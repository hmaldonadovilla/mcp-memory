# Standalone memory fork

This user-authorized fork packages only the augmented memory server. Upstream history and the complete mixed Apache/MIT/documentation license remain intact; `docs/upstream.json` pins provenance. Upstream organization boards, release branches, server monorepo jobs and credentials do not belong to this independent repository.

- Work on `codex/` branches. Use signed-off Conventional Commits. Preserve unrelated work.
- Use Node 24.19 or newer, TypeScript strict mode, Zod input validation, ES modules and explicit `.js` imports. Never use `any`, compiler/lint suppressions, fake embeddings or silent storage fallbacks.
- Add a purpose comment to new code and configuration. Keep the executable shebang first.
- Keep credentials and user memory out of source, logs, errors and package contents. Prefer mounted secret/CA files. Never disable TLS verification. Scope is server controlled, never a model argument.
- Preserve the upstream graph tool names. New tools use snake_case and accurate read-only, idempotency and destructive annotations. Use the SDK's transport factories for current and legacy protocol compatibility.
- Mutations must atomically persist graph and vector changes. A conflict or unknown write outcome is explicit. Bound graph size, requests, output and embedding calls. Do not retry model/provider calls automatically.
- Run `npm run local:gate` before pushing. It covers formatting, lint, types, per-file coverage (90% on all four dimensions), the build, real MongoDB/transport integration and installation/stdio smoke from the packed artifact. Test new behavior through MCP clients where possible. No test retries or skipped required integration checks.
- Public runtime behavior and packaging changes update README, the release notes and tests. Keep npm publication deliberate; CI has no provider or database credentials. A credentialed publication job installs/builds nothing and consumes the verified package artifact.
- This first release is a bounded exact-search graph, not an ANN/vector-index service or an implementation of framework Insights/compression. Record actual qualification and limitations.
