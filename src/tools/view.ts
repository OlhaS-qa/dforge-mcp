// View add + modify. Patches ui/data_views.json — a map of viewCode →
// dataView. The dataView object is passed through verbatim; this tool
// doesn't validate viewType-specific config (the schema does, and the
// install-time validator catches anything missed).

import { z } from "zod";
import * as fs from "node:fs";
import {
	loadManifest,
	readJson,
	readLocalTraits,
	expandedEntity,
	localEntityCode,
	type Manifest,
	type ModulePaths,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
	entityFilePath,
} from "./_helpers";

const EMPTY_ENTITY_CODE = "dataSources[].entityCode must not be empty";

const dataSourceSchema = z
	.object({
		entityCode: z.string().refine((v) => v.trim().length > 0, EMPTY_ENTITY_CODE),
		level: z.number().int().min(0).optional(),
		label: z.string().optional(),
		columns: z.array(z.unknown()).optional(),
		filter: z.unknown().optional(),
		order: z.unknown().optional(),
		parentSetField: z.string().optional(),
	})
	.passthrough();

const dataViewSchema = z
	.object({
		viewType: z.enum([
			"grid",
			"list",
			"kanban",
			"calendar",
			"gallery",
			"tree-grid",
			"diagram",
			"master-detail",
			"library",
			"matrix",
		]),
		label: z.string().optional(),
		description: z.string().optional(),
		icon: z.string().optional(),
		dataSources: z.array(dataSourceSchema).min(1),
		filter: z.unknown().optional(),
		order: z.unknown().optional(),
		viewConfig: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

type DataView = z.infer<typeof dataViewSchema>;

/**
 * Guard + default-column fill shared by view_add / view_modify.
 *
 * - An empty `entityCode` is rejected (it points at nothing).
 * - A grid source with `columns: []` renders the runtime empty state, so when
 *   the entity is local and readable the columns are filled with its visible
 *   scalar columns (flags contain V, columnType not S, orderNum order — the
 *   same set the view would fall back to with no `columns` at all). When they
 *   can't be derived, a warning is returned instead.
 */
function prepareView(paths: ModulePaths, manifest: Manifest, view: DataView): { view: DataView; warnings: string[] } {
	const warnings: string[] = [];
	const sources = view.dataSources.map((ds) => {
		if (!ds.entityCode || !ds.entityCode.trim()) {
			throw new Error(EMPTY_ENTITY_CODE);
		}
		if (view.viewType !== "grid" || !Array.isArray(ds.columns) || ds.columns.length > 0) return ds;
		const cols = defaultColumns(paths, manifest, ds.entityCode);
		if (cols && cols.length > 0) return { ...ds, columns: cols };
		warnings.push(
			`dataSources entity '${ds.entityCode}' has \`columns: []\`, which renders the empty state ` +
				"'No visible columns configured' — and its visible columns could not be derived here. " +
				"Name the columns, or omit `columns` so the entity's V-flag columns apply.",
		);
		return ds;
	});
	return { view: { ...view, dataSources: sources }, warnings };
}

function defaultColumns(paths: ModulePaths, manifest: Manifest, entityCode: string): string[] | undefined {
	const local = localEntityCode(entityCode, manifest.code);
	const relPath = local ? (manifest.entities ?? {})[local] : undefined;
	if (!local || !relPath) return undefined;
	const abs = entityFilePath(paths.root, relPath);
	if (!fs.existsSync(abs)) return undefined;
	try {
		const { traits: localTraits, error } = readLocalTraits(paths.root);
		if (error) return undefined;
		const { fieldDefs } = expandedEntity(readJson<Record<string, unknown>>(abs), local, localTraits);
		return Object.entries(fieldDefs)
			.filter(([, f]) => typeof f?.flags === "string" && f.flags.includes("V") && f.columnType !== "S")
			.sort((a, b) => Number(a[1].orderNum ?? 0) - Number(b[1].orderNum ?? 0))
			.map(([name]) => name);
	} catch {
		return undefined;
	}
}

// ── add ─────────────────────────────────────────────────────────────

export const viewAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("View code (keys ui/data_views.json + URL slug)."),
	view: dataViewSchema,
};

export function viewAdd(args: z.infer<z.ZodObject<typeof viewAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
	if (Object.prototype.hasOwnProperty.call(views, args.code)) {
		throw new Error(`View '${args.code}' already exists in ui/data_views.json. Use view_modify to change it.`);
	}
	const { view, warnings } = prepareView(paths, manifest, args.view);
	views[args.code] = view;
	return makeResult(
		`Added ${view.viewType} view '${args.code}' over [${view.dataSources.map((d) => d.entityCode).join(", ")}].`,
		{
			[rel(paths.root, paths.dataViews)]: jsonText(views),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length > 0 ? warnings.join("\n") : undefined,
	);
}

// ── modify ──────────────────────────────────────────────────────────

export const viewModifySchema = {
	moduleDir: z.string(),
	code: z.string().regex(/^[a-z][a-z0-9_]*$/),
	view: dataViewSchema.describe("Replacement view spec — full shape, not a partial patch."),
};

export function viewModify(args: z.infer<z.ZodObject<typeof viewModifySchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
	if (!Object.prototype.hasOwnProperty.call(views, args.code)) {
		throw new Error(`View '${args.code}' not found. Use view_add to create it.`);
	}
	const { view, warnings } = prepareView(paths, manifest, args.view);
	views[args.code] = view;
	return makeResult(
		`Modified view '${args.code}'.`,
		{
			[rel(paths.root, paths.dataViews)]: jsonText(views),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		warnings.length > 0 ? warnings.join("\n") : undefined,
	);
}
