# Requirements completeness check (Phase 0b)

Run these checks silently on the agreed answers **before writing
`docs/REQUIREMENTS.md`** (and again on the file before asking for YES). The right
column is what users otherwise find while testing a built module. A failed check
becomes **one question with a proposal** ("Gap: … Proposal: … Confirm or change?");
what cannot be settled is written down as an open item that names who must answer.

| # | Check | Catches |
|---|---|---|
| 1 | Every status of every record with a lifecycle has a way in and a way out, or is stated to be final (closed, cancelled). | A record stuck in a status; no way to correct a mistake |
| 2 | Every record type has a decision for cancel, delete (default: never deleted, only cancelled) and what happens to related records. | Rules added after testing: cancel reasons, delete refusals |
| 3 | Every status change says who may do it and what is refused at each status (a rule, or an explicit "nothing special"). | Forbidden-action rules found one by one in manual testing |
| 4 | Every date with a deadline or an expiry (due date, promised date, expiry of a document) has a decision on an overdue or expiring notice: yes or no, to whom, in the system or by e-mail. | Notifications invented late |
| 5 | Every kind of person has a stated "sees" and "changes"; every record type has someone who can create it and someone who can read it; nobody is silently allowed everything. | "My records" folders shown to all roles, missing rights found after install |
| 6 | Every number users read is either entered or calculated; every calculated value has its rule and its unit. | Totals, durations and flags redesigned after use |
| 7 | Every printed document or file has a sample or a field list; every field is on an entity or is calculated; who prints or receives it and who signs (paper or system) is stated. A document that leaves the organisation (an order to a supplier, a letter, a contract) also says how it is sent (e-mail, post, fax, by hand or by phone; the same for every recipient or not), how many copies are printed and who signs it. | A form missing a field once it is printed; the paper steps of a document sent to some recipients discovered only in use |
| 8 | Every report states for whom, which decision it supports and a default period; every report reads data that the entities hold. | Reports rebuilt or dropped after use |
| 9 | Every main record has a main scenario from creating to closing; every forbidden action in check 3 has a negative scenario; every scenario ends with something observable. | Gaps found by hand testing instead of by a scenario |
| 10 | Every directory has a source and a volume for its initial data; the kinds of people to be created are listed. | An empty system at launch; roles nobody created |
| 11 | No two statements contradict each other (for example "workers see only their own" and "everyone sees all"); every statement id is defined once. | Conflicting rules found at design validation or later |
| 12 | Every open item says who must answer or which assumption must be confirmed. | `TBD` that blocks the Phase 0 design check |
| 13 | Every fact was said by the user or accepted by the user as a proposal; nothing the user did not ask for is presented as their requirement. | Requirements nobody asked for |
| 14 | Every output keeps the form the user named (an Excel list is not silently turned into a report) and every figure comes from the user or is marked as a proposal. | A lost output form; an invented deadline or amount |

## How to run

- Go through the list silently, in this order. Do **not** announce the checks or
  read them out to the user.
- Ask only about failures, **one topic per turn**, at most five proposals per
  turn. A gap is a missing decision, not a new feature: do not add functions the
  user did not ask for.
- After the user answers, re-run the affected check.
- Figures (amounts, limits, deadlines) are never invented: they come from the
  user, or the gap stays open and names who must answer.

## Rules, limits and exceptions (one open question)

The checks above find missing decisions about things already mentioned. They
cannot find a rule nobody mentioned, and only the customer knows these. Ask
**once**, in plain words, near the end of the intake:

> _Are there rules, limits or exceptions that the system must know about: amounts
> and norms, time limits, thresholds, or people who work differently (contractors,
> people who have left, temporary staff)? And is there anything that must be
> blocked?_

Write each answer as a rule with its figure. If the answer is "no", write that
nothing special was named.
