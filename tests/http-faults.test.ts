// Fault-injected SDK transport failures prove the final HTTP boundary cannot leak request or credential details.
import type * as NodeAdapter from "@modelcontextprotocol/node";
import type * as ServerSdk from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { MemoryGraph } from "../src/graph.js";
import { serveHttp } from "../src/http.js";
import { TestStore } from "./helpers.js";
const faults = vi.hoisted(() => ({
  mode: "before",
  callbacks: [] as ((error: Error) => void)[],
}));
vi.mock("@modelcontextprotocol/server", async (original) => {
  const actual = await original<typeof ServerSdk>();
  return {
    ...actual,
    createMcpHandler: (
      factory: ServerSdk.McpServerFactory,
      options?: ServerSdk.CreateMcpHandlerOptions,
    ) => {
      if (options?.onerror) faults.callbacks.push(options.onerror);
      return actual.createMcpHandler(factory, options);
    },
  };
});
vi.mock("@modelcontextprotocol/node", async (original) => {
  const actual = await original<typeof NodeAdapter>();
  return {
    ...actual,
    toNodeHandler: (
      _handler: NodeAdapter.FetchLikeMcpHandler,
      options?: NodeAdapter.ToNodeHandlerOptions,
    ) => {
      if (options?.onerror) faults.callbacks.push(options.onerror);
      return async (
        _request: NodeAdapter.NodeIncomingMessageLike,
        response: NodeAdapter.NodeServerResponseLike,
      ) => {
        if (faults.mode === "after") {
          response.writeHead(200);
          response.write("partial");
        }
        throw new Error("synthetic-private-token-never-log");
      };
    },
  };
});
afterEach(() => {
  faults.callbacks = [];
  vi.restoreAllMocks();
});
it("reports only safe transport diagnostics and returns a bounded failure before headers", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {}),
    store = new TestStore();
  const config = await loadConfig({
    MEMORY_HTTP_TOKEN: "x".repeat(32),
    MEMORY_PORT: "0",
  });
  const app = await serveHttp(new MemoryGraph(store), store, config);
  try {
    expect(faults.callbacks).toHaveLength(2);
    for (const report of faults.callbacks)
      report(new Error("synthetic-private-token-never-log"));
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-token");
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture_address");
    const url = `http://127.0.0.1:${address.port}/mcp`,
      headers = { Authorization: "Bearer " + config.token };
    faults.mode = "before";
    const result = await fetch(url, { headers });
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ code: "transport_error" });
    faults.mode = "after";
    await expect(
      (async () => {
        const partial = await fetch(url, { headers });
        await partial.text();
      })(),
    ).rejects.toThrow();
  } finally {
    await app.close();
  }
});
