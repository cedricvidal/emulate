import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The Git transport tests boot a server and run real clone and push
    // operations against it, which is slower than the 5s default allows on a
    // loaded CI runner.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
