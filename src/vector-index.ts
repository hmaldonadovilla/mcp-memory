// MongoDB owns ranking and filtering; graph hydration reads only the selected public entities.
import { z } from "zod";
import type { ClientSession, Collection, Db, Document } from "mongodb";
import { digest, MemoryError, factRef, publicEntity } from "./model.js";
import { actor, aclFilter } from "./access.js";
import type { Actor } from "./access.js";
import { activeTeams } from "./directory.js";
import { readState } from "./state.js";
import { graphBoundary, graphProjection } from "./visibility.js";
import type { Snapshot, SemanticResult } from "./model.js";

export interface SearchSettings {
  name: string;
  dimensions: number;
  management?: "command" | "aggregation";
}

// Community's command interface preserves collection-scoped index-inspection privileges.
async function indexes(db: Db, settings: SearchSettings): Promise<unknown[]> {
  if (settings.management !== "command")
    return db
      .collection("memory_index")
      .listSearchIndexes(settings.name)
      .toArray();
  const result = await db.command({
    listSearchIndexes: "memory_index",
    name: settings.name,
  });
  return z
    .object({
      ok: z.literal(1),
      cursor: z.object({
        id: z.coerce.bigint().refine((id) => id === 0n),
        firstBatch: z.array(z.unknown()).max(1),
      }),
    })
    .parse(result).cursor.firstBatch;
}
interface VectorRecord {
  _id: string;
  namespace: string;
  realm: string;
  tenant_id: string;
  owner_user_id: string;
  scope_ref: string;
  visibility: "user" | "team" | "global";
  team_ids: string[];
  profile: string;
  kind: "entity" | "fact";
  recordId: string;
  entityName: string;
  entityRevision: number;
  embedding?: number[];
  expiresAt: Date;
}
const hitSchema = z.object({
  namespace: z.string(),
  kind: z.enum(["entity", "fact"]),
  recordId: z.string(),
  entityName: z.string(),
  entityRevision: z.number().int().positive(),
  score: z.number().min(-1).max(1),
});
export function vectorDefinition(dimensions: number) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)
    throw new MemoryError(
      "invalid_search_config",
      "Native vector dimensions must be between 1 and 8192.",
    );
  return {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: dimensions,
        similarity: "cosine",
      },
      ...[
        "namespace",
        "realm",
        "tenant_id",
        "owner_user_id",
        "scope_ref",
        "visibility",
        "team_ids",
        "profile",
        "expiresAt",
      ].map((path) => ({
        type: "filter",
        path,
      })),
    ],
  };
}
export function vectorRecords(
  state: Snapshot,
  namespace: string,
  requireComplete = true,
  who: Actor = actor(namespace),
): VectorRecord[] {
  const records: VectorRecord[] = [];
  if (!state.profile) return records;
  for (const entity of state.entities) {
    const values = [
      {
        kind: "entity" as const,
        id: digest(JSON.stringify(["entity", entity.name])),
        vector: entity.vector,
      },
      ...entity.facts.map((fact) => ({
        kind: "fact" as const,
        id: fact.id,
        vector: fact.vector,
        source: fact.source,
        permissions: fact.permissions,
      })),
    ];
    for (const value of values) {
      if (!value.vector) {
        if (requireComplete)
          throw new MemoryError(
            "reindex_required",
            "Every entity and fact needs a compatible embedding; run operator reindex.",
          );
      }
      const source = "source" in value ? value.source : undefined;
      records.push({
        _id: digest(JSON.stringify([namespace, value.kind, value.id])),
        namespace,
        profile: state.profile,
        kind: value.kind,
        recordId: value.id,
        entityName: entity.name,
        entityRevision: entity.revision,
        ...(value.vector ? { embedding: value.vector } : {}),
        expiresAt: new Date(source?.validUntil ?? "9999-12-31T23:59:59Z"),
        realm: who.realm,
        tenant_id: who.tenant_id,
        owner_user_id: who.user_id,
        scope_ref: who.scope_ref,
        visibility:
          "permissions" in value
            ? (value.permissions?.visibility ?? "user")
            : "user",
        team_ids:
          "permissions" in value ? (value.permissions?.team_ids ?? []) : [],
      });
    }
  }
  return records;
}
export class MongoVectorIndex {
  readonly collection: Collection<VectorRecord>;
  constructor(
    private readonly db: Db,
    private readonly namespace: string,
    private readonly settings: SearchSettings,
    private readonly who: Actor = actor(namespace),
    private readonly directory: Db = db,
  ) {
    this.collection = db.collection<VectorRecord>("memory_index");
    vectorDefinition(settings.dimensions);
  }
  async ready(): Promise<void> {
    try {
      const listed = await indexes(this.db, this.settings);
      const index = z
        .object({
          queryable: z.boolean(),
          status: z.string(),
          latestDefinition: z.unknown(),
        })
        .parse(listed[0]);
      if (index.queryable !== true || index.status !== "READY")
        throw new Error("not_ready");
      const expected = vectorDefinition(this.settings.dimensions);
      const actual = index.latestDefinition as unknown;
      const shape = z
        .object({
          fields: z.array(
            z.object({
              type: z.string(),
              path: z.string(),
              numDimensions: z.number().optional(),
              similarity: z.string().optional(),
            }),
          ),
        })
        .parse(actual);
      if (JSON.stringify(shape) !== JSON.stringify(expected))
        throw new MemoryError(
          "search_index_mismatch",
          "The native index definition differs from the configured dimensions, metric or scope filters.",
        );
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError(
        "search_index_unavailable",
        "The native vector index is missing, unready or inaccessible. Run the operator index preparation; no local search fallback exists.",
      );
    }
  }
  async update(
    previous: Snapshot,
    next: Snapshot,
    session: ClientSession,
  ): Promise<void> {
    const before = new Map(
      vectorRecords(previous, this.namespace, false, this.who).map((record) => [
        record._id,
        record,
      ]),
    );
    for (const record of vectorRecords(next, this.namespace, false, this.who)) {
      const old = before.get(record._id);
      const { embedding, ...metadata } = record;
      const oldMetadata = old && { ...old, embedding: undefined };
      if (
        embedding ||
        JSON.stringify({ ...metadata, embedding: undefined }) !==
          JSON.stringify(oldMetadata)
      ) {
        if (embedding && embedding.length !== this.settings.dimensions)
          throw new MemoryError(
            "embedding_incompatible",
            "Stored vector dimensions differ from the native index.",
          );
        if (!old && !embedding)
          throw new MemoryError(
            "reindex_required",
            "New indexed records require an embedding.",
          );
        const result = await this.collection.updateOne(
          { _id: record._id, namespace: this.namespace },
          { $set: { ...metadata, ...(embedding ? { embedding } : {}) } },
          { upsert: !!embedding, session },
        );
        if (!embedding && result.matchedCount !== 1)
          throw new MemoryError(
            "reindex_required",
            "A canonical embedding is missing; run operator reindex.",
          );
      }
      before.delete(record._id);
    }
    if (before.size)
      await this.collection.deleteMany(
        { namespace: this.namespace, _id: { $in: [...before.keys()] } },
        { session },
      );
  }
  async search(
    vector: number[],
    profile: string,
    topK: number,
    minScore: number,
    signal?: AbortSignal,
  ): Promise<SemanticResult> {
    if (
      vector.length !== this.settings.dimensions ||
      vector.some((v) => !Number.isFinite(v)) ||
      !Math.hypot(...vector)
    )
      throw new MemoryError(
        "embedding_incompatible",
        "Query vector dimensions and values must match the native index.",
      );
    try {
      const graphs = this.db.collection("memory_graphs");
      const metadata = await graphs
        .aggregate<Document>(
          [
            { $match: { _id: this.namespace, ...graphBoundary(this.who) } },
            {
              $project: {
                revision: 1,
                profile: 1,
                hasEntities: { $gt: [{ $size: "$entities" }, 0] },
              },
            },
          ],
          { maxTimeMS: 10000, signal },
        )
        .next();
      if (!metadata || (metadata.hasEntities && !metadata.profile))
        throw new MemoryError(
          "reindex_required",
          "Existing graph needs operator reindex before semantic retrieval.",
        );
      if (metadata.profile && metadata.profile !== profile)
        throw new MemoryError(
          "embedding_profile_mismatch",
          "Stored memory and query profiles differ; run operator reindex.",
        );
      const teams = (await activeTeams(this.directory, this.who)).map(
        (team) => team.team_id,
      );
      const filter = {
        ...aclFilter(this.who, teams),
        profile,
        expiresAt: { $gt: new Date() },
      };
      const rows = await this.collection
        .aggregate(
          [
            {
              $vectorSearch: {
                index: this.settings.name,
                path: "embedding",
                queryVector: vector,
                numCandidates: Math.min(10000, Math.max(100, topK * 20)),
                limit: topK,
                filter,
              },
            },
            { $match: filter },
            {
              $project: {
                _id: 0,
                namespace: 1,
                kind: 1,
                recordId: 1,
                entityName: 1,
                entityRevision: 1,
                score: {
                  $subtract: [
                    { $multiply: [{ $meta: "vectorSearchScore" }, 2] },
                    1,
                  ],
                },
              },
            },
            { $match: { score: { $gte: minScore } } },
          ],
          { maxTimeMS: 10000, signal },
        )
        .toArray();
      const hits = rows.map((row) => hitSchema.parse(row));
      const selectedNames = {
        $map: {
          input: {
            $filter: {
              input: { $literal: hits },
              as: "h",
              cond: { $eq: ["$$h.namespace", "$_id"] },
            },
          },
          as: "h",
          in: "$$h.entityName",
        },
      };
      const documents = await graphs
        .aggregate(
          [
            {
              $match: {
                ...graphBoundary(this.who),
                _id: { $in: [...new Set(hits.map((hit) => hit.namespace))] },
              },
            },
            { $project: graphProjection(this.who, teams, selectedNames) },
          ],
          { maxTimeMS: 10000, signal },
        )
        .toArray();
      const matches: SemanticResult["matches"] = [];
      const entities: SemanticResult["entities"] = [];
      const relations: SemanticResult["relations"] = [];
      for (const doc of documents) {
        const { _id, ...value } = doc;
        const namespace = z.string().parse(_id);
        const graph = readState({ _id, ...value });
        if (graph.profile !== profile) continue;
        const chosen = new Set<string>();
        for (const hit of hits.filter((hit) => hit.namespace === namespace)) {
          const entity = graph.entities.find(
            (entity) =>
              entity.name === hit.entityName &&
              entity.revision === hit.entityRevision,
          );
          if (!entity) continue;
          const fact = entity.facts.find((fact) => fact.id === hit.recordId);
          if (hit.kind === "fact" && (!fact || !fact.permissions)) continue;
          if (hit.kind === "entity" && namespace !== this.namespace) continue;
          chosen.add(entity.name);
          matches.push({
            entityName: entity.name,
            kind: hit.kind,
            score: hit.score,
            observation: fact
              ? fact.content
              : entity.name + " (" + entity.entityType + ")",
            recordRef: fact?.permissions
              ? factRef(namespace, fact.id, fact.permissions)
              : "entity:" + hit.recordId + ":" + hit.entityRevision,
            ...(fact?.source ? { source: fact.source } : {}),
          });
        }
        for (const entity of graph.entities.filter((entity) =>
          chosen.has(entity.name),
        )) {
          for (const fact of entity.facts)
            if (fact.permissions)
              fact.ref = factRef(namespace, fact.id, fact.permissions);
          entities.push(publicEntity(entity));
        }
        relations.push(
          ...graph.relations.filter(
            (relation) => chosen.has(relation.from) && chosen.has(relation.to),
          ),
        );
      }
      const current = (await activeTeams(this.directory, this.who)).map(
        (team) => team.team_id,
      );
      if (JSON.stringify(teams) !== JSON.stringify(current))
        throw new MemoryError(
          "authorization_changed",
          "Team memberships changed during retrieval; no result was disclosed.",
        );
      return {
        entities,
        relations,
        revision: Number(metadata.revision),
        matches: matches.sort((a, b) => b.score - a.score),
        embeddingProfile: profile,
      };
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError(
        "native_search_unavailable",
        "MongoDB Vector Search failed; no application-side similarity scan or retry was made.",
      );
    }
  }
}

// Operator-only provisioning, never called by the serving MCP or a tool invocation.
export async function prepareVectorIndex(
  db: Db,
  settings: SearchSettings,
): Promise<void> {
  const collection = db.collection("memory_index");
  await collection.createIndex(
    { namespace: 1, kind: 1, recordId: 1 },
    { name: "memory_vector_identity", unique: true },
  );
  const existing = await indexes(db, settings);
  if (!existing.length)
    await collection.createSearchIndex({
      name: settings.name,
      type: "vectorSearch",
      definition: vectorDefinition(settings.dimensions),
    });
  const index = new MongoVectorIndex(db, "operator", settings);
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await index.ready();
      return;
    } catch (error) {
      if (
        !(error instanceof MemoryError) ||
        error.code !== "search_index_unavailable" ||
        attempt === 119
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
