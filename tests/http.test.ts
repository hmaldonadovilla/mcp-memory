// Real loopback HTTP checks authentication, rebinding protection, request bounds and both MCP eras.
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@mcp-v1/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyHttpTransport } from "@mcp-v1/sdk/client/streamableHttp.js";
import { createServer, request as requestHttp } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { MemoryGraph } from "../src/graph.js";
import { serveHttp } from "../src/http.js";
import { TestEmbeddings, TestStore } from "./helpers.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const TOKEN = "synthetic-token-only-".repeat(3);
async function raw(
  url: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
) {
  return new Promise<{ status: number }>((resolve, reject) => {
    const request = requestHttp(url, { method, headers }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once("error", reject);
    request.end(body);
  });
}
async function start(env: NodeJS.ProcessEnv = {}) {
  const store = new TestStore();
  const graph = new MemoryGraph(store, new TestEmbeddings());
  const config = await loadConfig({
    MEMORY_HTTP_TOKEN: TOKEN,
    MEMORY_PORT: "0",
    ...env,
  });
  const running = await serveHttp(graph, store, config);
  cleanups.push(() => running.close());
  const address = running.server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address");
  return {
    ...running,
    store,
    url: `http://127.0.0.1:${address.port}`,
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
  };
}
it("requires explicit HTTP credentials and host configuration before accepting connections", async () => {
  const config = await loadConfig({});
  const store = new TestStore(),
    graph = new MemoryGraph(store);
  await expect(serveHttp(graph, store, config)).rejects.toMatchObject({
    code: "http_auth_required",
  });
  await expect(
    serveHttp(graph, store, { ...config, host: "0.0.0.0", token: TOKEN }),
  ).rejects.toMatchObject({ code: "http_hosts_required" });
});
it("isolates endpoint access and never returns data to a missing/incorrect bearer or foreign origin/host", async () => {
  const app = await start();
  expect((await fetch(app.url + "/healthz")).status).toBe(200);
  app.store.load.mockRejectedValueOnce(new Error("synthetic database details"));
  expect((await fetch(app.url + "/healthz")).status).toBe(503);
  expect((await fetch(app.url + "/unknown")).status).toBe(404);
  expect((await fetch(app.url + "/mcp")).status).toBe(401);
  expect(
    (
      await fetch(app.url + "/mcp", {
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await raw(app.url + "/mcp", { Host: "attacker.invalid" })).status,
  ).toBe(403);
  expect(
    (await fetch(app.url + "/mcp", { headers: { Origin: "null" } })).status,
  ).toBe(403);
  expect(
    (
      await fetch(app.url + "/mcp", {
        headers: { ...app.headers, Origin: "http://attacker.invalid" },
      })
    ).status,
  ).toBe(403);
  const local = await fetch(app.url + "/mcp", {
    headers: { ...app.headers, Origin: app.url },
  });
  expect(local.status).toBe(405);
  expect(local.headers.get("cache-control")).toBe("no-store");
});
it("serves current and framework legacy clients without sessions, shared stores or model calls", async () => {
  const app = await start();
  const client = new Client({ name: "modern-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + TOKEN } },
    }),
  );
  cleanups.push(() => client.close());
  expect((await client.listTools()).tools).toHaveLength(11);
  const legacy = new LegacyClient({ name: "framework-test", version: "1" });
  await legacy.connect(
    new LegacyHttpTransport(new URL(app.url + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + TOKEN } },
    }),
  );
  cleanups.push(() => legacy.close());
  expect((await legacy.listTools()).tools).toHaveLength(11);
  const result = await legacy.callTool({ name: "read_graph", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(
    (await client.readResource({ uri: "memory://knowledge-graph" })).contents,
  ).toHaveLength(1);
});
it("accepts only explicitly configured proxy hosts/origins and limits incoming bodies", async () => {
  const app = await start({
    MEMORY_HOST: "0.0.0.0",
    MEMORY_ALLOWED_HOSTS: "memory.example:3001",
    MEMORY_ALLOWED_ORIGINS: "https://client.example",
  });
  expect((await fetch(app.url + "/healthz")).status).toBe(403);
  const headers = {
    ...app.headers,
    Host: "memory.example:3001",
    Origin: "https://client.example",
  };
  expect((await raw(app.url + "/healthz", headers)).status).toBe(200);
  expect(
    (
      await raw(
        app.url + "/mcp",
        { ...headers, "Content-Length": "1048577" },
        "POST",
        "{}",
      )
    ).status,
  ).toBe(413);
});
it("bounds active requests and releases capacity after completion", async () => {
  const app = await start();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.store.load.mockImplementation(async () => {
    await held;
    return structuredClone(app.store.state);
  });
  const pending = Array.from({ length: 64 }, (_, i) =>
    fetch(app.url + "/mcp", {
      method: "POST",
      headers: app.headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "read_graph", arguments: {} },
      }),
    }),
  );
  await vi.waitFor(() => expect(app.store.load).toHaveBeenCalledTimes(64));
  expect((await fetch(app.url + "/mcp", { headers: app.headers })).status).toBe(
    503,
  );
  release();
  for (const response of await Promise.all(pending)) {
    expect(response.status).toBe(200);
    await response.text();
  }
  expect((await fetch(app.url + "/mcp", { headers: app.headers })).status).toBe(
    405,
  );
});
it("refuses a listener address already in use", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  );
  const address = blocker.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address");
  const config = await loadConfig({
      MEMORY_HTTP_TOKEN: TOKEN,
      MEMORY_PORT: String(address.port),
    }),
    store = new TestStore();
  await expect(
    serveHttp(new MemoryGraph(store), store, config),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
});
