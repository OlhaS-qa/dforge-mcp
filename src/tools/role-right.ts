// Grant or revoke a single right on a single entity/action/report for a
// single role. Cheaper backtrack than rewriting the whole role.

import { z } from "zod";
import { roleAdd, roleAddSchema } from "./adds";
import {
	loadManifest,
	readJson,
	jsonText,
	rel,
	makeResult,
	withTodayStamp,
	assertValidRightKey,
	assertValidRightValue,
	type ToolResult,
} from "./_helpers";

export const roleRightSetSchema = {
	moduleDir: z.string(),
	roleCode: z.string().describe("Role code as it appears in security/roles.json (e.g. 'crm.admin')."),
	object: z
		.string()
		.describe(
			"Object to grant rights on. Same-module entity: bare ('product'). Cross-module entity: dotted " +
				"('fin.invoice'). Action/report/SP: COLON prefix ('action:approve', 'report:summary', " +
				"'sp:rpt_totals') — never a dot. NEVER 'folder:<code>': role-to-folder access is not expressible " +
				"through role rights, the CLI rejects that prefix, and the call is refused (folder access is " +
				"configured by the tenant administrator). A report whose dataset is datasetType 'S' ALSO needs " +
				"'sp:<spCd>' — report.run enforces both, and the admin UI cannot grant SP rights later.",
		),
	rights: z
		.string()
		.describe(
			"Rights string. Entities: any combination of S/I/U/D/C (use '' to revoke all). Actions/reports/SPs: " +
				"'E' or '' to revoke.",
		),
};

/**
 * `folder:<code>` role rights are rejected by the CLI and no replacement is
 * documented in the vendored schemas (open platform question), so the tools
 * refuse to write them rather than silently accept a key that fails pack.
 */
export function assertNoFolderRights(keys: Iterable<string>): void {
	for (const key of keys) {
		if (/^folder[:.]/.test(key)) {
			throw new Error(
				`Rights key '${key}' is not allowed: role-to-folder access is NOT expressible through role rights ` +
					"(the CLI rejects the 'folder:' prefix, and the vendored schemas document no replacement). " +
					"Do not write it. Folder access is configured by the tenant administrator after install, " +
					"unless the platform owners confirm the folder `roles` map.",
			);
		}
	}
}

export function roleRightSet(args: z.infer<z.ZodObject<typeof roleRightSetSchema>>): ToolResult {
	// Revoking ('') a legacy folder: key stays allowed so it can be cleaned up.
	if (args.rights !== "") assertNoFolderRights([args.object]);
	assertValidRightKey(args.object);
	assertValidRightValue(args.object, args.rights, true); // "" allowed = revoke
	const { paths, manifest } = loadManifest(args.moduleDir);
	const roles = readJson<Record<string, Record<string, unknown>>>(paths.roles);
	const role = roles[args.roleCode];
	if (!role) {
		throw new Error(`Role '${args.roleCode}' not found in security/roles.json. Use role_add to create it.`);
	}
	const rights = (role.rights as Record<string, string> | undefined) ?? {};

	if (args.rights === "") {
		// Revoke: delete the key entirely so the role no longer mentions this object.
		const { [args.object]: _gone, ...rest } = rights;
		void _gone;
		role.rights = rest;
	} else {
		role.rights = { ...rights, [args.object]: args.rights };
	}

	return makeResult(
		args.rights === ""
			? `Revoked all rights on '${args.object}' from role '${args.roleCode}'.`
			: `Set rights on '${args.object}' for role '${args.roleCode}' to '${args.rights}'.`,
		{
			[rel(paths.root, paths.roles)]: jsonText(roles),
			"manifest.json": jsonText(withTodayStamp(manifest)),
		},
	);
}

/**
 * dforge_role_add with the `folder:` refusal in front of it. The role_add
 * implementation lives in ./adds; this wrapper is what the server registers.
 */
export function roleAddChecked(args: z.infer<z.ZodObject<typeof roleAddSchema>>): ToolResult {
	assertNoFolderRights(Object.keys(args.rights));
	return roleAdd(args);
}

export const roleAddCheckedSchema = {
	...roleAddSchema,
	rights: roleAddSchema.rights.describe(
		"Map: object code → rights string. Keys: same-module entity bare ('product'), cross-module entity " +
			"dotted ('fin.invoice'), action/report/SP with a COLON prefix ('action:approve', 'report:summary', " +
			"'sp:rpt_totals') — never a dot. NEVER 'folder:<code>': role-to-folder access is not expressible " +
			"through role rights, the CLI rejects that prefix and this tool refuses it (folder access is " +
			"configured by the tenant administrator). Values: entities use 'S'/'I'/'U'/'D'/'C' (e.g. 'SIUDC'); " +
			"actions/reports/SPs use 'E'. A report with a datasetType 'S' dataset needs BOTH 'report:<cd>' and " +
			"'sp:<spCd>'. To deny, omit the key (never map to '').",
	),
};
