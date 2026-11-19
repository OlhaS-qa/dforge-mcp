# Run log: school district purchasing (AI_2)

Comparison of plain Phase 0 and Phase 0 with edits 1-4, two runs of each flow, 18.11.2026. The needs-and-traps list was fixed before the runs and not changed.

## Conditions (the same in all runs)

- Customer answers come only from the customer knowledge sheet; the needs checklist and traps were never shown to the sessions.
- First customer message in every run: "We need a system for purchase requests for our school district office."
- Fixed answers: interface language "English only"; dependencies "I don't know what that is" (counted as a question the customer could not answer); scaffold depth "as you recommend" (also counted as such). Fiscal year, if asked: "1 July to 30 June" (taken from the checklist, trap 8; not in the customer sheet).
- Anything not in the sheet: "I don't know". Traps were not hinted.
- Skills run as usual (dforge-mcp-author, then dforge-module-design), with no extra prompt about the edits.
- Each run stops after `write_design` and validation (end of Phase 0c/0d); no module is built.

## Folders and versions

| Run | Server | Skills | Version |
|---|---|---|---|
| Plain 1 | published `@dforge-core/dforge-mcp@0.2.58` | main (3497541) | 0.2.58 |
| Plain 2 | same | same | 0.2.58 |
| Edits 1 | local build of branch `261118-phase0-edits-3-4` (f2461f7) | same branch | 0.2.58 + edits 1-4 |
| Edits 2 | same | same | same |

Check before each run: plain Phase 0a asks 5 questions, the edited one asks 2 (name and languages). One plain run and one edited run were restarted (a very detailed customer answer; the wrong server was picked up).

## Summary

Needs of 32, traps of 9, customer turns until REQUIREMENTS.md is approved, questions in 0a.

| | Needs | Traps | Turns | 0a questions |
|---|---|---|---|---|
| Plain 1 | 18 | 1 full + 1 partial | 18 | 5 |
| Plain 2 | 20 | 2 full + 1 partial | 21 | 5 |
| Edits 1 | 24 | 4 full + 1 partial | 10 | 2 |
| Edits 2 | 13 | 0 | 22 | 2 |

## Metrics per run

| | Plain 1 | Plain 2 | Edits 1 | Edits 2 |
|---|---|---|---|---|
| Customer turns until requirements approved (whole Phase 0) | 18 (about 25) | 21 (about 28) | 10 (about 12) | 22 (about 24) |
| Questions in 0a | 5 | 5 + folder path | 2 | 2 |
| Questions the customer could not answer | about 10 | about 12 | 0 in 0a, about 6 later | 0 in 0a, about 11 later |
| Needs fully covered (of 32) | 18 | 20 | 24 | 13 |
| Partly / not covered | 4 / 10 | 3 / 9 | 2 / 6 | 3 / 16 |
| Traps raised (of 9) | 1 + 1 partial | 2 + 1 partial | 4 + 1 partial | 0 |
| Asked about rules, limits, exceptions itself | no | partly (thresholds, tender, budget) | yes (thresholds, quotations, urgent, fixed assets, blocks) | no (edit 2 did not trigger) |
| Platform check | during design, after requirements | during design; in-system notifications not confirmed | before requirements (patterns and references read) | at the start of design, references read before DESIGN.md |
| Platform limits recorded | in Gaps & Proposals | in Gaps & Proposals | `Platform Limits` section | `Platform Limits` section |

## Needs (32)

S = from the source, I = inferred. P1/P2 = plain runs, E1/E2 = edited runs. Y = covered, p = partly, n = not covered.

| ID | Need | Src | P1 | P2 | E1 | E2 |
|---|---|---|---|---|---|---|
| U1 | Any employee can create and submit a request for their unit | S | Y | Y | Y | Y |
| U2 | A unit head can view, approve or reject requests of their unit | S | Y | Y | Y | Y |
| U3 | A unit secretary sees approved requests of their unit and turns them into orders | S | Y | Y | Y | Y |
| U4 | Finance staff see all requests, orders, budgets and invoices | S | Y | Y | Y | Y |
| U5 | Only the finance director gives the final approval of an order | S | Y | Y | Y | Y |
| U6 | Requesters and heads see only their own unit's data | I | Y | Y | Y | Y |
| W1 | Every request is approved by the local head before it becomes an order | S | Y | Y | Y | Y |
| W2 | A rejected request returns to the requester with a rejected status | S | Y | Y | Y | Y |
| W3 | The system compares the purchase amount with the available balance of the budget line | S | Y | Y | Y | Y |
| W4 | Order release is blocked when funds are insufficient, unless a transfer or emergency exception is recorded | S | p | n | Y | p |
| W5 | Approved orders for electronic suppliers are sent electronically | S | Y | n | n | n |
| W6 | Orders for non-electronic suppliers go back to the unit for manual sending | S | Y | n | n | n |
| W7 | Two printed copies for a manual order sent by post | S | Y | p | n | p |
| W8 | "On approval" (preview) orders still need a PO number before shipment | S | n | n | n | n |
| W9 | Finance matches the order, packing slip and invoice before payment authorization | S | p | Y | Y | Y |
| R1 | Micro purchases (up to $1,000): micro form instead of quotations | S | n | Y | Y | n |
| R2 | $1,000-$10,000: small-purchase form and at least two quotations | S | n | Y | Y | n |
| R3 | Over $10,000: formal tender run by finance, documents kept by finance | S | n | Y | Y | n |
| R4 | Equipment or long-lived property needs a fixed asset card | S | n | n | Y | n |
| R5 | The system prevents splitting one purchase into several small requests | S | n | n | Y | n |
| R6 | A budget code on the invoice that differs from the order is highlighted and explicitly confirmed by finance | S | n | p | Y | n |
| R7 | Every approved order gets a unique sequential number | I | Y | Y | Y | Y |
| R8 | After approval the requester and secretary cannot change the order lines without a procedure | I | n | n | n | n |
| R9 | Completed documents are kept in a searchable archive per the retention schedule | S | n | n | n | n |
| D1 | Reserved and actually spent funds are accounted separately | S | p | Y | p | Y |
| D2 | Requesters are notified of rejection and of the issued order | I | Y | Y | Y | n |
| D3 | Heads and secretaries are notified when a request enters their queue | I | Y | Y | Y | n |
| D4 | Finance is alerted if an invoice is posted to a different budget code | I | n | Y | Y | n |
| D5 | Finance report: available and reserved balances by budget line | I | Y | Y | Y | n |
| D6 | Finance report: open orders waiting for delivery or invoice | I | p | n | Y | n |
| D7 | Load the supplier directory with the order-acceptance method (electronic / non-electronic) | S | Y | p | p | p |
| D8 | Load the chart of budget accounts with starting balances | S | Y | Y | Y | Y |

## Traps (9)

| # | Trap | Src | P1 | P2 | E1 | E2 |
|---|---|---|---|---|---|---|
| 1 | Two supplier channels and the "two copies" rule | S | Y | n | n | n |
| 2 | Micro-purchase exemption from quotations (form PUR-F024) | S | n | Y | Y | n |
| 3 | Framework or recurring orders versus one-off | S | n | n | n | n |
| 4 | Budget code changes at the moment of invoice payment | S | n | n | Y | n |
| 5 | Preview ("on approval") orders | S | n | n | n | n |
| 6 | Tender documents are kept separately from the payment voucher | S | n | Y | n | n |
| 7 | Splitting a purchase into several requests | S | n | n | Y | n |
| 8 | Fiscal year end and carry-over of reserves | I | p | p | p | n |
| 9 | Emergency purchases before pre-approval | S | n | n | Y | n |

## Conclusions

1. **On needs and traps the averages are close** (plain 19, edited 18.5). The spread of the edited flow (24 and 13) is much larger than that of the plain flow (18 and 20). No stable gain in completeness is shown yet.
2. **Edits 3 and 4 worked in both runs.** Phase 0a asks the customer 2 questions instead of 5, and no question the customer could not answer (two in the plain runs); a `Platform Limits` section appeared in DESIGN.md in both; platform references were read before the design was written. This is a stable result.
3. **Edit 2 (the question about rules, limits and exceptions) worked in one run of two.** In edited run 1 the session asked about thresholds, urgent purchases, fixed assets and blocks and wrote 12 rules; in edited run 2 it skipped the question, so the document has no thresholds, exceptions, blocks, notifications or reports (the rules about requests, approval and balance are there). The edit should be made more reliable (for example a required question in the 0b list rather than a note in `followUpNote`) and retested.
4. **Supplier order channels and the two-copies rule (trap 1)** were not raised in either edited run; in plain run 1 the session raised them itself. Splitting purchases (trap 7) was raised only in edited run 1.
5. **Platform check.** The plain flow does it during design, after requirements are approved; the edited flow reads the references earlier and records limits in `Platform Limits`. In both flows platform limits (static security folders, number sequence reset on 1 January, no hard lock by status, an error rolling back the log write) surface in the design, not in the requirements.
6. **Limits of the test.** One scenario (a school district); the customer sheet was written by another AI from a public procedure; customer answers were given from the sheet (answers taken from the checklist: fiscal year, urgent purchases). The customer answer about partial deliveries and several invoices per order in the edited runs was given outside the sheet and checklist (in the plain runs the session proposed such deliveries itself); it does not change the counts, but partial deliveries appear in the documents of those runs. In plain run 1 the session asked about documents, in plain run 2 it did not: the plain flow also varies.
7. **Next:** make edit 2 more reliable and rerun twice; test separately the path "the customer already has a requirements document"; report the platform limits above to the platform team.

## Test on an existing requirements document (a public tender brief, 41 needs, 9 traps)

The customer brought a written description instead of an idea. One run of plain Phase 0 and one of Phase 0 with the edits.

| | Plain Phase 0 | With the edits |
|---|---|---|
| Needs covered (of 41) | 36 + 2 partly | 36 + 2 partly |
| Traps raised (of 9) | 0 + 2 partly | 2 + 3 partly |
| Customer turns until REQUIREMENTS.md is approved | 11 | 17 (the completeness check asks the gaps one by one, 10 questions) |
| Re-asked what the file already says | no | no |
| Gaps shown to the customer in Phase 0c (the Gaps section of DESIGN.md) | 3 items, accepted in one answer (example thresholds, one accountant per legal entity, the order is sent by hand) | 7 in one list, 4 to 5 of them technical (an owner field, a lock on editing, the legal entity code in a number, accounting fields) |

What it shows: both flows read the file and do not re-ask it, so no separate path is needed; the edits add the gap questions (2 traps raised against 0) at the cost of more customer turns in 0b; in 0c the customer is asked to confirm technical choices in both flows (3 items in the plain flow, 7 with the edits), which the 0c change in this branch is meant to remove; this is not yet verified in a live run.
