// tests/*.test.json — module test scenarios run by `dforge-cli module test`.
// Nothing else reads them before the CLI does, so a malformed suite or a
// scenario naming an entity or action that does not exist only surfaces when
// the tests run. Schema violations are errors (the CLI refuses the file);
// references that do not resolve are warnings (the scenario fails when run).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidateContext } from "./context";
import { loadVendoredSchema, validateAgainstSchema } from "./json-schema";

// Keys the vendored schema says a suite does not have yet.
const REFUSED_KEYS = ["fixture", "isolation"] as const;

export function checkTestScenarios(ctx: ValidateContext): void {
	const { paths, err } = ctx;
	const dir = path.join(paths.root, "tests");
	let files: string[];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".test.json"))
			.sort();
	} catch {
		return;
	}
	if (files.length === 0) return;
	const schema = loadVendoredSchema("test-scenario");

	for (const file of files) {
		const where = `tests/${file}`;
		let doc: unknown;
		try {
			doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
		} catch (ex) {
			err(where, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
			err(where, "must be an object with 'describe' and 'tests'.");
			continue;
		}

		// fixture / isolation: refused with a purpose-made message rather than the
		// generic "unexpected property" (the suite runs against data that already
		// exists in the workspace — there is no fixture or isolation yet).
		const forSchema = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
		const stripRefused = (node: Record<string, unknown>, at: string): void => {
			for (const k of REFUSED_KEYS) {
				if (k in node) {
					err(
						`${where}${at}`,
						`uses '${k}', which \`dforge-cli module test\` refuses: a suite has no fixture or isolation yet, ` +
							"so the workspace must already hold the data the scenarios rely on. Remove the key and " +
							"create the records in 'given' or 'do' steps.",
					);
					delete node[k];
				}
			}
		};
		stripRefused(forSchema, "");
		const tests = Array.isArray(forSchema.tests) ? (forSchema.tests as unknown[]) : [];
		tests.forEach((t, i) => {
			if (t && typeof t === "object" && !Array.isArray(t)) stripRefused(t as Record<string, unknown>, ` → tests[${i}]`);
		});

		if (schema) {
			for (const p of validateAgainstSchema(schema, forSchema)) {
				err(`${where}${p.path ? ` → ${p.path}` : ""}`, `${p.message} (test-scenario schema).`);
			}
		}

		checkReferences(ctx, where, doc as Record<string, unknown>);
	}
}

// A suite entry the schema pass already flagged (`do: [42]`, `expect: [false]`) must not crash the
// reference pass: `"insert" in 42` throws, and the whole validation report would be lost.
const asObject = (x: unknown): Record<string, unknown> =>
	x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

function checkReferences(ctx: ValidateContext, where: string, doc: Record<string, unknown>): void {
	const { warn, isKnownEntity, actions, columnsOf, manifest, deps } = ctx;
	const tests = Array.isArray(doc.tests) ? (doc.tests as unknown[]) : [];

	const entityOk = (code: string): boolean => {
		const local = code.startsWith(`${manifest.code}.`) ? code.slice(manifest.code.length + 1) : code;
		return isKnownEntity(local) || isKnownEntity(code);
	};
	const entityRef = (code: unknown, at: string): void => {
		if (typeof code !== "string" || code === "") return;
		if (!entityOk(code)) {
			warn(
				at,
				`names entity '${code}', which is not a known entity of this module (same-module, system, or a declared dependency).`,
			);
		}
	};
	const recordRef = (ref: unknown, at: string): void => {
		if (!ref || typeof ref !== "object" || Array.isArray(ref)) return; // "$name" form
		for (const [entity, cols] of Object.entries(ref as Record<string, unknown>)) {
			entityRef(entity, at);
			columnsRef(entity, cols, at);
		}
	};
	const columnsRef = (entity: unknown, values: unknown, at: string): void => {
		if (typeof entity !== "string" || !values || typeof values !== "object" || Array.isArray(values)) return;
		const cols = columnsOf[entity] ?? columnsOf[entity.replace(`${manifest.code}.`, "")];
		if (!cols) return;
		for (const k of Object.keys(values as Record<string, unknown>)) {
			if (k.startsWith("$")) continue;
			if (!cols.has(k)) warn(at, `sets column '${k}', which is not a column on '${entity}'.`);
		}
	};
	const actionRef = (code: unknown, at: string): void => {
		if (typeof code !== "string" || code === "") return;
		if (code in actions) return;
		const dot = code.indexOf(".");
		if (dot > 0) {
			const mod = code.slice(0, dot);
			if (deps.has(mod) || mod === manifest.code) return;
		}
		warn(at, `calls action '${code}', which is not in ui/actions.json.`);
	};

	tests.forEach((t, i) => {
		if (!t || typeof t !== "object") return;
		const test = t as Record<string, unknown>;
		const base = `${where} → tests[${i}]${typeof test.name === "string" ? ` (${test.name})` : ""}`;
		if (Array.isArray(test.given)) {
			test.given.forEach((g, gi) => {
				const block = asObject(g);
				const at = `${base} → given[${gi}]`;
				entityRef(block.entityCode, at);
				if (Array.isArray(block.records)) block.records.forEach((r) => columnsRef(block.entityCode, r, at));
			});
		}
		if (Array.isArray(test.do)) {
			test.do.forEach((s, si) => {
				const step = asObject(s);
				const at = `${base} → do[${si}]`;
				if ("insert" in step) {
					entityRef(step.insert, at);
					columnsRef(step.insert, step.values, at);
				}
				if ("update" in step) recordRef(step.update, at);
				if ("delete" in step) recordRef(step.delete, at);
				if ("action" in step) {
					actionRef(step.action, at);
					recordRef(step.record, at);
					if (Array.isArray(step.records)) step.records.forEach((r) => recordRef(r, at));
				}
			});
		}
		if (Array.isArray(test.expect)) {
			test.expect.forEach((x, xi) => {
				const exp = asObject(x);
				const at = `${base} → expect[${xi}]`;
				if ("record" in exp) recordRef(exp.record, at);
				if ("count" in exp) entityRef(exp.count, at);
			});
		}
	});
}
