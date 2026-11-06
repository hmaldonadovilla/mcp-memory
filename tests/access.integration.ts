// Real native search and MCP clients prove user/team/global isolation and single-copy embedding persistence.
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, it } from "vitest";
import { actor } from "../src/access.js";
import type { CallerContext } from "../src/access.js";
import { MemoryGraph } from "../src/graph.js";
import { createMemoryServer, RESOURCE_URI } from "../src/server.js";
import { MongoGraphStore } from "../src/store.js";
import { TestEmbeddings } from "./helpers.js";
import { indexed } from "./native-fixtures.js";
const uri = process.env.MEMORY_TEST_MONGODB_URI;
if (
  !uri ||
  !/^mongodb:\/\/127\.0\.0\.1:\d+\/(?:\?directConnection=true)?$/.test(uri)
)
  throw Error("Use the isolated integration runner");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const caller = (
  user = "owner",
  tenant = "tenant",
  scope = "scope",
): CallerContext => ({
  mode: "user",
  tenant_id: tenant,
  user_id: user,
  conversation_id: "conversation:" + randomUUID(),
  task_id: "task:" + randomUUID(),
  scope_ref: scope,
});
async function fixture() {
  const dbClient = new MongoClient(uri!);
  await dbClient.connect();
  cleanup.push(() => dbClient.close());
  const db = dbClient.db("mcp_memory_tests"),
    realm = "acl:" + randomUUID();
  async function open(context: CallerContext) {
    const store = await MongoGraphStore.connect(
      uri!,
      "mcp_memory_tests",
      realm,
      undefined,
      { name: "memory_semantic_v3", dimensions: 2 },
      context,
    );
    cleanup.push(() => store.close());
    const provider = new TestEmbeddings(),
      graph = new MemoryGraph(store, provider);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMemoryServer(graph), {
      transport: serverSide,
    });
    const client = new Client({ name: "acl-test", version: "1.0.0" });
    await client.connect(clientSide);
    cleanup.push(async () => {
      await client.close();
      await handle.close();
    });
    async function call(name: string, args: Record<string, unknown> = {}) {
      const response = await client.callTool({ name, arguments: args });
      const text =
        "content" in response && Array.isArray(response.content)
          ? response.content[0]
          : undefined;
      if (!text || text.type !== "text")
        throw Error("Expected MCP text result");
      return {
        error: response.isError === true,
        data:
          text.text.startsWith("{") || text.text.startsWith("[")
            ? (JSON.parse(text.text) as Record<string, unknown>)
            : { message: text.text },
      };
    }
    return { store, provider, graph, client, call };
  }
  return { db, realm, open };
}
it("defaults facts to the verified creator across conversations and stores every vector only once", async () => {
  const f = await fixture(),
    context = caller(),
    own = await f.open(context);
  expect(
    (
      await own.call("create_entities", {
        entities: [
          {
            name: "A",
            entityType: "test",
            observations: ["private bread preference"],
            subjects: ["private-subject"],
          },
        ],
      })
    ).error,
  ).toBe(false);
  const same = await f.open(caller()),
    stranger = await f.open(caller("stranger"));
  expect((await same.graph.readGraph()).entities[0]?.observations).toEqual([
    "private bread preference",
  ]);
  expect((await stranger.graph.readGraph()).entities).toEqual([]);
  const stored = await f.db
    .collection<{ _id: string }>("memory_graphs")
    .findOne({ _id: actor(f.realm, context).namespace });
  expect(JSON.stringify(stored)).not.toMatch(/"vector"|"embedding"/);
  const state = await own.store.load(),
    fact = state.entities[0]!.facts[0]!;
  expect(fact.permissions).toMatchObject({
    creator_user_id: "owner",
    source_conversation_id:
      context.mode === "user" ? context.conversation_id : "",
    visibility: "user",
    team_ids: [],
  });
  const rows = await f.db
    .collection("memory_index")
    .find({ realm: f.realm })
    .toArray();
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row) =>
        Array.isArray(row.embedding) &&
        !("observation" in row) &&
        !("source" in row),
    ),
  ).toBe(true);
  const added = await own.graph.addObservations([
    { entityName: "A", contents: ["second private fact"] },
  ]);
  expect(added[0]?.fact_metadata[0]?.ref).toMatch(/^fact:/);
  expect(own.provider.embed).toHaveBeenCalledTimes(2);
  expect(own.provider.embed.mock.calls[1]?.[0]).toHaveLength(1);
  expect(
    await f.db.collection("memory_index").countDocuments({ realm: f.realm }),
  ).toBe(3);
  await expect(
    own.graph.setMemoryPermissions({
      fact_refs: [fact.ref!],
      visibility: "team",
      team_ids: ["not-a-member"],
    }),
  ).rejects.toHaveProperty("code", "permission_denied");
  expect((await stranger.graph.searchNodes("preference")).entities).toEqual([]);
  expect((await stranger.graph.openNodes(["A"])).entities).toEqual([]);
  expect(
    (await stranger.graph.lookupSubject("private-subject")).entities,
  ).toEqual([]);
  const resource = await stranger.client.readResource({ uri: RESOURCE_URI });
  expect(JSON.stringify(resource)).not.toContain("private bread");
});
it("shares selected facts with chosen teams, refreshes memberships, and blocks stale or foreign permission references", async () => {
  const f = await fixture();
  const team1 = "team:" + randomUUID(),
    team2 = "team:" + randomUUID();
  await f.db
    .collection<{
      _id: string;
      tenant_id: string;
      name: string;
      status: string;
    }>("memory_teams")
    .insertMany(
      [team1, team2].map((_id) => ({
        _id,
        tenant_id: "tenant",
        name: _id,
        status: "active",
      })),
    );
  await f.db.collection("memory_team_memberships").insertMany(
    [
      ["owner", team1],
      ["owner", team2],
      ["reader", team1],
      ["other-reader", team2],
    ].map(([user_id, team_id]) => ({
      tenant_id: "tenant",
      user_id,
      team_id,
      status: "active",
    })),
  );
  const context = caller(),
    own = await f.open(context),
    reader = await f.open(caller("reader")),
    other = await f.open(caller("other-reader")),
    outsider = await f.open(caller("outsider"));
  await own.graph.createEntities([
    {
      name: "A",
      entityType: "test",
      observations: ["team bread fact", "private sister fact"],
      subjects: ["private-subject"],
      source: { source: "private-conversation", sourceId: "private-source" },
    },
    { name: "B", entityType: "test", observations: [] },
  ]);
  await own.graph.createRelations([
    { from: "A", to: "B", relationType: "private-edge" },
  ]);
  expect((await own.call("list_memory_teams")).data).toHaveLength(2);
  const fact = (await own.store.load()).entities[0]!.facts[0]!,
    ref = fact.ref!;
  expect(
    (
      await own.call("set_memory_permissions", {
        fact_refs: [ref],
        visibility: "team",
        team_ids: [team1],
      })
    ).error,
  ).toBe(false);
  await indexed(
    uri!,
    actor(f.realm, context).namespace,
    "team bread fact",
    "team",
  );
  expect(
    (await reader.graph.semanticSearch("bread", 10, 0.9)).matches[0]
      ?.observation,
  ).toBe("team bread fact");
  const shared = await reader.graph.readGraph();
  expect(shared.entities[0]?.observations).toEqual(["team bread fact"]);
  expect(shared.entities[0]?.subjects).toEqual([]);
  expect(shared.relations).toEqual([]);
  expect(JSON.stringify(shared)).not.toContain("private-sister");
  expect(JSON.stringify(shared)).not.toContain("private-source");
  expect(JSON.stringify(shared)).not.toContain(
    context.mode === "user" ? context.conversation_id : "unexpected",
  );
  expect((await other.graph.readGraph()).entities).toEqual([]);
  expect((await outsider.graph.readGraph()).entities).toEqual([]);
  const sharedRef = shared.entities[0]!.fact_metadata![0]!.ref;
  expect(
    (
      await reader.call("set_memory_permissions", {
        fact_refs: [sharedRef],
        visibility: "global",
      })
    ).data,
  ).toMatchObject({ code: "permission_denied" });
  expect(
    (
      await reader.call("delete_observations", {
        deletions: [{ entityName: "A", observations: ["team bread fact"] }],
      })
    ).error,
  ).toBe(false);
  expect((await own.store.load()).entities[0]?.facts).toHaveLength(2);
  expect(
    (
      await own.call("set_memory_permissions", {
        fact_refs: [ref],
        visibility: "global",
      })
    ).data,
  ).toMatchObject({ code: "permission_denied" });
  const freshRef = (await own.store.load()).entities[0]!.facts[0]!.ref!;
  await own.graph.setMemoryPermissions({
    fact_refs: [freshRef],
    visibility: "team",
    team_ids: [team1, team2],
  });
  expect((await other.graph.readGraph()).entities[0]?.observations).toEqual([
    "team bread fact",
  ]);
  await f.db
    .collection("memory_team_memberships")
    .updateOne(
      { user_id: "reader", team_id: team1 },
      { $set: { status: "inactive" } },
    );
  expect((await reader.graph.readGraph()).entities).toEqual([]);
  await indexed(uri!, actor(f.realm, context).namespace, "team bread fact");
  expect((await reader.graph.semanticSearch("bread", 10, 0.9)).matches).toEqual(
    [],
  );
  expect(own.provider.embed).toHaveBeenCalledOnce();
});
it("keeps global sharing within tenant and scope, rechecks authoritative ACLs, and invalidates deleted/recreated fact references", async () => {
  const f = await fixture(),
    context = caller(),
    own = await f.open(context),
    reader = await f.open(caller("reader")),
    foreign = await f.open(caller("reader", "foreign")),
    scope = await f.open(caller("reader", "tenant", "other-scope"));
  await own.graph.createEntities([
    { name: "A", entityType: "test", observations: ["global bread fact"] },
  ]);
  expect(
    (await own.graph.openNodes(["A"])).entities[0]?.fact_metadata?.[0]?.ref,
  ).toMatch(/^fact:/);
  const first = (await own.store.load()).entities[0]!.facts[0]!;
  await own.graph.setMemoryPermissions({
    fact_refs: [first.ref!],
    visibility: "global",
    team_ids: [],
  });
  expect(
    (await reader.graph.searchNodes("bread")).entities[0]?.observations,
  ).toEqual(["global bread fact"]);
  expect((await foreign.graph.readGraph()).entities).toEqual([]);
  expect((await scope.graph.readGraph()).entities).toEqual([]);
  await indexed(uri!, actor(f.realm, context).namespace, "global bread fact");
  expect(
    (await reader.graph.semanticSearch("bread", 10, 0.9)).matches[0]
      ?.observation,
  ).toBe("global bread fact");
  const sharedRef = (await own.store.load()).entities[0]!.facts[0]!.ref!;
  await own.graph.setMemoryPermissions({
    fact_refs: [sharedRef],
    visibility: "user",
    team_ids: [],
  });
  // Simulate a stale/public search projection: authoritative graph filtering still denies it.
  await f.db
    .collection("memory_index")
    .updateMany(
      { realm: f.realm, kind: "fact" },
      { $set: { visibility: "global" } },
    );
  expect((await reader.graph.semanticSearch("bread", 10, 0.9)).matches).toEqual(
    [],
  );
  await own.graph.deleteObservations([
    { entityName: "A", observations: ["global bread fact"] },
  ]);
  await own.graph.addObservations([
    { entityName: "A", contents: ["global bread fact"] },
  ]);
  expect((await own.store.load()).entities[0]!.facts[0]!.ref).not.toBe(
    first.ref,
  );
  await expect(
    own.graph.setMemoryPermissions({
      fact_refs: [first.ref!],
      visibility: "global",
      team_ids: [],
    }),
  ).rejects.toHaveProperty("code", "permission_denied");
});
it("allows discovery without access to any graph and rejects identity injection in tool arguments", async () => {
  const f = await fixture(),
    discovery = await f.open({ mode: "discovery" });
  expect((await discovery.client.listTools()).tools).toHaveLength(13);
  expect((await discovery.call("read_graph")).data).toMatchObject({
    code: "identity_required",
  });
  expect((await discovery.call("list_memory_teams")).data).toMatchObject({
    code: "identity_required",
  });
  expect(
    (
      await discovery.call("create_entities", {
        entities: [{ name: "A", entityType: "test", observations: [] }],
        user_id: "owner",
      })
    ).error,
  ).toBe(true);
  expect(
    await f.db.collection("memory_graphs").countDocuments({ realm: f.realm }),
  ).toBe(0);
});
