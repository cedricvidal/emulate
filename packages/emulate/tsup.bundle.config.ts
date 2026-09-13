import { defineConfig } from "tsup";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

/**
 * Container build: bundles every dependency, including commander, picocolors,
 * and yaml, so the image needs nothing but Node and git at runtime. The npm
 * build in tsup.config.ts deliberately leaves those external; this variant is
 * only used to produce a self-contained artifact for the Docker image, which
 * also makes the image buildable without registry access.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist-bundle",
  format: ["esm"],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/.*/],
  // Bundled CommonJS dependencies still call require() for Node built-ins, so
  // provide a real require in the ESM output.
  banner: {
    js: "import { createRequire as __emulateCreateRequire } from 'module'; const require = __emulateCreateRequire(import.meta.url);",
  },
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  async onSuccess() {
    const dest = resolve(__dirname, "dist-bundle/fonts");
    mkdirSync(dest, { recursive: true });
    cpSync(resolve(__dirname, "../@emulators/core/src/fonts"), dest, { recursive: true });

    const entry = resolve(__dirname, "dist-bundle/index.js");
    writeFileSync(entry, `#!/usr/bin/env node\n${readFileSync(entry, "utf-8")}`);
  },
});
