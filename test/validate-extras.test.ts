// Additions to dforge_module_validate: summary format, tests/*.test.json,
// scaffold leftovers, dependency contracts, menu/folder coverage, the folder:
// rights key, vendored-schema pass, and the library-function names handed to
// the DSL checker.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const seen: Array<Record<string, unknown>> = [];
vi.mock("@dforge-core/metadata/dsl", async () => {
	const actual = await vi.importActual<typeof import("@dforge-core/metadata/dsl")>("@dforge-core/metadata/dsl");
	return {
		...actual,
		checkDsl: (src: string, ctx: Record<string, unknown>) => {
			seen.push(ctx);
			return actual.checkDsl(src, ctx as never);
		},
	};
});

import { moduleValidate } from "../src/tools/module-validate";
import { readLibraryFunctions } from "../src/tools/dsl-check";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ENTITY = {
	description: "Thing",
	toString: "{name}",
	traits: ["identity"],
	fields: { name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" } },
};

function make(files: Record<string, unknown>, manifest: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-extras-"));
	dirs.push(dir);
	const all: Record<string, unknown> = {
		"manifest.json": { code: "t", entities: { thing: "./entities/thing.json" }, ...manifest },
		"entities/thing.json": ENTITY,
		...files,
	};
	for (const [rel, body] of Object.entries(all)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
	}
	return dir;
}
const run = (dir: string, format?: "full" | "summary") =>
	JSON.parse(moduleValidate({ moduleDir: dir, format }).files["_validate.json"]);
const msgs = (list: Array<{ where: string; message: string }>) => list.map((i) => `${i.where}: ${i.message}`).join("\n");

describe("format: summary", () => {
	it("groups repeated warnings with a count and 3 examples, keeps counts in the summary line", () => {
		const entities: Record<string, string> = {};
		const files: Record<string, unknown> = {};
		for (let i = 0; i < 12; i++) {
			entities[`e${i}`] = `./entities/e${i}.json`;
			files[`entities/e${i}.json`] = { ...ENTITY, toString: undefined };
		}
		const dir = make(files, { entities });
		const res = moduleValidate({ moduleDir: dir, format: "summary" });
		expect(res.summary).toMatch(/0 error\(s\), \d+ warning\(s\)/);
		const j = JSON.parse(res.files["_validate.json"]);
		const g = j.warnings.find((w: { rule: string }) => w.rule.includes("template"));
		expect(g.count).toBe(12);
		expect(g.examples).toHaveLength(3);
		expect(res.files["_validate.json"].length).toBeLessThan(JSON.stringify(run(dir)).length);
		const full = JSON.parse(readFileSync(j.fullReport, "utf8"));
		expect(full.warnings.length).toBeGreaterThanOrEqual(12);
	});

	it("default format stays the flat list", () => {
		const j = run(make({}));
		expect(Array.isArray(j.errors)).toBe(true);
		expect(j.format).toBeUndefined();
	});
});

describe("tests/*.test.json", () => {
	const suite = (extra: Record<string, unknown> = {}, test: Record<string, unknown> = {}) => ({
		describe: "s",
		...extra,
		tests: [
			{
				name: "t1",
				do: [{ insert: "thing", values: { name: "a" } }],
				expect: [{ count: "thing", equals: 1 }],
				...test,
			},
		],
	});

	it("accepts a valid suite", () => {
		const j = run(make({ "tests/a.test.json": suite() }));
		expect(msgs(j.errors)).toBe("");
	});

	it("errors on schema violations (missing describe, unknown step, as != admin)", () => {
		const j = run(
			make({
				"tests/a.test.json": { tests: [{ name: "x", as: "bob", do: [{ frobnicate: 1 }] }] },
			}),
		);
		const text = msgs(j.errors);
		expect(text).toContain("missing required property 'describe'");
		expect(text).toContain("tests/a.test.json → tests[0].as");
		expect(text).toContain("tests[0].do[0]");
	});

	it("flags fixture / isolation as refused", () => {
		const j = run(make({ "tests/a.test.json": suite({ fixture: { users: [] } }, { isolation: "tx" }) }));
		const text = msgs(j.errors);
		expect(text).toMatch(/uses 'fixture'/);
		expect(text).toMatch(/uses 'isolation'/);
	});

	it("warns on unknown entity, action and column", () => {
		const j = run(
			make({
				"tests/a.test.json": suite(
					{},
					{
						given: [{ entityCode: "ghost", records: [{}] }],
						do: [{ action: "nope", record: { thing: { name: "a" } } }, { insert: "thing", values: { colx: 1 } }],
					},
				),
			}),
		);
		const text = msgs(j.warnings);
		expect(text).toContain("entity 'ghost'");
		expect(text).toContain("action 'nope'");
		expect(text).toContain("column 'colx'");
	});
});

describe("scaffold leftovers", () => {
	it("warns on an empty seed file and a view with columns: []", () => {
		const j = run(
			make({
				"seed-data/a.json": { entityCode: "", records: [] },
				"ui/data_views.json": { v: { dataSources: [{ entityCode: "thing", columns: [] }] } },
			}),
		);
		const text = msgs(j.warnings);
		expect(text).toContain("seed-data/a.json: has an empty 'entityCode'");
		expect(text).toContain("seed-data/a.json: has no records");
		expect(text).toContain('"columns": []');
	});
});

describe("dependency contracts", () => {
	it("errors on a dependency with no deps/<code>.json, naming dforge_dependency_add", () => {
		const j = run(make({}, { dependencies: { crm: ">=1.0.0" } }));
		expect(msgs(j.errors)).toContain("deps/crm.json");
		expect(msgs(j.errors)).toContain("dforge_dependency_add");
	});
	it("does not require one for a system module", () => {
		expect(msgs(run(make({}, { dependencies: { metadata: ">=1.0.0" } })).errors)).not.toContain("deps/metadata.json");
	});
});

describe("role rights: folder: prefix", () => {
	it("is reported early, without claiming a supported alternative", () => {
		const j = run(make({ "security/roles.json": { r: { rights: { thing: "S", "folder:main": "E" } } } }));
		const w = j.warnings.find((x: { message: string }) => x.message.includes("folder:main"));
		expect(w.message).toContain("rejects the 'folder:' prefix");
		expect(w.message).toContain("does not define one");
	});
});

describe("menu / folder coverage", () => {
	const two = {
		"manifest.json": { code: "t", entities: { a: "./entities/a.json", b: "./entities/b.json" } },
		"entities/a.json": ENTITY,
		"entities/b.json": ENTITY,
		"ui/data_views.json": {
			va: { dataSources: [{ entityCode: "a" }] },
			vb: { dataSources: [{ entityCode: "b" }] },
		},
		"ui/folders.json": {
			label: "T",
			children: { fa: { entities: { a: {} } }, fb: { entities: { b: {} } } },
		},
	};
	const menu = (extra: Record<string, unknown> = {}) => ({
		m: {
			label: "M",
			...extra,
			items: {
				ia: { label: "A", itemType: "V", dataViewCode: "va" },
				ib: { label: "B", itemType: "V", dataViewCode: "vb" },
			},
		},
	});

	it("reports one grouped warning per folder with both fixes", () => {
		const dir = make({ ...two, "ui/menus.json": menu() }, two["manifest.json"] as never);
		const j = run(dir);
		const w = j.warnings.filter((x: { where: string }) => x.where.startsWith("ui/folders.json"));
		expect(w).toHaveLength(2);
		expect(w[0].message).toContain("menu 'm' needs");
		expect(w[0].message).toContain('"folders"');
		expect(w[0].message).toContain("add the entity to this folder");
	});

	it("is satisfied when the menu is restricted with `folders`... only if it covers the folder", () => {
		// restricting to fa alone still leaves 'b' (item ib) missing there
		const j = run(make({ ...two, "ui/menus.json": menu({ folders: ["fa"] }) }, two["manifest.json"] as never));
		const w = j.warnings.filter((x: { where: string }) => x.where.startsWith("ui/folders.json"));
		expect(w).toHaveLength(1);
		expect(w[0].where).toContain("t_fa");
	});

	it("flags a menu `folders` entry that matches no folder", () => {
		const j = run(make({ ...two, "ui/menus.json": menu({ folders: ["zzz"] }) }, two["manifest.json"] as never));
		expect(msgs(j.warnings)).toContain("'zzz', which matches no folder");
	});
});

describe("vendored JSON-schema pass", () => {
	it("reports numberSequence without defaultPrefix and a bad baseDatatypeCd", () => {
		const j = run(
			make({
				"entities/thing.json": {
					...ENTITY,
					numberSequence: { column: "name", pattern: "X-{seq:3}" },
					fields: {
						...ENTITY.fields,
						total: { columnType: "F", fieldTypeCd: "text", baseDatatypeCd: "text", formula: "1", flags: "V" },
						made: { columnType: "F", fieldTypeCd: "text", baseDatatypeCd: "datetime", formula: "1", flags: "V" },
					},
				},
			}),
		);
		const text = msgs(j.warnings);
		expect(text).toContain("entities/thing.json → numberSequence: is missing required property 'defaultPrefix'");
		expect(text).toContain("fields.total.baseDatatypeCd");
		expect(text).toContain("fields.made.baseDatatypeCd");
	});

	it("reports nested translation menu items and a report description", () => {
		const j = run(
			make(
				{
					"translations/ru-RU.json": {
						menus: { m: { label: "М", items: { section: { label: "С", items: { leaf: { label: "Л" } } } } } },
						reports: { r: { label: "Р", description: "описание" } },
					},
				},
				{ supportedLocales: ["en-US", "ru-RU"] },
			),
		);
		const text = msgs(j.warnings);
		expect(text).toContain("translations/ru-RU.json → menus.m.items.section: has unexpected property 'items'");
		expect(text).toContain("translations/ru-RU.json → reports.r: has unexpected property 'description'");
	});

	it("keeps schema findings out of `errors` (the CLI is the authority on install)", () => {
		const j = run(make({ "entities/thing.json": { ...ENTITY, numberSequence: { column: "name" } } }));
		expect(msgs(j.errors)).not.toContain("defaultPrefix");
	});
});

describe("library functions are collected and passed to the DSL checker", () => {
	it("reads top-level function names from logic/functions/*.dsl", () => {
		const dir = make({
			"logic/functions/lib.dsl": "// helpers\nfunction addMonths(d, n) {\n\treturn d\n}\n\nfunction daysSince(ts) {\n\treturn 1\n}\n  function nested() {}\n",
		});
		expect(readLibraryFunctions(join(dir, "logic"))).toEqual(["addMonths", "daysSince"]);
	});

	it("hands them to checkDsl as libraryFunctions (the installed package ignores the field today)", () => {
		const dir = make({
			"ui/actions.json": { go: { entityCode: "thing", executionMode: "single", script: "go" } },
			"logic/actions/go.dsl": "execute:\n\tvar x = addMonths(now(), 1)\n",
			"logic/functions/lib.dsl": "function addMonths(d, n) {\n\treturn d\n}\n",
		});
		seen.length = 0;
		run(dir);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.some((c) => Array.isArray(c.libraryFunctions) && (c.libraryFunctions as string[]).includes("addMonths"))).toBe(true);
	});
});

describe("menu nesting hint", () => {
	it("tells the author to use `children` for nested sections", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { loadContext } = await import("../src/tools/validate/context");
		const { checkJsonSchemas } = await import("../src/tools/validate/schemas");
		const dir = mkdtempSync(join(tmpdir(), "dforge-menu-hint-"));
		try {
			mkdirSync(join(dir, "ui"), { recursive: true });
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ packageFormat: 1, code: "m", version: "1.0.0", displayName: "M", entities: {} }));
			writeFileSync(
				join(dir, "ui/menus.json"),
				JSON.stringify({ m_menu: { label: "M", items: { sec: { label: "S", orderNum: 1, items: { a: { itemType: "V", label: "A", dataViewCode: "a", orderNum: 1 } } } } } }),
			);
			const ctx = loadContext(dir);
			checkJsonSchemas(ctx);
			const hit = ctx.issues.find((i) => i.where.startsWith("ui/menus.json"));
			expect(hit?.message).toMatch(/nests its entries under `children`/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
