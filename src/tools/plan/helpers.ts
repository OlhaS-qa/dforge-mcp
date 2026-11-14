import * as fs from "node:fs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function fileExists(absPath: string): boolean {
	return fs.existsSync(absPath);
}

export function readFile(absPath: string): string {
	return fs.readFileSync(absPath, "utf8");
}

export function assertDocReady(absPath: string, relPath: string): void {
	if (!fileExists(absPath)) {
		throw new Error(
			`${relPath} not found — write the draft to disk first (using your file-write tool), then ask the user to review it before calling this action with userConfirmed: true.`,
		);
	}
	if (readFile(absPath).trim().length < 100) {
		throw new Error(
			`${relPath} appears empty or too short (under 100 chars) — write the full draft to disk first.`,
		);
	}
}

/**
 * Tick `phase` AND every earlier Phase 0 checkbox: a phase can only be reached
 * through its predecessors, so the returned CLAUDE.md never shows an earlier
 * phase unticked just because the client skipped an earlier write.
 */
export function tickChecklist(claudeMd: string, phase: "0b" | "0c" | "0d", nextStep: string): string {
	const upTo = ["0a", "0b", "0c", "0d"].slice(0, ["0a", "0b", "0c", "0d"].indexOf(phase) + 1);
	let ticked = claudeMd;
	for (const ph of upTo) {
		ticked = ticked.replace(new RegExp(`- \\[ \\] (\\*\\*${ph}\\*\\*)`), "- [x] $1");
	}
	return ticked.replace(
		/\*\*Next step:\*\* .+/,
		`**Next step:** ${nextStep}`,
	);
}
