// Public factories allow a trusted host to supply authorization and lifecycle without importing private source.
export { MemoryGraph } from "./graph.js";
export { MongoGraphStore } from "./store.js";
export { OpenAICompatibleEmbeddings } from "./embeddings.js";
export { createMemoryServer, VERSION } from "./server.js";
export { serveHttp } from "./http.js";
export { MemoryError } from "./model.js";
export type {
  GraphStore,
  Embeddings,
  EntityInput,
  Relation,
  Snapshot,
  Source,
} from "./model.js";

export { actor, callerSchema } from "./access.js";
export type { Actor, CallerContext, PermissionChange, Team } from "./access.js";
