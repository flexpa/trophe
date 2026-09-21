import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { createActions } from "../actions.js";
import { foodSchema, mealSchema } from "../schema.js";
import { openStore } from "../store.js";

const directories: string[] = [];
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const exampleFood = JSON.parse(readFileSync(new URL("../../examples/food.json", import.meta.url), "utf8"));
const exampleMeal = JSON.parse(readFileSync(new URL("../../examples/meal.json", import.meta.url), "utf8"));

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "trophe-test-"));
  directories.push(path);
  return path;
}

function fixture() {
  const root = directory();
  const store = openStore(root);
  store.init("America/Toronto");
  const actions = createActions(store);
  const run = (name: string, input: unknown = {}) => {
    const action = actions.find(candidate => candidate.name === name);
    assert.ok(action, `Missing action ${name}`);
    return action.run(input);
  };
  return { root, store, run };
}

function cliOutput(root: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args, "--data", root], { encoding: "utf8" });
}

function cliCall(root: string, ...args: string[]): unknown {
  return JSON.parse(cliOutput(root, ...args));
}

const summarySchema = z.object({
  timezone: z.string(),
  days: z.array(z.object({
    date: z.string(), logged: z.boolean(), meal_count: z.number(), estimated_items: z.number(),
    nutrients: z.record(z.string(), z.object({
      known: z.number(), unknown_items: z.number(), complete: z.boolean(),
      target: z.number().nullable(), remaining: z.number().nullable(),
    })),
  })),
  total: z.object({ meal_count: z.number() }),
});

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("opening an unknown journal does not create one; initialization never replaces a profile", () => {
  const root = directory();
  const store = openStore(join(root, "missing"));
  assert.throws(() => store.readProfile(), /Run init first/);
  assert.deepEqual(readdirSync(root), []);
  store.init("America/Toronto");
  const original = store.readProfile();
  assert.throws(() => store.init("UTC"), /already exists/);
  assert.deepEqual(store.readProfile(), original);
});

test("servings are scaled once, identical retries do not duplicate, and foods are snapshotted", () => {
  const { store, run } = fixture();
  run("put_food", exampleFood);
  const result = run("log_meal", exampleMeal);
  assert.deepEqual(run("log_meal", exampleMeal), result);
  assert.deepEqual(store.list("meal"), ["2026-09-21-breakfast"]);
  const logged = store.readMeal("2026-09-21-breakfast");
  assert.deepEqual(logged.record.items[0]?.amount, { quantity: 150, unit: "g" });
  assert.deepEqual(logged.record.items[0]?.nutrients, { kcal: 105, protein_g: 15, carbs_g: 6, fat_g: 2.25, fiber_g: 0 });
  const food = store.readFood("example-yogurt");
  run("put_food", { food: { ...food.record, nutrients: { ...food.record.nutrients, kcal: 200 } }, expected_revision: food.revision });
  assert.deepEqual(store.readMeal(logged.record.id), logged);
  assert.throws(() => run("log_meal", exampleMeal), /Record exists or changed/);
  assert.equal(store.list("meal").length, 1);
});

test("a distinct meal with the same food needs and receives its own ID", () => {
  const { store, run } = fixture();
  run("put_food", exampleFood);
  run("log_meal", exampleMeal);
  run("log_meal", { meal: { ...exampleMeal.meal, id: "second-breakfast" } });
  assert.equal(store.list("meal").length, 2);
  const report = summarySchema.parse(run("summarize", { from: "2026-09-21", to: "2026-09-21" }));
  assert.equal(report.days[0]?.nutrients.kcal?.known, 210);
});

test("stale corrections cannot overwrite data; voiding keeps the file and removes its totals", () => {
  const { store, run } = fixture();
  run("put_food", exampleFood);
  run("log_meal", exampleMeal);
  const original = store.readMeal(exampleMeal.meal.id);
  run("update_meal", { meal: { ...original.record, notes: "First correction" }, expected_revision: original.revision });
  assert.throws(() => run("update_meal", { meal: { ...original.record, notes: "Stale correction" }, expected_revision: original.revision }), /changed/);
  const current = store.readMeal(original.record.id);
  run("update_meal", { meal: { ...current.record, status: "void", notes: "Duplicate reported by the user." }, expected_revision: current.revision });
  assert.equal(store.readMeal(original.record.id).record.status, "void");
  assert.equal(store.list("meal").length, 1);
  const summary = summarySchema.parse(run("summarize", { from: "2026-09-21", to: "2026-09-21" }));
  assert.equal(summary.total.meal_count, 0);
  assert.equal(summary.days[0]?.logged, false);
  assert.equal(summary.days[0]?.nutrients.kcal?.complete, false);
});

test("unknown nutrients and estimated portions remain visible in totals", () => {
  const { store, run } = fixture();
  const profile = store.readProfile();
  run("set_profile", { profile: { ...profile.record, targets: [{ from: "2026-09-01", kcal: 2000, protein_g: 100 }] }, expected_revision: profile.revision });
  run("log_meal", { meal: {
    id: "estimated-lunch", eaten_at: "2026-09-21T12:00:00-04:00", occasion: "lunch",
    items: [{ name: "Example meal", amount: { quantity: 1, unit: "bowl" },
      nutrients: { kcal: 500, protein_g: null, carbs_g: 50, fat_g: 20 },
      evidence: { method: "estimate", source: "User meal photo", assumptions: "One bowl; oil amount uncertain." } }],
  } });
  const report = summarySchema.parse(run("summarize", { from: "2026-09-21", to: "2026-09-22" }));
  assert.deepEqual(report.days[0]?.nutrients.kcal, { known: 500, unknown_items: 0, complete: true, target: 2000, remaining: 1500 });
  assert.deepEqual(report.days[0]?.nutrients.protein_g, { known: 0, unknown_items: 1, complete: false, target: 100, remaining: null });
  assert.equal(report.days[0]?.estimated_items, 1);
  assert.equal(report.days[1]?.logged, false);
  assert.equal(report.days[1]?.nutrients.kcal?.remaining, null);
});

test("local days cross UTC midnight and handle repeated daylight saving hours", () => {
  const { run } = fixture();
  run("put_food", exampleFood);
  for (const [id, eaten_at] of [
    ["late-dinner", "2026-09-22T02:00:00Z"],
    ["early-hour", "2026-11-01T05:30:00Z"],
    ["repeated-hour", "2026-11-01T06:30:00Z"],
  ]) run("log_meal", { meal: { ...exampleMeal.meal, id, eaten_at } });
  const september = summarySchema.parse(run("summarize", { from: "2026-09-21", to: "2026-09-22" }));
  assert.equal(september.days[0]?.meal_count, 1);
  assert.equal(september.days[1]?.meal_count, 0);
  const november = summarySchema.parse(run("summarize", { from: "2026-11-01", to: "2026-11-01" }));
  assert.equal(november.days[0]?.meal_count, 2);
});

test("dated targets preserve the target used for each day", () => {
  const { store, run } = fixture();
  const profile = store.readProfile();
  run("set_profile", { profile: { ...profile.record, targets: [{ from: "2026-09-01", kcal: 1800 }, { from: "2026-09-22", kcal: 2200 }] }, expected_revision: profile.revision });
  const report = summarySchema.parse(run("summarize", { from: "2026-09-21", to: "2026-09-22" }));
  assert.equal(report.days[0]?.nutrients.kcal?.target, 1800);
  assert.equal(report.days[1]?.nutrients.kcal?.target, 2200);
  assert.equal(report.days[0]?.nutrients.protein_g?.target, null);
});

test("invalid dates, path IDs, negative values, and unexplained estimates cannot be written", () => {
  const { store, run } = fixture();
  const food = foodSchema.parse(exampleFood.food);
  assert.throws(() => run("put_food", { food: { ...food, id: "../escape" } }));
  assert.throws(() => run("put_food", { food: { ...food, nutrients: { ...food.nutrients, kcal: -1 } } }));
  assert.throws(() => run("put_food", { food: { ...food, evidence: { method: "estimate", source: "photo" } } }));
  assert.throws(() => run("log_meal", { meal: { ...exampleMeal.meal, eaten_at: "2026-09-21T08:00:00" } }));
  assert.throws(() => run("summarize", { from: "2026-02-30", to: "2026-03-01" }));
  assert.throws(() => run("summarize", { from: "2026-09-22", to: "2026-09-21" }));
  assert.throws(() => run("summarize", { from: "2020-01-01", to: "2026-09-21" }));
  assert.deepEqual(store.list("food"), []);
  assert.deepEqual(store.list("meal"), []);
});

test("manual Markdown edits are read, and malformed records stop totals without silent data loss", () => {
  const { root, store, run } = fixture();
  run("put_food", exampleFood);
  run("log_meal", exampleMeal);
  const path = join(root, "journal", `${exampleMeal.meal.id}.md`);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("kcal: 105", "kcal: 120"));
  assert.equal(store.readMeal(exampleMeal.meal.id).record.items[0]?.nutrients.kcal, 120);
  writeFileSync(path, original.replace("kcal: 105", "kcal: -105"));
  assert.throws(() => run("summarize", { from: "2026-09-21", to: "2026-09-21" }), /Invalid record/);
  const validation = z.object({ valid: z.boolean(), errors: z.array(z.string()) }).parse(run("validate_journal"));
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.length, 1);
  assert.throws(() => cliCall(root, "validate"));
  assert.equal(readFileSync(path, "utf8"), original.replace("kcal: 105", "kcal: -105"));
});

test("Markdown examples match the accepted storage schema", () => {
  const { root, store } = fixture();
  writeFileSync(join(root, "journal", "2026-09-21-breakfast.md"), readFileSync(new URL("../../examples/meal.md", import.meta.url)));
  assert.equal(mealSchema.parse(store.readMeal("2026-09-21-breakfast").record).items[0]?.nutrients.kcal, 105);
});

test("native NDJSON preserves every record, including targets, unused foods, void meals, and multiline notes", () => {
  const { root, store, run } = fixture();
  const profile = store.readProfile();
  store.putProfile({ ...profile.record, targets: [{ from: "2026-09-01", kcal: 2000 }], notes: 'Preferences\nGreek: τροφή; "quoted"' }, profile.revision);
  run("put_food", exampleFood);
  run("log_meal", exampleMeal);
  const food = store.readFood(exampleFood.food.id).record;
  store.putFood({ ...food, id: "unused-food", nutrients: { ...food.nutrients, protein_g: null }, notes: "Line 1\nLine 2" });
  const meal = store.readMeal(exampleMeal.meal.id).record;
  store.putMeal({ ...meal, id: "void-meal", status: "void", notes: "Duplicate\nKeep this record." });
  const before = [store.readProfile(), ...store.list("food").map(id => store.readFood(id)), ...store.list("meal").map(id => store.readMeal(id))];
  const exported = z.string().parse(run("export_ndjson"));
  assert.ok(exported.endsWith("\n"));
  const lines = exported.slice(0, -1).split("\n");
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map(line => JSON.parse(line)), before.map(document => document.record));
  assert.equal(cliOutput(root, "export", "ndjson"), exported);
  assert.equal(cliOutput(root, "call", "export_ndjson"), exported);
  assert.equal(run("export_ndjson"), exported);
  assert.deepEqual([store.readProfile(), ...store.list("food").map(id => store.readFood(id)), ...store.list("meal").map(id => store.readMeal(id))], before);
});

test("native NDJSON exports an empty journal's profile and rejects filters", () => {
  const { root, store, run } = fixture();
  assert.equal(run("export_ndjson"), `${JSON.stringify(store.readProfile().record)}\n`);
  assert.throws(() => run("export_ndjson", { from: "2026-09-21" }));
  for (const args of [["--from", "2026-09-21", "--to", "2026-09-21"], ["--format", "json"], ["--patient-id", "person"], ["--resource-type", "Patient"]]) {
    const result = spawnSync(process.execPath, [cli, "export", "ndjson", "--data", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /exports the complete journal/);
  }
});

test("native NDJSON stops on malformed records without emitting a partial export", () => {
  const { root, run } = fixture();
  run("put_food", exampleFood);
  writeFileSync(join(root, "journal", "broken.md"), "malformed record\n");
  assert.throws(() => run("export_ndjson"), /Invalid record/);
  const result = spawnSync(process.execPath, [cli, "export", "ndjson", "--data", root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid record/);
});

test("CLI and a real stdio MCP client share operations, schemas, resources, and results", async () => {
  const root = directory();
  cliCall(root, "init", "--timezone", "America/Toronto");
  cliCall(root, "food", "put", "--json", JSON.stringify(exampleFood));
  const client = new Client({ name: "trophe-integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--data", root] });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const cliTools = z.array(z.object({ name: z.string(), inputSchema: z.unknown() })).parse(cliCall(root, "tools"));
    assert.deepEqual(listed.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })), cliTools);
    const logged = await client.callTool({ name: "log_meal", arguments: exampleMeal });
    assert.notEqual(logged.isError, true);
    const mcpReport = await client.callTool({ name: "summarize", arguments: { from: "2026-09-21", to: "2026-09-21" } });
    const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(mcpReport.content);
    assert.deepEqual(JSON.parse(content[0]?.text ?? "null"), cliCall(root, "day", "2026-09-21"));
    const fhir = await client.callTool({ name: "export_fhir", arguments: { patient_id: "example-person" } });
    assert.notEqual(fhir.isError, true);
    const fhirContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(fhir.content);
    assert.deepEqual(JSON.parse(fhirContent[0]?.text ?? "null"), cliCall(root, "export", "fhir5", "--patient-id", "example-person"));
    const filteredFhir = await client.callTool({ name: "export_fhir", arguments: { patient_id: "example-person", from: "2026-09-21", to: "2026-09-21" } });
    const filteredContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(filteredFhir.content);
    assert.deepEqual(JSON.parse(filteredContent[0]?.text ?? "null"), cliCall(root, "export", "fhir5", "--patient-id", "example-person", "--from", "2026-09-21", "--to", "2026-09-21"));
    const native = await client.callTool({ name: "export_ndjson", arguments: {} });
    assert.notEqual(native.isError, true);
    const nativeContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(native.content);
    assert.equal(nativeContent[0]?.text, cliOutput(root, "export", "ndjson"));
    for (const resource_type of ["Patient", "NutritionIntake"]) {
      const ndjson = await client.callTool({ name: "export_fhir", arguments: { patient_id: "example-person", format: "ndjson", resource_type } });
      assert.notEqual(ndjson.isError, true);
      const ndjsonContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(ndjson.content);
      assert.equal(ndjsonContent[0]?.text, cliOutput(root, "export", "fhir5", "--patient-id", "example-person", "--format", "ndjson", "--resource-type", resource_type));
    }
    const emptyNdjson = await client.callTool({ name: "export_fhir", arguments: {
      patient_id: "example-person", format: "ndjson", resource_type: "NutritionIntake", from: "2026-09-01", to: "2026-09-01",
    } });
    assert.notEqual(emptyNdjson.isError, true);
    assert.deepEqual(emptyNdjson.content, [{ type: "text", text: "" }]);
    assert.equal(cliOutput(root, "export", "fhir5", "--patient-id", "example-person", "--format", "ndjson", "--resource-type", "NutritionIntake", "--from", "2026-09-01", "--to", "2026-09-01"), "");
    const missingType = await client.callTool({ name: "export_fhir", arguments: { patient_id: "example-person", format: "ndjson" } });
    assert.equal(missingType.isError, true);
    const badNative = await client.callTool({ name: "export_ndjson", arguments: { from: "2026-09-01" } });
    assert.equal(badNative.isError, true);
    assert.throws(() => cliCall(root, "export", "fhir4", "--patient-id", "example-person"));
    assert.throws(() => cliCall(root, "export", "fhir5"));
    const bad = await client.callTool({ name: "log_meal", arguments: { meal: { id: "bad" } } });
    assert.equal(bad.isError, true);
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 4);
    for (const uri of ["trophe://guide", "trophe://schema-guide", "trophe://schemas", "trophe://fhir-guide"]) {
      const resource = await client.readResource({ uri });
      assert.equal(resource.contents.length, 1);
    }
  } finally {
    await client.close();
    await transport.close();
  }
});
