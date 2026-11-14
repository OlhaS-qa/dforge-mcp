import * as path from "node:path";
import { phaseStateJson } from "../_helpers";
import { sectionBody, entityListCodes, sectionCodes } from "../design-doc";
import { MATRIX_FORMAT_HINT, parsePermissionsMatrix } from "../permissions-matrix";
import type { Args, PlanResult } from "./types";
import { P0 } from "./templates";
import { fileExists, readFile, tickChecklist } from "./helpers";

// ─── validate ─────────────────────────────────────────────────────────────────

const SEMANTIC_CHECK_DESCRIPTIONS = [
	{
		name: "Locale coverage",
		description:
			"Do the locales listed in CLAUDE.md match the translation scope implied in REQUIREMENTS.md?",
	},
	{
		name: "Persona → entity coverage",
		description:
			"Does every user persona listed in REQUIREMENTS.md map to at least one entity in DESIGN.md that they interact with?",
	},
	{
		name: "Core process coverage",
		description:
			"Does every process in REQUIREMENTS.md Core Processes have a corresponding entity, action, or status machine in DESIGN.md?",
	},
	{
		name: "Entity traceability",
		description:
			"Can every entity in DESIGN.md Entity List be traced to a stated need in REQUIREMENTS.md? No invented entities.",
	},
	{
		name: "Status machine completeness",
		description:
			"Does every entity with a status field have a fully documented machine (all values, transitions, guards, recovery path)?",
	},
	{
		name: "Action completeness",
		description:
			"Does every verb in REQUIREMENTS.md Core Processes that implies a user-triggered operation appear in DESIGN.md Actions table?",
	},
	{
		name: "Seed data coverage",
		description:
			"If REQUIREMENTS.md implies initial reference data or starting state, is it covered in DESIGN.md Seed Data section?",
	},
	{
		name: "Visibility & permissions completeness",
		description:
			"Does DESIGN.md say who sees which records (including child records and how people bind to departments/roles) and give a Permissions Matrix covering every role x entity and every action, trigger-only actions included?",
	},
	{
		name: "Rules enforcement mechanism",
		description:
			"Does every business rule in REQUIREMENTS.md appear in DESIGN.md Rules & Constraints with the mechanism that enforces it (CHECK constraint / trigger / action body / canExecute on own-record fields / text only) — and is 'text only' a deliberate, stated choice?",
	},
	{
		name: "Notification coverage",
		description:
			"Does every notification or alert in REQUIREMENTS.md have a DESIGN.md Notifications row (event -> recipient -> channel -> text)?",
	},
];

interface CheckResult {
	check: string;
	pass: boolean;
	detail: string;
	/**
	 * Non-blocking outcomes: 'warn' = something to look at (does not fail the
	 * gate), 'skipped' = the check could not run (must NOT read as PASS).
	 */
	status?: "warn" | "skipped";
}

const STATEMENT_ID = /\b([SNVURP])-(\d+)\b/g;

/** Statement definitions: an ID at the start of a line / list item / table cell / bold. */
function statementDefinitions(doc: string): string[] {
	const out: string[] = [];
	for (const line of doc.replace(/\r\n/g, "\n").split("\n")) {
		const m = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+|\|\s*|#{1,6}\s+)?[*_`[(]*([SNVURP]-\d+)\b/);
		if (m) out.push(m[1]);
	}
	return out;
}

function runStructuralChecks(root: string): CheckResult[] {
	const claudePath = path.join(root, P0.identity);
	const reqPath = path.join(root, P0.requirements);
	const designPath = path.join(root, P0.design);

	// Check 11: Docs present & substantive
	const missingDocs: string[] = [];
	if (!fileExists(claudePath)) missingDocs.push("CLAUDE.md");
	if (!fileExists(reqPath)) missingDocs.push("docs/REQUIREMENTS.md");
	if (!fileExists(designPath)) missingDocs.push("docs/DESIGN.md");

	if (missingDocs.length > 0) {
		return [
			{
				check: "Docs present & substantive",
				pass: false,
				detail: `Missing: ${missingDocs.join(", ")}`,
			},
		];
	}

	const reqContent = readFile(reqPath);
	const designContent = readFile(designPath);

	const emptyDocs: string[] = [];
	if (reqContent.trim().length < 100) emptyDocs.push("docs/REQUIREMENTS.md");
	if (designContent.trim().length < 100) emptyDocs.push("docs/DESIGN.md");

	if (emptyDocs.length > 0) {
		return [
			{
				check: "Docs present & substantive",
				pass: false,
				detail: `Appears empty or too short (under 100 chars): ${emptyDocs.join(", ")}`,
			},
		];
	}

	const results: CheckResult[] = [
		{ check: "Docs present & substantive", pass: true, detail: "All 3 docs exist with content." },
	];

	// Check 1: Identity consistency — code + display name in CLAUDE.md appear in REQUIREMENTS.md
	const claudeContent = readFile(claudePath);
	const codeMatch = claudeContent.match(/\|\s*Code\s*\|\s*`([^`]+)`/);
	const nameMatch = claudeContent.match(/\|\s*Display name\s*\|\s*([^\n|]+)/);
	const code = codeMatch?.[1]?.trim();
	const displayName = nameMatch?.[1]?.trim();

	if (!code || !displayName) {
		results.push({
			check: "Identity consistency",
			pass: false,
			detail: "Could not extract code or display name from CLAUDE.md Module identity table — was it hand-edited?",
		});
	} else {
		const reqLower = reqContent.toLowerCase();
		const found = reqLower.includes(code.toLowerCase()) || reqLower.includes(displayName.toLowerCase());
		results.push({
			check: "Identity consistency",
			pass: found,
			detail: found
				? `Module identity (${code} / ${displayName}) referenced in REQUIREMENTS.md.`
				: `Module code '${code}' and display name '${displayName}' not found in REQUIREMENTS.md. Verify both docs describe the same module.`,
		});
	}

	// Check 6: Relationship completeness — every entity in Relationship Map appears in Entity List
	const knownEntities = entityListCodes(designContent);

	const relMapText = sectionBody(designContent, "Relationship Map") ?? "";
	const referencedEntities: string[] = [];
	for (const line of relMapText.split("\n")) {
		const entityDef = line.match(/^\s{2,}([a-z][a-z0-9_]*)\s*\{/);
		if (entityDef) referencedEntities.push(entityDef[1]);
		const relLine = line.match(/\b([a-z][a-z0-9_]*)\s+[|}o]{2}[-.]{2}[|{o]{2}\s+([a-z][a-z0-9_]*)\b/);
		if (relLine) {
			referencedEntities.push(relLine[1]);
			referencedEntities.push(relLine[2]);
		}
	}

	if (knownEntities.size === 0 || referencedEntities.length === 0) {
		const why =
			sectionBody(designContent, "Entity List") === null
				? "no '## Entity List' section"
				: knownEntities.size === 0
					? "no entity names recognised in '## Entity List' (expected list items like '- name', '1. name — ...', or table rows)"
					: sectionBody(designContent, "Relationship Map") === null
						? "no '## Relationship Map' section"
						: "no relationships recognised in '## Relationship Map' (expected a mermaid erDiagram)";
		results.push({
			check: "Relationship completeness",
			pass: true,
			status: "skipped",
			detail: `SKIPPED (not verified): ${why}. Verify manually.`,
		});
	} else {
		const missing = [...new Set(referencedEntities.filter((e) => !knownEntities.has(e)))];
		results.push({
			check: "Relationship completeness",
			pass: missing.length === 0,
			detail:
				missing.length === 0
					? "All entities in Relationship Map appear in Entity List."
					: `Entities in Relationship Map not found in Entity List: ${missing.join(", ")}`,
		});
	}

	// Warn-level: sections every real design needed (older docs may lack them).
	const wantedSections = ["Visibility", "Rules & Constraints", "Notifications", "Permissions Matrix"];
	const missingSections = wantedSections.filter((t) => sectionBody(designContent, t) === null);
	results.push({
		check: "Design sections (Visibility, Rules & Constraints, Notifications, Permissions Matrix)",
		pass: true,
		...(missingSections.length ? { status: "warn" as const } : {}),
		detail:
			missingSections.length === 0
				? "All four sections present."
				: `WARN: missing section(s) in DESIGN.md: ${missingSections.map((t) => "## " + t).join(", ")}. Add them (see designTemplate) — each rule needs its enforcing mechanism, every role x entity/action needs a matrix row. Not blocking for older docs.`,
	});

	// Warn-level: the matrix must be machine-readable and cover the design.
	{
		const matrixBody = sectionBody(designContent, "Permissions Matrix");
		if (matrixBody !== null) {
			const m = parsePermissionsMatrix(matrixBody);
			const problems: string[] = [];
			if (!m.machine) {
				problems.push(`the matrix is not a table with Role / Object / Rights columns. ${MATRIX_FORMAT_HINT}`);
			} else {
				problems.push(...m.problems);
				const objects = new Set(m.rows.map((r) => r.object));
				const uncovered = [...entityListCodes(designContent)].filter((e) => !objects.has(e) && ![...objects].some((o) => o.endsWith(`.${e}`)));
				if (uncovered.length) problems.push(`no matrix row for entity: ${uncovered.join(", ")} (add a row, or '-' to deny)`);
				const noWhy = m.rows.filter((r) => r.rights !== "-" && r.statements.length === 0 && !/\.admin$/.test(r.role));
				if (noWhy.length) problems.push(`${noWhy.length} row(s) cite no statement id (Statements column), e.g. ${noWhy[0].role} / ${noWhy[0].object}`);
				if (m.rows.length > 0) {
					const actions = [...sectionCodes(designContent, "Actions")].filter((a) => !objects.has(`action:${a}`));
					if (actions.length) problems.push(`action(s) in the Actions section with no 'action:<code>' row: ${actions.join(", ")} (a trigger-only action still needs a row naming who may run it, or '-')`);
				}
			}
			results.push({
				check: "Permissions Matrix (machine-readable, covers entities and actions)",
				pass: true,
				...(problems.length ? { status: "warn" as const } : {}),
				detail: problems.length ? `WARN: ${problems.join("; ")}.` : `${m.rows.length} row(s), ${new Set(m.rows.map((r) => r.role)).size} role(s).`,
			});
		}
	}

	// Warn-level: REQUIREMENTS carries per-user-type access needs.
	if (!/^#{1,3}[ \t]+.*\baccess\b/im.test(reqContent)) {
		results.push({
			check: "Access Needs in REQUIREMENTS.md",
			pass: true,
			status: "warn" as const,
			detail:
				"WARN: REQUIREMENTS.md has no '## Access Needs' section. For each user type write what it must be able to reach and what it must NOT see or change (verb-led, no role codes) — the Permissions Matrix and Phase 5 are checked against it.",
		});
	}

	// Warn-level: statement IDs (S-1, N-3, V-2, U-1, R-4, P-1) in REQUIREMENTS / SPEC vs DESIGN.
	const specPath = path.join(root, "docs", "SPEC.md");
	const specDocs = [reqContent, ...(fileExists(specPath) ? [readFile(specPath)] : [])];
	const defs = specDocs.flatMap(statementDefinitions);
	if (defs.length > 0) {
		const seen = new Set<string>();
		const dupes = new Set<string>();
		for (const d of defs) (seen.has(d) ? dupes : seen).add(d);
		const referenced = new Set<string>();
		for (const m of designContent.matchAll(STATEMENT_ID)) referenced.add(`${m[1]}-${m[2]}`);
		const undefinedRefs = [...referenced].filter((r) => !seen.has(r));
		const problems: string[] = [];
		if (dupes.size) problems.push(`duplicate statement ids: ${[...dupes].join(", ")}`);
		if (undefinedRefs.length) {
			problems.push(`ids referenced in DESIGN.md but not defined in REQUIREMENTS/SPEC: ${undefinedRefs.join(", ")}`);
		}
		results.push({
			check: "Statement ids",
			pass: true,
			...(problems.length ? { status: "warn" as const } : {}),
			detail: problems.length
				? `WARN: ${problems.join("; ")}.`
				: `${seen.size} statement id(s) defined; no duplicates; every id referenced in DESIGN.md is defined.`,
		});
	}

	// Check 10: Gap resolution — scan Gaps & Proposals for unresolved markers
	const gapsBody = sectionBody(designContent, "Gaps & Proposals");
	const gapsMatch = gapsBody === null ? null : [gapsBody, gapsBody];
	if (!gapsMatch) {
		results.push({
			check: "Gap resolution",
			pass: true,
			detail: "No Gaps & Proposals section in DESIGN.md.",
		});
	} else {
		const gapsText = gapsMatch[1];
		const openPatterns = [/\bTBD\b/i, /\bto be determined\b/i, /\bunresolved\b/i, /\bopen:\b/i, /\bneeds clarification\b/i];
		const found = openPatterns.filter((p) => p.test(gapsText)).map((p) => p.source);
		results.push({
			check: "Gap resolution",
			pass: found.length === 0,
			detail:
				found.length === 0
					? "Gaps & Proposals section present with no open-item markers."
					: `Possible unresolved gaps (matched: ${found.join(", ")}). Resolve all gaps before Phase 0d.`,
		});
	}

	return results;
}

export function handleValidate(root: string, args: Args): PlanResult {
	const structuralResults = runStructuralChecks(root);
	const structuralFailed = structuralResults.filter((r) => !r.pass);

	if (!args.checkResults) {
		// First call: structural pre-check only
		if (structuralFailed.length > 0) {
			return {
				summary: `Structural pre-check: ${structuralFailed.length} check(s) failed. Fix before proceeding.`,
				structuralChecks: structuralResults,
				nextStep:
					"Fix the structural failures listed above, update the relevant document(s), then call dforge_module_plan({ action: 'validate', moduleDir }) again.",
			};
		}

		return {
			summary:
				"Structural checks passed. Evaluate the semantic checks below against the Phase 0 docs, then call validate with checkResults.",
			structuralChecks: structuralResults,
			semanticChecks: SEMANTIC_CHECK_DESCRIPTIONS,
			nextStep:
				`Evaluate each semantic check against the Phase 0 docs — read docs/REQUIREMENTS.md and docs/DESIGN.md from disk (and CLAUDE.md) if they aren't already in your context — then call dforge_module_plan({ action: 'validate', moduleDir, checkResults: [...] }) with your results for all ${SEMANTIC_CHECK_DESCRIPTIONS.length} checks.`,
		};
	}

	// Second call: merge structural + semantic, write VALIDATION.md if all pass
	if (structuralFailed.length > 0) {
		return {
			summary: `Structural checks still failing — fix documents first.`,
			structuralChecks: structuralResults,
		};
	}

	const allResults: CheckResult[] = [...structuralResults, ...args.checkResults];
	const failedAll = allResults.filter((r) => !r.pass);

	if (failedAll.length > 0) {
		return {
			summary: `Validation failed: ${failedAll.length} check(s) did not pass.`,
			failures: failedAll,
			nextStep:
				"Fix the issues above in the relevant Phase 0 documents. Then call validate again (starting from the first call, without checkResults, to re-run structural checks).",
		};
	}

	// All pass → write VALIDATION.md and tick 0d in CLAUDE.md
	const today = new Date().toISOString().slice(0, 10);
	const rows = allResults
		.map((r, i) => {
			const res = !r.pass ? "❌ FAIL" : r.status === "skipped" ? "⚠️ SKIPPED" : r.status === "warn" ? "⚠️ WARN" : "✅ PASS";
			return `| ${i + 1} | ${r.check} | ${res} | ${r.detail.replace(/\|/g, "\\|")} |`;
		})
		.join("\n");

	const validationMd = `# Validation Report

*Generated: ${today}*

## Phase 0 Pre-Scaffold Design-Doc Checks

| # | Check | Result | Detail |
|---|-------|--------|--------|
${rows}

**Result: ✅ ALL DESIGN-DOC CHECKS PASSED**${allResults.some((r) => r.status) ? " (with warnings / skipped checks above — review them)" : ""}

> Scope: these checks validate the **Phase 0 design documents** only (identity, requirements,
> design consistency). They do **not** inspect generated entity / UI / security / DSL artifacts —
> those are validated by the platform at install (Phase 6). A pass here unlocks scaffolding; it is
> not a guarantee the module installs. Use the Phase 6 pre-pack self-review before packing.

readyToScaffold: true
`;

	const claudePath = path.join(root, P0.identity);
	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0d",
		"Phase 0 complete — call `dforge_module_create({ moduleDir: \"...\", ... })` to scaffold the module.",
	);

	return {
		summary:
			"Phase 0d complete — design docs validated (readyToScaffold: true). Note: this validates the design docs only; generated artifacts are checked by the platform at install.",
		readyToScaffold: true,
		files: {
			[P0.identity]: updatedClaude,
			[P0.validation]: validationMd,
			// Machine-readable gate marker — the scaffold check parses this, not the
			// Markdown report above.
			[P0.phaseState]: phaseStateJson({ phase: "0d", readyToScaffold: true, validatedAt: today }),
		},
		nextStep:
			"Write both files to disk. Phase 0 is complete. Now call dforge_module_create({ moduleDir, code, displayName, entities, preset }) to scaffold the module.",
	};
}
