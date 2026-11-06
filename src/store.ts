// Owner graphs and their single canonical vector index settle atomically under host-supplied identity.
import { BSON, MongoClient, MongoServerError } from "mongodb";
import type { Collection, Document, Db } from "mongodb";
import {
  emptySnapshot,
  MemoryError,
  snapshotSchema,
  factRef,
} from "./model.js";
import type { GraphStore, Snapshot } from "./model.js";
import { MongoVectorIndex, prepareVectorIndex } from "./vector-index.js";
import type { SearchSettings } from "./vector-index.js";

import { actor, changePermissionsSchema } from "./access.js";
import type { Actor, CallerContext, PermissionChange } from "./access.js";
import { activeTeams } from "./directory.js";
import { graphBoundary, graphProjection } from "./visibility.js";
import { bindState, readState, withoutVectors } from "./state.js";
// Session startup validates metadata only; semantic sessions never hydrate the vector snapshot.
const metadataSchema = snapshotSchema
  .pick({ schemaVersion: true, revision: true, profile: true })
  .strip();
export class MongoGraphStore implements GraphStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<Document & { _id: string }>,
    private readonly who: Actor | undefined,
    private readonly directory: Db,
    private readonly index?: MongoVectorIndex,
  ) {}
  static async connect(
    uri: string,
    database: string,
    namespace: string,
    caFile?: string,
    search?: SearchSettings,
    caller?: CallerContext,
    directoryDatabase = database,
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
        .collection<Document & { _id: string }>("memory_graphs");
      const who =
        caller?.mode === "discovery" ? undefined : actor(namespace, caller);
      const directory = client.db(directoryDatabase);
      const index =
        search && who
          ? new MongoVectorIndex(
              client.db(database),
              who.namespace,
              search,
              who,
              directory,
            )
          : undefined;
      if (search)
        await (
          index ??
          new MongoVectorIndex(client.db(database), "discovery", search)
        ).ready();
      if (who) {
        const boundary = {
          _id: who.namespace,
          ...graphBoundary(who),
          owner_user_id: who.user_id,
        };
        await collection.updateOne(
          boundary,
          { $setOnInsert: emptySnapshot() },
          { upsert: true, writeConcern: { w: "majority" } },
        );
        metadataSchema.parse(
          await collection.findOne(boundary, {
            projection: { _id: 0, schemaVersion: 1, revision: 1, profile: 1 },
          }),
        );
      }
      return new MongoGraphStore(client, collection, who, directory, index);
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
  authorize(): void {
    this.identity();
  }
  private identity(): Actor {
    if (!this.who)
      throw new MemoryError(
        "identity_required",
        "Discovery cannot read or change memories.",
      );
    return this.who;
  }
  private boundary(): Document & { _id: string } {
    const who = this.identity();
    return {
      _id: who.namespace,
      ...graphBoundary(who),
      owner_user_id: who.user_id,
    };
  }
  async load(): Promise<Snapshot> {
    const boundary = this.boundary();
    try {
      const doc = await this.collection.findOne(boundary, {
        projection: { "entities.vector": 0, "entities.facts.vector": 0 },
      });
      if (!doc) throw new Error("missing_graph");
      return readState(doc);
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError(
        "persistence_unavailable",
        "Memory could not be read or its stored schema is invalid.",
      );
    }
  }
  async teams() {
    return activeTeams(this.directory, this.identity());
  }
  async view(): Promise<Snapshot> {
    const who = this.identity();
    try {
      const teams = (await this.teams()).map((team) => team.team_id);
      const docs = await this.collection
        .aggregate(
          [
            { $match: graphBoundary(who) },
            { $project: graphProjection(who, teams) },
            {
              $match: {
                $or: [
                  { _id: who.namespace },
                  { "entities.0": { $exists: true } },
                ],
              },
            },
            { $limit: 101 },
          ],
          { maxTimeMS: 10000 },
        )
        .toArray();
      if (docs.length > 100)
        throw new MemoryError(
          "result_limit",
          "Too many shared graphs; narrow retrieval using semantic search.",
        );
      const states = docs.map(readState);
      if (
        JSON.stringify(teams) !==
        JSON.stringify((await this.teams()).map((team) => team.team_id))
      )
        throw new MemoryError(
          "authorization_changed",
          "Team membership changed during retrieval; request current memory again.",
        );
      return snapshotSchema.parse({
        schemaVersion: 1,
        revision:
          states[docs.findIndex((doc) => doc._id === who.namespace)]
            ?.revision ?? 0,
        entities: states.flatMap((state) => state.entities),
        relations: states.flatMap((state) => state.relations),
      });
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      throw new MemoryError(
        "persistence_unavailable",
        "Authorized memory could not be read.",
      );
    }
  }
  async setPermissions(input: PermissionChange) {
    const who = this.identity();
    if (who.kind !== "user")
      throw new MemoryError(
        "identity_required",
        "Sharing requires a verified human user context.",
      );
    const change = changePermissionsSchema.parse(input);
    const teamIds = [...new Set(change.team_ids)].sort();
    if (
      (change.visibility === "team") !== teamIds.length > 0 ||
      (change.visibility !== "team" && teamIds.length)
    )
      throw new MemoryError(
        "invalid_permissions",
        "Team sharing requires selected teams; user and global sharing accept no teams.",
      );
    const teams = (await this.teams()).map((team) => team.team_id);
    if (teamIds.some((team) => !teams.includes(team)))
      throw new MemoryError(
        "permission_denied",
        "Choose only your currently active teams.",
      );
    const before = await this.load();
    const next = structuredClone(before);
    const refs = new Set(change.fact_refs);
    let changed = 0;
    for (const entity of next.entities) {
      let updated = false;
      for (const fact of entity.facts) {
        if (
          !fact.permissions ||
          !refs.delete(factRef(who.namespace, fact.id, fact.permissions))
        )
          continue;
        fact.permissions.visibility = change.visibility;
        fact.permissions.team_ids = teamIds;
        fact.permissions.revision++;
        updated = true;
        changed++;
      }
      if (updated) entity.revision++;
    }
    if (refs.size)
      throw new MemoryError(
        "permission_denied",
        "A fact is unavailable, not owned by you or has changed; read current fact references before sharing.",
      );
    next.revision++;
    await this.persist(before.revision, next, before, true);
    return {
      changed,
      visibility: change.visibility,
      team_ids: teamIds,
      revision: next.revision,
    };
  }
  async commit(
    expectedRevision: number,
    next: Snapshot,
    previous?: Snapshot,
  ): Promise<Snapshot> {
    return this.persist(expectedRevision, next, previous);
  }
  private async persist(
    expectedRevision: number,
    next: Snapshot,
    previous?: Snapshot,
    permissionChange = false,
  ): Promise<Snapshot> {
    const who = this.identity();
    if (next.profile && !this.index)
      throw new MemoryError(
        "native_search_required",
        "Configure the native index before modifying embedded memory.",
      );
    const validated = bindState(next, previous, who, permissionChange);
    if (validated.revision !== expectedRevision + 1)
      throw new MemoryError(
        "invalid_revision",
        "A write must advance the graph revision exactly once.",
      );
    const document: Document & { _id: string } = {
      ...this.boundary(),
      ...withoutVectors(validated),
    };
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
        { ...this.boundary(), revision: expectedRevision },
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
        await this.index.update(previous, validated, session);
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
    return readState(document);
  }
  async search(
    vector: number[],
    profile: string,
    topK: number,
    minScore: number,
    signal?: AbortSignal,
  ) {
    this.identity();
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
