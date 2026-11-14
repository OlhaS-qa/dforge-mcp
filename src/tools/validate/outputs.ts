// What the module PRODUCES: the design's Outputs table traced into the built
// module, plus the print templates themselves.
//
//  - every output row names a mechanism that exists (print template, report, export entity,
//    job, webhook, action), reads entities/fields that exist, is run by roles
//    that really hold the right it needs, and names a test that exists;
//  - every print template is bound to a known entity, has its file, and every
//    `{{ column }}` / `_fmt.column` / `_raw.column` it reads is a column of that entity.
//
// All findings are warnings: validate also runs mid-build, when an output is
// designed but not built yet. Phase 6 requires them cleared.

import * as fs from "node:fs";
import * as path from "node:path";
import { sectionBody } from "../design-doc";
import { readJsonOrDefault } from "../_helpers";
import { NON_ROLE_RUNNERS, OUTPUT_FORMAT_HINT, parseOutputs, rightsKeyFor, splitSource } from "../outputs";
import type { ValidateContext } from "./context";

type PrintDef = Record<string, unknown>;

/** Column names a template body reads from the record root (outside child-set loops). */
export function placeholdersOf(body: string): Set<string> {
	const stripped = body
		.replace(/\{%-?\s*for\s+(\w+)\s+in\s+[\w.]+[^%]*%\}[\s\S]*?\{%-?\s*endfor\s*-?%\}/g, "")
		.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
	const out = new Set<string>();
	const re = /\{\{-?\s*(?:_fmt\.|_raw\.|_color\.)?([a-z][a-z0-9_]*)\b(?!\.)/g;
	for (const m of stripped.matchAll(re)) out.add(m[1]);
	// `{% if amount_paid > 0 %}` style reads of a bare column.
	for (const m of stripped.matchAll(/\{%-?\s*(?:if|elsif|unless)\s+(?:_fmt\.|_raw\.)?([a-z][a-z0-9_]*)\b/g))
		out.add(m[1]);
	return out;
}

const RESERVED = new Set(["true", "false", "nil", "null", "empty", "blank", "forloop", "include", "with", "and", "or"]);

export function checkOutputs(ctx: ValidateContext): void {
	checkPrintTemplates(ctx);
	checkOutputsAgainstDesign(ctx);
}

function checkPrintTemplates(ctx: ValidateContext): void {
	const { paths, warn, manifest, isKnownEntity, columnsOf, partialColumns } = ctx;
	const defs = readJsonOrDefault<Record<string, PrintDef>>(paths.printTemplates, {});
	for (const [code, def] of Object.entries(defs)) {
		const where = `ui/print_templates.json → ${code}`;
		if ((def.type ?? "template") === "snippet") continue;
		const ent = typeof def.entityCd === "string" ? def.entityCd : undefined;
		if (!ent) continue; // the schema already requires it
		const local = ent.startsWith(`${manifest.code}.`) ? ent.slice(manifest.code.length + 1) : ent;
		if (!isKnownEntity(local) && !isKnownEntity(ent)) {
			warn(where, `is bound to entity '${ent}', which is not a known entity.`, "out:print-entity");
			continue;
		}
		let body = typeof def.template === "string" ? def.template : "";
		if (typeof def.file === "string") {
			const abs = path.join(paths.root, "print_templates", def.file);
			if (!fs.existsSync(abs)) {
				warn(where, `names file print_templates/${def.file}, which does not exist.`, "out:print-file");
				continue;
			}
			body = fs.readFileSync(abs, "utf8");
		}
		if (!body.trim()) {
			warn(where, "has no template body — it prints an empty page.", "out:print-empty");
			continue;
		}
		const cols = columnsOf[local];
		if (!cols || partialColumns.has(local)) continue;
		const unknown = [...placeholdersOf(body)].filter((n) => !cols.has(n) && !n.startsWith("_") && !RESERVED.has(n));
		if (unknown.length) {
			warn(
				where,
				`reads ${unknown.map((n) => `'${n}'`).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a column of '${local}' ` +
					"(a typo prints an empty value; a child set is only read inside a {% for %} loop).",
				"out:print-placeholder",
			);
		}
	}
}

function checkOutputsAgainstDesign(ctx: ValidateContext): void {
	const { moduleDir, paths, warn, isKnownEntity, columnsOf, reports, actions, roles } = ctx;
	const designPath = path.join(moduleDir, "docs", "DESIGN.md");
	if (!fs.existsSync(designPath)) return;
	const body = sectionBody(fs.readFileSync(designPath, "utf8"), "Outputs");
	if (body === null) return;
	const o = parseOutputs(body);
	if (!o.machine) {
		if (!o.none)
			warn(
				"docs/DESIGN.md",
				`the Outputs section is not a machine-readable table. ${OUTPUT_FORMAT_HINT}`,
				"out:format",
			);
		return;
	}
	for (const p of o.problems) warn("docs/DESIGN.md → Outputs", p, "out:row");

	const printDefs = readJsonOrDefault<Record<string, PrintDef>>(paths.printTemplates, {});
	const jobCodes = new Set(
		(readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {}).jobs ?? []).map((j) =>
			String(j.code),
		),
	);
	const hookCodes = new Set(
		(readJsonOrDefault<{ subscriptions?: Array<Record<string, unknown>> }>(paths.webhooks, {}).subscriptions ?? []).map(
			(w) => String(w.code),
		),
	);
	const testNames = readTestNames(paths.root);

	for (const r of o.rows) {
		const where = `docs/DESIGN.md → Outputs → ${r.id}`;
		if (r.mechanism) {
			const { type, code } = r.mechanism;
			const exists =
				type === "print"
					? code in printDefs
					: type === "report"
						? code in reports || code.includes(".")
						: type === "export"
							? isKnownEntity(code)
							: type === "job"
								? jobCodes.has(code)
								: type === "webhook"
									? hookCodes.has(code)
									: code in actions;
			if (!exists)
				warn(
					where,
					`promises '${r.rawMechanism}' but the module has no such ${type} — the output is designed and not built`,
					"out:not-built",
				);
		}
		// data.export writes the entity's visible columns: V flag, not identity, not a formula/set/query column.
		if (r.mechanism?.type === "export" && columnsOf[r.mechanism.code]) {
			const defs = ctx.fieldDefsOf[r.mechanism.code] ?? {};
			for (const src of r.sources) {
				const { entity, field } = splitSource(src, isKnownEntity);
				if (!field || entity !== r.mechanism.code || !defs[field]) continue;
				const f = defs[field];
				const flags = String(f.flags ?? "");
				const ct = String(f.columnType ?? "");
				if (!flags.includes("V") || flags.includes("I") || ["F", "S", "Q"].includes(ct))
					warn(
						where,
						`export of '${r.mechanism.code}' will not carry '${field}': ${!flags.includes("V") ? "it lacks the V flag" : flags.includes("I") ? "it is an identity column" : `columnType '${ct}' is not exported`} (data.export writes visible, non-identity, non-formula/set/query columns)`,
						"out:export-column",
					);
			}
		}
		// An action that is meant to print or mail must call the platform function that does it.
		if (r.mechanism?.type === "action" && r.mechanism.code in actions) {
			const script = actionScript(paths.root, actions[r.mechanism.code]);
			if (script !== null) {
				if (r.kind === "print" && !/\bprintPdf\s*\(/.test(script))
					warn(
						where,
						`is a print output but action '${r.mechanism.code}' never calls printPdf()`,
						"out:mechanism-mismatch",
					);
				if (r.kind === "mail" && !/\bsendEmail\s*\(/.test(script))
					warn(
						where,
						`is a mail output but action '${r.mechanism.code}' never calls sendEmail()`,
						"out:mechanism-mismatch",
					);
			}
		}
		// printPdf() is not available to a scheduled job or a background action (no signed-in user).
		if (r.mechanism?.type === "job") {
			const job = (readJsonOrDefault<{ jobs?: Array<Record<string, unknown>> }>(paths.jobs, {}).jobs ?? []).find(
				(j) => String(j.code) === r.mechanism!.code,
			);
			const act = job && typeof job.action === "string" ? job.action : "";
			const script = act && act in actions ? actionScript(paths.root, actions[act]) : null;
			if (script && /\bprintPdf\s*\(/.test(script))
				warn(
					where,
					`job '${r.mechanism.code}' runs action '${act}', which calls printPdf(): a scheduled job has no signed-in user, so printPdf() fails there`,
					"out:print-in-job",
				);
		}
		for (const src of r.sources) {
			const { entity, field } = splitSource(src, isKnownEntity);
			if (entity.includes(".")) continue;
			if (!isKnownEntity(entity)) {
				warn(where, `reads '${src}', but '${entity}' is not an entity of the module`, "out:source");
			} else if (field && columnsOf[entity] && !columnsOf[entity].has(field)) {
				warn(where, `reads '${src}', but '${entity}' has no column '${field}'`, "out:source");
			}
		}
		const need = rightsKeyFor(r, isKnownEntity);
		if (need) {
			for (const role of r.runBy) {
				if ((NON_ROLE_RUNNERS as readonly string[]).includes(role)) continue;
				if (!(role in roles)) continue; // missing role is reported by the permissions check
				const have = ((roles[role].rights as Record<string, string> | undefined) ?? {})[need.key] ?? "";
				if (!have.includes(need.need))
					warn(
						where,
						`${role} is meant to run it, but roles.json gives '${have || "nothing"}' on '${need.key}' (needs '${need.need}')`,
						"out:no-access",
					);
			}
		}
		const m = r.verifiedBy.match(/^test:\s*(.+)$/i);
		if (m && !testNames.has(m[1].trim().toLowerCase()))
			warn(where, `names test '${m[1].trim()}', which is not in tests/*.test.json`, "out:test-missing");
		if (r.verifiedBy && !m && !/^manual\b/i.test(r.verifiedBy))
			warn(where, `'Verified by' must be 'test:<scenario name>' or 'manual: <how>', got '${r.verifiedBy}'`, "out:row");
	}
}

function readTestNames(root: string): Set<string> {
	const names = new Set<string>();
	const dir = path.join(root, "tests");
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.json"));
	} catch {
		return names;
	}
	for (const f of files) {
		try {
			const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { tests?: Array<{ name?: string }> };
			for (const t of doc.tests ?? []) if (typeof t.name === "string") names.add(t.name.trim().toLowerCase());
		} catch {
			/* reported by the scenario check */
		}
	}
	return names;
}

function actionScript(root: string, def: unknown): string | null {
	const script = (def as { script?: unknown } | undefined)?.script;
	if (typeof script !== "string") return null;
	try {
		return fs.readFileSync(path.join(root, "logic", "actions", `${script}.dsl`), "utf8");
	} catch {
		return null;
	}
}
