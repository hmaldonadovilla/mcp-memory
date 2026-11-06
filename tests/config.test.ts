// Operator configuration validates secret files, exact scope and certificate policy without revealing values.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const profile = {
  MEMORY_VECTOR_INDEX: "memory_semantic_v2",
  MEMORY_EMBEDDING_BASE_URL: "https://provider.example/openai/v1",
  MEMORY_EMBEDDING_MODEL: "embedding",
  MEMORY_EMBEDDING_PROFILE: "model-v1",
  MEMORY_EMBEDDING_DIMENSIONS: "2",
};
it("has a literal graph-only default and accepts explicit mounted credentials and CA references", async () => {
  expect(await loadConfig({})).toMatchObject({
    uri: "mongodb://127.0.0.1:27017",
    database: "mcp_memory",
    namespace: "default",
    readOnly: false,
    host: "127.0.0.1",
    port: 3001,
  });
  const dir = await mkdtemp(join(tmpdir(), "memory-config-"));
  directories.push(dir);
  const uriFile = join(dir, "mongo"),
    keyFile = join(dir, "key"),
    tokenFile = join(dir, "token");
  await writeFile(uriFile, "mongodb://127.0.0.1:27017\n");
  await writeFile(keyFile, "synthetic-embedding-key\n");
  await writeFile(tokenFile, "x".repeat(32));
  const config = await loadConfig({
    ...profile,
    MEMORY_MONGODB_URI_FILE: uriFile,
    MEMORY_HTTP_TOKEN_FILE: tokenFile,
    MEMORY_EMBEDDING_API_KEY_FILE: keyFile,
    MEMORY_MONGODB_CA_FILE: "/mounted/db-ca",
    MEMORY_EMBEDDING_CA_FILE: "/mounted/model-ca",
    MEMORY_EMBEDDING_AUTH_HEADER: "api-key",
    MEMORY_EMBEDDING_SEND_DIMENSIONS: "true",
    MEMORY_NAMESPACE: "user:agent",
    MEMORY_READ_ONLY: "true",
    MEMORY_ALLOWED_HOSTS: "memory.example:3001, localhost:3001",
    MEMORY_ALLOWED_ORIGINS: "https://client.example, https://other.example",
  });
  expect(config.readOnly).toBe(true);
  expect(config.allowedHosts).toHaveLength(2);
  expect(config.allowedOrigins).toHaveLength(2);
  expect(config.embedding).toMatchObject({
    key: "synthetic-embedding-key",
    authHeader: "api-key",
    sendDimensions: true,
    caFile: "/mounted/model-ca",
  });
  expect((await loadConfig(profile)).embedding).toMatchObject({
    authHeader: "bearer",
    sendDimensions: false,
  });
  expect(
    (await loadConfig({ ...profile, MEMORY_VECTOR_INDEX_INTERFACE: "command" }))
      .search,
  ).toMatchObject({ management: "command" });
  expect((await loadConfig(profile)).search).toMatchObject({
    management: "aggregation",
  });
});
it.each([
  [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "insecure_tls"],
  [{ MEMORY_MONGODB_URI: "https://example.invalid" }, "invalid_mongodb_uri"],
  [
    {
      MEMORY_MONGODB_URI:
        "mongodb://localhost/?tlsAllowInvalidCertificates=true",
    },
    "invalid_mongodb_uri",
  ],
  [
    { MEMORY_MONGODB_URI: "mongodb://localhost/?tlsInsecure=true&x=1" },
    "invalid_mongodb_uri",
  ],
  [
    { MEMORY_MONGODB_URI: "mongodb://localhost/?tlsInsecure=%74rue" },
    "invalid_mongodb_uri",
  ],
  [{ MEMORY_NAMESPACE: "$bad" }, "invalid_config"],
  [{ MEMORY_PORT: "65536" }, "invalid_config"],
  [{ MEMORY_READ_ONLY: "yes" }, "invalid_config"],
  [{ MEMORY_DATABASE: "bad/db" }, "invalid_config"],
  [{ MEMORY_ALLOWED_HOSTS: "*.example" }, "invalid_config"],
  [{ MEMORY_ALLOWED_HOSTS: "https://host" }, "invalid_config"],
  [{ MEMORY_ALLOWED_ORIGINS: "null" }, "invalid_config"],
  [{ MEMORY_ALLOWED_ORIGINS: "ftp://host" }, "invalid_config"],
  [{ MEMORY_ALLOWED_ORIGINS: "https://user:secret@host" }, "invalid_config"],
  [{ MEMORY_HTTP_TOKEN: "short" }, "invalid_http_token"],
  [{ MEMORY_HTTP_TOKEN: "x".repeat(8193) }, "invalid_http_token"],
  [{ MEMORY_HTTP_TOKEN: "x".repeat(31) + " " }, "invalid_http_token"],
  [{ MEMORY_EMBEDDING_MODEL: "unbound" }, "invalid_embedding_profile"],
  [{ ...profile, MEMORY_VECTOR_INDEX: "" }, "invalid_search_config"],
  [{ MEMORY_VECTOR_INDEX: "unbound" }, "invalid_search_config"],
  [{ MEMORY_VECTOR_INDEX_INTERFACE: "command" }, "invalid_search_config"],
  [
    { ...profile, MEMORY_VECTOR_INDEX_INTERFACE: "unrecognized" },
    "invalid_search_config",
  ],
  [
    { ...profile, MEMORY_EMBEDDING_DIMENSIONS: "8193" },
    "invalid_embedding_profile",
  ],
  [{ MEMORY_EMBEDDING_BASE_URL: "https://host" }, "invalid_embedding_profile"],
  [
    { ...profile, MEMORY_EMBEDDING_DIMENSIONS: "NaN" },
    "invalid_embedding_profile",
  ],
  [
    { ...profile, MEMORY_EMBEDDING_DIMENSIONS: "0" },
    "invalid_embedding_profile",
  ],
  [
    { ...profile, MEMORY_EMBEDDING_DIMENSIONS: "16385" },
    "invalid_embedding_profile",
  ],
  [
    { ...profile, MEMORY_EMBEDDING_AUTH_HEADER: "unknown" },
    "invalid_embedding_profile",
  ],
  [
    { ...profile, MEMORY_EMBEDDING_SEND_DIMENSIONS: "unknown" },
    "invalid_embedding_profile",
  ],
  [
    {
      MEMORY_MONGODB_URI: "mongodb://localhost",
      MEMORY_MONGODB_URI_FILE: "ignored",
    },
    "invalid_config",
  ],
  [
    { MEMORY_HTTP_TOKEN_FILE: "/missing/synthetic-token" },
    "invalid_secret_file",
  ],
  [{ MEMORY_HTTP_TOKEN: "" }, "invalid_secret_file"],
  [{ MEMORY_HTTP_TOKEN: "x".repeat(65537) }, "invalid_secret_file"],
] as const)(
  "refuses unsafe or ambiguous configuration %#",
  async (env, code) => {
    await expect(loadConfig(env)).rejects.toMatchObject({ code });
  },
);
it("accepts explicit non-default settings without adding a provider or disabling TLS", async () => {
  const config = await loadConfig({
    MEMORY_MONGODB_URI: "mongodb+srv://cluster.example",
    MEMORY_HTTP_TOKEN: "x".repeat(32),
    MEMORY_ALLOWED_HOSTS: ", localhost:3001,",
    MEMORY_ALLOWED_ORIGINS: ",",
    MEMORY_PORT: "0",
    MEMORY_NAMESPACE: "other",
  });
  expect(config.port).toBe(0);
  expect(config.embedding).toBeUndefined();
  expect(config.allowedHosts).toEqual(["localhost:3001"]);
});
