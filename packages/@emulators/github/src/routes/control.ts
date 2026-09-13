import { rmSync } from "fs";
import type { Context, RouteContext } from "@emulators/core";
import type { Store } from "@emulators/core";
import { resolveGitDir } from "../git-mirror.js";

export interface ControlOptions {
  /** Re-applies the seed after the store is cleared. */
  reseed?: (store: Store) => void;
}

/**
 * Control endpoints for evaluation harnesses.
 *
 * A scenario run needs identical starting state on every occurrence. Resetting
 * clears the entity store, discards the bare repository mirrors so a previously
 * pushed branch cannot leak into the next run, and re-applies the seed.
 */
export function controlRoutes(ctx: RouteContext, options: ControlOptions = {}): void {
  const { app, store } = ctx;

  app.post("/_emulate/reset", (c: Context) => {
    const gitDir = resolveGitDir();

    store.reset();
    // Mirrors are derived state, so removing them is safe and prevents a branch
    // pushed by one run from surviving into the next.
    rmSync(gitDir, { recursive: true, force: true });

    options.reseed?.(store);

    return c.json({ ok: true, reset_at: new Date().toISOString() });
  });
}
