// Three sister tools for patching fields inside an existing entity:
//   dforge_entity_field_add     — append a new field to entity.fields
//   dforge_entity_field_modify  — replace an existing field's spec
//   dforge_entity_field_remove  — delete a field
//
// All three load the entity JSON, mutate, and return the single-file map.
// They DON'T touch related artifacts (views, roles, menus) — those are
// regenerated separately when the AI follows a backtrack flow.

import { z } from "zod";
import * as path from "node:path";
import { deriveDbDatatype } from "@dforge-core/metadata";
import { loadManifest, readJson, jsonText, rel, makeResult, withTodayStamp, type ToolResult } from "./_helpers";
import { scanFieldReferences, renderReferences, type FieldReferences } from "./refactor";
import { checkFieldSpec } from "./field-rules";

/** Column kinds that own no physical column — they never get a derived dbDatatype. */
const VIRTUAL_COLUMN_TYPES = new Set(["F", "R", "S", "Q"]);

/**
 * Auto-fill `dbDatatype` from `fieldTypeCd` when the author omitted it, using
 * the canonical derivation in @dforge-core/metadata. Never overrides an
 * author-provided value, and skips relationship/formula columns
 * (`deriveDbDatatype` returns null for lookup/grid — they own no column).
 * Formula/reference/set/query columns (columnType F/R/S/Q) own no physical
 * column either, so nothing is derived for them — the module validator rejects
 * a 'dbDatatype' on an 'F' column. `notes` says so in the tool result.
 */
function finalizeField(field: Record<string, unknown>): { field: Record<string, unknown>; notes: string[] } {
	const ftc = field.fieldTypeCd;
	if (typeof ftc !== "string" || field.dbDatatype !== undefined) return { field, notes: [] };
	if (typeof field.columnType === "string" && VIRTUAL_COLUMN_TYPES.has(field.columnType)) {
		return {
			field,
			notes: [
				`dbDatatype was NOT derived from fieldTypeCd '${ftc}': a '${field.columnType}' column owns no physical column` +
					(field.columnType === "F" ? " (use baseDatatypeCd for the value type)." : "."),
			],
		};
	}
	const derived = deriveDbDatatype(ftc, {
		maxLen: typeof field.maxLen === "number" ? field.maxLen : undefined,
		precision: typeof field.precision === "number" ? field.precision : undefined,
	});
	if (derived == null) return { field, notes: [] };
	return { field: { ...field, dbDatatype: derived }, notes: [] };
}

/** Next free orderNum for an entity's own fields (trait columns are not counted): max existing + 10. */
export function nextFieldOrderNum(fields: Record<string, unknown>): number {
	let max = 0;
	for (const f of Object.values(fields)) {
		const n = (f as { orderNum?: unknown } | null)?.orderNum;
		if (typeof n === "number" && n > max) max = n;
	}
	return max + 10;
}

const sentenceCaseFromCode = (code: string): string =>
	code
		.split("_")
		.filter(Boolean)
		.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");

const fieldSchema = z
	.object({
		dbDatatype: z.string().optional(),
		fieldTypeCd: z.string().optional(),
		baseDatatypeCd: z.string().optional(),
		columnType: z.string().optional(),
		flags: z.string().optional(),
		isNullable: z.boolean().optional(),
		maxLen: z.number().int().optional(),
		orderNum: z.number().int().optional(),
		description: z.string().optional(),
		formula: z.string().optional(),
		link: z.record(z.string(), z.unknown()).optional(),
		params: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough()
	.superRefine((val, ctx) => {
		// Rules live in ./field-rules so dforge_module_validate can re-run the
		// exact same set over every field of every entity — catching fields that
		// entered via import / scaffold / a hand edit and never saw this schema.
		// Only `error`-level issues reject the call here; warnings are advisory
		// and surface in the validator.
		for (const issue of checkFieldSpec("field", val)) {
			if (issue.level !== "error") continue;
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: issue.message.replace(/^field: /, ""),
			});
		}
	})
	.describe(
		"Field spec. RULES (load dforge://reference/flags, /field-types, /column-types first):\n" +
			"• flags = a subset of V/E/M only. NEVER combine I or H with them. VEM = required+visible; VE = optional+visible; V = read-only/formula; EM/E = hidden FK (required/optional). 'VEMHI' is INVALID.\n" +
			"• 'M' means required: it is resolved into isNullable:false at install, so it makes the column NOT NULL. Declaring 'M' AND \"isNullable\": true fails the pack. 'M' is inert on virtual (R/S/F) and identity columns — don't put it there.\n" +
			"• dbDatatype is AUTO-DERIVED from fieldTypeCd when omitted (e.g. currency → numeric(18,2), text → varchar) — only set it to override. Values: bool, varchar, text, int, bigint, numeric, timestamptz, date, time, cuid, json. NOT boolean/string/datetime/integer/timestamp/number — 'number' is a fieldTypeCd, not a dbDatatype.\n" +
			"• A relation is TWO fields: hidden FK (dbDatatype:'cuid', flags:'EM' if required else 'E', NO fieldTypeCd) + a Reference (columnType:'R', fieldTypeCd:'lookup', flags:'VEM'/'VE' to match, link:{entity,thisKey,otherKey}). Keep the two halves in step. otherKey = the target entity's PK ('{entity}_id'), never 'id'. Prefer dforge_entity_reference_add, which emits both.\n" +
			"• Formula column: columnType:'F', baseDatatypeCd set, NO dbDatatype (never derived for F), flags:'V'.\n" +
			"• baseDatatypeCd is a CLOSED enum: binary, bool, cuid, culture, date, guid, link, number, project, string, time, timestamp, xml, json — NOT a fieldTypeCd ('text'→string, 'datetime'→timestamp, 'checkbox'→bool, 'currency'→number).\n" +
			"• Column DEFAULTS use 'formula' (e.g. \"'draft'\" or \"TODAY()\"), NOT 'defaultValue' (settings-only).\n" +
			"• dropdown options go under params.options = [{value,label}] objects, never at the field root and never bare strings.",
	);

// ── add ─────────────────────────────────────────────────────────────

export const entityFieldAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entityName: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Entity code to add the field to."),
	fieldName: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("New field's code."),
	field: fieldSchema,
};

export function entityFieldAdd(args: z.infer<z.ZodObject<typeof entityFieldAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityPath = path.join(paths.entitiesDir, `${args.entityName}.json`);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, unknown> | undefined) ?? {};
	if (Object.prototype.hasOwnProperty.call(fields, args.fieldName)) {
		throw new Error(
			`Field '${args.fieldName}' already exists on entity '${args.entityName}'. Use entity_field_modify to change it.`,
		);
	}
	// entity.schema.json requires `orderNum` and `description` on every field.
	const incoming = { ...(args.field as Record<string, unknown>) };
	const filled: string[] = [];
	if (typeof incoming.orderNum !== "number") {
		incoming.orderNum = nextFieldOrderNum(fields);
		filled.push(`orderNum ${incoming.orderNum}`);
	}
	if (typeof incoming.description !== "string" || incoming.description === "") {
		incoming.description = sentenceCaseFromCode(args.fieldName);
		filled.push(`description '${incoming.description}'`);
	}
	const fin = finalizeField(incoming);
	if (filled.length)
		fin.notes.push(`Filled in the required ${filled.join(" and ")} (entity schema); change them if needed.`);
	entity.fields = { ...fields, [args.fieldName]: fin.field };
	const files: Record<string, string> = {
		[rel(paths.root, entityPath)]: jsonText(entity),
		"manifest.json": jsonText(withTodayStamp(manifest)),
	};
	return makeResult(
		`Added field '${args.fieldName}' to entity '${args.entityName}'.`,
		files,
		fin.notes.length ? fin.notes.join(" ") : undefined,
	);
}

// ── modify ──────────────────────────────────────────────────────────

export const entityFieldModifySchema = {
	moduleDir: z.string(),
	entityName: z.string().regex(/^[a-z][a-z0-9_]*$/),
	fieldName: z.string().regex(/^[a-z][a-z0-9_]*$/),
	field: fieldSchema.describe(
		"Replacement spec: replaces the existing field — pass the full desired shape (keys you omit are dropped and listed in the warnings). " +
			"EXCEPTION: `params` is MERGED into the existing params (shallow); set a params key to null to remove it. " +
			"A type change (fieldTypeCd/dbDatatype/columnType) needs a dbSchemaVersion bump and maybe migrations/<version>.sql — the result says so.",
	),
};

/** Shallow-merge `params`: keys not mentioned survive, an explicit null removes a key. */
function mergeParams(
	oldParams: unknown,
	newParams: unknown,
): { params: Record<string, unknown> | undefined; kept: string[] } {
	const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
	if (!isObj(newParams))
		return { params: isObj(oldParams) ? oldParams : undefined, kept: isObj(oldParams) ? Object.keys(oldParams) : [] };
	if (!isObj(oldParams)) {
		const clean = Object.fromEntries(Object.entries(newParams).filter(([, v]) => v !== null));
		return { params: clean, kept: [] };
	}
	const out: Record<string, unknown> = { ...oldParams };
	for (const [k, v] of Object.entries(newParams)) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return { params: out, kept: Object.keys(oldParams).filter((k) => !(k in newParams)) };
}

export function entityFieldModify(args: z.infer<z.ZodObject<typeof entityFieldModifySchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityPath = path.join(paths.entitiesDir, `${args.entityName}.json`);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const fields = (entity.fields as Record<string, Record<string, unknown>> | undefined) ?? {};
	if (!Object.prototype.hasOwnProperty.call(fields, args.fieldName)) {
		throw new Error(`Field '${args.fieldName}' not found on entity '${args.entityName}'.`);
	}
	const old = fields[args.fieldName];
	const incoming = { ...(args.field as Record<string, unknown>) };
	const warnings: string[] = [];

	// params: merge instead of wholesale replace.
	if (incoming.params !== undefined || old.params !== undefined) {
		const { params, kept } = mergeParams(old.params, incoming.params);
		if (params === undefined || Object.keys(params).length === 0) delete incoming.params;
		else incoming.params = params;
		if (incoming.params !== undefined && kept.length > 0 && args.field.params !== undefined) {
			warnings.push(`params merged: kept existing key(s) ${kept.join(", ")} (set to null to remove).`);
		} else if (args.field.params === undefined && kept.length > 0) {
			warnings.push(`params not mentioned — kept existing key(s) ${kept.join(", ")}.`);
		}
	}

	// orderNum / description are schema-required: keep the old ones when the replacement omits them.
	for (const k of ["orderNum", "description"] as const) {
		if (incoming[k] === undefined && old[k] !== undefined) incoming[k] = old[k];
	}
	const fin = finalizeField(incoming);
	warnings.push(...fin.notes);
	const next = fin.field;

	const dropped = Object.keys(old).filter((k) => !(k in next));
	if (dropped.length > 0) {
		warnings.push(
			`keys of the old spec dropped because the new spec omits them: ${dropped.join(", ")} (re-add them if unintended).`,
		);
	}

	// Data-affecting change.
	const changed = (k: string) => JSON.stringify(old[k]) !== JSON.stringify(next[k]);
	const typeChanged = ["fieldTypeCd", "dbDatatype", "baseDatatypeCd", "columnType", "maxLen", "precision"].filter(
		(k) => (old[k] !== undefined || next[k] !== undefined) && changed(k),
	);
	if (typeChanged.some((k) => k === "dbDatatype" || k === "columnType" || k === "maxLen" || k === "precision")) {
		warnings.push(
			`TYPE CHANGE on '${args.fieldName}' (${typeChanged.map((k) => `${k}: ${JSON.stringify(old[k])} -> ${JSON.stringify(next[k])}`).join(", ")}): ` +
				"the physical column changes — bump manifest dbSchemaVersion, and add migrations/<version>.sql if existing rows need converting (existing data is NOT converted automatically).",
		);
	} else if (typeChanged.length > 0) {
		warnings.push(
			`fieldTypeCd/baseDatatypeCd changed (${typeChanged.map((k) => `${k}: ${JSON.stringify(old[k])} -> ${JSON.stringify(next[k])}`).join(", ")}): ` +
				"check the paired columns and the dependants listed under references.",
		);
	}

	entity.fields = { ...fields, [args.fieldName]: next };

	// Dependants that mention the field and may break under the change.
	let references: FieldReferences = {};
	const touchesShape =
		changed("fieldTypeCd") ||
		changed("dbDatatype") ||
		changed("baseDatatypeCd") ||
		changed("columnType") ||
		changed("params") ||
		changed("formula");
	if (touchesShape) {
		references = scanFieldReferences(paths, manifest, readJson<Record<string, unknown>>(entityPath), args.entityName, [
			args.fieldName,
		]);
		for (const k of Object.keys(references)) if (!references[k]?.length) delete references[k];
		if (Object.keys(references).length > 0) {
			warnings.push(`dependants that mention '${args.fieldName}' — re-check them: ${renderReferences(references)}.`);
		}
	}

	const result = makeResult(
		`Modified field '${args.fieldName}' on entity '${args.entityName}'.`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length ? warnings.join(" ") : undefined,
	) as ToolResult & { references?: FieldReferences };
	if (Object.keys(references).length > 0) result.references = references;
	return result;
}

// `entity_field_remove` lives in ./refactor.ts — it's a refactor-safe cascade
// (cleans up paired Reference, views, seed data; warns on formula/cross-entity
// dependents), alongside entity_field_rename.
