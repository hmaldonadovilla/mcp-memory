// Synthetic adapters exist only in tests; production always persists to MongoDB and uses a real provider.
import { vi } from "vitest";
import { emptySnapshot, MemoryError, subgraph, visible } from "../src/model.js";
import type { Embeddings, GraphStore, Snapshot } from "../src/model.js";
export class TestStore implements GraphStore {
  state = emptySnapshot();
  close = vi.fn(async () => {});
  load = vi.fn(async () => structuredClone(this.state));
  // A deterministic test-port oracle, not a runtime search implementation.
  search = vi.fn(
    async (
      vector: number[],
      profile: string,
      topK: number,
      minScore: number,
    ) => {
      if (this.state.profile && this.state.profile !== profile)
        throw new MemoryError(
          "embedding_profile_mismatch",
          "Test profile mismatch",
        );
      if (this.state.entities.some((e) => e.facts.some((f) => !f.vector)))
        throw new MemoryError("reindex_required", "Test index missing");
      const matches = this.state.entities
        .flatMap((entity) =>
          entity.facts
            .filter((fact) => visible(fact))
            .map((fact) => ({
              entityName: entity.name,
              observation: fact.content,
              kind: "fact" as const,
              score:
                JSON.stringify(vector) === JSON.stringify(fact.vector) ? 1 : 0,
              recordRef: `fact:${fact.id}:${entity.revision}`,
              ...(fact.source ? { source: fact.source } : {}),
            })),
        )
        .filter((hit) => hit.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return {
        ...subgraph(this.state, new Set(matches.map((m) => m.entityName))),
        matches,
        embeddingProfile: profile,
      };
    },
  );
  commit = vi.fn(async (expected: number, next: Snapshot) => {
    if (expected !== this.state.revision)
      throw new MemoryError("write_conflict", "Concurrent write");
    this.state = structuredClone(next);
  });
}
export class TestEmbeddings implements Embeddings {
  readonly profile: string;
  close = vi.fn(async () => {});
  embed = vi.fn(async (inputs: string[]) =>
    inputs.map((input) =>
      /pastry|croissant|bread/i.test(input) ? [1, 0] : [0, 1],
    ),
  );
  constructor(profile = "a".repeat(64)) {
    this.profile = profile;
  }
}
export const person = (name = "A", observations = ["Enjoys croissants"]) => ({
  name,
  entityType: "person",
  observations,
});
