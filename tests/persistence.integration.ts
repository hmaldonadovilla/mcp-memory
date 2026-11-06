// Real MongoDB proves restart durability, namespace isolation, optimistic concurrency and atomic deletion.
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, afterEach, expect, it } from "vitest";
import { MemoryGraph } from "../src/graph.js";
import { MongoGraphStore } from "../src/store.js";
import type { GraphStore } from "../src/model.js";
import { person, TestEmbeddings } from "./helpers.js";
import { indexed } from "./native-fixtures.js";
const uri = process.env.MEMORY_TEST_MONGODB_URI;
if (
  !uri ||
  !/^mongodb:\/\/127\.0\.0\.1:\d+\/(?:\?directConnection=true)?$/.test(uri)
)
  throw new Error("Use the required isolated integration runner");
const stores: GraphStore[] = [],
  namespaces: string[] = [];
async function open(namespace = "integration-" + randomUUID()) {
  namespaces.push(namespace);
  const store = await MongoGraphStore.connect(
    uri!,
    "mcp_memory_tests",
    namespace,
    undefined,
    { name: "memory_semantic_v3", dimensions: 2, management: "command" },
  );
  stores.push(store);
  return { store, namespace };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
afterAll(async () => {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    await client
      .db("mcp_memory_tests")
      .collection<{ _id: string }>("memory_graphs")
      .deleteMany({ _id: { $in: namespaces } });
  } finally {
    await client.close();
  }
});
it("retains facts, vectors, provenance and relations across a new connection", async () => {
  const first = await open();
  const provider = new TestEmbeddings(),
    graph = new MemoryGraph(first.store, provider);
  await graph.createEntities([
    {
      ...person("A"),
      subjects: ["subject"],
      source: { source: "synthetic", sourceId: "original" },
    },
    person("B", ["Writes code"]),
  ]);
  await graph.createRelations([{ from: "A", to: "B", relationType: "knows" }]);
  await first.store.close();
  const again = await open(first.namespace),
    restored = new MemoryGraph(again.store, provider);
  expect((await restored.readGraph()).relations).toHaveLength(1);
  expect((await restored.lookupSubject("subject")).entities[0]?.name).toBe("A");
  await indexed(uri!, first.namespace, "Enjoys croissants");
  const found = await restored.semanticSearch("pastry", 1, 0.9);
  expect(found.matches[0]).toMatchObject({
    entityName: "A",
    source: { source: "synthetic", sourceId: "original" },
  });
  expect(JSON.stringify(found)).not.toContain('"vector"');
  const foreign = await open();
  expect(
    (
      await new MemoryGraph(foreign.store, provider).semanticSearch(
        "pastry",
        5,
        0.9,
      )
    ).matches,
  ).toEqual([]);
  await restored.deleteObservations([
    { entityName: "A", observations: ["Enjoys croissants"] },
  ]);
  expect((await restored.semanticSearch("pastry", 10, 0.9)).matches).toEqual(
    [],
  );
  await restored.deleteEntities(["A"]);
  expect((await restored.readGraph()).relations).toEqual([]);
});
it("does not lose a concurrent write or cross namespace boundaries", async () => {
  const first = await open(),
    same = await open(first.namespace),
    other = await open();
  const a = await first.store.load(),
    b = await same.store.load();
  a.revision++;
  a.entities = [
    { name: "A", entityType: "test", subjects: [], revision: 1, facts: [] },
  ];
  b.revision++;
  b.entities = [
    { name: "B", entityType: "test", subjects: [], revision: 1, facts: [] },
  ];
  const outcomes = await Promise.allSettled([
    first.store.commit(0, a, { ...a, revision: 0, entities: [] }),
    same.store.commit(0, b, { ...b, revision: 0, entities: [] }),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  const failure = outcomes.find((o) => o.status === "rejected");
  expect(failure?.status === "rejected" && failure.reason.code).toBe(
    "write_conflict",
  );
  expect((await first.store.load()).entities).toHaveLength(1);
  expect((await other.store.load()).entities).toEqual([]);
});
it("does not persist a failed embedding operation or partially apply a failed relation batch", async () => {
  const { store } = await open(),
    provider = new TestEmbeddings(),
    graph = new MemoryGraph(store, provider);
  provider.embed.mockRejectedValueOnce(
    new Error("synthetic embedding failure"),
  );
  await expect(graph.createEntities([person()])).rejects.toThrow();
  expect((await store.load()).revision).toBe(0);
  await graph.createEntities([person("A"), person("B")]);
  await expect(
    graph.createRelations([
      { from: "A", to: "B", relationType: "knows" },
      { from: "B", to: "absent", relationType: "knows" },
    ]),
  ).rejects.toMatchObject({ code: "entity_missing" });
  expect((await store.load()).relations).toEqual([]);
});

it("rolls back graph changes when a native vector projection is incompatible", async () => {
  const { store, namespace } = await open();
  const provider = new TestEmbeddings();
  provider.embed.mockImplementationOnce(async (inputs) =>
    inputs.map(() => [1]),
  );
  await expect(
    new MemoryGraph(store, provider).createEntities([person()]),
  ).rejects.toMatchObject({ code: "embedding_incompatible" });
  expect((await store.load()).revision).toBe(0);
  const client = new MongoClient(uri);
  try {
    await client.connect();
    expect(
      await client
        .db("mcp_memory_tests")
        .collection("memory_index")
        .countDocuments({ namespace }),
    ).toBe(0);
  } finally {
    await client.close();
  }
});
it("native search excludes expired facts while retaining their original graph evidence", async () => {
  const { store, namespace } = await open();
  const graph = new MemoryGraph(store, new TestEmbeddings());
  await graph.createEntities([
    {
      ...person("Expired", ["Expired croissant fact"]),
      source: { source: "synthetic", validUntil: "2000-01-01T00:00:00Z" },
    },
    person("Current", ["Current bread fact"]),
  ]);
  await indexed(uri!, namespace, "Current bread fact");
  const result = await graph.semanticSearch("pastry", 10, 0.9);
  expect(result.matches.map((m) => m.entityName)).toEqual(["Current"]);
  expect(
    (await store.load()).entities.find((e) => e.name === "Expired")?.facts,
  ).toHaveLength(1);
});

it("treats entity names beginning with dollar signs as literal data during database hydration", async () => {
  const { store, namespace } = await open();
  const graph = new MemoryGraph(store, new TestEmbeddings());
  await graph.createEntities([person("$Baker", ["Enjoys bread"])]);
  await indexed(uri!, namespace, "Enjoys bread");
  expect((await graph.semanticSearch("pastry", 1, 0.9)).entities[0]?.name).toBe(
    "$Baker",
  );
});
