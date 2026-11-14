// Five additive tools that all follow the same shape:
//   1. Load manifest + target JSON (creating an empty default if absent)
//   2. Reject if the key already exists (use *_modify or *_set instead)
//   3. Insert
//   4. Return single-file map
//
// Grouped in one file to keep boilerplate together — each tool is ~15-20
// lines of actual logic.

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { isFieldTypeCd, fieldTypeCds } from "@dforge-core/metadata";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	assertValidRights,
	walkFolders,
	diagramKeyProblem,
	readJson,
	type ToolResult,
	type Manifest,
	entityFilePath,
} from "./_helpers";
import { unlabeledReportMessage } from "./validate/reports";
import { loadVendoredSchema, validateAgainstSchema } from "./validate/json-schema";

// ── report add ──────────────────────────────────────────────────────

export const reportAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Report code (keys ui/reports.json)."),
	report: z
		.object({
			label: z
				.string()
				.optional()
				.describe(
					"The report's name: page title, breadcrumb and parameter dialog. Keep it short ('Trial Balance'). Omitted, the description names the report and pack/validate/install warn.",
				),
			description: z
				.string()
				.describe("What the report shows, under its label on the page ('Debit and credit totals per account for a period')."),
			layout: z.record(z.string(), z.unknown()),
			datasets: z.record(z.string(), z.unknown()),
			parameters: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					"Report-level parameter declarations — the canonical home for a param, and the only one that fits a param several datasets use. Merged with each dataset's `params` into the report's one param set; this block wins on a code collision.",
				),
			entities: z
				.array(
					z
						.object({
							entityCd: z.string(),
							params: z.record(z.string(), z.string()).optional(),
							orderNum: z.number().int().optional(),
						})
						.passthrough(),
				)
				.optional()
				.describe(
					"RECORD-REPORT attachments — entities this report can be opened FROM, so it appears on the record's toolbar with the record's values feeding its params. Each entry: { entityCd, params: { <reportParamCd>: <sourceColumnOnThatEntity> }, orderNum? }. NOTE `params` here is the MAPPING (param → column), not a param declaration. Qualify a cross-module entityCd ('parties.party') and declare that module as a dependency. Source columns: the PK, a reference ('R') column, or a bounded scalar — never text/json/file. Requires 'metadata': '>=1.5.0' in the manifest.",
				),
		})
		.passthrough()
		.describe(
			"Full report spec per reports.schema.json: { label, description, layout: { panels: [...] }, datasets: { code: {...} }, parameters?, entities?, reloadInterval? }. PARAMS ARE REPORT-SCOPED: declare them in the top-level `parameters` block, or as shorthand under `datasets.<cd>.params` when exactly one dataset uses the param — the installer merges both into the report's single param set, report level winning on a collision. A param several datasets use belongs at report level; there is no meaningful dataset to attribute it to. Within a param, use `required` (not `isRequired`) and nest a lookup's binding as `params: { link: { entity } }` (not a top-level `link`).",
		),
};

export function reportAdd(args: z.infer<z.ZodObject<typeof reportAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const reports = readJsonOrDefault<Record<string, unknown>>(paths.reports, {});
	if (Object.prototype.hasOwnProperty.call(reports, args.code)) {
		throw new Error(`Report '${args.code}' already exists in ui/reports.json.`);
	}
	// label first, so the file reads name → description → body.
	const { label, ...rest } = args.report;
	reports[args.code] = label?.trim() ? { label, ...rest } : rest;
	return makeResult(
		`Added report '${args.code}'.`,
		{
			[rel(paths.root, paths.reports)]: jsonText(reports),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		label?.trim() ? undefined : unlabeledReportMessage(args.code, args.report.description),
	);
}

// ── setting add ─────────────────────────────────────────────────────

export const settingAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Setting code (keys settings.json)."),
	setting: z
		.object({
			fieldTypeCd: z.string(),
			baseDatatypeCd: z.string().optional(),
			label: z.string().optional(),
			description: z.string().optional(),
			defaultValue: z.unknown().optional(),
			formula: z.string().optional(),
			required: z.boolean().optional(),
			params: z.record(z.string(), z.unknown()).optional(),
		})
		.passthrough()
		.superRefine((val, ctx) => {
			const ftc = (val as { fieldTypeCd?: unknown }).fieldTypeCd;
			if (typeof ftc === "string" && !isFieldTypeCd(ftc)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `fieldTypeCd '${ftc}' is not a valid field type. Valid codes: ${[...fieldTypeCds].sort().join(", ")}. (See dforge://reference/field-types.)`,
				});
			}
		}),
};

export function settingAdd(args: z.infer<z.ZodObject<typeof settingAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const settings = readJsonOrDefault<Record<string, unknown>>(paths.settings, {});
	if (Object.prototype.hasOwnProperty.call(settings, args.code)) {
		throw new Error(`Setting '${args.code}' already exists.`);
	}
	const schema = loadVendoredSchema("settings");
	if (schema) {
		const problems = validateAgainstSchema(schema, { [args.code]: args.setting }).map((p) => {
			const at = p.path.replace(new RegExp(`^${args.code}\\.?`), "") || "(setting)";
			if (at === "baseDatatypeCd") {
				const bad = String((args.setting as Record<string, unknown>).baseDatatypeCd);
				return (
					`baseDatatypeCd '${bad}': the vendored settings.schema.json does not list it (allowed: string, number, bool, date, dateTime, time, json). ` +
					"How a setting that holds a user/record id (a user picker) is typed is an open question in the schema; use 'string' (or omit baseDatatypeCd and give fieldTypeCd) rather than guessing."
				);
			}
			return `${at} ${p.message}`;
		});
		if (problems.length > 0) {
			throw new Error(`Setting '${args.code}' does not match the vendored settings schema: ${problems.join("; ")}`);
		}
	}
	settings[args.code] = args.setting;
	return makeResult(`Added setting '${args.code}'.`, {
		[rel(paths.root, paths.settings)]: jsonText(settings),
		"manifest.json": jsonText(withTodayStamp(manifest)),
	});
}

// ── role add ────────────────────────────────────────────────────────

export const roleAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/)
		.describe(
			"Role code, namespaced as `<module>.<role>` (e.g. 'crm.admin'). Conventional namespacing prevents collisions across modules.",
		),
	description: z.string(),
	rights: z
		.record(z.string(), z.string())
		.describe(
			"Map: object code → rights string. Keys: same-module entity bare ('product'), cross-module entity dotted ('fin.invoice'), action/report/SP/folder with a COLON prefix ('action:approve', 'report:summary', 'sp:rpt_totals', 'folder:east') — never a dot. Values: entities use 'S'/'I'/'U'/'D'/'C' (e.g. 'SIUDC'); actions/reports/SPs/folders use 'E'. A report with a datasetType 'S' dataset needs BOTH 'report:<cd>' and 'sp:<spCd>'. To deny, omit the key (never map to '').",
		),
};

export function roleAdd(args: z.infer<z.ZodObject<typeof roleAddSchema>>): ToolResult {
	assertValidRights(args.rights);
	const { paths, manifest } = loadManifest(args.moduleDir);
	const roles = readJsonOrDefault<Record<string, unknown>>(paths.roles, {});
	if (Object.prototype.hasOwnProperty.call(roles, args.code)) {
		throw new Error(`Role '${args.code}' already exists.`);
	}
	roles[args.code] = { description: args.description, rights: args.rights };
	return makeResult(
		`Added role '${args.code}' with rights on ${Object.keys(args.rights).length} object(s).`,
		{
			[rel(paths.root, paths.roles)]: jsonText(roles),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── folder add ──────────────────────────────────────────────────────
//
// folders.json IS the root folder (single-folder convention, NOT a map).
// Adding a sub-folder means inserting into the root's (or a nested
// folder's) `children` map. parentPath is a slash-separated path of
// folder codes from root, OR empty for "directly under root".

export const folderAddSchema = {
	moduleDir: z.string(),
	parentPath: z
		.string()
		.default("")
		.describe(
			"Slash-separated folder codes from root, e.g. 'central/east' nests under root → central → east. Empty = add directly under root.",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("New folder's code (key under parent.children)."),
	folder: z
		.object({
			label: z.string(),
			description: z.string().optional(),
			color: z.string().optional(),
			icon: z.string().optional(),
			inheritSecurity: z.boolean().optional(),
			entities: z.record(z.string(), z.unknown()).optional(),
			children: z.record(z.string(), z.unknown()).optional(),
		})
		.passthrough(),
};

export function folderAdd(args: z.infer<z.ZodObject<typeof folderAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const root = readJsonOrDefault<Record<string, unknown>>(paths.folders, {
		label: manifest.displayName,
	});

	// Walk parentPath to find the destination folder.
	let cursor: Record<string, unknown> = root;
	const segments = args.parentPath.split("/").filter(Boolean);
	for (const seg of segments) {
		const children = (cursor.children as Record<string, unknown>) ?? {};
		if (!children[seg]) {
			throw new Error(
				`Folder path segment '${seg}' not found under '${segments.slice(0, segments.indexOf(seg)).join("/") || "(root)"}'.`,
			);
		}
		cursor = children[seg] as Record<string, unknown>;
	}

	// Folder codes must be unique across the WHOLE tree, not just among siblings:
	// role rights reference a folder as `folder:<code>` with no path. A second
	// 'east' under a different parent would make the grant ambiguous.
	const clash = walkFolders(root).find((f) => f.code === args.code);
	if (clash) {
		throw new Error(
			`Folder code '${args.code}' is already used at '${clash.path}'. Folder codes must be unique across ` +
				`the whole tree — role rights reference a folder as 'folder:${args.code}' with no path, so a ` +
				"duplicate is ambiguous. Pick a distinct code (e.g. 'east_central').",
		);
	}

	const children = (cursor.children as Record<string, unknown>) ?? {};
	children[args.code] = args.folder;
	cursor.children = children;

	return makeResult(
		`Added folder '${args.code}' under '${args.parentPath || "(root)"}'.`,
		{
			[rel(paths.root, paths.folders)]: jsonText(root),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── folder modify ───────────────────────────────────────────────────
//
// folder_add only creates; the menu/folder coverage rule needs an entity added
// to an EXISTING folder. Edits one folder node of ui/folders.json: entity
// bindings (add/replace + remove), label/description/icon/color/inheritSecurity,
// and removal of optional scalar keys. The result is checked against the
// vendored folders.schema.json. Never writes a `roles` key.

const folderBindingSchema = z
	.object({
		viewName: z.string().optional().describe("Entity view (a key under the entity's `views`), NOT a data view code. 'default' = no view."),
		quickAdd: z.boolean().optional(),
		rowFilter: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("SQL expression string or canonical filter object ({c,o,v} / {g,i})."),
	})
	.strict();

export const folderModifySchema = {
	moduleDir: z.string(),
	parentPath: z
		.string()
		.default("")
		.describe("Slash-separated folder codes from the root to the PARENT of the folder to modify. Empty = the folder is directly under the root."),
	code: z
		.string()
		.optional()
		.describe("Code of the folder to modify. Omit it to modify the ROOT folder."),
	label: z.string().optional(),
	description: z.string().optional(),
	icon: z.string().optional(),
	color: z.string().optional(),
	inheritSecurity: z.boolean().optional(),
	unset: z
		.array(z.enum(["description", "icon", "color", "inheritSecurity"]))
		.optional()
		.describe("Optional keys to remove from the folder."),
	addEntities: z
		.record(z.string(), folderBindingSchema)
		.optional()
		.describe("Entity code -> binding {viewName?, quickAdd?, rowFilter?}. An entity already bound is MERGED (given keys replace, others stay)."),
	removeEntities: z.array(z.string()).optional().describe("Entity codes whose binding is removed from the folder."),
};

export function folderModify(args: z.infer<z.ZodObject<typeof folderModifySchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	if (!fs.existsSync(paths.folders)) throw new Error("ui/folders.json does not exist — nothing to modify (dforge_folder_add creates sub-folders on an existing root).");
	const root = readJson<Record<string, unknown>>(paths.folders);

	const parentSegments = args.parentPath.split("/").filter(Boolean);
	if (!args.code && parentSegments.length > 0) {
		throw new Error(
			`parentPath '${args.parentPath}' is given without 'code'. Omitting 'code' targets the ROOT folder, which has no parent — to modify '${args.parentPath}' itself, pass its last segment as 'code' and the rest as parentPath.`,
		);
	}
	const segments = [...parentSegments, ...(args.code ? [args.code] : [])];
	let node: Record<string, unknown> = root;
	for (let i = 0; i < segments.length; i++) {
		const child = ((node.children as Record<string, unknown> | undefined) ?? {})[segments[i]];
		if (!child || typeof child !== "object") {
			throw new Error(`Folder '${segments.slice(0, i + 1).join("/")}' not found. Existing folders: ${walkFolders(root).map((f) => f.path).join(", ") || "(only the root)"}.`);
		}
		node = child as Record<string, unknown>;
	}
	const where = segments.length ? segments.join("/") : "(root)";
	const changed: string[] = [];
	const warnings: string[] = [];

	for (const k of ["label", "description", "icon", "color", "inheritSecurity"] as const) {
		if (args[k] !== undefined) {
			node[k] = args[k];
			changed.push(k);
		}
	}
	for (const k of args.unset ?? []) {
		if (args[k as keyof typeof args] !== undefined) throw new Error(`'${k}' is both set and unset in one call.`);
		if (!(k in node)) {
			warnings.push(`'${k}' was not set on '${where}' — nothing to unset.`);
			continue;
		}
		delete node[k];
		changed.push(`-${k}`);
	}

	const entities = { ...((node.entities as Record<string, Record<string, unknown>> | undefined) ?? {}) };
	for (const code of args.removeEntities ?? []) {
		if (!Object.prototype.hasOwnProperty.call(entities, code)) {
			throw new Error(`Folder '${where}' has no binding for entity '${code}'. Bound: ${Object.keys(entities).join(", ") || "(none)"}.`);
		}
		if (args.addEntities && code in args.addEntities) throw new Error(`Entity '${code}' is both added and removed in one call.`);
		delete entities[code];
		changed.push(`-entities.${code}`);
	}
	const ownEntities = manifest.entities ?? {};
	for (const [code, binding] of Object.entries(args.addEntities ?? {})) {
		if (!code.includes(".") && !Object.prototype.hasOwnProperty.call(ownEntities, code)) {
			throw new Error(`Entity '${code}' is not in manifest.entities. Existing: ${Object.keys(ownEntities).join(", ") || "(none)"}. (Cross-module entities are written 'module.entity'.)`);
		}
		const vn = binding.viewName;
		if (vn && vn.trim().toLowerCase() !== "default" && ownEntities[code]) {
			const ep = entityFilePath(paths.root, ownEntities[code]);
			const declared = fs.existsSync(ep)
				? Object.keys(((readJson<Record<string, unknown>>(ep).views as Record<string, unknown> | undefined) ?? {})).map((v) => v.trim().toLowerCase())
				: [];
			if (!declared.includes(vn.trim().toLowerCase())) {
				throw new Error(`viewName '${vn}' is not declared under 'views' in entities/${code}.json — the install fails on it. Declare the view or use 'default'.`);
			}
		}
		const had = Object.prototype.hasOwnProperty.call(entities, code);
		entities[code] = { ...(entities[code] ?? {}), ...binding };
		changed.push(`${had ? "~" : "+"}entities.${code}`);
	}
	if (args.addEntities || args.removeEntities) {
		if (Object.keys(entities).length === 0) delete node.entities;
		else node.entities = entities;
	}

	if (changed.length === 0) {
		throw new Error("Nothing to change: pass at least one of label, description, icon, color, inheritSecurity, unset, addEntities, removeEntities.");
	}

	const schema = loadVendoredSchema("folders");
	if (schema) {
		const problems = validateAgainstSchema(schema, root);
		if (problems.length > 0) {
			throw new Error(`Result would violate folders.schema.json: ${problems.map((p) => `${p.path || "(root)"} ${p.message}`).join("; ")}. Nothing written.`);
		}
	}

	return makeResult(
		`Modified folder '${where}' (${changed.join(", ")}).`,
		{
			[rel(paths.root, paths.folders)]: jsonText(root),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length > 0 ? `Warnings:\n${warnings.map((w) => `  • ${w}`).join("\n")}` : undefined,
	);
}

// ── diagram add ─────────────────────────────────────────────────────
//
// docs/diagrams/<code>.json is ONE diagram per file (the file name is its
// code): a chosen subset of the module's entities, drawn by the editor.
// Design-time only — install never reads it. Unlike the other *_add tools this
// one also extends an existing diagram: missing entity keys are appended,
// placed ones keep their x/y, and nothing is ever dropped. An unresolved key
// is rejected here (module_validate only warns about it) — the caller is
// authoring, so a typo should fail now rather than draw a dangling node.

export const diagramAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Diagram code — becomes the file name docs/diagrams/<code>.json."),
	label: z.string().optional().describe("Display name. Defaults to the fromFolder's label, else the code."),
	description: z.string().optional().describe("What part of the model the diagram covers."),
	entities: z
		.array(z.string().min(1))
		.default([])
		.describe(
			"Entity keys to draw: the manifest's own entity code ('invoice'), or 'module.entity' for an entity of a declared dependency ('parties.party') — the same form a field link's `entity` takes.",
		),
	fromFolder: z
		.string()
		.optional()
		.describe(
			"A folder code from ui/folders.json (anywhere in the tree). Adds the entities bound to that folder AND to all its descendants.",
		),
	showBoundary: z
		.boolean()
		.optional()
		.describe(
			"Also draw the entities outside the diagram that its entities reference or are referenced by, as header-only stubs. Default true.",
		),
};

export function diagramAdd(args: z.infer<z.ZodObject<typeof diagramAddSchema>>): ToolResult {
	// The code is a file name — re-check here, not only in the MCP input schema,
	// so no caller can write outside docs/diagrams/.
	if (!/^[a-z][a-z0-9_]*$/.test(args.code)) {
		throw new Error(`Diagram code '${args.code}' must be snake_case (^[a-z][a-z0-9_]*$) — it becomes the file name.`);
	}
	const { paths, manifest } = loadManifest(args.moduleDir);
	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	const deps = new Set(Object.keys(manifest.dependencies ?? {}));

	// fromFolder: the folder's own bindings, then every descendant's, in tree order.
	const keys: string[] = [...args.entities];
	let folderLabel: string | undefined;
	if (args.fromFolder !== undefined) {
		const root = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
		const folder = walkFolders(root).find((f) => f.code === args.fromFolder);
		if (!folder) {
			throw new Error(
				`Folder '${args.fromFolder}' is not in ui/folders.json. Pass a sub-folder's code (codes are ` +
					"unique across the tree); for every entity in the module, list them in 'entities' instead.",
			);
		}
		if (typeof folder.node.label === "string") folderLabel = folder.node.label;
		for (const node of [folder.node, ...walkFolders(folder.node).map((f) => f.node)]) {
			keys.push(...Object.keys((node.entities as Record<string, unknown> | undefined) ?? {}));
		}
	}
	const wanted = [...new Set(keys)];

	const problems = wanted
		.map((k) => diagramKeyProblem(k, entityMap, deps, paths.root))
		.filter((p): p is string => p !== undefined);
	if (problems.length > 0) {
		throw new Error(`Nothing written — ${problems.join(" ")}`);
	}

	const file = path.join(paths.diagramsDir, `${args.code}.json`);
	const exists = fs.existsSync(file);
	let diagram: Record<string, unknown>;
	if (exists) {
		const existing = readJson<unknown>(file);
		if (
			!existing ||
			typeof existing !== "object" ||
			Array.isArray(existing) ||
			!(existing as Record<string, unknown>).entities ||
			typeof (existing as Record<string, unknown>).entities !== "object" ||
			Array.isArray((existing as Record<string, unknown>).entities)
		) {
			throw new Error(
				`${rel(paths.root, file)} is not a diagram (an object with an 'entities' map) — fix or delete it first.`,
			);
		}
		diagram = existing as Record<string, unknown>;
		if (args.label !== undefined) diagram.label = args.label;
		if (args.description !== undefined) diagram.description = args.description;
		if (args.showBoundary !== undefined) diagram.showBoundary = args.showBoundary;
	} else {
		diagram = { label: args.label ?? folderLabel ?? args.code };
		if (args.description !== undefined) diagram.description = args.description;
		diagram.entities = {};
		if (args.showBoundary !== undefined) diagram.showBoundary = args.showBoundary;
	}

	// Append only — a placed entity keeps its x/y, and nothing is dropped.
	const entities = diagram.entities as Record<string, unknown>;
	const added = wanted.filter((k) => !Object.prototype.hasOwnProperty.call(entities, k));
	for (const k of added) entities[k] = {};

	const relPath = rel(paths.root, file);
	const present = wanted.length - added.length;
	return makeResult(
		exists
			? `Updated diagram '${args.code}' (${relPath}): added ${added.length} entit${added.length === 1 ? "y" : "ies"}` +
					`${present ? `, ${present} already drawn` : ""}.`
			: `Created diagram '${args.code}' (${relPath}) with ${added.length} entit${added.length === 1 ? "y" : "ies"}.`,
		{
			[relPath]: jsonText(diagram),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

// ── dependency add ──────────────────────────────────────────────────

// System modules are provisioned into every tenant before any other module
// installs, so depending on one buys nothing on its own. The single legitimate
// reason is to require a minimum platform version for a feature you use
// (e.g. metadata >= 1.5.0 for record-report attachments) — hence a warning, not
// a hard error. Such a gate may name no entity: its contract is `"entities": {}`.
export const SYSTEM_MODULES = new Set(["admin", "metadata", "workspace", "sys-billing"]);

export const dependencyAddSchema = {
	moduleDir: z.string(),
	moduleCode: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("Module to depend on."),
	version: z
		.string()
		.optional()
		.describe(
			"Semver range. Defaults to '>=0.1.0' for a new dependency; when the dependency is already declared, omit it to keep the current range or pass it to change the range (manifest and contract are both updated).",
		),
	entities: z
		.array(z.string())
		.describe(
			"The provider entities this module consumes, e.g. ['party']. Every dependency needs a deps/<module>.json contract naming at least one entity, and a dependency you cannot name a consumed entity for should not be declared at all. Narrows the manifest dep to the object form `{ version, entities }`. Exception: against a system module (admin, metadata, workspace, sys-billing) pass [] for a pure platform-version gate, e.g. admin >=1.21.0 for upgrade migrations; the contract then declares \"entities\": {} and the manifest dep stays a plain version string.",
		),
	use: z
		.array(z.string())
		.optional()
		.describe(
			"Provenance tokens recorded against each declared entity: '<kind>:<symbol>' where kind is ref|extends|formula|action|view|report|print|role, e.g. 'ref:invoice.customer'. 'extends' must be fully qualified ('extends:parties.party'). Defaults to a placeholder you must refine.",
		),
	pks: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Override the provider PK column per entity, e.g. { \"party\": \"party_uid\" }. Defaults to '<entity>_id', which is what the 'identity' trait produces.",
		),
};

/**
 * The deps/<module>.json contract for one dependency: the consumer's import list.
 * Shared with dforge_module_create, which writes it for `dependencies` entries
 * that name their entities (a bare manifest entry without it fails validate).
 */
export function buildDependencyContract(
	moduleCode: string,
	version: string,
	entities: string[],
	use: string[],
	pks?: Record<string, string>,
): Record<string, unknown> {
	return {
		module: moduleCode,
		version,
		entities: Object.fromEntries(
			entities.map((e) => [e, { pk: pks?.[e] ?? `${e}_id`, use: [...use] }]),
		),
	};
}

export function dependencyAdd(
	args: z.infer<z.ZodObject<typeof dependencyAddSchema>>,
): ToolResult {
	const { manifest, paths } = loadManifest(args.moduleDir);
	if (manifest.code === args.moduleCode) {
		throw new Error("A module can't depend on itself.");
	}
	const deps = manifest.dependencies ?? {};
	const declared = Object.prototype.hasOwnProperty.call(deps, args.moduleCode);
	const contractPath = path.join(paths.root, "deps", `${args.moduleCode}.json`);
	const contractExists = fs.existsSync(contractPath);
	const isSystem = SYSTEM_MODULES.has(args.moduleCode);

	if (declared) return repairDependency(args, manifest, deps, contractPath, contractExists, isSystem);

	const version = args.version ?? ">=0.1.0";
	const gateOnly = args.entities.length === 0;
	if (gateOnly && !isSystem) {
		throw new Error(
			`Name at least one '${args.moduleCode}' entity this module consumes. Only a system module (${[...SYSTEM_MODULES].join(", ")}) may be depended on with no entity, as a platform-version gate.`,
		);
	}
	if (contractExists) {
		throw new Error(
			`deps/${args.moduleCode}.json already exists but '${args.moduleCode}' is not a manifest dependency. ` +
				`Add the manifest entry by hand or delete the stale contract — this tool will not overwrite it.`,
		);
	}

	const newManifest = withTodayStamp({
		...manifest,
		dependencies: {
			...deps,
			[args.moduleCode]: gateOnly ? version : { version, entities: args.entities },
		},
	});

	// The contract is the consumer's import list, and the platform hard-gates on
	// it: a manifest dependency without deps/<module>.json fails module validate,
	// pack and install alike. Writing only the manifest half (what this tool used
	// to do) leaves an unpackable module — see dforge-core issue #1090.
	const placeholderUse = !gateOnly && (!args.use || args.use.length === 0);
	const use: string[] = placeholderUse ? [`ref:${manifest.code}`] : args.use!;
	const contract = buildDependencyContract(args.moduleCode, version, args.entities, use, args.pks);

	const warnings: string[] = [];
	if (placeholderUse) {
		warnings.push(
			`deps/${args.moduleCode}.json was written with a placeholder provenance token 'ref:${manifest.code}'. ` +
				`Replace it with the real usage (e.g. 'ref:<my_entity>.<my_column>', 'extends:${args.moduleCode}.<entity>', 'role:<role_cd>') — it is the record of WHY the dependency exists.`,
		);
	}
	if (!gateOnly && !args.pks) {
		warnings.push(
			`PKs were guessed as '<entity>_id'. Check them against ${args.moduleCode}'s entity files — a wrong pk fails the install-time satisfaction check.`,
		);
	}
	if (isSystem && !gateOnly) {
		warnings.push(
			`'${args.moduleCode}' is a system module — always provisioned, so this dependency is only meaningful as a minimum-platform-version gate. If you are not gating a platform feature, drop it.`,
		);
	}
	if (!gateOnly) {
		warnings.push(
			`Declare the columns you actually read, write or join on under each entity's 'columns' — see dforge://schema/deps.`,
		);
	}

	return makeResult(
		gateOnly
			? `Added platform-version gate on '${args.moduleCode}' (${version}), with a deps/${args.moduleCode}.json contract that declares no entity.`
			: `Added dependency on '${args.moduleCode}' (${version}) for entities [${args.entities.join(", ")}], with the required deps/${args.moduleCode}.json contract.`,
		{
			"manifest.json": jsonText(newManifest),
			[`deps/${args.moduleCode}.json`]: jsonText(contract),
		},
		warnings.length ? warnings.join("\n") : undefined,
	);
}

/**
 * The dependency is already in the manifest: idempotent / repairing path.
 * - contract missing  -> create it (what `dforge_module_create` used to leave undone);
 * - contract present  -> add any entities it lacks, and move the version range if asked;
 * - nothing to change -> say so and return no files.
 */
function repairDependency(
	args: z.infer<z.ZodObject<typeof dependencyAddSchema>>,
	manifest: Manifest,
	deps: NonNullable<Manifest["dependencies"]>,
	contractPath: string,
	contractExists: boolean,
	isSystem: boolean,
): ToolResult {
	const code = args.moduleCode;
	const entry = deps[code];
	const entryVersion = typeof entry === "string" ? entry : entry.version;
	const entryEntities = typeof entry === "string" ? [] : (entry.entities ?? []);
	const version = args.version ?? entryVersion;

	let contract: Record<string, any> | undefined;
	if (contractExists) {
		try {
			contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
		} catch (e) {
			throw new Error(`deps/${code}.json is not valid JSON (${(e as Error).message}) — fix or delete it, then re-run.`);
		}
		if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
			throw new Error(`deps/${code}.json is not a JSON object — fix or delete it, then re-run.`);
		}
	}

	// Entities the contract must name: the ones asked for, else what the
	// manifest entry already narrows to, else what the contract already has.
	const wanted = args.entities.length ? args.entities : entryEntities;
	if (!contract && wanted.length === 0 && !isSystem) {
		throw new Error(
			`Dependency '${code}' is declared in manifest.json but has no deps/${code}.json contract, and no entity is named. ` +
				`Pass the '${code}' entities this module consumes (entities: [...]) and the contract is created.`,
		);
	}

	const use = args.use?.length ? args.use : [`ref:${manifest.code}`];
	const placeholderUse = !args.use?.length;
	const newContract: Record<string, any> = contract
		? { ...contract }
		: (buildDependencyContract(code, version, [], use) as Record<string, any>);
	newContract.module = code;
	newContract.version = version;
	newContract.entities = { ...(contract?.entities ?? {}) };
	const addedEntities: string[] = [];
	for (const e of wanted) {
		if (Object.prototype.hasOwnProperty.call(newContract.entities, e)) continue;
		newContract.entities[e] = { pk: args.pks?.[e] ?? `${e}_id`, use: [...use] };
		addedEntities.push(e);
	}

	const allEntities = [...new Set([...entryEntities, ...Object.keys(newContract.entities)])];
	const newEntry: string | { version: string; entities: string[] } =
		allEntities.length === 0 ? version : { version, entities: allEntities };

	const manifestChanged = JSON.stringify(newEntry) !== JSON.stringify(entry);
	const contractChanged = !contract || JSON.stringify(newContract) !== JSON.stringify(contract);

	if (!manifestChanged && !contractChanged) {
		return makeResult(
			`Dependency on '${code}' (${version}) is already declared with a matching deps/${code}.json contract — nothing to change.`,
			{},
		);
	}

	const files: Record<string, string> = {};
	if (manifestChanged) {
		files["manifest.json"] = jsonText(withTodayStamp({ ...manifest, dependencies: { ...deps, [code]: newEntry } }));
	}
	if (contractChanged) files[`deps/${code}.json`] = jsonText(newContract);

	const did: string[] = [];
	if (!contract) did.push(`created the missing deps/${code}.json contract`);
	else if (addedEntities.length) did.push(`added entit${addedEntities.length === 1 ? "y" : "ies"} ${addedEntities.join(", ")} to deps/${code}.json`);
	if (version !== entryVersion) did.push(`moved the range ${entryVersion} -> ${version}`);
	const warnings: string[] = [];
	if (addedEntities.length && placeholderUse) {
		warnings.push(
			`New contract entries carry the placeholder provenance token 'ref:${manifest.code}' — replace it with the real usage ('ref:<entity>.<column>', 'extends:${code}.<entity>', ...).`,
		);
	}
	if (addedEntities.length && !args.pks) {
		warnings.push(`PKs of the added entities were guessed as '<entity>_id' — check them against ${code}'s entity files.`);
	}
	return makeResult(
		`Dependency on '${code}' was already declared; ${did.join(", ") || "synchronised manifest and contract"}.`,
		files,
		warnings.length ? warnings.join("\n") : undefined,
	);
}
