// orchestrate command: event loop for parallel work item processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT/SIGTERM shutdown.
// Supports daemon mode (--daemon) for background operation with state persistence.

import { existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { totalmem, freemem } from "os";
import { execSync } from "node:child_process";
import { getAvailableMemory } from "../memory.ts";
import {
  Orchestrator,
  DEFAULT_CONFIG,
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
import { parseWorkItems } from "../parser.ts";
import { resolveRepo, bootstrapRepo } from "../cross-repo.ts";
import { scanExternalPRs } from "./pr-monitor.ts";
import { launchSingleItem, launchReviewWorker, launchRebaserWorker, launchForwardFixerWorker } from "./launch.ts";
import { cleanStaleBranchForReuse } from "../branch-cleanup.ts";
import { selectAiTools, detectInstalledAITools } from "../tool-select.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { prMerge, prComment, checkPrMergeable, getRepoOwner, applyGithubToken, fetchTrustedPrCommentsAsync, upsertOrchestratorComment, setCommitStatus as ghSetCommitStatus, prHeadSha, getMergeCommitSha as ghGetMergeCommitSha, checkCommitCI as ghCheckCommitCI, checkCommitCIAsync as ghCheckCommitCIAsync, ensureDomainLabels } from "../gh.ts";
import { fetchOrigin, ffMerge, gitAdd, gitCommit, gitPush, daemonRebase } from "../git.ts";
import { run } from "../shell.ts";
import { type Multiplexer, getMux } from "../mux.ts";
import { resolveSessionName } from "../tmux.ts";
import { reconcile } from "./reconcile.ts";
import { die, warn, info, ALT_SCREEN_ON, ALT_SCREEN_OFF } from "../output.ts";
import { confirmPrompt } from "../prompt.ts";
import { shouldEnterInteractive, runInteractiveFlow } from "../interactive.ts";
import type { WorkItem, LogEntry } from "../types.ts";
import { ID_IN_FILENAME, PRIORITY_NUM } from "../types.ts";
import { loadConfig, saveConfig, loadUserConfig } from "../config.ts";
import { preflight } from "../preflight.ts";
import {
  collectRunMetrics,
  parseCostSummary,
  parseWorkerTelemetry,
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
  forkDaemon,
  logFilePath,
  stateFilePath,
  userStateDir,
  migrateRuntimeState,
  readLayoutPreference,
  writeLayoutPreference,
  type DaemonState,
  type ExternalReviewItem,
} from "../daemon.ts";
import {
  formatStatusTable,
  mapDaemonItemState,
  getTerminalWidth,
  getTerminalHeight,
  buildStatusLayout,
  renderFullScreenFrame,
  renderHelpOverlay,
  renderDetailOverlay,
  clampScrollOffset,
  buildPanelLayout,
  renderPanelFrame,
  MIN_FULLSCREEN_ROWS,
  type StatusItem,
  type ViewOptions,
  type CrewStatusInfo,
  type PanelMode,
  type LogEntry as PanelLogEntry,
} from "../status-render.ts";
import type { CrewBroker, CrewStatus, SyncItem } from "../crew.ts";
import { WebSocketCrewBroker, resolveOperatorId, readCrewCode, saveCrewCode } from "../crew.ts";
import { AuthorCache } from "../git-author.ts";
import {
  readScheduleState,
  writeScheduleState,
} from "../schedule-state.ts";
import {
  launchScheduledTask,
  scheduleTriggerDir,
} from "../schedule-runner.ts";
import { listScheduledTasks as listScheduledTasksFromDir } from "../schedule-files.ts";
// ── Extracted subsystems ─────────────────────────────────────────────
import {
  buildSnapshot as _buildSnapshot,
  buildSnapshotAsync,
  isWorkerAlive,
  isWorkerAliveWithCache,
  getWorktreeLastCommitTime,
  getWorktreeLastCommitTimeAsync,
} from "../snapshot.ts";
import { reconstructState } from "../reconstruct.ts";
import { parseWatchArgs, validateItemIds, type ParsedWatchArgs } from "./watch-args.ts";
import {
  setupKeyboardShortcuts,
  filterLogsByLevel,
  pushLogBuffer,
  LOG_BUFFER_MAX,
  LOG_LEVEL_CYCLE,
  type TuiState,
  type LogLevelFilter,
} from "../tui-keyboard.ts";
import { processExternalReviews, type ExternalReviewDeps } from "../external-review.ts";
import { processScheduledTasks, type ScheduleLoopDeps } from "../schedule-processing.ts";
// ── Re-exports for backward compatibility ────────────────────────────
// These keep existing importers (tests, other modules) working without changes.
export { buildSnapshotAsync, isWorkerAlive, isWorkerAliveWithCache, getWorktreeLastCommitTime, getWorktreeLastCommitTimeAsync } from "../snapshot.ts";
export { buildSnapshot } from "../snapshot.ts";
export { reconstructState } from "../reconstruct.ts";
export { parseWatchArgs, validateItemIds, type ParsedWatchArgs } from "./watch-args.ts";
export { setupKeyboardShortcuts, filterLogsByLevel, pushLogBuffer, LOG_BUFFER_MAX, type TuiState, type LogLevelFilter } from "../tui-keyboard.ts";
export { processExternalReviews, type ExternalReviewDeps } from "../external-review.ts";
export { processScheduledTasks, type ScheduleLoopDeps } from "../schedule-processing.ts";
export { forkDaemon } from "../daemon.ts";
export type { LogEntry } from "../types.ts";

// ── Structured logging ─────────────────────────────────────────────

export function structuredLog(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

export interface TmuxStartupInfo {
  sessionName: string;
  outsideTmuxSession: boolean;
  attachHintLines: string[];
}

/** Build startup metadata and attach hints for tmux-backed orchestration. */
export function getTmuxStartupInfo(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
  runner: typeof run = run,
): TmuxStartupInfo {
  const sessionName = resolveSessionName({
    runner,
    env,
    cwd: () => projectRoot,
  });
  const outsideTmuxSession = !env.TMUX;

  if (!outsideTmuxSession) {
    return {
      sessionName,
      outsideTmuxSession,
      attachHintLines: [],
    };
  }

  const attachCommand = `tmux attach -t ${sessionName}`;
  const attachHintLines = env.TERM_PROGRAM === "iTerm.app"
    ? [
        `Tmux session ready: ${sessionName}`,
        `iTerm2: open a new tab or split pane and run: ${attachCommand}`,
      ]
    : [
        `Tmux session ready: ${sessionName}`,
        `Attach with: ${attachCommand}`,
      ];

  return {
    sessionName,
    outsideTmuxSession,
    attachHintLines,
  };
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
 * When remoteItemIds is provided, marks items claimed by other crew members as remote.
 */
export function orchestratorItemsToStatusItems(
  items: OrchestratorItem[],
  remoteItemIds?: Set<string>,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
): StatusItem[] {
  const now = Date.now();
  return items.map((item) => ({
    id: item.id,
    title: item.workItem.title,
    state: remoteItemIds?.has(item.id) ? "implementing" : mapDaemonItemState(item.state),
    prNumber: item.prNumber ?? null,
    ageMs: now - new Date(item.lastTransition).getTime(),
    timeoutRemainingMs: item.timeoutDeadline
      ? Math.max(0, new Date(item.timeoutDeadline).getTime() - now)
      : undefined,
    timeoutExtensions: item.timeoutDeadline
      ? `${item.timeoutExtensionCount ?? 0}/${maxTimeoutExtensions}`
      : undefined,
    repoLabel: item.resolvedRepoRoot ? basename(item.resolvedRepoRoot) : "",
    failureReason: item.failureReason,
    dependencies: item.workItem.dependencies ?? [],
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    exitCode: item.exitCode,
    stderrTail: item.stderrTail,
    remote: remoteItemIds?.has(item.id) ?? false,
    workspaceRef: item.workspaceRef,
  }));
}

/**
 * Render the status table to stdout using ANSI cursor control for flicker-free updates.
 * Uses cursor-home + clear-line + clear-to-end to replace content in-place.
 * Injectable write function for testability.
 *
 * In full-screen mode (>= MIN_FULLSCREEN_ROWS), uses buildStatusLayout + renderFullScreenFrame
 * with pinned header/footer and scrollable item area. Falls back to legacy rendering for
 * very small terminals.
 */
export function renderTuiFrame(
  items: OrchestratorItem[],
  wipLimit: number | undefined,
  write: (s: string) => void = (s) => process.stdout.write(s),
  viewOptions?: ViewOptions,
  scrollOffset: number = 0,
  remoteItemIds?: Set<string>,
  sessionCode?: string,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, remoteItemIds, maxTimeoutExtensions);
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();

  write("\x1B[H");

  if (viewOptions?.showHelp) {
    // Render help overlay instead of the normal frame
    const helpLines = renderHelpOverlay(termWidth, termRows, sessionCode, undefined);
    const content = helpLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (termRows >= MIN_FULLSCREEN_ROWS) {
    const layout = buildStatusLayout(statusItems, termWidth, wipLimit, false, viewOptions);
    const clamped = clampScrollOffset(scrollOffset, layout.itemLines.length, Math.max(1, termRows - layout.headerLines.length - layout.footerLines.length));
    const frameLines = renderFullScreenFrame(layout, termRows, termWidth, clamped);
    const content = frameLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else {
    const content = formatStatusTable(statusItems, termWidth, wipLimit, false, viewOptions);
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  }

  write("\x1B[J");
}

/**
 * Render a panel-aware TUI frame with split/logs-only/status-only support.
 * Uses buildPanelLayout + renderPanelFrame from status-render.ts.
 * Falls back to renderTuiFrame when the help overlay is active.
 */
export function renderTuiPanelFrame(
  items: OrchestratorItem[],
  wipLimit: number | undefined,
  tuiState: TuiState,
  write: (s: string) => void = (s) => process.stdout.write(s),
  remoteItemIds?: Set<string>,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, remoteItemIds, maxTimeoutExtensions);
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();

  write("\x1B[H");

  if (tuiState.viewOptions.showHelp) {
    // Render help overlay instead of the panel frame
    const helpLines = renderHelpOverlay(termWidth, termRows, tuiState.sessionCode, tuiState.tmuxSessionName);
    const content = helpLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (tuiState.detailItemId) {
    // Render detail overlay for the selected item
    const detailStatusItem = statusItems.find((i) => i.id === tuiState.detailItemId);
    if (detailStatusItem) {
      const orchItem = items.find((i) => i.id === tuiState.detailItemId);
      const overlayLines = renderDetailOverlay(detailStatusItem, termWidth, termRows, {
        repoUrl: tuiState.viewOptions.repoUrl,
        priority: orchItem?.workItem.priority,
        dependencies: orchItem?.workItem.dependencies,
        ciFailCount: orchItem?.ciFailCount,
        retryCount: orchItem?.retryCount,
      });
      const content = overlayLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    } else {
      // Item no longer exists -- clear detail view and render normal frame
      tuiState.detailItemId = null;
      const filteredLogs = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
      const panelLayout = buildPanelLayout(
        tuiState.panelMode, statusItems, filteredLogs, termWidth, termRows,
        { wipLimit, viewOptions: tuiState.viewOptions, logScrollOffset: tuiState.logScrollOffset, statusScrollOffset: tuiState.scrollOffset, selectedIndex: tuiState.selectedIndex },
      );
      const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
      const content = frameLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    }
  } else {
    const filteredLogs = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);

    const panelLayout = buildPanelLayout(
      tuiState.panelMode,
      statusItems,
      filteredLogs,
      termWidth,
      termRows,
      {
        wipLimit,
        viewOptions: tuiState.viewOptions,
        logScrollOffset: tuiState.logScrollOffset,
        statusScrollOffset: tuiState.scrollOffset,
        selectedIndex: tuiState.selectedIndex,
      },
    );
    const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
    const content = frameLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  }

  write("\x1B[J");
}

// ── Reusable TUI runner ─────────────────────────────────────────────

/** Options for runTUI -- the reusable TUI lifecycle runner. */
export interface RunTUIOptions {
  /** Provide status items and optional wip limit for each render cycle. */
  getItems: () => { items: StatusItem[]; wipLimit?: number; sessionStartedAt?: string };
  /** Provide log entries for the log panel. If omitted, logBuffer is empty. */
  getLogEntries?: () => PanelLogEntry[];
  /** Poll interval in ms (default: 2000). */
  intervalMs?: number;
  /** External abort signal to stop the TUI loop. */
  signal?: AbortSignal;
  /** Starting panel mode (default: split). */
  panelMode?: PanelMode;
}

/**
 * Run a panel-aware TUI loop.
 *
 * Sets up the alternate screen buffer, keyboard shortcuts (Tab, j/k, l, G, q, d, ?, ↑/↓),
 * and a poll-render loop. Returns when the user presses `q` or the signal is aborted.
 *
 * Designed for read-only mode: status.ts can call this to get the full panel TUI
 * without needing the orchestrate event loop.
 */
export async function runTUI(opts: RunTUIOptions): Promise<void> {
  const { getItems, getLogEntries, intervalMs = 2000, signal, panelMode = "split" } = opts;
  const isTTY = process.stdin.isTTY === true;
  if (!isTTY) return;

  const abortController = new AbortController();
  const combinedSignal = signal
    ? (() => { signal.addEventListener("abort", () => abortController.abort()); return abortController.signal; })()
    : abortController.signal;

  const logBuffer: PanelLogEntry[] = [];
  const tuiState: TuiState = {
    scrollOffset: 0,
    viewOptions: { showBlockerDetail: true },
    mergeStrategy: "auto",
    bypassEnabled: false,
    ctrlCPending: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    panelMode,
    logBuffer,
    logScrollOffset: 0,
    logLevelFilter: "all",
    selectedIndex: 0,
    detailItemId: null,
    savedLogScrollOffset: 0,
    getSelectedItemId: (index: number) => {
      const data = getItems();
      const nonQueued = data.items.filter((i) => i.state !== "queued");
      return nonQueued[index]?.id;
    },
    getItemCount: () => {
      const data = getItems();
      return data.items.filter((i) => i.state !== "queued").length;
    },
    onUpdate: () => {
      try { render(); } catch { /* non-fatal */ }
    },
  };

  // Noop log for keyboard shortcuts (read-only mode has no orchestrator log)
  const noopLog = (_entry: LogEntry) => {};

  function render() {
    const data = getItems();
    if (data.sessionStartedAt) {
      tuiState.viewOptions.sessionStartedAt = data.sessionStartedAt;
    }
    // Refresh log entries from provider
    if (getLogEntries) {
      const entries = getLogEntries();
      logBuffer.length = 0;
      logBuffer.push(...entries);
    }
    // Build a minimal set of OrchestratorItem-like objects for rendering
    // Since we have StatusItem[], we render directly via panel layout
    const termWidth = getTerminalWidth();
    const termRows = getTerminalHeight();
    const write = (s: string) => process.stdout.write(s);

    write("\x1B[H");

    if (tuiState.viewOptions.showHelp) {
      const helpLines = renderHelpOverlay(termWidth, termRows, tuiState.sessionCode, tuiState.tmuxSessionName);
      const content = helpLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    } else if (tuiState.detailItemId) {
      const detailItem = data.items.find((i) => i.id === tuiState.detailItemId);
      if (detailItem) {
        const overlayLines = renderDetailOverlay(detailItem, termWidth, termRows, {
          repoUrl: tuiState.viewOptions.repoUrl,
        });
        const content = overlayLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      } else {
        tuiState.detailItemId = null;
      }
    } else {
      const filteredLogs = filterLogsByLevel(logBuffer, tuiState.logLevelFilter);

      const panelLayout = buildPanelLayout(
        tuiState.panelMode,
        data.items,
        filteredLogs,
        termWidth,
        termRows,
        {
          wipLimit: data.wipLimit,
          viewOptions: tuiState.viewOptions,
          logScrollOffset: tuiState.logScrollOffset,
          statusScrollOffset: tuiState.scrollOffset,
          selectedIndex: tuiState.selectedIndex,
        },
      );
      const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
      const content = frameLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    }

    write("\x1B[J");
  }

  process.stdout.write(ALT_SCREEN_ON);
  const exitAltScreen = () => process.stdout.write(ALT_SCREEN_OFF);
  process.on("exit", exitAltScreen);

  const cleanupKeyboard = setupKeyboardShortcuts(abortController, noopLog, process.stdin, tuiState);

  try {
    while (!combinedSignal.aborted) {
      render();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        combinedSignal.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    cleanupKeyboard();
    exitAltScreen();
    process.removeListener("exit", exitAltScreen);
  }
}

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

    // Set status pill (best-effort)
    try {
      mux.setStatus(item.workspaceRef, statusKey, display.text, display.icon, display.color);
    } catch { /* best-effort */ }

    // Set progress bar
    const snap = heartbeatMap.get(item.id);
    const heartbeat = snap?.lastHeartbeat;

    try {
      if (workerActiveStates.has(item.state)) {
        // Worker is active: use heartbeat progress/label, default to 0 with no label
        if (heartbeat) {
          mux.setProgress(item.workspaceRef, heartbeat.progress, heartbeat.label);
        } else {
          mux.setProgress(item.workspaceRef, 0);
        }
      } else {
        // Worker is idle: 1.0 (complete), no label -- status pill carries the message
        mux.setProgress(item.workspaceRef, 1);
      }
    } catch { /* best-effort */ }
  }
}

// ── Adaptive poll interval ─────────────────────────────────────────

/** Flat 2s poll interval -- fast enough that users never need to think about refresh timing. */
export function adaptivePollInterval(_orch: Orchestrator): number {
  return 2_000;
}

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
function listWorktreeIds(worktreeDir: string): string[] {
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
function listOpenItemIds(workDir: string): string[] {
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

// ── Memory detection ──────────────────────────────────────────────

// getAvailableMemory is imported from ../memory.ts and re-exported for backward compatibility.
export { getAvailableMemory } from "../memory.ts";

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
  // Final cleanup sweep: close workspaces and remove worktrees for managed items.
  // Stuck items preserve their worktree so users can inspect partial work.
  const cleanedIds: string[] = [];
  for (const item of allItems) {
    try {
      // Close workspace before worktree cleanup (prevents orphaned workspaces)
      if (item.workspaceRef) {
        deps.actionDeps.closeWorkspace(item.workspaceRef);
      }
      // Preserve worktrees for stuck items -- users can inspect partial work
      // and clean manually with `nw clean <ID>` when done.
      if (item.state === "stuck") continue;
      const cleaned = deps.actionDeps.cleanSingleWorktree(
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

  // Analytics: emit run_metrics as a structured log event (replaces JSON file writing)
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
 * Format: "ninthwave: N merged, M stuck, K queued (Xm Ys) / Cost: $X.XX (N PRs) | Lead time: p50 Xm, p95 Ym"
 */
export function formatExitSummary(
  allItems: OrchestratorItem[],
  runStartTime: string,
  costData?: Map<string, CostSummary>,
): string {
  const merged = allItems.filter((i) => i.state === "done").length;
  const stuck = allItems.filter((i) => i.state === "stuck").length;
  const queued = allItems.filter((i) => i.state === "queued" || i.state === "ready").length;

  // Duration
  const elapsed = Math.max(0, Date.now() - new Date(runStartTime).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  let line = `ninthwave: ${merged} merged, ${stuck} stuck, ${queued} queued (${durationStr})`;

  // Cost
  if (costData && costData.size > 0) {
    const costItems = [...costData.values()].filter((c) => c.costUsd != null);
    if (costItems.length > 0) {
      const totalCost = costItems.reduce((sum, c) => sum + c.costUsd!, 0);
      const prCount = merged;
      line += ` / Cost: $${totalCost.toFixed(2)}`;
      if (prCount > 0) line += ` (${prCount} PRs)`;
    }
  }

  // Lead time (time from start to done for each completed item)
  const leadTimes = allItems
    .filter((i) => i.state === "done" && i.startedAt && i.endedAt)
    .map((i) => new Date(i.endedAt!).getTime() - new Date(i.startedAt!).getTime())
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);

  if (leadTimes.length > 0) {
    const p50Idx = Math.max(0, Math.ceil(0.5 * leadTimes.length) - 1);
    const p95Idx = Math.max(0, Math.ceil(0.95 * leadTimes.length) - 1);
    const p50m = Math.round(leadTimes[p50Idx]! / 60_000);
    const p95m = Math.round(leadTimes[p95Idx]! / 60_000);
    line += ` | Lead time: p50 ${p50m}m, p95 ${p95m}m`;
  }

  return line;
}

// ── Completion prompt ───────────────────────────────────────────────

/**
 * Action chosen at the post-completion prompt.
 * - "run-more": re-enter interactive selection flow
 * - "clean": clean up worktrees for done items
 * - "quit": exit the TUI
 */
export type CompletionAction = "run-more" | "clean" | "quit";

/**
 * Format the completion banner shown when all items reach terminal state.
 * Returns the banner text as an array of lines.
 */
export function formatCompletionBanner(
  allItems: OrchestratorItem[],
  runStartTime: string,
  costData?: Map<string, CostSummary>,
): string[] {
  const merged = allItems.filter((i) => i.state === "done").length;
  const stuck = allItems.filter((i) => i.state === "stuck").length;
  const total = allItems.length;

  const elapsed = Math.max(0, Date.now() - new Date(runStartTime).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  const lines: string[] = [];
  lines.push("");
  lines.push(`  All ${total} items complete. ${merged} merged, ${stuck} stuck. (${durationStr})`);

  // Inline analytics
  if (costData && costData.size > 0) {
    const costItems = [...costData.values()].filter((c) => c.costUsd != null);
    if (costItems.length > 0) {
      const totalCost = costItems.reduce((sum, c) => sum + c.costUsd!, 0);
      lines.push(`  Cost: $${totalCost.toFixed(2)} across ${costItems.length} workers`);
    }
  }

  const leadTimes = allItems
    .filter((i) => i.state === "done" && i.startedAt && i.endedAt)
    .map((i) => new Date(i.endedAt!).getTime() - new Date(i.startedAt!).getTime())
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (leadTimes.length > 0) {
    const p50Idx = Math.max(0, Math.ceil(0.5 * leadTimes.length) - 1);
    const p95Idx = Math.max(0, Math.ceil(0.95 * leadTimes.length) - 1);
    const p50m = Math.round(leadTimes[p50Idx]! / 60_000);
    const p95m = Math.round(leadTimes[p95Idx]! / 60_000);
    lines.push(`  Lead time: p50 ${p50m}m, p95 ${p95m}m`);
  }

  lines.push("");
  lines.push("  [r] Run more  [c] Clean up  [q] Quit");
  lines.push("");
  return lines;
}

/**
 * Wait for a completion prompt keypress (r, c, q, or Ctrl-C).
 * Returns the chosen action. Resolves when a valid key is pressed.
 *
 * @param stdin - Readable stream (must already be in raw mode)
 * @param signal - Optional abort signal (e.g., from Ctrl-C handler)
 */
export function waitForCompletionKey(
  stdin: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<CompletionAction> {
  return new Promise<CompletionAction>((resolve) => {
    if (signal?.aborted) {
      resolve("quit");
      return;
    }

    const onAbort = () => {
      cleanup();
      resolve("quit");
    };

    const onData = (key: string) => {
      switch (key) {
        case "r":
          cleanup();
          resolve("run-more");
          break;
        case "c":
          cleanup();
          resolve("clean");
          break;
        case "q":
        case "\x03": // Ctrl-C
          cleanup();
          resolve("quit");
          break;
        // Ignore other keys
      }
    };

    function cleanup() {
      stdin.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
    }

    stdin.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
        // Report session_ended telemetry
        if (deps.crewBroker) {
          const role = orchItem.reviewerWorkspaceRef ? "reviewer"
            : orchItem.rebaserWorkspaceRef ? "rebaser"
            : orchItem.fixForwardWorkspaceRef ? "verifier"
            : "implementer";
          deps.crewBroker.report("session_ended", action.itemId, {
            model: orchItem.aiTool ?? ctx.aiTool ?? "unknown",
            role,
            durationMs: orchItem.startedAt ? Date.now() - new Date(orchItem.startedAt).getTime() : undefined,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
          });
        }
      } catch {
        // Non-fatal -- cost/telemetry capture failure doesn't block cleanup
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
    const launchRoles: Record<string, string> = {
      "launch": "implementer",
      "launch-review": "reviewer",
      "launch-rebaser": "rebaser",
      "launch-forward-fixer": "verifier",
    };
    const role = launchRoles[action.type];
    if (role) {
      deps.crewBroker.report("session_started", action.itemId, {
        model: ctx.aiTool ?? "unknown",
        role,
        provider: ctx.aiTool ?? "unknown",
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

// ── Event loop ─────────────────────────────────────────────────────

/** Dependencies injected into orchestrateLoop for testability. */
export interface OrchestrateLoopDeps {
  buildSnapshot: (orch: Orchestrator, projectRoot: string, worktreeDir: string) => PollSnapshot | Promise<PollSnapshot>;
  sleep: (ms: number) => Promise<void>;
  log: (entry: LogEntry) => void;
  actionDeps: OrchestratorDeps;
  /** Get available free memory in bytes. Defaults to os.freemem(). Injectable for testing. */
  getFreeMem?: () => number;
  /** Reconcile work item files with GitHub state after merge actions. */
  reconcile?: (workDir: string, worktreeDir: string, projectRoot: string) => void;
  /** Read screen content from a worker workspace for cost/token parsing. */
  readScreen?: (ref: string, lines?: number) => string;
  /** Called after each poll cycle with current items. Used for daemon state persistence and TUI countdown. */
  onPollComplete?: (items: OrchestratorItem[], pollIntervalMs?: number) => void;
  /** Sync cmux sidebar display for active workers after each poll cycle. */
  syncDisplay?: (orch: Orchestrator, snapshot: PollSnapshot) => void;
  /** Dependencies for external PR review processing. When present and reviewExternal is enabled, external PRs are scanned and reviewed. */
  externalReviewDeps?: ExternalReviewDeps;
  /** Scan for work item files. Required for watch mode -- re-scans the work directory to discover new items. */
  scanWorkItems?: () => WorkItem[];
  /** Crew coordination broker. When present, crew mode is active -- claim before launch, complete after merge. */
  crewBroker?: CrewBroker;
  /** Schedule dependencies. When present, scheduled task processing is active. */
  scheduleDeps?: ScheduleLoopDeps;
  /**
   * Show the post-completion prompt and wait for user choice.
   * Returns the chosen action (run-more, clean, quit).
   * Only called when tuiMode is true and watch mode is false.
   */
  completionPrompt?: (allItems: OrchestratorItem[], runStartTime: string, costData: Map<string, CostSummary>) => Promise<CompletionAction>;
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
  /** When true, scan for non-ninthwave PRs and spawn review workers for them. */
  reviewExternal?: boolean;
  /** When true, daemon stays running after all items reach terminal state, watching for new work items. */
  watch?: boolean;
  /** Polling interval (milliseconds) for watch mode. Default: 30000 (30 seconds). */
  watchIntervalMs?: number;
  /** When true, TUI is active -- enables the post-completion prompt. */
  tuiMode?: boolean;
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

  // Author cache for resolving git author of TODO files during sync.
  // Cleared each poll cycle to avoid stale data.
  const authorCache = new AuthorCache();

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
  let lastScheduleCheckMs = 0; // Force first check immediately
  let lastMainRefreshMs = 0; // Force first refresh immediately
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

      // Watch mode: instead of exiting, poll for new work items
      if (config.watch && deps.scanWorkItems) {
        const watchInterval = config.watchIntervalMs ?? 30_000;
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "watch_mode_waiting",
          message: "All items complete. Watching for new work items...",
          watchIntervalMs: watchInterval,
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
          await deps.sleep(watchInterval);
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return {};
          }

          // Re-scan for work item files
          const freshItems = deps.scanWorkItems();
          const existingIds = new Set(orch.getAllItems().map((i) => i.id));
          const newItems = freshItems.filter((t) => !existingIds.has(t.id));

          if (newItems.length > 0) {
            for (const item of newItems) {
              orch.addItem(item);
            }
            log({
              ts: new Date().toISOString(),
              level: "info",
              event: "watch_new_items",
              newIds: newItems.map((t) => t.id),
              count: newItems.length,
            });
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
        const action = await deps.completionPrompt(allItems, runStartTime, costData);
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
              if (item.workspaceRef) deps.actionDeps.closeWorkspace(item.workspaceRef);
              deps.actionDeps.cleanSingleWorktree(item.id, ctx.worktreeDir, ctx.projectRoot);
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

    // Crew mode: sync active items to broker (fire-and-forget, before snapshot)
    // Clear author cache each cycle to avoid stale data across syncs.
    authorCache.clear();
    if (deps.crewBroker) {
      try {
        const activeItems = orch.getAllItems()
          .filter((i) => i.state !== "done" && i.state !== "stuck");
        // Build enriched sync items with priority, dependencies, and author
        const syncItems: SyncItem[] = activeItems.map((item) => ({
          id: item.id,
          dependencies: item.workItem.dependencies ?? [],
          priority: PRIORITY_NUM[item.workItem.priority] ?? 2,
          author: item.workItem.filePath
            ? authorCache.resolve(item.workItem.filePath, ctx.projectRoot)
            : "",
        }));
        deps.crewBroker.sync(syncItems);
      } catch { /* best-effort -- sync failure doesn't block the orchestrator */ }
    }

    // ── Scheduled task processing ─────────────────────────────────
    // Gated by 30s interval check to avoid excessive filesystem reads.
    if (deps.scheduleDeps) {
      const SCHEDULE_CHECK_INTERVAL_MS = 30_000;
      const nowMs = Date.now();
      if (nowMs - lastScheduleCheckMs >= SCHEDULE_CHECK_INTERVAL_MS) {
        lastScheduleCheckMs = nowMs;
        try {
          processScheduledTasks(
            ctx.projectRoot,
            orch,
            deps.scheduleDeps,
            log,
            memoryWip,
          );
        } catch (e: unknown) {
          // Non-fatal -- schedule processing failure shouldn't block the orchestrator
          const msg = e instanceof Error ? e.message : String(e);
          log({
            ts: new Date().toISOString(),
            level: "warn",
            event: "schedule_error",
            error: msg,
          });
        }
      }
    }

    // ── Periodic main branch refresh ──────────────────────────────
    // Keeps origin/main fresh and fast-forwards local main when clean.
    // ff-only is atomic: succeeds or changes nothing (never leaves partial state).
    const MAIN_REFRESH_INTERVAL_MS = 60_000;
    const nowRefreshMs = Date.now();
    if (nowRefreshMs - lastMainRefreshMs >= MAIN_REFRESH_INTERVAL_MS) {
      lastMainRefreshMs = nowRefreshMs;
      const reposToRefresh = new Set<string>([ctx.projectRoot]);
      for (const item of orch.getAllItems()) {
        if (item.resolvedRepoRoot && item.state !== "done" && item.state !== "stuck") {
          reposToRefresh.add(item.resolvedRepoRoot);
        }
      }
      for (const repoRoot of reposToRefresh) {
        try { deps.actionDeps.fetchOrigin(repoRoot, "main"); } catch { /* non-fatal */ }
        try { deps.actionDeps.ffMerge(repoRoot, "main"); } catch { /* non-fatal -- dirty tree or diverged */ }
      }
    }

    // Build snapshot from external state
    const snapshot = await deps.buildSnapshot(orch, ctx.projectRoot, ctx.worktreeDir);
    __lastSnapshot = snapshot;

    // Log warning when GitHub API is unreachable for all polled items
    if (snapshot.apiErrorCount && snapshot.apiErrorCount > 0) {
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "github_api_errors",
        apiErrorCount: snapshot.apiErrorCount,
        message: "GitHub API unreachable, holding state",
      });
    }


    // Process transitions (pure state machine)
    let actions = orch.processTransitions(snapshot);
    __lastActions = actions;

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
            wipSlots: orch.wipSlots,
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
      const crewStatus = deps.crewBroker.getCrewStatus();
      const remoteIds = crewStatus?.claimedItems?.length
        ? new Set(crewStatus.claimedItems)
        : undefined;
      if (remoteIds && remoteIds.size > 0) {
        const WRITE_ACTIONS: ReadonlySet<string> = new Set([
          "merge", "clean", "retry", "rebase", "daemon-rebase",
          "launch-repair", "clean-repair", "launch-review", "clean-review",
          "launch-verifier", "clean-verifier", "workspace-close",
        ]);
        actions = actions.filter((a) => {
          if (WRITE_ACTIONS.has(a.type) && remoteIds.has(a.itemId)) return false;
          return true;
        });
      }
    }

    // Execute actions
    for (const action of actions) {
      handleActionExecution(action, orch, ctx, deps, log, costData);
    }

    // Crew mode: notify broker of completed items (merge/done)
    if (deps.crewBroker) {
      for (const action of actions) {
        if (action.type === "merge" || action.type === "clean") {
          const orchItem = orch.getItem(action.itemId);
          if (orchItem && (orchItem.state === "done" || orchItem.state === "merged")) {
            try {
              deps.crewBroker.complete(action.itemId);
            } catch { /* best-effort */ }
          }
        }
      }
    }

    // Sync cmux sidebar display for active workers
    try {
      deps.syncDisplay?.(orch, snapshot);
    } catch { /* best-effort -- display sync failure shouldn't block the orchestrator */ }

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
          orch.wipSlots,
          deps.externalReviewDeps,
        );
        // Persist external review state
        writeExternalReviews(ctx.projectRoot, externalReviews);
      } catch (e: unknown) {
        // Non-fatal -- external review failure shouldn't block work item processing
        const msg = e instanceof Error ? e.message : String(e);
        log({
          ts: new Date().toISOString(),
          level: "warn",
          event: "external_review_error",
          error: msg,
        });
      }
    }

    // Sleep -- adaptive or fixed override
    const interval = config.pollIntervalMs ?? adaptivePollInterval(orch);

    // Persist state for daemon mode (or any caller that wants snapshots)
    // Pass interval so TUI can set countdown target
    deps.onPollComplete?.(orch.getAllItems(), interval);

    await deps.sleep(interval);
  }

  return {};
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

/** Renamed entry point: `nw watch` dispatches here. */
export const cmdWatch = cmdOrchestrate;

export async function cmdOrchestrate(
  args: string[],
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
): Promise<void> {
  const parsed = parseWatchArgs(args);
  let {
    itemIds,
    mergeStrategy,
  } = parsed;
  const {
    wipLimitOverride, pollIntervalOverride, frictionDir,
    daemonMode, isDaemonChild, clickupListId, remoteFlag,
    reviewAutoFix, reviewExternal, reviewWipLimit,
    fixForward, skipReview: cliSkipReview, noWatch, watchIntervalSecs,
    jsonFlag, skipPreflight, crewName,
    bypassEnabled, toolOverride: parsedToolOverride,
  } = parsed;
  let toolOverride = parsedToolOverride;
  let watchMode = parsed.watchMode;
  let crewCode = parsed.crewCode;
  let crewUrl = parsed.crewUrl;
  let connectMode = parsed.connectMode;

  // ── Pre-flight environment validation ────────────────────────────────
  if (!skipPreflight) {
    const pf = preflight(undefined, projectRoot);
    if (!pf.passed) {
      // Check if the only failure is uncommitted work items -- handle with auto-commit
      const itemCheck = pf.checks.find(
        (c) => c.status === "fail" && c.message.includes("uncommitted work item file"),
      );
      const otherErrors = pf.errors.filter(
        (e) => !e.includes("uncommitted work item file"),
      );

      if (itemCheck && otherErrors.length === 0) {
        // Only uncommitted work items failed -- try auto-commit
        const isInteractive = !isDaemonChild && !daemonMode && process.stdout.isTTY === true;
        let shouldCommit = false;

        if (isInteractive) {
          warn(itemCheck.message);
          shouldCommit = await confirmPrompt(
            "Commit and push work item files before launching workers?",
            true,
          );
          if (!shouldCommit) {
            die("Uncommitted work item files detected. Commit them before launching workers.");
          }
        } else {
          // Daemon/non-interactive mode: auto-commit
          info(`Auto-committing: ${itemCheck.message}`);
          shouldCommit = true;
        }

        if (shouldCommit) {
          try {
            gitAdd(projectRoot, [".ninthwave/work/"]);
            gitCommit(projectRoot, "chore: commit work item files before orchestration");
            gitPush(projectRoot);
            info("Work item files committed and pushed.");
          } catch (err) {
            die(`Failed to auto-commit work item files: ${(err as Error).message}`);
          }
        }
      } else {
        for (const err of pf.errors) {
          console.error(`Pre-flight failed: ${err}`);
        }
        die("Environment checks failed. Fix the issues above or use --skip-preflight to bypass.");
      }
    }
  }

  // ── Daemon fork: spawn detached child and return immediately ──
  if (daemonMode) {
    // Check if daemon is already running
    const existingPid = isDaemonRunning(projectRoot);
    if (existingPid !== null) {
      die(`Watch daemon is already running (PID ${existingPid}). Use 'ninthwave stop' first.`);
    }

    // Build child args: replace --daemon with --_daemon-child
    const childArgs = args.filter((a) => a !== "--daemon");
    childArgs.push("--_daemon-child");

    const { pid, logPath } = forkDaemon(childArgs, projectRoot);

    console.log(`Watch daemon started (PID ${pid})`);
    console.log(`  Log:   ${logPath}`);
    console.log(`  State: ${stateFilePath(projectRoot)}`);
    console.log(`  Stop:  ninthwave stop`);
    return;
  }

  // ── TUI mode setup ─────────────────────────────────────────────────
  // TUI mode: render live status table to stdout; redirect JSON logs to log file.
  // Enabled when stdout is a TTY and neither --json nor --_daemon-child is set.
  const tuiMode = detectTuiMode(isDaemonChild, jsonFlag, process.stdout.isTTY === true);

  // Shared log ring buffer for the TUI log panel.
  // Created here so the log closure can push entries before tuiState is constructed.
  const logBuffer: PanelLogEntry[] = [];

  // In TUI mode, redirect structured logs to the log file instead of stdout.
  // Also push each entry to the ring buffer for the live log panel.
  let log: (entry: LogEntry) => void = structuredLog;
  if (tuiMode) {
    const stateDir = userStateDir(projectRoot);
    mkdirSync(stateDir, { recursive: true });
    const tuiLogPath = logFilePath(projectRoot);
    log = (entry: LogEntry) => {
      appendFileSync(tuiLogPath, JSON.stringify(entry) + "\n");
      // Push to ring buffer for live TUI log panel
      const levelTag = entry.level !== "info" ? `[${entry.level}] ` : "";
      pushLogBuffer(logBuffer, {
        timestamp: entry.ts,
        itemId: (entry.itemId as string) ?? (entry.id as string) ?? "",
        message: `${levelTag}${entry.event}${entry.message ? ": " + entry.message : ""}`,
      });
    };
  }

  // Migrate runtime state from old .ninthwave/ to ~/.ninthwave/projects/<slug>/
  migrateRuntimeState(projectRoot);

  // Prevent duplicate orchestrator instances (foreground or daemon-child)
  const existingPid = isDaemonRunning(projectRoot);
  if (existingPid !== null && existingPid !== process.pid) {
    die(`Another watch daemon is already running (PID ${existingPid}). Use 'ninthwave stop' first, or kill the stale process.`);
  }

  // Compute memory-aware WIP default, allow --wip-limit to override
  const computedWipLimit = computeDefaultWipLimit();
  let wipLimit = wipLimitOverride ?? computedWipLimit;

  // Parse work items (needed for both interactive and flag-based modes)
  // Pass projectRoot to filter to only items pushed to origin/main
  const workItems = parseWorkItems(workDir, worktreeDir, projectRoot);

  // Interactive mode: no --items and stdin is a TTY
  let interactiveSkipReview = false;
  if (shouldEnterInteractive(itemIds.length > 0)) {
    // Pre-detect tools and config for TUI flow
    const installedTools = detectInstalledAITools();
    const preConfig = loadConfig(projectRoot);
    const userCfg = loadUserConfig();
    const skipToolStep = !!toolOverride || !!userCfg.ai_tool;
    const defaultReviewMode = preConfig.review_external ? "all" as const : "mine" as const;

    const result = await runInteractiveFlow(workItems, wipLimit, {
      defaultReviewMode,
      installedTools,
      savedToolId: preConfig.ai_tool,
      savedToolIds: preConfig.ai_tools,
      skipToolStep,
    });
    if (!result) {
      process.exit(0);
    }
    itemIds = result.itemIds;
    mergeStrategy = result.mergeStrategy;
    wipLimit = result.wipLimit;
    // Capture review mode from interactive selection
    if (result.reviewMode === "off") {
      interactiveSkipReview = true;
    }
    if (result.connectionAction) {
      if (result.connectionAction.type === "connect") {
        connectMode = true;
      } else if (result.connectionAction.type === "join") {
        crewCode = result.connectionAction.code;
      }
    }
    // Capture AI tool choice from TUI -- flows to selectAiTools via toolOverride
    if (result.aiTools && result.aiTools.length > 0) {
      toolOverride = result.aiTools.join(",");
    } else if (result.aiTool) {
      toolOverride = result.aiTool;
    }
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
      "Usage: ninthwave watch --items ID1 ID2 ... [--merge-strategy auto|manual] [--wip-limit N] [--poll-interval SECS] [--daemon] [--no-watch] [--watch-interval SECS]",
    );
  }

  // Apply custom GitHub token so daemon and workers use the configured identity
  applyGithubToken(projectRoot);

  const workItemMap = new Map<string, WorkItem>();
  for (const item of workItems) {
    workItemMap.set(item.id, item);
  }

  // Validate all items exist
  const unknownIds = validateItemIds(itemIds, workItemMap);
  if (unknownIds.length > 0) {
    die(`Item ${unknownIds[0]} not found in work item files`);
  }

  // Create orchestrator
  // skipReview: CLI --no-review, interactive "off" mode, or --review-wip-limit 0 disables AI review gate
  const skipReview = cliSkipReview || interactiveSkipReview || reviewWipLimit === 0;
  const orch = new Orchestrator({
    wipLimit,
    mergeStrategy,
    bypassEnabled,
    fixForward,
    skipReview,
    ...(tuiMode ? {} : { gracePeriodMs: 0 }),
    ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
  });
  for (const id of itemIds) {
    orch.addItem(workItemMap.get(id)!);
  }

  // Pre-create domain labels so workers don't need to (one API call per unique domain)
  const domainSet = new Set(itemIds.map(id => workItemMap.get(id)!.domain));
  if (fixForward) domainSet.add("verify");
  ensureDomainLabels(projectRoot, [...domainSet]);

  // Populate resolvedRepoRoot for cross-repo items
  for (const item of orch.getAllItems()) {
    const alias = item.workItem.repoAlias;
    if (alias && alias !== "self" && alias !== "hub") {
      try {
        item.resolvedRepoRoot = resolveRepo(alias, projectRoot);
      } catch {
        // Resolution failed -- if item has bootstrap: true, the orchestrator will
        // bootstrap the repo before launch (via the bootstrap action). Log the
        // deferred resolution. Non-bootstrap items stay hub-local as fallback.
        if (item.workItem.bootstrap) {
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

  // Real action dependencies -- create mux before state reconstruction so
  // workspace refs can be recovered from live workspaces.
  const mux = getMux();

  // Pre-flight: fail fast if the mux backend is not usable (binary missing
  // or no active session). Without this, workers launch and immediately fail
  // with misleading errors, wasting 10+ minutes in retry/stuck cycles.
  if (!mux.isAvailable()) {
    die(mux.diagnoseUnavailable());
  }

  let tmuxSessionName: string | undefined;
  let tmuxOutsideSession = false;
  if (mux.type === "tmux") {
    const tmuxInfo = getTmuxStartupInfo(projectRoot);
    tmuxSessionName = tmuxInfo.sessionName;
    tmuxOutsideSession = tmuxInfo.outsideTmuxSession;
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "tmux_session_resolved",
      sessionName: tmuxInfo.sessionName,
      outsideTmuxSession: tmuxInfo.outsideTmuxSession,
      termProgram: process.env.TERM_PROGRAM ?? null,
    });
    if (!jsonFlag && tmuxInfo.outsideTmuxSession) {
      for (const line of tmuxInfo.attachHintLines) {
        info(line);
      }
    }
  }

  // Prune stale git worktree registry entries (e.g., from copied repos or
  // crashed sessions). Safe no-op when nothing is stale.
  try {
    run("git", ["-C", projectRoot, "worktree", "prune"]);
  } catch { /* best-effort */ }

  // Clean orphaned worktrees before state reconstruction so stale worktrees
  // from previous runs don't confuse reconstructState or count toward WIP.
  cleanOrphanedWorktrees(workDir, worktreeDir, projectRoot, {
    getWorktreeIds: listWorktreeIds,
    getOpenItemIds: listOpenItemIds,
    cleanWorktree: (id, wtDir, root) => cleanSingleWorktree(id, wtDir, root),
    closeWorkspaceForItem: (itemId) => {
      const list = mux.listWorkspaces();
      if (!list) return;
      for (const line of list.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes(itemId)) continue;
        const match = trimmed.match(/workspace:\d+/);
        mux.closeWorkspace(match?.[0] ?? trimmed);
        return;
      }
    },
    log,
  });

  // Reconstruct state from disk + GitHub (crash recovery)
  // Pass saved daemon state so counters (ciFailCount, retryCount) survive restarts
  const savedDaemonState = readStateFile(projectRoot);
  reconstructState(orch, projectRoot, worktreeDir, mux, undefined, savedDaemonState);

  // Select AI tool(s) (interactive prompt when multiple tools installed)
  const isInteractive = !isDaemonChild && !daemonMode && process.stdin.isTTY === true;
  const aiTools = await selectAiTools({ toolOverride, projectRoot, isInteractive });
  const aiTool = aiTools[0]!;

  // Compute hub repo NWO once at startup for absolute agent-link URLs in PR comments
  let hubRepoNwo = "";
  try {
    hubRepoNwo = getRepoOwner(projectRoot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Could not determine hub repo NWO: ${msg}`);
  }

  const ctx: ExecutionContext = { projectRoot, worktreeDir, workDir, aiTool, aiTools, nextToolIndex: 0, hubRepoNwo };
  const actionDeps: OrchestratorDeps = {
    launchSingleItem: (item, workDir, worktreeDir, projectRoot, aiTool, baseBranch, forceWorkerLaunch) =>
      launchSingleItem(item, workDir, worktreeDir, projectRoot, aiTool, mux, { baseBranch, forceWorkerLaunch, hubRepoNwo }),
    cleanStaleBranch: (item, projRoot) => {
      let targetRepo: string;
      try {
        targetRepo = resolveRepo(item.repoAlias, projRoot);
      } catch {
        return; // Can't resolve repo -- launchSingleItem will handle the error
      }
      cleanStaleBranchForReuse(item.id, item.title, targetRepo);
    },
    cleanSingleWorktree,
    prMerge: (repoRoot, prNumber, options) => prMerge(repoRoot, prNumber, options),
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
    launchReview: (itemId, prNumber, repoRoot, implementerWorktreePath, itemAiTool) => {
      const autoFix = orch.config.reviewAutoFix;
      const result = launchReviewWorker(prNumber, itemId, autoFix, repoRoot, itemAiTool ?? aiTool, mux, { implementerWorktreePath, hubRepoNwo });
      if (!result) return null;
      return { workspaceRef: result.workspaceRef, verdictPath: result.verdictPath };
    },
    bootstrapRepo: (alias, projRoot) => bootstrapRepo(alias, projRoot),
    cleanReview: (itemId, reviewWorkspaceRef) => {
      // Close the review workspace
      try { mux.closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
      // Clean the review worktree if it exists (only for direct/pr modes)
      try {
        cleanSingleWorktree(`review-${itemId}`, join(projectRoot, ".ninthwave", ".worktrees"), projectRoot);
      } catch { /* best-effort -- review worktree may not exist for off mode */ }
      return true;
    },
    launchRebaser: (itemId, prNumber, repoRoot, itemAiTool) => {
      const result = launchRebaserWorker(prNumber, itemId, repoRoot, itemAiTool ?? aiTool, mux, { hubRepoNwo });
      if (!result) return null;
      return { workspaceRef: result.workspaceRef };
    },
    cleanRebaser: (itemId, rebaserWorkspaceRef) => {
      try { mux.closeWorkspace(rebaserWorkspaceRef); } catch { /* best-effort */ }
      return true;
    },
    setCommitStatus: (repoRoot, prNumber, state, context, description) => {
      const sha = prHeadSha(repoRoot, prNumber);
      if (!sha) return false;
      return ghSetCommitStatus(repoRoot, sha, state, context, description);
    },
    getMergeCommitSha: (repoRoot, prNumber) => ghGetMergeCommitSha(repoRoot, prNumber),
    checkCommitCI: (repoRoot, sha) => ghCheckCommitCI(repoRoot, sha),
    launchForwardFixer: (itemId, mergeCommitSha, repoRoot, itemAiTool) => {
      const result = launchForwardFixerWorker(itemId, mergeCommitSha, repoRoot, itemAiTool ?? aiTool, mux, { hubRepoNwo });
      if (!result) return null;
      return { worktreePath: result.worktreePath, workspaceRef: result.workspaceRef };
    },
    cleanForwardFixer: (itemId, fixForwardWorkspaceRef) => {
      try { mux.closeWorkspace(fixForwardWorkspaceRef); } catch { /* best-effort */ }
      try {
        cleanSingleWorktree(`ninthwave-fix-forward-${itemId}`, join(projectRoot, ".ninthwave", ".worktrees"), projectRoot);
      } catch { /* best-effort -- forward-fixer worktree may already be cleaned */ }
      return true;
    },
  };

  // ── Crew mode setup ──────────────────────────────────────────────
  let crewBroker: CrewBroker | undefined;

  // Resolve git remote URL for crew repo verification
  let crewRepoUrl = "";
  try {
    const { execSync } = await import("child_process");
    crewRepoUrl = execSync("git remote get-url origin", { cwd: projectRoot, encoding: "utf-8" }).trim();
  } catch {
    // No git remote available
  }

  // Load saved crew code for persistent sessions
  const savedCrewCode = readCrewCode(projectRoot);
  if (!crewCode && !connectMode && savedCrewCode) {
    // Re-activate saved crew via POST /api/crews with code field
    info("Re-activating saved session...");
    const brokerBaseUrl = crewUrl ?? "https://ninthwave.sh";
    const httpUrl = brokerBaseUrl.replace(/^wss?:\/\//, "https://");
    try {
      const res = await fetch(`${httpUrl}/api/crews`, {
        method: "POST",
        body: JSON.stringify({ repoUrl: crewRepoUrl, code: savedCrewCode }),
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as { code: string };
        crewCode = body.code;
        if (!crewUrl) crewUrl = "wss://ninthwave.sh";
        info(`Session re-activated: ${crewCode}`);
      } else {
        info("Saved session code expired, starting local.");
      }
    } catch {
      info("Could not reach ninthwave.sh, starting local.");
    }
  }

  if (connectMode && !crewCode) {
    info("Connecting to ninthwave.sh...");
    const brokerBaseUrl = crewUrl ?? "https://ninthwave.sh";
    const httpUrl = brokerBaseUrl.replace(/^wss?:\/\//, "https://");
    const res = await fetch(`${httpUrl}/api/crews`, {
      method: "POST",
      body: JSON.stringify({ repoUrl: crewRepoUrl }),
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      die(`Failed to create session: ${res.status} ${body}`);
    }
    const body = (await res.json()) as { code: string };
    crewCode = body.code;
    if (!crewUrl) crewUrl = "wss://ninthwave.sh";
    info(`Session created: ${crewCode}`);
    info(`  Invite: nw watch --crew ${crewCode}`);
  }

  let resolvedCrewName: string | undefined;
  if (crewCode) {
    if (!crewUrl) {
      crewUrl = "wss://ninthwave.sh";
    }
    resolvedCrewName = crewName ?? (await import("os")).hostname();
    info(`Connecting to ninthwave.sh (${crewCode})...`);
    const broker = new WebSocketCrewBroker(projectRoot, crewUrl, crewCode, crewRepoUrl, {
      log: (level, msg) => log({ ts: new Date().toISOString(), level, event: "crew_client", message: msg }),
    }, resolvedCrewName);

    try {
      await broker.connect();
      info(`Connected to ninthwave.sh as "${resolvedCrewName}"`);
    } catch (err) {
      die(`Failed to connect to crew server: ${(err as Error).message}`);
    }
    crewBroker = broker;
    saveCrewCode(projectRoot, crewCode);
  }

  /** Get IDs of items claimed by other crew members (for remote indicator in TUI). */
  function getRemoteItemIds(): Set<string> | undefined {
    if (!crewBroker) return undefined;
    const status = crewBroker.getCrewStatus();
    if (!status?.claimedItems?.length) return undefined;
    return new Set(status.claimedItems);
  }

  // Graceful SIGINT handling
  const abortController = new AbortController();
  const sigintHandler = () => {
    log({ ts: new Date().toISOString(), level: "info", event: "sigint_received" });
    crewBroker?.disconnect();
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  // Graceful SIGTERM handling (used by daemon mode for clean shutdown)
  const sigtermHandler = () => {
    log({ ts: new Date().toISOString(), level: "info", event: "sigterm_received" });
    crewBroker?.disconnect();
    abortController.abort();
  };
  process.on("SIGTERM", sigtermHandler);

  // Resolve config-file flags
  const projectConfig = loadConfig(projectRoot);
  // --review-wip-limit 0 explicitly disables reviews, overriding config
  const reviewExternalEnabled = reviewWipLimit === 0
    ? false
    : (reviewExternal || projectConfig.review_external);
  const scheduleEnabled = projectConfig.schedule_enabled;

  // Resolve telemetry: connected mode implies consent; env var and config override
  let telemetryEnabled = false;
  if (process.env.NW_TELEMETRY === "1") {
    telemetryEnabled = true;
  } else if (projectConfig.telemetry !== undefined) {
    telemetryEnabled = projectConfig.telemetry;
  } else if (crewBroker) {
    // Connected to ninthwave.sh -- telemetry is implied by connection choice
    telemetryEnabled = true;
    saveConfig(projectRoot, { telemetry: true });
  }
  if (telemetryEnabled && crewBroker) {
    crewBroker.setTelemetry(true);
  }

  // State persistence: serialize state each poll cycle so the status pane can display all items.
  // Written in both daemon and interactive mode -- the status pane reads this file to show
  // the full queue including queued items that don't have worktrees yet.
  // statusPaneRef is captured by reference so the closure always persists the current value.
  const daemonStartedAt = new Date().toISOString();

  // Resolve operator identity (git email) for this daemon session.
  // Persisted to state dir so it survives restarts.
  const operatorId = resolveOperatorId(projectRoot);

  // Clean stale state from previous run and write a fresh initial state.
  // This ensures `ninthwave status` never shows items from a previous run mixed
  // with the current run -- even before the first poll cycle completes.
  cleanStateFile(projectRoot);
  const initialState = serializeOrchestratorState(orch.getAllItems(), process.pid, daemonStartedAt, {
    wipLimit,
    operatorId,
  });
  writeStateFile(projectRoot, initialState);

  // TUI state: scroll offset and view option toggles (shared with keyboard handler)
  // Read persisted layout preference (defaults to "split" if missing/corrupt)
  const savedPanelMode = tuiMode ? readLayoutPreference(projectRoot) : "split";

  let lastTuiItems: OrchestratorItem[] = orch.getAllItems();
  const tuiState: TuiState = {
    scrollOffset: 0,
    viewOptions: {
      showBlockerDetail: true,
      sessionStartedAt: daemonStartedAt,
      mergeStrategy: orch.config.mergeStrategy,
    },
    mergeStrategy: orch.config.mergeStrategy,
    bypassEnabled: orch.config.bypassEnabled,
    ctrlCPending: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    panelMode: savedPanelMode,
    logBuffer,
    logScrollOffset: 0,
    logLevelFilter: "all",
    selectedIndex: 0,
    detailItemId: null,
    savedLogScrollOffset: 0,
    getSelectedItemId: (index: number) => {
      const items = orchestratorItemsToStatusItems(lastTuiItems, getRemoteItemIds(), orch.config.maxTimeoutExtensions);
      const nonQueued = items.filter((i) => i.state !== "queued");
      return nonQueued[index]?.id;
    },
    getItemCount: () => {
      const items = orchestratorItemsToStatusItems(lastTuiItems, getRemoteItemIds(), orch.config.maxTimeoutExtensions);
      return items.filter((i) => i.state !== "queued").length;
    },
    onExtendTimeout: (itemId) => orch.extendTimeout(itemId),
    onStrategyChange: (strategy) => {
      orch.setMergeStrategy(strategy);
    },
    onPanelModeChange: (mode) => {
      writeLayoutPreference(projectRoot, mode);
    },
    // Immediate re-render on keypress (doesn't wait for poll cycle)
    onUpdate: () => {
      if (tuiMode) {
        try {
          renderTuiPanelFrame(lastTuiItems, wipLimit, tuiState, undefined, getRemoteItemIds(), orch.config.maxTimeoutExtensions);
        } catch {
          // Non-fatal
        }
      }
    },
    sessionCode: crewCode ?? undefined,
    tmuxSessionName: tmuxOutsideSession ? tmuxSessionName : undefined,
  };

  const onPollComplete = (items: OrchestratorItem[], _pollIntervalMs?: number) => {
    lastTuiItems = items;
    // Update crew status from broker
    if (crewBroker && crewCode) {
      const cs = crewBroker.getCrewStatus();
      tuiState.viewOptions.crewStatus = {
        crewCode: cs?.crewCode ?? crewCode,
        daemonCount: cs?.daemonCount ?? 0,
        availableCount: cs?.availableCount ?? 0,
        claimedCount: cs?.claimedCount ?? 0,
        completedCount: cs?.completedCount ?? 0,
        connected: crewBroker.isConnected(),
      };
    }
    try {
      const state = serializeOrchestratorState(items, process.pid, daemonStartedAt, {
        statusPaneRef: null,
        wipLimit,
        operatorId,
      });
      writeStateFile(projectRoot, state);
    } catch {
      // Non-fatal -- state persistence failure shouldn't block the orchestrator
    }
    // TUI mode: render panel frame to stdout after each poll cycle
    if (tuiMode) {
      // Populate schedule worker status for TUI display
      if (scheduleLoopDeps) {
        try {
          const schedState = readScheduleState(projectRoot);
          tuiState.viewOptions.scheduleWorkers = schedState.active.map((w) => ({
            taskId: w.taskId,
            startedAt: w.startedAt,
          }));
        } catch {
          tuiState.viewOptions.scheduleWorkers = [];
        }
      }
      try {
        renderTuiPanelFrame(items, wipLimit, tuiState, undefined, getRemoteItemIds(), orch.config.maxTimeoutExtensions);
      } catch {
        // Non-fatal -- TUI render failure shouldn't block the orchestrator
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
            hubRepoNwo,
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

  // Build schedule deps when schedule_enabled and no crew broker (solo mode only)
  const schedulesDir = join(projectRoot, ".ninthwave", "schedules");
  const scheduleLoopDeps: ScheduleLoopDeps | undefined = (scheduleEnabled && !crewBroker)
    ? {
        listScheduledTasks: () => listScheduledTasksFromDir(schedulesDir),
        readState: readScheduleState,
        writeState: writeScheduleState,
        launchWorker: (task, pr, ai) => launchScheduledTask(task, pr, ai, {
          launchWorkspace: (cwd, cmd, todoId) => mux.launchWorkspace(cwd, cmd, todoId),
        }),
        monitorDeps: {
          listWorkspaces: () => mux.listWorkspaces(),
          closeWorkspace: (ref) => mux.closeWorkspace(ref),
        },
        aiTool,
        triggerDir: scheduleTriggerDir(projectRoot),
      }
    : undefined;

  if (scheduleLoopDeps) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "schedule_enabled",
      schedulesDir,
    });
  }

  const loopDeps: OrchestrateLoopDeps = {
    buildSnapshot: (o, pr, wd) => buildSnapshotAsync(o, pr, wd, mux, undefined, undefined, fetchTrustedPrCommentsAsync, ghCheckCommitCIAsync),
    sleep: (ms) => interruptibleSleep(ms, abortController.signal),
    log,
    actionDeps,
    getFreeMem: getAvailableMemory,
    reconcile,
    readScreen: (ref, lines) => mux.readScreen(ref, lines),
    onPollComplete,
    syncDisplay: (o, snap) => {
      syncWorkerDisplay(o, snap, mux);
      tuiState.viewOptions.apiErrorCount = snap.apiErrorCount ?? 0;
    },
    externalReviewDeps,
    ...(watchMode ? { scanWorkItems: () => {
      try { fetchOrigin(projectRoot, "main"); } catch { /* non-fatal */ }
      try { ffMerge(projectRoot, "main"); } catch { /* non-fatal -- dirty tree or diverged */ }
      return parseWorkItems(workDir, worktreeDir, projectRoot);
    } } : {}),
    ...(crewBroker ? { crewBroker } : {}),
    ...(scheduleLoopDeps ? { scheduleDeps: scheduleLoopDeps } : {}),
    // Completion prompt for TUI mode: render banner + wait for keypress
    ...(tuiMode ? {
      completionPrompt: async (allItems, runStartTime, costData) => {
        // Remove the orchestrate keyboard handler so keys are routed to the prompt
        cleanupKeyboard();
        // Render the completion banner on screen
        const bannerLines = formatCompletionBanner(allItems, runStartTime, costData);
        const write = (s: string) => process.stdout.write(s);
        write("\x1B[H"); // cursor home
        // Re-render the current TUI frame first (to show final state)
        renderTuiPanelFrame(allItems, wipLimit, tuiState, write, getRemoteItemIds());
        // Overlay the banner at the bottom
        const termRows = getTerminalHeight();
        const startRow = Math.max(1, termRows - bannerLines.length);
        write(`\x1B[${startRow};1H`);
        for (const line of bannerLines) {
          write(line + "\x1B[K\n");
        }
        // Wait for completion key
        const action = await waitForCompletionKey(process.stdin, abortController.signal);
        // Restore the keyboard handler if we're continuing (run-more)
        if (action === "run-more") {
          cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
        }
        return action;
      },
    } : {}),
  };

  // Resolve repo URL for PR URL construction in completion event
  let repoUrl: string | undefined;
  try {
    const ownerRepo = getRepoOwner(projectRoot);
    repoUrl = `https://github.com/${ownerRepo}`;
  } catch {
    // Non-fatal -- PR URLs will be null in completion event
  }

  const loopConfig: OrchestrateLoopConfig = {
    ...(pollIntervalOverride ? { pollIntervalMs: pollIntervalOverride } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    aiTool,
    ...(reviewExternalEnabled ? { reviewExternal: true } : {}),
    ...(watchMode ? { watch: true } : {}),
    ...(watchIntervalSecs !== undefined ? { watchIntervalMs: watchIntervalSecs * 1000 } : {}),
    ...(tuiMode ? { tuiMode: true } : {}),
  };

  // Set up keyboard shortcuts in TUI mode (q, Ctrl-C, m, d, ?, ↑/↓)
  let cleanupKeyboard = () => {};
  if (tuiMode) {
    cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
  }

  // Enter alternate screen buffer so TUI renders don't pollute terminal scrollback.
  // The matching ALT_SCREEN_OFF is in the finally block below + a process.on('exit') safety net.
  if (tuiMode) {
    process.stdout.write(ALT_SCREEN_ON);
  }
  const exitAltScreen = () => {
    if (tuiMode) process.stdout.write(ALT_SCREEN_OFF);
  };
  process.on("exit", exitAltScreen);

  // Show session splash screen on startup (auto-dismisses after 3s or any keypress)
  if (tuiMode && crewCode) {
    const termWidth = getTerminalWidth();
    const termRows = getTerminalHeight();
    const BRAND_ANSI = "\x1B[38;2;212;160;48m"; // #D4A030
    const lines: string[] = [];
    const centerLine = (text: string, plainLen: number) => {
      const pad = Math.max(0, Math.floor((termWidth - plainLen) / 2));
      return " ".repeat(pad) + text;
    };
    const midRow = Math.floor(termRows / 2) - 3;
    for (let i = 0; i < midRow; i++) lines.push("");
    lines.push(centerLine(`\x1B[1m${BRAND_ANSI}${crewCode}\x1B[0m`, crewCode.length));
    lines.push("");
    const dashboardUrl = `ninthwave.sh/stats/${crewCode}`;
    lines.push(centerLine(`\x1B[2m${dashboardUrl}\x1B[0m`, dashboardUrl.length));
    const inviteCmd = `Invite: nw watch --crew ${crewCode}`;
    lines.push(centerLine(`\x1B[2m${inviteCmd}\x1B[0m`, inviteCmd.length));
    lines.push("");
    lines.push(centerLine("\x1B[2mPress ? for help\x1B[0m", 16));
    process.stdout.write("\x1B[H" + lines.join("\x1B[K\n") + "\x1B[J");

    // Auto-dismiss after 3s or any keypress (whichever first)
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      new Promise<void>((resolve) => {
        const onData = () => {
          process.stdin.removeListener("data", onData);
          resolve();
        };
        process.stdin.on("data", onData);
      }),
    ]);
  }

  // Show tmux attach splash screen on startup (dismissed by any keypress)
  if (tuiMode && tmuxOutsideSession && tmuxSessionName) {
    const termWidth = getTerminalWidth();
    const termRows = getTerminalHeight();
    const lines: string[] = [];
    const centerLine = (text: string, plainLen: number) => {
      const pad = Math.max(0, Math.floor((termWidth - plainLen) / 2));
      return " ".repeat(pad) + text;
    };
    const attachCmd = `tmux attach -t ${tmuxSessionName}`;
    const midRow = Math.floor(termRows / 2) - 2;
    for (let i = 0; i < midRow; i++) lines.push("");
    lines.push(centerLine(`\x1B[1m\x1B[36m${attachCmd}\x1B[0m`, attachCmd.length));
    lines.push("");
    lines.push(centerLine("\x1B[2mPress ? for help  |  Press any key to continue\x1B[0m", 47));
    process.stdout.write("\x1B[H" + lines.join("\x1B[K\n") + "\x1B[J");

    await new Promise<void>((resolve) => {
      const onData = () => {
        process.stdin.removeListener("data", onData);
        resolve();
      };
      process.stdin.on("data", onData);
    });
  }

  // Write PID file for foreground mode too (prevents duplicate instances)
  if (!isDaemonChild) {
    writePidFile(projectRoot, process.pid);
  }

  try {
    // Run-more loop: re-enter interactive flow when the user picks [r] at the completion prompt
    let keepRunning = true;
    while (keepRunning) {
      const result = await orchestrateLoop(
        orch,
        ctx,
        loopDeps,
        loopConfig,
        abortController.signal,
      );

      if (result.completionAction === "run-more" && tuiMode) {
        // Release keyboard shortcuts so TUI widgets can handle raw keys
        cleanupKeyboard();

        // Re-parse work items and re-enter interactive selection
        // Widgets render in the same alt-screen buffer -- no screen switch needed
        // showConnectionStep: false because session is already established
        const freshItems = parseWorkItems(workDir, worktreeDir, projectRoot);
        const interactiveResult = await runInteractiveFlow(freshItems, wipLimit, {
          showConnectionStep: false,
          skipToolStep: true,
        });
        if (!interactiveResult) {
          // User cancelled selection -- restore keyboard and exit loop
          cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
          break;
        }

        // Add newly selected items to the orchestrator
        const freshMap = new Map<string, WorkItem>();
        for (const item of freshItems) freshMap.set(item.id, item);
        const newDomains = new Set<string>();
        for (const id of interactiveResult.itemIds) {
          const wi = freshMap.get(id);
          if (wi && !orch.getItem(id)) {
            orch.addItem(wi);
            newDomains.add(wi.domain);
          }
        }
        if (newDomains.size > 0) ensureDomainLabels(projectRoot, [...newDomains]);
        wipLimit = interactiveResult.wipLimit;
        mergeStrategy = interactiveResult.mergeStrategy;
        orch.setMergeStrategy(mergeStrategy);

        // Update review config based on user's review mode selection
        if (interactiveResult.reviewMode === "all") {
          loopConfig.reviewExternal = true;
          orch.setSkipReview(false);
        } else if (interactiveResult.reviewMode === "off") {
          loopConfig.reviewExternal = false;
          orch.setSkipReview(true);
        } else {
          // "items" mode: review work items only, not external PRs
          orch.setSkipReview(false);
        }

        // Restore keyboard shortcuts for the main TUI
        cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);

        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "run_more_restart",
          newItems: interactiveResult.itemIds,
          reviewMode: interactiveResult.reviewMode,
        });
        continue; // Restart the orchestrate loop
      }

      keepRunning = false;
    }
  } finally {
    // Close workspaces for terminal items only (done, stuck, merged).
    // In-flight workers (implementing, ci-pending, etc.) may still be actively
    // running -- leave their workspaces open so they survive orchestrator restarts.
    // On restart, reconstructState recovers their workspace refs.
    const terminalStates = new Set(["done", "stuck", "merged"]);
    const closedWorkspaces: string[] = [];
    for (const item of orch.getAllItems()) {
      if (terminalStates.has(item.state) && item.workspaceRef) {
        try {
          mux.closeWorkspace(item.workspaceRef);
          closedWorkspaces.push(item.id);
        } catch {
          // Non-fatal -- best-effort cleanup
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

    // Leave alternate screen buffer before restoring terminal state
    exitAltScreen();
    process.removeListener("exit", exitAltScreen);

    // Print exit summary to stdout (persists in terminal scrollback)
    if (tuiMode) {
      const allItems = orch.getAllItems();
      if (allItems.length > 0) {
        const summary = formatExitSummary(allItems, daemonStartedAt);
        console.log(summary);
      }
    }

    // Restore terminal state (disable raw mode)
    cleanupKeyboard();

    // Clean up crew broker
    if (crewBroker) {
      try { crewBroker.disconnect(); } catch { /* best-effort */ }
    }

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
