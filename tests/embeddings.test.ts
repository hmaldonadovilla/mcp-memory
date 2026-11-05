// Local provider fixtures exercise request dialects, real HTTP failure and strict vector validation.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OpenAICompatibleEmbeddings } from "../src/embeddings.js";
let server: Server;
let baseUrl: string;
let body: unknown;
let auth: string | undefined;
let status: number;
let output: unknown;
let delay: number;
let calls: number;
const providers: OpenAICompatibleEmbeddings[] = [];
beforeEach(async () => {
  status = 200;
  output = { data: [{ index: 0, embedding: [3, 4] }] };
  delay = 0;
  calls = 0;
  body = undefined;
  auth = undefined;
  server = createServer((request, response) => {
    void (async () => {
      calls++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString());
      auth =
        request.headers.authorization ?? request.headers["api-key"]?.toString();
      const send = () => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(
          typeof output === "string" ? output : JSON.stringify(output),
        );
      };
      if (delay) {
        const timer = setTimeout(send, delay);
        timer.unref();
      } else send();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function provider(
  options: Partial<
    Parameters<typeof OpenAICompatibleEmbeddings.create>[0]
  > = {},
) {
  const instance = await OpenAICompatibleEmbeddings.create({
    baseUrl,
    model: "synthetic-embedding",
    profileId: "test-v1",
    dimensions: 2,
    ...options,
  });
  providers.push(instance);
  return instance;
}
it("normalizes finite vectors and uses optional OpenAI/Azure v1 dialect fields explicitly", async () => {
  const embedder = await provider({ key: "synthetic", authHeader: "bearer" });
  expect(await embedder.embed(["fact"])).toEqual([[0.6, 0.8]]);
  expect(auth).toBe("Bearer synthetic");
  expect(body).toEqual({
    model: "synthetic-embedding",
    input: ["fact"],
    encoding_format: "float",
  });
  const azure = await provider({
    key: "synthetic",
    authHeader: "api-key",
    sendDimensions: true,
  });
  await azure.embed(["fact"]);
  expect(auth).toBe("synthetic");
  expect(body).toMatchObject({ dimensions: 2 });
  const anonymous = await provider();
  await anonymous.embed(["fact"]);
  expect(auth).toBeUndefined();
  expect((await provider({ baseUrl: baseUrl + "/" })).profile).toBe(
    embedder.profile,
  );
  expect(await anonymous.embed([])).toEqual([]);
  expect(calls).toBe(3);
});
it("reorders indexed batch results and never mixes missing, duplicate or malformed vectors", async () => {
  const embedder = await provider();
  output = {
    data: [
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ],
  };
  expect(await embedder.embed(["a", "b"])).toEqual([
    [1, 0],
    [0, 1],
  ]);
  for (const invalid of [
    "not-json",
    { data: [] },
    { data: [{ index: 1, embedding: [1, 0] }] },
    { data: [{ index: 0, embedding: [1] }] },
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: [null, 1] }] },
    { data: [{ index: 0, embedding: [1.7e308, 1.7e308] }] },
    {
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [1, 0] },
      ],
    },
  ]) {
    output = invalid;
    await expect(embedder.embed(["fact"])).rejects.toMatchObject({
      code: "embedding_unavailable",
    });
  }
});
it("has explicit input, response, status, timeout and cancellation bounds with no retry", async () => {
  const embedder = await provider();
  for (const inputs of [
    [""],
    [" "],
    ["a".repeat(8193)],
    Array.from({ length: 65 }, () => "fact"),
  ])
    await expect(embedder.embed(inputs)).rejects.toMatchObject({
      code: "embedding_budget",
    });
  expect(calls).toBe(0);
  status = 429;
  await expect(embedder.embed(["fact"])).rejects.toMatchObject({
    code: "embedding_unavailable",
  });
  expect(calls).toBe(1);
  status = 204;
  await expect(embedder.embed(["fact"])).rejects.toMatchObject({
    code: "embedding_unavailable",
  });
  status = 200;
  output = "x".repeat(17 * 1024 * 1024);
  await expect(embedder.embed(["fact"])).rejects.toMatchObject({
    code: "embedding_unavailable",
  });
  output = { data: [{ index: 0, embedding: [1, 0] }] };
  delay = 100;
  const timed = await provider({ timeoutMs: 5 });
  await expect(timed.embed(["fact"])).rejects.toMatchObject({
    code: "embedding_unavailable",
  });
  await expect(
    embedder.embed(["fact"], AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "embedding_unavailable" });
});
it("requires a safe explicit endpoint and valid profile, including a readable CA file", async () => {
  for (const bad of [
    "http://external.invalid/v1",
    "ftp://localhost",
    "https://user:password@host",
    "https://host?key=synthetic",
    "https://host/#fragment",
  ])
    await expect(provider({ baseUrl: bad })).rejects.toMatchObject({
      code: "invalid_embedding_endpoint",
    });
  for (const dimensions of [0, 1.5, 16385])
    await expect(provider({ dimensions })).rejects.toMatchObject({
      code: "invalid_embedding_profile",
    });
  await expect(provider({ model: " " })).rejects.toMatchObject({
    code: "invalid_embedding_profile",
  });
  await expect(provider({ profileId: " " })).rejects.toMatchObject({
    code: "invalid_embedding_profile",
  });
  await expect(
    provider({ caFile: "/missing/synthetic-ca" }),
  ).rejects.toMatchObject({ code: "invalid_ca_file" });
});
