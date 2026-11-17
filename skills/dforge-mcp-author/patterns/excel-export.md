# Excel register / export

Two mechanisms; pick by what the receiver needs.

| Receiver needs | Use | Output row Mechanism |
|---|---|---|
| The entity's rows as a plain csv/xlsx | the grid's Export (`data.export`), nothing to build | `export:<entity>` |
| A fixed layout: title, number formats, totals, logo cells | an Excel template | `xlsx:<template>` |

Both read **one entity** only: its columns with flag `V`, not identity, not
`F`/`S`/`Q`. No child sets, no report, no named view. **A formula (`F`) column does not
reach the file.** If the receiver needs a computed value, store it: a physical
column filled by the action or trigger, or a Generated (`G`) column. (In a test run
of a payroll export, 6 of 11 columns were `F` and would have been lost.)

## Design rows

- Fields per Entity: every column of the sample, as a stored column with `V`.
- Outputs row: `| O-n Payroll register | export | <entity>.<col>, … | xlsx:<template> | <role> | manual: export and compare columns |`.
- Permissions Matrix: the role has `S` on `<entity>`. That is the only right needed.
- Run by a person on screen; **not in a job**: `exportXlsx()` is refused without a signed-in user.

## Files for `xlsx:<template>`

`ui/export_templates.json` (nothing in `manifest.json`):

```json
{ "invoice_list": { "entityCd": "invoice", "description": "Invoice register", "file": "invoice_list.xlsx" } }
```

Workbook at `export_templates/invoice_list.xlsx`. Cells:

| In a cell | Result |
|---|---|
| `{{rows.column_cd}}` | the row repeats once per record (column code, not label; a reference shows its display value) |
| `{{_count}}`, `{{_today}}` | row count, today's date |
| `$=SUM(D{{$enumrowstart}}:D{{$enumrowend}})` | total over the repeated rows |

Dates arrive as Excel serial numbers: give the cell a date format. Put repeated
blocks one under another, not side by side. Group or branch in the workbook
itself (a second sheet with `SUMIFS`), not with `@group`/`@if`.

From an action: `exportXlsx('<module>.invoice', 'invoice_list', { filter: { c: 'sold_on', o: '>=', v: '2026-01-01' }, orderBy: …, fileName: 'register.xlsx' })` returns
`{ url, fileName, recordCount }` and hands the user the file as the action's download.

## Not available (do not promise)

One record with its child sets in Excel; attaching the file to a mail; upload of a
template through the admin UI; export of a report; background export of large sets.
The tool cannot look inside the `.xlsx`: whether `{{rows.col}}` names real columns is
checked by eye — open the exported file once (`manual:`).

Row filter: `data.export` always runs in a folder (a call with no folder is refused: "Folder context required"), and it builds the query like `data.get`, so the folder's row filter and the entity view's columns apply (read from code by two core sessions, no test). Run by a role with a row-filtered folder, the export contains only its rows. `exportXlsx()` is refused in a job, so "mail the register to the accountant on a schedule" cannot be built on it.
