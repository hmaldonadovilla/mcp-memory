// A namespace graph is one atomic MongoDB document: graph, fact vectors and revision settle together.
import { BSON, MongoClient, MongoServerError } from "mongodb";
import type { Collection } from "mongodb";
import { emptySnapshot, MemoryError, snapshotSchema } from "./model.js";
import type { GraphStore, Snapshot } from "./model.js";
import { MongoVectorIndex, prepareVectorIndex } from "./vector-index.js";
import type { SearchSettings } from "./vector-index.js";

type Document = Snapshot & { _id: string };
// Session startup validates metadata only; semantic sessions never hydrate the vector snapshot.
const metadataSchema = snapshotSchema
  .pick({ schemaVersion: true, revision: true, profile: true })
  .strip();
export class MongoGraphStore implements GraphStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<Document>,
    private readonly namespace: string,
    private readonly index?: MongoVectorIndex,
  ) {}
  static async connect(
    uri: string,
    database: string,
    namespace: string,
    caFile?: string,
    search?: SearchSettings,
  ): Promise<GraphStore> {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      retryWrites: false,
      ...(caFile ? { tls: true, tlsCAFile: caFile } : {}),
    });
    try {
      await client.connect();
      const collection = client
        .db(database)
        .collection<Document>("memory_graphs");
      await collection.updateOne(
        { _id: namespace },
        { $setOnInsert: emptySnapshot() },
        { upsert: true, writeConcern: { w: "majority" } },
      );
      const index = search
        ? new MongoVectorIndex(client.db(database), namespace, search)
        : undefined;
      if (index) await index.ready();
      metadataSchema.parse(
        await collection.findOne(
          { _id: namespace },
          { projection: { _id: 0, schemaVersion: 1, revision: 1, profile: 1 } },
        ),
      );
      return new MongoGraphStore(client, collection, namespace, index);
    } catch (error) {
      await client.close();
      if (
        error instanceof MemoryError &&
        error.code.startsWith("search_index_")
      )
        throw error;
      throw new MemoryError(
        "persistence_unavailable",
        "MongoDB initialization failed; verify connectivity, credentials and certificate trust.",
      );
    }
  }
  async load(): Promise<Snapshot> {
    try {
      const doc = await this.collection.findOne({ _id: this.namespace });
      if (!doc) throw new Error("missing_graph");
      const { _id, ...state } = doc;
      void _id;
      return snapshotSchema.parse(state);
    } catch {
      throw new MemoryError(
        "persistence_unavailable",
        "Memory could not be read or its stored schema is invalid.",
      );
    }
  }
  async commit(
    expectedRevision: number,
    next: Snapshot,
    previous?: Snapshot,
  ): Promise<void> {
    if (next.profile && !this.index)
      throw new MemoryError(
        "native_search_required",
        "Configure the native index before modifying embedded memory.",
      );
    const validated = snapshotSchema.parse(next);
    if (validated.revision !== expectedRevision + 1)
      throw new MemoryError(
        "invalid_revision",
        "A write must advance the graph revision exactly once.",
      );
    const document: Document = { _id: this.namespace, ...validated };
    if (BSON.calculateObjectSize(document) > 14 * 1024 * 1024)
      throw new MemoryError(
        "graph_limit",
        "Namespace graph exceeds the 14 MiB storage allowance; partition or archive memory before adding more.",
      );
    const session = this.index ? this.client.startSession() : undefined;
    let committing = false;
    try {
      if (session)
        session.startTransaction({ writeConcern: { w: "majority" } });
      const result = await this.collection.replaceOne(
        { _id: this.namespace, revision: expectedRevision },
        document,
        session ? { session } : { writeConcern: { w: "majority" } },
      );
      if (!result.acknowledged || result.matchedCount !== 1)
        throw new MemoryError(
          "write_conflict",
          "The graph changed concurrently. Read the current graph before retrying the operation.",
        );
      if (this.index && session) {
        if (!previous)
          throw new MemoryError(
            "invalid_revision",
            "Native graph commits require the previous snapshot.",
          );
        await this.index.update(previous, next, session);
        committing = true;
        await session.commitTransaction();
      }
    } catch (error) {
      if (session && !committing)
        await session.abortTransaction().catch(() => {});
      if (error instanceof MemoryError) throw error;
      if (
        !committing &&
        error instanceof MongoServerError &&
        [112, 11000].includes(Number(error.code))
      )
        throw new MemoryError(
          "write_conflict",
          "MongoDB rejected a conflicting transaction; read current state before another mutation.",
        );
      throw new MemoryError(
        "write_outcome_unknown",
        "MongoDB did not confirm the write outcome. Read current memory before retrying.",
      );
    } finally {
      await session?.endSession();
    }
  }
  async search(
    vector: number[],
    profile: string,
    topK: number,
    minScore: number,
    signal?: AbortSignal,
  ) {
    if (!this.index)
      throw new MemoryError(
        "native_search_required",
        "Configure a native vector index before semantic retrieval.",
      );
    return this.index.search(vector, profile, topK, minScore, signal);
  }
  static async prepare(
    uri: string,
    database: string,
    search: SearchSettings,
    caFile?: string,
  ): Promise<void> {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      retryWrites: false,
      ...(caFile ? { tls: true, tlsCAFile: caFile } : {}),
    });
    try {
      await client.connect();
      await prepareVectorIndex(client.db(database), search);
    } finally {
      await client.close();
    }
  }
  async close(): Promise<void> {
    await this.client.close();
  }
}
