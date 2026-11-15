# Document with an approval status machine

**Verified on a test tenant (dForge 2026-11-15, module `wf`, 13 scenarios; see `mcp-module-test/v5/wf-test`):** `VM` + default `'draft'` replaces a status sent on insert; an update of only the status is refused (`INVALID_REQUEST: No valid columns to update`) and a mixed update keeps the other columns and drops the status; an action's `[status] = …` is written; a sync trigger on `status_change` with `error()` refuses reopening an approved document; `canExecute` with `*` and `ABS()` evaluated correctly both ways. Not verifiable by the runner (admin only): who may run an action.

**Use when** a document goes draft → submitted → approved / rejected (→ draft) and
status must change only through actions. Source: core's guidance; read from core code, not run in a module of ours.

## Two parts

**(a) Make the status read-only.** Declare `status` visible and mandatory but **without the `E`
flag** (`"flags": "VM"`) **with a default `'draft'` that fires on insert** (`"formula": "'draft'"`). Without a default, a mandatory non-editable column must be supplied by the creating user, who could send `'approved'`; with a default the platform drops the caller's value and fills `draft`. A kanban on this column becomes view-only (open the card, press the button). Insert and update silently drop a user-supplied value
for a non-editable column (a mandatory column without default is the exception), so
a user, REST call or bulk update cannot set it. Only an action changes it:
`[status] = 'approved'` (an action's assignment ignores `E`; triggers still fire on it).

**(b) Forbid transitions the machine must not allow** with a synchronous trigger,
because a check constraint cannot see the old value (use it only for static rules such as "approved needs approved_by"), and `E` only gates the UI and `data.update` by users. Actions are written by the module's developer and installed with the module (a user cannot create one), so an action writing the column directly is the intended path, not a hole; the guard trigger is for transitions that must be refused **even for the module's own actions and other modules' actions** (a developer's mistake, a bridge module). Core's `logic/workflows/*.json` state-machine files are a proposal, not shipped; do not author them:

```json
{ "triggers": [ {
	"code": "doc_status_guard", "entity": "document", "event": "status_change",
	"action": "guard_doc_status", "async": false
} ] }
```

`logic/actions/guard_doc_status.dsl`:

```
execute:
    if (old[status] == 'approved' && [status] != 'approved') {
        error('An approved document cannot change status')
    }
```

`async: false` runs in the writer's transaction; `error()` rolls the whole write
back. `old[...]` is the pre-change record in actions called by a trigger (update, delete, status_change); do not use `old` as a local name. A
trigger's action needs no Execute right.

## Design rows

- Status Machines: every value, every transition, who may do it, what happens on
  refusal. A reject must say whether it is terminal or returns to draft (recovery
  path), or it is a gap.
- Actions: `submit_<doc>`, `approve_<doc>`, `reject_<doc>` (each `canExecute: [status] = '<from>'`). Keep `canExecute` a plain comparison on columns joined with AND. Install refuses a `canExecute` that calls a function the server cannot evaluate (`FOO()`), and says to read settings or count children inside `execute:` instead; core also warned that some forms fail open (arithmetic and `ABS()` were evaluated correctly in our run, so the warning is unreproduced).
- Permissions Matrix: `E` on `action:approve_<doc>` only for the approver role;
  the author role gets `SIU` on `<doc>` and `E` on `action:submit_<doc>`.
- Rules: "approved cannot be edited" is enforced by trigger `doc_status_guard`
  (name the mechanism, or it is a gap).

## Scenario

Tests: submit → approve → the status is `approved`; approve twice is refused
(`"refused": "canExecute"`); a direct edit of status is not applied. The runner
acts as admin only, so "the author cannot approve" stays a matrix row checked by
`validate`.

## Posting instead of approving

For a document whose posting must freeze it in the database, registers have
`lockedFields` (a DB-level lock of a posted document); that is a different
mechanism from approval.
