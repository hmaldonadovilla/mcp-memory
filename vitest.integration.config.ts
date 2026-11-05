// Required integration uses an isolated MongoDB namespace and SDK clients over both transports.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/*.integration.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
