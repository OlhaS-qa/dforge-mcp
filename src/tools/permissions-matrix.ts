// Machine-readable Permissions Matrix.
//
// DESIGN.md `## Permissions Matrix` is where "who may do what" is approved
// BEFORE any security file exists. To make it checkable it is one table:
//
//   | Role | Object | Rights | Statements |
//   |---|---|---|---|
//   | shop.buyer | purchase_order | SIU | S-3, V-1 |
//   | shop.buyer | action:approve_order | E | S-4 |
//   | shop.clerk | purchase_order | - | N-2 |
//
// Role = full role code as it will appear in security/roles.json. Object = a
// rights key exactly as roles.json spells it (entity, dep.entity, action:x,
// report:x, sp:x). Rights = S/I/U/D/C for entities, E for objects, `-` for an
// explicit denial. Statements = the requirement ids that justify the row.
// An absent (role, object) pair means "not granted", same as in roles.json.

import { assertValidRightKey, assertValidRightValue, ROLE_CODE_RE } from "./_helpers";

export interface MatrixRow {
	role: string;
	object: string;
	/** `-` = explicitly denied. */
	rights: string;
	statements: string[];
	/** 1-based line within the section body. */
	line: number;
}

export interface ParsedMatrix {
	/** A table with Role / Object / Rights columns was found. */
	machine: boolean;
	rows: MatrixRow[];
	problems: string[];
}

export const cells = (line: string): string[] =>
	line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) =>
			c
				.trim()
				.replace(/^`+|`+$/g, "")
				.replace(/^\*\*|\*\*$/g, "")
				.trim(),
		);

export const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parsePermissionsMatrix(sectionBody: string | null): ParsedMatrix {
	const out: ParsedMatrix = { machine: false, rows: [], problems: [] };
	if (!sectionBody) return out;
	const lines = sectionBody.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim().startsWith("|")) continue;
		const head = cells(lines[i]).map((h) => h.toLowerCase());
		const ri = head.indexOf("role");
		const oi = head.indexOf("object");
		const gi = head.indexOf("rights");
		if (ri < 0 || oi < 0 || gi < 0) continue;
		const si = head.findIndex((h) => h.startsWith("statement"));
		out.machine = true;
		const seen = new Set<string>();
		for (let j = i + 1; j < lines.length && lines[j].trim().startsWith("|"); j++) {
			if (isSeparator(lines[j])) continue;
			const c = cells(lines[j]);
			const row: MatrixRow = {
				role: c[ri] ?? "",
				object: c[oi] ?? "",
				rights: (c[gi] ?? "").replace(/\s+/g, ""),
				statements: si >= 0 ? (c[si] ?? "").split(/[,\s;]+/).filter((s) => /^[SNVURP]-\d+$/.test(s)) : [],
				line: j + 1,
			};
			const at = `row ${row.role || "?"} / ${row.object || "?"}`;
			if (!ROLE_CODE_RE.test(row.role)) {
				out.problems.push(`${at}: Role must be a full role code like 'shop.buyer'`);
				continue;
			}
			try {
				assertValidRightKey(row.object);
				if (row.rights !== "-") assertValidRightValue(row.object, row.rights, false);
			} catch (e) {
				out.problems.push(`${at}: ${(e as Error).message}`);
				continue;
			}
			const key = `${row.role}\u0000${row.object}`;
			if (seen.has(key)) {
				out.problems.push(`${at}: listed twice`);
				continue;
			}
			seen.add(key);
			out.rows.push(row);
		}
		break; // one matrix table
	}
	return out;
}

/** Rights letters a role must hold, as a sorted string. */
export const sortRights = (r: string): string => [...new Set(r.split(""))].sort().join("");

export const MATRIX_FORMAT_HINT =
	"Use one table `| Role | Object | Rights | Statements |` — Role = full role code (shop.buyer), " +
	"Object = the rights key as it will appear in roles.json (entity, dep.entity, action:x, report:x), " +
	"Rights = S/I/U/D/C (entities) or E (action/report), `-` = explicitly denied, Statements = the " +
	"P-/V-/R- ids behind the row.";
