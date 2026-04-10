import { run, runAsync } from "./shell.ts";
import type { RunResult } from "./types.ts";

// ── Result type ─────────────────────────────────────────────────────

export type GhFailureKind =
  | "missing-cli"
  | "auth"
  | "rate-limit"
  | "network"
  | "repo-access"
  | "parse"
  | "unknown";

/** Discriminated union: success with data vs API failure with error message. */
export type GhResult<T> = { ok: true; data: T } | { ok: false; error: string; kind: GhFailureKind };

function classifyGhFailure(error: string, fallback: GhFailureKind = "unknown"): GhFailureKind {
  const text = error.toLowerCase();
  if (
    text.includes("command not found")
    || text.includes("executable file not found")
    || text.includes("no such file or directory")
    || text.includes("spawn gh enoent")
    || text.includes("gh not installed")
  ) {
    return "missing-cli";
  }
  if (
    text.includes("rate limit")
    || text.includes("secondary rate limit")
    || text.includes("too many requests")
    || text.includes("api rate limit exceeded")
    || text.includes("http 429")
  ) {
    return "rate-limit";
  }
  if (
    text.includes("authentication")
    || text.includes("gh auth login")
    || text.includes("not logged into")
    || text.includes("requires authentication")
    || text.includes("http 401")
    || text.includes("bad credentials")
  ) {
    return "auth";
  }
  if (
    text.includes("repository not found")
    || text.includes("resource not accessible")
    || text.includes("http 403")
    || text.includes("not found")
    || text.includes("forbidden")
    || text.includes("could not resolve to a repository")
  ) {
    return "repo-access";
  }
  if (
    text.includes("timeout")
    || text.includes("timed out")
    || text.includes("connection reset")
    || text.includes("connection refused")
    || text.includes("temporary failure")
    || text.includes("network")
    || text.includes("tls")
    || text.includes("dial tcp")
    || text.includes("econn")
    || text.includes("resolve host")
  ) {
    return "network";
  }
  return fallback;
}

function ghFailure(error: string): { ok: false; error: string; kind: GhFailureKind } {
  return { ok: false, error, kind: classifyGhFailure(error) };
}

function ghParseFailure(message: string): { ok: false; error: string; kind: GhFailureKind } {
  return { ok: false, error: message, kind: "parse" };
}

export function ghFailureKindLabel(kind: GhFailureKind): string {
  switch (kind) {
    case "missing-cli":
      return "CLI unavailable";
    case "auth":
      return "auth";
    case "rate-limit":
      return "rate limit";
    case "network":
      return "network";
    case "repo-access":
      return "repo access";
    case "parse":
      return "response parse";
    case "unknown":
      return "unknown";
  }
}

// ── Branding constants ──────────────────────────────────────────────
/** Markdown footer appended to PR comments. */
export const NINTHWAVE_FOOTER = "<sub>[Ninthwave](https://ninthwave.sh)</sub>";

/** Link to the orchestrator state-machine docs. */
export const ORCHESTRATOR_LINK =
  "https://github.com/ninthwave-sh/ninthwave/blob/main/ARCHITECTURE.md#orchestrator-state-machine";

/** Run a gh command in the context of a specific repo directory. */
export function ghInRepo(repoRoot: string, args: string[]): RunResult {
  return run("gh", args, { cwd: repoRoot });
}

/** Check if the gh CLI is available. */
export function isAvailable(): boolean {
  const result = run("gh", ["--version"]);
  return result.exitCode === 0;
}

/** List PRs for a branch with a given state. Returns GhResult with array of {number, title, body?}. */
export function prList(
  repoRoot: string,
  branch: string,
  state: string,
): GhResult<Array<{ number: number; title: string; body?: string }>> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    state,
    "--json",
    "number,title,body",
    "--limit",
    "100",
  ]);
  if (result.exitCode !== 0) return ghFailure(result.stderr || `gh pr list exited with code ${result.exitCode}`);
  if (!result.stdout) return { ok: true, data: [] };
  try {
    return {
      ok: true,
      data: JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        body?: string;
      }>,
    };
  } catch {
    return ghParseFailure("Failed to parse gh pr list output");
  }
}

/** View a PR by number, returning requested fields. Returns GhResult. */
export function prView(
  repoRoot: string,
  prNumber: number,
  fields: string[],
): GhResult<Record<string, unknown>> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    fields.join(","),
  ]);
  if (result.exitCode !== 0) return ghFailure(result.stderr || `gh pr view exited with code ${result.exitCode}`);
  if (!result.stdout) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(result.stdout) as Record<string, unknown> };
  } catch {
    return ghParseFailure("Failed to parse gh pr view output");
  }
}

/** Get CI check status for a PR. Includes completedAt for detection latency measurement. Returns GhResult. */
export function prChecks(
  repoRoot: string,
  prNumber: number,
): GhResult<{ state: string; name: string; url: string; completedAt?: string }[]> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "state,name,link,completedAt",
  ]);
  if (result.exitCode !== 0) return ghFailure(result.stderr || `gh pr checks exited with code ${result.exitCode}`);
  if (!result.stdout) return { ok: true, data: [] };
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      state: string;
      name: string;
      link: string;
      completedAt?: string;
    }>;
    return {
      ok: true,
      data: raw.map((c) => ({
        state: c.state,
        name: c.name,
        url: c.link,
        completedAt: c.completedAt || undefined,
      })),
    };
  } catch {
    return ghParseFailure("Failed to parse gh pr checks output");
  }
}

// ── Async variants ──────────────────────────────────────────────────
// These use Bun.spawn (via runAsync) to yield to the event loop,
// keeping the TUI responsive during poll cycles.
// Sync versions above are kept unchanged for tests and one-shot CLI commands.

/** Async: run a gh command in the context of a specific repo directory. */
export function ghInRepoAsync(repoRoot: string, args: string[]): Promise<RunResult> {
  return runAsync("gh", args, { cwd: repoRoot });
}

/** Async: list PRs for a branch with a given state. Returns GhResult. */
export async function prListAsync(
  repoRoot: string,
  branch: string,
  state: string,
): Promise<GhResult<Array<{ number: number; title: string; body?: string }>>> {
  const result = await ghInRepoAsync(repoRoot, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    state,
    "--json",
    "number,title,body",
    "--limit",
    "100",
  ]);
  if (result.exitCode !== 0) return ghFailure(result.stderr || `gh pr list exited with code ${result.exitCode}`);
  if (!result.stdout) return { ok: true, data: [] };
  try {
    return {
      ok: true,
      data: JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        body?: string;
      }>,
    };
  } catch {
    return ghParseFailure("Failed to parse gh pr list output");
  }
}

/** Async: view a PR by number, returning requested fields. Returns GhResult. */
export async function prViewAsync(
  repoRoot: string,
  prNumber: number,
  fields: string[],
): Promise<GhResult<Record<string, unknown>>> {
  const result = await ghInRepoAsync(repoRoot, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    fields.join(","),
  ]);
  if (result.exitCode !== 0) return ghFailure(result.stderr || `gh pr view exited with code ${result.exitCode}`);
  if (!result.stdout) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(result.stdout) as Record<string, unknown> };
  } catch {
    return ghParseFailure("Failed to parse gh pr view output");
  }
}

/** Async: get CI check status for a PR. Returns GhResult. */
export async function prChecksAsync(
  repoRoot: string,
  prNumber: number,
): Promise<GhResult<{ state: string; name: string; url: string; completedAt?: string }[]>> {
  const result = await ghInRepoAsync(repoRoot, [
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "state,name,link,completedAt",
  ]);
  if (result.exitCode !== 0) return ghFailure(result.stderr || `gh pr checks exited with code ${result.exitCode}`);
  if (!result.stdout) return { ok: true, data: [] };
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      state: string;
      name: string;
      link: string;
      completedAt?: string;
    }>;
    return {
      ok: true,
      data: raw.map((c) => ({
        state: c.state,
        name: c.name,
        url: c.link,
        completedAt: c.completedAt || undefined,
      })),
    };
  } catch {
    return ghParseFailure("Failed to parse gh pr checks output");
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

/** Async variant of getRepoOwner. Uses ghInRepoAsync to avoid blocking. */
async function getRepoOwnerAsync(repoRoot: string): Promise<string> {
  const result = await ghInRepoAsync(repoRoot, [
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

/** Get the repository default branch name (e.g. "main"). */
export function getDefaultBranch(repoRoot: string): string | null {
  const result = ghInRepo(repoRoot, [
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
  ]);
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }
  try {
    const data = JSON.parse(result.stdout) as { defaultBranchRef?: { name?: string } };
    return data.defaultBranchRef?.name ?? null;
  } catch {
    return null;
  }
}

/** Async variant of getDefaultBranch. Uses ghInRepoAsync to avoid blocking. */
export async function getDefaultBranchAsync(repoRoot: string): Promise<string | null> {
  const result = await ghInRepoAsync(repoRoot, [
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
  ]);
  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }
  try {
    const data = JSON.parse(result.stdout) as { defaultBranchRef?: { name?: string } };
    return data.defaultBranchRef?.name ?? null;
  } catch {
    return null;
  }
}

/** Merge a PR by number. Returns true on success, false on failure. */
export function prMerge(
  repoRoot: string,
  prNumber: number,
  options: { method?: "squash" | "merge" | "rebase"; admin?: boolean } = {},
): boolean {
  const { method = "squash", admin = false } = options;
  const args = [
    "pr",
    "merge",
    String(prNumber),
    `--${method}`,
    "--delete-branch",
  ];
  if (admin) {
    args.push("--admin");
  }
  const result = ghInRepo(repoRoot, args);
  return result.exitCode === 0;
}

/** Get a PR's current base branch. Returns null on failure. */
export function getPrBaseBranch(repoRoot: string, prNumber: number): string | null {
  const result = prView(repoRoot, prNumber, ["baseRefName"]);
  if (!result.ok) return null;
  const baseRefName = result.data.baseRefName;
  return typeof baseRefName === "string" && baseRefName.trim().length > 0
    ? baseRefName
    : null;
}

/** Result of fetching PR base branch and state together. */
export type PrBaseAndState = {
  baseBranch: string | null;
  prState: "MERGED" | "OPEN" | "CLOSED" | null;
};

/** Get a PR's current base branch and state in a single API call. Returns null on total failure. */
export function getPrBaseAndState(repoRoot: string, prNumber: number): PrBaseAndState | null {
  const result = prView(repoRoot, prNumber, ["baseRefName", "state"]);
  if (!result.ok) return null;
  const baseRefName = result.data.baseRefName;
  const state = result.data.state;
  const validStates = ["MERGED", "OPEN", "CLOSED"];
  return {
    baseBranch: typeof baseRefName === "string" && (baseRefName as string).trim().length > 0
      ? (baseRefName as string)
      : null,
    prState: typeof state === "string" && validStates.includes(state as string)
      ? (state as "MERGED" | "OPEN" | "CLOSED")
      : null,
  };
}

/** Retarget a PR to a new base branch. Returns true on success, false on failure. */
export function retargetPrBase(repoRoot: string, prNumber: number, baseBranch: string): boolean {
  const result = ghInRepo(repoRoot, [
    "pr",
    "edit",
    String(prNumber),
    "--base",
    baseBranch,
  ]);
  return result.exitCode === 0;
}

/**
 * Find the oldest open PR for an exact head branch.
 * Review maintenance uses one long-lived PR per domain branch, so prefer the
 * lowest-numbered open PR when duplicates exist.
 */
export function findOpenPrByHeadBranch(
  repoRoot: string,
  headBranch: string,
): { number: number; title: string; body?: string } | null {
  const result = prList(repoRoot, headBranch, "open");
  if (!result.ok || result.data.length === 0) return null;
  return result.data
    .slice()
    .sort((a, b) => a.number - b.number)[0] ?? null;
}

/** Replace the body of an existing PR. Returns true on success. */
export function updatePrBody(
  repoRoot: string,
  prNumber: number,
  body: string,
): boolean {
  const result = ghInRepo(repoRoot, [
    "pr",
    "edit",
    String(prNumber),
    "--body",
    body,
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
  const result = prView(repoRoot, prNumber, ["mergeable"]);
  if (!result.ok) return true; // Conservative: treat API error as mergeable to avoid spurious rebase requests
  const mergeable = result.data.mergeable as string | undefined;
  // GitHub returns "MERGEABLE", "CONFLICTING", or "UNKNOWN"
  return mergeable !== "CONFLICTING";
}

/**
 * Check if a PR is blocked by branch protection rules (required checks not passing,
 * required reviews missing, etc.). Returns true if blocked, false if not blocked
 * or on API error (conservative: don't treat API failures as blocked).
 */
export function isPrBlocked(repoRoot: string, prNumber: number): boolean {
  const result = prView(repoRoot, prNumber, ["mergeStateStatus"]);
  if (!result.ok) return false;
  const status = result.data.mergeStateStatus as string | undefined;
  // GitHub returns "BLOCKED", "BEHIND", "CLEAN", "DIRTY", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"
  return status === "BLOCKED";
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

// ── Rate limit querying ────────────────────────────────────────────

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // unix timestamp (seconds)
  used: number;
}

/** Query the GitHub rate limit status. The rate_limit endpoint is exempt from rate limits. */
export async function queryRateLimitAsync(repoRoot: string): Promise<RateLimitInfo | null> {
  try {
    const result = await ghInRepoAsync(repoRoot, ["api", "rate_limit", "--jq", ".rate"]);
    if (result.exitCode !== 0 || !result.stdout?.trim()) return null;
    const parsed = JSON.parse(result.stdout) as RateLimitInfo;
    if (typeof parsed.reset !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the GitHub token to use for gh CLI commands.
 * Only checks the NINTHWAVE_GITHUB_TOKEN env var.
 */
export function resolveGithubToken(_projectRoot: string): string | undefined {
  return process.env.NINTHWAVE_GITHUB_TOKEN ?? undefined;
}

// ── Merge commit SHA ────────────────────────────────────────────────

/**
 * Get the merge commit SHA for a merged PR.
 * Uses `gh pr view` to retrieve the mergeCommit.oid field.
 * @returns The merge commit SHA, or null if it can't be determined.
 */
export function getMergeCommitSha(repoRoot: string, prNumber: number): string | null {
  const result = prView(repoRoot, prNumber, ["mergeCommit"]);
  if (!result.ok) return null;
  const mergeCommit = result.data.mergeCommit as { oid?: string } | undefined;
  return mergeCommit?.oid ?? null;
}

// ── Commit CI check ─────────────────────────────────────────────────

/** Name of the Ninthwave review status check to ignore in commit CI checks. */
export const IGNORED_CHECK_NAMES = new Set(["Ninthwave / Review"]);

/**
 * Check CI status on a specific commit SHA (e.g., merge commit on main).
 * Uses the GitHub Check Runs API to get check statuses.
 * Ignores the Ninthwave / Review check to avoid self-referential loops.
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

  // Filter out ignored checks (e.g., Ninthwave / Review to avoid self-referential loops)
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

/**
 * Async variant of checkCommitCI. Uses ghInRepoAsync to yield to the event
 * loop instead of blocking with Bun.spawnSync. Same parsing logic as sync version.
 */
export async function checkCommitCIAsync(
  repoRoot: string,
  sha: string,
): Promise<"pass" | "fail" | "pending"> {
  let ownerRepo: string;
  try {
    ownerRepo = await getRepoOwnerAsync(repoRoot);
  } catch {
    return "pending";
  }

  const result = await ghInRepoAsync(repoRoot, [
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

  // Filter out ignored checks (e.g., Ninthwave / Review to avoid self-referential loops)
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
 * Uses `gh api repos/{owner}/{repo}/statuses/{sha}` -- requires standard `repo` scope.
 *
 * @param repoRoot - Repo root for gh CLI context
 * @param sha - The commit SHA to set status on
 * @param state - Status state: "pending", "success", or "failure"
 * @param context - Status context string (e.g., "Ninthwave / Review")
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
  const result = prView(repoRoot, prNumber, ["headRefOid"]);
  if (!result.ok) return null;
  const sha = result.data.headRefOid as string | undefined;
  return sha ?? null;
}

// ── Trusted PR comments ──────────────────────────────────────────────

/** Trusted author associations for comment filtering. */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A PR comment from a trusted collaborator. */
export interface PrComment {
  id: number;
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
  commentType: "issue" | "review";
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
  const issueJq = `[.[] | select(.created_at > "${since}" and ${trustedFilter}) | {id: .id, body: .body, author: .user.login, authorAssociation: .author_association, createdAt: .created_at, commentType: "issue"}]`;
  const reviewJq = `[.[] | select(.created_at > "${since}" and ${trustedFilter}) | {id: .id, body: .body, author: .user.login, authorAssociation: .author_association, createdAt: .created_at, commentType: "review"}]`;

  // Issue comments (general PR comments)
  try {
    const raw = apiGet(repoRoot, `repos/${ownerRepo}/issues/${prNumber}/comments`, issueJq);
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as PrComment[];
      comments.push(...parsed);
    }
  } catch { /* ignore */ }

  // Review comments (inline code comments)
  try {
    const raw = apiGet(repoRoot, `repos/${ownerRepo}/pulls/${prNumber}/comments`, reviewJq);
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as PrComment[];
      comments.push(...parsed);
    }
  } catch { /* ignore */ }

  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Async variant of fetchTrustedPrComments. Uses ghInRepoAsync for both API
 * calls to yield to the event loop instead of blocking with Bun.spawnSync.
 * Same filtering and sorting logic as sync version.
 */
export async function fetchTrustedPrCommentsAsync(
  repoRoot: string,
  prNumber: number,
  since: string,
): Promise<PrComment[]> {
  let ownerRepo: string;
  try {
    ownerRepo = await getRepoOwnerAsync(repoRoot);
  } catch {
    return [];
  }

  const comments: PrComment[] = [];
  const trustedFilter = '(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")';
  const issueJq = `[.[] | select(.created_at > "${since}" and ${trustedFilter}) | {id: .id, body: .body, author: .user.login, authorAssociation: .author_association, createdAt: .created_at, commentType: "issue"}]`;
  const reviewJq = `[.[] | select(.created_at > "${since}" and ${trustedFilter}) | {id: .id, body: .body, author: .user.login, authorAssociation: .author_association, createdAt: .created_at, commentType: "review"}]`;

  // Issue comments (general PR comments)
  try {
    const result = await ghInRepoAsync(repoRoot, [
      "api",
      `repos/${ownerRepo}/issues/${prNumber}/comments`,
      "--jq",
      issueJq,
    ]);
    if (result.exitCode === 0 && result.stdout?.trim()) {
      const parsed = JSON.parse(result.stdout) as PrComment[];
      comments.push(...parsed);
    }
  } catch { /* ignore */ }

  // Review comments (inline code comments)
  try {
    const result = await ghInRepoAsync(repoRoot, [
      "api",
      `repos/${ownerRepo}/pulls/${prNumber}/comments`,
      "--jq",
      reviewJq,
    ]);
    if (result.exitCode === 0 && result.stdout?.trim()) {
      const parsed = JSON.parse(result.stdout) as PrComment[];
      comments.push(...parsed);
    }
  } catch { /* ignore */ }

  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── Domain labels ──────────────────────────────────────────────────

const DOMAIN_LABEL_COLOR = "0E8A16";

/**
 * Pre-create domain labels so workers don't need to.
 * Deduplicates domains and ignores failures (label creation should never block work).
 */
export function ensureDomainLabels(repoRoot: string, domains: string[]): void {
  const unique = [...new Set(domains)];
  for (const domain of unique) {
    ghInRepo(repoRoot, [
      "label", "create", `domain:${domain}`,
      "--color", DOMAIN_LABEL_COLOR, "--force",
    ]);
  }
}

/**
 * Apply the resolved GitHub token to process.env.GH_TOKEN.
 * This makes all gh CLI invocations (daemon + workers) use the custom identity.
 * Workers inherit GH_TOKEN via environment when launched.
 * No-op if no custom token is configured -- preserves default gh auth behavior.
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

/** List all review comments on a PR. Returns array of {id, body, path}. */
export function listPrReviewComments(
  repoRoot: string,
  prNumber: number,
): Array<{ id: number; body: string; path: string }> {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return [];
  }
  const result = ghInRepo(repoRoot, [
    "api",
    `repos/${ownerRepo}/pulls/${prNumber}/comments`,
    "--jq",
    "[.[] | {id: .id, body: .body, path: .path}]",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    return JSON.parse(result.stdout) as Array<{ id: number; body: string; path: string }>;
  } catch {
    return [];
  }
}

/** Add a reaction to a PR comment. Best-effort: failures are ignored. */
export function addCommentReaction(
  repoRoot: string,
  commentId: number,
  commentType: "issue" | "review",
  reaction: string,
): void {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return;
  }

  const endpoint = commentType === "issue"
    ? `repos/${ownerRepo}/issues/comments/${commentId}/reactions`
    : `repos/${ownerRepo}/pulls/comments/${commentId}/reactions`;

  try {
    ghInRepo(repoRoot, [
      "api",
      "--method",
      "POST",
      endpoint,
      "-f",
      `content=${reaction}`,
    ]);
  } catch {
    // Best-effort acknowledgement only.
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

/** Update an existing review comment by ID. Returns true on success. */
export function updatePrReviewComment(
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
    `repos/${ownerRepo}/pulls/comments/${commentId}`,
    "-f",
    `body=${body}`,
  ]);
  return result.exitCode === 0;
}

/** Hidden HTML comment prefix for deleted-file review comments. */
export const DELETED_FILE_REVIEW_COMMENT_MARKER_PREFIX = "<!-- ninthwave-deleted-file-review:";

/** Build the stable marker used to upsert deleted-file review comments. */
export function deletedFileReviewCommentMarker(path: string): string {
  return `${DELETED_FILE_REVIEW_COMMENT_MARKER_PREFIX}${path} -->`;
}

function withManagedMarker(marker: string, body: string): string {
  return body.includes(marker) ? body : `${marker}\n${body}`;
}

/** Create a file-level review comment for a deleted file. Returns true on success. */
export function createDeletedFileReviewComment(
  repoRoot: string,
  prNumber: number,
  commitId: string,
  path: string,
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
    "POST",
    `repos/${ownerRepo}/pulls/${prNumber}/comments`,
    "-f",
    `body=${body}`,
    "-f",
    `commit_id=${commitId}`,
    "-f",
    `path=${path}`,
    "-f",
    "subject_type=file",
  ]);
  return result.exitCode === 0;
}

/**
 * Create or update a managed file-level review comment for a deleted file.
 * Uses a stable path-derived marker and updates the oldest matching comment when
 * duplicates exist, preventing reruns from spraying additional comments.
 */
export function upsertDeletedFileReviewComment(
  repoRoot: string,
  prNumber: number,
  commitId: string,
  path: string,
  body: string,
): boolean {
  const marker = deletedFileReviewCommentMarker(path);
  const managedBody = withManagedMarker(marker, body);
  const existing = listPrReviewComments(repoRoot, prNumber)
    .filter((comment) => comment.path === path && comment.body.includes(marker))
    .sort((a, b) => a.id - b.id)[0];

  if (existing) {
    return updatePrReviewComment(repoRoot, existing.id, managedBody);
  }

  return createDeletedFileReviewComment(repoRoot, prNumber, commitId, path, managedBody);
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
 * @param itemId - Work item ID (e.g., "H-FOO-1")
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
    // Insert new row before the branding footer (if present), otherwise append.
    // The footer in the created body is: "\n\n---\n<sub>Ninthwave</sub>"
    // (blank line before --- to avoid setext heading interpretation).
    const footerMarker = `\n\n---\n${NINTHWAVE_FOOTER}`;
    let updatedBody: string;
    if (existing.body.includes(footerMarker)) {
      updatedBody = existing.body.replace(footerMarker, "\n" + newRow + footerMarker);
    } else {
      updatedBody = existing.body + "\n" + newRow;
    }
    return client.updateComment(repoRoot, existing.id, updatedBody);
  }

  // Create new comment with header + first row + branding footer
  const body = [
    ORCHESTRATOR_COMMENT_MARKER,
    `**[Orchestrator](${ORCHESTRATOR_LINK})** Status for ${itemId}`,
    "",
    "| Time | Event |",
    "|------|-------|",
    newRow,
    "",
    "---",
    NINTHWAVE_FOOTER,
  ].join("\n");

  return client.createComment(repoRoot, prNumber, body);
}
