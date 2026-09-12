/**
 * GraphQL schema for the GitHub emulator.
 *
 * Deliberately minimal. The `gh` CLI introspects types before issuing its real
 * queries and asks only for fields the schema advertises, so a smaller schema
 * causes `gh` to send smaller queries rather than failing. Fields are added
 * here only when a target command actually needs them.
 */
export const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar URI
  scalar GitObjectID

  enum IssueState {
    OPEN
    CLOSED
  }

  # Shared by Issue.state and PullRequest.state. gh selects \`state\` in both
  # fragments of an issueOrPullRequest union without an alias, which only
  # validates when the two fields resolve to the same enum type. The
  # argument-side enums above stay separate, matching the real API.
  enum ItemState {
    OPEN
    CLOSED
    MERGED
  }

  type IssueType {
    id: ID!
    name: String!
    description: String
    color: String
  }

  # gh issues a follow-up IssueProjectItems query after issue view and pr view.
  # Projects are not modelled, so these resolve to empty connections.
  type ProjectV2 {
    id: ID!
    title: String!
    number: Int
    url: URI
  }

  type ProjectV2ItemFieldSingleSelectValue {
    optionId: String
    name: String
  }

  type ProjectV2ItemFieldTextValue {
    text: String
  }

  union ProjectV2ItemFieldValue =
      ProjectV2ItemFieldSingleSelectValue
    | ProjectV2ItemFieldTextValue

  type ProjectV2Item {
    id: ID!
    project: ProjectV2!
    fieldValueByName(name: String!): ProjectV2ItemFieldValue
  }

  type ProjectV2ItemConnection {
    totalCount: Int!
    nodes: [ProjectV2Item]
    pageInfo: PageInfo!
  }

  type SubIssuesSummary {
    total: Int!
    completed: Int!
    percentCompleted: Int!
  }

  enum IssueStateReason {
    COMPLETED
    NOT_PLANNED
    REOPENED
    DUPLICATE
  }

  enum PullRequestState {
    OPEN
    CLOSED
    MERGED
  }

  enum MergeableState {
    MERGEABLE
    CONFLICTING
    UNKNOWN
  }

  enum MergeStateStatus {
    BEHIND
    BLOCKED
    CLEAN
    DIRTY
    DRAFT
    HAS_HOOKS
    UNKNOWN
    UNSTABLE
  }

  enum RepositoryPermission {
    ADMIN
    MAINTAIN
    WRITE
    TRIAGE
    READ
  }

  enum CommentAuthorAssociation {
    MEMBER
    OWNER
    COLLABORATOR
    CONTRIBUTOR
    FIRST_TIME_CONTRIBUTOR
    NONE
  }

  enum PullRequestReviewState {
    PENDING
    COMMENTED
    APPROVED
    CHANGES_REQUESTED
    DISMISSED
  }

  enum PullRequestMergeMethod {
    MERGE
    SQUASH
    REBASE
  }

  enum OrderDirection {
    ASC
    DESC
  }

  enum IssueOrderField {
    CREATED_AT
    UPDATED_AT
    COMMENTS
  }

  enum PullRequestOrderField {
    CREATED_AT
    UPDATED_AT
  }

  input IssueOrder {
    field: IssueOrderField!
    direction: OrderDirection!
  }

  input IssueFilters {
    assignee: String
    createdBy: String
    mentioned: String
    labels: [String!]
    states: [IssueState!]
    since: DateTime
  }

  input PullRequestOrder {
    field: PullRequestOrderField!
    direction: OrderDirection!
  }

  interface Node {
    id: ID!
  }

  interface Actor {
    login: String!
  }

  # Real GitHub exposes id and login on RepositoryOwner, and gh queries
  # owner { id login }, so owner fields must use this interface rather than Actor.
  interface RepositoryOwner {
    id: ID!
    login: String!
    url: URI
  }

  type User implements Actor & Node & RepositoryOwner {
    id: ID!
    databaseId: Int
    login: String!
    name: String
    email: String
    url: URI
    avatarUrl: URI
    isViewer: Boolean
  }

  type Bot implements Actor & Node {
    id: ID!
    login: String!
    url: URI
  }

  type Organization implements Actor & Node & RepositoryOwner {
    id: ID!
    login: String!
    name: String
    url: URI
  }

  type Team {
    id: ID!
    # Nullable to match User.name. gh selects \`name\` on both User and Team in
    # the RequestedReviewer union without aliasing, and mismatched nullability
    # is rejected by the overlapping-fields rule.
    name: String
    slug: String!
    organization: Organization
  }

  type AutoMergeRequest {
    authorEmail: String
    commitBody: String
    commitHeadline: String
    mergeMethod: PullRequestMergeMethod
    enabledAt: DateTime
    enabledBy: Actor
  }

  type Workflow {
    id: ID
    name: String!
  }

  type WorkflowRun {
    id: ID
    workflow: Workflow
    url: URI
  }

  type CheckSuite {
    id: ID
    workflowRun: WorkflowRun
  }

  type StatusContext {
    id: ID
    context: String!
    state: String!
    targetUrl: URI
    createdAt: DateTime
    description: String
  }

  type CheckRun {
    id: ID
    name: String
    checkSuite: CheckSuite
    status: String
    conclusion: String
    startedAt: DateTime
    completedAt: DateTime
    detailsUrl: URI
  }

  union StatusCheckRollupContext = StatusContext | CheckRun

  type StatusCheckRollupContextConnection {
    totalCount: Int!
    nodes: [StatusCheckRollupContext]
    pageInfo: PageInfo!
    checkRunCount: Int
    checkRunCountsByState: [String]
    statusContextCount: Int
    statusContextCountsByState: [String]
  }

  type StatusCheckRollup {
    state: String
    contexts(first: Int, after: String): StatusCheckRollupContextConnection!
  }

  union RequestedReviewer = User | Bot | Team

  type Label {
    id: ID!
    name: String!
    color: String!
    description: String
  }

  type LabelConnection {
    totalCount: Int!
    nodes: [Label]
  }

  type UserConnection {
    totalCount: Int!
    nodes: [User]
  }

  type Milestone {
    id: ID!
    number: Int!
    title: String!
    description: String
    dueOn: DateTime
  }

  type MilestoneConnection {
    totalCount: Int!
    nodes: [Milestone]
  }

  type ReactionGroupUsers {
    totalCount: Int!
  }

  type ReactionGroup {
    content: String!
    users: ReactionGroupUsers!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type IssueComment implements Node {
    id: ID!
    databaseId: Int
    body: String!
    bodyText: String
    url: URI
    createdAt: DateTime!
    updatedAt: DateTime
    author: Actor
    authorAssociation: CommentAuthorAssociation!
    includesCreatedEdit: Boolean!
    isMinimized: Boolean!
    minimizedReason: String
    viewerDidAuthor: Boolean!
    reactionGroups: [ReactionGroup!]
  }

  type IssueCommentConnection {
    totalCount: Int!
    nodes: [IssueComment]
    pageInfo: PageInfo!
  }

  type Commit {
    statusCheckRollup: StatusCheckRollup
    oid: GitObjectID!
    abbreviatedOid: String
    message: String
    messageHeadline: String
    committedDate: DateTime
    authoredDate: DateTime
  }

  type PullRequestCommit {
    commit: Commit!
  }

  type PullRequestCommitConnection {
    totalCount: Int!
    nodes: [PullRequestCommit]
  }

  type PullRequestReview {
    id: ID!
    author: Actor
    authorAssociation: CommentAuthorAssociation!
    body: String!
    state: PullRequestReviewState!
    submittedAt: DateTime
    url: URI
    commit: Commit
    reactionGroups: [ReactionGroup!]
  }

  type PullRequestReviewConnection {
    totalCount: Int!
    nodes: [PullRequestReview]
    pageInfo: PageInfo!
  }

  type ReviewRequest {
    requestedReviewer: RequestedReviewer
  }

  type ReviewRequestConnection {
    totalCount: Int!
    nodes: [ReviewRequest]
  }

  type Ref {
    id: ID!
    name: String!
    prefix: String!
    target: Commit
  }

  type Issue implements Node {
    id: ID!
    databaseId: Int
    number: Int!
    title: String!
    body: String!
    bodyText: String
    state: ItemState!
    stateReason: IssueStateReason
    closed: Boolean!
    url: URI!
    createdAt: DateTime!
    updatedAt: DateTime!
    closedAt: DateTime
    locked: Boolean!
    isPinned: Boolean
    author: Actor
    authorAssociation: CommentAuthorAssociation!
    milestone: Milestone
    assignees(first: Int, after: String): UserConnection!
    labels(first: Int, after: String, orderBy: IssueOrder): LabelConnection
    comments(first: Int, last: Int, after: String): IssueCommentConnection!
    reactionGroups: [ReactionGroup!]
    viewerDidAuthor: Boolean!
    repository: Repository!
    issueType: IssueType
    parent: Issue
    subIssues(first: Int, after: String): IssueConnection!
    subIssuesSummary: SubIssuesSummary
    blockedBy(first: Int, after: String): IssueConnection!
    blocking(first: Int, after: String): IssueConnection!
    projectItems(first: Int, after: String, includeArchived: Boolean): ProjectV2ItemConnection!
  }

  type IssueConnection {
    totalCount: Int!
    nodes: [Issue]
    pageInfo: PageInfo!
  }

  type PullRequest implements Node {
    id: ID!
    databaseId: Int
    number: Int!
    title: String!
    body: String!
    bodyText: String
    state: ItemState!
    closed: Boolean!
    url: URI!
    createdAt: DateTime!
    updatedAt: DateTime!
    closedAt: DateTime
    mergedAt: DateTime
    locked: Boolean!
    isDraft: Boolean!
    merged: Boolean!
    mergeable: MergeableState!
    mergeStateStatus: MergeStateStatus!
    maintainerCanModify: Boolean!
    isCrossRepository: Boolean!
    additions: Int!
    deletions: Int!
    changedFiles: Int!
    baseRefName: String!
    baseRefOid: GitObjectID
    headRefName: String!
    headRefOid: GitObjectID
    headRepository: Repository
    headRepositoryOwner: RepositoryOwner
    author: Actor
    authorAssociation: CommentAuthorAssociation!
    mergedBy: Actor
    mergeCommit: Commit
    autoMergeRequest: AutoMergeRequest
    milestone: Milestone
    assignees(first: Int, after: String): UserConnection!
    labels(first: Int, after: String, orderBy: IssueOrder): LabelConnection
    comments(first: Int, last: Int, after: String): IssueCommentConnection!
    commits(first: Int, last: Int, after: String): PullRequestCommitConnection!
    reviews(first: Int, after: String, states: [PullRequestReviewState!]): PullRequestReviewConnection
    reviewRequests(first: Int, after: String): ReviewRequestConnection
    reactionGroups: [ReactionGroup!]
    viewerDidAuthor: Boolean!
    repository: Repository!
    projectItems(first: Int, after: String, includeArchived: Boolean): ProjectV2ItemConnection!
  }

  type PullRequestConnection {
    totalCount: Int!
    nodes: [PullRequest]
    pageInfo: PageInfo!
  }

  union IssueOrPullRequest = Issue | PullRequest

  type Repository implements Node {
    id: ID!
    databaseId: Int
    name: String!
    nameWithOwner: String!
    description: String
    url: URI!
    isPrivate: Boolean!
    isFork: Boolean!
    isArchived: Boolean!
    isTemplate: Boolean!
    hasIssuesEnabled: Boolean!
    hasWikiEnabled: Boolean!
    hasProjectsEnabled: Boolean!
    hasDiscussionsEnabled: Boolean!
    viewerPermission: RepositoryPermission
    viewerCanAdminister: Boolean
    createdAt: DateTime!
    updatedAt: DateTime!
    pushedAt: DateTime
    stargazerCount: Int!
    forkCount: Int!
    mergeCommitAllowed: Boolean!
    rebaseMergeAllowed: Boolean!
    squashMergeAllowed: Boolean!
    deleteBranchOnMerge: Boolean!
    defaultBranchRef: Ref
    owner: RepositoryOwner!
    parent: Repository
    issue(number: Int!): Issue
    issueOrPullRequest(number: Int!): IssueOrPullRequest
    pullRequest(number: Int!): PullRequest
    issues(
      first: Int
      last: Int
      after: String
      before: String
      states: [IssueState!]
      labels: [String!]
      orderBy: IssueOrder
      filterBy: IssueFilters
    ): IssueConnection!
    pullRequests(
      first: Int
      last: Int
      after: String
      before: String
      states: [PullRequestState!]
      baseRefName: String
      headRefName: String
      labels: [String!]
      orderBy: PullRequestOrder
    ): PullRequestConnection!
    labels(first: Int, after: String, query: String): LabelConnection
    assignableUsers(first: Int, after: String, query: String): UserConnection!
    milestones(first: Int, after: String, states: [String!]): MilestoneConnection
  }

  type RateLimit {
    limit: Int!
    cost: Int!
    remaining: Int!
    resetAt: DateTime!
    nodeCount: Int!
  }

  type Query {
    viewer: User!
    rateLimit: RateLimit
    repository(owner: String!, name: String!): Repository
    node(id: ID!): Node
    organization(login: String!): Organization
    user(login: String!): User
  }

  input CreatePullRequestInput {
    repositoryId: ID!
    baseRefName: String!
    headRefName: String!
    title: String!
    body: String
    draft: Boolean
    maintainerCanModify: Boolean
    clientMutationId: String
  }

  type CreatePullRequestPayload {
    clientMutationId: String
    pullRequest: PullRequest
  }

  input MergePullRequestInput {
    pullRequestId: ID!
    commitHeadline: String
    commitBody: String
    expectedHeadOid: GitObjectID
    mergeMethod: PullRequestMergeMethod
    authorEmail: String
    clientMutationId: String
  }

  type MergePullRequestPayload {
    clientMutationId: String
    pullRequest: PullRequest
  }

  input AddCommentInput {
    subjectId: ID!
    body: String!
    clientMutationId: String
  }

  type IssueCommentEdge {
    node: IssueComment
  }

  type AddCommentPayload {
    clientMutationId: String
    commentEdge: IssueCommentEdge
    subject: Node
  }

  enum PullRequestUpdateState {
    OPEN
    CLOSED
  }

  input UpdatePullRequestInput {
    pullRequestId: ID!
    title: String
    body: String
    state: PullRequestUpdateState
    baseRefName: String
    clientMutationId: String
  }

  type UpdatePullRequestPayload {
    clientMutationId: String
    pullRequest: PullRequest
  }

  input CloseIssueInput {
    issueId: ID!
    stateReason: IssueStateReason
    clientMutationId: String
  }

  type CloseIssuePayload {
    clientMutationId: String
    issue: Issue
  }

  input ReopenIssueInput {
    issueId: ID!
    clientMutationId: String
  }

  type ReopenIssuePayload {
    clientMutationId: String
    issue: Issue
  }

  input MarkPullRequestReadyForReviewInput {
    pullRequestId: ID!
    clientMutationId: String
  }

  type MarkPullRequestReadyForReviewPayload {
    clientMutationId: String
    pullRequest: PullRequest
  }

  type Mutation {
    createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload
    mergePullRequest(input: MergePullRequestInput!): MergePullRequestPayload
    addComment(input: AddCommentInput!): AddCommentPayload
    updatePullRequest(input: UpdatePullRequestInput!): UpdatePullRequestPayload
    closeIssue(input: CloseIssueInput!): CloseIssuePayload
    reopenIssue(input: ReopenIssueInput!): ReopenIssuePayload
    markPullRequestReadyForReview(
      input: MarkPullRequestReadyForReviewInput!
    ): MarkPullRequestReadyForReviewPayload
  }
`;
