import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardSchemas } from "../src/tools/schema-guard";
import { envelope } from "../src/tools/envelope";
import { schemaNameForFile } from "../src/tools/validate/schemas";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-guard-"));
	mkdirSync(join(dir, "entities"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entity = (fields: Record<string, unknown>) =>
	JSON.stringify({ description: "X", toString: "{x_id}", traits: ["identity"], fields }, null, "\t");
const okField = { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", orderNum: 10, description: "Name" };
const badField = { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE" }; // no orderNum/description

describe("schemaNameForFile", () => {
	it("maps module files to their schema", () => {
		expect(schemaNameForFile("entities/order.json")).toBe("entity");
		expect(schemaNameForFile("ui/reports.json")).toBe("reports");
		expect(schemaNameForFile("deps/comm.json")).toBe("deps");
		expect(schemaNameForFile("docs/phase.json")).toBeUndefined();
		expect(schemaNameForFile("logic/actions/a.dsl")).toBeUndefined();
	});
});

describe("guardSchemas", () => {
	it("refuses a file that introduces a schema violation", () => {
		const r = { summary: "s", files: { "entities/x.json": entity({ name: badField }) } };
		expect(() => guardSchemas(dir, r)).toThrow(/orderNum/);
		expect(() => guardSchemas(dir, r)).toThrow(/Nothing was written/);
	});

	it("lets a clean file through untouched", () => {
		const r = { summary: "s", files: { "entities/x.json": entity({ name: okField }) } };
		expect(guardSchemas(dir, r)).toBe(r);
	});

	it("ignores violations already on disk, refuses only new ones", () => {
		writeFileSync(join(dir, "entities/x.json"), entity({ legacy: badField }));
		// repair call that keeps the legacy problem and adds a clean field: allowed
		const keep = { summary: "s", files: { "entities/x.json": entity({ legacy: badField, name: okField }) } };
		expect(() => guardSchemas(dir, keep)).not.toThrow();
		// a call that adds ANOTHER broken field: refused
		const worse = { summary: "s", files: { "entities/x.json": entity({ legacy: badField, other: badField }) } };
		expect(() => guardSchemas(dir, worse)).toThrow(/other/);
	});

	it("only warns for manifest.json (its vendored schema lags the platform)", () => {
		const manifest = JSON.stringify({ packageFormat: 1, code: "m", version: "1.0.0", shortDescription: "x", bogusKey: 1 });
		const out = guardSchemas(dir, { summary: "s", files: { "manifest.json": manifest } });
		expect(out.warning).toMatch(/Schema notes/);
	});

	it("is applied by the envelope: nothing reaches the client", async () => {
		const tool = envelope(() => ({ summary: "s", files: { "entities/x.json": entity({ name: badField }) } }));
		const res = await tool({ moduleDir: dir });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/Refused/);
		expect(() => readFileSync(join(dir, "entities/x.json"))).toThrow();
	});
});
