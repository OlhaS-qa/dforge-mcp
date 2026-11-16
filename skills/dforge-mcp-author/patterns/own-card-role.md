# A role that sees only its own records

**Use when** the user says "an employee sees only their own card / requests /
payslips". Source: core's answer; the `isCurrentUser` filter is in production in other
modules and the installer accepts it in a folder's `rowFilter`.
**Verified live** (module `wf`, `mcp-module-test/v5/wf-test`, child folder `my_expenses`, column
`owner_id` of type `user`): the manager reading `wf/my_expenses` got only the record whose
`owner_id` is their id, while the same user reading the parent folder `wf` got all 13 rows. The row filter and the id also apply to update and delete, so
own-row-only is documented for writes (writes not run by us).

## Mechanism

The module scopes rows; the **tenant admin still assigns** the role to the user in
that folder (`user_role(user, role, folder)`) — the module cannot do it.

1. The entity needs a column holding the **tenant user id** of its owner: type
   `user` or a number/`cuid` column. A guid column makes the condition unusable: in a **folder `rowFilter` the read or
   write is refused (fails closed)**, but the same condition in a **view `filter` is silently
   ignored and shows more rows (fails open)** — so keep this scoping in the folder, never in a
   view alone, and check the column type. There is no
   "linked record" variable (`employee.user_id = me` through a reference does not work), so
   every entity the role reads carries its own `user` column. `CURRENT_USER_ID()` exists in
   `F` formulas, not in row filters.
2. A folder for this role binds the entity with a row filter:

```json
{
	"entities": {
		"payslip": { "rowFilter": { "c": "user_id", "o": "f", "v": { "fn": "isCurrentUser" } } }
	}
}
```

(`rowFilter` may also be a SQL string; the `{c,o,v}` / `{g,i:[]}` tree is the
same as in `ui/data_views.json`.) Plain equality only: "my subordinates" through a
`manager_id` cannot be expressed.

   **The owner column is not filled for you.** A record inserted without `owner_id` has it NULL
   and is visible to nobody in the own-card folder; set it in the creating action, a trigger, or
   the entry form. Ids of users come from the `user` lookup (RPC `user.getAll` lists them).
3. The role holds `S` on the entity as usual; the folder narrows the rows. A role
   with the same rights but **no folder assignment sees every row**: say so in the
   design as an admin task, never as something the module guarantees.

## `inheritSecurity`: where the role is assigned

Write the own-card folder as a **child** of the module folder (`children.my_card`).

- `"inheritSecurity": false` is the right choice when the people in this folder must **not** be
  able to reach the parent's rows: a role assigned on the parent does not reach the child (verified: the manager
  holding the role on `wf` got `ENTITY_NOT_ACCESSIBLE` in the child), so the tenant admin assigns the role
  in the child folder (`user_role(user, role, child folder)`) for exactly those people. Needs a core with commit
  `d192478be` (2026-11-15): from then on the **installer** (the admin who installed) also receives the module's roles in such a
  child and so sees the folder and can assign roles in it. Before that fix the folder was hidden from every user
  without a grant, the tenant admin included (`folder.getAll` filters by access), and nobody could assign a role in it. Verified:
  after reinstall the admin sees `wf/my_expenses` and reads it through the row filter.
- `"inheritSecurity": true`: the role assigned on the parent reaches the child, so a user with the
  role on the parent sees all rows there; the child only offers the narrowed view.
- Other users never get the child's roles automatically: the admin assigns them.

## Design rows

- Fields per Entity: `user_id` (owner) on every entity the role reads.
- Visibility: "<role> sees only records where `user_id` is the current user, in folder `<code>`".
- Permissions Matrix: only `S` (plus whatever it may change) on those entities; a
  note that the folder assignment is made by the tenant admin.
- Outputs: an export or Excel template run by this role is limited by the folder's row filter (exports always run in a folder).

## Pitfalls

- Verification: the test runner acts only as admin, so this is `manual:` (log in
  as the employee, check the grid).
- The whole check was done with RPC calls as two real users; a module test cannot do it.
- Do not write `folder:` keys in `roles.json` (rejected by pack).
