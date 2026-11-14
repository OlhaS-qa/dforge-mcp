// ui/folders.json and docs/diagrams/ checks.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	readJsonOrDefault,
	duplicateFolderCodes,
	walkFolders,
	diagramFiles,
	diagramKeyProblem,
	isPlannedDiagramKey,
	likelyMisspelledEntity,
} from "../_helpers";
import type { ValidateContext } from "./context";

// Folder codes are unique, and each folder viewName names a declared entity view.
export function checkFolders(ctx: ValidateContext): void {
	const { paths, err, entities } = ctx;
	// Folder codes are unique across the whole tree.
	// Role rights reference a folder flat and path-less (`folder:<code>`), so the
	// same code in two branches makes the grant ambiguous. Nesting alone doesn't
	// namespace them.
	const folderRoot = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	for (const [code, dupPaths] of duplicateFolderCodes(folderRoot)) {
		err(
			"ui/folders.json",
			`folder code '${code}' is used ${dupPaths.length} times (${dupPaths.join(", ")}). Codes must be ` +
				`unique across the whole tree: role rights say 'folder:${code}' with no path, so duplicates are ambiguous.`,
		);
	}

	// Folder viewName → a view the entity declares.
	// `entities.<code>.viewName` binds one entity view per folder. An unresolved
	// name FAILS the install (falling back would serve the entity's FULL column
	// set, so a typo would quietly unrestrict the folder), which makes this worth
	// catching offline. "default" is the conventional placeholder for "no view"
	// and declares nothing — every shipped module writes it — so it is exempt.
	// Cross-module entities (qualified 'mod.entity') can't be inspected offline.
	const folderNodes = [
		{ path: "(root)", node: folderRoot },
		...walkFolders(folderRoot).map((f) => ({ path: f.path, node: f.node })),
	];
	for (const { path: fpath, node } of folderNodes) {
		const bindings = (node.entities as Record<string, Record<string, unknown>> | undefined) ?? {};
		for (const [entityCd, binding] of Object.entries(bindings)) {
			const viewName = (binding ?? {})?.viewName;
			if (typeof viewName !== "string" || viewName.trim() === "") continue;
			if (viewName.trim().toLowerCase() === "default") continue;
			if (entityCd.includes(".")) continue; // cross-module — not authored here
			const e = entities[entityCd];
			if (!e) continue; // unknown entity is reported by the folder/entity checks

			const declared = Object.keys(
				(e.views as Record<string, unknown> | undefined) ?? {},
			).map((v) => v.trim().toLowerCase());
			if (!declared.includes(viewName.trim().toLowerCase())) {
				err(
					`ui/folders.json → ${fpath} → entities.${entityCd}`,
					`viewName '${viewName}' is not declared under 'views' in entities/${entityCd}.json. ` +
						"This fails the install: an unresolved view would show every column of the entity, " +
						"which is the opposite of what naming one asks for. Declare the view, or drop " +
						"'viewName' (or use \"default\", which means no view).",
				);
			}
		}
	}
}

// Diagrams: entity keys resolve, x/y come as a pair.
// docs/diagrams/<code>.json — one diagram per file, the file name its code.
// Design-time only — the installer never reads them — so nothing here may
// block a pack: an unparseable file is worth one error (the editor can't open
// it either), everything else is a warning, and one broken file doesn't stop
// the others being checked. A key is the manifest's own entity code, a
// planned entity (an own code not built yet), or 'module.entity' for a
// declared dependency. Module codes can contain dots,
// so own keys are tried first, then the LONGEST declared dependency code
// followed by '.'.
export function checkDiagrams(ctx: ValidateContext): void {
	const { paths, err, warn, entityMap, deps } = ctx;
	for (const fp of diagramFiles(paths.diagramsDir)) {
		const where = `docs/diagrams/${path.basename(fp)}`;
		let diagram: unknown;
		try {
			diagram = JSON.parse(fs.readFileSync(fp, "utf8"));
		} catch (ex) {
			err(where, `invalid JSON: ${(ex as Error).message}`);
			continue;
		}
		if (!diagram || typeof diagram !== "object" || Array.isArray(diagram)) {
			warn(where, "must be an object — the diagram itself, with an 'entities' map.");
			continue;
		}
		const diagramEntities = (diagram as Record<string, unknown>).entities;
		if (!diagramEntities || typeof diagramEntities !== "object" || Array.isArray(diagramEntities)) {
			warn(where, "has no 'entities' object — list the entities the diagram draws, keyed by entity code.");
			continue;
		}
		for (const [key, placement] of Object.entries(diagramEntities as Record<string, unknown>)) {
			const at = `${where} → entities.${key}`;
			if (isPlannedDiagramKey(key, entityMap)) {
				// A planned entity is valid design content; only a near-miss of a
				// built entity is worth a word, since it's more likely a typo.
				const meant = likelyMisspelledEntity(key, entityMap);
				if (meant) {
					warn(
						at,
						`'${key}' is not built yet, so the diagram draws it as a planned entity. ` +
							`If you meant the existing '${meant}', fix the key.`,
					);
				}
			} else {
				const unresolved = diagramKeyProblem(key, entityMap, deps, paths.root);
				if (unresolved) warn(at, unresolved);
			}
			const p = (placement && typeof placement === "object" ? placement : {}) as Record<string, unknown>;
			if (("x" in p) !== ("y" in p)) {
				warn(
					at,
					`sets '${"x" in p ? "x" : "y"}' without '${"x" in p ? "y" : "x"}'. Give both to pin the ` +
						"entity, or neither to let the diagram place it.",
				);
			}
		}
	}
}

// Menu ↔ folder entity coverage. `module pack` requires every folder a menu is
// linked to to contain the entities behind every item of that menu (a data
// view's entities, a report's entities); a gap is reported by the CLI as one
// line per (folder, entity, item). Offline, the same gaps are reported grouped
// per folder with both ways out. A menu is linked to the folders listed in its
// `folders` property, or to every folder when it has none.
export function checkMenuFolderCoverage(ctx: ValidateContext): void {
	const { paths, manifest, warn, views, reports, entities } = ctx;
	const menus = readJsonOrDefault<Record<string, Record<string, unknown>>>(paths.menus, {});
	const root = readJsonOrDefault<Record<string, unknown>>(paths.folders, {});
	if (Object.keys(menus).length === 0 || Object.keys(root).length === 0) return;

	interface F {
		flat: string;
		path: string;
		key: string;
		entities: Set<string>;
	}
	const own = (code: string): string => (code.startsWith(`${manifest.code}.`) ? code.slice(manifest.code.length + 1) : code);
	const entitySet = (node: Record<string, unknown>): Set<string> =>
		new Set(Object.keys((node.entities as Record<string, unknown> | undefined) ?? {}).map(own));
	const folders: F[] = [{ flat: manifest.code, path: manifest.code, key: manifest.code, entities: entitySet(root) }];
	for (const f of walkFolders(root)) {
		folders.push({
			flat: `${manifest.code}_${f.path.split("/").join("_")}`,
			path: f.path,
			key: f.code,
			entities: entitySet(f.node),
		});
	}
	const keyCount = new Map<string, number>();
	for (const f of folders) keyCount.set(f.key, (keyCount.get(f.key) ?? 0) + 1);
	const resolve = (code: string): F | undefined =>
		folders.find((f) => f.flat === code) ??
		folders.find((f) => f.path === code || `${manifest.code}/${f.path}` === code) ??
		folders.find((f) => f.key === code && keyCount.get(f.key) === 1);

	const itemEntities = (item: Record<string, unknown>, into: Map<string, Set<string>>, trail: string): void => {
		const add = (ent: unknown, label: string) => {
			if (typeof ent !== "string") return;
			const e = own(ent);
			if (!(e in entities)) return; // foreign / system entity — not authored here
			(into.get(e) ?? into.set(e, new Set()).get(e)!).add(label);
		};
		const label = trail;
		if (typeof item.dataViewCode === "string") {
			const v = views[item.dataViewCode];
			for (const s of ((v?.dataSources as Array<Record<string, unknown>> | undefined) ?? [])) add(s.entityCode, `${label} (view ${item.dataViewCode})`);
		}
		if (typeof item.reportCode === "string") {
			const r = (reports[item.reportCode] ?? {}) as Record<string, unknown>;
			for (const ent of Object.keys((r.entities as Record<string, unknown> | undefined) ?? {})) add(ent, `${label} (report ${item.reportCode})`);
			for (const ds of Object.values((r.datasets as Record<string, Record<string, unknown>> | undefined) ?? {})) {
				add(ds?.entityCode ?? ds?.entity, `${label} (report ${item.reportCode})`);
			}
		}
		for (const [k, child] of Object.entries((item.children as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			if (child && typeof child === "object") itemEntities(child, into, `${trail} → ${k}`);
		}
	};

	// folder flat code → menu code → entity → item labels
	const gaps = new Map<string, Map<string, Map<string, Set<string>>>>();
	for (const [mcode, menu] of Object.entries(menus)) {
		if (!menu || typeof menu !== "object") continue;
		const need = new Map<string, Set<string>>();
		for (const [icode, item] of Object.entries((menu.items as Record<string, Record<string, unknown>> | undefined) ?? {})) {
			if (item && typeof item === "object") itemEntities(item, need, icode);
		}
		if (need.size === 0) continue;
		let linked: F[];
		if (Array.isArray(menu.folders)) {
			linked = [];
			for (const c of menu.folders) {
				const f = typeof c === "string" ? resolve(c) : undefined;
				if (f) linked.push(f);
				else warn(`menus → ${mcode}`, `'folders' names '${String(c)}', which matches no folder in ui/folders.json (the install fails on it).`);
			}
		} else linked = folders;
		for (const f of linked) {
			// A pure container folder (no entity bindings at all) shows no entity
			// lists, so the coverage rule has nothing to apply to.
			if (f.entities.size === 0) continue;
			for (const [ent, labels] of need) {
				if (f.entities.has(ent)) continue;
				const byMenu = gaps.get(f.flat) ?? gaps.set(f.flat, new Map()).get(f.flat)!;
				const byEnt = byMenu.get(mcode) ?? byMenu.set(mcode, new Map()).get(mcode)!;
				const set = byEnt.get(ent) ?? byEnt.set(ent, new Set()).get(ent)!;
				for (const l of labels) set.add(l);
			}
		}
	}

	for (const [folder, byMenu] of gaps) {
		const parts: string[] = [];
		const fixes: string[] = [];
		for (const [mcode, byEnt] of byMenu) {
			const ents = [...byEnt.keys()];
			parts.push(`menu '${mcode}' needs ${ents.map((e) => `'${e}'`).join(", ")}`);
			fixes.push(
				`restrict menu '${mcode}' with "folders": [...] to the folders that hold its entities`,
			);
		}
		const total = [...byMenu.values()].reduce((n, m) => n + m.size, 0);
		warn(
			`ui/folders.json → ${folder}`,
			`folder is linked to menus whose items need ${total} entit${total === 1 ? "y" : "ies"} it does not contain: ${parts.join("; ")}. ` +
				"`module pack` rejects this ('cli: menu/folder/entity coverage'). Fix, per menu: " +
				`${[...new Set(fixes)].join("; ")}; or add the entity to this folder's 'entities' ` +
				"(a never-true rowFilter on it hides the rows, but the folder still lists the entity).",
		);
	}
}
