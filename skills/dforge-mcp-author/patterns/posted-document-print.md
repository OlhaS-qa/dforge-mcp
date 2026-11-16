# Posted document with a print form

**Shape.** A document (hire order, act, invoice) is typed in as `draft`, a person
runs one action that applies its effect to other records and sets `posted`, and a
print form renders the posted document. Verified on the HR orders module
(hire/dismissal orders; validate clean, scenarios green).

## Design rows (DESIGN.md)

- Entity `<doc>` with traits `identity`, `audit`; a number sequence on `<doc>_no`
  (`pattern: "{yyyy}-{seq:4}"`, `resetPeriod: "year"`); `status` dropdown
  `draft` → `posted` (3+ states → status machine, not a boolean).
- **Every printed datum is a field of `<doc>`.** A datum that lives on another
  entity (employee name, tax id) is copied into the document. A navigation
  formula (`[employee].[full_name]`, flag `F`) is evaluated **on read**, so it is
  only the *current* value: edit the employee and a reprinted, already posted
  order changes (`references/print-templates.md`: formula columns are read in the
  same SQL as the record). A posted order must keep what was true when it was
  signed, so store a **snapshot**: a plain column (no formula, flag `V`, no `E`)
  that `post_<doc>` fills (`[employee_name] = [employee].[full_name]`), and print
  that column. Use a live formula column only for data that must follow the
  source. Not verified on a tenant yet: that `execute:` can read
  `[employee].[full_name]` (a `canExecute` can; see `references/action-dsl.md`).
  If it cannot, pass the value in as an action parameter.
- Actions table: `post_<doc>`, `executionMode: single`, runs from the card.
- Permissions Matrix: the role that types the document `SIU` on `<doc>`; the role
  that posts it adds `action:post_<doc>` = `E`; every lookup target the role
  fills gets `S`.
- Outputs row: `| O-n <Doc> | print | <doc>.<every printed field> | print:<doc> | <role> | manual: print and compare with the sample |`.
- Settings: signatory names and similar constants go to `settings.json` and are
  read as `{{ _settings.<code> }}` — declare each one, an undeclared name prints empty.

## Files

`logic/actions/post_<doc>.dsl`

```
canExecute:
    [status] = 'draft'

execute:
    var emp = getRecord('<module>.employee', [employee_id])
    if (emp.status != 'candidate') {
        error('Employee {name} cannot be hired', { name: emp.full_name })
    }
    update('<module>.employee', [employee_id], { status: 'active', hire_date: [start_date] })
    [status] = 'posted'
    info('Order {no} posted', { no: [<doc>_no] })
```

`ui/print_templates.json` (nothing goes in `manifest.json`; the installer reads
this file and `print_templates/<file>`):

```json
{ "<doc>": { "entityCd": "<doc>", "description": "<Doc>", "file": "<doc>.html", "css": "order.css",
  "pageSettings": { "size": "A4", "orientation": "portrait", "margins": { "top": "20mm", "right": "20mm", "bottom": "20mm", "left": "25mm" } } } }
```

Template body: `{{ column }}` for text, `{{ _raw.<date> | format_date: '%Y-%m-%d' }}` for a
date, `{{ _raw.<amount> | format_number: 2 }}` for money (groups by
`pageSettings.culture`), `{% if probation_months %}…{% endif %}` for optional parts.

## Scenario (tests/<doc>.test.json)

Two tests: posting applies the effect (`expect` on both records), and posting a
posted document is refused (`"expect": [{ "refused": "canExecute" }]`). The runner
has no print step, so the printed form is `manual:` in Outputs.

## Pitfalls seen

- Reading a name that is not a column of `<doc>` in the template prints empty:
  `out:print-placeholder` catches it.
- The role that prints needs `S` on `<doc>`; there is no separate print right.
- Text the user must not see through a lookup: the copy column shows it anyway; keep
  such fields off the form's source entity.
