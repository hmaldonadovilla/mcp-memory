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
const identityKey = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:./-]+$/);
export const permissionsSchema = z
  .strictObject({
    creator_user_id: identityKey,
    source_conversation_id: identityKey.nullable(),
    source_task_id: identityKey.nullable(),
    generation: z.uuid(),
    revision: z.number().int().positive(),
    visibility: z.enum(["user", "team", "global"]),
    team_ids: z.array(identityKey).max(64),
  })
  .refine(
    (value) =>
      value.team_ids.length === new Set(value.team_ids).size &&
      (value.visibility === "team"
        ? value.team_ids.length > 0
        : value.team_ids.length === 0),
  );
export type FactPermissions = z.infer<typeof permissionsSchema>;
const factSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  content: observation,
  createdAt: z.iso.datetime(),
  source: sourceSchema.optional(),
  vector: z.array(z.number().finite()).min(1).max(16384).optional(),
  permissions: permissionsSchema.optional(),
  ref: z.string().optional(),
});
const entitySchema = z.strictObject({
  name,
  entityType: name,
  subjects: z.array(name).max(20),
  facts: z.array(factSchema).max(200),
  revision: z.number().int().positive(),
  vector: z.array(z.number().finite()).min(1).max(8192).optional(),
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
  authorize?(): void;
  load(): Promise<Snapshot>;
  view?(): Promise<Snapshot>;
  teams?(): Promise<{ team_id: string; name: string }[]>;
  setPermissions?(change: {
    fact_refs: string[];
    visibility: "user" | "team" | "global";
    team_ids: string[];
  }): Promise<unknown>;
  commit(
    expectedRevision: number,
    next: Snapshot,
    previous?: Snapshot,
  ): Promise<Snapshot | void>;
  search?(
    vector: number[],
    profile: string,
    topK: number,
    minScore: number,
    signal?: AbortSignal,
  ): Promise<SemanticResult>;
  close(): Promise<void>;
}
export interface SemanticMatch {
  entityName: string;
  observation: string;
  score: number;
  recordRef: string;
  kind: "entity" | "fact";
  source?: Source;
}
export interface SemanticResult {
  entities: ReturnType<typeof publicEntity>[];
  relations: Relation[];
  revision: number;
  matches: SemanticMatch[];
  embeddingProfile: string;
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
export function factRef(
  namespace: string,
  id: string,
  permissions: FactPermissions,
): string {
  return (
    "fact:" +
    digest(JSON.stringify([namespace, "fact", id])) +
    ":" +
    digest(JSON.stringify([permissions.generation, permissions.revision]))
  );
}
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
    ...(entity.facts.some((fact) => fact.ref)
      ? {
          fact_metadata: entity.facts
            .filter((fact) => visible(fact) && fact.ref && fact.permissions)
            .map((fact) => ({
              ref: fact.ref,
              observation: fact.content,
              visibility: fact.permissions!.visibility,
              team_ids: fact.permissions!.team_ids,
              creator_user_id: fact.permissions!.creator_user_id,
              source_conversation_id: fact.permissions!.source_conversation_id,
            })),
        }
      : {}),
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
