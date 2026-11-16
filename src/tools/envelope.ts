// MCP envelope for patch tools — kept out of server.ts so tests can drive a
// tool through exactly the path the server uses.

import type { ToolResult } from "./_helpers";
import { applyToDisk } from "./apply";
import { guardSchemas } from "./schema-guard";

/** Args every patch tool shares — the module it targets, and the write flag. */
export type PatchArgs = { moduleDir?: string; apply?: boolean };

/**
 * Patch tools: return the file map for the client to write, OR — with
 * `apply: true` — write it here and return only the paths touched. The apply
 * path also guarantees `deletes` are honoured, which a client that forgets to
 * read them would otherwise silently drop.
 *
 * `apply` is a transport flag: it is stripped before the tool function runs, so
 * a tool that iterates its own args (manifest_set) never sees it as a key.
 */
export function envelope<T extends PatchArgs>(fn: (a: T) => ToolResult) {
	return async (args: T) => {
		try {
			// Never silently downgrade an explicit `apply: true` to a preview — a
			// client relying on apply semantics would see a success response and
			// assume the write happened. Every apply-capable tool requires
			// moduleDir in its own schema, so this only fires if that ever drifts.
			if (args.apply && !args.moduleDir) {
				throw new Error(
					"apply: true requires `moduleDir` — it's the root the file map is written relative to. " +
						"Pass moduleDir, or omit `apply` to get the file map back for the client to write.",
				);
			}
			const { apply, ...rest } = args;
			const result = guardSchemas(args.moduleDir, fn(rest as unknown as T));
			const payload = apply ? applyToDisk(args.moduleDir as string, result) : result;
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
			};
		} catch (e) {
			return {
				content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
				isError: true,
			};
		}
	};
}
