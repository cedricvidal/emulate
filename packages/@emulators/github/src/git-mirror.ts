import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { deflateSync } from "zlib";
import type { GitHubStore } from "./store.js";
import type { GitHubRepo } from "./entities.js";
import { generateNodeId } from "./helpers.js";
import {
  blobBytes,
  findOrCreateBlob,
  gitCommitContent,
  gitObjectSha,
  treeContent,
  type GitTreeEntry,
} from "./git-helpers.js";

// A host or image git config can set safe.bareRepository=explicit, which makes git
// refuse to operate on the bare mirrors. Force it off for every invocation.
const GIT_SAFETY_ARGS = ["-c", "safe.bareRepository=all"];

export function gitArgs(args: string[]): string[] {
  return [...GIT_SAFETY_ARGS, ...args];
}

export function runGit(gitDir: string, args: string[], options: { input?: Buffer } = {}): string {
  return execFileSync("git", gitArgs([`--git-dir=${gitDir}`, ...args]), {
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function runGitBuffer(gitDir: string, args: string[]): Buffer {
  return execFileSync("git", gitArgs([`--git-dir=${gitDir}`, ...args]), {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function assertGitAvailable(): string {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      "git is required for the GitHub emulator's Git transport but was not found on PATH. " +
        "Install git, or omit the git directory configuration to disable Git transport.",
    );
  }
  return result.stdout.trim();
}

export function repoGitDir(root: string, repo: GitHubRepo): string {
  return join(root, `${repo.full_name}.git`);
}

let configuredGitDir: string | undefined;
let resolvedGitDir: string | undefined;

/**
 * Sets the directory holding the bare repository mirrors. Called from seed
 * config so a container can point the mirrors at a mounted volume.
 */
export function setGitDir(dir: string): void {
  configuredGitDir = dir;
  resolvedGitDir = undefined;
}

/**
 * Resolves the mirror root, creating a process-scoped temporary directory when
 * none was configured so Git transport works with no setup. The temporary
 * directory is removed on exit; an explicitly configured one is left alone.
 */
export function resolveGitDir(): string {
  if (resolvedGitDir) return resolvedGitDir;

  const configured = configuredGitDir ?? process.env.EMULATE_GIT_DIR;
  if (configured) {
    mkdirSync(configured, { recursive: true });
    resolvedGitDir = configured;
    return resolvedGitDir;
  }

  const temp = mkdtempSync(join(tmpdir(), "emulate-github-git-"));
  resolvedGitDir = temp;
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  return resolvedGitDir;
}

/** Test seam: forgets any resolved directory without deleting it. */
export function resetGitDirForTesting(): void {
  configuredGitDir = undefined;
  resolvedGitDir = undefined;
}

export function ensureBareRepo(gitDir: string, defaultBranch: string): void {
  if (existsSync(join(gitDir, "HEAD"))) return;
  mkdirSync(dirname(gitDir), { recursive: true });
  execFileSync("git", gitArgs(["init", "--bare", `--initial-branch=${defaultBranch}`, gitDir]), {
    stdio: "ignore",
  });
  execFileSync("git", gitArgs([`--git-dir=${gitDir}`, "config", "http.receivepack", "true"]), { stdio: "ignore" });
}

function looseObjectPath(gitDir: string, sha: string): string {
  return join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
}

/**
 * Writes a git object as a loose object. The SHA is already known because emulate
 * computes real git object IDs, so there is no need to shell out to hash-object.
 */
function writeLooseObject(gitDir: string, type: "blob" | "tree" | "commit", content: Buffer, sha: string): void {
  const path = looseObjectPath(gitDir, sha);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const header = Buffer.from(`${type} ${content.byteLength}\0`, "utf8");
  writeFileSync(path, deflateSync(Buffer.concat([header, content])));
}

export function syncToGit(gh: GitHubStore, repo: GitHubRepo, gitDir: string): void {
  ensureBareRepo(gitDir, repo.default_branch);

  for (const blob of gh.blobs.findBy("repo_id", repo.id)) {
    writeLooseObject(gitDir, "blob", blobBytes(blob), blob.sha);
  }
  for (const tree of gh.trees.findBy("repo_id", repo.id)) {
    writeLooseObject(gitDir, "tree", treeContent(tree.tree as GitTreeEntry[]), tree.sha);
  }
  for (const commit of gh.commits.findBy("repo_id", repo.id)) {
    writeLooseObject(gitDir, "commit", gitCommitContent(commit), commit.sha);
  }

  for (const ref of gh.refs.findBy("repo_id", repo.id)) {
    const path = join(gitDir, ref.ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${ref.sha}\n`);
  }

  const headPath = join(gitDir, "HEAD");
  const head = `ref: refs/heads/${repo.default_branch}\n`;
  if (!existsSync(headPath) || readFileSync(headPath, "utf8") !== head) {
    writeFileSync(headPath, head);
  }
}

interface ParsedCommit {
  sha: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

const COMMIT_FIELD = "\u0000";
const COMMIT_RECORD = "\u0001\n";

function readCommits(gitDir: string): ParsedCommit[] {
  // %x00 / %x01 are git format escapes: they must stay as literal two-character
  // sequences in argv, because a real NUL byte cannot be passed through execve.
  const format = ["%H", "%T", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%B"].join("%x00") + "%x01";

  let out: string;
  try {
    out = runGit(gitDir, ["log", "--all", "--reflog", "--reverse", `--format=${format}`]);
  } catch {
    return [];
  }

  const commits: ParsedCommit[] = [];
  for (const record of out.split(COMMIT_RECORD)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const fields = trimmed.split(COMMIT_FIELD);
    if (fields.length < 10) continue;
    commits.push({
      sha: fields[0].trim(),
      tree: fields[1].trim(),
      parents: fields[2].trim() ? fields[2].trim().split(/\s+/) : [],
      authorName: fields[3],
      authorEmail: fields[4],
      authorDate: fields[5],
      committerName: fields[6],
      committerEmail: fields[7],
      committerDate: fields[8],
      message: fields.slice(9).join(COMMIT_FIELD),
    });
  }
  return commits;
}

function readTreeEntries(gitDir: string, treeSha: string): GitTreeEntry[] {
  const out = runGit(gitDir, ["ls-tree", treeSha]);
  const entries: GitTreeEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [meta, path] = line.split("\t");
    const [mode, type, sha] = meta.split(/\s+/);
    entries.push({
      path,
      mode,
      type: type as GitTreeEntry["type"],
      sha,
    });
  }
  return entries;
}

function importTree(gh: GitHubStore, repo: GitHubRepo, gitDir: string, treeSha: string, seen: Set<string>): void {
  if (seen.has(treeSha)) return;
  seen.add(treeSha);

  const existing = gh.trees.findBy("repo_id", repo.id).find((t) => t.sha === treeSha);
  const entries = readTreeEntries(gitDir, treeSha);

  for (const entry of entries) {
    if (entry.type === "tree") {
      importTree(gh, repo, gitDir, entry.sha, seen);
    } else if (entry.type === "blob") {
      const hasBlob = gh.blobs.findBy("repo_id", repo.id).some((b) => b.sha === entry.sha);
      if (!hasBlob) {
        const content = runGitBuffer(gitDir, ["cat-file", "blob", entry.sha]);
        findOrCreateBlob(gh, repo.id, content);
      }
      const blob = gh.blobs.findBy("repo_id", repo.id).find((b) => b.sha === entry.sha);
      if (blob) entry.size = blob.size;
    }
  }

  if (existing) return;
  const tree = gh.trees.insert({
    repo_id: repo.id,
    sha: treeSha,
    node_id: "",
    tree: entries,
    truncated: false,
  } as Parameters<typeof gh.trees.insert>[0]);
  gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });
}

/**
 * Ingests a bare repository into the entity store. Used both to seed a repository
 * from an imported mirror and to absorb what an agent pushed via receive-pack.
 */
export function syncFromGit(gh: GitHubStore, repo: GitHubRepo, gitDir: string): { commits: number; refs: number } {
  const seenTrees = new Set<string>();
  const commits = readCommits(gitDir);
  let importedCommits = 0;

  for (const commit of commits) {
    const exists = gh.commits.findBy("repo_id", repo.id).some((c) => c.sha === commit.sha);
    importTree(gh, repo, gitDir, commit.tree, seenTrees);
    if (exists) continue;

    const author = gh.users.findOneBy("email", commit.authorEmail);
    const row = gh.commits.insert({
      repo_id: repo.id,
      sha: commit.sha,
      node_id: "",
      message: commit.message.replace(/\n+$/, ""),
      author_name: commit.authorName,
      author_email: commit.authorEmail,
      author_date: commit.authorDate,
      committer_name: commit.committerName,
      committer_email: commit.committerEmail,
      committer_date: commit.committerDate,
      tree_sha: commit.tree,
      parent_shas: commit.parents,
      user_id: author?.id ?? null,
    } as Parameters<typeof gh.commits.insert>[0]);
    gh.commits.update(row.id, { node_id: generateNodeId("Commit", row.id) });
    importedCommits++;
  }

  const refsOut = runGit(gitDir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)"]);
  let refCount = 0;
  for (const line of refsOut.split("\n")) {
    if (!line.trim()) continue;
    const [refName, sha] = line.split("\u0000");

    // refs/pull/*/head exists in mirrors so PR head SHAs resolve, but GitHub does
    // not expose it through the refs API.
    if (refName.startsWith("refs/pull/")) continue;
    if (!refName.startsWith("refs/heads/") && !refName.startsWith("refs/tags/")) continue;

    refCount++;
    const existingRef = gh.refs.findBy("repo_id", repo.id).find((r) => r.ref === refName);
    if (existingRef) {
      if (existingRef.sha !== sha) gh.refs.update(existingRef.id, { sha });
    } else {
      const refRow = gh.refs.insert({ repo_id: repo.id, ref: refName, sha, node_id: "" } as Parameters<
        typeof gh.refs.insert
      >[0]);
      gh.refs.update(refRow.id, { node_id: generateNodeId("Ref", refRow.id) });
    }

    if (refName.startsWith("refs/heads/")) {
      const name = refName.slice("refs/heads/".length);
      const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === name);
      if (branch) {
        if (branch.sha !== sha) gh.branches.update(branch.id, { sha });
      } else {
        gh.branches.insert({ repo_id: repo.id, name, sha, protected: false } as Parameters<
          typeof gh.branches.insert
        >[0]);
      }
    }
  }

  // Branches deleted by a push must disappear from the API too.
  const liveBranches = new Set(
    refsOut
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.split("\u0000")[0])
      .filter((r) => r.startsWith("refs/heads/"))
      .map((r) => r.slice("refs/heads/".length)),
  );
  for (const branch of gh.branches.findBy("repo_id", repo.id)) {
    if (!liveBranches.has(branch.name)) {
      gh.branches.delete(branch.id);
      const staleRef = gh.refs.findBy("repo_id", repo.id).find((r) => r.ref === `refs/heads/${branch.name}`);
      if (staleRef) gh.refs.delete(staleRef.id);
    }
  }

  try {
    const head = runGit(gitDir, ["symbolic-ref", "HEAD"]).trim();
    if (head.startsWith("refs/heads/")) {
      const name = head.slice("refs/heads/".length);
      if (liveBranches.has(name) && repo.default_branch !== name) {
        gh.repos.update(repo.id, { default_branch: name });
      }
    }
  } catch {
    // A mirror without a resolvable HEAD keeps the configured default branch.
  }

  if (importedCommits > 0) {
    gh.repos.update(repo.id, { pushed_at: new Date().toISOString() });
  }

  return { commits: importedCommits, refs: refCount };
}

export function objectSha(type: "blob" | "tree" | "commit", content: Buffer): string {
  return gitObjectSha(type, content);
}
