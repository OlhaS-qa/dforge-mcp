import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
	buildManifest,
	buildFolders,
	buildMenus,
	buildRoles,
	buildActions,
	buildSettings,
	buildGitignore,
	buildVscodeSettings,
	buildZedSettings,
} from "@dforge-core/dforge-cli/templates";
import * as cliTemplates from "@dforge-core/dforge-cli/templates";
import type { EntitySpec, Preset, ScaffoldOpts } from "@dforge-core/dforge-cli/templates";
import { traitsInput, isReadyToScaffold, PHASE_STATE_FILE } from "./_helpers";
import { buildEntityStub, viewColumnsFor, nameFieldInput, toStringInput } from "./add-entity";
import { SYSTEM_MODULES, buildDependencyContract } from "./adds";

// Tool input schema. zod gives us both validation and a JSON schema MCP
// can advertise to clients (so the LLM sees argument types).
export const createModuleSchema = {
	moduleDir: z
		.string()
		.describe(
			"Absolute path to the directory where the module will be written. Phase 0 must be validated first — " +
				"dforge_module_plan validate writes a docs/phase.json marker that this gate reads (readyToScaffold: " +
				"true).",
		),
	code: z
		.string()
		.regex(/^[a-z][a-z0-9_-]*$/)
		.describe("Module code, e.g. 'crm' or 'hr-admin'. Lowercase, digits, underscore, hyphen; first char a letter."),
	displayName: z.string().min(1).describe("Human-readable module name."),
	description: z.string().optional().describe("Optional short description."),
	author: z.string().optional().describe("Author display name."),
	license: z.string().default("MIT"),
	version: z
		.string()
		.regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
		.default("0.1.0"),
	dbSchemaVersion: z
		.string()
		.regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
		.default("0.0.1"),
	dependencies: z
		.array(
			z.union([
				z.string().regex(/^[a-z][a-z0-9_-]*$/),
				z.object({
					module: z.string().regex(/^[a-z][a-z0-9_-]*$/),
					version: z.string().optional().describe("Semver range; default '>=0.0.1'."),
					entities: z
						.array(z.string())
						.describe("The provider entities this module consumes, e.g. ['party']. Required for a non-system module."),
				}),
			]),
		)
		.default([])
		.describe(
			"Other modules this one requires. Every dependency needs a deps/<module>.json contract naming the " +
				"consumed entities, so pass { module: 'parties', entities: ['party'] } — the manifest entry AND the " +
				"contract are then written. A bare code is accepted only for a system module (admin, metadata, " +
				"workspace, sys-billing: a platform-version gate, contract with no entities); for any other module a " +
				"bare code is refused, because a manifest entry without a contract fails the first validate — add it " +
				"later with dforge_dependency_add. Leave empty unless the module genuinely depends on another one; " +
				"do NOT depend on 'admin'/'metadata' without a feature that needs a minimum version.",
		),
	supportedLocales: z
		.array(z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/))
		.optional()
		.describe(
			"Non-English locales this module will ship translations for, e.g. ['ru-RU', 'uk-UA'] -> " +
				"manifest.supportedLocales. English ('en', 'en-US') is the default and is never listed. Generate the " +
				"files with dforge_translation_sync.",
		),
	preset: z
		.enum(["minimal", "minimal-plus", "full"])
		.default("minimal")
		.describe(
			"'minimal' = manifest+entity+UI+role only. 'full' = also settings.json and a logic/actions folder " +
				"(no seed-data stubs: an empty seed file is invalid — add real data with dforge_seed_add). No " +
				"translation file: English lives in the definitions, other locales come from " +
				"dforge_translation_sync. 'minimal-plus' behaves like 'minimal' here since MCP can't loop; pass all " +
				"entities up-front.",
		),
	entities: z
		.array(
			z.object({
				name: z
					.string()
					.regex(/^[a-z][a-z0-9_]*$/)
					.describe("Entity code, e.g. 'customer'. Lowercase, digits, underscore; first char a letter."),
				label: z.string().min(1),
				traits: traitsInput,
				nameField: nameFieldInput,
				toStringTemplate: toStringInput,
			}),
		)
		.min(1)
		.describe(
			"At least one entity. Each entity gets a stub JSON, a default grid view, a menu item, and rights in the admin role.",
		),
};

function assertPhase0Complete(moduleDir: string): void {
	const root = path.resolve(moduleDir);
	const required = [
		{ rel: "CLAUDE.md", phase: "0a" },
		{ rel: "docs/REQUIREMENTS.md", phase: "0b" },
		{ rel: "docs/DESIGN.md", phase: "0c" },
		{ rel: "docs/VALIDATION.md", phase: "0d" },
	];

	const missing = required.filter((f) => !fs.existsSync(path.join(root, f.rel)));
	if (missing.length > 0) {
		const lines = missing.map((f) => `  ✗ Phase ${f.phase}: ${f.rel}`).join("\n");
		throw new Error(
			`Phase 0 incomplete — cannot scaffold yet.\n${lines}\n\nRun dforge_module_plan({ action: "check", moduleDir: "${moduleDir}" }) to see what's needed.`,
		);
	}

	if (!isReadyToScaffold(root)) {
		throw new Error(
			`Phase 0 incomplete — design validation has not passed (no readyToScaffold marker in ${PHASE_STATE_FILE} or docs/VALIDATION.md).\n\nRun dforge_module_plan({ action: "validate", moduleDir: "${moduleDir}" }) to complete Phase 0d.`,
		);
	}
}

/**
 * Build the full file map for a new module. Returns paths relative to the
 * module root, NOT absolute paths — the MCP client decides where to write.
 *
 * This is the pure, return-not-write version. The CLI's `init module`
 * command does the equivalent + writes to disk.
 */
export function createModuleFiles(args: z.infer<z.ZodObject<typeof createModuleSchema>>): Record<string, string> {
	assertPhase0Complete(args.moduleDir);
	const moduleId = randomUUID();

	// The trait codes the author chose, kept per-entity. The builders take an
	// EntitySpec whose `traits` is one of two presets and only use it to seed
	// the codes array — so pass a placeholder preset to the builders and apply
	// the real (metadata-validated) codes to each entity JSON below.
	const traitsByName: Record<string, string[]> = {};
	const stubOptsByName: Record<string, { nameField?: boolean; toStringTemplate?: string }> = {};
	const specEntities: EntitySpec[] = args.entities.map((e) => {
		traitsByName[e.name] = e.traits;
		stubOptsByName[e.name] = { nameField: e.nameField, toStringTemplate: e.toStringTemplate };
		return { name: e.name, label: e.label, traits: "identity" };
	});

	const opts: ScaffoldOpts = {
		path: "", // unused: builders don't write paths into output
		code: args.code,
		displayName: args.displayName,
		description: args.description ?? "",
		author: args.author ?? "",
		license: args.license,
		version: args.version,
		dbSchemaVersion: args.dbSchemaVersion,
		dependencies: [],
		preset: args.preset as Preset,
		entities: specEntities,
	};

	// Dependencies: manifest entry + deps/<module>.json contract, always together.
	const depEntries: Record<string, string | { version: string; entities: string[] }> = {};
	const depContracts: Record<string, unknown> = {};
	for (const d of args.dependencies) {
		const dep = typeof d === "string" ? { module: d, version: undefined, entities: [] as string[] } : d;
		if (dep.module === args.code) throw new Error("A module can't depend on itself.");
		const version = dep.version ?? ">=0.0.1";
		if (dep.entities.length === 0) {
			if (!SYSTEM_MODULES.has(dep.module)) {
				throw new Error(
					`Dependency '${dep.module}' names no entity. A manifest entry without a deps/${dep.module}.json contract fails the first validate, ` +
						`and the contract must name at least one consumed entity. Pass { module: '${dep.module}', entities: ['<entity>'] } here, ` +
						`or leave it out and call dforge_dependency_add once you know the entities.`,
				);
			}
			depEntries[dep.module] = version;
			depContracts[dep.module] = buildDependencyContract(dep.module, version, [], []);
		} else {
			depEntries[dep.module] = { version, entities: dep.entities };
			depContracts[dep.module] = buildDependencyContract(dep.module, version, dep.entities, [`ref:${args.code}`]);
		}
	}

	const files: Record<string, string> = {};
	const write = (rel: string, obj: unknown) => {
		files[rel] = JSON.stringify(obj, null, "\t") + "\n";
	};
	const writeText = (rel: string, text: string) => {
		files[rel] = text;
	};

	// Minimal set — every preset writes these.
	const manifest: Record<string, unknown> = { ...buildManifest(opts, moduleId) };
	if (Object.keys(depEntries).length) manifest.dependencies = depEntries;
	if (args.supportedLocales?.length) {
		const bad = args.supportedLocales.filter((l) => /^en(-|$)/i.test(l));
		if (bad.length) {
			throw new Error(
				`supportedLocales must not list English (${bad.join(", ")}) — English lives in the definitions and is the default.`,
			);
		}
		manifest.supportedLocales = [...new Set(args.supportedLocales)];
	}
	write("manifest.json", manifest);
	for (const [mod, contract] of Object.entries(depContracts)) write(`deps/${mod}.json`, contract);
	const builtEntities: Record<string, Record<string, any>> = {};
	for (const e of opts.entities) {
		const traits = traitsByName[e.name];
		const entity = buildEntityStub(e, traits, stubOptsByName[e.name]);
		builtEntities[e.name] = entity;
		write(`entities/${e.name}.json`, entity);
	}
	// Default grids carry real columns (fields the entity has), never `columns: []`.
	write(
		"ui/data_views.json",
		Object.fromEntries(
			opts.entities.map((e) => [
				e.name,
				{
					viewType: "grid",
					label: e.label,
					dataSources: [{ entityCode: e.name, columns: viewColumnsFor(builtEntities[e.name], e.name) }],
				},
			]),
		),
	);
	write("ui/folders.json", buildFolders(opts));
	write("ui/menus.json", buildMenus(opts));
	write("ui/actions.json", buildActions());
	write("security/roles.json", buildRoles(opts));
	writeText(".gitignore", buildGitignore());

	// Editor-bindings (see templates.ts for rationale): inline JSON
	// validation + autocomplete in VS Code & Zed with zero per-user setup.
	write(".vscode/settings.json", buildVscodeSettings());
	write(".zed/settings.json", buildZedSettings());
	// Zed has no extension command API, so the CLI dev loop ships as tasks
	// instead. Read off the templates module rather than imported directly:
	// the helper landed after dforge-cli 0.2.16, and scaffolding must not
	// break for anyone still on an older CLI.
	const buildZedTasks = (cliTemplates as { buildZedTasks?: () => unknown[] }).buildZedTasks;
	if (buildZedTasks) write(".zed/tasks.json", buildZedTasks());

	// Full preset adds the optional-but-typical extras.
	if (opts.preset === "full") {
		write("settings.json", buildSettings());
		// .gitkeep — empty file, signals presence of an empty dir.
		writeText("logic/actions/.gitkeep", "");
	}

	return files;
}
