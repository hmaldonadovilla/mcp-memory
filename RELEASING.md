# Releasing MCP Memory

Releases publish the verified standalone package under `@hmaldonadovilla/mcp-memory`. This fork does not inherit upstream's multi-server publication or registry credentials.

1. Update the package version and lockfile intentionally, record the changes in CHANGELOG.md, and run `npm run local:gate` on the exact source.
2. Push a `codex/` branch and merge its PR only after the CI matrix passes. Tag the accepted commit `v<package-version>`.
3. Run `npm run pack:verify`. The allowlisted `.tgz` and SHA-256 receipt are under `.local/package/`. Install that tarball in a clean directory or use npm/npx with the tagged HTTPS Git source. Do not claim registry availability before publication succeeds.
4. For npm, either sign in as the package owner and publish the verified tarball with `npm publish ./path/to/package.tgz --access public --ignore-scripts`, or configure npm trusted publishing for `hmaldonadovilla/mcp-memory`, workflow `release.yml`, then dispatch that workflow for the reviewed tag. New package names may need an initial owner-authenticated publication before trusted-publisher configuration is available.
5. The workflow's uncredentialed verification job runs the full gate, packages and verifies the artifact. Its separate OIDC publication job installs/builds nothing, validates the downloaded artifact's checksum/name/version/publish configuration and publishes that exact tarball with provenance. It has no provider or database credentials.
6. Verify the registry's package version/bin and test `npx --yes @hmaldonadovilla/mcp-memory@<version> --help`. Only then document the registry command as available.

GitHub-source npx installation and direct tarball installation remain available independently of the npm registry. Use explicit HTTPS Git URLs and pin a tag/commit for repeatability. Never publish local secret files, corporate CA bundles, graph snapshots, integration fixtures or private framework configuration.
