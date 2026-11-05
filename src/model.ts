// Validate persisted graph state and tool inputs at the boundary; scope is never model supplied.
import { createHash } from "node:crypto";
import { z } from "zod";

export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const name = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => v.trim().length > 0, "Must not be blank");
export const observation = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => v.trim().length > 0, "Must not be blank");
export const sourceSchema = z.strictObject({
  source: z.string().min(1).max(512),
  sourceId: z.string().min(1).max(512).optional(),
  validUntil: z.iso.datetime().optional(),
});
export const entityInput = z.strictObject({
  name: name.describe(
    "Unique entity name within the server-authorized namespace",
  ),
  entityType: name.describe("Entity classification"),
  observations: z
    .array(observation)
    .max(200)
    .describe("Atomic memory facts; duplicates are ignored"),
  subjects: z
    .array(name)
    .max(20)
    .optional()
    .describe("Exact associated subject identifiers, not embedding queries"),
  source: sourceSchema
    .optional()
    .describe("Claimed source provenance for these observations"),
});
export const relationSchema = z.strictObject({
  from: name,
  to: name,
  relationType: name,
});
const factSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  content: observation,
  createdAt: z.iso.datetime(),
  source: sourceSchema.optional(),
  vector: z.array(z.number().finite()).min(1).max(16384).optional(),
});
const entitySchema = z.strictObject({
  name,
  entityType: name,
  subjects: z.array(name).max(20),
  facts: z.array(factSchema).max(200),
  revision: z.number().int().positive(),
});
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  entities: z.array(entitySchema).max(1000),
  relations: z.array(relationSchema).max(5000),
  profile: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type Source = z.infer<typeof sourceSchema>;
export type EntityInput = z.infer<typeof entityInput>;
export type Relation = z.infer<typeof relationSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type StoredEntity = Snapshot["entities"][number];
export type Fact = StoredEntity["facts"][number];
export interface GraphStore {
  load(): Promise<Snapshot>;
  commit(expectedRevision: number, next: Snapshot): Promise<void>;
  close(): Promise<void>;
}
export interface Embeddings {
  readonly profile: string;
  embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
  close(): Promise<void>;
}
export const emptySnapshot = (): Snapshot => ({
  schemaVersion: 1,
  revision: 0,
  entities: [],
  relations: [],
});
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const factId = (entity: string, content: string): string =>
  digest(JSON.stringify([entity, content]));
export function visible(fact: Fact, now = Date.now()): boolean {
  return !fact.source?.validUntil || Date.parse(fact.source.validUntil) > now;
}
export function publicEntity(entity: StoredEntity) {
  return {
    name: entity.name,
    entityType: entity.entityType,
    observations: entity.facts.filter((f) => visible(f)).map((f) => f.content),
    subjects: entity.subjects,
    revision: entity.revision,
  };
}
export function subgraph(snapshot: Snapshot, names: Set<string>) {
  return {
    entities: snapshot.entities
      .filter((e) => names.has(e.name))
      .map(publicEntity),
    relations: snapshot.relations.filter(
      (r) => names.has(r.from) && names.has(r.to),
    ),
    revision: snapshot.revision,
  };
}
export function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 262144)
    throw new MemoryError(
      "result_limit",
      "Result exceeds the response allowance; narrow the query or requested names.",
    );
  return value;
}
