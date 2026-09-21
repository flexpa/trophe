#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createActions } from "./actions.js";
import { serve } from "./mcp.js";
import { openStore, recordSchemas } from "./store.js";

const help = `Trophe — a local nutrition journal for people and their agents.

  trophe init --timezone America/Toronto
  trophe food list [--query oats]
  trophe food get <id>
  trophe food put --input food.json
  trophe meal log --input meal.json
  trophe meal get <id>
  trophe meal update --input correction.json
  trophe meal list --from YYYY-MM-DD --to YYYY-MM-DD
  trophe day YYYY-MM-DD
  trophe summary --from YYYY-MM-DD --to YYYY-MM-DD
  trophe export ndjson
  trophe export fhir5 --patient-id <id> [--from YYYY-MM-DD --to YYYY-MM-DD]
  trophe export fhir5 --patient-id <id> --format ndjson --resource-type Patient|NutritionIntake
  trophe profile get
  trophe profile set --input profile.json
  trophe validate
  trophe schema [food|meal|profile]
  trophe tools
  trophe call <tool> [--input file.json | --json '{...}']
  trophe mcp

Global: --data <directory> (default: TROPHE_HOME or ~/.trophe).
Input files contain tool arguments. Use --input - for JSON on stdin.
Results are JSON, or raw NDJSON for NDJSON exports. Run tools for input contracts.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" }, timezone: { type: "string" },
      input: { type: "string" }, json: { type: "string" }, query: { type: "string" },
      from: { type: "string" }, to: { type: "string" }, help: { type: "boolean", short: "h" },
      "patient-id": { type: "string" },
      format: { type: "string" }, "resource-type": { type: "string" },
    },
  });
  const [command, subcommand, id] = positionals;
  if (!command || values.help) { process.stdout.write(help); return; }
  const directory = values.data ?? process.env.TROPHE_HOME ?? join(homedir(), ".trophe");
  const actions = createActions(openStore(directory));
  if (command === "mcp") { await serve(directory); return; }
  if (command === "schema") {
    if (subcommand && !(subcommand in recordSchemas)) throw new Error("Choose food, meal, or profile.");
    output(Object.fromEntries(Object.entries(recordSchemas).filter(([kind]) => !subcommand || kind === subcommand)
      .map(([kind, schema]) => [kind, z.toJSONSchema(schema)])));
    return;
  }
  if (command === "tools") {
    output(actions.map(action => ({ name: action.name, description: action.description, inputSchema: z.toJSONSchema(action.schema, { io: "input" }) })));
    return;
  }
  if (values.input !== undefined && values.json !== undefined) throw new Error("Use either --input or --json.");
  const payload: unknown = values.input !== undefined
    ? JSON.parse(readFileSync(values.input === "-" ? 0 : values.input, "utf8"))
    : values.json !== undefined ? JSON.parse(values.json) : {};
  const range = { from: values.from, to: values.to };
  let tool: string | undefined;
  let args: unknown = payload;
  switch (command) {
    case "call": tool = subcommand; break;
    case "init": tool = "init_journal"; args = { timezone: values.timezone }; break;
    case "validate": tool = "validate_journal"; args = {}; break;
    case "day": tool = "summarize"; args = { from: subcommand, to: subcommand }; break;
    case "summary": tool = "summarize"; args = range; break;
    case "export":
      if (subcommand === "ndjson") {
        if ([values["patient-id"], values.from, values.to, values.format, values["resource-type"]].some(value => value !== undefined)) {
          throw new Error("Native NDJSON exports the complete journal. Omit patient, date, format, and resource-type options.");
        }
        tool = "export_ndjson";
        args = {};
        break;
      }
      if (subcommand !== "fhir5") throw new Error("Supported exports: ndjson, fhir5.");
      tool = "export_fhir";
      args = { patient_id: values["patient-id"], format: values.format, resource_type: values["resource-type"], ...range };
      break;
    case "food":
      if (subcommand === "list") { tool = "search_foods"; args = { query: values.query ?? "" }; }
      if (subcommand === "get") { tool = "get_food"; args = { id }; }
      if (subcommand === "put") tool = "put_food";
      break;
    case "meal":
      if (subcommand === "get") { tool = "get_meal"; args = { id }; }
      if (subcommand === "list") { tool = "list_meals"; args = range; }
      if (subcommand === "log") tool = "log_meal";
      if (subcommand === "update") tool = "update_meal";
      break;
    case "profile":
      if (subcommand === "get") { tool = "get_profile"; args = {}; }
      if (subcommand === "set") tool = "set_profile";
      break;
  }
  const action = actions.find(candidate => candidate.name === tool);
  if (!action) throw new Error("Unknown command. Run trophe --help.");
  const result = action.run(args);
  output(result);
  if (command === "validate" && result && typeof result === "object" && "valid" in result && !result.valid) process.exitCode = 1;
}

function output(value: unknown): void {
  process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
