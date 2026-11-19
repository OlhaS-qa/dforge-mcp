// dforge_module_plan: ledger robustness (apply), change iterations, CLAUDE.md
// tick preservation, relationship-completeness parsing, new DESIGN sections.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planModule } from "../src/tools/plan-module";
import { readPhaseState } from "../src/tools/_helpers";

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const plan = (a: Record<string, unknown>) =>
	planModule({ moduleDir: dir, ...a } as Parameters<typeof planModule>[0]) as any;

const write = (rel: string, body: string) => {
	mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true });
	writeFileSync(join(dir, rel), body);
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

const pad = "x".repeat(120);
const REQ = `# Req mod_x\n${pad}\n`;
const DESIGN_BASE = (entityList: string) => `# Design
## Entity List
${entityList}

## Relationship Map
\`\`\`mermaid
erDiagram
    category ||--o{ product : "has"
\`\`\`

## Gaps & Proposals
None. ${pad}
`;

function identity() {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-plan-"));
	const r = plan({ action: "write_identity", displayName: "Mod X", code: "mod_x" });
	write("CLAUDE.md", r.files["CLAUDE.md"]);
}

function readyModule() {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-plan-"));
	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "docs", "phase.json"), JSON.stringify({ phase: "0d", readyToScaffold: true }));
	writeFileSync(join(dir, "CLAUDE.md"), "- [x] **0a** a\n- [x] **0b** b\n- [x] **0c** c\n- [x] **0d** d\n");
}

describe("complete_phase ledger", () => {
	it("apply: true writes the file; successive calls accumulate; text says to write otherwise", () => {
		readyModule();
		const preview = plan({ action: "complete_phase", phase: "1" });
		expect(preview.nextStep).toMatch(/WRITE docs\/phase\.json/);
		expect(readPhaseState(dir)?.phases).toBeUndefined();

		const r1 = plan({ action: "complete_phase", phase: "1", apply: true });
		expect(r1.applied).toBe(true);
		expect(r1.files).toBeUndefined();
		plan({ action: "complete_phase", phase: "2", skipped: true, apply: true });
		expect(Object.keys(readPhaseState(dir)!.phases!).sort()).toEqual(["1", "2"]);
		expect(readPhaseState(dir)!.readyToScaffold).toBe(true);
	});

	it("check flags a ledger that is behind the module's evidence", () => {
		readyModule();
		write("manifest.json", JSON.stringify({ entities: { a: "./entities/a.json" } }));
		write("entities/a.json", JSON.stringify({ fields: { x: {} } }));
		plan({ action: "complete_phase", phase: "5", apply: true }); // later phase recorded, 1 missing
		const c = plan({ action: "check" });
		expect(c.ledgerBehind.join(" ")).toMatch(/Phase 1/);
		expect(c.summary).toMatch(/LEDGER BEHIND/);
	});
});

describe("change iterations", () => {
	it("begin_change keeps history; phases record against the iteration; phase 6 closes it", () => {
		readyModule();
		for (const p of ["1", "2", "3", "4", "5", "6"]) {
			plan({ action: "complete_phase", phase: p, skipped: p === "2" || p === "4", apply: true });
		}
		expect(plan({ action: "check" }).currentPhase).toBe("complete");
		expect(() => plan({ action: "begin_change" })).toThrow(/note/);

		plan({ action: "begin_change", note: "add approvals", statements: ["S-3"], apply: true });
		const st = readPhaseState(dir)!;
		expect(st.iterations).toHaveLength(1);
		expect(st.iterations![0]).toMatchObject({ id: "it-1", note: "add approvals", statements: ["S-3"] });
		expect(plan({ action: "check" }).currentPhase).toBe("1");
		expect(() => plan({ action: "begin_change", note: "again" })).toThrow(/still open/);

		const firstBuild = JSON.stringify(readPhaseState(dir)!.phases);
		plan({ action: "complete_phase", phase: "1", note: "new field", apply: true });
		plan({ action: "complete_phase", phase: "3", skipped: true, apply: true }); // skippable inside iteration
		expect(JSON.stringify(readPhaseState(dir)!.phases)).toBe(firstBuild);
		expect(readPhaseState(dir)!.iterations![0].phases["1"].note).toBe("new field");
		const r = plan({ action: "complete_phase", phase: "6", apply: true });
		expect(r.summary).toMatch(/closed/);
		expect(readPhaseState(dir)!.iterations![0].closedAt).toBeTruthy();
		expect(plan({ action: "check" }).currentPhase).toBe("complete");
	});

	it("end_change closes explicitly; old single-iteration files still work", () => {
		readyModule();
		writeFileSync(
			join(dir, "docs", "phase.json"),
			JSON.stringify({ readyToScaffold: true, phases: { "1": { completedAt: "2026-01-01" } } }),
		);
		expect(plan({ action: "check" }).currentPhase).toBe("2");
		plan({ action: "begin_change", note: "n", apply: true });
		plan({ action: "end_change", note: "done early", apply: true });
		expect(readPhaseState(dir)!.iterations![0].closeNote).toBe("done early");
		expect(() => plan({ action: "end_change" })).toThrow(/No open/);
		expect(plan({ action: "check" }).currentPhase).toBe("2");
	});
});

describe("CLAUDE.md ticks", () => {
	it("write_design / validate return a CLAUDE.md with all earlier phases ticked", () => {
		identity();
		write("docs/REQUIREMENTS.md", REQ + "mod_x");
		write("docs/DESIGN.md", DESIGN_BASE("- category\n- product"));
		// client never wrote the write_requirements result
		const d = plan({ action: "write_design", userConfirmed: true });
		expect(d.files["CLAUDE.md"]).toMatch(/- \[x\] \*\*0b\*\*/);
		expect(d.files["CLAUDE.md"]).toMatch(/- \[x\] \*\*0c\*\*/);
		const v = (() => {
			write("CLAUDE.md", d.files["CLAUDE.md"].replace("- [x] **0b**", "- [ ] **0b**"));
			return plan({
				action: "validate",
				checkResults: [{ check: "s", pass: true, detail: "ok" }],
			});
		})();
		for (const ph of ["0a", "0b", "0c", "0d"]) {
			expect(v.files["CLAUDE.md"]).toMatch(new RegExp(`- \\[x\\] \\*\\*${ph}\\*\\*`));
		}
	});

	it("check tolerates an unticked earlier box when a later one is ticked", () => {
		identity();
		write("CLAUDE.md", read("CLAUDE.md").replace("- [ ] **0c**", "- [x] **0c**"));
		const c = plan({ action: "check" });
		expect(c.currentPhase).toBe("0d");
	});
});

describe("validate structural checks", () => {
	const run = () => {
		const r = plan({ action: "validate" });
		return r.structuralChecks as Array<{ check: string; pass: boolean; detail: string; status?: string }>;
	};

	it("recognises numbered entity lists (was silently skipped as PASS)", () => {
		identity();
		write("docs/REQUIREMENTS.md", REQ + "mod_x");
		write("docs/DESIGN.md", DESIGN_BASE("1. category — tree\n2. product — item"));
		const rel = run().find((c) => c.check === "Relationship completeness")!;
		expect(rel.status).toBeUndefined();
		expect(rel.pass).toBe(true);
		expect(rel.detail).toMatch(/All entities/);
	});

	it("flags a missing entity from a numbered list, and a skipped check is labelled", () => {
		identity();
		write("docs/REQUIREMENTS.md", REQ + "mod_x");
		write("docs/DESIGN.md", DESIGN_BASE("1. category — tree"));
		expect(run().find((c) => c.check === "Relationship completeness")!.pass).toBe(false);

		write("docs/DESIGN.md", DESIGN_BASE("nothing parseable here"));
		const rel = run().find((c) => c.check === "Relationship completeness")!;
		expect(rel.status).toBe("skipped");
		expect(rel.detail).toMatch(/SKIPPED/);
	});

	it("warns (does not fail) when the four new sections are missing", () => {
		identity();
		write("docs/REQUIREMENTS.md", REQ + "mod_x");
		write("docs/DESIGN.md", DESIGN_BASE("- category\n- product"));
		const w = run().find((c) => c.check.startsWith("Design sections"))!;
		expect(w.pass).toBe(true);
		expect(w.status).toBe("warn");
		expect(w.detail).toMatch(/## Visibility/);
		write(
			"docs/DESIGN.md",
			DESIGN_BASE("- category\n- product") +
				"\n## Visibility\nx\n## Rules & Constraints\nx\n## Notifications\nx\n## Permissions Matrix\nx\n",
		);
		expect(run().find((c) => c.check.startsWith("Design sections"))!.status).toBeUndefined();
	});

	it("Permissions Matrix check: non-table, uncovered entities, missing statements, uncovered actions", () => {
		identity();
		write("docs/REQUIREMENTS.md", REQ + "mod_x");
		const design = (matrix: string, extra = "") =>
			DESIGN_BASE("- category\n- product") + extra + `\n## Permissions Matrix\n${matrix}\n`;
		const row = () => run().find((c) => c.check.startsWith("Permissions Matrix"))!;
		const T = (rows: string[]) => `| Role | Object | Rights | Statements |\n|---|---|---|---|\n${rows.join("\n")}`;

		write("docs/DESIGN.md", design("Buyers can do everything."));
		expect(row().status).toBe("warn");
		expect(row().detail).toMatch(/not a table/);

		// product covered via a dep.entity key; category missing; second row cites no statement
		write(
			"docs/DESIGN.md",
			design(T(["| mod_x.buyer | mod_x.product | SIU | S-1 |", "| mod_x.buyer | other | S | |"])),
		);
		expect(row().status).toBe("warn");
		expect(row().detail).toMatch(/no matrix row for entity: category/);
		expect(row().detail).not.toMatch(/no matrix row for entity:.*product/);
		expect(row().detail).toMatch(/1 row\(s\) cite no statement id/);

		// action listed in ## Actions without an action:<code> row
		write(
			"docs/DESIGN.md",
			design(
				T(["| mod_x.buyer | category | S | S-1 |", "| mod_x.buyer | product | S | S-1 |"]),
				"\n## Actions\n| approve | x |\n| ship | y |\n",
			),
		);
		expect(row().detail).toMatch(/Actions section with no 'action:<code>' row: approve, ship/);

		write(
			"docs/DESIGN.md",
			design(
				T([
					"| mod_x.buyer | category | S | S-1 |",
					"| mod_x.buyer | product | S | S-1 |",
					"| mod_x.buyer | action:approve | E | S-2 |",
					"| mod_x.buyer | action:ship | - | S-2 |",
				]),
				"\n## Actions\n| approve | x |\n| ship | y |\n",
			),
		);
		expect(row().status).toBeUndefined();
		expect(row().detail).toMatch(/4 row\(s\), 1 role\(s\)/);
	});

	it("reports duplicate and undefined statement ids at warn level", () => {
		identity();
		write("docs/REQUIREMENTS.md", REQ + "mod_x\n- S-1: a\n- S-1: dup\n| N-3 | notify |\n");
		write("docs/DESIGN.md", DESIGN_BASE("- category\n- product") + "\nCovers S-1, N-3 and R-9.\n");
		const w = run().find((c) => c.check === "Statement ids")!;
		expect(w.pass).toBe(true);
		expect(w.status).toBe("warn");
		expect(w.detail).toMatch(/duplicate.*S-1/);
		expect(w.detail).toMatch(/R-9/);
	});

	it("template includes the new sections", () => {
		identity();
		write("CLAUDE.md", read("CLAUDE.md").replace("- [ ] **0b**", "- [x] **0b**"));
		const c = plan({ action: "check" });
		for (const h of ["## Visibility", "## Rules & Constraints", "## Notifications", "## Permissions Matrix", "## Platform Limits"]) {
			expect(c.designTemplate).toContain(h);
		}
		expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
	});
});

describe("Phase 0b intake: rules, limits and exceptions", () => {
	it("0b returns a required question about rules, limits and exceptions and the completeness check", () => {
		identity();
		const c = plan({ action: "check" });
		expect(c.currentPhase).toBe("0b");
		expect(c.questions).toHaveLength(5);
		expect(c.questions[4]).toMatch(/rules, limits or exceptions/);
		expect(c.questions[4]).toMatch(/contractors, people who have left/);
		expect(c.followUpNote).toMatch(/required/);
		expect(c.followUpNote).toContain("dforge://reference/requirements-completeness");
	});
});

describe("Phase 0a asks only the name and languages", () => {
	it("returns two questions and tells the agent to decide code, dependencies and preset itself", () => {
		dir = mkdtempSync(join(tmpdir(), "dforge-mcp-plan-"));
		const c = plan({ action: "check" });
		expect(c.currentPhase).toBe("0a");
		expect(c.questions).toHaveLength(2);
		expect(c.questions[0]).toMatch(/display name/);
		expect(c.questions[1]).toMatch(/locales/);
		expect(c.nextStep).toMatch(/Decide the technical items yourself/);
		expect(c.nextStep).toMatch(/module code/);
		expect(c.nextStep).toMatch(/choose full when the user brings a requirements document/);
	});

	it("0b followUpNote runs the quiet platform check and points to the Platform Limits section", () => {
		identity();
		const c = plan({ action: "check" });
		expect(c.followUpNote).toMatch(/quiet platform check/);
		expect(c.followUpNote).toContain("## Platform Limits");
	});
});

describe("write_requirements gate: rules, limits and exceptions", () => {
	it("accepts a Russian heading about limits and exceptions", () => {
		identity();
		write(
			"docs/REQUIREMENTS.md",
			`${REQ}mod_x
## Ограничения и исключения
- Ничего особого не названо.
`,
		);
		const r = plan({ action: "write_requirements", userConfirmed: true });
		expect(r.summary).toMatch(/Phase 0b complete/);
	});

	it("a heading like Data and rules is not enough", () => {
		identity();
		write(
			"docs/REQUIREMENTS.md",
			`${REQ}mod_x
## Data and rules
- an invoice is linked to an order
`,
		);
		expect(() => plan({ action: "write_requirements", userConfirmed: true })).toThrow(/rules, limits and exceptions/);
	});

	it("refuses a REQUIREMENTS.md without a section about rules, limits and exceptions", () => {
		identity();
		write(
			"docs/REQUIREMENTS.md",
			`${REQ}mod_x
## Users
- someone does something
`,
		);
		expect(() => plan({ action: "write_requirements", userConfirmed: true })).toThrow(/rules, limits and exceptions/);
	});

	it("accepts it once the section exists, even when it says nothing special was named", () => {
		identity();
		write(
			"docs/REQUIREMENTS.md",
			`${REQ}mod_x
## Rules, limits and exceptions
- Nothing special was named.
`,
		);
		const r = plan({ action: "write_requirements", userConfirmed: true });
		expect(r.summary).toMatch(/Phase 0b complete/);
	});
});

describe("completeness check 7 covers how a document leaves the organisation", () => {
	it("names the way it is sent, the copies and who signs", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const text = readFileSync(join(__dirname, "..", "skills", "dforge-mcp-author", "references", "requirements-completeness.md"), "utf8");
		const row = text.split(String.fromCharCode(10)).find((l) => l.startsWith("| 7 |")) ?? "";
		expect(row).toMatch(/how it is sent/);
		expect(row).toMatch(/how many copies/);
	});
});
