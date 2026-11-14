import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityConfigure, manifestSet } from "../src/tools/configure";
import { actionAdd, actionModify } from "../src/tools/action-add";
import { menuAdd } from "../src/tools/menu";
import { roleRightSet, roleAddChecked } from "../src/tools/role-right";
import { viewAdd } from "../src/tools/view";
import { seedAdd } from "../src/tools/seed";
import { applyToDisk } from "../src/tools/apply";
import { guardSchemas } from "../src/tools/schema-guard";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;
const w = (rel: string, v: unknown) => {
	const p = join(dir, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, "\t"));
};
const apply = (r: ToolResult) => applyToDisk(dir, guardSchemas(dir, r));
const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-configure-"));
	w("manifest.json", {
		packageFormat: 1,
		moduleId: "00000000-0000-0000-0000-000000000001",
		code: "shop",
		version: "1.0.0",
		dbSchemaVersion: "1.0.0",
		displayName: "Shop",
		entities: { order: "./entities/order.json" },
	});
	w("entities/order.json", {
		description: "Orders",
		toString: "{order_id}",
		traits: ["identity"],
		fields: {
			number: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", orderNum: 10 },
			total: { dbDatatype: "numeric", fieldTypeCd: "currency", flags: "VE", orderNum: 20 },
			lines: { columnType: "S", flags: "V", orderNum: 30 },
			label: { columnType: "F", formula: "[number]", flags: "V", orderNum: 40 },
		},
	});
	w("ui/folders.json", { label: "Shop", children: { east: { label: "East" } } });
	w("ui/reports.json", { sales: { label: "Sales" } });
	w("ui/data_views.json", { orders: { viewType: "grid", dataSources: [{ entityCode: "order" }] } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("dforge_entity_configure", () => {
	it("sets toString, numberSequence and constraints", () => {
		const r = entityConfigure({
			moduleDir: dir,
			entity: "order",
			toStringTemplate: "{number} / {total}",
			numberSequence: { column: "number", defaultPrefix: "ORD-", pattern: "{prefix}{yyyy}-{seq:4}" },
			constraints: { add: { uq_number: { type: "unique", fields: ["number"], message: "Number is taken" } } },
		});
		apply(r);
		const e = read("entities/order.json");
		expect(e.toString).toBe("{number} / {total}");
		expect(e.numberSequence.defaultPrefix).toBe("ORD-");
		expect(e.constraints.uq_number.fields).toEqual(["number"]);
		expect(r.warning).toBeUndefined();
	});
	it("rejects toString with unknown column or a set", () => {
		expect(() => entityConfigure({ moduleDir: dir, entity: "order", toStringTemplate: "{nope}" })).toThrow(/not a column/);
		expect(() => entityConfigure({ moduleDir: dir, entity: "order", toStringTemplate: "{lines}" })).toThrow(/set/);
	});
	it("rejects numberSequence on a missing/virtual column and bad pattern", () => {
		expect(() =>
			entityConfigure({ moduleDir: dir, entity: "order", numberSequence: { column: "nope", defaultPrefix: "" } }),
		).toThrow(/not a column/);
		expect(() =>
			entityConfigure({ moduleDir: dir, entity: "order", numberSequence: { column: "label", defaultPrefix: "" } }),
		).toThrow(/virtual/);
		expect(() =>
			entityConfigure({ moduleDir: dir, entity: "order", numberSequence: { column: "number", defaultPrefix: "", pattern: "{foo}" } }),
		).toThrow(/placeholder/);
	});
	it("validates constraints and supports replace via remove+add", () => {
		expect(() =>
			entityConfigure({ moduleDir: dir, entity: "order", constraints: { add: { u: { type: "unique", fields: ["zzz"] } } } }),
		).toThrow(/not a column/);
		expect(() =>
			entityConfigure({ moduleDir: dir, entity: "order", constraints: { add: { c: { type: "check" } } } }),
		).toThrow(/expression/);
		apply(entityConfigure({ moduleDir: dir, entity: "order", constraints: { add: { c: { type: "check", expression: "total >= 0" } } } }));
		expect(() =>
			entityConfigure({ moduleDir: dir, entity: "order", constraints: { add: { c: { type: "check", expression: "total > 0" } } } }),
		).toThrow(/already exists/);
		apply(entityConfigure({ moduleDir: dir, entity: "order", constraints: { remove: ["c"], add: { c: { type: "check", expression: "total > 0", message: "m" } } } }));
		expect(read("entities/order.json").constraints.c.expression).toBe("total > 0");
	});
});

describe("dforge_manifest_set", () => {
	it("sets documented keys and refuses en locales", () => {
		apply(manifestSet({ moduleDir: dir, description: "d", shortDescription: "s", category: "sales", tags: ["a"], supportedLocales: ["ru-RU"] }));
		const m = read("manifest.json");
		expect(m.shortDescription).toBe("s");
		expect(m.supportedLocales).toEqual(["ru-RU"]);
		expect(() => manifestSet({ moduleDir: dir, supportedLocales: ["en-US"] })).toThrow(/English/);
		expect(() => manifestSet({ moduleDir: dir, supportedLocales: ["en"] })).toThrow(/English/);
	});
	it("warns when report-security has no grants, and supports unset", () => {
		const r = manifestSet({ moduleDir: dir, features: ["report-security"] });
		expect(r.warning).toMatch(/sales/);
		apply(r);
		apply(manifestSet({ moduleDir: dir, unset: ["features"] }));
		expect(read("manifest.json").features).toBeUndefined();
	});
	it("does not allow identity keys", () => {
		expect(() => manifestSet({ moduleDir: dir, code: "x" } as never)).toThrow();
	});
});

describe("dforge_menu_add report leaf", () => {
	it("emits itemType R + reportCode and folders on the root", () => {
		apply(menuAdd({ moduleDir: dir, menu: "shop_menu", parentPath: "", code: "sales", label: "Sales", reportCode: "sales", folders: ["shop_east"] }));
		const m = read("ui/menus.json");
		expect(m.shop_menu.folders).toEqual(["shop_east"]);
		expect(m.shop_menu.items.sales).toMatchObject({ itemType: "R", reportCode: "sales" });
	});
	it("rejects unknown report, unknown folder, and both codes", () => {
		expect(() => menuAdd({ moduleDir: dir, menu: "m", parentPath: "", code: "x", label: "X", reportCode: "nope" })).toThrow(/ui\/reports/);
		expect(() => menuAdd({ moduleDir: dir, menu: "m", parentPath: "", code: "x", label: "X", folders: ["bogus"] })).toThrow(/folders/);
		expect(() => menuAdd({ moduleDir: dir, menu: "m", parentPath: "", code: "x", label: "X", reportCode: "sales", dataViewCode: "orders" })).toThrow(/not both/);
	});
});

describe("dforge_action_modify", () => {
	const dsl = "params:\nexecute:\n\tnotify('hi')\n";
	it("updates registry entry and DSL, rejects missing code", () => {
		apply(actionAdd({ moduleDir: dir, code: "ship", entityCode: "order", label: "Ship", executionMode: "single", isAsync: false, dslBody: dsl }));
		expect(() => actionModify({ moduleDir: dir, code: "nope", label: "x" })).toThrow(/not found/);
		const r = actionModify({ moduleDir: dir, code: "ship", label: "Ship it", executionMode: "each", dslBody: "params:\nexecute:\n\tnotify('bye')\n" });
		apply(r);
		expect(read("ui/actions.json").ship).toMatchObject({ label: "Ship it", executionMode: "each", script: "ship" });
		expect(readFileSync(join(dir, "logic/actions/ship.dsl"), "utf8")).toContain("bye");
		expect(() => actionModify({ moduleDir: dir, code: "ship" })).toThrow(/Nothing to change/);
	});
});

describe("role folder: rights", () => {
	it("refuses folder: keys in role_right_set and role_add", () => {
		w("security/roles.json", { "shop.admin": { description: "a", rights: { order: "S" } } });
		expect(() => roleRightSet({ moduleDir: dir, roleCode: "shop.admin", object: "folder:east", rights: "E" })).toThrow(/NOT expressible/);
		expect(() => roleAddChecked({ moduleDir: dir, code: "shop.user", description: "u", rights: { order: "S", "folder:east": "E" } })).toThrow(/NOT expressible/);
		// revoke stays allowed
		expect(() => roleRightSet({ moduleDir: dir, roleCode: "shop.admin", object: "folder:east", rights: "" })).not.toThrow();
	});
});

describe("view_add / seed_add guards", () => {
	it("rejects empty entityCode and fills grid columns from the entity", () => {
		expect(() => viewAdd({ moduleDir: dir, code: "v", view: { viewType: "grid", dataSources: [{ entityCode: "" }] } })).toThrow(/empty/);
		const r = viewAdd({ moduleDir: dir, code: "v2", view: { viewType: "grid", dataSources: [{ entityCode: "order", columns: [] }] } });
		const v = JSON.parse(r.files["ui/data_views.json"]);
		expect(v.v2.dataSources[0].columns).toEqual(["number", "total", "label"]);
	});
	it("warns when columns can't be derived", () => {
		const r = viewAdd({ moduleDir: dir, code: "v3", view: { viewType: "grid", dataSources: [{ entityCode: "other.thing", columns: [] }] } });
		expect(r.warning).toMatch(/columns: \[\]/);
	});
	it("seed_add rejects an empty entity", () => {
		expect(() => seedAdd({ moduleDir: dir, entity: "", records: [{ x: 1 }] })).toThrow(/empty/);
	});
});
