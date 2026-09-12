import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return { app, store };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "token test-token" };
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

async function mainHeadSha(app: Hono): Promise<string> {
  const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
  expect(commits.status).toBe(200);
  const [head] = (await commits.json()) as Array<{ sha: string }>;
  return head.sha;
}

async function createBranch(app: Hono, branch: string): Promise<void> {
  const sha = await mainHeadSha(app);
  const res = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  expect(res.status).toBe(201);
}

async function putFile(app: Hono, branch: string, path: string, content: string, sha?: string): Promise<void> {
  const res = await app.request(`${base}/repos/octocat/hello-world/contents/${path}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({
      branch,
      message: `Update ${path}`,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  expect([200, 201]).toContain(res.status);
}

async function createPull(app: Hono, branch: string): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title: `Pull ${branch}`, head: branch, base: "main" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { number: number };
  return body.number;
}

async function createAddedFilePull(app: Hono, branch: string): Promise<number> {
  await createBranch(app, branch);
  await putFile(app, branch, "src/new-file.ts", "export const value = 1;\n");
  return createPull(app, branch);
}

async function createModifiedFilePull(app: Hono, branch: string): Promise<number> {
  await createBranch(app, branch);
  const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md?ref=${branch}`, {
    headers: authHeaders(),
  });
  expect(readme.status).toBe(200);
  const readmeBody = (await readme.json()) as { sha: string };
  await putFile(app, branch, "README.md", "# hello-world\nupdated\n", readmeBody.sha);
  return createPull(app, branch);
}

describe("GitHub pull request diff routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("reports an added file with patch details", async () => {
    const pullNumber = await createAddedFilePull(app, "add-file");

    const res = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/files`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const files = (await res.json()) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      filename: "src/new-file.ts",
      status: "added",
      additions: 1,
      deletions: 0,
    });
    expect(files[0].patch).toContain("+export const value = 1;");
  });

  it("reports modified file additions and deletions", async () => {
    const pullNumber = await createModifiedFilePull(app, "modify-file");

    const res = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/files`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const files = (await res.json()) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 0,
    });
  });

  it("returns unified diff text for the diff media type", async () => {
    const pullNumber = await createAddedFilePull(app, "diff-media");

    const res = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
      headers: { ...authHeaders(), Accept: "application/vnd.github.v3.diff" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/vnd.github.v3.diff");
    const text = await res.text();
    expect(text).toContain("diff --git a/src/new-file.ts b/src/new-file.ts");
    expect(text).toContain("@@");
  });

  it("keeps returning the JSON pull request by default", async () => {
    const pullNumber = await createAddedFilePull(app, "json-default");

    const res = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { number: number };
    expect(body.number).toBe(pullNumber);
  });

  it("returns an empty file list for a dangling head sha", async () => {
    const pullNumber = await createAddedFilePull(app, "dangling-head");
    const gh = getGitHubStore(store);
    const pr = gh.pullRequests.all().find((candidate) => candidate.number === pullNumber);
    expect(pr).toBeDefined();
    gh.pullRequests.update(pr!.id, { head_sha: "f".repeat(40) });

    const res = await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}/files`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
