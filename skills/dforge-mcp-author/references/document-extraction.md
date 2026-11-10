# Document Extraction Reference (OCR)

dForge turns uploaded documents (PDFs, scans, photos) into structured records via a generic OCR service plus a per-module **field schema**. The load-bearing principle: **OCR is schema-agnostic, the module owns the schema.** The platform service is a write-once "document + schema → fields" engine; every new document type is a new schema in *your* module, never a change to the service.

Two DSL built-ins do the work, both host functions callable from `logic/actions/*.dsl`:

- `ocrExtract(...)` — send a file to the OCR endpoint, get structured fields back.
- `detectDocument(rawText)` — score a document's text against your profiles' detect rules to guess its type.

## Where documents go: the `ocr` module

Don't declare an OCR endpoint setting of your own. Depend on the platform's `ocr` module and call its functions: it holds the one **OCR service** setting a workspace sets once (per folder if it wants), `platform` by default — the server's own OCR service — or the URL of an external one.

```jsonc
// manifest.json
"dependencies": { "ocr": ">=0.1.0" }

// deps/ocr.json
{ "module": "ocr", "version": ">=0.1.0", "entities": {}, "functions": ["extract", "extractProfile", "summary", "raw"] }
```

```
execute:
  var r = ocr.extractProfile([doc_file], 'proc.bill_of_lading')
  if (r.ok) {
    [bl_no] = r.data.fields.bl_no
    [status] = 'recognized'
  } else {
    [status] = 'failed'
    [error_text] = r.error
  }
```

| Function | `data` on success |
|---|---|
| `ocr.extract(file, schema)` | `{ fields, confidence?, unmatched, raw_text, meta }` — `schema` is the action's `schema:` block |
| `ocr.extractProfile(file, 'module_cd.profile_cd')` | as `extract` |
| `ocr.summary(file)` | `{ summary, raw_text, meta }` |
| `ocr.raw(file)` | the raw bundle, `raw_text` included |

- Each returns `{ ok, data, error }` and **never throws**, so write `error` to a status column instead of rolling the run back.
- **Name a profile in full** (`'proc.bill_of_lading'`): the functions run as the `ocr` module, so a short name would be looked up there and is refused.
- **Call `detectDocument()` from your own action**, where it sees your module's profiles, and pass the code it returns to `ocr.extractProfile()`.
- The folder's **Settings** tab of a module that uses `ocr` shows the OCR section, so an admin changes the service there.

Calling `ocrExtract()` directly still works — for a module that really needs its own endpoint. The second argument is `'platform'` (any case) for the server's own service, or the base URL of an external one. A URL on a private or loopback address is refused (`Blocked endpoint: private network addresses are not allowed`) unless the server allows that host; `'platform'` and the platform service's own address always pass. A server with no OCR service of its own refuses `'platform'`.

## `ocrExtract()`

Three forms, from raw to managed:

**v1 — raw bundle** (back-compat; returns a JSON **string**, you `JSON.parse` it):
```
var raw = ocrExtract([doc_file], 'platform')        // hints optional (array | string | object)
```

**v2 — inline schema** (explicit opt-in via `opts.mode`; returns the **parsed** object):
```
var r = ocrExtract([doc_file], 'platform', schema, { mode: 'extract' })
// r → { fields, confidence?, unmatched, raw_text, meta }
```

**v2 — extraction profile** (the managed path; schema lives in a row, not inline):
```
var r = ocrExtract([doc_file], 'platform', null, { profile: 'proc.bill_of_lading' })
```

Notes:
- v2 is selected **only** by `opts.mode` (`'extract' | 'summary' | 'raw'`) or `opts.profile`. A bare object third arg *without* `opts.mode` stays on the v1 hints contract — so passing a schema object alone does **not** switch to v2.
- `opts.profile` implies `mode: 'extract'` and is mutually exclusive with an inline `schema`. Unqualified profile codes resolve the action's own module first, then tenant-created rows. Missing/inactive profiles fail loudly.
- The parsed response is `{ fields, confidence?, unmatched, raw_text, meta }` — map `r.fields.<name>` straight into `insert()`.

## The `schema:` block (inline)

Declare the field schema next to the mapping, in a `schema:` block in the action `.dsl`. It compiles verbatim into `var schema = {…}`, so it's a **JS object-literal body** — entries comma-separated, **string values quoted** (`type: 'string'`, not `type: string`, which fails the compile with `'string' is not defined`):

```
schema:
  bl_no:        { type: 'string', description: "Bill of lading number (label 'B.L. No.')" },
  container_no: { type: 'string', description: 'ISO 6346 container number' },
  issue_date:   { type: 'date' }

execute:
  var r = ocrExtract([doc_file], 'platform', schema, { mode: 'extract' })
  var bl = insert('bill_of_lading', { bl_no: r.fields.bl_no, issue_date: r.fields.issue_date })
  if (r.fields.container_no != null) {
    insert('container', { bill_of_lading_id: bl.bill_of_lading_id, container_no: r.fields.container_no })
  }
```

Each field descriptor carries a `type` (`string` | `date` | `number` | …) and an optional `description` — the human-language hint the recognizer/LLM uses to find it. Keep descriptions concrete ("label 'B.L. No.'", "ISO 6346 container number").

## Extraction profiles — `logic/extraction_profiles.json`

The managed evolution of the inline `schema:` block: the same field schema stored as a row in `dForge.extraction_profile` (a platform-managed entity), so it's editable in the admin UI and reusable across actions. Mirrors the print-template lifecycle.

```json
{
    "bill_of_lading": {
        "description": "Ocean bill of lading",
        "docType": "bill_of_lading",
        "schema": {
            "bl_no":        { "type": "string", "description": "Bill of lading number (label 'B.L. No.')" },
            "container_no": { "type": "string", "description": "ISO 6346 container number" },
            "issue_date":   { "type": "date" }
        },
        "detect": {
            "signals": [
                { "regex": "bill of lading", "weight": 3 },
                { "regex": "B/?L\\s*No", "weight": 2 }
            ],
            "threshold": 4
        }
    }
}
```

- **Keyed by `profile_cd`** (no `.` — it collides with the `module.profile` qualified form).
- **Registered on install** by `(module_id, profile_cd)`; profiles dropped from the manifest are **reaped** on upgrade; uninstall removes the module's rows. Tenant-created profiles (`module_id IS NULL`) are authored in the admin UI and never touched by install.
- Reference at runtime with `ocrExtract(..., null, { profile: 'module_cd.profile_cd' })`.

## `detectDocument()` — doc-type auto-detect

A profile's optional `detect` rules let the platform guess a document's type before you extract. `detectDocument(rawText)` scores every reachable profile's `signals` (case-insensitive regexes, summed weights, per-pattern timeout) and returns the best profile at/above its `threshold`:

```
execute:
  var det = detectDocument(data.raw_text)     // → { profile: 'proc.bill_of_lading', docType: 'bill_of_lading', score } | null
  if (det != null && det.docType != null) { [doc_type] = det.docType }
  var r = ocrExtract([doc_file], 'platform', null, { profile: det.profile })
```

- Returns `{ profile, docType, score }` (the profile code is already module-qualified, ready to pass to `ocrExtract`) or `null`.
- **Advisory by design** — malformed rules are skipped, and the returned type is a suggestion; let the human confirm before committing an irreversible mapping.
- `rawText` is typically `ocrExtract`'s `raw_text` (or a v1 raw bundle's text) from a first pass.

## Typical intake flow

1. User uploads a file to an intake record (a `file`/`image` column).
2. An action runs OCR once to get `raw_text`, calls `detectDocument(raw_text)` to suggest the type, and stores the suggestion for the user to confirm.
3. On confirm, `ocrExtract(..., { profile })` returns structured `fields`; the action `insert()`s the target record(s), applying resolution transforms (`lookupRef`, `matchCatalog`, `parseMoney`) for anything that needs turning into a DB ref.

## Common mistakes

- Passing a schema object as the third arg **without** `{ mode: 'extract' }` — that's still v1 (raw string), not v2.
- Unquoted values in a `schema:` block (`type: string`) — compile fails; quote them.
- A `profile_cd` containing `.` — rejected (reserved for the `module.profile` form).
- Treating `detectDocument` as authoritative — it's advisory; confirm the type before an irreversible write.
- Declaring an `ocr_endpoint_url` setting of your own — use the `ocr` module, so the workspace sets the service once.
- Hardcoding a private address such as `http://ocr:8080` or `http://10.0.0.5` in a direct `ocrExtract()` call — pass `'platform'`; a private address is refused unless the server allows it.
- Passing a short profile name to `ocr.extractProfile()` — name it `'module_cd.profile_cd'`.
