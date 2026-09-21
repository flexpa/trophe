# Trophe

A local nutrition journal for people and their agents.

**Trophe** comes from Ancient Greek **τροφή** (*trophē*): nourishment or food.
[Dictionary source](https://vocab.perseus.org/lemma/84476/).

Tell your agent what you ate, show it a label or meal photo, or ask how your week
looks. The agent interprets the request. Trophe stores the evidence, checks the
records, and does the arithmetic.

## Design

```text
your agent ── CLI or MCP ── validated actions ── Markdown files
     │
     └── its own vision and web tools, when needed
```

- Markdown with YAML front matter is the source of truth: profile, saved foods,
  meal logs, assumptions, and notes.
- One TypeScript core handles validation, serving calculations, and date totals.
- No account, application server, built-in model, API key, or database service.
- The CLI and MCP server expose the same operations and input schemas.
- Food edits do not alter past meals. Each logged item stores a nutrition snapshot.
- Estimates stay marked as estimates. Missing nutrients stay `null`.

There is no SQLite layer in this first version. A personal journal is small enough
to read directly. If indexing becomes useful, it can be rebuilt from the files.

## Start

Requires Node.js 22 or newer and Yarn 4.14.1.

```sh
yarn install
yarn build

# Default data location: ~/.trophe
yarn trophe init --timezone America/Toronto
yarn trophe food put --input examples/food.json
yarn trophe meal log --input examples/meal.json
yarn trophe day 2026-09-21
yarn trophe validate
```

The examples are fictional. They are added only when you run these commands.
To use a separate example journal, add `--data ./data` to **every** command.
`TROPHE_HOME` can also set a fixed data directory. An absolute path is best in
agent configuration. Opening a missing journal fails; only `init` creates one.

The executable is `node /absolute/path/to/trophe/dist/cli.js`. `yarn trophe` is a
repository shortcut. All command results are JSON, and errors go to stderr.

## Commands

| CLI | MCP tool | Purpose |
| --- | --- | --- |
| `init --timezone <zone>` | `init_journal` | Create an empty journal |
| `profile get` | `get_profile` | Read timezone, targets, and notes |
| `profile set --input <file>` | `set_profile` | Update the profile with its revision |
| `food list --query <text>` | `search_foods` | Find reusable foods |
| `food get <id>` | `get_food` | Read a food and its revision |
| `food put --input <file>` | `put_food` | Create or update a food |
| `meal log --input <file>` | `log_meal` | Record portions and evidence |
| `meal get <id>` | `get_meal` | Read a meal and its revision |
| `meal update --input <file>` | `update_meal` | Correct or void a meal |
| `meal list --from <date> --to <date>` | `list_meals` | Read a date range, including void records |
| `day <date>` / `summary --from <date> --to <date>` | `summarize` | Calculate active meal totals |
| `validate` | `validate_journal` | Check all records |

Use `tools` to print all tool argument schemas. `schema` prints the stored record
schemas. `call <tool> --json '{...}'` invokes any shared action directly.
`--input -` reads JSON from stdin. JSON input files contain the full tool
arguments: for example, `{ "meal": { ... } }`.

## Agent setup

Give your agent [SKILL.md](SKILL.md) and the absolute command and data paths.
Agents with shell access can use the CLI. Agents with MCP support can use:

```json
{
  "mcpServers": {
    "trophe": {
      "command": "node",
      "args": [
        "/absolute/path/to/trophe/dist/cli.js",
        "mcp",
        "--data",
        "/absolute/path/to/your/nutrition-journal"
      ]
    }
  }
}
```

The server uses stdio. It opens no network port. It exposes the guide as
`trophe://guide`, the schema explanation as `trophe://schema-guide`, and generated
JSON Schemas as `trophe://schemas`.

Photo interpretation and online food lookup use the host agent's capabilities.
Trophe itself does not call a model or nutrition provider. An agent can save photo
references and source links in the Markdown notes, with files in `attachments/`.
Using an external agent or web tool can share the information you give it; local
storage does not make those external services local.

## Data you can read

```text
~/.trophe/
├── profile.md
├── foods/
│   └── example-yogurt.md
├── journal/
│   └── 2026-09-21-breakfast.md
└── attachments/
```

Read [SCHEMA.md](SCHEMA.md) for the record format and [examples/meal.md](examples/meal.md)
for a full meal record. You can edit Markdown directly; run `validate` afterward.
Stop concurrent tools before manual edits. Back up the whole data directory with
your preferred file backup tool. Personal data is separate from the code and is
not pushed by this repository.

Tool writes use an exclusive directory lock and an atomic file replacement.
Updates require the SHA-256 revision returned by a read. This prevents one tool
from overwriting another tool's edits. Repeating an identical write is safe.
A changed payload with an existing ID fails until an explicit update is made.

If a process crashes while holding `.write-lock`, stop all Trophe writers and
remove that empty lock directory before retrying. The lock protects cooperating
Trophe processes; external editors must not write concurrently. Records are
current state, not a full revision archive. Backups preserve older versions.

## Totals and targets

The profile timezone determines the day for a timestamp, including daylight saving
time. Targets have effective dates. A report uses the target in effect on each day.
Changing the profile timezone regroups historical timestamps into that timezone.

Each nutrient reports a `known` subtotal, `unknown_items`, and whether the value is
`complete` **for the logged items**. This does not mean every meal was logged.
`remaining` is `null` if a nutrient is unknown or no target exists. An empty day has
`logged: false`; it is not treated as a confirmed fast. Estimates are counted
separately. Voided meals remain readable but are excluded from totals.

## Development

```sh
yarn check
yarn test
```

The tests cover persisted records, duplicate retries, serving calculations,
corrections, unknown values, local dates, malformed files, CLI behavior, and real
MCP client/server calls. See [AGENTS.md](AGENTS.md) for development conventions.

This initial version covers saved foods, meal logging, dated targets, and daily or
period summaries. Recipes can be saved as foods with known per-serving values.
Automatic recipe calculation, barcode lookup, body measurements, synchronization,
and a graphical interface are outside the initial scope.

## License

[MIT](LICENSE). Copyright (c) 2026 Flexpa.
