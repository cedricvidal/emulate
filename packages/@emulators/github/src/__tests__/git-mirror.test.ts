import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";
import { getGitHubStore } from "../store.js";
import { assertGitAvailable, ensureBareRepo, gitArgs, repoGitDir, syncFromGit, syncToGit } from "../git-mirror.js";

const base = "http://localhost:4000";

function seededStore() {
  const store = new Store();
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world", auto_init: true }],
  });
  return store;
}

describe("git mirror", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "emulate-git-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the git binary it will use", () => {
    expect(assertGitAvailable()).toMatch(/^git version/);
  });

  it("writes entity objects into a bare repo that git accepts", () => {
    const store = seededStore();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const gitDir = repoGitDir(root, repo);

    syncToGit(gh, repo, gitDir);

    const fsck = execFileSync("git", gitArgs([`--git-dir=${gitDir}`, "fsck", "--strict"]), { encoding: "utf8" });
    expect(fsck).not.toMatch(/missing|broken|corrupt/i);

    const head = execFileSync("git", gitArgs([`--git-dir=${gitDir}`, "rev-parse", "HEAD"]), {
      encoding: "utf8",
    }).trim();
    const branch = gh.branches.findBy("repo_id", repo.id)[0];
    expect(head).toBe(branch.sha);
  });

  it("round-trips SHAs: entities to git and back are byte identical", () => {
    const store = seededStore();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const gitDir = repoGitDir(root, repo);

    const before = {
      blobs: gh.blobs.findBy("repo_id", repo.id).map((b) => b.sha).sort(),
      trees: gh.trees.findBy("repo_id", repo.id).map((t) => t.sha).sort(),
      commits: gh.commits.findBy("repo_id", repo.id).map((c) => c.sha).sort(),
    };

    syncToGit(gh, repo, gitDir);
    syncFromGit(gh, repo, gitDir);

    const after = {
      blobs: gh.blobs.findBy("repo_id", repo.id).map((b) => b.sha).sort(),
      trees: gh.trees.findBy("repo_id", repo.id).map((t) => t.sha).sort(),
      commits: gh.commits.findBy("repo_id", repo.id).map((c) => c.sha).sort(),
    };

    expect(after).toEqual(before);
  });

  it("imports commits, branches and file contents created by real git", () => {
    const store = seededStore();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const gitDir = repoGitDir(root, repo);
    syncToGit(gh, repo, gitDir);

    const work = mkdtempSync(join(tmpdir(), "emulate-work-"));
    const git = (args: string[], cwd = work) =>
      execFileSync("git", gitArgs(args), {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com" },
      });

    try {
      git(["clone", gitDir, "clone"], work);
      const clone = join(work, "clone");
      execFileSync("bash", ["-c", "echo 'hello from git' > feature.txt"], { cwd: clone });
      git(["-C", clone, "checkout", "-b", "feature"]);
      git(["-C", clone, "add", "feature.txt"]);
      git([
        "-C",
        clone,
        "-c",
        "user.name=Dev",
        "-c",
        "user.email=dev@example.com",
        "commit",
        "-m",
        "Add feature file",
      ]);
      git(["-C", clone, "push", "origin", "feature"]);

      const result = syncFromGit(gh, repo, gitDir);
      expect(result.commits).toBeGreaterThan(0);

      const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === "feature");
      expect(branch).toBeDefined();

      const commit = gh.commits.findBy("repo_id", repo.id).find((c) => c.message === "Add feature file");
      expect(commit).toBeDefined();
      expect(commit!.sha).toBe(branch!.sha);
      expect(commit!.author_email).toBe("dev@example.com");

      const tree = gh.trees.findBy("repo_id", repo.id).find((t) => t.sha === commit!.tree_sha);
      expect(tree!.tree.some((e) => e.path === "feature.txt")).toBe(true);

      const entry = tree!.tree.find((e) => e.path === "feature.txt")!;
      const blob = gh.blobs.findBy("repo_id", repo.id).find((b) => b.sha === entry.sha);
      expect(blob!.content).toContain("hello from git");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("creates a usable bare repo for an empty repository", () => {
    ensureBareRepo(join(root, "empty.git"), "main");
    const head = execFileSync("git", gitArgs([`--git-dir=${join(root, "empty.git")}`, "symbolic-ref", "HEAD"]), {
      encoding: "utf8",
    }).trim();
    expect(head).toBe("refs/heads/main");
  });
});
