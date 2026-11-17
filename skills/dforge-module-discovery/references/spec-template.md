# docs/SPEC.md — template

One file, plain Markdown. Number statements with the ids Phase 0 understands:
`S-` system behaviour, `N-` notification, `V-` visibility, `U-` kind of user,
`R-` rule, `P-` permission, `O-` output. Define each id once, at the start of a
line or a list item; refer to it elsewhere inside a sentence. Mark the origin of
each fact: `user`, `typical`, `practice`, `assumption`, `open`.

```markdown
# <Module> — specification

## 1. Task and organisation
Task, organisation, how it works now, what hurts, scale, goals, constraints.

## 2. Starting point
The typical solution used ("none" if the draft was written from scratch).

## 3. Platform decisions
People, directories, other modules, with origin. Exports and imports appear in sections 9 and 12.

## 4. Users
- U-1 <descriptor of the person> <verb phrase>. Sees: … Changes: …

## Access Needs
- U-1 needs: … / must not: …   (verb-led, no role codes)

## 5. Entities
Name — purpose — key fields.

## 6. Lifecycles
Per entity: statuses, who moves it, forbidden at each status, cancel, send back, delete.

## 7. Rules and constraints
- R-1 …

## 8. Calculated values
- S-1 …

## 9. Documents and files
## Outputs
- O-1 <name>: kind (print / report / export / mail), who gets it, how often, fields (sample attached or listed), signatures.

## 10. Notifications
- N-1 event → who is told → in the system / by e-mail → text

## 11. Reports
For whom — the decision it helps to make — default period.

## 12. Initial data
## 13. Out of scope
## 14. Scenarios
Main and negative cases (title, steps, expected result).

## 15. Open questions and assumptions
```

Sections `## Access Needs` and `## Outputs` use the same shape as `REQUIREMENTS.md`
so `dforge-module-design` can copy them. Open questions must be closed before the
design is validated.
