# Number Sequences Reference

dForge has built-in **automatic document numbering**. Declare a sequence on an entity, and any INSERT that leaves the target column empty gets the next value assigned automatically — no DSL, no manual counter, no race conditions.

## Declaring on an entity

```json
{
    "description": "Invoices",
    "dbObject": "invoice",
    "toString": "{number}",
    "traits": ["identity", "audit"],
    "numberSequence": {
        "column": "number",
        "defaultPrefix": "INV",
        "pattern": "{prefix}-{yyyy}-{seq:4}",
        "resetPeriod": "year"
    },
    "fields": {
        "number": {
            "dbDatatype": "varchar",
            "fieldTypeCd": "text",
            "flags": "VEM",
            "maxLen": 50,
            "orderNum": 10,
            "description": "Invoice Number"
        },
        /* ... */
    }
}
```

The platform:

1. On INSERT, checks if the `number` column is empty.
2. If empty, atomically increments the counter and formats the value.
3. Writes it into the column before the row is committed.

`column` and **`defaultPrefix` are REQUIRED** by `entity.schema.json` (an earlier version of this page omitted `defaultPrefix`). `defaultPrefix` is the fallback for `{prefix}` when no setting resolves it. `dforge_entity_configure` writes the block with both and checks the placeholders.

No code needed on your side. No DSL. No race conditions (the counter uses a database-level atomic operation).

## Pattern placeholders

| Placeholder | Meaning | Example |
|---|---|---|
| `{prefix}` | The prefix: the `prefixSettingCd` setting, else `defaultPrefix` | `INV` |
| `{yyyy}` | 4-digit year | `2026` |
| `{yy}` | 2-digit year | `26` |
| `{mm}` | 2-digit month | `04` |
| `{dd}` | 2-digit day | `08` |
| `{seq:N}` | Zero-padded counter with N digits | `{seq:3}` → `001`, `002`, ... |

You can combine them freely:

```
"INV-{yyyy}-{seq:4}"           → "INV-2026-0001"
"Q{yyyy}{mm}-{seq:3}"          → "Q202604-001"
"{dd}/{mm}/{yyyy}-{seq:2}"     → "08/04/2026-01"
"PO-{seq:6}"                   → "PO-000001"
```

## Reset periods

`resetPeriod` controls when the counter resets to 1:

| Value | Resets |
|---|---|
| `"never"` | Counter never resets (monotonic forever) |
| `"year"` | Counter resets on Jan 1 |
| `"month"` | Counter resets on the 1st of each month |
| `"day"` | Counter resets daily |

If the pattern uses `{yyyy}` but `resetPeriod` is `"never"`, you get the same number each year — probably not what you want. Match the reset period to the pattern.

## Prefix resolution via settings

For multi-tenant or multi-folder setups, prefixes can come from module settings instead of being hardcoded. Declare a setting:

```json
// settings.json
{
    "invoice_prefix": {
        "fieldTypeCd": "text",
        "defaultValue": "INV",
        "label": "Invoice Prefix"
    }
}
```

And point the sequence at it with `prefixSettingCd`; the pattern uses `{prefix}`:

```json
"numberSequence": {
    "column": "number",
    "prefixSettingCd": "invoice_prefix",
    "defaultPrefix": "INV",
    "pattern": "{prefix}-{yyyy}-{seq:4}"
}
```

Folder-scoped settings mean different folders can have different prefixes (e.g. `US-INV-2026-0001` in the US folder, `EU-INV-2026-0001` in the EU folder).

## Cross-module sequences

Sequences can be called from other modules via `nextNumber('<module>.<entity>')` in DSL actions:

```
execute:
    invoice_num = nextNumber("fin.invoice")
    notify("Next invoice number: " + invoice_num)
```

But most of the time, you don't need this — the automatic INSERT behaviour is enough.

## Storage

Counters are stored in `dForge.number_sequence` (definitions) and `dForge.number_sequence_counter` (atomic values). Don't touch these tables directly.

## Common mistakes

- Declaring a number column without a `numberSequence` and manually counting in a DSL — **unnecessary**. Use the platform.
- Using `{seq}` without a width — the counter has no padding. Use `{seq:N}`.
- Mismatching `resetPeriod` and placeholders — e.g. `resetPeriod: "month"` with a pattern like `{yyyy}-{seq:4}` (no month) means Jan and Feb start at 1 producing duplicate numbers.
- Trying to set the number column manually on INSERT — it will be overwritten (unless you provide a non-null value, in which case the sequence respects it).
- Omitting `defaultPrefix` — the schema requires it, validate reports it.
- Forgetting `numberSequence` declaration and expecting it to "just work" — needs to be declared per entity.
