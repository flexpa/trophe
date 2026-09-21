import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NutritionIntake, NutritionProduct } from "fhir/r5.js";
import { createActions } from "../actions.js";
import { exportFhir, fhirExportSchema } from "../fhir.js";
import { mealSchema, type Meal } from "../schema.js";
import { openStore } from "../store.js";

function meal(overrides: Partial<Meal> = {}): Meal {
  return mealSchema.parse({
    id: "2026-09-21_breakfast", eaten_at: "2026-09-21T08:00:00-04:00", occasion: "breakfast",
    items: [{
      food_id: "saved-yogurt", name: "Example yogurt", amount: { quantity: 150, unit: "g" },
      nutrients: { kcal: 105, protein_g: 15, carbs_g: 6, fat_g: 2.25, fiber_g: 0 },
      evidence: { method: "label", source: "Fictional nutrition label", url: "https://example.com/label" },
    }],
    notes: "A note about the meal.", ...overrides,
  });
}

function intake(bundle: ReturnType<typeof exportFhir>): NutritionIntake {
  const resource = bundle.entry?.map(entry => entry.resource)
    .find(resource => resource?.resourceType === "NutritionIntake");
  assert.ok(resource?.resourceType === "NutritionIntake");
  return resource;
}

function products(resource: NutritionIntake): NutritionProduct[] {
  return (resource.contained ?? []).filter((item): item is NutritionProduct => item.resourceType === "NutritionProduct");
}

test("FHIR export is deterministic, uses valid IDs, and resolves patient and contained references", () => {
  const original = meal({ id: `meal_${"a".repeat(95)}` });
  const bundle = exportFhir([original], "person-123");
  assert.deepEqual(exportFhir([original], "person-123"), bundle);
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "collection");
  assert.equal(bundle.entry?.length, 2);
  assert.equal(bundle.entry?.[0]?.resource?.id, "person-123");
  const resource = intake(bundle);
  assert.match(resource.id ?? "", /^[A-Za-z0-9.-]{1,64}$/);
  assert.match(bundle.entry?.[1]?.fullUrl ?? "", /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(resource.subject.reference, bundle.entry?.[0]?.fullUrl);
  assert.equal(resource.consumedItem[0]?.nutritionProduct.reference?.reference, `#${products(resource)[0]?.id}`);
  assert.equal(resource.identifier?.[0]?.value, original.id);
  assert.notEqual(intake(exportFhir([original], "another-person")).id, resource.id);
  assert.equal(resource.status, "completed");
  assert.equal(resource.occurrenceDateTime, original.eaten_at);
  assert.equal(resource.reportedBoolean, true);
  assert.equal(resource.note?.[0]?.text, original.notes);
});

test("FHIR quantities retain per-item values, actual portion denominators, units, and known zero", () => {
  const resource = intake(exportFhir([meal()], "person"));
  const product = products(resource)[0];
  const protein = product?.nutrient?.find(nutrient => nutrient.item?.concept?.text === "Protein");
  assert.deepEqual(protein?.amount, [{
    numerator: { value: 15, unit: "g", system: "http://unitsofmeasure.org", code: "g" },
    denominator: { value: 150, unit: "g", system: "http://unitsofmeasure.org", code: "g" },
  }]);
  assert.deepEqual(resource.ingredientLabel?.find(label => label.nutrient.concept?.text === "Energy")?.amount,
    { value: 105, unit: "kcal", system: "http://unitsofmeasure.org", code: "kcal" });
  assert.equal(resource.ingredientLabel?.find(label => label.nutrient.concept?.text === "Dietary fiber")?.amount.value, 0);
  assert.ok(product?.note?.some(note => note.text.includes("https://example.com/label")));
  assert.ok(product?.note?.some(note => note.text === "Saved food ID: saved-yogurt"));
});

test("unknown item nutrients do not become zero or a partial meal total; estimates retain assumptions", () => {
  const original = meal();
  const known = original.items[0];
  assert.ok(known);
  original.items.push({
    ...known, name: "Estimated portion", amount: { quantity: 1, unit: "bowl" },
    nutrients: { ...known.nutrients, kcal: 200, protein_g: null },
    evidence: { method: "estimate", source: "Meal photo", assumptions: "One bowl; oil uncertain." },
  });
  const resource = intake(exportFhir([original], "person"));
  assert.equal(resource.ingredientLabel?.find(label => label.nutrient.concept?.text === "Energy")?.amount.value, 305);
  assert.equal(resource.ingredientLabel?.find(label => label.nutrient.concept?.text === "Protein"), undefined);
  assert.equal(products(resource)[1]?.nutrient?.find(nutrient => nutrient.item?.concept?.text === "Protein"), undefined);
  assert.deepEqual(resource.consumedItem[1]?.amount, { value: 1, unit: "bowl" });
  assert.ok(products(resource)[1]?.note?.some(note => note.text === "Evidence method: estimate."));
  assert.ok(products(resource)[1]?.note?.some(note => note.text.includes("oil uncertain")));
  assert.ok(resource.note?.some(note => note.text.includes("unknown nutrients: Protein")));
});

test("all-unknown values omit empty FHIR arrays, while void meals remain entered-in-error", () => {
  const original = meal({ status: "void", notes: "" });
  original.items = original.items.map(item => ({ ...item, nutrients: { kcal: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null } }));
  const resource = intake(exportFhir([original], "person"));
  assert.equal(resource.status, "entered-in-error");
  assert.equal(resource.ingredientLabel, undefined);
  assert.equal(products(resource)[0]?.nutrient, undefined);
  assert.equal(resource.consumedItem[0]?.notConsumed, undefined);
  assert.ok(resource.text?.div.includes("entered-in-error"));
});

test("FHIR export supports empty journals and preserves milliliter units and timestamp precision", () => {
  const empty = exportFhir([], "person");
  assert.equal(empty.entry?.length, 1);
  assert.equal(empty.entry?.[0]?.resource?.resourceType, "Patient");
  const original = meal({ eaten_at: "2026-09-21T08:00:00.123456-04:00" });
  original.items = original.items.map(item => ({ ...item, amount: { quantity: 200, unit: "ml" } }));
  const resource = intake(exportFhir([original], "person"));
  assert.equal(resource.occurrenceDateTime, original.eaten_at);
  assert.deepEqual(resource.consumedItem[0]?.amount, { value: 200, unit: "ml", system: "http://unitsofmeasure.org", code: "mL" });
});

test("FHIR narrative escapes user text and invalid export parameters fail", () => {
  const original = meal({ notes: '<script>alert("test")</script> & notes' });
  original.items = original.items.map(item => ({ ...item, name: "<Yogurt> & fruit" }));
  const resource = intake(exportFhir([original], "person"));
  assert.ok(resource.text?.div.includes("&lt;Yogurt&gt; &amp; fruit"));
  assert.ok(!resource.text?.div.includes("<script>"));
  assert.equal(resource.note?.[0]?.text, original.notes);
  assert.throws(() => exportFhir([meal({ eaten_at: "2026-09-21T08:00:00+15:00" })], "person"), /timezone offset/);
  for (const input of [
    {}, { patient_id: "bad_id" }, { patient_id: "a".repeat(65) },
    { patient_id: "person", from: "2026-09-21" },
    { patient_id: "person", from: "2026-09-22", to: "2026-09-21" },
    { patient_id: "person", from: "2026-02-30", to: "2026-03-01" },
    { patient_id: "person", from: "2020-01-01", to: "2026-09-21" },
  ]) assert.equal(fhirExportSchema.safeParse(input).success, false);
});

test("shared FHIR action applies local date bounds, exports snapshots, and never changes the journal", () => {
  const root = mkdtempSync(join(tmpdir(), "trophe-fhir-test-"));
  try {
    const store = openStore(root);
    store.init("America/Toronto");
    const previousDay = meal({ id: "late-meal", eaten_at: "2026-09-22T02:00:00Z" });
    const nextDay = meal({ id: "early-meal", eaten_at: "2026-09-22T05:00:00Z", status: "void" });
    store.putMeal(previousDay);
    store.putMeal(nextDay);
    const before = [store.readProfile(), ...store.list("meal").map(id => store.readMeal(id))];
    const action = createActions(store).find(action => action.name === "export_fhir");
    assert.ok(action?.readOnly);
    assert.deepEqual(action.run({ patient_id: "person", from: "2026-09-21", to: "2026-09-21" }), exportFhir([previousDay], "person"));
    assert.deepEqual(action.run({ patient_id: "person" }), exportFhir([previousDay, nextDay], "person"));
    assert.deepEqual(action.run({ patient_id: "person", from: "2026-09-01", to: "2026-09-01" }), exportFhir([], "person"));
    assert.deepEqual([store.readProfile(), ...store.list("meal").map(id => store.readMeal(id))], before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
