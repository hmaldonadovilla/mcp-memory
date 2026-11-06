// Register the upstream graph vocabulary plus explicit semantic and subject retrieval on one factory.
import { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  bounded,
  entityInput,
  MemoryError,
  name,
  observation,
  relationSchema,
  sourceSchema,
} from "./model.js";
import { changePermissionsSchema } from "./access.js";
import type { MemoryGraph } from "./graph.js";

export const VERSION = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
  ).version;
export const RESOURCE_URI = "memory://knowledge-graph";
export function createMemoryServer(
  graph: MemoryGraph,
  readOnly = false,
): McpServer {
  const server = new McpServer({ name: "mcp-memory", version: VERSION });
  function register<S extends z.ZodObject>(
    tool: string,
    description: string,
    schema: S,
    read: boolean,
    destructive: boolean,
    operation: (input: z.output<S>, signal: AbortSignal) => Promise<unknown>,
    idempotent = true,
  ) {
    const inputSchema: z.ZodObject = schema;
    server.registerTool(
      tool,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: read,
          destructiveHint: destructive,
          idempotentHint: idempotent,
          openWorldHint: false,
        },
      },
      async (input, ctx) => {
        try {
          const value = bounded(
            await operation(schema.parse(input), ctx.mcpReq.signal),
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
          };
        } catch (error) {
          const code =
            error instanceof MemoryError ? error.code : "operation_failed";
          const message =
            error instanceof MemoryError
              ? error.message
              : "The memory operation could not be confirmed. Read current memory before retrying a mutation.";
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ code, message }),
              },
            ],
          };
        }
      },
    );
  }
  const limit = z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum selected entities");
  register(
    "read_graph",
    "Read this authorized namespace's current graph. Large results require narrower retrieval.",
    z.strictObject({}),
    true,
    false,
    () => graph.readGraph(),
  );
  register(
    "open_nodes",
    "Retrieve named entities and only relations between the selected entities.",
    z.strictObject({
      names: z.array(name).max(50).describe("Exact entity names"),
    }),
    true,
    false,
    (args) => graph.openNodes(args.names),
  );
  register(
    "search_nodes",
    "Upstream-compatible literal search of names, types and current observations; does not call an embedding provider.",
    z.strictObject({
      query: observation.describe("Literal text to find"),
      limit,
    }),
    true,
    false,
    (args) => graph.searchNodes(args.query, args.limit),
  );
  register(
    "lookup_subject",
    "Look up facts associated with an exact subject identifier inside the authorized namespace; never embed a user ID.",
    z.strictObject({
      subject: name.describe("Exact subject identifier"),
      limit,
    }),
    true,
    false,
    (args) => graph.lookupSubject(args.subject, args.limit),
  );
  register(
    "semantic_search",
    "Retrieve scored observation evidence using the configured real embedding profile; similarity is not factual confidence.",
    z.strictObject({
      query: observation.describe(
        "Text to embed and compare with stored observations",
      ),
      topK: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum scored observations"),
      minScore: z
        .number()
        .min(-1)
        .max(1)
        .default(0.25)
        .describe("Minimum cosine similarity"),
    }),
    true,
    false,
    (args, signal) =>
      graph.semanticSearch(args.query, args.topK, args.minScore, signal),
  );
  register(
    "list_memory_teams",
    "List your current framework-managed teams before choosing which teams may read a fact.",
    z.strictObject({}),
    true,
    false,
    () => graph.listMemoryTeams(),
  );
  if (!readOnly) {
    register(
      "set_memory_permissions",
      "Change visibility of your own facts using current fact_metadata.ref values from retrieval. User is private across your conversations, team requires selected team_ids from list_memory_teams, global shares within the tenant and authorized realm. Read current references again after any change. Never share without the user's request.",
      changePermissionsSchema,
      false,
      true,
      (args) => graph.setMemoryPermissions(args),
      false,
    );
    register(
      "create_entities",
      "Create entities, ignoring names that already exist. Persist facts and vectors together.",
      z.strictObject({ entities: z.array(entityInput).max(50) }),
      false,
      false,
      (args, signal) => graph.createEntities(args.entities, signal),
    );
    register(
      "create_relations",
      "Create unique directed relations; both endpoints must already exist.",
      z.strictObject({ relations: z.array(relationSchema).max(100) }),
      false,
      false,
      (args, signal) => graph.createRelations(args.relations, signal),
    );
    register(
      "add_observations",
      "Add unique facts to existing entities; duplicate facts do not skew semantic retrieval.",
      z.strictObject({
        observations: z
          .array(
            z.strictObject({
              entityName: name,
              contents: z.array(observation).max(64),
              source: sourceSchema.optional(),
            }),
          )
          .max(50),
      }),
      false,
      false,
      (args, signal) => graph.addObservations(args.observations, signal),
    );
    register(
      "delete_entities",
      "Delete entities and all incident relations atomically.",
      z.strictObject({ entityNames: z.array(name).max(100) }),
      false,
      true,
      (args, signal) => graph.deleteEntities(args.entityNames, signal),
    );
    register(
      "delete_observations",
      "Delete exact facts and their stored vectors atomically.",
      z.strictObject({
        deletions: z
          .array(
            z.strictObject({
              entityName: name,
              observations: z.array(observation).max(200),
            }),
          )
          .max(50),
      }),
      false,
      true,
      (args, signal) => graph.deleteObservations(args.deletions, signal),
    );
    register(
      "delete_relations",
      "Delete matching directed relations; missing relations are harmless.",
      z.strictObject({ relations: z.array(relationSchema).max(100) }),
      false,
      true,
      (args, signal) => graph.deleteRelations(args.relations, signal),
    );
  }
  server.registerResource(
    "knowledge-graph",
    RESOURCE_URI,
    { title: "Authorized memory graph", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: "application/json",
          text: JSON.stringify(await graph.readGraph()),
        },
      ],
    }),
  );
  return server;
}
