import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// The importer is a standalone script rather than a package entry, so it is
// loaded by path. Only its pure helpers are exercised here; the network paths
// are covered by running the script against a real repository.
import { applyCutoff, pinToRef, type ImportData } from "../../../../scripts/import-github.mjs";

const CUTOFF = "2026-03-24T15:34:49Z";

describe("applyCutoff", () => {
  const data: ImportData = {
    repo: { default_branch: "main" },
    labels: [],
    issues: [
      {
        number: 6,
        title: "Slack Support",
        state: "closed",
        created_at: "2026-03-23T20:44:19Z",
        closed_at: "2026-03-24T16:47:28Z",
      },
      { number: 30, title: "Filed later", state: "open", created_at: "2026-05-01T00:00:00Z" },
      {
        number: 2,
        title: "Already closed",
        state: "closed",
        created_at: "2026-03-01T00:00:00Z",
        closed_at: "2026-03-02T00:00:00Z",
      },
    ],
    pulls: [
      {
        number: 10,
        title: "Slack emulator",
        state: "closed",
        merged: true,
        created_at: "2026-03-24T03:00:00Z",
        merged_at: "2026-03-24T16:47:26Z",
        merge_commit_sha: "abc",
        merged_by: "someone",
      },
      {
        number: 5,
        title: "Merged before",
        state: "closed",
        merged: true,
        created_at: "2026-03-01T00:00:00Z",
        merged_at: "2026-03-02T00:00:00Z",
        merge_commit_sha: "def",
      },
    ],
  };

  it("drops items that did not exist yet", () => {
    const result = applyCutoff(data, CUTOFF);
    expect(result.issues.map((i) => i.number)).toEqual([6, 2]);
  });

  it("reopens an issue that was closed after the cutoff", () => {
    const issue = applyCutoff(data, CUTOFF).issues.find((i) => i.number === 6)!;
    expect(issue.state).toBe("open");
    expect(issue.closed_at).toBeUndefined();
  });

  it("leaves an issue closed when it was already closed", () => {
    const issue = applyCutoff(data, CUTOFF).issues.find((i) => i.number === 2)!;
    expect(issue.state).toBe("closed");
    expect(issue.closed_at).toBe("2026-03-02T00:00:00Z");
  });

  it("unmerges a pull request merged after the cutoff", () => {
    const pr = applyCutoff(data, CUTOFF).pulls.find((p) => p.number === 10)!;
    expect(pr.state).toBe("open");
    expect(pr.merged).toBeUndefined();
    expect(pr.merged_at).toBeUndefined();
    expect(pr.merge_commit_sha).toBeUndefined();
  });

  it("leaves a pull request merged when it was already merged", () => {
    const pr = applyCutoff(data, CUTOFF).pulls.find((p) => p.number === 5)!;
    expect(pr.merged).toBe(true);
    expect(pr.merge_commit_sha).toBe("def");
  });

  it("drops comments written after the cutoff", () => {
    const withComments: ImportData = {
      ...data,
      issues: [
        {
          number: 6,
          created_at: "2026-03-23T20:44:19Z",
          comments: [
            { user: "a", body: "before", created_at: "2026-03-24T00:00:00Z" },
            { user: "b", body: "after", created_at: "2026-04-01T00:00:00Z" },
          ],
        },
      ],
    };
    const issue = applyCutoff(withComments, CUTOFF).issues[0];
    expect(issue.comments!.map((c) => c.body)).toEqual(["before"]);
  });
});

describe("pinToRef", () => {
  let root: string;
  let gitDir: string;
  let first: string;
  let second: string;

  const git = (args: string[], cwd?: string) =>
    execFileSync("git", ["-c", "safe.bareRepository=all", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "emulate-pin-"));
    const work = join(root, "work");
    gitDir = join(root, "mirror.git");
    mkdirSync(work, { recursive: true });

    git(["init", "-q", "--initial-branch=main", work]);
    writeFileSync(join(work, "a.txt"), "one\n");
    git(["add", "a.txt"], work);
    git(["commit", "-qm", "first"], work);
    first = git(["rev-parse", "HEAD"], work).trim();

    writeFileSync(join(work, "b.txt"), "two\n");
    git(["add", "b.txt"], work);
    git(["commit", "-qm", "second"], work);
    second = git(["rev-parse", "HEAD"], work).trim();

    // A later branch, standing in for a pull request head that must not keep
    // post-pin history reachable.
    git(["branch", "later"], work);
    git(["clone", "--mirror", "-q", work, gitDir]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("moves the default branch to the pinned commit", async () => {
    const result = await pinToRef(gitDir, first, "main");
    expect(result.oid).toBe(first);
    expect(git([`--git-dir=${gitDir}`, "rev-parse", "refs/heads/main"]).trim()).toBe(first);
  });

  it("returns the commit date, which drives the cutoff", async () => {
    const result = await pinToRef(gitDir, first, "main");
    expect(Number.isNaN(Date.parse(result.committedAt))).toBe(false);
  });

  it("drops history after the pin so a clone cannot see it", async () => {
    await pinToRef(gitDir, first, "main");

    const count = git([`--git-dir=${gitDir}`, "rev-list", "--count", "--all"]).trim();
    expect(count).toBe("1");

    const refs = git([`--git-dir=${gitDir}`, "for-each-ref", "--format=%(refname)"]).trim();
    expect(refs).toBe("refs/heads/main");

    // The later commit must be gone, not merely unreferenced.
    expect(() => git([`--git-dir=${gitDir}`, "cat-file", "-e", `${second}^{commit}`])).toThrow();
  });

  it("points HEAD at the pinned branch so a clone checks it out", async () => {
    await pinToRef(gitDir, first, "main");
    expect(git([`--git-dir=${gitDir}`, "symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/main");
  });
});
