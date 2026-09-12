import type { GitHubStore } from "./store.js";
import type { GitHubIssue, GitHubLabel, GitHubPullRequest, GitHubRepo } from "./entities.js";
import { generateNodeId } from "./helpers.js";

export interface SeedComment {
  user?: string;
  body?: string;
  body_file?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SeedIssue {
  number: number;
  title: string;
  body?: string;
  body_file?: string;
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | null;
  user?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
  locked?: boolean;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  comments?: SeedComment[];
}

export interface SeedPullRequest extends SeedIssue {
  base_ref?: string;
  base_sha?: string;
  head_ref?: string;
  head_sha?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: string;
  merge_commit_sha?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
}

export interface SeedLabel {
  name: string;
  color?: string;
  description?: string;
  default?: boolean;
}

type BodyReader = (path: string) => string;

function readBody(entry: { body?: string; body_file?: string }, readFile: BodyReader): string | null {
  if (entry.body !== undefined) return entry.body;
  if (entry.body_file) return readFile(entry.body_file);
  return null;
}

function userId(gh: GitHubStore, login: string | undefined, fallback: number): number {
  if (!login) return fallback;
  return gh.users.findOneBy("login", login)?.id ?? fallback;
}

export function seedLabels(gh: GitHubStore, repo: GitHubRepo, labels: SeedLabel[]): void {
  for (const label of labels) {
    const existing = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === label.name);
    if (existing) continue;
    const row = gh.labels.insert({
      repo_id: repo.id,
      node_id: "",
      name: label.name,
      description: label.description ?? null,
      color: (label.color ?? "ededed").replace(/^#/, ""),
      default: label.default ?? false,
    } as Parameters<typeof gh.labels.insert>[0]);
    gh.labels.update(row.id, { node_id: generateNodeId("Label", row.id) });
  }
}

function resolveLabelIds(gh: GitHubStore, repo: GitHubRepo, names: string[] | undefined): number[] {
  if (!names?.length) return [];
  const ids: number[] = [];
  for (const name of names) {
    let label: GitHubLabel | undefined = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
    if (!label) {
      seedLabels(gh, repo, [{ name }]);
      label = gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
    }
    if (label) ids.push(label.id);
  }
  return ids;
}

function resolveUserIds(gh: GitHubStore, logins: string[] | undefined): number[] {
  if (!logins?.length) return [];
  return logins.map((login) => gh.users.findOneBy("login", login)?.id).filter((id): id is number => id !== undefined);
}

function seedComments(
  gh: GitHubStore,
  repo: GitHubRepo,
  issueNumber: number,
  comments: SeedComment[] | undefined,
  readFile: BodyReader,
  fallbackUser: number,
): number {
  if (!comments?.length) return 0;
  for (const comment of comments) {
    const row = gh.comments.insert({
      repo_id: repo.id,
      node_id: "",
      issue_number: issueNumber,
      pull_number: null,
      commit_sha: null,
      body: readBody(comment, readFile) ?? "",
      user_id: userId(gh, comment.user, fallbackUser),
      in_reply_to_id: null,
      path: null,
      position: null,
      line: null,
      side: null,
      subject_type: null,
      comment_type: "issue",
      review_id: null,
    } as Parameters<typeof gh.comments.insert>[0]);
    gh.comments.update(row.id, { node_id: generateNodeId("IssueComment", row.id) });
  }
  return comments.length;
}

/**
 * Inserts the issue row shared by issues and pull requests. On GitHub, and in
 * this store, a pull request is also an issue: it occupies the same number
 * sequence and owns the conversation comments.
 */
function insertIssueRow(
  gh: GitHubStore,
  repo: GitHubRepo,
  entry: SeedIssue,
  isPullRequest: boolean,
  readFile: BodyReader,
  fallbackUser: number,
): GitHubIssue {
  const state = entry.state ?? "open";
  const row = gh.issues.insert({
    node_id: "",
    number: entry.number,
    repo_id: repo.id,
    title: entry.title,
    body: readBody(entry, readFile),
    state,
    state_reason: entry.state_reason ?? null,
    locked: entry.locked ?? false,
    active_lock_reason: null,
    user_id: userId(gh, entry.user, fallbackUser),
    assignee_ids: resolveUserIds(gh, entry.assignees),
    label_ids: resolveLabelIds(gh, repo, entry.labels),
    milestone_id: null,
    comments: entry.comments?.length ?? 0,
    closed_at: entry.closed_at ?? (state === "closed" ? entry.updated_at ?? null : null),
    closed_by_id: null,
    is_pull_request: isPullRequest,
  } as Parameters<typeof gh.issues.insert>[0]);

  gh.issues.update(row.id, {
    node_id: generateNodeId(isPullRequest ? "PullRequest" : "Issue", row.id),
    ...(entry.created_at ? { created_at: entry.created_at } : {}),
    ...(entry.updated_at ? { updated_at: entry.updated_at } : {}),
  });

  return gh.issues.get(row.id)!;
}

export function seedIssues(
  gh: GitHubStore,
  repo: GitHubRepo,
  issues: SeedIssue[],
  readFile: BodyReader,
  fallbackUser: number,
): void {
  for (const entry of issues) {
    const existing = gh.issues.findBy("repo_id", repo.id).find((i) => i.number === entry.number);
    if (existing) continue;
    insertIssueRow(gh, repo, entry, false, readFile, fallbackUser);
    seedComments(gh, repo, entry.number, entry.comments, readFile, fallbackUser);
  }
  gh.repos.update(repo.id, {
    open_issues_count: gh.issues.findBy("repo_id", repo.id).filter((i) => i.state === "open").length,
  });
}

export function seedPullRequests(
  gh: GitHubStore,
  repo: GitHubRepo,
  pulls: SeedPullRequest[],
  readFile: BodyReader,
  fallbackUser: number,
): void {
  for (const entry of pulls) {
    const existing = gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === entry.number);
    if (existing) continue;

    // Both rows are required: the issue row carries the conversation and the
    // shared number sequence, the pull request row carries the branch metadata.
    const issueRow = insertIssueRow(gh, repo, entry, true, readFile, fallbackUser);
    seedComments(gh, repo, entry.number, entry.comments, readFile, fallbackUser);

    const merged = entry.merged ?? false;
    const state = entry.state ?? (merged ? "closed" : "open");

    const prRow = gh.pullRequests.insert({
      node_id: "",
      number: entry.number,
      repo_id: repo.id,
      title: entry.title,
      body: issueRow.body,
      state,
      locked: entry.locked ?? false,
      user_id: issueRow.user_id,
      assignee_ids: issueRow.assignee_ids,
      label_ids: issueRow.label_ids,
      milestone_id: null,
      head_ref: entry.head_ref ?? `pull-${entry.number}`,
      head_sha: entry.head_sha ?? "",
      head_repo_id: repo.id,
      base_ref: entry.base_ref ?? repo.default_branch,
      base_sha: entry.base_sha ?? "",
      base_repo_id: repo.id,
      merged,
      merged_at: entry.merged_at ?? null,
      merged_by_id: entry.merged_by ? (gh.users.findOneBy("login", entry.merged_by)?.id ?? null) : null,
      merge_commit_sha: entry.merge_commit_sha ?? null,
      mergeable: merged ? null : true,
      mergeable_state: merged ? "unknown" : "clean",
      comments: entry.comments?.length ?? 0,
      review_comments: 0,
      commits: entry.commits ?? 1,
      additions: entry.additions ?? 0,
      deletions: entry.deletions ?? 0,
      changed_files: entry.changed_files ?? 0,
      draft: entry.draft ?? false,
      requested_reviewer_ids: [],
      requested_team_ids: [],
      closed_at: entry.closed_at ?? (state === "closed" ? entry.merged_at ?? null : null),
      auto_merge: null,
    } as unknown as Parameters<typeof gh.pullRequests.insert>[0]);

    gh.pullRequests.update(prRow.id, {
      node_id: generateNodeId("PullRequest", prRow.id),
      ...(entry.created_at ? { created_at: entry.created_at } : {}),
      ...(entry.updated_at ? { updated_at: entry.updated_at } : {}),
    } as Partial<GitHubPullRequest>);
  }
}
