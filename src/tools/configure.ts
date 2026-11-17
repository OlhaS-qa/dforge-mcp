// dforge_entity_configure + dforge_manifest_set — the two "settings" surfaces
// that had no tool, so builders edited entities/<code>.json and manifest.json
// by hand even though the skills forbid it.
//
//   entity_configure  entity-level keys: toString, numberSequence, constraints,
//                     description (everything else on an entity has its own tool)
//   manifest_set      manifest metadata the vendored manifest.schema.json allows
//
// Both validate against the vendored schemas in resources/schemas and refuse
// unknown keys rather than inventing them.

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadManifest,
	readJson,
	readJsonOrDefault,
	readLocalTraits,
	expandedEntity,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
	entityFilePath,
} from "./_helpers";

// ── entity_configure ────────────────────────────────────────────────

const CODE = /^[a-z][a-z0-9_]*$/;

const numberSequenceSchema = z
	.object({
		column: z
			.string()
			.describe("Column code that receives the generated number (must be an existing physical text column)."),
		defaultPrefix: z
			.string()
			.describe(
				"REQUIRED by entity.schema.json (the reference doc omits it): fallback prefix when no setting is " +
					"configured. Use '' only if the pattern has no {prefix}.",
			),
		prefixSettingCd: z.string().optional().describe("Module setting code the prefix is resolved from (folder-scoped)."),
		pattern: z
			.string()
			.optional()
			.describe("Placeholders: {prefix}, {yyyy}, {yy}, {mm}, {dd}, {seq:N}. Schema default '{prefix}{yyyy}-{seq:3}'."),
		resetPeriod: z.enum(["year", "month", "day", "never"]).optional().describe("Counter reset period (default year)."),
	})
	.strict();

const constraintSchema = z
	.object({
		type: z.enum(["unique", "check"]),
		fields: z
			.array(z.string())
			.optional()
			.describe("unique: the key columns (required). check: optional columns to highlight on violation."),
		expression: z.string().optional().describe("check only (required): SQL boolean expression the row must satisfy."),
		message: z.string().optional().describe("Violation message shown to the user (localizable)."),
	})
	.strict();

export const entityConfigureSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	entity: z.string().regex(CODE).describe("Entity code (key in manifest.entities)."),
	toStringTemplate: z
		.string()
		.optional()
		.describe(
			"Sets the entity's `toString` (named toStringTemplate because a `toString` input key collides with " +
				"Object.prototype.toString in validators). Record caption template, e.g. '{number} {name}'. Every " +
				"{placeholder} must be an existing column of the entity (trait columns included) and not a set. Not " +
				"allowed on extension entities.",
		),
	description: z.string().optional().describe("Entity description."),
	numberSequence: z
		.union([numberSequenceSchema, z.null()])
		.optional()
		.describe(
			"Automatic document numbering ({column, defaultPrefix, prefixSettingCd?, pattern?, resetPeriod?}). " +
				"Pass null to remove it. See dforge://reference/number-sequences.",
		),
	constraints: z
		.object({
			add: z
				.record(z.string(), constraintSchema)
				.optional()
				.describe(
					"Constraints to add, keyed by constraint name ('uq_number'). Existing names are refused — remove first.",
				),
			remove: z
				.array(z.string())
				.optional()
				.describe("Constraint names to remove (applied before `add`, so remove+add replaces)."),
		})
		.optional()
		.describe(
			"Unique/check database constraints. Unique constraints name existing physical columns; every one " +
				"should carry a `message`.",
		),
};

const SQL_WORDS = new Set(
	"and or not in is null between true false like ilike similar to case when then else end distinct escape any all some exists cast as current_date current_time current_timestamp now abs length lower upper coalesce nullif greatest least round floor ceil ceiling trim char_length date timestamp timestamptz numeric integer int bigint text varchar boolean interval year month day hour minute second extract age".split(
		" ",
	),
);

/**
 * A check constraint is raw PostgreSQL over real column names. Refuses the
 * formula bracket syntax ([col]) and any identifier that is not a column.
 * Exported so other constraint writers can reuse it.
 */
export function checkCheckExpression(name: string, expression: string, columns: ReadonlySet<string>): void {
	if (/\[[^\]]*\]/.test(expression)) {
		const raw = expression.replace(/\[([^\]]*)\]/g, "$1");
		throw new Error(
			`Check constraint '${name}': expression "${expression}" uses formula bracket syntax. A check constraint is raw PostgreSQL over real column names — write "${raw}".`,
		);
	}
	const bare = expression.replace(/'(?:[^']|'')*'/g, " ");
	for (const m of bare.matchAll(/(::\s*)?\b([A-Za-z_][A-Za-z0-9_]*)\b(\s*\()?/g)) {
		if (m[1] || m[3]) continue; // cast target / function call
		const id = m[2];
		if (SQL_WORDS.has(id.toLowerCase()) || columns.has(id)) continue;
		throw new Error(
			`Check constraint '${name}': '${id}' in expression "${expression}" is not a column of the entity table (virtual F/R/S columns are not stored, so they cannot be used). Use real column names (raw PostgreSQL). Columns: ${[...columns].sort().join(", ")}.`,
		);
	}
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

export function entityConfigure(args: z.infer<z.ZodObject<typeof entityConfigureSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const relPath = (manifest.entities ?? {})[args.entity];
	if (!relPath) {
		throw new Error(
			`Entity '${args.entity}' is not in manifest.entities. Existing: ${Object.keys(manifest.entities ?? {}).join(", ") || "(none)"}.`,
		);
	}
	const entityPath = entityFilePath(paths.root, relPath);
	const entity = readJson<Record<string, unknown>>(entityPath);
	const isExtension = typeof entity.extends === "string" && entity.extends.length > 0;
	const warnings: string[] = [];
	const changed: string[] = [];

	const { traits: localTraits, error: traitsError } = readLocalTraits(paths.root);
	if (traitsError) throw new Error(`traits.json — ${traitsError} Fix the file and call again.`);
	const { columns, fieldDefs } = expandedEntity(entity, args.entity, localTraits);
	const physical = (c: string): boolean => {
		const t = fieldDefs[c]?.columnType;
		return t !== "R" && t !== "S" && t !== "F";
	};

	if (args.toStringTemplate !== undefined) {
		if (isExtension) {
			throw new Error(`'${args.entity}' is an extension entity (extends) — toString is not declared on extensions.`);
		}
		const ts = args.toStringTemplate;
		const braces = [...ts.matchAll(PLACEHOLDER)].map((m) => m[1]);
		if (braces.length === 0) {
			throw new Error(`toString "${ts}" has no {column} placeholder — every record would render the same label.`);
		}
		for (const b of braces) {
			if (!columns.has(b)) {
				throw new Error(
					`toString references {${b}}, which is not a column of '${args.entity}'. ` +
						`Columns (incl. traits): ${[...columns].sort().join(", ")}.`,
				);
			}
			if (fieldDefs[b]?.columnType === "S") {
				throw new Error(`toString references {${b}}, a set (1:N) column — sets cannot be used in a caption.`);
			}
		}
		Object.defineProperty(entity, "toString", { value: ts, enumerable: true, writable: true, configurable: true });
		changed.push("toString");
	}

	if (args.description !== undefined) {
		entity.description = args.description;
		changed.push("description");
	}

	if (args.numberSequence !== undefined) {
		if (args.numberSequence === null) {
			delete entity.numberSequence;
		} else {
			const ns = args.numberSequence;
			if (!columns.has(ns.column)) {
				throw new Error(
					`numberSequence.column '${ns.column}' is not a column of '${args.entity}'. Columns: ${[...columns].sort().join(", ")}.`,
				);
			}
			if (!physical(ns.column)) {
				throw new Error(
					`numberSequence.column '${ns.column}' is a virtual (F/R/S) column — it must be a physical text column.`,
				);
			}
			if (ns.pattern !== undefined) {
				for (const m of ns.pattern.matchAll(PLACEHOLDER)) {
					if (!/^(prefix|yyyy|yy|mm|dd|seq:\d+)$/.test(m[1])) {
						throw new Error(
							`numberSequence.pattern has unknown placeholder {${m[1]}}. Allowed: {prefix}, {yyyy}, {yy}, {mm}, {dd}, {seq:N}.`,
						);
					}
				}
				if (!/\{seq:\d+\}/.test(ns.pattern)) {
					warnings.push(
						"numberSequence.pattern has no {seq:N} — generated numbers would repeat within a reset period.",
					);
				}
			}
			if (ns.prefixSettingCd) {
				const settings = readJsonOrDefault<Record<string, unknown>>(paths.settings, {});
				if (!Object.prototype.hasOwnProperty.call(settings, ns.prefixSettingCd)) {
					warnings.push(
						`prefixSettingCd '${ns.prefixSettingCd}' is not in settings.json yet — add it with dforge_setting_add.`,
					);
				}
			}
			const col = fieldDefs[ns.column];
			if (typeof col?.flags === "string" && col.flags.includes("M")) {
				warnings.push(
					`column '${ns.column}' is mandatory (M): the number is generated on INSERT only when the column is empty, so a required column may be rejected before generation — prefer a non-M column.`,
				);
			}
			entity.numberSequence = { ...ns };
		}
		changed.push("numberSequence");
	}

	if (args.constraints) {
		const cons = { ...((entity.constraints as Record<string, unknown> | undefined) ?? {}) };
		for (const name of args.constraints.remove ?? []) {
			if (!Object.prototype.hasOwnProperty.call(cons, name)) {
				throw new Error(
					`Constraint '${name}' does not exist on '${args.entity}'. Existing: ${Object.keys(cons).join(", ") || "(none)"}.`,
				);
			}
			delete cons[name];
		}
		for (const [name, c] of Object.entries(args.constraints.add ?? {})) {
			if (!CODE.test(name)) throw new Error(`Constraint name '${name}' must match ${CODE}.`);
			if (Object.prototype.hasOwnProperty.call(cons, name)) {
				throw new Error(
					`Constraint '${name}' already exists on '${args.entity}' — list it under constraints.remove in the same call to replace it.`,
				);
			}
			if (c.type === "unique") {
				if (!c.fields || c.fields.length === 0)
					throw new Error(`Unique constraint '${name}' needs a non-empty \`fields\`.`);
				if (c.expression !== undefined) throw new Error(`Unique constraint '${name}' must not have an \`expression\`.`);
				for (const f of c.fields) {
					if (!columns.has(f)) {
						throw new Error(
							`Constraint '${name}': column '${f}' is not a column of '${args.entity}'. Columns: ${[...columns].sort().join(", ")}.`,
						);
					}
					if (!physical(f)) {
						throw new Error(
							`Constraint '${name}': '${f}' is a virtual (F/R/S) column — use the hidden FK / a physical column.`,
						);
					}
				}
			} else {
				if (!c.expression || !c.expression.trim())
					throw new Error(`Check constraint '${name}' needs an \`expression\`.`);
				checkCheckExpression(name, c.expression, new Set([...columns].filter(physical)));
				for (const f of c.fields ?? []) {
					if (!columns.has(f)) {
						throw new Error(`Constraint '${name}': column '${f}' is not a column of '${args.entity}'.`);
					}
				}
			}
			if (!c.message) warnings.push(`constraint '${name}' has no \`message\` — users would see the generated default.`);
			cons[name] = { ...c };
		}
		if (Object.keys(cons).length === 0) delete entity.constraints;
		else entity.constraints = cons;
		changed.push("constraints");
	}

	if (changed.length === 0) {
		throw new Error(
			"Nothing to change: pass at least one of toStringTemplate, description, numberSequence, constraints.",
		);
	}

	return makeResult(
		`Configured entity '${args.entity}' (${changed.join(", ")}).`,
		{
			[rel(paths.root, entityPath)]: jsonText(entity),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length > 0 ? `Warnings:\n${warnings.map((w) => `  • ${w}`).join("\n")}` : undefined,
	);
}

// ── manifest_set ────────────────────────────────────────────────────

const SEMVER = /^\d+\.\d+\.\d+/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const FEATURES = ["report-security"] as const;

/** Manifest keys this tool may set — the settable subset of manifest.schema.json (+ documented shortDescription/security). */
const SETTABLE = [
	"displayName",
	"description",
	"shortDescription",
	"version",
	"dbSchemaVersion",
	"category",
	"tags",
	"icon",
	"license",
	"author",
	"auditHistory",
	"comments",
	"supportedLocales",
	"features",
	"security",
] as const;

export const manifestSetSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	displayName: z.string().min(1).optional(),
	description: z.string().optional().describe("Module description (marketplace page text)."),
	shortDescription: z
		.string()
		.max(1000)
		.optional()
		.describe(
			"Marketplace card text, at most 1000 characters (documented in references/manifest.md; absent from " +
				"the vendored manifest.schema.json).",
		),
	version: z.string().regex(SEMVER).optional().describe("Module semver."),
	dbSchemaVersion: z.string().regex(SEMVER).optional().describe("DB schema semver."),
	category: z.string().optional().describe("Marketplace category slug, e.g. 'sales'."),
	tags: z.array(z.string()).optional().describe("Search tags (lowercase, hyphen-separated). [] removes the key."),
	icon: z.string().optional().describe("Bootstrap icon class, e.g. 'bi-briefcase'."),
	license: z.string().optional(),
	author: z.object({ name: z.string(), url: z.string().optional() }).strict().optional().describe("{name, url?}."),
	auditHistory: z.enum(["basic", "fields", "full"]).optional(),
	comments: z.boolean().optional(),
	supportedLocales: z
		.array(z.string().regex(LOCALE))
		.optional()
		.describe(
			"Non-English locales the package translates, e.g. ['ru-RU','de-DE']. NEVER 'en' or 'en-*' (English " +
				"is the default). Each needs translations/<locale>.json — run dforge_translation_sync after. [] " +
				"removes the key.",
		),
	features: z
		.array(z.enum(FEATURES))
		.optional()
		.describe(
			"Opt-in platform behaviours; currently only 'report-security' (grant report:<code> 'E' to roles " +
				"FIRST, then declare it in a later version). [] removes the key.",
		),
	security: z
		.object({ roles: z.string().optional(), folders: z.string().optional() })
		.strict()
		.optional()
		.describe(
			"Content declaration {roles?: './security/roles.json', folders?: './ui/folders.json'} (documented in " +
				"references/manifest.md).",
		),
	unset: z.array(z.enum(SETTABLE)).optional().describe("Optional keys to remove from the manifest."),
};

export function manifestSet(args: z.infer<z.ZodObject<typeof manifestSetSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const next: Record<string, unknown> = { ...manifest };
	const warnings: string[] = [];
	const changed: string[] = [];

	const { moduleDir: _m, unset, ...values } = args;
	void _m;
	for (const [k, v] of Object.entries(values)) {
		if (v === undefined) continue;
		if (!(SETTABLE as readonly string[]).includes(k)) {
			throw new Error(`Manifest key '${k}' cannot be set with this tool. Settable: ${SETTABLE.join(", ")}.`);
		}
		next[k] = v;
		changed.push(k);
	}
	for (const k of unset ?? []) {
		if (next[k] === undefined) continue;
		delete next[k];
		changed.push(`-${k}`);
	}
	for (const k of ["supportedLocales", "features", "tags"] as const) {
		if (Array.isArray(next[k]) && (next[k] as unknown[]).length === 0) delete next[k];
	}

	if (args.supportedLocales) {
		const bad = args.supportedLocales.filter((l) => /^en($|-)/i.test(l));
		if (bad.length > 0) {
			throw new Error(`supportedLocales must not list ${bad.join(", ")} — English is the default and is never listed.`);
		}
		const dup = args.supportedLocales.filter((l, i) => args.supportedLocales!.indexOf(l) !== i);
		if (dup.length > 0) throw new Error(`supportedLocales lists ${[...new Set(dup)].join(", ")} twice.`);
		const missing = args.supportedLocales.filter((l) => !fs.existsSync(path.join(paths.translationsDir, `${l}.json`)));
		if (missing.length > 0) {
			warnings.push(
				`translations/${missing.join(".json, translations/")}.json missing — run dforge_translation_sync (it defaults to manifest.supportedLocales) before pack.`,
			);
		}
	}
	if (args.features?.includes("report-security")) {
		const reports = Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.reports, {}));
		const roles = readJsonOrDefault<Record<string, { rights?: Record<string, string> }>>(paths.roles, {});
		const ungranted = reports.filter(
			(r) =>
				!Object.values(roles).some(
					(role) => typeof role?.rights?.[`report:${r}`] === "string" && role.rights[`report:${r}`].includes("E"),
				),
		);
		if (ungranted.length > 0) {
			warnings.push(
				`'report-security' makes reports require 'E': no role grants it for report(s) ${ungranted.join(", ")} — they go dark for every role. Grant "report:<code>": "E" first (dforge_role_right_set).`,
			);
		}
	}
	if (typeof next.icon === "string" && args.icon !== undefined && !next.icon.startsWith("bi-")) {
		warnings.push(
			`icon '${next.icon}' has no 'bi-' prefix; the manifest convention is a Bootstrap class like 'bi-briefcase'.`,
		);
	}
	if (changed.length === 0) {
		throw new Error(`Nothing to change: pass at least one of ${SETTABLE.join(", ")}.`);
	}

	return makeResult(
		`Updated manifest.json (${changed.join(", ")}).`,
		{ "manifest.json": jsonText(withTodayStamp(next as typeof manifest)) },
		warnings.length > 0 ? `Warnings:\n${warnings.map((w) => `  • ${w}`).join("\n")}` : undefined,
	);
}
