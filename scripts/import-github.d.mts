/**
 * Type surface for the helpers the importer exports for testing. The script
 * itself is plain JavaScript so it can run from the container with no build
 * step, so its testable surface is declared here.
 */
export interface ImportItem {
  number: number;
  title?: string;
  state?: string;
  created_at?: string;
  closed_at?: string;
  merged?: boolean;
  merged_at?: string;
  merged_by?: string;
  merge_commit_sha?: string;
  comments?: Array<{ user?: string; body: string; created_at?: string }>;
  [key: string]: unknown;
}

export interface ImportData {
  repo: { default_branch: string; [key: string]: unknown };
  labels: unknown[];
  issues: ImportItem[];
  pulls: ImportItem[];
}

/** Rebuilds issue and pull request state as it stood at the cutoff. */
export function applyCutoff(data: ImportData, cutoff: string): ImportData;

/** Rewrites a mirror so it represents the repository exactly at `ref`. */
export function pinToRef(
  gitDir: string,
  ref: string,
  defaultBranch: string,
): Promise<{ oid: string; committedAt: string }>;
