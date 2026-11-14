// Round 3b: field orderNum/description, validate summary breakdown, field_remove
// view cascade, nameField:false scaffold, plan ledger heuristic + CLAUDE.md tick,
// library messages, setting_add enum.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModuleFiles } from "../src/tools/create-module";
import { addEntityFiles } from "../src/tools/add-entity";
import { entityFieldAdd, entityFieldModify } from "../src/tools/entity-field";
import { entityFieldRemove, entityFieldRename } from "../src/tools/refactor";
import { entityReferenceAdd, entityRollupAdd, entityStatusAdd } from "../src/tools/entity-compose";
import { dbmlImport } from "../src/tools/import";
import { moduleValidate } from "../src/tools/module-validate";
import { settingAdd } from "../src/tools/adds";
import { translationSync } from "../src/tools/translations";
import { planModule } from "../src/tools/plan-module";
import { applyToDisk } from "../src/tools/apply";
import { guardSchemas } from "../src/tools/schema-guard";
import { loadVendoredSchema, validateAgainstSchema } from "../src/tools/validate/json-schema";
import type { ToolResult } from "../src/tools/_helpers";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-r3b-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));
const write = (rel: string, obj: unknown) => {
	mkdirSync(dirname(join(dir, rel)), { recursive: true });
	writeFileSync(join(dir, rel), typeof obj === "string" ? obj : JSON.stringify(obj, null, "\t") + "\n");
};
const apply = (r: ToolResult) => applyToDisk(dir, guardSchemas(dir, r));

function phase0() {
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(
		join(dir, "CLAUDE.md"),
		"# Shop\n\n- [x] **0a** Identity\n- [x] **0b** Requirements\n- [x] **0c** Design\n- [x] **0d** Validation\n- [ ] **1** Scaffolded — `manifest.json`\n",
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
	dependencies: [] as string[],
	preset: "minimal" as const,
	entities: [
		{ name: "item", label: "Item", traits: ["identity", "audit"] },
		{ name: "order", label: "Order", traits: ["identity", "audit"] },
	],
});

function scaffold(entities?: Array<Record<string, unknown>>) {
	phase0();
	const files = createModuleFiles({ ...base(), ...(entities ? { entities } : {}) } as never);
	apply({ summary: "x", files });
}

const fieldSchema = () => {
	const s = loadVendoredSchema("entity")!;
	return (s as any).$defs.field as { required: string[] };
};
const requiredProblems = (entityRel: string): string[] => {
	const req = fieldSchema().required;
	const e = read(entityRel);
	const out: string[] = [];
	for (const [k, f] of Object.entries<any>(e.fields ?? {})) for (const r of req) if (!(r in f)) out.push(`${k}.${r}`);
	return out;
};

describe("field tools emit orderNum + description", () => {
	it("field_add assigns max+10 and a description; explicit values are kept", () => {
		scaffold();
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "item",
				fieldName: "price",
				field: { fieldTypeCd: "currency", flags: "VE" },
			}),
		);
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "item",
				fieldName: "qty",
				field: { fieldTypeCd: "number", flags: "VE", orderNum: 5, description: "Quantity" },
			}),
		);
		const e = read("entities/item.json");
		expect(e.fields.name.orderNum).toBe(10);
		expect(e.fields.price.orderNum).toBe(20);
		expect(e.fields.price.description).toBe("Price");
		expect(e.fields.qty).toMatchObject({ orderNum: 5, description: "Quantity" });
		expect(requiredProblems("entities/item.json")).toEqual([]);
	});

	it("field_modify keeps the old orderNum/description when the replacement omits them", () => {
		scaffold();
		apply(
			entityFieldModify({
				moduleDir: dir,
				entityName: "item",
				fieldName: "name",
				field: { fieldTypeCd: "text", flags: "VEM", dbDatatype: "varchar", maxLen: 100 },
			}),
		);
		expect(read("entities/item.json").fields.name).toMatchObject({ orderNum: 10, description: "Name", maxLen: 100 });
	});

	it("reference_add / status_add / rollup_add / dbml_import / entity_add stubs validate against the field `required`", () => {
		scaffold();
		apply(entityReferenceAdd({ moduleDir: dir, entity: "order", targetEntity: "item", name: "item", required: true }));
		apply(
			entityStatusAdd({
				moduleDir: dir,
				entity: "order",
				name: "status",
				options: ["new", "done"],
				required: true,
			} as never),
		);
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "order",
				fieldName: "amount",
				field: { fieldTypeCd: "currency", flags: "VE" },
			}),
		);
		apply(
			entityRollupAdd({
				moduleDir: dir,
				entity: "item",
				name: "total",
				childEntity: "order",
				childField: "amount",
				agg: "SUM",
				childFkField: "item_id",
			} as never),
		);
		apply({
			summary: "x",
			files: addEntityFiles({ moduleDir: dir, entity: { name: "extra", label: "Extra", traits: ["identity"] } }).files,
		});
		for (const n of ["item", "order", "extra"]) expect(requiredProblems(`entities/${n}.json`), n).toEqual([]);

		const d2 = mkdtempSync(join(tmpdir(), "dforge-mcp-r3b2-"));
		try {
			const r = dbmlImport({
				moduleDir: d2,
				dbml: "Table ord { id int [pk]\n title varchar(50) [not null]\n cust int }\nTable cust { id int [pk]\n name varchar }\nRef: ord.cust > cust.id",
				module: { code: "shop", displayName: "Shop" },
			});
			const req = fieldSchema().required;
			for (const [rel, text] of Object.entries(r.files)) {
				if (!rel.startsWith("entities/")) continue;
				for (const [k, f] of Object.entries<any>(JSON.parse(text).fields ?? {}))
					for (const q of req) expect(f, `${rel}.${k}.${q}`).toHaveProperty(q);
			}
		} finally {
			rmSync(d2, { recursive: true, force: true });
		}
	});
});

describe("validate summary", () => {
	it("names the schema-warning count and the top family", () => {
		scaffold();
		// strip required props from several fields: schema warnings
		const e = read("entities/item.json");
		e.fields.a = { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VE" };
		e.fields.b = { fieldTypeCd: "text", dbDatatype: "varchar", flags: "VE" };
		write("entities/item.json", e);
		for (const format of ["full", "summary"] as const) {
			const r = moduleValidate({ moduleDir: dir, format });
			expect(r.summary).toMatch(/\d+ warning\(s\) \(schema: \d+ in 1 file/);
		}
	});
});

describe("field_remove cascades into data views", () => {
	it("removes the column from string-form columns, order and filter", () => {
		scaffold();
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "item",
				fieldName: "code",
				field: { fieldTypeCd: "text", flags: "VE", dbDatatype: "varchar" },
			}),
		);
		const v = read("ui/data_views.json");
		v.item.dataSources[0].columns = ["name", "code"];
		v.item.dataSources[0].order = [{ c: "name", d: "asc" }, "-code"];
		v.item.dataSources[0].filter = {
			g: "and",
			i: [
				{ c: "name", o: "=", v: "x" },
				{ c: "code", o: "!null" },
			],
		};
		write("ui/data_views.json", v);
		const r = entityFieldRemove({ moduleDir: dir, entityName: "item", fieldName: "name" });
		expect(r.summary).toMatch(/data_views\.json/);
		apply(r);
		const src = read("ui/data_views.json").item.dataSources[0];
		expect(src.columns).toEqual(["code"]);
		expect(src.order).toEqual(["-code"]);
		expect(src.filter).toEqual({ g: "and", i: [{ c: "code", o: "!null" }] });
	});

	it("rename handles string columns too", () => {
		scaffold();
		const r = entityFieldRename({ moduleDir: dir, entityName: "item", fieldName: "name", newName: "title" } as never);
		apply(r);
		expect(read("ui/data_views.json").item.dataSources[0].columns).toContain("title");
	});
});

describe("nameField: false", () => {
	const ents = [
		{ name: "item", label: "Item", traits: ["identity", "audit"], nameField: false },
		{ name: "order", label: "Order", traits: ["identity"], nameField: false, toStringTemplate: "{order_id}" },
		{ name: "plain", label: "Plain", traits: ["identity"] },
	];
	it("module_create: no stub name; toString is PK or the given template; grid uses real columns; schema-clean", () => {
		scaffold(ents);
		const item = read("entities/item.json");
		expect(item.fields).toEqual({});
		expect(item.toString).toBe("{item_id}");
		expect(read("entities/order.json").toString).toBe("{order_id}");
		expect(read("entities/plain.json").fields.name).toBeDefined();
		expect(read("entities/plain.json").toString).toBe("{name}");
		expect(read("ui/data_views.json").item.dataSources[0].columns).toEqual(["item_id"]);
		// A grid needs a visible field: the only open error is that one, until the author adds a field.
		let v = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(v.errors.map((e: { message: string }) => e.message).every((m: string) => /no visible column/.test(m))).toBe(
			true,
		);
		const grid = v.warnings.filter((w: { message: string }) => /schema\)/.test(w.message));
		expect(grid, JSON.stringify(grid)).toEqual([]);
		for (const n of ["item", "order"]) {
			apply(
				entityFieldAdd({
					moduleDir: dir,
					entityName: n,
					fieldName: "title",
					field: { fieldTypeCd: "text", flags: "VEM", dbDatatype: "varchar" },
				}),
			);
		}
		expect(read("entities/item.json").fields.title.orderNum).toBe(10);
		v = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		expect(v.errors, JSON.stringify(v.errors)).toEqual([]);
		const sw = v.warnings.filter((w: { message: string }) => /schema\)/.test(w.message));
		expect(sw, JSON.stringify(sw)).toEqual([]);
	});
	it("entity_add accepts nameField:false and toStringTemplate", () => {
		scaffold();
		const r = addEntityFiles({
			moduleDir: dir,
			entity: { name: "line", label: "Line", traits: ["identity"], nameField: false, toStringTemplate: "{number}" },
		});
		const e = JSON.parse(r.files["entities/line.json"]);
		expect(e.fields).toEqual({});
		expect(e.toString).toBe("{number}");
		expect(JSON.parse(r.files["ui/data_views.json"]).line.dataSources[0].columns).toEqual(["line_id"]);
	});
});

describe("module_plan ledger", () => {
	const plan = (a: Record<string, unknown>) => planModule({ moduleDir: dir, ...a } as never) as any;

	it("a freshly scaffolded module with only Phase 1 recorded shows no false drift; CLAUDE.md '1' is ticked", () => {
		scaffold();
		const r = plan({ action: "complete_phase", phase: "1", apply: true });
		expect(r.written ?? []).toContain("CLAUDE.md");
		expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toMatch(/- \[x\] \*\*1\*\* Scaffolded/);
		const c = plan({ action: "check" });
		expect(c.ledgerBehind ?? []).toEqual([]);
		expect(c.summary).not.toMatch(/LEDGER BEHIND/);
	});

	it("still flags real evidence: actions exist but Phase 2 is not recorded", () => {
		scaffold();
		apply(
			entityFieldAdd({
				moduleDir: dir,
				entityName: "item",
				fieldName: "code",
				field: { fieldTypeCd: "text", flags: "VE", dbDatatype: "varchar" },
			}),
		);
		write("ui/actions.json", { approve: { label: "Approve", entityCode: "item" } });
		const c = plan({ action: "check" });
		expect((c.ledgerBehind ?? []).join(" ")).toMatch(/Phase 1/);
		expect((c.ledgerBehind ?? []).join(" ")).toMatch(/Phase 2/);
		expect((c.ledgerBehind ?? []).join(" ")).not.toMatch(/Phase 3|Phase 5/);
	});
});

describe("messages from function libraries", () => {
	function withLibrary() {
		scaffold();
		write("manifest.json", { ...read("manifest.json"), supportedLocales: ["ru-RU"] });
		write(
			"logic/functions/lib.dsl",
			"function guard(c) {\n    if (c == null) { error('The record is missing.') }\n}\n",
		);
		write("logic/actions/go.dsl", "execute:\n    info('Done.')\n");
		write("ui/actions.json", { go: { label: "Go", entityCode: "item" } });
	}
	it("sync seeds library texts and validate does not call them 'never shows'", () => {
		withLibrary();
		apply(translationSync({ moduleDir: dir, prune: false } as never));
		const ru = read("translations/ru-RU.json");
		expect(Object.keys(ru.messages)).toEqual(expect.arrayContaining(["Done.", "The record is missing."]));
		const v = JSON.parse(moduleValidate({ moduleDir: dir }).files["_validate.json"]);
		const bad = v.warnings.filter((w: { message: string }) => /never shows/.test(w.message));
		expect(bad, JSON.stringify(bad)).toEqual([]);
		// prune keeps them
		apply(translationSync({ moduleDir: dir, prune: true } as never));
		expect(read("translations/ru-RU.json").messages["The record is missing."]).toBeDefined();
	});
});

describe("setting_add datatype enum", () => {
	it("rejects baseDatatypeCd 'cuid' naming the vendored schema; accepts 'string'", () => {
		scaffold();
		expect(() =>
			settingAdd({
				moduleDir: dir,
				code: "owner",
				setting: { fieldTypeCd: "text", baseDatatypeCd: "cuid", label: "Owner" },
			} as never),
		).toThrow(/vendored settings\.schema\.json does not list it/);
		const r = settingAdd({
			moduleDir: dir,
			code: "owner",
			setting: { fieldTypeCd: "text", baseDatatypeCd: "string", label: "Owner" },
		} as never);
		expect(JSON.parse(r.files["settings.json"]).owner.baseDatatypeCd).toBe("string");
	});
});

void validateAgainstSchema;
