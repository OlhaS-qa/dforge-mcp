import * as path from "node:path";
import { isReadyToScaffold } from "./_helpers";
import { applyToDisk } from "./apply";
import type { Args, PlanResult } from "./plan/types";
import { P0, DESIGN_TEMPLATE } from "./plan/templates";
import { fileExists, readFile, assertDocReady, tickChecklist } from "./plan/helpers";
import {
	buildPhaseCheck,
	handleCompletePhase,
	handleBeginChange,
	handleEndChange,
	handleNoteChange,
} from "./plan/build-phases";
import { handleValidate } from "./plan/design-checks";
export { planModuleSchema } from "./plan/types";

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export function planModule(rawArgs: Args): PlanResult {
	const result = dispatch(rawArgs);
	if (rawArgs.apply && result.files && Object.keys(result.files).length > 0) {
		const applied = applyToDisk(rawArgs.moduleDir, { summary: result.summary, files: result.files } as never);
		const { files: _files, ...rest } = result;
		return {
			...rest,
			applied: true,
			written: applied.written,
			nextStep: String(rest.nextStep ?? "").replace(
				/^(Write the updated [^.]*?\.|Write both files to disk\.)\s*/,
				"Files already written to disk (apply: true). ",
			),
		};
	}
	return result;
}

function dispatch(rawArgs: Args): PlanResult {
	const root = path.resolve(rawArgs.moduleDir);
	switch (rawArgs.action) {
		case "check":
			return handleCheck(root);
		case "write_identity":
			return handleWriteIdentity(root, rawArgs);
		case "write_requirements":
			return handleWriteRequirements(root, rawArgs);
		case "write_design":
			return handleWriteDesign(root, rawArgs);
		case "validate":
			return handleValidate(root, rawArgs);
		case "complete_phase":
			return handleCompletePhase(root, rawArgs);
		case "begin_change":
			return handleBeginChange(root, rawArgs);
		case "end_change":
			return handleEndChange(root, rawArgs);
		case "note_change":
			return handleNoteChange(root, rawArgs);
	}
}

// ─── check ────────────────────────────────────────────────────────────────────

function handleCheck(root: string): PlanResult {
	const claudePath = path.join(root, P0.identity);
	const reqPath = path.join(root, P0.requirements);
	const designPath = path.join(root, P0.design);

	const has0a = fileExists(claudePath);
	const claudeContent = has0a ? readFile(claudePath) : "";
	// 0b/0c file existence alone isn't "done" — the agent writes the draft to disk
	// before the user confirms it, so the CLAUDE.md checklist tick is the source of truth.
	// A later tick implies the earlier ones (an older write may have returned a
	// CLAUDE.md with only its own phase ticked and the client never ticked the rest).
	const ticked = (ph: string) => new RegExp(`- \\[x\\] \\*\\*${ph}\\*\\*`).test(claudeContent);
	const ready = has0a && isReadyToScaffold(root);
	const has0c = has0a && (ticked("0c") || ticked("0d") || ready);
	const has0b = has0a && (ticked("0b") || has0c);
	const has0d = has0c && ready;

	const completed: string[] = [];
	if (has0a) completed.push("0a");
	if (has0b) completed.push("0b");
	if (has0c) completed.push("0c");
	if (has0d) completed.push("0d");

	const allPhases = ["0a", "0b", "0c", "0d"];
	const pending = allPhases.filter((p) => !completed.includes(p));

	// Phase 0 done → hand off to the build/ship half, which tracks phases 1-6
	// from the ledger in docs/phase.json plus evidence from the module itself.
	if (has0d) return buildPhaseCheck(root);

	if (!has0a) {
		return {
			summary: "Phase 0 not started.",
			currentPhase: "0a",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0a — Module Identity. Ask the user these questions ONE AT A TIME. After each answer, restate " +
				"what you understood and confirm before continuing.",
			questions: [
				'What\'s the module\'s display name? (e.g. "Purchase Orders", "HR Leave Requests")',
				"What code should it use? (snake_case, letters + digits + underscores — becomes the DB schema name; " +
					"suggest a default derived from the display name)",
				"Does this module depend on any other dForge modules — e.g. needing entities from 'crm' or " +
					"'parties'? (admin and metadata are platform-implicit; list any others, or say None)",
				"English only, or which other locales should the module ship translations for (e.g. uk-UA)? English " +
					"is the base and needs no translation file.",
				"How complete should the initial scaffold be? (minimal = entities + default views + single admin " +
					"role; minimal-plus = + settings stubs; full = + logic stubs + seed data structure)",
			],
			writeAction:
				"Once all answers are collected and reflected back, call dforge_module_plan({ action: " +
				"'write_identity', moduleDir, displayName, code, dependencies, locales, preset }).",
		};
	}

	if (!has0b) {
		if (fileExists(reqPath)) {
			return {
				summary: "Phase 0a complete. A draft docs/REQUIREMENTS.md exists on disk but hasn't been confirmed yet.",
				currentPhase: "0b",
				completed,
				pending,
				readyToScaffold: false,
				nextStep:
					"Read docs/REQUIREMENTS.md. Give the user a short outline (section headings + counts) and gap status " +
					"(open items, or 'No gaps'), then ask them to review the file and reply YES, or describe what to " +
					"change. If they request changes, edit docs/REQUIREMENTS.md directly (targeted edits), summarize the " +
					"change in one line, and ask again. Once they reply YES, call dforge_module_plan({ action: " +
					"'write_requirements', moduleDir, userConfirmed: true }).",
			};
		}

		return {
			summary: "Phase 0a complete. Proceed to Phase 0b intake.",
			currentPhase: "0b",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0b — Intake. Ask the user these questions ONE AT A TIME in free-form prose. After each " +
				"answer, restate what you understood and confirm before continuing. Do NOT use pickers or predefined " +
				"options.",
			questions: [
				"In one sentence, what does this module do?",
				"Who will use this, and what does each type DO with it? (Capture as verb-led sentences, e.g. " +
					"'Department managers approve or reject pending requests'. NOT role labels like 'Approver — approves " +
					"requests'. Push back on vague answers like 'admins and users' — ask what each type does that the " +
					"other can't.)",
				"For each user type: which records and screens must it be able to reach to do that work, and what " +
					"must it NOT see or change? (Write the answers in REQUIREMENTS.md under '## Access Needs', one " +
					"bullet per user type: 'needs: … / must not: …', verb-led, no role codes. These become the " +
					"Permissions Matrix rows in 0c and the checks in Phase 5.)",
			],
			followUpNote:
				"After answers 1-2: ask any domain ambiguity questions that remain open (e.g. 'What counts as a " +
				"closed item?', 'Can anonymous users submit?'). Continue one at a time until no open questions " +
				"remain. Dependencies and locales are confirmed from Phase 0a — carry them into REQUIREMENTS.md " +
				"without re-asking.",
			writeAction:
				"Draft REQUIREMENTS.md and write it directly to docs/REQUIREMENTS.md on disk (do not paste it into " +
				"chat). Tell the user it's ready: give a short outline (section headings + counts) and gap status " +
				"('No gaps' or a one-line list), then ask them to review and reply YES, or describe what to change. " +
				"If they request changes, edit the file directly and ask again. Once they reply YES ('yes', 'looks " +
				"good', 'confirmed', 'LGTM'), call dforge_module_plan({ action: 'write_requirements', moduleDir, " +
				"userConfirmed: true }).",
		};
	}

	if (!has0c) {
		if (fileExists(designPath)) {
			return {
				summary: "Phase 0b complete. A draft docs/DESIGN.md exists on disk but hasn't been confirmed yet.",
				currentPhase: "0c",
				completed,
				pending,
				readyToScaffold: false,
				nextStep:
					"Read docs/DESIGN.md. Give the user a short outline (entity/status-machine counts, section headings) " +
					"and Gaps & Proposals status (open items, or 'No gaps'), then ask them to review the file and reply " +
					"YES, or describe what to change. If they request changes, edit docs/DESIGN.md directly (targeted " +
					"edits), summarize the change in one line, and ask again. Once they reply YES, call " +
					"dforge_module_plan({ action: 'write_design', moduleDir, userConfirmed: true }).",
			};
		}

		return {
			summary: "Phase 0b complete. Proceed to Phase 0c design.",
			currentPhase: "0c",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0c — Design. Re-read REQUIREMENTS.md, then draft DESIGN.md (use the designTemplate below) " +
				"with all 8 design items in a single message.",
			designTemplate: DESIGN_TEMPLATE,
			designItems: [
				"1. Entity list (ordered least-dependent → most-dependent, one-line purpose each)",
				"2. Fields per entity (key fields, status values, lookups, formulas, sequences)",
				"3. Relationship map (Mermaid erDiagram + FK table with required/optional column)",
				"4. Status machines (per-entity: values, transitions, canExecute guards, recovery paths)",
				"5. Actions (name, target entity, description, params)",
				"6. Seed data (entities needing initial rows, parent-before-child order)",
				"7. Reports & queries",
				"8. Special behaviors (soft-delete, sorting, webhooks, print templates)",
				"8a. Visibility (who sees which records, child records, how people bind to departments/roles)",
				"8b. Rules & Constraints (each rule with its enforcing MECHANISM: CHECK / trigger / action body / " +
					"canExecute own-record fields / text only)",
				"8c. Notifications (event -> recipient -> channel -> text)",
				"8d. Permissions Matrix (every role x entity and action, incl. trigger-only actions)",
			],
			gapDetection:
				"After drafting: run gap detection pass (FK optionality, status recovery, boolean-to-status smell, " +
				"set aggregation risk, deep navigation, self-referential FK, security coverage, seed data circular " +
				"refs). Add a 'Gaps & Proposals' section for each issue found. ALL gaps must be resolved before " +
				"Phase 0d.",
			writeAction:
				"Once gaps are resolved, write docs/DESIGN.md directly to disk (do not paste it into chat). Tell the " +
				"user it's ready: give a short outline (entity/status-machine counts, section headings) and Gaps & " +
				"Proposals status ('No gaps' or a one-line summary), then ask them to review and reply YES, or " +
				"describe what to change. If they request changes, edit the file directly and ask again. Once they " +
				"reply YES, call dforge_module_plan({ action: 'write_design', moduleDir, userConfirmed: true }).",
		};
	}

	// has0a + has0b + has0c, no 0d
	return {
		summary: "Phase 0c complete. Proceed to Phase 0d validation.",
		currentPhase: "0d",
		completed,
		pending,
		readyToScaffold: false,
		nextStep:
			"Phase 0d — Validation. Call dforge_module_plan({ action: 'validate', moduleDir }) to run structural " +
			"checks. If all pass, evaluate the returned semantic checks, then call validate again with " +
			"checkResults.",
	};
}

// ─── write_identity ───────────────────────────────────────────────────────────

function handleWriteIdentity(root: string, args: Args): PlanResult {
	const { displayName, code, dependencies = [], preset = "minimal" } = args;
	const locales = (args.locales ?? []).filter((l) => !/^en(-|$)/i.test(l.trim()));

	if (!displayName) throw new Error("displayName is required for write_identity.");
	if (!code) throw new Error("code is required for write_identity.");

	const depsText = dependencies.length > 0 ? dependencies.join(", ") : "None";
	const localesText = ["English (base, in the definitions)", ...locales].join(", ");

	const claudeMd = buildClaudeMd({ root, displayName, code, depsText, localesText, preset });

	return {
		summary: `Phase 0a complete — CLAUDE.md prepared for module '${code}'.`,
		files: { [P0.identity]: claudeMd },
		nextStep:
			"Write CLAUDE.md to disk. Then start Phase 0b intake: ask the user (1) 'In one sentence, what does " +
			"this module do?' (2) 'Who will use this, and what does each type DO with it?' — capture as verb-led " +
			"sentences, not role labels. Ask domain ambiguity follow-ups until no open questions remain. Draft " +
			"REQUIREMENTS.md and write it directly to docs/REQUIREMENTS.md on disk, give the user a short " +
			"outline + gap status, wait for explicit YES, then call write_requirements with userConfirmed: true.",
	};
}

function buildClaudeMd(opts: {
	root: string;
	displayName: string;
	code: string;
	depsText: string;
	localesText: string;
	preset: string;
}): string {
	const { root, displayName, code, depsText, localesText, preset } = opts;
	return `# ${displayName} — dForge Module

## For AI assistants

- All structural changes go through dforge-mcp tools — do not hand-edit entity/UI/security JSON files.
- Read \`docs/DESIGN.md\` before proposing any changes to entities, fields, or relationships.
- Run \`dforge_module_plan({ action: "check", moduleDir: "..." })\` to check Phase 0 status before any other tool.
- Do NOT call \`dforge_module_create\` until \`dforge_module_plan\` validate returns \`readyToScaffold: true\`.

## Module identity

| Field | Value |
|-------|-------|
| Code | \`${code}\` |
| Display name | ${displayName} |
| Dependencies | ${depsText} |
| Locales | ${localesText} |
| Preset | ${preset} |

## Module status

- [x] **0a** Identity — \`CLAUDE.md\`
- [ ] **0b** Requirements — \`docs/REQUIREMENTS.md\`
- [ ] **0c** Design — \`docs/DESIGN.md\`
- [ ] **0d** Validation — \`docs/VALIDATION.md\`
- [ ] **1** Scaffolded — \`manifest.json\`

**Next step:** Phase 0b — run intake questions (purpose, user types, domain ambiguities), draft \`docs/REQUIREMENTS.md\` and write it to disk, get explicit user YES, then call \`dforge_module_plan({ action: "write_requirements", moduleDir, userConfirmed: true })\`.

## Pack and install (after Phase 0 complete)

\`\`\`
dforge_module_pack({ moduleDir: "${root}" })
dforge_module_install({ moduleDir: "${root}" })
\`\`\`
`;
}

// ─── write_requirements ───────────────────────────────────────────────────────

function handleWriteRequirements(root: string, args: Args): PlanResult {
	const reqPath = path.join(root, P0.requirements);
	assertDocReady(reqPath, P0.requirements);

	if (!args.userConfirmed) {
		throw new Error(
			"User confirmation required — ask the user to review docs/REQUIREMENTS.md (already written to disk) " +
				'and wait for an explicit YES ("yes", "looks good", "confirmed", "LGTM", or equivalent) before ' +
				"calling write_requirements with userConfirmed: true.",
		);
	}

	const claudePath = path.join(root, P0.identity);
	if (!fileExists(claudePath)) {
		throw new Error("CLAUDE.md not found — complete Phase 0a (write_identity) first.");
	}

	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0b",
		"Phase 0c — design docs/DESIGN.md (8 design items + gap detection pass), write it to disk, get " +
			'explicit user YES, then call `dforge_module_plan({ action: "write_design", moduleDir, ' +
			"userConfirmed: true })`.",
	);

	return {
		summary: "Phase 0b complete — docs/REQUIREMENTS.md confirmed.",
		files: {
			[P0.identity]: updatedClaude,
		},
		designTemplate: DESIGN_TEMPLATE,
		nextStep:
			"Write the updated CLAUDE.md to disk. Now design DESIGN.md using the designTemplate above: 8 design " +
			"items (entity list, fields per entity, relationship map, status machines, actions, seed data, " +
			"reports, special behaviors). Run gap detection pass, add Gaps & Proposals section, resolve all " +
			"gaps. Write docs/DESIGN.md to disk, give the user a short outline (entity/status-machine counts, " +
			"section headings) plus Gaps & Proposals status, wait for explicit YES, then call write_design with " +
			"userConfirmed: true.",
	};
}

// ─── write_design ─────────────────────────────────────────────────────────────

function handleWriteDesign(root: string, args: Args): PlanResult {
	const designPath = path.join(root, P0.design);
	assertDocReady(designPath, P0.design);

	if (!args.userConfirmed) {
		throw new Error(
			"User confirmation required — ask the user to review docs/DESIGN.md (already written to disk, " +
				"including the Gaps & Proposals section) and wait for an explicit YES before calling write_design " +
				"with userConfirmed: true. Ensure all Gaps & Proposals items are resolved.",
		);
	}

	const claudePath = path.join(root, P0.identity);
	if (!fileExists(claudePath)) throw new Error("CLAUDE.md not found — complete Phase 0a first.");
	if (!fileExists(path.join(root, P0.requirements))) {
		throw new Error("docs/REQUIREMENTS.md not found — complete Phase 0b first.");
	}

	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0c",
		'Phase 0d — call `dforge_module_plan({ action: "validate", moduleDir: "..." })` to run structural ' +
			"checks, then provide semantic checkResults.",
	);

	return {
		summary: "Phase 0c complete — docs/DESIGN.md confirmed.",
		files: {
			[P0.identity]: updatedClaude,
		},
		nextStep:
			"Write the updated CLAUDE.md to disk. Now run Phase 0d validation: call dforge_module_plan({ action: " +
			"'validate', moduleDir }) for the structural pre-check, evaluate the returned semantic checks, then " +
			"call validate again with all checkResults.",
	};
}
