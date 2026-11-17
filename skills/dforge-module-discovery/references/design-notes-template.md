# docs/SPEC-design-notes.md — template

For `dforge-module-design`, **not for the customer**. Written by the discovery skill
during the quiet research of Step 2 and updated while the interview changes the
picture. The customer sees only the consequences in business words, in
`docs/SPEC.md` (sections 3, 14 and 17).

Mark everything you could not confirm as `unchecked`; an unchecked platform fact is a
question for the design phase, never a promise to the customer.

```markdown
# <Module> — design notes

## 1. Platform fit
- Modules the solution uses, depends on or bridges to, and why. "None" is an answer.
- Who owns which data (one owner per kind of data; the others only use it).
- How the pieces connect (bridges, extensions, folders).

## 2. Platform limits and how the specification works around them
| Need | What the platform does | Workaround in the specification | Checked against |
|---|---|---|---|
| e.g. "a head sees the requests of their section" | a folder row filter compares a user column with the current user; it cannot follow a link to another record | copy the head's user id onto the request when it is created | `dforge://reference/security`; `unchecked` if not confirmed |

Typical limits to check against the references and the modules you can see: row
visibility by owner or by a related record, hierarchies ("everyone below me"), who
holds a role (the module cannot list users of a role), exports of one entity only,
reports and print forms (a print form needs a signed-in user, not a job), e-mail and
notices from a scheduled job, number sequences, settings.

## 3. Basis
What the draft was built from: the typical solution (by name), modules and documents
read, anything taken from the customer's own materials. No internet.

## 4. Scheduled checks and settings (technical view)
Jobs and their frequency, the settings and their defaults, who may change them.

## 5. First-install checks
What to look at on the first installation: roles assigned in the folders, the lists
loaded, the first request end to end.

## 6. Not checked
Everything above marked `unchecked`, in one list.
```
