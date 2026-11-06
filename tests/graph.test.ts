// Exercise graph semantics, atomic failure, vector consistency and explicit retrieval budgets.
import { describe, expect, it } from "vitest";
import { MemoryGraph } from "../src/graph.js";
import {
  bounded,
  publicEntity,
  snapshotSchema,
  visible,
} from "../src/model.js";
import { person, TestEmbeddings, TestStore } from "./helpers.js";

describe("graph mutations and retrieval", () => {
  it("preserves upstream creation, observation and relation semantics without duplicate vectors", async () => {
    const store = new TestStore(),
      provider = new TestEmbeddings(),
      graph = new MemoryGraph(store, provider);
    const created = await graph.createEntities([
      {
        ...person("A"),
        observations: ["Enjoys croissants", "Enjoys croissants"],
        subjects: ["subject-1", "subject-1"],
        source: { source: "test", sourceId: "one" },
      },
      person("B", ["Writes TypeScript"]),
    ]);
    expect(created).toHaveLength(2);
    expect(provider.embed).toHaveBeenCalledOnce();
    expect(await graph.createEntities([person("A")])).toEqual([]);
    expect(provider.embed).toHaveBeenCalledOnce();
    const relation = { from: "A", to: "B", relationType: "works_with" };
    expect(await graph.createRelations([relation, relation])).toEqual([
      relation,
    ]);
    expect(await graph.createRelations([relation])).toEqual([]);
    expect(
      await graph.addObservations([
        {
          entityName: "A",
          contents: ["Enjoys croissants", "Bakes bread", "Bakes bread"],
        },
      ]),
    ).toEqual([
      {
        entityName: "A",
        addedObservations: ["Bakes bread"],
        fact_metadata: [],
      },
    ]);
    const before = store.state.revision;
    await graph.addObservations([
      { entityName: "A", contents: ["Bakes bread"] },
    ]);
    expect(store.state.revision).toBe(before);
    const semantic = await graph.semanticSearch("pastry", 2, 0.9);
    expect(semantic.matches).toContainEqual(
      expect.objectContaining({
        entityName: "A",
        score: 1,
        observation: "Enjoys croissants",
        source: { source: "test", sourceId: "one" },
      }),
    );
    expect(semantic.matches[0]?.recordRef).toMatch(/^fact:/);
    expect(semantic.relations).toEqual([]);
    expect(JSON.stringify(semantic)).not.toContain('"vector"');
    expect((await graph.semanticSearch("code", 2, -1)).matches).toHaveLength(2);
    expect(
      (await graph.lookupSubject("subject-1")).entities.map((e) => e.name),
    ).toEqual(["A"]);
    expect((await graph.lookupSubject("subject-1", 1)).entities).toHaveLength(
      1,
    );
    expect((await graph.lookupSubject("other")).entities).toEqual([]);
    expect((await graph.searchNodes("PERSON")).entities).toHaveLength(2);
    expect((await graph.searchNodes("bread", 1)).entities).toHaveLength(1);
    expect((await graph.searchNodes("no-match")).entities).toEqual([]);
    expect((await graph.openNodes(["A"])).relations).toEqual([]);
    expect((await graph.openNodes(["A", "B"])).relations).toEqual([relation]);
    expect((await graph.readGraph()).entities).toHaveLength(2);
    expect(
      await graph.deleteObservations([
        { entityName: "missing", observations: ["unknown"] },
        { entityName: "A", observations: ["Enjoys croissants"] },
      ]),
    ).toEqual({ deleted: 1 });
    expect(store.state.entities[0]?.facts.map((f) => f.content)).toEqual([
      "Bakes bread",
    ]);
    const stable = store.state.revision;
    await graph.deleteObservations([
      { entityName: "A", observations: ["unknown"] },
    ]);
    expect(store.state.revision).toBe(stable);
    expect(await graph.deleteRelations([relation])).toEqual({ deleted: 1 });
    expect(await graph.deleteRelations([relation])).toEqual({ deleted: 0 });
    await graph.createRelations([relation]);
    expect(await graph.deleteEntities(["A", "missing", "missing"])).toEqual({
      deleted: ["A"],
      notFound: ["missing"],
    });
    expect((await graph.readGraph()).relations).toEqual([]);
    expect(await graph.deleteEntities(["A"])).toEqual({
      deleted: [],
      notFound: ["A"],
    });
  });
  it("never reports success for missing targets or partially commits a failed batch", async () => {
    const store = new TestStore(),
      graph = new MemoryGraph(store);
    await graph.createEntities([person("A", [])]);
    const before = structuredClone(store.state);
    await expect(
      graph.createRelations([
        { from: "A", to: "absent", relationType: "knows" },
      ]),
    ).rejects.toMatchObject({ code: "entity_missing" });
    await expect(
      graph.addObservations([
        { entityName: "A", contents: ["new"] },
        { entityName: "absent", contents: ["new"] },
      ]),
    ).rejects.toMatchObject({ code: "entity_missing" });
    expect(store.state).toEqual(before);
  });
  it("fails explicitly on missing/incompatible embeddings and supports bounded operator reindex", async () => {
    const store = new TestStore(),
      plain = new MemoryGraph(store),
      provider = new TestEmbeddings(),
      indexed = new MemoryGraph(store, provider);
    await plain.createEntities([person("A")]);
    await expect(plain.semanticSearch("query")).rejects.toMatchObject({
      code: "embedding_not_configured",
    });
    await expect(plain.reindex(1)).rejects.toMatchObject({
      code: "embedding_not_configured",
    });
    await expect(indexed.semanticSearch("query")).rejects.toMatchObject({
      code: "reindex_required",
    });
    await expect(
      indexed.addObservations([{ entityName: "A", contents: ["new"] }]),
    ).rejects.toMatchObject({ code: "reindex_required" });
    await expect(indexed.reindex(0)).rejects.toMatchObject({
      code: "embedding_budget",
    });
    expect(await indexed.reindex(1)).toMatchObject({ indexedFacts: 1 });
    await expect(
      plain.addObservations([{ entityName: "A", contents: ["new"] }]),
    ).rejects.toMatchObject({ code: "embedding_required" });
    await expect(plain.deleteEntities(["A"])).rejects.toMatchObject({
      code: "embedding_required",
    });
    expect(store.state.entities).toHaveLength(1);
    const changed = new MemoryGraph(store, new TestEmbeddings("b".repeat(64)));
    await expect(changed.semanticSearch("query")).rejects.toMatchObject({
      code: "embedding_profile_mismatch",
    });
    await changed.reindex(1);
    expect(store.state.profile).toBe("b".repeat(64));
    provider.embed.mockResolvedValueOnce([]);
    await expect(indexed.reindex(1)).rejects.toMatchObject({
      code: "embedding_incompatible",
    });
  });
  it("keeps storage unchanged after provider failure, cancellation, conflict, invalid output or capacity errors", async () => {
    const store = new TestStore(),
      provider = new TestEmbeddings(),
      graph = new MemoryGraph(store, provider);
    provider.embed.mockRejectedValueOnce(
      new Error("synthetic-provider-failure"),
    );
    await expect(graph.createEntities([person()])).rejects.toThrow(
      "synthetic-provider-failure",
    );
    expect(store.state.entities).toEqual([]);
    await expect(
      graph.createEntities([person()], AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    provider.embed.mockResolvedValueOnce([]);
    await expect(graph.createEntities([person()])).rejects.toMatchObject({
      code: "embedding_incompatible",
    });
    await expect(
      graph.createEntities([
        person(
          "A",
          Array.from({ length: 65 }, (_, i) => "fact" + i),
        ),
      ]),
    ).rejects.toMatchObject({ code: "embedding_budget" });
    store.commit.mockRejectedValueOnce(new Error("write_conflict"));
    await expect(graph.createEntities([person()])).rejects.toThrow(
      "write_conflict",
    );
    expect(store.state.entities).toEqual([]);
    await graph.createEntities([person()]);
    provider.embed.mockResolvedValueOnce([]);
    await expect(graph.semanticSearch("query")).rejects.toMatchObject({
      code: "embedding_incompatible",
    });
    await expect(graph.reindex(1, AbortSignal.abort())).rejects.toMatchObject({
      code: "cancelled",
    });
  });
  it("embeds reindex batches in bounded groups, preserving all facts until successful settlement", async () => {
    const store = new TestStore(),
      plain = new MemoryGraph(store);
    await plain.createEntities([
      person(
        "A",
        Array.from({ length: 63 }, (_, i) => "fact" + i),
      ),
    ]);
    await plain.addObservations([
      { entityName: "A", contents: ["last", "last-two"] },
    ]);
    const provider = new TestEmbeddings(),
      graph = new MemoryGraph(store, provider);
    await graph.reindex(65);
    expect(provider.embed.mock.calls.map((c) => c[0].length)).toEqual([64, 2]);
    const empty = new MemoryGraph(new TestStore(), provider);
    expect((await empty.semanticSearch("query")).matches).toEqual([]);
    expect(await empty.reindex(0)).toMatchObject({ indexedFacts: 0 });
  });
  it("excludes expired facts from literal and semantic retrieval without deleting retained provenance", async () => {
    const store = new TestStore(),
      provider = new TestEmbeddings(),
      graph = new MemoryGraph(store, provider);
    await graph.createEntities([
      {
        ...person("A", ["expired croissant"]),
        source: { source: "test", validUntil: "2000-01-01T00:00:00Z" },
      },
      {
        ...person("B", ["current bread"]),
        source: { source: "test", validUntil: "2099-01-01T00:00:00Z" },
      },
    ]);
    expect((await graph.semanticSearch("pastry")).matches).toHaveLength(1);
    expect((await graph.searchNodes("expired")).entities).toEqual([]);
    expect((await graph.openNodes(["A"])).entities[0]?.observations).toEqual(
      [],
    );
    expect(store.state.entities[0]?.facts).toHaveLength(1);
    expect(publicEntity(store.state.entities[1]!).observations).toEqual([
      "current bread",
    ]);
    expect(visible(store.state.entities[0]!.facts[0]!, 0)).toBe(true);
  });
  it("rejects inconsistent vectors and oversized output rather than silently truncating", () => {
    expect(() => bounded("x".repeat(262145))).toThrow();
    expect(bounded({ ok: true })).toEqual({ ok: true });
    expect(() => snapshotSchema.parse({ schemaVersion: 2 })).toThrow();
  });
});

it("bounds the enriched write result before embedding or committing any facts", async () => {
  const store = new TestStore(),
    provider = new TestEmbeddings(),
    graph = new MemoryGraph(store, provider);
  await expect(
    graph.createEntities([
      person(
        "A",
        Array.from({ length: 40 }, (_, i) => String(i) + "x".repeat(4090)),
      ),
    ]),
  ).rejects.toHaveProperty("code", "result_limit");
  expect(provider.embed).not.toHaveBeenCalled();
  expect(store.state.revision).toBe(0);
});
