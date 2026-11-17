// Write guard: a patch tool must never emit a file that the vendored JSON
// schema rejects. The same schemas drive the editor's red squiggles, and
// `dforge-cli module validate/pack` do NOT check them, so a tool that emitted a
// field without `orderNum` produced hundreds of editor errors that nothing
// stopped.
//
// Only problems the call INTRODUCES are refused — findings already present in
// the file on disk are left alone, so a repair call on an old, imperfect module
// still goes through. manifest.json is advisory (a warning): the vendored
// manifest schema is known to lag the platform (shortDescription, security).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolResult } from "./_helpers";
import { loadVendoredSchema, validateAgainstSchema } from "./validate/json-schema";
import { schemaNameForFile } from "./validate/schemas";

const ADVISORY = new Set(["manifest.json"]);

const key = (p: { path: string; message: string }) => `${p.path}\u0000${p.message}`;

function problemsOf(schemaName: string, text: string): Array<{ path: string; message: string }> | undefined {
	const schema = loadVendoredSchema(schemaName);
	if (!schema) return undefined;
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (e) {
		// Unparseable output is a violation, not "no schema": returning undefined here let a
		// malformed file skip the guard and be written.
		return [{ path: "", message: `is not valid JSON: ${(e as Error).message}` }];
	}
	return validateAgainstSchema(schema, doc);
}

export function guardSchemas(moduleDir: string | undefined, result: ToolResult): ToolResult {
	const refused: string[] = [];
	const advisory: string[] = [];
	for (const [rel, content] of Object.entries(result.files ?? {})) {
		if (typeof content !== "string") continue;
		const name = schemaNameForFile(rel);
		if (!name) continue;
		const after = problemsOf(name, content);
		if (!after || after.length === 0) continue;
		let before = new Set<string>();
		if (moduleDir) {
			try {
				const prev = problemsOf(name, fs.readFileSync(path.join(moduleDir, rel), "utf8"));
				before = new Set((prev ?? []).map(key));
			} catch {
				// new file: everything counts
			}
		}
		const added = after.filter((p) => !before.has(key(p)));
		if (added.length === 0) continue;
		const shown = added.slice(0, 5).map((p) => `${p.path || "/"}: ${p.message}`);
		const line = `${rel} (${name} schema, ${added.length} new): ${shown.join("; ")}${added.length > shown.length ? `; +${added.length - shown.length} more` : ""}`;
		(ADVISORY.has(rel) ? advisory : refused).push(line);
	}
	if (refused.length > 0) {
		throw new Error(
			`Refused: this call would write file(s) that violate the module schemas (the editor flags them as errors). Nothing was written.\n- ${refused.join("\n- ")}\nFix the arguments, or hand-edit the file if the schema is known to be behind the platform.`,
		);
	}
	if (advisory.length === 0) return result;
	const note = `Schema notes (advisory, not blocking): ${advisory.join("; ")}`;
	return { ...result, warning: result.warning ? `${result.warning}\n${note}` : note };
}
