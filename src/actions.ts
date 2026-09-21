import { z } from "zod";
import { exportFhir, fhirExportSchema } from "./fhir.js";
import {
  dateSchema, foodSchema, idSchema, mealInputSchema, mealSchema,
  nutrientKeys, profileSchema, rangeSchema, type Meal, type Nutrients, type Profile,
} from "./schema.js";
import { type Store } from "./store.js";

/** One validated operation, exposed unchanged through both interfaces. */
export type Action = {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
  run: (input: unknown) => unknown;
};

function action<T>(name: string, description: string, schema: z.ZodType<T>, readOnly: boolean,
  execute: (input: T) => unknown): Action {
  return { name, description, schema, readOnly, run: input => execute(schema.parse(input)) };
}

function localDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = (name: string) => parts.find(value => value.type === name)?.value;
  return dateSchema.parse(`${part("year")}-${part("month")}-${part("day")}`);
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function scale(values: Nutrients, servings: number): Nutrients {
  return {
    kcal: values.kcal === null ? null : values.kcal * servings,
    protein_g: values.protein_g === null ? null : values.protein_g * servings,
    carbs_g: values.carbs_g === null ? null : values.carbs_g * servings,
    fat_g: values.fat_g === null ? null : values.fat_g * servings,
    fiber_g: values.fiber_g === null ? null : values.fiber_g * servings,
  };
}

function totals(meals: Meal[], target?: Profile["targets"][number]) {
  const items = meals.flatMap(meal => meal.items);
  const nutrients = Object.fromEntries(nutrientKeys.map(key => {
    const known = rounded(items.reduce((sum, item) => sum + (item.nutrients[key] ?? 0), 0));
    const unknownItems = items.filter(item => item.nutrients[key] === null).length;
    const complete = items.length > 0 && unknownItems === 0;
    const goal = target?.[key] ?? null;
    return [key, {
      known, unknown_items: unknownItems, complete, target: goal,
      remaining: goal !== null && complete ? rounded(goal - known) : null,
    }];
  }));
  return {
    meal_count: meals.length, item_count: items.length,
    estimated_items: items.filter(item => item.evidence.method === "estimate").length,
    nutrients,
  };
}

/** Creates the shared tool contracts and deterministic nutrition operations. */
export function createActions(store: Store): Action[] {
  const idInput = z.strictObject({ id: idSchema });
  const revision = z.string().regex(/^[a-f0-9]{64}$/);

  function mealsInRange(from: string, to: string) {
    const profile = store.readProfile().record;
    const meals = store.list("meal").map(id => store.readMeal(id))
      .filter(({ record }) => {
        const date = localDate(record.eaten_at, profile.timezone);
        return date >= from && date <= to;
      }).sort((a, b) => Date.parse(a.record.eaten_at) - Date.parse(b.record.eaten_at));
    return { profile, meals };
  }

  return [
    action("init_journal", "Create an empty local journal. Refuses to replace an existing journal.",
      z.strictObject({ timezone: profileSchema.shape.timezone }), false,
      input => store.init(input.timezone)),
    action("get_profile", "Read timezone, dated user targets, and Markdown notes.",
      z.strictObject({}), true, () => store.readProfile()),
    action("set_profile", "Replace a profile using its current revision. Preserve past dated targets.",
      z.strictObject({ profile: profileSchema, expected_revision: revision }), false,
      input => store.putProfile(input.profile, input.expected_revision)),
    action("put_food", "Save food nutrition per serving. An update needs the current revision; identical retries are safe.",
      z.strictObject({ food: foodSchema, expected_revision: revision.optional() }), false,
      input => store.putFood(input.food, input.expected_revision)),
    action("get_food", "Read a saved food and its revision by ID.", idInput, true,
      input => store.readFood(input.id)),
    action("search_foods", "Search saved foods by name, ID, or notes. Empty query lists all foods.",
      z.strictObject({ query: z.string().default("") }), true,
      input => {
        const query = input.query.toLocaleLowerCase();
        return store.list("food").map(id => store.readFood(id)).filter(({ record }) =>
          `${record.id} ${record.name} ${record.notes}`.toLocaleLowerCase().includes(query));
      }),
    action("log_meal", "Log a meal with a stable ID. Saved-food servings become fixed nutrition snapshots. Reuse the ID on retries.",
      z.strictObject({ meal: mealInputSchema }), false,
      input => {
        const items = input.meal.items.map(item => {
          if (!("servings" in item)) return item;
          const food = store.readFood(item.food_id).record;
          return {
            food_id: food.id, name: food.name,
            amount: { quantity: food.serving.quantity * item.servings, unit: food.serving.unit },
            nutrients: scale(food.nutrients, item.servings), evidence: food.evidence,
          };
        });
        return store.putMeal({ ...input.meal, items });
      }),
    action("get_meal", "Read one meal and its revision by ID.", idInput, true,
      input => store.readMeal(input.id)),
    action("update_meal", "Correct a meal by ID with its current revision. Set status to void to undo a log without deleting its file.",
      z.strictObject({ meal: mealSchema, expected_revision: revision }), false,
      input => store.putMeal(input.meal, input.expected_revision)),
    action("list_meals", "List meals, including void records, within inclusive local date bounds.",
      rangeSchema, true, input => mealsInRange(input.from, input.to).meals),
    action("export_fhir", "Export a FHIR R5 collection Bundle with a Patient and logged meal snapshots. Includes void meals as entered-in-error. Optional dates use the profile timezone.",
      fhirExportSchema, true, input => {
        const meals = input.from !== undefined && input.to !== undefined
          ? mealsInRange(input.from, input.to).meals
          : store.list("meal").map(id => store.readMeal(id));
        return exportFhir(meals.map(value => value.record), input.patient_id);
      }),
    action("summarize", "Compute daily and period totals from active meals. Unknown values and days without logs stay explicit.",
      rangeSchema, true, input => {
        const { profile, meals } = mealsInRange(input.from, input.to);
        const active = meals.map(value => value.record).filter(meal => meal.status === "active");
        const days = [];
        for (let time = Date.parse(input.from); time <= Date.parse(input.to); time += 86400000) {
          const date = new Date(time).toISOString().slice(0, 10);
          const daily = active.filter(meal => localDate(meal.eaten_at, profile.timezone) === date);
          const target = profile.targets.filter(value => value.from <= date)
            .sort((a, b) => a.from.localeCompare(b.from)).at(-1);
          days.push({ date, logged: daily.length > 0, ...totals(daily, target) });
        }
        return { timezone: profile.timezone, from: input.from, to: input.to, days, total: totals(active) };
      }),
    action("validate_journal", "Validate all Markdown records. Reports malformed data without rewriting it.",
      z.strictObject({}), true, () => {
        const errors: string[] = [];
        let checked = 0;
        const check = (read: () => unknown) => {
          checked += 1;
          try { read(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        };
        check(() => store.readProfile());
        for (const kind of ["food", "meal"] as const) {
          try {
            for (const id of store.list(kind)) check(() => kind === "food" ? store.readFood(id) : store.readMeal(id));
          } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        }
        return { valid: errors.length === 0, checked, errors };
      }),
  ];
}
