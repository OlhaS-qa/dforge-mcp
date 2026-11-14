import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { buildEntity, buildFolders, buildMenus, buildRoles } from "@dforge-core/dforge-cli/templates";
import type { EntitySpec, ScaffoldOpts } from "@dforge-core/dforge-cli/templates";
import { traitsInput, withTraits, withIdentityToString, expandedEntity, walkFolders, jsonText } from "./_helpers";

export const adminRightsInput = z
	.string()
	.regex(/^[SIUDC]+$/)
	.describe(
		"Rights granted to the '<module>.admin' role on the new entity/entities (default 'SIUDC'). Pass e.g. " +
			"'SIUC' when the module forbids deleting these records. Applies only when roles.json already exists; " +
			"with a fresh roles.json the scaffold default is used.",
	);

export const nameFieldInput = z
	.boolean()
	.optional()
	.describe(
		"Default true: the scaffold stub carries a visible `name` text field and toString '{name}'. Pass " +
			"false when the entity has no 'name' (a document, a line, a register row): no stub field is created, " +
			"so there is nothing to remove afterwards; toString is then the given `toString` template or the " +
			"primary key, and the default grid lists real columns (the PK until you add fields). A grid needs " +
			"one visible field, so add the entity's first field (dforge_entity_field_add, flags V…) before " +
			"dforge_module_validate.",
	);

export const toStringInput = z
	.string()
	.optional()
	.describe(
		"Optional toString template (key `toStringTemplate`) for the new entity, e.g. '{number} - {title}'. " +
			"It must name columns the entity has or will get (add them with dforge_entity_field_add); " +
			"dforge_module_validate flags a placeholder with no column. Used as given with nameField:false; " +
			"otherwise it replaces the stub '{name}'.",
	);

/**
 * Build the entity JSON for a scaffold stub: the CLI builder's output with the
 * author's traits, a toString that only names real columns, and, when
 * `nameField` is false, no stub `name` field.
 */
export function buildEntityStub(
	spec: EntitySpec,
	traits: readonly string[],
	opts: { nameField?: boolean; toStringTemplate?: string } = {},
): Obj {
	let entity: Obj = withIdentityToString(withTraits(buildEntity(spec), traits), spec.name, traits) as Obj;
	if (opts.nameField === false) {
		const { name: _stub, ...rest } = (entity.fields ?? {}) as Obj;
		entity = { ...entity, fields: rest };
		// The stub toString names the dropped field: ensureToString falls back to the PK.
		entity = ensureToString(entity, spec.name);
	}
	if (opts.toStringTemplate) return { ...entity, toString: opts.toStringTemplate };
	return ensureToString(entity, spec.name);
}

export const addEntitySchema = {
	moduleDir: z.string().describe("Absolute or relative path to an existing module directory (contains manifest.json)."),
	entity: z.object({
		name: z.string().regex(/^[a-z][a-z0-9_]*$/),
		label: z.string().min(1),
		traits: traitsInput,
		nameField: nameFieldInput,
		toStringTemplate: toStringInput,
	}),
	adminRights: adminRightsInput.optional(),
};

type Obj = Record<string, any>;

// ── Shared, additive UI/security helpers ─────────────────────────────
//
// The builders in dforge-cli regenerate whole files (views, folders, menus,
// roles) for a list of entities. Running them over the module's full entity
// list and writing the result over the existing files is what used to delete
// roles, action/report rights, custom views, child folders and menu sections.
// These helpers read what is on disk and ADD only what the new entities need.

/** Field types that make a poor grid column (large / structured values). */
const NON_GRID_TYPES = new Set(["textarea", "json", "markdown", "richtext", "file", "image", "code", "hidden"]);

/**
 * Default grid columns for an entity: the fields it really has, visible, scalar,
 * in orderNum order (max 8). Falls back to the identity PK so the view never
 * ships with `columns: []`.
 */
export function viewColumnsFor(entity: Obj, entityName: string): string[] {
	const fields: Obj = entity.fields ?? {};
	const own = Object.entries(fields)
		.filter(
			([, f]) =>
				f &&
				typeof f.flags === "string" &&
				f.flags.includes("V") &&
				f.columnType !== "S" &&
				f.columnType !== "F" &&
				!NON_GRID_TYPES.has(f.fieldTypeCd),
		)
		.sort((a, b) => (a[1].orderNum ?? 0) - (b[1].orderNum ?? 0))
		.map(([k]) => k)
		.slice(0, 8);
	if (own.length > 0) return own;
	const { fieldDefs } = expandedEntity(entity, entityName);
	const pk = Object.entries(fieldDefs).find(([, f]) => f.isPk === true)?.[0];
	return pk ? [pk] : [];
}

/**
 * Make sure `toString` only mentions columns the entity has. A placeholder like
 * `{name}` on an entity without a `name` field fails validation; replace it with
 * the first suitable text field, else the primary key.
 */
export function ensureToString<T extends Obj>(entity: T, entityName: string): T {
	const { columns, fieldDefs } = expandedEntity(entity, entityName);
	const ts: unknown = Object.prototype.hasOwnProperty.call(entity, "toString")
		? (entity as Obj)["toString"]
		: undefined;
	if (typeof ts === "string") {
		const refs = [...ts.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
		if (refs.length > 0 && refs.every((r) => columns.has(r))) return entity;
		if (refs.length === 0) return entity; // a literal template, nothing to check
	}
	const fields: Obj = entity.fields ?? {};
	const text = Object.entries(fields)
		.filter(([, f]) => f && f.fieldTypeCd === "text" && f.columnType !== "R" && f.columnType !== "S")
		.sort((a, b) => (a[1].orderNum ?? 0) - (b[1].orderNum ?? 0))[0]?.[0];
	const pk = Object.entries(fieldDefs).find(([, f]) => f.isPk === true)?.[0];
	const pick = text ?? pk;
	return { ...entity, toString: pick ? `{${pick}}` : null };
}

export interface NewEntityInfo {
	name: string;
	label: string;
	/** The built entity JSON (fields + traits), used for default view columns. */
	entity: Obj;
}

export interface UiMergeResult {
	/** Only the files that changed (merged content). */
	files: Record<string, string>;
	/** Human-readable list of what was ADDED. */
	added: string[];
	/** Human-readable list of problems/skips (e.g. no admin role to grant on). */
	notes: string[];
}

function readExisting(root: string, rel: string): Obj | undefined {
	const abs = path.join(root, rel);
	if (!fs.existsSync(abs)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
	} catch (e) {
		throw new Error(
			`${rel} is not valid JSON (${(e as Error).message}) — fix it before adding entities; nothing was changed.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${rel} is not a JSON object — fix it before adding entities; nothing was changed.`);
	}
	return parsed as Obj;
}

function menuViewCodes(items: Obj | undefined, into: Set<string>): void {
	for (const it of Object.values(items ?? {})) {
		if (!it || typeof it !== "object") continue;
		if (typeof (it as Obj).dataViewCode === "string") into.add((it as Obj).dataViewCode);
		menuViewCodes((it as Obj).children, into);
	}
}

function folderHasEntity(root: Obj, name: string): boolean {
	if (root.entities && Object.prototype.hasOwnProperty.call(root.entities, name)) return true;
	return walkFolders(root).some((f) => {
		const ents = (f.node as Obj).entities;
		return !!ents && Object.prototype.hasOwnProperty.call(ents, name);
	});
}

/**
 * Add default view / folder entry / menu leaf / admin right for each new entity,
 * keeping every existing file's content. A file that does not exist yet is built
 * from scratch for all of `allSpecs` (nothing to overwrite).
 */
export function mergeUiAndSecurity(
	root: string,
	opts: ScaffoldOpts,
	news: NewEntityInfo[],
	allSpecs: EntitySpec[],
	adminRights = "SIUDC",
): UiMergeResult {
	const files: Record<string, string> = {};
	const added: string[] = [];
	const notes: string[] = [];
	const code = opts.code;
	const newByName = new Map(news.map((n) => [n.name, n]));

	const entityJson = (name: string): Obj | undefined => {
		const n = newByName.get(name);
		if (n) return n.entity;
		try {
			return JSON.parse(fs.readFileSync(path.join(root, "entities", `${name}.json`), "utf8"));
		} catch {
			return undefined;
		}
	};
	const viewFor = (spec: EntitySpec): Obj => {
		const ent = entityJson(spec.name);
		return {
			viewType: "grid",
			label: spec.label,
			dataSources: [{ entityCode: spec.name, columns: ent ? viewColumnsFor(ent, spec.name) : [] }],
		};
	};

	// ── ui/data_views.json
	const views = readExisting(root, "ui/data_views.json");
	if (!views) {
		files["ui/data_views.json"] = jsonText(Object.fromEntries(allSpecs.map((s) => [s.name, viewFor(s)])));
		added.push(`ui/data_views.json created with ${allSpecs.length} default view(s)`);
	} else {
		const added_: string[] = [];
		for (const n of news) {
			if (Object.prototype.hasOwnProperty.call(views, n.name)) {
				notes.push(`ui/data_views.json already has a view '${n.name}' — left as is.`);
				continue;
			}
			views[n.name] = viewFor({ name: n.name, label: n.label, traits: "identity" });
			added_.push(n.name);
		}
		if (added_.length) {
			files["ui/data_views.json"] = jsonText(views);
			added.push(`ui/data_views.json: default grid view(s) ${added_.join(", ")}`);
		}
	}

	// ── ui/folders.json
	const folders = readExisting(root, "ui/folders.json");
	if (!folders) {
		files["ui/folders.json"] = jsonText(buildFolders({ ...opts, entities: allSpecs }));
		added.push("ui/folders.json created");
	} else {
		const added_: string[] = [];
		for (const n of news) {
			if (folderHasEntity(folders, n.name)) continue;
			if (!folders.entities || typeof folders.entities !== "object") folders.entities = {};
			folders.entities[n.name] = { viewName: "default", quickAdd: true };
			added_.push(n.name);
		}
		if (added_.length) {
			files["ui/folders.json"] = jsonText(folders);
			added.push(`ui/folders.json: root folder entry for ${added_.join(", ")}`);
		}
	}

	// ── ui/menus.json
	const menus = readExisting(root, "ui/menus.json");
	if (!menus || Object.keys(menus).length === 0) {
		files["ui/menus.json"] = jsonText(buildMenus({ ...opts, entities: allSpecs }));
		added.push("ui/menus.json created");
	} else {
		const used = new Set<string>();
		for (const m of Object.values(menus)) menuViewCodes((m as Obj)?.items, used);
		const targetKey =
			menus[`${code}_menu`] && typeof menus[`${code}_menu`] === "object"
				? `${code}_menu`
				: Object.keys(menus).find((k) => menus[k] && typeof menus[k] === "object" && menus[k].items);
		const added_: string[] = [];
		for (const n of news) {
			if (used.has(n.name)) continue;
			const key = targetKey ?? `${code}_menu`;
			if (!menus[key]) menus[key] = { label: opts.displayName, items: {} };
			if (!menus[key].items || typeof menus[key].items !== "object") menus[key].items = {};
			const items: Obj = menus[key].items;
			let itemKey = n.name;
			while (Object.prototype.hasOwnProperty.call(items, itemKey)) itemKey = `${itemKey}_item`;
			const maxOrder = Math.max(
				0,
				...Object.values(items).map((i) => (typeof (i as Obj)?.orderNum === "number" ? (i as Obj).orderNum : 0)),
			);
			items[itemKey] = { itemType: "V", label: n.label, dataViewCode: n.name, orderNum: maxOrder + 1, icon: "table" };
			added_.push(n.name);
		}
		if (added_.length) {
			files["ui/menus.json"] = jsonText(menus);
			added.push(`ui/menus.json: menu item(s) ${added_.join(", ")} (top level of '${targetKey ?? `${code}_menu`}')`);
		}
	}

	// ── security/roles.json
	const roles = readExisting(root, "security/roles.json");
	if (!roles || Object.keys(roles).length === 0) {
		files["security/roles.json"] = jsonText(buildRoles({ ...opts, entities: allSpecs }));
		added.push("security/roles.json created");
	} else {
		const adminKey = `${code}.admin`;
		const admin = roles[adminKey];
		if (!admin || typeof admin !== "object") {
			notes.push(
				`security/roles.json has no '${adminKey}' role, so no rights were granted on ${news.map((n) => n.name).join(", ")} — grant them with dforge_role_right_set.`,
			);
		} else {
			if (!admin.rights || typeof admin.rights !== "object") admin.rights = {};
			const added_: string[] = [];
			for (const n of news) {
				if (Object.prototype.hasOwnProperty.call(admin.rights, n.name)) continue;
				admin.rights[n.name] = adminRights;
				added_.push(n.name);
			}
			if (added_.length) {
				files["security/roles.json"] = jsonText(roles);
				added.push(`security/roles.json: ${adminKey} ${adminRights} on ${added_.join(", ")}`);
			}
		}
	}

	return { files, added, notes };
}

/** The standard sentence appended to additive results. */
export function additiveNotice(m: UiMergeResult, otherFiles: string[]): string {
	const lines = [
		`Additive update — ADDED: ${[...otherFiles, ...m.added].join("; ")}.`,
		"Nothing existing was overwritten: roles, rights on actions/reports, custom views, child folders, " +
			"menu sections and every other entry already on disk were preserved.",
	];
	if (m.notes.length) lines.push(...m.notes);
	return lines.join("\n");
}

/**
 * Read an existing module, return the file map for the files that change (new
 * entity + patched manifest + additively patched UI/security JSONs).
 *
 * The MCP client writes only the returned files; everything else on disk
 * stays untouched. UI/security files are MERGED with what is on disk — only the
 * new entity's default view / folder entry / menu leaf / admin right is added.
 */
export function addEntityFiles(args: z.infer<z.ZodObject<typeof addEntitySchema>>): {
	files: Record<string, string>;
	warning?: string;
} {
	const root = path.resolve(args.moduleDir);
	const manifestPath = path.join(root, "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`No manifest.json found at ${manifestPath}`);
	}

	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (!manifest.code) {
		throw new Error("manifest.json has no `code` field — corrupt module?");
	}

	// Refuse if entity already exists. The AI should call create_module or
	// directly edit the entity JSON if it wants to evolve an existing one.
	const newName = args.entity.name;
	if (manifest.entities && manifest.entities[newName]) {
		throw new Error(
			`Entity '${newName}' already exists in this module. ` +
				`Edit entities/${newName}.json directly, or pick a different name.`,
		);
	}

	// Existing entities are only needed to build files that do not exist yet.
	const existingEntities: EntitySpec[] = Object.keys(manifest.entities ?? {}).map((name) => ({
		name,
		label: tryReadEntityLabel(root, name) ?? name,
		traits: "identity+audit",
	}));

	const newEntity: EntitySpec = {
		name: args.entity.name,
		label: args.entity.label,
		// Placeholder preset for the builders (they ignore traits); the real
		// validated trait codes are applied to the entity JSON below.
		traits: "identity",
	};
	const allEntities = [...existingEntities, newEntity];

	const opts: ScaffoldOpts = {
		path: root,
		code: manifest.code,
		displayName: manifest.displayName ?? manifest.code,
		description: manifest.description ?? "",
		author: manifest.author?.name ?? "",
		license: manifest.license ?? "MIT",
		version: manifest.version ?? "0.1.0",
		dbSchemaVersion: manifest.dbSchemaVersion ?? "0.0.1",
		dependencies: Object.keys(manifest.dependencies ?? {}),
		preset: "minimal",
		entities: allEntities,
	};

	// Patched manifest: add the new entity to the entities map, bump updated date.
	const newManifest = {
		...manifest,
		entities: {
			...(manifest.entities ?? {}),
			[newEntity.name]: `./entities/${newEntity.name}.json`,
		},
		updated: new Date().toISOString().slice(0, 10),
	};

	const entityJson = buildEntityStub(newEntity, args.entity.traits, {
		nameField: args.entity.nameField,
		toStringTemplate: args.entity.toStringTemplate,
	});

	const files: Record<string, string> = {};
	files["manifest.json"] = JSON.stringify(newManifest, null, "\t") + "\n";
	files[`entities/${newEntity.name}.json`] = JSON.stringify(entityJson, null, "\t") + "\n";

	const merged = mergeUiAndSecurity(
		root,
		opts,
		[{ name: newEntity.name, label: newEntity.label, entity: entityJson }],
		allEntities,
		args.adminRights,
	);
	Object.assign(files, merged.files);

	const warning = additiveNotice(merged, [
		`manifest.json entity '${newEntity.name}'`,
		`entities/${newEntity.name}.json`,
	]);
	return { files, warning };
}

function tryReadEntityLabel(root: string, name: string): string | undefined {
	try {
		const e = JSON.parse(fs.readFileSync(path.join(root, "entities", `${name}.json`), "utf8"));
		return e.description as string | undefined;
	} catch {
		return undefined;
	}
}
