// Fault-injected driver outcomes complement real MongoDB integration: no unacknowledged write is called success.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptySnapshot } from "../src/model.js";
import type * as MongoDb from "mongodb";
import { MongoServerError } from "mongodb";
const driver = vi.hoisted(() => ({
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
          findOne: driver.findOne,
          updateOne: driver.updateOne,
          replaceOne: driver.replaceOne,
        }),
      };
    }
  },
}));
import { MongoGraphStore } from "../src/store.js";
afterEach(() => vi.resetAllMocks());
beforeEach(() => {
  driver.abort.mockResolvedValue(undefined);
  driver.commit.mockResolvedValue(undefined);
  driver.end.mockResolvedValue(undefined);
});
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
    { _id: "scope" },
    { $setOnInsert: emptySnapshot() },
    expect.objectContaining({ upsert: true }),
  );
  expect(await db.load()).toEqual(emptySnapshot());
  driver.replaceOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  await db.commit(0, { ...emptySnapshot(), revision: 1 });
  expect(driver.replaceOne.mock.calls[0]?.[0]).toEqual({
    _id: "scope",
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
      facts: [
        {
          id: "a".repeat(64),
          content: "test",
          createdAt: "2026-01-01T00:00:00Z",
          vector: Array.from({ length: 4096 }, () => 1),
        },
      ],
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
  expect(driver.findOne).toHaveBeenCalledExactlyOnceWith(
    { _id: "scope" },
    { projection: { _id: 0, schemaVersion: 1, revision: 1, profile: 1 } },
  );
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
