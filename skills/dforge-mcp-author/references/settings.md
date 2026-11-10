# Module Settings Reference

Module settings are **configurable values** scoped to a module. Tenant admins set them; module code reads them at runtime. Values inherit through the folder tree (child folder overrides parent, parent overrides module default).

Lives in: `settings.json` at the module root.

## Structure

Settings use the **same field type system as entity columns**. Each setting is like a single column with a default value.

```json
{
    "company_name": {
        "fieldTypeCd": "text",
        "baseDatatypeCd": "string",
        "label": "Company name",
        "desc": "Shown in the header of every printed document",
        "defaultValue": "Your Company Name"
    },
    "invoice_prefix": {
        "fieldTypeCd": "text",
        "baseDatatypeCd": "string",
        "description": "Prefix for auto-generated invoice numbers",
        "defaultValue": "INV-"
    },
    "default_currency": {
        "fieldTypeCd": "dropdown",
        "baseDatatypeCd": "string",
        "description": "Default currency code for documents",
        "defaultValue": "USD",
        "params": {
            "options": ["USD", "EUR", "GBP", "CHF"]
        }
    },
    "allow_negative_stock": {
        "fieldTypeCd": "checkbox",
        "baseDatatypeCd": "bool",
        "description": "Allow operations that result in negative stock",
        "defaultValue": false
    },
    "company_logo": {
        "fieldTypeCd": "image",
        "description": "Shown on printed documents"
    }
}
```

### Name and help text

- `label` — the name shown for the setting. Translate it as `settings.<code>.label`.
- `desc` — optional help text shown under the name. Translate it as `settings.<code>.desc`.
- `description` — the older key for the name, still accepted (the other examples use it). Beside a `label` it is taken as the help text instead, unless `desc` is given.
- A setting with neither `label` nor `description` shows its code.

## Reading settings

From formulas, reference settings with `$[setting_name]`:

```
[total] * (1 + $[vat_rate] / 100)
```

From DSL actions (check your dForge version for exact syntax):

```
execute:
    rate = settings.vat_rate
    tax = [total] * rate / 100
```

From number sequence patterns:

```
"pattern": "$[invoice_prefix]-{yyyy}-{seq:4}"
```

## Folder-scoped inheritance

Settings resolve at runtime through the folder hierarchy:

1. The context's folder → its override (if any)
2. Parent folder → override (if any)
3. ... up the tree ...
4. Module default (from `settings.json`)

This means different folders can have different VAT rates, different prefixes, different currencies — without any code changes.

The walk stops at a folder whose `inherit_security` is false; that folder's own override still applies, but it does not inherit from its parent.

**Which folder is "the context's folder"** depends on what is reading. A user request uses the folder the user navigated to; an action uses the folder of the record or the queue entry; a **scheduled job** uses `scheduled_job.folder_id`, defaulting to its module's root folder. A job is the one context with no user, which is why it carries an explicit binding — without one it would see only the module default, and module defaults are not writable through the API (`settings.set` requires a folder).

## Where a setting is edited

A setting is edited on the **Settings** tab of a folder. That tab lists the module owning the folder, the modules that depend on it, and the modules those depend on that **own no folder** and have settings — gateway modules such as `ai` and `ocr`. A gateway's functions run in the calling module's folder and read their settings there, so a value set on that folder's tab applies to calls made from it. A module with settings but no folder and no dependants has nowhere to edit them.

## Field types supported in settings

Any field type that makes sense for a single scalar value:

- `text`, `textarea`, `richtext`, `code`
- `number`, `currency`, `percent`
- `checkbox`
- `date`, `datetime`, `time`
- `dropdown`, `flags`, `color`, `tags`
- `image`, `file`
- `json`
- `user` (if you want to store a reference to a specific user)

**Not supported** as settings:

- `lookup` (reference to an entity row) — use a `text` setting holding a code instead
- `grid` (set) — settings are single values

## Params

Settings support the same `params` as entity columns:

- `options` (for `dropdown` and `flags`)
- `min`, `max` (for `number`)
- `currency` (for `currency`)
- `maxLen` (for `text`)

## Declaring setting access in roles

By default, only the module/tenant admin can change settings. If you want specific roles to read or modify settings, grant appropriate rights on the settings objects in `security/roles.json` (check your dForge version for the exact naming).

## Common mistakes

- Forgetting to declare `defaultValue` (the key is `defaultValue`, not `default`) — missing setting values cause runtime errors when formulas reference them.
- Using `lookup` as a setting field type — unsupported.
- Hardcoding values that should be settings — makes the module non-configurable. Any string/number that might vary per deployment is a good candidate for a setting.
- Reading a setting that doesn't exist — returns null, which causes formula errors. Always provide a default.
- A setting with neither `label` nor `description` — the settings page shows its bare code.
- Restating a gateway module's setting (an OCR endpoint, an AI provider) in your own `settings.json` — depend on the gateway and call its functions, so the workspace sets it once.

## Reference

This file covers the module package format for settings. If you need details on the runtime resolution API (`settings.get`, `settings.list`, `settings.set`, `settings.clear`), ask the user to check their dForge version's settings documentation.
