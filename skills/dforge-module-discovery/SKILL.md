---
name: dforge-module-discovery
description: Stage before Phase 0 of dForge module authoring, for a NEW module when the user describes a business problem or a wish ("we need a system for…", "we have a problem with…", "what is already there?") and has no finished data model or requirements. Interviews the user about the business task (how it works now, what hurts, scale, goals), proposes a typical solution (entities, statuses, calculations, notifications, reports, scenarios) for the user to correct, and writes one approved specification, docs/SPEC.md, that dforge-module-design then uses. Do not use when the module already exists (dforge-module-build), for install and release (dforge-module-ship), or when the user brings a complete data model and requirements (go straight to dforge-module-design).
---

# dForge module — Discovery (before Phase 0)

You are the first conversation about a module. The user knows their business, not
dForge. Your job is to turn "we need something for X" into **one specification the
user has approved**, so that Phase 0 can write `REQUIREMENTS.md` and `DESIGN.md`
without asking about meaning again, and so that the gaps users usually find only
while testing (who sees what, what is forbidden at each status, who gets notified,
which reports and documents) are decided **before** anything is built.

Output: `docs/SPEC.md` in the module directory (format: `references/spec-template.md`).
Nothing here creates module files or calls `dforge_module_create`.

> **Prerequisite:** you know `moduleDir` (the router asks for it first) and
> `docs/SPEC.md` does not exist yet. If it exists, read it and continue from the
> first open item instead of starting over.

## Ground rules

These matter more than the step list.

1. **Talk about the user's business, not about the tool.** Never mention searching,
   templates, patterns, module codes, phases or what you checked. One short
   sentence when you have no ready solution ("I have no ready solution for this, so
   here is a first draft"), nothing more.
2. **One question per turn.** After each answer restate it in one line ("Understood:
   requests are in a paper log and get lost"), then ask the next question. Skip a
   question whose answer is already known.
3. **Propose first when a typical answer exists, ask open only for what only the
   user knows.** Write the typical answer as a **numbered** list and ask "Is this how
   it works for you, or what should change?" so the user can reply by numbers
   ("1 and 2 as is, 3 by e-mail too, 4 not needed"). Names, people, their own
   forms and numbers are always open questions. Mark where each fact in the
   spec came from: `user`, `typical`, `practice` (your proposal the user accepted) or
   `assumption`.
4. **Build questions from the user's own words.** Do not decide for the user ("a
   system this size should be simple"), do not repeat what they have already said,
   do not promise absolutes ("no request is ever lost" → "requests do not get
   lost").
5. **Say what the platform does, in business words** ("the system will tell the
   mechanic", not "a trigger will fire"). The user never sets up e-mail or any
   platform feature; do not mention it.
6. **People are asked in free prose, as verbs** ("What does each kind of person do
   with it?"). Never offer role names or a menu of roles: Phase 0b depends on verb
   sentences and refuses role labels. Proposals start after that, for what happens
   to the record.
7. **Reports and scenarios are different things.** A report is something a person
   reads to decide something; a scenario is a path through the system used to
   check it works. Propose and agree them separately.
8. **A real sample beats a description.** For every printed form, report or file
   ask for a sample, or for the list of its fields, and check each field against the
   spec.

## Step 0 — which path

Decide silently from the first answer. If the user brings a finished data model, a
DBML, a migration from another system or a detailed description, skip the interview:
check the model (optional links, status recovery, who sees what, what happens on
cancel and delete), ask only about the gaps you find, write the spec from it and
go to the handoff. Otherwise take the open path below. If unsure, ask exactly one
question: _"Do you already have a data model or a description, or shall we start
from the task?"_

## Step 1 — understand the task

One question: _what needs to be solved and for what kind of organisation?_ Restate
in one line and wait for "yes".

## Step 2 — research quietly, then show a first draft

Right after the "yes" on the task, **before asking more**, build a first draft
yourself and do not tell the user how:

1. Find what exists: the modules installed or available as dependencies (for example
   with `dforge_module_inspect` on a dependency directory), a library of ready
   solutions if you have one, and your knowledge of the domain. No internet. Choose
   silently: people = platform users, a separate directory only when the user manages
   it, own tables otherwise.
2. Assemble the draft in your notes: the entities, the typical lifecycle, typical
   kinds of people, notifications, documents and reports, and the typical reasons
   a team introduces such a system and the typical goals. Show only the first
   part now: what such systems usually consist of, one line per entity ("Equipment:
   name, number, area, condition; Request: who raised it, which equipment, what
   broke, urgency, status, who works on it"), and ask whether it fits, what to remove
   and what to add. The rest is shown in the step where it is discussed.
3. Ask one business question about the platform only when the answer changes the
   design and only the user knows it ("Do you already keep spare parts stock in
   another dForge module?").

If you have no ready solution, say so in one sentence (rule 1). Record the base in
section 2 of the spec and the platform decisions, as assumptions, in section 3.

## Step 3 — business analysis (three questions, short)

The draft already holds the typical answers, so most of this becomes a numbered
proposal instead of an open question. One at a time, each only if not answered:

1. How does it work now (paper, spreadsheet, messenger…) and what bothers them
   most? Ask **open**: only the user knows.
2. Goals: restate what follows from their pains, then propose the typical goals from
   the draft as a numbered list ("usually teams also want: 1 … 2 … 3 …; which apply?").
3. Scale: roughly how many items, records per month, people. Offer ranges.

Do not ask about connections to other programs as a separate question: an export or
a file for another program is asked with the documents (Step 4), data coming from
another place with the initial data. Ask about another system only if the user
mentions one.

Do not ask about a launch date (it does not change the design) and do not ask what
is out of scope as a question: whatever the user removes or declines during the
interview goes to section 13 of the spec, and the user can still remove more when
reading the file in Step 7.

Record the answers in section 1 of the spec.

## Step 4 — details, one topic per turn

Use the phrasing in `references/interview.md` and the proposals from the draft of Step 2. Order:

1. **People and visibility** — free prose first (what each kind of person does,
   whose records they see and change). Then restate as verb sentences. Prefer
   the phrasing that the Phase 0b Access Needs section uses, so it can be copied.
2. **Lifecycle** of each record that goes through stages: statuses, who moves it,
   what is forbidden at each status, how it is cancelled, whether it can be sent
   back, what happens on delete (default: never deleted, only cancelled).
3. **Calculated values** — numbers, totals, durations, overdue flags, stock.
4. **Notifications** — for **every date that has a deadline** and **every status
   change**, propose _event → who is told → in the system or by e-mail_. Typical
   triggers: new record, taken into work, waiting, finished, sent back, overdue,
   expiring document, low stock. Ask which are needed, which only in the system,
   which also by e-mail.
5. **Documents and files** — which printed forms, spreadsheets or exports; ask for a
   sample or the field list; note who signs (paper or in the system). The language
   of a printed form is the language of its sample; the language of the screens is
   asked in Phase 0a, do not ask it here.
6. **Initial data** — where it comes from (table, by hand, from scratch) and how much.

After each topic, restate the agreed result in a few lines.

## Step 5 — reports and scenarios (two separate proposals)

- **Reports:** propose 2–3. For each say who uses it and **what decision it helps to
  make**, plus a default period. The user removes, changes or adds. Record each
  agreed report also as an output (`O-n`, kind report) in `## Outputs`, so that Phase
  0b, which asks about reports among the outputs, does not ask again.
- **Scenarios:** propose 3–5 main paths from start to finish and the negative
  cases (what is refused at each status, what happens on cancel and delete, what
  happens when a required thing is missing). The user corrects.

## Step 6 — check completeness

Before writing the file, go through `references/completeness-checks.md` yourself,
quietly. The checks look for what users usually discover only while testing: a status
nobody can leave, a deadline with no notification decided, a person who sees
nothing or everything, a printed field that exists nowhere, a report with no
decision behind it, a forbidden action with no scenario. For every check that fails,
ask the user **one** question with a proposal (rule 3), then repeat the check. Do not
list the checks to the user; say at most "I checked the specification for gaps and
found N" with the questions. Whatever cannot be settled goes to the last section of
the spec as an open question. These checks test completeness and consistency of the
spec, not whether it can be built on the platform; that is Phase 0 and
`dforge_module_validate`.

## Step 7 — write the specification

Write `docs/SPEC.md` using `references/spec-template.md`. Number every statement
(`S-`, `N-`, `V-`, `U-`, `R-`, `P-`, `O-`; each id defined once, at the start of
its line) so that Phase 0 can cite them. Put what is still open in the last
section. Then give a short orientation — section names, counts of entities,
scenarios and open questions — and ask the user to read the **file** and answer
"yes" or say what to change. Edit the file with targeted edits, say what changed in one
line, ask again. Nothing moves on before "yes".

## Step 8 — handoff

Tell the user the specification is agreed. Invoke **`dforge-module-design`**; it
turns sections 4, 6 and 14 into `REQUIREMENTS.md` (verb sentences, `## Access Needs`,
`## Outputs`, core processes) and shows it to the user in one message instead of
asking the questions again. Open questions from the spec must be closed with the
user before Phase 0d (the design check rejects `TBD`/`open:` wording in Gaps).

## What this skill does not do

- It does not create module files, call `dforge_module_create` or write anything but
  `docs/SPEC.md`.
- It does not invent the domain: entities, people and forms come from the user's
  words and from typical solutions, and are marked as such.
- It does not browse the internet for examples.
- It does not decide money, access or data deletion without an explicit answer.

## Known limits

- The library of ready solutions and its search are a prototype and may not be
  available; the skill works without them.
- `dforge-module-design` does not read `docs/SPEC.md` directly yet (only the statement
  ids are checked against it); the agent derives `REQUIREMENTS.md` from it.
