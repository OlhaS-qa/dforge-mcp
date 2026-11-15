import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { outputIdsDefined, parseOutputs, placeholdersOfForTest } from "./outputs-helpers";
import { loadContext } from "../src/tools/validate/context";
import { checkOutputs } from "../src/tools/validate/outputs";
import { handleValidate } from "../src/tools/plan/design-checks";

const HEAD = "| Output | Kind | Source | Mechanism | Run by | Verified by |\n|---|---|---|---|---|---|\n";

describe("parseOutputs", () => {
	it("reads rows with kind, sources, mechanism, runners", () => {
		const p = parseOutputs(
			`\n${HEAD}| O-1 Hire order | print | employee.full_name, employee.hire_date | print:hire_order | hr.officer, hr.head | manual: sample |\n| O-2 Feed | api | employee | webhook:hr_feed | system | test:feed |\n`,
		);
		expect(p.machine).toBe(true);
		expect(p.problems).toEqual([]);
		expect(p.rows[0]).toMatchObject({
			id: "O-1",
			kind: "print",
			sources: ["employee.full_name", "employee.hire_date"],
			mechanism: { type: "print", code: "hire_order" },
			runBy: ["hr.officer", "hr.head"],
		});
		expect(p.rows[1].mechanism).toEqual({ type: "webhook", code: "hr_feed" });
	});

	it("flags bad kind, bad mechanism, empty runner and duplicates", () => {
		const p = parseOutputs(
			`\n${HEAD}| O-1 a | pdf | x | thing | | |\n| O-1 b | print | x | print:y | system | manual |\n`,
		);
		const t = p.problems.join("\n");
		expect(t).toMatch(/Kind 'pdf'/);
		expect(t).toMatch(/Mechanism 'thing'/);
		expect(t).toMatch(/'Run by' is empty/);
		expect(t).toMatch(/O-1 appears twice/);
	});

	it("treats 'None' as an explicit no-outputs statement", () => {
		expect(parseOutputs("\nNone\n").none).toBe(true);
		expect(parseOutputs("<!-- c -->\n- None, screens only\n").none).toBe(true);
		expect(parseOutputs("Reports are needed.").machine).toBe(false);
	});

	it("collects ids defined in REQUIREMENTS", () => {
		expect(outputIdsDefined("- O-1 Hire order: PDF, per hire\n- **O-2** Tax report\n| O-3 | x |\nprose O-9\n")).toEqual(
			["O-1", "O-2", "O-3"],
		);
	});
});

describe("print template placeholders", () => {
	it("reads root columns, ignores child loops, filters and settings", () => {
		const names = placeholdersOfForTest(
			"{{ invoice_number }} {{ _fmt.total }} {{ _settings.logo }} {% for l in lines %}{{ l.qty }}{{ desc }}{% endfor %}{% if paid > 0 %}x{% endif %}",
		);
		expect([...names].sort()).toEqual(["invoice_number", "paid", "total"]);
	});
});

describe("Outputs in plan validate", () => {
	let dir: string;
	const w = (rel: string, v: string) => {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), v);
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dforge-out-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const design = (outputs: string) =>
		`# Design\n\n## Entity List\n- employee — person\n\n## Relationship Map\n\n## Permissions Matrix\n\n| Role | Object | Rights | Statements |\n|---|---|---|---|\n| hr.officer | employee | S | S-1 |\n\n## Outputs\n${outputs}\n`;
	const outputCheck = (req: string, des: string) => {
		w("CLAUDE.md", "# x\n");
		w("docs/REQUIREMENTS.md", req + "\n" + "Padding line for the substantive-docs check. ".repeat(4));
		w("docs/DESIGN.md", des);
		const r = handleValidate(dir, { action: "validate", moduleDir: dir } as never);
		const results = ((r as unknown as { structuralChecks?: unknown[] }).structuralChecks ?? []) as Array<{
			check: string;
			detail: string;
			status?: string;
		}>;
		return results.find((c) => c.check.startsWith("Outputs"));
	};

	it("warns when REQUIREMENTS has no Outputs section", () => {
		const c = outputCheck("# Req\nS-1 people\n", design("None"));
		expect(c?.status).toBe("warn");
		expect(c?.detail).toMatch(/no '## Outputs' section/);
	});

	it("traces ids both ways and checks the runner's access", () => {
		const row = (id: string, runner: string, src = "employee.full_name") =>
			`${HEAD}| ${id} Hire order | print | ${src} | print:hire_order | ${runner} | manual |\n`;
		const ok = outputCheck("# Req\n## Outputs\n- O-1 Hire order\n", design(row("O-1", "hr.officer")));
		expect(ok?.detail).toMatch(/1 output/);
		const missing = outputCheck("# Req\n## Outputs\n- O-1 a\n- O-2 b\n", design(row("O-1", "hr.officer")));
		expect(missing?.detail).toMatch(/no row in the DESIGN.md table: O-2/);
		const noAccess = outputCheck("# Req\n## Outputs\n- O-1 a\n", design(row("O-1", "hr.clerk")));
		expect(noAccess?.detail).toMatch(/hr.clerk runs it, but the Permissions Matrix has no 'S' on 'employee'/);
		const badSource = outputCheck("# Req\n## Outputs\n- O-1 a\n", design(row("O-1", "hr.officer", "ghost.name")));
		expect(badSource?.detail).toMatch(/'ghost' which is not in the Entity List|not in the Entity List/);
	});

	it("accepts an explicit None on both sides", () => {
		const c = outputCheck("# Req\n## Outputs\nNone\n", design("None"));
		expect(c?.status).toBeUndefined();
	});
});

describe("Outputs in module validate", () => {
	let dir: string;
	const w = (rel: string, v: unknown) => {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), typeof v === "string" ? v : JSON.stringify(v, null, "\t"));
	};
	const field = { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VE", orderNum: 10, description: "x" };
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dforge-outv-"));
		w("manifest.json", {
			packageFormat: 1,
			code: "hr",
			version: "1.0.0",
			displayName: "HR",
			entities: { employee: "./entities/employee.json" },
		});
		w("entities/employee.json", {
			description: "e",
			toString: "{full_name}",
			traits: ["identity"],
			fields: { full_name: field },
		});
		w("security/roles.json", {
			"hr.officer": { description: "o", rights: { employee: "S" } },
			"hr.clerk": { description: "c", rights: {} },
		});
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = () => {
		const ctx = loadContext(dir);
		checkOutputs(ctx);
		return ctx.issues.map((i) => `${i.rule}: ${i.message}`);
	};

	it("flags a print template that reads a column the entity does not have", () => {
		w("ui/print_templates.json", { hire_order: { entityCd: "employee", file: "hire_order.html" } });
		w("print_templates/hire_order.html", "<p>{{ full_name }} {{ hire_date }}</p>");
		const out = run().join("\n");
		expect(out).toMatch(/out:print-placeholder.*'hire_date'/);
		expect(out).not.toMatch(/'full_name'/);
	});

	it("flags a print template that reads an undeclared setting", () => {
		w("settings.json", { director_name: { fieldTypeCd: "text", baseDatatypeCd: "string" } });
		w("ui/print_templates.json", {
			o: { entityCd: "employee", template: "{{ full_name }} {{ _settings.director_name }} {{ _settings.stamp }}" },
		});
		const out = run().join("\n");
		expect(out).toMatch(/out:print-setting.*'_settings.stamp'/);
		expect(out).not.toMatch(/_settings.director_name/);
	});

	it("checks Excel export templates and an xlsx output row", () => {
		w("ui/export_templates.json", {
			list: { entityCd: "employee", file: "list.xlsx" },
			bad: { entityCd: "ghost", file: "x.csv" },
		});
		w(
			"docs/DESIGN.md",
			`# D\n\n## Outputs\n${HEAD}| O-1 List | export | employee.full_name | xlsx:list | hr.officer | manual: x |\n| O-2 Other | export | employee.full_name | xlsx:nope | hr.officer | manual: x |\n`,
		);
		const out = run().join("\n");
		expect(out).toMatch(/out:xlsx-file.*export_templates\/list.xlsx/);
		expect(out).toMatch(/out:xlsx-entity.*'ghost'/);
		expect(out).toMatch(/out:xlsx-file.*not an .xlsx/);
		expect(out).toMatch(/out:not-built.*xlsx:nope/);
		expect(out).not.toMatch(/no-access/);
	});

	it("flags a missing template file and an unknown entity", () => {
		w("ui/print_templates.json", {
			a: { entityCd: "employee", file: "nope.html" },
			b: { entityCd: "ghost", template: "x" },
		});
		const out = run().join("\n");
		expect(out).toMatch(/out:print-file/);
		expect(out).toMatch(/out:print-entity/);
	});

	it("traces the design's outputs into the module", () => {
		w("ui/print_templates.json", { hire_order: { entityCd: "employee", template: "{{ full_name }}" } });
		w(
			"docs/DESIGN.md",
			`# D\n\n## Outputs\n${HEAD}| O-1 Hire order | print | employee.full_name | print:hire_order | hr.officer | manual: x |\n| O-2 Tax | report | employee.salary | report:tax | hr.clerk | test:nope |\n`,
		);
		const out = run().join("\n");
		expect(out).toMatch(/out:not-built.*report:tax/);
		expect(out).toMatch(/out:source.*'employee' has no column 'salary'/);
		expect(out).toMatch(/out:test-missing.*nope/);
		expect(out).not.toMatch(/O-1/);
	});

	it("flags a runner without the right the mechanism needs", () => {
		w("ui/print_templates.json", { hire_order: { entityCd: "employee", template: "{{ full_name }}" } });
		w(
			"docs/DESIGN.md",
			`# D\n\n## Outputs\n${HEAD}| O-1 Hire order | print | employee.full_name | print:hire_order | hr.clerk | manual: x |\n`,
		);
		expect(run().join("\n")).toMatch(/out:no-access.*hr.clerk.*needs 'S'/);
	});

	it("flags export columns that data.export will not write", () => {
		w("entities/employee.json", {
			description: "e",
			toString: "{full_name}",
			traits: ["identity"],
			fields: {
				full_name: field,
				secret: { ...field, flags: "E" },
				age: { ...field, columnType: "F", formula: "1" },
			},
		});
		w(
			"docs/DESIGN.md",
			`# D\n\n## Outputs\n${HEAD}| O-1 Staff | export | employee.full_name, employee.secret, employee.age | export:employee | hr.officer | manual: x |\n`,
		);
		const out = run().join("\n");
		expect(out).toMatch(/out:export-column.*'secret': it lacks the V flag/);
		expect(out).toMatch(/out:export-column.*'age': columnType 'F'/);
		expect(out).not.toMatch(/'full_name'/);
		expect(out).not.toMatch(/out:no-access/); // hr.officer holds S on employee
	});

	it("rejects exporting a report and an unknown export entity", () => {
		w(
			"docs/DESIGN.md",
			`# D\n\n## Outputs\n${HEAD}| O-1 Tax | export | employee | report:tax | hr.officer | manual: x |\n| O-2 Ghosts | export | ghost | export:ghost | hr.officer | manual: x |\n`,
		);
		const out = run().join("\n");
		expect(out).toMatch(/a report cannot be exported/);
		expect(out).toMatch(/out:not-built.*export:ghost/);
	});

	it("checks that a print/mail action calls printPdf/sendEmail, and that a job never prints", () => {
		w("ui/actions.json", {
			make_pdf: { label: "PDF", entityCode: "employee", executionMode: "single", script: "make_pdf" },
			send: { label: "Send", entityCode: "employee", executionMode: "single", script: "send" },
		});
		w("logic/actions/make_pdf.dsl", "sendEmail('a@b.c', 'hi', 'x')\n");
		w("logic/actions/send.dsl", "let f = printPdf('employee', { employee_id: [employee_id] }, 'hire_order')\n");
		w("logic/jobs.json", { jobs: [{ code: "nightly", action: "send", cron: "0 0 * * *" }] });
		w(
			"docs/DESIGN.md",
			`# D\n\n## Outputs\n${HEAD}| O-1 Order PDF | print | employee | action:make_pdf | hr.officer | manual: x |\n| O-2 Mail | mail | employee | action:send | hr.officer | manual: x |\n| O-3 Nightly | mail | employee | job:nightly | schedule | manual: x |\n`,
		);
		const out = run().join("\n");
		expect(out).toMatch(/out:mechanism-mismatch.*never calls printPdf/);
		expect(out).toMatch(/out:mechanism-mismatch.*never calls sendEmail/);
		expect(out).toMatch(/out:print-in-job.*nightly/);
	});
});
