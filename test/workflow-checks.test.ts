import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadContext } from "../src/tools/validate/context";
import { checkWorkflow } from "../src/tools/validate/workflow";

describe("workflow (status machine) checks", () => {
	let dir: string;
	const w = (rel: string, v: unknown) => {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), typeof v === "string" ? v : JSON.stringify(v, null, "\t"));
	};
	const status = (over: Record<string, unknown> = {}) => ({
		dbDatatype: "varchar",
		fieldTypeCd: "dropdown",
		flags: "VM",
		maxLen: 20,
		orderNum: 10,
		description: "Status",
		formula: "'draft'",
		params: { options: ["draft", "submitted", "approved"].map((v) => ({ label: v, value: v })) },
		...over,
	});
	const action = (code: string) => ({
		label: code,
		description: code,
		entityCode: "expense",
		executionMode: "single",
		script: code,
		isAsync: false,
	});
	const setup = (opts: { status?: Record<string, unknown>; scripts: Record<string, string> }) => {
		w("manifest.json", {
			packageFormat: 1,
			code: "wf",
			version: "1.0.0",
			displayName: "WF",
			entities: { expense: "./entities/expense.json" },
		});
		w("entities/expense.json", {
			description: "e",
			toString: "{title}",
			traits: ["identity"],
			fields: {
				title: { dbDatatype: "varchar", fieldTypeCd: "text", flags: "VEM", orderNum: 5, description: "t" },
				status: status(opts.status),
			},
		});
		w("ui/actions.json", Object.fromEntries(Object.keys(opts.scripts).map((k) => [k, action(k)])));
		for (const [k, v] of Object.entries(opts.scripts)) w(`logic/actions/${k}.dsl`, v);
	};
	const run = () => {
		const ctx = loadContext(dir);
		checkWorkflow(ctx);
		return ctx.issues.filter((i) => i.rule?.startsWith("wf:"));
	};
	const rules = () => run().map((i) => i.rule);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dforge-wf-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const good = {
		submit: "canExecute:\n    [status] = 'draft'\n\nexecute:\n    [status] = 'submitted'\n",
		approve: "canExecute:\n    [status] = 'submitted'\n\nexecute:\n    [status] = 'approved'\n",
	};

	it("is silent on a clean machine", () => {
		setup({ scripts: good });
		expect(run()).toEqual([]);
	});

	it("ignores a dropdown that no action drives", () => {
		setup({ status: { formula: undefined, flags: "VE" }, scripts: { noop: "execute:\n    [title] = 'x'\n" } });
		expect(run()).toEqual([]);
	});

	it("errors on a value that is not an option", () => {
		setup({ scripts: { ...good, bad: "canExecute:\n    [status] = 'draft'\nexecute:\n    [status] = 'aproved'\n" } });
		const i = run().find((x) => x.rule === "wf:status-unknown-value");
		expect(i?.level).toBe("error");
		expect(i?.message).toMatch(/'aproved'/);
	});

	it("warns when canExecute names an unknown status", () => {
		setup({ scripts: { ...good, ghost: "canExecute:\n    [status] = 'closed'\nexecute:\n    [status] = 'approved'\n" } });
		expect(rules()).toContain("wf:status-unknown-from");
	});

	it("warns on no default and on the E flag", () => {
		setup({ status: { formula: undefined, flags: "VEM" }, scripts: good });
		expect(rules()).toEqual(expect.arrayContaining(["wf:status-no-default", "wf:status-editable"]));
	});

	it("warns on a status nothing leads into and on one nothing leaves", () => {
		const options = ["draft", "submitted", "approved", "rejected"].map((v) => ({ label: v, value: v }));
		setup({ status: { params: { options } }, scripts: good });
		const found = run();
		expect(found.find((x) => x.rule === "wf:status-unreachable")?.message).toMatch(/'rejected'/);
		expect(found.find((x) => x.rule === "wf:status-no-exit")?.message).toMatch(/'approved'/);
	});

	it("leaves a column users can edit by hand to the editable warning only", () => {
		const options = ["draft", "submitted", "approved", "rejected"].map((v) => ({ label: v, value: v }));
		setup({ status: { flags: "VEM", params: { options } }, scripts: good });
		expect(rules()).toEqual(["wf:status-editable"]);
	});

	it("does not call the last option a dead end", () => {
		setup({ scripts: good });
		expect(rules()).not.toContain("wf:status-no-exit");
	});

	it("warns when an action can run from any status", () => {
		setup({ scripts: { ...good, reopen: "execute:\n    [status] = 'draft'\n" } });
		const i = run().find((x) => x.rule === "wf:transition-open");
		expect(i?.where).toMatch(/reopen/);
	});

	it("does not read comparisons or comments as writes", () => {
		setup({
			scripts: {
				...good,
				peek: "canExecute:\n    [status] = 'submitted'\nexecute:\n    // [status] = 'bogus'\n    if ([status] <= 'z') { [title] = 'x' }\n",
			},
		});
		expect(run()).toEqual([]);
	});
});
