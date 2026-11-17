import { z } from "zod";
import { BUILD_PHASES, type FileMap } from "../_helpers";

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
			"Sub-command: 'check' = current lifecycle state (Phase 0 sub-phase, or the build/ship phase once " +
				"Phase 0 is done) + which skill to run next; 'write_identity' = Phase 0a; 'write_requirements' = " +
				"Phase 0b; 'write_design' = Phase 0c; 'validate' = Phase 0d; 'complete_phase' = record a build phase " +
				"(1-6) as done or deliberately skipped; 'begin_change' = open a new change iteration on a finished " +
				"module (note required) so check/complete_phase work against it without overwriting history; " +
				"'end_change' = close the open iteration explicitly; 'note_change' = append `statements` (deduped) " +
				"and/or a `note` to the open iteration without recording a phase.",
		),
	moduleDir: z.string().describe("Absolute path to the module directory. Ask the user for this before the first call."),
	// ── write_identity fields (Phase 0a) ────────────────────────────────
	displayName: z.string().optional().describe("[write_identity] Human-readable module name, e.g. 'Purchase Orders'."),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional()
		.describe("[write_identity] snake_case module code, e.g. 'purchase_orders'. Becomes the DB schema name."),
	dependencies: z
		.array(z.string())
		.optional()
		.describe(
			"[write_identity] Other dForge module codes this module depends on. admin + metadata are always implicit.",
		),
	locales: z
		.array(z.string())
		.optional()
		.describe(
			"[write_identity] Locales besides English, e.g. ['uk-UA', 'de-DE'] — recorded in CLAUDE.md only; " +
				"declare them in manifest.supportedLocales and run dforge_translation_sync to create the files. " +
				"English is the base: its text lives in the definitions and needs no file. Default: [] (English " +
				"only).",
		),
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
			"[write_requirements, write_design] MUST be true — only set after the user has reviewed the on-disk " +
				"draft (docs/REQUIREMENTS.md / docs/DESIGN.md, already written by you) and explicitly confirmed " +
				"(replied YES / 'looks good' / 'confirmed').",
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
			"[validate] Semantic check results from agent evaluation. Omit on the first call (structural " +
				"pre-check only). Provide after evaluating the returned semanticChecks.",
		),
	// ── complete_phase fields (Phases 1-6) ───────────────────────────────
	phase: z
		.enum(BUILD_PHASES)
		.optional()
		.describe(
			"[complete_phase] Which build phase finished: '1' domain, '2' behavior, '3' views/reports, '4' " +
				"polish, '5' security, '6' verify.",
		),
	skipped: z
		.boolean()
		.optional()
		.describe(
			"[complete_phase] True when the phase was deliberately skipped rather than done (only valid for the " +
				"optional phases 2 and 4). Recording it stops a resumed session from re-proposing work the user " +
				"already declined.",
		),
	note: z
		.string()
		.optional()
		.describe(
			"[complete_phase, end_change] One-line record of what was done or why it was skipped. [begin_change] " +
				"REQUIRED: what the change is.",
		),
	statements: z
		.array(z.string())
		.optional()
		.describe(
			"[begin_change, complete_phase, note_change] Spec statement ids this change affects (e.g. " +
				"['S-3','R-4']). Recorded on the iteration; later calls append (deduped) the ones found to be " +
				"affected afterwards.",
		),
	apply: z
		.boolean()
		.optional()
		.describe(
			"When true, WRITE the resulting files (docs/phase.json, CLAUDE.md, ...) to disk here instead of " +
				"returning them for the client to write. Recommended for complete_phase / begin_change / end_change: " +
				"the ledger is a read-modify-write of the file on disk, so a client that skips a write (or writes " +
				"two results out of order) loses phases.",
		),
};

export type Args = z.infer<z.ZodObject<typeof planModuleSchema>>;

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
