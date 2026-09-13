import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { createServer, serve } from "@emulators/core";
import githubPlugin, { seedFromConfig } from "../index.js";
import { getGitHubStore } from "../store.js";

const execFileAsync = promisify(execFile);

/**
 * git speaks HTTP through a separate git-remote-http helper that lives in
 * git's exec path. Some sandboxed environments, including task runners that
 * trim the environment, leave it unreachable. The emulator is unaffected, but
 * the test client cannot connect, so skip rather than report a false failure.
 */
function gitCanSpeakHttp(): boolean {
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    return existsSync(join(execPath, "git-remote-http")) || existsSync(join(execPath, "git-remote-http.exe"));
  } catch {
    return false;
  }
}

const httpCapable = gitCanSpeakHttp();

let server: ReturnType<typeof serve>;
let store: ReturnType<typeof createServer>["store"];
let port: number;
let gitRoot: string;
let work: string;

/**
 * Git commands must run asynchronously: the emulator is served from this same
 * process, so a synchronous child process would block the event loop that has
 * to answer git's own HTTP requests, and the test would deadlock.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "safe.bareRepository=all", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "Agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

beforeAll(async () => {
  port = 4700 + Math.floor(Math.random() * 200);
  gitRoot = mkdtempSync(join(tmpdir(), "emulate-xport-"));
  work = mkdtempSync(join(tmpdir(), "emulate-xport-work-"));

  const created = createServer(githubPlugin, {
    port,
    baseUrl: `http://localhost:${port}`,
    tokens: { "test-token": { login: "octocat", id: 1, scopes: ["repo"] } },
  });
  store = created.store;
  githubPlugin.seed?.(created.store, created.baseUrl);
  seedFromConfig(created.store, created.baseUrl, {
    git_dir: gitRoot,
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world", auto_init: true }],
  });

  server = serve({ fetch: created.app.fetch, port });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
});

afterAll(() => {
  server?.close();
  rmSync(gitRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!httpCapable)("git smart HTTP transport", () => {
  const remote = () => `http://localhost:${port}/octocat/hello-world.git`;

  it("advertises refs to git ls-remote", async () => {
    const out = await git(["ls-remote", remote()], work);
    expect(out).toMatch(/refs\/heads\/main/);
  });

  it("supports protocol v2", async () => {
    const out = await git(["-c", "protocol.version=2", "ls-remote", remote()], work);
    expect(out).toMatch(/refs\/heads\/main/);
  });

  it("clones a real working copy", async () => {
    await git(["clone", remote(), "clone1"], work);
    const { readdirSync } = await import("fs");
    expect(readdirSync(join(work, "clone1"))).toContain("README.md");
  });

  it("accepts a push and reflects it in the API", async () => {
    await git(["clone", remote(), "clone2"], work);
    const repo = join(work, "clone2");
    const { writeFileSync } = await import("fs");

    await git(["checkout", "-b", "fix-11"], repo);
    writeFileSync(join(repo, "fix.mjs"), "export const fixed = true\n");
    await git(["add", "fix.mjs"], repo);
    await git(["commit", "-m", "Fix streaming bug\n\nFixes #11"], repo);
    const pushed = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["push", "origin", "fix-11"], repo);

    const gh = getGitHubStore(store);
    const repoRow = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const branch = gh.branches.findBy("repo_id", repoRow.id).find((b) => b.name === "fix-11");
    expect(branch?.sha).toBe(pushed);

    // The pushed commit must be queryable through the REST API, which is what
    // the evaluation harness grades against.
    const res = await fetch(`http://localhost:${port}/repos/octocat/hello-world/branches/fix-11`, {
      headers: { Authorization: "token test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; commit: { sha: string } };
    expect(body.name).toBe("fix-11");
    expect(body.commit.sha).toBe(pushed);

    const contents = await fetch(`http://localhost:${port}/repos/octocat/hello-world/contents/fix.mjs?ref=fix-11`, {
      headers: { Authorization: "token test-token" },
    });
    expect(contents.status).toBe(200);
    const file = (await contents.json()) as { content: string; encoding: string };
    expect(Buffer.from(file.content, file.encoding as BufferEncoding).toString("utf8")).toContain("fixed");
  });

  it("serves a branch pushed by another clone", async () => {
    await git(["clone", remote(), "clone3"], work);
    const out = await git(["ls-remote", "origin"], join(work, "clone3"));
    expect(out).toMatch(/refs\/heads\/fix-11/);
  });

  it("rejects an unknown repository", async () => {
    await expect(git(["ls-remote", `http://localhost:${port}/octocat/nope.git`], work)).rejects.toThrow();
  });
});
