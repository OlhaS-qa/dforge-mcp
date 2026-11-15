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

# approve_manager.dsl   (role: manager) — the limits are in canExecute
canExecute:
    [status] = 'submitted' AND [amount] > $[limit_low] AND [amount] <= $[limit_high]
execute:
    [status] = 'approved'

# approve_director.dsl  (role: director)
canExecute:
    [status] = 'submitted' AND [amount] > $[limit_high]
execute:
    [status] = 'approved'
```

**`$[setting]` in `canExecute`** (needs a core release that has it; the MCP's dev tenant has it).
The server evaluates the setting for the folder the call runs in (nearest folder, then the
module default) and the browser reads the same value, so the button is hidden **and** the
server refuses (`ACTION_NOT_AVAILABLE`) when the amount is outside the role's band. Verified
on a tenant: with limits 1000/1000000 the manager action ran on 5000 and was refused on 500
and 2 000 000; the director action ran on 2 000 000 and was refused on 500; after the tenant
admin set `limit_high` = 3000, the manager action ran on 2000 and was refused on 5000, at once,
without reinstalling. A tenant on an older core refuses the install (`$[x]` in canExecute);
there, keep the amount test in `execute:` with `error('Above {lim} only the director approves',
{ lim: getSetting('limit_high') })`, and say in the design that the button stays visible.

Core states that an **unset** setting reads as NULL, so the comparison is false and the action is refused for
everyone (not run by us): give every limit a default in `settings.json`. Changing a setting needs the `M`
right on the folder (not `E`), so a director cannot move the limits unless granted it.

## Design rows

- Status Machines: draft → approved (amount ≤ low), draft → submitted → approved
  (by the role that matches the amount). A reject path if the user needs one.
- Settings: both limits, with who may change them.
- Permissions Matrix: author `SIU` on the document + `E` on `action:submit_*`;
  manager `E` on `action:approve_manager`; director `E` on `action:approve_director`.
  Each action needs `S` on the document for its role, or the button never appears.
- Rules: "limits are read at click time; changing a setting does not re-route documents
  already submitted" (a document that fell out of the manager's band waits for the director).
- Gap to raise with the user: a limit boundary (is exactly 1000 approved?). The sample
  above is `<=` low, `>` high.

## Verified by

On a tenant, as three real users (author/manager, director, tenant admin): the band
checks above, the hidden actions (a manager cannot run the director action even by its
`actionId`: `PERMISSION_DENIED`), and a setting change taking effect at once. The test
runner acts only as `admin`, so a module test covers the status results (500 approved at
submit; 5000 `submitted`; the band actions with `refused: canExecute` outside it), while "the
manager role cannot run the director action" is a Permissions Matrix row checked by `validate`.
