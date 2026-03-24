// orchestrate command: event loop for parallel TODO processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT/SIGTERM shutdown.
// Supports daemon mode (--daemon) for background operation with state persistence.
// Optionally runs an LLM supervisor tick for anomaly detection and friction logging.

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "fs";
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
import { checkPrStatus } from "./watch.ts";
import { launchSingleItem, detectAiTool } from "./start.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { prMerge, prComment, checkPrMergeable, getRepoOwner } from "../gh.ts";
import { fetchOrigin, ffMerge, hasChanges, getStagedFiles, gitAdd, gitCommit, gitReset, daemonRebase } from "../git.ts";
import { type Multiplexer, getMux } from "../mux.ts";
import { reconcile } from "./reconcile.ts";
import { die } from "../output.ts";
import type { TodoItem, StatusSync } from "../types.ts";
import {
  supervisorTick,
  applySupervisorActions,
  writeFrictionLog,
  shouldActivateSupervisor,
  createSupervisorDeps,
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
  logFilePath,
  stateFilePath,
  type DaemonIO,
  type DaemonState,
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
    const result = run("git", ["log", "-1", "--format=%cI", branchName], {
      cwd: projectRoot,
    });
    if (result.exitCode !== 0 || !result.stdout) return null;
    return result.stdout;
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

    // Check PR status via gh for items past the implementing phase
    const statusLine = checkPr(orchItem.id, projectRoot);
    if (statusLine) {
      const parts = statusLine.split("\t");
      const prNumStr = parts[1];
      const status = parts[2];
      const mergeableStr = parts[3]; // 4th field: MERGEABLE|CONFLICTING|UNKNOWN

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
    }

    // Check worker alive and commit freshness for early-stage items
    if (orchItem.state === "launching" || orchItem.state === "implementing") {
      snap.workerAlive = isWorkerAlive(orchItem, mux);
      const commitTime = getLastCommitTime(projectRoot, `todo/${orchItem.id}`);
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

  // 10s when workers active: launching or implementing
  if (items.some((i) => i.state === "launching" || i.state === "implementing")) {
    return 10_000;
  }

  // 15s when waiting for CI or reviews — still want fast feedback
  if (items.some((i) => i.state === "ci-pending" || i.state === "ci-passed" || i.state === "ci-failed")) {
    return 15_000;
  }

  // 30s idle fallback
  return 30_000;
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
  // Build a lookup map from saved daemon state for restoring persisted counters
  const savedItems = new Map<string, { ciFailCount: number; retryCount: number }>();
  if (daemonState?.items) {
    for (const si of daemonState.items) {
      savedItems.set(si.id, { ciFailCount: si.ciFailCount, retryCount: si.retryCount });
    }
  }

  // Pre-fetch workspace list once (avoid per-item shell calls)
  const workspaceList = mux ? mux.listWorkspaces() : "";

  for (const item of orch.getAllItems()) {
    // Restore persisted counters from daemon state (before any state transitions)
    const saved = savedItems.get(item.id);
    if (saved) {
      item.ciFailCount = saved.ciFailCount;
      item.retryCount = saved.retryCount;
    }

    const wtPath = join(worktreeDir, `todo-${item.id}`);
    if (!existsSync(wtPath)) continue;

    // Item has a worktree — check PR status
    const statusLine = checkPr(item.id, projectRoot);
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
  // Final cleanup sweep: remove any stale worktrees for managed items
  const cleanedIds: string[] = [];
  for (const item of allItems) {
    try {
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

  // After a successful merge, reconcile TODOS.md with GitHub state
  // so list --ready reflects reality for the rest of the run.
  if (action.type === "merge" && result.success && deps.reconcile) {
    try {
      deps.reconcile(ctx.todosFile, ctx.worktreeDir, ctx.projectRoot);
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
  /** Reconcile TODOS.md with GitHub state after merge actions. */
  reconcile?: (todosFile: string, worktreeDir: string, projectRoot: string) => void;
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

  const runStartTime = new Date().toISOString();
  const costData = new Map<string, CostSummary>();

  wrappedLog({
    ts: runStartTime,
    level: "info",
    event: "orchestrate_start",
    items: orch.getAllItems().map((i) => i.id),
    wipLimit: orch.config.wipLimit,
    mergeStrategy: orch.config.mergeStrategy,
    supervisorActive: !!supervisorState,
  });

  while (true) {
    if (signal?.aborted) {
      wrappedLog({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "SIGINT" });
      break;
    }

    // Check if all items are in terminal state
    const allItems = orch.getAllItems();
    const allTerminal = allItems.every((i) => i.state === "done" || i.state === "stuck");
    if (allTerminal) {
      handleRunComplete(allItems, orch, ctx, deps, config, wrappedLog, runStartTime, costData);
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

    // Process transitions (pure state machine)
    const actions = orch.processTransitions(snapshot);

    // Log state transitions and sync status labels with external tracker
    for (const item of orch.getAllItems()) {
      const prev = prevStates.get(item.id);
      if (prev && prev !== item.state) {
        wrappedLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "transition",
          itemId: item.id,
          from: prev,
          to: item.state,
        });

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
    if (supervisorState && config.supervisor && deps.supervisorDeps) {
      const now = deps.supervisorDeps.now();
      const elapsed = now.getTime() - supervisorState.lastTickTime.getTime();

      if (elapsed >= config.supervisor.intervalMs) {
        try {
          const observation = supervisorTick(
            supervisorState,
            orch.getAllItems(),
            deps.supervisorDeps,
          );

          // Apply suggested actions (send messages to workers)
          applySupervisorActions(
            observation,
            orch.getAllItems(),
            deps.actionDeps.sendMessage,
            wrappedLog,
          );

          // Write friction log if configured
          if (config.supervisor.frictionLogPath) {
            writeFrictionLog(
              observation,
              config.supervisor.frictionLogPath,
              deps.supervisorDeps.appendFile,
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
 * Detects cmux via CMUX_WORKSPACE_ID and tmux via TMUX env vars.
 */
export function isInsideWorkspace(env: EnvAccessor = defaultEnv): boolean {
  return !!(env("CMUX_WORKSPACE_ID") || env("TMUX"));
}

/**
 * Launch a dedicated status pane that runs `ninthwave status --watch`.
 *
 * When running inside an existing workspace (detected via CMUX_WORKSPACE_ID
 * or TMUX env vars), opens the status pane as a split in the current
 * workspace. Falls back to creating a new workspace when not inside one.
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
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
): Promise<void> {
  let itemIds: string[] = [];
  let mergeStrategy: MergeStrategy = "asap";
  let wipLimitOverride: number | undefined;
  let pollIntervalOverride: number | undefined;
  let supervisorFlag = false;
  let supervisorIntervalSecs: number | undefined;
  let frictionLogPath: string | undefined;
  let daemonMode = false;
  let isDaemonChild = false;

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
        frictionLogPath = args[i + 1];
        i += 2;
        break;
      case "--mux": {
        const muxValue = args[i + 1];
        if (muxValue !== "cmux" && muxValue !== "tmux") {
          die(`Invalid --mux value: "${muxValue ?? ""}". Must be "cmux" or "tmux".`);
        }
        process.env.NINTHWAVE_MUX = muxValue;
        i += 2;
        break;
      }
      case "--daemon":
        daemonMode = true;
        i += 1;
        break;
      case "--_daemon-child":
        isDaemonChild = true;
        i += 1;
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
  const wipLimit = wipLimitOverride ?? computedWipLimit;

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
      "Usage: ninthwave orchestrate --items ID1 ID2 ... [--merge-strategy asap|approved|ask] [--wip-limit N] [--poll-interval SECS] [--daemon]",
    );
  }

  // Parse TODO items
  const allTodos = parseTodos(todosFile, worktreeDir);
  const todoMap = new Map<string, TodoItem>();
  for (const todo of allTodos) {
    todoMap.set(todo.id, todo);
  }

  // Validate all items exist
  for (const id of itemIds) {
    if (!todoMap.has(id)) {
      die(`Item ${id} not found in TODOS.md`);
    }
  }

  // Create orchestrator
  const orch = new Orchestrator({ wipLimit, mergeStrategy });
  for (const id of itemIds) {
    orch.addItem(todoMap.get(id)!);
  }

  // Real action dependencies — create mux before state reconstruction so
  // workspace refs can be recovered from live workspaces.
  const mux = getMux();

  // Reconstruct state from disk + GitHub (crash recovery)
  // Pass saved daemon state so counters (ciFailCount, retryCount) survive restarts
  const savedDaemonState = readStateFile(projectRoot);
  reconstructState(orch, projectRoot, worktreeDir, mux, undefined, savedDaemonState);

  // Detect AI tool
  const aiTool = detectAiTool();

  const ctx: ExecutionContext = { projectRoot, worktreeDir, todosFile, aiTool };
  const actionDeps: OrchestratorDeps = {
    launchSingleItem: (item, todosFile, worktreeDir, projectRoot, aiTool) =>
      launchSingleItem(item, todosFile, worktreeDir, projectRoot, aiTool, mux),
    cleanSingleWorktree,
    prMerge: (repoRoot, prNumber) => prMerge(repoRoot, prNumber),
    prComment: (repoRoot, prNumber, body) => prComment(repoRoot, prNumber, body),
    sendMessage: (ref, msg) => mux.sendMessage(ref, msg),
    closeWorkspace: (ref) => mux.closeWorkspace(ref),
    fetchOrigin,
    ffMerge,
    checkPrMergeable,
    daemonRebase,
    warn: (message) =>
      structuredLog({ ts: new Date().toISOString(), level: "warn", event: "orchestrator_warning", message }),
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
        frictionLogPath,
        maxLogEntries: DEFAULT_SUPERVISOR_CONFIG.maxLogEntries,
      }
    : undefined;

  if (supervisorActive) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "supervisor_enabled",
      intervalMs: supervisorConfig!.intervalMs,
      frictionLogPath: frictionLogPath ?? null,
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

  // Analytics directory — always enabled, writes to .ninthwave/analytics/
  const analyticsDir = join(projectRoot, ".ninthwave", "analytics");

  // Daemon state persistence: serialize state each poll cycle when running as daemon child
  const daemonStartedAt = new Date().toISOString();
  const onPollComplete = isDaemonChild
    ? (items: OrchestratorItem[]) => {
        try {
          const state = serializeOrchestratorState(items, process.pid, daemonStartedAt);
          writeStateFile(projectRoot, state);
        } catch {
          // Non-fatal — state persistence failure shouldn't block the orchestrator
        }
      }
    : undefined;

  if (isDaemonChild) {
    structuredLog({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon_child_started",
      pid: process.pid,
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
  };

  // Launch status pane if running inside a multiplexer (skip for daemon child — no terminal)
  const statusPaneRef = isDaemonChild ? null : launchStatusPane(mux, projectRoot);
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

    // Clean up daemon files when running as daemon child
    if (isDaemonChild) {
      cleanPidFile(projectRoot);
      cleanStateFile(projectRoot);
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
