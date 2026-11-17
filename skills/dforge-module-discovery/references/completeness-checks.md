# Discovery — completeness checks

Run these on the agreed answers before writing `docs/SPEC.md` (Step 7 of `SKILL.md`).
The right column says what the check catches, i.e. what users otherwise find while
testing a built module. A failed check becomes one question with a proposal; what
cannot be settled becomes an open question in the last section of the spec.

| # | Check | Catches |
|---|---|---|
| 1 | Every status of every record with a lifecycle has a way in and a way out, or is stated to be final (closed, cancelled). | A record stuck in a status; no way to correct a mistake |
| 2 | Every record type has a decision for cancel, delete (default: never deleted, only cancelled) and what happens to related records. | Rules added after testing: cancel reasons, delete refusals |
| 3 | Every status change says who may do it and what is refused at each status (an `R-` statement or an explicit "nothing special"). | Forbidden-action rules found one by one in manual testing |
| 4 | Every date with a deadline or an expiry (due date, promised date, expiry of a document) has a decision on an overdue or expiring notice: yes or no, to whom, in the system or by e-mail. | Notifications invented late |
| 5 | Every kind of person has a stated "sees" and "changes"; every record type has someone who can create it and someone who can read it; nobody is silently allowed everything. | "My records" folders shown to all roles, missing rights found after install |
| 6 | Every number users read is either entered or calculated; every calculated value has its rule and its unit. | Totals, durations and flags redesigned after use |
| 7 | Every printed document or file has a sample or a field list; every field is on an entity or is calculated; who prints or receives it and who signs (paper or system) is stated. | A form missing a field once it is printed |
| 8 | Every report states for whom, which decision it supports and a default period; every report reads data that the entities hold. | Reports rebuilt or dropped after use |
| 9 | Every main record has a main scenario from creating to closing; every forbidden action in 3 has a negative scenario; every scenario ends with something observable. | Gaps found by hand testing instead of by a scenario |
| 10 | Every directory has a source and a volume for its initial data; the people and kinds of access to be created are listed. | An empty system at launch; roles nobody created |
| 11 | No two statements contradict each other (for example "workers see only their own" and "everyone sees all"); every statement id is defined once. | Conflicting rules found at design validation or later |
| 12 | Every open item says who must answer or which assumption must be confirmed. | `TBD` that blocks the Phase 0 design check |

How to run: go through the list silently, in this order. Do not narrate each check.
Ask only about failures, one question per turn. After the user answers, re-run the
affected check. Record the outcome in one line at the end of the spec (for example
"completeness: 12 checks, 3 questions asked, 1 open").
