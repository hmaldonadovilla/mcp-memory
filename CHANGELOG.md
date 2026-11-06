# Changelog

This log records independently versioned releases of the augmented memory fork.

## 0.3.0 (unreleased)

- Return current fact references directly from successful writes, with the enriched output bounded before embedding or persistence.
- Bind user identity and immutable source conversation/task provenance through a private trusted-host context; discovery has no data or embedding access.
- Default new facts to user-private across conversations; add creator-only user/team/global sharing and fresh framework-managed multi-team authorization.
- Keep embeddings only in `memory_index`, fact text only in `memory_graphs`; update ACL metadata without re-embedding.
- Apply native visibility prefilters and authoritative ACL/expiry checks across every retrieval path; redact private foreign provenance, subjects and relations.
- Require a reviewed backup/ownership migration for legacy graphs; never infer ownership or publish legacy facts globally.

## 0.2.0

- Select the native Community index-discovery command without granting wider worker privileges; retain the Atlas aggregation interface.

- Move all similarity ranking to native MongoDB `$vectorSearch`; remove application-side cosine scanning.
- Validate only bounded metadata at session startup; load graph snapshots only for graph operations.
- Add a transactional, scoped entity/fact vector projection, contextual embeddings and authoritative result hydration.
- Require explicit native-index configuration and readiness, with operator-only `--prepare-index` and migration via `--reindex`.
- Preserve graph-only operation and both current/legacy stdio and Streamable HTTP transports.
- Qualify a real MongoDB 8.3.4 / mongot 1.70.1 replica-set fixture; native search is required in the integration gate.

## 0.1.0

- Standalone scoped npm package and executable, with clean tarball installation/npx proof.
- Durable MongoDB namespace graphs with atomic graph/vector mutations, revision conflicts and bounded storage.
- Upstream graph vocabulary, explicit semantic search, exact subject association lookup and provenance/validity.
- Configured OpenAI-compatible embeddings with profile consistency, explicit reindexing and no hidden fallback/retry.
- Official SDK stdio and Streamable HTTP serving, with current and legacy client verification.
- Fixed server-controlled authorization scope, bearer-protected HTTP, Host/Origin validation and read-only mode.
- Mounted credential and CA references, strict certificate verification and synthetic corporate-style CA regression.

Framework Insights/compression integration remains separate work. Registry availability is verified at publication time.
