// Orchestrate event loop: poll-transition-execute cycle, worker display sync,
// orphaned worktree cleanup, action execution, and run completion handling.

import { existsSync, readdirSync } from "fs";
import {
  Orchestrator,
  statusDisplayForState,
  TERMINAL_STATES,
  type Action,
  type ExecutionContext,
  type ItemSnapshot,
  type OrchestratorDeps,
  type OrchestratorItem,
  type OrchestratorItemState,
  type PollSnapshot,
} from "./orchestrator.ts";
import type { WorkItem, LogEntry } from "./types.ts";
import { ID_IN_FILENAME, PRIORITY_NUM } from "./types.ts";
import type { CrewBroker, SyncItem, TokenUsage } from "./crew.ts";
import { type Multiplexer, muxTypeForWorkspaceRef } from "./mux.ts";
import { RequestQueue, type RequestQueueStats } from "./request-queue.ts";
import { fetchOrigin, ffMerge } from "./git.ts";
import { reconcile } from "./commands/reconcile.ts";
import { cleanSingleWorktree } from "./commands/clean.ts";
import { collectRunMetrics, parseWorkerTelemetry } from "./analytics.ts";
import { readLatestTokenUsage } from "./token-usage.ts";
import { AuthorCache } from "./git-author.ts";
import {
  createEventLoopLagSampler,
  createInteractiveWatchTiming,
  elapsedMs,
  finalizeInteractiveWatchTiming,
  type InteractiveWatchTiming,
} from "./orchestrate-timing.ts";
import { type CompletionAction } from "./orchestrate-completion.ts";
import {
  filterCrewRemoteWriteActions,
  muxForWorkspaceRef,
} from "./orchestrate-tui-render.ts";
import { ghFailureKindLabel, queryRateLimitAsync as ghQueryRateLimitAsync } from "./gh.ts";

// ── Sidebar display sync ──────────────────────────────────────────

/**
 * Sync cmux sidebar display for all active workers.
 * Sets status pill (text, icon, color) and progress bar from heartbeat data.
 *
 * Ownership split:
 * - Status pill (orchestrator-owned): lifecycle state text/icon/color
 * - Progress bar (worker-primary, orchestrator-fallback):
 *   - Worker-active states (implementing, launching, ci-failed): heartbeat pass-through, default 0%
 *   - Worker-idle states (ci-pending, ci-passed, review-pending, merging): 100%, no label
 */
export function syncWorkerDisplay(
  orch: Orchestrator,
  snapshot: PollSnapshot,
  mux: Multiplexer,
  projectRoot: string,
): void {
  const heartbeatMap = new Map<string, ItemSnapshot>();
  for (const snap of snapshot.items) {
    heartbeatMap.set(snap.id, snap);
  }

  const activeStates = new Set<OrchestratorItemState>([
    "launching", "implementing", "ci-pending",
    "ci-passed", "ci-failed", "review-pending", "merging",
  ]);

  // Worker-active states: heartbeat pass-through, default to 0% when no heartbeat
  const workerActiveStates = new Set<OrchestratorItemState>([
    "implementing", "launching", "ci-failed",
  ]);

  for (const item of orch.getAllItems()) {
    // Only sync display for items with a workspace ref and active state
    if (!item.workspaceRef) continue;
    if (!activeStates.has(item.state)) continue;

    const display = statusDisplayForState(item.state, { rebaseRequested: item.rebaseRequested, reviewRound: item.reviewRound });
    const statusKey = `ninthwave-${item.id}`;
    const workspaceMux = muxTypeForWorkspaceRef(item.workspaceRef) === mux.type
      ? mux
      : muxForWorkspaceRef(item.workspaceRef, projectRoot);

    // Set status pill (best-effort)
    try {
      workspaceMux.setStatus(item.workspaceRef, statusKey, display.text, display.icon, display.color);
    } catch { /* best-effort */ }

    // Set progress bar
    const snap = heartbeatMap.get(item.id);
    const heartbeat = snap?.lastHeartbeat;

    try {
      if (workerActiveStates.has(item.state)) {
        // Worker is active: use heartbeat progress/label, default to 0 with no label
        if (heartbeat) {
          workspaceMux.setProgress(item.workspaceRef, heartbeat.progress, heartbeat.label);
        } else {
          workspaceMux.setProgress(item.workspaceRef, 0);
        }
      } else {
        // Worker is idle: 1.0 (complete), no label -- status pill carries the message
        workspaceMux.setProgress(item.workspaceRef, 1);
      }
    } catch { /* best-effort */ }
  }
}

// ── Adaptive poll interval ─────────────────────────────────────────

/** PR-polling states: items in these states trigger GitHub API calls each cycle. */
const PR_POLL_STATES: ReadonlySet<string> = new Set([
  "implementing", "ci-pending", "ci-passed", "ci-failed",
  "review-pending", "reviewing", "rebasing", "merging", "launching",
]);

/**
 * Adaptive poll interval that scales with the number of active items.
 * With bulk PR fetching, each cycle costs 2 constant API calls (open + merged)
 * regardless of item count -- individual items resolved from the cached result.
 * Interval still scales with active count to pace overall system load and give
 * headroom for action calls (comments, merges, status checks).
 * Floor 2s single-item, 10s multi-item, cap 30s. Override with --poll-interval.
 */
export function adaptivePollInterval(orch: Orchestrator): number {
  const activeCount = orch.getAllItems().filter(i => PR_POLL_STATES.has(i.state)).length;
  if (activeCount <= 1) return 2_000;
  return Math.min(30_000, Math.max(10_000, activeCount * 4_000));
}

/**
 * Action types that make GitHub API calls. Routed through the RequestQueue
 * for proactive token-bucket rate limiting and priority-based concurrency.
 */
export const GH_API_ACTIONS: ReadonlySet<string> = new Set([
  "merge", "set-commit-status", "post-review", "sync-stack-comments",
]);

// ── Orphaned worktree cleanup ──────────────────────────────────────

/**
 * Dependencies for cleanOrphanedWorktrees, injectable for testing.
 */
export interface CleanOrphanedDeps {
  /** List ninthwave-* directory names in the worktree dir. */
  getWorktreeIds(worktreeDir: string): string[];
  /** List open item IDs from work item files on disk. */
  getOpenItemIds(workDir: string): string[];
  /** Clean a single worktree by ID. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;
  /** Close a multiplexer workspace by item ID (best-effort). */
  closeWorkspaceForItem?(itemId: string): void;
  /** Structured logger. */
  log(entry: LogEntry): void;
}

/** List ninthwave-* worktree IDs in the worktree directory. */
export function listWorktreeIds(worktreeDir: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  try {
    return readdirSync(worktreeDir)
      .filter((e) => e.startsWith("ninthwave-"))
      .map((e) => e.slice(10));
  } catch {
    return [];
  }
}

/** List open item IDs from work item files on disk. */
export function listOpenItemIds(workDir: string): string[] {
  if (!existsSync(workDir)) return [];
  try {
    const entries = readdirSync(workDir).filter((f) => f.endsWith(".md"));
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
 * Clean orphaned ninthwave-* worktrees that have no matching work item file.
 * A worktree is orphaned if no `*--{ID}.md` file exists
 * in the work items directory. Non-ninthwave worktrees are left alone.
 *
 * Returns the list of IDs that were cleaned.
 */
export function cleanOrphanedWorktrees(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CleanOrphanedDeps,
): string[] {
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  if (worktreeIds.length === 0) return [];

  const openItemIds = new Set(deps.getOpenItemIds(workDir));
  const cleanedIds: string[] = [];

  for (const wtId of worktreeIds) {
    if (!openItemIds.has(wtId)) {
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

// ── Run-complete and action-execution helpers ─────────────────────

/**
 * Handle post-completion processing: cleanup sweep, logging, analytics.
 * Extracted from orchestrateLoop for readability.
 */
export function handleRunComplete(
  allItems: OrchestratorItem[],
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  config: OrchestrateLoopConfig,
  log: (entry: LogEntry) => void,
  runStartTime: string,
): void {
  // Final cleanup sweep: close workspaces and remove worktrees for managed items.
  // Stuck items preserve their worktree so users can inspect partial work.
  const cleanedIds: string[] = [];
  for (const item of allItems) {
    try {
      // Close workspace before worktree cleanup (prevents orphaned workspaces)
      if (item.workspaceRef) {
        deps.actionDeps.mux.closeWorkspace(item.workspaceRef, item.id);
      }
      // Preserve worktrees for stuck items -- users can inspect partial work
      // and clean manually with `nw clean <ID>` when done.
      if (item.state === "stuck") continue;
      const cleaned = deps.actionDeps.cleanup.cleanSingleWorktree(
        item.id,
        ctx.worktreeDir,
        ctx.projectRoot,
      );
      if (cleaned) {
        cleanedIds.push(item.id);
      }
    } catch {
      // Non-fatal -- best-effort cleanup
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
  const blockedCount = allItems.filter((i) => i.state === "blocked").length;
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
    blocked: blockedCount,
    stuck: stuckCount,
    total: allItems.length,
    items: itemSummaries,
  });

  // Analytics: emit run_metrics as a structured log event (replaces JSON file writing)
  try {
    const endTime = new Date().toISOString();
    const metrics = collectRunMetrics(
      allItems,
      orch.config,
      runStartTime,
      endTime,
      config.aiTool ?? "unknown",
    );
    log({
      ts: endTime,
      level: "info",
      event: "run_metrics",
      ...metrics,
    } as unknown as LogEntry);
  } catch (e: unknown) {
    // Non-fatal -- analytics failure shouldn't block the orchestrator
    const msg = e instanceof Error ? e.message : String(e);
    log({
      ts: new Date().toISOString(),
      level: "warn",
      event: "analytics_error",
      error: msg,
    });
  }
}

// ── Exit summary ────────────────────────────────────────────────────

/**
 * Format the compact end-of-run summary that prints to stdout after TUI exit.
 * Persists in terminal scrollback since it's written after exitAltScreen().
 *
 * Format: "ninthwave: N merged, M stuck, K queued (Xm Ys) | Lead time: p50 Xm, p95 Ym"
 */
// Completion types and functions extracted to core/orchestrate-completion.ts

/**
 * Execute a single orchestrator action with logging, telemetry capture, and reconcile.
 * Extracted from orchestrateLoop for readability.
 */
export function handleActionExecution(
  action: Action,
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  log: (entry: LogEntry) => void,
): void {
  const sessionEndedMetadata = deps.crewBroker
    ? (() => {
      const orchItem = orch.getItem(action.itemId);
      return orchItem ? buildSessionEndedMetadata(orchItem, ctx, action.type) : null;
    })()
    : null;

  // Before clean/retry action: capture worker screen for telemetry
  if ((action.type === "clean" || action.type === "retry" || action.type === "workspace-close") && deps.readScreen) {
    const orchItem = orch.getItem(action.itemId);
    if (orchItem?.workspaceRef) {
      try {
        const screenText = deps.readScreen(orchItem.workspaceRef, 50);
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
        // Non-fatal -- telemetry capture failure doesn't block cleanup
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

  // Report session_started for successful launches
  if (result.success && deps.crewBroker) {
    if (sessionEndedMetadata) {
      deps.crewBroker.report("session_ended", action.itemId, sessionEndedMetadata);
    }

    const launchTelemetry = getLaunchTelemetry(action.type);
    const orchItem = orch.getItem(action.itemId);
    if (launchTelemetry && orchItem) {
      deps.crewBroker.report("session_started", action.itemId, {
        agent: orchItem.aiTool ?? ctx.aiTool ?? "unknown",
        role: launchTelemetry.role,
      });
    }
  }

  // Bootstrap success: immediately follow up with a launch action
  if (action.type === "bootstrap" && result.success) {
    const orchItem = orch.getItem(action.itemId);
    if (orchItem && orchItem.state === "launching") {
      const launchAction: Action = { type: "launch", itemId: action.itemId };
      if (orchItem.baseBranch) {
        launchAction.baseBranch = orchItem.baseBranch;
      }
      handleActionExecution(launchAction, orch, ctx, deps, log);
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

  // After a successful merge, reconcile work item files with GitHub state
  // so list --ready reflects reality for the rest of the run.
  if (action.type === "merge" && result.success && deps.reconcile) {
    try {
      deps.reconcile(ctx.workDir, ctx.worktreeDir, ctx.projectRoot);
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "post_merge_reconcile",
        itemId: action.itemId,
      });
    } catch (e: unknown) {
      // Non-fatal -- reconcile failure shouldn't block the orchestrator
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

export function buildSessionEndedMetadata(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  actionType: Action["type"],
): { agent: string; role: LaunchTelemetryRole; durationMs?: number } | null {
  const telemetry = getSessionEndTelemetry(actionType);
  if (!telemetry) return null;

  const workspaceRef = item[telemetry.workspaceField];
  if (!workspaceRef) return null;

  return {
    agent: item.aiTool ?? ctx.aiTool ?? "unknown",
    role: telemetry.role,
    durationMs: item.startedAt ? Date.now() - new Date(item.startedAt).getTime() : undefined,
  };
}

type LaunchTelemetryRole = "implementer" | "reviewer" | "rebaser" | "verifier";

type LaunchTelemetryConfig = {
  role: LaunchTelemetryRole;
  filename: string;
};

type SessionEndTelemetryConfig = LaunchTelemetryConfig & {
  workspaceField: "workspaceRef" | "reviewWorkspaceRef" | "rebaserWorkspaceRef" | "fixForwardWorkspaceRef";
};

const LAUNCH_TELEMETRY_BY_ACTION: Partial<Record<Action["type"], LaunchTelemetryConfig>> = {
  "launch": { role: "implementer", filename: "implementer.md" },
  "launch-review": { role: "reviewer", filename: "reviewer.md" },
  "launch-rebaser": { role: "rebaser", filename: "rebaser.md" },
  "launch-forward-fixer": { role: "verifier", filename: "forward-fixer.md" },
};

const SESSION_END_TELEMETRY_BY_ACTION: Partial<Record<Action["type"], SessionEndTelemetryConfig>> = {
  "clean": {
    role: "implementer",
    filename: "implementer.md",
    workspaceField: "workspaceRef",
  },
  "retry": {
    role: "implementer",
    filename: "implementer.md",
    workspaceField: "workspaceRef",
  },
  "workspace-close": {
    role: "implementer",
    filename: "implementer.md",
    workspaceField: "workspaceRef",
  },
  "clean-review": {
    role: "reviewer",
    filename: "reviewer.md",
    workspaceField: "reviewWorkspaceRef",
  },
  "clean-rebaser": {
    role: "rebaser",
    filename: "rebaser.md",
    workspaceField: "rebaserWorkspaceRef",
  },
  "clean-forward-fixer": {
    role: "verifier",
    filename: "forward-fixer.md",
    workspaceField: "fixForwardWorkspaceRef",
  },
};

function getLaunchTelemetry(actionType: Action["type"]): LaunchTelemetryConfig | undefined {
  return LAUNCH_TELEMETRY_BY_ACTION[actionType];
}

function getSessionEndTelemetry(actionType: Action["type"]): SessionEndTelemetryConfig | undefined {
  return SESSION_END_TELEMETRY_BY_ACTION[actionType];
}

function buildCompletionReportMetadata(item: OrchestratorItem): Record<string, unknown> {
  return {
    state: item.state,
    ...(item.prNumber ? { prNumber: item.prNumber } : {}),
    ...(item.startedAt ? { durationMs: Date.now() - new Date(item.startedAt).getTime() } : {}),
  };
}

function isCrewCompletionState(item: OrchestratorItem, fixForwardEnabled: boolean): boolean {
  return item.state === "done" || (item.state === "merged" && !fixForwardEnabled);
}

// ── Event loop ─────────────────────────────────────────────────────

/** Dependencies injected into orchestrateLoop for testability. */
export interface OrchestrateLoopDeps {
  buildSnapshot: (orch: Orchestrator, projectRoot: string, worktreeDir: string) => PollSnapshot | Promise<PollSnapshot>;
  sleep: (ms: number) => Promise<void>;
  log: (entry: LogEntry) => void;
  actionDeps: OrchestratorDeps;
  /** Reconcile work item files with GitHub state after merge actions. */
  reconcile?: (workDir: string, worktreeDir: string, projectRoot: string) => void;
  /** Read screen content from a worker workspace for telemetry capture. */
  readScreen?: (ref: string, lines?: number) => string;
  /** Called after each poll cycle with current items. Used for daemon state persistence, TUI countdown, and render timing. */
  onPollComplete?: (items: OrchestratorItem[], snapshot: PollSnapshot, pollIntervalMs?: number, interactiveTiming?: InteractiveWatchTiming) => void;
  /** Sync cmux sidebar display for active workers after each poll cycle. */
  syncDisplay?: (orch: Orchestrator, snapshot: PollSnapshot) => void;
  /** Scan for work item files. Required for watch mode -- re-scans the work directory to discover new items. */
  scanWorkItems?: () => WorkItem[];
  /** Crew coordination broker. When present, crew mode is active -- claim before launch, complete after merge. */
  crewBroker?: CrewBroker;
  /** Override token usage resolution for telemetry tests. */
  readTokenUsage?: (item: OrchestratorItem, action: Action, ctx: ExecutionContext) => TokenUsage | undefined;
  /** Query GitHub rate limit status. Injectable for testing. */
  queryRateLimit?: (repoRoot: string) => Promise<import("../gh.ts").RateLimitInfo | null>;
  /** Injectable clock for interactive watch timing tests. Defaults to Date.now. */
  nowMs?: () => number;
  /** Injectable timer hooks for event-loop lag sampling tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Show the post-completion prompt and wait for user choice.
   * Returns the chosen action (run-more, clean, quit).
   * Only called when tuiMode is true and watch mode is false.
   */
  completionPrompt?: (allItems: OrchestratorItem[], runStartTime: string) => Promise<CompletionAction>;
  /** Centralized GitHub API request queue. When provided, GH API actions are routed through it. */
  requestQueue?: RequestQueue;
}

export interface OrchestrateLoopConfig {
  /** Override adaptive poll interval (milliseconds). */
  pollIntervalMs?: number;
  /** GitHub repo URL (e.g., "https://github.com/owner/repo") for constructing PR URLs. */
  repoUrl?: string;
  /** AI tool identifier for per-item metrics (e.g., "claude", "cursor"). */
  aiTool?: string;
  /**
   * Max loop iterations before forced exit. Guards against event-loop starvation:
   * when tests use `sleep: () => Promise.resolve()`, a stuck loop monopolizes the
   * microtask queue and macrotask-based safety timers (setTimeout/setInterval) never
   * fire -- not even SIGKILL guards. This synchronous check is the only reliable defense.
   * Undefined = no limit (production). Tests should always set a finite cap.
   */
  maxIterations?: number;
  /** When true, daemon stays running after all items reach terminal state, watching for new work items. */
  watch?: boolean;
  /** Polling interval (milliseconds) for watch mode. Default: 30000 (30 seconds). */
  watchIntervalMs?: number;
  /** When true, TUI is active -- enables the post-completion prompt. */
  tuiMode?: boolean;
  /**
   * Duration (ms) to gate claims at the start of the loop. During this window,
   * launch actions are suppressed (items reverted to ready) so the daemon runs
   * but does not start work.
   * 0 or undefined = no gating.
   */
  claimsGatedMs?: number;
}

/** Result from the orchestrate loop indicating why it exited. */
export interface OrchestrateLoopResult {
  /** The completion action chosen by the user, if any. Only set when tuiMode is true. */
  completionAction?: CompletionAction;
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
): Promise<OrchestrateLoopResult> {
  const { log } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  const lagSampler = config.tuiMode
    ? createEventLoopLagSampler({
        now: nowMs,
        setTimeoutFn: deps.setTimeoutFn,
        clearTimeoutFn: deps.clearTimeoutFn,
      })
    : undefined;
  lagSampler?.start();
  let pendingInteractiveTiming: InteractiveWatchTiming | undefined;

  // Wire onTransition callback for structured transition logging.
  // This fires from inside Orchestrator.transition() on every state change,
  // replacing the manual prevStates diff that previously lived in the poll loop.
  if (!orch.config.onTransition) {
    orch.config.onTransition = (itemId, from, to, timestamp, latencyMs) => {
      const entry: Record<string, unknown> = {
        ts: timestamp,
        level: "info",
        event: "transition",
        itemId,
        from,
        to,
        latencyMs,
      };
      // Enrich with stacking info when promoted from queued → ready with a base branch
      const item = orch.getItem(itemId);
      if (item && from === "queued" && to === "ready" && item.baseBranch) {
        entry.stacked = true;
        entry.baseBranch = item.baseBranch;
      }
      log(entry as LogEntry);

      // Telemetry report on state transitions
      if (deps.crewBroker) {
        const orchItem = orch.getItem(itemId);
        if (orchItem) {
          if (from === "implementing" && to === "ci-pending" && orchItem.prNumber) {
            deps.crewBroker.report("pr_opened", itemId, {
              prNumber: orchItem.prNumber,
              branch: `ninthwave/${itemId}`,
            });
          }
          if (from === "ci-pending" && (to === "ci-passed" || to === "ci-failed")) {
            deps.crewBroker.report("ci_result", itemId, {
              passed: to === "ci-passed",
              checkName: "github-actions",
              prNumber: orchItem.prNumber,
            });
          }
          if (from === "reviewing" && (to === "ci-passed" || to === "review-pending")) {
            deps.crewBroker.report("review_submitted", itemId, {
              reviewer: "ai",
              verdict: to === "ci-passed" ? "approved" : "changes_requested",
              prNumber: orchItem.prNumber,
            });
          }
          if (from === "review-pending" && to === "ci-pending") {
            deps.crewBroker.report("review_addressed", itemId, {
              round: orchItem.reviewRound ?? 1,
              prNumber: orchItem.prNumber,
            });
          }
          if (to === "rebasing") {
            deps.crewBroker.report("rebase", itemId, { reason: "conflicts" });
          }
          if (to === "merged" && orchItem.prNumber) {
            deps.crewBroker.report("pr_merged", itemId, { prNumber: orchItem.prNumber });
          }
          if (from === "forward-fix-pending" && (to === "done" || to === "fix-forward-failed")) {
            deps.crewBroker.report("post_merge_ci", itemId, {
              passed: to === "done",
              checkName: "github-actions",
              prNumber: orchItem.prNumber,
            });
          }
          if (from === "fix-forward-failed" && to === "fixing-forward") {
            deps.crewBroker.report("fix_forward_started", itemId, {
              triggerPr: orchItem.prNumber,
              fixBranch: `ninthwave/${itemId}-fix`,
            });
          }
          if (from === "fixing-forward" && (to === "done" || to === "stuck")) {
            deps.crewBroker.report("fix_forward_result", itemId, {
              succeeded: to === "done",
            });
          }
        }
      }
    };
  }

  // Wire onEvent callback for structured event logging (non-transition events).
  if (!orch.config.onEvent) {
    orch.config.onEvent = (itemId, event, data) => {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event,
        itemId,
        ...data,
      } as LogEntry);
    };
  }

  // Author cache for resolving git author of work item files during sync.
  // Cleared each poll cycle to avoid stale data.
  const authorCache = new AuthorCache();

  const runStartTime = new Date().toISOString();

  log({
    ts: runStartTime,
    level: "info",
    event: "orchestrate_start",
    items: orch.getAllItems().map((i) => i.id),
    maxInflight: orch.config.maxInflight,
    mergeStrategy: orch.config.mergeStrategy,
  });

  let __iterations = 0;
  let __lastSnapshot: PollSnapshot | undefined;
  let __lastActions: import("../orchestrator.ts").Action[] = [];
  let __lastTransitionIter = 0;
  let lastMainRefreshMs = 0; // Force first refresh immediately
  const watchIntervalMs = config.watchIntervalMs ?? 30_000;
  let lastWatchScanMs = Date.now();
  const loopStartMs = Date.now();
  const requestQueue = deps.requestQueue ?? new RequestQueue({
    log,
  });

  const scanForNewWatchItems = (): WorkItem[] => {
    if (!config.watch || !deps.scanWorkItems) return [];

    const freshItems = deps.scanWorkItems();
    const existingIds = new Set(orch.getAllItems().map((i) => i.id));
    const newItems = freshItems.filter((item) => !existingIds.has(item.id));
    if (newItems.length === 0) return [];

    for (const item of newItems) {
      orch.addItem(item);
    }

    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "watch_new_items",
      newIds: newItems.map((item) => item.id),
      count: newItems.length,
    });

    return newItems;
  };

  try {
    while (true) {
      __iterations++;

      if (pendingInteractiveTiming) {
        finalizeInteractiveWatchTiming(log, pendingInteractiveTiming, lagSampler?.drain().maxLagMs ?? 0);
        pendingInteractiveTiming = undefined;
      }

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
            ciFailCountTotal: i.ciFailCountTotal,
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
    const allTerminal = allItems.every((i) => TERMINAL_STATES.has(i.state));
    if (allTerminal) {
      handleRunComplete(allItems, orch, ctx, deps, config, log, runStartTime);

      // Watch mode: instead of exiting, poll for new work items
      if (config.watch && deps.scanWorkItems) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "watch_mode_waiting",
          message: "All items complete. Watching for new work items...",
          watchIntervalMs,
        });

        // Poll for new work items until we find some or get aborted
        let foundNew = false;
        while (!foundNew) {
          __iterations++;
          if (config.maxIterations != null && __iterations > config.maxIterations) {
            break;
          }
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return {};
          }
          await deps.sleep(watchIntervalMs);
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return {};
          }

          lastWatchScanMs = Date.now();
          if (scanForNewWatchItems().length > 0) {
            foundNew = true;
          }
        }
        if (foundNew) {
          // Continue the main loop with newly added items
          continue;
        }
        // maxIterations exceeded in watch loop -- fall through to break
        break;
      }

      // TUI mode (non-watch): show completion prompt
      if (config.tuiMode && deps.completionPrompt) {
        const action = await deps.completionPrompt(allItems, runStartTime);
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "completion_prompt",
          action,
        });

        if (action === "run-more") {
          return { completionAction: "run-more" };
        }
        if (action === "clean") {
          // Clean worktrees for done items
          for (const item of allItems) {
            if (item.state !== "done") continue;
            try {
              if (item.workspaceRef) deps.actionDeps.mux.closeWorkspace(item.workspaceRef, item.id);
              deps.actionDeps.cleanup.cleanSingleWorktree(item.id, ctx.worktreeDir, ctx.projectRoot);
            } catch { /* best-effort */ }
          }
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "completion_cleanup",
            cleanedIds: allItems.filter((i) => i.state === "done").map((i) => i.id),
          });
          return { completionAction: "clean" };
        }
        // action === "quit"
        return { completionAction: "quit" };
      }

      break;
    }

      if (config.watch && deps.scanWorkItems) {
        const nowWatchScanMs = Date.now();
        if (nowWatchScanMs - lastWatchScanMs >= watchIntervalMs) {
          lastWatchScanMs = nowWatchScanMs;
          scanForNewWatchItems();
        }
      }

    // Capture pre-transition states for logging
    const prevStates = new Map<string, OrchestratorItemState>();
    for (const item of allItems) {
      prevStates.set(item.id, item.state);
    }

    // Crew mode: sync active items to broker (fire-and-forget, before snapshot)
    // Clear author cache each cycle to avoid stale data across syncs.
    authorCache.clear();
    if (deps.crewBroker) {
      try {
        const activeItems = orch.getAllItems()
          .filter((i) => !TERMINAL_STATES.has(i.state));
        // Build enriched sync items with priority, dependencies, and author.
        // Filter dependencies to only include items tracked in the orchestrator.
        // Untracked deps (removed from work dir = already delivered) are omitted
        // so the hub doesn't block claims on stale items from previous syncs.
        const trackedIds = new Set(orch.getAllItems().map((i) => i.id));
        const syncItems: SyncItem[] = activeItems.map((item) => ({
          id: item.id,
          dependencies: (item.workItem.dependencies ?? []).filter((depId) => trackedIds.has(depId)),
          priority: PRIORITY_NUM[item.workItem.priority] ?? 2,
          author: item.workItem.filePath
            ? authorCache.resolve(item.workItem.filePath, ctx.projectRoot)
            : "",
        }));
        deps.crewBroker.sync(syncItems);
      } catch { /* best-effort -- sync failure doesn't block the orchestrator */ }
    }

    // ── Periodic main branch refresh ──────────────────────────────
    // Keeps origin/main fresh and fast-forwards local main when clean.
    // ff-only is atomic: succeeds or changes nothing (never leaves partial state).
      const interactiveTiming = config.tuiMode
        ? createInteractiveWatchTiming(__iterations, [])
        : undefined;

      const MAIN_REFRESH_INTERVAL_MS = 60_000;
      const nowRefreshMs = Date.now();
      if (nowRefreshMs - lastMainRefreshMs >= MAIN_REFRESH_INTERVAL_MS) {
        const mainRefreshStartMs = interactiveTiming ? nowMs() : 0;
        lastMainRefreshMs = nowRefreshMs;
        const reposToRefresh = new Set<string>([ctx.projectRoot]);
        for (const repoRoot of reposToRefresh) {
          try { deps.actionDeps.git.fetchOrigin(repoRoot, "main"); } catch { /* non-fatal */ }
          try { deps.actionDeps.git.ffMerge(repoRoot, "main"); } catch { /* non-fatal -- dirty tree or diverged */ }
        }
        if (interactiveTiming) {
          interactiveTiming.timingsMs.mainRefresh = elapsedMs(nowMs, mainRefreshStartMs);
        }
      }

      // Build snapshot from external state (queue handles per-request throttling)
      let snapshot: PollSnapshot;
        const pollStartMs = interactiveTiming ? nowMs() : 0;
        snapshot = await deps.buildSnapshot(orch, ctx.projectRoot, ctx.worktreeDir);
        if (interactiveTiming) {
          interactiveTiming.timingsMs.poll = elapsedMs(nowMs, pollStartMs);
        }
      __lastSnapshot = snapshot;

      // Sync token bucket with GitHub rate limit when API errors appear
      if (snapshot.apiErrorSummary?.primaryKind === "rate-limit" ||
          (snapshot.apiErrorSummary?.byKind?.["rate-limit"] ?? 0) > 0) {
        try {
          const queryRateLimit = deps.queryRateLimit ?? ghQueryRateLimitAsync;
          const rateInfo = await queryRateLimit(ctx.projectRoot);
          if (rateInfo) {
            requestQueue.updateBudget(rateInfo.remaining, rateInfo.reset);
            log({
              ts: new Date().toISOString(),
              level: "info",
              event: "rate_limit_budget_update",
              resetAt: new Date(rateInfo.reset * 1000).toISOString(),
              remaining: rateInfo.remaining,
              limit: rateInfo.limit,
              throttled: requestQueue.isThrottled(),
            });
          }
        } catch { /* non-fatal -- token bucket continues with natural refill */ }
      }

    // Log warning when GitHub API is unreachable (suppress when queue is throttled)
    if (snapshot.apiErrorCount && snapshot.apiErrorCount > 0 && !requestQueue.isThrottled()) {
      const primaryKind = snapshot.apiErrorSummary?.primaryKind;
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "github_api_errors",
        apiErrorCount: snapshot.apiErrorCount,
        apiErrorSummary: snapshot.apiErrorSummary,
        message: primaryKind
          ? `GitHub ${ghFailureKindLabel(primaryKind)} errors, holding state`
            + (snapshot.apiErrorSummary?.representativeError
              ? ` -- ${snapshot.apiErrorSummary.representativeError}`
              : "")
          : "GitHub API unreachable, holding state",
      });
    }


    // Process transitions (pure state machine)
      let actions = orch.processTransitions(snapshot);
      __lastActions = actions;

    // Arming window: suppress launch actions during the claims-gated period
    if (config.claimsGatedMs && config.claimsGatedMs > 0) {
      const elapsedMs = Date.now() - loopStartMs;
      if (elapsedMs < config.claimsGatedMs) {
        const launchActions = actions.filter((a) => a.type === "launch");
        if (launchActions.length > 0) {
          for (const action of launchActions) {
            orch.hydrateState(action.itemId, "ready");
          }
          actions = actions.filter((a) => a.type !== "launch");
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "claims_gated",
            elapsedMs,
            gatedMs: config.claimsGatedMs,
            suppressedCount: launchActions.length,
          });
        }
      }
    }

    // Crew mode: claim/filter launch actions through the broker
      if (deps.crewBroker) {
      const launchActions = actions.filter((a) => a.type === "launch");

      // Diagnostic: log when broker is connected but no items ready to launch
      if (launchActions.length === 0) {
        const queuedCount = orch.getAllItems().filter(i => i.state === "queued").length;
        const readyCount = orch.getAllItems().filter(i => i.state === "ready").length;
        if (queuedCount > 0 || readyCount > 0) {
          log({
            ts: new Date().toISOString(),
            level: "debug",
            event: "crew_no_launches",
            readyIds: snapshot.readyIds,
            queuedCount,
            readyCount,
            availableInflightSlots: orch.availableInflightSlots,
            connected: deps.crewBroker.isConnected(),
          });
        }
      }

      if (launchActions.length > 0) {
        if (!deps.crewBroker.isConnected()) {
          // Block ALL launches when disconnected -- prevents stall detection
          for (const action of launchActions) {
            orch.hydrateState(action.itemId, "ready");
          }
          actions = actions.filter((a) => a.type !== "launch");
          log({
            ts: new Date().toISOString(),
            level: "warn",
            event: "crew_launches_blocked",
            reason: "disconnected",
            blockedCount: launchActions.length,
          });
        } else {
          // Crew mode: let the broker decide what to work on.
          // Claim once per available launch slot, then replace the
          // processTransitions launch actions with broker-assigned items.
          const claimedIds = new Set<string>();
          let nullCount = 0;
          let errorCount = 0;
          for (const _action of launchActions) {
            try {
              const claimed = await deps.crewBroker.claim();
              if (claimed) claimedIds.add(claimed);
              else nullCount++;
            } catch { errorCount++; }
          }

          // Put all original launch actions back to ready
          for (const action of launchActions) {
            orch.hydrateState(action.itemId, "ready");
          }
          // Remove original launch actions
          actions = actions.filter((a) => a.type !== "launch");

          // Add launch actions for broker-claimed items that are still launchable
          const LAUNCHABLE: ReadonlySet<string> = new Set(["queued", "ready", "launching"]);
          for (const claimedId of claimedIds) {
            const orchItem = orch.getItem(claimedId);
            if (orchItem && LAUNCHABLE.has(orchItem.state)) {
              orch.hydrateState(claimedId, "launching");
              actions.push({ type: "launch", itemId: claimedId });
            }
          }

          if (claimedIds.size > 0 || launchActions.length > 0) {
            log({
              ts: new Date().toISOString(),
              level: "info",
              event: "crew_launches_resolved",
              requestedCount: launchActions.length,
              claimedCount: claimedIds.size,
              claimedIds: Array.from(claimedIds),
              nullCount,
              errorCount,
            });
          }
        }
      }
    }

    // Detect whether any transition occurred this cycle (for stale-detection bookkeeping).
    // Transition logging is handled by the Orchestrator's onTransition callback.
    let __hadTransition = false;
    for (const item of orch.getAllItems()) {
      const prev = prevStates.get(item.id);
      if (prev && prev !== item.state) {
        __hadTransition = true;
        break;
      }
    }

    if (__hadTransition) __lastTransitionIter = __iterations;

    // Crew mode: suppress write actions for items claimed by other daemons.
    // Remote items are tracked via GitHub polling but only the owning daemon acts.
      if (deps.crewBroker) {
        actions = filterCrewRemoteWriteActions(actions, deps.crewBroker.getCrewStatus());
      }

      if (interactiveTiming) {
        interactiveTiming.actionCount = actions.length;
        interactiveTiming.actionTypes = actions.map((action) => action.type);
      }

      // Emit an early snapshot so the TUI reflects state transitions (e.g.
      // queued->launching) immediately, before slow actions like launch/retry
      // block the event loop for tens of seconds per item.
      const hasSlowActions = actions.some((a) => a.type === "launch" || a.type === "retry");
      if (hasSlowActions) {
        deps.onPollComplete?.(orch.getAllItems(), snapshot, undefined, undefined);
      }

      // Execute actions -- route GH API actions through the request queue for
      // proactive token-bucket rate limiting; non-API actions execute immediately.
      const actionExecutionStartMs = interactiveTiming ? nowMs() : 0;
      const queuedActionPromises: Promise<void>[] = [];
      for (const action of actions) {
        if (GH_API_ACTIONS.has(action.type)) {
          const priority = action.type === "merge" ? "critical" as const : "high" as const;
          queuedActionPromises.push(
            requestQueue.enqueue({
              category: action.type,
              priority,
              itemId: action.itemId,
              execute: async () => {
                handleActionExecution(action, orch, ctx, deps, log);
              },
            }),
          );
        } else {
          handleActionExecution(action, orch, ctx, deps, log);
        }
      }
      // Await all queued GH API actions before proceeding
      if (queuedActionPromises.length > 0) {
        await Promise.all(queuedActionPromises);
      }
      if (interactiveTiming) {
        interactiveTiming.timingsMs.actionExecution = elapsedMs(nowMs, actionExecutionStartMs);
      }

      if (deps.crewBroker) {
        for (const orchItem of orch.getAllItems()) {
          const prevState = prevStates.get(orchItem.id);
          if (!prevState || prevState === orchItem.state || !isCrewCompletionState(orchItem, orch.config.fixForward)) {
            continue;
          }

          try {
            const completionAction = actions.find((action) => action.itemId === orchItem.id)
              ?? { type: "clean", itemId: orchItem.id };
            const tokenUsage = deps.readTokenUsage?.(orchItem, completionAction, ctx)
              ?? readLatestTokenUsage(ctx.projectRoot, orchItem.aiTool ?? ctx.aiTool ?? "unknown", {
                since: orchItem.startedAt,
              });
            deps.crewBroker.report("complete", orchItem.id, buildCompletionReportMetadata(orchItem), {
              tokenUsage,
            });
          } catch { /* best-effort */ }

          try {
            deps.crewBroker.complete(orchItem.id);
          } catch { /* best-effort */ }
        }
      }

    // Sync cmux sidebar display for active workers
      if (requestQueue.isThrottled()) {
        snapshot.rateLimitBackoffDescription = formatQueueThrottleDescription(requestQueue.getStats());
      }
      const displaySyncStartMs = interactiveTiming ? nowMs() : 0;
      try {
        deps.syncDisplay?.(orch, snapshot);
      } catch { /* best-effort -- display sync failure shouldn't block the orchestrator */ }
      if (interactiveTiming) {
        interactiveTiming.timingsMs.displaySync = elapsedMs(nowMs, displaySyncStartMs);
      }

    // Log state summary
    const states: Record<string, string[]> = {};
    for (const item of orch.getAllItems()) {
      if (!states[item.state]) states[item.state] = [];
      states[item.state]!.push(item.id);
    }
    log({ ts: new Date().toISOString(), level: "debug", event: "state_summary", states });

    // Sleep -- use adaptive interval; queue handles per-request throttling
      const interval = config.pollIntervalMs ?? adaptivePollInterval(orch);

      // Persist state for daemon mode (or any caller that wants snapshots)
      // Pass interval so TUI can set countdown target and capture render timing.
      deps.onPollComplete?.(orch.getAllItems(), snapshot, interval, interactiveTiming);
      if (interactiveTiming) {
        pendingInteractiveTiming = interactiveTiming;
      }

      await deps.sleep(interval);
    }
  } finally {
    lagSampler?.stop();
  }

  return {};
}

// ── Default session limit ───────────────────────────────────────────

/**
 * Default session limit for new users with no persisted preference.
 * Users' chosen value is persisted to ~/.ninthwave/config.json and takes
 * precedence on subsequent runs.
 */
export function computeDefaultMaxInflight(): number {
  return 1;
}

// ── Queue throttle display ──────────────────────────────────────────

/** Format queue stats into a human-readable throttle description for TUI display. */
export function formatQueueThrottleDescription(stats: RequestQueueStats): string {
  const utilPct = Math.round(stats.budgetUtilization * 100);
  const inFlight = stats.inFlight;
  const queued = stats.queued;

  const parts = [`Rate limited -- budget ${utilPct}% used`];
  if (inFlight > 0 || queued > 0) {
    parts.push(`(${inFlight} in-flight, ${queued} queued)`);
  }
  return parts.join(" ");
}
