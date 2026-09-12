#!/usr/bin/env node
/**
 * Imports a real GitHub repository into emulate seed state.
 *
 * Produces a self-contained directory holding a bare repository with full
 * history plus a seed config describing users, labels, issues, and pull
 * requests. Emulate then serves that state over REST, GraphQL, and Git smart
 * HTTP, so an agent can clone it, push to it, and open pull requests against it.
 *
 *   scripts/import-github <owner/repo> [options]
 *
 *   --ref <sha>        Commit to record as the pinned import ref
 *   --as <owner/repo>  Serve the repository under a different name
 *   --out <dir>        Output directory (default: ./emulate-import)
 *   --snapshot <dir>   Alias for --out, kept for symmetry with the container flags
 *   --token <token>    GitHub token (default: GITHUB_TOKEN or GH_TOKEN)
 *   --rest             Force the REST path even when a token is present
 *
 * A token is strongly recommended. The GraphQL API requires one and costs a
 * single point for the whole import; unauthenticated REST allows only 60
 * requests per hour, which a moderately sized repository can exhaust.
 */

import { execFile } from "child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const API = "https://api.github.com";
const MAX_ATTEMPTS = 6;
const MAX_TOTAL_WAIT_MS = 10 * 60 * 1000;

function fail(message) {
  console.error(`import-github: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: "./emulate-import" };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") args.ref = argv[++i];
    else if (arg === "--as") args.as = argv[++i];
    else if (arg === "--out" || arg === "--snapshot") args.out = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--rest") args.forceRest = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    else rest.push(arg);
  }

  args.source = rest[0];
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let totalWaited = 0;

async function waitFor(ms, reason) {
  if (totalWaited + ms > MAX_TOTAL_WAIT_MS) {
    fail(
      `giving up: waiting ${Math.round(ms / 1000)}s for ${reason} would exceed the ` +
        `${MAX_TOTAL_WAIT_MS / 60000} minute total wait budget. Set GITHUB_TOKEN for a much higher rate limit.`,
    );
  }
  totalWaited += ms;
  console.error(`  waiting ${Math.round(ms / 1000)}s (${reason})`);
  await sleep(ms);
}

/**
 * Performs a request, honouring GitHub's documented retry signals in priority
 * order: an explicit Retry-After, then an exhausted primary rate limit, then
 * secondary-limit and transient-error backoff. Client errors are never retried.
 */
async function request(url, options, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "emulate-import-github",
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) fail(`network error after ${MAX_ATTEMPTS} attempts: ${error.message}`);
      await waitFor(Math.min(2 ** attempt, 30) * 1000, "network error");
      continue;
    }

    if (res.ok) return res;

    const requestId = res.headers.get("x-github-request-id") ?? "unknown";

    // 401, 404 and 422 are never transient. Failing fast beats retrying a
    // request that cannot succeed.
    if ([401, 404, 422].includes(res.status)) {
      const body = await res.text();
      fail(`${res.status} for ${url} (request id ${requestId}): ${body.slice(0, 300)}`);
    }

    const retryAfter = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");

    if (retryAfter) {
      await waitFor(Number(retryAfter) * 1000, "Retry-After header");
    } else if (remaining === "0" && reset) {
      const waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
      await waitFor(waitMs, "primary rate limit exhausted");
    } else if (res.status === 403 || res.status === 429) {
      await waitFor(Math.min(60 * attempt, 180) * 1000, "secondary rate limit");
    } else if (res.status >= 500) {
      const jitter = Math.random() * 1000;
      await waitFor(Math.min(2 ** attempt, 30) * 1000 + jitter, `server error ${res.status}`);
    } else {
      const body = await res.text();
      fail(`${res.status} for ${url} (request id ${requestId}): ${body.slice(0, 300)}`);
    }
  }

  fail(`exhausted ${MAX_ATTEMPTS} attempts for ${url}`);
}

async function graphql(query, variables, token) {
  const res = await request(
    `${API}/graphql`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) },
    token,
  );
  const body = await res.json();
  if (body.errors?.length) {
    fail(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

async function restJson(path, token) {
  const res = await request(`${API}${path}`, {}, token);
  return res.json();
}

async function restPaged(path, token) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await restJson(`${path}${sep}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

const SHARED_FIELDS = `
  number title body state createdAt updatedAt closedAt locked
  author { __typename login }
  labels(first: 50) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  comments(first: 100) { totalCount nodes { body createdAt author { login } } }
`;

const IMPORT_QUERY = `
query Import($owner: String!, $name: String!, $issueCursor: String, $prCursor: String) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
    name description isPrivate hasIssuesEnabled
    defaultBranchRef { name }
    primaryLanguage { name }
    repositoryTopics(first: 20) { nodes { topic { name } } }
    owner { __typename login }
    labels(first: 100) { nodes { name color description isDefault } }
    issues(first: 100, after: $issueCursor, states: [OPEN, CLOSED], orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${SHARED_FIELDS} stateReason }
    }
    pullRequests(first: 100, after: $prCursor, states: [OPEN, CLOSED, MERGED], orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${SHARED_FIELDS}
        isDraft merged mergedAt baseRefName baseRefOid headRefName headRefOid
        additions deletions changedFiles
        mergedBy { login }
        mergeCommit { oid }
        commits { totalCount }
      }
    }
  }
}`;

function mapComments(node) {
  return (node.comments?.nodes ?? [])
    .filter(Boolean)
    .map((c) => ({ user: c.author?.login, body: c.body ?? "", created_at: c.createdAt }));
}

function mapIssueCommon(node) {
  return {
    number: node.number,
    title: node.title,
    body: node.body || undefined,
    state: node.state === "OPEN" ? "open" : "closed",
    user: node.author?.login,
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    assignees: (node.assignees?.nodes ?? []).map((a) => a.login),
    locked: node.locked || undefined,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    closed_at: node.closedAt ?? undefined,
    comments: mapComments(node),
  };
}

async function collectViaGraphQL(owner, name, token) {
  const issues = [];
  const pulls = [];
  let repo = null;
  let issueCursor = null;
  let prCursor = null;
  let issuesDone = false;
  let prsDone = false;
  let cost = 0;

  while (!issuesDone || !prsDone) {
    const data = await graphql(IMPORT_QUERY, { owner, name, issueCursor, prCursor }, token);
    if (!data.repository) fail(`repository not found: ${owner}/${name}`);
    repo ??= data.repository;
    cost += data.rateLimit?.cost ?? 0;

    if (!issuesDone) {
      issues.push(...data.repository.issues.nodes);
      issuesDone = !data.repository.issues.pageInfo.hasNextPage;
      issueCursor = data.repository.issues.pageInfo.endCursor;
    }
    if (!prsDone) {
      pulls.push(...data.repository.pullRequests.nodes);
      prsDone = !data.repository.pullRequests.pageInfo.hasNextPage;
      prCursor = data.repository.pullRequests.pageInfo.endCursor;
    }
  }

  console.error(`  GraphQL cost: ${cost} point(s)`);

  return {
    repo: {
      description: repo.description,
      private: repo.isPrivate,
      default_branch: repo.defaultBranchRef?.name ?? "main",
      language: repo.primaryLanguage?.name,
      topics: (repo.repositoryTopics?.nodes ?? []).map((t) => t.topic.name),
      ownerType: repo.owner.__typename,
    },
    labels: (repo.labels?.nodes ?? []).map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description ?? undefined,
      default: l.isDefault || undefined,
    })),
    issues: issues.map(mapIssueCommon),
    pulls: pulls.map((node) => ({
      ...mapIssueCommon(node),
      draft: node.isDraft || undefined,
      merged: node.merged || undefined,
      merged_at: node.mergedAt ?? undefined,
      merged_by: node.mergedBy?.login,
      merge_commit_sha: node.mergeCommit?.oid ?? undefined,
      base_ref: node.baseRefName,
      base_sha: node.baseRefOid,
      head_ref: node.headRefName,
      head_sha: node.headRefOid,
      additions: node.additions,
      deletions: node.deletions,
      changed_files: node.changedFiles,
      commits: node.commits?.totalCount,
    })),
  };
}

async function collectViaRest(owner, name, token) {
  console.error("  using REST (no token available for GraphQL)");
  const repo = await restJson(`/repos/${owner}/${name}`, token);
  const labels = await restPaged(`/repos/${owner}/${name}/labels`, token);
  const allIssues = await restPaged(`/repos/${owner}/${name}/issues?state=all`, token);
  const allPulls = await restPaged(`/repos/${owner}/${name}/pulls?state=all`, token);

  const withComments = async (item) => {
    const comments = item.comments
      ? await restPaged(`/repos/${owner}/${name}/issues/${item.number}/comments`, token)
      : [];
    return comments.map((c) => ({ user: c.user?.login, body: c.body ?? "", created_at: c.created_at }));
  };

  const issues = [];
  for (const issue of allIssues.filter((i) => !i.pull_request)) {
    issues.push({
      number: issue.number,
      title: issue.title,
      body: issue.body || undefined,
      state: issue.state,
      user: issue.user?.login,
      labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
      assignees: (issue.assignees ?? []).map((a) => a.login),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at ?? undefined,
      comments: await withComments(issue),
    });
  }

  const pulls = [];
  for (const pr of allPulls) {
    pulls.push({
      number: pr.number,
      title: pr.title,
      body: pr.body || undefined,
      state: pr.state,
      user: pr.user?.login,
      labels: (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
      assignees: (pr.assignees ?? []).map((a) => a.login),
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      closed_at: pr.closed_at ?? undefined,
      draft: pr.draft || undefined,
      merged: Boolean(pr.merged_at) || undefined,
      merged_at: pr.merged_at ?? undefined,
      merge_commit_sha: pr.merge_commit_sha ?? undefined,
      base_ref: pr.base?.ref,
      base_sha: pr.base?.sha,
      head_ref: pr.head?.ref,
      head_sha: pr.head?.sha,
      comments: await withComments({ ...pr, comments: 1 }),
    });
  }

  return {
    repo: {
      description: repo.description,
      private: repo.private,
      default_branch: repo.default_branch,
      language: repo.language,
      topics: repo.topics ?? [],
      ownerType: repo.owner?.type ?? "User",
    },
    labels: labels.map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description ?? undefined,
      default: l.default || undefined,
    })),
    issues,
    pulls,
  };
}

async function cloneMirror(owner, name, target) {
  console.error(`  cloning https://github.com/${owner}/${name}.git`);
  mkdirSync(dirname(target), { recursive: true });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileAsync(
        "git",
        ["-c", "safe.bareRepository=all", "clone", "--mirror", "--quiet", `https://github.com/${owner}/${name}.git`, target],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
      return;
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      if (attempt === 3) fail(`git clone failed after 3 attempts: ${error.message}`);
      await waitFor(2 ** attempt * 1000, "clone retry");
    }
  }
}

async function countCommits(gitDir) {
  try {
    const { stdout } = await execFileAsync("git", [
      "-c",
      "safe.bareRepository=all",
      `--git-dir=${gitDir}`,
      "rev-list",
      "--all",
      "--count",
    ]);
    return Number(stdout.trim());
  } catch {
    return 0;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.source) {
    console.log(
      [
        "Usage: scripts/import-github <owner/repo> [options]",
        "",
        "  --ref <sha>        Commit to record as the pinned import ref",
        "  --as <owner/repo>  Serve the repository under a different name",
        "  --out <dir>        Output directory (default: ./emulate-import)",
        "  --snapshot <dir>   Alias for --out",
        "  --token <token>    GitHub token (default: GITHUB_TOKEN or GH_TOKEN)",
        "  --rest             Force the REST path even when a token is present",
      ].join("\n"),
    );
    process.exit(args.help ? 0 : 1);
  }

  const [owner, name] = args.source.split("/");
  if (!owner || !name) fail(`expected <owner/repo>, got: ${args.source}`);

  const [targetOwner, targetName] = (args.as ?? args.source).split("/");
  const token = args.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  if (!token) {
    console.error("  no token found: falling back to REST, limited to 60 requests per hour");
    console.error("  set GITHUB_TOKEN for a single-query GraphQL import");
  }

  const outDir = resolve(args.out);
  // Import into a staging directory and move it into place only on success, so
  // a failed run never leaves a partial snapshot for a later run to consume.
  const staging = `${outDir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    console.error(`importing ${owner}/${name}`);

    const gitDirRelative = join("repos", `${targetOwner}/${targetName}.git`);
    const gitDir = join(staging, gitDirRelative);
    await cloneMirror(owner, name, gitDir);

    const data = token && !args.forceRest
      ? await collectViaGraphQL(owner, name, token)
      : await collectViaRest(owner, name, token);

    // Every referenced login must exist as a user, otherwise the seed silently
    // drops the records that point at it.
    const logins = new Set([targetOwner]);
    for (const item of [...data.issues, ...data.pulls]) {
      if (item.user) logins.add(item.user);
      if (item.merged_by) logins.add(item.merged_by);
      for (const login of item.assignees ?? []) logins.add(login);
      for (const comment of item.comments ?? []) if (comment.user) logins.add(comment.user);
    }

    const commits = await countCommits(gitDir);

    const config = {
      tokens: {
        "demo-token": { login: targetOwner, scopes: ["repo", "read:org", "workflow", "gist"] },
      },
      github: {
        users: [...logins].sort().map((login) => ({ login })),
        repos: [
          {
            owner: targetOwner,
            name: targetName,
            description: data.repo.description ?? undefined,
            private: data.repo.private || undefined,
            language: data.repo.language ?? undefined,
            topics: data.repo.topics?.length ? data.repo.topics : undefined,
            default_branch: data.repo.default_branch,
            git_source: `./${gitDirRelative}`,
            labels: data.labels,
            issues: data.issues,
            pull_requests: data.pulls,
          },
        ],
      },
    };

    writeFileSync(join(staging, "emulate.config.json"), `${JSON.stringify(config, null, 2)}\n`);

    const manifest = {
      source: `${owner}/${name}`,
      served_as: `${targetOwner}/${targetName}`,
      ref: args.ref ?? null,
      imported_at: new Date().toISOString(),
      counts: {
        commits,
        issues: data.issues.length,
        pull_requests: data.pulls.length,
        numbered_items: data.issues.length + data.pulls.length,
        labels: data.labels.length,
        users: logins.size,
        comments: [...data.issues, ...data.pulls].reduce((n, i) => n + (i.comments?.length ?? 0), 0),
      },
    };
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    rmSync(outDir, { recursive: true, force: true });
    renameSync(staging, outDir);

    const c = manifest.counts;
    console.error(
      `imported ${c.issues} issues, ${c.pull_requests} pull requests ` +
        `(${c.numbered_items} numbered items), ${c.labels} labels, ${c.comments} comments, ${c.commits} commits`,
    );
    console.error(`wrote ${outDir}`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => fail(error.stack ?? error.message));
