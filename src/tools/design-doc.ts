// Shared readers for docs/DESIGN.md sections.

/** Body of a `## <title>` section (up to the next `## `), or null when absent. */
export function sectionBody(doc: string, title: string): string | null {
	const text = doc.replace(/\r\n/g, "\n");
	const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = text.match(new RegExp(`^##[ \\t]+${esc}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, "mi"));
	return m ? m[1] : null;
}

const NAME = "(?:\\*\\*|`)?([a-z][a-z0-9_]*)";
const LIST_ITEM = new RegExp(`^\\s*(?:[-*+]|\\d+[.)])\\s+${NAME}\\b`);
const TABLE_CELL = new RegExp(`^\\s*\\|\\s*${NAME}(?:\\*\\*|\`)?\\s*\\|`);
const HEADING = new RegExp(`^#{3,6}\\s+${NAME}\\b`);

/**
 * Code at the start of a line: "- name", "* **name**", "1. name — ...",
 * "| name | ... |", and (when `allowHeading`) "### name".
 */
export function leadingCode(line: string, allowHeading = false): string | null {
	const m = line.match(LIST_ITEM) ?? line.match(TABLE_CELL) ?? (allowHeading ? line.match(HEADING) : null);
	return m ? m[1] : null;
}

/** Entity codes named in the Entity List section. */
export function entityListCodes(designContent: string): Set<string> {
	const out = new Set<string>();
	for (const line of (sectionBody(designContent, "Entity List") ?? "").split("\n")) {
		const c = leadingCode(line, true);
		if (c) out.add(c);
	}
	return out;
}

/** Codes named in a section's list items / first table cells (e.g. Actions). */
export function sectionCodes(
	designContent: string,
	title: string,
	skip: string[] = ["action", "name", "code"],
): Set<string> {
	const out = new Set<string>();
	for (const line of (sectionBody(designContent, title) ?? "").split("\n")) {
		const c = leadingCode(line);
		if (c && !skip.includes(c)) out.add(c);
	}
	return out;
}
