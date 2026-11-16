// Status-machine checks (rule ids `wf:*`). A "workflow column" is a dropdown column with
// `params.options` that at least one action of the same entity assigns with a literal
// (`[status] = 'approved'`). The checks read the action DSL text, so they only see literal
// transitions; a value computed at run time is invisible to them and is never reported.
// Everything but an unknown assigned value is a warning: a status list can be legitimately free.
// Reachability, dead-end and open-transition checks run only for a column users cannot edit by hand
// (no E flag) and that actions drive to two or more values; elsewhere a manual path exists.

import * as fs from "node:fs";
import * as path from "node:path";
import { localEntityCode } from "../_helpers";
import type { ValidateContext } from "./context";

interface ActionInfo {
	code: string;
	entity: string | undefined;
	/** [column, value] pairs assigned in `execute:`. */
	writes: Array<[string, string]>;
	/** Columns compared to a literal in `canExecute:`, with the literals. */
	guards: Map<string, Set<string>>;
	hasCanExecute: boolean;
}

/** Splits an action file into its `canExecute:` and `execute:` bodies. */
function sections(body: string): { can: string; exec: string } {
	const m = /^\s*(canExecute|execute)\s*:/gm;
	const marks: Array<{ name: string; start: number; bodyStart: number }> = [];
	for (let x = m.exec(body); x; x = m.exec(body)) {
		marks.push({ name: x[1], start: x.index, bodyStart: x.index + x[0].length });
	}
	if (!marks.length) return { can: "", exec: body };
	let can = "";
	let exec = "";
	marks.forEach((k, i) => {
		const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
		if (k.name === "canExecute") can += body.slice(k.bodyStart, end);
		else exec += body.slice(k.bodyStart, end);
	});
	return { can, exec };
}

const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

function optionValues(def: Record<string, unknown>): string[] | undefined {
	const params = def.params as { options?: unknown } | undefined;
	if (!params || !Array.isArray(params.options)) return undefined;
	const out: string[] = [];
	for (const o of params.options) {
		if (typeof o === "string") out.push(o);
		else if (o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string")
			out.push((o as { value: string }).value);
	}
	return out.length ? out : undefined;
}

/** `'draft'` → draft; anything that is not a bare string literal is not a default we can read. */
function literalDefault(def: Record<string, unknown>): string | undefined {
	const f = def.formula;
	if (typeof f !== "string") return undefined;
	const m = /^\s*'([^']*)'\s*$/.exec(f);
	return m ? m[1] : undefined;
}

export function checkWorkflow(ctx: ValidateContext): void {
	const { paths, manifest, actions, fieldDefsOf, warn, err } = ctx;

	const infos: ActionInfo[] = [];
	for (const [code, a] of Object.entries(actions)) {
		const act = (a ?? {}) as Record<string, unknown>;
		const script = typeof act.script === "string" && act.script ? act.script : code;
		const file = path.join(paths.logicDir, "actions", `${script}.dsl`);
		if (!fs.existsSync(file)) continue;
		let body: string;
		try {
			body = stripComments(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const { can, exec } = sections(body);
		const jsonCan = typeof act.canExecute === "string" ? act.canExecute : "";
		const canAll = `${can}\n${jsonCan}`;
		const writes: Array<[string, string]> = [];
		// `[col] = 'x'` that is not `==`, `<=`, `>=`, `!=` and not preceded by a comparison word.
		const w = /\[([a-z_][a-z0-9_]*)\]\s*(?<![<>!=])=(?!=)\s*'([^']*)'/gi;
		for (let x = w.exec(exec); x; x = w.exec(exec)) writes.push([x[1], x[2]]);
		const guards = new Map<string, Set<string>>();
		const add = (col: string, val: string) => {
			if (!guards.has(col)) guards.set(col, new Set());
			guards.get(col)!.add(val);
		};
		const eq = /\[([a-z_][a-z0-9_]*)\]\s*(?:=|==|!=|<>)\s*'([^']*)'/gi;
		for (let x = eq.exec(canAll); x; x = eq.exec(canAll)) add(x[1], x[2]);
		const inList = /\[([a-z_][a-z0-9_]*)\]\s+IN\s*\(([^)]*)\)/gi;
		for (let x = inList.exec(canAll); x; x = inList.exec(canAll))
			for (const v of x[2].matchAll(/'([^']*)'/g)) add(x[1], v[1]);
		infos.push({
			code,
			entity: localEntityCode(act.entityCode as string | undefined, manifest.code),
			writes,
			guards,
			hasCanExecute: canAll.trim().length > 0,
		});
	}

	for (const [entity, defs] of Object.entries(fieldDefsOf)) {
		const mine = infos.filter((i) => i.entity === entity);
		for (const [col, def] of Object.entries(defs)) {
			const options = optionValues(def);
			if (!options) continue;
			const writers = mine.filter((i) => i.writes.some(([c]) => c === col));
			if (!writers.length) continue; // not driven by actions: a plain dropdown
			const where = `entities → ${entity}.${col}`;
			const flags = typeof def.flags === "string" ? def.flags : "";
			const deflt = literalDefault(def);

			// A literal that is not an option: the action cannot do what it says.
			for (const i of writers)
				for (const [c, v] of i.writes)
					if (c === col && !options.includes(v))
						err(
							`actions → ${i.code}`,
							`sets '${col}' to '${v}', which is not one of the options of ${entity}.${col} (${options.join(", ")})`,
							"wf:status-unknown-value",
						);
			for (const i of mine) {
				for (const v of i.guards.get(col) ?? []) {
					if (!options.includes(v))
						warn(
							`actions → ${i.code}`,
							`canExecute tests '${col}' against '${v}', which is not one of the options of ${entity}.${col} (${options.join(", ")}): the button never appears`,
							"wf:status-unknown-from",
						);
				}
			}

			if (deflt === undefined)
				warn(
					where,
					`'${col}' is changed by actions but has no literal default (formula \`'${options[0]}'\`): a creator can send any status on insert`,
					"wf:status-no-default",
				);
			if (flags.includes("E"))
				warn(
					where,
					`'${col}' is changed by actions (${writers.map((w) => w.code).join(", ")}) and also carries the E flag: users can edit it by hand and skip the transitions. Use flags 'VM' (no E) if the actions are the only way to change it`,
					"wf:status-editable",
				);

			const written = new Set(writers.flatMap((i) => i.writes.filter(([c]) => c === col).map(([, v]) => v)));
			// Transition checks only make sense where the actions are the one way to change the column
			// (no E flag: a column users may edit has a manual path the DSL does not show) and the actions
			// really form a machine (two or more different values written).
			if (flags.includes("E") || written.size < 2) continue;
			for (const o of options) {
				if (o !== deflt && !written.has(o))
					warn(
						where,
						`status '${o}' is never set by any action: no transition leads into it (add the action, or drop the option)`,
						"wf:status-unreachable",
					);
			}
			const left = new Set<string>();
			for (const i of mine) for (const v of i.guards.get(col) ?? []) left.add(v);
			options.forEach((o, idx) => {
				if (idx === options.length - 1) return; // the last option is taken as the final state
				if (!left.has(o))
					warn(
						where,
						`no action can run from status '${o}' (no canExecute tests it): fine if '${o}' is final, otherwise add the way out`,
						"wf:status-no-exit",
					);
			});

			for (const i of writers) {
				const g = i.guards.get(col);
				if (!g || g.size === 0)
					warn(
						`actions → ${i.code}`,
						`sets '${col}' but its canExecute does not test '${col}': it can run from any status${i.hasCanExecute ? "" : " (it has no canExecute at all)"}. State the status it starts from`,
						"wf:transition-open",
					);
			}
		}
	}
}
