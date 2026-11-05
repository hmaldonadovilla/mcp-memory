// Fault-injected driver outcomes complement real MongoDB integration: no unacknowledged write is called success.
import { afterEach, expect, it, vi } from "vitest";
import { emptySnapshot } from "../src/model.js";
import type * as MongoDb from "mongodb";
const driver = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  replaceOne: vi.fn(),
}));
vi.mock("mongodb", async (original) => ({
  ...(await original<typeof MongoDb>()),
  MongoClient: class {
    connect = driver.connect;
    close = driver.close;
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
const document = () => ({ _id: "scope", ...emptySnapshot() });
async function store() {
  driver.findOne.mockResolvedValue(document());
  return MongoGraphStore.connect("mongodb://127.0.0.1", "test", "scope");
}
it("initializes and conditionally persists only the fixed namespace", async () => {
  const db = await store();
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
