// Watch/polling commands: watch-ready, pr-watch, pr-activity, scanExternalPRs.

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { die } from "../output.ts";
import { prList, prView, prChecks, prListAsync, prViewAsync, prChecksAsync, getRepoOwner, apiGet, ghInRepo } from "../gh.ts";
import * as gh from "../gh.ts";
import type { WatchResult, Transition } from "../types.ts";
import { listCrossRepoEntries } from "../cross-repo.ts";

// ── External PR scanning ──────────────────────────────────────────────

/** Data returned by scanExternalPRs for each non-ninthwave PR. */
export interface ExternalPR {
  prNumber: number;
  headBranch: string;
  author: string;
  isDraft: boolean;
  headSha: string;
  authorAssociation: string;
  labels: string[];
}

/** Raw shape returned by the GitHub REST API for pull requests. */
interface GitHubPullRequest {
  number: number;
  head: { ref: string; sha: string };
  user: { login: string };
  draft: boolean;
  author_association: string;
  labels: Array<{ name: string }>;
}

/** Injectable dependencies for scanExternalPRs, for testing. */
export interface ScanExternalPRsDeps {
  ghRunner: (root: string, args: string[]) => { exitCode: number; stdout: string };
  isAvailable: () => boolean;
  getOwnerRepo: (repoRoot: string) => string;
}

const defaultScanDeps: ScanExternalPRsDeps = {
  ghRunner: ghInRepo,
  isAvailable: () => gh.isAvailable(),
  getOwnerRepo: getRepoOwner,
};

/**
 * Scan for open PRs not managed by ninthwave (non-`ninthwave/*` branches).
 * Uses the GitHub REST API to list open PRs with author_association.
 *
 * @param repoRoot - Path to the repository root
 * @param deps - Injectable dependencies for testing
 */
export function scanExternalPRs(
  repoRoot: string,
  deps: Partial<ScanExternalPRsDeps> = {},
): ExternalPR[] {
  const { ghRunner, isAvailable, getOwnerRepo } = { ...defaultScanDeps, ...deps };

  if (!isAvailable()) return [];

  let ownerRepo: string;
  try {
    ownerRepo = getOwnerRepo(repoRoot);
  } catch {
    return [];
  }

  const result = ghRunner(repoRoot, [
    "api",
    `repos/${ownerRepo}/pulls?state=open&per_page=100`,
  ]);

  if (result.exitCode !== 0 || !result.stdout) return [];

  try {
    const prs = JSON.parse(result.stdout) as GitHubPullRequest[];

    return prs
      .filter((pr) => !pr.head.ref.startsWith("ninthwave/"))
      .map((pr) => ({
        prNumber: pr.number,
        headBranch: pr.head.ref,
        author: pr.user.login,
        isDraft: pr.draft,
        headSha: pr.head.sha,
        authorAssociation: pr.author_association,
        labels: pr.labels.map((l) => l.name),
      }));
  } catch {
    return [];
  }
}

/** jq fragment: only count comments/reviews from trusted author associations. */
export const TRUSTED_ASSOC = '(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")';

/**
 * Check each worktree's PR status (merged/ready/pending/failing/no-pr).
 * Returns tab-separated lines: ID\tPR_NUMBER\tSTATUS
 */
export function cmdWatchReady(
  worktreeDir: string,
  projectRoot: string,
): string {
  if (!existsSync(worktreeDir)) {
    console.log("No active worktrees");
    return "";
  }

  const results: string[] = [];
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");

  // Iterate hub-local worktrees
  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (!entry.startsWith("ninthwave-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(10);
      const line = checkPrStatus(id, projectRoot);
      if (line) results.push(line);
    }
  } catch {
    // ignore
  }

  // Iterate cross-repo worktrees (PRs live in target repos)
  const hubCheckedIds = new Set(results.map((r) => r.split("\t")[0]));
  for (const entry of listCrossRepoEntries(crossRepoIndex)) {
    if (hubCheckedIds.has(entry.itemId)) continue;
    const statusLine = checkPrStatus(entry.itemId, entry.repoRoot);
    if (statusLine) results.push(statusLine);
  }

  const output = results.join("\n");
  if (output) console.log(output);
  return output;
}

/**
 * CI check states that indicate a definitive failure.
 * GitHub returns these from check runs (FAILURE, CANCELLED, TIMED_OUT,
 * ACTION_REQUIRED, STARTUP_FAILURE) and commit status checks (ERROR).
 * Without this, only FAILURE was detected -- other failure states like ERROR
 * left ciStatus as "unknown", causing items to stay stuck in ci-pending.
 */
export const CI_FAILURE_STATES = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

export function checkPrStatus(id: string, repoRoot: string): string {
  const branch = `ninthwave/${id}`;

  if (!gh.isAvailable()) return "";

  // Check for open PR
  const openPrs = prList(repoRoot, branch, "open");
  if (openPrs.length === 0) {
    // Check if merged
    const mergedPrs = prList(repoRoot, branch, "merged");
    if (mergedPrs.length > 0) {
      // Include PR title as 6th field so callers can detect ID collisions
      // (a new TODO reusing an old merged PR's branch name).
      const prTitle = mergedPrs[0]!.title ?? "";
      return `${id}\t${mergedPrs[0]!.number}\tmerged\t\t\t${prTitle}`;
    }
    return `${id}\t\tno-pr`;
  }

  const prNumber = openPrs[0]!.number;

  // Check CI and review status (include updatedAt for detection latency)
  const prData = prView(repoRoot, prNumber, [
    "reviewDecision",
    "mergeable",
    "updatedAt",
  ]);
  const reviewDecision = (prData.reviewDecision as string) ?? "";
  const isMergeable = (prData.mergeable as string) ?? "";
  const prUpdatedAt = (prData.updatedAt as string) ?? "";

  const checks = prChecks(repoRoot, prNumber);
  const nonSkipped = checks.filter((c) => c.state !== "SKIPPED");
  let ciStatus = "unknown";
  if (nonSkipped.length > 0) {
    if (nonSkipped.every((c) => c.state === "SUCCESS")) {
      ciStatus = "pass";
    } else if (nonSkipped.some((c) => CI_FAILURE_STATES.has(c.state))) {
      ciStatus = "fail";
    } else if (nonSkipped.some((c) => c.state === "PENDING")) {
      ciStatus = "pending";
    }
  }

  let status = "pending";
  if (ciStatus === "fail") {
    status = "failing";
  } else if (ciStatus === "pass") {
    if (isMergeable === "MERGEABLE" && reviewDecision === "APPROVED") {
      status = "ready";
    } else {
      status = "ci-passed";
    }
  } else if (ciStatus === "pending") {
    status = "pending";
  }

  // Determine event time: use the latest CI check completedAt for terminal CI states,
  // fall back to PR updatedAt for other states.
  let eventTime = prUpdatedAt;
  if (ciStatus === "pass" || ciStatus === "fail") {
    const completedTimes = nonSkipped
      .map((c) => c.completedAt)
      .filter((t): t is string => !!t)
      .sort();
    if (completedTimes.length > 0) {
      // Use the latest completedAt -- the check that determined the final CI status
      eventTime = completedTimes[completedTimes.length - 1]!;
    }
  }

  // Fields: ID, PR number, status, mergeable, eventTime (5th field for detection latency)
  return `${id}\t${prNumber}\t${status}\t${isMergeable || "UNKNOWN"}\t${eventTime}`;
}

/**
 * Async variant of checkPrStatus. Uses async gh functions so each
 * network call yields to the event loop, keeping the TUI responsive.
 * Returns the same tab-separated string format as the sync version.
 */
export async function checkPrStatusAsync(id: string, repoRoot: string): Promise<string> {
  const branch = `ninthwave/${id}`;

  if (!gh.isAvailable()) return "";

  // Check for open PR
  const openPrs = await prListAsync(repoRoot, branch, "open");
  if (openPrs.length === 0) {
    // Check if merged
    const mergedPrs = await prListAsync(repoRoot, branch, "merged");
    if (mergedPrs.length > 0) {
      const prTitle = mergedPrs[0]!.title ?? "";
      return `${id}\t${mergedPrs[0]!.number}\tmerged\t\t\t${prTitle}`;
    }
    return `${id}\t\tno-pr`;
  }

  const prNumber = openPrs[0]!.number;

  // Check CI and review status (include updatedAt for detection latency)
  const prData = await prViewAsync(repoRoot, prNumber, [
    "reviewDecision",
    "mergeable",
    "updatedAt",
  ]);
  const reviewDecision = (prData.reviewDecision as string) ?? "";
  const isMergeable = (prData.mergeable as string) ?? "";
  const prUpdatedAt = (prData.updatedAt as string) ?? "";

  const checks = await prChecksAsync(repoRoot, prNumber);
  const nonSkipped = checks.filter((c) => c.state !== "SKIPPED");
  let ciStatus = "unknown";
  if (nonSkipped.length > 0) {
    if (nonSkipped.every((c) => c.state === "SUCCESS")) {
      ciStatus = "pass";
    } else if (nonSkipped.some((c) => CI_FAILURE_STATES.has(c.state))) {
      ciStatus = "fail";
    } else if (nonSkipped.some((c) => c.state === "PENDING")) {
      ciStatus = "pending";
    }
  }

  let status = "pending";
  if (ciStatus === "fail") {
    status = "failing";
  } else if (ciStatus === "pass") {
    if (isMergeable === "MERGEABLE" && reviewDecision === "APPROVED") {
      status = "ready";
    } else {
      status = "ci-passed";
    }
  } else if (ciStatus === "pending") {
    status = "pending";
  }

  // Determine event time
  let eventTime = prUpdatedAt;
  if (ciStatus === "pass" || ciStatus === "fail") {
    const completedTimes = nonSkipped
      .map((c) => c.completedAt)
      .filter((t): t is string => !!t)
      .sort();
    if (completedTimes.length > 0) {
      eventTime = completedTimes[completedTimes.length - 1]!;
    }
  }

  return `${id}\t${prNumber}\t${status}\t${isMergeable || "UNKNOWN"}\t${eventTime}`;
}

/** Get watch-ready state without printing to console. */
export function getWatchReadyState(
  worktreeDir: string,
  projectRoot: string,
): string {
  if (!existsSync(worktreeDir)) return "";

  const results: string[] = [];
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");

  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (!entry.startsWith("ninthwave-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(10);
      const line = checkPrStatus(id, projectRoot);
      if (line) results.push(line);
    }
  } catch {
    // ignore
  }

  // Also check cross-repo worktrees
  const hubCheckedIds = new Set(results.map((r) => r.split("\t")[0]));
  for (const entry of listCrossRepoEntries(crossRepoIndex)) {
    if (hubCheckedIds.has(entry.itemId)) continue;
    const statusLine = checkPrStatus(entry.itemId, entry.repoRoot);
    if (statusLine) results.push(statusLine);
  }

  return results.join("\n");
}

export function findTransitions(currentState: string, prevState: string): string {
  let transitions = "";
  for (const line of currentState.split("\n")) {
    if (!line) continue;
    const [id, prNumber, status] = line.split("\t");
    if (!id) continue;

    let prevStatus = "no-pr";
    if (prevState) {
      for (const prevLine of prevState.split("\n")) {
        const parts = prevLine.split("\t");
        if (parts[0] === id) {
          prevStatus = parts[2] ?? "no-pr";
          break;
        }
      }
    }

    if (prevStatus !== status) {
      transitions += `${id}\t${prNumber ?? ""}\t${prevStatus}\t${status}\n`;
    }
  }
  return transitions;
}

export function findGoneItems(currentState: string, prevState: string): string {
  if (!prevState) return "";
  let transitions = "";
  const currentIds = new Set(
    currentState
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t")[0]),
  );

  for (const line of prevState.split("\n")) {
    if (!line) continue;
    const [id, prNumber, status] = line.split("\t");
    if (!id) continue;
    if (!currentIds.has(id)) {
      transitions += `${id}\t${prNumber ?? ""}\t${status ?? ""}\tgone\n`;
    }
  }
  return transitions;
}

/**
 * Poll until PR has new activity (reviews, comments).
 */
export async function cmdPrWatch(
  args: string[],
  projectRoot: string,
): Promise<void> {
  let prNumber = "";
  let interval = 120;
  let since = "";

  // Parse args
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--pr":
        prNumber = args[i + 1] ?? "";
        i += 2;
        break;
      case "--interval":
        interval = parseInt(args[i + 1] ?? "120", 10);
        i += 2;
        break;
      case "--since":
        since = args[i + 1] ?? "";
        i += 2;
        break;
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  if (!prNumber) {
    die("Usage: ninthwave pr-watch --pr N [--interval N] [--since T]");
  }

  if (!since) {
    since = new Date().toISOString();
  }

  let elapsed = 0;
  while (elapsed < 3600) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    elapsed += interval;

    let ownerRepo: string;
    try {
      ownerRepo = getRepoOwner(projectRoot);
    } catch {
      continue;
    }

    // Check for new reviews (trusted authors only)
    let newReviews = 0;
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${prNumber}/reviews`,
        `[.[] | select(.submitted_at > "${since}" and ${TRUSTED_ASSOC})] | length`,
      );
      newReviews = parseInt(result, 10) || 0;
    } catch {
      // ignore
    }

    // Check for new comments (trusted authors only)
    let newComments = 0;
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/issues/${prNumber}/comments`,
        `[.[] | select(.created_at > "${since}" and ${TRUSTED_ASSOC})] | length`,
      );
      newComments = parseInt(result, 10) || 0;
    } catch {
      // ignore
    }

    // Check for new review comments (trusted authors only)
    let newReviewComments = 0;
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${prNumber}/comments`,
        `[.[] | select(.created_at > "${since}" and ${TRUSTED_ASSOC})] | length`,
      );
      newReviewComments = parseInt(result, 10) || 0;
    } catch {
      // ignore
    }

    const total = newReviews + newComments + newReviewComments;
    if (total > 0) {
      console.log(`activity\t${prNumber}\t${total}`);
      return;
    }

    // Check if PR state changed
    try {
      const data = prView(projectRoot, parseInt(prNumber, 10), ["state"]);
      const state = data.state as string;
      if (state === "MERGED" || state === "CLOSED") {
        console.log(`state_change\t${prNumber}\t${state}`);
        return;
      }
    } catch {
      // ignore
    }
  }

  console.log(`Timeout: no activity on PR #${prNumber} after 1 hour`);
  process.exit(1);
}

/**
 * Check for new comments/reviews on PRs since a given time.
 */
export function cmdPrActivity(
  args: string[],
  projectRoot: string,
): void {
  const prs: string[] = [];
  let since = "";

  // Parse args
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--since") {
      since = args[i + 1] ?? "";
      i += 2;
    } else {
      prs.push(args[i]!);
      i++;
    }
  }

  if (prs.length < 1) {
    die("Usage: ninthwave pr-activity <PR1> [PR2]... [--since T]");
  }

  if (!since) {
    // Default to 1 hour ago
    since = new Date(Date.now() - 3600 * 1000).toISOString();
  }

  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(projectRoot);
  } catch {
    die("Could not determine repository");
  }

  for (const pr of prs) {
    let activityType = "none";

    // Check for review decisions (trusted authors only)
    try {
      const reviewState = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${pr}/reviews`,
        `[.[] | select(.submitted_at > "${since}" and ${TRUSTED_ASSOC})] | last | .state`,
      );
      if (reviewState === "CHANGES_REQUESTED") {
        activityType = "changes_requested";
      } else if (reviewState === "APPROVED") {
        activityType = "approved";
      }
    } catch {
      // ignore
    }

    // Check for new comments (trusted authors only)
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/issues/${pr}/comments`,
        `[.[] | select(.created_at > "${since}" and ${TRUSTED_ASSOC})] | length`,
      );
      const count = parseInt(result, 10) || 0;
      if (count > 0 && activityType === "none") {
        activityType = "new_comments";
      }
    } catch {
      // ignore
    }

    // Check for new review comments (trusted authors only, inline)
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${pr}/comments`,
        `[.[] | select(.created_at > "${since}" and ${TRUSTED_ASSOC})] | length`,
      );
      const count = parseInt(result, 10) || 0;
      if (count > 0 && activityType === "none") {
        activityType = "new_comments";
      }
    } catch {
      // ignore
    }

    console.log(`${pr}\t${activityType}`);
  }
}
