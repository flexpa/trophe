# Record format, version 1

Each record is a UTF-8 Markdown file ending with a newline. YAML front matter
holds machine-readable values. The body holds notes. In CLI/MCP input and output,
the body is the `notes` string; do not also put `notes` in YAML front matter.

Use `trophe schema` for exact JSON Schemas generated from the runtime validators.
Use `trophe tools` for action arguments. Unknown fields are rejected. The only
supported `schema_version` is `1`.

## Shared values

- IDs match `[a-z0-9][a-z0-9_-]{0,99}` and equal their filename without `.md`.
- Amounts have a positive numeric `quantity` and a nonempty `unit`.
- Nutrients are `kcal`, `protein_g`, `carbs_g`, `fat_g`, and `fiber_g`.
  Values are nonnegative numbers or `null`. Fiber defaults to `null`; the other
  keys are required. Food values describe one serving. Meal values describe the
  full amount for each item. No implicit unit conversions occur.
- Evidence has `method` (`label`, `database`, `estimate`, or `user`), a nonempty
  `source`, optional `url`, and `assumptions`. Estimates require assumptions.
- `revision` is an API envelope field: a SHA-256 digest of the exact file contents.
  It is not stored inside the document.

## Profile: profile.md

```yaml
---
schema_version: 1
kind: profile
timezone: America/Toronto
targets: []
---

Personal preferences and context go here.
```

Each optional target has a calendar date `from` and any of the nutrient keys with
nonnegative numeric values. Each start date must be unique. The latest target on
or before the report day applies. It replaces the preceding target as a whole.
No calorie or macro targets are supplied by default.

## Food: foods/<id>.md

Fields: `schema_version`, `kind: food`, `id`, `name`, `serving`, `nutrients`, and
`evidence`. `serving` is an amount. This record is reusable nutrition per serving.

See [examples/food.json](examples/food.json) for `put_food` arguments. Use
`expected_revision` alongside `food` to update an existing food. The food's new
values apply to future logs only.

## Meal: journal/<id>.md

Fields: `schema_version`, `kind: meal`, `id`, `eaten_at`, `occasion`, `status`, and
`items`. Notes are the body.

- `eaten_at`: an ISO timestamp with `Z` or an explicit offset, such as
  `2026-09-21T08:00:00-04:00`. The profile timezone determines its report date.
- `occasion`: `breakfast`, `lunch`, `dinner`, `snack`, or `other`.
- `status`: `active` (default) or `void`. Only active meals contribute to totals.
- `items`: one or more objects with `name`, `amount`, `nutrients`, and `evidence`.
  An optional `food_id` records where a snapshot came from. It is not a live join.

`log_meal` also accepts `{ "food_id": "example-yogurt", "servings": 1.5 }` as an
item. It copies the saved food, scales the amount and nutrient values, and stores
a complete snapshot. `update_meal` accepts stored snapshots only.

See [examples/meal.json](examples/meal.json) for logging arguments and
[examples/meal.md](examples/meal.md) for the resulting storage format.

## Corrections and reports

Updates require the full record and `expected_revision` from the latest read.
Identical records can be retried without another write. Distinct payloads cannot
reuse an existing ID without a matching revision. To change an ID, create a new
record and void the old meal; IDs are not renamed by the tools.

Daily and period totals are computed when requested and never stored. Each
nutrient has `known`, `unknown_items`, `complete`, `target`, and `remaining`.
Missing values do not become zero. `complete` is false for an empty day. Only
daily totals have target comparisons; period totals contain known consumption.
Date ranges are inclusive and limited to 366 days per call.

Malformed records stop reads and reports rather than being silently skipped.
`validate_journal` returns errors without rewriting the files. Unknown file
types and `attachments/` are not parsed as records.
