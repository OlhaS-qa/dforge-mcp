// Regression tests for the create/import tool group:
//  - dforge_module_create: dependency contract written with the manifest entry,
//    no empty seed stubs, real grid columns, valid toString, supportedLocales;
//  - dforge_dependency_add: idempotent / repairing when the manifest already has the entry;
//  - dforge_entity_add / dbml_import / module_import: ADDITIVE UI+security, never regenerated;
//  - dbml_import fidelity (Enum, unique, default, varchar/numeric/int, CHECK, notes,
//    one-line tables, otherKey) and a loss report that names every dropped construct.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModuleFiles } from "../src/tools/create-module";
import { addEntityFiles } from "../src/tools/add-entity";
import { dependencyAdd } from "../src/tools/adds";
import { dbmlImport, moduleImport, parseDbmlDetailed } from "../src/tools/import";
import { moduleValidate } from "../src/tools/module-validate";
import { applyToDisk } from "../src/tools/apply";
import { guardSchemas } from "../src/tools/schema-guard";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-cif-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
const write = (rel: string, obj: unknown) => {
	mkdirSync(dirname(join(dir, rel)), { recursive: true });
	writeFileSync(join(dir, rel), JSON.stringify(obj, null, "\t") + "\n");
};
const apply = (r: ToolResult) => applyToDisk(dir, guardSchemas(dir, r));
const validate = () => JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);

function phase0() {
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(
		join(dir, "CLAUDE.md"),
		"# Shop — dForge Module\n\n| Field | Value |\n|---|---|\n| Code | `shop` |\n\n- [x] **0a** Identity\n- [x] **0b** Requirements\n- [x] **0c** Design\n- [x] **0d** Validation\n",
	);
	writeFileSync(
		join(dir, "docs/REQUIREMENTS.md"),
		"# Requirements\n\nThe shop module tracks orders and items for staff.\nStaff create orders and supervisors approve them.\n",
	);
	writeFileSync(
		join(dir, "docs/DESIGN.md"),
		"# Design\n\n## Entity List\n- item\n- order\n\n## Relationship Map\n```mermaid\nerDiagram\n    item ||--o{ order : in\n```\n",
	);
	writeFileSync(
		join(dir, "docs/VALIDATION.md"),
		"# Validation Report\n\nAll checks passed.\n\nreadyToScaffold: true\n",
	);
	writeFileSync(join(dir, "docs/phase.json"), JSON.stringify({ phase: "0d", readyToScaffold: true }) + "\n");
}

const base = () => ({
	moduleDir: dir,
	code: "shop",
	displayName: "Shop",
	license: "MIT",
	version: "0.1.0",
	dbSchemaVersion: "0.0.1",
	dependencies: [] as Array<string | { module: string; version?: string; entities: string[] }>,
	preset: "minimal" as "minimal" | "minimal-plus" | "full",
	entities: [
		{ name: "item", label: "Item", traits: ["identity", "audit"] },
		{ name: "order", label: "Order", traits: ["identity", "audit"] },
	],
});

describe("module_create: dependencies (Q-5)", () => {
	it("writes the deps/<module>.json contract next to the manifest entry", () => {
		phase0();
		const files = createModuleFiles({ ...base(), dependencies: [{ module: "comm", entities: ["party"] }] });
		const m = JSON.parse(files["manifest.json"]);
		expect(m.dependencies.comm).toEqual({ version: ">=0.0.1", entities: ["party"] });
		const c = JSON.parse(files["deps/comm.json"]);
		expect(c).toMatchObject({ module: "comm", version: ">=0.0.1", entities: { party: { pk: "party_id" } } });
		apply({ summary: "x", files });
		const errs = validate().errors.filter((e: string) => /dependenc/i.test(e));
		expect(errs, JSON.stringify(errs)).toEqual([]);
	});

	it("refuses a bare non-system code instead of writing a contract-less manifest entry", () => {
		phase0();
		expect(() => createModuleFiles({ ...base(), dependencies: ["comm"] })).toThrow(/names no entity/);
	});

	it("a bare system module becomes a version gate with an empty-entities contract", () => {
		phase0();
		const files = createModuleFiles({ ...base(), dependencies: ["admin"] });
		expect(JSON.parse(files["manifest.json"]).dependencies.admin).toBe(">=0.0.1");
		expect(JSON.parse(files["deps/admin.json"]).entities).toEqual({});
	});
});

describe("dependency_add: idempotent / repairing (Q-5)", () => {
	beforeEach(() => {
		write("manifest.json", { code: "shop", displayName: "Shop", entities: {}, dependencies: { comm: ">=0.0.1" } });
	});

	it("creates the missing contract for a dependency the manifest already lists", () => {
		const r = dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: ["party"] });
		apply(r);
		expect(read("deps/comm.json").entities.party.pk).toBe("party_id");
		expect(read("manifest.json").dependencies.comm).toEqual({ version: ">=0.0.1", entities: ["party"] });
	});

	it("updates the range in manifest and contract when asked, and is a no-op when nothing changes", () => {
		apply(dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: ["party"] }));
		apply(dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: ["party"], version: ">=0.3.0" }));
		expect(read("deps/comm.json").version).toBe(">=0.3.0");
		expect(read("manifest.json").dependencies.comm.version).toBe(">=0.3.0");
		const again = dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: ["party"], version: ">=0.3.0" });
		expect(Object.keys(again.files)).toEqual([]);
	});

	it("adds further entities to an existing contract without dropping the old ones", () => {
		apply(dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: ["party"] }));
		apply(dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: ["channel"] }));
		expect(Object.keys(read("deps/comm.json").entities).sort()).toEqual(["channel", "party"]);
	});

	it("still needs an entity to repair a non-system contract", () => {
		expect(() => dependencyAdd({ moduleDir: dir, moduleCode: "comm", entities: [] })).toThrow(/no entity is named/);
	});
});

describe("module_create: preset full and defaults (R-14)", () => {
	it("writes no empty seed stubs, real grid columns, a valid toString and supportedLocales", () => {
		phase0();
		const files = createModuleFiles({ ...base(), preset: "full", supportedLocales: ["ru-RU"] });
		expect(Object.keys(files).filter((f) => f.startsWith("seed-data/"))).toEqual([]);
		const views = JSON.parse(files["ui/data_views.json"]);
		for (const v of Object.values(views) as Array<{ dataSources: Array<{ columns: string[] }> }>) {
			expect(v.dataSources[0].columns.length).toBeGreaterThan(0);
		}
		const item = JSON.parse(files["entities/item.json"]);
		const m = item.toString.match(/\{(\w+)\}/)![1];
		expect(Object.keys(item.fields)).toContain(m);
		expect(JSON.parse(files["manifest.json"]).supportedLocales).toEqual(["ru-RU"]);
	});

	it("never lists English in supportedLocales", () => {
		phase0();
		expect(() => createModuleFiles({ ...base(), supportedLocales: ["en-US"] })).toThrow(/English/);
	});

	it("a created full-preset module has no validate errors beyond the missing translations", () => {
		phase0();
		apply({ summary: "x", files: createModuleFiles({ ...base(), preset: "full" }) });
		expect(validate().errors).toEqual([]);
	});
});

// A module with hand-built UI/security that the regenerating builders used to destroy.
function richModule() {
	write("manifest.json", {
		packageFormat: 1,
		moduleId: "m",
		code: "shop",
		version: "0.1.0",
		dbSchemaVersion: "0.0.1",
		displayName: "Shop",
		entities: { item: "./entities/item.json" },
	});
	write("entities/item.json", {
		description: "Item",
		dbObject: "item",
		toString: "{title}",
		traits: ["identity", "audit"],
		fields: { title: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", orderNum: 10, description: "Title" } },
	});
	write("ui/data_views.json", {
		item: { viewType: "grid", label: "Item", dataSources: [{ entityCode: "item", columns: ["title"] }] },
		item_kanban: { viewType: "kanban", label: "Board", dataSources: [{ entityCode: "item", columns: ["title"] }] },
	});
	write("ui/folders.json", {
		label: "Shop",
		icon: "bi-folder",
		entities: { item: { viewName: "default" } },
		children: {
			archive: {
				label: "Archive",
				entities: { item: { viewName: "default", rowFilter: { c: "title", o: "=", v: "x" } } },
			},
		},
	});
	write("ui/menus.json", {
		shop_menu: {
			label: "Shop",
			items: {
				stock: {
					label: "Stock",
					children: { item: { itemType: "V", label: "Item", dataViewCode: "item", orderNum: 1 } },
				},
			},
		},
	});
	write("security/roles.json", {
		"shop.admin": { description: "Admins", rights: { item: "SIUDC", "action:approve": "E" } },
		"shop.clerk": { description: "Clerks", rights: { item: "SI" } },
	});
}

describe("entity_add is additive (R-9)", () => {
	it("keeps existing roles, rights, views, child folders and menu sections", () => {
		richModule();
		const before = { roles: read("security/roles.json"), folders: read("ui/folders.json") };
		const res = addEntityFiles({
			moduleDir: dir,
			entity: { name: "order", label: "Order", traits: ["identity", "audit"] },
		});
		apply({ summary: "x", files: res.files });
		const roles = read("security/roles.json");
		expect(roles["shop.clerk"]).toEqual(before.roles["shop.clerk"]);
		expect(roles["shop.admin"].rights).toEqual({ item: "SIUDC", "action:approve": "E", order: "SIUDC" });
		const views = read("ui/data_views.json");
		expect(views.item_kanban.viewType).toBe("kanban");
		expect(views.order.dataSources[0].columns.length).toBeGreaterThan(0);
		const folders = read("ui/folders.json");
		expect(folders.children).toEqual(before.folders.children);
		expect(folders.entities.order).toBeDefined();
		const menus = read("ui/menus.json");
		expect(menus.shop_menu.items.stock.children.item.dataViewCode).toBe("item"); // section kept
		expect(menus.shop_menu.items.order).toMatchObject({ itemType: "V", dataViewCode: "order" });
		expect(res.warning).toMatch(/Nothing existing was overwritten/);
		expect(res.warning).toMatch(/order/);
	});

	it("does not touch files it has nothing to add to", () => {
		richModule();
		const res = addEntityFiles({
			moduleDir: dir,
			entity: { name: "order", label: "Order", traits: ["identity", "audit"] },
		});
		expect(Object.keys(res.files).sort()).toEqual(
			[
				"entities/order.json",
				"manifest.json",
				"security/roles.json",
				"ui/data_views.json",
				"ui/folders.json",
				"ui/menus.json",
			].sort(),
		);
	});

	it("warns when there is no admin role to grant on instead of inventing one", () => {
		richModule();
		write("security/roles.json", { "shop.clerk": { description: "Clerks", rights: { item: "SI" } } });
		const res = addEntityFiles({
			moduleDir: dir,
			entity: { name: "order", label: "Order", traits: ["identity", "audit"] },
		});
		expect(res.files["security/roles.json"]).toBeUndefined();
		expect(res.warning).toMatch(/no 'shop.admin' role/);
	});
});

const DBML = `
Enum order_status {
  new
  "in progress" [note: 'being worked']
  done
}

Table Customer {
  id integer [pk, increment]
  code varchar(20) [not null, unique]
  name varchar(120) [not null, note: 'Display name']
  credit numeric(12,3) [default: 0]
  qty int [not null, note: 'CHECK qty >= 0']
  big_ref bigint
  vip boolean [default: false]
  state order_status [not null, default: 'new']
  weird int [note: 'CHECK (abs(weird) > 1)']
  created timestamp [default: \`now()\`]
  token uuid [default: \`gen_random_uuid()\`]
  Note: 'The customers'
  indexes {
    (code, name) [unique]
    name
  }
}

Table Line { id int [pk] customer_id int [not null, ref: > Customer.id] }

Table Tiny { a int }

Ref: Line.customer_id > Customer.id [delete: cascade]
Ref: Tiny.a <> Line.id
`;

describe("dbml_import fidelity (R-9, Q-9)", () => {
	const parsed = parseDbmlDetailed(DBML);
	const res = (() => {
		const d = mkdtempSync(join(tmpdir(), "dforge-mcp-cif-dbml-"));
		try {
			return dbmlImport({ moduleDir: d, dbml: DBML, module: { code: "shop", displayName: "Shop" } });
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	})();
	const cust = JSON.parse(res.files["entities/customer.json"]);

	it("parses a one-line table", () => {
		expect(parsed.tables.find((t) => t.name === "tiny")!.columns.map((c) => c.name)).toEqual(["a"]);
	});

	it("maps Enum to dropdown options", () => {
		expect(cust.fields.state.fieldTypeCd).toBe("dropdown");
		expect(cust.fields.state.params.options.map((o: { value: string }) => o.value)).toEqual([
			"new",
			"in progress",
			"done",
		]);
	});

	it("maps default to a formula, never a defaultValue key", () => {
		expect(cust.fields.state.formula).toBe("'new'");
		expect(cust.fields.credit.formula).toBe("0");
		expect(cust.fields.vip.formula).toBe("false");
		expect(cust.fields.created.formula).toBe("NOW()");
		expect(JSON.stringify(cust)).not.toMatch(/defaultValue|"default"/);
	});

	it("maps varchar(n) to maxLen, numeric(p,s) to precision, int/bigint to integer types", () => {
		expect(cust.fields.code.maxLen).toBe(20);
		expect(cust.fields.name.maxLen).toBe(120);
		expect(cust.fields.credit.dbDatatype).toBe("numeric(12,3)");
		expect(cust.fields.qty.dbDatatype).toBe("int");
		expect(cust.fields.big_ref.dbDatatype).toBe("bigint");
	});

	it("maps unique and composite unique to unique constraints, plain index to indexes", () => {
		expect(cust.constraints.uq_customer_code).toMatchObject({ type: "unique", fields: ["code"] });
		expect(
			Object.values(cust.constraints).some(
				(c) => JSON.stringify((c as { fields: string[] }).fields) === '["code","name"]',
			),
		).toBe(true);
		expect(cust.indexes.idx_customer_name.fields).toEqual(["name"]);
	});

	it("carries a simple CHECK, reports a complex one, and uses short notes as description", () => {
		expect(cust.constraints.ck_customer_qty).toMatchObject({ type: "check", expression: "qty >= 0" });
		expect(cust.constraints.ck_customer_weird).toBeUndefined();
		expect(cust.fields.name.description).toBe("Display name");
	});

	it("writes otherKey as the target's PK, never 'id'", () => {
		const line = JSON.parse(res.files["entities/line.json"]);
		expect(line.fields.customer.link.otherKey).toBe("customer_id");
		expect(line.references.FK_Line_customer_id.to.field).toBe("customer_id");
	});

	it("the imported module validates clean (constraints, formulas, options are schema-valid)", () => {
		const d = mkdtempSync(join(tmpdir(), "dforge-mcp-cif-dbml2-"));
		try {
			const r = dbmlImport({ moduleDir: d, dbml: DBML, module: { code: "shop", displayName: "Shop" } });
			applyToDisk(d, r);
			const v = JSON.parse(moduleValidate({ moduleDir: d }).files["_validate.json"]);
			expect(v.errors, JSON.stringify(v.errors)).toEqual([]);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("names every construct it could not carry in the loss report", () => {
		const w = res.warning!;
		expect(w).toMatch(/Loss report/);
		expect(w).toMatch(/customer\.weird: CHECK .*abs/);
		expect(w).toMatch(/customer\.token: default/);
		expect(w).toMatch(/table note not carried/);
		expect(w).toMatch(/many-to-many/);
		expect(w).toMatch(/delete: cascade/);
		expect(w).toMatch(/value note not carried/);
		expect(JSON.parse(res.files["_import_report.json"]).losses.length).toBeGreaterThan(4);
		expect(res.summary).toMatch(/not carried/);
	});
});

describe("import into an existing module", () => {
	it("is additive: keeps roles/views/folders/menus and says so", () => {
		richModule();
		const r = dbmlImport({ moduleDir: dir, dbml: "Table ord { id int [pk]\n title varchar(50) [not null] }" });
		apply(r);
		expect(read("security/roles.json")["shop.clerk"].rights).toEqual({ item: "SI" });
		expect(read("security/roles.json")["shop.admin"].rights).toMatchObject({ "action:approve": "E", ord: "SIUDC" });
		expect(read("ui/data_views.json").item_kanban.viewType).toBe("kanban");
		expect(read("ui/folders.json").children.archive).toBeDefined();
		expect(read("ui/menus.json").shop_menu.items.stock.children.item).toBeDefined();
		expect(r.warning).toMatch(/Nothing existing was overwritten/);
		// (the fixture's 'action:approve' grant is intentionally dangling; everything else is clean)
		expect(validate().errors.filter((e: { message: string }) => !/action:approve/.test(e.message))).toEqual([]);
	});

	it("points a reference at an existing entity's real PK", () => {
		richModule();
		const r = dbmlImport({ moduleDir: dir, dbml: "Table ord { id int [pk]\n item_id int [ref: > item.id] }" });
		expect(JSON.parse(r.files["entities/ord.json"]).fields.item.link.otherKey).toBe("item_id");
	});

	it("errors on an existing entity by default, and replaces or skips on request", () => {
		richModule();
		const dbml = "Table item { id int [pk]\n sku varchar(10) [unique] }";
		expect(() => dbmlImport({ moduleDir: dir, dbml })).toThrow(/onExisting/);
		const skip = dbmlImport({ moduleDir: dir, dbml, onExisting: "skip" });
		expect(skip.files["entities/item.json"]).toBeUndefined();
		const rep = dbmlImport({ moduleDir: dir, dbml, onExisting: "replace" });
		expect(JSON.parse(rep.files["entities/item.json"]).fields.sku.maxLen).toBe(10);
		expect(rep.files["ui/data_views.json"]).toBeUndefined(); // UI untouched
		expect(rep.warning).toMatch(/REPLACED/);
	});

	it("module_import (table-spec) is additive too", () => {
		richModule();
		const r = moduleImport({
			moduleDir: dir,
			tables: [{ name: "ord", columns: [{ name: "title", sqlType: "varchar(50)" }] }],
		});
		apply(r);
		expect(read("security/roles.json")["shop.clerk"]).toBeDefined();
		expect(existsSync(join(dir, "entities/ord.json"))).toBe(true);
	});
});
