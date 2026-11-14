// Add a new action: writes logic/actions/<code>.dsl + appends an entry to
// ui/actions.json. The DSL body is supplied verbatim by the caller — this
// tool doesn't compile or validate the DSL syntax (the C# installer does
// that at install time).

import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs";
import {
	loadManifest,
	readJsonOrDefault,
	readLocalTraits,
	entityRecordContext,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	type ToolResult,
	type ModulePaths,
	type Manifest,
	DOTTED_CODE_RE,
} from "./_helpers";
import { readMessageTranslations } from "./validate/translations";
import { checkDsl } from "./dsl-check";

export const actionAddSchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Action code (becomes the DSL filename and registry key)."),
	entityCode: z
		.string()
		.regex(DOTTED_CODE_RE)
		.describe(
			"Entity this action targets. May be cross-module via dot notation ('fin.invoice').",
		),
	label: z.string().min(1).describe("Display label in the action menu."),
	description: z
		.string()
		.optional()
		.describe("Tooltip / description text. Defaults to the label if omitted."),
	executionMode: z
		.enum(["single", "each", "batch"])
		.default("single")
		.describe(
			"Execution mode (emitted as `executionMode`). 'single' = whole selection at once, 'each' = per-record, 'batch' = explicit `for x in records` loop in DSL.",
		),
	icon: z
		.string()
		.optional()
		.describe(
			"Bootstrap icon name. The `bi-` prefix is added automatically if missing (e.g. 'check-circle' → 'bi-check-circle'). NOTE: action icons keep the prefix; menu icons drop it.",
		),
	isAsync: z
		.boolean()
		.default(false)
		.describe("Run asynchronously in the background (emitted as `isAsync`)."),
	dslBody: z
		.string()
		.describe(
			"Full DSL source. Should contain `params:`, optional `canExecute:`, optional `onBeforeStart:` (async only), and required `execute:` blocks.",
		),
};

/**
 * Run the static DSL checks for one action body. Throws on errors (install
 * failures), returns a formatted warnings block (or undefined). Shared by
 * dforge_action_add and dforge_action_modify.
 */
export function checkActionDsl(
	paths: ModulePaths,
	manifest: Manifest,
	args: { code: string; entityCode: string; executionMode: "single" | "each" | "batch"; dslBody: string },
): string | undefined {
	// Static DSL checks (see ./dsl-check). Errors reject the call — they're all
	// documented install failures, and finding them here saves a pack/install
	// round trip. Warnings ride along on the result for the agent to review.
	//
	// The target entity is resolved first so the column rules run too: a
	// `[field]` that isn't on the entity fails the install the same way a bad
	// built-in does, and there is no reason to write the file and let
	// dforge_module_validate find it later. It resolves to undefined for a
	// cross-module entity, and those rules then stand down.
	//
	// An unusable traits.json stops the call outright. Without it the entity
	// comes back short the columns its traits contribute, `entityRecordContext`
	// withholds the context, and the column rules stand down — so the body would
	// be written having been checked by less than it looks, and fail at install
	// on a column nothing offline could see. Catching that before anything
	// reaches disk is why the module is loaded ahead of the DSL check.
	const { traits: localTraits, error: traitsError } = readLocalTraits(paths.root);
	if (traitsError) {
		throw new Error(
			`traits.json — ${traitsError} Its traits can't be overlaid, so '${args.entityCode}' reads as ` +
				"declaring an unknown trait and the column rules stand down — this body would be written " +
				"unchecked against the entity. Fix the file and call again.",
		);
	}
	const dslIssues = checkDsl(args.dslBody, {
		executionMode: args.executionMode,
		moduleCode: manifest.code,
		actionCode: args.code,
		entity: entityRecordContext(paths, manifest, args.entityCode, localTraits),
		messageTranslations: readMessageTranslations(paths.translationsDir, manifest.supportedLocales),
	});
	const dslErrors = dslIssues.filter((i) => i.level === "error");
	if (dslErrors.length > 0) {
		throw new Error(
			`Action '${args.code}' has ${dslErrors.length} DSL error(s):\n` +
				dslErrors.map((i) => `  • ${i.line ? `line ${i.line}: ` : ""}${i.message}`).join("\n") +
				"\n\nFix the DSL body and call again. (Load dforge://docs/dsl for the full grammar.)",
		);
	}
	const dslWarnings = dslIssues.filter((i) => i.level === "warning");
	return dslWarnings.length > 0
		? `DSL warnings (not blocking):\n${dslWarnings
				.map((i) => `  • ${i.line ? `line ${i.line}: ` : ""}${i.message}`)
				.join("\n")}`
		: undefined;
}

export function actionAdd(
	args: z.infer<z.ZodObject<typeof actionAddSchema>>,
): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);

	const dslWarning = checkActionDsl(paths, manifest, args);

	const actionsJson = readJsonOrDefault<Record<string, unknown>>(paths.actions, {});
	if (Object.prototype.hasOwnProperty.call(actionsJson, args.code)) {
		throw new Error(
			`Action '${args.code}' already exists in ui/actions.json. Use a different code or remove the existing entry first.`,
		);
	}

	// Shape MUST match references/action-dsl.md ("Registering the action") and
	// examples/simple-todo/ui/actions.json. The installer reads `script` (bare
	// filename, no path/extension), `entityCode`, `executionMode`, `isAsync` —
	// NOT entity/mode/background/dsl. Icons keep the `bi-` prefix.
	const actionEntry: Record<string, unknown> = {
		label: args.label,
		description: args.description ?? args.label,
		entityCode: args.entityCode,
		executionMode: args.executionMode,
		script: args.code,
		isAsync: args.isAsync,
	};
	if (args.icon) {
		actionEntry.icon = args.icon.startsWith("bi-") ? args.icon : `bi-${args.icon}`;
	}

	actionsJson[args.code] = actionEntry;

	const dslPath = path.join(paths.logicDir, "actions", `${args.code}.dsl`);
	const dslBody = args.dslBody.endsWith("\n") ? args.dslBody : args.dslBody + "\n";

	return makeResult(
		`Added action '${args.code}' targeting entity '${args.entityCode}' (executionMode=${args.executionMode}${args.isAsync ? ", async" : ""}).`,
		{
			[rel(paths.root, paths.actions)]: jsonText(actionsJson),
			[rel(paths.root, dslPath)]: dslBody,
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
		dslWarning,
	);
}

// ── modify ──────────────────────────────────────────────────────────
//
// action_add refuses an existing code, so before this tool the only way to fix
// a DSL body or a registry entry was to edit logic/actions/<code>.dsl and
// ui/actions.json by hand. Every parameter is optional; only the ones passed
// change. The DSL gets the same static check as action_add — and is re-checked
// from disk when only executionMode / entityCode change, because both alter
// which DSL rules apply.

export const actionModifySchema = {
	moduleDir: z.string(),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Code of an EXISTING action (its key in ui/actions.json)."),
	label: z.string().min(1).optional().describe("New display label."),
	description: z.string().optional().describe("New tooltip / description text."),
	entityCode: z
		.string()
		.regex(DOTTED_CODE_RE)
		.optional()
		.describe("Re-target the action to another entity (the DSL is re-checked against it)."),
	executionMode: z
		.enum(["single", "each", "batch"])
		.optional()
		.describe("New execution mode (the DSL is re-checked against it)."),
	icon: z
		.string()
		.optional()
		.describe("Bootstrap icon name; the `bi-` prefix is added if missing (action icons keep it)."),
	isAsync: z.boolean().optional().describe("Run asynchronously in the background."),
	isTransacted: z
		.boolean()
		.optional()
		.describe("Registry entry `isTransacted` (whole run = one transaction; platform default true)."),
	orderNum: z.number().int().optional().describe("Registry entry `orderNum` (display order in the action menu)."),
	dslBody: z
		.string()
		.optional()
		.describe(
			"Full replacement DSL source for logic/actions/<script>.dsl (not a patch). Omit to keep the file as is.",
		),
};

export function actionModify(args: z.infer<z.ZodObject<typeof actionModifySchema>>): ToolResult {
	const { paths, manifest } = loadManifest(args.moduleDir);
	const actionsJson = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.actions, {});
	const entry = actionsJson[args.code];
	if (!entry || typeof entry !== "object") {
		throw new Error(
			`Action '${args.code}' not found in ui/actions.json. Existing actions: ${Object.keys(actionsJson).join(", ") || "(none)"}. Use dforge_action_add to create it.`,
		);
	}
	const changed: string[] = [];
	const set = (k: string, v: unknown): void => {
		if (v === undefined) return;
		entry[k] = v;
		changed.push(k);
	};
	set("label", args.label);
	set("description", args.description);
	set("entityCode", args.entityCode);
	set("executionMode", args.executionMode);
	set("isAsync", args.isAsync);
	set("isTransacted", args.isTransacted);
	set("orderNum", args.orderNum);
	if (args.icon) set("icon", args.icon.startsWith("bi-") ? args.icon : `bi-${args.icon}`);

	const script = typeof entry.script === "string" && entry.script ? entry.script : args.code;
	const dslPath = path.join(paths.logicDir, "actions", `${script}.dsl`);
	const mode = (entry.executionMode as "single" | "each" | "batch" | undefined) ?? "single";
	const entityCode = String(entry.entityCode ?? "");

	let body = args.dslBody;
	const files: Record<string, string> = {};
	let warning: string | undefined;
	if (body !== undefined) {
		warning = checkActionDsl(paths, manifest, { code: args.code, entityCode, executionMode: mode, dslBody: body });
		body = body.endsWith("\n") ? body : body + "\n";
		files[rel(paths.root, dslPath)] = body;
		changed.push("dslBody");
	} else if (args.executionMode !== undefined || args.entityCode !== undefined) {
		if (fs.existsSync(dslPath)) {
			warning = checkActionDsl(paths, manifest, {
				code: args.code,
				entityCode,
				executionMode: mode,
				dslBody: fs.readFileSync(dslPath, "utf8"),
			});
		} else {
			warning = `logic/actions/${script}.dsl does not exist on disk, so the DSL could not be re-checked against the new executionMode/entityCode.`;
		}
	}
	if (changed.length === 0) {
		throw new Error("Nothing to change: pass at least one of label, description, entityCode, executionMode, icon, isAsync, isTransacted, orderNum, dslBody.");
	}
	actionsJson[args.code] = entry;
	files[rel(paths.root, paths.actions)] = jsonText(actionsJson);
	files["manifest.json"] = jsonText(withTodayStamp(manifest));
	return makeResult(`Modified action '${args.code}' (${changed.join(", ")}).`, files, warning);
}
