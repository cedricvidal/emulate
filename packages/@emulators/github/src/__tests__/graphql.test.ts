import { describe, it, expect } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as never, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "reporter" }],
    repos: [
      {
        owner: "octocat",
        name: "demo",
        files: { "index.mjs": "export const a = 1\n" },
        labels: [{ name: "bug", color: "d73a4a" }],
        issues: [
          {
            number: 11,
            title: "Malformed JSON can break streaming",
            state: "open",
            user: "reporter",
            labels: ["bug"],
            body: "Streaming stops.",
            comments: [{ user: "octocat", body: "Looking" }],
          },
        ],
        pull_requests: [
          {
            number: 17,
            title: "Release v1.4.0",
            state: "closed",
            user: "octocat",
            merged: true,
            base_ref: "main",
            head_ref: "release",
            head_sha: "c".repeat(40),
          },
        ],
      },
    ],
  });

  return { app, store };
}

async function gql(
  app: ReturnType<typeof createTestApp>["app"],
  query: string,
  variables?: Record<string, unknown>,
  path = "/graphql",
) {
  const res = await app.request(path, {
    method: "POST",
    headers: { Authorization: "token test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as { data?: never; errors?: Array<{ message: string }> } };
}

describe("graphql", () => {
  it("resolves the viewer, which gh auth status depends on", async () => {
    const { app } = createTestApp();
    const { body } = await gql(app, "query UserCurrent{viewer{login}}");
    expect(body.errors).toBeUndefined();
    expect((body.data as never as { viewer: { login: string } }).viewer.login).toBe("octocat");
  });

  it("serves the RepositoryInfo query gh uses for repo view and pr create", async () => {
    const { app } = createTestApp();
    const { body } = await gql(
      app,
      `fragment repo on Repository {
         id name owner { login } hasIssuesEnabled description hasWikiEnabled
         viewerPermission defaultBranchRef { name }
       }
       query RepositoryInfo($owner: String!, $name: String!) {
         repository(owner: $owner, name: $name) {
           ...repo
           parent { ...repo }
           mergeCommitAllowed rebaseMergeAllowed squashMergeAllowed
         }
       }`,
      { owner: "octocat", name: "demo" },
    );
    expect(body.errors).toBeUndefined();
    const repo = (body.data as never as { repository: Record<string, unknown> }).repository;
    expect(repo.name).toBe("demo");
    expect(repo.viewerPermission).toBe("ADMIN");
    expect((repo.defaultBranchRef as { name: string }).name).toBe("main");
  });

  it("selects state on both union members without aliasing, as gh issue view does", async () => {
    const { app } = createTestApp();
    // Issue.state and PullRequest.state must share an enum, otherwise the
    // overlapping-fields rule rejects this query.
    const { body } = await gql(
      app,
      `query IssueByNumber($owner: String!, $repo: String!, $number: Int!) {
         repository(owner: $owner, name: $repo) {
           hasIssuesEnabled
           issue: issueOrPullRequest(number: $number) {
             __typename
             ... on Issue { number url state title body labels(first: 10) { nodes { name } totalCount } }
             ... on PullRequest { number url state title }
           }
         }
       }`,
      { owner: "octocat", repo: "demo", number: 11 },
    );
    expect(body.errors).toBeUndefined();
    const issue = (body.data as never as { repository: { issue: Record<string, unknown> } }).repository.issue;
    expect(issue.__typename).toBe("Issue");
    expect(issue.number).toBe(11);
    expect(issue.state).toBe("OPEN");
  });

  it("resolves a pull request through the same union", async () => {
    const { app } = createTestApp();
    const { body } = await gql(
      app,
      `query($owner: String!, $repo: String!, $number: Int!) {
         repository(owner: $owner, name: $repo) {
           issueOrPullRequest(number: $number) { __typename ... on PullRequest { number state merged } }
         }
       }`,
      { owner: "octocat", repo: "demo", number: 17 },
    );
    expect(body.errors).toBeUndefined();
    const pr = (body.data as never as { repository: { issueOrPullRequest: Record<string, unknown> } }).repository
      .issueOrPullRequest;
    expect(pr.__typename).toBe("PullRequest");
    expect(pr.state).toBe("MERGED");
    expect(pr.merged).toBe(true);
  });

  it("filters issue and pull request connections", async () => {
    const { app } = createTestApp();
    const { body } = await gql(
      app,
      `query($owner: String!, $repo: String!) {
         repository(owner: $owner, name: $repo) {
           issues(first: 30, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
             totalCount nodes { number } pageInfo { hasNextPage }
           }
           pullRequests(first: 30, states: [MERGED], baseRefName: "main") { totalCount nodes { number } }
         }
       }`,
      { owner: "octocat", repo: "demo" },
    );
    expect(body.errors).toBeUndefined();
    const repo = body.data as never as {
      repository: { issues: { nodes: Array<{ number: number }> }; pullRequests: { nodes: Array<{ number: number }> } };
    };
    expect(repo.repository.issues.nodes.map((i) => i.number)).toEqual([11]);
    expect(repo.repository.pullRequests.nodes.map((p) => p.number)).toEqual([17]);
  });

  it("supports the introspection gh uses to size its queries", async () => {
    const { app } = createTestApp();
    const { body } = await gql(
      app,
      `query PullRequest_fields {
         PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
         StatusCheckRollupContextConnection: __type(name: "StatusCheckRollupContextConnection") {
           fields(includeDeprecated: true) { name }
         }
       }`,
    );
    expect(body.errors).toBeUndefined();
    const data = body.data as never as { PullRequest: { fields: Array<{ name: string }> } };
    expect(data.PullRequest.fields.map((f) => f.name)).toContain("mergeStateStatus");
  });

  it("creates a pull request and keeps REST consistent", async () => {
    const { app } = createTestApp();

    const repoRes = await gql(app, `query{repository(owner:"octocat",name:"demo"){id defaultBranchRef{target{oid}}}}`);
    const repoId = (repoRes.body.data as never as { repository: { id: string } }).repository.id;

    // A head branch must exist before a pull request can point at it.
    const mainSha = (repoRes.body.data as never as { repository: { defaultBranchRef: { target: { oid: string } } } })
      .repository.defaultBranchRef.target.oid;
    await app.request("/repos/octocat/demo/git/refs", {
      method: "POST",
      headers: { Authorization: "token test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/feature", sha: mainSha }),
    });

    const { body } = await gql(
      app,
      `mutation($input: CreatePullRequestInput!) {
         createPullRequest(input: $input) { pullRequest { number title baseRefName headRefName state } }
       }`,
      { input: { repositoryId: repoId, baseRefName: "main", headRefName: "feature", title: "New", body: "Fixes #11" } },
    );
    expect(body.errors).toBeUndefined();
    const pr = (body.data as never as { createPullRequest: { pullRequest: Record<string, unknown> } }).createPullRequest
      .pullRequest;
    // Seeded numbers run to 17, so the created pull request continues at 18.
    expect(pr.number).toBe(18);
    expect(pr.headRefName).toBe("feature");

    const rest = await app.request("/repos/octocat/demo/pulls/18", {
      headers: { Authorization: "token test-token" },
    });
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as { title: string }).title).toBe("New");
  });

  it("adds a comment through the mutation gh issue comment uses", async () => {
    const { app } = createTestApp();
    const idRes = await gql(
      app,
      `query{repository(owner:"octocat",name:"demo"){issueOrPullRequest(number:11){...on Issue{id}}}}`,
    );
    const id = (idRes.body.data as never as { repository: { issueOrPullRequest: { id: string } } }).repository
      .issueOrPullRequest.id;

    const { body } = await gql(
      app,
      `mutation($input: AddCommentInput!){addComment(input:$input){commentEdge{node{body}}}}`,
      { input: { subjectId: id, body: "from graphql" } },
    );
    expect(body.errors).toBeUndefined();

    const rest = await app.request("/repos/octocat/demo/issues/11/comments", {
      headers: { Authorization: "token test-token" },
    });
    const comments = (await rest.json()) as Array<{ body: string }>;
    expect(comments.map((c) => c.body)).toContain("from graphql");
  });

  it("is mounted at /api/graphql for the MCP server", async () => {
    const { app } = createTestApp();
    const { body } = await gql(app, "query{viewer{login}}", undefined, "/api/graphql");
    expect(body.errors).toBeUndefined();
    expect((body.data as never as { viewer: { login: string } }).viewer.login).toBe("octocat");
  });

  it("reports errors with a 200, the way GitHub does", async () => {
    const { app } = createTestApp();
    const { status, body } = await gql(app, 'query{repository(owner:"octocat",name:"demo"){nope}}');
    expect(status).toBe(200);
    expect(body.errors?.[0].message).toMatch(/Cannot query field/);
  });
});
