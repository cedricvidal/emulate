import { describe, it, expect } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";
import { getGitHubStore } from "../store.js";

const base = "http://localhost:4000";

/**
 * Mirrors the shape of the upstream repository the demo scenario imports:
 * issues and pull requests interleaved across one number sequence.
 */
const scenarioConfig = {
  users: [{ login: "pamelafox" }, { login: "reporter" }],
  repos: [
    {
      owner: "pamelafox",
      name: "ndjson-readablestream",
      files: { "index.mjs": "export const stream = true\n" },
      labels: [
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
        { name: "enhancement", color: "a2eeef" },
      ],
      issues: [
        { number: 4, title: "Module content unchanged", state: "closed" as const, user: "reporter" },
        {
          number: 11,
          title: "Malformed JSON can break streaming",
          state: "open" as const,
          user: "reporter",
          labels: ["bug"],
          body: "Streaming stops after a malformed line.",
          comments: [{ user: "pamelafox", body: "Thanks for the report" }],
        },
        { number: 12, title: "Flawed parsing logic", state: "open" as const, user: "reporter" },
      ],
      pull_requests: [
        {
          number: 10,
          title: "Release version 1.2.0",
          state: "closed" as const,
          user: "pamelafox",
          merged: true,
          base_ref: "main",
          head_ref: "release-1.2.0",
          head_sha: "a".repeat(40),
          merge_commit_sha: "b".repeat(40),
        },
        {
          number: 17,
          title: "Release v1.4.0",
          state: "closed" as const,
          user: "pamelafox",
          merged: true,
          base_ref: "main",
          head_ref: "release-1.4.0",
          head_sha: "c".repeat(40),
          comments: [{ user: "reporter", body: "Nice" }],
        },
      ],
    },
  ],
};

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "pamelafox", id: 1, scopes: ["repo", "user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as never, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, scenarioConfig);

  return { app, store };
}

const auth = { Authorization: "token test-token" };
const repoPath = "/repos/pamelafox/ndjson-readablestream";

describe("issue and pull request seeding", () => {
  it("seeds issues and pull requests as separate lists", () => {
    const { store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "pamelafox/ndjson-readablestream")!;

    const issues = gh.issues.findBy("repo_id", repo.id).filter((i) => !i.is_pull_request);
    const pulls = gh.pullRequests.findBy("repo_id", repo.id);

    expect(issues).toHaveLength(3);
    expect(pulls).toHaveLength(2);
  });

  it("creates two rows for every pull request", () => {
    const { store } = createTestApp();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "pamelafox/ndjson-readablestream")!;

    // A PR must also exist as an issue row, or comments and numbering break.
    const prIssueRows = gh.issues.findBy("repo_id", repo.id).filter((i) => i.is_pull_request);
    expect(prIssueRows.map((i) => i.number).sort((a, b) => a - b)).toEqual([10, 17]);
    expect(
      gh.pullRequests
        .findBy("repo_id", repo.id)
        .map((p) => p.number)
        .sort((a, b) => a - b),
    ).toEqual([10, 17]);
  });

  it("shares one number sequence, so the next created item continues it", async () => {
    const { app } = createTestApp();

    const res = await app.request(`${repoPath}/issues`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { number: number };

    // Highest seeded number is 17, across both lists.
    expect(created.number).toBe(18);
  });

  it("serves a seeded issue by its exact number with labels and comments", async () => {
    const { app } = createTestApp();

    const res = await app.request(`${repoPath}/issues/11`, { headers: auth });
    expect(res.status).toBe(200);
    const issue = (await res.json()) as {
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      comments: number;
      body: string;
    };

    expect(issue.number).toBe(11);
    expect(issue.title).toBe("Malformed JSON can break streaming");
    expect(issue.state).toBe("open");
    expect(issue.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(issue.comments).toBe(1);
    expect(issue.body).toContain("malformed line");
  });

  it("does not list pull requests as issues", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${repoPath}/issues?state=all`, { headers: auth });
    const issues = (await res.json()) as Array<{ number: number }>;
    const numbers = issues.map((i) => i.number).sort((a, b) => a - b);
    expect(numbers).toEqual([4, 11, 12]);
  });

  it("serves seeded pull requests with branch and merge metadata", async () => {
    const { app } = createTestApp();

    const res = await app.request(`${repoPath}/pulls/17`, { headers: auth });
    expect(res.status).toBe(200);
    const pr = (await res.json()) as {
      number: number;
      merged: boolean;
      base: { ref: string };
      head: { ref: string; sha: string };
    };

    expect(pr.number).toBe(17);
    expect(pr.merged).toBe(true);
    expect(pr.base.ref).toBe("main");
    expect(pr.head.ref).toBe("release-1.4.0");
    expect(pr.head.sha).toBe("c".repeat(40));
  });

  it("serves comments on both issues and pull requests", async () => {
    const { app } = createTestApp();

    const issueComments = await app.request(`${repoPath}/issues/11/comments`, { headers: auth });
    expect(((await issueComments.json()) as unknown[]).length).toBe(1);

    const prComments = await app.request(`${repoPath}/issues/17/comments`, { headers: auth });
    expect(((await prComments.json()) as unknown[]).length).toBe(1);
  });

  it("seeds repository labels", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${repoPath}/labels`, { headers: auth });
    const labels = (await res.json()) as Array<{ name: string; color: string }>;
    expect(labels.map((l) => l.name).sort()).toEqual(["bug", "enhancement"]);
    expect(labels.find((l) => l.name === "bug")!.color).toBe("d73a4a");
  });
});
