import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePermissionsMatrix } from "../src/tools/permissions-matrix";
import { loadContext } from "../src/tools/validate/context";
import { checkPermissionsAgainstDesign, checkRoleReachability } from "../src/tools/validate/security";

describe("parsePermissionsMatrix", () => {
	const table = (rows: string[]) =>
		`\n| Role | Object | Rights | Statements |\n|---|---|---|---|\n${rows.join("\n")}\n`;

	it("reads rows, denials and statement ids", () => {
		const m = parsePermissionsMatrix(
			table([
				"| shop.buyer | order | SIU | S-1, V-2 |",
				"| shop.buyer | action:approve | E | S-3 |",
				"| shop.clerk | order | - | N-1 |",
			]),
		);
		expect(m.machine).toBe(true);
		expect(m.problems).toEqual([]);
		expect(m.rows).toHaveLength(3);
		expect(m.rows[0]).toMatchObject({ role: "shop.buyer", object: "order", rights: "SIU", statements: ["S-1", "V-2"] });
		expect(m.rows[2].rights).toBe("-");
	});

	it("flags bad keys, bad rights and duplicates; a free-text matrix is not machine-readable", () => {
		const m = parsePermissionsMatrix(
			table([
				"| shop.buyer | action.approve | E | S-1 |",
				"| shop.buyer | order | SIE | S-1 |",
				"| shop.buyer | order | S | S-1 |",
				"| shop.buyer | order | S | S-1 |",
			]),
		);
		expect(m.problems.join("\n")).toMatch(/use a colon/);
		expect(m.problems.join("\n")).toMatch(/granted 'E'/);
		expect(m.problems.join("\n")).toMatch(/listed twice/);
		expect(parsePermissionsMatrix("Buyers can do everything.").machine).toBe(false);
	});

	it("requires a dotted role code (single-segment names are rejected)", () => {
		const m = parsePermissionsMatrix(table(["| buyer | order | S | S-1 |", "| shop.buyer | order | S | S-1 |"]));
		expect(m.rows).toHaveLength(1);
		expect(m.problems.join("\n")).toMatch(/full role code/);
	});
});

describe("permissions checks", () => {
	let dir: string;
	const w = (rel: string, v: unknown) => {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), typeof v === "string" ? v : JSON.stringify(v, null, "\t"));
	};
	const matrix = (rows: string[]) =>
		`# Design\n\n## Permissions Matrix\n\n| Role | Object | Rights | Statements |\n|---|---|---|---|\n${rows.join("\n")}\n`;
	const field = { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", orderNum: 10, description: "x" };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dforge-perm-"));
		w("manifest.json", {
			packageFormat: 1,
			code: "shop",
			version: "1.0.0",
			displayName: "Shop",
			entities: { order: "./entities/order.json", line: "./entities/line.json" },
		});
		w("entities/order.json", {
			description: "o",
			toString: "{order_id}",
			traits: ["identity"],
			fields: { name: field },
		});
		w("entities/line.json", { description: "l", toString: "{line_id}", traits: ["identity"], fields: { name: field } });
		w("ui/actions.json", {
			approve: { label: "Approve", entityCode: "order", executionMode: "single", script: "approve" },
			init_order: { label: "Init", entityCode: "order", executionMode: "single", script: "init_order" },
			orphan: { label: "Orphan", entityCode: "order", executionMode: "single", script: "orphan" },
		});
		w("logic/triggers.json", {
			triggers: [{ code: "order_created", entity: "order", event: "insert", action: "init_order" }],
		});
		w("security/roles.json", {
			"shop.buyer": { description: "b", rights: { order: "SIU", "action:approve": "E" } },
			"shop.clerk": { description: "c", rights: { order: "S" } },
		});
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = (fn: (c: ReturnType<typeof loadContext>) => void) => {
		const ctx = loadContext(dir);
		fn(ctx);
		return ctx.issues;
	};

	it("passes when roles.json equals the approved matrix", () => {
		w(
			"docs/DESIGN.md",
			matrix([
				"| shop.buyer | order | SIU | S-1 |",
				"| shop.buyer | action:approve | E | S-2 |",
				"| shop.clerk | order | S | S-3 |",
				"| shop.clerk | line | - | N-1 |",
			]),
		);
		expect(run(checkPermissionsAgainstDesign).filter((i) => i.level === "error")).toEqual([]);
	});

	it("reports every kind of drift between design and roles.json", () => {
		w(
			"docs/DESIGN.md",
			matrix([
				"| shop.buyer | order | SIUD | S-1 |",
				"| shop.buyer | action:approve | E | S-2 |",
				"| shop.clerk | order | - | N-1 |",
				"| shop.ghost | order | S | S-9 |",
			]),
		);
		const msgs = run(checkPermissionsAgainstDesign)
			.map((i) => i.message)
			.join("\n");
		expect(msgs).toMatch(/design says 'SIUD', roles.json has 'SIU' \(missing D\)/);
		expect(msgs).toMatch(/denies 'order'.*roles.json grants 'S'/);
		expect(msgs).toMatch(/role 'shop.ghost'/);
	});

	it("flags a grant the design never approved, and a non-machine matrix", () => {
		w("docs/DESIGN.md", matrix(["| shop.buyer | order | SIU | S-1 |"]));
		expect(
			run(checkPermissionsAgainstDesign)
				.map((i) => i.message)
				.join("\n"),
		).toMatch(/grants 'E' on 'action:approve' but the design's Permissions Matrix has no row/);
		w("docs/DESIGN.md", "## Permissions Matrix\nbuyers do buying\n");
		expect(
			run(checkPermissionsAgainstDesign)
				.map((i) => i.message)
				.join("\n"),
		).toMatch(/not machine-readable/);
	});

	it("checks per-role reachability: write without S, action without S, unreachable action, trigger action without E", () => {
		w("security/roles.json", {
			"shop.buyer": { description: "b", rights: { order: "SIU", "action:approve": "E" } },
			"shop.blind": { description: "x", rights: { line: "IU", "action:approve": "E" } },
		});
		const msgs = run(checkRoleReachability)
			.map((i) => i.message)
			.join("\n");
		expect(msgs).toMatch(/'line' grants 'IU' without S/);
		expect(msgs).toMatch(/can run 'action:approve' but has no S on 'order'/);
		expect(msgs).toMatch(/action 'orphan' is granted \(E\) to no role/);
		expect(msgs).not.toMatch(/action 'init_order' is granted/); // run by a trigger
		expect(msgs).toMatch(/trigger 'order_created'.*shop\.buyer/);
	});

	it("ignores triggers with an unknown event or empty action instead of guessing", () => {
		w("logic/triggers.json", {
			triggers: [
				{ code: "t1", entity: "order", event: "custom", action: "init_order" },
				{ code: "t2", entity: "order", event: "insert", action: "" },
			],
		});
		const msgs = run(checkRoleReachability)
			.map((i) => i.message)
			.join("\n");
		expect(msgs).not.toMatch(/trigger 't1'/);
		expect(msgs).not.toMatch(/action ''/);
	});
});
