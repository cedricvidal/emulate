import type { Context, RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { blobBytes } from "../git-helpers.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * GitHub Enterprise Server style aliases.
 *
 * The official github-mcp-server targets a GHES host by setting GITHUB_HOST,
 * which makes it call REST under /api/v3/, GraphQL at /api/graphql, and raw
 * content under /raw/. Emulate serves REST at the root, matching the
 * api.github.com shape, so /api/v3 is rewritten onto the existing routes rather
 * than duplicated. The rewritten path never starts with /api/v3 again, so there
 * is no recursion.
 */
export function ghesRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const gh = getGitHubStore(store);

  for (const method of METHODS) {
    app.on(method, "/api/v3/:rest{.*}", async (c: Context) => {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.slice("/api/v3".length) || "/";
      return app.fetch(new Request(url.toString(), c.req.raw));
    });
  }

  // Raw file content, in the shape GHES uses without subdomain isolation.
  app.get("/raw/:owner/:repo/:ref/:path{.+}", (c: Context) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const ref = c.req.param("ref")!;
    const prefix = `/raw/${owner}/${repoName}/${ref}/`;
    const path = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));

    const repo = gh.repos.findOneBy("full_name", `${owner}/${repoName}`);
    if (!repo) return c.text("Not Found", 404);

    const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === ref);
    const commit = gh.commits.findBy("repo_id", repo.id).find((x) => x.sha === (branch?.sha ?? ref));
    if (!commit) return c.text("Not Found", 404);

    let treeSha = commit.tree_sha;
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return c.text("Not Found", 404);

    for (let i = 0; i < segments.length; i++) {
      const tree = gh.trees.findBy("repo_id", repo.id).find((t) => t.sha === treeSha);
      const entry = tree?.tree.find((e) => e.path === segments[i]);
      if (!entry) return c.text("Not Found", 404);

      if (i === segments.length - 1) {
        if (entry.type !== "blob") return c.text("Not Found", 404);
        const blob = gh.blobs.findBy("repo_id", repo.id).find((b) => b.sha === entry.sha);
        if (!blob) return c.text("Not Found", 404);
        c.header("Content-Type", "text/plain; charset=utf-8");
        return c.body(blobBytes(blob));
      }
      treeSha = entry.sha;
    }

    return c.text("Not Found", 404);
  });
}
