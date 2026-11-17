# docs/SPEC.md — template

`docs/SPEC.md` is the document **the user reads and approves**, so it is written in
the user's business words: no module codes, no talk of templates, searching or
platform internals. What only the designer needs (platform fit, limits, sources) goes
to `docs/SPEC-design-notes.md` (`references/design-notes-template.md`).

One file, plain Markdown. Number statements with the ids Phase 0 understands:
`S-` system behaviour, `N-` notification, `V-` visibility, `U-` kind of user,
`R-` rule, `P-` permission, `O-` output. Define each id once, at the start of a
line or a list item; refer to it elsewhere inside a sentence. Mark the origin of
each fact in the user's language, in short words (not English tags): said by the user,
proposal accepted, taken by default, open. Write the section headings in the user's
language too; the English headings below are the template.

```markdown
# <Module> — specification

## Summary
What it is, what it consists of (in a few words), scale, the main goals.

## 1. Task and organisation
Task, organisation, how it works now, what hurts, scale, goals, constraints.

## 2. Starting point
One neutral sentence ("a typical system for tracking equipment maintenance", or "drawn up from scratch"). No module names or sources: those go to the design notes.

## 3. Platform decisions
People, directories and how they are kept, in business words. Exports and imports appear in sections 9 and 13.

## 4. Users
- U-1 <descriptor of the person> <verb phrase>. Sees: … Changes: …

## Access Needs
- <Users> (U-1) need: … / must not: …   (verb-led, no role codes; refer to the id inside the sentence, never at the start of the bullet, so it is defined only once)

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
Each agreed report is also listed in `## Outputs` as an `O-n` of kind report, so Phase 0b does not ask about it again.

## 12. Scheduled checks and settings
What is checked on a schedule (overdue, expiring) and how often; which values the user changes without a developer (rates, limits, prefixes) and who changes them.

## 13. Initial data
Where each directory comes from and how much.

## 14. Out of scope
What the system does not do in the first version, **with the reason in business words** ("not needed", "the user declined", "the system cannot do it yet: it will show X instead"). What the user removed or declined during the interview is listed here; it is not asked separately.

## 15. Scenarios
Main and negative cases (title, steps, expected result, and the statements it checks, e.g. `R-1`, `N-3`). The expected result contains only what is already agreed.

## 16. Where each goal is covered
Each goal from section 1 → the sections and statements that deliver it.

## 17. Decisions to confirm
| Question | Our proposal | Status (accepted / changed / open) |
|---|---|---|
Group by kind when it helps: legal, organisational, technical. An open row names who must answer.
```

Sections `## Access Needs` and `## Outputs` use the same shape as `REQUIREMENTS.md`
so `dforge-module-design` can copy them. Open decisions must be closed before the
design is validated.
