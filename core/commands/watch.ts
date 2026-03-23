// Watch/polling commands: watch-ready, autopilot-watch, pr-watch, pr-activity.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { die } from "../output.ts";
import { prList, prView, prChecks, getRepoOwner, apiGet } from "../gh.ts";
import * as gh from "../gh.ts";
import type { WatchResult, Transition } from "../types.ts";

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

  // Iterate hub-local worktrees
  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (!entry.startsWith("todo-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(5);
      const line = checkPrStatus(id, projectRoot);
      if (line) results.push(line);
    }
  } catch {
    // ignore
  }

  const output = results.join("\n");
  if (output) console.log(output);
  return output;
}

export function checkPrStatus(id: string, repoRoot: string): string {
  const branch = `todo/${id}`;

  if (!gh.isAvailable()) return "";

  // Check for open PR
  const openPrs = prList(repoRoot, branch, "open");
  if (openPrs.length === 0) {
    // Check if merged
    const mergedPrs = prList(repoRoot, branch, "merged");
    if (mergedPrs.length > 0) {
      return `${id}\t${mergedPrs[0]!.number}\tmerged`;
    }
    return `${id}\t\tno-pr`;
  }

  const prNumber = openPrs[0]!.number;

  // Check CI and review status
  const prData = prView(repoRoot, prNumber, [
    "reviewDecision",
    "mergeable",
  ]);
  const reviewDecision = (prData.reviewDecision as string) ?? "";
  const isMergeable = (prData.mergeable as string) ?? "";

  const checks = prChecks(repoRoot, prNumber);
  const nonSkipped = checks.filter((c) => c.state !== "SKIPPED");
  let ciStatus = "unknown";
  if (nonSkipped.length > 0) {
    if (nonSkipped.every((c) => c.state === "SUCCESS")) {
      ciStatus = "pass";
    } else if (nonSkipped.some((c) => c.state === "FAILURE")) {
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

  return `${id}\t${prNumber}\t${status}`;
}

/**
 * Poll until item status changes.
 * Outputs transitions as tab-separated: ID\tPR_NUMBER\tFROM\tTO
 */
export async function cmdAutopilotWatch(
  args: string[],
  worktreeDir: string,
  projectRoot: string,
): Promise<void> {
  let interval = 120;
  let stateFile = "";

  // Parse args
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--interval":
        interval = parseInt(args[i + 1] ?? "120", 10);
        i += 2;
        break;
      case "--state-file":
        stateFile = args[i + 1] ?? "";
        i += 2;
        break;
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  // Take initial snapshot (suppress console output by capturing)
  let currentState = getWatchReadyState(worktreeDir, projectRoot);

  // Load previous state
  let prevState = "";
  if (stateFile && existsSync(stateFile)) {
    prevState = readFileSync(stateFile, "utf-8");
  }

  // Save current state
  if (stateFile) {
    writeFileSync(stateFile, currentState);
  }

  // Compare and report transitions
  let transitions = findTransitions(currentState, prevState);

  // Check for gone items
  transitions += findGoneItems(currentState, prevState);

  if (transitions) {
    console.log(transitions.trim());
    return;
  }

  // No transitions — poll until something changes
  let elapsed = 0;
  while (elapsed < 3600) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    elapsed += interval;

    currentState = getWatchReadyState(worktreeDir, projectRoot);

    // Compare against saved state
    const savedState = stateFile && existsSync(stateFile)
      ? readFileSync(stateFile, "utf-8")
      : "";

    transitions = findTransitions(currentState, savedState);
    transitions += findGoneItems(currentState, savedState);

    // Save current state
    if (stateFile) {
      writeFileSync(stateFile, currentState);
    }

    if (transitions) {
      console.log(transitions.trim());
      return;
    }
  }

  console.log("Timeout: no status changes after 1 hour");
  process.exit(1);
}

/** Get watch-ready state without printing to console. */
export function getWatchReadyState(
  worktreeDir: string,
  projectRoot: string,
): string {
  if (!existsSync(worktreeDir)) return "";

  const results: string[] = [];
  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (!entry.startsWith("todo-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(5);
      const line = checkPrStatus(id, projectRoot);
      if (line) results.push(line);
    }
  } catch {
    // ignore
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

    // Check for new reviews
    let newReviews = 0;
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${prNumber}/reviews`,
        `[.[] | select(.submitted_at > "${since}")] | length`,
      );
      newReviews = parseInt(result, 10) || 0;
    } catch {
      // ignore
    }

    // Check for new comments
    let newComments = 0;
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/issues/${prNumber}/comments`,
        `[.[] | select(.created_at > "${since}")] | length`,
      );
      newComments = parseInt(result, 10) || 0;
    } catch {
      // ignore
    }

    // Check for new review comments
    let newReviewComments = 0;
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${prNumber}/comments`,
        `[.[] | select(.created_at > "${since}")] | length`,
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

    // Check for review decisions
    try {
      const reviewState = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${pr}/reviews`,
        `[.[] | select(.submitted_at > "${since}")] | last | .state`,
      );
      if (reviewState === "CHANGES_REQUESTED") {
        activityType = "changes_requested";
      } else if (reviewState === "APPROVED") {
        activityType = "approved";
      }
    } catch {
      // ignore
    }

    // Check for new comments
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/issues/${pr}/comments`,
        `[.[] | select(.created_at > "${since}")] | length`,
      );
      const count = parseInt(result, 10) || 0;
      if (count > 0 && activityType === "none") {
        activityType = "new_comments";
      }
    } catch {
      // ignore
    }

    // Check for new review comments (inline)
    try {
      const result = apiGet(
        projectRoot,
        `repos/${ownerRepo}/pulls/${pr}/comments`,
        `[.[] | select(.created_at > "${since}")] | length`,
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
