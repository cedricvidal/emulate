import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import type { GitHubStore } from "./store.js";
import type { GitHubRepo } from "./entities.js";
import { generateNodeId } from "./helpers.js";
import { findOrCreateBlob, findOrCreateCommit, findOrCreateTree, type GitTreeEntry } from "./git-helpers.js";
import { ensureBareRepo, repoGitDir, resolveGitDir, syncFromGit } from "./git-mirror.js";

export interface RepoContentSource {
  git_source?: string;
  from_path?: string;
  files?: Record<string, string>;
  initial_commit?: {
    message?: string;
    author_name?: string;
    author_email?: string;
    date?: string;
  };
}

/**
 * Fixed defaults so a seeded repository produces the same commit SHA on every
 * reset. Evaluation runs compare against a known base commit, so a timestamp
 * that moved per run would make results noisy.
 */
const DEFAULT_COMMIT = {
  message: "Initial commit",
  author_name: "emulate",
  author_email: "emulate@localhost",
  date: "2020-01-01T00:00:00Z",
};

function collectFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };

  walk(root);
  return files;
}

/**
 * Builds nested tree objects from flat paths, so a seeded directory produces the
 * same tree structure git would.
 */
function buildTree(gh: GitHubStore, repoId: number, files: Record<string, string>, prefix: string): string {
  const entries: GitTreeEntry[] = [];
  const subdirs = new Map<string, Record<string, string>>();

  for (const [path, content] of Object.entries(files)) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      const blob = findOrCreateBlob(gh, repoId, Buffer.from(content, "utf8"));
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
        size: blob.size,
      });
      continue;
    }
    const dir = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    if (!subdirs.has(dir)) subdirs.set(dir, {});
    subdirs.get(dir)![rest] = content;
  }

  for (const [dir, contents] of subdirs) {
    const sha = buildTree(gh, repoId, contents, `${prefix}${dir}/`);
    entries.push({ path: dir, mode: "040000", type: "tree", sha });
  }

  return findOrCreateTree(gh, repoId, entries).sha;
}

function seedFromFiles(
  gh: GitHubStore,
  repo: GitHubRepo,
  ownerId: number,
  files: Record<string, string>,
  overrides: RepoContentSource["initial_commit"],
): void {
  const commitInfo = { ...DEFAULT_COMMIT, ...overrides };
  const treeSha = buildTree(gh, repo.id, files, "");

  const commit = findOrCreateCommit(gh, repo.id, {
    message: commitInfo.message,
    author_name: commitInfo.author_name,
    author_email: commitInfo.author_email,
    author_date: commitInfo.date,
    committer_name: commitInfo.author_name,
    committer_email: commitInfo.author_email,
    committer_date: commitInfo.date,
    tree_sha: treeSha,
    parent_shas: [],
    user_id: ownerId,
  });

  gh.branches.insert({
    repo_id: repo.id,
    name: repo.default_branch,
    sha: commit.sha,
    protected: false,
  } as Parameters<typeof gh.branches.insert>[0]);

  const refRow = gh.refs.insert({
    repo_id: repo.id,
    ref: `refs/heads/${repo.default_branch}`,
    sha: commit.sha,
    node_id: "",
  } as Parameters<typeof gh.refs.insert>[0]);
  gh.refs.update(refRow.id, { node_id: generateNodeId("Ref", refRow.id) });

  gh.repos.update(repo.id, { pushed_at: commitInfo.date, size: Object.keys(files).length });
}

/**
 * Copies a bare repository into the mirror root and ingests it, preserving the
 * original commit SHAs and full history.
 */
function seedFromGitSource(gh: GitHubStore, repo: GitHubRepo, source: string): void {
  if (!existsSync(source)) {
    throw new Error(`git_source not found for ${repo.full_name}: ${source}`);
  }

  const gitDir = repoGitDir(resolveGitDir(), repo);
  ensureBareRepo(gitDir, repo.default_branch);
  // A bare repo is self-contained, so a plain recursive copy is enough and
  // avoids depending on the source remaining available later.
  cpSync(source, gitDir, { recursive: true });
  syncFromGit(gh, repo, gitDir);
}

export function hasContentSource(source: RepoContentSource): boolean {
  return Boolean(source.git_source || source.from_path || source.files);
}

/**
 * Applies a repository content source. Returns false when the entry has no
 * content source, so the caller can fall back to `auto_init`.
 */
export function seedRepoContents(
  gh: GitHubStore,
  repo: GitHubRepo,
  ownerId: number,
  source: RepoContentSource,
): boolean {
  if (source.git_source) {
    seedFromGitSource(gh, repo, source.git_source);
    return true;
  }

  if (source.from_path) {
    if (!existsSync(source.from_path)) {
      throw new Error(`from_path not found for ${repo.full_name}: ${source.from_path}`);
    }
    seedFromFiles(gh, repo, ownerId, collectFiles(source.from_path), source.initial_commit);
    return true;
  }

  if (source.files) {
    seedFromFiles(gh, repo, ownerId, source.files, source.initial_commit);
    return true;
  }

  return false;
}
