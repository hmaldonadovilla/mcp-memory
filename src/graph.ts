// One graph service backs both transports; optimistic commits prevent partial graph/vector updates.
import {
  bounded,
  factId,
  MemoryError,
  publicEntity,
  snapshotSchema,
  subgraph,
  visible,
} from "./model.js";
import type {
  Embeddings,
  EntityInput,
  Fact,
  GraphStore,
  Relation,
  Snapshot,
  Source,
} from "./model.js";

export class MemoryGraph {
  constructor(
    private readonly store: GraphStore,
    private readonly embeddings?: Embeddings,
  ) {}

  private async mutate<T>(
    operation: (state: Snapshot) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const before = await this.store.load();
    const next = structuredClone(before);
    const result = bounded(operation(next));
    if (JSON.stringify(before) === JSON.stringify(next)) return result;
    if (before.profile && !this.embeddings)
      throw new MemoryError(
        "embedding_required",
        "Indexed memory mutations require the compatible embedding and native search configuration.",
      );
    if (before.profile) this.checkProfile(before);
    const existing = new Set(
      before.entities.flatMap((e) => e.facts.map((f) => f.id)),
    );
    const oldNames = new Set(before.entities.map((e) => e.name));
    const added = next.entities.flatMap((entity) => [
      ...(!oldNames.has(entity.name)
        ? [{ target: entity, text: entityText(entity) }]
        : []),
      ...entity.facts
        .filter((fact) => !existing.has(fact.id))
        .map((fact) => ({
          target: fact,
          text: entityText(entity) + "\nFact: " + fact.content,
        })),
    ]);
    if (added.length > 64)
      throw new MemoryError(
        "embedding_budget",
        "A mutation may introduce at most 64 entity/fact vectors; split the request into smaller batches.",
      );
    if (added.length && this.embeddings) {
      this.checkProfile(before);
      const vectors = await this.embeddings.embed(
        added.map((item) => item.text),
        signal,
      );
      if (vectors.length !== added.length)
        throw new MemoryError(
          "embedding_incompatible",
          "The embedding provider returned an incompatible result count.",
        );
      added.forEach((item, index) => {
        item.target.vector = vectors[index]!;
      });
      next.profile = this.embeddings.profile;
    } else if (added.length && before.profile) {
      throw new MemoryError(
        "embedding_required",
        "This namespace is semantically indexed; configure its compatible embedding profile before adding facts.",
      );
    }
    if (signal?.aborted)
      throw new MemoryError(
        "cancelled",
        "The operation was cancelled before persistence.",
      );
    next.revision = before.revision + 1;
    snapshotSchema.parse(next);
    await this.store.commit(before.revision, next, before);
    return result;
  }
  private checkProfile(state: Snapshot): void {
    if (!this.embeddings)
      throw new MemoryError(
        "embedding_not_configured",
        "Semantic retrieval requires an explicit real embedding provider.",
      );
    if (state.profile && state.profile !== this.embeddings.profile)
      throw new MemoryError(
        "embedding_profile_mismatch",
        "The configured embedding profile differs from stored memory; run an explicit operator reindex or use a new namespace.",
      );
    if (state.entities.some((e) => !e.vector || e.facts.some((f) => !f.vector)))
      throw new MemoryError(
        "reindex_required",
        "Existing graph facts have not been embedded; run an explicit operator reindex first.",
      );
  }
  async createEntities(entities: EntityInput[], signal?: AbortSignal) {
    return this.mutate((state) => {
      const created = [];
      for (const input of entities) {
        if (state.entities.some((e) => e.name === input.name)) continue;
        const entity = {
          name: input.name,
          entityType: input.entityType,
          subjects: [...new Set(input.subjects ?? [])],
          revision: 1,
          facts: [...new Set(input.observations)].map((content) =>
            this.fact(input.name, content, input.source),
          ),
        };
        state.entities.push(entity);
        created.push(publicEntity(entity));
      }
      return created;
    }, signal);
  }
  private fact(entity: string, content: string, source?: Source): Fact {
    return {
      id: factId(entity, content),
      content,
      createdAt: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
  }
  async createRelations(relations: Relation[], signal?: AbortSignal) {
    return this.mutate((state) => {
      const names = new Set(state.entities.map((e) => e.name));
      const result: Relation[] = [];
      for (const relation of relations) {
        if (!names.has(relation.from) || !names.has(relation.to))
          throw new MemoryError(
            "entity_missing",
            "Both relation endpoints must already exist in this namespace.",
          );
        if (!state.relations.some((r) => sameRelation(r, relation))) {
          state.relations.push(relation);
          result.push(relation);
        }
      }
      return result;
    }, signal);
  }
  async addObservations(
    additions: {
      entityName: string;
      contents: string[];
      source?: Source | undefined;
    }[],
    signal?: AbortSignal,
  ) {
    return this.mutate(
      (state) =>
        additions.map((addition) => {
          const entity = state.entities.find(
            (e) => e.name === addition.entityName,
          );
          if (!entity)
            throw new MemoryError(
              "entity_missing",
              "An observation target does not exist in this namespace.",
            );
          const fresh = [...new Set(addition.contents)].filter(
            (content) => !entity.facts.some((f) => f.content === content),
          );
          if (fresh.length) {
            entity.facts.push(
              ...fresh.map((content) =>
                this.fact(entity.name, content, addition.source),
              ),
            );
            entity.revision++;
          }
          return { entityName: entity.name, addedObservations: fresh };
        }),
      signal,
    );
  }
  async deleteEntities(names: string[], signal?: AbortSignal) {
    return this.mutate((state) => {
      const selected = new Set(names);
      const deleted = state.entities
        .filter((e) => selected.has(e.name))
        .map((e) => e.name);
      state.entities = state.entities.filter((e) => !selected.has(e.name));
      state.relations = state.relations.filter(
        (r) => !selected.has(r.from) && !selected.has(r.to),
      );
      return {
        deleted,
        notFound: [...selected].filter((n) => !deleted.includes(n)),
      };
    }, signal);
  }
  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[],
    signal?: AbortSignal,
  ) {
    return this.mutate((state) => {
      let deleted = 0;
      for (const deletion of deletions) {
        const entity = state.entities.find(
          (e) => e.name === deletion.entityName,
        );
        if (!entity) continue;
        const remaining = entity.facts.filter(
          (f) => !deletion.observations.includes(f.content),
        );
        if (remaining.length !== entity.facts.length) {
          deleted += entity.facts.length - remaining.length;
          entity.facts = remaining;
          entity.revision++;
        }
      }
      return { deleted };
    }, signal);
  }
  async deleteRelations(relations: Relation[], signal?: AbortSignal) {
    return this.mutate((state) => {
      const count = state.relations.length;
      state.relations = state.relations.filter(
        (r) => !relations.some((other) => sameRelation(r, other)),
      );
      return { deleted: count - state.relations.length };
    }, signal);
  }
  async readGraph() {
    const state = await this.store.load();
    return bounded(subgraph(state, new Set(state.entities.map((e) => e.name))));
  }
  async openNodes(names: string[]) {
    return bounded(subgraph(await this.store.load(), new Set(names)));
  }
  async searchNodes(query: string, limit = 20) {
    const state = await this.store.load();
    const text = query.toLocaleLowerCase("en");
    const names = new Set(
      state.entities
        .filter((e) =>
          [
            e.name,
            e.entityType,
            ...e.facts.filter((f) => visible(f)).map((f) => f.content),
          ].some((v) => v.toLocaleLowerCase("en").includes(text)),
        )
        .slice(0, limit)
        .map((e) => e.name),
    );
    return bounded(subgraph(state, names));
  }
  async lookupSubject(subject: string, limit = 20) {
    const state = await this.store.load();
    return bounded(
      subgraph(
        state,
        new Set(
          state.entities
            .filter((e) => e.subjects.includes(subject))
            .slice(0, limit)
            .map((e) => e.name),
        ),
      ),
    );
  }
  async semanticSearch(
    query: string,
    topK = 10,
    minScore = 0.25,
    signal?: AbortSignal,
  ) {
    if (!this.embeddings)
      throw new MemoryError(
        "embedding_not_configured",
        "Semantic retrieval requires an explicit real embedding provider.",
      );
    if (!this.store.search)
      throw new MemoryError(
        "native_search_required",
        "Semantic retrieval requires a ready native MongoDB Vector Search index.",
      );
    const queryVector = (await this.embeddings.embed([query], signal))[0];
    if (!queryVector)
      throw new MemoryError(
        "embedding_incompatible",
        "The embedding provider returned no query vector.",
      );
    return bounded(
      await this.store.search(
        queryVector,
        this.embeddings.profile,
        topK,
        minScore,
        signal,
      ),
    );
  }
  async reindex(maxFacts: number, signal?: AbortSignal) {
    if (!this.embeddings)
      throw new MemoryError(
        "embedding_not_configured",
        "Reindexing requires a real embedding provider.",
      );
    const state = await this.store.load();
    const before = structuredClone(state);
    const facts = state.entities.flatMap((e) => e.facts);
    if (facts.length > maxFacts)
      throw new MemoryError(
        "embedding_budget",
        "Reindex fact count exceeds the explicit operator allowance.",
      );
    const records = state.entities.flatMap((entity) => [
      { target: entity, text: entityText(entity) },
      ...entity.facts.map((fact) => ({
        target: fact,
        text: entityText(entity) + "\nFact: " + fact.content,
      })),
    ]);
    for (let i = 0; i < records.length; i += 64) {
      const batch = records.slice(i, i + 64);
      const vectors = await this.embeddings.embed(
        batch.map((item) => item.text),
        signal,
      );
      if (vectors.length !== batch.length)
        throw new MemoryError(
          "embedding_incompatible",
          "The embedding provider returned an incompatible result count.",
        );
      batch.forEach((item, j) => {
        item.target.vector = vectors[j]!;
      });
    }
    if (signal?.aborted)
      throw new MemoryError(
        "cancelled",
        "Reindexing was cancelled before persistence.",
      );
    const priorRevision = state.revision;
    state.revision++;
    state.profile = this.embeddings.profile;
    for (const entity of state.entities) entity.revision++;
    await this.store.commit(priorRevision, state, before);
    return {
      indexedFacts: facts.length,
      indexedEntities: state.entities.length,
      revision: state.revision,
      embeddingProfile: state.profile,
    };
  }
}
function sameRelation(a: Relation, b: Relation): boolean {
  return (
    a.from === b.from && a.to === b.to && a.relationType === b.relationType
  );
}
function entityText(entity: { name: string; entityType: string }): string {
  return "Entity: " + entity.name + "\nType: " + entity.entityType;
}
