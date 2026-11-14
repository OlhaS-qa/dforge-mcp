// Import core: turn a normalized table-spec (tables → columns → relationships)
// into dForge entities. This is the shared transformer that the front-ends feed
// — DBML/SQL, an Excel/CSV upload, or a hand-authored spec. The interesting part
// is type inference: a column's fieldTypeCd is derived from an explicit code, a
// source SQL type, sample values, and name heuristics — then validated against
// the @dforge-core/metadata registry, with dbDatatype derived from it.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isFieldTypeCd, deriveDbDatatype } from "@dforge-core/metadata";
import type { EntitySpec, ScaffoldOpts } from "@dforge-core/dforge-cli/templates";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	expandedEntity,
	loadManifest,
	jsonText,
	makeResult,
	withTodayStamp,
	type Manifest,
	type ToolResult,
} from "./_helpers";
import { additiveNotice, adminRightsInput, ensureToString, mergeUiAndSecurity } from "./add-entity";

// Identity for a NEW module — supplied only when importing into an empty dir
// (greenfield). When a manifest already exists it's ignored.
const moduleIdentitySchema = z
	.object({
		code: codeReLazy(),
		displayName: z.string().optional(),
		version: z.string().optional(),
		dbSchemaVersion: z.string().optional(),
		license: z.string().optional(),
	})
	.optional();

// codeRe is declared below; this defers the reference so order doesn't matter.
function codeReLazy() {
	return z.string().regex(/^[a-z][a-z0-9_]*$/);
}

/** Load the module's manifest, or synthesize a minimal one for a greenfield import. */
function ensureManifest(moduleDir: string, identity?: z.infer<typeof moduleIdentitySchema>): Manifest {
	try {
		return loadManifest(moduleDir).manifest;
	} catch {
		if (!identity?.code) {
			throw new Error(`No manifest.json in '${moduleDir}'. Pass module.code (and module.displayName) to start a new module from this import.`);
		}
		return {
			packageFormat: 1,
			moduleId: randomUUID(),
			code: identity.code,
			version: identity.version ?? "0.1.0",
			dbSchemaVersion: identity.dbSchemaVersion ?? "0.0.1",
			displayName: identity.displayName ?? identity.code,
			license: identity.license ?? "MIT",
			entities: {},
		} as Manifest;
	}
}

/** One source construct the import could not (fully) carry into the entity JSON. */
export interface Loss {
	where: string;
	what: string;
}

/** Counters of what WAS carried — so the report can say it, not only what was lost. */
interface Carried {
	enums: number;
	unique: number;
	defaults: number;
	checks: number;
	lengths: number;
	notes: number;
	indexes: number;
}
const newCarried = (): Carried => ({ enums: 0, unique: 0, defaults: 0, checks: 0, lengths: 0, notes: 0, indexes: 0 });

type OnExisting = "error" | "skip" | "replace";

/** The PK column of an entity already on disk (identity trait or an `isPk` field), if any. */
function diskPk(moduleDir: string, entity: string): string | undefined {
	try {
		const e = JSON.parse(fs.readFileSync(path.join(moduleDir, "entities", `${entity}.json`), "utf8"));
		const { fieldDefs } = expandedEntity(e, entity);
		const pks = Object.entries(fieldDefs).filter(([, f]) => f.isPk === true).map(([k]) => k);
		return pks.length === 1 ? pks[0] : undefined;
	} catch {
		return undefined;
	}
}

interface ImportOutcome {
	files: Record<string, string>;
	added: string[];
	skipped: string[];
	replaced: string[];
	losses: Loss[];
	carried: Carried;
	notice: string;
}

/**
 * Build the file map for importing `tables` into a module: manifest + entities,
 * plus an ADDITIVE merge of the default view / folder entry / menu leaf / admin
 * right for each new entity (existing UI and security files are preserved).
 */
function buildImportFiles(
	moduleDir: string,
	manifest: Manifest,
	tables: Table[],
	onExisting: OnExisting,
	parseLosses: Loss[] = [],
	adminRights?: string,
): ImportOutcome {
	const root = path.resolve(moduleDir);
	const existing = new Set(Object.keys(manifest.entities ?? {}));
	const files: Record<string, string> = {};
	const added: string[] = [];
	const skipped: string[] = [];
	const replaced: string[] = [];
	const losses: Loss[] = [...parseLosses];
	const carried = newCarried();
	const manifestEntities: Record<string, string> = { ...((manifest.entities as Record<string, string>) ?? {}) };

	const clashes = tables.filter((t) => existing.has(t.name)).map((t) => t.name);
	if (clashes.length && onExisting === "error") {
		throw new Error(
			`Entit${clashes.length === 1 ? "y" : "ies"} ${clashes.map((c) => `'${c}'`).join(", ")} already exist${clashes.length === 1 ? "s" : ""} in this module — ` +
				`import only ADDS by default. Remove them from the source, or pass onExisting: 'skip' (keep the entity on disk) or 'replace' (overwrite entities/<name>.json with the imported definition; UI and security stay untouched).`,
		);
	}

	// Primary-key resolver for FK targets: this import's entities use the identity
	// PK '<entity>_id'; an entity already on disk reports its own PK.
	const importing = new Set(tables.filter((t) => !(existing.has(t.name) && onExisting === "skip")).map((t) => t.name));
	const pkOf = (entity: string): string => {
		if (!importing.has(entity)) {
			const d = diskPk(root, entity);
			if (d) return d;
		}
		return `${entity}_id`;
	};

	const news: Array<{ name: string; label: string; entity: Record<string, unknown> }> = [];
	for (const table of tables) {
		const isExisting = existing.has(table.name);
		if (isExisting && onExisting === "skip") {
			skipped.push(table.name);
			continue;
		}
		const built = buildImportedEntity(table, pkOf);
		losses.push(...built.losses);
		for (const k of Object.keys(carried) as Array<keyof Carried>) carried[k] += built.carried[k];
		files[`entities/${table.name}.json`] = jsonText(built.entity);
		manifestEntities[table.name] = `./entities/${table.name}.json`;
		if (isExisting) replaced.push(table.name);
		else {
			added.push(table.name);
			news.push({ name: table.name, label: table.label ?? titleCase(table.name), entity: built.entity });
		}
	}
	manifest.entities = manifestEntities;

	const allSpecs: EntitySpec[] = Object.keys(manifestEntities)
		.filter((n) => !n.includes("."))
		.map((n) => ({ name: n, label: tableLabel(root, n, tables), traits: "identity" }));
	const opts: ScaffoldOpts = {
		path: "",
		code: manifest.code,
		displayName: manifest.displayName ?? manifest.code,
		description: manifest.description ?? "",
		author: "",
		license: (manifest.license as string) ?? "MIT",
		version: manifest.version ?? "0.1.0",
		dbSchemaVersion: manifest.dbSchemaVersion ?? "0.0.1",
		dependencies: Object.keys(manifest.dependencies ?? {}),
		preset: "minimal",
		entities: allSpecs,
	};
	const merged = mergeUiAndSecurity(root, opts, news, allSpecs, adminRights);
	Object.assign(files, merged.files);
	files["manifest.json"] = jsonText(withTodayStamp(manifest));

	const otherFiles = [`manifest.json entit${added.length === 1 ? "y" : "ies"} ${added.join(", ") || "(none)"}`, ...added.map((n) => `entities/${n}.json`)];
	let notice = additiveNotice(merged, otherFiles);
	if (replaced.length) {
		notice += `\nREPLACED on request (onExisting: 'replace'): ${replaced.map((n) => `entities/${n}.json`).join(", ")} — the previous definition was discarded; their views/menus/roles were left as they are, so re-check the view columns.`;
	}
	if (skipped.length) notice += `\nSKIPPED (already in the module, onExisting: 'skip'): ${skipped.join(", ")}.`;
	return { files, added, skipped, replaced, losses, carried, notice };
}

function tableLabel(root: string, name: string, tables: Table[]): string {
	const t = tables.find((x) => x.name === name);
	if (t?.label) return t.label;
	try {
		const e = JSON.parse(fs.readFileSync(path.join(root, "entities", `${name}.json`), "utf8"));
		if (typeof e.description === "string") return e.description;
	} catch {
		/* new entity */
	}
	return titleCase(name);
}

const codeRe = z.string().regex(/^[a-z][a-z0-9_]*$/);

const columnSpec = z.object({
	name: codeRe.describe("Column code (snake_case)."),
	label: z.string().optional(),
	fieldTypeCd: z.string().optional().describe("Explicit field type; omit to infer."),
	sqlType: z.string().optional().describe("Source SQL type hint, e.g. varchar(50), int, numeric(18,2), timestamptz, bool. varchar(n) sets maxLen, numeric(p,s) sets the numeric precision/scale, int/bigint keep their integer dbDatatype."),
	sampleValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("A few example cell values — used to infer the type when no sqlType is given."),
	required: z.boolean().optional(),
	unique: z.boolean().optional().describe("Single-column UNIQUE → a unique constraint on the entity."),
	default: z.string().optional().describe("Source default expression: 'draft' (quoted string), 0, true, or a backticked `now()` / `current_date`. Becomes the column's `formula` (entity fields have no defaultValue key). Anything else is reported in the loss report."),
	enumValues: z.array(z.string()).optional().describe("Allowed values (a DBML Enum) → a dropdown with params.options."),
	check: z.string().optional().describe("Source CHECK expression over this table's columns. Carried as a check constraint only when it is a simple boolean expression (comparisons, AND/OR/NOT, IN, BETWEEN, IS NULL, arithmetic); otherwise it goes to the loss report."),
	note: z.string().optional().describe("Source column note → the field's description (when short; a long note is reported)."),
});

const tableSpec = z.object({
	name: codeRe.describe("Entity code (snake_case)."),
	label: z.string().optional(),
	columns: z.array(columnSpec).min(1),
	references: z
		.array(
			z.object({
				column: codeRe.describe("FK column on THIS table (a hidden cuid column is generated for it)."),
				toTable: codeRe.describe("Target entity code."),
				toColumn: codeRe.optional().describe("Target PK column; defaults to the target's PK ({toTable}_id, or the PK of an entity already on disk). 'id' is treated as the default."),
				required: z
					.boolean()
					.optional()
					.describe(
						"Whether the relation is required — puts 'M' on both halves (FK 'EM', Reference 'VEM'), " +
							"which is what makes the FK column NOT NULL. Default: nullable.",
					),
			}),
		)
		.optional(),
	uniques: z
		.array(z.object({ name: codeRe.optional(), fields: z.array(codeRe).min(1) }))
		.optional()
		.describe("Composite (or extra) UNIQUE keys → unique constraints."),
	indexes: z
		.array(z.object({ name: codeRe.optional(), fields: z.array(codeRe).min(1), using: z.enum(["btree", "hash"]).optional() }))
		.optional()
		.describe("Plain (non-unique) indexes → entity `indexes`."),
});

const onExistingInput = z
	.enum(["error", "skip", "replace"])
	.optional()
	.describe(
		"Default 'error'. What to do with a table whose entity already exists in the module: 'error' (default, nothing written), 'skip' (keep the entity on disk) or 'replace' (overwrite entities/<name>.json with the imported definition — e.g. the stub dforge_module_create made; UI and security files are never overwritten).",
	);

export const moduleImportSchema = {
	moduleDir: z.string().describe("Path to the module dir. If it has no manifest, pass `module` to start a new module (greenfield import)."),
	tables: z.array(tableSpec).min(1).describe("Normalized table-spec, produced from DBML/SQL, an Excel/CSV upload (read by the AI), or hand-authored."),
	module: moduleIdentitySchema.describe("New-module identity — required only when moduleDir has no manifest yet."),
	onExisting: onExistingInput,
	adminRights: adminRightsInput.optional(),
};

type Column = z.infer<typeof columnSpec>;
type Table = z.infer<typeof tableSpec>;

// Source SQL type (lowercased, params stripped) → fieldTypeCd.
const SQL_TYPE_MAP: Record<string, string> = {
	varchar: "text", nvarchar: "text", char: "text", bpchar: "text", string: "text", character: "text", varying: "text", nchar: "text",
	text: "textarea", ntext: "textarea", clob: "textarea",
	int: "number", integer: "number", int2: "number", int4: "number", int8: "number",
	bigint: "number", smallint: "number", tinyint: "number", serial: "number", bigserial: "number", smallserial: "number",
	numeric: "number", decimal: "number", float: "number", float4: "number", float8: "number", double: "number", real: "number",
	money: "currency",
	bool: "checkbox", boolean: "checkbox", bit: "checkbox",
	date: "date",
	timestamp: "datetime", timestamptz: "datetime", datetime: "datetime", datetime2: "datetime",
	time: "time", timetz: "time",
	json: "json", jsonb: "json",
	uuid: "text",
};

const INT_TYPES = new Set(["int", "integer", "int2", "int4", "smallint", "tinyint", "serial", "smallserial"]);
const BIGINT_TYPES = new Set(["bigint", "int8", "bigserial"]);
const FLOAT_TYPES = new Set(["float", "float4", "float8", "double", "real"]);

function titleCase(code: string): string {
	return code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferFromSamples(samples: Array<string | number | boolean>): string {
	const vals = samples.filter((v) => v !== null && v !== "");
	if (!vals.length) return "text";
	if (vals.every((v) => typeof v === "boolean" || /^(true|false|yes|no)$/i.test(String(v)))) return "checkbox";
	if (vals.every((v) => typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)))) return "number";
	if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)))) return "date";
	return "text";
}

function sqlBase(sqlType?: string): string | undefined {
	return sqlType?.toLowerCase().replace(/\(.*$/, "").replace(/\[\]$/, "").trim();
}

const optionLabel = (v: string): string => (/^[a-z0-9_]+$/.test(v) ? titleCase(v) : v);

/** Resolve a column to a fieldTypeCd (+ optional params), layering the signals. */
function inferFieldType(col: Column): { fieldTypeCd: string; params?: Record<string, unknown>; unknownType?: string } {
	if (col.fieldTypeCd) return { fieldTypeCd: col.fieldTypeCd };

	// A DBML Enum (or explicit allowed values) → a dropdown with those options.
	if (col.enumValues?.length) {
		return { fieldTypeCd: "dropdown", params: { options: col.enumValues.map((v) => ({ value: v, label: optionLabel(v) })) } };
	}

	let base: string | undefined;
	let unknownType: string | undefined;
	const sb = sqlBase(col.sqlType);
	if (sb) {
		base = SQL_TYPE_MAP[sb];
		if (!base) unknownType = col.sqlType;
	}
	if (!base && col.sampleValues?.length) base = inferFromSamples(col.sampleValues);
	base = base ?? "text";

	const n = col.name.toLowerCase();
	if (base === "text" || base === "textarea") {
		if (/email/.test(n)) base = "email";
		else if (/phone|tel|mobile|fax/.test(n)) base = "phone";
		else if (/url|website|homepage/.test(n)) base = "url";
	}
	// An integer-typed column stays an integer: only fractional columns become currency by name.
	const isIntType = !!sb && (INT_TYPES.has(sb) || BIGINT_TYPES.has(sb));
	if (base === "number" && !isIntType && /price|amount|cost|total|salary|fee|balance|revenue|payment|wage/.test(n)) {
		base = "currency";
	}

	// A small set of repeated string values → a dropdown with those options.
	if (base === "text" && col.sampleValues && col.sampleValues.length >= 3) {
		const distinct = [...new Set(col.sampleValues.map(String))];
		if (distinct.length <= 8 && distinct.length < col.sampleValues.length) {
			return { fieldTypeCd: "dropdown", params: { options: distinct.map((v) => ({ value: v, label: v })) } };
		}
	}
	return { fieldTypeCd: base, ...(unknownType ? { unknownType } : {}) };
}

/** DBML default expression → entity `formula` (entity fields have no defaultValue key). */
function defaultToFormula(raw: string): string | undefined {
	const v = raw.trim();
	if (/^null$/i.test(v)) return undefined;
	let m = v.match(/^'((?:[^'\\]|\\.|'')*)'$/s) ?? v.match(/^"((?:[^"\\]|\\.)*)"$/s);
	if (m) return `'${m[1].replace(/\\(.)/g, "$1").replace(/''/g, "'").replace(/'/g, "''")}'`;
	if (/^-?\d+(\.\d+)?$/.test(v)) return v;
	if (/^(true|false)$/i.test(v)) return v.toLowerCase();
	m = v.match(/^`\s*(.*?)\s*`$/s);
	if (m) {
		const e = m[1].toLowerCase().replace(/\s+/g, "");
		if (/^(now\(\)|current_timestamp(\(\))?|getdate\(\)|localtimestamp)$/.test(e)) return "NOW()";
		if (/^(current_date(\(\))?|curdate\(\))$/.test(e)) return "TODAY()";
	}
	return undefined;
}

const SQL_KW = new Set(["and", "or", "not", "in", "is", "null", "between", "true", "false", "like"]);

/**
 * A CHECK expression is carried only when it is plainly a boolean expression over
 * this table's own columns: comparisons, AND/OR/NOT, IN (...), BETWEEN, IS [NOT]
 * NULL, LIKE, + - * / %. Function calls, casts, sub-selects and unknown names are
 * not — they go to the loss report instead of becoming a CHECK that fails install.
 */
function simpleCheck(raw: string, cols: Set<string>): { ok: true; expr: string } | { ok: false; why: string } {
	let e = raw.trim().replace(/^check\b\s*/i, "").trim();
	// Strip ONE pair of wrapping parentheses when they enclose the whole expression.
	while (e.startsWith("(") && e.endsWith(")")) {
		let depth = 0;
		let wraps = true;
		for (let i = 0; i < e.length - 1; i++) {
			if (e[i] === "(") depth++;
			else if (e[i] === ")") depth--;
			if (depth === 0) {
				wraps = false;
				break;
			}
		}
		if (!wraps) break;
		e = e.slice(1, -1).trim();
	}
	if (!e) return { ok: false, why: "empty expression" };
	if (/[;`$]|--|\/\*|::/.test(e)) return { ok: false, why: "contains a cast, comment or unsupported symbol" };
	let out = "";
	let i = 0;
	let parens = 0;
	while (i < e.length) {
		const rest = e.slice(i);
		let m: RegExpMatchArray | null;
		if ((m = rest.match(/^\s+/))) out += m[0];
		else if ((m = rest.match(/^'(?:[^']|'')*'/))) out += m[0];
		else if ((m = rest.match(/^\d+(?:\.\d+)?/))) out += m[0];
		else if ((m = rest.match(/^(<=|>=|<>|!=|=|<|>|\+|-|\*|\/|%|,)/))) out += m[0];
		else if ((m = rest.match(/^\(/))) {
			parens++;
			out += "(";
		} else if ((m = rest.match(/^\)/))) {
			if (--parens < 0) return { ok: false, why: "unbalanced parentheses" };
			out += ")";
		} else if ((m = rest.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?/))) {
			const word = m[1];
			const lower = word.toLowerCase();
			if (SQL_KW.has(lower)) out += lower === word ? word : word.toUpperCase();
			else {
				if (/^\s*\(/.test(rest.slice(m[0].length))) return { ok: false, why: `calls the function ${word}()` };
				const col = snake(word);
				if (!cols.has(col)) return { ok: false, why: `refers to '${word}', which is not a column of this table` };
				out += col;
			}
		} else return { ok: false, why: `unsupported syntax near '${rest.slice(0, 12)}'` };
		i += m[0].length;
	}
	if (parens !== 0) return { ok: false, why: "unbalanced parentheses" };
	return { ok: true, expr: out.trim() };
}

function buildImportedEntity(
	table: Table,
	pkOf: (entity: string) => string = (e) => `${e}_id`,
): { entity: Record<string, unknown>; losses: Loss[]; carried: Carried } {
	const fields: Record<string, unknown> = {};
	const losses: Loss[] = [];
	const carried = newCarried();
	const constraints: Record<string, unknown> = {};
	const refColumns = new Set((table.references ?? []).map((r) => r.column));
	const colNames = new Set([...table.columns.map((c) => c.name), ...refColumns]);
	let order = 10;
	let toStringField: string | undefined;

	for (const col of table.columns) {
		if (refColumns.has(col.name)) continue; // emitted as an FK pair below
		const where = `${table.name}.${col.name}`;
		const inf = inferFieldType(col);
		if (!isFieldTypeCd(inf.fieldTypeCd)) {
			throw new Error(`Inferred an invalid fieldTypeCd '${inf.fieldTypeCd}' for ${table.name}.${col.name} — pass an explicit fieldTypeCd.`);
		}
		if (inf.unknownType) losses.push({ where, what: `source type '${inf.unknownType}' is not known — imported as text; set the right field type.` });

		const sb = sqlBase(col.sqlType);
		const params = col.sqlType?.match(/\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/);
		const field: Record<string, unknown> = {
			fieldTypeCd: inf.fieldTypeCd,
			flags: col.required ? "VEM" : "VE",
			orderNum: order,
			description: col.label ?? titleCase(col.name),
		};
		let db = deriveDbDatatype(inf.fieldTypeCd);
		// Integer source types stay integers (the default for `number` is numeric).
		if (inf.fieldTypeCd === "number" && sb) {
			if (BIGINT_TYPES.has(sb)) db = "bigint";
			else if (INT_TYPES.has(sb)) db = "int";
			else if (FLOAT_TYPES.has(sb)) losses.push({ where, what: `${col.sqlType} imported as numeric (arbitrary precision, not binary floating point).` });
		}
		// numeric(p,s) / decimal(p,s) → numeric(p,s).
		if (params && params[2] !== undefined && (sb === "numeric" || sb === "decimal") && ["number", "currency", "percent"].includes(inf.fieldTypeCd)) {
			db = `numeric(${params[1]},${params[2]})`;
			carried.lengths++;
		}
		if (db) field.dbDatatype = db;
		// varchar(n) / char(n) → maxLen.
		if (params && params[2] === undefined && ["varchar", "nvarchar", "char", "bpchar", "nchar", "character", "string"].includes(sb ?? "") && ["text", "email", "phone", "url", "dropdown"].includes(inf.fieldTypeCd)) {
			field.maxLen = Number(params[1]);
			carried.lengths++;
		}
		if (inf.params) {
			field.params = inf.params;
			if (col.enumValues?.length) carried.enums++;
		}

		if (col.note) {
			if (col.note.length <= 80) {
				field.description = col.note;
				carried.notes++;
			} else {
				losses.push({ where, what: `note is too long for a field description (${col.note.length} chars) — not carried: "${col.note.slice(0, 60)}…"` });
			}
		}
		if (col.default !== undefined) {
			const formula = defaultToFormula(col.default);
			if (formula !== undefined) {
				field.formula = formula;
				carried.defaults++;
			} else if (!/^null$/i.test(col.default.trim())) {
				losses.push({ where, what: `default ${col.default} cannot be expressed as a field formula — not carried.` });
			}
		}
		if (col.unique) {
			constraints[`uq_${table.name}_${col.name}`] = { type: "unique", fields: [col.name], message: `${titleCase(col.name)} must be unique.` };
			carried.unique++;
		}
		if (col.check) {
			const c = simpleCheck(col.check, colNames);
			if (c.ok) {
				constraints[`ck_${table.name}_${col.name}`] = { type: "check", expression: c.expr, fields: [col.name], message: `${titleCase(col.name)} must satisfy: ${c.expr}` };
				carried.checks++;
			} else {
				losses.push({ where, what: `CHECK ${col.check.replace(/^check\s*/i, "")} not carried — ${c.why}.` });
			}
		}

		fields[col.name] = field;
		if (!toStringField && inf.fieldTypeCd === "text") toStringField = col.name;
		order += 10;
	}

	// FK + Reference pairs.
	const references: Record<string, unknown> = {};
	for (const ref of table.references ?? []) {
		const otherKey = !ref.toColumn || ref.toColumn === "id" ? pkOf(ref.toTable) : ref.toColumn;
		// Take 'M' from the source column's own nullability rather than assuming
		// every relation is required: 'M' resolves to isNullable:false at install,
		// so a blanket 'EM' would emit NOT NULL for FKs the source declares
		// optional — and the import would then contradict itself on the Reference.
		const required =
			ref.required === true || table.columns.find((c) => c.name === ref.column)?.required === true;
		fields[ref.column] = {
			dbDatatype: "cuid",
			flags: required ? "EM" : "E",
			orderNum: order,
			description: titleCase(ref.column),
		};
		order += 10;
		const refName = ref.column.endsWith("_id") ? ref.column.slice(0, -3) : `${ref.column}_ref`;
		fields[refName] = {
			columnType: "R",
			fieldTypeCd: "lookup",
			flags: required ? "VEM" : "VE",
			orderNum: order,
			description: titleCase(refName),
			link: { entity: ref.toTable, thisKey: ref.column, otherKey },
		};
		order += 10;
		references[`FK_${titleCase(table.name).replace(/\s+/g, "")}_${ref.column}`] = {
			from: { field: ref.column },
			to: { entity: ref.toTable, field: otherKey },
		};
	}

	// Table-level unique keys and plain indexes.
	const indexes: Record<string, unknown> = {};
	const known = new Set([...Object.keys(fields), ...colNames]);
	for (const u of table.uniques ?? []) {
		const missing = u.fields.filter((f) => !known.has(f));
		if (missing.length) {
			losses.push({ where: table.name, what: `unique key (${u.fields.join(", ")}) not carried — column(s) ${missing.join(", ")} are not on the entity.` });
			continue;
		}
		const name = u.name ?? `uq_${table.name}_${u.fields.join("_")}`;
		constraints[name] = { type: "unique", fields: u.fields, message: `${u.fields.map(titleCase).join(" + ")} must be unique.` };
		carried.unique++;
	}
	for (const ix of table.indexes ?? []) {
		const missing = ix.fields.filter((f) => !known.has(f));
		if (missing.length) {
			losses.push({ where: table.name, what: `index (${ix.fields.join(", ")}) not carried — column(s) ${missing.join(", ")} are not on the entity.` });
			continue;
		}
		indexes[ix.name ?? `idx_${table.name}_${ix.fields.join("_")}`] = { fields: ix.fields, ...(ix.using ? { using: ix.using } : {}) };
		carried.indexes++;
	}

	let entity: Record<string, unknown> = {
		description: table.label ?? titleCase(table.name),
		dbObject: table.name,
		toString: toStringField ? `{${toStringField}}` : null,
		traits: ["identity", "audit"],
		fields,
	};
	if (Object.keys(references).length) entity.references = references;
	if (Object.keys(constraints).length) entity.constraints = constraints;
	if (Object.keys(indexes).length) entity.indexes = indexes;
	// No text column to show? Fall back to the PK rather than a null toString.
	entity = ensureToString(entity, table.name);
	return { entity, losses, carried };
}

function formatLosses(losses: Loss[]): string {
	if (!losses.length) return "Loss report: none — every source construct the importer understands was carried.";
	return (
		`Loss report — ${losses.length} source construct(s) NOT carried into the entities (handle by hand):\n` +
		losses.map((l) => `  - ${l.where}: ${l.what}`).join("\n")
	);
}

function carriedLine(c: Carried): string {
	const parts = [
		c.enums && `${c.enums} enum dropdown(s)`,
		c.unique && `${c.unique} unique constraint(s)`,
		c.defaults && `${c.defaults} default formula(s)`,
		c.checks && `${c.checks} check constraint(s)`,
		c.lengths && `${c.lengths} length/precision(s)`,
		c.notes && `${c.notes} note description(s)`,
		c.indexes && `${c.indexes} index(es)`,
	].filter(Boolean);
	return parts.length ? `Carried: ${parts.join(", ")}.` : "";
}

function importResult(verb: string, out: ImportOutcome): ToolResult {
	const warning = [
		out.notice,
		formatLosses(out.losses),
		"Review the inferred field types (dropdown vs text, currency vs number) and the default grids. Cross-table references resolve only if both tables are in this import or already in the module. Run dforge_module_validate after writing.",
	].join("\n\n");
	const summary =
		`${verb} ${out.added.length} entit${out.added.length === 1 ? "y" : "ies"} (${out.added.join(", ") || "none"}); ` +
		`${out.losses.length} source construct(s) not carried${out.losses.length ? " — see the loss report in `warning`" : ""}. ${carriedLine(out.carried)} ` +
		"Existing UI/security files were merged additively, nothing existing was overwritten.";
	const result = makeResult(summary.trim(), out.files, warning);
	result.files["_import_report.json"] = jsonText({ added: out.added, skipped: out.skipped, replaced: out.replaced, losses: out.losses });
	return result;
}

export function moduleImport(
	args: z.infer<z.ZodObject<typeof moduleImportSchema>>,
): ToolResult {
	const manifest = ensureManifest(args.moduleDir, args.module);
	const out = buildImportFiles(args.moduleDir, manifest, args.tables, args.onExisting ?? "error", [], args.adminRights);
	return importResult("Imported", out);
}

// ── DBML front-end ──────────────────────────────────────────────────────────
// Parse the DBML subset we can map (Table blocks incl. one-line tables, typed
// columns with [settings: pk, not null, unique, default, note, ref], Enum
// blocks, `indexes`, inline refs and top-level/block `Ref`s) into the
// table-spec, then run the import core. The source PK column is dropped (the
// identity trait provides {entity}_id), and FK targets are remapped to that PK.
// Everything it cannot carry lands in the loss report.

export const dbmlImportSchema = {
	moduleDir: z.string().describe("Path to the module dir. If empty, pass `module` to start a new module."),
	dbml: z.string().describe("DBML source text (https://dbml.dbdiagram.io)."),
	module: moduleIdentitySchema.describe("New-module identity — required only when moduleDir has no manifest yet."),
	onExisting: onExistingInput,
	adminRights: adminRightsInput.optional(),
};

/** Normalise a DBML identifier (possibly schema-qualified / CamelCase) to a dForge entity code. */
function snake(name: string): string {
	const base = name.includes(".") ? name.split(".").pop()! : name;
	return base
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/^([0-9])/, "_$1");
}

/** Remove // and block comments, quote-aware (a `'http://x'` default is not a comment). */
function stripDbmlComments(src: string): string {
	// '''multi-line notes''' → one line, so line-based parsing stays simple.
	src = src.replace(/'''([\s\S]*?)'''/g, (_m, t: string) => "'" + t.replace(/\s+/g, " ").trim().replace(/'/g, "\\'") + "'");
	let out = "";
	let i = 0;
	let q: string | null = null;
	while (i < src.length) {
		const c = src[i];
		if (q) {
			out += c;
			if (c === "\\" && i + 1 < src.length) {
				out += src[++i];
			} else if (c === q) q = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			q = c;
			out += c;
			i++;
		} else if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
		} else if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			out += " ";
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

interface Block {
	header: string;
	body: string;
}

/**
 * Split text into top-level `header { body }` blocks and the remaining text,
 * respecting quotes. A one-line `Table x { a int }` is one block like any other.
 */
function splitBlocks(text: string): { blocks: Block[]; rest: string } {
	const blocks: Block[] = [];
	let rest = "";
	let hs = 0; // start of the current header/statement
	let i = 0;
	let q: string | null = null;
	while (i < text.length) {
		const c = text[i];
		if (q) {
			if (c === "\\") i++;
			else if (c === q) q = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			q = c;
			i++;
		} else if (c === "\n") {
			rest += text.slice(hs, i + 1);
			hs = i + 1;
			i++;
		} else if (c === "{") {
			const header = text.slice(hs, i).trim();
			let depth = 1;
			let j = i + 1;
			let qq: string | null = null;
			while (j < text.length && depth > 0) {
				const d = text[j];
				if (qq) {
					if (d === "\\") j++;
					else if (d === qq) qq = null;
				} else if (d === "'" || d === '"' || d === "`") qq = d;
				else if (d === "{") depth++;
				else if (d === "}") depth--;
				j++;
			}
			blocks.push({ header, body: text.slice(i + 1, j - 1) });
			rest += "\n";
			hs = j;
			i = j;
		} else i++;
	}
	rest += text.slice(hs);
	return { blocks, rest };
}

/** Split on top-level commas (outside quotes, backticks and parentheses). */
function splitTopLevel(s: string, sep = ","): string[] {
	const out: string[] = [];
	let cur = "";
	let depth = 0;
	let q: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			cur += c;
			if (c === "\\" && i + 1 < s.length) cur += s[++i];
			else if (c === q) q = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			q = c;
			cur += c;
		} else if (c === "(") {
			depth++;
			cur += c;
		} else if (c === ")") {
			depth--;
			cur += c;
		} else if (c === sep && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	if (cur.trim()) out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

/** The `[...]` settings list at the start of `s` (quote-aware), and what follows it. */
function takeSettings(s: string): { items: string[]; after: string } {
	const t = s.trimStart();
	if (!t.startsWith("[")) return { items: [], after: t };
	let q: string | null = null;
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (q) {
			if (c === "\\") i++;
			else if (c === q) q = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") q = c;
		else if (c === "[") depth++;
		else if (c === "]" && --depth === 0) return { items: splitTopLevel(t.slice(1, i)), after: t.slice(i + 1) };
	}
	return { items: splitTopLevel(t.slice(1)), after: "" };
}

const unquote = (v: string): string => {
	const t = v.trim();
	const m = t.match(/^(['"`])([\s\S]*)\1$/);
	return m ? m[2].replace(/\\(.)/g, "$1") : t;
};

const stripName = (n: string): string => n.trim().replace(/^"(.*)"$/, "$1");
const lastSegment = (n: string): string => {
	const parts = n.match(/"[^"]+"|[^."\s]+/g) ?? [n];
	return stripName(parts[parts.length - 1]);
};

interface PendingRef {
	table: string; // table that wrote the ref (inline) or the left side (top-level)
	column: string;
	op: string;
	toTable: string;
	toColumn: string;
	where: string;
}

interface DbmlColumn extends Column {
	pk?: boolean;
}

interface DbmlTable {
	name: string;
	pkCols: string[];
	pkType?: string;
	columns: DbmlColumn[];
	refs: Array<{ column: string; toTable: string; toColumn: string }>;
	uniques: Array<{ name?: string; fields: string[] }>;
	indexes: Array<{ name?: string; fields: string[]; using?: "btree" | "hash" }>;
}

const REF_RE = /^\s*"?([\w.]+)"?\s*\.\s*"?(\w+)"?\s*(<>|[<>-])\s*"?([\w.]+)"?\s*\.\s*"?(\w+)"?/;

function parseColumnLine(
	line: string,
	t: DbmlTable,
	enums: Map<string, string[]>,
	losses: Loss[],
	pending: PendingRef[],
): void {
	const m = line.match(/^("[^"]+"|\w+)\s+("[^"]+"|[\w.]+(?:\s*\([^)]*\))?(?:\[\d*\])?)\s*(.*)$/s);
	if (!m) {
		losses.push({ where: t.name, what: `line not understood and skipped: "${line.slice(0, 60)}"` });
		return;
	}
	const colName = snake(stripName(m[1]));
	let sqlType = stripName(m[2]);
	const where = `${t.name}.${colName}`;
	const isArray = /\[\d*\]$/.test(sqlType);
	const { items, after } = takeSettings(m[3]);
	if (after.trim() && !/^[;,]?$/.test(after.trim())) losses.push({ where, what: `trailing text ignored: "${after.trim().slice(0, 40)}"` });

	const col: DbmlColumn = { name: colName, sqlType };
	let isPk = false;
	if (isArray) {
		losses.push({ where, what: `array type ${sqlType} — imported as text; model it as a child entity or json.` });
		col.sqlType = sqlType.replace(/\[\d*\]$/, "");
	}
	const enumKey = sqlType.includes(".") ? lastSegment(sqlType) : sqlType;
	const ev = enums.get(enumKey.toLowerCase()) ?? enums.get(snake(enumKey));
	if (ev) {
		col.enumValues = ev;
		col.sqlType = "varchar";
	}
	for (const item of items) {
		const low = item.toLowerCase().replace(/\s+/g, " ");
		const kv = item.match(/^([\w ]+?)\s*:\s*([\s\S]*)$/);
		const key = kv ? kv[1].toLowerCase().trim() : low;
		const val = kv ? kv[2].trim() : "";
		if (low === "pk" || low === "primary key") isPk = true;
		else if (low === "not null") col.required = true;
		else if (low === "null") col.required = false;
		else if (low === "unique") col.unique = true;
		else if (low === "increment") {
			/* identity PK covers it; a non-PK serial is covered by the type map */
		} else if (key === "default") col.default = val;
		else if (key === "note") {
			const note = unquote(val);
			const ck = note.match(/^\s*check\b\s*([\s\S]*)$/i);
			if (ck) col.check = ck[1];
			else col.note = note;
		} else if (key === "ref") {
			const rm = val.match(/^(<>|[<>-])\s*"?([\w.]+)"?\s*\.\s*"?(\w+)"?/);
			if (rm) pending.push({ table: t.name, column: colName, op: rm[1], toTable: snake(rm[2]), toColumn: snake(rm[3]), where });
			else losses.push({ where, what: `ref setting not understood: "${item}"` });
		} else losses.push({ where, what: `setting "${item}" not carried.` });
	}
	if (isPk) {
		t.pkCols.push(colName);
		t.pkType = col.sqlType;
		if (/(^|[^a-z])(varchar|char|text|string|nvarchar|bpchar|character)/i.test(col.sqlType ?? "") && !ev) {
			losses.push({ where, what: `natural primary key (${col.sqlType}) replaced by the identity PK ${t.name}_id — its values and uniqueness are not carried; keep it as a unique field if it matters.` });
		}
	}
	t.columns.push({ ...col, pk: isPk });
}

function parseIndexLine(line: string, t: DbmlTable, losses: Loss[]): void {
	const m = line.match(/^(\([^)]*\)|`[^`]*`|"?\w+"?)\s*(\[[\s\S]*\])?\s*$/);
	if (!m) {
		losses.push({ where: t.name, what: `index line not understood: "${line.slice(0, 60)}"` });
		return;
	}
	if (m[1].startsWith("`")) {
		losses.push({ where: t.name, what: `expression index ${m[1]} not carried.` });
		return;
	}
	const fields = (m[1].startsWith("(") ? m[1].slice(1, -1).split(",") : [m[1]]).map((f) => snake(stripName(f)));
	const { items } = takeSettings(m[2] ?? "");
	let unique = false;
	let pk = false;
	let name: string | undefined;
	let using: "btree" | "hash" | undefined;
	for (const item of items) {
		const low = item.toLowerCase().trim();
		const kv = item.match(/^(\w+)\s*:\s*([\s\S]*)$/);
		if (low === "unique") unique = true;
		else if (low === "pk") pk = true;
		else if (kv && kv[1].toLowerCase() === "name") name = snake(unquote(kv[2]));
		else if (kv && kv[1].toLowerCase() === "type") {
			const ty = unquote(kv[2]).toLowerCase();
			if (ty === "btree" || ty === "hash") using = ty;
			else losses.push({ where: t.name, what: `index type '${ty}' not carried (btree/hash only).` });
		} else if (kv && kv[1].toLowerCase() === "note") {
			/* cosmetic */
		} else losses.push({ where: t.name, what: `index setting "${item}" not carried.` });
	}
	if (pk) {
		losses.push({ where: t.name, what: `composite primary key (${fields.join(", ")}) replaced by the identity PK ${t.name}_id; kept as a unique constraint.` });
		t.uniques.push({ ...(name ? { name } : {}), fields });
	} else if (unique) t.uniques.push({ ...(name ? { name } : {}), fields });
	else t.indexes.push({ ...(name ? { name } : {}), fields, ...(using ? { using } : {}) });
}

function parseDbmlTableBody(rawName: string, body: string, enums: Map<string, string[]>, losses: Loss[], pending: PendingRef[]): DbmlTable {
	const t: DbmlTable = { name: snake(rawName), pkCols: [], columns: [], refs: [], uniques: [], indexes: [] };
	const { blocks, rest } = splitBlocks(body);
	for (const b of blocks) {
		if (/^indexes$/i.test(b.header)) {
			for (const l of b.body.split("\n")) if (l.trim()) parseIndexLine(l.trim(), t, losses);
		} else if (/^note$/i.test(b.header)) {
			losses.push({ where: t.name, what: "table note not carried (an entity's description is its UI label)." });
		} else {
			losses.push({ where: t.name, what: `block "${b.header.slice(0, 30)}" not carried.` });
		}
	}
	for (const raw of rest.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (/^note\s*:/i.test(line)) {
			losses.push({ where: t.name, what: "table note not carried (an entity's description is its UI label)." });
			continue;
		}
		if (/^headercolor\s*:/i.test(line)) continue; // cosmetic
		parseColumnLine(line, t, enums, losses, pending);
	}
	return t;
}

export interface DbmlParse {
	tables: Table[];
	losses: Loss[];
}

/** Parse DBML into the table-spec and a loss report of everything it could not carry. */
export function parseDbmlDetailed(dbml: string): DbmlParse {
	const src = stripDbmlComments(dbml);
	const losses: Loss[] = [];
	const pending: PendingRef[] = [];
	const { blocks, rest } = splitBlocks(src);

	// Enums first, so column types naming one become dropdowns.
	const enums = new Map<string, string[]>();
	for (const b of blocks) {
		const h = b.header.match(/^Enum\s+(.+)$/i);
		if (!h) continue;
		const values: string[] = [];
		for (const raw of b.body.split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			const vm = line.match(/^("[^"]+"|[^\s\[]+)\s*(\[[\s\S]*\])?\s*$/);
			if (!vm) {
				losses.push({ where: `enum ${lastSegment(h[1])}`, what: `value line not understood: "${line.slice(0, 40)}"` });
				continue;
			}
			values.push(stripName(vm[1]));
			if (vm[2] && /note\s*:/i.test(vm[2])) losses.push({ where: `enum ${lastSegment(h[1])}.${stripName(vm[1])}`, what: "value note not carried." });
		}
		const nm = lastSegment(h[1]);
		enums.set(nm.toLowerCase(), values);
		enums.set(snake(nm), values);
	}

	const tables: DbmlTable[] = [];
	for (const b of blocks) {
		const th = b.header.match(/^Table\s+((?:"[^"]+"|[\w]+)(?:\s*\.\s*(?:"[^"]+"|[\w]+))*)\s*(?:as\s+\w+\s*)?(?:\[[^\]]*\])?\s*$/i);
		if (th) {
			tables.push(parseDbmlTableBody(lastSegment(th[1].replace(/\s+/g, "")), b.body, enums, losses, pending));
		} else if (/^Ref\b/i.test(b.header)) {
			for (const l of b.body.split("\n")) if (l.trim()) handleRefLine(l.trim(), pending, losses);
		} else if (/^Enum\b/i.test(b.header)) {
			/* handled above */
		} else if (b.header) {
			losses.push({ where: b.header.split(/\s+/).slice(0, 2).join(" "), what: "block not carried (only Table, Enum and Ref are imported)." });
		}
	}
	for (const raw of rest.split("\n")) {
		const line = raw.trim();
		if (/^Ref\b/i.test(line)) handleRefLine(line.replace(/^Ref\s*\w*\s*:?\s*/i, ""), pending, losses, line);
	}

	const byName = new Map(tables.map((t) => [t.name, t]));
	// Resolve refs, inline and top-level: `>` many-to-one (left is FK), `<` one-to-many
	// (right is FK), `-` one-to-one (left treated as FK).
	for (const r of pending) {
		const aTable = r.table, aCol = r.column, bTable = r.toTable, bCol = r.toColumn;
		const fkOnLeft = r.op === ">" || r.op === "-";
		const fk = fkOnLeft ? { table: aTable, col: aCol, toTable: bTable, toCol: bCol } : { table: bTable, col: bCol, toTable: aTable, toCol: aCol };
		const owner = byName.get(fk.table);
		if (!owner) {
			losses.push({ where: r.where, what: `reference ${fk.table}.${fk.col} -> ${fk.toTable}.${fk.toCol} not carried — table '${fk.table}' is not in this DBML.` });
			continue;
		}
		if (!owner.refs.some((x) => x.column === fk.col)) owner.refs.push({ column: fk.col, toTable: fk.toTable, toColumn: fk.toCol });
	}

	const out: Table[] = tables.map((t) => {
		const composite = t.pkCols.length > 1;
		if (composite) {
			losses.push({ where: t.name, what: `composite primary key (${t.pkCols.join(", ")}) replaced by the identity PK ${t.name}_id; kept as a unique constraint.` });
			t.uniques.push({ fields: [...t.pkCols] });
		}
		const refColNames = new Set(t.refs.map((r) => r.column));
		const references = t.refs.map((r) => {
			const targetPk = byName.get(r.toTable)?.pkCols[0];
			// A ref at the source PK ('id' or the declared PK) targets the identity PK, whatever it is named.
			const toColumn = r.toColumn === "id" || (targetPk && r.toColumn === targetPk) ? undefined : r.toColumn;
			if (toColumn && byName.has(r.toTable)) {
				losses.push({ where: `${t.name}.${r.column}`, what: `references non-PK column ${r.toTable}.${toColumn}; kept as the link target — check it is the entity's key.` });
			}
			// The FK column is dropped from `columns` just below, so carry its
			// `[not null]` onto the reference — otherwise every DBML relation would
			// import as optional, and 'M' is what makes the FK column NOT NULL.
			const fkCol = t.columns.find((c) => c.name === r.column);
			if (fkCol?.default !== undefined) losses.push({ where: `${t.name}.${r.column}`, what: `default ${fkCol.default} on a foreign key not carried.` });
			if (fkCol?.unique) {
				t.uniques.push({ fields: [r.column] });
			}
			return {
				column: r.column,
				toTable: r.toTable,
				...(toColumn ? { toColumn } : {}),
				...(fkCol?.required ? { required: true } : {}),
			};
		});
		const columns = t.columns
			.filter((c) => !refColNames.has(c.name))
			.filter((c) => composite || !c.pk)
			.map(({ pk: _pk, ...c }) => c);
		const spec: Table = { name: t.name, columns: columns.length ? columns : [{ name: "name", sqlType: "varchar" }] };
		if (references.length) spec.references = references;
		if (t.uniques.length) spec.uniques = t.uniques;
		if (t.indexes.length) spec.indexes = t.indexes;
		return spec;
	});
	return { tables: out, losses };
}

function handleRefLine(text: string, pending: PendingRef[], losses: Loss[], original = text): void {
	const m = text.match(REF_RE);
	if (!m) {
		losses.push({ where: "Ref", what: `relationship not understood and skipped: "${original.slice(0, 70)}"` });
		return;
	}
	const [, aT, aC, op, bT, bC] = m;
	const trailing = text.slice(m[0].length);
	if (op === "<>") {
		losses.push({ where: `${snake(aT)}.${snake(aC)}`, what: `many-to-many ref to ${snake(bT)}.${snake(bC)} not carried — model it with a link entity.` });
		return;
	}
	const { items } = takeSettings(trailing);
	for (const it of items) losses.push({ where: `${snake(aT)}.${snake(aC)} > ${snake(bT)}.${snake(bC)}`, what: `ref setting "${it}" not carried (referential actions are not modelled).` });
	pending.push({ table: snake(aT), column: snake(aC), op, toTable: snake(bT), toColumn: snake(bC), where: `${snake(aT)}.${snake(aC)}` });
}

export function parseDbml(dbml: string): Table[] {
	return parseDbmlDetailed(dbml).tables;
}

export function dbmlImport(
	args: z.infer<z.ZodObject<typeof dbmlImportSchema>>,
): ToolResult {
	const { tables, losses } = parseDbmlDetailed(args.dbml);
	if (!tables.length) throw new Error("No `Table` blocks found in the DBML source.");
	const manifest = ensureManifest(args.moduleDir, args.module);
	const out = buildImportFiles(args.moduleDir, manifest, tables, args.onExisting ?? "error", losses, args.adminRights);
	return importResult(`Parsed ${tables.length} table(s) from DBML and imported`, out);
}
