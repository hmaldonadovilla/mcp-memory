# MCP Memory

A standalone fork of the MCP knowledge-graph memory server with durable MongoDB persistence and observation-level semantic retrieval. It serves the same graph through **stdio/npx** and **Streamable HTTP**, using the official SDK for current (2026-07-28) and 2025-era MCP clients.

This is an independent project. Upstream history, attribution and the complete license are retained; see [provenance](docs/upstream.json) and [design](docs/design.md). New implementation code is Apache-2.0 under the terms in [LICENSE](LICENSE).

## Run

Requires Node **24.19+**, Git for GitHub-source installation, and MongoDB **8+**. MongoDB is the system of record; unavailable persistence prevents startup. There is no in-memory production fallback. A graph-only server needs no embedding key.

Install directly from the public GitHub source with npm/npx:

```sh
npx --yes --package=git+https://github.com/hmaldonadovilla/mcp-memory.git mcp-memory --help
```

For repeatable installations, pin a release tag or commit after `#` in the Git URL. The npm registry package name is `@hmaldonadovilla/mcp-memory`; registry publication is a separate release action. A verified `.tgz` can also be installed with `npm install /path/to/package.tgz`, then run with `npx --no-install mcp-memory`.

Configure MongoDB and a server-controlled authorization namespace, then start stdio:

```sh
export MEMORY_MONGODB_URI_FILE=/run/secrets/mongodb-uri
export MEMORY_DATABASE=mcp_memory
export MEMORY_NAMESPACE=personal-memory
npx --yes --package=git+https://github.com/hmaldonadovilla/mcp-memory.git mcp-memory
```

An MCP client configuration uses the same command:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=git+https://github.com/hmaldonadovilla/mcp-memory.git",
        "mcp-memory"
      ],
      "env": {
        "MEMORY_MONGODB_URI_FILE": "/run/secrets/mongodb-uri",
        "MEMORY_NAMESPACE": "personal-memory"
      }
    }
  }
}
```

### Streamable HTTP

```sh
export MEMORY_HTTP_TOKEN_FILE=/run/secrets/memory-http-token
export MEMORY_HOST=127.0.0.1
export MEMORY_PORT=3001
npx --yes --package=git+https://github.com/hmaldonadovilla/mcp-memory.git mcp-memory --transport http
```

Connect an MCP client to `http://127.0.0.1:3001/mcp` with `Authorization: Bearer <token>`. The token file must contain an opaque credential of at least 32 characters. Every MCP request is authenticated, including discovery. The namespace is fixed by server configuration; every holder of that server credential has access to that authorization realm. Use separate namespaces/credentials/listeners for separate realms, or build a trusted identity adapter using the public server/store factories. This release does not implement OAuth or infer authorization from model arguments, a session ID or forwarded headers.

The listener is loopback by default. Binding another interface requires an explicit `MEMORY_ALLOWED_HOSTS` list. For a TLS reverse proxy, configure its exact host (including port when present) and approved origins. Unapproved Host and Origin headers are rejected before dispatch. This is a server-to-server endpoint; browser CORS access is not enabled. `/healthz` reports persistence availability without returning memory. GET/DELETE session operations on `/mcp` return 405: the current protocol is sessionless and older clients use stateless compatibility. Deprecated HTTP+SSE is not implemented.

### Container

`docker build -t mcp-memory:0.3.0 .` builds the same executable with production dependencies and an unprivileged user. To supply a corporate CA during dependency installation, add `--secret id=ca_bundle,src=/path/to/trusted-ca-bundle.pem`; the build secret is not copied into the image. At runtime, mount credentials/CAs read-only under `/run/secrets`, make them readable by the container user, and set the same environment references. A container HTTP listener needs `MEMORY_HOST=0.0.0.0` and explicit `MEMORY_ALLOWED_HOSTS`; publish its port only on the intended interface.

## Semantic retrieval

Graph operations and literal `search_nodes` work without a provider. `semantic_search` is explicit and requires a real OpenAI-compatible **embeddings** endpoint. For Azure Foundry v1:

```sh
export MEMORY_EMBEDDING_BASE_URL=https://your-resource.services.ai.azure.com/openai/v1
export MEMORY_EMBEDDING_MODEL=your-embedding-deployment
export MEMORY_EMBEDDING_PROFILE=your-reviewed-embedding-profile-v1
export MEMORY_EMBEDDING_DIMENSIONS=1536
export MEMORY_EMBEDDING_API_KEY_FILE=/run/secrets/embedding-api-key
export MEMORY_VECTOR_INDEX=memory_semantic_v3
# MongoDB Community uses its native command for scoped index discovery.
export MEMORY_VECTOR_INDEX_INTERFACE=command
```

Use the configured provider's actual embedding model and dimensions. A local OpenAI-compatible embeddings service uses the same interface. Completion/Responses model deployments are not embedding models. Keys and endpoint selection are operator configuration, never tool arguments. `MEMORY_EMBEDDING_AUTH_HEADER` selects `bearer` (default) or `api-key`; an explicitly configured private service may omit a key. `dimensions` is sent only with `MEMORY_EMBEDDING_SEND_DIMENSIONS=true`, for providers that support dimension reduction. Returned dimensions, indices, finite values and nonzero norms are always validated.

Each entity has a name/type vector; each unique fact has a vector of its entity name/type plus fact text, immutable fact identifier, timestamp and optional source provenance. Search returns bounded ranked evidence with cosine scores, fact/version references and the selected entities/relations. A score measures similarity, not truth. Expired observations are excluded from retrieval. Public graph/tool responses never include stored vectors or provider credentials.

Missing credentials, provider errors, timeouts and incompatible profiles are explicit errors. No fake embeddings, lexical fallback, provider retry or hidden model selection occurs. Graph mutations do not settle until the corresponding vectors are ready. A failed provider call leaves stored graph state unchanged.

### Existing facts and profile changes

Semantic retrieval requires a native MongoDB Vector Search deployment: Atlas with search enabled, or a compatible self-managed MongoDB/mongot pair and replica set. MongoDB 8.0 alone does not provide this backend. Operators first provision the ordinary identity and native cosine index using a DDL-capable credential:

```bash
npx --yes @hmaldonadovilla/mcp-memory --prepare-index
```

The command creates a missing index, waits for READY, and rejects dimension, metric or filter drift. The serving credential needs find/insert/update on `memory_graphs`, find/insert/update/remove/listSearchIndexes on `memory_index`, and read-only access to its team directory. Index provisioning stays operator-only.

Enabling semantic retrieval over existing literal or 0.1.0 facts, or changing endpoint/model/profile/dimensions, requires a deliberate reindex:

```sh
npx --yes --package=git+https://github.com/hmaldonadovilla/mcp-memory.git mcp-memory --reindex --max-facts 64
```

This is an operator command, not an agent tool. It embeds all stored facts within the explicit allowance (1–10,000, default 64), plus at most 1,000 entity headers, in batches of at most 64. The old graph/index remains intact until the complete new snapshot commits atomically. Concurrent writes produce a conflict; read current state before retrying. A read-only deployment cannot reindex. Stored profiles include an endpoint/model/dimension fingerprint in addition to the operator's immutable profile identifier.

## User identity and fact permissions

A trusted host can bind a user to a private `0600` JSON file referenced by `MCP_SERVER_CONFIG_FILE`:

```json
{
  "mode": "user",
  "tenant_id": "tenant-id",
  "user_id": "stable-framework-user-id",
  "conversation_id": "conversation:source",
  "task_id": "task:source",
  "scope_ref": "approved-business-scope"
}
```

Set `MEMORY_REQUIRE_USER_CONTEXT=true` on shared framework deployments, `MEMORY_NAMESPACE` to a stable operator-controlled realm, and `MEMORY_DIRECTORY_DATABASE` to the identity database (defaults to `MEMORY_DATABASE`). The host must derive these fields from verified authorization and scoped conversation records; never accept identity, memberships or database selection as model/tool arguments. Discovery supplies `{"mode":"discovery"}` and may list/ping tools but cannot read, write or embed a query.

New facts are `user` private across the same user's conversations in the approved realm/scope. Original creator, conversation and task provenance are immutable. `team` shares a specific fact with one or more selected active teams; `global` shares within the tenant and approved realm/scope. The creator alone may change sharing using `set_memory_permissions`. Create/add results return the newly written facts' `fact_metadata.ref` values immediately. For existing facts, first retrieve their current references; stale references, foreign-owned facts and unapproved teams are rejected. Deleting/recreating a fact creates a new generation, invalidating its old references. No sharing is inferred from fact text. Models should change permissions only on an explicit user request.

The operator/framework owns `memory_teams` (`_id`, `tenant_id`, `name`, `status`) and `memory_team_memberships` (`tenant_id`, `user_id`, `team_id`, `status`). The serving credential receives **read only** on both. Only active team rows and active memberships count. Users may belong to multiple independent workgroups. Current memberships are read on every operation and checked again before disclosing retrieved results. Native search applies visibility prefilters and authoritative graph filtering so stale search projections cannot restore revoked access. Foreign readers receive only shared facts; private subjects, relations, source conversation/task identifiers and unrelated team IDs are withheld.

Without a required host context the standalone server remains an explicit fixed realm, suitable for a single trusted operator. Its shared HTTP bearer token authorizes that realm; it does not identify different people. Creator/team sharing requires verified user context. A multi-user gateway must authenticate callers and supply isolated user-bound stores/servers rather than treating one workload token as many users.

**Upgrade from 0.1/0.2:** back up first and perform a reviewed ownership/provenance migration to `storage_version: 3` and `memory_index`. The server never guesses legacy owners, adopts unscoped graphs or automatically makes old facts global. The embedding profile can remain unchanged when existing compatible vectors are copied to the new index; remove legacy graph vectors and the old projection only after verification. `--reindex` handles embedding/profile changes after ownership is established, not ownership migration.

## Tools

| Tool                     | Behavior                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_entities`        | Create new names with unique observations; ignore existing entities. Optional `subjects` and `source` attach subject associations and claimed provenance. |
| `create_relations`       | Create unique directed edges; both endpoints must exist.                                                                                                  |
| `add_observations`       | Add unique facts to existing entities; missing targets fail the whole operation.                                                                          |
| `delete_entities`        | Atomically delete nodes, vectors and incident edges.                                                                                                      |
| `delete_observations`    | Atomically remove exact facts and their vectors.                                                                                                          |
| `delete_relations`       | Remove matching directed edges.                                                                                                                           |
| `read_graph`             | Read the authorized namespace's bounded current graph.                                                                                                    |
| `open_nodes`             | Read named nodes and edges between selected nodes.                                                                                                        |
| `search_nodes`           | Upstream-compatible literal search; optional entity `limit` (1–50).                                                                                       |
| `lookup_subject`         | Exact `subject` association lookup, without embedding a subject ID; optional `limit`.                                                                     |
| `list_memory_teams`      | List current active teams from the framework/operator directory.                                                                                          |
| `set_memory_permissions` | Creator-only visibility changes using current fact references and selected teams.                                                                         |
| `semantic_search`        | Real embedding retrieval with `query`, `topK` (1–50) and `minScore` (cosine −1 through 1).                                                                |

The `memory://knowledge-graph` resource exposes the same bounded public graph. Resource subscriptions are not advertised. `MEMORY_READ_ONLY=true` exposes the six read-only tools (including team lookup) and the resource. All inputs are strict schemas; namespace, database, provider and credentials cannot be overridden through arguments. See [the framework integration contract](docs/integration.md).

Example entity:

```json
{
  "name": "editor-preference",
  "entityType": "preference",
  "subjects": ["user-123"],
  "observations": ["Prefers concise code-review explanations"],
  "source": {
    "source": "conversation",
    "sourceId": "turn-42",
    "validUntil": "2027-01-01T00:00:00Z"
  }
}
```

Source metadata is claimed provenance, not independent verification. The trusted host identity and stored fact permissions govern access; `subjects` is a private retrieval association, not an access-control list.

## Configuration and certificate trust

| Setting                                          | Default / purpose                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `MEMORY_MONGODB_URI_FILE` / `MEMORY_MONGODB_URI` | Prefer a mounted secret file; default is credential-free `mongodb://127.0.0.1:27017`. Set one form only. |
| `MEMORY_DATABASE` / `MEMORY_NAMESPACE`           | `mcp_memory` / `default`; fixed by operator.                                                             |
| `MEMORY_MONGODB_CA_FILE`                         | Mounted database CA bundle; also enables TLS.                                                            |
| `MEMORY_EMBEDDING_CA_FILE`                       | Additional embedding CA bundle, appended to Node's default trust roots.                                  |
| `MEMORY_HTTP_TOKEN_FILE` / `MEMORY_HTTP_TOKEN`   | Required for HTTP; prefer a mounted secret.                                                              |
| `MEMORY_HOST` / `MEMORY_PORT`                    | `127.0.0.1` / `3001`.                                                                                    |
| `MEMORY_ALLOWED_HOSTS`                           | Exact comma-separated host:port values for non-loopback/proxy deployments.                               |
| `MEMORY_ALLOWED_ORIGINS`                         | Exact comma-separated scheme/host/port origins; otherwise loopback listener origins only. No wildcard.   |
| `MEMORY_READ_ONLY`                               | `false`; only `true` or `false`.                                                                         |

Corporate laptops can use Node's system-CA option (`NODE_USE_SYSTEM_CA=1`) or `NODE_EXTRA_CA_CERTS` at process startup. Explicit mounted CA bundles remain useful in WSL and containers whose trust stores differ from the host. Keep the full required chain in the database CA bundle. Certificate and hostname verification stay enabled; `NODE_TLS_REJECT_UNAUTHORIZED=0` and MongoDB verification-bypass options are rejected. No corporate certificate is distributed in the repository or package.

## Limits and storage model

**All similarity ranking runs in MongoDB through `$vectorSearch`.** The MCP embeds the query and submits a bounded native ANN query, with tenant, realm, approved scope, owner/team/global visibility, embedding-profile and validity prefilters. Native scores are converted to cosine scores inside the aggregation pipeline. There is no process-side distance calculation, vector scan or fallback.

MongoDB retains authoritative fact text, provenance, permissions and relations in `memory_graphs`. It stores each entity/fact embedding exactly once in `memory_index`, with identifiers and minimal authorization metadata. Graph documents contain no vectors, and the search collection contains no duplicate fact text or source records. Ordinary mutations retain unchanged embeddings; permission changes never call the embedding provider. A replica-set transaction commits the graph revision and vector deltas together. Similarity search reads only metadata and bounded matches, then hydrates selected public entities/relations in MongoDB; it does not load the graph/vector snapshot into the MCP. Index synchronization is asynchronous: a just-written fact can take time to become searchable. Authoritative hydration excludes deleted or stale facts. Conflicts are explicit; unconfirmed writes require reconciliation.

The graph is limited to 14 MiB BSON, 1,000 entities, 5,000 relations and 200 observations per entity. Each normal mutation may introduce at most 64 entity/fact vectors. Embedding inputs are at most 8,192 UTF-8 bytes each, with a 30-second request timeout and a 16 MiB provider-response allowance. Provider token limits still apply. HTTP bodies are limited to 1 MiB and tool/resource results to 256 KiB. Oversized results fail explicitly; use narrower retrieval. Facts are never silently truncated. This is a scoped memory graph, not a large knowledge warehouse. An independently qualified per-record/indexed backend is a future extension behind the store boundary.

## Develop and verify

```sh
npm ci
npm run local:gate
```

The gate runs formatting, lint, strict types, unit/protocol tests with independent 90% coverage floors, the build, real MongoDB integration and installation/npx smoke from the exact tarball, plus a production-only container entry-point/user check. Docker supplies a disposable loopback-only MongoDB 8.3.4 replica set and mongot 1.70.1; both are removed after each command. An explicit credential-free `MEMORY_TEST_MONGODB_URI=mongodb://127.0.0.1:PORT/?directConnection=true` can point to an owned isolated test replica set with native search already configured. Tests only write their isolated `mcp_memory_tests` namespaces. Embeddings and certificates are local synthetic fixtures; tests need no provider account or paid calls. Node 24 and 26 run in CI.

See [release instructions](RELEASING.md). Framework Insights/compression, deployment infrastructure, OAuth and large-scale/load qualification are outside this release.

MongoDB also requires a compatible host kernel, including when run in Docker. The current 6.19–7.0.13 incompatibility and supported alternatives are documented in the [MongoDB production notes](https://www.mongodb.com/docs/v8.0/administration/production-notes/). CI uses Ubuntu 22.04 to retain real MongoDB checks on a supported kernel; the test runner never bypasses MongoDB's startup guard.

`MEMORY_VECTOR_INDEX_INTERFACE` selects native index discovery: `command` for MongoDB Community, or `aggregation` (default) for Atlas. Both keep index checks in the database; neither grants the MCP index creation privileges.
