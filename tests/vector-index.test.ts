// Driver-port tests verify native ranking, scope filters, atomic projections and fail-closed behavior.
import { beforeEach, expect, it, vi } from "vitest";
import type { Db, ClientSession } from "mongodb";
import {
  MongoVectorIndex,
  prepareVectorIndex,
  vectorDefinition,
  vectorRecords,
} from "../src/vector-index.js";
import { emptySnapshot } from "../src/model.js";
import type { Snapshot } from "../src/model.js";
const profile = "a".repeat(64);
const driver = {
  list: vi.fn(),
  replace: vi.fn(),
  remove: vi.fn(),
  vectors: vi.fn(),
  graphs: vi.fn(),
  create: vi.fn(),
  unique: vi.fn(),
  command: vi.fn(),
};
const database = {
  command: driver.command,
  collection: (name: string) =>
    name === "memory_vectors"
      ? {
          listSearchIndexes: () => ({ toArray: driver.list }),
          replaceOne: driver.replace,
          deleteMany: driver.remove,
          aggregate: driver.vectors,
          createSearchIndex: driver.create,
          createIndex: driver.unique,
        }
      : { aggregate: driver.graphs },
} as unknown as Db;
const session = {} as ClientSession;
const settings = { name: "memory_semantic_v2", dimensions: 2 };
const graph: Snapshot = {
  ...emptySnapshot(),
  profile,
  revision: 1,
  entities: [
    {
      name: "A",
      entityType: "person",
      subjects: ["caller"],
      revision: 1,
      vector: [0, 1],
      facts: [
        {
          id: "b".repeat(64),
          content: "Enjoys bread",
          createdAt: "2026-01-01T00:00:00Z",
          vector: [1, 0],
          source: { source: "test" },
        },
      ],
    },
  ],
};
const publicGraph = {
  revision: 1,
  entities: [
    {
      name: "A",
      entityType: "person",
      subjects: ["caller"],
      revision: 1,
      observations: ["Enjoys bread"],
    },
  ],
  relations: [],
};
const hit = {
  kind: "fact",
  recordId: "b".repeat(64),
  entityName: "A",
  entityRevision: 1,
  observation: "Enjoys bread",
  score: 0.9,
  source: { source: "test" },
};
beforeEach(() => {
  vi.resetAllMocks();
  driver.list.mockResolvedValue([
    { queryable: true, status: "READY", latestDefinition: vectorDefinition(2) },
  ]);
  driver.graphs
    .mockReturnValueOnce({
      next: async () => ({ revision: 1, profile, hasEntities: true }),
    })
    .mockReturnValue({ next: async () => publicGraph });
  driver.vectors.mockReturnValue({ toArray: async () => [hit] });
});
it("defines ordinary identity and cosine indexes without granting server-side provisioning", async () => {
  await prepareVectorIndex(database, settings);
  expect(driver.unique).toHaveBeenCalledWith(
    { namespace: 1, kind: 1, recordId: 1 },
    { name: "memory_vector_identity", unique: true },
  );
  expect(driver.create).not.toHaveBeenCalled();
  driver.list.mockResolvedValueOnce([]);
  await prepareVectorIndex(database, settings);
  expect(driver.create).toHaveBeenCalledWith({
    name: settings.name,
    type: "vectorSearch",
    definition: vectorDefinition(2),
  });
  for (const dimensions of [0, 8193, 1.5])
    expect(() => vectorDefinition(dimensions)).toThrow();
});
it("requires READY and exact dimensions, cosine metric and filter fields", async () => {
  const index = new MongoVectorIndex(database, "scope", settings);
  await index.ready();
  for (const value of [
    [],
    [{ queryable: false, status: "BUILDING" }],
    [
      {
        queryable: true,
        status: "READY",
        latestDefinition: vectorDefinition(3),
      },
    ],
  ]) {
    driver.list.mockResolvedValueOnce(value);
    await expect(index.ready()).rejects.toHaveProperty(
      "code",
      value[0]?.queryable === true
        ? "search_index_mismatch"
        : "search_index_unavailable",
    );
  }
  driver.list.mockRejectedValueOnce(Error("private driver details"));
  await expect(index.ready()).rejects.toMatchObject({
    code: "search_index_unavailable",
  });
});

it("uses Community's bounded native command without broadening the collection identity", async () => {
  driver.command.mockResolvedValue({
    ok: 1,
    cursor: {
      id: 0,
      firstBatch: [
        {
          queryable: true,
          status: "READY",
          latestDefinition: vectorDefinition(2),
        },
      ],
    },
  });
  const selected = { ...settings, management: "command" as const };
  await new MongoVectorIndex(database, "scope", selected).ready();
  await prepareVectorIndex(database, selected);
  expect(driver.command).toHaveBeenCalledWith({
    listSearchIndexes: "memory_vectors",
    name: settings.name,
  });
  expect(driver.list).not.toHaveBeenCalled();
  driver.command.mockResolvedValueOnce({
    ok: 1,
    cursor: { id: 2, firstBatch: [] },
  });
  await expect(
    new MongoVectorIndex(database, "scope", selected).ready(),
  ).rejects.toHaveProperty("code", "search_index_unavailable");
});
it("projects entities and facts with separate stable scope IDs and no unembedded records", async () => {
  expect(vectorRecords(emptySnapshot(), "scope")).toEqual([]);
  const records = vectorRecords(graph, "scope");
  expect(records.map((r) => r.kind)).toEqual(["entity", "fact"]);
  expect(records[1]).toMatchObject({
    namespace: "scope",
    observation: "Enjoys bread",
    profile,
  });
  expect(records[0]?._id).not.toEqual(vectorRecords(graph, "other")[0]?._id);
  const legacy = structuredClone(graph);
  delete legacy.entities[0]!.vector;
  expect(() => vectorRecords(legacy, "scope")).toThrow();
  expect(vectorRecords(legacy, "scope", false)).toHaveLength(1);
  const index = new MongoVectorIndex(database, "scope", settings);
  await index.update(emptySnapshot(), graph, session);
  expect(driver.replace).toHaveBeenCalledTimes(2);
  driver.replace.mockClear();
  await index.update(graph, structuredClone(graph), session);
  expect(driver.replace).not.toHaveBeenCalled();
  await index.update(graph, emptySnapshot(), session);
  expect(driver.remove).toHaveBeenCalledWith(
    { namespace: "scope", _id: { $in: records.map((r) => r._id) } },
    { session },
  );
  const incompatible = structuredClone(graph);
  incompatible.entities[0]!.vector = [1];
  await expect(
    index.update(emptySnapshot(), incompatible, session),
  ).rejects.toMatchObject({ code: "embedding_incompatible" });
});
it("delegates top-k ranking to MongoDB with mandatory scope/profile/expiry prefilters and no vector export", async () => {
  const index = new MongoVectorIndex(database, "scope", settings);
  const result = await index.search([1, 0], profile, 5, 0.25);
  const pipeline = driver.vectors.mock.calls[0]![0];
  expect(pipeline[0].$vectorSearch).toMatchObject({
    index: settings.name,
    path: "embedding",
    queryVector: [1, 0],
    numCandidates: 100,
    limit: 5,
    filter: {
      namespace: "scope",
      profile,
      expiresAt: { $gt: expect.any(Date) },
    },
  });
  expect(pipeline[1].$match).toEqual(pipeline[0].$vectorSearch.filter);
  expect(result.matches[0]).toMatchObject({
    kind: "fact",
    score: 0.9,
    recordRef: `fact:${hit.recordId}:1`,
    source: { source: "test" },
  });
  expect(JSON.stringify(result)).not.toContain('"embedding"');
  expect(driver.graphs.mock.calls[1]![0][0]).toEqual({
    $match: { _id: "scope", revision: 1 },
  });
});
it("rejects incompatible queries, profile drift, missing migration and changed graph without falling back", async () => {
  const index = new MongoVectorIndex(database, "scope", settings);
  for (const vector of [[0, 0], [1], [Infinity, 0]])
    await expect(index.search(vector, profile, 1, 0)).rejects.toMatchObject({
      code: "embedding_incompatible",
    });
  for (const [metadata, code] of [
    [null, "reindex_required"],
    [{ revision: 1, hasEntities: true }, "reindex_required"],
    [
      { revision: 1, hasEntities: true, profile: "c".repeat(64) },
      "embedding_profile_mismatch",
    ],
  ] as const) {
    driver.graphs.mockReset().mockReturnValue({ next: async () => metadata });
    await expect(index.search([1, 0], profile, 1, 0)).rejects.toMatchObject({
      code,
    });
  }
  driver.graphs
    .mockReset()
    .mockReturnValueOnce({ next: async () => ({ revision: 1, profile }) })
    .mockReturnValueOnce({ next: async () => null });
  await expect(index.search([1, 0], profile, 1, 0)).rejects.toMatchObject({
    code: "search_snapshot_changed",
  });
  driver.graphs.mockReset().mockImplementation(() => {
    throw Error("private driver details");
  });
  await expect(index.search([1, 0], profile, 1, 0)).rejects.toMatchObject({
    code: "native_search_unavailable",
  });
});
it("returns entity matches and rejects stale fact hits after authoritative hydration", async () => {
  driver.vectors.mockReturnValue({
    toArray: async () => [
      { ...hit, kind: "entity" },
      { ...hit, entityName: "other" },
      { ...hit, observation: "deleted" },
      { ...hit, entityRevision: 2 },
    ],
  });
  const result = await new MongoVectorIndex(database, "scope", settings).search(
    [1, 0],
    profile,
    5,
    0,
  );
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]?.kind).toBe("entity");
});
it("bounds operator readiness polling and never silently rebuilds a mismatched index", async () => {
  vi.useFakeTimers();
  try {
    driver.list.mockResolvedValue([
      {
        queryable: false,
        status: "BUILDING",
        latestDefinition: vectorDefinition(2),
      },
    ]);
    const failed = expect(
      prepareVectorIndex(database, settings),
    ).rejects.toHaveProperty("code", "search_index_unavailable");
    await vi.runAllTimersAsync();
    await failed;
    driver.list.mockResolvedValue([
      {
        queryable: true,
        status: "READY",
        latestDefinition: vectorDefinition(3),
      },
    ]);
    await expect(prepareVectorIndex(database, settings)).rejects.toHaveProperty(
      "code",
      "search_index_mismatch",
    );
  } finally {
    vi.useRealTimers();
  }
});
