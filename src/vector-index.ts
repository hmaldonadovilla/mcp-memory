// MongoDB owns ranking and filtering; graph hydration reads only the selected public entities.
import { z } from "zod";
import type { ClientSession, Collection, Db, Document } from "mongodb";
import { digest, MemoryError, sourceSchema } from "./model.js";
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
      .collection("memory_vectors")
      .listSearchIndexes(settings.name)
      .toArray();
  const result = await db.command({
    listSearchIndexes: "memory_vectors",
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
  profile: string;
  kind: "entity" | "fact";
  recordId: string;
  entityName: string;
  observation: string;
  entityRevision: number;
  embedding: number[];
  expiresAt: Date;
  source?: z.infer<typeof sourceSchema>;
}
const hitSchema = z.object({
  kind: z.enum(["entity", "fact"]),
  recordId: z.string(),
  entityName: z.string(),
  observation: z.string(),
  entityRevision: z.number().int().positive(),
  score: z.number().min(-1).max(1),
  source: sourceSchema.optional(),
});
const graphSchema = z.object({
  revision: z.number().int().nonnegative(),
  entities: z.array(
    z.object({
      name: z.string(),
      entityType: z.string(),
      subjects: z.array(z.string()),
      revision: z.number().int(),
      observations: z.array(z.string()),
    }),
  ),
  relations: z.array(
    z.object({ from: z.string(), to: z.string(), relationType: z.string() }),
  ),
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
      ...["namespace", "profile", "expiresAt"].map((path) => ({
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
): VectorRecord[] {
  const records: VectorRecord[] = [];
  if (!state.profile) return records;
  for (const entity of state.entities) {
    const values = [
      {
        kind: "entity" as const,
        id: digest(JSON.stringify(["entity", entity.name])),
        content: entity.name + " (" + entity.entityType + ")",
        vector: entity.vector,
      },
      ...entity.facts.map((fact) => ({
        kind: "fact" as const,
        id: fact.id,
        content: fact.content,
        vector: fact.vector,
        source: fact.source,
      })),
    ];
    for (const value of values) {
      if (!value.vector) {
        if (requireComplete)
          throw new MemoryError(
            "reindex_required",
            "Every entity and fact needs a compatible embedding; run operator reindex.",
          );
        continue;
      }
      const source = "source" in value ? value.source : undefined;
      records.push({
        _id: digest(JSON.stringify([namespace, value.kind, value.id])),
        namespace,
        profile: state.profile,
        kind: value.kind,
        recordId: value.id,
        entityName: entity.name,
        observation: value.content,
        entityRevision: entity.revision,
        embedding: value.vector,
        expiresAt: new Date(source?.validUntil ?? "9999-12-31T23:59:59Z"),
        ...(source ? { source } : {}),
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
  ) {
    this.collection = db.collection<VectorRecord>("memory_vectors");
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
      (previous.profile
        ? vectorRecords(previous, this.namespace, false)
        : []
      ).map((record) => [record._id, record]),
    );
    const after = vectorRecords(next, this.namespace);
    for (const record of after) {
      const old = before.get(record._id);
      if (JSON.stringify(old) !== JSON.stringify(record)) {
        if (record.embedding.length !== this.settings.dimensions)
          throw new MemoryError(
            "embedding_incompatible",
            "Stored vector dimensions differ from the native index.",
          );
        await this.collection.replaceOne(
          { _id: record._id, namespace: this.namespace },
          record,
          { upsert: true, session },
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
            { $match: { _id: this.namespace } },
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
          "Stored memory and query embedding profiles differ; run operator reindex.",
        );
      const now = new Date();
      const filter = {
        namespace: this.namespace,
        profile,
        expiresAt: { $gt: now },
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
                kind: 1,
                recordId: 1,
                entityName: 1,
                observation: 1,
                entityRevision: 1,
                source: 1,
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
      const names = [...new Set(hits.map((hit) => hit.entityName))];
      const visibleFacts = {
        $filter: {
          input: "$$e.facts",
          as: "f",
          cond: {
            $or: [
              { $eq: [{ $type: "$$f.source.validUntil" }, "missing"] },
              { $gt: ["$$f.source.validUntil", now.toISOString()] },
            ],
          },
        },
      };
      const selectedEntities = {
        $filter: {
          input: "$entities",
          as: "e",
          cond: { $in: ["$$e.name", { $literal: names }] },
        },
      };
      const result = await graphs
        .aggregate(
          [
            { $match: { _id: this.namespace, revision: metadata.revision } },
            {
              $project: {
                _id: 0,
                revision: 1,
                entities: {
                  $map: {
                    input: selectedEntities,
                    as: "e",
                    in: {
                      name: "$$e.name",
                      entityType: "$$e.entityType",
                      subjects: "$$e.subjects",
                      revision: "$$e.revision",
                      observations: {
                        $map: {
                          input: visibleFacts,
                          as: "f",
                          in: "$$f.content",
                        },
                      },
                    },
                  },
                },
                relations: {
                  $filter: {
                    input: "$relations",
                    as: "r",
                    cond: {
                      $and: [
                        { $in: ["$$r.from", { $literal: names }] },
                        { $in: ["$$r.to", { $literal: names }] },
                      ],
                    },
                  },
                },
              },
            },
          ],
          { maxTimeMS: 10000, signal },
        )
        .next();
      if (!result)
        throw new MemoryError(
          "search_snapshot_changed",
          "The graph changed during retrieval; read the current state before another request.",
        );
      const graph = graphSchema.parse(result);
      const matches = hits
        .filter((hit) =>
          graph.entities.some(
            (entity) =>
              entity.name === hit.entityName &&
              entity.revision === hit.entityRevision &&
              (hit.kind === "entity" ||
                entity.observations.includes(hit.observation)),
          ),
        )
        .map((hit) => ({
          entityName: hit.entityName,
          observation: hit.observation,
          kind: hit.kind,
          score: hit.score,
          recordRef: hit.kind + ":" + hit.recordId + ":" + hit.entityRevision,
          ...(hit.source ? { source: hit.source } : {}),
        }));
      return { ...graph, matches, embeddingProfile: profile };
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
  const collection = db.collection("memory_vectors");
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
