# Multi-step approval (a chain of roles)

**Use when** the user says "first the manager, then the finance director, then the CEO", "each
level confirms in turn", "a reject sends it back to the author". Builds on
`status-machine-document` (read it first: `VM` status with a default, actions are the only way
to change it). For "which approver by amount" use `approval-by-amount` instead; the two combine
(the amount decides how many steps the document needs).

**Verification.** The mechanics each step relies on were verified on a tenant in module `wf`
(status written only by actions, `canExecute` on a status, `E` per action and role, a hidden
action refused even by its `actionId`). A chain of three or more steps with a reject path was
**not** run as such; treat the shape below as a composition of verified parts.

## Shape

- One status column, in workflow order: `draft`, `pending_l1`, `pending_l2`, `approved`,
  `rejected`. Flags `VM`, default `'draft'`.
- One action per step, each tested on the status it starts from and restricted by `E` to its
  role. No action may be open to every status (`validate` reports `wf:transition-open`).

```
# submit.dsl            (author)
canExecute:
    [status] = 'draft' OR [status] = 'rejected'
execute:
    [status] = 'pending_l1'

# approve_l1.dsl        (role: manager)
canExecute:
    [status] = 'pending_l1'
execute:
    [status] = 'pending_l2'

# approve_l2.dsl        (role: finance director)
canExecute:
    [status] = 'pending_l2'
execute:
    [status] = 'approved'

# reject.dsl            (every approver role; the status it starts from is a list)
canExecute:
    [status] = 'pending_l1' OR [status] = 'pending_l2'
execute:
    [status] = 'rejected'
```

- A reject the author can re-submit ends in `rejected` and `submit` accepts it (the example). A
  reject that ends the document drops `OR [status] = 'rejected'` from `submit`.
- **Who approved which step** is not stored by the status. If the user needs it (audit, a
  printed approval sheet), add columns `l1_by`, `l1_at`, … that each action fills, or use the
  `audit-full` trait only when "who changed each row" is the whole need; say which in the design.
- The step an approver may take is decided by the status, not by the role: the role only
  chooses who may run the action. A manager never sees `approve_l2` (no `E`), and `approve_l2`
  refuses a document in `pending_l1` even for the director.
- A reason for the reject: either a column the approver fills before running `reject`, or an
  action parameter. Action parameters were **not** run by us; prefer the column.

## Design rows

- Status Machines: the statuses above and every transition with the role that makes it.
- Permissions Matrix: author `SIU` + `E` on `action:submit`; each approver `E` on its step action
  and `S` on the document (without `S` the button never appears); the reject action to each approver.
- Rules: "an approver cannot approve their own document" is **not** expressible in `canExecute`
  (it sees columns of the record, not who is calling); enforce it in `execute:` by comparing the
  author column with the user (`CURRENT_USER_ID()` is formula-only, so this needs the author's
  id stored in a `user` column and a check in the action: **unverified**, ask core before
  promising it).
- Gap to raise: what happens to a document whose approver leaves the company (the role is
  assigned by the tenant admin; a document in `pending_l2` waits for whoever holds the role).

## Verified by

`validate` reads the chain: an action setting a value that is not an option (error), an option
nothing leads into or leaves, an action without a status guard (`wf:*`). Role access is a
Permissions Matrix row checked by `validate`; the test runner acts only as `admin`, so a
scenario covers the status results (`submit` → `pending_l1`, `approve_l2` on it is refused with
`refused: canExecute`) and "the manager cannot run the director's action" is `manual:`.
