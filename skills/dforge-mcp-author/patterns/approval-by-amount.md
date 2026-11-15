# Approval by amount (limits from settings)

**Use when** the rule is "up to X no approval, up to Y a manager approves, above Y
the director". Verified on a test tenant (module `wf`, scenarios in
`mcp-module-test/v5/wf-test`). Builds on `status-machine-document`.

## Shape

- `amount` column; `status` `VM` with default `draft` (see `status-machine-document`).
- Limits are **module settings** (`settings.json`: `limit_low` = 1000, `limit_high` =
  1000000, number/decimal), so the tenant admin changes them without a release.
- One action per approver and one to submit; each right is `E` on the action for its role.

```
# submit_expense.dsl
canExecute:
    [status] = 'draft'
execute:
    if ([amount] <= getSetting('limit_low')) { [status] = 'approved' } else { [status] = 'submitted' }

# approve_manager.dsl   (role: manager)
canExecute:
    [status] = 'submitted'
execute:
    if ([amount] > getSetting('limit_high')) {
        error('Above {lim} only the director approves', { lim: getSetting('limit_high') })
    }
    [status] = 'approved'

# approve_director.dsl  (role: director) — mirror image: error when amount <= limit_high
```

**Why the amount check sits in `execute:`, not in `canExecute`.** `canExecute` is a
formula the server evaluates without settings (its scalar walker and SQL translator have no
rule for a `$[setting]` reference; the browser's `getSetting` is a stub returning null): install
refuses `$[x]` or an unknown function and says to read settings inside `execute:`. Core
confirmed the fix is feasible but it is not built or scheduled; do not use `$[x]` in
`canExecute` until it ships. The cost: a manager sees the
button on a large expense and gets the error on click. Hiding the button needs the
limit as a column (a copied value on the record), which then freezes the limit at
submit time — decide which you want and say it in the design.

## Design rows

- Status Machines: draft → approved (amount ≤ low), draft → submitted → approved
  (by the role that matches the amount). A reject path if the user needs one.
- Settings: both limits, with who may change them.
- Permissions Matrix: author `SIU` on the document + `E` on `action:submit_*`;
  manager `E` on `action:approve_manager`; director `E` on `action:approve_director`.
  Each action needs `S` on the document for its role, or the button never appears.
- Rules: "limits are read at click time; changing a setting does not re-route documents
  already submitted".
- Gap to raise with the user: a limit boundary (is exactly 1000 approved?). The sample
  above is `<=` low, `>` high.

## Verified by

Scenarios as `admin`: 500 approved at submit; 50000 waits, the director action errors,
the manager action approves; 2 000 000 the manager action errors, the director approves.
"The manager role cannot run the director action" is a Permissions Matrix row checked by
`validate`; the runner cannot act as another role.
