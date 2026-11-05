// Every runtime module has an independent coverage floor; integration tests use real transports.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        perFile: true,
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
