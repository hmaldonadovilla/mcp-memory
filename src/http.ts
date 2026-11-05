// Streamable HTTP uses the SDK's era negotiation behind exact Host/Origin checks and a scoped bearer credential.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { MemoryGraph } from "./graph.js";
import { MemoryError } from "./model.js";
import type { GraphStore } from "./model.js";
import { createMemoryServer } from "./server.js";

export async function serveHttp(
  graph: MemoryGraph,
  store: GraphStore,
  config: Config,
) {
  if (!config.token)
    throw new MemoryError(
      "http_auth_required",
      "Streamable HTTP requires a mounted MEMORY_HTTP_TOKEN_FILE or an explicit MEMORY_HTTP_TOKEN.",
    );
  if (
    !["127.0.0.1", "localhost", "::1"].includes(config.host) &&
    !config.allowedHosts.length
  )
    throw new MemoryError(
      "http_hosts_required",
      "A non-loopback listener requires explicit MEMORY_ALLOWED_HOSTS.",
    );
  const tokenDigest = hash("Bearer " + config.token);
  const handler = createMcpHandler(
    () => createMemoryServer(graph, config.readOnly),
    {
      legacy: "stateless",
      maxRequestBodySize: 1048576,
      maxSubscriptions: 16,
      onerror: () =>
        console.error(
          "mcp-memory: MCP transport rejected a request; request details suppressed.",
        ),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: 1048576,
    onerror: () =>
      console.error(
        "mcp-memory: HTTP transport error; request details suppressed.",
      ),
  });
  let inFlight = 0;
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 35000, headersTimeout: 10000 },
    (request, response) => {
      const address = server.address();
      const port =
        address && typeof address !== "string" ? address.port : config.port;
      const hosts = config.allowedHosts.length
        ? config.allowedHosts
        : [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      const origins = config.allowedOrigins.length
        ? config.allowedOrigins
        : hosts.map((h) => "http://" + h);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (
        !request.headers.host ||
        !hosts.includes(request.headers.host) ||
        (request.headers.origin !== undefined &&
          !origins.includes(request.headers.origin))
      ) {
        reply(response, 403, "origin_or_host_denied");
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        store
          .load()
          .then(() => reply(response, 200, "ok"))
          .catch(() => reply(response, 503, "persistence_unavailable"));
        return;
      }
      if (request.url !== "/mcp") {
        reply(response, 404, "not_found");
        return;
      }
      if (
        !timingSafeEqual(hash(request.headers.authorization ?? ""), tokenDigest)
      ) {
        response.setHeader("WWW-Authenticate", "Bearer");
        reply(response, 401, "authentication_required");
        return;
      }
      if (inFlight >= 64) {
        reply(response, 503, "request_capacity");
        return;
      }
      inFlight++;
      // SDK optional properties exclude explicit undefined; Node's IncomingMessage permits it.
      const incoming = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      };
      nodeHandler(incoming, response)
        .catch(() => {
          if (!response.headersSent) reply(response, 500, "transport_error");
          else response.destroy();
        })
        .finally(() => {
          inFlight--;
        });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    server,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function reply(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code }));
}
