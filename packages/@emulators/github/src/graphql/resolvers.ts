import type { GitHubStore } from "../store.js";
import type {
  GitHubComment,
  GitHubIssue,
  GitHubLabel,
  GitHubPullRequest,
  GitHubRepo,
  GitHubUser,
} from "../entities.js";
import { getNextIssueNumber } from "../helpers.js";
import { generateNodeId } from "../helpers.js";

export interface GraphQLContext {
  gh: GitHubStore;
  baseUrl: string;
  viewerLogin: string | null;
}

/** Marks an object so graphql-js can resolve unions and interfaces from data. */
function typed<T extends object>(typename: string, value: T): T & { __typename: string } {
  return { ...value, __typename: typename };
}

function repoUrl(ctx: GraphQLContext, repo: GitHubRepo): string {
  return `${ctx.baseUrl}/${repo.full_name}`;
}

function ownerLogin(ctx: GraphQLContext, repo: GitHubRepo): string {
  if (repo.owner_type === "User") return ctx.gh.users.get(repo.owner_id)?.login ?? "unknown";
  return ctx.gh.orgs.get(repo.owner_id)?.login ?? "unknown";
}

function mapUser(ctx: GraphQLContext, user: GitHubUser | undefined | null) {
  if (!user) return null;
  return typed(user.type === "Bot" ? "Bot" : "User", {
    id: user.node_id,
    databaseId: user.id,
    login: user.login,
    name: user.name,
    email: user.email,
    url: `${ctx.baseUrl}/${user.login}`,
    avatarUrl: user.avatar_url,
    isViewer: ctx.viewerLogin === user.login,
  });
}

function mapLabel(label: GitHubLabel) {
  return {
    id: label.node_id,
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

function connection<T>(nodes: T[], total = nodes.length) {
  return {
    totalCount: total,
    nodes,
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function sliceConnection<T>(all: T[], args: { first?: number; last?: number }) {
  const total = all.length;
  let nodes = all;
  if (typeof args.first === "number") nodes = all.slice(0, args.first);
  else if (typeof args.last === "number") nodes = all.slice(-args.last);
  return connection(nodes, total);
}

function mapComment(ctx: GraphQLContext, comment: GitHubComment, repo: GitHubRepo, number: number) {
  const author = ctx.gh.users.get(comment.user_id);
  return {
    id: comment.node_id,
    databaseId: comment.id,
    body: comment.body,
    bodyText: comment.body,
    url: `${repoUrl(ctx, repo)}/issues/${number}#issuecomment-${comment.id}`,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    author: mapUser(ctx, author),
    authorAssociation: "NONE",
    includesCreatedEdit: false,
    isMinimized: false,
    minimizedReason: null,
    viewerDidAuthor: ctx.viewerLogin === author?.login,
    reactionGroups: [],
  };
}

function commentsFor(ctx: GraphQLContext, repo: GitHubRepo, number: number) {
  return ctx.gh.comments
    .findBy("repo_id", repo.id)
    .filter((c) => c.comment_type === "issue" && c.issue_number === number)
    .map((c) => mapComment(ctx, c, repo, number));
}

function mapCommit(ctx: GraphQLContext, repo: GitHubRepo, sha: string | null | undefined) {
  if (!sha) return null;
  const commit = ctx.gh.commits.findBy("repo_id", repo.id).find((c) => c.sha === sha);
  return {
    // Checks are not modelled; gh renders an absent rollup as no checks.
    statusCheckRollup: null,
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    message: commit?.message ?? null,
    messageHeadline: commit?.message?.split("\n")[0] ?? null,
    committedDate: commit?.committer_date ?? null,
    authoredDate: commit?.author_date ?? null,
  };
}

export function mapIssue(ctx: GraphQLContext, repo: GitHubRepo, issue: GitHubIssue) {
  const labels = issue.label_ids
    .map((id) => ctx.gh.labels.get(id))
    .filter((l): l is GitHubLabel => Boolean(l))
    .map(mapLabel);
  const assignees = issue.assignee_ids
    .map((id) => ctx.gh.users.get(id))
    .filter((u): u is GitHubUser => Boolean(u))
    .map((u) => mapUser(ctx, u));
  const author = ctx.gh.users.get(issue.user_id);

  return typed("Issue", {
    id: issue.node_id,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    bodyText: issue.body ?? "",
    state: issue.state === "open" ? "OPEN" : "CLOSED",
    stateReason: issue.state_reason ? issue.state_reason.toUpperCase() : null,
    closed: issue.state === "closed",
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}`,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    locked: issue.locked,
    isPinned: false,
    author: mapUser(ctx, author),
    authorAssociation: "NONE",
    milestone: null,
    assignees: (args: { first?: number; last?: number }) => sliceConnection(assignees, args),
    labels: (args: { first?: number; last?: number }) => sliceConnection(labels, args),
    comments: (args: { first?: number; last?: number }) =>
      sliceConnection(commentsFor(ctx, repo, issue.number), args),
    reactionGroups: [],
    viewerDidAuthor: ctx.viewerLogin === author?.login,
    repository: () => mapRepository(ctx, repo),
    // Sub-issue relationships are not modelled; gh requests them for `issue
    // view` and renders empty results without complaint.
    issueType: null,
    parent: null,
    subIssues: (args: { first?: number; last?: number }) => sliceConnection([], args),
    subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 },
    blockedBy: (args: { first?: number; last?: number }) => sliceConnection([], args),
    blocking: (args: { first?: number; last?: number }) => sliceConnection([], args),
    projectItems: (args: { first?: number; last?: number }) => sliceConnection([], args),
  });
}

export function mapPullRequest(ctx: GraphQLContext, repo: GitHubRepo, pr: GitHubPullRequest) {
  const labels = pr.label_ids
    .map((id) => ctx.gh.labels.get(id))
    .filter((l): l is GitHubLabel => Boolean(l))
    .map(mapLabel);
  const assignees = pr.assignee_ids
    .map((id) => ctx.gh.users.get(id))
    .filter((u): u is GitHubUser => Boolean(u))
    .map((u) => mapUser(ctx, u));
  const author = ctx.gh.users.get(pr.user_id);
  const headRepo = ctx.gh.repos.get(pr.head_repo_id) ?? repo;

  const state = pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED";

  return typed("PullRequest", {
    id: pr.node_id,
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    bodyText: pr.body ?? "",
    state,
    closed: pr.state === "closed",
    url: `${repoUrl(ctx, repo)}/pull/${pr.number}`,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    locked: pr.locked,
    isDraft: pr.draft,
    merged: pr.merged,
    mergeable: pr.mergeable === null ? "UNKNOWN" : pr.mergeable ? "MERGEABLE" : "CONFLICTING",
    mergeStateStatus: pr.merged || pr.state === "closed" ? "UNKNOWN" : pr.draft ? "DRAFT" : "CLEAN",
    maintainerCanModify: true,
    isCrossRepository: pr.head_repo_id !== pr.base_repo_id,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    baseRefName: pr.base_ref,
    baseRefOid: pr.base_sha || null,
    headRefName: pr.head_ref,
    headRefOid: pr.head_sha || null,
    headRepository: () => mapRepository(ctx, headRepo),
    headRepositoryOwner: () =>
      headRepo.owner_type === "User"
        ? mapUser(ctx, ctx.gh.users.get(headRepo.owner_id))
        : typed("Organization", {
            id: ctx.gh.orgs.get(headRepo.owner_id)?.node_id ?? "",
            login: ownerLogin(ctx, headRepo),
            name: ctx.gh.orgs.get(headRepo.owner_id)?.name ?? null,
            url: `${ctx.baseUrl}/${ownerLogin(ctx, headRepo)}`,
          }),
    author: mapUser(ctx, author),
    authorAssociation: "NONE",
    mergedBy: pr.merged_by_id ? mapUser(ctx, ctx.gh.users.get(pr.merged_by_id)) : null,
    autoMergeRequest: null,
    mergeCommit: mapCommit(ctx, repo, pr.merge_commit_sha),
    milestone: null,
    assignees: (args: { first?: number; last?: number }) => sliceConnection(assignees, args),
    labels: (args: { first?: number; last?: number }) => sliceConnection(labels, args),
    comments: (args: { first?: number; last?: number }) =>
      sliceConnection(commentsFor(ctx, repo, pr.number), args),
    commits: (args: { first?: number; last?: number }) => {
      const head = mapCommit(ctx, repo, pr.head_sha);
      const nodes = head ? [{ commit: head }] : [];
      const limited =
        typeof args.first === "number"
          ? nodes.slice(0, args.first)
          : typeof args.last === "number"
            ? nodes.slice(-args.last)
            : nodes;
      return connection(limited, pr.commits);
    },
    reviews: (args: { first?: number; last?: number }) => sliceConnection([], args),
    reviewRequests: (args: { first?: number; last?: number }) => sliceConnection([], args),
    reactionGroups: [],
    viewerDidAuthor: ctx.viewerLogin === author?.login,
    repository: () => mapRepository(ctx, repo),
    projectItems: (args: { first?: number; last?: number }) => sliceConnection([], args),
  });
}

function viewerPermission(ctx: GraphQLContext, repo: GitHubRepo): string {
  if (!ctx.viewerLogin) return "READ";
  return ownerLogin(ctx, repo) === ctx.viewerLogin ? "ADMIN" : "WRITE";
}

export function mapRepository(ctx: GraphQLContext, repo: GitHubRepo) {
  const gh = ctx.gh;
  const login = ownerLogin(ctx, repo);
  const defaultBranch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === repo.default_branch);

  const issuesOf = () => gh.issues.findBy("repo_id", repo.id).filter((i) => !i.is_pull_request);

  return typed("Repository", {
    id: repo.node_id,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    description: repo.description,
    url: repoUrl(ctx, repo),
    isPrivate: repo.private,
    isFork: repo.fork,
    isArchived: repo.archived,
    isTemplate: repo.is_template,
    hasIssuesEnabled: repo.has_issues,
    hasWikiEnabled: repo.has_wiki,
    hasProjectsEnabled: repo.has_projects,
    hasDiscussionsEnabled: repo.has_discussions,
    viewerPermission: viewerPermission(ctx, repo),
    viewerCanAdminister: viewerPermission(ctx, repo) === "ADMIN",
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    stargazerCount: repo.stargazers_count,
    forkCount: repo.forks_count,
    mergeCommitAllowed: repo.allow_merge_commit,
    rebaseMergeAllowed: repo.allow_rebase_merge,
    squashMergeAllowed: repo.allow_squash_merge,
    deleteBranchOnMerge: repo.delete_branch_on_merge,
    defaultBranchRef: defaultBranch
      ? {
          id: `ref-${repo.id}-${defaultBranch.name}`,
          name: defaultBranch.name,
          prefix: "refs/heads/",
          target: mapCommit(ctx, repo, defaultBranch.sha),
        }
      : null,
    owner:
      repo.owner_type === "User"
        ? mapUser(ctx, gh.users.get(repo.owner_id))
        : typed("Organization", {
            id: gh.orgs.get(repo.owner_id)?.node_id ?? "",
            login,
            name: gh.orgs.get(repo.owner_id)?.name ?? null,
            url: `${ctx.baseUrl}/${login}`,
          }),
    parent: null,

    issue: ({ number }: { number: number }) => {
      const issue = issuesOf().find((i) => i.number === number);
      return issue ? mapIssue(ctx, repo, issue) : null;
    },

    // gh uses this for `issue view` and `issue comment`, since a number may
    // identify either kind of item.
    issueOrPullRequest: ({ number }: { number: number }) => {
      const issue = issuesOf().find((i) => i.number === number);
      if (issue) return mapIssue(ctx, repo, issue);
      const pr = gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === number);
      return pr ? mapPullRequest(ctx, repo, pr) : null;
    },

    pullRequest: ({ number }: { number: number }) => {
      const pr = gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === number);
      return pr ? mapPullRequest(ctx, repo, pr) : null;
    },

    issues: (args: {
      first?: number;
      last?: number;
      states?: string[];
      labels?: string[];
      filterBy?: { assignee?: string; createdBy?: string; mentioned?: string };
      orderBy?: { field: string; direction: string };
    }) => {
      let items = issuesOf();
      if (args.states?.length) {
        const wanted = args.states.map((s) => s.toLowerCase());
        items = items.filter((i) => wanted.includes(i.state));
      }
      if (args.labels?.length) {
        items = items.filter((i) =>
          args.labels!.every((name) =>
            i.label_ids.some((id) => gh.labels.get(id)?.name === name),
          ),
        );
      }
      if (args.filterBy?.createdBy) {
        items = items.filter((i) => gh.users.get(i.user_id)?.login === args.filterBy!.createdBy);
      }
      if (args.filterBy?.assignee) {
        items = items.filter((i) =>
          i.assignee_ids.some((id) => gh.users.get(id)?.login === args.filterBy!.assignee),
        );
      }

      const direction = args.orderBy?.direction === "ASC" ? 1 : -1;
      items = [...items].sort(
        (a, b) => direction * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      );

      return sliceConnection(items.map((i) => mapIssue(ctx, repo, i)), args);
    },

    pullRequests: (args: {
      first?: number;
      last?: number;
      states?: string[];
      baseRefName?: string;
      headRefName?: string;
      orderBy?: { field: string; direction: string };
    }) => {
      let items = gh.pullRequests.findBy("repo_id", repo.id);
      if (args.states?.length) {
        items = items.filter((p) => {
          const state = p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED";
          return args.states!.includes(state);
        });
      }
      if (args.baseRefName) items = items.filter((p) => p.base_ref === args.baseRefName);
      if (args.headRefName) items = items.filter((p) => p.head_ref === args.headRefName);

      const direction = args.orderBy?.direction === "ASC" ? 1 : -1;
      items = [...items].sort(
        (a, b) => direction * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
      );

      return sliceConnection(items.map((p) => mapPullRequest(ctx, repo, p)), args);
    },

    labels: (args: { first?: number; last?: number; query?: string }) => {
      let items = gh.labels.findBy("repo_id", repo.id);
      if (args.query) items = items.filter((l) => l.name.includes(args.query!));
      return sliceConnection(items.map(mapLabel), args);
    },

    assignableUsers: (args: { first?: number; last?: number; query?: string }) => {
      let items = gh.users.all();
      if (args.query) items = items.filter((u) => u.login.includes(args.query!));
      return sliceConnection(items.map((u) => mapUser(ctx, u)), args);
    },

    milestones: (args: { first?: number; last?: number }) =>
      sliceConnection(
        gh.milestones.findBy("repo_id", repo.id).map((m) => ({
          id: m.node_id,
          number: m.number,
          title: m.title,
          description: m.description,
          dueOn: m.due_on,
        })),
        args,
      ),
  });
}

function findRepoByNodeId(gh: GitHubStore, nodeId: string): GitHubRepo | undefined {
  return gh.repos.all().find((r) => r.node_id === nodeId);
}

function findIssueByNodeId(gh: GitHubStore, nodeId: string): GitHubIssue | undefined {
  return gh.issues.all().find((i) => i.node_id === nodeId);
}

function findPullByNodeId(gh: GitHubStore, nodeId: string): GitHubPullRequest | undefined {
  return gh.pullRequests.all().find((p) => p.node_id === nodeId);
}

export function createRootValue(ctx: GraphQLContext) {
  const gh = ctx.gh;

  const repoOf = (repoId: number) => gh.repos.get(repoId)!;

  return {
    viewer: () => {
      const user = ctx.viewerLogin ? gh.users.findOneBy("login", ctx.viewerLogin) : undefined;
      return (
        mapUser(ctx, user) ?? {
          id: "",
          databaseId: 0,
          login: ctx.viewerLogin ?? "anonymous",
          name: null,
          email: null,
          url: ctx.baseUrl,
          avatarUrl: null,
          isViewer: true,
        }
      );
    },

    rateLimit: () => ({
      limit: 5000,
      cost: 1,
      remaining: 4999,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
      nodeCount: 1,
    }),

    repository: ({ owner, name }: { owner: string; name: string }) => {
      const repo = gh.repos.findOneBy("full_name", `${owner}/${name}`);
      return repo ? mapRepository(ctx, repo) : null;
    },

    user: ({ login }: { login: string }) => mapUser(ctx, gh.users.findOneBy("login", login)),

    organization: ({ login }: { login: string }) => {
      const org = gh.orgs.findOneBy("login", login);
      return org
        ? typed("Organization", {
            id: org.node_id,
            login: org.login,
            name: org.name,
            url: `${ctx.baseUrl}/${org.login}`,
          })
        : null;
    },

    node: ({ id }: { id: string }) => {
      const repo = findRepoByNodeId(gh, id);
      if (repo) return mapRepository(ctx, repo);
      const issue = findIssueByNodeId(gh, id);
      if (issue) return mapIssue(ctx, repoOf(issue.repo_id), issue);
      const pr = findPullByNodeId(gh, id);
      if (pr) return mapPullRequest(ctx, repoOf(pr.repo_id), pr);
      return null;
    },

    createPullRequest: ({ input }: { input: Record<string, unknown> }) => {
      const repo = findRepoByNodeId(gh, String(input.repositoryId));
      if (!repo) throw new Error("Repository not found");

      const headRef = String(input.headRefName);
      const baseRef = String(input.baseRefName);
      const head = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === headRef);
      const base = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === baseRef);
      if (!head) throw new Error(`Head ref not found: ${headRef}`);
      if (!base) throw new Error(`Base ref not found: ${baseRef}`);

      const actor = ctx.viewerLogin ? gh.users.findOneBy("login", ctx.viewerLogin) : undefined;
      const number = getNextIssueNumber(gh, repo.id);
      const body = input.body === undefined || input.body === null ? null : String(input.body);

      // Both rows, matching what the REST path creates.
      const issueRow = gh.issues.insert({
        node_id: "",
        number,
        repo_id: repo.id,
        title: String(input.title),
        body,
        state: "open",
        state_reason: null,
        locked: false,
        active_lock_reason: null,
        user_id: actor?.id ?? 0,
        assignee_ids: [],
        label_ids: [],
        milestone_id: null,
        comments: 0,
        closed_at: null,
        closed_by_id: null,
        is_pull_request: true,
      } as Parameters<typeof gh.issues.insert>[0]);
      gh.issues.update(issueRow.id, { node_id: generateNodeId("PullRequest", issueRow.id) });

      const prRow = gh.pullRequests.insert({
        node_id: "",
        number,
        repo_id: repo.id,
        title: String(input.title),
        body,
        state: "open",
        locked: false,
        user_id: actor?.id ?? 0,
        assignee_ids: [],
        label_ids: [],
        milestone_id: null,
        head_ref: headRef,
        head_sha: head.sha,
        head_repo_id: repo.id,
        base_ref: baseRef,
        base_sha: base.sha,
        base_repo_id: repo.id,
        merged: false,
        merged_at: null,
        merged_by_id: null,
        merge_commit_sha: null,
        mergeable: true,
        mergeable_state: "clean",
        comments: 0,
        review_comments: 0,
        commits: 1,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        draft: Boolean(input.draft),
        requested_reviewer_ids: [],
        requested_team_ids: [],
        closed_at: null,
        auto_merge: null,
      } as unknown as Parameters<typeof gh.pullRequests.insert>[0]);
      gh.pullRequests.update(prRow.id, { node_id: generateNodeId("PullRequest", prRow.id) });

      return { clientMutationId: input.clientMutationId ?? null, pullRequest: mapPullRequest(ctx, repo, gh.pullRequests.get(prRow.id)!) };
    },

    mergePullRequest: ({ input }: { input: Record<string, unknown> }) => {
      const pr = findPullByNodeId(gh, String(input.pullRequestId));
      if (!pr) throw new Error("Pull request not found");
      const repo = repoOf(pr.repo_id);

      if (pr.merged || pr.state === "closed") throw new Error("Pull request is not mergeable");
      if (pr.draft) throw new Error("Draft pull requests cannot be merged");
      if (input.expectedHeadOid && input.expectedHeadOid !== pr.head_sha) {
        throw new Error("Head sha is out of date");
      }

      const actor = ctx.viewerLogin ? gh.users.findOneBy("login", ctx.viewerLogin) : undefined;
      const now = new Date().toISOString();

      gh.pullRequests.update(pr.id, {
        merged: true,
        merged_at: now,
        merged_by_id: actor?.id ?? null,
        merge_commit_sha: pr.head_sha,
        state: "closed",
        closed_at: now,
      });

      const issueRow = gh.issues.findBy("repo_id", repo.id).find((i) => i.number === pr.number && i.is_pull_request);
      if (issueRow) gh.issues.update(issueRow.id, { state: "closed", closed_at: now });

      return {
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: mapPullRequest(ctx, repo, gh.pullRequests.get(pr.id)!),
      };
    },

    addComment: ({ input }: { input: Record<string, unknown> }) => {
      const subjectId = String(input.subjectId);
      const issue = findIssueByNodeId(gh, subjectId);
      const pr = issue ? undefined : findPullByNodeId(gh, subjectId);
      const target = issue ?? pr;
      if (!target) throw new Error("Subject not found");

      const repo = repoOf(target.repo_id);
      const actor = ctx.viewerLogin ? gh.users.findOneBy("login", ctx.viewerLogin) : undefined;

      const row = gh.comments.insert({
        repo_id: repo.id,
        node_id: "",
        issue_number: target.number,
        pull_number: null,
        commit_sha: null,
        body: String(input.body),
        user_id: actor?.id ?? 0,
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

      if (issue) gh.issues.update(issue.id, { comments: issue.comments + 1 });

      const subject = issue
        ? mapIssue(ctx, repo, gh.issues.get(issue.id)!)
        : mapPullRequest(ctx, repo, gh.pullRequests.get(pr!.id)!);

      return {
        clientMutationId: input.clientMutationId ?? null,
        commentEdge: { node: mapComment(ctx, gh.comments.get(row.id)!, repo, target.number) },
        subject,
      };
    },

    updatePullRequest: ({ input }: { input: Record<string, unknown> }) => {
      const pr = findPullByNodeId(gh, String(input.pullRequestId));
      if (!pr) throw new Error("Pull request not found");
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = String(input.title);
      if (input.body !== undefined) patch.body = String(input.body);
      if (input.baseRefName !== undefined) patch.base_ref = String(input.baseRefName);
      if (input.state !== undefined) patch.state = String(input.state).toLowerCase();
      gh.pullRequests.update(pr.id, patch as Partial<GitHubPullRequest>);
      return {
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: mapPullRequest(ctx, repoOf(pr.repo_id), gh.pullRequests.get(pr.id)!),
      };
    },

    closeIssue: ({ input }: { input: Record<string, unknown> }) => {
      const issue = findIssueByNodeId(gh, String(input.issueId));
      if (!issue) throw new Error("Issue not found");
      gh.issues.update(issue.id, {
        state: "closed",
        closed_at: new Date().toISOString(),
        state_reason: input.stateReason ? (String(input.stateReason).toLowerCase() as GitHubIssue["state_reason"]) : "completed",
      });
      return {
        clientMutationId: input.clientMutationId ?? null,
        issue: mapIssue(ctx, repoOf(issue.repo_id), gh.issues.get(issue.id)!),
      };
    },

    reopenIssue: ({ input }: { input: Record<string, unknown> }) => {
      const issue = findIssueByNodeId(gh, String(input.issueId));
      if (!issue) throw new Error("Issue not found");
      gh.issues.update(issue.id, { state: "open", closed_at: null, state_reason: "reopened" });
      return {
        clientMutationId: input.clientMutationId ?? null,
        issue: mapIssue(ctx, repoOf(issue.repo_id), gh.issues.get(issue.id)!),
      };
    },

    markPullRequestReadyForReview: ({ input }: { input: Record<string, unknown> }) => {
      const pr = findPullByNodeId(gh, String(input.pullRequestId));
      if (!pr) throw new Error("Pull request not found");
      gh.pullRequests.update(pr.id, { draft: false });
      return {
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: mapPullRequest(ctx, repoOf(pr.repo_id), gh.pullRequests.get(pr.id)!),
      };
    },
  };
}
