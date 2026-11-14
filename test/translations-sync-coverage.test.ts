// dforge_translation_sync must generate every key the CLI's completeness check
// requires (Q-7 / R-10), and prune must remove only true orphans.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { translationSync } from "../src/tools/translations";

let dir: string;
const write = (rel: string, body: unknown) => {
	mkdirSync(dirname(join(dir, rel)), { recursive: true });
	writeFileSync(join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
};
const sync = (prune = false) => {
	const r = translationSync({ moduleDir: dir, locales: ["ru-RU"], prune });
	return { tx: JSON.parse(r.files["translations/ru-RU.json"]!), r };
};
const flatKeys = (o: unknown, trail: string[] = []): string[] =>
	o && typeof o === "object"
		? Object.entries(o).flatMap(([k, v]) => flatKeys(v, [...trail, k]))
		: [trail.join(".")];

// Minimal draft-07 walker (no ajv in the dependency tree): type, properties,
// additionalProperties (false | schema), $ref, oneOf.
const schema = JSON.parse(readFileSync(join(__dirname, "..", "resources", "schemas", "translations.schema.json"), "utf8"));
function schemaErrors(node: any, value: unknown, at: string): string[] {
	if (node.$ref) return schemaErrors(node.$ref.split("/").reduce((a: any, k: string) => (k === "#" ? schema : a[k]), schema), value, at);
	if (node.oneOf) {
		return node.oneOf.some((n: any) => schemaErrors(n, value, at).length === 0) ? [] : [`${at}: matches no oneOf branch`];
	}
	if (node.type === "string") return typeof value === "string" ? [] : [`${at}: not a string`];
	if (node.type !== "object") return [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at}: not an object`];
	const out: string[] = [];
	for (const [k, v] of Object.entries(value)) {
		const sub = node.properties?.[k];
		if (sub) out.push(...schemaErrors(sub, v, `${at}/${k}`));
		else if (node.additionalProperties === false) out.push(`${at}: unexpected property "${k}"`);
		else if (node.additionalProperties) out.push(...schemaErrors(node.additionalProperties, v, `${at}/${k}`));
	}
	return out;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dforge-mcp-txcov-"));
	write("manifest.json", {
		code: "shop",
		supportedLocales: ["ru-RU"],
		entities: { order: "./entities/order.json" },
	});
	write("entities/order.json", {
		description: "Order",
		traits: [],
		fields: {
			status: {
				description: "Status",
				fieldTypeCd: "dropdown",
				params: { options: [{ value: "draft", label: "Draft" }, { value: "done", label: "Done" }] },
			},
			qty: { description: "Quantity", fieldTypeCd: "int" },
		},
		constraints: { qty_positive: { type: "check", expression: "qty > 0", message: "Quantity must be positive" } },
	});
	write("security/roles.json", { "shop.admin": { description: "Admin", rights: {} } });
	write("ui/menus.json", {
		shop_menu: {
			label: "Shop",
			items: {
				sales: {
					label: "Sales",
					children: {
						orders: { label: "Orders", dataViewCode: "orders" },
						stock_report: { reportCode: "stock_rep" },
					},
				},
			},
		},
	});
	write("ui/actions.json", { ship: { label: "Ship", entityCode: "order", script: "ship" } });
	write(
		"logic/actions/ship.dsl",
		"params:\n\treason: text \"Reason\"\n\tcarrier: ref order\n\nexecute:\n\terror('Left ' + [qty])\n\tinfo('Shipped')\n",
	);
	write("ui/reports.json", {
		stock_rep: {
			label: "Stock",
			parameters: { date_from: { fieldTypeCd: "date", label: "From" } },
			datasets: { rows: { caption: "Rows", params: { date_to: { fieldTypeCd: "date", label: "To" } } } },
		},
	});
	write("registers.json", { stock: { kind: "balance", label: "Stock on hand" } });
	write("settings.json", { limit: { description: "Order limit", type: "int" } });
	write("ui/folders.json", { label: "Shop", children: { ops: { label: "Operations" } } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("translation_sync covers the keys install requires", () => {
	it("generates action params, report label/params/captions, registers, flat menu items, options, constraints", () => {
		const { tx } = sync();
		const keys = new Set(flatKeys(tx));
		for (const k of [
			"roles.shop.admin.label",
			"actions.ship.label",
			"actions.ship.params.reason.label",
			"actions.ship.params.carrier.label",
			"reports.stock_rep.label",
			"reports.stock_rep.params.date_from.label",
			"reports.stock_rep.params.date_to.label",
			"reports.stock_rep.datasets.rows.caption",
			"registers.stock.label",
			"menus.shop_menu.label",
			"menus.shop_menu.items.sales.label",
			"menus.shop_menu.items.orders.label",
			"menus.shop_menu.items.stock_report.label",
			"entities.order.fields.status.options.draft",
			"entities.order.constraints.qty_positive.message",
			"settings.limit.label",
			"folders.shop.label",
			"folders.shop_ops.label",
		]) {
			expect(keys, k).toContain(k);
		}
		expect(tx.actions.ship.params.reason.label).toBe("Reason");
		expect(tx.menus.shop_menu.items.orders.label).toBe("Orders");
		expect(tx.menus.shop_menu.items.stock_report.label).toBe("Stock Report");
		// Flat only: no nested leaf under the section.
		expect(tx.menus.shop_menu.items.sales.items).toBeUndefined();
	});

	it("writes only keys the translations schema accepts (flat menus, no report description)", () => {
		write("ui/reports.json", {
			stock_rep: {
				label: "Stock",
				description: "Long text",
				datasets: { rows: { caption: "Rows" } },
			},
		});
		const { tx } = sync();
		expect(schemaErrors(schema, tx, "")).toEqual([]);
		expect(tx.reports.stock_rep.description).toBeUndefined();
		expect(tx.reports.stock_rep.desc).toBeUndefined();
	});

	it("never overwrites existing translations and is idempotent", () => {
		write("translations/ru-RU.json", { actions: { ship: { params: { reason: { label: "Причина" } } } } });
		const first = sync();
		expect(first.tx.actions.ship.params.reason.label).toBe("Причина");
		write("translations/ru-RU.json", JSON.stringify(first.tx));
		expect(sync().tx).toEqual(first.tx);
	});

	it("reports action messages that join text and values", () => {
		const { r, tx } = sync();
		expect(r.warning).toMatch(/join text and values.*ship\.dsl/);
		expect(Object.keys(tx.messages)).toEqual(["Shipped"]);
	});
});

describe("translation_sync prune", () => {
	it("keeps manual keys of live objects and nested menu keys, drops only orphans", () => {
		write("translations/ru-RU.json", {
			entities: {
				order: {
					desc: "Заказ",
					fields: { qty: { label: "Кол-во", hint: "x" }, gone: { label: "Нет" } },
				},
				dead: { label: "Dead" },
			},
			actions: { ship: { params: { reason: { label: "Причина" }, old: { label: "Old" } } }, dead_act: { label: "x" } },
			reports: { stock_rep: { params: { date_from: { label: "С" } }, datasets: { gone: { caption: "x" } } } },
			menus: {
				shop_menu: { items: { sales: { items: { orders: { label: "Заказы" } } }, removed: { label: "x" } } },
			},
			domains: { d: { label: "keep" } },
		});
		const { tx } = sync(true);
		expect(tx.entities.order.desc).toBe("Заказ");
		expect(tx.entities.order.fields.qty.hint).toBe("x");
		expect(tx.entities.order.fields.gone).toBeUndefined();
		expect(tx.entities.dead).toBeUndefined();
		expect(tx.actions.ship.params.reason.label).toBe("Причина");
		expect(tx.actions.ship.params.old).toBeUndefined();
		expect(tx.actions.dead_act).toBeUndefined();
		expect(tx.reports.stock_rep.params.date_from.label).toBe("С");
		expect(tx.reports.stock_rep.datasets.gone).toBeUndefined();
		expect(tx.menus.shop_menu.items.sales.items.orders.label).toBe("Заказы");
		expect(tx.menus.shop_menu.items.removed).toBeUndefined();
		expect(tx.domains.d.label).toBe("keep");
	});
});
