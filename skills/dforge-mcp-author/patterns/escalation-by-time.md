# Escalation and reminders by time

**Use when** the user says "if nobody approves in 3 days, remind / escalate", "overdue
documents go to the head", "every morning a list of what is waiting". The platform's tool is a
**scheduled job** that runs an action with no record and no user.

**Verification.** Everything about jobs below is read from the jobs reference and the action
DSL reference; **no job was run by us on a tenant**. Do not promise the user timing precision
beyond the cron minute, and verify the first real run by hand ("Run now" in the admin).

## Shape

```json
// logic/jobs.json
{ "jobs": [ { "code": "escalate_pending", "description": "Escalate documents waiting too long",
  "action": "escalate_pending", "schedule": "0 8 * * 1-5", "timeout": 120, "timeZone": "Europe/Kyiv" } ] }
```

```
# logic/actions/escalate_pending.dsl   (the job's action: no [field], no records)
canExecute:
    false

execute:
    let waitDays = getSetting('escalate_after_days')
    let cutoff = addMinutes(now(), -1440 * waitDays)
    let late = query("SELECT expense_id, title FROM wf.expense WHERE status = 'pending_l1' AND escalated_at IS NULL AND pending_since < @cutoff", { cutoff: cutoff })
    for r in late {
        update('wf.expense', r.expense_id, { escalated_at: now() })
        notify(getSetting('escalation_user_id'), 'Waiting too long: ' + r.title)
    }
```

The query and `update()` forms follow the DSL reference; the job as a whole is **unrun**.
`escalated_at` is the marker that stops the next run from repeating the notice.

- **The time a document entered a status must be stored.** The status column does not remember
  when it changed. Add a `timestamp` column (`pending_since`) that the submitting action
  sets (`[pending_since] = now()`); the job compares it to the cutoff. Without it the job can only use
  `last_updated`, which moves on every edit.
- **The job runs as the system user (`user_id = 0`)**, with the module root folder (or the
  folder an admin bound) as its settings context; so the delay lives in a **module setting**
  (`escalate_after_days`), not in the job's fixed `params`.
- **Gate the action to automation** with `canExecute: false` so no one runs it from a button.
  Grant no role `E` on it: a job needs none.
- **Writes from a job are raw.** `update()` raises no events: a trigger on the status will not fire
  for a status the job sets. If the escalation must notify someone, the job does it itself
  (`notify()` writes to the inbox only; `sendEmail()` raw mode; both need the mail provider
  configured for mail). Do not rely on a trigger to send the mail.
- **A scheduled run cannot print or post**; escalating is a status/field update plus a notice.
- **Idempotency is yours**: the schedule dedupes by slot, not by business key. Escalate only rows
  still in the waiting status, and set a marker (`escalated_at`) so the next run does not repeat
  the notice.
- Escalation target: "the manager's manager" cannot be derived by the platform (no linked-record
  variable); store the escalation role/user in a setting or on the document.

## Design rows

- Status Machines: the escalated state is a status of its own (`escalated`) with an action that
  leaves it, or a flag column; say which.
- Settings: `escalate_after_days` and who may change it (the `M` right on the folder).
- Outputs: the notice (`mail`/`inbox`) with `Mechanism` `job:<code>` and `Run by` `schedule`;
  a job cannot be verified by a test scenario, so `Verified by` is `manual: Run now, check the inbox`.
- Rules: the cron minute granularity; the weekday/time zone.
