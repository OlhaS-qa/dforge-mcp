// A small JSON-Schema checker for the vendored schemas that nothing else
// validates offline (tests/*.test.json today). It implements only the keywords
// those schemas use — type, const, enum, required, properties,
// additionalProperties, items, pattern, min/max bounds, oneOf and local
// `#/...` $refs — and reports a message per violation with its JSON path.
// An unknown keyword is ignored, so it can only under-report, never invent a
// failure.

import * as fs from "node:fs";
import * as path from "node:path";

type Schema = Record<string, unknown>;

/** Reads resources/schemas/<name>.schema.json from the package (src/ or dist/ layout). */
export function loadVendoredSchema(name: string): Schema | undefined {
	const candidates = [
		path.resolve(__dirname, "..", "resources", "schemas"),
		path.resolve(__dirname, "..", "..", "resources", "schemas"),
		path.resolve(__dirname, "..", "..", "..", "resources", "schemas"),
		path.resolve(process.cwd(), "resources", "schemas"),
	];
	for (const dir of candidates) {
		const p = path.join(dir, `${name}.schema.json`);
		if (fs.existsSync(p)) {
			try {
				return JSON.parse(fs.readFileSync(p, "utf8")) as Schema;
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

export interface SchemaProblem {
	/** JSON path, e.g. `tests[0].do[1]`. */
	path: string;
	message: string;
}

/**
 * When no branch of a oneOf/anyOf fits, say what the CLOSEST branch (the one
 * with the fewest problems) still wants. A bare "does not match any of the
 * allowed forms" hid 24 missing properties of an incomplete lookup column.
 */
function closestForm(results: SchemaProblem[][]): string {
	const best = [...results].filter((r) => r.length > 0).sort((a, b) => a.length - b.length)[0];
	if (!best) return "";
	const shown = best.slice(0, 4).map((p) => `${p.path ? `${p.path} ` : ""}${p.message}`);
	return `; closest form: ${shown.join("; ")}${best.length > shown.length ? `; +${best.length - shown.length} more` : ""}`;
}

const typeOf = (v: unknown): string =>
	v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

const matchesType = (v: unknown, t: string): boolean =>
	t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t;

export function validateAgainstSchema(root: Schema, instance: unknown): SchemaProblem[] {
	const resolve = (ref: string): Schema => {
		let node: unknown = root;
		for (const part of ref.replace(/^#\/?/, "").split("/").filter(Boolean)) {
			node = (node as Record<string, unknown> | undefined)?.[part];
		}
		return (node ?? {}) as Schema;
	};

	const walk = (schema: Schema | boolean, v: unknown, at: string): SchemaProblem[] => {
		if (typeof schema !== "object" || schema === null) {
			return schema === false ? [{ path: at, message: "is not allowed here" }] : [];
		}
		if (typeof schema.$ref === "string") return walk(resolve(schema.$ref), v, at);
		const out: SchemaProblem[] = [];
		const bad = (message: string) => out.push({ path: at, message });

		if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) {
			bad(`must be ${JSON.stringify(schema.const)}, got ${JSON.stringify(v)}`);
			return out;
		}
		if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
			bad(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
			return out;
		}
		if (schema.type !== undefined) {
			const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
			if (!types.some((t) => matchesType(v, t))) {
				bad(`must be ${types.join(" or ")}, got ${typeOf(v)}`);
				return out;
			}
		}
		if (Array.isArray(schema.oneOf)) {
			const branches = schema.oneOf as Schema[];
			const results = branches.map((b) => walk(b, v, at));
			if (!results.some((r) => r.length === 0)) {
				// Name the branch the instance is plainly aiming at: the one whose
				// first required key it carries (insert / update / action / …).
				const aimed = branches
					.map((b, i) => ({ b: resolveBranch(b), i }))
					.filter(({ b }) => {
						const req = (b.required as string[] | undefined)?.[0];
						return req !== undefined && v !== null && typeof v === "object" && req in (v as object);
					});
				if (aimed.length > 0) {
					const best = aimed.map(({ i }) => results[i]).sort((a, b) => a.length - b.length)[0];
					out.push(...best);
				} else {
					bad(`does not match any of the allowed forms${closestForm(results)}`);
				}
			}
		}
		if (Array.isArray(schema.allOf)) {
			for (const b of schema.allOf as Schema[]) out.push(...walk(b, v, at));
		}
		if (Array.isArray(schema.anyOf)) {
			const results = (schema.anyOf as Schema[]).map((b) => walk(b, v, at));
			if (!results.some((r) => r.length === 0)) {
				if (results.length > 0) {
					bad(`does not match any of the allowed forms${closestForm(results)}`);
				}
			}
		}
		if (schema.not && typeof schema.not === "object" && walk(schema.not as Schema, v, at).length === 0) {
			bad("matches a form the schema forbids");
		}
		if (schema.if && typeof schema.if === "object") {
			if (walk(schema.if as Schema, v, at).length === 0) {
				if (schema.then && typeof schema.then === "object") out.push(...walk(schema.then as Schema, v, at));
			} else if (schema.else && typeof schema.else === "object") {
				out.push(...walk(schema.else as Schema, v, at));
			}
		}
		if (typeof v === "string") {
			if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) {
				bad(`'${v}' does not match pattern ${schema.pattern}`);
			}
			if (typeof schema.minLength === "number" && v.length < schema.minLength) {
				bad(`must be at least ${schema.minLength} character(s)`);
			}
		}
		if (typeof v === "number") {
			if (typeof schema.minimum === "number" && v < schema.minimum) bad(`must be >= ${schema.minimum}`);
		}
		if (Array.isArray(v)) {
			if (typeof schema.minItems === "number" && v.length < schema.minItems) {
				bad(`must have at least ${schema.minItems} item(s)`);
			}
			if (schema.items && typeof schema.items === "object") {
				v.forEach((item, i) => out.push(...walk(schema.items as Schema, item, `${at}[${i}]`)));
			}
		}
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			const obj = v as Record<string, unknown>;
			const keys = Object.keys(obj);
			for (const r of (schema.required as string[] | undefined) ?? []) {
				if (!(r in obj)) bad(`is missing required property '${r}'`);
			}
			if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
				bad(`must have at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}`);
			}
			if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
				bad(`must have at most ${schema.maxProperties} propert${schema.maxProperties === 1 ? "y" : "ies"}`);
			}
			const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
			const patternProps = Object.entries((schema.patternProperties as Record<string, Schema> | undefined) ?? {});
			for (const k of keys) {
				const sub = k in props ? props[k] : undefined;
				const child = at ? `${at}.${k}` : k;
				const patterned = patternProps.filter(([re]) => new RegExp(re).test(k));
				if (!sub && patterned.length > 0) {
					for (const [, ps] of patterned) out.push(...walk(ps, obj[k], child));
					continue;
				}
				if (sub) out.push(...walk(sub, obj[k], child));
				else if (schema.additionalProperties === false) bad(`has unexpected property '${k}'`);
				else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
					out.push(...walk(schema.additionalProperties as Schema, obj[k], child));
				}
			}
		}
		return out;
	};

	const resolveBranch = (b: Schema): Schema => (typeof b.$ref === "string" ? resolve(b.$ref) : b);

	return walk(root, instance, "");
}
