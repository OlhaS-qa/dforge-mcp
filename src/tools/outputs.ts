// Machine-readable Outputs: what the module must PRODUCE (printed documents,
// reports, data exports, API/webhook feeds, mails).
//
// REQUIREMENTS.md `## Outputs` lists each output with an id (O-1, O-2 …) — who
// receives it, in what format, how often, and a sample. DESIGN.md `## Outputs`
// turns every id into one table row:
//
//   | Output | Kind | Source | Mechanism | Run by | Verified by |
//   |---|---|---|---|---|---|
//   | O-1 Hire order | print | employee.full_name, employee.hire_date | print:hire_order | hr.officer | manual: sample in docs/samples |
//   | O-2 Payroll export | export | payslip.number, payslip.net | export:payslip | hr.accountant | manual: open the file |
//
// Kind = print | report | export | api | mail | file. Source = entities (or
// entity.field) the output reads. Mechanism = <type>:<code> where type is one
// of print, report, export, xlsx, job, webhook, action. `xlsx:<template>` is an Excel export template (ui/export_templates.json, one entity's rows poured into a workbook; also `exportXlsx()` in an action). `export:<entity>` is the platform's data.export (csv/xlsx of an entity: its visible columns, a filter, an order); `print:<template>` is the UI print form; mail and PDF produced by an action are `action:<code>` (printPdf / sendEmail in its script). Run by = full role codes, or
// system / schedule / external. Verified by = `test:<scenario name>` or
// `manual: <how>`.

import { cells, isSeparator } from "./permissions-matrix";

export const OUTPUT_KINDS = ["print", "report", "export", "api", "mail", "file"] as const;
export const MECHANISM_TYPES = ["print", "report", "export", "xlsx", "job", "webhook", "action"] as const;
export const NON_ROLE_RUNNERS = ["system", "schedule", "external"] as const;

export interface OutputRow {
	id: string;
	kind: string;
	/** Raw source cells, e.g. "employee.full_name". */
	sources: string[];
	mechanism: { type: string; code: string } | null;
	rawMechanism: string;
	runBy: string[];
	verifiedBy: string;
	line: number;
}

export interface ParsedOutputs {
	machine: boolean;
	rows: OutputRow[];
	problems: string[];
	/** The section says "None": the module produces nothing beyond its plain views. */
	none: boolean;
}

export const OUTPUT_FORMAT_HINT =
	"Use one table `| Output | Kind | Source | Mechanism | Run by | Verified by |` with one row per output id " +
	"(O-1 …); Kind = print/report/export/api/mail/file, Mechanism = print:<code> / report:<code> / export:<entity> / " +
	"xlsx:<template> / job:<code> / webhook:<code> / action:<code>, Run by = full role codes or system/schedule/external.";

const OUTPUT_ID = /\bO-(\d+)\b/;

/** Output ids defined in a REQUIREMENTS.md `## Outputs` section body (at a line / cell start). */
export function outputIdsDefined(sectionBody: string | null): string[] {
	if (!sectionBody) return [];
	const out: string[] = [];
	for (const line of sectionBody.replace(/\r\n/g, "\n").split("\n")) {
		const m = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+|\|\s*|#{1,6}\s+)?[*_`[(]*(O-\d+)\b/);
		if (m) out.push(m[1]);
	}
	return out;
}

export function sectionSaysNone(body: string | null): boolean {
	if (body === null) return false;
	const text = body.replace(/<!--[\s\S]*?-->/g, "").trim();
	return /^(?:[-*]\s*)?(?:none|n\/a|нет|отсутствуют)\b[^\n]*$/i.test(text);
}

const splitList = (s: string | undefined): string[] =>
	(s ?? "")
		.split(/[,;]/)
		.map((x) => x.trim())
		.filter(Boolean);

export function parseOutputs(sectionBody: string | null): ParsedOutputs {
	const out: ParsedOutputs = { machine: false, rows: [], problems: [], none: sectionSaysNone(sectionBody) };
	if (!sectionBody) return out;
	const lines = sectionBody.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim().startsWith("|")) continue;
		const head = cells(lines[i]).map((h) => h.toLowerCase());
		const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
		const oi = col("output");
		const ki = col("kind");
		const mi = col("mechanism");
		if (oi < 0 || ki < 0 || mi < 0) continue;
		const si = col("source", "sources");
		const ri = col("run by", "who", "runner");
		const vi = col("verified by", "verified", "check");
		out.machine = true;
		const seen = new Set<string>();
		for (let j = i + 1; j < lines.length; j++) {
			const raw = lines[j];
			if (!raw.trim().startsWith("|")) break;
			if (isSeparator(raw)) continue;
			const c = cells(raw);
			const first = (c[oi] ?? "").trim();
			const idm = first.match(OUTPUT_ID);
			if (!idm) {
				if (first && !/^<.*>$/.test(first))
					out.problems.push(`line ${j + 1}: first cell '${first}' does not start with an output id (O-1 …)`);
				continue;
			}
			const id = `O-${idm[1]}`;
			if (seen.has(id)) out.problems.push(`${id} appears twice`);
			seen.add(id);
			const kind = (c[ki] ?? "").toLowerCase();
			if (!(OUTPUT_KINDS as readonly string[]).includes(kind))
				out.problems.push(`${id}: Kind '${c[ki] ?? ""}' is not one of ${OUTPUT_KINDS.join("/")}`);
			const rawMechanism = (c[mi] ?? "").trim();
			const mm = rawMechanism.match(/^([a-z]+):([A-Za-z0-9_.-]+)$/);
			let mechanism: OutputRow["mechanism"] = null;
			const mechType = mm?.[1];
			if (kind === "export" && mechType === "report")
				out.problems.push(
					`${id}: a report cannot be exported (data.export works on an entity); use export:<entity>, or print the report to PDF through an action`,
				);
			if (mm && (MECHANISM_TYPES as readonly string[]).includes(mm[1])) mechanism = { type: mm[1], code: mm[2] };
			else
				out.problems.push(
					`${id}: Mechanism '${rawMechanism}' must be <type>:<code> with type one of ${MECHANISM_TYPES.join("/")}`,
				);
			const runBy = ri >= 0 ? splitList(c[ri]) : [];
			if (runBy.length === 0) out.problems.push(`${id}: 'Run by' is empty (a role code, or system/schedule/external)`);
			out.rows.push({
				id,
				kind,
				sources: si >= 0 ? splitList(c[si]) : [],
				mechanism,
				rawMechanism,
				runBy,
				verifiedBy: vi >= 0 ? (c[vi] ?? "").trim() : "",
				line: j + 1,
			});
		}
		break;
	}
	return out;
}

/** "employee.full_name" → entity + field. A source naming a known entity as a whole is not split. */
export function splitSource(s: string, knownEntity: (e: string) => boolean): { entity: string; field?: string } {
	if (knownEntity(s)) return { entity: s };
	const dot = s.lastIndexOf(".");
	if (dot > 0) return { entity: s.slice(0, dot), field: s.slice(dot + 1) };
	return { entity: s };
}

/**
 * The rights key a runner needs to produce an output: report/action need Execute on
 * their own key; print and export need Select on the source entity.
 */
export function rightsKeyFor(
	row: OutputRow,
	knownEntity: (e: string) => boolean,
): { key: string; need: string } | null {
	if (!row.mechanism) return null;
	const { type, code } = row.mechanism;
	if (type === "report") return { key: `report:${code}`, need: "E" };
	if (type === "action") return { key: `action:${code}`, need: "E" };
	const first = row.sources[0];
	if (!first) return null;
	if (type === "export") return { key: code, need: "S" };
	if (type === "print" || type === "xlsx") return { key: splitSource(first, knownEntity).entity, need: "S" };
	return null;
}
