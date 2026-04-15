// Snapshot building: polling GitHub PR status, worker liveness, heartbeats, and commit times.
// Extracted from core/commands/orchestrate.ts for modularity.

import { run, runAsync } from "./shell.ts";
import { type Multiplexer, getMux } from "./mux.ts";
import {
  type Orchestrator,
  type PollSnapshot,
  type ItemSnapshot,
  type OrchestratorItem,
  type OrchestratorItemState,
  TERMINAL_STATES,
} from "./orchestrator.ts";
import { type RequestQueue, type RequestPriority } from "./request-queue.ts";
import { readHeartbeat, readVerdictFile, readFeedbackDoneSignal } from "./daemon.ts";
import { readHeadlessPhase } from "./headless.ts";
import { snapshotInboxState } from "./commands/inbox.ts";
import {
  checkPrStatusDetailed,
  checkPrStatusDetailedAsync,
  type PrStatusPollResult,
} from "./commands/pr-monitor.ts";
import { classifyPrMetadataMatch } from "./work-item-files.ts";
import {
  getDefaultBranch as defaultGetDefaultBranch,
  getDefaultBranchAsync as defaultGetDefaultBranchAsync,
  getMergeCommitSha as defaultGetMergeCommitSha,
  type PrComment,
} from "./gh.ts";
import { detectWorkflowPresence } from "./workflow-detect.ts";
import { resolveRef as defaultResolveRef } from "./git.ts";

function normalizePrStatusResult(result: string | null | PrStatusPollResult): PrStatusPollResult {
  if (typeof result === "string" || result == null) {
    return result ? { statusLine: result } : { statusLine: "", failure: { kind: "unknown", stage: "availability", error: "Unknown GitHub polling failure" } };
  }
  return result;
}

function summarizeApiErrors(byKind: Record<string, number>, firstErrorByKind: Record<string, string> = {}): PollSnapshot["apiErrorSummary"] {
  const entries = Object.entries(byKind)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return undefined;
  const primaryKind = entries[0]![0] as NonNullable<PollSnapshot["apiErrorSummary"]>["primaryKind"];
  return {
    total: entries.reduce((sum, [, count]) => sum + count, 0),
    byKind,
    primaryKind,
    representativeError: firstErrorByKind[primaryKind],
  };
}

function isBlindPrPoll(statusLine: string): boolean {
  if (!statusLine) return true;
  return statusLine.split("\t")[2] === "no-pr";
}

function restoreTrackedPrSnapshot(
  snap: ItemSnapshot,
  orchItem: OrchestratorItem,
  statusLine: string,
): void {
  if (orchItem.prNumber != null && isBlindPrPoll(statusLine)) {
    if (!snap.prNumber) {
      snap.prNumber = orchItem.prNumber;
    }
    if (snap.prNumber === orchItem.prNumber && !snap.prState) {
      // When the item is in "merging" state, don't assume "open" -- the PR
      // may already be merged and the API is just temporarily unavailable.
      // Setting "open" would prevent interceptExternalMerge from firing
      // on the next successful poll.
      if (orchItem.state !== "merging") {
        snap.prState = "open";
      }
    }
  }
}

function dependencySatisfied(depItem: OrchestratorItem | undefined, fixForward: boolean): boolean {
  if (!depItem) return true;
  if (depItem.state === "done") return true;
  if (!fixForward && depItem.state === "merged") return true;
  return false;
}

function isRepairPrCandidate(itemId: string, candidateId: string): boolean {
  return candidateId === `fix-forward-${itemId}` || candidateId === `revert-${itemId}`;
}

function createBaseSnapshot(orchItem: OrchestratorItem): ItemSnapshot {
  return {
    id: orchItem.id,
    ...(orchItem.prNumber != null ? { prNumber: orchItem.prNumber } : {}),
    ...(orchItem.priorPrNumbers?.length ? { priorPrNumbers: [...orchItem.priorPrNumbers] } : {}),
  };
}

function preservePrContext(snap: ItemSnapshot, orchItem: OrchestratorItem): void {
  if (snap.prNumber == null && orchItem.prNumber != null) {
    snap.prNumber = orchItem.prNumber;
  }

  const priorPrNumbers = [...(orchItem.priorPrNumbers ?? [])];
  if (snap.prNumber != null && orchItem.prNumber != null && snap.prNumber !== orchItem.prNumber && !priorPrNumbers.includes(orchItem.prNumber)) {
    priorPrNumbers.push(orchItem.prNumber);
  }

  if (priorPrNumbers.length > 0) {
    snap.priorPrNumbers = priorPrNumbers;
  }
}

function trackedPrPollIds(orchItem: OrchestratorItem): string[] {
  if (orchItem.state === "fixing-forward" || (orchItem.priorPrNumbers?.length ?? 0) > 0) {
    return [`fix-forward-${orchItem.id}`, `revert-${orchItem.id}`];
  }
  return [orchItem.id];
}

function pollTrackedPrStatus(
  orchItem: OrchestratorItem,
  repoRoot: string,
  checkPr: (id: string, projectRoot: string) => string | null | PrStatusPollResult,
): PrStatusPollResult {
  let firstFailure: PrStatusPollResult | undefined;
  let noPrResult: PrStatusPollResult | undefined;

  for (const candidateId of trackedPrPollIds(orchItem)) {
    const result = normalizePrStatusResult(checkPr(candidateId, repoRoot));
    if (!isBlindPrPoll(result.statusLine)) {
      return result;
    }
    if (result.failure && !firstFailure) {
      firstFailure = result;
      continue;
    }
    if (!noPrResult) {
      noPrResult = result;
    }
  }

  return noPrResult ?? firstFailure ?? { statusLine: `${orchItem.id}\t\tno-pr` };
}

async function pollTrackedPrStatusAsync(
  orchItem: OrchestratorItem,
  repoRoot: string,
  checkPr: (id: string, projectRoot: string) => Promise<string | null | PrStatusPollResult>,
): Promise<PrStatusPollResult> {
  let firstFailure: PrStatusPollResult | undefined;
  let noPrResult: PrStatusPollResult | undefined;

  for (const candidateId of trackedPrPollIds(orchItem)) {
    const result = normalizePrStatusResult(await checkPr(candidateId, repoRoot));
    if (!isBlindPrPoll(result.statusLine)) {
      return result;
    }
    if (result.failure && !firstFailure) {
      firstFailure = result;
      continue;
    }
    if (!noPrResult) {
      noPrResult = result;
    }
  }

  return noPrResult ?? firstFailure ?? { statusLine: `${orchItem.id}\t\tno-pr` };
}

function enrichMergedMetadata(
  snap: ItemSnapshot,
  orchItem: OrchestratorItem,
  repoRoot: string,
  getMergeCommitSha: (repoRoot: string, prNumber: number) => string | null = defaultGetMergeCommitSha,
  getDefaultBranch: (repoRoot: string) => string | null = defaultGetDefaultBranch,
): void {
  const shouldEnrich = snap.prState === "merged" || orchItem.state === "merged";
  if (!shouldEnrich) return;

  const prNumber = snap.prNumber ?? orchItem.prNumber;
  if (prNumber != null) {
    snap.prNumber = prNumber;
  }

  if (orchItem.mergeCommitSha) {
    snap.mergeCommitSha = orchItem.mergeCommitSha;
  } else if (prNumber != null) {
    try {
      const mergeCommitSha = getMergeCommitSha(repoRoot, prNumber);
      if (mergeCommitSha) {
        orchItem.mergeCommitSha = mergeCommitSha;
        snap.mergeCommitSha = mergeCommitSha;
      }
    } catch {
      // Non-fatal -- merged metadata is best-effort and retried next cycle.
    }
  }

  if (orchItem.defaultBranch) {
    snap.defaultBranch = orchItem.defaultBranch;
  } else {
    try {
      const defaultBranch = getDefaultBranch(repoRoot);
      if (defaultBranch) {
        orchItem.defaultBranch = defaultBranch;
        snap.defaultBranch = defaultBranch;
      }
    } catch {
      // Non-fatal -- merged metadata is best-effort and retried next cycle.
    }
  }
}

function enrichMergedCommitCiStatus(
  snap: ItemSnapshot,
  orchItem: OrchestratorItem,
  repoRoot: string,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending",
): void {
  if (!checkCommitCI) return;
  const shouldCheck = orchItem.state === "merged" || snap.prState === "merged";
  if (!shouldCheck || !orchItem.mergeCommitSha) return;

  try {
    snap.mergeCommitCIStatus = checkCommitCI(repoRoot, orchItem.mergeCommitSha);
  } catch {
    // Non-fatal -- will retry on later polls.
  }
}

async function enrichMergedMetadataAsync(
  snap: ItemSnapshot,
  orchItem: OrchestratorItem,
  repoRoot: string,
  getMergeCommitSha: (repoRoot: string, prNumber: number) => string | null | Promise<string | null> = defaultGetMergeCommitSha,
  getDefaultBranch: (repoRoot: string) => string | null | Promise<string | null> = defaultGetDefaultBranchAsync,
): Promise<void> {
  const shouldEnrich = snap.prState === "merged" || orchItem.state === "merged";
  if (!shouldEnrich) return;

  const prNumber = snap.prNumber ?? orchItem.prNumber;
  if (prNumber != null) {
    snap.prNumber = prNumber;
  }

  if (orchItem.mergeCommitSha) {
    snap.mergeCommitSha = orchItem.mergeCommitSha;
  } else if (prNumber != null) {
    try {
      const mergeCommitSha = await getMergeCommitSha(repoRoot, prNumber);
      if (mergeCommitSha) {
        orchItem.mergeCommitSha = mergeCommitSha;
        snap.mergeCommitSha = mergeCommitSha;
      }
    } catch {
      // Non-fatal -- merged metadata is best-effort and retried next cycle.
    }
  }

  if (orchItem.defaultBranch) {
    snap.defaultBranch = orchItem.defaultBranch;
  } else {
    try {
      const defaultBranch = await getDefaultBranch(repoRoot);
      if (defaultBranch) {
        orchItem.defaultBranch = defaultBranch;
        snap.defaultBranch = defaultBranch;
      }
    } catch {
      // Non-fatal -- merged metadata is best-effort and retried next cycle.
    }
  }
}

async function enrichMergedCommitCiStatusAsync(
  snap: ItemSnapshot,
  orchItem: OrchestratorItem,
  repoRoot: string,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending" | Promise<"pass" | "fail" | "pending">,
): Promise<void> {
  if (!checkCommitCI) return;
  const shouldCheck = orchItem.state === "merged" || snap.prState === "merged";
  if (!shouldCheck || !orchItem.mergeCommitSha) return;

  try {
    snap.mergeCommitCIStatus = await checkCommitCI(repoRoot, orchItem.mergeCommitSha);
  } catch {
    // Non-fatal -- will retry on later polls.
  }
}

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

// ── Polling priority ──────────────────────────────────────────────

/**
 * Map orchestrator item state to a request queue priority for polling.
 * Items closer to merge get higher priority to minimize cycle time.
 */
export function stateToPollingPriority(state: OrchestratorItemState): RequestPriority {
  switch (state) {
    case "merging":
      return "critical";
    case "ci-failed":
      return "high";
    case "ci-pending":
    case "ci-passed":
    case "review-pending":
    case "reviewing":
    case "rebasing":
    case "forward-fix-pending":
    case "fix-forward-failed":
    case "fixing-forward":
      return "normal";
    case "implementing":
    case "launching":
      return "low";
    default:
      return "normal";
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
  checkPr: (id: string, projectRoot: string) => string | null | PrStatusPollResult = checkPrStatusDetailed,
  fetchComments?: (repoRoot: string, prNumber: number, since: string) => Array<{ body: string; author: string; createdAt: string }>,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending",
  getMergeCommitSha: (repoRoot: string, prNumber: number) => string | null = defaultGetMergeCommitSha,
  getDefaultBranch: (repoRoot: string) => string | null = defaultGetDefaultBranch,
  getHeadSha: (repoRoot: string, ref: string) => string | null = defaultResolveRef,
): PollSnapshot {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "rebasing", "merging"]);
  let apiErrorCount = 0;
  const apiErrorByKind: Record<string, number> = {};
  const firstErrorByKind: Record<string, string> = {};
  /** States that require PR polling -- used to count API errors only for items that actually poll GitHub. */
  const prPollStates = new Set(["implementing", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing", "rebasing", "merging", "launching"]);

  // Cache workspace listing once for all isWorkerAlive checks in this snapshot
  const cachedWorkspaces = mux.listWorkspaces();

  for (const orchItem of orch.getAllItems()) {
    // Compute readyIds for queued items
    if (orchItem.state === "queued") {
      const allDepsMet = orchItem.workItem.dependencies.every((depId) => {
        const depItem = orch.getItem(depId);
        return dependencySatisfied(depItem, orch.config.fixForward);
      });
      if (allDepsMet) {
        readyIds.push(orchItem.id);
      }
      continue;
    }

    // Skip terminal states -- nothing to poll
    if (TERMINAL_STATES.has(orchItem.state)) continue;

    // Post-merge verification: poll CI on the merge commit (no PR polling needed)
    if ((orchItem.state === "forward-fix-pending" || orchItem.state === "fix-forward-failed") && orchItem.mergeCommitSha) {
      const snap: ItemSnapshot = createBaseSnapshot(orchItem);
      if (checkCommitCI) {
        try {
          snap.mergeCommitCIStatus = checkCommitCI(projectRoot, orchItem.mergeCommitSha);
        } catch {
          // Non-fatal -- will retry next cycle
        }
      }
      preservePrContext(snap, orchItem);
      items.push(snap);
      continue;
    }

    const snap: ItemSnapshot = createBaseSnapshot(orchItem);
    const repoRoot = projectRoot;

    const prResult = pollTrackedPrStatus(orchItem, projectRoot, checkPr);
    const statusLine = prResult.statusLine;
    // Only count critical API errors (availability, prList, prView) toward the
    // error backoff. prChecks failures are handled gracefully (treated as zero
    // checks with grace period), so they shouldn't engage the global backoff
    // and block actions for other healthy items.
    if (prResult.failure && prResult.failure.stage !== "prChecks" && prPollStates.has(orchItem.state)) {
      apiErrorCount++;
      apiErrorByKind[prResult.failure.kind] = (apiErrorByKind[prResult.failure.kind] ?? 0) + 1;
      if (!firstErrorByKind[prResult.failure.kind]) {
        firstErrorByKind[prResult.failure.kind] = prResult.failure.error;
      }
    }
    if (statusLine) {
      const parts = statusLine.split("\t");
      const candidateId = parts[0] ?? orchItem.id;
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
          const mergedPrLineageToken = parts[6] ?? "";
          const alreadyTracked = orchItem.prNumber != null && snap.prNumber === orchItem.prNumber;
          const prMatch = classifyPrMetadataMatch(
            { title: mergedPrTitle, lineageToken: mergedPrLineageToken },
            orchItem.workItem,
          );
          if (
            isRepairPrCandidate(orchItem.id, candidateId)
            || alreadyTracked
            || prMatch.matches
          ) {
            snap.prState = "merged";
          }
          // else: title mismatch -- stale merged PR from a previous cycle, ignore it
          break;
        }
        case "open":
          snap.prState = "open";
          break;
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

    // If GitHub is temporarily blind after we've already learned the PR number,
    // keep the item in PR-tracking flow instead of regressing to implementing.
    restoreTrackedPrSnapshot(snap, orchItem, statusLine);
    preservePrContext(snap, orchItem);

    enrichMergedMetadata(snap, orchItem, repoRoot, getMergeCommitSha, getDefaultBranch);
    enrichMergedCommitCiStatus(snap, orchItem, repoRoot, checkCommitCI);

    // Detect workflow presence for merge commit CI grace period decisions
    if (snap.mergeCommitCIStatus === "pending") {
      snap.hasPushWorkflows = detectWorkflowPresence(repoRoot).hasPushWorkflows;
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
      if (orchItem.workspaceRef?.startsWith("headless:")) {
        try {
          snap.headlessPhase = readHeadlessPhase(repoRoot, orchItem.id) ?? null;
        } catch { /* best-effort */ }
      }
    }

    // Track branch HEAD SHA for all states that can reach evaluateMerge or need
    // to record lastReviewedCommitSha. This gates reviews on new commits.
    const headShaStates = new Set(["implementing", "ci-pending", "ci-passed", "ci-failed", "reviewing", "review-pending", "merging"]);
    if (headShaStates.has(orchItem.state)) {
      snap.headSha = getHeadSha(repoRoot, `ninthwave/${orchItem.id}`);
    }

    // Track worker liveness for review-pending items so the orchestrator can
    // detect dead implementer workers and respawn them with review feedback.
    if (orchItem.state === "review-pending" && orchItem.workspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(orchItem, cachedWorkspaces);
    }

    // Read heartbeat file for active items
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.lastHeartbeat = readHeartbeat(projectRoot, orchItem.id) ?? null;
      } catch { /* best-effort -- heartbeat read failure doesn't block polling */ }
    }

    // Read inbox state for active items
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.inboxSnapshot = snapshotInboxState(projectRoot, orchItem.id);
      } catch { /* best-effort -- inbox read failure doesn't block polling */ }
    }

    // Read feedback-done signal for items awaiting feedback response
    if (heartbeatStates.has(orchItem.state)) {
      try {
        const signal = readFeedbackDoneSignal(projectRoot, orchItem.id);
        if (signal) snap.feedbackDoneSignal = true;
      } catch { /* best-effort */ }
    }

    // Fast PR detection: if GitHub didn't find a PR but the heartbeat reports one,
    // trust the heartbeat. The worker writes --pr after gh pr create returns, so
    // the PR definitely exists. GitHub API will confirm on the next cycle.
    if (!snap.prNumber && snap.lastHeartbeat?.prNumber) {
      snap.prNumber = snap.lastHeartbeat.prNumber;
      snap.prState = "open";
    }

    preservePrContext(snap, orchItem);

    // Fetch new trusted PR comments for items with open PRs in active states
    if (orchItem.prNumber && fetchComments) {
      const commentRelayStates = new Set(["ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing", "merging"]);
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

  return {
    items,
    readyIds,
    apiErrorCount: apiErrorCount > 0 ? apiErrorCount : undefined,
    apiErrorSummary: summarizeApiErrors(apiErrorByKind, firstErrorByKind),
  };
}

/**
 * Async variant of buildSnapshot. All subprocess calls (PR status, commit CI,
 * PR comments, commit time) use async variants that yield to the event loop,
 * keeping TUI keyboard input responsive during poll cycles.
 *
 * When a RequestQueue is provided, item polls are dispatched in parallel
 * through the queue with priority ordering (merging > ci-failed > normal > low).
 * Concurrency is capped by the queue's semaphore. Without a queue, items are
 * polled sequentially for backward compatibility.
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
  checkPr: (id: string, projectRoot: string) => Promise<string | null | PrStatusPollResult> = checkPrStatusDetailedAsync,
  fetchComments?: (repoRoot: string, prNumber: number, since: string) => PrComment[] | Promise<PrComment[]>,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending" | Promise<"pass" | "fail" | "pending">,
  getMergeCommitSha: (repoRoot: string, prNumber: number) => string | null | Promise<string | null> = defaultGetMergeCommitSha,
  getDefaultBranch: (repoRoot: string) => string | null | Promise<string | null> = defaultGetDefaultBranchAsync,
  queue?: RequestQueue,
  getHeadSha: (repoRoot: string, ref: string) => string | null | Promise<string | null> = defaultResolveRef,
): Promise<PollSnapshot> {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "rebasing", "merging"]);
  let apiErrorCount = 0;
  const apiErrorByKind: Record<string, number> = {};
  const firstErrorByKind: Record<string, string> = {};
  const prPollStates = new Set(["implementing", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing", "rebasing", "merging", "launching"]);

  // Cache workspace listing once for all isWorkerAlive checks in this snapshot
  const cachedWorkspaces = mux.listWorkspaces();

  // First pass: compute readyIds for queued items, collect active items for polling
  const activeItems: OrchestratorItem[] = [];
  for (const orchItem of orch.getAllItems()) {
    if (orchItem.state === "queued") {
      const allDepsMet = orchItem.workItem.dependencies.every((depId) => {
        const depItem = orch.getItem(depId);
        return dependencySatisfied(depItem, orch.config.fixForward);
      });
      if (allDepsMet) {
        readyIds.push(orchItem.id);
      }
      continue;
    }
    if (TERMINAL_STATES.has(orchItem.state)) continue;
    activeItems.push(orchItem);
  }

  // Per-item async processing closure
  const processItem = async (orchItem: OrchestratorItem): Promise<{
    snap: ItemSnapshot;
    apiErrorIncrement: number;
    errorKind?: string;
    errorMessage?: string;
  }> => {
    // Post-merge verification
    if ((orchItem.state === "forward-fix-pending" || orchItem.state === "fix-forward-failed") && orchItem.mergeCommitSha) {
      const snap: ItemSnapshot = createBaseSnapshot(orchItem);
      if (checkCommitCI) {
        try {
          snap.mergeCommitCIStatus = await checkCommitCI(projectRoot, orchItem.mergeCommitSha);
        } catch {
          // Non-fatal
        }
      }
      preservePrContext(snap, orchItem);
      return { snap, apiErrorIncrement: 0 };
    }

    const snap: ItemSnapshot = createBaseSnapshot(orchItem);
    const repoRoot = projectRoot;
    let apiErrorIncrement = 0;
    let errorKind: string | undefined;
    let errorMessage: string | undefined;

    // Check PR status via async gh -- yields to event loop per call
    const prResult = await pollTrackedPrStatusAsync(orchItem, projectRoot, checkPr);
    const statusLine = prResult.statusLine;
    // Only count critical API errors (availability, prList, prView) toward the
    // error backoff. prChecks failures are handled gracefully (treated as zero
    // checks with grace period), so they shouldn't engage the global backoff
    // and block actions for other healthy items.
    if (prResult.failure && prResult.failure.stage !== "prChecks" && prPollStates.has(orchItem.state)) {
      apiErrorIncrement = 1;
      errorKind = prResult.failure.kind;
      errorMessage = prResult.failure.error;
    }
    if (statusLine) {
      const parts = statusLine.split("\t");
      const candidateId = parts[0] ?? orchItem.id;
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
          const mergedPrLineageToken = parts[6] ?? "";
          const alreadyTracked = orchItem.prNumber != null && snap.prNumber === orchItem.prNumber;
          const prMatch = classifyPrMetadataMatch(
            { title: mergedPrTitle, lineageToken: mergedPrLineageToken },
            orchItem.workItem,
          );
          if (
            isRepairPrCandidate(orchItem.id, candidateId)
            || alreadyTracked
            || prMatch.matches
          ) {
            snap.prState = "merged";
          }
          break;
        }
        case "open":
          snap.prState = "open";
          break;
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

    // If GitHub is temporarily blind after we've already learned the PR number,
    // keep the item in PR-tracking flow instead of regressing to implementing.
    restoreTrackedPrSnapshot(snap, orchItem, statusLine);
    preservePrContext(snap, orchItem);

    await enrichMergedMetadataAsync(snap, orchItem, repoRoot, getMergeCommitSha, getDefaultBranch);
    await enrichMergedCommitCiStatusAsync(snap, orchItem, repoRoot, checkCommitCI);

    // Detect workflow presence for merge commit CI grace period decisions
    if (snap.mergeCommitCIStatus === "pending") {
      snap.hasPushWorkflows = detectWorkflowPresence(repoRoot).hasPushWorkflows;
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
      if (orchItem.workspaceRef?.startsWith("headless:")) {
        try {
          snap.headlessPhase = readHeadlessPhase(repoRoot, orchItem.id) ?? null;
        } catch { /* best-effort */ }
      }
    }

    // Track branch HEAD SHA for review gating (see sync version for rationale)
    const headShaStates = new Set(["implementing", "ci-pending", "ci-passed", "ci-failed", "reviewing", "review-pending", "merging"]);
    if (headShaStates.has(orchItem.state)) {
      snap.headSha = await getHeadSha(repoRoot, `ninthwave/${orchItem.id}`);
    }

    // Track worker liveness for review-pending items (see sync version)
    if (orchItem.state === "review-pending" && orchItem.workspaceRef) {
      snap.workerAlive = isWorkerAliveWithCache(orchItem, cachedWorkspaces);
    }

    // Heartbeat
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.lastHeartbeat = readHeartbeat(projectRoot, orchItem.id) ?? null;
      } catch { /* best-effort */ }
    }

    // Inbox state
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.inboxSnapshot = snapshotInboxState(projectRoot, orchItem.id);
      } catch { /* best-effort */ }
    }

    // Read feedback-done signal for items awaiting feedback response
    if (heartbeatStates.has(orchItem.state)) {
      try {
        const signal = readFeedbackDoneSignal(projectRoot, orchItem.id);
        if (signal) snap.feedbackDoneSignal = true;
      } catch { /* best-effort */ }
    }

    // Fast PR detection: if GitHub didn't find a PR but the heartbeat reports one,
    // trust the heartbeat. The worker writes --pr after gh pr create returns, so
    // the PR definitely exists. GitHub API will confirm on the next cycle.
    if (!snap.prNumber && snap.lastHeartbeat?.prNumber) {
      snap.prNumber = snap.lastHeartbeat.prNumber;
      snap.prState = "open";
    }

    preservePrContext(snap, orchItem);

    // PR comments
    if (orchItem.prNumber && fetchComments) {
      const commentRelayStates = new Set(["ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing", "merging"]);
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

    return { snap, apiErrorIncrement, errorKind, errorMessage };
  };

  // Dispatch: parallel via queue or sequential fallback
  type ItemPollResult = Awaited<ReturnType<typeof processItem>>;
  let results: ItemPollResult[];
  if (queue) {
    results = await Promise.all(
      activeItems.map((orchItem) =>
        queue.enqueue({
          category: "snapshot-poll",
          priority: stateToPollingPriority(orchItem.state),
          itemId: orchItem.id,
          execute: () => processItem(orchItem),
        }),
      ),
    );
  } else {
    results = [];
    for (const orchItem of activeItems) {
      results.push(await processItem(orchItem));
    }
  }

  // Accumulate results
  for (const result of results) {
    items.push(result.snap);
    if (result.apiErrorIncrement) {
      apiErrorCount += result.apiErrorIncrement;
      if (result.errorKind) {
        apiErrorByKind[result.errorKind] = (apiErrorByKind[result.errorKind] ?? 0) + 1;
        if (!firstErrorByKind[result.errorKind]) {
          firstErrorByKind[result.errorKind] = result.errorMessage!;
        }
      }
    }
  }

  return {
    items,
    readyIds,
    apiErrorCount: apiErrorCount > 0 ? apiErrorCount : undefined,
    apiErrorSummary: summarizeApiErrors(apiErrorByKind, firstErrorByKind),
  };
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
  const refRe = new RegExp(`(^|\\s)${escapedRef}($|\\s)`);
  const idRe = new RegExp(`\\b${escapedId}\\b`);
  return workspaceListing.split("\n").some(
    (line) => refRe.test(line) || idRe.test(line),
  );
}

/** Check if a worker's cmux workspace is still running. Thin wrapper around isWorkerAliveWithCache for callers outside snapshot builds. */
export function isWorkerAlive(item: OrchestratorItem, mux: Multiplexer): boolean {
  return isWorkerAliveWithCache(item, mux.listWorkspaces());
}
