// Round 3: envelope strips `apply`, folder_modify, change-iteration statements,
// adminRights, check-constraint syntax, validate full vs summary parity.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { applyInput } from "../src/tools/apply";

import { envelope } from "../src/tools/envelope";
import { entityConfigure, entityConfigureSchema, manifestSet, manifestSetSchema } from "../src/tools/configure";
import { actionAdd, actionAddSchema } from "../src/tools/action-add";
import { menuAdd, menuAddSchema } from "../src/tools/menu";
import { folderModify, folderModifySchema } from "../src/tools/adds";
import { addEntityFiles, addEntitySchema } from "../src/tools/add-entity";
import { moduleImport, dbmlImport } from "../src/tools/import";
import { planModule } from "../src/tools/plan-module";
import { moduleValidate } from "../src/tools/module-validate";
import { checkDsl } from "../src/tools/dsl-check";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function make(extra: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "dforge-r3-"));
	dirs.push(dir);
	const all: Record<string, unknown> = {
		"manifest.json": {
			packageFormat: 1,
			moduleId: "00000000-0000-0000-0000-000000000001",
			code: "shop",
			version: "1.0.0",
			dbSchemaVersion: "1.0.0",
			displayName: "Shop",
			entities: { order: "./entities/order.json", item: "./entities/item.json" },
		},
		"entities/order.json": {
			description: "Orders",
			toString: "{number}",
			traits: ["identity"],
			fields: {
				number: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", orderNum: 10 },
				quantity: { dbDatatype: "numeric", fieldTypeCd: "number", flags: "VE", orderNum: 20 },
			},
			views: { slim: { columns: ["number"] } },
		},
		"entities/item.json": {
			description: "Items",
			toString: "{name}",
			traits: ["identity"],
			fields: { name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", orderNum: 10 } },
		},
		"ui/folders.json": {
			label: "Shop",
			entities: { order: { viewName: "default", quickAdd: true } },
			children: { east: { label: "East", entities: { order: { viewName: "default" } } } },
		},
		"ui/data_views.json": {
			order: { viewType: "grid", label: "Orders", dataSources: [{ entityCode: "order", columns: ["number"] }] },
		},
		"ui/menus.json": { shop_menu: { label: "Shop", items: {} } },
		"ui/actions.json": {},
		"security/roles.json": { "shop.admin": { label: "Admin", rights: { order: "SIUDC" } } },
		...extra,
	};
	for (const [rel, body] of Object.entries(all)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), typeof body === "string" ? body : JSON.stringify(body, null, "\t"));
	}
	return dir;
}
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
const out = async (p: Promise<{ content: { text: string }[]; isError?: boolean }>) => {
	const r = await p;
	return { err: !!r.isError, text: r.content[0].text };
};

describe("envelope: `apply` never leaks into a tool's own args", () => {
	// Each entry: [name, fn, input schema as registered in server.ts, args]. Args go
	// through the same zod parse the MCP SDK does (defaults included).
	const calls: Array<[string, (a: any) => any, Record<string, z.ZodTypeAny>, (d: string) => any]> = [
		["manifest_set", manifestSet, manifestSetSchema, (moduleDir) => ({ moduleDir, description: "x" })],
		[
			"entity_configure",
			entityConfigure,
			entityConfigureSchema,
			(moduleDir) => ({ moduleDir, entity: "order", description: "x" }),
		],
		[
			"action_add",
			actionAdd,
			actionAddSchema,
			(moduleDir) => ({
				moduleDir,
				code: "ping",
				entityCode: "order",
				label: "Ping",
				dslBody: "execute:\n\tlet x = 1\n",
			}),
		],
		[
			"menu_add",
			menuAdd,
			menuAddSchema,
			(moduleDir) => ({ moduleDir, menu: "shop_menu", code: "orders", label: "Orders", dataViewCode: "order" }),
		],
		["folder_modify", folderModify, folderModifySchema, (moduleDir) => ({ moduleDir, code: "east", label: "East 2" })],
	];
	for (const [name, fn, schema, mk] of calls) {
		for (const apply of [false, true]) {
			it(`${name} apply=${apply}`, async () => {
				const dir = make();
				const args = z.object({ ...schema, ...applyInput }).parse({ ...mk(dir), apply });
				const r = await out(envelope(fn)(args));
				expect(r.err, r.text).toBe(false);
				const body = JSON.parse(r.text);
				if (apply) expect(body.applied).toBe(true);
				else expect(body.files).toBeTruthy();
			});
		}
	}
	it("manifest_set apply:true actually writes", async () => {
		const dir = make();
		await envelope(manifestSet)(
			z.object({ ...manifestSetSchema, ...applyInput }).parse({ moduleDir: dir, description: "hello", apply: true }),
		);
		expect(read(dir, "manifest.json").description).toBe("hello");
	});
});

describe("dforge_folder_modify", () => {
	it("adds an entity binding to an existing folder", () => {
		const dir = make();
		const r = folderModify({
			moduleDir: dir,
			parentPath: "",
			code: "east",
			addEntities: { item: { viewName: "default", quickAdd: true, rowFilter: { c: "name", o: "=", v: "x" } } },
			label: "East region",
		});
		const f = JSON.parse(r.files["ui/folders.json"]);
		expect(f.children.east.entities.item).toEqual({
			viewName: "default",
			quickAdd: true,
			rowFilter: { c: "name", o: "=", v: "x" },
		});
		expect(f.children.east.entities.order).toBeTruthy();
		expect(f.children.east.label).toBe("East region");
		expect(JSON.stringify(f)).not.toContain('"roles"');
	});
	it("merges, removes, modifies the root", () => {
		const dir = make();
		const f = JSON.parse(
			folderModify({
				moduleDir: dir,
				parentPath: "",
				addEntities: { order: { quickAdd: false } },
				icon: "bi-shop",
				removeEntities: [],
			}).files["ui/folders.json"],
		);
		expect(f.entities.order).toEqual({ viewName: "default", quickAdd: false });
		expect(f.icon).toBe("bi-shop");
		const g = JSON.parse(
			folderModify({ moduleDir: dir, parentPath: "", code: "east", removeEntities: ["order"] }).files[
				"ui/folders.json"
			],
		);
		expect(g.children.east.entities).toBeUndefined();
	});
	it("refuses silently-wrong input", () => {
		const dir = make();
		const base = { moduleDir: dir, parentPath: "" };
		expect(() => folderModify({ ...base, code: "west", label: "x" })).toThrow(/not found/);
		expect(() => folderModify({ ...base, code: "east", addEntities: { ghost: {} } })).toThrow(/not in manifest/);
		expect(() => folderModify({ ...base, code: "east", removeEntities: ["item"] })).toThrow(/no binding/);
		expect(() => folderModify({ ...base, code: "east", addEntities: { order: { viewName: "nope" } } })).toThrow(
			/not declared/,
		);
		expect(() => folderModify({ ...base, code: "east" })).toThrow(/Nothing to change/);
		expect(() => folderModify({ ...base, parentPath: "east", label: "x" })).toThrow(/without 'code'/);
		expect(() => folderModify({ ...base, code: "east", addEntities: { order: { viewName: "slim" } } })).not.toThrow();
	});
});

describe("change iteration statements", () => {
	const setup = () => {
		const dir = make({ "docs/phase.json": { readyToScaffold: true, phases: {} } });
		const apply = (args: Record<string, unknown>) => planModule({ moduleDir: dir, apply: true, ...args } as never);
		return { dir, apply };
	};
	it("complete_phase appends deduped statements; note_change too", () => {
		const { dir, apply } = setup();
		apply({ action: "begin_change", note: "chg", statements: ["S-1"] });
		apply({ action: "complete_phase", phase: "1", note: "x", statements: ["S-1", "S-2"] });
		let it1 = read(dir, "docs/phase.json").iterations[0];
		expect(it1.statements).toEqual(["S-1", "S-2"]);
		apply({ action: "note_change", statements: ["S-2", "R-4"], note: "found later" });
		it1 = read(dir, "docs/phase.json").iterations[0];
		expect(it1.statements).toEqual(["S-1", "S-2", "R-4"]);
		expect(it1.notes).toEqual(["found later"]);
		expect(Object.keys(it1.phases)).toEqual(["1"]);
	});
	it("note_change needs an open iteration and some content", () => {
		const { apply } = setup();
		expect(() => apply({ action: "note_change", statements: ["S-1"] })).toThrow(/No open change iteration/);
		apply({ action: "begin_change", note: "chg" });
		expect(() => apply({ action: "note_change" })).toThrow(/needs/);
	});
});

describe("adminRights", () => {
	it("entity_add default stays SIUDC, override honoured", () => {
		const dir = make();
		const def = addEntityFiles({
			moduleDir: dir,
			entity: z.object(addEntitySchema).shape.entity.parse({ name: "box", label: "Box" }),
		});
		expect(JSON.parse(def.files["security/roles.json"])["shop.admin"].rights.box).toBe("SIUDC");
		const o = addEntityFiles({
			moduleDir: dir,
			entity: z.object(addEntitySchema).shape.entity.parse({ name: "box", label: "Box" }),
			adminRights: "SIUC",
		});
		expect(JSON.parse(o.files["security/roles.json"])["shop.admin"].rights.box).toBe("SIUC");
	});
	it("module_import and dbml_import honour it", () => {
		const dir = make();
		const r = moduleImport({
			moduleDir: dir,
			tables: [{ name: "tag", label: "Tag", columns: [{ name: "title" }] }] as never,
			adminRights: "SIU",
		} as never);
		expect(JSON.parse(r.files["security/roles.json"])["shop.admin"].rights.tag).toBe("SIU");
		const d = dbmlImport({ moduleDir: dir, dbml: "Table label { name varchar }", adminRights: "SIU" } as never);
		expect(JSON.parse(d.files["security/roles.json"])["shop.admin"].rights.label).toBe("SIU");
	});
});

describe("check constraint expressions are raw PostgreSQL", () => {
	const add = (expression: string, dir = make()) =>
		entityConfigure({
			moduleDir: dir,
			entity: "order",
			constraints: { add: { ck_q: { type: "check", expression, message: "m" } } },
		});
	it("refuses formula bracket syntax with the fix", () => {
		expect(() => add("[quantity] > 0")).toThrow(/formula bracket syntax.*write "quantity > 0"/);
	});
	it("refuses unknown columns", () => {
		expect(() => add("qty > 0")).toThrow(/'qty'.*not a column/);
	});
	it("accepts real columns, literals, functions, casts", () => {
		expect(() => add("quantity > 0 AND number IS NOT NULL")).not.toThrow();
		expect(() => add("length(number) > 2 AND number <> 'x y'")).not.toThrow();
		expect(() => add("quantity::int BETWEEN 1 AND 9")).not.toThrow();
		expect(() => add("order_id > 0")).not.toThrow();
	});
	it("dbml_import emits raw column names or reports a loss", () => {
		const dir = make();
		const r = dbmlImport({ moduleDir: dir, dbml: "Table part {\n qty int [note: 'check qty > 0']\n}" } as never);
		const ent = JSON.parse(r.files["entities/part.json"]);
		const cons = Object.values(ent.constraints ?? {}) as Array<{ expression: string }>;
		for (const c of cons) expect(c.expression).not.toMatch(/\[/);
		const r2 = dbmlImport({ moduleDir: make(), dbml: "Table part {\n qty int [note: 'check [qty] > 0']\n}" } as never);
		const ent2 = JSON.parse(r2.files["entities/part.json"]);
		expect(ent2.constraints).toBeUndefined();
	});
});

describe("unqualified-entity DSL message", () => {
	it("says the rule applies to DSL built-in arguments only", () => {
		const issues = checkDsl("execute:\n\tselect('plan', {})\n", { moduleCode: "m", executionMode: "single" });
		const u = issues.find((i) => i.rule === "dsl/unqualified-entity");
		if (u) expect(u.message).toMatch(/stay bare/);
	});
});

describe("validate: full vs summary parity (Z-2 / Z-3)", () => {
	const files = () => ({
		"manifest.json": {
			code: "t",
			version: "1.0.0",
			dbSchemaVersion: "1.0.0",
			displayName: "T",
			supportedLocales: ["ru-RU"],
			entities: { thing: "./entities/thing.json" },
		},
		"entities/thing.json": {
			description: "Thing",
			toString: "{name}",
			traits: ["identity"],
			numberSequence: { column: "name" },
			fields: { name: { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VEM" } },
		},
		"ui/menus.json": { t_menu: { label: "T", items: { a: { label: "A", dataViewCode: "thing" } } } },
		"translations/ru-RU.json": { menus: { t_menu: { label: "T", items: { items: { a: { label: "A" } } } } } },
	});
	it("both formats report the numberSequence and nested-menu schema findings", () => {
		const dir = make(files());
		const msgs = (format: "full" | "summary") => {
			const r = moduleValidate({ moduleDir: dir, format });
			const v = JSON.parse(r.files["_validate.json"]);
			return JSON.stringify(v) + (format === "summary" ? readFull(r) : "");
		};
		const readFull = (r: { summary: string }) => {
			const m = r.summary.match(/Full list: (\S+?)\.?$/);
			return m && existsSync(m[1]) ? readFileSync(m[1], "utf8") : "";
		};
		for (const f of ["full", "summary"] as const) {
			const t = msgs(f);
			expect(t, f).toMatch(/defaultPrefix/);
			expect(t, f).toMatch(/items/);
		}
	});
});

describe("manifest path containment", () => {
	it("entityFilePath refuses paths outside the module root", async () => {
		const { entityFilePath } = await import("../src/tools/_helpers");
		expect(() => entityFilePath("/a/mod", "../../etc/passwd")).toThrow(/outside the module/);
		expect(entityFilePath("/a/mod", "./entities/x.json")).toBe("/a/mod/entities/x.json");
	});
});
