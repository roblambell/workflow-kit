// Snapshot building: polling GitHub PR status, worker liveness, heartbeats, and commit times.
// Extracted from core/commands/orchestrate.ts for modularity.

import { run, runAsync } from "./shell.ts";
import { type Multiplexer, getMux } from "./mux.ts";
import {
  type Orchestrator,
  type PollSnapshot,
  type ItemSnapshot,
  type OrchestratorItem,
} from "./orchestrator.ts";
import { readHeartbeat, readVerdictFile } from "./daemon.ts";
import { checkPrStatus, checkPrStatusAsync } from "./commands/pr-monitor.ts";
import { prTitleMatchesWorkItem } from "./work-item-files.ts";
import type { PrComment } from "./gh.ts";

// ── Worktree commit tracking ──────────────────────────────────────

/**
 * Get the ISO timestamp of the most recent commit on a worktree branch.
 * Returns the ISO 8601 timestamp string, or null if the branch doesn't exist
 * or has no commits (e.g., just launched, branch not yet created).
 */
export function getWorktreeLastCommitTime(
  projectRoot: string,
  branchName: string,
): string | null {
  try {
    // Only count commits the worker actually made (on this branch but not on main).
    // Using `main..branchName` avoids treating the base branch's last commit time
    // as worker activity -- which would cause the heartbeat to immediately declare
    // stale workers as stalled when the base branch hasn't been updated recently.
    const result = run("git", ["log", "-1", "--format=%cI", `main..${branchName}`], {
      cwd: projectRoot,
    });
    if (result.exitCode !== 0 || !result.stdout?.trim()) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Async variant of getWorktreeLastCommitTime. Uses runAsync to yield to the
 * event loop instead of blocking with Bun.spawnSync.
 */
export async function getWorktreeLastCommitTimeAsync(
  projectRoot: string,
  branchName: string,
): Promise<string | null> {
  try {
    const result = await runAsync("git", ["log", "-1", "--format=%cI", `main..${branchName}`], {
      cwd: projectRoot,
    });
    if (result.exitCode !== 0 || !result.stdout?.trim()) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

// ── Snapshot building ──────────────────────────────────────────────

/**
 * Build a PollSnapshot by querying GitHub PR status and cmux workspace state
 * for all tracked items. Computes readyIds based on dependency satisfaction.
 */
export function buildSnapshot(
  orch: Orchestrator,
  projectRoot: string,
  _worktreeDir: string,
  mux: Multiplexer = getMux(),
  getLastCommitTime: (projectRoot: string, branchName: string) => string | null = getWorktreeLastCommitTime,
  checkPr: (id: string, projectRoot: string) => string | null = checkPrStatus,
  fetchComments?: (repoRoot: string, prNumber: number, since: string) => Array<{ body: string; author: string; createdAt: string }>,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending",
): PollSnapshot {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "merging"]);
  let apiErrorCount = 0;
  /** States that require PR polling -- used to count API errors only for items that actually poll GitHub. */
  const prPollStates = new Set(["implementing", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing", "rebasing", "merging", "launching"]);

  // Cache workspace listing once for all isWorkerAlive checks in this snapshot
  const cachedWorkspaces = mux.listWorkspaces();

  for (const orchItem of orch.getAllItems()) {
    // Compute readyIds for queued items
    if (orchItem.state === "queued") {
      const allDepsMet = orchItem.workItem.dependencies.every((depId) => {
        const depItem = orch.getItem(depId);
        // Dep is met if: not tracked, or in done/merged state
        return !depItem || depItem.state === "done" || depItem.state === "merged";
      });
      if (allDepsMet) {
        readyIds.push(orchItem.id);
      }
      continue;
    }

    // Skip terminal states -- nothing to poll
    if (orchItem.state === "done" || orchItem.state === "stuck") continue;

    // Post-merge verification: poll CI on the merge commit (no PR polling needed)
    if ((orchItem.state === "forward-fix-pending" || orchItem.state === "fix-forward-failed") && orchItem.mergeCommitSha) {
      const snap: ItemSnapshot = { id: orchItem.id };
      if (checkCommitCI) {
        const repoRoot = orchItem.resolvedRepoRoot ?? projectRoot;
        try {
          snap.mergeCommitCIStatus = checkCommitCI(repoRoot, orchItem.mergeCommitSha);
        } catch {
          // Non-fatal -- will retry next cycle
        }
      }
      items.push(snap);
      continue;
    }

    const snap: ItemSnapshot = { id: orchItem.id };

    // Check PR status via gh -- use the item's resolved repo root for cross-repo items
    const repoRoot = orchItem.resolvedRepoRoot ?? projectRoot;
    const statusLine = checkPr(orchItem.id, repoRoot);
    // Empty string from checkPr means API error -- hold state for this item
    if (!statusLine && prPollStates.has(orchItem.state)) {
      apiErrorCount++;
    }
    if (statusLine) {
      const parts = statusLine.split("\t");
      const prNumStr = parts[1];
      const status = parts[2];
      const mergeableStr = parts[3]; // 4th field: MERGEABLE|CONFLICTING|UNKNOWN
      const eventTimeStr = parts[4]; // 5th field: event timestamp for detection latency

      if (prNumStr) {
        snap.prNumber = parseInt(prNumStr, 10);
      }

      switch (status) {
        case "merged": {
          // Title collision check: when a work item ID is reused, the old merged PR
          // still shows up for the same branch name. If the orchestrator already
          // assigned a PR number to this item (during this session), trust it.
          // Otherwise, compare the merged PR's title against the work item title.
          const mergedPrTitle = parts[5] ?? "";
          const itemTitle = orchItem.workItem.title;
          const alreadyTracked = orchItem.prNumber != null && snap.prNumber === orchItem.prNumber;
          if (alreadyTracked || !mergedPrTitle || prTitleMatchesWorkItem(mergedPrTitle, itemTitle)) {
            snap.prState = "merged";
          }
          // else: title mismatch -- stale merged PR from a previous cycle, ignore it
          break;
        }
        case "ready":
          snap.ciStatus = "pass";
          snap.prState = "open";
          snap.reviewDecision = "APPROVED";
          snap.isMergeable = true;
          break;
        case "ci-passed":
          snap.ciStatus = "pass";
          snap.prState = "open";
          break;
        case "failing":
          snap.ciStatus = "fail";
          snap.prState = "open";
          break;
        case "pending":
          snap.ciStatus = "pending";
          snap.prState = "open";
          break;
        // "no-pr" -- leave snap fields unset
      }

      // Set isMergeable from the 4th field for all open PR states.
      // This lets the orchestrator distinguish CI failures caused by
      // merge conflicts (needs rebase) from regular CI failures (needs code fix).
      if (mergeableStr === "MERGEABLE") {
        snap.isMergeable = true;
      } else if (mergeableStr === "CONFLICTING") {
        snap.isMergeable = false;
      }

      // Set eventTime from the 5th field for detection latency measurement
      if (eventTimeStr) {
        snap.eventTime = eventTimeStr;
      }
    }

    // Check review worker health and verdict file for items in reviewing state
    if (orchItem.state === "reviewing" && orchItem.reviewWorkspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(
        { ...orchItem, workspaceRef: orchItem.reviewWorkspaceRef } as OrchestratorItem,
        cachedWorkspaces,
      );
      if (orchItem.reviewVerdictPath) {
        try {
          snap.reviewVerdict = readVerdictFile(orchItem.reviewVerdictPath) ?? undefined;
        } catch { /* best-effort -- verdict read failure doesn't block polling */ }
      }
    }

    // Check rebaser worker health for items in rebasing state
    if (orchItem.state === "rebasing" && orchItem.rebaserWorkspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(
        { ...orchItem, workspaceRef: orchItem.rebaserWorkspaceRef } as OrchestratorItem,
        cachedWorkspaces,
      );
    }

    // Check forward-fixer worker health for items in fixing-forward state
    if (orchItem.state === "fixing-forward" && orchItem.fixForwardWorkspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(
        { ...orchItem, workspaceRef: orchItem.fixForwardWorkspaceRef } as OrchestratorItem,
        cachedWorkspaces,
      );
    }

    // Check worker alive and commit freshness for active items
    if (orchItem.state === "launching" || orchItem.state === "implementing" || orchItem.state === "ci-failed") {
      snap.workerAlive = isWorkerAliveWithCache(orchItem, cachedWorkspaces);
      const commitTime = getLastCommitTime(repoRoot, `ninthwave/${orchItem.id}`);
      snap.lastCommitTime = commitTime;
      orchItem.lastCommitTime = commitTime;
    }

    // Read heartbeat file for active items
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.lastHeartbeat = readHeartbeat(projectRoot, orchItem.id) ?? null;
      } catch { /* best-effort -- heartbeat read failure doesn't block polling */ }
    }

    // Fetch new trusted PR comments for items with open PRs in active states
    if (orchItem.prNumber && fetchComments) {
      const commentRelayStates = new Set(["ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing"]);
      if (commentRelayStates.has(orchItem.state)) {
        const since = orchItem.lastCommentCheck || orchItem.lastTransition;
        try {
          const comments = fetchComments(repoRoot, orchItem.prNumber, since);
          if (comments.length > 0) {
            snap.newComments = comments;
          }
        } catch { /* ignore -- comment polling is best-effort */ }
      }
    }

    items.push(snap);
  }

  return { items, readyIds, apiErrorCount: apiErrorCount > 0 ? apiErrorCount : undefined };
}

/**
 * Async variant of buildSnapshot. All subprocess calls (PR status, commit CI,
 * PR comments, commit time) use async variants that yield to the event loop,
 * keeping TUI keyboard input responsive during poll cycles.
 *
 * Same snapshot assembly logic as the sync version. Non-subprocess operations
 * (heartbeat reads, worker-alive checks) remain synchronous since they
 * are local filesystem/process operations that complete instantly.
 */
export async function buildSnapshotAsync(
  orch: Orchestrator,
  projectRoot: string,
  _worktreeDir: string,
  mux: Multiplexer = getMux(),
  getLastCommitTime: (projectRoot: string, branchName: string) => string | null | Promise<string | null> = getWorktreeLastCommitTimeAsync,
  checkPr: (id: string, projectRoot: string) => Promise<string | null> = checkPrStatusAsync,
  fetchComments?: (repoRoot: string, prNumber: number, since: string) => PrComment[] | Promise<PrComment[]>,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending" | Promise<"pass" | "fail" | "pending">,
): Promise<PollSnapshot> {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "merging"]);
  let apiErrorCount = 0;
  const prPollStates = new Set(["implementing", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing", "rebasing", "merging", "launching"]);

  // Cache workspace listing once for all isWorkerAlive checks in this snapshot
  const cachedWorkspaces = mux.listWorkspaces();

  for (const orchItem of orch.getAllItems()) {
    // Compute readyIds for queued items
    if (orchItem.state === "queued") {
      const allDepsMet = orchItem.workItem.dependencies.every((depId) => {
        const depItem = orch.getItem(depId);
        return !depItem || depItem.state === "done" || depItem.state === "merged";
      });
      if (allDepsMet) {
        readyIds.push(orchItem.id);
      }
      continue;
    }

    // Skip terminal states
    if (orchItem.state === "done" || orchItem.state === "stuck") continue;

    // Post-merge verification
    if ((orchItem.state === "forward-fix-pending" || orchItem.state === "fix-forward-failed") && orchItem.mergeCommitSha) {
      const snap: ItemSnapshot = { id: orchItem.id };
      if (checkCommitCI) {
        const repoRoot = orchItem.resolvedRepoRoot ?? projectRoot;
        try {
          snap.mergeCommitCIStatus = await checkCommitCI(repoRoot, orchItem.mergeCommitSha);
        } catch {
          // Non-fatal
        }
      }
      items.push(snap);
      continue;
    }

    const snap: ItemSnapshot = { id: orchItem.id };

    // Check PR status via async gh -- yields to event loop per call
    const repoRoot = orchItem.resolvedRepoRoot ?? projectRoot;
    const statusLine = await checkPr(orchItem.id, repoRoot);
    // Empty string from checkPr means API error -- hold state for this item
    if (!statusLine && prPollStates.has(orchItem.state)) {
      apiErrorCount++;
    }
    if (statusLine) {
      const parts = statusLine.split("\t");
      const prNumStr = parts[1];
      const status = parts[2];
      const mergeableStr = parts[3];
      const eventTimeStr = parts[4];

      if (prNumStr) {
        snap.prNumber = parseInt(prNumStr, 10);
      }

      switch (status) {
        case "merged": {
          const mergedPrTitle = parts[5] ?? "";
          const itemTitle = orchItem.workItem.title;
          const alreadyTracked = orchItem.prNumber != null && snap.prNumber === orchItem.prNumber;
          if (alreadyTracked || !mergedPrTitle || prTitleMatchesWorkItem(mergedPrTitle, itemTitle)) {
            snap.prState = "merged";
          }
          break;
        }
        case "ready":
          snap.ciStatus = "pass";
          snap.prState = "open";
          snap.reviewDecision = "APPROVED";
          snap.isMergeable = true;
          break;
        case "ci-passed":
          snap.ciStatus = "pass";
          snap.prState = "open";
          break;
        case "failing":
          snap.ciStatus = "fail";
          snap.prState = "open";
          break;
        case "pending":
          snap.ciStatus = "pending";
          snap.prState = "open";
          break;
      }

      if (mergeableStr === "MERGEABLE") {
        snap.isMergeable = true;
      } else if (mergeableStr === "CONFLICTING") {
        snap.isMergeable = false;
      }

      if (eventTimeStr) {
        snap.eventTime = eventTimeStr;
      }
    }

    // Review worker health
    if (orchItem.state === "reviewing" && orchItem.reviewWorkspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(
        { ...orchItem, workspaceRef: orchItem.reviewWorkspaceRef } as OrchestratorItem,
        cachedWorkspaces,
      );
      if (orchItem.reviewVerdictPath) {
        try {
          snap.reviewVerdict = readVerdictFile(orchItem.reviewVerdictPath) ?? undefined;
        } catch { /* best-effort */ }
      }
    }

    // Rebaser worker health
    if (orchItem.state === "rebasing" && orchItem.rebaserWorkspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(
        { ...orchItem, workspaceRef: orchItem.rebaserWorkspaceRef } as OrchestratorItem,
        cachedWorkspaces,
      );
    }

    // Forward-fixer worker health
    if (orchItem.state === "fixing-forward" && orchItem.fixForwardWorkspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(
        { ...orchItem, workspaceRef: orchItem.fixForwardWorkspaceRef } as OrchestratorItem,
        cachedWorkspaces,
      );
    }

    // Worker alive and commit freshness
    if (orchItem.state === "launching" || orchItem.state === "implementing" || orchItem.state === "ci-failed") {
      snap.workerAlive = isWorkerAliveWithCache(orchItem, cachedWorkspaces);
      const commitTime = await getLastCommitTime(repoRoot, `ninthwave/${orchItem.id}`);
      snap.lastCommitTime = commitTime;
      orchItem.lastCommitTime = commitTime;
    }

    // Heartbeat
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.lastHeartbeat = readHeartbeat(projectRoot, orchItem.id) ?? null;
      } catch { /* best-effort */ }
    }

    // PR comments
    if (orchItem.prNumber && fetchComments) {
      const commentRelayStates = new Set(["ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing"]);
      if (commentRelayStates.has(orchItem.state)) {
        const since = orchItem.lastCommentCheck || orchItem.lastTransition;
        try {
          const comments = await fetchComments(repoRoot, orchItem.prNumber, since);
          if (comments.length > 0) {
            snap.newComments = comments;
          }
        } catch { /* best-effort */ }
      }
    }

    items.push(snap);
  }

  return { items, readyIds, apiErrorCount: apiErrorCount > 0 ? apiErrorCount : undefined };
}

/**
 * Check if a worker's cmux workspace is still running using a pre-fetched
 * workspace listing. Use this inside snapshot builds where the listing has
 * already been fetched once for all items.
 */
export function isWorkerAliveWithCache(item: OrchestratorItem, workspaceListing: string): boolean {
  if (!item.workspaceRef) return false;
  if (!workspaceListing) return false;
  const escapedRef = item.workspaceRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedId = item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refRe = new RegExp(`\\b${escapedRef}\\b`);
  const idRe = new RegExp(`\\b${escapedId}\\b`);
  return workspaceListing.split("\n").some(
    (line) => refRe.test(line) || idRe.test(line),
  );
}

/** Check if a worker's cmux workspace is still running. Thin wrapper around isWorkerAliveWithCache for callers outside snapshot builds. */
export function isWorkerAlive(item: OrchestratorItem, mux: Multiplexer): boolean {
  return isWorkerAliveWithCache(item, mux.listWorkspaces());
}
