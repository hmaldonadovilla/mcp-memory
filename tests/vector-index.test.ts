// Driver-port tests verify native ranking, scope filters, atomic projections and fail-closed behavior.
import { beforeEach, expect, it, vi } from "vitest";
import type { Db, ClientSession } from "mongodb";
import {
  MongoVectorIndex,
  prepareVectorIndex,
  vectorDefinition,
  vectorRecords,
} from "../src/vector-index.js";
import { actor } from "../src/access.js";
import { graphBoundary } from "../src/visibility.js";
import { bindState, readState } from "../src/state.js";
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
    name === "memory_index"
      ? {
          listSearchIndexes: () => ({ toArray: driver.list }),
          updateOne: driver.replace,
          deleteMany: driver.remove,
          aggregate: driver.vectors,
          createSearchIndex: driver.create,
          createIndex: driver.unique,
        }
      : { aggregate: driver.graphs },
} as unknown as Db;
const session = {} as ClientSession;
const settings = { name: "memory_semantic_v3", dimensions: 2 };
const graph: Snapshot = bindState(
  {
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
  },
  undefined,
  actor("scope"),
);
const publicGraph = { _id: "scope", ...graph };
const hit = {
  namespace: "scope",
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
    .mockReturnValue({ toArray: async () => [publicGraph] });
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
    listSearchIndexes: "memory_index",
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
    profile,
  });
  expect(records[0]?._id).not.toEqual(vectorRecords(graph, "other")[0]?._id);
  const legacy = structuredClone(graph);
  delete legacy.entities[0]!.vector;
  expect(() => vectorRecords(legacy, "scope")).toThrow();
  expect(vectorRecords(legacy, "scope", false)).toHaveLength(2);
  const index = new MongoVectorIndex(database, "scope", settings);
  await index.update(emptySnapshot(), graph, session);
  expect(driver.replace).toHaveBeenCalledTimes(2);
  driver.replace.mockClear();
  const unchanged = structuredClone(graph);
  for (const entity of unchanged.entities) {
    delete entity.vector;
    for (const fact of entity.facts) delete fact.vector;
  }
  await index.update(unchanged, structuredClone(unchanged), session);
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
      realm: "scope",
      tenant_id: actor("scope").tenant_id,
      scope_ref: "scope",
      profile,
      expiresAt: { $gt: expect.any(Date) },
    },
  });
  expect(pipeline[1].$match).toEqual(pipeline[0].$vectorSearch.filter);
  expect(result.matches[0]).toMatchObject({
    kind: "fact",
    score: 0.9,
    recordRef: readState(publicGraph).entities[0]!.facts[0]!.ref,
    source: { source: "test" },
  });
  expect(JSON.stringify(result)).not.toContain('"embedding"');
  expect(driver.graphs.mock.calls[1]![0][0]).toEqual({
    $match: { ...graphBoundary(actor("scope")), _id: { $in: ["scope"] } },
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
    .mockReturnValueOnce({ toArray: async () => [] });
  expect((await index.search([1, 0], profile, 1, 0)).matches).toEqual([]);
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
      { ...hit, recordId: "c".repeat(64) },
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

it("retains unchanged canonical embeddings, rejects missing vectors, and updates only metadata for ACL changes", async () => {
  const index = new MongoVectorIndex(database, "scope", settings);
  const noVectors = structuredClone(graph);
  for (const entity of noVectors.entities) {
    delete entity.vector;
    for (const fact of entity.facts) delete fact.vector;
  }
  await expect(
    index.update(emptySnapshot(), noVectors, session),
  ).rejects.toHaveProperty("code", "reindex_required");
  const shared = structuredClone(noVectors);
  shared.entities[0]!.revision++;
  shared.entities[0]!.facts[0]!.permissions!.visibility = "global";
  driver.replace.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(index.update(noVectors, shared, session)).rejects.toHaveProperty(
    "code",
    "reindex_required",
  );
  driver.replace.mockResolvedValue({ matchedCount: 1 });
  await index.update(noVectors, shared, session);
  expect(driver.replace.mock.calls.at(-1)?.[1].$set).toMatchObject({
    visibility: "global",
  });
  expect(driver.replace.mock.calls.at(-1)?.[1].$set).not.toHaveProperty(
    "embedding",
  );
});
it("hydrates only current authorized evidence, keeps relation endpoints bounded and preserves native score order", async () => {
  const other = structuredClone(publicGraph);
  other.entities.push({ ...structuredClone(graph.entities[0]!), name: "B" });
  other.relations = [
    { from: "A", to: "B", relationType: "knows" },
    { from: "A", to: "C", relationType: "hidden" },
  ];
  const drifted = {
    ...structuredClone(publicGraph),
    _id: "drifted",
    profile: "b".repeat(64),
  };
  const foreign = { ...structuredClone(publicGraph), _id: "foreign" };
  driver.graphs
    .mockReset()
    .mockReturnValueOnce({
      next: async () => ({ revision: 1, profile, hasEntities: true }),
    })
    .mockReturnValue({ toArray: async () => [other, drifted, foreign] });
  driver.vectors.mockReturnValue({
    toArray: async () => [
      { ...hit, score: 0.5 },
      { ...hit, entityName: "B", score: 0.9 },
      { ...hit, namespace: "foreign", kind: "entity" },
    ],
  });
  const result = await new MongoVectorIndex(database, "scope", settings).search(
    [1, 0],
    profile,
    5,
    0,
  );
  expect(result.matches.map((match) => match.score)).toEqual([0.9, 0.5]);
  expect(result.relations).toHaveLength(1);
  expect(result.entities).toHaveLength(2);
});

it("withholds retrieved evidence when fresh team membership changes during native hydration", async () => {
  const directory = await import("../src/directory.js");
  const memberships = vi
    .spyOn(directory, "activeTeams")
    .mockResolvedValueOnce([{ team_id: "team:1", name: "one" }])
    .mockResolvedValueOnce([{ team_id: "team:2", name: "two" }]);
  try {
    await expect(
      new MongoVectorIndex(database, "scope", settings).search(
        [1, 0],
        profile,
        5,
        0,
      ),
    ).rejects.toHaveProperty("code", "authorization_changed");
  } finally {
    memberships.mockRestore();
  }
});
