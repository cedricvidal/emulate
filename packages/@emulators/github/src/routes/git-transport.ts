import { spawn } from "child_process";
import { gunzipSync } from "zlib";
import type { Context, RouteContext } from "@emulators/core";
import { notFound } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubRepo } from "../entities.js";
import { gitArgs, repoGitDir, resolveGitDir, syncFromGit, syncToGit } from "../git-mirror.js";

export interface GitTransportOptions {
  /** Mirror root. Defaults to the process-scoped directory from resolveGitDir(). */
  gitDir?: string;
}

type GitService = "git-upload-pack" | "git-receive-pack";

function isGitService(value: string | undefined): value is GitService {
  return value === "git-upload-pack" || value === "git-receive-pack";
}

/**
 * Git pkt-line framing: a 4-byte hex length prefix covering the whole line.
 */
function pktLine(payload: string): Buffer {
  const length = Buffer.byteLength(payload, "utf8") + 4;
  return Buffer.from(`${length.toString(16).padStart(4, "0")}${payload}`, "utf8");
}

const PKT_FLUSH = Buffer.from("0000", "utf8");

function lookupRepoByPath(gh: GitHubStore, owner: string, repoName: string): GitHubRepo | undefined {
  const name = repoName.replace(/\.git$/, "");
  return gh.repos.findOneBy("full_name", `${owner}/${name}`);
}

/**
 * Runs a git service in stateless-RPC mode and returns its stdout.
 *
 * Two details matter here. The subcommand form `git upload-pack` is used rather
 * than the hyphenated `git-upload-pack` binary, because the latter is not on PATH
 * on many systems and can resolve to a different git installation. And the
 * client's Git-Protocol header is forwarded as GIT_PROTOCOL, merged into the
 * existing environment rather than replacing it, which enables protocol v2.
 */
function runGitService(
  service: GitService,
  gitDir: string,
  options: { advertise?: boolean; input?: Buffer; gitProtocol?: string },
): Promise<Buffer> {
  const subcommand = service.replace(/^git-/, "");
  const args = gitArgs([subcommand, "--stateless-rpc"]);
  if (options.advertise) args.push("--advertise-refs");
  args.push(gitDir);

  const env = { ...process.env };
  if (options.gitProtocol) env.GIT_PROTOCOL = options.gitProtocol;

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && stdout.length === 0) {
        reject(new Error(`git ${subcommand} failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });

    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
}

async function readRequestBody(c: Context): Promise<Buffer> {
  const raw = Buffer.from(await c.req.arrayBuffer());
  return c.req.header("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
}

function noCacheHeaders(c: Context, contentType: string): void {
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
  c.header("Expires", "Fri, 01 Jan 1980 00:00:00 GMT");
  c.header("Pragma", "no-cache");
}

export function gitTransportRoutes(ctx: RouteContext, options: GitTransportOptions = {}): void {
  const { app, store, webhooks } = ctx;
  const gh = getGitHubStore(store);
  const root = options.gitDir;

  const resolve = (c: Context): { repo: GitHubRepo; gitDir: string } => {
    const owner = c.req.param("owner")!;
    const repoParam = c.req.param("repo")!;
    const repo = lookupRepoByPath(gh, owner, repoParam);
    if (!repo) throw notFound();
    return { repo, gitDir: repoGitDir(root ?? resolveGitDir(), repo) };
  };

  // Smart HTTP discovery. Clients hit this first to learn the refs and capabilities.
  app.get("/:owner/:repo{.+\\.git}/info/refs", async (c) => {
    const service = c.req.query("service");
    if (!isGitService(service)) {
      // Dumb HTTP is not supported; only the smart protocol.
      throw notFound();
    }

    const { repo, gitDir } = resolve(c);
    syncToGit(gh, repo, gitDir);

    const advertisement = await runGitService(service, gitDir, {
      advertise: true,
      gitProtocol: c.req.header("git-protocol"),
    });

    noCacheHeaders(c, `application/x-${service}-advertisement`);
    return c.body(Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, advertisement]));
  });

  app.post("/:owner/:repo{.+\\.git}/git-upload-pack", async (c) => {
    const { repo, gitDir } = resolve(c);
    syncToGit(gh, repo, gitDir);

    const output = await runGitService("git-upload-pack", gitDir, {
      input: await readRequestBody(c),
      gitProtocol: c.req.header("git-protocol"),
    });

    noCacheHeaders(c, "application/x-git-upload-pack-result");
    return c.body(output);
  });

  app.post("/:owner/:repo{.+\\.git}/git-receive-pack", async (c) => {
    const { repo, gitDir } = resolve(c);
    syncToGit(gh, repo, gitDir);

    const before = new Map(gh.branches.findBy("repo_id", repo.id).map((b) => [b.name, b.sha]));

    const output = await runGitService("git-receive-pack", gitDir, {
      input: await readRequestBody(c),
      gitProtocol: c.req.header("git-protocol"),
    });

    // Absorb whatever the client just pushed so the REST and GraphQL layers see it.
    syncFromGit(gh, repo, gitDir);

    const after = gh.branches.findBy("repo_id", repo.id);
    const pusher = c.get("authUser")?.login ?? "emulate";

    for (const branch of after) {
      const previous = before.get(branch.name);
      if (previous === branch.sha) continue;
      const commit = gh.commits.findBy("repo_id", repo.id).find((x) => x.sha === branch.sha);
      void webhooks.dispatch(
        "push",
        undefined,
        {
          ref: `refs/heads/${branch.name}`,
          before: previous ?? "0".repeat(40),
          after: branch.sha,
          created: previous === undefined,
          deleted: false,
          forced: false,
          repository: { full_name: repo.full_name, name: repo.name },
          pusher: { name: pusher },
          head_commit: commit
            ? { id: commit.sha, message: commit.message, timestamp: commit.committer_date }
            : null,
        },
        repo.full_name.split("/")[0],
        repo.name,
      );
    }

    noCacheHeaders(c, "application/x-git-receive-pack-result");
    return c.body(output);
  });
}
