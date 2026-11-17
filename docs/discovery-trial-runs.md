# Discovery skill — trial runs

A log of how `dforge-module-discovery` was tried out, what was found and what it
changed in the skill. Add one section per run. Each section says what was tested,
on what, and what is **not** covered, so the next reader can tell what the result
is worth.

## Run 1 — equipment repair requests for a small factory

**Setup**
- Customer: an invented small factory, played by a person who answered as that
  customer would. The answers are invented; one sample form was made up for the
  run.
- Skill: played by an AI agent following the written description of the skill (the
  `SKILL.md` did not exist yet). One question per turn, the person commented on
  the wording of each turn.
- Starting point: a draft of a typical equipment-maintenance solution (equipment,
  request, preventive schedule, spare parts) taken from the module ideas of the
  platform repository.

**Covered:** the task and the business analysis (how it works now, what hurts,
scale, goals), the starting point, the platform check, people and visibility, the
request lifecycle, calculated values, notifications, documents with a sample form,
initial data.

**Not covered:** reports and scenarios (step 5), the completeness check (step 6), writing and
approving `docs/SPEC.md` (step 7) on this run as a conversation, the handoff to `dforge-module-design`,
a second domain, repeatability.

**Result:** a draft specification of the module (see
`skills/dforge-module-discovery/examples/equipment-repair-spec.md`, which is
shortened and cleaned for the example).

### Findings and what changed in the skill

| # | Finding in the run | Change |
|---|---|---|
| 1 | The agent announced which "path" it took and what it would do next | Path is chosen silently; asked only when unclear (Step 0) |
| 2 | The agent explained its search, what it found and rejected | No talk about searching or templates; one sentence when there is no ready solution (rule 1, Step 2) |
| 3 | Internal names (patterns, modules) were shown to the user | Business words only (rules 1, 5) |
| 4 | Platform check was shown as a table of module codes with a choice per row | Done silently with defaults; one business question only when it changes the design (Step 2) |
| 5 | The agent asked what the user had already said and decided for them ("a system this size should be simple", "no request is ever lost") | Questions built from the user's words; no decisions or absolutes (rule 4, Step 3) |
| 6 | Open questions with no typical answer were hard to answer from a blank page | Propose the typical answer first, numbered, ask for corrections; open only for what only the user knows (rule 3) |
| 7 | Typical proposals were taken from general practice although a found solution already had them (e.g. a "waiting for parts" status) | Take the proposal from the starting point first; mark the origin of every fact (`user`, `typical`, `practice`, `assumption`) (rule 3, spec template) |
| 8 | The dry wording "who sees what" was not understood | Ask through what the person will see when they open the system (`references/interview.md`) |
| 9 | Notifications and their channels were not explained | Explain "in the system" vs "by e-mail" in business words; propose events for every deadline date and every status change (Step 4, `interview.md`) |
| 10 | Offered options were bullets; the user had to retype them to answer | Numbered proposals so the user can answer by numbers (rule 3) |
| 11 | A promise "exactly the fields of your paper" | Do not promise; ask for the sample or its fields and check each field (rule 8, `interview.md`) |
| 12 | A sample form must be compared with what was already agreed | Say in one line what is already covered; ask only about the missing fields (`interview.md`) |
| 13 | There was almost no business analysis before the design questions | Added Step 3: how it works now, what hurts, scale, goals |
| 14 | Three different things (deadline, other programs, out of scope) were asked in one block; "other programs" read as third-party integrations | One short question each; the separate question about other programs was dropped: an export is asked with the documents, data from elsewhere with the initial data (Step 3) |
| 15 | Reports and scenarios were proposed together | Separate proposals (rule 7, Step 5) |

### Overlap with Phase 0b

The Phase 0b intake of `dforge-module-design` (0.2.58) already asks what the module
does, who uses it and what each type does, what each must and must not reach
(`## Access Needs`) and what it must produce (`## Outputs`, with a sample). The
discovery skill therefore does not repeat those as separate interviews: it asks about
people as verb sentences and writes the two sections in the Phase 0b shape. What it
adds and the intake does not ask: business analysis, a proposed starting point,
lifecycle and forbidden actions, calculated values, notifications, initial data,
proposed reports and scenarios, and one written specification.

### Changes made after the run

- The flow was reordered: after the task is understood the agent quietly looks at
  what exists and builds a first draft, shows only what the system usually consists
  of, and then runs a shorter business analysis that proposes typical reasons and
  goals instead of asking them open (Steps 2–3).
- The interview was shifted toward "the agent builds the whole typical solution, the
  user corrects": the full draft is built up front and checked once for gaps, and
  each topic is then shown as a complete numbered proposal, one topic per turn,
  aiming at ten to twelve turns instead of the twenty-five of this run.
- The questions about the launch date and about what is out of scope were removed:
  the date does not change the design, and what the user removes or declines during
  the interview is recorded as out of scope without asking.
- The question about the language was removed: Phase 0a already asks for locales,
  and the language of a printed form follows from its sample.
- The separate question about connections to other programs was removed: it
  confused the person and overlaps with the questions about documents (exports) and
  initial data.
- A completeness check was added before the specification is written (Step 6,
  `references/completeness-checks.md`).

### What this run does not show

- It is one run, one person, invented answers. It shows which turns of the
  conversation were weak, not that the skill works for other domains.
- The written `SKILL.md` has not been run yet; the changes above were applied from
  the findings, not re-tested.
- Repeatability (the same task several times, then compare the specifications) has
  not been measured.

### Next

1. Run steps 5–8 on the same case and hand `docs/SPEC.md` to `dforge-module-design`;
   note what Phase 0 asks again or misses.
2. Run the written skill on a second domain and compare the turns with this run.
3. Repeat one case several times and compare the specifications.

## Run 2 — Phase 0 of dforge-mcp 0.2.58 with and without the specification

Same task as Run 1 (equipment repair requests for a small factory), invented customer
answered by a person. Phase 0 (identity, requirements, design, validation) was run to
`readyToScaffold: true` three ways; nothing was scaffolded or installed.

1. **Without the specification**, led by the same agent that wrote the specification
   (so it knew it), with deliberately short customer answers.
2. **With the specification** from Run 1: identity, requirements and design were derived
   from `docs/SPEC.md`.
3. **Clean run** in a separate session that had not seen the specification, with a
   different, richer customer story (a chain of managers, a director, photos, audit).

| | 1. Without the specification | 2. With the specification | 3. Clean run |
|---|---|---|---|
| Customer turns in Phase 0 | about 20 | 5 (the specification itself took about 25–30) | about 43 (7 + 30 + 6) |
| Design | 5 entities, 6 actions, 1 notification, 1 output | 7 entities, 9 actions, 7 notifications, 6 outputs, 3 reports | 4 entities, 7 statuses, 7 actions, 4 triggers, 5 roles |
| Gaps found in design | 9 (business and technical) | 7 (technical) | 7, mostly platform limits |
| Result | ready to scaffold | ready to scaffold | ready to scaffold |

How the designs differ: the design without the specification has no "waiting for parts"
status, five of the seven notifications, calculated values (downtime, overdue, cost,
stock), three reports, the act of work done, the Excel list, scenarios, or initial data
from the customer's tables. This does **not** show that the customer needs them: in
run 1 the customer did not ask for them, in run 2 the skill proposed them and the
customer accepted most. What the specification does not give and the design adds: folders
with row filters, binding a head to a section, enforcement mechanisms for rules, the
permissions matrix.

Findings:
- What the skill adds is mostly proposals by category (notifications, calculated
  values, documents, reports) that the customer accepts; whether the customer needs
  all of them, and whether they inflate the scope, is not measured. A fair test
  compares each approach with a list of needs fixed in advance (a ground truth) and
  counts needs found, extras proposed and turns used.
- The usual flow is question-heavy (about 43 customer turns in the clean run).
- Platform limits surfaced only in the design phase and broke requirements that had
  already been confirmed (an employee record with no link to a platform user, no
  "everyone below me" visibility, row visibility held by folders, a report for a role
  with no rights on the data). The discovery skill therefore checks the platform
  quietly in Step 2 and writes the limits to `docs/SPEC-design-notes.md`.
- A defect in the specification template was found: a user id was defined twice (in
  Users and again in Access Needs), which the design check reports as a duplicate.
  Fixed in the template and the example.
- A "pass" in Phase 0d means the documents agree with each other, not that the
  platform was checked.

Limits of this comparison: one case and an invented customer; run 1 was led by an agent
that knew the specification, so it probably overstates what the design phase finds on
its own; run 3 had a different customer story, so its content cannot be compared with
the others, only its process; the design skill was not found in the clean session, which
followed the router only. A cleaner comparison needs a separate session without the
specification and a customer who answers naturally on the same story.

## Run 3 — the written skill on a customer-knowledge sheet (business trips)

A new domain. The customer (a person) answered only from a prepared sheet that the
session could not see: how it works now, who does what, rules and figures, documents,
notifications, reports, initial data, plus things the customer does not know. The sheet
ends with ten "traps" used to see what the skill raises on its own.

- **Turns:** about 16 customer answers up to an approved specification.
- **Needs from the sheet captured:** all of them, with the figures correct (the skill
  first took a 5-day report deadline and the customer corrected it to 3).
- **Traps raised without a prompt:** 10 of 10 (approval by amount and for trips abroad;
  a manager hierarchy, raised as an open question; working days; two currencies and a
  rate; reminders and overdue; receipts as files; reports and scenarios proposed;
  trips of managers and of the director; signature of the order; a link to an
  accounting program, dropped).
- **Scope inflation:** 13 notifications proposed for 5 needed and 6 task lists for 4;
  about 11 statements in the specification are accepted proposals of the skill.
- **Rule breaks:** several topics in one message, "sees and changes" written where the
  customer said "sees", accepted proposals labelled as the customer's own words, an
  Excel list turned into a report, the design-notes file and statement ids mentioned to
  the customer.
- **Main weakness:** the quiet platform check was not done: every row of the design notes
  was marked unchecked and no reference was actually read, so the claimed benefit
  (platform limits known before the requirements) was not obtained in this run.
- The design phase was not run: the design skill was not installed in that session.

Changes made after this run: the platform check now requires opening the references
and quoting what they say (a file with every row unchecked means the check was not
done); origins are strict; one topic per turn; figures come from the user or are marked
as proposals; the user's own wording of an output is kept; proposals carry a reason and
notifications start from events that need action; two new completeness checks. These
changes have not been re-tested yet.

## Run 4 — the skill again, and plain Phase 0, on the same customer-knowledge sheet

Same sheet as Run 3 (business trips; 37 known needs, ten "traps"). The customer answered
only from the sheet and volunteered nothing that was not asked. Two sessions in separate
folders: the skill (updated after Run 3) and plain Phase 0 of dforge-mcp 0.2.58 with the
four standard skills installed (router, design, build, ship) and no discovery skill.

| | Skill, run 1 | Skill, run 2 | Plain Phase 0 |
|---|---|---|---|
| Needs captured fully (of 37) | 36 | 35 | 26 |
| Partly / not at all | 1 / 0 | 1 / 1 | 2 / 9 |
| Traps raised (of 10) | 10 | 9–10 | about 8 |
| Customer turns to an approved spec / to the design | about 16 | about 15 | about 16 (5 in identity, 9 in requirements, 2 in design) |
| Platform check done | no | yes, before the requirements (7 references and 3 patterns read) | yes, during the design |
| Questions the customer could not answer | few | few | 3 technical (dependencies, scaffold depth, a spreadsheet's columns) |

What plain Phase 0 did not ask, so the needs are missing from its requirements and design:
the goals and how it works now, the size of the organisation, the daily rates (two
figures), the spending limit for a hotel night, the list of who is on a trip now, and
whether to connect an accounting program. It first left cancellation out and added it
only when the customer objected. What it does better: the technical design (statuses
with guard triggers, 13 actions, folders for visibility, a permissions matrix, numbers,
seed data) and its gap scan (audit depth, implied entities, a link between a person and
a platform user); that is the next layer, and the skill's specification was not passed
through the design phase in these runs.

What the second skill run lost: the hotel limit, because no step asked for rules, norms
or limits that the customer already works by (in run 1 it appeared only because a goal
about limits happened to be offered). A new open topic now asks for them.

Changes made after the second skill run: a topic for rules and limits the customer
already has; proposals capped at five per message and tied to the customer's words, a
topic ends with a yes/no check instead of an invitation to wish for more; gap questions
limited to missing decisions and contradictions, not new features; scenarios written into
the specification without a question; the skill does not announce its checks or its
draft; defaults named in plain words; origins written in the customer's language;
the scale question dropped. These changes are not re-tested.

Limits: the sheet was written by the author of the skill and its categories overlap with
the topics of the skill, so the result may favour the skill; one run per approach and one
task; the model's variation is not averaged; neither flow was taken beyond Phase 0.

