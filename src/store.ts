// A namespace graph is one atomic MongoDB document: graph, fact vectors and revision settle together.
import { BSON, MongoClient } from "mongodb";
import type { Collection } from "mongodb";
import { emptySnapshot, MemoryError, snapshotSchema } from "./model.js";
import type { GraphStore, Snapshot } from "./model.js";

type Document = Snapshot & { _id: string };
export class MongoGraphStore implements GraphStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<Document>,
    private readonly namespace: string,
  ) {}
  static async connect(
    uri: string,
    database: string,
    namespace: string,
    caFile?: string,
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
      const store = new MongoGraphStore(client, collection, namespace);
      await store.load();
      return store;
    } catch {
      await client.close();
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
  async commit(expectedRevision: number, next: Snapshot): Promise<void> {
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
    try {
      const result = await this.collection.replaceOne(
        { _id: this.namespace, revision: expectedRevision },
        document,
        { writeConcern: { w: "majority" } },
      );
      if (!result.acknowledged || result.matchedCount !== 1)
        throw new MemoryError(
          "write_conflict",
          "The graph changed concurrently. Read the current graph before retrying the operation.",
        );
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError(
        "write_outcome_unknown",
        "MongoDB did not confirm the write outcome. Read current memory before retrying.",
      );
    }
  }
  async close(): Promise<void> {
    await this.client.close();
  }
}
