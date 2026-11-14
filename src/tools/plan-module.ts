import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
	PHASE_STATE_FILE,
	phaseStateJson,
	isReadyToScaffold,
	readPhaseState,
	markPhase,
	beginIteration,
	noteIteration,
	endIteration,
	openIteration,
	modulePaths,
	readJsonOrDefault,
	checkSecurityCoverage,
	BUILD_PHASES,
	type BuildPhase,
	type FileMap,
	entityFilePath,
} from "./_helpers";
import { applyToDisk } from "./apply";

// Phase 0 doc paths (relative to module root)
const P0 = {
	identity: "CLAUDE.md",
	requirements: "docs/REQUIREMENTS.md",
	design: "docs/DESIGN.md",
	validation: "docs/VALIDATION.md",
	phaseState: PHASE_STATE_FILE,
} as const;

// docs/DESIGN.md template. Returned to the agent (as `designTemplate`) at the
// 0b→0c handoff and on the 0c resume path, so the template lives in exactly one
// place and is delivered just-in-time — instead of sitting permanently in the
// skill prompt. The section headers (## Entity List / ## Relationship Map /
// ## Gaps & Proposals) MUST stay in sync with the regexes in runStructuralChecks.
// Visibility / Rules & Constraints / Notifications / Permissions Matrix are WARN-
// level in the structural check (older docs without them keep working).
const DESIGN_TEMPLATE = `# Design Document
<!-- written after Phase 0c approval — edit with care -->

## Entity List
<name — one-line purpose, ordered least- to most-dependent>

## Fields per Entity
### <EntityName>
<key fields, status values, formulas, number sequences>

## Relationship Map
<!-- crow's-foot cardinality: ||--o{ = required N:1 (child must have a parent); |o--o{ = optional N:1. One edge per FK; replace names with your entities. -->
\`\`\`mermaid
erDiagram
    parent_entity ||--o{ child_entity : "verb"
    lookup_entity |o--o{ child_entity : "verb"
\`\`\`

| Relationship (child FK → parent PK) | Required |
|-------------------------------------|----------|
| child_entity.parent_id → parent_entity.id | required |
| child_entity.lookup_id → lookup_entity.id | optional |

Total FKs: <N>

## Status Machines
### <EntityName>
| Status | Transitions via | canExecute guard | Recovery |
|--------|----------------|-----------------|----------|

## Actions
| Name | Target Entity | Description | Params |
|------|--------------|-------------|--------|

## Seed Data
<entity name — rows needed, in parent-before-child order>

## Number Sequences
<column → pattern, or "None">

## Reports & Queries
<report/query name — entity, key columns; or "None">

## Special Behaviors
<entity — soft-delete? sorting? webhooks? print templates? — or "None">

## Visibility
<who sees which records — per role/persona and entity, INCLUDING child records (do they follow the parent's visibility?) and how people bind to departments/roles/teams (which field or table links a user to a department)>

## Rules & Constraints
| Rule (spec statement id if any) | Mechanism | Where |
|---|---|---|
| <rule> | CHECK constraint / trigger / action body / canExecute (own-record fields only) / text only | <entity.field or action> |

## Notifications
| Event | Recipient | Channel | Text |
|---|---|---|---|

## Permissions Matrix
<every role x entity (Select/Insert/Update/Delete) and every action (Execute) — INCLUDING trigger-only actions that no user calls directly>

## Gaps & Proposals
<findings from the gap detection pass, or omit this section if none>

---
*Approved: <date>*
`;

// ─── Schema ───────────────────────────────────────────────────────────────────

export const planModuleSchema = {
	action: z
		.enum([
			"check",
			"write_identity",
			"write_requirements",
			"write_design",
			"validate",
			"complete_phase",
			"begin_change",
			"end_change",
			"note_change",
		])
		.describe(
			"Sub-command: 'check' = current lifecycle state (Phase 0 sub-phase, or the build/ship phase once Phase 0 is done) + which skill to run next; 'write_identity' = Phase 0a; 'write_requirements' = Phase 0b; 'write_design' = Phase 0c; 'validate' = Phase 0d; 'complete_phase' = record a build phase (1-6) as done or deliberately skipped; 'begin_change' = open a new change iteration on a finished module (note required) so check/complete_phase work against it without overwriting history; 'end_change' = close the open iteration explicitly; 'note_change' = append `statements` (deduped) and/or a `note` to the open iteration without recording a phase.",
		),
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the module directory. Ask the user for this before the first call.",
		),
	// ── write_identity fields (Phase 0a) ────────────────────────────────
	displayName: z
		.string()
		.optional()
		.describe("[write_identity] Human-readable module name, e.g. 'Purchase Orders'."),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe(
			"[write_identity] snake_case module code, e.g. 'purchase_orders'. Becomes the DB schema name.",
		),
	dependencies: z
		.array(z.string())
		.optional()
		.describe(
			"[write_identity] Other dForge module codes this module depends on. admin + metadata are always implicit.",
		),
	locales: z
		.array(z.string())
		.optional()
		.describe("[write_identity] Locales besides English, e.g. ['uk-UA', 'de-DE'] — recorded in CLAUDE.md only; declare them in manifest.supportedLocales and run dforge_translation_sync to create the files. English is the base: its text lives in the definitions and needs no file. Default: [] (English only)."),
	preset: z
		.enum(["minimal", "minimal-plus", "full"])
		.optional()
		.describe(
			"[write_identity] Scaffold depth: minimal = entities + views + role; full = + settings + seed-data stubs.",
		),
	// ── write_requirements / write_design fields (Phase 0b / 0c) ────────
	userConfirmed: z
		.boolean()
		.optional()
		.describe(
			"[write_requirements, write_design] MUST be true — only set after the user has reviewed the on-disk draft (docs/REQUIREMENTS.md / docs/DESIGN.md, already written by you) and explicitly confirmed (replied YES / 'looks good' / 'confirmed').",
		),
	// ── validate fields (Phase 0d) ───────────────────────────────────────
	checkResults: z
		.array(
			z.object({
				check: z.string().describe("Check name, e.g. 'Persona → entity coverage'."),
				pass: z.boolean(),
				detail: z.string().describe("One sentence explaining the pass or failure."),
			}),
		)
		.optional()
		.describe(
			"[validate] Semantic check results from agent evaluation. Omit on the first call (structural pre-check only). Provide after evaluating the returned semanticChecks.",
		),
	// ── complete_phase fields (Phases 1-6) ───────────────────────────────
	phase: z
		.enum(BUILD_PHASES)
		.optional()
		.describe(
			"[complete_phase] Which build phase finished: '1' domain, '2' behavior, '3' views/reports, '4' polish, '5' security, '6' verify.",
		),
	skipped: z
		.boolean()
		.optional()
		.describe(
			"[complete_phase] True when the phase was deliberately skipped rather than done (only valid for the optional phases 2 and 4). Recording it stops a resumed session from re-proposing work the user already declined.",
		),
	note: z
		.string()
		.optional()
		.describe(
			"[complete_phase, end_change] One-line record of what was done or why it was skipped. [begin_change] REQUIRED: what the change is.",
		),
	statements: z
		.array(z.string())
		.optional()
		.describe(
			"[begin_change, complete_phase, note_change] Spec statement ids this change affects (e.g. ['S-3','R-4']). Recorded on the iteration; later calls append (deduped) the ones found to be affected afterwards.",
		),
	apply: z
		.boolean()
		.optional()
		.describe(
			"When true, WRITE the resulting files (docs/phase.json, CLAUDE.md, ...) to disk here instead of returning them for the client to write. Recommended for complete_phase / begin_change / end_change: the ledger is a read-modify-write of the file on disk, so a client that skips a write (or writes two results out of order) loses phases.",
		),
};

type Args = z.infer<z.ZodObject<typeof planModuleSchema>>;

/**
 * This tool's result is NOT a ToolResult. Most actions return lifecycle state —
 * the current phase, the questions to ask, the next step, the skill to run next
 * — with no files at all; only the write actions carry a `files` map for the
 * client to write. The shape is the contract, so it's typed here rather than
 * cast to ToolResult at the registration site (a cast would silently absorb a
 * real mismatch).
 */
export interface PlanResult {
	/** One-line human-readable status. Always present. */
	summary: string;
	/** Files for the client to write — only on the write actions. */
	files?: FileMap;
	/** Action-specific fields: currentPhase, questions, nextStep, nextSkill, … */
	[key: string]: unknown;
}

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

// ─── Build phases (1-6) ───────────────────────────────────────────────────────
//
// Phase 0 is tracked by which artifact files exist. Phases 1-6 are tracked by a
// LEDGER in docs/phase.json plus evidence derived from the module itself. Before
// this, a resumed session had to guess the last completed phase by
// cross-referencing inspect output — which can't tell "Phase 2 skipped
// deliberately" from "Phase 2 not started", and can't tell whether the user has
// signed off. The ledger records intent; the evidence catches drift.

/** Which skill owns each stretch of the lifecycle. */
const SKILL_FOR_PHASE: Record<string, string> = {
	"0a": "dforge-module-design",
	"0b": "dforge-module-design",
	"0c": "dforge-module-design",
	"0d": "dforge-module-design",
	"1": "dforge-module-build",
	"2": "dforge-module-build",
	"3": "dforge-module-build",
	"4": "dforge-module-build",
	"5": "dforge-module-build",
	"6": "dforge-module-ship",
};

const PHASE_TITLES: Record<BuildPhase, string> = {
	"1": "Domain — entities, fields, relations (required)",
	"2": "Behavior — actions, triggers, jobs, webhooks (optional)",
	"3": "Views + menus, reports (3a grids required)",
	"4": "Polish — settings, translations, seed data (optional)",
	"5": "Security — roles + rights matrix (5a required)",
	"6": "Verify — validate, pack, install (required)",
};

/** Phases the module can't ship without. 2 and 4 are legitimately skippable. */
const REQUIRED_PHASES: BuildPhase[] = ["1", "3", "5", "6"];

interface BuildEvidence {
	scaffolded: boolean;
	entityCount: number;
	entitiesWithoutFields: string[];
	entitiesWithoutView: string[];
	entitiesWithoutSelect: string[];
	actionCount: number;
	/** Entities with at least one field besides the scaffold's stub `name`. */
	entitiesBeyondStub: number;
	/** Entries in logic/triggers.json + logic/jobs.json + logic/webhooks.json. */
	automationCount: number;
	viewCount: number;
	roleCount: number;
}

/** Read what the module itself proves, independent of the ledger. */
function gatherEvidence(root: string): BuildEvidence {
	const paths = modulePaths(root);
	const empty: BuildEvidence = {
		scaffolded: false,
		entityCount: 0,
		entitiesWithoutFields: [],
		entitiesWithoutView: [],
		entitiesWithoutSelect: [],
		actionCount: 0,
		entitiesBeyondStub: 0,
		automationCount: 0,
		viewCount: 0,
		roleCount: 0,
	};
	if (!fileExists(paths.manifest)) return empty;

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(readFile(paths.manifest));
	} catch {
		return empty;
	}

	const entityMap = (manifest.entities ?? {}) as Record<string, string>;
	const names = Object.keys(entityMap).filter((n) => !n.includes("."));
	const entitiesWithoutFields: string[] = [];
	let entitiesBeyondStub = 0;
	for (const name of names) {
		const abs = entityFilePath(root, entityMap[name]);
		if (!fileExists(abs)) {
			entitiesWithoutFields.push(name);
			continue;
		}
		try {
			const e = JSON.parse(readFile(abs)) as { fields?: Record<string, unknown> };
			const keys = Object.keys(e.fields ?? {});
			if (keys.length === 0) entitiesWithoutFields.push(name);
			if (keys.some((k) => k !== "name")) entitiesBeyondStub++;
		} catch {
			entitiesWithoutFields.push(name);
		}
	}

	const views = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.dataViews, {});
	const covered = new Set<string>();
	for (const v of Object.values(views)) {
		for (const s of (v.dataSources as Array<Record<string, unknown>> | undefined) ?? []) {
			if (typeof s.entityCode === "string") covered.add(s.entityCode);
		}
	}

	let entitiesWithoutSelect: string[] = [];
	try {
		entitiesWithoutSelect = checkSecurityCoverage(root).uncoveredEntities;
	} catch {
		entitiesWithoutSelect = names;
	}

	return {
		scaffolded: true,
		entityCount: names.length,
		entitiesWithoutFields,
		entitiesWithoutView: names.filter((n) => !covered.has(n)),
		entitiesWithoutSelect,
		actionCount: Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.actions, {})).length,
		entitiesBeyondStub,
		automationCount: [paths.triggers, paths.jobs, path.join(root, "logic", "webhooks.json")].reduce(
			(n, p) => n + Object.keys(readJsonOrDefault<Record<string, unknown>>(p, {})).length,
			0,
		),
		viewCount: Object.keys(views).length,
		roleCount: Object.keys(readJsonOrDefault<Record<string, unknown>>(paths.roles, {})).length,
	};
}

/**
 * `check`'s build/ship result. A narrower PlanResult: the fields callers read
 * are declared, so `handleCompletePhase` can consume them without casting the
 * whole thing back to an untyped bag.
 */
export interface BuildPhaseCheck extends PlanResult {
	currentPhase: BuildPhase | "complete";
	/** Which authoring skill owns the next phase. Absent once complete. */
	nextSkill?: string;
	nextStep: string;
	/** What the module itself proves is unfinished, regardless of the ledger. */
	gaps: string[];
	completed: BuildPhase[];
	pending: BuildPhase[];
	/** Set while a change iteration (begin_change) is open. */
	iteration?: { id: string; note: string; startedAt: string; statements?: string[] };
	/** Phases the module's own state proves done but the ledger does not record. */
	ledgerBehind?: string[];
}

/**
 * Phases whose evidence is present in the module but missing from the ledger.
 * The usual cause: the client did not write the docs/phase.json that an earlier
 * complete_phase returned (or two results were written out of order).
 */
function ledgerDrift(ev: BuildEvidence, recorded: (p: BuildPhase) => boolean): string[] {
	if (!ev.scaffolded) return [];
	const out: string[] = [];
	// Only evidence the scaffold itself cannot produce counts. dforge_module_create
	// writes a stub `name` field, a default grid per entity, menus and an admin
	// role with rights on everything, so "views cover every entity" (Phase 3) and
	// "a role grants Select on every entity" (Phase 5) are true straight after
	// scaffolding and would wrongly report "Phase 3, 5 look done" when only Phase 1
	// is recorded. Those two are therefore NOT used as drift evidence: they stay
	// under `gaps` (what is missing), not under `ledgerBehind` (what looks done).
	const evidence: Partial<Record<BuildPhase, string>> = {};
	if (ev.entityCount > 0 && ev.entitiesWithoutFields.length === 0 && ev.entitiesBeyondStub > 0) {
		evidence["1"] = `${ev.entitiesBeyondStub} of ${ev.entityCount} entities have fields beyond the scaffold stub`;
	}
	if (ev.actionCount + ev.automationCount > 0) {
		evidence["2"] = `${ev.actionCount} action(s), ${ev.automationCount} trigger/job/webhook(s)`;
	}
	for (const p of BUILD_PHASES) {
		if (evidence[p] && !recorded(p)) out.push(`Phase ${p} (${evidence[p]})`);
	}
	// A later phase recorded while an earlier required one is not.
	const lastRecorded = [...BUILD_PHASES].reverse().find(recorded);
	if (lastRecorded) {
		for (const p of REQUIRED_PHASES) {
			if (p < lastRecorded && !recorded(p) && !out.some((o) => o.startsWith(`Phase ${p} `))) {
				out.push(`Phase ${p} (a later phase ${lastRecorded} is recorded)`);
			}
		}
	}
	return out;
}

/**
 * The build/ship half of `check`, reached once Phase 0d has passed. Returns the
 * next phase to work on, the skill that owns it, and — where the module's own
 * state contradicts the ledger — the specific gaps.
 */
function buildPhaseCheck(root: string, override?: PhaseStateLike): BuildPhaseCheck {
	const state = override ?? readPhaseState(root);
	const open = openIteration(state);
	const ledger = open ? open.phases : (state?.phases ?? {});
	const ev = gatherEvidence(root);

	const recorded = (p: BuildPhase) => Boolean(ledger[p]);
	const completed = BUILD_PHASES.filter(recorded);

	// Gaps are what the module PROVES is unfinished, regardless of the ledger.
	const gaps: string[] = [];
	if (!ev.scaffolded) {
		gaps.push("no manifest.json — the module has not been scaffolded (dforge_module_create).");
	} else {
		if (ev.entitiesWithoutFields.length > 0) {
			gaps.push(
				`Phase 1: entities with no fields yet: ${ev.entitiesWithoutFields.join(", ")}.`,
			);
		}
		if (ev.entitiesWithoutView.length > 0) {
			gaps.push(
				`Phase 3a: entities with no data view: ${ev.entitiesWithoutView.join(", ")} (every entity needs a default grid).`,
			);
		}
		if (ev.entitiesWithoutSelect.length > 0) {
			gaps.push(
				`Phase 5a: entities with no role granting Select: ${ev.entitiesWithoutSelect.join(", ")} (dforge_module_pack refuses to build until fixed).`,
			);
		}
	}

	// Evidence-vs-ledger drift only makes sense for the first build; an iteration
	// legitimately touches a subset of phases.
	const ledgerBehind = open ? [] : ledgerDrift(ev, recorded);
	const driftNote = ledgerBehind.length
		? `LEDGER BEHIND THE MODULE: ${ledgerBehind.join("; ")} look done but are not recorded in ${P0.phaseState} — a complete_phase result was probably not written to disk. Re-record them (complete_phase with apply: true) before continuing. `
		: "";

	if (open) {
		// Change iteration: only Phase 6 (verify) is mandatory, and it closes the
		// iteration. Other phases are recorded when touched, or skipped.
		const itInfo = { id: open.id, note: open.note, startedAt: open.startedAt, statements: open.statements };
		const nextIt = BUILD_PHASES.find((p) => !recorded(p)) as BuildPhase;
		return {
			summary: `Change iteration ${open.id} open ("${open.note}"). Recorded in it: ${completed.join(", ") || "none"}. Next: Phase ${nextIt} — ${PHASE_TITLES[nextIt]}.`,
			currentPhase: nextIt,
			phase0: "complete",
			readyToScaffold: true,
			iteration: itInfo,
			completed,
			pending: BUILD_PHASES.filter((p) => !recorded(p)),
			gaps,
			evidence: ev,
			nextSkill: SKILL_FOR_PHASE[nextIt],
			nextStep:
				`Iteration ${open.id}: work only the phases this change touches with the '${SKILL_FOR_PHASE[nextIt]}' skill. ` +
				`Record each with dforge_module_plan({ action: 'complete_phase', moduleDir, phase, note, apply: true }); a phase the change does not touch is recorded with skipped: true (any phase may be skipped inside an iteration). ` +
				`Completing Phase 6 closes the iteration (or call action 'end_change'). The first-build ledger is not modified.` +
				(gaps.length > 0 ? ` Open gaps: ${gaps.join(" ")}` : ""),
		};
	}

	// Next phase = the first required-or-unrecorded phase that isn't done.
	const next = BUILD_PHASES.find((p) => !recorded(p));
	const allRequiredDone = REQUIRED_PHASES.every(recorded);

	if (!next || (allRequiredDone && gaps.length === 0)) {
		return {
			summary: `Module complete — all build phases recorded${gaps.length ? " (with open gaps, see below)" : ""}.${driftNote ? " " + driftNote.trim() : ""}`,
			...(ledgerBehind.length ? { ledgerBehind } : {}),
			currentPhase: "complete",
			phase0: "complete",
			readyToScaffold: true,
			completed,
			pending: [],
			gaps,
			evidence: ev,
			nextStep:
				gaps.length > 0
					? "Every phase is recorded as done, but the module still shows the gaps listed above. Resolve them, then re-run dforge_module_validate."
					: "Nothing left to do. Run dforge_module_validate for a final check if the module has changed since install. To change a finished module, call dforge_module_plan({ action: 'begin_change', moduleDir, note }) first — it opens an iteration so the change is recorded without overwriting this ledger.",
		};
	}

	return {
		summary: `Phase 0 complete. ${completed.length ? `Recorded: ${completed.join(", ")}. ` : ""}Next: Phase ${next} — ${PHASE_TITLES[next]}.${driftNote ? " " + driftNote.trim() : ""}`,
		...(ledgerBehind.length ? { ledgerBehind } : {}),
		currentPhase: next,
		phase0: "complete",
		readyToScaffold: true,
		completed,
		pending: BUILD_PHASES.filter((p) => !recorded(p)),
		optionalPhases: ["2", "4"],
		gaps,
		evidence: ev,
		nextSkill: SKILL_FOR_PHASE[next],
		nextStep:
			driftNote +
			`Run the '${SKILL_FOR_PHASE[next]}' skill and work Phase ${next} (${PHASE_TITLES[next]}). ` +
			(gaps.length > 0 ? `Open gaps to resolve first: ${gaps.join(" ")} ` : "") +
			`When the phase is done (or the user declines an optional one), record it with ` +
			`dforge_module_plan({ action: 'complete_phase', moduleDir, phase: '${next}', note: '...', apply: true }).`,
	};
}

function handleCompletePhase(root: string, args: Args): PlanResult {
	if (!args.phase) {
		throw new Error(
			`complete_phase needs a 'phase' — one of ${BUILD_PHASES.join(", ")}. (Phase 0 sub-phases are recorded by write_identity / write_requirements / write_design / validate.)`,
		);
	}
	if (!isReadyToScaffold(root)) {
		throw new Error(
			"Phase 0 has not passed validation yet — there are no build phases to record. Call dforge_module_plan({ action: 'check', moduleDir }) to see what Phase 0 still needs.",
		);
	}
	const open = openIteration(readPhaseState(root));
	if (!open && args.skipped && args.phase !== "2" && args.phase !== "4") {
		throw new Error(
			`Phase ${args.phase} (${PHASE_TITLES[args.phase]}) is required and can't be marked skipped. Only Phases 2 and 4 are optional (inside a change iteration, any phase may be skipped).`,
		);
	}

	const { json, iteration, closedIteration } = markPhase(root, args.phase, {
		skipped: args.skipped,
		note: args.note,
		statements: args.statements,
	});
	// `next` is evaluated against the NEW ledger (not on disk yet unless applied).
	const { currentPhase, nextSkill, nextStep, gaps } = buildPhaseCheck(
		root,
		JSON.parse(json) as PhaseStateLike,
	);

	const files: FileMap = { [P0.phaseState]: json };
	if (!args.skipped) {
		const claudePath = path.join(root, "CLAUDE.md");
		if (fileExists(claudePath)) {
			const claude = readFile(claudePath);
			const ticked = claude.replace(new RegExp(`- \\[ \\] (\\*\\*${args.phase}\\*\\*)`), "- [x] $1");
			if (ticked !== claude) files["CLAUDE.md"] = ticked;
		}
	}

	return {
		summary: `Recorded Phase ${args.phase} as ${args.skipped ? "SKIPPED" : "complete"}${iteration ? ` in iteration ${iteration}` : ""}${args.note ? ` — ${args.note}` : ""}${closedIteration ? ` (iteration ${iteration} closed)` : ""}.`,
		files,
		next: { currentPhase, nextSkill, nextStep, gaps },
		nextStep: `${writeLedgerNote(args)} Then continue: ${nextStep}`,
	};
}

type PhaseStateLike = NonNullable<ReturnType<typeof readPhaseState>>;

function writeLedgerNote(args: Args): string {
	return args.apply
		? `${P0.phaseState} written to disk (apply: true).`
		: `WRITE ${P0.phaseState} to disk BEFORE the next dforge_module_plan call — the ledger is merged with the file on disk, so an unwritten result is lost (and parallel calls overwrite each other). Pass apply: true to have the tool write it.`;
}

function handleBeginChange(root: string, args: Args): PlanResult {
	if (!args.note || !args.note.trim()) {
		throw new Error(
			"begin_change needs a 'note' — one line saying what the change is (and optionally 'statements': the spec ids it affects).",
		);
	}
	if (!isReadyToScaffold(root)) {
		throw new Error(
			"Phase 0 has not passed validation yet — there is no finished module to change. Call dforge_module_plan({ action: 'check', moduleDir }).",
		);
	}
	const { json, iteration } = beginIteration(root, {
		note: args.note.trim(),
		statements: args.statements,
	});
	return {
		summary: `Change iteration ${iteration.id} opened — "${iteration.note}".`,
		files: { [P0.phaseState]: json },
		iteration,
		nextStep: `${writeLedgerNote(args)} Then update docs/REQUIREMENTS.md / docs/DESIGN.md for this change, work the phases it touches (dforge-module-build), and record each with complete_phase (skipped: true for phases the change does not touch). Completing Phase 6 closes the iteration.`,
	};
}

function handleNoteChange(root: string, args: Args): PlanResult {
	const statements = args.statements ?? [];
	if (statements.length === 0 && !(args.note && args.note.trim())) {
		throw new Error("note_change needs 'statements' (spec ids found to be affected) and/or a 'note'.");
	}
	const { json, iteration } = noteIteration(root, { statements, note: args.note?.trim() || undefined });
	return {
		summary: `Iteration ${iteration.id} now lists ${iteration.statements?.length ?? 0} statement(s)${iteration.statements?.length ? `: ${iteration.statements.join(", ")}` : ""}.`,
		files: { [P0.phaseState]: json },
		iteration,
		nextStep: writeLedgerNote(args),
	};
}

function handleEndChange(root: string, args: Args): PlanResult {
	const { json, iteration } = endIteration(root, { note: args.note });
	return {
		summary: `Change iteration ${iteration.id} closed.`,
		files: { [P0.phaseState]: json },
		iteration,
		nextStep: writeLedgerNote(args),
	};
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
				"Phase 0a — Module Identity. Ask the user these questions ONE AT A TIME. After each answer, restate what you understood and confirm before continuing.",
			questions: [
				'What\'s the module\'s display name? (e.g. "Purchase Orders", "HR Leave Requests")',
				"What code should it use? (snake_case, letters + digits + underscores — becomes the DB schema name; suggest a default derived from the display name)",
				"Does this module depend on any other dForge modules — e.g. needing entities from 'crm' or 'parties'? (admin and metadata are platform-implicit; list any others, or say None)",
				"English only, or which other locales should the module ship translations for (e.g. uk-UA)? English is the base and needs no translation file.",
				"How complete should the initial scaffold be? (minimal = entities + default views + single admin role; minimal-plus = + settings stubs; full = + logic stubs + seed data structure)",
			],
			writeAction:
				"Once all answers are collected and reflected back, call dforge_module_plan({ action: 'write_identity', moduleDir, displayName, code, dependencies, locales, preset }).",
		};
	}

	if (!has0b) {
		if (fileExists(reqPath)) {
			return {
				summary:
					"Phase 0a complete. A draft docs/REQUIREMENTS.md exists on disk but hasn't been confirmed yet.",
				currentPhase: "0b",
				completed,
				pending,
				readyToScaffold: false,
				nextStep:
					"Read docs/REQUIREMENTS.md. Give the user a short outline (section headings + counts) and gap status (open items, or 'No gaps'), then ask them to review the file and reply YES, or describe what to change. If they request changes, edit docs/REQUIREMENTS.md directly (targeted edits), summarize the change in one line, and ask again. Once they reply YES, call dforge_module_plan({ action: 'write_requirements', moduleDir, userConfirmed: true }).",
			};
		}

		return {
			summary: "Phase 0a complete. Proceed to Phase 0b intake.",
			currentPhase: "0b",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0b — Intake. Ask the user these questions ONE AT A TIME in free-form prose. After each answer, restate what you understood and confirm before continuing. Do NOT use pickers or predefined options.",
			questions: [
				"In one sentence, what does this module do?",
				"Who will use this, and what does each type DO with it? (Capture as verb-led sentences, e.g. 'Department managers approve or reject pending requests'. NOT role labels like 'Approver — approves requests'. Push back on vague answers like 'admins and users' — ask what each type does that the other can't.)",
			],
			followUpNote:
				"After answers 1-2: ask any domain ambiguity questions that remain open (e.g. 'What counts as a closed item?', 'Can anonymous users submit?'). Continue one at a time until no open questions remain. Dependencies and locales are confirmed from Phase 0a — carry them into REQUIREMENTS.md without re-asking.",
			writeAction:
				"Draft REQUIREMENTS.md and write it directly to docs/REQUIREMENTS.md on disk (do not paste it into chat). Tell the user it's ready: give a short outline (section headings + counts) and gap status ('No gaps' or a one-line list), then ask them to review and reply YES, or describe what to change. If they request changes, edit the file directly and ask again. Once they reply YES ('yes', 'looks good', 'confirmed', 'LGTM'), call dforge_module_plan({ action: 'write_requirements', moduleDir, userConfirmed: true }).",
		};
	}

	if (!has0c) {
		if (fileExists(designPath)) {
			return {
				summary:
					"Phase 0b complete. A draft docs/DESIGN.md exists on disk but hasn't been confirmed yet.",
				currentPhase: "0c",
				completed,
				pending,
				readyToScaffold: false,
				nextStep:
					"Read docs/DESIGN.md. Give the user a short outline (entity/status-machine counts, section headings) and Gaps & Proposals status (open items, or 'No gaps'), then ask them to review the file and reply YES, or describe what to change. If they request changes, edit docs/DESIGN.md directly (targeted edits), summarize the change in one line, and ask again. Once they reply YES, call dforge_module_plan({ action: 'write_design', moduleDir, userConfirmed: true }).",
			};
		}

		return {
			summary: "Phase 0b complete. Proceed to Phase 0c design.",
			currentPhase: "0c",
			completed,
			pending,
			readyToScaffold: false,
			nextStep:
				"Phase 0c — Design. Re-read REQUIREMENTS.md, then draft DESIGN.md (use the designTemplate below) with all 8 design items in a single message.",
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
				"8b. Rules & Constraints (each rule with its enforcing MECHANISM: CHECK / trigger / action body / canExecute own-record fields / text only)",
				"8c. Notifications (event -> recipient -> channel -> text)",
				"8d. Permissions Matrix (every role x entity and action, incl. trigger-only actions)",
			],
			gapDetection:
				"After drafting: run gap detection pass (FK optionality, status recovery, boolean-to-status smell, set aggregation risk, deep navigation, self-referential FK, security coverage, seed data circular refs). Add a 'Gaps & Proposals' section for each issue found. ALL gaps must be resolved before Phase 0d.",
			writeAction:
				"Once gaps are resolved, write docs/DESIGN.md directly to disk (do not paste it into chat). Tell the user it's ready: give a short outline (entity/status-machine counts, section headings) and Gaps & Proposals status ('No gaps' or a one-line summary), then ask them to review and reply YES, or describe what to change. If they request changes, edit the file directly and ask again. Once they reply YES, call dforge_module_plan({ action: 'write_design', moduleDir, userConfirmed: true }).",
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
			"Phase 0d — Validation. Call dforge_module_plan({ action: 'validate', moduleDir }) to run structural checks. If all pass, evaluate the returned semantic checks, then call validate again with checkResults.",
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
			"Write CLAUDE.md to disk. Then start Phase 0b intake: ask the user (1) 'In one sentence, what does this module do?' (2) 'Who will use this, and what does each type DO with it?' — capture as verb-led sentences, not role labels. Ask domain ambiguity follow-ups until no open questions remain. Draft REQUIREMENTS.md and write it directly to docs/REQUIREMENTS.md on disk, give the user a short outline + gap status, wait for explicit YES, then call write_requirements with userConfirmed: true.",
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
			'User confirmation required — ask the user to review docs/REQUIREMENTS.md (already written to disk) and wait for an explicit YES ("yes", "looks good", "confirmed", "LGTM", or equivalent) before calling write_requirements with userConfirmed: true.',
		);
	}

	const claudePath = path.join(root, P0.identity);
	if (!fileExists(claudePath)) {
		throw new Error("CLAUDE.md not found — complete Phase 0a (write_identity) first.");
	}

	const updatedClaude = tickChecklist(
		readFile(claudePath),
		"0b",
		'Phase 0c — design docs/DESIGN.md (8 design items + gap detection pass), write it to disk, get explicit user YES, then call `dforge_module_plan({ action: "write_design", moduleDir, userConfirmed: true })`.',
	);

	return {
		summary: "Phase 0b complete — docs/REQUIREMENTS.md confirmed.",
		files: {
			[P0.identity]: updatedClaude,
		},
		designTemplate: DESIGN_TEMPLATE,
		nextStep:
			"Write the updated CLAUDE.md to disk. Now design DESIGN.md using the designTemplate above: 8 design items (entity list, fields per entity, relationship map, status machines, actions, seed data, reports, special behaviors). Run gap detection pass, add Gaps & Proposals section, resolve all gaps. Write docs/DESIGN.md to disk, give the user a short outline (entity/status-machine counts, section headings) plus Gaps & Proposals status, wait for explicit YES, then call write_design with userConfirmed: true.",
	};
}

// ─── write_design ─────────────────────────────────────────────────────────────

function handleWriteDesign(root: string, args: Args): PlanResult {
	const designPath = path.join(root, P0.design);
	assertDocReady(designPath, P0.design);

	if (!args.userConfirmed) {
		throw new Error(
			"User confirmation required — ask the user to review docs/DESIGN.md (already written to disk, including the Gaps & Proposals section) and wait for an explicit YES before calling write_design with userConfirmed: true. Ensure all Gaps & Proposals items are resolved.",
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
		'Phase 0d — call `dforge_module_plan({ action: "validate", moduleDir: "..." })` to run structural checks, then provide semantic checkResults.',
	);

	return {
		summary: "Phase 0c complete — docs/DESIGN.md confirmed.",
		files: {
			[P0.identity]: updatedClaude,
		},
		nextStep:
			"Write the updated CLAUDE.md to disk. Now run Phase 0d validation: call dforge_module_plan({ action: 'validate', moduleDir }) for the structural pre-check, evaluate the returned semantic checks, then call validate again with all checkResults.",
	};
}

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

/** Body of a `## <title>` section (any heading level 2, tolerant of CRLF/trailing text), or null. */
function sectionBody(doc: string, title: string): string | null {
	const text = doc.replace(/\r\n/g, "\n");
	const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = text.match(new RegExp(`^##[ \\t]+${esc}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, "mi"));
	return m ? m[1] : null;
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
	const entityListText = sectionBody(designContent, "Entity List") ?? "";
	const knownEntities = new Set<string>();
	for (const line of entityListText.split("\n")) {
		// "- name", "* **name**", "1. name — ...", "| name | ... |", "### name"
		const m =
			line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|`)?([a-z][a-z0-9_]*)\b/) ??
			line.match(/^\s*\|\s*(?:\*\*|`)?([a-z][a-z0-9_]*)(?:\*\*|`)?\s*\|/) ??
			line.match(/^#{3,6}\s+(?:\*\*|`)?([a-z][a-z0-9_]*)\b/);
		if (m) knownEntities.add(m[1]);
	}

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

function handleValidate(root: string, args: Args): PlanResult {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileExists(absPath: string): boolean {
	return fs.existsSync(absPath);
}

function readFile(absPath: string): string {
	return fs.readFileSync(absPath, "utf8");
}

function assertDocReady(absPath: string, relPath: string): void {
	if (!fileExists(absPath)) {
		throw new Error(
			`${relPath} not found — write the draft to disk first (using your file-write tool), then ask the user to review it before calling this action with userConfirmed: true.`,
		);
	}
	if (readFile(absPath).trim().length < 100) {
		throw new Error(
			`${relPath} appears empty or too short (under 100 chars) — write the full draft to disk first.`,
		);
	}
}

/**
 * Tick `phase` AND every earlier Phase 0 checkbox: a phase can only be reached
 * through its predecessors, so the returned CLAUDE.md never shows an earlier
 * phase unticked just because the client skipped an earlier write.
 */
function tickChecklist(claudeMd: string, phase: "0b" | "0c" | "0d", nextStep: string): string {
	const upTo = ["0a", "0b", "0c", "0d"].slice(0, ["0a", "0b", "0c", "0d"].indexOf(phase) + 1);
	let ticked = claudeMd;
	for (const ph of upTo) {
		ticked = ticked.replace(new RegExp(`- \\[ \\] (\\*\\*${ph}\\*\\*)`), "- [x] $1");
	}
	return ticked.replace(
		/\*\*Next step:\*\* .+/,
		`**Next step:** ${nextStep}`,
	);
}
