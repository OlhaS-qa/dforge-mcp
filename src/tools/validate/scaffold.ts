// Leftovers of an unfinished scaffold, and dependency contracts. Each passes
// every cross-reference check yet is a dead or install-blocking file.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidateContext } from "./context";

// Seed / demo data files with no entity or no records do nothing: the empty
// stubs `module_create` leaves behind, or a file whose entity was renamed away.
export function checkEmptySeedData(ctx: ValidateContext): void {
	const { paths, warn } = ctx;
	for (const dirName of ["seed-data", "demo-data"]) {
		const dir = dirName === "seed-data" ? paths.seedDataDir : path.join(paths.root, dirName);
		let files: string[];
		try {
			files = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort();
		} catch {
			continue;
		}
		for (const f of files) {
			const where = `${dirName}/${f}`;
			let doc: Record<string, unknown>;
			try {
				doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			} catch {
				continue;
			}
			if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
			if (typeof doc.entityCode !== "string" || doc.entityCode.trim() === "") {
				warn(
					where,
					"has an empty 'entityCode' — the file targets no entity and seeds nothing. Set the entity code, or delete the file.",
				);
			}
			if (Array.isArray(doc.records) && doc.records.length === 0) {
				warn(where, "has no records — an empty scaffold stub. Add records, or delete the file.");
			}
		}
	}
}

// A data view source with `columns: []` renders nothing useful.
export function checkEmptyViewColumns(ctx: ValidateContext): void {
	const { warn, views } = ctx;
	for (const [vcode, v] of Object.entries(views)) {
		const sources = (v.dataSources as Array<Record<string, unknown>> | undefined) ?? [];
		for (const s of sources) {
			if (Array.isArray(s.columns) && s.columns.length === 0) {
				warn(
					`data_views → ${vcode}`,
					`dataSource '${String(s.entityCode ?? "?")}' has an empty "columns": [] — a scaffold leftover. List the columns to show, or omit 'columns' to use the entity's visible ones.`,
				);
			}
		}
	}
}

const SYSTEM_MODULES = new Set(["admin", "metadata", "workspace", "sys-billing"]);

// Every manifest dependency needs deps/<code>.json (its consumption contract);
// install is blocked without it.
export function checkDependencyContracts(ctx: ValidateContext): void {
	const { paths, manifest, err } = ctx;
	for (const dep of Object.keys(manifest.dependencies ?? {})) {
		// A system module's contract is only a platform-version gate (deps schema); not required.
		if (SYSTEM_MODULES.has(dep)) continue;
		if (!fs.existsSync(path.join(paths.root, "deps", `${dep}.json`))) {
			err(
				`manifest.dependencies.${dep}`,
				`has no dependency contract deps/${dep}.json — install is blocked ('dependency contracts' check). ` +
					`Add one with dforge_dependency_add (module: '${dep}').`,
			);
		}
	}
}
