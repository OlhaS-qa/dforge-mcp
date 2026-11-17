# Equipment repair requests — design notes (example)

For `dforge-module-design`, not for the customer. Example for the invented customer in
`equipment-repair-spec.md`. Facts about the platform are from the references named in
the last column; anything not confirmed is marked `unchecked`.

## 1. Platform fit
- No other module is needed: people are platform users, the supplier of a part is text.
- One owner per kind of data: the module owns equipment, sections, parts, requests.
- Folders: one for workers ("my requests"), one for mechanics (all requests), one for
  section heads (requests of their sections).

## 2. Platform limits and how the specification works around them
| Need | What the platform does | Workaround in the specification | Checked against |
|---|---|---|---|
| Workers see only their own requests | a folder row filter compares a user-type column with the current user, in a folder, not in a view | an owner column of type user on the request, filtered in the workers' folder | `dforge://reference/security` |
| Section heads see the requests of their section | the filter cannot follow a link to another record (a request to its section's head) | the head's user id is copied onto the request when it is created | `dforge://reference/security` |
| Notices to "the mechanics" | the module does not know who holds a role; the tenant admin assigns roles | notify everyone holding the mechanic role; the admin assigns it | `unchecked` |
| Overdue notices | a scheduled job can send in-system notices and e-mail; a print form cannot be produced in a job | an hourly job sets flags so each notice is sent once; e-mail only for the 24-hour notice | `dforge://reference/jobs` |
| Cost uses the hourly rate | a module setting is available to actions | the rate is a setting; the cost is computed when the request is completed | `dforge://reference/settings` |

## 3. Basis
A typical equipment-maintenance solution (equipment, requests, preventive schedule,
spare parts) from the platform's list of module ideas, adapted to the customer's form
and rules. No internet.

## 4. Scheduled checks and settings (technical view)
- Job `overdue_check`, every hour: sets the overdue flags and sends the notices once.
- Setting `labor_rate`, number, default 0, changed by the section head.

## 5. First-install checks
- The roles are assigned in the folders (a role without a folder assignment sees every row).
- The sections (with their heads) and the equipment are loaded from the customer's tables.
- One request goes through raising, taking into work, completing and closing, and the
  printed request matches the customer's form.

## 6. Not checked
- Whether the mechanic-role recipients can be resolved inside a notification (see section 2).
