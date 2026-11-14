// dforge_menu_add — insert a leaf or section into ui/menus.json.
//
// Menus were the last UI surface with a reference doc but no tool, so agents
// hand-wrote the JSON and hit the same three documented mistakes every time:
// `viewCode` instead of `dataViewCode`, Bootstrap icons keeping their `bi-`
// prefix (menu icons drop it — action icons keep it), and `itemType` on a
// section node. All three are unrepresentable here.

import { z } from "zod";
import {
	loadManifest,
	readJsonOrDefault,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	walkFolders,
	type ToolResult,
} from "./_helpers";

type Node = Record<string, unknown>;

export const menuAddSchema = {
	moduleDir: z.string().describe("Path to the module root."),
	menu: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Root menu key in ui/menus.json, e.g. 'crm_menu'. Created if it doesn't exist yet."),
	menuLabel: z
		.string()
		.optional()
		.describe("Label for the root menu — only used when the root is being created."),
	parentPath: z
		.string()
		.default("")
		.describe(
			"Slash-separated item codes under the root, e.g. 'lists/archive'. Empty = add directly under the root menu.",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Code of the new item (its key under the parent's items/children)."),
	label: z.string().min(1).describe("Display label."),
	dataViewCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"For a LEAF item: the view code from ui/data_views.json this item opens. Omit to create a SECTION node (a container for children). Note the key is dataViewCode, never viewCode.",
		),
	reportCode: z
		.string()
		.regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/)
		.optional()
		.describe(
			"For a LEAF item that opens a REPORT: the report code from ui/reports.json (emitted as itemType 'R' + reportCode). Mutually exclusive with dataViewCode. Omit both to create a SECTION node.",
		),
	folders: z
		.array(z.string())
		.optional()
		.describe(
			"Restricts the ROOT menu to these folder codes (the schema's menu-level `folders`; flat codes: module code for the root folder, '<module>_<nested_segments>' for children). Applied to the root menu named by `menu` (set on creation, or replaced if the root exists). Omit to link the menu to every folder. Each code must resolve against ui/folders.json — an unknown code fails the install.",
		),
	icon: z
		.string()
		.optional()
		.describe(
			"Bootstrap icon name. A leading 'bi-' is STRIPPED — menu icons are bare names ('list-ul'), unlike action icons which keep the prefix.",
		),
	orderNum: z
		.number()
		.int()
		.optional()
		.describe("Sort position among siblings. Default: appended after the current highest."),
};

/**
 * Flat folder codes a menu's `folders` may name: the module code (root), the
 * module code + '_' + each nesting path with '/' → '_', the full and the
 * module-relative path, and a folder's own key when unique in the tree.
 */
function knownFolderCodes(foldersPath: string, moduleCode: string): Set<string> {
	const out = new Set<string>([moduleCode]);
	const root = readJsonOrDefault<Record<string, unknown>>(foldersPath, {});
	const all = walkFolders(root);
	const keyCount = new Map<string, number>();
	for (const f of all) keyCount.set(f.code, (keyCount.get(f.code) ?? 0) + 1);
	for (const f of all) {
		out.add(`${moduleCode}_${f.path.replace(/\//g, "_")}`);
		out.add(`${moduleCode}/${f.path}`);
		out.add(f.path);
		if (keyCount.get(f.code) === 1) out.add(f.code);
	}
	return out;
}

/** Child map of a node: the root uses `items`, nested nodes use `children`. */
function childKey(node: Node, isRoot: boolean): "items" | "children" {
	if (isRoot) return "items";
	return Object.prototype.hasOwnProperty.call(node, "items") ? "items" : "children";
}

function nextOrder(children: Record<string, Node>): number {
	let max = 0;
	for (const c of Object.values(children)) {
		const n = typeof c?.orderNum === "number" ? c.orderNum : 0;
		if (n > max) max = n;
	}
	return max + 1;
}

export function menuAdd(args: z.infer<z.ZodObject<typeof menuAddSchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const menus = readJsonOrDefault<Record<string, Node>>(paths.menus, {});

	if (args.dataViewCode && args.reportCode) {
		throw new Error("Pass dataViewCode OR reportCode, not both — a menu leaf opens either a view or a report.");
	}
	if (args.reportCode && !args.reportCode.includes(".")) {
		const reports = readJsonOrDefault<Record<string, unknown>>(paths.reports, {});
		if (!Object.prototype.hasOwnProperty.call(reports, args.reportCode)) {
			throw new Error(
				`reportCode '${args.reportCode}' has no matching report in ui/reports.json. ` +
					`Existing reports: ${Object.keys(reports).join(", ") || "(none)"}. Add the report first with dforge_report_add.`,
			);
		}
	}
	if (args.folders) {
		const known = knownFolderCodes(paths.folders, manifest.code);
		const bad = args.folders.filter((f) => !known.has(f));
		if (bad.length > 0) {
			throw new Error(
				`folders [${bad.join(", ")}] match no folder in ui/folders.json (an unknown code fails the install). ` +
					`Resolvable codes: ${[...known].sort().join(", ")}.`,
			);
		}
	}

	// A leaf must point at a view that exists — a dangling dataViewCode renders
	// a dead menu entry and is flagged by dforge_module_validate anyway.
	if (args.dataViewCode) {
		const views = readJsonOrDefault<Record<string, unknown>>(paths.dataViews, {});
		if (!Object.prototype.hasOwnProperty.call(views, args.dataViewCode)) {
			throw new Error(
				`dataViewCode '${args.dataViewCode}' has no matching view in ui/data_views.json. ` +
					`Existing views: ${Object.keys(views).join(", ") || "(none)"}. Add the view first with dforge_view_add.`,
			);
		}
	}

	let root = menus[args.menu];
	if (!root) {
		root = { label: args.menuLabel ?? manifest.displayName, items: {} };
		menus[args.menu] = root;
	}

	if (args.folders) {
		root.folders = [...args.folders];
	}

	// Walk parentPath down from the root.
	let cursor: Node = root;
	let isRoot = true;
	const segments = args.parentPath.split("/").filter(Boolean);
	const walked: string[] = [];
	for (const seg of segments) {
		const key = childKey(cursor, isRoot);
		const children = (cursor[key] as Record<string, Node> | undefined) ?? {};
		if (!children[seg]) {
			throw new Error(
				`Menu path segment '${seg}' not found under '${walked.join("/") || args.menu}'. ` +
					`Available: ${Object.keys(children).join(", ") || "(none)"}.`,
			);
		}
		cursor = children[seg];
		walked.push(seg);
		isRoot = false;
	}

	// A leaf can't have children hung off it.
	if (!isRoot && (cursor.dataViewCode || cursor.reportCode)) {
		throw new Error(
			`'${walked.join("/")}' is a leaf item (it has a dataViewCode or reportCode) — it can't contain children. ` +
				"Nest under a section node instead (a node with no dataViewCode).",
		);
	}

	const key = childKey(cursor, isRoot);
	const children = (cursor[key] as Record<string, Node> | undefined) ?? {};
	if (children[args.code]) {
		throw new Error(
			`Menu item '${args.code}' already exists under '${walked.join("/") || args.menu}'.`,
		);
	}

	const node: Node = { label: args.label, orderNum: args.orderNum ?? nextOrder(children) };
	if (args.icon) {
		// Menu icons are BARE Bootstrap names — the bi- prefix belongs to action
		// icons only. Strip it rather than rejecting, so either input works.
		node.icon = args.icon.replace(/^bi-/, "");
	}
	if (args.dataViewCode) {
		// Leaf: itemType 'V' + the view it opens. Section nodes OMIT itemType.
		node.itemType = "V";
		node.dataViewCode = args.dataViewCode;
	} else if (args.reportCode) {
		// Report leaf: itemType 'R' + the report it opens.
		node.itemType = "R";
		node.reportCode = args.reportCode;
	} else {
		node.children = {};
	}

	children[args.code] = node;
	cursor[key] = children;

	const kind = args.dataViewCode
		? `leaf → view '${args.dataViewCode}'`
		: args.reportCode
			? `leaf → report '${args.reportCode}'`
			: "section";
	return makeResult(
		`Added menu ${kind} '${args.code}' under '${args.menu}${walked.length ? "/" + walked.join("/") : ""}'.`,
		{
			[rel(paths.root, paths.menus)]: jsonText(menus),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}
