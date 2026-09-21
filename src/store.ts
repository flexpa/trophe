import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { foodSchema, idSchema, mealSchema, profileSchema } from "./schema.js";

/** The three record types each have one canonical location and schema. */
export const recordSchemas = { food: foodSchema, meal: mealSchema, profile: profileSchema };

/** A hash of the exact Markdown file prevents stale tool updates. */
export type Document<T> = { record: T; revision: string };

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function encode(record: { notes: string }): string {
  const { notes, ...metadata } = record;
  return `---\n${stringify(metadata)}---\n${notes.trim() ? `\n${notes.trim()}\n` : ""}`;
}

function decode<T>(text: string, schema: z.ZodType<T>): T {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Expected YAML front matter between --- lines.");
  const metadata: unknown = parse(match[1] ?? "", { maxAliasCount: 20 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Front matter must be an object.");
  }
  if ("notes" in metadata) throw new Error("Put notes in the Markdown body, not front matter.");
  return schema.parse({ ...metadata, notes: (match[2] ?? "").trim() });
}

function atomicWrite(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Opens an explicit data directory without creating it or changing its records. */
export function openStore(directory: string) {
  const root = resolve(directory);

  function pathFor(kind: keyof typeof recordSchemas, id?: string): string {
    if (kind === "profile") return join(root, "profile.md");
    return join(root, kind === "food" ? "foods" : "journal", `${idSchema.parse(id)}.md`);
  }

  function assertInitialized(): void {
    if (!existsSync(pathFor("profile"))) throw new Error(`No journal at ${root}. Run init first.`);
  }

  function locked<T>(operation: () => T): T {
    const lock = join(root, ".write-lock");
    try { mkdirSync(lock); }
    catch (error) {
      if (existsSync(lock)) throw new Error(`Another write holds ${lock}. Retry after it finishes. If a process crashed, remove this empty lock directory only after all Trophe writers stop.`);
      throw error;
    }
    try { return operation(); }
    finally { rmSync(lock, { recursive: true }); }
  }

  function read<T>(kind: keyof typeof recordSchemas, schema: z.ZodType<T>, id?: string): Document<T> {
    assertInitialized();
    const path = pathFor(kind, id);
    const text = readFileSync(path, "utf8");
    try {
      const record = decode(text, schema);
      if (id && typeof record === "object" && record && "id" in record && record.id !== id) {
        throw new Error("Record ID must match its filename.");
      }
      return { record, revision: digest(text) };
    } catch (error) {
      throw new Error(`Invalid record ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function list(kind: "food" | "meal"): string[] {
    assertInitialized();
    const folder = join(root, kind === "food" ? "foods" : "journal");
    return readdirSync(folder).filter(name => name.endsWith(".md")).sort().map(name => idSchema.parse(name.slice(0, -3)));
  }

  function put<T extends { notes: string }>(
    kind: keyof typeof recordSchemas, schema: z.ZodType<T>, input: unknown,
    id?: string, expectedRevision?: string,
  ): Document<T> {
    assertInitialized();
    return locked(() => {
      const record = schema.parse(input);
      const path = pathFor(kind, id);
      const text = encode(record);
      const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (previous === text) return { record, revision: digest(text) };
      if (previous !== undefined && digest(previous) !== expectedRevision) {
        throw new Error(`Record exists or changed. Read it and supply its current expected_revision: ${path}`);
      }
      if (previous === undefined && expectedRevision !== undefined) throw new Error("Cannot update a missing record.");
      atomicWrite(path, text);
      return { record, revision: digest(text) };
    });
  }

  return {
    root,
    /** Creates an empty journal. It refuses to replace an existing profile. */
    init(timezone: string) {
      const profile = profileSchema.parse({ timezone });
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return locked(() => {
        if (existsSync(pathFor("profile"))) throw new Error(`Journal already exists at ${root}.`);
        mkdirSync(join(root, "foods"), { recursive: true });
        mkdirSync(join(root, "journal"), { recursive: true });
        mkdirSync(join(root, "attachments"), { recursive: true });
        atomicWrite(pathFor("profile"), encode(profile));
        return { directory: root, profile };
      });
    },
    readProfile: () => read("profile", profileSchema),
    readFood: (id: string) => read("food", foodSchema, id),
    readMeal: (id: string) => read("meal", mealSchema, id),
    list,
    putFood: (input: unknown, revision?: string) => {
      const record = foodSchema.parse(input);
      return put("food", foodSchema, record, record.id, revision);
    },
    putMeal: (input: unknown, revision?: string) => {
      const record = mealSchema.parse(input);
      return put("meal", mealSchema, record, record.id, revision);
    },
    putProfile: (input: unknown, revision: string) => put("profile", profileSchema, input, undefined, revision),
  };
}

/** The local record store used by all actions. */
export type Store = ReturnType<typeof openStore>;
