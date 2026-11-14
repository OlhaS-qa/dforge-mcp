import * as path from "node:path";
import {
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
} from "../_helpers";
import type { Args, PlanResult } from "./types";
import { P0 } from "./templates";
import { fileExists, readFile } from "./helpers";

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
export function buildPhaseCheck(root: string, override?: PhaseStateLike): BuildPhaseCheck {
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

export function handleCompletePhase(root: string, args: Args): PlanResult {
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

export function handleBeginChange(root: string, args: Args): PlanResult {
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

export function handleNoteChange(root: string, args: Args): PlanResult {
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

export function handleEndChange(root: string, args: Args): PlanResult {
	const { json, iteration } = endIteration(root, { note: args.note });
	return {
		summary: `Change iteration ${iteration.id} closed.`,
		files: { [P0.phaseState]: json },
		iteration,
		nextStep: writeLedgerNote(args),
	};
}
