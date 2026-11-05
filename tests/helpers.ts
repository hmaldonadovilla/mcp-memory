// Synthetic adapters exist only in tests; production always persists to MongoDB and uses a real provider.
import { vi } from "vitest";
import { emptySnapshot, MemoryError } from "../src/model.js";
import type { Embeddings, GraphStore, Snapshot } from "../src/model.js";
export class TestStore implements GraphStore {
  state = emptySnapshot();
  close = vi.fn(async () => {});
  load = vi.fn(async () => structuredClone(this.state));
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
