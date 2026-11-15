# A role that sees only its own records

**Use when** the user says "an employee sees only their own card / requests /
payslips". Source: core's answer; the `isCurrentUser` filter is in production in other
modules and the installer accepts it in a folder's `rowFilter` and it is applied at run time
(read from code; the only shipped example is a view, not a folder) — **check it live once**. The row filter and the id also apply to update and delete, so
own-row-only holds for writes.

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

3. The role holds `S` on the entity as usual; the folder narrows the rows. A role
   with the same rights but **no folder assignment sees every row**: say so in the
   design as an admin task, never as something the module guarantees.

## Design rows

- Fields per Entity: `user_id` (owner) on every entity the role reads.
- Visibility: "<role> sees only records where `user_id` is the current user, in folder `<code>`".
- Permissions Matrix: only `S` (plus whatever it may change) on those entities; a
  note that the folder assignment is made by the tenant admin.
- Outputs: an export or Excel template run by this role is limited by the folder's row filter (exports always run in a folder).

## Pitfalls

- Verification: the test runner acts only as admin, so this is `manual:` (log in
  as the employee, check the grid).
- Do not write `folder:` keys in `roles.json` (rejected by pack).
