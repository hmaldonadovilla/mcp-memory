#!/usr/bin/env node
// Keep stdout reserved for MCP; signals and stdin EOF close the transport and database pool.
import { runCli, safeError } from "../dist/cli.js";
try {
  const runtime = await runCli(process.argv.slice(2), process.env);
  if (runtime) {
    const close = () => {
      void runtime.close().catch((error) => {
        console.error(safeError(error));
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    if (runtime.transport === "stdio") process.stdin.once("end", close);
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
}
