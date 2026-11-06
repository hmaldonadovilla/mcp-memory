// Native indexes synchronize asynchronously. Poll database reads without repeating writes or embedding calls.
import { MongoClient } from "mongodb";
import { setTimeout as delay } from "node:timers/promises";
export async function indexed(
  uri: string,
  namespace: string,
  observation: string,
  visibility?: "user" | "team" | "global",
): Promise<void> {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const state = await client
      .db("mcp_memory_tests")
      .collection<{
        _id: string;
        entities: { facts: { id: string; content: string }[] }[];
      }>("memory_graphs")
      .findOne({ _id: namespace });
    const ids =
      state?.entities.flatMap((entity) =>
        entity.facts
          .filter((fact) => fact.content === observation)
          .map((fact) => fact.id),
      ) ?? [];
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await client
        .db("mcp_memory_tests")
        .collection("memory_index")
        .aggregate([
          {
            $vectorSearch: {
              index: "memory_semantic_v3",
              path: "embedding",
              queryVector: [1, 0],
              numCandidates: 100,
              limit: 50,
              filter: { namespace, ...(visibility ? { visibility } : {}) },
            },
          },
          { $project: { recordId: 1 } },
        ])
        .toArray();
      if (rows.some((row) => ids.includes(String(row.recordId)))) return;
      await delay(100);
    }
    throw Error(
      "Native index did not synchronize the synthetic fact within its allowance",
    );
  } finally {
    await client.close();
  }
}
