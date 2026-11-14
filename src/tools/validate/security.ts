// security/roles.json checks: rights keyed on real objects, Select coverage.

import * as fs from "node:fs";
import * as path from "node:path";
import { sectionBody } from "../design-doc";
import { DOTTED_CODE_RE, readJsonOrDefault, checkSecurityCoverage } from "../_helpers";
import type { ValidateContext } from "./context";
import { MATRIX_FORMAT_HINT, parsePermissionsMatrix, sortRights } from "../permissions-matrix";

// Role rights keyed on real objects.
export function checkRoleRights(ctx: ValidateContext): void {
	const { paths, manifest, err, warn, deps, isKnownEntity, roles, actions, reports } = ctx;
	const storedProcedures = readJsonOrDefault<Record<string, unknown>>(paths.storedProcedures, {});
	// report: and sp: may be qualified 'module.code'; only a foreign module's objects are out of sight.
	// Codes are [a-z][a-z0-9_]* (no dots), so the single dot is unambiguous — a
	// malformed ref is reported as such rather than as a phantom module or object.
	const checkObjectKey = (
		rcode: string,
		key: string,
		kind: string,
		own: Record<string, unknown>,
		absFile: string,
		file: string,
	): void => {
		const ref = key.slice(kind.length + 1);
		const noun = kind === "sp" ? "stored procedure" : "report";
		if (!DOTTED_CODE_RE.test(ref)) {
			err(
				`roles → ${rcode}`,
				`malformed rights key '${key}' — expected '${kind}:code' or '${kind}:module.code', each part matching [a-z][a-z0-9_]*`,
			);
			return;
		}
		const dot = ref.indexOf(".");
		const mod = dot < 0 ? manifest.code : ref.slice(0, dot);
		const code = dot < 0 ? ref : ref.slice(dot + 1);
		if (mod !== manifest.code) {
			if (!deps.has(mod)) err(`roles → ${rcode}`, `grants on '${key}' but '${mod}' is not a declared dependency`);
		} else if (!fs.existsSync(absFile)) {
			err(`roles → ${rcode}`, `grants on '${key}' but ${file} is missing — declare the ${noun} there`);
		} else if (!(code in own)) {
			err(`roles → ${rcode}`, `grants on '${key}' but no such ${noun} exists in ${file}`);
		}
	};
	for (const [rcode, r] of Object.entries(roles)) {
		const rights = (r.rights as Record<string, string> | undefined) ?? {};
		for (const key of Object.keys(rights)) {
			if (key.startsWith("action:")) {
				const a = key.slice("action:".length);
				if (!(a in actions)) err(`roles → ${rcode}`, `grants on 'action:${a}' but no such action exists`);
			} else if (key.startsWith("report:")) {
				checkObjectKey(rcode, key, "report", reports, paths.reports, "ui/reports.json");
			} else if (key.startsWith("sp:")) {
				checkObjectKey(rcode, key, "sp", storedProcedures, paths.storedProcedures, "logic/stored_procedures.json");
			} else if (key.startsWith("folder:")) {
				// `dforge-cli module validate` rejects this prefix in role rights. The
				// vendored folders.schema.json has no 'roles' key either, so the offline
				// tooling cannot say what replaces it. Report early, state exactly that.
				warn(
					`roles → ${rcode}`,
					`rights key '${key}': the CLI's role-rights check rejects the 'folder:' prefix ('cli: role rights keys'), so pack fails. ` +
						"The CLI points at a 'roles' map inside the folder in folders.json, but the vendored folders.schema.json " +
						"does not define one, so this tool cannot confirm how a role is bound to a folder. Remove the key and " +
						"ask the platform owners how to grant folder access.",
				);
			} else if (!isKnownEntity(key)) {
				// An entity rights key: same-module, a system entity (user, document,
				// …), or a declared cross-module dependency. Reuse the same resolver
				// as FK targets so system/cross-module grants don't false-error.
				err(
					`roles → ${rcode}`,
					`grants rights on '${key}', which is not a known entity (same-module, system, or a declared cross-module dependency)`,
				);
			}
		}
	}
}

// Security coverage (every entity needs a Select grant).
export function checkSelectCoverage(ctx: ValidateContext): void {
	const { moduleDir, warn } = ctx;
	try {
		const { uncoveredEntities } = checkSecurityCoverage(moduleDir);
		for (const e of uncoveredEntities) {
			warn("security", `entity '${e}' has no role granting Select (S) — it will be inaccessible`);
		}
	} catch {
		/* roles file unreadable — checkRoleRights reports on it */
	}
}

// ── Permissions: approved design vs roles.json, and per-role reachability ──

const hasLetter = (rights: string | undefined, l: string) => !!rights && rights.includes(l);

/** The Permissions Matrix approved in docs/DESIGN.md must equal what roles.json grants. */
export function checkPermissionsAgainstDesign(ctx: ValidateContext): void {
	const { moduleDir, roles, err, warn } = ctx;
	const designPath = path.join(moduleDir, "docs", "DESIGN.md");
	if (!fs.existsSync(designPath)) return;
	const design = fs.readFileSync(designPath, "utf8");
	const body = sectionBody(design, "Permissions Matrix");
	if (body === null) return;
	const m = parsePermissionsMatrix(body);
	if (!m.machine) {
		warn(
			"docs/DESIGN.md",
			`Permissions Matrix is not machine-readable, so it cannot be checked against security/roles.json. ${MATRIX_FORMAT_HINT}`,
			"perm:matrix-format",
		);
		return;
	}
	for (const p of m.problems) warn("docs/DESIGN.md → Permissions Matrix", p, "perm:matrix-row");
	const rightsOf = (role: string): Record<string, string> =>
		(roles[role]?.rights as Record<string, string> | undefined) ?? {};
	const designRoles = new Set(m.rows.map((r) => r.role));
	for (const role of designRoles) {
		if (!(role in roles))
			err(
				"security → roles",
				`the design's Permissions Matrix names role '${role}' but security/roles.json has no such role`,
				"perm:role-missing",
			);
	}
	for (const r of m.rows) {
		if (!(r.role in roles)) continue;
		const have = rightsOf(r.role)[r.object];
		const where = `roles → ${r.role}`;
		if (r.rights === "-") {
			if (have)
				err(
					where,
					`the design denies '${r.object}' (${r.statements.join(", ") || "no statement"}) but roles.json grants '${have}'`,
					"perm:denied-but-granted",
				);
			continue;
		}
		if (!have && r.object.startsWith("folder:")) {
			warn(
				where,
				`the design grants '${r.rights}' on '${r.object}', but roles.json has no folder keys: a role reaches a folder through a user_role assignment (user, role, folder) made by the tenant admin, and folder access only gives navigation — data access comes from entity rights. Remove the row and write the folder assignment as a note`,
				"perm:folder-binding",
			);
			continue;
		}
		if (!have) {
			err(
				where,
				`the design grants '${r.rights}' on '${r.object}' (${r.statements.join(", ") || "no statement"}) but roles.json has no such key`,
				"perm:grant-missing",
			);
		} else if (sortRights(have) !== sortRights(r.rights)) {
			const missing = [...r.rights].filter((c) => !have.includes(c)).join("");
			const extra = [...have].filter((c) => !r.rights.includes(c)).join("");
			err(
				where,
				`'${r.object}': design says '${r.rights}', roles.json has '${have}'${missing ? ` (missing ${missing})` : ""}${extra ? ` (beyond the design: ${extra})` : ""}`,
				"perm:rights-differ",
			);
		}
	}
	// Grants the design never approved (roles the matrix covers only).
	const listed = new Set(m.rows.map((r) => `${r.role}\u0000${r.object}`));
	for (const role of designRoles) {
		if (!(role in roles)) continue;
		for (const [obj, rights] of Object.entries(rightsOf(role))) {
			if (!listed.has(`${role}\u0000${obj}`)) {
				warn(
					`roles → ${role}`,
					`roles.json grants '${rights}' on '${obj}' but the design's Permissions Matrix has no row for it`,
					"perm:grant-unapproved",
				);
			}
		}
	}
}

/** Each role can actually do what its rights imply. */
export function checkRoleReachability(ctx: ValidateContext): void {
	const { paths, manifest, roles, actions, reports, warn, isKnownEntity } = ctx;
	const roleEntries = Object.entries(roles).map(
		([code, r]) => [code, (r.rights as Record<string, string> | undefined) ?? {}] as const,
	);
	const canSelect = (rights: Record<string, string>, entity: string) => hasLetter(rights[entity], "S");

	for (const [code, rights] of roleEntries) {
		const where = `roles → ${code}`;
		if (Object.keys(rights).length === 0)
			warn(where, "role has no rights at all — it can do nothing", "perm:empty-role");
		for (const [key, value] of Object.entries(rights)) {
			if (key.includes(":")) continue;
			if (/[IUD]/.test(value) && !hasLetter(value, "S")) {
				warn(
					where,
					`'${key}' grants '${value}' without S — the role writes records it cannot see`,
					"perm:write-without-select",
				);
			}
		}
		for (const key of Object.keys(rights)) {
			if (key.startsWith("action:")) {
				const a = actions[key.slice(7)] as { entityCode?: string } | undefined;
				// An own-module entity may be written qualified ('hr.order'); rights use the bare code.
				const raw = a?.entityCode;
				const ent = raw?.startsWith(`${manifest.code}.`) ? raw.slice(manifest.code.length + 1) : raw;
				if (ent && isKnownEntity(ent) && !canSelect(rights, ent)) {
					warn(
						where,
						`can run '${key}' but has no S on '${ent}', the action's entity — the button never appears`,
						"perm:action-without-select",
					);
				}
			} else if (key.startsWith("report:")) {
				const rep = reports[key.slice(7)] as
					| { datasets?: Record<string, { query?: { entityCd?: string } }> }
					| undefined;
				for (const ds of Object.values(rep?.datasets ?? {})) {
					const ent = ds?.query?.entityCd;
					if (ent && isKnownEntity(ent) && !canSelect(rights, ent)) {
						warn(
							where,
							`can run '${key}' but has no S on '${ent}', which a dataset reads — the report comes back empty or fails`,
							"perm:report-without-select",
						);
					}
				}
			}
		}
	}

	// A trigger runs its action in the writer's name WITHOUT checking Execute on it (core: TriggerQueueService
	// never consults ActionRight.Execute), so a trigger action needs no E grant; it only needs to be known here.
	const trig = readJsonOrDefault<{ triggers?: Array<Record<string, unknown>> }>(paths.triggers, {});
	const triggerActions = new Set<string>();
	for (const t of trig.triggers ?? []) {
		const action = String(t.action ?? "");
		if (action) triggerActions.add(action);
	}

	// Every action is runnable by someone, run by a job or a trigger, or deliberately canExecute:false.
	const granted = new Set<string>();
	for (const [, rights] of roleEntries)
		for (const k of Object.keys(rights)) if (k.startsWith("action:")) granted.add(k.slice(7));
	const jobFile = readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {});
	const jobActions = new Set((jobFile.jobs ?? []).map((j) => String(j.action ?? "")));
	for (const [a, def] of Object.entries(actions)) {
		if (granted.has(a) || jobActions.has(a) || triggerActions.has(a)) continue;
		const d = def as { canExecute?: unknown };
		if (d && d.canExecute === false) continue;
		warn(
			"security",
			`action '${a}' is granted (E) to no role and is not run by a job or trigger — nobody can run it`,
			"perm:action-unreachable",
		);
	}
}
