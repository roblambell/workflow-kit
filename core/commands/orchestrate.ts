// orchestrate command: event loop for parallel TODO processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT/SIGTERM shutdown.
// Supports daemon mode (--daemon) for background operation with state persistence.
// Optionally runs an LLM supervisor tick for anomaly detection and friction logging.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, appendFileSync } from "fs";
import { join } from "path";
import { totalmem, freemem, platform } from "os";
import { execSync } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { run } from "../shell.ts";
import {
  Orchestrator,
  calculateMemoryWipLimit,
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
import { launchSingleItem, launchReviewWorker, detectAiTool } from "./start.ts";
import { getWorkerHealthStatus, computeScreenHealth, type ScreenHealthStatus } from "../worker-health.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { prMerge, prComment, checkPrMergeable, getRepoOwner, applyGithubToken } from "../gh.ts";
import { fetchOrigin, ffMerge, hasChanges, getStagedFiles, gitAdd, gitCommit, gitReset, daemonRebase } from "../git.ts";
import { type Multiplexer, getMux } from "../mux.ts";
import { reconcile } from "./reconcile.ts";
import { die } from "../output.ts";
import { shouldEnterInteractive, runInteractiveFlow } from "../interactive.ts";
import type { TodoItem, StatusSync } from "../types.ts";
import { ClickUpBackend, resolveClickUpConfig } from "../backends/clickup.ts";
import { loadConfig } from "../config.ts";
import {
  supervisorTick,
  applySupervisorActions,
  writeFrictionLog,
  shouldActivateSupervisor,
  createSupervisorDeps,
  getEffectiveInterval,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorConfig,
  type SupervisorDeps,
  type SupervisorState,
} from "../supervisor.ts";
import {
  resolveWebhookUrl,
  createWebhookNotifier,
  type WebhookNotifyFn,
} from "../webhooks.ts";
import {
  startDashboard,
  stopDashboard,
  type DashboardServer,
} from "../session-server.ts";
import {
  collectRunMetrics,
  writeRunMetrics,
  commitAnalyticsFiles,
  parseCostSummary,
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
  readExternalReviews,
  writeExternalReviews,
  logFilePath,
  stateFilePath,
  type DaemonIO,
  type DaemonState,
  type ExternalReviewItem,
} from "../daemon.ts";

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
): PollSnapshot {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];

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
        case "merged":
          snap.prState = "merged";
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

    // Check worker alive, health, and commit freshness for active items
    if (orchItem.state === "launching" || orchItem.state === "implementing" || orchItem.state === "ci-failed") {
      snap.workerAlive = isWorkerAlive(orchItem, mux);
      // Screen-based health check: read once, derive both workerHealth and screenHealth
      if (orchItem.workspaceRef) {
        try {
          const rawScreen = mux.readScreen(orchItem.workspaceRef, 30);
          snap.workerHealth = getWorkerHealthStatus(rawScreen);
          snap.screenHealth = computeScreenHealth(rawScreen, orchItem);
          // Record screen samples for health-check tuning (best-effort, separate try/catch)
          try {
            if (rawScreen.trim()) {
              const samplesDir = join(projectRoot, ".ninthwave");
              const samplesFile = join(samplesDir, "health-samples.jsonl");
              const sample = JSON.stringify({
                t: new Date().toISOString(),
                id: orchItem.id,
                state: orchItem.state,
                health: snap.workerHealth,
                screenHealth: snap.screenHealth,
                alive: snap.workerAlive,
                lines: rawScreen.split("\n").filter((l: string) => l.trim()).length,
                screen: rawScreen.slice(0, 2000),
              });
              appendFileSync(samplesFile, sample + "\n");
            }
          } catch { /* best-effort — don't break polling */ }
        } catch {
          // readScreen threw — graceful degradation
          snap.screenHealth = "unknown";
        }
      }
      const commitTime = getLastCommitTime(repoRoot, `todo/${orchItem.id}`);
      snap.lastCommitTime = commitTime;
      // Also store on the orchestrator item so the supervisor can read it
      orchItem.lastCommitTime = commitTime;
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
  const savedItems = new Map<string, { ciFailCount: number; retryCount: number; reviewWorkspaceRef?: string; reviewCompleted?: boolean }>();
  if (daemonState?.items) {
    for (const si of daemonState.items) {
      savedItems.set(si.id, {
        ciFailCount: si.ciFailCount,
        retryCount: si.retryCount,
        reviewWorkspaceRef: si.reviewWorkspaceRef,
        reviewCompleted: si.reviewCompleted,
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

    if (prNumStr) {
      const orchItem = orch.getItem(item.id)!;
      orchItem.prNumber = parseInt(prNumStr, 10);
    }

    switch (status) {
      case "merged":
        orch.setState(item.id, "merged");
        break;
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
 * Workspace names follow the pattern: "workspace:N  ✳ TODO <ID>: <title>"
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
      const match = entry.match(/--([A-Z]-[A-Za-z0-9]+-[0-9]+)\.md$/);
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

// ── Status sync helpers ──────────────────────────────────────────────

/**
 * Sync status labels on an external tracker based on orchestrator state transitions.
 * Called after each state change to keep external status in sync.
 *
 * Label mapping:
 * - launching/implementing → "status:in-progress"
 * - pr-open/ci-pending/ci-passed/ci-failed → "status:pr-open"
 * - merged/done → remove all status labels and close issue
 */
export function syncStatusLabels(
  sync: StatusSync,
  itemId: string,
  from: string,
  to: string,
  log?: (entry: LogEntry) => void,
): void {
  switch (to) {
    case "bootstrapping":
    case "launching":
    case "implementing":
      sync.addStatusLabel(itemId, "status:in-progress");
      break;

    case "pr-open":
    case "ci-pending":
    case "ci-passed":
    case "ci-failed":
      sync.removeStatusLabel(itemId, "status:in-progress");
      sync.addStatusLabel(itemId, "status:pr-open");
      break;

    case "merged":
    case "done":
      sync.removeStatusLabel(itemId, "status:in-progress");
      sync.removeStatusLabel(itemId, "status:pr-open");
      // Close the issue on merge (idempotent — already-closed is a no-op)
      if (to === "merged") {
        sync.markDone(itemId);
        log?.({
          ts: new Date().toISOString(),
          level: "info",
          event: "status_sync_close",
          itemId,
        });
      }
      break;
  }
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
 * Handle post-completion processing: cleanup sweep, logging, webhooks, analytics.
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

  // Webhook: orchestrate_complete
  deps.notify?.("orchestrate_complete", {
    items: allItems.map((i) => ({ id: i.id, state: i.state, prNumber: i.prNumber })),
    summary: { done: doneCount, stuck: stuckCount, total: allItems.length },
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
 * Execute a single orchestrator action with logging, cost capture, webhooks, and reconcile.
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
  // Before clean action: capture worker screen for cost/token parsing
  if (action.type === "clean" && deps.readScreen) {
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
      } catch {
        // Non-fatal — cost capture failure doesn't block cleanup
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

  // Webhook: pr_merged on successful merge
  if (action.type === "merge" && result.success) {
    deps.notify?.("pr_merged", {
      itemId: action.itemId,
      prNumber: action.prNumber,
    });
  }

  // Webhook: ci_failed on CI failure notification
  if (action.type === "notify-ci-failure") {
    deps.notify?.("ci_failed", {
      itemId: action.itemId,
      prNumber: action.prNumber,
      error: action.message,
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
  /** Supervisor dependencies (injected when supervisor is active). */
  supervisorDeps?: SupervisorDeps;
  /** Webhook notifier for lifecycle events (fire-and-forget). No-op when absent. */
  notify?: WebhookNotifyFn;
  /** File I/O for analytics metrics (injectable for testing). When absent, analytics is skipped. */
  analyticsIO?: AnalyticsIO;
  /** Git operations for auto-committing analytics files. When absent, commit is skipped. */
  analyticsCommit?: AnalyticsCommitDeps;
  /** Read screen content from a worker workspace for cost/token parsing. */
  readScreen?: (ref: string, lines?: number) => string;
  /** Called after each poll cycle with current items. Used for daemon state persistence. */
  onPollComplete?: (items: OrchestratorItem[]) => void;
  /** Optional status sync backend for synchronizing state with external work-item trackers (e.g., GitHub Issues). */
  statusSync?: StatusSync;
  /** Dependencies for external PR review processing. When present and reviewExternal is enabled, external PRs are scanned and reviewed. */
  externalReviewDeps?: ExternalReviewDeps;
  /** Scan for TODO files. Required for watch mode — re-scans the todos directory to discover new items. */
  scanTodos?: () => TodoItem[];
}

export interface OrchestrateLoopConfig {
  /** Override adaptive poll interval (milliseconds). */
  pollIntervalMs?: number;
  /** Supervisor configuration (present when supervisor is active). */
  supervisor?: SupervisorConfig;
  /** GitHub repo URL (e.g., "https://github.com/owner/repo") for constructing PR URLs. */
  repoUrl?: string;
  /** Directory to write analytics metrics files. When set, metrics are emitted on run completion. */
  analyticsDir?: string;
  /** AI tool identifier for per-item metrics (e.g., "claude", "cursor"). */
  aiTool?: string;
  /** Public dashboard URL (from session URL provider). When set, a PR comment is posted once per run. */
  dashboardPublicUrl?: string;
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
 * Optionally runs LLM supervisor ticks on a configurable interval.
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

  // Initialize supervisor state if supervisor is active
  let supervisorState: SupervisorState | undefined;
  if (config.supervisor && deps.supervisorDeps) {
    supervisorState = {
      lastTickTime: deps.supervisorDeps.now(),
      logsSinceLastTick: [],
      consecutiveFailures: 0,
      disabled: false,
    };
  }

  // Wrap log to capture entries for supervisor
  const wrappedLog = (entry: LogEntry): void => {
    log(entry);
    if (supervisorState) {
      supervisorState.logsSinceLastTick.push(entry);
      // Cap log buffer to prevent unbounded growth
      const maxEntries = config.supervisor?.maxLogEntries ?? DEFAULT_SUPERVISOR_CONFIG.maxLogEntries;
      if (supervisorState.logsSinceLastTick.length > maxEntries) {
        supervisorState.logsSinceLastTick = supervisorState.logsSinceLastTick.slice(-maxEntries);
      }
    }
  };

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
  let dashboardCommentPosted = false;

  wrappedLog({
    ts: runStartTime,
    level: "info",
    event: "orchestrate_start",
    items: orch.getAllItems().map((i) => i.id),
    wipLimit: orch.config.wipLimit,
    mergeStrategy: orch.config.mergeStrategy,
    supervisorActive: !!supervisorState,
  });

  let __iterations = 0;
  let __lastSnapshot: PollSnapshot | undefined;
  let __lastActions: import("../orchestrator.ts").Action[] = [];
  let __lastTransitionIter = 0;
  while (true) {
    __iterations++;
    if (config.maxIterations != null && __iterations > config.maxIterations) {
      const items = orch.getAllItems();
      wrappedLog({
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
      wrappedLog({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "SIGINT" });
      break;
    }

    // Check if all items are in terminal state
    const allItems = orch.getAllItems();
    const allTerminal = allItems.every((i) => i.state === "done" || i.state === "stuck");
    if (allTerminal) {
      handleRunComplete(allItems, orch, ctx, deps, config, wrappedLog, runStartTime, costData);

      // Watch mode: instead of exiting, poll for new TODO files
      if (config.watch && deps.scanTodos) {
        const watchInterval = config.watchIntervalMs ?? 30_000;
        wrappedLog({
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
            wrappedLog({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return;
          }
          await deps.sleep(watchInterval);
          if (signal?.aborted) {
            wrappedLog({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
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
            wrappedLog({
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

    // Capture pre-transition states for logging and batch_complete detection
    const prevStates = new Map<string, OrchestratorItemState>();
    const prevDoneCount = allItems.filter(
      (i) => i.state === "done" || i.state === "stuck",
    ).length;
    for (const item of allItems) {
      prevStates.set(item.id, item.state);
    }

    // Memory-aware WIP: adjust effective limit based on available free memory
    const freeMemBytes = (deps.getFreeMem ?? freemem)();
    const memoryWip = calculateMemoryWipLimit(orch.config.wipLimit, freeMemBytes);
    orch.setEffectiveWipLimit(memoryWip);

    if (memoryWip < orch.config.wipLimit) {
      wrappedLog({
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

    // Log state transitions and sync status labels with external tracker
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
        wrappedLog(transitionLog);

        // Status sync: update external tracker labels on state transitions
        if (deps.statusSync) {
          try {
            syncStatusLabels(deps.statusSync, item.id, prev, item.state, wrappedLog);
          } catch {
            // Non-fatal — status sync failure shouldn't block the orchestrator
          }
        }
      }
    }

    if (__hadTransition) __lastTransitionIter = __iterations;

    // Execute actions
    for (const action of actions) {
      handleActionExecution(action, orch, ctx, deps, wrappedLog, costData);
    }

    // Log state summary
    const states: Record<string, string[]> = {};
    for (const item of orch.getAllItems()) {
      if (!states[item.state]) states[item.state] = [];
      states[item.state]!.push(item.id);
    }
    wrappedLog({ ts: new Date().toISOString(), level: "debug", event: "state_summary", states });

    // Dashboard PR comment: post once per run when a public URL is available
    // and the first PR number is detected on any item.
    if (config.dashboardPublicUrl && !dashboardCommentPosted) {
      const itemWithPr = orch.getAllItems().find((i) => i.prNumber != null);
      if (itemWithPr?.prNumber) {
        try {
          const body = `**[Orchestrator]** Live dashboard: ${config.dashboardPublicUrl}`;
          deps.actionDeps.prComment(ctx.projectRoot, itemWithPr.prNumber, body);
          dashboardCommentPosted = true;
          wrappedLog({
            ts: new Date().toISOString(),
            level: "info",
            event: "dashboard_comment_posted",
            prNumber: itemWithPr.prNumber,
            url: config.dashboardPublicUrl,
          });
        } catch {
          // Non-fatal — dashboard comment failure doesn't block orchestration
          wrappedLog({
            ts: new Date().toISOString(),
            level: "warn",
            event: "dashboard_comment_failed",
            prNumber: itemWithPr.prNumber,
          });
        }
      }
    }

    // Webhook: batch_complete when items finish and non-terminal items remain
    if (deps.notify) {
      const currentItems = orch.getAllItems();
      const currentTerminalCount = currentItems.filter(
        (i) => i.state === "done" || i.state === "stuck",
      ).length;
      const newlyTerminal = currentTerminalCount - prevDoneCount;
      const hasRemaining = currentTerminalCount < currentItems.length;
      if (newlyTerminal > 0 && hasRemaining) {
        const doneNow = currentItems.filter((i) => i.state === "done").length;
        const stuckNow = currentItems.filter((i) => i.state === "stuck").length;
        deps.notify("batch_complete", {
          items: currentItems.map((i) => ({ id: i.id, state: i.state, prNumber: i.prNumber })),
          summary: { done: doneNow, stuck: stuckNow, total: currentItems.length },
        });
      }
    }

    // ── Supervisor tick ──────────────────────────────────────────
    if (supervisorState && !supervisorState.disabled && config.supervisor && deps.supervisorDeps) {
      const now = deps.supervisorDeps.now();
      const elapsed = now.getTime() - supervisorState.lastTickTime.getTime();
      const effectiveInterval = getEffectiveInterval(
        config.supervisor.intervalMs,
        supervisorState.consecutiveFailures,
      );

      if (elapsed >= effectiveInterval) {
        try {
          // Extract screen health from latest snapshot for supervisor context
          const screenHealthByItem = new Map<string, ScreenHealthStatus>();
          if (snapshot) {
            for (const snapItem of snapshot.items) {
              if (snapItem.screenHealth) {
                screenHealthByItem.set(snapItem.id, snapItem.screenHealth);
              }
            }
          }

          const observation = supervisorTick(
            supervisorState,
            orch.getAllItems(),
            deps.supervisorDeps,
            screenHealthByItem.size > 0 ? screenHealthByItem : undefined,
          );

          // Apply suggested actions (send messages to workers)
          applySupervisorActions(
            observation,
            orch.getAllItems(),
            deps.actionDeps.sendMessage,
            wrappedLog,
          );

          // Write friction log if configured
          if (config.supervisor.frictionDir) {
            writeFrictionLog(
              observation,
              config.supervisor.frictionDir,
              deps.supervisorDeps,
            );
          }
        } catch (e: unknown) {
          // Supervisor failure is non-fatal — daemon continues
          const msg = e instanceof Error ? e.message : String(e);
          wrappedLog({
            ts: new Date().toISOString(),
            level: "warn",
            event: "supervisor_error",
            error: msg,
          });
        }
      }
    }

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
        wrappedLog({
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

// ── Status pane management ──────────────────────────────────────────

/** Status pane workspace name used for identification. */
export const STATUS_PANE_NAME = "nw-status";

/** Environment variable accessor — injectable for testing. */
export type EnvAccessor = (key: string) => string | undefined;

const defaultEnv: EnvAccessor = (key) => process.env[key];

/**
 * Check if we're running inside an existing workspace.
 * Detects cmux via CMUX_WORKSPACE_ID, tmux via TMUX, and zellij via
 * ZELLIJ_SESSION_NAME env vars.
 */
export function isInsideWorkspace(env: EnvAccessor = defaultEnv): boolean {
  return !!(env("CMUX_WORKSPACE_ID") || env("TMUX") || env("ZELLIJ_SESSION_NAME"));
}

/**
 * Close a stale status pane from a previous daemon run.
 *
 * Reads the daemon state file to find the `statusPaneRef` from the last run.
 * If present, closes that pane so we don't accumulate duplicates across
 * daemon restarts.
 */
export function closeStaleStatusPane(
  mux: Multiplexer,
  projectRoot: string,
  readState: (projectRoot: string) => DaemonState | null = readStateFile,
): void {
  const oldState = readState(projectRoot);
  if (oldState?.statusPaneRef) {
    try {
      mux.closeWorkspace(oldState.statusPaneRef);
    } catch {
      // Best effort — pane may already be gone
    }
  }
}

/**
 * Launch a dedicated status pane that runs `ninthwave status --watch`.
 *
 * When running inside an existing workspace (detected via CMUX_WORKSPACE_ID,
 * TMUX, or ZELLIJ_SESSION_NAME env vars), opens the status pane as a split
 * in the current workspace. Falls back to creating a new workspace when not
 * inside one.
 *
 * Returns the workspace/pane ref or null if mux is not available.
 */
export function launchStatusPane(
  mux: Multiplexer,
  projectRoot: string,
  env: EnvAccessor = defaultEnv,
): string | null {
  if (!mux.isAvailable()) return null;

  // When inside an existing workspace, split a pane instead of creating a new workspace
  if (isInsideWorkspace(env)) {
    const paneRef = mux.splitPane("ninthwave status --watch");
    if (paneRef) return paneRef;
    // Fall through to launchWorkspace if splitPane fails
  }

  return mux.launchWorkspace(projectRoot, "ninthwave status --watch");
}

/**
 * Close the status pane opened by launchStatusPane.
 */
export function closeStatusPane(
  mux: Multiplexer,
  ref: string | null,
): void {
  if (ref) {
    mux.closeWorkspace(ref);
  }
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
  const ninthwaveDir = join(projectRoot, ".ninthwave");
  if (!daemonIO.existsSync(ninthwaveDir)) {
    daemonIO.mkdirSync(ninthwaveDir, { recursive: true });
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
  let supervisorFlag = false;
  let supervisorIntervalSecs: number | undefined;
  let frictionDir: string | undefined;
  let daemonMode = false;
  let isDaemonChild = false;
  let noSandbox = false;
  let clickupListId: string | undefined;
  let remoteFlag = false;
  let reviewEnabled = false;
  let reviewWipLimit: number | undefined;
  let reviewAutoFix: "off" | "direct" | "pr" | undefined;
  let reviewCanApprove = false;
  let reviewExternal = false;
  let watchMode = false;
  let watchIntervalSecs: number | undefined;

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
      case "--supervisor":
        supervisorFlag = true;
        i += 1;
        break;
      case "--supervisor-interval":
        supervisorIntervalSecs = parseInt(args[i + 1] ?? "300", 10);
        i += 2;
        break;
      case "--friction-log":
        frictionDir = args[i + 1];
        i += 2;
        break;
      case "--mux": {
        const muxValue = args[i + 1];
        if (muxValue !== "cmux" && muxValue !== "zellij" && muxValue !== "tmux") {
          die(`Invalid --mux value: "${muxValue ?? ""}". Must be "cmux", "zellij", or "tmux".`);
        }
        process.env.NINTHWAVE_MUX = muxValue;
        i += 2;
        break;
      }
      case "--no-sandbox":
        noSandbox = true;
        i += 1;
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
      case "--remote":
        remoteFlag = true;
        i += 1;
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
      default:
        die(`Unknown option: ${args[i]}`);
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
    supervisorFlag = result.supervisor;
  }

  structuredLog({
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
          structuredLog({
            ts: new Date().toISOString(),
            level: "info",
            event: "cross_repo_bootstrap_deferred",
            itemId: item.id,
            alias,
          });
        } else {
          structuredLog({
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
    log: structuredLog,
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
      launchSingleItem(item, todosDir, worktreeDir, projectRoot, aiTool, mux, { noSandbox, baseBranch }),
    cleanSingleWorktree,
    prMerge: (repoRoot, prNumber) => prMerge(repoRoot, prNumber),
    prComment: (repoRoot, prNumber, body) => prComment(repoRoot, prNumber, body),
    sendMessage: (ref, msg) => mux.sendMessage(ref, msg),
    closeWorkspace: (ref) => mux.closeWorkspace(ref),
    readScreen: (ref, lines) => mux.readScreen(ref, lines),
    fetchOrigin,
    ffMerge,
    checkPrMergeable,
    daemonRebase,
    warn: (message) =>
      structuredLog({ ts: new Date().toISOString(), level: "warn", event: "orchestrator_warning", message }),
    launchReview: (itemId, prNumber, repoRoot) => {
      const autoFix = orch.config.reviewAutoFix;
      const result = launchReviewWorker(prNumber, itemId, autoFix, repoRoot, aiTool, mux, { noSandbox });
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
    structuredLog({ ts: new Date().toISOString(), level: "info", event: "sigint_received" });
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  // Graceful SIGTERM handling (used by daemon mode for clean shutdown)
  const sigtermHandler = () => {
    structuredLog({ ts: new Date().toISOString(), level: "info", event: "sigterm_received" });
    abortController.abort();
  };
  process.on("SIGTERM", sigtermHandler);

  // Resolve supervisor configuration
  const supervisorActive = shouldActivateSupervisor(supervisorFlag, projectRoot);
  const supervisorConfig: SupervisorConfig | undefined = supervisorActive
    ? {
        intervalMs: supervisorIntervalSecs
          ? supervisorIntervalSecs * 1000
          : DEFAULT_SUPERVISOR_CONFIG.intervalMs,
        frictionDir,
        maxLogEntries: DEFAULT_SUPERVISOR_CONFIG.maxLogEntries,
      }
    : undefined;

  if (supervisorActive) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "supervisor_enabled",
      intervalMs: supervisorConfig!.intervalMs,
      frictionDir: frictionDir ?? null,
      autoActivated: !supervisorFlag,
    });
  }

  // Resolve webhook URL and create notifier (fire-and-forget)
  const webhookUrl = resolveWebhookUrl(projectRoot);
  const notify = createWebhookNotifier(webhookUrl, undefined, (msg) =>
    structuredLog({ ts: new Date().toISOString(), level: "warn", event: "webhook_error", error: msg }),
  );
  if (webhookUrl) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "webhook_configured",
      url: webhookUrl,
    });
  }

  // Resolve config-file flags
  const projectConfig = loadConfig(projectRoot);
  const remoteEnabled = remoteFlag || projectConfig["remote_sessions"] === "true";
  const reviewExternalEnabled = reviewExternal || projectConfig["review_external"] === "true";

  // Start dashboard server when --remote is enabled
  let dashboardServer: DashboardServer | null = null;
  let dashboardPublicUrl: string | null = null;
  let dashboardLocalUrl: string | null = null;

  if (remoteEnabled) {
    try {
      dashboardServer = startDashboard(
        () => orch.getAllItems(),
        (ref, lines) => mux.readScreen(ref, lines),
      );
      dashboardLocalUrl = `http://localhost:${dashboardServer.port}`;
      const tokenPreview = dashboardServer.token.length > 8
        ? `${dashboardServer.token.slice(0, 4)}...${dashboardServer.token.slice(-4)}`
        : dashboardServer.token;

      structuredLog({
        ts: new Date().toISOString(),
        level: "info",
        event: "dashboard_started",
        port: dashboardServer.port,
        localUrl: dashboardLocalUrl,
      });
      console.log(`Dashboard: ${dashboardLocalUrl} (token: ${tokenPreview})`);
    } catch (e: unknown) {
      // Graceful degradation: log warning, continue without dashboard
      const msg = e instanceof Error ? e.message : String(e);
      structuredLog({
        ts: new Date().toISOString(),
        level: "warn",
        event: "dashboard_start_failed",
        error: msg,
      });
    }
  }

  // Analytics directory — always enabled, writes to .ninthwave/analytics/
  const analyticsDir = join(projectRoot, ".ninthwave", "analytics");

  // State persistence: serialize state each poll cycle so the status pane can display all items.
  // Written in both daemon and interactive mode — the status pane reads this file to show
  // the full queue including queued items that don't have worktrees yet.
  // statusPaneRef is captured by reference so the closure always persists the current value.
  const daemonStartedAt = new Date().toISOString();
  let statusPaneRef: string | null = null;
  const onPollComplete = (items: OrchestratorItem[]) => {
    try {
      const state = serializeOrchestratorState(items, process.pid, daemonStartedAt, {
        statusPaneRef,
        wipLimit,
        dashboardUrl: dashboardLocalUrl,
      });
      writeStateFile(projectRoot, state);
    } catch {
      // Non-fatal — state persistence failure shouldn't block the orchestrator
    }
  };

  if (isDaemonChild) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon_child_started",
      pid: process.pid,
    });
  }

  // Resolve ClickUp status sync if configured
  const ckConfig = resolveClickUpConfig(clickupListId, (key) => projectConfig[key]);
  const statusSync: StatusSync | undefined = ckConfig
    ? new ClickUpBackend(ckConfig.listId, ckConfig.apiToken)
    : undefined;

  if (statusSync) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "clickup_sync_enabled",
      listId: ckConfig!.listId,
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
            noSandbox,
            reviewType: "external",
          });
          if (!result) return null;
          return { workspaceRef: result.workspaceRef };
        },
        cleanReview: (reviewWorkspaceRef) => {
          try { mux.closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
          return true;
        },
        log: structuredLog,
      }
    : undefined;

  if (reviewExternalEnabled) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "review_external_enabled",
    });
  }

  const loopDeps: OrchestrateLoopDeps = {
    buildSnapshot: (o, pr, wd) => buildSnapshot(o, pr, wd, mux),
    sleep: (ms) => interruptibleSleep(ms, abortController.signal),
    log: structuredLog,
    actionDeps,
    getFreeMem: getAvailableMemory,
    reconcile,
    supervisorDeps: supervisorActive ? createSupervisorDeps(structuredLog) : undefined,
    notify,
    analyticsIO: { mkdirSync, writeFileSync },
    analyticsCommit: { hasChanges, gitAdd, getStagedFiles, gitCommit, gitReset },
    readScreen: (ref, lines) => mux.readScreen(ref, lines),
    onPollComplete,
    statusSync,
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
    ...(supervisorConfig ? { supervisor: supervisorConfig } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    analyticsDir,
    aiTool,
    ...(dashboardPublicUrl ? { dashboardPublicUrl } : {}),
    ...(reviewExternalEnabled ? { reviewExternal: true } : {}),
    ...(watchMode ? { watch: true } : {}),
    ...(watchIntervalSecs !== undefined ? { watchIntervalMs: watchIntervalSecs * 1000 } : {}),
  };

  // Close stale status pane from a previous daemon run before launching a new one
  if (!isDaemonChild) {
    closeStaleStatusPane(mux, projectRoot);
  }

  // Launch status pane if running inside a multiplexer (skip for daemon child — no terminal)
  statusPaneRef = isDaemonChild ? null : launchStatusPane(mux, projectRoot);
  if (statusPaneRef) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "status_pane_opened",
      ref: statusPaneRef,
      name: STATUS_PANE_NAME,
    });
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
      structuredLog({
        ts: new Date().toISOString(),
        level: "info",
        event: "shutdown_workspaces_closed",
        itemIds: closedWorkspaces,
        count: closedWorkspaces.length,
      });
    }

    // Close status pane on completion (or SIGINT)
    if (statusPaneRef) {
      closeStatusPane(mux, statusPaneRef);
      structuredLog({
        ts: new Date().toISOString(),
        level: "info",
        event: "status_pane_closed",
        ref: statusPaneRef,
      });
    }

    // Stop dashboard server on shutdown
    if (dashboardServer) {
      try {
        stopDashboard(dashboardServer);
        structuredLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "dashboard_stopped",
        });
      } catch {
        // Non-fatal — best-effort cleanup
      }
    }

    // Always clean up state file on exit (written in both daemon and interactive mode)
    cleanStateFile(projectRoot);

    // Clean up daemon-specific files when running as daemon child
    if (isDaemonChild) {
      cleanPidFile(projectRoot);
      structuredLog({
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
