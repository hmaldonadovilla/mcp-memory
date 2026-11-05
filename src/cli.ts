// Separate configuration/startup from the tiny executable so both transports and failure cleanup are testable.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { OpenAICompatibleEmbeddings } from "./embeddings.js";
import { MemoryGraph } from "./graph.js";
import { serveHttp } from "./http.js";
import { MemoryError } from "./model.js";
import { createMemoryServer, VERSION } from "./server.js";
import { MongoGraphStore } from "./store.js";

const HELP = `mcp-memory ${VERSION}
Usage: mcp-memory [--transport stdio|http] [--help] [--version]
       mcp-memory --reindex --max-facts 64

MongoDB: MEMORY_MONGODB_URI_FILE (or MEMORY_MONGODB_URI), MEMORY_DATABASE, MEMORY_NAMESPACE.
HTTP: MEMORY_HTTP_TOKEN_FILE, MEMORY_HOST (127.0.0.1), MEMORY_PORT (3001).
Semantic retrieval: MEMORY_EMBEDDING_BASE_URL, MEMORY_EMBEDDING_MODEL,
MEMORY_EMBEDDING_PROFILE, MEMORY_EMBEDDING_DIMENSIONS, MEMORY_EMBEDDING_API_KEY_FILE.
CA bundles: MEMORY_MONGODB_CA_FILE, MEMORY_EMBEDDING_CA_FILE; NODE_EXTRA_CA_CERTS
and Node's system CA options remain available. TLS verification is always required.
See https://github.com/hmaldonadovilla/mcp-memory for configuration and limits.`;

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  output: (text: string) => void = console.log,
) {
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        transport: { type: "string", default: "stdio" },
        help: { type: "boolean" },
        version: { type: "boolean" },
        reindex: { type: "boolean" },
        "max-facts": { type: "string", default: "64" },
      },
      strict: true,
    }).values;
  } catch {
    throw new MemoryError(
      "invalid_arguments",
      "Unrecognized command arguments; use --help.",
    );
  }
  if (values.help) {
    output(HELP);
    return;
  }
  if (values.version) {
    output(VERSION);
    return;
  }
  if (!["stdio", "http"].includes(values.transport))
    throw new MemoryError(
      "invalid_arguments",
      "Transport must be stdio or http.",
    );
  const maxFacts = Number(values["max-facts"]);
  if (!Number.isInteger(maxFacts) || maxFacts < 1 || maxFacts > 10000)
    throw new MemoryError(
      "invalid_arguments",
      "Reindex allowance must be an integer from 1 through 10,000.",
    );
  const config = await loadConfig(env);
  if (values.reindex && config.readOnly)
    throw new MemoryError(
      "read_only",
      "A read-only deployment cannot reindex memory.",
    );
  if (values.transport === "http" && !config.token)
    throw new MemoryError(
      "http_auth_required",
      "HTTP requires an explicitly configured bearer credential.",
    );
  const store = await MongoGraphStore.connect(
    config.uri,
    config.database,
    config.namespace,
    config.caFile,
  );
  let embeddings: OpenAICompatibleEmbeddings | undefined;
  try {
    if (config.embedding)
      embeddings = await OpenAICompatibleEmbeddings.create(config.embedding);
  } catch (error) {
    await store.close();
    throw error;
  }
  const graph = new MemoryGraph(store, embeddings);
  const closeData = async () => {
    try {
      await embeddings?.close();
    } finally {
      await store.close();
    }
  };
  if (values.reindex) {
    try {
      output(JSON.stringify(await graph.reindex(maxFacts)));
    } finally {
      await closeData();
    }
    return;
  }
  try {
    const transport =
      values.transport === "http"
        ? await serveHttp(graph, store, config)
        : serveStdio(() => createMemoryServer(graph, config.readOnly), {
            onerror: () =>
              console.error(
                "mcp-memory: stdio transport error; request details suppressed.",
              ),
          });
    let closing: Promise<void> | undefined;
    return {
      transport: values.transport,
      close: () => {
        closing ??= (async () => {
          try {
            await transport.close();
          } finally {
            await closeData();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await closeData();
    throw error;
  }
}
export function safeError(error: unknown): string {
  return error instanceof MemoryError
    ? `${error.code}: ${error.message}`
    : "server_failed: The server could not confirm completion; check configuration and dependencies.";
}
