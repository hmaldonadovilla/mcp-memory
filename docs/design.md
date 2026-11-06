# Design and implementation review

This document records the augmented server's design choices and the defects its tests must prevent. The public implementation starts from the licensed MCP memory server's graph vocabulary and independently implements persistence and retrieval; private framework source is not imported.

| Capability                        | Reference graph server       | This fork                                                                                     |
| --------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Entities, relations, observations | Nine graph tools             | Preserved names and literal-search behavior, with strict bounded schemas                      |
| Persistence                       | Local JSONL                  | MongoDB, one versioned atomic document per authorized namespace                               |
| Semantic retrieval                | None                         | Explicit `semantic_search`, native MongoDB ANN and scoped entity/fact evidence                |
| User-associated lookup            | Name/literal search          | Explicit subject associations and exact `lookup_subject`                                      |
| Embeddings                        | None                         | Configured OpenAI-compatible embeddings, including Azure v1; no synthetic fallback            |
| Transports                        | stdio                        | Official SDK stdio and Streamable HTTP, current and legacy clients                            |
| Access                            | Local process boundary       | Fixed namespace; HTTP bearer authentication and Host/Origin checks; optional read-only server |
| Packaging                         | Upstream namespace/workspace | Independent scoped npm package, clean tarball/npx proof and own release workflow              |

## Improvements over an early semantic extension

- Persistence failure must stop startup. No-op adapters can make discovery look healthy while discarding writes.
- Missing providers must fail semantic requests. Deterministic hashes are useful test fixtures, not embeddings.
- Read and write paths must share one vector representation. Store observation vectors once and search those same vectors; do not write entity averages while searching missing observation vectors.
- Duplicate observations must be idempotent. Adding the same fact twice must neither duplicate evidence nor change its semantic weight.
- Facts, vectors and graph edges must settle atomically. Embedding failures, deletion and concurrent writes must not leave an index that describes different facts.
- Namespace identity is a transport/deployment decision. User-supplied entities and tool arguments cannot replace it. Subject associations are not ACLs.
- Embedding dimensions and profile identity must match. Never compare only the shared prefix of incompatible vectors. Profile changes require explicit reindexing.
- Search failures must be classified without dumping sample entities, vectors, provider responses, connection strings or credentials.
- Retrieval and storage need budgets. MongoDB performs native ANN ranking with mandatory scope/profile/expiry filters. Search never reads the whole vector snapshot into the MCP and never falls back to a local calculation.

## Atomicity and concurrency

The initial `memory_graphs` document has `_id = namespace`, schema version 1 and revision 0. A mutation loads the current snapshot, validates its whole operation, obtains vectors for new unique facts, and replaces the document only if the expected revision still matches. A replica-set transaction commits that replacement and the flat `memory_vectors` deltas together. One concurrent writer wins; the loser gets `write_conflict`. There is no hidden provider retry or automatic mutation resubmission.

MongoDB's 16 MiB document ceiling remains independent of model/embedding capacity. This implementation reserves headroom with a 14 MiB BSON cap and explicit graph/cardinality limits. Returning a large result has a separate 256 KiB cap. These are deliberate first-release constraints, not an unlimited memory platform. Native ANN uses the flat projection; the graph snapshot retains these explicit bounds. Index readiness and dimension/metric/filter compatibility are mandatory before serving semantic tools.

Each fact's stable ID hashes its entity name and exact content. Returned fact/version references are namespace-local and must be retained with the trusted server binding and scope. The graph revision and entity revisions make evidence changes observable. Source fields are claimed provenance, retained with the fact; they are not a verification of a model's claim.

## Qualification

Offline tests include malformed provider responses, dimension/profile drift, duplicates, missing entities, expired facts, failed batches, cancellation, conflicts, oversized results and unsafe configuration. Real MongoDB tests prove persistence across connections, namespace isolation, concurrency and deletion. Actual SDK clients exercise both protocol eras on both transports. HTTPS tests reject an untrusted synthetic certificate and accept an explicitly mounted additional CA. A clean installed tarball is driven through npx and stdio against isolated MongoDB.

No test calls a paid model or uses a corporate credential/certificate. This release does not implement framework Insights, compression, OAuth, resource subscriptions or large-scale performance qualification.

MongoDB Community index readiness uses the explicitly selected native `listSearchIndexes` command (`MEMORY_VECTOR_INDEX_INTERFACE=command`). Atlas uses the driver aggregation interface. The Community aggregation wrapper currently rejects the collection-scoped identity even when the native command permits it; do not broaden the worker role to bypass this distinction.
