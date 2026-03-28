import { run } from "./shell.ts";
import type { RunResult } from "./types.ts";
import { loadConfig } from "./config.ts";

/** Run a gh command in the context of a specific repo directory. */
export function ghInRepo(repoRoot: string, args: string[]): RunResult {
  return run("gh", args, { cwd: repoRoot });
}

/** Check if the gh CLI is available. */
export function isAvailable(): boolean {
  const result = run("gh", ["--version"]);
  return result.exitCode === 0;
}

/** List PRs for a branch with a given state. Returns array of {number}. */
export function prList(
  repoRoot: string,
  branch: string,
  state: string,
): Array<{ number: number; title: string }> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    state,
    "--json",
    "number,title",
    "--limit",
    "100",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    return JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
  } catch {
    return [];
  }
}

/** View a PR by number, returning requested fields. */
export function prView(
  repoRoot: string,
  prNumber: number,
  fields: string[],
): Record<string, unknown> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    fields.join(","),
  ]);
  if (result.exitCode !== 0 || !result.stdout) return {};
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Get CI check status for a PR. Includes completedAt for detection latency measurement. */
export function prChecks(
  repoRoot: string,
  prNumber: number,
): { state: string; name: string; url: string; completedAt?: string }[] {
  const result = ghInRepo(repoRoot, [
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "state,name,link,completedAt",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      state: string;
      name: string;
      link: string;
      completedAt?: string;
    }>;
    return raw.map((c) => ({
      state: c.state,
      name: c.name,
      url: c.link,
      completedAt: c.completedAt || undefined,
    }));
  } catch {
    return [];
  }
}

/** Get the owner/repo string (e.g., "ninthwave-sh/ninthwave"). */
export function getRepoOwner(repoRoot: string): string {
  const result = ghInRepo(repoRoot, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error("Could not determine repository owner");
  }
  return result.stdout;
}

/** Merge a PR by number. Returns true on success, false on failure. */
export function prMerge(
  repoRoot: string,
  prNumber: number,
  method: "squash" | "merge" | "rebase" = "squash",
): boolean {
  const result = ghInRepo(repoRoot, [
    "pr",
    "merge",
    String(prNumber),
    `--${method}`,
    "--delete-branch",
  ]);
  return result.exitCode === 0;
}

/** Post a comment on a PR. Returns true on success, false on failure. */
export function prComment(
  repoRoot: string,
  prNumber: number,
  body: string,
): boolean {
  const result = ghInRepo(repoRoot, [
    "pr",
    "comment",
    String(prNumber),
    "--body",
    body,
  ]);
  return result.exitCode === 0;
}

/**
 * Check if a PR is mergeable (no conflicts with base branch).
 * Returns true if mergeable or status is unknown, false only if definitely conflicting.
 * Conservative: treats unknown as mergeable to avoid spurious rebase requests.
 */
export function checkPrMergeable(repoRoot: string, prNumber: number): boolean {
  const data = prView(repoRoot, prNumber, ["mergeable"]);
  const mergeable = data.mergeable as string | undefined;
  // GitHub returns "MERGEABLE", "CONFLICTING", or "UNKNOWN"
  return mergeable !== "CONFLICTING";
}

/** Lock a PR/issue conversation to restrict comments to collaborators. Returns true on success. */
export function prLock(repoRoot: string, prNumber: number): boolean {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return false;
  }
  const result = ghInRepo(repoRoot, [
    "api",
    "--method",
    "PUT",
    `repos/${ownerRepo}/issues/${prNumber}/lock`,
    "-f",
    "lock_reason=resolved",
  ]);
  return result.exitCode === 0;
}

/** Make a gh api GET request, optionally with a jq filter. */
export function apiGet(
  repoRoot: string,
  path: string,
  jqFilter?: string,
): string {
  const args = ["api", path];
  if (jqFilter) {
    args.push("--jq", jqFilter);
  }
  const result = ghInRepo(repoRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Resolve the GitHub token to use for gh CLI commands.
 * Priority: NINTHWAVE_GITHUB_TOKEN env var > github_token config key > undefined (use default gh auth).
 */
export function resolveGithubToken(projectRoot: string): string | undefined {
  const envToken = process.env.NINTHWAVE_GITHUB_TOKEN;
  if (envToken) return envToken;

  const config = loadConfig(projectRoot);
  const configToken = config["github_token"];
  if (configToken) return configToken;

  return undefined;
}

// ── Merge commit SHA ────────────────────────────────────────────────

/**
 * Get the merge commit SHA for a merged PR.
 * Uses `gh pr view` to retrieve the mergeCommit.oid field.
 * @returns The merge commit SHA, or null if it can't be determined.
 */
export function getMergeCommitSha(repoRoot: string, prNumber: number): string | null {
  const data = prView(repoRoot, prNumber, ["mergeCommit"]);
  const mergeCommit = data.mergeCommit as { oid?: string } | undefined;
  return mergeCommit?.oid ?? null;
}

// ── Commit CI check ─────────────────────────────────────────────────

/** Name of the ninthwave review status check to ignore in commit CI checks. */
const IGNORED_CHECK_NAMES = new Set(["ninthwave/review"]);

/**
 * Check CI status on a specific commit SHA (e.g., merge commit on main).
 * Uses the GitHub Check Runs API to get check statuses.
 * Ignores the ninthwave/review check to avoid self-referential loops.
 *
 * @returns "pass" if all checks passed, "fail" if any failed, "pending" if still running or no checks found.
 */
export function checkCommitCI(
  repoRoot: string,
  sha: string,
): "pass" | "fail" | "pending" {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return "pending";
  }

  const result = ghInRepo(repoRoot, [
    "api",
    `repos/${ownerRepo}/commits/${sha}/check-runs`,
    "--jq",
    "[.check_runs[] | {name: .name, status: .status, conclusion: .conclusion}]",
  ]);

  if (result.exitCode !== 0 || !result.stdout) {
    return "pending";
  }

  let checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  try {
    checkRuns = JSON.parse(result.stdout);
  } catch {
    return "pending";
  }

  // Filter out ignored checks (e.g., ninthwave/review to avoid self-referential loops)
  const relevantRuns = checkRuns.filter((r) => !IGNORED_CHECK_NAMES.has(r.name));

  if (relevantRuns.length === 0) {
    return "pending"; // No checks found yet
  }

  let hasFailure = false;
  let allCompleted = true;

  for (const run of relevantRuns) {
    if (run.status !== "completed") {
      allCompleted = false;
      continue;
    }
    // Map conclusion: success/neutral/skipped = pass, failure/cancelled/timed_out/action_required = fail
    const conclusion = run.conclusion?.toLowerCase();
    if (conclusion === "failure" || conclusion === "cancelled" || conclusion === "timed_out" || conclusion === "action_required") {
      hasFailure = true;
    }
  }

  if (hasFailure) return "fail";
  if (!allCompleted) return "pending";
  return "pass";
}

// ── Commit Status API ───────────────────────────────────────────────

/**
 * Set a commit status on a specific SHA via the GitHub Statuses API.
 * Uses `gh api repos/{owner}/{repo}/statuses/{sha}` — requires standard `repo` scope.
 *
 * @param repoRoot - Repo root for gh CLI context
 * @param sha - The commit SHA to set status on
 * @param state - Status state: "pending", "success", or "failure"
 * @param context - Status context string (e.g., "ninthwave/review")
 * @param description - Short description (e.g., "2 nits, 0 blockers")
 * @param targetUrl - Optional URL linking to the review comment
 * @returns true on success, false on failure
 */
export function setCommitStatus(
  repoRoot: string,
  sha: string,
  state: "pending" | "success" | "failure",
  context: string,
  description: string,
  targetUrl?: string,
): boolean {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return false;
  }

  const args = [
    "api",
    "--method",
    "POST",
    `repos/${ownerRepo}/statuses/${sha}`,
    "-f", `state=${state}`,
    "-f", `context=${context}`,
    "-f", `description=${description}`,
  ];
  if (targetUrl) {
    args.push("-f", `target_url=${targetUrl}`);
  }

  const result = ghInRepo(repoRoot, args);
  return result.exitCode === 0;
}

/**
 * Get the head SHA of a PR.
 * @returns The head commit SHA, or null if the PR can't be queried.
 */
export function prHeadSha(repoRoot: string, prNumber: number): string | null {
  const data = prView(repoRoot, prNumber, ["headRefOid"]);
  const sha = data.headRefOid as string | undefined;
  return sha ?? null;
}

// ── Trusted PR comments ──────────────────────────────────────────────

/** Trusted author associations for comment filtering. */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A PR comment from a trusted collaborator. */
export interface PrComment {
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
}

/**
 * Fetch PR comments from trusted collaborators since a given timestamp.
 * Checks both issue comments (general) and review comments (inline).
 * Returns comments sorted by createdAt ascending.
 */
export function fetchTrustedPrComments(
  repoRoot: string,
  prNumber: number,
  since: string,
): PrComment[] {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return [];
  }

  const comments: PrComment[] = [];
  const trustedFilter = '(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")';
  const jq = `[.[] | select(.created_at > "${since}" and ${trustedFilter}) | {body: .body, author: .user.login, authorAssociation: .author_association, createdAt: .created_at}]`;

  // Issue comments (general PR comments)
  try {
    const raw = apiGet(repoRoot, `repos/${ownerRepo}/issues/${prNumber}/comments`, jq);
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as PrComment[];
      comments.push(...parsed);
    }
  } catch { /* ignore */ }

  // Review comments (inline code comments)
  try {
    const raw = apiGet(repoRoot, `repos/${ownerRepo}/pulls/${prNumber}/comments`, jq);
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as PrComment[];
      comments.push(...parsed);
    }
  } catch { /* ignore */ }

  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Apply the resolved GitHub token to process.env.GH_TOKEN.
 * This makes all gh CLI invocations (daemon + workers) use the custom identity.
 * Workers inherit GH_TOKEN via environment when launched.
 * No-op if no custom token is configured — preserves default gh auth behavior.
 */
export function applyGithubToken(projectRoot: string): void {
  const token = resolveGithubToken(projectRoot);
  if (token) {
    process.env.GH_TOKEN = token;
  }
}

// ── PR comment CRUD (for upsert pattern) ──────────────────────────

/** List all issue comments on a PR. Returns array of {id, body}. */
export function listPrComments(
  repoRoot: string,
  prNumber: number,
): Array<{ id: number; body: string }> {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return [];
  }
  const result = ghInRepo(repoRoot, [
    "api",
    `repos/${ownerRepo}/issues/${prNumber}/comments`,
    "--jq",
    "[.[] | {id: .id, body: .body}]",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    return JSON.parse(result.stdout) as Array<{ id: number; body: string }>;
  } catch {
    return [];
  }
}

/** Update an existing issue comment by ID. Returns true on success. */
export function updatePrComment(
  repoRoot: string,
  commentId: number,
  body: string,
): boolean {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return false;
  }
  const result = ghInRepo(repoRoot, [
    "api",
    "--method",
    "PATCH",
    `repos/${ownerRepo}/issues/comments/${commentId}`,
    "-f",
    `body=${body}`,
  ]);
  return result.exitCode === 0;
}

// ── Living orchestrator comment (upsert pattern) ──────────────────

/** Hidden HTML comment marker to identify orchestrator status comments. */
export const ORCHESTRATOR_COMMENT_MARKER = "<!-- ninthwave-orchestrator-status -->";

/** Interface for PR comment operations (dependency injection for testability). */
export interface PrCommentClient {
  listComments(repoRoot: string, prNumber: number): Array<{ id: number; body: string }>;
  createComment(repoRoot: string, prNumber: number, body: string): boolean;
  updateComment(repoRoot: string, commentId: number, body: string): boolean;
}

/** Default PrCommentClient backed by the gh CLI. */
export const defaultPrCommentClient: PrCommentClient = {
  listComments: listPrComments,
  createComment: prComment,
  updateComment: updatePrComment,
};

/**
 * Create or update a living orchestrator status comment on a PR.
 * Each event is appended as a row in a timestamped table.
 * Uses a hidden marker to find the existing comment.
 *
 * @param repoRoot - Repo root for gh CLI context
 * @param prNumber - PR number to comment on
 * @param itemId - TODO item ID (e.g., "H-FOO-1")
 * @param eventLine - Event description (e.g., "CI failure detected. Worker notified.")
 * @param client - PR comment client (injected for testability)
 */
export function upsertOrchestratorComment(
  repoRoot: string,
  prNumber: number,
  itemId: string,
  eventLine: string,
  client: PrCommentClient = defaultPrCommentClient,
): boolean {
  const timeStr = new Date().toISOString().slice(11, 16); // "HH:MM"
  const newRow = `| ${timeStr} | ${eventLine} |`;

  // Try to find existing marker comment
  const comments = client.listComments(repoRoot, prNumber);
  const existing = comments.find((c) => c.body.includes(ORCHESTRATOR_COMMENT_MARKER));

  if (existing) {
    // Append the new row to the existing table
    const updatedBody = existing.body + "\n" + newRow;
    return client.updateComment(repoRoot, existing.id, updatedBody);
  }

  // Create new comment with header + first row
  const body = [
    ORCHESTRATOR_COMMENT_MARKER,
    `**[Orchestrator]** Status for ${itemId}`,
    "",
    "| Time | Event |",
    "|------|-------|",
    newRow,
  ].join("\n");

  return client.createComment(repoRoot, prNumber, body);
}
