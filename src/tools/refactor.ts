// Refactor-safe modify operations. Unlike the additive entity_field_* tools,
// these PROPAGATE a change to every place that references the renamed thing, so
// the agent doesn't leave dangling references (which dforge_module_validate
// would then flag and the agent would have to chase by hand).
//
// entity_field_rename: rename a field and update —
//   • the field key (order-preserving)
//   • the paired Reference column's link.thisKey + references.*.from.field
//   • same-entity formula columns referencing [oldName]
//   • data views: dataSources[].columns[].column_cd and order[] entries
//   • seed-data files whose entityCode matches (record keys, order-preserving)
//   • OTHER entities' FKs that target this field (link.otherKey / references.to.field)

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadManifest,
	readJson,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	diagramFiles,
	type ToolResult,
	entityFilePath,
} from "./_helpers";

const code = z.string().regex(/^[a-z][a-z0-9_]*$/);

// ── Reference scanner (shared by rename / remove / modify) ──────────────────
// Finds every place a field is still mentioned that the tools cannot rewrite
// with certainty: reports, constraints, tests, DSL, translations, formulas of
// other entities. Text/JSON-walk based and deliberately conservative — a hit
// means "look here", not "this is definitely broken".

export type FieldReferences = Record<string, string[] | undefined>;

/** The entity's own `toString` template (not Object.prototype.toString). */
function ownToString(e: Record<string, unknown>): string | undefined {
	const v = Object.getOwnPropertyDescriptor(e, "toString")?.value;
	return typeof v === "string" ? v : undefined;
}
function setToString(e: Record<string, unknown>, v: string): void {
	Object.defineProperty(e, "toString", { value: v, enumerable: true, writable: true, configurable: true });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Leaf keys whose string values are prose/literals, never a column code. */
const PROSE_KEYS = new Set(["v", "label", "title", "caption", "description", "message", "name", "text"]);

function walkStrings(
	node: unknown,
	where: string,
	cb: (value: string, where: string, key: string | undefined) => void,
	key?: string,
): void {
	if (typeof node === "string") cb(node, where, key);
	else if (Array.isArray(node)) node.forEach((n, i) => walkStrings(n, `${where}[${i}]`, cb, key));
	else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			cb(k, `${where}.${k} (key)`, "$key");
			walkStrings(v, `${where}.${k}`, cb, k);
		}
	}
}

function readDirText(dir: string, ext: RegExp): Array<{ file: string; text: string }> {
	if (!fs.existsSync(dir)) return [];
	const out: Array<{ file: string; text: string }> = [];
	for (const f of fs.readdirSync(dir)) {
		const fp = path.join(dir, f);
		try {
			if (fs.statSync(fp).isDirectory()) {
				for (const sub of readDirText(fp, ext)) out.push({ file: `${f}/${sub.file}`, text: sub.text });
			} else if (ext.test(f)) out.push({ file: f, text: fs.readFileSync(fp, "utf8") });
		} catch {
			/* unreadable file: skip */
		}
	}
	return out;
}

export function scanFieldReferences(
	paths: ReturnType<typeof loadManifest>["paths"],
	manifest: { entities?: Record<string, string> },
	entity: Record<string, unknown>,
	entityName: string,
	fieldNames: string[],
): FieldReferences {
	const refs: FieldReferences = {};
	const add = (cat: string, line: string) => {
		(refs[cat] ??= []).push(line);
	};
	for (const name of fieldNames) {
		const word = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(name)}($|[^A-Za-z0-9_])`);
		const ownFields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};

		// Same entity: constraints, toString, formulas, other field params.
		for (const [cn, c] of Object.entries(
			(entity.constraints as Record<string, Record<string, unknown>> | undefined) ?? {},
		)) {
			const cols = [...((c.fields as string[]) ?? []), ...((c.columns as string[]) ?? [])];
			const expr = typeof c.expression === "string" ? c.expression : "";
			if (cols.includes(name) || word.test(expr)) {
				add("constraints", `entities/${entityName}.json constraints.${cn} (${String(c.type)}) mentions '${name}'`);
			}
		}
		const ts = ownToString(entity);
		if (ts !== undefined && ts.includes(`{${name}}`)) {
			add("toStringTemplate", `entities/${entityName}.json toString '${ts}' uses {${name}}`);
		}
		for (const [fn, f] of Object.entries(ownFields)) {
			if (fn === name) continue;
			if (typeof f.formula === "string" && f.formula.includes(`[${name}]`)) {
				add("formulas", `entities/${entityName}.json fields.${fn}.formula uses [${name}]`);
			}
			if (f.params && typeof f.params === "object") {
				walkStrings(f.params, `fields.${fn}.params`, (v, w) => {
					if (v === name || v.includes(`[${name}]`))
						add("formulas", `entities/${entityName}.json ${w} mentions '${name}'`);
				});
			}
		}

		// Other entities: navigation / set aggregates `].[name]` through a link to this entity.
		for (const [oname, orel] of Object.entries(manifest.entities ?? {})) {
			if (oname === entityName || oname.includes(".")) continue;
			const op = entityFilePath(paths.root, orel);
			if (!fs.existsSync(op)) continue;
			let oe: Record<string, unknown>;
			try {
				oe = readJson<Record<string, unknown>>(op);
			} catch {
				continue;
			}
			const ofields = (oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
			const linksHere = Object.values(ofields).some(
				(f) => (f.link as Record<string, unknown> | undefined)?.entity === entityName,
			);
			if (!linksHere) continue;
			for (const [fn, f] of Object.entries(ofields)) {
				if (typeof f.formula === "string" && f.formula.includes(`].[${name}]`)) {
					add("otherEntities", `entities/${oname}.json fields.${fn}.formula navigates to [${name}] (${f.formula})`);
				}
			}
			const ots = ownToString(oe);
			if (ots !== undefined && ots.includes(`.${name}}`)) {
				add("otherEntities", `entities/${oname}.json toString uses a reference's {…${name}}`);
			}
		}

		// ui/reports.json: datasets on this entity + the panels that read them.
		const reports = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.reports, {});
		const hit = (v: string) => v === name || v.startsWith(`${name}.`);
		for (const [rn, r] of Object.entries(reports)) {
			const datasets = (r.datasets as Record<string, Record<string, unknown>> | undefined) ?? {};
			const mine = new Set<string>();
			for (const [dn, d] of Object.entries(datasets)) {
				const q = d.query as Record<string, unknown> | undefined;
				if (q?.entityCd !== entityName) continue;
				mine.add(dn);
				walkStrings(d, `datasets.${dn}`, (v, w, k) => {
					if (k !== "$key" && k !== undefined && PROSE_KEYS.has(k)) return;
					if (hit(v)) add("reports", `ui/reports.json ${rn}.${w}`);
				});
			}
			const panels =
				((r.layout as Record<string, unknown> | undefined)?.panels as Array<Record<string, unknown>> | undefined) ?? [];
			panels.forEach((p, i) => {
				if (typeof p.datasetCd !== "string" || !mine.has(p.datasetCd)) return;
				walkStrings(p.config, `layout.panels[${i}].config`, (v, w, k) => {
					if (k !== undefined && k !== "$key" && PROSE_KEYS.has(k)) return;
					if (hit(v)) add("reports", `ui/reports.json ${rn}.${w}`);
				});
			});
		}

		// tests/*.test.json: any quoted use of the code in a test touching this entity.
		for (const { file, text } of readDirText(path.join(paths.root, "tests"), /\.json$/)) {
			if (!text.includes(`"${entityName}"`)) continue;
			const n = (text.match(new RegExp(`"${escapeRe(name)}"\\s*:|"\\$?[a-z_]*\\.?${escapeRe(name)}"`, "g")) ?? [])
				.length;
			if (n > 0) add("tests", `tests/${file}: ${n} use(s) of '${name}' (check those on '${entityName}')`);
		}

		// DSL: logic/actions/**, triggers/jobs and ui/actions.json.
		const dsl = readDirText(path.join(paths.logicDir, "actions"), /\.dsl$/);
		for (const { file, text } of dsl) {
			if (text.includes(`[${name}]`) || new RegExp(`\\.${escapeRe(name)}\\b`).test(text)) {
				add("dsl", `logic/actions/${file} mentions '${name}' (possible, verify it is ${entityName}'s)`);
			}
		}
		for (const [label, fp] of [
			["logic/triggers.json", paths.triggers],
			["logic/jobs.json", paths.jobs],
		] as const) {
			if (fs.existsSync(fp) && fs.readFileSync(fp, "utf8").includes(`[${name}]`)) {
				add("dsl", `${label} mentions [${name}] (possible)`);
			}
		}

		// translations/*.json: entities.<entity>.fields.<name>
		for (const { file, text } of readDirText(paths.translationsDir, /\.json$/)) {
			try {
				const t = JSON.parse(text);
				if (t?.entities?.[entityName]?.fields && name in t.entities[entityName].fields) {
					add("translations", `translations/${file} entities.${entityName}.fields.${name}`);
				}
			} catch {
				/* not JSON */
			}
		}
	}
	return refs;
}

/** Render a references section for the human-readable `warning` text. */
export function renderReferences(refs: FieldReferences): string {
	return Object.entries(refs)
		.map(([cat, lines]) => `${cat}: ${(lines ?? []).join(" | ")}`)
		.join("; ");
}

/** Pick a sensible replacement toString for an entity whose template lost its fields. */
function pickToStringField(
	fields: Record<string, Record<string, unknown>>,
	entityName: string,
	traits: string[],
): string | undefined {
	const candidates = Object.entries(fields).filter(
		([, f]) =>
			f.columnType === undefined &&
			typeof f.flags === "string" &&
			f.flags.includes("V") &&
			(f.dbDatatype === "varchar" || f.dbDatatype === "text"),
	);
	const pref = candidates.find(([k]) => /^(name|title|number|code|label)$/.test(k)) ?? candidates[0];
	if (pref) return pref[0];
	return traits.includes("identity") ? `${entityName}_id` : undefined;
}

export const entityFieldRenameSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Entity that owns the field."),
	fieldName: code.describe("Current field code."),
	newName: code.describe("New field code."),
};

/** Rebuild an object with one key renamed, preserving insertion order. */
function renameKey<T>(obj: Record<string, T>, oldK: string, newK: string): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [k, v] of Object.entries(obj)) out[k === oldK ? newK : k] = v;
	return out;
}

export function entityFieldRename(args: z.infer<z.ZodObject<typeof entityFieldRenameSchema>>): ToolResult {
	const { entityName, fieldName: oldName, newName } = args;
	if (oldName === newName) throw new Error("newName must differ from fieldName.");

	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityRel = (manifest.entities ?? {})[entityName];
	if (!entityRel) throw new Error(`Entity '${entityName}' is not in the manifest.`);
	const entityPath = entityFilePath(paths.root, entityRel);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	if (!(oldName in fields)) throw new Error(`Field '${oldName}' not found on entity '${entityName}'.`);
	if (newName in fields)
		throw new Error(`Field '${newName}' already exists on entity '${entityName}'. Pick another name.`);

	const changes: string[] = [];
	const files: Record<string, string> = {};

	// 1. Rename the field key (order-preserving).
	entity.fields = renameKey(fields, oldName, newName);
	changes.push(`field '${oldName}' → '${newName}'`);

	// 2. Same-entity: paired Reference's thisKey + formula refs. Use literal
	// bracket-token string ops (not a shared /g/ regex, whose lastIndex would
	// carry across .test() calls and skip later formulas). Field names are
	// [a-z0-9_] so the token is unambiguous.
	const oldToken = `[${oldName}]`;
	const newToken = `[${newName}]`;
	for (const [fname, f] of Object.entries(entity.fields as Record<string, Record<string, unknown>>)) {
		const link = f.link as Record<string, unknown> | undefined;
		if (link && link.thisKey === oldName) {
			link.thisKey = newName;
			changes.push(`${fname}.link.thisKey`);
		}
		if (typeof f.formula === "string" && f.formula.includes(oldToken)) {
			f.formula = f.formula.split(oldToken).join(newToken);
			changes.push(`formula in ${fname}`);
		}
	}
	// references block: from.field on this entity.
	const refs = (entity.references as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const [rname, r] of Object.entries(refs)) {
		const from = r.from as Record<string, unknown> | undefined;
		if (from && from.field === oldName) {
			from.field = newName;
			changes.push(`references.${rname}.from.field`);
		}
	}
	// 2b. Entity views (column-level security, `views.<v>.columns.<cd>`): the column
	// key itself, plus any per-view formula override that names the field. A stale
	// key here is not cosmetic — the platform installer rejects a view listing a
	// column the entity does not have, so a rename would leave a module that no
	// longer installs. Note `views` on the entity is unrelated to ui/data_views.json,
	// handled separately in step 4.
	const entityViews = (entity.views as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const [vname, v] of Object.entries(entityViews)) {
		const cols = v.columns as Record<string, Record<string, unknown> | null> | undefined;
		if (!cols) continue;
		if (oldName in cols) {
			v.columns = renameKey(cols, oldName, newName);
			changes.push(`views.${vname}.columns.${oldName}`);
		}
		for (const [cn, ov] of Object.entries(v.columns as Record<string, Record<string, unknown> | null>)) {
			if (ov && typeof ov.formula === "string" && ov.formula.includes(oldToken)) {
				ov.formula = ov.formula.split(oldToken).join(newToken);
				changes.push(`views.${vname}.${cn}.formula`);
			}
		}
	}

	// 2c. toString template and constraints on this entity.
	const tsOld = ownToString(entity);
	if (tsOld !== undefined && tsOld.includes(`{${oldName}}`)) {
		setToString(entity, tsOld.split(`{${oldName}}`).join(`{${newName}}`));
		changes.push("toString");
	}
	const wordRe = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(oldName)}(?![A-Za-z0-9_])`, "g");
	for (const [cn, c] of Object.entries(
		(entity.constraints as Record<string, Record<string, unknown>> | undefined) ?? {},
	)) {
		for (const key of ["fields", "columns"] as const) {
			if (Array.isArray(c[key]) && (c[key] as string[]).includes(oldName)) {
				c[key] = (c[key] as string[]).map((x) => (x === oldName ? newName : x));
				changes.push(`constraints.${cn}.${key}`);
			}
		}
		if (typeof c.expression === "string") {
			// Rewrite identifiers only — quoted SQL string literals stay untouched.
			const next = c.expression
				.split(/('(?:[^']|'')*')/)
				.map((part, i) => (i % 2 === 1 ? part : part.replace(wordRe, `$1${newName}`)))
				.join("");
			if (next !== c.expression) {
				c.expression = next;
				changes.push(`constraints.${cn}.expression`);
			}
		}
	}

	files[rel(paths.root, entityPath)] = jsonText(entity);

	// 3. OTHER entities whose FK targets this field (otherKey / references.to.field).
	for (const [oname, orel] of Object.entries(manifest.entities ?? {})) {
		if (oname === entityName || oname.includes(".")) continue;
		const op = entityFilePath(paths.root, orel as string);
		if (!fs.existsSync(op)) continue;
		const oe = readJson<Record<string, unknown>>(op);
		let touched = false;
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === entityName && link.otherKey === oldName) {
				link.otherKey = newName;
				touched = true;
				changes.push(`${oname}.${fn}.link.otherKey`);
			}
		}
		for (const [rn, r] of Object.entries(
			(oe.references as Record<string, Record<string, unknown>> | undefined) ?? {},
		)) {
			const to = r.to as Record<string, unknown> | undefined;
			if (to && to.entity === entityName && to.field === oldName) {
				to.field = newName;
				touched = true;
				changes.push(`${oname}.references.${rn}.to.field`);
			}
		}
		if (touched) files[rel(paths.root, op)] = jsonText(oe);
	}

	// 4. Data views: column_cd + order entries on this entity's dataSources.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	for (const v of Object.values(views)) {
		for (const s of (v.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
			if (s.entityCode !== entityName) continue;
			if (Array.isArray(s.columns)) {
				s.columns = (s.columns as unknown[]).map((c) => {
					if (c === oldName) {
						viewsTouched = true;
						return newName;
					}
					if (c && typeof c === "object" && (c as Record<string, unknown>).column_cd === oldName) {
						viewsTouched = true;
						(c as Record<string, unknown>).column_cd = newName;
					}
					return c;
				});
			}
			if (Array.isArray(s.order)) {
				s.order = (s.order as unknown[]).map((o) => {
					if (o === oldName) {
						viewsTouched = true;
						return newName;
					}
					if (o === "-" + oldName) {
						viewsTouched = true;
						return "-" + newName;
					}
					if (o && typeof o === "object" && (o as Record<string, unknown>).c === oldName) {
						viewsTouched = true;
						return { ...(o as object), c: newName };
					}
					return o;
				});
			}
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (columns/order)");
	}

	// 5. Seed-data files for this entity (record keys, order-preserving).
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode !== entityName || !Array.isArray(data.records)) continue;
			let touched = false;
			data.records = (data.records as Array<Record<string, unknown>>).map((rec) => {
				if (rec && typeof rec === "object" && oldName in rec) {
					touched = true;
					return renameKey(rec, oldName, newName);
				}
				return rec;
			});
			if (touched) {
				files[rel(paths.root, fp)] = jsonText(data);
				changes.push(`seed-data/${file}`);
			}
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	// Whatever the rename could not rewrite with certainty (reports, tests, DSL,
	// translations, other entities' formulas) is listed, never left silent. The
	// scan runs against the ORIGINAL on-disk state, so the old name is still there.
	const original = readJson<Record<string, unknown>>(entityPath);
	const references = scanFieldReferences(paths, manifest, original, entityName, [oldName]);
	delete references.constraints; // rewritten above
	delete references.toStringTemplate; // rewritten above
	for (const k of Object.keys(references)) {
		if (!references[k]?.length) delete references[k];
	}
	const refText = renderReferences(references);

	const result = makeResult(
		`Renamed '${entityName}.${oldName}' → '${newName}', propagated to ${changes.length} location(s): ${changes.join("; ")}.`,
		files,
		"Review the returned files before writing — this rewrites every file that referenced the field. " +
			(refText ? `NOT rewritten, update by hand (old name '${oldName}'): ${refText}. ` : "") +
			"Run dforge_module_validate after writing to confirm no references were missed.",
	) as ToolResult & { references?: FieldReferences };
	if (refText) result.references = references;
	return result;
}

// ── data-view pruning (shared by field_remove) ─────────────────────────────

const colCodeOf = (c: unknown): string | undefined =>
	typeof c === "string"
		? c
		: c && typeof c === "object" && typeof (c as Record<string, unknown>).column_cd === "string"
			? ((c as Record<string, unknown>).column_cd as string)
			: undefined;

/** Column code behind one `order` entry: "-col", "col" or {c, d}. */
const orderCodeOf = (o: unknown): string | undefined =>
	typeof o === "string"
		? o.replace(/^-/, "")
		: o && typeof o === "object" && typeof (o as Record<string, unknown>).c === "string"
			? ((o as Record<string, unknown>).c as string)
			: undefined;

/** Drop conditions on removed columns from a filter tree; returns undefined when nothing is left. */
function pruneFilter(f: unknown, removed: Set<string>, hit: { n: number }): unknown {
	if (!f || typeof f !== "object") return f;
	const node = f as Record<string, unknown>;
	if (Array.isArray(node.i)) {
		const kept = (node.i as unknown[]).map((c) => pruneFilter(c, removed, hit)).filter((c) => c !== undefined);
		return kept.length === 0 ? undefined : { ...node, i: kept };
	}
	if (typeof node.c === "string" && removed.has(node.c)) {
		hit.n++;
		return undefined;
	}
	return f;
}

/**
 * Remove `removed` columns of `entityName` from every data view: dataSource
 * `columns` (strings or {column_cd}), `order` (strings or {c,d}) and `filter`
 * conditions. A view-level `order`/`filter` is touched only when every
 * dataSource of the view reads this entity (otherwise the column is ambiguous).
 * Mutates `views`; returns what changed.
 */
export function pruneDataViews(
	views: Record<string, Record<string, unknown>>,
	entityName: string,
	removed: Set<string>,
): string[] {
	const out: string[] = [];
	for (const [vcode, v] of Object.entries(views)) {
		if (!v || typeof v !== "object") continue;
		const sources = (v.dataSources as Array<Record<string, unknown>> | undefined) ?? [];
		for (const s of sources) {
			if (!s || s.entityCode !== entityName) continue;
			if (Array.isArray(s.columns)) {
				const cols = s.columns as unknown[];
				const kept = cols.filter((c) => !removed.has(colCodeOf(c) ?? "\0"));
				if (kept.length !== cols.length) {
					s.columns = kept;
					out.push(`${vcode}: columns`);
				}
			}
			if (Array.isArray(s.order)) {
				const ord = s.order as unknown[];
				const kept = ord.filter((o) => !removed.has(orderCodeOf(o) ?? "\0"));
				if (kept.length !== ord.length) {
					s.order = kept;
					out.push(`${vcode}: order`);
				}
			}
			if (s.filter !== undefined) {
				const hit = { n: 0 };
				const next = pruneFilter(s.filter, removed, hit);
				if (hit.n > 0) {
					if (next === undefined) delete s.filter;
					else s.filter = next;
					out.push(`${vcode}: filter`);
				}
			}
		}
		const single = sources.length > 0 && sources.every((s) => s?.entityCode === entityName);
		if (single) {
			if (Array.isArray(v.order)) {
				const ord = v.order as unknown[];
				const kept = ord.filter((o) => !removed.has(orderCodeOf(o) ?? "\0"));
				if (kept.length !== ord.length) {
					v.order = kept;
					out.push(`${vcode}: view order`);
				}
			}
			if (v.filter !== undefined) {
				const hit = { n: 0 };
				const next = pruneFilter(v.filter, removed, hit);
				if (hit.n > 0) {
					if (next === undefined) delete v.filter;
					else v.filter = next;
					out.push(`${vcode}: view filter`);
				}
			}
		}
	}
	return out;
}

// ── entity_field_remove (cascade) ───────────────────────────────────────────
// Removes a field AND cleans up the safe cascade: paired Reference column when
// removing its hidden FK, the references entry, view columns + order, and
// seed-data keys. Formula refs and cross-entity FKs are surfaced as warnings
// (not auto-deleted — those are the user's judgement call).

export const entityFieldRemoveSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Entity that owns the field."),
	fieldName: code.describe("Field code to remove."),
};

export function entityFieldRemove(args: z.infer<z.ZodObject<typeof entityFieldRemoveSchema>>): ToolResult {
	const { entityName, fieldName } = args;
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityRel = (manifest.entities ?? {})[entityName];
	if (!entityRel) throw new Error(`Entity '${entityName}' is not in the manifest.`);
	const entityPath = entityFilePath(paths.root, entityRel);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	if (!(fieldName in fields)) throw new Error(`Field '${fieldName}' not found on entity '${entityName}'.`);

	const removed = new Set<string>([fieldName]);
	const changes: string[] = [];
	const warnings: string[] = [];
	const files: Record<string, string> = {};

	// Removing a hidden FK that a Reference column depends on → remove that Reference too.
	for (const [fn, f] of Object.entries(fields)) {
		const link = f.link as Record<string, unknown> | undefined;
		if (fn !== fieldName && link && link.thisKey === fieldName) {
			removed.add(fn);
			changes.push(`paired reference column '${fn}'`);
		}
	}

	const newFields: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields)) if (!removed.has(k)) newFields[k] = v;
	entity.fields = newFields;
	changes.push(`field '${fieldName}'`);

	// references entries whose from.field was removed.
	const refs = (entity.references as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const [rn, r] of Object.entries(refs)) {
		const from = r.from as Record<string, unknown> | undefined;
		if (from && removed.has(from.field as string)) {
			delete refs[rn];
			changes.push(`references.${rn}`);
		}
	}
	// Entity views: drop the removed columns from every view that lists them. Left
	// behind, the view names a column the entity no longer has and the platform
	// installer rejects it — the module would stop installing.
	const entityViews = (entity.views as Record<string, Record<string, unknown>> | undefined) ?? {};
	for (const [vname, v] of Object.entries(entityViews)) {
		const cols = v.columns as Record<string, Record<string, unknown> | null> | undefined;
		if (!cols) continue;
		const kept: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(cols)) if (!removed.has(k)) kept[k] = val;
		if (Object.keys(kept).length !== Object.keys(cols).length) {
			v.columns = kept;
			changes.push(`views.${vname}.columns`);
		}
		// A view is the complete set of columns visible in a folder bound to it, so
		// an empty one is rejected at install rather than treated as "show nothing".
		if (Object.keys(kept).length === 0) {
			warnings.push(
				`view '${vname}' has no columns left — delete the view, or give it columns ` +
					"(an empty view fails the install)",
			);
		}
		for (const [cn, ov] of Object.entries(kept as Record<string, Record<string, unknown> | null>)) {
			if (ov && typeof ov.formula === "string") {
				for (const r of removed) {
					if (ov.formula.includes(`[${r}]`)) {
						warnings.push(`formula in view '${vname}'.${cn} still references removed '[${r}]'`);
					}
				}
			}
		}
	}

	// toString template: a `{removed}` token would render literally / break the label.
	if (ownToString(entity) !== undefined) {
		let ts = ownToString(entity) as string;
		let hit = false;
		for (const r of removed) {
			if (ts.includes(`{${r}}`)) {
				ts = ts.split(`{${r}}`).join("");
				hit = true;
			}
		}
		if (hit) {
			ts = ts.replace(/\s+/g, " ").trim();
			if (!/\{[^}]+\}/.test(ts)) {
				const pick = pickToStringField(
					entity.fields as Record<string, Record<string, unknown>>,
					entityName,
					(entity.traits as string[] | undefined) ?? [],
				);
				if (pick) {
					ts = `{${pick}}`;
					warnings.push(
						`toString lost all its fields; set to '${ts}' — change it to a sensible business label if needed`,
					);
				} else {
					warnings.push("toString lost all its fields and no replacement column was found — set it by hand");
				}
			}
			setToString(entity, ts);
			changes.push("toString");
		}
	}

	files[rel(paths.root, entityPath)] = jsonText(entity);

	// Formula columns (still present) that reference a removed field → warn.
	for (const [fn, f] of Object.entries(entity.fields as Record<string, Record<string, unknown>>)) {
		if (typeof f.formula !== "string") continue;
		for (const r of removed) {
			if (f.formula.includes(`[${r}]`)) {
				warnings.push(`formula in '${fn}' still references removed '[${r}]'`);
			}
		}
	}

	// Views: drop columns + order + filter entries for removed fields on this entity.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	const viewChanges = pruneDataViews(views, entityName, removed);
	if (viewChanges.length > 0) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push(`data_views.json (${viewChanges.join("; ")})`);
		for (const [vcode, v] of Object.entries(views)) {
			for (const src of (v?.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
				if (src?.entityCode === entityName && Array.isArray(src.columns) && src.columns.length === 0) {
					warnings.push(
						`view '${vcode}' has no columns left after the removal — add real columns (an empty grid fails validation)`,
					);
				}
			}
		}
	}

	// Seed-data: drop removed keys from this entity's records.
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode !== entityName || !Array.isArray(data.records)) continue;
			let touched = false;
			data.records = (data.records as Array<Record<string, unknown>>).map((rec) => {
				const out: Record<string, unknown> = {};
				let changed = false;
				for (const [k, val] of Object.entries(rec)) {
					if (removed.has(k)) changed = true;
					else out[k] = val;
				}
				if (changed) touched = true;
				return changed ? out : rec;
			});
			if (touched) {
				files[rel(paths.root, fp)] = jsonText(data);
				changes.push(`seed-data/${file}`);
			}
		}
	}

	// Cross-entity FKs targeting a removed field → warn (don't touch other modules' columns).
	for (const [oname, orel] of Object.entries(manifest.entities ?? {})) {
		if (oname === entityName || oname.includes(".")) continue;
		const op = entityFilePath(paths.root, orel as string);
		if (!fs.existsSync(op)) continue;
		let oe: Record<string, unknown>;
		try {
			oe = readJson<Record<string, unknown>>(op);
		} catch {
			continue;
		}
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === entityName && removed.has(link.otherKey as string)) {
				warnings.push(`'${oname}.${fn}' references removed '${entityName}.${link.otherKey}' — its FK now dangles`);
			}
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	// Everything still mentioning a removed field that we do not rewrite. Constraints
	// are blocking: a check/unique over a dropped column fails the install.
	const references: FieldReferences = {};
	{
		const original = readJson<Record<string, unknown>>(entityPath);
		const found = scanFieldReferences(paths, manifest, original, entityName, [...removed]);
		delete found.toStringTemplate; // handled above
		for (const [k, v] of Object.entries(found)) if (v?.length) references[k] = v;
	}
	if (references.constraints?.length) {
		warnings.unshift(
			`BLOCKING: constraint(s) still reference the removed field and will fail the install — ${references.constraints?.join("; ")}`,
		);
	}
	const refText = renderReferences(references);

	const warnText = [
		warnings.length ? `Manual follow-up: ${warnings.join("; ")}.` : "",
		refText ? `Remaining references (not rewritten): ${refText}.` : "",
		"Run dforge_module_validate after writing to confirm nothing dangles.",
	]
		.filter(Boolean)
		.join(" ");

	const result = makeResult(
		`Removed '${entityName}.${fieldName}'${removed.size > 1 ? ` (+${removed.size - 1} paired column)` : ""}; cascade-cleaned ${changes.length} location(s): ${changes.join("; ")}.`,
		files,
		warnText,
	) as ToolResult & { references?: FieldReferences };
	if (refText) result.references = references;
	return result;
}

// ── entity_rename (with PK + reference cascade) ─────────────────────────────
// Renames an entity code and propagates: the manifest key + file (old deleted),
// the identity PK {old}_id → {new}_id wherever an FK targets it, and every
// reference to the entity code — other entities' link.entity / references.to,
// view entityCode, role rights keys, action entity, folder bindings, diagram
// entity keys and relations (refused when a diagram already draws the new code), and seed-data entityCode + PK keys. Reports/translations/menus/DSL are warned, not
// rewritten.

const SYSTEM_ENTITIES = new Set(["user", "document", "menu_item", "resource"]);

export const entityRenameSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Current entity code."),
	newName: code.describe("New entity code."),
};

export function entityRename(args: z.infer<z.ZodObject<typeof entityRenameSchema>>): ToolResult {
	const { entityName: oldE, newName: newE } = args;
	if (oldE === newE) throw new Error("newName must differ from entityName.");
	if (SYSTEM_ENTITIES.has(newE)) throw new Error(`'${newE}' is a reserved system entity name.`);

	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	if (!(oldE in entityMap)) throw new Error(`Entity '${oldE}' is not in the manifest.`);
	if (newE in entityMap) throw new Error(`Entity '${newE}' already exists in this module.`);
	// A diagram may already draw a planned newE next to oldE; renaming
	// would collapse the two nodes (placement lost, old → new relations turned
	// into self-loops). Refuse rather than merge silently.
	const collisions = diagramFiles(paths.diagramsDir)
		.filter((fp) => {
			let d: Record<string, unknown>;
			try {
				d = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				return false;
			}
			return !!d && typeof d === "object" && diagramMentions(d, oldE) && diagramMentions(d, newE);
		})
		.map((fp) => `docs/diagrams/${path.basename(fp)}`);
	if (collisions.length > 0) {
		throw new Error(
			`${collisions.join(", ")} already draw${collisions.length === 1 ? "s" : ""} a '${newE}' alongside '${oldE}' — ` +
				`renaming would merge the two nodes. Remove or rename '${newE}' in the diagram first.`,
		);
	}

	const files: Record<string, string> = {};
	const deletes: string[] = [];
	const changes: string[] = [];

	const oldPath = entityFilePath(paths.root, entityMap[oldE]);
	const entity = readJson<Record<string, unknown>>(oldPath);
	const usesIdentity = ((entity.traits as string[] | undefined) ?? []).includes("identity");
	const oldPk = `${oldE}_id`;
	const newPk = `${newE}_id`;

	if (entity.dbObject === oldE) {
		entity.dbObject = newE;
		changes.push("entity.dbObject");
	}

	// Move the entity file: write new path, delete old.
	const newPath = path.join(paths.root, "entities", `${newE}.json`);
	files[rel(paths.root, newPath)] = jsonText(entity);
	deletes.push(rel(paths.root, oldPath));
	changes.push(`entity file → entities/${newE}.json`);

	// Manifest entities map: rename key + path (order-preserving).
	manifest.entities = renameKey(entityMap, oldE, newE);
	(manifest.entities as Record<string, string>)[newE] = `./entities/${newE}.json`;

	// Other entities: link.entity / references.to.entity (+ PK in otherKey/to.field).
	for (const [oname, orel] of Object.entries(entityMap)) {
		if (oname === oldE || oname.includes(".")) continue;
		const op = entityFilePath(paths.root, orel);
		if (!fs.existsSync(op)) continue;
		const oe = readJson<Record<string, unknown>>(op);
		let touched = false;
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === oldE) {
				link.entity = newE;
				touched = true;
				changes.push(`${oname}.${fn}.link.entity`);
				if (usesIdentity && link.otherKey === oldPk) link.otherKey = newPk;
			}
		}
		for (const [rn, r] of Object.entries(
			(oe.references as Record<string, Record<string, unknown>> | undefined) ?? {},
		)) {
			const to = r.to as Record<string, unknown> | undefined;
			if (to && to.entity === oldE) {
				to.entity = newE;
				touched = true;
				changes.push(`${oname}.references.${rn}.to.entity`);
				if (usesIdentity && to.field === oldPk) to.field = newPk;
			}
		}
		if (touched) files[rel(paths.root, op)] = jsonText(oe);
	}

	// Views: dataSources[].entityCode.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	for (const v of Object.values(views)) {
		for (const s of (v.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
			if (s.entityCode === oldE) {
				s.entityCode = newE;
				viewsTouched = true;
			}
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (entityCode)");
	}

	// Roles: rights keys equal to the entity code.
	const roles = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {});
	let rolesTouched = false;
	for (const r of Object.values(roles)) {
		const rights = r.rights as Record<string, string> | undefined;
		if (rights && oldE in rights) {
			r.rights = renameKey(rights, oldE, newE);
			rolesTouched = true;
		}
	}
	if (rolesTouched) {
		files[rel(paths.root, paths.roles)] = jsonText(roles);
		changes.push("roles.json (rights keys)");
	}

	// Actions: entity / entityCode.
	const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	let actionsTouched = false;
	for (const a of Object.values(actions)) {
		if (a.entity === oldE) {
			a.entity = newE;
			actionsTouched = true;
		}
		if (a.entityCode === oldE) {
			a.entityCode = newE;
			actionsTouched = true;
		}
	}
	if (actionsTouched) {
		files[rel(paths.root, paths.actions)] = jsonText(actions);
		changes.push("actions.json (entity)");
	}

	// Folders: per-entity bindings keyed by entity code (recursive).
	const folders = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	let foldersTouched = false;
	const walkFolders = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const ents = rec.entities as Record<string, unknown> | undefined;
		if (ents && oldE in ents) {
			rec.entities = renameKey(ents, oldE, newE);
			foldersTouched = true;
		}
		const children = rec.children as Record<string, unknown> | undefined;
		if (children) for (const c of Object.values(children)) walkFolders(c);
	};
	walkFolders(folders);
	if (foldersTouched) {
		files[rel(paths.root, paths.folders)] = jsonText(folders);
		changes.push("folders.json (entity bindings)");
	}

	// Diagrams: one file per diagram, entity keys renamed in place so the order
	// holds; hand-drawn relations[].from/to follow the rename.
	for (const fp of diagramFiles(paths.diagramsDir)) {
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(fs.readFileSync(fp, "utf8"));
		} catch {
			continue;
		}
		if (!d || typeof d !== "object") continue;
		const what: string[] = [];
		const ents = d.entities as Record<string, unknown> | undefined;
		if (ents && typeof ents === "object" && oldE in ents) {
			d.entities = renameKey(ents, oldE, newE);
			what.push("entity key");
		}
		let relTouched = false;
		for (const r of diagramRelations(d)) {
			if (r.from === oldE) {
				r.from = newE;
				relTouched = true;
			}
			if (r.to === oldE) {
				r.to = newE;
				relTouched = true;
			}
		}
		if (relTouched) what.push("relations");
		if (what.length === 0) continue;
		files[rel(paths.root, fp)] = jsonText(d);
		changes.push(`docs/diagrams/${path.basename(fp)} (${what.join(", ")})`);
	}

	// Seed-data: entityCode + PK key.
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode !== oldE) continue;
			data.entityCode = newE;
			if (usesIdentity && Array.isArray(data.records)) {
				data.records = (data.records as Array<Record<string, unknown>>).map((r) =>
					oldPk in r ? renameKey(r, oldPk, newPk) : r,
				);
			}
			files[rel(paths.root, fp)] = jsonText(data);
			changes.push(`seed-data/${file}`);
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	return makeResult(
		`Renamed entity '${oldE}' → '${newE}'${usesIdentity ? ` (PK ${oldPk} → ${newPk})` : ""}; propagated to ${changes.length} location(s). Old entity file deleted.`,
		files,
		`Reports datasets, translation files, menu labels, and DSL bodies are NOT rewritten — check anything referencing '${oldE}'. Run dforge_module_validate after writing.`,
		deletes,
	);
}

/** A diagram's hand-drawn relations — the object entries of `relations`, or none. */
function diagramRelations(d: Record<string, unknown>): Array<Record<string, unknown>> {
	if (!Array.isArray(d.relations)) return [];
	return (d.relations as unknown[]).filter(
		(r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
	);
}

/** Whether a diagram places `key` as an entity or names it as a relation endpoint. */
function diagramMentions(d: Record<string, unknown>, key: string): boolean {
	const ents = d.entities;
	if (ents && typeof ents === "object" && Object.prototype.hasOwnProperty.call(ents, key)) return true;
	return diagramRelations(d).some((r) => r.from === key || r.to === key);
}

// ── entity_delete (with reference cleanup) ──────────────────────────────────
// Deletes an entity: drops the file + manifest entry + its seed files, removes
// role rights keys + folder bindings + diagram entries and relations + data-view sources
// (deleting a view left with no source). Cross-entity FKs targeting it,
// actions on it, and menus that pointed at a removed view are surfaced as
// warnings — the user decides.

export const entityDeleteSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: code.describe("Entity code to delete."),
};

export function entityDelete(args: z.infer<z.ZodObject<typeof entityDeleteSchema>>): ToolResult {
	const { entityName: target } = args;
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	if (!(target in entityMap)) throw new Error(`Entity '${target}' is not in the manifest.`);

	const files: Record<string, string> = {};
	const deletes: string[] = [];
	const changes: string[] = [];
	const warnings: string[] = [];

	const ePath = entityFilePath(paths.root, entityMap[target]);
	if (fs.existsSync(ePath)) deletes.push(rel(paths.root, ePath));

	const { [target]: _dropped, ...restEntities } = entityMap;
	void _dropped;
	manifest.entities = restEntities;
	changes.push("manifest.entities entry");

	// Cross-entity FKs targeting it → warn (don't silently mangle other entities).
	for (const [oname, orel] of Object.entries(entityMap)) {
		if (oname === target || oname.includes(".")) continue;
		const op = entityFilePath(paths.root, orel);
		if (!fs.existsSync(op)) continue;
		let oe: Record<string, unknown>;
		try {
			oe = readJson<Record<string, unknown>>(op);
		} catch {
			continue;
		}
		for (const [fn, f] of Object.entries((oe.fields as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			const link = f.link as Record<string, unknown> | undefined;
			if (link && link.entity === target) {
				warnings.push(`'${oname}.${fn}' references deleted entity '${target}' — remove or repoint it`);
			}
		}
	}

	// Roles: drop rights key.
	const roles = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.roles, {});
	let rolesTouched = false;
	for (const r of Object.values(roles)) {
		const rights = r.rights as Record<string, string> | undefined;
		if (rights && target in rights) {
			delete rights[target];
			rolesTouched = true;
		}
	}
	if (rolesTouched) {
		files[rel(paths.root, paths.roles)] = jsonText(roles);
		changes.push("roles.json (rights key)");
	}

	// Folders: drop binding (recursive).
	const folders = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	let foldersTouched = false;
	const walkFolders = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const rec = node as Record<string, unknown>;
		const ents = rec.entities as Record<string, unknown> | undefined;
		if (ents && target in ents) {
			delete ents[target];
			foldersTouched = true;
		}
		const children = rec.children as Record<string, unknown> | undefined;
		if (children) for (const c of Object.values(children)) walkFolders(c);
	};
	walkFolders(folders);
	if (foldersTouched) {
		files[rel(paths.root, paths.folders)] = jsonText(folders);
		changes.push("folders.json (binding)");
	}

	// Diagrams: drop the entity, and every hand-drawn relation touching it, from
	// every diagram file.
	for (const fp of diagramFiles(paths.diagramsDir)) {
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(fs.readFileSync(fp, "utf8"));
		} catch {
			continue;
		}
		if (!d || typeof d !== "object") continue;
		const what: string[] = [];
		const ents = d.entities as Record<string, unknown> | undefined;
		if (ents && typeof ents === "object" && target in ents) {
			delete ents[target];
			what.push("entity key");
		}
		const doomed = new Set(diagramRelations(d).filter((r) => r.from === target || r.to === target));
		if (doomed.size > 0) {
			d.relations = (d.relations as unknown[]).filter((r) => !doomed.has(r as Record<string, unknown>));
			what.push("relations");
		}
		if (what.length === 0) continue;
		files[rel(paths.root, fp)] = jsonText(d);
		changes.push(`docs/diagrams/${path.basename(fp)} (${what.join(", ")})`);
	}

	// Views: drop sources referencing it; delete a view left with no source.
	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	let viewsTouched = false;
	const removedViews: string[] = [];
	for (const [vcode, v] of Object.entries(views)) {
		const ds = v.dataSources as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(ds)) continue;
		const filtered = ds.filter((s) => s.entityCode !== target);
		if (filtered.length === ds.length) continue;
		viewsTouched = true;
		if (filtered.length === 0) {
			delete views[vcode];
			removedViews.push(vcode);
		} else {
			v.dataSources = filtered;
		}
	}
	if (viewsTouched) {
		files[rel(paths.root, paths.dataViews)] = jsonText(views);
		changes.push("data_views.json (sources)");
	}
	if (removedViews.length) {
		warnings.push(`deleted view(s) ${removedViews.join(", ")} (no sources left) — check menus pointing at them`);
	}

	// Actions on it → warn.
	const actions = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	for (const [acode, a] of Object.entries(actions)) {
		if (a.entity === target || a.entityCode === target) {
			warnings.push(`action '${acode}' targets deleted entity '${target}'`);
		}
	}

	// Seed files for it → delete.
	if (fs.existsSync(paths.seedDataDir)) {
		for (const file of fs.readdirSync(paths.seedDataDir).filter((f) => f.endsWith(".json"))) {
			const fp = path.join(paths.seedDataDir, file);
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(fs.readFileSync(fp, "utf8"));
			} catch {
				continue;
			}
			if (data?.entityCode === target) {
				deletes.push(rel(paths.root, fp));
				changes.push(`seed-data/${file}`);
			}
		}
	}

	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	const warnText = [
		warnings.length ? `Manual follow-up: ${warnings.join("; ")}.` : "",
		"Run dforge_module_validate after writing.",
	]
		.filter(Boolean)
		.join(" ");

	return makeResult(
		`Deleted entity '${target}'; cleaned ${changes.length} artifact(s)${deletes.length > 1 ? `, removed ${deletes.length} file(s)` : ""}.`,
		files,
		warnText,
		deletes,
	);
}
