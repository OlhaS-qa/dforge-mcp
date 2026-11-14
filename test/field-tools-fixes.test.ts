import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entityFieldAdd, entityFieldModify, entityFieldAddSchema } from "../src/tools/entity-field";
import { entityFieldRemove, entityFieldRename } from "../src/tools/refactor";
import { entityRollupAdd, entityStatusAdd } from "../src/tools/entity-compose";
import { checkFieldSpec } from "../src/tools/field-rules";
import { z } from "zod";

let dir: string;
const w = (rel: string, obj: unknown) => {
	const fp = join(dir, rel);
	mkdirSync(join(fp, ".."), { recursive: true });
	writeFileSync(fp, typeof obj === "string" ? obj : JSON.stringify(obj, null, "\t"));
};
const parse = (files: Record<string, string>, rel: string) => JSON.parse(files[rel]);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-ftf-"));
	w("manifest.json", {
		code: "t",
		dbSchemaVersion: "0.0.1",
		entities: { req: "./entities/req.json", part: "./entities/part.json" },
	});
	w("entities/req.json", {
		entityCode: "req",
		dbObject: "req",
		traits: ["identity"],
		toString: "{name}",
		fields: {
			name: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", params: { min: 1, hint: "x" } },
			qty: { dbDatatype: "int", fieldTypeCd: "number", flags: "VE" },
			parts: { columnType: "S", fieldTypeCd: "grid", flags: "VE", link: { entity: "part", thisKey: "req_id", otherKey: "req_id" } },
		},
		constraints: { ck_name: { type: "check", expression: "length(name) > 0" } },
		views: { v1: { columns: { name: {}, qty: {} } } },
	});
	w("entities/part.json", {
		entityCode: "part",
		dbObject: "part",
		traits: ["identity"],
		fields: { req_id: { dbDatatype: "cuid", flags: "EM" }, amount: { dbDatatype: "numeric(18,2)", fieldTypeCd: "currency", flags: "VEM" } },
	});
	w("ui/reports.json", {
		r1: {
			datasets: { d: { query: { entityCd: "req", columns: ["name", "qty"], sort: [{ c: "name", d: "asc" }] }, columnsDef: { name: { label: "Name" } } } },
			layout: { panels: [{ datasetCd: "d", config: { categoryCol: "name" } }] },
		},
	});
	w("tests/a.test.json", { tests: [{ given: [{ entityCode: "req", records: [{ name: "x" }] }] }] });
	w("logic/actions/a.dsl", "set [name] = 'x'");
	w("translations/ru.json", { entities: { req: { fields: { name: { label: "Имя" } } } } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("field_add: formula columns", () => {
	it("never derives dbDatatype for an F column and says so", () => {
		const r = entityFieldAdd({
			moduleDir: dir, entityName: "req", fieldName: "total",
			field: { columnType: "F", fieldTypeCd: "currency", baseDatatypeCd: "number", formula: "[qty] * 2", flags: "V" },
		});
		const f = parse(r.files, "entities/req.json").fields.total;
		expect(f.dbDatatype).toBeUndefined();
		expect(r.warning).toMatch(/dbDatatype was NOT derived/);
	});
});

describe("baseDatatypeCd enum", () => {
	it("rejects fieldTypeCd-style values", () => {
		const issues = checkFieldSpec("f", { columnType: "F", baseDatatypeCd: "text", formula: "1" });
		expect(issues.some((i) => i.level === "error" && /'string'/.test(i.message))).toBe(true);
		const schema = z.object(entityFieldAddSchema);
		expect(
			schema.safeParse({ moduleDir: dir, entityName: "req", fieldName: "x", field: { columnType: "F", baseDatatypeCd: "datetime", formula: "1", flags: "V" } }).success,
		).toBe(false);
		expect(checkFieldSpec("f", { columnType: "F", baseDatatypeCd: "timestamp", formula: "1", flags: "V" })).toEqual([]);
	});
});

describe("rollup COUNT over the child PK", () => {
	it("allows COUNT of the identity PK", () => {
		const r = entityRollupAdd({ moduleDir: dir, entity: "req", name: "parts_count", childEntity: "part", childField: "part_id", agg: "COUNT", setField: "parts" });
		const f = parse(r.files, "entities/req.json").fields.parts_count;
		expect(f.formula).toBe("COUNT([parts].[part_id])");
		expect(f.dbDatatype).toBe("int8");
	});
	it("refuses SUM over the PK and points at the helper-column workaround for unknown columns", () => {
		expect(() => entityRollupAdd({ moduleDir: dir, entity: "req", name: "x", childEntity: "part", childField: "part_id", agg: "SUM", setField: "parts" })).toThrow(/only COUNT/);
		expect(() => entityRollupAdd({ moduleDir: dir, entity: "req", name: "x", childEntity: "part", childField: "nope", agg: "SUM", setField: "parts" })).toThrow(/helper numeric column/);
	});
});

describe("status_add editable", () => {
	const base = { moduleDir: "", entity: "req", name: "status", options: ["new", "done"], required: true };
	it("defaults to VEM", () => {
		const r = entityStatusAdd({ ...base, moduleDir: dir });
		expect(parse(r.files, "entities/req.json").fields.status.flags).toBe("VEM");
	});
	it("editable:false is read-only V and keeps the initial formula", () => {
		const r = entityStatusAdd({ ...base, moduleDir: dir, editable: false });
		const f = parse(r.files, "entities/req.json").fields.status;
		expect(f.flags).toBe("V");
		expect(f.formula).toBe("'new'");
	});
});

describe("field_modify", () => {
	it("merges params and null removes a key", () => {
		const r = entityFieldModify({
			moduleDir: dir, entityName: "req", fieldName: "name",
			field: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", params: { max: 5, hint: null } },
		});
		expect(parse(r.files, "entities/req.json").fields.name.params).toEqual({ min: 1, max: 5 });
	});
	it("warns on a type change and lists dependants", () => {
		const r = entityFieldModify({
			moduleDir: dir, entityName: "req", fieldName: "name",
			field: { dbDatatype: "text", fieldTypeCd: "textarea", flags: "VEM" },
		});
		expect(r.warning).toMatch(/dbSchemaVersion/);
		expect(r.warning).toMatch(/constraints/);
		expect(r.warning).toMatch(/reports/);
		expect((r as { references?: Record<string, string[]> }).references?.reports?.length).toBeGreaterThan(0);
	});
});

describe("field_remove / rename leave nothing silent", () => {
	it("remove: fixes toString, blocks on constraints, lists references", () => {
		const r = entityFieldRemove({ moduleDir: dir, entityName: "req", fieldName: "name" });
		const e = parse(r.files, "entities/req.json");
		expect(e.toString).toBe("{req_id}");
		expect(e.views.v1.columns.name).toBeUndefined();
		expect(r.warning).toMatch(/BLOCKING/);
		const refs = (r as { references?: Record<string, string[]> }).references!;
		expect(refs.constraints?.length).toBe(1);
		expect(refs.reports?.length).toBeGreaterThanOrEqual(4);
		expect(refs.tests?.length).toBe(1);
		expect(refs.dsl?.length).toBe(1);
		expect(refs.translations?.length).toBe(1);
	});
	it("rename: rewrites toString and constraints, lists the rest", () => {
		const r = entityFieldRename({ moduleDir: dir, entityName: "req", fieldName: "name", newName: "title" });
		const e = parse(r.files, "entities/req.json");
		expect(e.toString).toBe("{title}");
		expect(e.constraints.ck_name.expression).toBe("length(title) > 0");
		const refs = (r as { references?: Record<string, string[]> }).references!;
		expect(refs.reports?.length).toBeGreaterThan(0);
		expect(refs.constraints).toBeUndefined();
	});
});
