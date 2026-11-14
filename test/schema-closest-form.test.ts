import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../src/tools/validate/json-schema";

describe("validateAgainstSchema oneOf reporting", () => {
	const schema = {
		oneOf: [
			{
				type: "object",
				required: ["kind", "domain"],
				properties: { kind: { const: "lookup" }, domain: { type: "string" } },
			},
			{ type: "object", required: ["kind", "type"], properties: { kind: { const: "text" }, type: { type: "string" } } },
		],
	};

	it("names what the closest form still needs instead of a bare 'no allowed form'", () => {
		const problems = validateAgainstSchema(schema as never, { flags: "V" });
		expect(problems).toHaveLength(1);
		expect(problems[0].message).toContain("does not match any of the allowed forms");
		expect(problems[0].message).toContain("closest form");
		expect(problems[0].message).toMatch(/required property '(kind|domain|type)'/);
	});

	it("is silent for a valid instance", () => {
		expect(validateAgainstSchema(schema as never, { kind: "text", type: "x" })).toEqual([]);
	});
});
