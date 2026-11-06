// Built executables and the HTTP factory complete real MongoDB tasks using only an owned local embedding fixture.
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@mcp-v1/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@mcp-v1/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@mcp-v1/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OpenAICompatibleEmbeddings } from "../src/embeddings.js";
import { MemoryGraph } from "../src/graph.js";
import { serveHttp } from "../src/http.js";
import { MongoGraphStore } from "../src/store.js";
import { embeddingFixture } from "./network-fixtures.js";
import { indexed } from "./native-fixtures.js";
const uri = process.env.MEMORY_TEST_MONGODB_URI;
if (
  !uri ||
  !/^mongodb:\/\/127\.0\.0\.1:\d+\/(?:\?directConnection=true)?$/.test(uri)
)
  throw new Error("Use the isolated integration runner");
const cleanup: (() => Promise<void>)[] = [],
  namespaces: string[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
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
function environment(baseUrl: string) {
  const namespace = "transport-" + randomUUID();
  namespaces.push(namespace);
  return {
    PATH: process.env.PATH ?? "",
    MEMORY_MONGODB_URI: uri!,
    MEMORY_DATABASE: "mcp_memory_tests",
    MEMORY_NAMESPACE: namespace,
    MEMORY_EMBEDDING_BASE_URL: baseUrl,
    MEMORY_EMBEDDING_MODEL: "synthetic",
    MEMORY_EMBEDDING_PROFILE: "test-v1",
    MEMORY_EMBEDDING_DIMENSIONS: "2",
    MEMORY_VECTOR_INDEX: "memory_semantic_v3",
    MEMORY_VECTOR_INDEX_INTERFACE: "command",
    MEMORY_EMBEDDING_API_KEY: "synthetic-test-key",
  };
}
for (const era of ["current", "legacy"] as const)
  it(`completes a text-memory task through the packed-entry stdio API (${era})`, async () => {
    const fixture = await embeddingFixture();
    cleanup.push(() => fixture.close());
    const env = environment(fixture.baseUrl);
    const client =
      era === "current"
        ? new Client({ name: "integration-test", version: "1" })
        : new LegacyClient({ name: "integration-test", version: "1" });
    if (era === "current")
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ["bin/mcp-memory.mjs"],
          env,
          stderr: "pipe",
        }),
      );
    else
      await client.connect(
        new LegacyStdio({
          command: process.execPath,
          args: ["bin/mcp-memory.mjs"],
          env,
          stderr: "pipe",
        }),
      );
    cleanup.push(() => client.close());
    const created = await client.callTool({
      name: "create_entities",
      arguments: {
        entities: [
          {
            name: "preference",
            entityType: "memory",
            subjects: ["synthetic-user"],
            observations: ["Enjoys croissants"],
          },
        ],
      },
    });
    expect(created.isError).not.toBe(true);
    await indexed(uri!, env.MEMORY_NAMESPACE, "Enjoys croissants");
    const result = await client.callTool({
      name: "semantic_search",
      arguments: { query: "pastry preferences", topK: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Enjoys croissants");
    expect(JSON.stringify(result)).not.toContain('"vector"');
    expect(fixture.seen).toHaveLength(2);
    expect(fixture.seen[0]?.authorization).toBe("Bearer synthetic-test-key");
  });
it("serves persisted memory over current and legacy Streamable HTTP clients", async () => {
  const fixture = await embeddingFixture();
  cleanup.push(() => fixture.close());
  const env = environment(fixture.baseUrl);
  const config = await loadConfig({
    ...env,
    MEMORY_HTTP_TOKEN: "synthetic-token-".repeat(4),
    MEMORY_PORT: "0",
  });
  const store = await MongoGraphStore.connect(
    config.uri,
    config.database,
    config.namespace,
    config.caFile,
    config.search,
  );
  cleanup.push(() => store.close());
  const provider = await OpenAICompatibleEmbeddings.create(config.embedding!);
  cleanup.push(() => provider.close());
  const running = await serveHttp(
    new MemoryGraph(store, provider),
    store,
    config,
  );
  cleanup.push(() => running.close());
  const address = running.server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const current = new Client({ name: "current", version: "1" });
  await current.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  cleanup.push(() => current.close());
  const added = await current.callTool({
    name: "create_entities",
    arguments: {
      entities: [
        {
          name: "preference",
          entityType: "memory",
          observations: ["Bakes bread"],
        },
      ],
    },
  });
  expect(added.isError).not.toBe(true);
  await indexed(uri!, config.namespace, "Bakes bread");
  const legacy = new LegacyClient({ name: "legacy", version: "1" });
  await legacy.connect(
    new LegacyHttp(url, {
      requestInit: { headers: { Authorization: "Bearer " + config.token } },
    }),
  );
  cleanup.push(() => legacy.close());
  const found = await legacy.callTool({
    name: "semantic_search",
    arguments: { query: "pastry" },
  });
  expect(found.isError).not.toBe(true);
  expect(JSON.stringify(found)).toContain("Bakes bread");
  expect(fixture.seen).toHaveLength(2);
});
it("rejects an untrusted HTTPS embedding certificate and succeeds with an explicit additional CA", async () => {
  const fixture = await embeddingFixture(true);
  cleanup.push(() => fixture.close());
  const options = {
    baseUrl: fixture.baseUrl,
    model: "synthetic",
    profileId: "tls-test",
    dimensions: 2,
  };
  const untrusted = await OpenAICompatibleEmbeddings.create(options);
  cleanup.push(() => untrusted.close());
  await expect(untrusted.embed(["pastry"])).rejects.toMatchObject({
    code: "embedding_unavailable",
  });
  const trusted = await OpenAICompatibleEmbeddings.create({
    ...options,
    caFile: fixture.caFile!,
  });
  cleanup.push(() => trusted.close());
  expect(await trusted.embed(["pastry"])).toEqual([[1, 0]]);
  expect(fixture.seen).toHaveLength(1);
});
