// Full JSON-schema pass: every module JSON file against its vendored schema
// (resources/schemas/*.schema.json, the same ones the editor extension checks).
//
// Findings are WARNINGS, not errors: `dforge-cli module validate` and install
// are the authority on what the platform refuses, and a vendored schema can be
// ahead of (or behind) the installed platform. Treating a schema finding as an
// error would block a pack on a module that installs. They are still worth
// fixing: the editor shows each one as an error. tests/*.test.json are the
// exception — see ./scenarios.ts, where the CLI itself refuses the file.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidateContext } from "./context";
import { loadVendoredSchema, validateAgainstSchema } from "./json-schema";

/** Single-file mappings: module-root-relative path → schema name. */
const FILE_SCHEMAS: Array<[string, string]> = [
	["manifest.json", "manifest"],
	["ui/data_views.json", "data-views"],
	["ui/folders.json", "folders"],
	["ui/menus.json", "menus"],
	["ui/reports.json", "reports"],
	["ui/print_templates.json", "print-templates"],
	["ui/export_templates.json", "export-templates"],
	["security/roles.json", "roles"],
	["logic/jobs.json", "jobs"],
	["logic/triggers.json", "triggers"],
	["logic/webhooks.json", "webhooks"],
	["logic/stored_procedures.json", "stored-procedures"],
	["settings.json", "settings"],
	["domains.json", "domains"],
	["traits.json", "traits"],
	["registers.json", "registers"],
];

/** Directory mappings: every *.json inside → schema name. */
const DIR_SCHEMAS: Array<[string, string]> = [
	["entities", "entity"],
	["translations", "translations"],
	["seed-data", "seed-data"],
	["demo-data", "seed-data"],
	["deps", "deps"],
];

/** Schema that governs a module-root-relative file, if any (shared with the write guard). */
export function schemaNameForFile(rel: string): string | undefined {
	const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
	const single = FILE_SCHEMAS.find(([f]) => f === norm);
	if (single) return single[1];
	const i = norm.lastIndexOf("/");
	if (i < 0) return undefined;
	const dir = norm.slice(0, i);
	return norm.endsWith(".json") ? DIR_SCHEMAS.find(([d]) => d === dir)?.[1] : undefined;
}

/** A pointed fix for findings agents keep making; empty when there is none. */
function hintFor(schemaName: string, p: { path: string; message: string }): string {
	// Only the ROOT menu key has `items`; a nested section node nests under `children`.
	if (
		schemaName === "menus" &&
		/unexpected property 'items'/.test(p.message) &&
		p.path.split(/[./]/).filter(Boolean).length > 2
	) {
		return (
			" Hint: a section node inside a menu nests its entries under `children`, not `items` (only the root " +
			"menu key has `items`) — rename it, or add the entries with dforge_menu_add parentPath."
		);
	}
	return "";
}

/** Stable rule id for a schema finding: keyword + the property it concerns, never the instance values. */
function schemaRuleId(schemaName: string, p: { path: string; message: string }): string {
	const m = p.message;
	const last =
		p.path
			.split(/[.\[]/)
			.filter((x) => x && !/^\d+\]?$/.test(x))
			.pop() ?? "";
	let keyword: string;
	const req = /missing required property '([^']+)'/.exec(m);
	const extra = /unexpected property '([^']+)'/.exec(m);
	if (req) keyword = `required:${req[1]}`;
	else if (extra) keyword = `unexpected:${extra[1]}`;
	else if (/^must be one of/.test(m)) keyword = `enum@${last}`;
	else if (/^must be /.test(m)) keyword = `type-or-const@${last}`;
	else if (/does not match pattern/.test(m)) keyword = `pattern@${last}`;
	else if (/allowed forms/.test(m)) keyword = `oneOf@${last}`;
	else keyword = `other@${last}`;
	return `schema:${schemaName}:${keyword}`;
}

export function checkJsonSchemas(ctx: ValidateContext): void {
	const { paths, warn } = ctx;
	const cache = new Map<string, ReturnType<typeof loadVendoredSchema>>();
	const schemaFor = (name: string) => {
		if (!cache.has(name)) cache.set(name, loadVendoredSchema(name));
		return cache.get(name);
	};

	const check = (rel: string, schemaName: string): void => {
		const abs = path.join(paths.root, rel);
		const schema = schemaFor(schemaName);
		if (!schema || !fs.existsSync(abs)) return;
		let doc: unknown;
		try {
			doc = JSON.parse(fs.readFileSync(abs, "utf8"));
		} catch (e) {
			// Not every mapped file has another checker that reports broken JSON (a deps/<m>.json
			// is only tested for existence), so say it here; a duplicate beats a silent pass.
			warn(rel, `is not valid JSON: ${(e as Error).message}`, "schema:invalid-json");
			return;
		}
		for (const p of validateAgainstSchema(schema, doc)) {
			warn(
				`${rel}${p.path ? ` → ${p.path}` : ""}`,
				`${p.message} (${schemaName} schema).${hintFor(schemaName, p)}`,
				schemaRuleId(schemaName, p),
			);
		}
	};

	for (const [rel, name] of FILE_SCHEMAS) check(rel, name);
	for (const [dir, name] of DIR_SCHEMAS) {
		let files: string[];
		try {
			files = fs
				.readdirSync(path.join(paths.root, dir))
				.filter((f) => f.endsWith(".json"))
				.sort();
		} catch {
			continue;
		}
		for (const f of files) check(`${dir}/${f}`, name);
	}
}
