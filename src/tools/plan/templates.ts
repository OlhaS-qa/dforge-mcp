import { PHASE_STATE_FILE } from "../_helpers";

// Phase 0 doc paths (relative to module root)
export const P0 = {
	identity: "CLAUDE.md",
	requirements: "docs/REQUIREMENTS.md",
	design: "docs/DESIGN.md",
	validation: "docs/VALIDATION.md",
	phaseState: PHASE_STATE_FILE,
} as const;

// docs/DESIGN.md template. Returned to the agent (as `designTemplate`) at the
// 0b→0c handoff and on the 0c resume path, so the template lives in exactly one
// place and is delivered just-in-time — instead of sitting permanently in the
// skill prompt. The section headers (## Entity List / ## Relationship Map /
// ## Gaps & Proposals) MUST stay in sync with the regexes in runStructuralChecks.
// Visibility / Rules & Constraints / Notifications / Permissions Matrix are WARN-
// level in the structural check (older docs without them keep working).
export const DESIGN_TEMPLATE = `# Design Document
<!-- written after Phase 0c approval — edit with care -->

## Entity List
<name — one-line purpose, ordered least- to most-dependent>

## Fields per Entity
### <EntityName>
<key fields, status values, formulas, number sequences>

## Relationship Map
<!-- crow's-foot cardinality: ||--o{ = required N:1 (child must have a parent); |o--o{ = optional N:1. One edge per FK; replace names with your entities. -->
\`\`\`mermaid
erDiagram
    parent_entity ||--o{ child_entity : "verb"
    lookup_entity |o--o{ child_entity : "verb"
\`\`\`

| Relationship (child FK → parent PK) | Required |
|-------------------------------------|----------|
| child_entity.parent_id → parent_entity.id | required |
| child_entity.lookup_id → lookup_entity.id | optional |

Total FKs: <N>

## Status Machines
### <EntityName>
| Status | Transitions via | canExecute guard | Recovery |
|--------|----------------|-----------------|----------|

## Actions
| Name | Target Entity | Description | Params |
|------|--------------|-------------|--------|

## Seed Data
<entity name — rows needed, in parent-before-child order>

## Number Sequences
<column → pattern, or "None">

## Reports & Queries
<report/query name — entity, key columns; or "None">

## Special Behaviors
<entity — soft-delete? sorting? webhooks? print templates? — or "None">

## Visibility
<who sees which records — per role/persona and entity, INCLUDING child records (do they follow the parent's visibility?) and how people bind to departments/roles/teams (which field or table links a user to a department)>

## Rules & Constraints
| Rule (spec statement id if any) | Mechanism | Where |
|---|---|---|
| <rule> | CHECK constraint / trigger / action body / canExecute (own-record fields only) / text only | <entity.field or action> |

## Notifications
| Event | Recipient | Channel | Text |
|---|---|---|---|

## Permissions Matrix
<one row per role x object, INCLUDING every action (Execute) and every report, trigger-only actions too. Machine-checked against security/roles.json at validate time.>

| Role | Object | Rights | Statements |
|---|---|---|---|
| <code>.<role> | <entity> | SIU | S-1, V-1 |
| <code>.<role> | action:<code> | E | S-2 |
| <code>.<role> | <entity> | - | N-1 |

## Gaps & Proposals
<findings from the gap detection pass, or omit this section if none>

---
*Approved: <date>*
`;
