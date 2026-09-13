import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    PKG_VERSION: JSON.stringify("0.0.0-test"),
  },
  test: {
    globals: true,
    // These tests boot real HTTP servers and spawn the CLI. The 5s default is
    // enough on an idle machine but not on a loaded CI runner, where the test
    // task for every package runs concurrently.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
