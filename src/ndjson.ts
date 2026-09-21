/** Serializes one JSON object per line, with a final newline for nonempty exports. */
export function toNdjson(records: object[], newline: "\n" | "\r\n" = "\n"): string {
  return records.length ? `${records.map(record => JSON.stringify(record)).join(newline)}${newline}` : "";
}
