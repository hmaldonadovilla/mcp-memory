// Startup owns cleanup on every path and keeps provider/credential details out of executable diagnostics.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli, safeError } from "../src/cli.js";
import { OpenAICompatibleEmbeddings } from "../src/embeddings.js";
import { serveHttp } from "../src/http.js";
import { MemoryError } from "../src/model.js";
import { MongoGraphStore } from "../src/store.js";
import { TestStore } from "./helpers.js";
const fixtures = vi.hoisted(() => ({
  closeStdio: vi.fn(async () => {}),
  closeHttp: vi.fn(async () => {}),
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn(() => ({ close: fixtures.closeStdio })),
}));
vi.mock("../src/http.js", () => ({
  serveHttp: vi.fn(async () => ({ close: fixtures.closeHttp })),
}));
let store: TestStore;
beforeEach(() => {
  store = new TestStore();
  vi.spyOn(MongoGraphStore, "connect").mockResolvedValue(store);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const profile = {
  MEMORY_EMBEDDING_BASE_URL: "http://127.0.0.1:9/v1",
  MEMORY_EMBEDDING_MODEL: "synthetic",
  MEMORY_EMBEDDING_PROFILE: "v1",
  MEMORY_EMBEDDING_DIMENSIONS: "2",
};
it("serves help/version and refuses invalid arguments before touching persistence", async () => {
  const output = vi.fn();
  await runCli(["--help"], {}, output);
  expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  await runCli(["--version"], {}, output);
  expect(output).toHaveBeenCalledWith("0.1.0");
  for (const args of [
    ["--unknown"],
    ["--transport", "ftp"],
    ["--max-facts", "0"],
    ["--max-facts", "10001"],
    ["--max-facts", "x"],
  ])
    await expect(runCli(args, {})).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  expect(MongoGraphStore.connect).not.toHaveBeenCalled();
  await expect(
    runCli(["--reindex"], { MEMORY_READ_ONLY: "true" }),
  ).rejects.toMatchObject({ code: "read_only" });
  await expect(runCli(["--transport", "http"], {})).rejects.toMatchObject({
    code: "http_auth_required",
  });
});
it("starts stdio through the negotiating SDK factory and closes data exactly once", async () => {
  const runtime = await runCli([], {});
  expect(runtime?.transport).toBe("stdio");
  const factory = vi.mocked(serveStdio).mock.calls[0]?.[0];
  if (!factory) throw new Error("missing_factory");
  const server = await factory({ era: "legacy" });
  await server.close();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(serveStdio).mock.calls[0]?.[1]?.onerror?.(
    new Error("synthetic-private"),
  );
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("details suppressed"),
  );
  await Promise.all([runtime?.close(), runtime?.close()]);
  expect(fixtures.closeStdio).toHaveBeenCalledOnce();
  expect(store.close).toHaveBeenCalledOnce();
});
it("starts HTTP with read-only configuration and closes the provider along with storage", async () => {
  const provider = await OpenAICompatibleEmbeddings.create({
    baseUrl: "http://127.0.0.1:9",
    model: "synthetic",
    profileId: "v1",
    dimensions: 2,
  });
  vi.spyOn(OpenAICompatibleEmbeddings, "create").mockResolvedValue(provider);
  const close = vi.spyOn(provider, "close");
  const runtime = await runCli(["--transport", "http"], {
    ...profile,
    MEMORY_HTTP_TOKEN: "x".repeat(32),
    MEMORY_READ_ONLY: "true",
  });
  expect(serveHttp).toHaveBeenCalledWith(
    expect.anything(),
    store,
    expect.objectContaining({ readOnly: true }),
  );
  await runtime?.close();
  expect(close).toHaveBeenCalledOnce();
  expect(fixtures.closeHttp).toHaveBeenCalledOnce();
});
it("closes persistence if provider initialization or transport creation fails", async () => {
  vi.spyOn(OpenAICompatibleEmbeddings, "create").mockRejectedValueOnce(
    new Error("synthetic failure"),
  );
  await expect(runCli([], profile)).rejects.toThrow("synthetic failure");
  expect(store.close).toHaveBeenCalledOnce();
  vi.mocked(serveHttp).mockRejectedValueOnce(new Error("bind failure"));
  await expect(
    runCli(["--transport", "http"], { MEMORY_HTTP_TOKEN: "x".repeat(32) }),
  ).rejects.toThrow("bind failure");
  expect(store.close).toHaveBeenCalledTimes(2);
});
it("runs explicit reindex as a bounded operator action, always cleaning up", async () => {
  const output = vi.fn();
  await runCli(["--reindex", "--max-facts", "1"], profile, output);
  expect(output).toHaveBeenCalledWith(
    expect.stringContaining('"indexedFacts":0'),
  );
  expect(store.close).toHaveBeenCalledOnce();
  await expect(runCli(["--reindex"], {})).rejects.toMatchObject({
    code: "embedding_not_configured",
  });
  expect(store.close).toHaveBeenCalledTimes(2);
  expect(safeError(new Error("synthetic-private-key"))).not.toContain(
    "private-key",
  );
  expect(safeError(new MemoryError("known", "Safe failure"))).toBe(
    "known: Safe failure",
  );
});
