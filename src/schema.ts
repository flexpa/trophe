import { z } from "zod";

/** Stable nutrient keys and units used in records, targets, and summaries. */
export const nutrientKeys = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const;

/** A record ID is also its filename; path separators are not allowed. */
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);

/** An actual calendar date, without an implied timezone. */
export const dateSchema = z.iso.date();

/** Unknown nutrients are null, never zero. Values describe the stated portion. */
export const nutrientsSchema = z.strictObject({
  kcal: z.number().nonnegative().nullable(),
  protein_g: z.number().nonnegative().nullable(),
  carbs_g: z.number().nonnegative().nullable(),
  fat_g: z.number().nonnegative().nullable(),
  fiber_g: z.number().nonnegative().nullable().default(null),
});

/** Amounts are explicit; Trophe does not infer conversions between units. */
export const amountSchema = z.strictObject({
  quantity: z.number().positive(),
  unit: z.string().trim().min(1).max(60),
});

/** Evidence records how a value was obtained and any estimation assumptions. */
export const evidenceSchema = z.strictObject({
  method: z.enum(["label", "database", "estimate", "user"]),
  source: z.string().trim().min(1),
  url: z.url().optional(),
  assumptions: z.string().default(""),
}).refine(value => value.method !== "estimate" || value.assumptions.trim().length > 0, {
  message: "An estimate must state its portion and preparation assumptions.",
  path: ["assumptions"],
});

/** Saved food values describe one reusable serving. Notes form the Markdown body. */
export const foodSchema = z.strictObject({
  schema_version: z.literal(1).default(1),
  kind: z.literal("food").default("food"),
  id: idSchema,
  name: z.string().trim().min(1),
  serving: amountSchema,
  nutrients: nutrientsSchema,
  evidence: evidenceSchema,
  notes: z.string().default(""),
});

/** A meal item retains its own values even if the saved food changes later. */
export const itemSchema = z.strictObject({
  food_id: idSchema.optional(),
  name: z.string().trim().min(1),
  amount: amountSchema,
  nutrients: nutrientsSchema,
  evidence: evidenceSchema,
});

const mealFields = {
  schema_version: z.literal(1).default(1),
  kind: z.literal("meal").default("meal"),
  id: idSchema,
  eaten_at: z.iso.datetime({ offset: true }),
  occasion: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]),
  status: z.enum(["active", "void"]).default("active"),
  notes: z.string().default(""),
};

/** Stored meals contain only nutrition snapshots, not live food references. */
export const mealSchema = z.strictObject({
  ...mealFields,
  items: z.array(itemSchema).min(1),
});

/** Logging accepts either explicit values or a count of saved food servings. */
export const mealInputSchema = z.strictObject({
  ...mealFields,
  items: z.array(z.union([
    z.strictObject({ food_id: idSchema, servings: z.number().positive() }),
    itemSchema,
  ])).min(1),
});

/** Targets apply from a date until the next target; they are set by the user. */
export const targetSchema = z.strictObject({
  from: dateSchema,
  kcal: z.number().nonnegative().optional(),
  protein_g: z.number().nonnegative().optional(),
  carbs_g: z.number().nonnegative().optional(),
  fat_g: z.number().nonnegative().optional(),
  fiber_g: z.number().nonnegative().optional(),
});

/** Profile timezone defines calendar days for every report. */
export const profileSchema = z.strictObject({
  schema_version: z.literal(1).default(1),
  kind: z.literal("profile").default("profile"),
  timezone: z.string().refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch { return false; }
  }, "Use a valid IANA timezone, such as America/Toronto."),
  targets: z.array(targetSchema).default([]).refine(
    values => new Set(values.map(value => value.from)).size === values.length,
    "Each target must have a different start date.",
  ),
  notes: z.string().default(""),
});

/** Inclusive report bounds; a range may contain at most 366 days. */
export const rangeSchema = z.strictObject({ from: dateSchema, to: dateSchema }).refine(
  value => value.from <= value.to && Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000,
  "Use an ascending date range of at most 366 days.",
);

/** A saved food with its serving and evidence. */
export type Food = z.infer<typeof foodSchema>;
/** A stored meal containing fixed nutrition values. */
export type Meal = z.infer<typeof mealSchema>;
/** Personal settings and dated nutrition targets. */
export type Profile = z.infer<typeof profileSchema>;
/** Numeric values for one portion; null means unknown. */
export type Nutrients = z.infer<typeof nutrientsSchema>;
