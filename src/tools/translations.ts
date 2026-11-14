// dforge_translation_sync — generate/refresh translations/<locale>.json from
// what the module actually contains.
//
// English is the base locale and lives in the definitions themselves (an
// entity's `description`, a menu's `label`, …): install never reads
// translations/en*.json, so this tool writes no English file. Translation
// completeness is enforced at install for the files it does read:
// `roles.<code>.label` is required for EVERY role in EVERY non-English locale
// file, and every locale in manifest.supportedLocales must have a file. Hand-maintaining
// that across entity/view/menu churn is exactly the bookkeeping a tool should
// do — and "missing translation key" was a documented install-failure mode with
// no tool behind it.
//
// Non-destructive by contract: an existing translated value is NEVER
// overwritten. Missing keys are seeded with the English text install shows,
// so the file is immediately installable and the human/agent can translate in place.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandTraits } from "@dforge-core/metadata";
import { extractMessages, parseDsl } from "@dforge-core/metadata/dsl";
import { allMessageTexts, libraryMessages } from "./validate/translations";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	walkFolders,
	duplicateFolderCodes,
	compositeKey,
	assertKnownTraits,
	readLocalTraits,
	type ToolResult,
	entityFilePath,
} from "./_helpers";

type Dict = Record<string, unknown>;

/** Turn a snake_case code into a human label: `due_date` → `Due Date`. */
function titleize(code: string): string {
	return code
		.split(/[_-]/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

/** Read `obj[key]` as a non-empty string, or undefined. */
function str(obj: Dict | undefined, key: string): string | undefined {
	const v = obj?.[key];
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export const translationSyncSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	locales: z
		.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/))
		.optional()
		.describe(
			"Non-English locales to sync. Default: every entry in manifest.supportedLocales — exactly the set install requires. An English locale is refused: install never reads translations/en*.json, English text belongs in the definitions.",
		),
	prune: z
		.boolean()
		.default(false)
		.describe(
			"Remove keys that no longer correspond to anything in the module (e.g. after an entity delete). Off by default — pruning discards translated text.",
		),
};

interface SkeletonEntry {
	/** Dotted path into the locale JSON, e.g. entities.todo_item.fields.title.label */
	pathParts: string[];
	/** English source text to seed a missing key with. */
	english: string;
	/** True when install FAILS if this key is absent (roles only, today). */
	required: boolean;
	/** Where older files held this text; a translation there is carried over. */
	legacyParts?: string[];
	/** Not created by sync, but not an orphan either: prune keeps it (older nested menu keys). */
	tolerated?: boolean;
}

/** Script messages built by joining text and values: they have no fixed text to translate. */
interface JoinedMessage {
	script: string;
	builtin: string;
}

/** Build the full set of translatable keys from the module's own files. */
function buildSkeleton(moduleDir: string): {
	entries: SkeletonEntry[];
	counts: Record<string, number>;
	joined: JoinedMessage[];
	notes: string[];
} {
	const { paths, manifest } = loadManifest(moduleDir);
	const entries: SkeletonEntry[] = [];
	const counts: Record<string, number> = {};
	const notes: string[] = [];
	// Overlaid on the platform traits as the installer does, so a module-local
	// trait's columns get labels instead of reading as an unknown trait code.
	const { traits: localTraits, error: traitsError } = readLocalTraits(paths.root);
	if (traitsError) {
		throw new Error(
			`traits.json — ${traitsError} Its traits can't be overlaid, so the entities that use one ` +
				"would be skipped as declaring an unknown trait and their columns would go unlabelled — " +
				"which fails the install. Fix the file and sync again.",
		);
	}
	const push = (
		section: string,
		pathParts: string[],
		english: string,
		required = false,
		legacyParts?: string[],
	) => {
		entries.push({ pathParts, english, required, legacyParts });
		counts[section] = (counts[section] ?? 0) + 1;
	};
	/** Option labels of a dropdown/radio/flags column or param: `{ value, label }` entries. */
	const pushOptions = (section: string, base: string[], holder: Dict | undefined): void => {
		const options = (holder?.params as Dict | undefined)?.options;
		if (!Array.isArray(options)) return;
		for (const o of options) {
			if (!o || typeof o !== "object") continue;
			const value = (o as Dict).value;
			const label = str(o as Dict, "label");
			if ((typeof value === "string" || typeof value === "number") && label) {
				push(section, [...base, "options", String(value)], label);
			}
		}
	};

	// ── entities + fields (including trait-provided columns, which users see) ──
	// An unreadable entity file is FATAL here, not skippable. Skipping it would
	// silently drop that entity's keys from the skeleton, the tool would report
	// success, and the module would then fail install on the missing labels —
	// with nothing pointing back at the real cause.
	for (const [name, relPath] of Object.entries((manifest.entities ?? {}) as Record<string, string>)) {
		if (name.includes(".")) continue; // cross-module extension — foreign module owns it
		const abs = entityFilePath(paths.root, relPath);
		if (!fs.existsSync(abs)) {
			throw new Error(
				`manifest.entities.${name} points at '${relPath}', which does not exist on disk. ` +
					"Fix the manifest or restore the file — syncing now would silently omit that entity's " +
					"translation keys and the gap would only surface at install.",
			);
		}
		let e: Dict;
		try {
			e = JSON.parse(fs.readFileSync(abs, "utf8")) as Dict;
		} catch (ex) {
			throw new Error(`${relPath} is not valid JSON: ${(ex as Error).message}`);
		}
		push("entities", ["entities", name, "label"], str(e, "description") ?? titleize(name));

		const authored = (e.fields as Record<string, Dict> | undefined) ?? {};
		// Trait-provided columns are user-visible and need labels, so an unknown
		// trait means an incomplete skeleton — and expandTraits would drop it
		// silently rather than complain.
		const traitCodes = (e.traits as string[] | undefined) ?? [];
		assertKnownTraits(traitCodes, name, localTraits);
		const traitFields = expandTraits(traitCodes, name, localTraits) as Record<string, Dict>;
		const all = { ...traitFields, ...authored };
		for (const [fname, f] of Object.entries(all)) {
			push(
				"fields",
				["entities", name, "fields", fname, "label"],
				str(f, "description") ?? str(f, "label") ?? titleize(fname),
			);
			pushOptions("options", ["entities", name, "fields", fname], f);
		}
		// Constraint violation messages (opt-in; validate warns when a locale lacks one).
		if (!(typeof e.extends === "string" && e.extends)) {
			const constraints = (e.constraints as Record<string, Dict> | undefined) ?? {};
			for (const [cname, c] of Object.entries(constraints)) {
				const msg = c && typeof c === "object" ? str(c, "message") : undefined;
				if (msg) push("constraints", ["entities", name, "constraints", cname, "message"], msg);
			}
		}
	}

	// ── views ──
	const views = readJsonOrDefault<Record<string, Dict>>(paths.dataViews, {});
	for (const [code, v] of Object.entries(views)) {
		push("views", ["views", code, "label"], str(v, "label") ?? titleize(code));
	}

	// ── menus ──
	// Install requires the FLAT form: every item (section or leaf, at any depth)
	// is `menus.<menu>.items.<item_code>.label`, keyed by the item's own code
	// directly under the root menu. The nested `items.<section>.items.<leaf>` form
	// older syncs wrote is never created now; an existing one is tolerated by prune.
	const menus = readJsonOrDefault<Record<string, Dict>>(paths.menus, {});
	for (const [code, m] of Object.entries(menus)) {
		push("menus", ["menus", code, "label"], str(m, "label") ?? str(m, "description") ?? titleize(code));
		const seenItems = new Set<string>();
		const walkMenu = (node: Dict, nested: string[]): void => {
			const children =
				(node.items as Record<string, Dict> | undefined) ??
				(node.children as Record<string, Dict> | undefined) ??
				{};
			for (const [icode, child] of Object.entries(children)) {
				if (!child || typeof child !== "object") continue;
				const nestedNext = [...nested, "items", icode];
				if (seenItems.has(icode)) {
					notes.push(`menu '${code}' uses item code '${icode}' more than once — install keys items by code, so rename one.`);
				} else {
					seenItems.add(icode);
					push("menus", ["menus", code, "items", icode, "label"], str(child, "label") ?? str(child, "description") ?? titleize(icode));
				}
				if (nested.length > 2) {
					entries.push({ pathParts: [...nestedNext, "label"], english: "", required: false, tolerated: true });
				}
				walkMenu(child, nestedNext);
			}
		};
		walkMenu(m, ["menus", code]);
	}

	// ── roles — the only completeness-ENFORCED section ──
	const roles = readJsonOrDefault<Record<string, Dict>>(paths.roles, {});
	for (const [code, r] of Object.entries(roles)) {
		push(
			"roles",
			["roles", code, "label"],
			str(r, "description") ?? titleize(code.split(".").pop() ?? code),
			true,
		);
	}

	// ── actions ──
	const actions = readJsonOrDefault<Record<string, Dict>>(paths.actions, {});
	const joined: JoinedMessage[] = [];
	for (const [code, a] of Object.entries(actions)) {
		push("actions", ["actions", code, "label"], str(a, "label") ?? str(a, "description") ?? titleize(code));
		// Params are declared in the script's `params:` block; install requires a label for each.
		const declared = a?.script;
		const script = typeof declared === "string" && declared ? declared : code;
		const file = path.join(paths.logicDir, "actions", `${script}.dsl`);
		if (!fs.existsSync(file)) continue;
		let doc: ReturnType<typeof parseDsl>;
		try {
			doc = parseDsl(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		for (const p of doc.params) {
			push("action params", ["actions", code, "params", p.name, "label"], p.label?.trim() || titleize(p.name));
		}
		for (const m of extractMessages(doc)) {
			if (m.text === undefined) joined.push({ script: `logic/actions/${script}.dsl`, builtin: m.builtin });
		}
	}

	// ── reports: label, params (report level and per dataset), dataset captions ──
	const reports = readJsonOrDefault<Record<string, Dict>>(paths.reports, {});
	for (const [code, r] of Object.entries(reports)) {
		if (!r || typeof r !== "object") continue;
		push("reports", ["reports", code, "label"], str(r, "label") ?? str(r, "description") ?? titleize(code));
		const datasets = (r.datasets as Record<string, Dict> | undefined) ?? {};
		const params: Record<string, Dict> = {};
		for (const d of Object.values(datasets)) {
			if (d?.params && typeof d.params === "object") Object.assign(params, d.params as Dict);
		}
		for (const key of ["parameters", "params"]) {
			if (r[key] && typeof r[key] === "object" && !Array.isArray(r[key])) Object.assign(params, r[key] as Dict);
		}
		for (const [pcode, p] of Object.entries(params)) {
			if (!p || typeof p !== "object") continue;
			push("report params", ["reports", code, "params", pcode, "label"], str(p, "label") ?? titleize(pcode));
			pushOptions("options", ["reports", code, "params", pcode], p);
		}
		for (const [dcode, d] of Object.entries(datasets)) {
			push("captions", ["reports", code, "datasets", dcode, "caption"], str(d, "caption") ?? titleize(dcode));
		}
	}

	// ── registers (registers.json at the module root) ──
	const registers = readJsonOrDefault<Record<string, Dict>>(path.join(paths.root, "registers.json"), {});
	for (const [code, g] of Object.entries(registers)) {
		if (!g || typeof g !== "object") continue;
		push("registers", ["registers", code, "label"], str(g, "label") ?? str(g, "description") ?? titleize(code));
	}

	// ── folders (root + every nested sub-folder) ──
	// A sub-folder is keyed by the flat code the installer gives it — the module
	// code and its path joined with `_` (`ops_north`). That is the key install's
	// completeness check requires and the registrar resolves to the folder row.
	// Role rights still address a folder by its bare code (`folder:<code>`), so
	// two folders sharing one stay refused. dforge_folder_add and
	// dforge_module_validate enforce the same rule.
	const folders = readJsonOrDefault<Dict>(paths.folders, {});
	if (Object.keys(folders).length > 0) {
		const dupes = duplicateFolderCodes(folders);
		if (dupes.size > 0) {
			const detail = [...dupes]
				.map(([code, paths_]) => `'${code}' (${paths_.join(", ")})`)
				.join("; ");
			throw new Error(
				`ui/folders.json reuses folder code(s) across branches: ${detail}. Role rights ` +
					"(`folder:<code>`) can't tell them apart. Rename them to unique codes, then re-run.",
			);
		}
		// The root folder has no code of its own — it IS the file — so it's keyed
		// on the module code.
		push("folders", ["folders", manifest.code, "label"], str(folders, "label") ?? titleize(manifest.code));
		for (const f of walkFolders(folders)) {
			const flatCode = [manifest.code, ...f.path.split("/")].join("_");
			// Earlier syncs keyed a sub-folder by its bare code, which install never applied.
			push("folders", ["folders", flatCode, "label"], str(f.node, "label") ?? titleize(f.code), false, [
				"folders",
				f.code,
				"label",
			]);
		}
	}

	// ── settings (completeness-checked for declared locales) ──
	// Install labels a setting with its `description`; `label` and the short
	// `desc` are fallbacks for older files.
	const settings = readJsonOrDefault<Record<string, Dict>>(paths.settings, {});
	for (const [code, s] of Object.entries(settings)) {
		push("settings", ["settings", code, "label"], str(s, "description") ?? str(s, "label") ?? str(s, "desc") ?? titleize(code));
	}

	// ── DSL messages: info / warn / error / exit texts, keyed by the English text ──
	// Library functions (logic/functions/*.dsl) are called from the actions, so their
	// texts show at run time and the CLI reports them untranslated: seed them too.
	for (const text of allMessageTexts(paths.logicDir, actions).keys()) {
		push("messages", ["messages", text], text);
	}
	joined.push(...libraryMessages(paths.logicDir).joined);

	return { entries, counts, joined, notes };
}

const getIn = (root: Dict, parts: string[]): unknown =>
	parts.reduce<unknown>((acc, p) => (acc && typeof acc === "object" ? (acc as Dict)[p] : undefined), root);

function setIn(root: Dict, parts: string[], value: unknown): void {
	let cursor: Dict = root;
	for (const p of parts.slice(0, -1)) {
		if (!cursor[p] || typeof cursor[p] !== "object") cursor[p] = {};
		cursor = cursor[p] as Dict;
	}
	cursor[parts[parts.length - 1]] = value;
}

/** Top-level sections sync manages: only inside these may prune delete anything. */
const MANAGED = new Set(["entities", "views", "menus", "roles", "actions", "reports", "registers", "settings", "folders", "messages"]);
/** Keys that hold a collection of codes — a member there that nothing declares is an orphan. */
const COLLECTIONS = new Set(["fields", "params", "datasets", "constraints", "items"]);

/**
 * Drop keys that correspond to nothing in the module. A leaf is kept when it is a
 * skeleton key, or when it hangs off an object that still exists (the object's
 * `desc`, hand-added `options`, ...). It is dropped only when its owner (an entity,
 * field, action, param, dataset, menu item ...) is gone. `messages` is exact.
 */
function pruneTo(existing: Dict, entries: SkeletonEntry[]): Dict {
	const keep = new Set(entries.map((e) => compositeKey(...e.pathParts)));
	// Every live owner path: each skeleton key's parent and its ancestors.
	const live = new Set<string>();
	for (const e of entries) {
		for (let n = 2; n < e.pathParts.length; n++) live.add(compositeKey(...e.pathParts.slice(0, n)));
	}
	const keepLeaf = (parts: string[]): boolean => {
		if (!MANAGED.has(parts[0])) return true;
		if (keep.has(compositeKey(...parts))) return true;
		if (parts[0] === "messages") return false;
		for (let n = parts.length - 1; n >= 2; n--) {
			if (COLLECTIONS.has(parts[n - 1])) continue; // a container, not an owner
			if (live.has(compositeKey(...parts.slice(0, n)))) return !COLLECTIONS.has(parts[n]);
		}
		return false;
	};
	const walk = (node: Dict, trail: string[]): Dict => {
		const out: Dict = {};
		for (const [k, v] of Object.entries(node)) {
			const parts = [...trail, k];
			if (v && typeof v === "object" && !Array.isArray(v)) {
				const sub = walk(v as Dict, parts);
				if (Object.keys(sub).length > 0) out[k] = sub;
				continue;
			}
			if (keepLeaf(parts)) out[k] = v;
		}
		return out;
	};
	return walk(existing, []);
}

export function translationSync(
	args: z.infer<z.ZodObject<typeof translationSyncSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const declared = Array.isArray(manifest.supportedLocales)
		? (manifest.supportedLocales as unknown[]).filter((l): l is string => typeof l === "string")
		: [];
	const isEnglish = (l: string) => l.toLowerCase() === "en" || l.toLowerCase().startsWith("en-");
	const english = (args.locales ?? []).filter(isEnglish);
	if (english.length > 0) {
		throw new Error(
			`Refusing to sync ${english.join(", ")}: install never reads translations/en*.json. English is the base ` +
				"locale and lives in the definitions — an entity's or field's `description`, a menu's, action's or " +
				"report's `label`, a role's or setting's `description`. Edit the text there.",
		);
	}
	// A manifest that still lists English (legacy shape) must not get an English file: skip it.
	const ignored = fs.existsSync(paths.translationsDir)
		? fs.readdirSync(paths.translationsDir).filter((f) => f.toLowerCase().endsWith(".json") && isEnglish(f.slice(0, -5)))
		: [];
	const staleEnglish = ignored.length > 0
		? ` Leftover ${ignored.map((f) => `translations/${f}`).join(", ")} is never read by install — move any wording you want from it into the definitions, then delete it.`
		: "";
	const locales = args.locales ?? declared.filter((l) => !isEnglish(l));
	if (locales.length === 0) {
		throw new Error(
			"No locales to sync. An English-only module needs no translation files: its English text lives in the " +
				"definitions. To translate, declare the other locales in manifest.supportedLocales (e.g. [\"uk-UA\"])." + staleEnglish,
		);
	}

	const { entries: allEntries, counts, joined, notes } = buildSkeleton(args.moduleDir);
	const entries = allEntries.filter((e) => !e.tolerated);
	if (entries.length === 0) {
		throw new Error(
			"Nothing translatable found — the module has no entities, views, menus, or roles yet. Author them first.",
		);
	}

	const files: Record<string, string> = {};
	const report: string[] = [];
	let totalAdded = 0;
	let missingRequired = 0;
	const seeded: string[] = [];

	for (const locale of locales) {
		const abs = path.join(paths.translationsDir, `${locale}.json`);
		let existing: Dict = {};
		if (fs.existsSync(abs)) {
			try {
				existing = JSON.parse(fs.readFileSync(abs, "utf8")) as Dict;
			} catch (e) {
				throw new Error(`translations/${locale}.json is not valid JSON: ${(e as Error).message}`);
			}
		}

		const next: Dict = args.prune ? pruneTo(existing, allEntries) : JSON.parse(JSON.stringify(existing));
		let added = 0;
		for (const entry of entries) {
			const current = getIn(next, entry.pathParts);
			// Never overwrite existing translated text.
			if (typeof current === "string" && current.trim() !== "") continue;
			const legacy = entry.legacyParts && getIn(existing, entry.legacyParts);
			setIn(next, entry.pathParts, typeof legacy === "string" && legacy.trim() !== "" ? legacy : entry.english);
			added++;
			if (entry.required) missingRequired++;
		}

		files[rel(paths.root, abs)] = jsonText(next);
		totalAdded += added;
		if (added > 0) seeded.push(locale);
		report.push(`${locale}: +${added} key(s)${added === 0 ? " (already complete)" : ""}`);
	}

	const warnings: string[] = [];
	if (totalAdded > 0) {
		warnings.push(
			`Newly-added keys in ${seeded.join(", ")} are seeded with the ENGLISH source text so the file is ` +
				"installable immediately — they still need real translation.",
		);
	}
	if (ignored.length > 0) {
		warnings.push(
			`${ignored.map((f) => `translations/${f}`).join(", ")} is never read by install — the English UI shows the ` +
				"definitions' own `description` / `label`. Move any wording you want from it into the definitions, then delete it.",
		);
	}
	if (joined.length > 0) {
		const byScript = new Map<string, number>();
		for (const j of joined) byScript.set(j.script, (byScript.get(j.script) ?? 0) + 1);
		const list = [...byScript].map(([s, n]) => `${s} (${n})`).join(", ");
		warnings.push(
			`${joined.length} message(s) in actions or function libraries join text and values, so they cannot be translated and are not in \`messages\`: ${list}. ` +
				"Rewrite each with placeholders, e.g. error('Only {n} left', { n: qty }).",
		);
	}
	warnings.push(...notes);
	const warning = warnings.length > 0 ? warnings.join(" ") : undefined;

	const sections = Object.entries(counts)
		.map(([k, v]) => `${v} ${k}`)
		.join(", ");
	return makeResult(
		`Synced ${locales.length} locale file(s) from ${entries.length} translatable keys (${sections}). ` +
			`${report.join("; ")}.${missingRequired > 0 ? ` Filled ${missingRequired} install-blocking role label(s).` : ""}`,
		files,
		warning,
	);
}
