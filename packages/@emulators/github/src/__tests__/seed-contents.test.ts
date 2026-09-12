import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";
import { getGitHubStore } from "../store.js";
import { resetGitDirForTesting, setGitDir } from "../git-mirror.js";

const base = "http://localhost:4000";

function seed(config: Parameters<typeof seedFromConfig>[2]) {
  const store = new Store();
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, config);
  return getGitHubStore(store);
}

describe("repository content seeding", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "emulate-seed-"));
    resetGitDirForTesting();
    setGitDir(join(root, "mirrors"));
  });

  afterEach(() => {
    resetGitDirForTesting();
    rmSync(root, { recursive: true, force: true });
  });

  it("seeds inline files as a single commit", () => {
    const gh = seed({
      users: [{ login: "octocat" }],
      repos: [
        {
          owner: "octocat",
          name: "inline",
          files: { "index.mjs": "export const a = 1\n", "README.md": "# inline\n" },
        },
      ],
    });

    const repo = gh.repos.findOneBy("full_name", "octocat/inline")!;
    const commits = gh.commits.findBy("repo_id", repo.id);
    expect(commits).toHaveLength(1);

    const tree = gh.trees.findBy("repo_id", repo.id).find((t) => t.sha === commits[0].tree_sha)!;
    expect(tree.tree.map((e) => e.path).sort()).toEqual(["README.md", "index.mjs"]);

    const branch = gh.branches.findBy("repo_id", repo.id)[0];
    expect(branch.name).toBe("main");
    expect(branch.sha).toBe(commits[0].sha);
  });

  it("produces a deterministic commit SHA across reseeds", () => {
    const config = {
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "determinism", files: { "a.txt": "same\n" } }],
    };

    const first = seed(config);
    const second = seed(config);

    const shaOf = (gh: ReturnType<typeof seed>) => {
      const repo = gh.repos.findOneBy("full_name", "octocat/determinism")!;
      return gh.commits.findBy("repo_id", repo.id)[0].sha;
    };

    expect(shaOf(first)).toBe(shaOf(second));
  });

  it("seeds nested directories as nested trees", () => {
    const gh = seed({
      users: [{ login: "octocat" }],
      repos: [
        {
          owner: "octocat",
          name: "nested",
          files: { "src/lib/deep.mjs": "export const deep = true\n", "top.md": "top\n" },
        },
      ],
    });

    const repo = gh.repos.findOneBy("full_name", "octocat/nested")!;
    const root = gh.trees.findBy("repo_id", repo.id).find(
      (t) => t.sha === gh.commits.findBy("repo_id", repo.id)[0].tree_sha,
    )!;
    const src = root.tree.find((e) => e.path === "src")!;
    expect(src.type).toBe("tree");

    const srcTree = gh.trees.findBy("repo_id", repo.id).find((t) => t.sha === src.sha)!;
    expect(srcTree.tree.find((e) => e.path === "lib")!.type).toBe("tree");
  });

  it("seeds from a directory on disk", () => {
    const dir = join(root, "src-dir");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "one.txt"), "one\n");
    writeFileSync(join(dir, "sub", "two.txt"), "two\n");

    const gh = seed({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "from-path", from_path: dir }],
    });

    const repo = gh.repos.findOneBy("full_name", "octocat/from-path")!;
    const blobs = gh.blobs.findBy("repo_id", repo.id);
    expect(blobs.map((b) => b.content).sort()).toEqual(["one\n", "two\n"]);
  });

  it("seeds full history from a bare repository, preserving real SHAs", () => {
    const source = join(root, "source.git");
    const work = join(root, "work");
    const run = (args: string[], cwd: string) =>
      execFileSync("git", ["-c", "safe.bareRepository=all", ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Up",
          GIT_AUTHOR_EMAIL: "up@example.com",
          GIT_COMMITTER_NAME: "Up",
          GIT_COMMITTER_EMAIL: "up@example.com",
        },
      });

    execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", source]);
    mkdirSync(work, { recursive: true });
    run(["clone", "-q", source, "wc"], work);
    const wc = join(work, "wc");
    writeFileSync(join(wc, "first.txt"), "first\n");
    run(["add", "first.txt"], wc);
    run(["commit", "-qm", "first commit"], wc);
    writeFileSync(join(wc, "second.txt"), "second\n");
    run(["add", "second.txt"], wc);
    run(["commit", "-qm", "second commit"], wc);
    run(["push", "-q", "origin", "main"], wc);
    const upstreamShas = run(["log", "--format=%H", "main"], wc).trim().split("\n").sort();

    const gh = seed({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "imported", git_source: source }],
    });

    const repo = gh.repos.findOneBy("full_name", "octocat/imported")!;
    const commits = gh.commits.findBy("repo_id", repo.id);

    // Full history, not a squashed snapshot.
    expect(commits).toHaveLength(2);
    // SHAs must match upstream exactly, or imported PR base SHAs would not resolve.
    expect(commits.map((c) => c.sha).sort()).toEqual(upstreamShas);
    expect(commits.map((c) => c.message).sort()).toEqual(["first commit", "second commit"]);

    const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === "main");
    expect(branch).toBeDefined();
  });

  it("still honours auto_init when no content source is given", () => {
    const gh = seed({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "plain", auto_init: true }],
    });
    const repo = gh.repos.findOneBy("full_name", "octocat/plain")!;
    const blobs = gh.blobs.findBy("repo_id", repo.id);
    expect(blobs[0].content).toContain("# plain");
  });
});
