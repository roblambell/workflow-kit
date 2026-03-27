// orchestrate command: event loop for parallel TODO processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT/SIGTERM shutdown.
// Supports daemon mode (--daemon) for background operation with state persistence.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { totalmem, freemem, platform } from "os";
import { execSync } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { run } from "../shell.ts";
import {
  Orchestrator,
  calculateMemoryWipLimit,
  statusDisplayForState,
  type Action,
  type MergeStrategy,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
  type OrchestratorItem,
  type OrchestratorItemState,
} from "../orchestrator.ts";
import { parseTodos } from "../parser.ts";
import { resolveRepo, getWorktreeInfo, bootstrapRepo } from "../cross-repo.ts";
import { checkPrStatus, scanExternalPRs } from "./watch.ts";
import { launchSingleItem, launchReviewWorker, detectAiTool, cleanStaleBranchForReuse } from "./start.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { prMerge, prComment, checkPrMergeable, getRepoOwner, applyGithubToken, fetchTrustedPrComments, upsertOrchestratorComment } from "../gh.ts";
import { fetchOrigin, ffMerge, hasChanges, getStagedFiles, gitAdd, gitCommit, gitReset, daemonRebase } from "../git.ts";
import { type Multiplexer, getMux } from "../mux.ts";
import { reconcile } from "./reconcile.ts";
import { die } from "../output.ts";
import { shouldEnterInteractive, runInteractiveFlow } from "../interactive.ts";
import type { TodoItem } from "../types.ts";
import { ID_IN_FILENAME } from "../types.ts";
import { prTitleMatchesTodo } from "../todo-utils.ts";
import { loadConfig } from "../config.ts";
import { preflight } from "../preflight.ts";
import {
  collectRunMetrics,
  writeRunMetrics,
  commitAnalyticsFiles,
  parseCostSummary,
  parseWorkerTelemetry,
  type AnalyticsIO,
  type AnalyticsCommitDeps,
  type CostSummary,
} from "../analytics.ts";
import {
  writePidFile,
  cleanPidFile,
  cleanStateFile,
  isDaemonRunning,
  serializeOrchestratorState,
  writeStateFile,
  readStateFile,
  archiveStateFile,
  readExternalReviews,
  writeExternalReviews,
  readHeartbeat,
  logFilePath,
  stateFilePath,
  userStateDir,
  migrateRuntimeState,
  type DaemonIO,
  type DaemonState,
  type ExternalReviewItem,
} from "../daemon.ts";
import {
  formatStatusTable,
  mapDaemonItemState,
  getTerminalWidth,
  type StatusItem,
  type ViewOptions,
} from "../status-render.ts";

// ── Structured logging ─────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  [key: string]: unknown;
}

export function structuredLog(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

// ── TUI mode helpers ────────────────────────────────────────────────

/**
 * Determine if TUI mode should be active.
 * TUI mode renders a live status table on stdout instead of JSON log lines.
 * Enabled when: stdout is a TTY, not a daemon child process, and --json not set.
 */
export function detectTuiMode(isDaemonChild: boolean, jsonFlag: boolean, isTTY: boolean): boolean {
  return !isDaemonChild && !jsonFlag && isTTY;
}

/**
 * Convert OrchestratorItem[] to StatusItem[] for TUI rendering.
 * Mirrors the logic in daemonStateToStatusItems but works directly from live orchestrator state.
 */
export function orchestratorItemsToStatusItems(items: OrchestratorItem[]): StatusItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.todo.title,
    state: mapDaemonItemState(item.state),
    prNumber: item.prNumber ?? null,
    ageMs: Date.now() - new Date(item.lastTransition).getTime(),
    repoLabel: item.resolvedRepoRoot ? basename(item.resolvedRepoRoot) : "",
    failureReason: item.failureReason,
    dependencies: item.todo.dependencies ?? [],
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    exitCode: item.exitCode,
    stderrTail: item.stderrTail,
  }));
}

/**
 * Render the status table to stdout using ANSI cursor control for flicker-free updates.
 * Uses cursor-home + clear-line + clear-to-end to replace content in-place.
 * Injectable write function for testability.
 */
export function renderTuiFrame(
  items: OrchestratorItem[],
  wipLimit: number | undefined,
  write: (s: string) => void = (s) => process.stdout.write(s),
  viewOptions?: ViewOptions,
): void {
  const statusItems = orchestratorItemsToStatusItems(items);
  const termWidth = getTerminalWidth();
  const content = formatStatusTable(statusItems, termWidth, wipLimit, false, viewOptions);
  write("\x1B[H");
  write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  write("\x1B[J");
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
    // as worker activity — which would cause the heartbeat to immediately declare
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
): PollSnapshot {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "merging", "pr-open"]);

  for (const orchItem of orch.getAllItems()) {
    // Compute readyIds for queued items
    if (orchItem.state === "queued") {
      const allDepsMet = orchItem.todo.dependencies.every((depId) => {
        const depItem = orch.getItem(depId);
        // Dep is met if: not tracked, or in done/merged state
        return !depItem || depItem.state === "done" || depItem.state === "merged";
      });
      if (allDepsMet) {
        readyIds.push(orchItem.id);
      }
      continue;
    }

    // Skip terminal states — nothing to poll
    if (orchItem.state === "done" || orchItem.state === "stuck") continue;

    const snap: ItemSnapshot = { id: orchItem.id };

    // Check PR status via gh — use the item's resolved repo root for cross-repo items
    const repoRoot = orchItem.resolvedRepoRoot ?? projectRoot;
    const statusLine = checkPr(orchItem.id, repoRoot);
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
          // Title collision check: when a TODO ID is reused, the old merged PR
          // still shows up for the same branch name. If the orchestrator already
          // assigned a PR number to this item (during this session), trust it.
          // Otherwise, compare the merged PR's title against the TODO title.
          const mergedPrTitle = parts[5] ?? "";
          const todoTitle = orchItem.todo.title;
          const alreadyTracked = orchItem.prNumber != null && snap.prNumber === orchItem.prNumber;
          if (alreadyTracked || !mergedPrTitle || prTitleMatchesTodo(mergedPrTitle, todoTitle)) {
            snap.prState = "merged";
          }
          // else: title mismatch — stale merged PR from a previous cycle, ignore it
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
        // "no-pr" — leave snap fields unset
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

    // Check review worker health for items in reviewing state
    if (orchItem.state === "reviewing" && orchItem.reviewWorkspaceRef) {
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.reviewWorkspaceRef } as OrchestratorItem,
        mux,
      );
    }

    // Check worker alive and commit freshness for active items
    if (orchItem.state === "launching" || orchItem.state === "implementing" || orchItem.state === "ci-failed") {
      snap.workerAlive = isWorkerAlive(orchItem, mux);
      const commitTime = getLastCommitTime(repoRoot, `todo/${orchItem.id}`);
      snap.lastCommitTime = commitTime;
      orchItem.lastCommitTime = commitTime;
    }

    // Read heartbeat file for active items
    if (heartbeatStates.has(orchItem.state)) {
      try {
        snap.lastHeartbeat = readHeartbeat(projectRoot, orchItem.id) ?? null;
      } catch { /* best-effort — heartbeat read failure doesn't block polling */ }
    }

    // Fetch new trusted PR comments for items with open PRs in active states
    if (orchItem.prNumber && fetchComments) {
      const commentRelayStates = new Set(["pr-open", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing"]);
      if (commentRelayStates.has(orchItem.state)) {
        const since = orchItem.lastCommentCheck || orchItem.lastTransition;
        try {
          const comments = fetchComments(repoRoot, orchItem.prNumber, since);
          if (comments.length > 0) {
            snap.newComments = comments;
          }
        } catch { /* ignore — comment polling is best-effort */ }
      }
    }

    items.push(snap);
  }

  return { items, readyIds };
}

/** Check if a worker's cmux workspace is still running. */
export function isWorkerAlive(item: OrchestratorItem, mux: Multiplexer): boolean {
  if (!item.workspaceRef) return false;
  const workspaces = mux.listWorkspaces();
  if (!workspaces) return false;
  const escapedRef = item.workspaceRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedId = item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refRe = new RegExp(`\\b${escapedRef}\\b`);
  const idRe = new RegExp(`\\b${escapedId}\\b`);
  return workspaces.split("\n").some(
    (line) => refRe.test(line) || idRe.test(line),
  );
}

// ── Sidebar display sync ──────────────────────────────────────────

/**
 * Sync cmux sidebar display for all active workers.
 * Sets status pill (text, icon, color) and progress bar from heartbeat data.
 *
 * Progress bar logic:
 * - implementing/ci-failed: use worker-reported progress/label from heartbeat
 * - ci-pending/ci-passed/merging: progress 1.0 with contextual label
 * - other active states: use heartbeat if available, else no progress update
 */
export function syncWorkerDisplay(
  orch: Orchestrator,
  snapshot: PollSnapshot,
  mux: Multiplexer,
): void {
  const heartbeatMap = new Map<string, ItemSnapshot>();
  for (const snap of snapshot.items) {
    heartbeatMap.set(snap.id, snap);
  }

  const activeStates = new Set<OrchestratorItemState>([
    "launching", "implementing", "pr-open", "ci-pending",
    "ci-passed", "ci-failed", "review-pending", "merging",
  ]);

  for (const item of orch.getAllItems()) {
    // Only sync display for items with a workspace ref and active state
    if (!item.workspaceRef) continue;
    if (!activeStates.has(item.state)) continue;

    const display = statusDisplayForState(item.state, { rebaseRequested: item.rebaseRequested });
    const statusKey = `todo-${item.id}`;

    // Set status pill (best-effort)
    try {
      mux.setStatus(item.workspaceRef, statusKey, display.text, display.icon, display.color);
    } catch { /* best-effort */ }

    // Set progress bar
    const snap = heartbeatMap.get(item.id);
    const heartbeat = snap?.lastHeartbeat;

    try {
      if (item.state === "implementing" || item.state === "launching" || item.state === "ci-failed") {
        // Use worker-reported progress if available
        if (heartbeat) {
          mux.setProgress(item.workspaceRef, Math.round(heartbeat.progress * 100), heartbeat.label);
        }
      } else if (item.state === "ci-pending") {
        mux.setProgress(item.workspaceRef, 100, "CI running");
      } else if (item.state === "ci-passed" || item.state === "review-pending") {
        mux.setProgress(item.workspaceRef, 100, "Awaiting review");
      } else if (item.state === "merging") {
        mux.setProgress(item.workspaceRef, 100, "Merging");
      }
    } catch { /* best-effort */ }
  }
}

// ── Adaptive poll interval ─────────────────────────────────────────

/** Compute poll interval based on current item states. */
export function adaptivePollInterval(orch: Orchestrator): number {
  const items = orch.getAllItems();

  // 5s between batches: items are ready and about to launch
  if (items.some((i) => i.state === "ready")) {
    return 5_000;
  }

  // 10s when workers active: bootstrapping, launching, or implementing
  if (items.some((i) => i.state === "bootstrapping" || i.state === "launching" || i.state === "implementing")) {
    return 10_000;
  }

  // 15s when waiting for CI or reviews — still want fast feedback
  if (items.some((i) => i.state === "ci-pending" || i.state === "ci-passed" || i.state === "ci-failed")) {
    return 15_000;
  }

  // 30s idle fallback
  return 30_000;
}

// ── External PR review processing ─────────────────────────────────

/** Author associations with write access — only review PRs from trusted contributors. */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** Label that causes a PR to be skipped for external review. */
const SKIP_REVIEW_LABEL = "ninthwave: skip-review";

/** Dependencies for processExternalReviews, injectable for testing. */
export interface ExternalReviewDeps {
  scanExternalPRs: (repoRoot: string) => import("./watch.ts").ExternalPR[];
  launchReview: (prNumber: number, repoRoot: string) => { workspaceRef: string } | null;
  cleanReview: (reviewWorkspaceRef: string) => boolean;
  log: (entry: LogEntry) => void;
}

/**
 * Process external (non-ninthwave) PRs for review.
 *
 * 1. Scans for open external PRs
 * 2. Filters: skip drafts, skip labeled PRs, only trusted contributors
 * 3. Detects new PRs and re-reviews (HEAD commit changed)
 * 4. Launches review workers within WIP limit
 * 5. Cleans up reviews for closed/merged PRs
 *
 * Returns the updated external review items list.
 */
export function processExternalReviews(
  repoRoot: string,
  externalReviews: import("../daemon.ts").ExternalReviewItem[],
  reviewWipLimit: number,
  currentReviewWipCount: number,
  deps: ExternalReviewDeps,
): import("../daemon.ts").ExternalReviewItem[] {
  // 1. Scan for external PRs
  const externalPRs = deps.scanExternalPRs(repoRoot);

  // 2. Filter: skip drafts, skip labeled PRs, only trusted contributors
  const eligiblePRs = externalPRs.filter((pr) => {
    if (pr.isDraft) return false;
    if (pr.labels.includes(SKIP_REVIEW_LABEL)) return false;
    if (!TRUSTED_AUTHOR_ASSOCIATIONS.has(pr.authorAssociation)) return false;
    return true;
  });

  // Build lookup of currently-open external PR numbers for cleanup
  const openPrNumbers = new Set(externalPRs.map((pr) => pr.prNumber));
  const eligibleByPr = new Map(eligiblePRs.map((pr) => [pr.prNumber, pr]));

  // 3. Update tracked reviews: detect new PRs and HEAD changes
  const trackedByPr = new Map(externalReviews.map((r) => [r.prNumber, r]));
  const updatedReviews = [...externalReviews];

  for (const pr of eligiblePRs) {
    const existing = trackedByPr.get(pr.prNumber);

    if (existing) {
      // HEAD commit changed on an already-reviewed PR → re-review
      if (
        existing.state === "reviewed" &&
        existing.lastReviewedCommit !== pr.headSha
      ) {
        existing.state = "detected";
        existing.lastTransition = new Date().toISOString();
        deps.log({
          ts: new Date().toISOString(),
          level: "info",
          event: "external_review_head_changed",
          prNumber: pr.prNumber,
          oldCommit: existing.lastReviewedCommit,
          newCommit: pr.headSha,
        });
      }
      continue;
    }

    // New PR — add to tracking
    const newItem: import("../daemon.ts").ExternalReviewItem = {
      prNumber: pr.prNumber,
      headBranch: pr.headBranch,
      author: pr.author,
      state: "detected",
      lastTransition: new Date().toISOString(),
    };
    updatedReviews.push(newItem);
    trackedByPr.set(pr.prNumber, newItem);

    deps.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "external_pr_detected",
      prNumber: pr.prNumber,
      author: pr.author,
      headBranch: pr.headBranch,
    });
  }

  // 4. Launch review workers for detected PRs, respecting shared WIP limit
  const reviewingCount = updatedReviews.filter((r) => r.state === "reviewing").length;
  let availableSlots = reviewWipLimit - currentReviewWipCount - reviewingCount;

  for (const review of updatedReviews) {
    if (review.state !== "detected") continue;
    if (availableSlots <= 0) break;

    const pr = eligibleByPr.get(review.prNumber);
    const result = deps.launchReview(review.prNumber, repoRoot);

    if (result) {
      review.state = "reviewing";
      review.reviewWorkspaceRef = result.workspaceRef;
      review.lastReviewedCommit = pr?.headSha;
      review.lastTransition = new Date().toISOString();
      availableSlots--;

      deps.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "external_review_launched",
        prNumber: review.prNumber,
        workspaceRef: result.workspaceRef,
      });
    }
  }

  // 5. Clean up reviews for closed/merged PRs (no longer in the open PR list)
  for (let i = updatedReviews.length - 1; i >= 0; i--) {
    const review = updatedReviews[i]!;
    if (!openPrNumbers.has(review.prNumber)) {
      // PR was closed or merged — clean up
      if (review.reviewWorkspaceRef) {
        try {
          deps.cleanReview(review.reviewWorkspaceRef);
        } catch {
          // best-effort
        }
      }
      deps.log({
        ts: new Date().toISOString(),
        level: "info",
        event: "external_review_cleaned",
        prNumber: review.prNumber,
        reason: "pr_closed",
      });
      updatedReviews.splice(i, 1);
    }
  }

  return updatedReviews;
}

// ── State reconstruction (crash recovery) ──────────────────────────

/**
 * Reconstruct orchestrator state from existing worktrees and GitHub PRs.
 * Called on startup to resume after a crash or restart.
 *
 * When an item is in "implementing" state (worktree exists, no PR yet),
 * also recovers the workspaceRef from live cmux workspaces. Without this,
 * the first poll cycle sees workerAlive=false and immediately marks the
 * item stuck — even if the worker is actively running.
 */
export function reconstructState(
  orch: Orchestrator,
  projectRoot: string,
  worktreeDir: string,
  mux?: Multiplexer,
  checkPr: (id: string, root: string) => string | null = checkPrStatus,
  daemonState?: DaemonState | null,
): void {
  // Build a lookup map from saved daemon state for restoring persisted counters and review fields
  const savedItems = new Map<string, { ciFailCount: number; retryCount: number; reviewWorkspaceRef?: string; reviewCompleted?: boolean; lastCommentCheck?: string; rebaseRequested?: boolean; ciFailureNotified?: boolean; ciFailureNotifiedAt?: string | null }>();
  if (daemonState?.items) {
    for (const si of daemonState.items) {
      savedItems.set(si.id, {
        ciFailCount: si.ciFailCount,
        retryCount: si.retryCount,
        reviewWorkspaceRef: si.reviewWorkspaceRef,
        reviewCompleted: si.reviewCompleted,
        lastCommentCheck: si.lastCommentCheck,
        rebaseRequested: si.rebaseRequested,
        ciFailureNotified: si.ciFailureNotified,
        ciFailureNotifiedAt: si.ciFailureNotifiedAt,
      });
    }
  }

  // Pre-fetch workspace list once (avoid per-item shell calls)
  const workspaceList = mux ? mux.listWorkspaces() : "";

  // Build cross-repo index path for worktree lookup
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");

  for (const item of orch.getAllItems()) {
    // Restore persisted counters and review fields from daemon state (before any state transitions)
    const saved = savedItems.get(item.id);
    if (saved) {
      item.ciFailCount = saved.ciFailCount;
      item.retryCount = saved.retryCount;
      if (saved.reviewWorkspaceRef) item.reviewWorkspaceRef = saved.reviewWorkspaceRef;
      if (saved.reviewCompleted) item.reviewCompleted = saved.reviewCompleted;
      if (saved.lastCommentCheck) item.lastCommentCheck = saved.lastCommentCheck;
      if (saved.rebaseRequested) item.rebaseRequested = saved.rebaseRequested;
      if (saved.ciFailureNotified) item.ciFailureNotified = saved.ciFailureNotified;
      if (saved.ciFailureNotifiedAt) item.ciFailureNotifiedAt = saved.ciFailureNotifiedAt;
    }

    // Check for worktree: cross-repo index first, then hub-local fallback
    const repoRoot = item.resolvedRepoRoot ?? projectRoot;
    const wtInfo = getWorktreeInfo(item.id, crossRepoIndex, worktreeDir);
    const wtPath = wtInfo?.worktreePath ?? join(worktreeDir, `todo-${item.id}`);
    if (!existsSync(wtPath)) continue;

    // Item has a worktree — check PR status in the correct repo
    const statusLine = checkPr(item.id, repoRoot);
    if (!statusLine) {
      orch.setState(item.id, "implementing");
      recoverWorkspaceRef(orch, item.id, workspaceList);
      continue;
    }

    const parts = statusLine.split("\t");
    const prNumStr = parts[1];
    const status = parts[2];

    // Capture the pre-existing prNumber (from daemon state) BEFORE overwriting it.
    // Used by the merged-case alreadyTracked check below.
    const previousPrNumber = orch.getItem(item.id)?.prNumber;

    if (prNumStr) {
      const orchItem = orch.getItem(item.id)!;
      orchItem.prNumber = parseInt(prNumStr, 10);
    }

    switch (status) {
      case "merged": {
        // Collision detection: verify the merged PR's title matches this TODO's title.
        // If titles don't match, the merged PR belongs to a previous TODO that reused the
        // same ID — treat as no-pr to avoid falsely completing the new item (H-MID-1).
        // BUT: skip the title check if the orchestrator already tracked this PR number
        // (from daemon state) — that means we assigned it during the previous run,
        // so it's definitely ours regardless of how the worker titled it.
        const mergedPrNum = prNumStr ? parseInt(prNumStr, 10) : undefined;
        const alreadyTracked = mergedPrNum != null && previousPrNumber === mergedPrNum;
        if (alreadyTracked) {
          orch.setState(item.id, "merged");
        } else {
          const mergedPrTitle = parts[5] ?? "";
          const todoTitle = orch.getItem(item.id)?.todo.title ?? "";
          if (mergedPrTitle && todoTitle && !prTitleMatchesTodo(mergedPrTitle, todoTitle)) {
            orch.setState(item.id, "implementing");
            recoverWorkspaceRef(orch, item.id, workspaceList);
          } else {
            orch.setState(item.id, "merged");
          }
        }
        break;
      }
      case "ready":
      case "ci-passed":
        orch.setState(item.id, "ci-passed");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "failing":
        orch.setState(item.id, "ci-failed");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "pending":
        orch.setState(item.id, "ci-pending");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "no-pr":
      default:
        orch.setState(item.id, "implementing");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
    }
  }
}

/**
 * Try to recover the workspaceRef for an implementing item by matching
 * its TODO ID in the cmux workspace listing.
 *
 * Workspace names follow the pattern: "workspace:N  ✳ <ID> <title>"
 * so we scan for lines containing the item ID.
 */
function recoverWorkspaceRef(
  orch: Orchestrator,
  itemId: string,
  workspaceList: string,
): void {
  if (!workspaceList) return;

  for (const line of workspaceList.split("\n")) {
    if (!line.includes(itemId)) continue;
    const match = line.match(/workspace:\d+/);
    if (match) {
      const orchItem = orch.getItem(itemId);
      if (orchItem) {
        orchItem.workspaceRef = match[0];
      }
      return;
    }
  }
}

// ── Orphaned worktree cleanup ──────────────────────────────────────

/**
 * Dependencies for cleanOrphanedWorktrees, injectable for testing.
 */
export interface CleanOrphanedDeps {
  /** List todo-* directory names in the worktree dir. */
  getWorktreeIds(worktreeDir: string): string[];
  /** List open todo IDs from todo files on disk. */
  getOpenTodoIds(todosDir: string): string[];
  /** Clean a single worktree by ID. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;
  /** Close a multiplexer workspace by item ID (best-effort). */
  closeWorkspaceForItem?(itemId: string): void;
  /** Structured logger. */
  log(entry: LogEntry): void;
}

/** List todo-* worktree IDs in the worktree directory. */
function listWorktreeIds(worktreeDir: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  try {
    return readdirSync(worktreeDir)
      .filter((e) => e.startsWith("todo-"))
      .map((e) => e.slice(5));
  } catch {
    return [];
  }
}

/** List open todo IDs from todo files on disk. */
function listOpenTodoIds(todosDir: string): string[] {
  if (!existsSync(todosDir)) return [];
  try {
    const entries = readdirSync(todosDir).filter((f) => f.endsWith(".md"));
    const ids: string[] = [];
    for (const entry of entries) {
      const match = entry.match(ID_IN_FILENAME);
      if (match) ids.push(match[1]!);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Clean orphaned todo-* worktrees that have no matching todo file.
 * A worktree `todo-{ID}` is orphaned if no `*--{ID}.md` file exists
 * in the todos directory. Non-todo worktrees are left alone.
 *
 * Returns the list of IDs that were cleaned.
 */
export function cleanOrphanedWorktrees(
  todosDir: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CleanOrphanedDeps,
): string[] {
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  if (worktreeIds.length === 0) return [];

  const openTodoIds = new Set(deps.getOpenTodoIds(todosDir));
  const cleanedIds: string[] = [];

  for (const wtId of worktreeIds) {
    if (!openTodoIds.has(wtId)) {
      // Close workspace before removing worktree to prevent orphaned windows
      if (deps.closeWorkspaceForItem) {
        try { deps.closeWorkspaceForItem(wtId); } catch { /* best-effort */ }
      }
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        cleanedIds.push(wtId);
      }
    }
  }

  if (cleanedIds.length > 0) {
    deps.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "orphaned_worktrees_cleaned",
      cleanedIds,
      count: cleanedIds.length,
    });
  }

  return cleanedIds;
}

// ── Interruptible sleep ────────────────────────────────────────────

/** Sleep that resolves immediately if the abort signal fires. */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ── Memory detection ──────────────────────────────────────────────

/**
 * Get available memory in bytes, accounting for reclaimable file cache.
 *
 * On macOS, os.freemem() only reports truly "free" pages — not inactive
 * pages that the OS can reclaim on demand. This causes the memory-aware
 * WIP limiter to throttle to 1 worker even when the system has plenty of
 * headroom. We parse vm_stat to sum free + inactive pages instead.
 *
 * On other platforms, falls back to os.freemem().
 */
export function getAvailableMemory(): number {
  if (platform() === "darwin") {
    try {
      const vmstat = execSync("vm_stat", { encoding: "utf-8" });
      // vm_stat reports in pages; first line has page size
      const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

      const free = vmstat.match(/Pages free:\s+(\d+)/);
      const inactive = vmstat.match(/Pages inactive:\s+(\d+)/);

      const freePages = free ? parseInt(free[1], 10) : 0;
      const inactivePages = inactive ? parseInt(inactive[1], 10) : 0;

      return (freePages + inactivePages) * pageSize;
    } catch {
      return freemem();
    }
  }
  return freemem();
}

// ── Run-complete and action-execution helpers ─────────────────────

/**
 * Handle post-completion processing: cleanup sweep, logging, analytics.
 * Extracted from orchestrateLoop for readability.
 */
function handleRunComplete(
  allItems: OrchestratorItem[],
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  config: OrchestrateLoopConfig,
  log: (entry: LogEntry) => void,
  runStartTime: string,
  costData: Map<string, CostSummary>,
): void {
  // Final cleanup sweep: close workspaces and remove worktrees for managed items
  const cleanedIds: string[] = [];
  for (const item of allItems) {
    try {
      // Close workspace before worktree cleanup (prevents orphaned workspaces)
      if (item.workspaceRef) {
        deps.actionDeps.closeWorkspace(item.workspaceRef);
      }
      const cleaned = deps.actionDeps.cleanSingleWorktree(
        item.id,
        ctx.worktreeDir,
        ctx.projectRoot,
      );
      if (cleaned) {
        cleanedIds.push(item.id);
      }
    } catch {
      // Non-fatal — best-effort cleanup
    }
  }

  if (cleanedIds.length > 0) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "worktree_cleanup_sweep",
      cleanedIds,
      count: cleanedIds.length,
    });
  }

  const doneCount = allItems.filter((i) => i.state === "done").length;
  const stuckCount = allItems.filter((i) => i.state === "stuck").length;
  const itemSummaries = allItems.map((i) => ({
    id: i.id,
    state: i.state,
    prUrl: i.prNumber && config.repoUrl
      ? `${config.repoUrl}/pull/${i.prNumber}`
      : null,
  }));
  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "orchestrate_complete",
    done: doneCount,
    stuck: stuckCount,
    total: allItems.length,
    items: itemSummaries,
  });

  // Analytics: write structured metrics file
  if (config.analyticsDir && deps.analyticsIO) {
    try {
      const endTime = new Date().toISOString();
      const metrics = collectRunMetrics(
        allItems,
        orch.config,
        runStartTime,
        endTime,
        config.aiTool ?? "unknown",
        costData.size > 0 ? costData : undefined,
      );
      const metricsPath = writeRunMetrics(metrics, config.analyticsDir, deps.analyticsIO);
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "analytics_written",
        path: metricsPath,
      });
    } catch (e: unknown) {
      // Non-fatal — analytics failure shouldn't block the orchestrator
      const msg = e instanceof Error ? e.message : String(e);
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "analytics_error",
        error: msg,
      });
    }
  }

  // Analytics: auto-commit analytics files to current branch
  if (config.analyticsDir && deps.analyticsCommit) {
    try {
      const analyticsRelPath = ".ninthwave/analytics";
      const result = commitAnalyticsFiles(
        ctx.projectRoot,
        analyticsRelPath,
        deps.analyticsCommit,
      );
      if (result.committed) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "analytics_committed",
        });
      } else {
        log({
          ts: new Date().toISOString(),
          level: "debug",
          event: "analytics_commit_skipped",
          reason: result.reason,
        });
      }
    } catch (e: unknown) {
      // Non-fatal — commit failure shouldn't block the orchestrator
      const msg = e instanceof Error ? e.message : String(e);
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "analytics_commit_error",
        error: msg,
      });
    }
  }
}

/**
 * Execute a single orchestrator action with logging, cost capture, and reconcile.
 * Extracted from orchestrateLoop for readability.
 */
function handleActionExecution(
  action: Action,
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  log: (entry: LogEntry) => void,
  costData: Map<string, CostSummary>,
): void {
  // Before clean/retry action: capture worker screen for cost/token parsing and telemetry
  if ((action.type === "clean" || action.type === "retry") && deps.readScreen) {
    const orchItem = orch.getItem(action.itemId);
    if (orchItem?.workspaceRef) {
      try {
        const screenText = deps.readScreen(orchItem.workspaceRef, 50);
        const cost = parseCostSummary(screenText);
        if (cost.tokensUsed != null || cost.costUsd != null) {
          costData.set(action.itemId, cost);
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "cost_captured",
            itemId: action.itemId,
            tokensUsed: cost.tokensUsed,
            costUsd: cost.costUsd,
          });
        }
        // Capture worker telemetry (exit code, stderr tail) for diagnostics
        const telemetry = parseWorkerTelemetry(screenText);
        if (telemetry.exitCode != null) {
          orchItem.exitCode = telemetry.exitCode;
        }
        if (telemetry.stderrTail && (orchItem.state === "stuck" || orchItem.state === "ci-failed")) {
          orchItem.stderrTail = telemetry.stderrTail;
        }
        if (telemetry.exitCode != null || telemetry.stderrTail) {
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "telemetry_captured",
            itemId: action.itemId,
            exitCode: telemetry.exitCode,
            stderrLines: telemetry.stderrTail ? telemetry.stderrTail.split("\n").length : 0,
          });
        }
      } catch {
        // Non-fatal — cost/telemetry capture failure doesn't block cleanup
      }
    }
  }

  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "action_execute",
    action: action.type,
    itemId: action.itemId,
    prNumber: action.prNumber,
    ...(action.type === "launch" && action.baseBranch ? { stacked: true, baseBranch: action.baseBranch } : {}),
  });

  const result = orch.executeAction(action, ctx, deps.actionDeps);

  log({
    ts: new Date().toISOString(),
    level: result.success ? "info" : "warn",
    event: "action_result",
    action: action.type,
    itemId: action.itemId,
    success: result.success,
    error: result.error,
  });

  // Bootstrap success: immediately follow up with a launch action
  if (action.type === "bootstrap" && result.success) {
    const orchItem = orch.getItem(action.itemId);
    if (orchItem && orchItem.state === "launching") {
      const launchAction: Action = { type: "launch", itemId: action.itemId };
      if (orchItem.baseBranch) {
        launchAction.baseBranch = orchItem.baseBranch;
      }
      handleActionExecution(launchAction, orch, ctx, deps, log, costData);
    }
  }

  // Structured log for retry events
  if (action.type === "retry" && result.success) {
    const orchItem = orch.getItem(action.itemId);
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "worker_retry",
      itemId: action.itemId,
      retryCount: orchItem?.retryCount ?? 0,
      maxRetries: orch.config.maxRetries,
    });
  }

  // After a successful merge, reconcile todo files with GitHub state
  // so list --ready reflects reality for the rest of the run.
  if (action.type === "merge" && result.success && deps.reconcile) {
    try {
      deps.reconcile(ctx.todosDir, ctx.worktreeDir, ctx.projectRoot);
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "post_merge_reconcile",
        itemId: action.itemId,
      });
    } catch (e: unknown) {
      // Non-fatal — reconcile failure shouldn't block the orchestrator
      const msg = e instanceof Error ? e.message : String(e);
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "post_merge_reconcile_error",
        itemId: action.itemId,
        error: msg,
      });
    }
  }
}

// ── Event loop ─────────────────────────────────────────────────────

/** Dependencies injected into orchestrateLoop for testability. */
export interface OrchestrateLoopDeps {
  buildSnapshot: (orch: Orchestrator, projectRoot: string, worktreeDir: string) => PollSnapshot;
  sleep: (ms: number) => Promise<void>;
  log: (entry: LogEntry) => void;
  actionDeps: OrchestratorDeps;
  /** Get available free memory in bytes. Defaults to os.freemem(). Injectable for testing. */
  getFreeMem?: () => number;
  /** Reconcile todo files with GitHub state after merge actions. */
  reconcile?: (todosDir: string, worktreeDir: string, projectRoot: string) => void;
  /** File I/O for analytics metrics (injectable for testing). When absent, analytics is skipped. */
  analyticsIO?: AnalyticsIO;
  /** Git operations for auto-committing analytics files. When absent, commit is skipped. */
  analyticsCommit?: AnalyticsCommitDeps;
  /** Read screen content from a worker workspace for cost/token parsing. */
  readScreen?: (ref: string, lines?: number) => string;
  /** Called after each poll cycle with current items. Used for daemon state persistence. */
  onPollComplete?: (items: OrchestratorItem[]) => void;
  /** Sync cmux sidebar display for active workers after each poll cycle. */
  syncDisplay?: (orch: Orchestrator, snapshot: PollSnapshot) => void;
  /** Dependencies for external PR review processing. When present and reviewExternal is enabled, external PRs are scanned and reviewed. */
  externalReviewDeps?: ExternalReviewDeps;
  /** Scan for TODO files. Required for watch mode — re-scans the todos directory to discover new items. */
  scanTodos?: () => TodoItem[];
}

export interface OrchestrateLoopConfig {
  /** Override adaptive poll interval (milliseconds). */
  pollIntervalMs?: number;
  /** GitHub repo URL (e.g., "https://github.com/owner/repo") for constructing PR URLs. */
  repoUrl?: string;
  /** Directory to write analytics metrics files. When set, metrics are emitted on run completion. */
  analyticsDir?: string;
  /** AI tool identifier for per-item metrics (e.g., "claude", "cursor"). */
  aiTool?: string;
  /**
   * Max loop iterations before forced exit. Guards against event-loop starvation:
   * when tests use `sleep: () => Promise.resolve()`, a stuck loop monopolizes the
   * microtask queue and macrotask-based safety timers (setTimeout/setInterval) never
   * fire — not even SIGKILL guards. This synchronous check is the only reliable defense.
   * Undefined = no limit (production). Tests should always set a finite cap.
   */
  maxIterations?: number;
  /** When true, scan for non-ninthwave PRs and spawn review workers for them. */
  reviewExternal?: boolean;
  /** When true, daemon stays running after all items reach terminal state, watching for new TODO files. */
  watch?: boolean;
  /** Polling interval (milliseconds) for watch mode. Default: 30000 (30 seconds). */
  watchIntervalMs?: number;
}

/**
 * Main event loop. Polls, detects transitions, executes actions, sleeps.
 * Exits when all items reach terminal state or signal is aborted.
 */
export async function orchestrateLoop(
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  config: OrchestrateLoopConfig = {},
  signal?: AbortSignal,
): Promise<void> {
  const { log } = deps;

  // Initialize external review state from persisted file
  let externalReviews: ExternalReviewItem[] = [];
  if (config.reviewExternal && deps.externalReviewDeps) {
    externalReviews = readExternalReviews(ctx.projectRoot);
    if (externalReviews.length > 0) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "external_reviews_restored",
        count: externalReviews.length,
      });
    }
  }

  const runStartTime = new Date().toISOString();
  const costData = new Map<string, CostSummary>();

  log({
    ts: runStartTime,
    level: "info",
    event: "orchestrate_start",
    items: orch.getAllItems().map((i) => i.id),
    wipLimit: orch.config.wipLimit,
    mergeStrategy: orch.config.mergeStrategy,
  });

  let __iterations = 0;
  let __lastSnapshot: PollSnapshot | undefined;
  let __lastActions: import("../orchestrator.ts").Action[] = [];
  let __lastTransitionIter = 0;
  while (true) {
    __iterations++;
    if (config.maxIterations != null && __iterations > config.maxIterations) {
      const items = orch.getAllItems();
      log({
        ts: new Date().toISOString(),
        level: "error",
        event: "max_iterations_exceeded",
        iterations: __iterations,
        limit: config.maxIterations,
        staleFor: __iterations - __lastTransitionIter,
        itemDetails: items.map((i) => ({
          id: i.id,
          state: i.state,
          lastTransition: i.lastTransition,
          prNumber: i.prNumber,
          ciFailCount: i.ciFailCount,
          retryCount: i.retryCount,
          workspaceRef: i.workspaceRef,
        })),
        lastSnapshot: __lastSnapshot,
        lastActions: __lastActions.map((a) => ({ type: a.type, itemId: a.itemId })),
        rssMB: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
      });
      break;
    }

    if (signal?.aborted) {
      log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "SIGINT" });
      break;
    }

    // Check if all items are in terminal state
    const allItems = orch.getAllItems();
    const allTerminal = allItems.every((i) => i.state === "done" || i.state === "stuck");
    if (allTerminal) {
      handleRunComplete(allItems, orch, ctx, deps, config, log, runStartTime, costData);

      // Watch mode: instead of exiting, poll for new TODO files
      if (config.watch && deps.scanTodos) {
        const watchInterval = config.watchIntervalMs ?? 30_000;
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "watch_mode_waiting",
          message: "All items complete. Watching for new TODOs...",
          watchIntervalMs: watchInterval,
        });

        // Poll for new TODOs until we find some or get aborted
        let foundNew = false;
        while (!foundNew) {
          __iterations++;
          if (config.maxIterations != null && __iterations > config.maxIterations) {
            break;
          }
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return;
          }
          await deps.sleep(watchInterval);
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return;
          }

          // Re-scan for TODO files
          const freshTodos = deps.scanTodos();
          const existingIds = new Set(orch.getAllItems().map((i) => i.id));
          const newTodos = freshTodos.filter((t) => !existingIds.has(t.id));

          if (newTodos.length > 0) {
            for (const todo of newTodos) {
              orch.addItem(todo);
            }
            log({
              ts: new Date().toISOString(),
              level: "info",
              event: "watch_new_items",
              newIds: newTodos.map((t) => t.id),
              count: newTodos.length,
            });
            foundNew = true;
          }
        }
        if (foundNew) {
          // Continue the main loop with newly added items
          continue;
        }
        // maxIterations exceeded in watch loop — fall through to break
        break;
      }

      break;
    }

    // Capture pre-transition states for logging
    const prevStates = new Map<string, OrchestratorItemState>();
    for (const item of allItems) {
      prevStates.set(item.id, item.state);
    }

    // Memory-aware WIP: adjust effective limit based on available free memory
    const freeMemBytes = (deps.getFreeMem ?? freemem)();
    const memoryWip = calculateMemoryWipLimit(orch.config.wipLimit, freeMemBytes);
    orch.setEffectiveWipLimit(memoryWip);

    if (memoryWip < orch.config.wipLimit) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "wip_reduced_memory",
        configuredWip: orch.config.wipLimit,
        effectiveWip: memoryWip,
        freeMemMB: Math.round(freeMemBytes / (1024 * 1024)),
      });
    }

    // Build snapshot from external state
    const snapshot = deps.buildSnapshot(orch, ctx.projectRoot, ctx.worktreeDir);
    __lastSnapshot = snapshot;

    // Process transitions (pure state machine)
    const actions = orch.processTransitions(snapshot);
    __lastActions = actions;

    // Log state transitions
    let __hadTransition = false;
    for (const item of orch.getAllItems()) {
      const prev = prevStates.get(item.id);
      if (prev && prev !== item.state) {
        __hadTransition = true;
        const transitionLog: Record<string, unknown> = {
          ts: new Date().toISOString(),
          level: "info",
          event: "transition",
          itemId: item.id,
          from: prev,
          to: item.state,
          eventTime: item.eventTime,
          detectedTime: item.detectedTime,
          detectionLatencyMs: item.detectionLatencyMs,
        };
        // Log stacking info when an item is promoted from queued → ready with a baseBranch
        if (prev === "queued" && item.state === "ready" && item.baseBranch) {
          transitionLog.stacked = true;
          transitionLog.baseBranch = item.baseBranch;
        }
        log(transitionLog);
      }
    }

    if (__hadTransition) __lastTransitionIter = __iterations;

    // Execute actions
    for (const action of actions) {
      handleActionExecution(action, orch, ctx, deps, log, costData);
    }

    // Sync cmux sidebar display for active workers
    try {
      deps.syncDisplay?.(orch, snapshot);
    } catch { /* best-effort — display sync failure shouldn't block the orchestrator */ }

    // Log state summary
    const states: Record<string, string[]> = {};
    for (const item of orch.getAllItems()) {
      if (!states[item.state]) states[item.state] = [];
      states[item.state]!.push(item.id);
    }
    log({ ts: new Date().toISOString(), level: "debug", event: "state_summary", states });

    // ── External PR review processing ───────────────────────────
    if (config.reviewExternal && deps.externalReviewDeps) {
      try {
        externalReviews = processExternalReviews(
          ctx.projectRoot,
          externalReviews,
          orch.config.reviewWipLimit,
          orch.reviewWipCount,
          deps.externalReviewDeps,
        );
        // Persist external review state
        writeExternalReviews(ctx.projectRoot, externalReviews);
      } catch (e: unknown) {
        // Non-fatal — external review failure shouldn't block TODO processing
        const msg = e instanceof Error ? e.message : String(e);
        log({
          ts: new Date().toISOString(),
          level: "warn",
          event: "external_review_error",
          error: msg,
        });
      }
    }

    // Persist state for daemon mode (or any caller that wants snapshots)
    deps.onPollComplete?.(orch.getAllItems());

    // Sleep — adaptive or fixed override
    const interval = config.pollIntervalMs ?? adaptivePollInterval(orch);
    await deps.sleep(interval);
  }
}

// ── Keyboard shortcuts (TUI mode) ────────────────────────────────────

/**
 * Set up raw-mode stdin to capture individual keystrokes in TUI mode.
 *
 * - `q` triggers graceful shutdown via the AbortController
 * - Ctrl-C (0x03) triggers the same graceful shutdown
 *
 * Returns a cleanup function that restores terminal state.
 * Only call this when tuiMode is true and stdin is a TTY.
 */
export function setupKeyboardShortcuts(
  abortController: AbortController,
  log: (entry: LogEntry) => void,
  stdin: NodeJS.ReadStream = process.stdin,
): () => void {
  if (!stdin.isTTY || !stdin.setRawMode) {
    return () => {};
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const onData = (key: string) => {
    if (key === "q" || key === "\x03") {
      log({ ts: new Date().toISOString(), level: "info", event: "keyboard_quit", key: key === "\x03" ? "ctrl-c" : "q" });
      abortController.abort();
    }
  };

  stdin.on("data", onData);

  return () => {
    stdin.removeListener("data", onData);
    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };
}

// ── Memory-aware WIP default ────────────────────────────────────────

/**
 * Compute a sensible default WIP limit based on available system memory.
 * Each parallel worker consumes ~2-3GB RAM (Claude Code + language server + git worktree),
 * so we allocate one slot per 3GB of total RAM, with a minimum of 2.
 *
 * @param getTotalMemory - Injectable for testing; defaults to os.totalmem()
 */
export function computeDefaultWipLimit(getTotalMemory: () => number = totalmem): number {
  const totalBytes = getTotalMemory();
  const totalGB = totalBytes / (1024 ** 3);
  return Math.max(2, Math.floor(totalGB / 3));
}

// ── CLI command ─────────────────────────────────────────────────────

// ── Daemon fork ─────────────────────────────────────────────────────

/**
 * Fork the orchestrate command into a detached background process.
 * Writes PID file, redirects output to log file, and returns immediately.
 *
 * @param childArgs - args to pass to the child (original args with --daemon replaced by --_daemon-child)
 * @param projectRoot - project root for PID/log file paths
 * @param spawnFn - injectable for testing; defaults to node:child_process spawn
 * @param openFn - injectable for testing; defaults to fs.openSync
 * @param daemonIO - injectable I/O for PID file; defaults to real fs
 */
export function forkDaemon(
  childArgs: string[],
  projectRoot: string,
  spawnFn: typeof nodeSpawn = nodeSpawn,
  openFn: typeof openSync = openSync,
  daemonIO: DaemonIO = { writeFileSync, readFileSync: () => "" as any, unlinkSync: () => {}, existsSync, mkdirSync },
): { pid: number; logPath: string } {
  const stateDir = userStateDir(projectRoot);
  if (!daemonIO.existsSync(stateDir)) {
    daemonIO.mkdirSync(stateDir, { recursive: true });
  }

  const logPath = logFilePath(projectRoot);
  const logFd = openFn(logPath, "a");

  const child = spawnFn(process.argv[0]!, [process.argv[1]!, "orchestrate", ...childArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: projectRoot,
  });
  child.unref();

  const pid = child.pid!;
  writePidFile(projectRoot, pid, daemonIO);

  return { pid, logPath };
}

export async function cmdOrchestrate(
  args: string[],
  todosDir: string,
  worktreeDir: string,
  projectRoot: string,
): Promise<void> {
  let itemIds: string[] = [];
  let mergeStrategy: MergeStrategy = "asap";
  let wipLimitOverride: number | undefined;
  let pollIntervalOverride: number | undefined;
  let frictionDir: string | undefined;
  let daemonMode = false;
  let isDaemonChild = false;
  let clickupListId: string | undefined;
  let remoteFlag = false;
  let reviewEnabled = false;
  let reviewWipLimit: number | undefined;
  let reviewAutoFix: "off" | "direct" | "pr" | undefined;
  let reviewCanApprove = false;
  let reviewExternal = false;
  let watchMode = false;
  let watchIntervalSecs: number | undefined;
  let jsonFlag = false;
  let skipPreflight = false;

  // Parse args
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--items":
        // Support both comma-separated (--items A,B,C) and space-separated (--items A B C)
        i += 1;
        while (i < args.length && !args[i]!.startsWith("--")) {
          itemIds.push(...args[i]!.split(",").filter(Boolean));
          i += 1;
        }
        break;
      case "--merge-strategy":
        mergeStrategy = (args[i + 1] ?? "asap") as MergeStrategy;
        i += 2;
        break;
      case "--wip-limit":
        wipLimitOverride = parseInt(args[i + 1] ?? "4", 10);
        i += 2;
        break;
      case "--poll-interval":
        pollIntervalOverride = parseInt(args[i + 1] ?? "30", 10) * 1000;
        i += 2;
        break;
      case "--orchestrator-ws":
        // Reserved for future use — workspace ref for the orchestrator itself
        i += 2;
        break;
      case "--friction-log":
        frictionDir = args[i + 1];
        i += 2;
        break;
      case "--daemon":
        daemonMode = true;
        i += 1;
        break;
      case "--_daemon-child":
        isDaemonChild = true;
        i += 1;
        break;
      case "--clickup-list":
        clickupListId = args[i + 1];
        i += 2;
        break;
      case "--review":
        reviewEnabled = true;
        i += 1;
        break;
      case "--review-wip-limit":
        reviewWipLimit = parseInt(args[i + 1] ?? "2", 10);
        i += 2;
        break;
      case "--review-auto-fix": {
        const autoFixVal = args[i + 1] ?? "off";
        if (autoFixVal !== "off" && autoFixVal !== "direct" && autoFixVal !== "pr") {
          die(`Invalid --review-auto-fix value: "${autoFixVal}". Must be "off", "direct", or "pr".`);
        }
        reviewAutoFix = autoFixVal;
        i += 2;
        break;
      }
      case "--review-can-approve":
        reviewCanApprove = true;
        i += 1;
        break;
      case "--review-external":
        reviewExternal = true;
        i += 1;
        break;
      case "--watch":
        watchMode = true;
        i += 1;
        break;
      case "--watch-interval":
        watchIntervalSecs = parseInt(args[i + 1] ?? "30", 10);
        i += 2;
        break;
      case "--json":
        jsonFlag = true;
        i += 1;
        break;
      case "--skip-preflight":
        skipPreflight = true;
        i += 1;
        break;
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  // ── Pre-flight environment validation ────────────────────────────────
  if (!skipPreflight) {
    const pf = preflight();
    if (!pf.passed) {
      for (const err of pf.errors) {
        console.error(`Pre-flight failed: ${err}`);
      }
      die("Environment checks failed. Fix the issues above or use --skip-preflight to bypass.");
    }
  }

  // ── Daemon fork: spawn detached child and return immediately ──
  if (daemonMode) {
    // Check if daemon is already running
    const existingPid = isDaemonRunning(projectRoot);
    if (existingPid !== null) {
      die(`Orchestrator daemon is already running (PID ${existingPid}). Use 'ninthwave stop' first.`);
    }

    // Build child args: replace --daemon with --_daemon-child
    const childArgs = args.filter((a) => a !== "--daemon");
    childArgs.push("--_daemon-child");

    const { pid, logPath } = forkDaemon(childArgs, projectRoot);

    console.log(`Orchestrator daemon started (PID ${pid})`);
    console.log(`  Log:   ${logPath}`);
    console.log(`  State: ${stateFilePath(projectRoot)}`);
    console.log(`  Stop:  ninthwave stop`);
    return;
  }

  // ── TUI mode setup ─────────────────────────────────────────────────
  // TUI mode: render live status table to stdout; redirect JSON logs to log file.
  // Enabled when stdout is a TTY and neither --json nor --_daemon-child is set.
  const tuiMode = detectTuiMode(isDaemonChild, jsonFlag, process.stdout.isTTY === true);

  // In TUI mode, redirect structured logs to the log file instead of stdout.
  let log: (entry: LogEntry) => void = structuredLog;
  if (tuiMode) {
    const stateDir = userStateDir(projectRoot);
    mkdirSync(stateDir, { recursive: true });
    const tuiLogPath = logFilePath(projectRoot);
    log = (entry: LogEntry) => {
      appendFileSync(tuiLogPath, JSON.stringify(entry) + "\n");
    };
  }

  // Migrate runtime state from old .ninthwave/ to ~/.ninthwave/projects/<slug>/
  migrateRuntimeState(projectRoot);

  // Prevent duplicate orchestrator instances (foreground or daemon-child)
  const existingPid = isDaemonRunning(projectRoot);
  if (existingPid !== null && existingPid !== process.pid) {
    die(`Another orchestrator is already running (PID ${existingPid}). Use 'ninthwave stop' first, or kill the stale process.`);
  }

  // Compute memory-aware WIP default, allow --wip-limit to override
  const computedWipLimit = computeDefaultWipLimit();
  let wipLimit = wipLimitOverride ?? computedWipLimit;

  // Parse TODO items (needed for both interactive and flag-based modes)
  const allTodos = parseTodos(todosDir, worktreeDir);

  // Interactive mode: no --items and stdin is a TTY
  if (shouldEnterInteractive(itemIds.length > 0)) {
    const result = await runInteractiveFlow(allTodos, wipLimit);
    if (!result) {
      process.exit(0);
    }
    itemIds = result.itemIds;
    mergeStrategy = result.mergeStrategy;
    wipLimit = result.wipLimit;
  }

  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "wip_limit_resolved",
    computedDefault: computedWipLimit,
    effectiveLimit: wipLimit,
    overridden: wipLimitOverride !== undefined,
    totalMemoryGB: Math.round(totalmem() / (1024 ** 3)),
  });

  if (itemIds.length === 0) {
    die(
      "Usage: ninthwave orchestrate --items ID1 ID2 ... [--merge-strategy asap|approved|ask] [--wip-limit N] [--poll-interval SECS] [--daemon] [--watch] [--watch-interval SECS]",
    );
  }

  // Apply custom GitHub token so daemon and workers use the configured identity
  applyGithubToken(projectRoot);

  const todoMap = new Map<string, TodoItem>();
  for (const todo of allTodos) {
    todoMap.set(todo.id, todo);
  }

  // Validate all items exist
  for (const id of itemIds) {
    if (!todoMap.has(id)) {
      die(`Item ${id} not found in todo files`);
    }
  }

  // Create orchestrator
  const orch = new Orchestrator({
    wipLimit,
    mergeStrategy,
    ...(reviewEnabled ? { reviewEnabled } : {}),
    ...(reviewWipLimit !== undefined ? { reviewWipLimit } : {}),
    ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
    ...(reviewCanApprove ? { reviewCanApprove } : {}),
  });
  for (const id of itemIds) {
    orch.addItem(todoMap.get(id)!);
  }

  // Populate resolvedRepoRoot for cross-repo items
  for (const item of orch.getAllItems()) {
    const alias = item.todo.repoAlias;
    if (alias && alias !== "self" && alias !== "hub") {
      try {
        item.resolvedRepoRoot = resolveRepo(alias, projectRoot);
      } catch {
        // Resolution failed — if item has bootstrap: true, the orchestrator will
        // bootstrap the repo before launch (via the bootstrap action). Log the
        // deferred resolution. Non-bootstrap items stay hub-local as fallback.
        if (item.todo.bootstrap) {
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "cross_repo_bootstrap_deferred",
            itemId: item.id,
            alias,
          });
        } else {
          log({
            ts: new Date().toISOString(),
            level: "warn",
            event: "cross_repo_resolve_failed",
            itemId: item.id,
            alias,
          });
        }
      }
    }
  }

  // Real action dependencies — create mux before state reconstruction so
  // workspace refs can be recovered from live workspaces.
  const mux = getMux();

  // Pre-flight: fail fast if the mux backend is not usable (binary missing
  // or no active session). Without this, workers launch and immediately fail
  // with misleading errors, wasting 10+ minutes in retry/stuck cycles.
  if (!mux.isAvailable()) {
    die(mux.diagnoseUnavailable());
  }

  // Clean orphaned worktrees before state reconstruction so stale worktrees
  // from previous runs don't confuse reconstructState or count toward WIP.
  cleanOrphanedWorktrees(todosDir, worktreeDir, projectRoot, {
    getWorktreeIds: listWorktreeIds,
    getOpenTodoIds: listOpenTodoIds,
    cleanWorktree: (id, wtDir, root) => cleanSingleWorktree(id, wtDir, root),
    closeWorkspaceForItem: (itemId) => {
      const list = mux.listWorkspaces();
      if (!list) return;
      for (const line of list.split("\n")) {
        if (!line.includes(itemId)) continue;
        const match = line.match(/workspace:\d+/);
        if (match) mux.closeWorkspace(match[0]);
      }
    },
    log,
  });

  // Reconstruct state from disk + GitHub (crash recovery)
  // Pass saved daemon state so counters (ciFailCount, retryCount) survive restarts
  const savedDaemonState = readStateFile(projectRoot);
  reconstructState(orch, projectRoot, worktreeDir, mux, undefined, savedDaemonState);

  // Detect AI tool
  const aiTool = detectAiTool();

  const ctx: ExecutionContext = { projectRoot, worktreeDir, todosDir, aiTool };
  const actionDeps: OrchestratorDeps = {
    launchSingleItem: (item, todosDir, worktreeDir, projectRoot, aiTool, baseBranch) =>
      launchSingleItem(item, todosDir, worktreeDir, projectRoot, aiTool, mux, { baseBranch }),
    cleanStaleBranch: (todo, projRoot) => {
      let targetRepo: string;
      try {
        targetRepo = resolveRepo(todo.repoAlias, projRoot);
      } catch {
        return; // Can't resolve repo — launchSingleItem will handle the error
      }
      cleanStaleBranchForReuse(todo.id, todo.title, targetRepo);
    },
    cleanSingleWorktree,
    prMerge: (repoRoot, prNumber) => prMerge(repoRoot, prNumber),
    prComment: (repoRoot, prNumber, body) => prComment(repoRoot, prNumber, body),
    upsertOrchestratorComment: (repoRoot, prNumber, itemId, eventLine) =>
      upsertOrchestratorComment(repoRoot, prNumber, itemId, eventLine),
    sendMessage: (ref, msg) => mux.sendMessage(ref, msg),
    closeWorkspace: (ref) => mux.closeWorkspace(ref),
    readScreen: (ref, lines) => mux.readScreen(ref, lines),
    fetchOrigin,
    ffMerge,
    checkPrMergeable,
    daemonRebase,
    warn: (message) =>
      log({ ts: new Date().toISOString(), level: "warn", event: "orchestrator_warning", message }),
    launchReview: (itemId, prNumber, repoRoot) => {
      const autoFix = orch.config.reviewAutoFix;
      const result = launchReviewWorker(prNumber, itemId, autoFix, repoRoot, aiTool, mux);
      if (!result) return null;
      return { workspaceRef: result.workspaceRef };
    },
    bootstrapRepo: (alias, projRoot) => bootstrapRepo(alias, projRoot),
    cleanReview: (itemId, reviewWorkspaceRef) => {
      // Close the review workspace
      try { mux.closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
      // Clean the review worktree if it exists (only for direct/pr modes)
      try {
        cleanSingleWorktree(`review-${itemId}`, join(projectRoot, ".worktrees"), projectRoot);
      } catch { /* best-effort — review worktree may not exist for off mode */ }
      return true;
    },
  };

  // Graceful SIGINT handling
  const abortController = new AbortController();
  const sigintHandler = () => {
    log({ ts: new Date().toISOString(), level: "info", event: "sigint_received" });
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  // Graceful SIGTERM handling (used by daemon mode for clean shutdown)
  const sigtermHandler = () => {
    log({ ts: new Date().toISOString(), level: "info", event: "sigterm_received" });
    abortController.abort();
  };
  process.on("SIGTERM", sigtermHandler);

  // Resolve config-file flags
  const projectConfig = loadConfig(projectRoot);
  const reviewExternalEnabled = reviewExternal || projectConfig["review_external"] === "true";

  // Analytics directory — always enabled, writes to .ninthwave/analytics/
  const analyticsDir = join(projectRoot, ".ninthwave", "analytics");

  // State persistence: serialize state each poll cycle so the status pane can display all items.
  // Written in both daemon and interactive mode — the status pane reads this file to show
  // the full queue including queued items that don't have worktrees yet.
  // statusPaneRef is captured by reference so the closure always persists the current value.
  const daemonStartedAt = new Date().toISOString();

  // Archive stale state from previous run and write a fresh initial state.
  // This ensures `ninthwave status` never shows items from a previous run mixed
  // with the current run — even before the first poll cycle completes.
  const archivePath = archiveStateFile(projectRoot);
  if (archivePath) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "state_archived",
      archivePath,
    });
  }
  const initialState = serializeOrchestratorState(orch.getAllItems(), process.pid, daemonStartedAt, {
    wipLimit,
  });
  writeStateFile(projectRoot, initialState);

  const onPollComplete = (items: OrchestratorItem[]) => {
    try {
      const state = serializeOrchestratorState(items, process.pid, daemonStartedAt, {
        statusPaneRef: null,
        wipLimit,
      });
      writeStateFile(projectRoot, state);
    } catch {
      // Non-fatal — state persistence failure shouldn't block the orchestrator
    }
    // TUI mode: render live status table to stdout after each poll cycle
    if (tuiMode) {
      try {
        renderTuiFrame(items, wipLimit, undefined, { sessionStartedAt: daemonStartedAt });
      } catch {
        // Non-fatal — TUI render failure shouldn't block the orchestrator
      }
    }
  };

  if (isDaemonChild) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon_child_started",
      pid: process.pid,
    });
  }

  // Build external review deps when review_external is enabled
  const externalReviewDeps: ExternalReviewDeps | undefined = reviewExternalEnabled
    ? {
        scanExternalPRs: (root) => scanExternalPRs(root),
        launchReview: (prNumber, repoRoot) => {
          const autoFix = orch.config.reviewAutoFix;
          const extItemId = `ext-${prNumber}`;
          const result = launchReviewWorker(prNumber, extItemId, autoFix, repoRoot, aiTool, mux, {
            reviewType: "external",
          });
          if (!result) return null;
          return { workspaceRef: result.workspaceRef };
        },
        cleanReview: (reviewWorkspaceRef) => {
          try { mux.closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
          return true;
        },
        log,
      }
    : undefined;

  if (reviewExternalEnabled) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "review_external_enabled",
    });
  }

  const loopDeps: OrchestrateLoopDeps = {
    buildSnapshot: (o, pr, wd) => buildSnapshot(o, pr, wd, mux, undefined, undefined, fetchTrustedPrComments),
    sleep: (ms) => interruptibleSleep(ms, abortController.signal),
    log,
    actionDeps,
    getFreeMem: getAvailableMemory,
    reconcile,
    analyticsIO: { mkdirSync, writeFileSync },
    analyticsCommit: { hasChanges, gitAdd, getStagedFiles, gitCommit, gitReset },
    readScreen: (ref, lines) => mux.readScreen(ref, lines),
    onPollComplete,
    syncDisplay: (o, snap) => syncWorkerDisplay(o, snap, mux),
    externalReviewDeps,
    ...(watchMode ? { scanTodos: () => parseTodos(todosDir, worktreeDir) } : {}),
  };

  // Resolve repo URL for PR URL construction in completion event
  let repoUrl: string | undefined;
  try {
    const ownerRepo = getRepoOwner(projectRoot);
    repoUrl = `https://github.com/${ownerRepo}`;
  } catch {
    // Non-fatal — PR URLs will be null in completion event
  }

  const loopConfig: OrchestrateLoopConfig = {
    ...(pollIntervalOverride ? { pollIntervalMs: pollIntervalOverride } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    analyticsDir,
    aiTool,
    ...(reviewExternalEnabled ? { reviewExternal: true } : {}),
    ...(watchMode ? { watch: true } : {}),
    ...(watchIntervalSecs !== undefined ? { watchIntervalMs: watchIntervalSecs * 1000 } : {}),
  };

  // Set up keyboard shortcuts in TUI mode (q and Ctrl-C for graceful shutdown)
  let cleanupKeyboard = () => {};
  if (tuiMode) {
    cleanupKeyboard = setupKeyboardShortcuts(abortController, log);
  }

  // Write PID file for foreground mode too (prevents duplicate instances)
  if (!isDaemonChild) {
    writePidFile(projectRoot, process.pid);
  }

  try {
    await orchestrateLoop(
      orch,
      ctx,
      loopDeps,
      loopConfig,
      abortController.signal,
    );
  } finally {
    // Close workspaces for terminal items only (done, stuck, merged).
    // In-flight workers (implementing, ci-pending, etc.) may still be actively
    // running — leave their workspaces open so they survive orchestrator restarts.
    // On restart, reconstructState recovers their workspace refs.
    const terminalStates = new Set(["done", "stuck", "merged"]);
    const closedWorkspaces: string[] = [];
    for (const item of orch.getAllItems()) {
      if (terminalStates.has(item.state) && item.workspaceRef) {
        try {
          mux.closeWorkspace(item.workspaceRef);
          closedWorkspaces.push(item.id);
        } catch {
          // Non-fatal — best-effort cleanup
        }
      }
    }
    if (closedWorkspaces.length > 0) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "shutdown_workspaces_closed",
        itemIds: closedWorkspaces,
        count: closedWorkspaces.length,
      });
    }

    // Restore terminal state (disable raw mode)
    cleanupKeyboard();

    // Always clean up state file on exit (written in both daemon and interactive mode)
    cleanStateFile(projectRoot);

    // Clean up PID file on exit (both foreground and daemon child)
    cleanPidFile(projectRoot);
    if (isDaemonChild) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon_child_exiting",
        pid: process.pid,
      });
    }

    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }
}
