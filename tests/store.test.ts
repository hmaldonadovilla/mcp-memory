// Fault-injected driver outcomes complement real MongoDB integration: no unacknowledged write is called success.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptySnapshot } from "../src/model.js";
import type * as MongoDb from "mongodb";
import { MongoServerError } from "mongodb";
const driver = vi.hoisted(() => ({
  view: vi.fn(),
  teams: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  replaceOne: vi.fn(),
  ready: vi.fn(),
  update: vi.fn(),
  search: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  commit: vi.fn(),
  abort: vi.fn(),
  end: vi.fn(),
}));
vi.mock("../src/directory.js", () => ({ activeTeams: driver.teams }));
vi.mock("../src/vector-index.js", () => ({
  MongoVectorIndex: class {
    ready = driver.ready;
    update = driver.update;
    search = driver.search;
  },
  prepareVectorIndex: driver.prepare,
}));
vi.mock("mongodb", async (original) => ({
  ...(await original<typeof MongoDb>()),
  MongoClient: class {
    connect = driver.connect;
    close = driver.close;
    startSession() {
      return {
        startTransaction: driver.start,
        commitTransaction: driver.commit,
        abortTransaction: driver.abort,
        endSession: driver.end,
      };
    }
    db() {
      return {
        collection: () => ({
          aggregate: () => ({ toArray: driver.view }),
          findOne: driver.findOne,
          updateOne: driver.updateOne,
          replaceOne: driver.replaceOne,
        }),
      };
    }
  },
}));
import { actor } from "../src/access.js";
import { graphBoundary } from "../src/visibility.js";
import { MongoGraphStore } from "../src/store.js";
afterEach(() => vi.resetAllMocks());
beforeEach(() => {
  driver.teams.mockResolvedValue([]);
  driver.abort.mockResolvedValue(undefined);
  driver.commit.mockResolvedValue(undefined);
  driver.end.mockResolvedValue(undefined);
});
const boundary = {
  _id: "scope",
  ...graphBoundary(actor("scope")),
  owner_user_id: actor("scope").user_id,
};
const document = () => ({ _id: "scope", ...emptySnapshot() });
async function store() {
  driver.findOne.mockResolvedValue(document());
  return MongoGraphStore.connect("mongodb://127.0.0.1", "test", "scope");
}
it("initializes and conditionally persists only the fixed namespace", async () => {
  const db = await store();
  await expect(
    db.commit(0, { ...emptySnapshot(), revision: 1, profile: "a".repeat(64) }),
  ).rejects.toHaveProperty("code", "native_search_required");
  expect(driver.updateOne).toHaveBeenCalledWith(
    boundary,
    { $setOnInsert: emptySnapshot() },
    expect.objectContaining({ upsert: true }),
  );
  expect(await db.load()).toEqual(emptySnapshot());
  driver.replaceOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  await db.commit(0, { ...emptySnapshot(), revision: 1 });
  expect(driver.replaceOne.mock.calls[0]?.[0]).toEqual({
    ...boundary,
    revision: 0,
  });
  await db.close();
  expect(driver.close).toHaveBeenCalledOnce();
});
it("supports an explicit database CA and refuses unavailable or corrupt persisted state", async () => {
  driver.findOne.mockResolvedValue(document());
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "scope",
    "/mounted/ca",
  );
  for (const value of [null, { _id: "scope", schemaVersion: 2 }]) {
    driver.findOne.mockResolvedValueOnce(value);
    await expect(db.load()).rejects.toMatchObject({
      code: "persistence_unavailable",
    });
  }
  driver.findOne.mockRejectedValueOnce(new Error("synthetic private details"));
  await expect(db.load()).rejects.toMatchObject({
    code: "persistence_unavailable",
  });
  driver.connect.mockRejectedValueOnce(new Error("synthetic credentials"));
  await expect(store()).rejects.toMatchObject({
    code: "persistence_unavailable",
  });
  expect(driver.close).toHaveBeenCalledOnce();
});
it("distinguishes conflicts from unknown write outcomes and enforces storage/revision limits", async () => {
  const db = await store(),
    next = { ...emptySnapshot(), revision: 1 };
  await expect(db.commit(0, emptySnapshot())).rejects.toMatchObject({
    code: "invalid_revision",
  });
  for (const result of [
    { acknowledged: false, matchedCount: 0 },
    { acknowledged: true, matchedCount: 0 },
  ]) {
    driver.replaceOne.mockResolvedValueOnce(result);
    await expect(db.commit(0, next)).rejects.toMatchObject({
      code: "write_conflict",
    });
  }
  driver.replaceOne.mockRejectedValueOnce(
    new Error("server timeout with private text"),
  );
  await expect(db.commit(0, next)).rejects.toMatchObject({
    code: "write_outcome_unknown",
  });
  const oversized = {
    ...next,
    entities: Array.from({ length: 500 }, (_, i) => ({
      name: "entity" + i,
      entityType: "test",
      subjects: [],
      revision: 1,
      facts: Array.from({ length: 10 }, (_, j) => ({
        id: "a".repeat(64),
        content: String(j) + "x".repeat(4090),
        createdAt: "2026-01-01T00:00:00Z",
        vector: Array.from({ length: 4096 }, () => 1),
      })),
    })),
  };
  await expect(db.commit(0, oversized)).rejects.toMatchObject({
    code: "graph_limit",
  });
});
it("commits the graph and native vector projection in one transaction and delegates queries", async () => {
  driver.findOne.mockResolvedValue(document());
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "scope",
    undefined,
    { name: "native", dimensions: 2 },
  );
  driver.replaceOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  const previous = emptySnapshot(),
    next = { ...previous, revision: 1 };
  await db.commit(0, next, previous);
  expect(driver.update).toHaveBeenCalledWith(
    previous,
    next,
    expect.any(Object),
  );
  expect(driver.commit).toHaveBeenCalledOnce();
  expect(driver.abort).not.toHaveBeenCalled();
  expect(driver.end).toHaveBeenCalledOnce();
  await db.search!([1, 0], "a".repeat(64), 3, 0.25);
  expect(driver.search).toHaveBeenCalledWith(
    [1, 0],
    "a".repeat(64),
    3,
    0.25,
    undefined,
  );
  await expect(
    (await store()).search!([1, 0], "a".repeat(64), 3, 0),
  ).rejects.toHaveProperty("code", "native_search_required");
});
it("starts semantic sessions with bounded metadata and validates graph contents only when requested", async () => {
  driver.findOne.mockResolvedValueOnce({
    schemaVersion: 1,
    revision: 3,
    profile: "a".repeat(64),
  });
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "scope",
    undefined,
    { name: "native", dimensions: 2 },
  );
  await db.search!([1, 0], "a".repeat(64), 1, 0);
  expect(driver.findOne).toHaveBeenCalledExactlyOnceWith(boundary, {
    projection: { _id: 0, schemaVersion: 1, revision: 1, profile: 1 },
  });
  driver.findOne.mockResolvedValueOnce({
    _id: "scope",
    schemaVersion: 1,
    revision: 3,
    entities: "corrupt",
  });
  await expect(db.load()).rejects.toHaveProperty(
    "code",
    "persistence_unavailable",
  );
  driver.findOne.mockResolvedValueOnce({ schemaVersion: 2, revision: 3 });
  await expect(
    MongoGraphStore.connect("mongodb://127.0.0.1", "test", "scope"),
  ).rejects.toHaveProperty("code", "persistence_unavailable");
});
it("aborts precommit failures but preserves an unknown commit without retrying", async () => {
  driver.findOne.mockResolvedValue(document());
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "scope",
    undefined,
    { name: "native", dimensions: 2 },
  );
  driver.replaceOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  const previous = emptySnapshot(),
    next = { ...previous, revision: 1 };
  await expect(db.commit(0, next)).rejects.toHaveProperty(
    "code",
    "invalid_revision",
  );
  driver.abort.mockRejectedValueOnce(Error("abort lost"));
  driver.update.mockRejectedValueOnce(Error("transaction write failed"));
  await expect(db.commit(0, next, previous)).rejects.toHaveProperty(
    "code",
    "write_outcome_unknown",
  );
  driver.abort.mockClear();
  driver.replaceOne.mockRejectedValueOnce(
    new MongoServerError({ code: 112, message: "transaction conflict" }),
  );
  await expect(db.commit(0, next, previous)).rejects.toHaveProperty(
    "code",
    "write_conflict",
  );
  driver.abort.mockClear();
  driver.commit.mockRejectedValueOnce(Error("commit acknowledgement lost"));
  await expect(db.commit(0, next, previous)).rejects.toHaveProperty(
    "code",
    "write_outcome_unknown",
  );
  expect(driver.abort).not.toHaveBeenCalled();
  expect(driver.commit).toHaveBeenCalledOnce();
});
it("fails closed on an unavailable native index and always closes operator connections", async () => {
  const { MemoryError } = await import("../src/model.js");
  driver.ready.mockRejectedValueOnce(
    new MemoryError("search_index_unavailable", "not ready"),
  );
  await expect(
    MongoGraphStore.connect("mongodb://127.0.0.1", "test", "scope", undefined, {
      name: "native",
      dimensions: 2,
    }),
  ).rejects.toHaveProperty("code", "search_index_unavailable");
  await MongoGraphStore.prepare("mongodb://127.0.0.1", "test", {
    name: "native",
    dimensions: 2,
  });
  driver.prepare.mockRejectedValueOnce(Error("index operation failed"));
  await expect(
    MongoGraphStore.prepare(
      "mongodb://127.0.0.1",
      "test",
      { name: "native", dimensions: 2 },
      "/mounted/ca",
    ),
  ).rejects.toThrow("index operation failed");
  expect(driver.close).toHaveBeenCalledTimes(3);
});

it("denies discovery data access while allowing schema discovery startup without creating a graph", async () => {
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "realm",
    undefined,
    undefined,
    { mode: "discovery" },
  );
  expect(driver.updateOne).not.toHaveBeenCalled();
  expect(() => db.authorize!()).toThrow("Discovery");
  for (const work of [
    () => db.load(),
    () => db.view!(),
    () => db.teams!(),
    () => db.commit(0, { ...emptySnapshot(), revision: 1 }),
    () => db.search!([1, 0], "a".repeat(64), 1, 0),
  ])
    await expect(work()).rejects.toHaveProperty("code", "identity_required");
  await expect(
    db.setPermissions!({
      fact_refs: ["fact:" + "a".repeat(64) + ":" + "b".repeat(64)],
      visibility: "user",
      team_ids: [],
    }),
  ).rejects.toHaveProperty("code", "identity_required");
  const realm = await store();
  await expect(
    realm.setPermissions!({
      fact_refs: ["fact:" + "a".repeat(64) + ":" + "b".repeat(64)],
      visibility: "global",
      team_ids: [],
    }),
  ).rejects.toHaveProperty("code", "identity_required");
});
it("projects authorized graphs without vectors and refuses membership drift, corrupt or excessive results", async () => {
  const context = {
    mode: "user" as const,
    tenant_id: "tenant",
    user_id: "owner",
    conversation_id: "conversation:1",
    task_id: "task:1",
    scope_ref: "scope",
  };
  driver.findOne.mockResolvedValue(document());
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "realm",
    undefined,
    undefined,
    context,
    "identity",
  );
  const who = actor("realm", context);
  driver.teams.mockResolvedValue([{ team_id: "team:1", name: "one" }]);
  driver.view.mockResolvedValue([{ _id: who.namespace, ...emptySnapshot() }]);
  expect(await db.view!()).toEqual(emptySnapshot());
  driver.view.mockResolvedValueOnce([]);
  expect((await db.view!()).revision).toBe(0);
  driver.view.mockResolvedValueOnce(
    Array.from({ length: 101 }, () => ({
      _id: who.namespace,
      ...emptySnapshot(),
    })),
  );
  await expect(db.view!()).rejects.toHaveProperty("code", "result_limit");
  driver.teams.mockResolvedValueOnce([]);
  await expect(db.view!()).rejects.toHaveProperty(
    "code",
    "authorization_changed",
  );
  driver.view.mockRejectedValueOnce(Error("private driver details"));
  await expect(db.view!()).rejects.toHaveProperty(
    "code",
    "persistence_unavailable",
  );
  const legacy = {
    _id: who.namespace,
    ...emptySnapshot(),
    entities: [
      {
        name: "A",
        entityType: "test",
        subjects: [],
        revision: 1,
        facts: [
          {
            id: "a".repeat(64),
            content: "legacy",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ],
  };
  driver.findOne.mockResolvedValueOnce(legacy);
  await expect(db.load()).rejects.toHaveProperty("code", "migration_required");
});
it("changes only owned fact ACLs with fresh references, validates selected teams and preserves embeddings", async () => {
  const { bindState, withoutVectors, readState } =
    await import("../src/state.js");
  const context = {
    mode: "user" as const,
    tenant_id: "tenant",
    user_id: "owner",
    conversation_id: "conversation:1",
    task_id: "task:1",
    scope_ref: "scope",
  };
  const who = actor("realm", context);
  const bound = bindState(
    {
      ...emptySnapshot(),
      revision: 1,
      entities: ["A", "B"].map((name) => ({
        name,
        entityType: "test",
        subjects: [],
        revision: 1,
        facts: [
          {
            id: (name === "A" ? "a" : "b").repeat(64),
            content: name,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      })),
    },
    undefined,
    who,
  );
  const persisted = { _id: who.namespace, ...withoutVectors(bound) };
  driver.findOne.mockResolvedValue(persisted);
  driver.teams.mockResolvedValue([{ team_id: "team:1", name: "one" }]);
  const db = await MongoGraphStore.connect(
    "mongodb://127.0.0.1",
    "test",
    "realm",
    undefined,
    { name: "native", dimensions: 2 },
    context,
  );
  const ref = readState(persisted).entities[0]!.facts[0]!.ref!;
  for (const change of [
    { visibility: "team" as const, team_ids: [] },
    { visibility: "global" as const, team_ids: ["team:1"] },
    { visibility: "user" as const, team_ids: ["team:1"] },
  ])
    await expect(
      db.setPermissions!({ fact_refs: [ref], ...change }),
    ).rejects.toHaveProperty("code", "invalid_permissions");
  await expect(
    db.setPermissions!({
      fact_refs: [ref],
      visibility: "team",
      team_ids: ["foreign"],
    }),
  ).rejects.toHaveProperty("code", "permission_denied");
  await expect(
    db.setPermissions!({
      fact_refs: ["fact:" + "c".repeat(64) + ":" + "d".repeat(64)],
      visibility: "global",
      team_ids: [],
    }),
  ).rejects.toHaveProperty("code", "permission_denied");
  driver.replaceOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  expect(
    await db.setPermissions!({
      fact_refs: [ref],
      visibility: "team",
      team_ids: ["team:1", "team:1"],
    }),
  ).toMatchObject({
    changed: 1,
    visibility: "team",
    team_ids: ["team:1"],
    revision: 2,
  });
  const stored = driver.replaceOne.mock.calls[0]![1];
  expect(stored.entities[0].facts[0].permissions).toMatchObject({
    creator_user_id: "owner",
    source_conversation_id: "conversation:1",
    visibility: "team",
    revision: 2,
  });
  expect(stored.entities[1].revision).toBe(1);
  expect(JSON.stringify(stored)).not.toContain('"vector"');
  expect(driver.commit).toHaveBeenCalledOnce();
});
