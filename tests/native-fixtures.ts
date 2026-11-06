// Native indexes synchronize asynchronously. Poll database reads without repeating writes or embedding calls.
import { MongoClient } from "mongodb";
import { setTimeout as delay } from "node:timers/promises";
export async function indexed(
  uri: string,
  namespace: string,
  observation: string,
): Promise<void> {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await client
        .db("mcp_memory_tests")
        .collection("memory_vectors")
        .aggregate([
          {
            $vectorSearch: {
              index: "memory_semantic_v2",
              path: "embedding",
              queryVector: [1, 0],
              numCandidates: 100,
              limit: 50,
              filter: { namespace },
            },
          },
          { $project: { observation: 1 } },
        ])
        .toArray();
      if (rows.some((row) => row.observation === observation)) return;
      await delay(100);
    }
    throw Error(
      "Native index did not synchronize the synthetic fact within its allowance",
    );
  } finally {
    await client.close();
  }
}
