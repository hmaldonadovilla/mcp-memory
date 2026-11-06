// Read only documented operator configuration; secret values never enter diagnostics or tool arguments.
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { MemoryError } from "./model.js";
import type { EmbeddingOptions } from "./embeddings.js";
import { callerSchema } from "./access.js";
import type { CallerContext } from "./access.js";
import type { SearchSettings } from "./vector-index.js";

export interface Config {
  uri: string;
  database: string;
  namespace: string;
  caller?: CallerContext;
  directoryDatabase?: string;
  caFile?: string;
  readOnly: boolean;
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  embedding?: EmbeddingOptions;
  search?: SearchSettings;
}
async function secret(
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<string | undefined> {
  if (env[key] && env[key + "_FILE"])
    throw new MemoryError(
      "invalid_config",
      "Choose a secret value or its mounted file, not both.",
    );
  try {
    const value = env[key + "_FILE"]
      ? (await readFile(env[key + "_FILE"]!, "utf8")).trim()
      : env[key];
    if (value !== undefined && (!value || Buffer.byteLength(value) > 65536))
      throw new Error("invalid_secret");
    return value;
  } catch {
    throw new MemoryError(
      "invalid_secret_file",
      "A configured secret is empty, oversized or unreadable.",
    );
  }
}
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new MemoryError(
      "insecure_tls",
      "TLS verification must remain enabled; configure a trusted CA bundle instead.",
    );
  const uri =
    (await secret(env, "MEMORY_MONGODB_URI")) ?? "mongodb://127.0.0.1:27017";
  const query = new URLSearchParams(
    uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "",
  );
  const insecure = [...query].some(
    ([key, value]) =>
      [
        "tlsinsecure",
        "tlsallowinvalidcertificates",
        "tlsallowinvalidhostnames",
      ].includes(key.toLowerCase()) && value.toLowerCase() !== "false",
  );
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri) || insecure)
    throw new MemoryError(
      "invalid_mongodb_uri",
      "Use a MongoDB URI without TLS-verification bypass options.",
    );
  const raw = z
    .object({
      database: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      namespace: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
      readOnly: z.enum(["true", "false"]),
      host: z.string().min(1).max(253),
      port: z.coerce.number().int().min(0).max(65535),
    })
    .safeParse({
      database: env.MEMORY_DATABASE ?? "mcp_memory",
      namespace: env.MEMORY_NAMESPACE ?? "default",
      readOnly: env.MEMORY_READ_ONLY ?? "false",
      host: env.MEMORY_HOST ?? "127.0.0.1",
      port: env.MEMORY_PORT ?? "3001",
    });
  if (!raw.success)
    throw new MemoryError(
      "invalid_config",
      "Database, namespace, read-only mode, host or port configuration is invalid.",
    );
  const split = (value: string | undefined) =>
    value
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
  const allowedHosts = split(env.MEMORY_ALLOWED_HOSTS);
  const allowedOrigins = split(env.MEMORY_ALLOWED_ORIGINS);
  if (
    allowedHosts.some((v) => /[\s/*@]/.test(v)) ||
    allowedOrigins.some((v) => {
      try {
        const url = new URL(v);
        return url.origin !== v || !["http:", "https:"].includes(url.protocol);
      } catch {
        return true;
      }
    })
  )
    throw new MemoryError(
      "invalid_config",
      "Allowed hosts and origins must be explicit exact values; wildcards and URL credentials are not allowed.",
    );
  const token = await secret(env, "MEMORY_HTTP_TOKEN");
  if (token && (token.length < 32 || token.length > 8192 || /\s/.test(token)))
    throw new MemoryError(
      "invalid_http_token",
      "HTTP bearer credentials must be 32–8,192 non-whitespace characters.",
    );
  const config: Config = {
    ...raw.data,
    readOnly: raw.data.readOnly === "true",
    uri,
    allowedHosts,
    allowedOrigins,
    ...(env.MEMORY_MONGODB_CA_FILE
      ? { caFile: env.MEMORY_MONGODB_CA_FILE }
      : {}),
    ...(token ? { token } : {}),
  };
  if (env.MEMORY_DIRECTORY_DATABASE) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(env.MEMORY_DIRECTORY_DATABASE))
      throw new MemoryError(
        "invalid_config",
        "The directory database name is invalid.",
      );
    config.directoryDatabase = env.MEMORY_DIRECTORY_DATABASE;
  }
  if (env.MCP_SERVER_CONFIG_FILE) {
    try {
      const file = await stat(env.MCP_SERVER_CONFIG_FILE);
      if (
        !file.isFile() ||
        file.size > 16384 ||
        (process.platform !== "win32" && file.mode & 0o077)
      )
        throw Error("private_context_required");
      config.caller = callerSchema.parse(
        JSON.parse(await readFile(env.MCP_SERVER_CONFIG_FILE, "utf8")),
      );
    } catch {
      throw new MemoryError(
        "invalid_caller_context",
        "The trusted host context must be a bounded, private identity file.",
      );
    }
  }
  if (![undefined, "true", "false"].includes(env.MEMORY_REQUIRE_USER_CONTEXT))
    throw new MemoryError(
      "invalid_config",
      "Choose true or false for required user context.",
    );
  if (env.MEMORY_REQUIRE_USER_CONTEXT === "true" && !config.caller)
    throw new MemoryError(
      "identity_required",
      "This deployment requires a trusted host identity file.",
    );
  const baseUrl = env.MEMORY_EMBEDDING_BASE_URL;
  if (baseUrl) {
    const model = env.MEMORY_EMBEDDING_MODEL,
      profileId = env.MEMORY_EMBEDDING_PROFILE;
    const dimensions = Number(env.MEMORY_EMBEDDING_DIMENSIONS);
    const authHeader = env.MEMORY_EMBEDDING_AUTH_HEADER ?? "bearer";
    const sendDimensions = env.MEMORY_EMBEDDING_SEND_DIMENSIONS ?? "false";
    if (
      !model ||
      !profileId ||
      !Number.isInteger(dimensions) ||
      dimensions < 1 ||
      dimensions > 8192 ||
      !["bearer", "api-key"].includes(authHeader) ||
      !["true", "false"].includes(sendDimensions)
    )
      throw new MemoryError(
        "invalid_embedding_profile",
        "An embedding endpoint needs an explicit model, immutable profile identifier, dimensions and supported auth-header mode.",
      );
    const key = await secret(env, "MEMORY_EMBEDDING_API_KEY");
    config.embedding = {
      baseUrl,
      model,
      profileId,
      dimensions,
      sendDimensions: sendDimensions === "true",
      authHeader: authHeader === "api-key" ? "api-key" : "bearer",
      ...(key ? { key } : {}),
      ...(env.MEMORY_EMBEDDING_CA_FILE
        ? { caFile: env.MEMORY_EMBEDDING_CA_FILE }
        : {}),
    };
    const name = env.MEMORY_VECTOR_INDEX;
    if (!name || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))
      throw new MemoryError(
        "invalid_search_config",
        "An explicit native MEMORY_VECTOR_INDEX is required with embeddings.",
      );
    const management = env.MEMORY_VECTOR_INDEX_INTERFACE ?? "aggregation";
    if (management !== "command" && management !== "aggregation")
      throw new MemoryError(
        "invalid_search_config",
        "Choose the command or aggregation native index interface.",
      );
    config.search = { name, dimensions, management };
  } else if (
    Object.keys(env).some((k) => k.startsWith("MEMORY_EMBEDDING_") && env[k])
  ) {
    throw new MemoryError(
      "invalid_embedding_profile",
      "Embedding settings require an explicit endpoint; no provider is chosen implicitly.",
    );
  }
  if (
    (env.MEMORY_VECTOR_INDEX || env.MEMORY_VECTOR_INDEX_INTERFACE) &&
    !baseUrl
  )
    throw new MemoryError(
      "invalid_search_config",
      "A native vector index requires its embedding profile.",
    );
  return config;
}
