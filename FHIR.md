# FHIR R5 export

Trophe exports meal history using the native
[NutritionIntake](https://hl7.org/fhir/R5/nutritionintake.html) and
[NutritionProduct](https://hl7.org/fhir/R5/nutritionproduct.html) resources in
FHIR **5.0.0 (R5)**. These nutrition resources have trial-use status in R5.
This export does not target FHIR R4 or a receiver-specific implementation guide.

## Interfaces

```sh
yarn trophe export fhir5 --patient-id example-person > nutrition.fhir.json
yarn trophe export fhir5 --patient-id example-person \
  --from 2026-09-01 --to 2026-09-30 > september.fhir.json
```

The same MCP tool is `export_fhir`:

```json
{
  "patient_id": "example-person",
  "from": "2026-09-01",
  "to": "2026-09-30"
}
```

`patient_id` is required. It must contain 1–64 letters, digits, hyphens, or periods,
as required for a [FHIR resource ID](https://hl7.org/fhir/R5/datatypes.html#id).
Dates are optional but must be supplied together. They use the profile timezone,
are inclusive, and follow the existing 366-day maximum for bounded reports.
Omitting both dates exports the entire meal history, without a date-range limit.

The CLI prints the Bundle itself as JSON, suitable for redirecting to a file.
The MCP response carries the same JSON in its text content. Export is read-only.

## Mapping

| Trophe data | FHIR representation |
| --- | --- |
| Journal subject | One minimal `Patient` with the supplied ID |
| Export | A `Bundle` with `type: collection` |
| Meal | One `NutritionIntake` |
| Meal ID | Business `identifier`, scoped to the supplied patient ID |
| Eating timestamp | `occurrenceDateTime`, preserving the source offset and precision |
| Meal occasion | `code.text` |
| Active meal | `status: completed` |
| Void meal | `status: entered-in-error`; this does not assert the food was refused |
| Meal item | `consumedItem` with its amount and a reference to a contained product |
| Item snapshot | Contained `NutritionProduct` with the food name and nutrients |
| Item nutrient | `NutritionProduct.nutrient.amount`: a ratio of nutrient quantity to the full consumed portion |
| Complete meal nutrient total | `NutritionIntake.ingredientLabel.amount` |
| Sources, source URLs, estimation assumptions, saved food ID | Product `note` annotations |
| Meal notes | Intake `note` annotations |

The export uses stored meal snapshots. It does not reread current saved-food
values. A product ratio of **15 g protein per 150 g food**, consumed in a **150 g**
portion, means **15 g protein consumed**. The portion is not multiplied twice.

Food and nutrient names use native text CodeableConcepts. Trophe does not invent
SNOMED CT, LOINC, or product catalog codes. A receiving system that requires a
specific terminology or profile will need its own mapping step.

## Units and missing values

Nutrient quantities use [UCUM](https://hl7.org/fhir/R5/ucum.html): `kcal` for energy
and `g` for protein, carbohydrate, fat, and fiber. Recognized portion units (`g`,
`kg`, `mg`, `ug`, `µg`, `ml`, `mL`, `l`, `L`) also receive UCUM codes. Display units
are preserved. Other units, such as `bowl`, `serving`, `cup`, or `oz`, remain text
without an inferred unit conversion or unit system.

Unknown nutrients are omitted, not written as zero or JSON null. If any item has
an unknown nutrient, the whole-meal total for that nutrient is omitted. Known
values remain available in individual product snapshots. Notes identify missing
nutrients and estimation methods. A known zero is exported as zero.

Timestamps must have an offset within FHIR's supported range of -14:00 to +14:00.
Export fails with the meal ID if a record uses an offset outside that range.

## Identity and scope

Bundle entries have `urn:uuid:` full URLs. Intake UUIDs are deterministic UUIDv5
values scoped to the supplied patient ID and meal ID. Repeating the export with
the same records and patient ID produces the same output. Corrections retain the
intake's identity. Long journal IDs and underscores remain in business identifiers
instead of becoming invalid FHIR resource IDs. Patient and contained-product
references resolve within the Bundle.

Use the same patient ID when exporting the same journal. Use distinct IDs for
different subjects. The minimal Patient contains no invented name, birth date,
or identifier from an external system. A FHIR server import must still map it to
the correct person. This collection Bundle is not a transaction request.

An empty journal or empty date range produces a Bundle containing only the Patient.
Voided meals are retained so a receiver can see their error status. Saved-food
catalog entries without consumption, profile targets, preferences, and attachment
file contents are not exported. Source links and Markdown notes are included.

The exporter is typed against FHIR R5 and tested for references, units, incomplete
totals, corrections, stable IDs, and CLI/MCP parity. The example is checked against
HL7's published R5 JSON Schema. Schema validation does not establish conformance
to a receiving system's clinical profile or terminology requirements.
