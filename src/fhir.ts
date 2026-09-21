import { createHash } from "node:crypto";
import type {
  Bundle, NutritionIntake, NutritionIntakeIngredientLabel, NutritionProduct,
  NutritionProductNutrient, Patient, SimpleQuantity,
} from "fhir/r5.js";
import { z } from "zod";
import { toNdjson } from "./ndjson.js";
import { dateSchema, nutrientKeys, rangeSchema, type Meal, type Nutrients } from "./schema.js";

const namespace = "https://github.com/flexpa/trophe";
const ucum = "http://unitsofmeasure.org";
const unitCodes = new Map([
  ["g", "g"], ["kg", "kg"], ["mg", "mg"], ["ug", "ug"], ["µg", "ug"],
  ["ml", "mL"], ["mL", "mL"], ["l", "L"], ["L", "L"],
]);
const nutrientNames: Record<keyof Nutrients, string> = {
  kcal: "Energy", protein_g: "Protein", carbs_g: "Carbohydrate", fat_g: "Fat", fiber_g: "Dietary fiber",
};

/** FHIR R5 export requires an explicit patient ID and optional paired local dates. */
export const fhirExportSchema = z.strictObject({
  patient_id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/, "Use a FHIR ID: 1–64 letters, digits, hyphens, or periods."),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  format: z.enum(["json", "ndjson"]).default("json"),
  resource_type: z.enum(["Patient", "NutritionIntake"]).optional(),
}).refine(input =>
  (input.from === undefined && input.to === undefined) ||
  rangeSchema.safeParse({ from: input.from, to: input.to }).success,
"Provide both from and to as an ascending range of at most 366 days, or omit both.")
  .refine(input => input.format === "ndjson" ? input.resource_type !== undefined : input.resource_type === undefined,
    "NDJSON requires resource_type. JSON Bundle exports do not accept resource_type.");

function uuid(patientId: string, kind: string, id = ""): string {
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(JSON.stringify([namespace, patientId, kind, id])).digest("hex");
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function quantity(amount: Meal["items"][number]["amount"]): SimpleQuantity {
  const code = unitCodes.get(amount.unit);
  return { value: amount.quantity, unit: amount.unit, ...(code ? { system: ucum, code } : {}) };
}

function nutrientQuantity(key: keyof Nutrients, value: number): SimpleQuantity {
  const unit = key === "kcal" ? "kcal" : "g";
  return { value, unit, system: ucum, code: unit };
}

function product(item: Meal["items"][number], index: number): NutritionProduct {
  const nutrient: NutritionProductNutrient[] = nutrientKeys.flatMap(key => {
    const value = item.nutrients[key];
    if (value === null) return [];
    return [{
      item: { concept: { text: nutrientNames[key] } },
      amount: [{ numerator: nutrientQuantity(key, value), denominator: quantity(item.amount) }],
    }];
  });
  const unknown = nutrientKeys.filter(key => item.nutrients[key] === null).map(key => nutrientNames[key]);
  const notes = [
    `Evidence method: ${item.evidence.method}.`,
    `Source: ${item.evidence.source}`,
    ...(item.evidence.url ? [`Source URL: ${item.evidence.url}`] : []),
    ...(item.evidence.assumptions ? [`Assumptions: ${item.evidence.assumptions}`] : []),
    ...(item.food_id ? [`Saved food ID: ${item.food_id}`] : []),
    ...(unknown.length ? [`Unknown nutrients: ${unknown.join(", ")}.`] : []),
  ];
  return {
    resourceType: "NutritionProduct",
    id: `item-${index + 1}`,
    status: "active",
    code: { text: item.name },
    ...(nutrient.length ? { nutrient } : {}),
    note: notes.map(text => ({ text })),
  };
}

function ingredientLabels(meal: Meal): NutritionIntakeIngredientLabel[] {
  return nutrientKeys.flatMap(key => {
    let value = 0;
    for (const item of meal.items) {
      const amount = item.nutrients[key];
      if (amount === null) return [];
      value += amount;
    }
    if (!Number.isFinite(value)) throw new Error(`Nutrient total exceeds the numeric range for meal ${meal.id}.`);
    return [{
      nutrient: { concept: { text: nutrientNames[key] } },
      amount: nutrientQuantity(key, value),
    }];
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function intake(meal: Meal, patientId: string, patientUrl: string): NutritionIntake {
  if (!/(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(meal.eaten_at)) {
    throw new Error(`Meal ${meal.id} has a timezone offset outside FHIR's supported range of -14:00 to +14:00.`);
  }
  const products = meal.items.map(product);
  const ingredientLabel = ingredientLabels(meal);
  const incomplete = nutrientKeys.filter(key => meal.items.some(item => item.nutrients[key] === null));
  const notes = [
    ...(meal.notes.trim() ? [meal.notes] : []),
    ...(incomplete.length ? [`Meal totals omitted for unknown nutrients: ${incomplete.map(key => nutrientNames[key]).join(", ")}. See the food snapshots for known values.`] : []),
  ];
  const status = meal.status === "void" ? "entered-in-error" : "completed";
  return {
    resourceType: "NutritionIntake",
    id: uuid(patientId, "meal", meal.id),
    identifier: [{ system: `${namespace}/identifier/meal/${patientId}`, value: meal.id }],
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeHtml(meal.occasion)}: ${escapeHtml(meal.eaten_at)} (${status}).</p><ul>${meal.items.map(item => `<li>${escapeHtml(item.name)}: ${item.amount.quantity} ${escapeHtml(item.amount.unit)}; evidence: ${item.evidence.method}.</li>`).join("")}</ul>${notes.map(note => `<p>${escapeHtml(note)}</p>`).join("")}</div>`,
    },
    contained: products,
    status,
    code: { text: meal.occasion },
    subject: { reference: patientUrl },
    occurrenceDateTime: meal.eaten_at,
    reportedBoolean: true,
    consumedItem: meal.items.map((item, index) => ({
      type: { text: "Food or fluid" },
      nutritionProduct: { reference: { reference: `#item-${index + 1}` } },
      amount: quantity(item.amount),
    })),
    ...(ingredientLabel.length ? { ingredientLabel } : {}),
    ...(notes.length ? { note: notes.map(text => ({ text })) } : {}),
  };
}

/** Exports logged meal snapshots as a self-contained FHIR R5 collection Bundle. */
export function exportFhir(meals: Meal[], patientId: string): Bundle<Patient | NutritionIntake> {
  fhirExportSchema.parse({ patient_id: patientId });
  const patientUrl = `urn:uuid:${uuid(patientId, "patient")}`;
  const patient: Patient = {
    resourceType: "Patient",
    id: patientId,
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>Nutrition journal subject: ${escapeHtml(patientId)}. No demographics supplied.</p></div>`,
    },
  };
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { fullUrl: patientUrl, resource: patient },
      ...[...meals].sort((a, b) => Date.parse(a.eaten_at) - Date.parse(b.eaten_at) || a.id.localeCompare(b.id))
        .map(meal => {
          const resource = intake(meal, patientId, patientUrl);
          return { fullUrl: `urn:uuid:${resource.id}`, resource };
        }),
    ],
  };
}

/** Exports one FHIR resource type per file, using relative patient references outside a Bundle. */
export function exportFhirNdjson(meals: Meal[], patientId: string, resourceType: "Patient" | "NutritionIntake"): string {
  const resources: (Patient | NutritionIntake)[] = [];
  for (const { resource } of exportFhir(meals, patientId).entry ?? []) {
    if (!resource || resource.resourceType !== resourceType) continue;
    resources.push(resource.resourceType === "NutritionIntake"
      ? { ...resource, subject: { reference: `Patient/${patientId}` } }
      : resource);
  }
  return toNdjson(resources, "\r\n");
}
