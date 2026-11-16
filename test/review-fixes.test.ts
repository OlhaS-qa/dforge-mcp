import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rightsKeyFor, splitSource } from "../src/tools/outputs";
import { guardSchemas } from "../src/tools/schema-guard";
import { loadContext } from "../src/tools/validate/context";
import { checkEmptyViewColumns } from "../src/tools/validate/scaffold";
import { checkJsonSchemas } from "../src/tools/validate/schemas";
import { checkTestScenarios } from "../src/tools/validate/scenarios";

describe("PR #37 review fixes", () => {
	let dir: string;
	const w = (rel: string, v: unknown) => {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), typeof v === "string" ? v : JSON.stringify(v, null, "\t"));
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rf-"));
		w("manifest.json", { code: "hr", name: "HR", version: "0.1.0", dependencies: { fin: ">=0.1.0" } });
		w("entities/employee.json", { fields: {} });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	describe("qualified output sources", () => {
		const known = (c: string) =>
			c === "employee" || (c.includes(".") && ["fin", "hr"].includes(c.slice(0, c.indexOf("."))));
		it("splits a cross-module field source into entity and field", () => {
			expect(splitSource("fin.invoice.total", known, "hr")).toEqual({ entity: "fin.invoice", field: "total" });
		});
		it("keeps a whole qualified entity whole", () => {
			expect(splitSource("fin.invoice", known, "hr")).toEqual({ entity: "fin.invoice" });
		});
		it("returns an own-module entity bare, with or without a field", () => {
			expect(splitSource("hr.employee.full_name", known, "hr")).toEqual({ entity: "employee", field: "full_name" });
			expect(splitSource("hr.employee", known, "hr")).toEqual({ entity: "employee" });
			expect(splitSource("employee.full_name", known, "hr")).toEqual({ entity: "employee", field: "full_name" });
		});
		it("asks for rights on the bare key", () => {
			const row = {
				mechanism: { type: "print", code: "order" },
				sources: ["hr.employee.full_name"],
			} as never;
			expect(rightsKeyFor(row, known, "hr")).toEqual({ key: "employee", need: "S" });
		});
	});

	describe("write guard", () => {
		it("refuses malformed JSON instead of skipping the file", () => {
			expect(() => guardSchemas(dir, { summary: "x", files: { "ui/folders.json": "{ not json" } })).toThrow(
				/not valid JSON/,
			);
		});
	});

	describe("schema pass", () => {
		it("reports malformed deps/<module>.json", () => {
			w("deps/fin.json", "{ nope");
			const ctx = loadContext(dir);
			checkJsonSchemas(ctx);
			expect(ctx.issues.some((i) => /deps\/fin\.json/.test(i.where) && /not valid JSON/.test(i.message))).toBe(true);
		});
		it("checks registers.json against its schema", () => {
			w("registers.json", { stock: { kind: "bogus" } });
			const ctx = loadContext(dir);
			checkJsonSchemas(ctx);
			expect(ctx.issues.some((i) => /registers\.json/.test(i.where))).toBe(true);
		});
	});

	describe("empty grid columns", () => {
		it("warns for a grid but not for a diagram view", () => {
			w("ui/data_views.json", {
				grid_v: { viewType: "grid", dataSources: [{ entityCode: "employee", columns: [] }] },
				diagram_v: { viewType: "diagram", dataSources: [{ entityCode: "employee", columns: [] }] },
			});
			const ctx = loadContext(dir);
			checkEmptyViewColumns(ctx);
			const where = ctx.issues.map((i) => i.where).join("|");
			expect(where).toContain("grid_v");
			expect(where).not.toContain("diagram_v");
		});
	});

	describe("schema-invalid scenario suites", () => {
		it("does not throw on non-object steps", () => {
			w("tests/bad.test.json", { tests: [{ name: "t", given: [7], do: [42], expect: [false] }] });
			const ctx = loadContext(dir);
			expect(() => checkTestScenarios(ctx)).not.toThrow();
		});
	});
});
