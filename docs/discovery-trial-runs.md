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
the language and out-of-scope questions, a second domain, repeatability.

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
| 13 | There was almost no business analysis before the design questions | Added Step 3: how it works now, what hurts, scale, goals, connections, launch date and what is out of scope |
| 14 | Three different things (deadline, other programs, out of scope) were asked in one block; "other programs" read as third-party integrations | One short question each; connections offered as "usually everything is in one system" (Step 3) |
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
