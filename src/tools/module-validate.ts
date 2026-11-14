// Pre-flight whole-module validator. Read-only: loads every file and runs the
// CROSS-REFERENCE checks that per-tool validation can't see — the errors that
// otherwise only surface at pack/install (a slow, tenant-bound round trip).
//
// Catches: dangling FK/reference targets, the hidden-FK column missing for a
// Reference, view dataSources/columns pointing at unknown entities/fields, a
// grid-style view over an entity with no visible column, menu dataViewCode →
// missing view, role rights keyed on unknown entities/actions/reports, record-report
// attachments (param declared, entity known, source column mappable), reports with no label,
// entities with no Select grant, and docs/diagrams/*.json entity keys that
// resolve to nothing — a dependency key, or an own key close to a built
// entity's code; other own keys are planned entities (warnings only — diagrams are design-time). Returns a
// structured issue list in `_validate.json` plus a one-line summary; never writes anything.
//
// Each check lives in ./validate/ and reads the shared ValidateContext; this
// file runs them in order and shapes the result.

import { z } from "zod";
import type { ToolResult } from "./_helpers";
import type { CliValidate } from "./native-shell";
import { loadContext, type ValidateContext } from "./validate/context";
import {
	checkReferences,
	checkEntityViews,
	checkFieldSpecs,
	checkToString,
	checkSetAggregates,
} from "./validate/entities";
import { checkDataViews, checkVisibleColumns, checkViewGrouping, checkMenus } from "./validate/views";
import {
	checkRoleRights,
	checkSelectCoverage,
	checkPermissionsAgainstDesign,
	checkRoleReachability,
} from "./validate/security";
import {
	checkConstraintTranslations,
	checkMessageTranslations,
	checkTranslationCompleteness,
} from "./validate/translations";
import { checkActions, checkTriggersJobsWebhooks, checkActionDsl } from "./validate/logic";
import { checkFolders, checkDiagrams, checkMenuFolderCoverage } from "./validate/folders";
import { checkJsonSchemas } from "./validate/schemas";
import { checkTestScenarios } from "./validate/scenarios";
import { checkEmptySeedData, checkEmptyViewColumns, checkDependencyContracts } from "./validate/scaffold";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkReports } from "./validate/reports";
import { checkOutputs } from "./validate/outputs";

export const moduleValidateSchema = {
	moduleDir: z.string().describe("Path to the module root. Run this after authoring and before dforge_module_pack."),
	format: z
		.enum(["full", "summary"])
		.optional()
		.describe(
			"'full' (default): every error and warning listed one by one in _validate.json. 'summary': repeated " +
				"messages are grouped by rule with a count and 3 examples, which keeps the response small on a large " +
				"module (a 26-entity module can produce 60K+ characters in full); the complete list is written to a " +
				"file whose path is returned in `fullReport`. The `summary` line carries the error/warning counts in " +
				"both formats.",
		),
};

// Order matters only for the order issues are listed in (and so the summary's
// "first error").
const CHECKS: Array<(ctx: ValidateContext) => void> = [
	checkReferences,
	checkEntityViews,
	checkDataViews,
	checkVisibleColumns,
	checkViewGrouping,
	checkMenus,
	checkRoleRights,
	checkSelectCoverage,
	checkPermissionsAgainstDesign,
	checkRoleReachability,
	checkConstraintTranslations,
	checkFieldSpecs,
	checkToString,
	checkSetAggregates,
	checkActions,
	checkTriggersJobsWebhooks,
	checkActionDsl,
	checkFolders,
	checkDiagrams,
	checkReports,
	checkOutputs,
	checkTranslationCompleteness,
	checkMessageTranslations,
	checkMenuFolderCoverage,
	checkEmptySeedData,
	checkEmptyViewColumns,
	checkDependencyContracts,
	checkTestScenarios,
	checkJsonSchemas,
];

interface Issue {
	level: "error" | "warning";
	where: string;
	message: string;
	rule?: string;
}

/** Message with its variable parts (quoted names, braces, numbers) blanked, so repeats collapse into one rule. */
function ruleOf(i: Issue): string {
	if (i.rule) return `${i.where.split(" → ")[0].replace(/[^/\s:]+\.(json|dsl)(:\d+)?/g, "*.$1")} | ${i.rule}`;
	const where = i.where
		.split(" → ")[0]
		.replace(/[^/\s:]+\.(json|dsl)(:\d+)?/g, "*.$1")
		.replace(/\.[A-Za-z_][\w-]*$/, ".*");
	const msg = i.message
		.replace(/'[^']*'/g, "'…'")
		.replace(/"[^"]*"/g, '"…"')
		.replace(/\{[^}]*\}/g, "{…}")
		.replace(/\[[^\]]*\]/g, "[…]")
		.replace(/\d+/g, "N");
	return `${where} | ${msg}`;
}

function groupIssues(issues: Issue[]): Array<{ rule: string; count: number; examples: Issue[] }> {
	const groups = new Map<string, { rule: string; count: number; examples: Issue[] }>();
	for (const i of issues) {
		const key = ruleOf(i);
		const g = groups.get(key) ?? groups.set(key, { rule: key, count: 0, examples: [] }).get(key)!;
		g.count++;
		if (g.examples.length < 3) g.examples.push(i);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Which family a finding belongs to, for the summary line. */
function categoryOf(i: Issue): string {
	if (/\([\w-]+ schema\)\.?$/.test(i.message)) return "schema";
	const w = i.where;
	if (/\.dsl\b/.test(w) || w.startsWith("logic/functions")) return "dsl";
	if (w.startsWith("translations") || /^translations\b/.test(w)) return "translations";
	if (i.rule?.startsWith("perm:")) return "permissions";
	if (i.rule?.startsWith("out:")) return "outputs";
	if (w.startsWith("cli")) return "cli";
	return "other";
}

/**
 * "(schema: 234 in 27 files; dsl: 129; translations: 1)" — warnings by family,
 * largest first, so a pile of schema findings cannot hide behind "0 errors".
 */
function warningBreakdown(warnings: Issue[]): string {
	if (warnings.length === 0) return "";
	const byCat = new Map<string, { n: number; files: Set<string> }>();
	for (const w of warnings) {
		const c = categoryOf(w);
		const e = byCat.get(c) ?? byCat.set(c, { n: 0, files: new Set() }).get(c)!;
		e.n++;
		e.files.add(w.where.split(" → ")[0]);
	}
	const parts = [...byCat.entries()]
		.sort((a, b) => b[1].n - a[1].n)
		.slice(0, 4)
		.map(([c, e]) =>
			c === "schema" ? `schema: ${e.n} in ${e.files.size} file${e.files.size === 1 ? "" : "s"}` : `${c}: ${e.n}`,
		);
	return ` (${parts.join("; ")})`;
}

export function moduleValidate(args: z.infer<z.ZodObject<typeof moduleValidateSchema>>, cli?: CliValidate): ToolResult {
	const ctx = loadContext(args.moduleDir);
	for (const check of CHECKS) check(ctx);
	const { manifest, issues, err, warn, entities, viewCodes, roles } = ctx;

	// ── CLI static checks ──
	// The rules `module pack` enforces live in the CLI (ModuleStaticValidator);
	// running it keeps them in one place instead of re-implemented here.
	if (cli) {
		const res = cli(args.moduleDir);
		if ("unavailable" in res) {
			warn("cli", `CLI checks skipped, so pack may still fail: ${res.unavailable}`);
		} else {
			if (res.report.error) err("cli: package", res.report.error);
			for (const c of res.report.checks) if (!c.ok) err(`cli: ${c.name}`, c.message ?? "failed");
			for (const w of res.report.warnings) {
				// The offline pass already warns about a missing toString and a missing report label.
				const dup = issues.some(
					(i) =>
						(i.where === w.where && i.message.includes("toString") && w.message.includes("toString")) ||
						(i.level === "warning" && i.message === w.message),
				);
				if (!dup) warn(w.where, w.message);
			}
		}
	}

	// ── Result ──
	const errors = issues.filter((i) => i.level === "error");
	const warnings = issues.filter((i) => i.level === "warning");
	const clean = errors.length === 0 && warnings.length === 0;
	const summary = clean
		? `✓ ${manifest.code}: no cross-reference issues found across ${Object.keys(entities).length} entities, ${viewCodes.size} views, ${Object.keys(roles).length} roles.`
		: `${manifest.code}: ${errors.length} error(s), ${warnings.length} warning(s)${warningBreakdown(warnings)}.${errors.length ? ` First error: ${errors[0].where} — ${errors[0].message}` : ""}`;

	const fullJson = JSON.stringify({ ok: errors.length === 0, errors, warnings }, null, "\t") + "\n";
	if (args.format === "summary") {
		// The complete list goes to a file outside the module (so pack never sees it).
		let fullReport: string | undefined;
		try {
			const dir = path.join(os.tmpdir(), "dforge-validate");
			fs.mkdirSync(dir, { recursive: true });
			// Retention: drop reports older than a day so repeated runs don't pile up.
			const cutoff = Date.now() - 24 * 60 * 60 * 1000;
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith(".json")) continue;
				try {
					const p = path.join(dir, f);
					if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
				} catch {
					/* best effort */
				}
			}
			fullReport = path.join(
				dir,
				`${manifest.code}-${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.json`,
			);
			fs.writeFileSync(fullReport, fullJson);
		} catch {
			fullReport = undefined;
		}
		const grouped = {
			ok: errors.length === 0,
			format: "summary",
			counts: { errors: errors.length, warnings: warnings.length },
			errors: groupIssues(errors),
			warnings: groupIssues(warnings),
			fullReport,
		};
		return {
			summary: `${summary}${fullReport ? ` Full list: ${fullReport}.` : ""}`,
			files: { "_validate.json": JSON.stringify(grouped, null, "\t") + "\n" },
			warning: errors.length
				? `${errors.length} validation error(s) — fix before dforge_module_pack / dforge_module_install. Grouped in _validate.json.`
				: undefined,
		};
	}

	return {
		summary,
		files: {
			"_validate.json": fullJson,
		},
		warning: errors.length
			? `${errors.length} validation error(s) — fix before dforge_module_pack / dforge_module_install. Details in _validate.json.`
			: undefined,
	};
}
