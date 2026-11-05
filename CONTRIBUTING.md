# Contributing

This independent fork accepts focused issues and pull requests for the standalone memory server. It does not file work on the upstream project's board or change its publishing process.

Use Node 24.19+, npm and Docker. Run `npm ci` and `npm run local:gate`; all integration data and provider/certificate fixtures are synthetic. Work on a `codex/` branch, use Conventional Commits with `git commit -s`, update user-facing documentation and the changelog, and keep source/profile/authorization boundaries explicit. New runtime modules must meet the existing per-file 90% coverage floors. Do not suppress checks, add test retries or substitute mocks for required persistence/transport qualification.

Report credential or cross-scope disclosure privately through the repository's security reporting facilities when available; never include real credentials, user memory or connection strings in an issue. Public bug reports should use synthetic reproductions. Contributions retain upstream notices and the applicable license terms in LICENSE.
