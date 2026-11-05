// Drive actual MCP discovery, validation and tools through the SDK, rather than invoking registration callbacks.
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, it } from "vitest";
import { MemoryGraph } from "../src/graph.js";
import { createMemoryServer, RESOURCE_URI } from "../src/server.js";
import { person, TestEmbeddings, TestStore } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function connect(
  readOnly = false,
  store = new TestStore(),
  provider: TestEmbeddings | undefined = new TestEmbeddings(),
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createMemoryServer(new MemoryGraph(store, provider), readOnly),
    { transport: serverSide },
  );
  const client = new Client({ name: "memory-test", version: "1.0.0" });
  await client.connect(clientSide);
  cleanup.push(async () => {
    await client.close();
    await handle.close();
  });
  return { client, store };
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  if (!("content" in result) || !Array.isArray(result.content))
    throw new Error("missing_tool_content");
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("missing_tool_text");
  let data;
  try {
    data = JSON.parse(first.text);
  } catch {
    data = { message: first.text };
  }
  return { error: result.isError === true, data };
}
it("discovers all eleven tools with accurate annotations and reads the graph resource", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(11);
  expect(
    tools.find((t) => t.name === "semantic_search")?.annotations,
  ).toMatchObject({
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  });
  expect(
    tools.find((t) => t.name === "delete_entities")?.annotations,
  ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  expect((await client.listResources()).resources[0]?.uri).toBe(RESOURCE_URI);
  expect(
    (await client.readResource({ uri: RESOURCE_URI })).contents,
  ).toHaveLength(1);
  expect((await call(client, "read_graph")).data).toMatchObject({
    entities: [],
    relations: [],
  });
});
it("executes the full public graph vocabulary and semantic/subject retrieval", async () => {
  const { client } = await connect();
  expect(
    (
      await call(client, "create_entities", {
        entities: [
          { ...person("A"), subjects: ["user"] },
          person("B", ["Writes code"]),
        ],
      })
    ).error,
  ).toBe(false);
  const relation = { from: "A", to: "B", relationType: "knows" };
  expect(
    (await call(client, "create_relations", { relations: [relation] })).data,
  ).toHaveLength(1);
  expect(
    (
      await call(client, "add_observations", {
        observations: [{ entityName: "A", contents: ["Bakes bread"] }],
      })
    ).error,
  ).toBe(false);
  expect(
    (await call(client, "open_nodes", { names: ["A", "B"] })).data.entities,
  ).toHaveLength(2);
  expect(
    (await call(client, "search_nodes", { query: "code" })).data.entities,
  ).toHaveLength(1);
  expect(
    (await call(client, "lookup_subject", { subject: "user" })).data.entities,
  ).toHaveLength(1);
  expect(
    (await call(client, "semantic_search", { query: "pastry" })).data.matches,
  ).toHaveLength(2);
  expect(
    (await call(client, "delete_relations", { relations: [relation] })).data
      .deleted,
  ).toBe(1);
  expect(
    (
      await call(client, "delete_observations", {
        deletions: [{ entityName: "A", observations: ["Bakes bread"] }],
      })
    ).data.deleted,
  ).toBe(1);
  expect(
    (await call(client, "delete_entities", { entityNames: ["A"] })).data
      .deleted,
  ).toEqual(["A"]);
});
it("rejects namespace overrides and invalid input, exposes only read tools in read-only mode", async () => {
  const { client } = await connect(true);
  expect((await client.listTools()).tools).toHaveLength(5);
  expect(
    (await call(client, "open_nodes", { names: [], namespace: "another-user" }))
      .error,
  ).toBe(true);
  expect(
    (await call(client, "semantic_search", { query: "", topK: 5000 })).error,
  ).toBe(true);
  await expect(
    call(client, "create_entities", { entities: [person()] }),
  ).rejects.toThrow("not found");
});
it("returns classified errors and never provider, database or credential details", async () => {
  const { client, store } = await connect();
  expect(
    (
      await call(client, "create_relations", {
        relations: [{ from: "missing", to: "other", relationType: "knows" }],
      })
    ).data.code,
  ).toBe("entity_missing");
  store.load.mockRejectedValueOnce(new Error("synthetic-secret-DO-NOT-LEAK"));
  const failed = await call(client, "read_graph");
  expect(failed.data.code).toBe("operation_failed");
  expect(JSON.stringify(failed)).not.toContain("DO-NOT-LEAK");
});
