// orchestrate command: event loop for parallel work item processing.
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
import { parseWorkItems } from "../parser.ts";
import { resolveRepo, getWorktreeInfo, bootstrapRepo } from "../cross-repo.ts";
import { checkPrStatus, checkPrStatusAsync, scanExternalPRs } from "./pr-monitor.ts";
import { launchSingleItem, launchReviewWorker, launchRepairWorker, launchVerifierWorker, detectAiTool, cleanStaleBranchForReuse } from "./launch.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { prMerge, prComment, checkPrMergeable, getRepoOwner, applyGithubToken, fetchTrustedPrComments, upsertOrchestratorComment, setCommitStatus as ghSetCommitStatus, prHeadSha, getMergeCommitSha as ghGetMergeCommitSha, checkCommitCI as ghCheckCommitCI } from "../gh.ts";
import { fetchOrigin, ffMerge, gitAdd, gitCommit, gitPush, daemonRebase } from "../git.ts";
import { type Multiplexer, getMux } from "../mux.ts";
import { reconcile } from "./reconcile.ts";
import { die, warn, info, ALT_SCREEN_ON, ALT_SCREEN_OFF } from "../output.ts";
import { confirmPrompt } from "../prompt.ts";
import { shouldEnterInteractive, runInteractiveFlow } from "../interactive.ts";
import type { WorkItem } from "../types.ts";
import { ID_IN_FILENAME, PRIORITY_NUM } from "../types.ts";
import { prTitleMatchesWorkItem } from "../work-item-utils.ts";
import { loadConfig } from "../config.ts";
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
  readHeartbeat,
  readVerdictFile,
  logFilePath,
  stateFilePath,
  userStateDir,
  migrateRuntimeState,
  rotateLogs,
  readLayoutPreference,
  writeLayoutPreference,
  type DaemonIO,
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
  clampScrollOffset,
  buildPanelLayout,
  renderPanelFrame,
  formatItemDetail,
  MIN_FULLSCREEN_ROWS,
  MIN_SPLIT_ROWS,
  type StatusItem,
  type ViewOptions,
  type CrewStatusInfo,
  type PanelMode,
  type LogEntry as PanelLogEntry,
} from "../status-render.ts";
import type { CrewBroker, CrewStatus, SyncItem } from "../crew.ts";
import { WebSocketCrewBroker, getOrCreateDaemonId, resolveOperatorId } from "../crew.ts";
import { MockBroker } from "../mock-broker.ts";
import { AuthorCache } from "../git-author.ts";
import type { ScheduledTask } from "../types.ts";
import type { ScheduleState, ScheduleWorkerEntry } from "../schedule-state.ts";
import {
  readScheduleState,
  writeScheduleState,
} from "../schedule-state.ts";
import {
  checkSchedules,
  processScheduleQueue,
  launchScheduledTask,
  monitorScheduleWorkers,
  processTriggerFiles,
  scheduleTriggerDir,
  type MonitorScheduleDeps,
} from "../schedule-runner.ts";
import { listScheduledTasks as listScheduledTasksFromDir } from "../schedule-files.ts";
import {
  appendHistoryEntry,
  type ScheduleHistoryIO,
} from "../schedule-history.ts";

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

// ── Log ring buffer ────────────────────────────────────────────────

/** Maximum number of log entries retained in the ring buffer for the TUI log panel. */
export const LOG_BUFFER_MAX = 500;

/** Log level filter cycle order for the `l` keyboard shortcut. */
export type LogLevelFilter = "info" | "warn" | "error" | "all";

/** The cycle order for log level filter. */
const LOG_LEVEL_CYCLE: LogLevelFilter[] = ["info", "warn", "error", "all"];

/** Severity ordering for log level filtering. */
const LOG_LEVEL_SEVERITY: Record<string, number> = {
  error: 3,
  warn: 2,
  info: 1,
  debug: 0,
};

/**
 * Push a log entry into the ring buffer, dropping the oldest entry when at capacity.
 * Mutates the buffer in-place for efficiency.
 */
export function pushLogBuffer(buffer: PanelLogEntry[], entry: PanelLogEntry): void {
  buffer.push(entry);
  if (buffer.length > LOG_BUFFER_MAX) {
    buffer.splice(0, buffer.length - LOG_BUFFER_MAX);
  }
}

/**
 * Filter log entries by level.
 * "all" returns everything. Otherwise returns entries at or above the given severity.
 */
export function filterLogsByLevel(buffer: PanelLogEntry[], filter: LogLevelFilter): PanelLogEntry[] {
  if (filter === "all") return buffer;
  const minSeverity = LOG_LEVEL_SEVERITY[filter] ?? 0;
  // PanelLogEntry doesn't have a level field -- we encode it in the message prefix.
  // We'll match by checking if the message starts with a level tag like "[error]" or "[warn]".
  // If no tag is found, assume "info" level.
  return buffer.filter((entry) => {
    const level = extractLogLevel(entry.message);
    return (LOG_LEVEL_SEVERITY[level] ?? 1) >= minSeverity;
  });
}

/**
 * Extract the log level from a message string.
 * Messages may be prefixed with [error], [warn], [info], [debug].
 * Falls back to "info" if no prefix found.
 */
function extractLogLevel(message: string): string {
  const match = message.match(/^\[(error|warn|info|debug)\]\s*/);
  return match ? match[1]! : "info";
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
 * When crewDaemonName is provided, sets daemonName on items ("local" for self, daemon name for claimed, "--" for unclaimed).
 */
export function orchestratorItemsToStatusItems(
  items: OrchestratorItem[],
  crewDaemonName?: string,
): StatusItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.workItem.title,
    state: mapDaemonItemState(item.state),
    prNumber: item.prNumber ?? null,
    ageMs: Date.now() - new Date(item.lastTransition).getTime(),
    repoLabel: item.resolvedRepoRoot ? basename(item.resolvedRepoRoot) : "",
    failureReason: item.failureReason,
    dependencies: item.workItem.dependencies ?? [],
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    exitCode: item.exitCode,
    stderrTail: item.stderrTail,
    ...(crewDaemonName !== undefined ? {
      daemonName: crewDaemonName === "local" ? "local" :
        (item.workspaceRef ? crewDaemonName : "--"),
    } : {}),
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
  crewDaemonName?: string,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, crewDaemonName);
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();

  write("\x1B[H");

  if (viewOptions?.showHelp) {
    // Render help overlay instead of the normal frame
    const helpLines = renderHelpOverlay(termWidth, termRows);
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
  crewDaemonName?: string,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, crewDaemonName);
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();

  write("\x1B[H");

  if (tuiState.viewOptions.showHelp) {
    // Render help overlay instead of the panel frame
    const helpLines = renderHelpOverlay(termWidth, termRows);
    const content = helpLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else {
    const filteredLogs = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);

    // Generate detail lines if an item is selected for detail view
    let detailLines: string[] | undefined;
    if (tuiState.detailItemId) {
      const detailStatusItem = statusItems.find((i) => i.id === tuiState.detailItemId);
      if (detailStatusItem) {
        detailLines = formatItemDetail(detailStatusItem, {
          repoUrl: tuiState.viewOptions.repoUrl,
        });
      } else {
        // Item no longer exists -- clear detail view
        tuiState.detailItemId = null;
      }
    }

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
        detailLines,
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
      const helpLines = renderHelpOverlay(termWidth, termRows);
      const content = helpLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    } else {
      const filteredLogs = filterLogsByLevel(logBuffer, tuiState.logLevelFilter);

      // Generate detail lines if an item is selected for detail view
      let detailLines: string[] | undefined;
      if (tuiState.detailItemId) {
        const detailItem = data.items.find((i) => i.id === tuiState.detailItemId);
        if (detailItem) {
          detailLines = formatItemDetail(detailItem, {
            repoUrl: tuiState.viewOptions.repoUrl,
          });
        } else {
          tuiState.detailItemId = null;
        }
      }

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
          detailLines,
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
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "merging", "pr-open"]);

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
    if ((orchItem.state === "verifying" || orchItem.state === "verify-failed") && orchItem.mergeCommitSha) {
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
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.reviewWorkspaceRef } as OrchestratorItem,
        mux,
      );
      if (orchItem.reviewVerdictPath) {
        try {
          snap.reviewVerdict = readVerdictFile(orchItem.reviewVerdictPath) ?? undefined;
        } catch { /* best-effort -- verdict read failure doesn't block polling */ }
      }
    }

    // Check repair worker health for items in repairing state
    if (orchItem.state === "repairing" && orchItem.repairWorkspaceRef) {
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.repairWorkspaceRef } as OrchestratorItem,
        mux,
      );
    }

    // Check verifier worker health for items in repairing-main state
    if (orchItem.state === "repairing-main" && orchItem.verifyWorkspaceRef) {
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.verifyWorkspaceRef } as OrchestratorItem,
        mux,
      );
    }

    // Check worker alive and commit freshness for active items
    if (orchItem.state === "launching" || orchItem.state === "implementing" || orchItem.state === "ci-failed") {
      snap.workerAlive = isWorkerAlive(orchItem, mux);
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
      const commentRelayStates = new Set(["pr-open", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing"]);
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

  return { items, readyIds };
}

/**
 * Async variant of buildSnapshot. Uses checkPrStatusAsync so each gh CLI
 * call yields to the event loop, keeping keyboard events responsive.
 *
 * Same snapshot assembly logic as the sync version. Non-gh operations
 * (heartbeat reads, worker-alive checks) remain synchronous since they
 * are local filesystem/process operations that complete instantly.
 */
export async function buildSnapshotAsync(
  orch: Orchestrator,
  projectRoot: string,
  _worktreeDir: string,
  mux: Multiplexer = getMux(),
  getLastCommitTime: (projectRoot: string, branchName: string) => string | null = getWorktreeLastCommitTime,
  checkPr: (id: string, projectRoot: string) => Promise<string | null> = checkPrStatusAsync,
  fetchComments?: (repoRoot: string, prNumber: number, since: string) => Array<{ body: string; author: string; createdAt: string }>,
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending",
): Promise<PollSnapshot> {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];
  const heartbeatStates = new Set(["launching", "implementing", "ci-failed", "ci-pending", "ci-passed", "review-pending", "merging", "pr-open"]);

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
    if ((orchItem.state === "verifying" || orchItem.state === "verify-failed") && orchItem.mergeCommitSha) {
      const snap: ItemSnapshot = { id: orchItem.id };
      if (checkCommitCI) {
        const repoRoot = orchItem.resolvedRepoRoot ?? projectRoot;
        try {
          snap.mergeCommitCIStatus = checkCommitCI(repoRoot, orchItem.mergeCommitSha);
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
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.reviewWorkspaceRef } as OrchestratorItem,
        mux,
      );
      if (orchItem.reviewVerdictPath) {
        try {
          snap.reviewVerdict = readVerdictFile(orchItem.reviewVerdictPath) ?? undefined;
        } catch { /* best-effort */ }
      }
    }

    // Repair worker health
    if (orchItem.state === "repairing" && orchItem.repairWorkspaceRef) {
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.repairWorkspaceRef } as OrchestratorItem,
        mux,
      );
    }

    // Verifier worker health
    if (orchItem.state === "repairing-main" && orchItem.verifyWorkspaceRef) {
      snap.workerAlive = isWorkerAlive(
        { ...orchItem, workspaceRef: orchItem.verifyWorkspaceRef } as OrchestratorItem,
        mux,
      );
    }

    // Worker alive and commit freshness
    if (orchItem.state === "launching" || orchItem.state === "implementing" || orchItem.state === "ci-failed") {
      snap.workerAlive = isWorkerAlive(orchItem, mux);
      const commitTime = getLastCommitTime(repoRoot, `ninthwave/${orchItem.id}`);
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
      const commentRelayStates = new Set(["pr-open", "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing"]);
      if (commentRelayStates.has(orchItem.state)) {
        const since = orchItem.lastCommentCheck || orchItem.lastTransition;
        try {
          const comments = fetchComments(repoRoot, orchItem.prNumber, since);
          if (comments.length > 0) {
            snap.newComments = comments;
          }
        } catch { /* best-effort */ }
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
 * Ownership split:
 * - Status pill (orchestrator-owned): lifecycle state text/icon/color
 * - Progress bar (worker-primary, orchestrator-fallback):
 *   - Worker-active states (implementing, launching, ci-failed): heartbeat pass-through, default 0%
 *   - Worker-idle states (ci-pending, pr-open, ci-passed, review-pending, merging): 100%, no label
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

// ── External PR review processing ─────────────────────────────────

/** Author associations with write access -- only review PRs from trusted contributors. */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** Label that causes a PR to be skipped for external review. */
const SKIP_REVIEW_LABEL = "ninthwave: skip-review";

/** Dependencies for processExternalReviews, injectable for testing. */
export interface ExternalReviewDeps {
  scanExternalPRs: (repoRoot: string) => import("./pr-monitor.ts").ExternalPR[];
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

    // New PR -- add to tracking
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
      // PR was closed or merged -- clean up
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
 * item stuck -- even if the worker is actively running.
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
  const savedItems = new Map<string, { ciFailCount: number; retryCount: number; reviewWorkspaceRef?: string; reviewCompleted?: boolean; reviewRound?: number; lastCommentCheck?: string; rebaseRequested?: boolean; ciFailureNotified?: boolean; ciFailureNotifiedAt?: string | null; repairWorkspaceRef?: string; mergeCommitSha?: string; verifyFailCount?: number; verifyWorkspaceRef?: string }>();
  if (daemonState?.items) {
    for (const si of daemonState.items) {
      savedItems.set(si.id, {
        ciFailCount: si.ciFailCount,
        retryCount: si.retryCount,
        reviewWorkspaceRef: si.reviewWorkspaceRef,
        reviewCompleted: si.reviewCompleted,
        reviewRound: si.reviewRound,
        lastCommentCheck: si.lastCommentCheck,
        rebaseRequested: si.rebaseRequested,
        ciFailureNotified: si.ciFailureNotified,
        ciFailureNotifiedAt: si.ciFailureNotifiedAt,
        repairWorkspaceRef: si.repairWorkspaceRef,
        mergeCommitSha: si.mergeCommitSha,
        verifyFailCount: si.verifyFailCount,
        verifyWorkspaceRef: si.verifyWorkspaceRef,
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
      if (saved.reviewRound != null) item.reviewRound = saved.reviewRound;
      if (saved.lastCommentCheck) item.lastCommentCheck = saved.lastCommentCheck;
      if (saved.rebaseRequested) item.rebaseRequested = saved.rebaseRequested;
      if (saved.ciFailureNotified) item.ciFailureNotified = saved.ciFailureNotified;
      if (saved.ciFailureNotifiedAt) item.ciFailureNotifiedAt = saved.ciFailureNotifiedAt;
      if (saved.repairWorkspaceRef) item.repairWorkspaceRef = saved.repairWorkspaceRef;
      if (saved.mergeCommitSha) item.mergeCommitSha = saved.mergeCommitSha;
      if (saved.verifyFailCount) item.verifyFailCount = saved.verifyFailCount;
      if (saved.verifyWorkspaceRef) item.verifyWorkspaceRef = saved.verifyWorkspaceRef;
    }

    // Restore post-merge verification states from daemon state (these items have no worktree)
    if (saved && item.mergeCommitSha) {
      const savedState = daemonState?.items.find((si) => si.id === item.id)?.state;
      if (savedState === "verifying" || savedState === "verify-failed" || savedState === "repairing-main") {
        orch.setState(item.id, savedState as OrchestratorItemState);
        continue;
      }
    }

    // Check for worktree: cross-repo index first, then hub-local fallback
    const repoRoot = item.resolvedRepoRoot ?? projectRoot;
    const wtInfo = getWorktreeInfo(item.id, crossRepoIndex, worktreeDir);
    const wtPath = wtInfo?.worktreePath ?? join(worktreeDir, `ninthwave-${item.id}`);
    if (!existsSync(wtPath)) continue;

    // Item has a worktree -- check PR status in the correct repo
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
        // Collision detection: verify the merged PR's title matches this work item's title.
        // If titles don't match, the merged PR belongs to a previous item that reused the
        // same ID -- treat as no-pr to avoid falsely completing the new item (H-MID-1).
        // BUT: skip the title check if the orchestrator already tracked this PR number
        // (from daemon state) -- that means we assigned it during the previous run,
        // so it's definitely ours regardless of how the worker titled it.
        const mergedPrNum = prNumStr ? parseInt(prNumStr, 10) : undefined;
        const alreadyTracked = mergedPrNum != null && previousPrNumber === mergedPrNum;
        if (alreadyTracked) {
          orch.setState(item.id, "merged");
        } else {
          const mergedPrTitle = parts[5] ?? "";
          const itemTitle = orch.getItem(item.id)?.workItem.title ?? "";
          if (mergedPrTitle && itemTitle && !prTitleMatchesWorkItem(mergedPrTitle, itemTitle)) {
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
 * its item ID in the cmux workspace listing.
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

/**
 * Get available memory in bytes, accounting for reclaimable file cache.
 *
 * On macOS, os.freemem() only reports truly "free" pages -- not inactive
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

/** Dependencies for scheduled task processing within the orchestrate loop. */
export interface ScheduleLoopDeps {
  /** List all scheduled tasks from the schedules directory. */
  listScheduledTasks: () => ScheduledTask[];
  /** Read schedule state from disk. */
  readState: (projectRoot: string) => ScheduleState;
  /** Write schedule state to disk. */
  writeState: (projectRoot: string, state: ScheduleState) => void;
  /** Launch a scheduled task worker. Returns workspace ref or null. */
  launchWorker: (task: ScheduledTask, projectRoot: string, aiTool: string) => string | null;
  /** Monitor deps (workspace listing + close). */
  monitorDeps: MonitorScheduleDeps;
  /** AI tool identifier for worker launch commands. */
  aiTool: string;
  /** Path to the schedule triggers directory. */
  triggerDir: string;
  /** Append a history entry. Injected for testability. */
  appendHistory?: (projectRoot: string, entry: import("../schedule-history.ts").ScheduleHistoryEntry, io?: ScheduleHistoryIO) => void;
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

    // Build snapshot from external state
    const snapshot = await deps.buildSnapshot(orch, ctx.projectRoot, ctx.worktreeDir);
    __lastSnapshot = snapshot;

    // Process transitions (pure state machine)
    let actions = orch.processTransitions(snapshot);
    __lastActions = actions;

    // Crew mode: claim/filter launch actions through the broker
    if (deps.crewBroker) {
      const launchActions = actions.filter((a) => a.type === "launch");
      if (launchActions.length > 0) {
        if (!deps.crewBroker.isConnected()) {
          // Block ALL launches when disconnected -- prevents stall detection
          for (const action of launchActions) {
            orch.setState(action.itemId, "ready");
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
          // Claim from broker for each launch action
          const claimedIds = new Set<string>();
          for (const _action of launchActions) {
            try {
              const claimed = await deps.crewBroker.claim();
              if (claimed) claimedIds.add(claimed);
            } catch { /* claim failure = not assigned */ }
          }
          // Filter: only keep launch actions for items we claimed
          const denied = launchActions.filter((a) => !claimedIds.has(a.itemId));
          for (const action of denied) {
            orch.setState(action.itemId, "ready");
          }
          actions = actions.filter((a) => a.type !== "launch" || claimedIds.has(a.itemId));
          if (denied.length > 0) {
            log({
              ts: new Date().toISOString(),
              level: "info",
              event: "crew_launches_filtered",
              claimedCount: claimedIds.size,
              deniedCount: denied.length,
              deniedIds: denied.map((a) => a.itemId),
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
          orch.config.reviewWipLimit,
          orch.reviewWipCount,
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

// ── Scheduled task processing ────────────────────────────────────────

/**
 * Process scheduled tasks: check for due tasks, handle triggers, monitor workers, manage queue.
 *
 * This is called from the orchestrate loop on a 30s interval. It:
 * 1. Reads schedule state from disk
 * 2. Monitors active workers (detect completion/timeout/crash)
 * 3. Checks for trigger files from `nw schedule run`
 * 4. Checks which tasks are due based on cron schedule
 * 5. Queues or launches tasks based on WIP availability
 * 6. Writes updated state back to disk
 */
export function processScheduledTasks(
  projectRoot: string,
  orch: Orchestrator,
  deps: ScheduleLoopDeps,
  log: (entry: LogEntry) => void,
  effectiveWip: number,
): void {
  const tasks = deps.listScheduledTasks();
  if (tasks.length === 0) return;

  const state = deps.readState(projectRoot);
  const now = new Date();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // 1. Monitor active workers
  const writeHistory = deps.appendHistory ?? appendHistoryEntry;
  // Build a lookup for active worker start times (needed for history entries)
  const workerStartMap = new Map<string, string>();
  for (const w of state.active) {
    workerStartMap.set(w.taskId, w.startedAt);
  }

  if (state.active.length > 0) {
    const results = monitorScheduleWorkers(state, tasks, now, deps.monitorDeps);
    const completedIds: string[] = [];
    const timedOutIds: string[] = [];

    for (const [taskId, result] of results) {
      const startedAt = workerStartMap.get(taskId) ?? now.toISOString();
      const durationMs = now.getTime() - new Date(startedAt).getTime();

      if (result.status === "completed") {
        completedIds.push(taskId);
        log({
          ts: now.toISOString(),
          level: "info",
          event: "schedule-completed",
          taskId,
          durationMs,
          result: "success",
        });
        // Write history entry
        try {
          writeHistory(projectRoot, {
            taskId,
            startedAt,
            endedAt: now.toISOString(),
            result: "success",
            durationMs,
          });
        } catch { /* best-effort history write */ }
      } else if (result.status === "timeout") {
        timedOutIds.push(taskId);
        log({
          ts: now.toISOString(),
          level: "warn",
          event: "schedule-completed",
          taskId,
          durationMs: result.elapsedMs,
          result: "timeout",
        });
        // Write history entry
        try {
          writeHistory(projectRoot, {
            taskId,
            startedAt,
            endedAt: now.toISOString(),
            result: "timeout",
            durationMs: result.elapsedMs,
          });
        } catch { /* best-effort history write */ }
      } else if (result.status === "crashed") {
        completedIds.push(taskId);
        log({
          ts: now.toISOString(),
          level: "warn",
          event: "schedule-completed",
          taskId,
          durationMs,
          result: "error",
        });
        // Write history entry
        try {
          writeHistory(projectRoot, {
            taskId,
            startedAt,
            endedAt: now.toISOString(),
            result: "error",
            durationMs,
          });
        } catch { /* best-effort history write */ }
      }
    }

    // Remove completed/timed-out workers from active list
    const removeIds = new Set([...completedIds, ...timedOutIds]);
    state.active = state.active.filter((w) => !removeIds.has(w.taskId));
  }

  // 2. Check for trigger files
  const triggered = processTriggerFiles(projectRoot, deps.triggerDir);
  const activeIds = new Set(state.active.map((w) => w.taskId));
  const queuedIds = new Set(state.queued);

  for (const taskId of triggered) {
    if (!taskMap.has(taskId)) {
      log({
        ts: now.toISOString(),
        level: "warn",
        event: "schedule-skipped",
        taskId,
        reason: "trigger-unknown-task",
      });
      continue;
    }
    if (activeIds.has(taskId) || queuedIds.has(taskId)) {
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-skipped",
        taskId,
        reason: "already-running",
      });
      continue;
    }
    log({
      ts: now.toISOString(),
      level: "info",
      event: "schedule-triggered",
      taskId,
      triggerType: "manual",
      scheduleTime: now.toISOString(),
    });
    // Add to front of queue for priority processing
    state.queued.unshift(taskId);
    queuedIds.add(taskId);
  }

  // 3. Check which tasks are due based on cron schedule
  const dueTasks = checkSchedules(tasks, state, now);
  for (const taskId of dueTasks) {
    if (!queuedIds.has(taskId)) {
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-triggered",
        taskId,
        triggerType: "cron",
        scheduleTime: now.toISOString(),
      });
      state.queued.push(taskId);
    }
  }

  // 4. Process queue: launch tasks when WIP slots are available
  // Scheduled tasks consume from the shared WIP pool
  const activeWorkItemCount = orch.getAllItems()
    .filter((i) => !["done", "stuck", "ready", "queued"].includes(i.state)).length;
  const activeScheduleCount = state.active.length;
  const freeSlots = Math.max(0, effectiveWip - activeWorkItemCount - activeScheduleCount);

  const { toLaunch, remainingQueue } = processScheduleQueue(state, freeSlots);
  state.queued = remainingQueue;

  for (const taskId of toLaunch) {
    const task = taskMap.get(taskId);
    if (!task) continue;

    // Double-fire prevention: update lastRunAt BEFORE launching worker
    // Uses the scheduled fire time (now), not poll time
    state.tasks[task.id] = { lastRunAt: now.toISOString() };

    const ref = deps.launchWorker(task, projectRoot, deps.aiTool);
    if (ref) {
      state.active.push({
        taskId: task.id,
        workspaceRef: ref,
        startedAt: now.toISOString(),
      });
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-triggered",
        taskId: task.id,
        triggerType: "launch",
        workspaceRef: ref,
      });
    } else {
      log({
        ts: now.toISOString(),
        level: "warn",
        event: "schedule-error",
        taskId: task.id,
        error: "launch-failed",
      });
    }
  }

  // Log WIP-full queueing
  if (state.queued.length > 0 && freeSlots === 0) {
    for (const queuedTaskId of state.queued) {
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-skipped",
        taskId: queuedTaskId,
        reason: "wip-full-queued",
      });
    }
  }

  // 5. Write updated state
  deps.writeState(projectRoot, state);
}

// ── Keyboard shortcuts (TUI mode) ────────────────────────────────────

/** Shared mutable state for TUI keyboard shortcuts and scroll. */
export interface TuiState {
  scrollOffset: number;
  viewOptions: ViewOptions;
  /** Current merge strategy (per-daemon, cycled via Shift+Tab). */
  mergeStrategy: MergeStrategy;
  /** Whether bypass is available in the cycle (from --dangerously-bypass). */
  bypassEnabled: boolean;
  /** First Ctrl+C pressed -- waiting for confirmation. */
  ctrlCPending: boolean;
  /** Timestamp of the first Ctrl+C press (for 2s timeout). */
  ctrlCTimestamp: number;
  /** Whether the help overlay is visible. */
  showHelp: boolean;
  /** Active panel mode: split (default), logs-only, or status-only. */
  panelMode: PanelMode;
  /** Ring buffer of log entries for the TUI log panel (max LOG_BUFFER_MAX). */
  logBuffer: PanelLogEntry[];
  /** Scroll offset within the log panel. */
  logScrollOffset: number;
  /** Current log level filter. */
  logLevelFilter: LogLevelFilter;
  /** Selected item index in the visible item list (0-based). Defaults to 0. */
  selectedIndex?: number;
  /** Item ID currently shown in the detail panel (null = log panel visible). */
  detailItemId?: string | null;
  /** Saved log scroll offset, restored when returning from detail view. */
  savedLogScrollOffset?: number;
  /** Called when the user cycles the merge strategy via Shift+Tab. */
  onStrategyChange?: (strategy: MergeStrategy) => void;
  /** Called when the user cycles panel mode via Tab (for preference persistence). */
  onPanelModeChange?: (mode: PanelMode) => void;
  /** Called after any key that should trigger an immediate re-render. */
  onUpdate?: () => void;
  /** Resolve item ID at the given index in the visible item list. */
  getSelectedItemId?: (index: number) => string | undefined;
  /** Get total number of items for clamping selectedIndex. */
  getItemCount?: () => number;
}

/**
 * Set up raw-mode stdin to capture individual keystrokes in TUI mode.
 *
 * - `q` triggers graceful shutdown via the AbortController
 * - Ctrl-C (0x03) triggers the same graceful shutdown
 * - `m` toggles metrics panel
 * - `d` toggles deps detail view
 * - `?` toggles full-screen help overlay
 * - Escape dismisses help overlay (raw `\x1b`, not arrow key sequences)
 * - Up/Down arrows scroll item list
 *
 * Returns a cleanup function that restores terminal state.
 * Only call this when tuiMode is true and stdin is a TTY.
 */
export function setupKeyboardShortcuts(
  abortController: AbortController,
  log: (entry: LogEntry) => void,
  stdin: NodeJS.ReadStream = process.stdin,
  tuiState?: TuiState,
): () => void {
  if (!stdin.isTTY || !stdin.setRawMode) {
    return () => {};
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  // Timer for Ctrl+C double-tap timeout (clear ctrlCPending after ~2s)
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  const onData = (key: string) => {
    // q still exits immediately (discoverable via ? help overlay)
    if (key === "q") {
      log({ ts: new Date().toISOString(), level: "info", event: "keyboard_quit", key: "q" });
      abortController.abort();
      return;
    }

    // Ctrl+C: double-tap to exit
    if (key === "\x03") {
      if (tuiState?.ctrlCPending && Date.now() - tuiState.ctrlCTimestamp < 2000) {
        // Second press within 2s -- exit
        if (ctrlCTimer) clearTimeout(ctrlCTimer);
        log({ ts: new Date().toISOString(), level: "info", event: "keyboard_quit", key: "ctrl-c" });
        abortController.abort();
        return;
      }
      if (tuiState) {
        // First press -- show confirmation footer
        tuiState.ctrlCPending = true;
        tuiState.ctrlCTimestamp = Date.now();
        tuiState.viewOptions.ctrlCPending = true;
        tuiState.onUpdate?.();
        // Clear after ~2s
        if (ctrlCTimer) clearTimeout(ctrlCTimer);
        ctrlCTimer = setTimeout(() => {
          tuiState.ctrlCPending = false;
          tuiState.viewOptions.ctrlCPending = false;
          tuiState.onUpdate?.();
        }, 2000);
        return;
      }
      // No tuiState -- fall through to immediate abort
      log({ ts: new Date().toISOString(), level: "info", event: "keyboard_quit", key: "ctrl-c" });
      abortController.abort();
      return;
    }

    if (!tuiState) return;

    // Any non-Ctrl+C key clears the ctrlCPending state
    if (tuiState.ctrlCPending) {
      tuiState.ctrlCPending = false;
      tuiState.viewOptions.ctrlCPending = false;
      if (ctrlCTimer) { clearTimeout(ctrlCTimer); ctrlCTimer = null; }
    }

    let handled = true;
    switch (key) {
      case "?":
        tuiState.showHelp = !tuiState.showHelp;
        tuiState.viewOptions.showHelp = tuiState.showHelp;
        break;
      case "\x1b": // Raw Escape (length 1) -- dismiss help overlay or detail panel
        // Only treat single-byte \x1b as Escape. Arrow keys send \x1b[A etc.
        // which are longer sequences and won't match this case.
        if (tuiState.showHelp) {
          tuiState.showHelp = false;
          tuiState.viewOptions.showHelp = false;
        } else if (tuiState.detailItemId) {
          // Return from detail view to log panel, restore scroll offset
          tuiState.detailItemId = null;
          tuiState.logScrollOffset = tuiState.savedLogScrollOffset ?? 0;
        } else {
          handled = false;
        }
        break;
      case "d":
        tuiState.viewOptions.showBlockerDetail = !tuiState.viewOptions.showBlockerDetail;
        break;
      case "\r": // Enter -- open detail panel for selected item
      case "i": { // i -- open detail panel for selected item
        const selIdx = tuiState.selectedIndex ?? 0;
        if (selIdx >= 0 && !tuiState.detailItemId) {
          const itemId = tuiState.getSelectedItemId?.(selIdx);
          if (itemId) {
            tuiState.savedLogScrollOffset = tuiState.logScrollOffset;
            tuiState.detailItemId = itemId;
          }
        }
        break;
      }
      case "\x1b[A": // Up arrow
        if ((tuiState.selectedIndex ?? 0) > 0) {
          tuiState.selectedIndex = (tuiState.selectedIndex ?? 0) - 1;
        }
        tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - 1);
        break;
      case "\x1b[B": { // Down arrow
        const maxIdx = (tuiState.getItemCount?.() ?? 0) - 1;
        const curIdx = tuiState.selectedIndex ?? 0;
        if (curIdx < maxIdx) {
          tuiState.selectedIndex = curIdx + 1;
        }
        tuiState.scrollOffset += 1;
        break;
      }
      case "\t": { // Tab -- cycle panel mode (split -> logs-only -> status-only -> split)
        const termRows = getTerminalHeight();
        const modes: PanelMode[] = termRows < MIN_SPLIT_ROWS
          ? ["logs-only", "status-only"]  // Small terminal: no split, cycle full-screen views
          : ["split", "logs-only", "status-only"];
        const currentIdx = modes.indexOf(tuiState.panelMode);
        const nextIdx = (currentIdx + 1) % modes.length;
        tuiState.panelMode = modes[nextIdx]!;
        tuiState.onPanelModeChange?.(tuiState.panelMode);
        break;
      }
      case "j": // Scroll log panel down
        tuiState.logScrollOffset += 1;
        break;
      case "k": // Scroll log panel up
        tuiState.logScrollOffset = Math.max(0, tuiState.logScrollOffset - 1);
        break;
      case "l": { // Cycle log level filter (info -> warn -> error -> all)
        const currentIdx = LOG_LEVEL_CYCLE.indexOf(tuiState.logLevelFilter);
        const nextIdx = (currentIdx + 1) % LOG_LEVEL_CYCLE.length;
        tuiState.logLevelFilter = LOG_LEVEL_CYCLE[nextIdx]!;
        // Reset scroll when filter changes
        tuiState.logScrollOffset = 0;
        break;
      }
      case "G": { // Jump to end of log (re-enable follow mode)
        const filtered = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
        const termRows = getTerminalHeight();
        const viewportHeight = Math.max(1, termRows - 10); // approximate
        tuiState.logScrollOffset = Math.max(0, filtered.length - viewportHeight);
        break;
      }
      case "\x1B[Z": { // Shift+Tab -- cycle merge strategy
        const strategies: MergeStrategy[] = tuiState.bypassEnabled
          ? ["auto", "manual", "bypass"]
          : ["auto", "manual"];
        const currentIdx = strategies.indexOf(tuiState.mergeStrategy);
        const nextIdx = (currentIdx + 1) % strategies.length;
        const oldStrategy = tuiState.mergeStrategy;
        tuiState.mergeStrategy = strategies[nextIdx]!;
        tuiState.viewOptions.mergeStrategy = tuiState.mergeStrategy;
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "strategy_cycle",
          oldStrategy,
          newStrategy: tuiState.mergeStrategy,
        });
        tuiState.onStrategyChange?.(tuiState.mergeStrategy);
        break;
      }
      default:
        handled = false;
    }

    if (handled) tuiState.onUpdate?.();
  };

  // Handle terminal resize: clamp scroll offset
  const onResize = () => {
    if (tuiState) {
      const termRows = getTerminalHeight();
      const viewportHeight = Math.max(1, termRows - 10); // approximate
      tuiState.scrollOffset = clampScrollOffset(tuiState.scrollOffset, 999, viewportHeight);
      // Also clamp log scroll offset on resize
      const filtered = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
      tuiState.logScrollOffset = clampScrollOffset(tuiState.logScrollOffset, filtered.length, viewportHeight);
      tuiState.onUpdate?.();
    }
  };

  stdin.on("data", onData);
  process.stdout.on("resize", onResize);

  return () => {
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);
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

  // Rotate logs at daemon startup to bound total log storage (~20MB max)
  rotateLogs(logPath);

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

// ── Arg parsing (extracted for testability) ──────────────────────────

export interface ParsedWatchArgs {
  itemIds: string[];
  mergeStrategy: MergeStrategy;
  wipLimitOverride?: number;
  pollIntervalOverride?: number;
  frictionDir?: string;
  daemonMode: boolean;
  isDaemonChild: boolean;
  clickupListId?: string;
  remoteFlag: boolean;
  reviewWipLimit?: number;
  reviewAutoFix?: "off" | "direct" | "pr";
  reviewExternal: boolean;
  verifyMain: boolean;
  watchMode: boolean;
  noWatch: boolean;
  watchIntervalSecs?: number;
  jsonFlag: boolean;
  skipPreflight: boolean;
  crewCode?: string;
  crewCreate: boolean;
  crewPort: number;
  crewUrl?: string;
  crewName?: string;
  bypassEnabled: boolean;
}

export function parseWatchArgs(args: string[]): ParsedWatchArgs {
  const itemIds: string[] = [];
  let mergeStrategy: MergeStrategy = "auto";
  let wipLimitOverride: number | undefined;
  let pollIntervalOverride: number | undefined;
  let frictionDir: string | undefined;
  let daemonMode = false;
  let isDaemonChild = false;
  let clickupListId: string | undefined;
  let remoteFlag = false;
  let reviewWipLimit: number | undefined;
  let reviewAutoFix: "off" | "direct" | "pr" | undefined;
  let reviewExternal = false;
  let verifyMain = true;
  let watchMode = false;
  let noWatch = false;
  let watchIntervalSecs: number | undefined;
  let jsonFlag = false;
  let skipPreflight = false;
  let crewCode: string | undefined;
  let crewCreate = false;
  let crewPort = 0;
  let crewUrl: string | undefined;
  let crewName: string | undefined;
  let bypassEnabled = false;

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
      case "--merge-strategy": {
        const raw = args[i + 1] ?? "auto";
        // Map skill aliases to actual strategies
        const strategyMap: Record<string, MergeStrategy> = {
          auto: "auto", manual: "manual", bypass: "bypass",
          asap: "auto", approved: "auto", ask: "manual",
        };
        mergeStrategy = strategyMap[raw] ?? "auto";
        if (!strategyMap[raw]) {
          warn(`Unknown merge strategy "${raw}", defaulting to "auto"`);
        }
        i += 2;
        break;
      }
      case "--wip-limit":
        wipLimitOverride = parseInt(args[i + 1] ?? "4", 10);
        i += 2;
        break;
      case "--poll-interval":
        pollIntervalOverride = parseInt(args[i + 1] ?? "30", 10) * 1000;
        i += 2;
        break;
      case "--orchestrator-ws":
        // Reserved for future use -- workspace ref for the orchestrator itself
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
      case "--review-wip-limit":
        reviewWipLimit = parseInt(args[i + 1] ?? "2", 10);
        i += 2;
        break;
      case "--review-auto-fix": {
        const autoFixVal = args[i + 1] ?? "off";
        if (autoFixVal !== "off" && autoFixVal !== "direct" && autoFixVal !== "pr") {
          throw new Error(`Invalid --review-auto-fix value: "${autoFixVal}". Must be "off", "direct", or "pr".`);
        }
        reviewAutoFix = autoFixVal;
        i += 2;
        break;
      }
      case "--review-external":
        reviewExternal = true;
        i += 1;
        break;
      case "--no-verify-main":
        verifyMain = false;
        i += 1;
        break;
      case "--verify-main":
        verifyMain = true;
        i += 1;
        break;
      case "--watch":
        // Accepted silently for backwards compat (watch is now default for daemon)
        watchMode = true;
        i += 1;
        break;
      case "--no-watch":
        noWatch = true;
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
      case "--crew":
        crewCode = args[i + 1];
        i += 2;
        break;
      case "--crew-create":
        crewCreate = true;
        i += 1;
        break;
      case "--crew-port":
        crewPort = parseInt(args[i + 1] ?? "0", 10);
        i += 2;
        break;
      case "--crew-url":
        crewUrl = args[i + 1];
        i += 2;
        break;
      case "--crew-name":
        crewName = args[i + 1];
        i += 2;
        break;
      case "--dangerously-bypass":
        bypassEnabled = true;
        mergeStrategy = "bypass";
        i += 1;
        break;
      default:
        throw new Error(`Unknown option: ${args[i]}`);
    }
  }

  // --daemon implies --watch unless --no-watch is explicitly set
  if (daemonMode && !noWatch) {
    watchMode = true;
  }

  return {
    itemIds, mergeStrategy, wipLimitOverride, pollIntervalOverride, frictionDir,
    daemonMode, isDaemonChild, clickupListId, remoteFlag,
    reviewWipLimit, reviewAutoFix, reviewExternal,
    verifyMain, watchMode, noWatch, watchIntervalSecs,
    jsonFlag, skipPreflight, crewCode, crewCreate, crewPort, crewUrl, crewName,
    bypassEnabled,
  };
}

/**
 * Validate that all item IDs exist in the todo map.
 * Returns array of unknown IDs (empty = all valid).
 */
export function validateItemIds(itemIds: string[], todoMap: Map<string, WorkItem>): string[] {
  return itemIds.filter(id => !todoMap.has(id));
}

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
    reviewWipLimit, reviewAutoFix, reviewExternal,
    verifyMain, noWatch, watchIntervalSecs,
    jsonFlag, skipPreflight, crewCreate, crewPort, crewName,
    bypassEnabled,
  } = parsed;
  let watchMode = parsed.watchMode;
  let crewCode = parsed.crewCode;
  let crewUrl = parsed.crewUrl;

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
  if (shouldEnterInteractive(itemIds.length > 0)) {
    const result = await runInteractiveFlow(workItems, wipLimit);
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
  const orch = new Orchestrator({
    wipLimit,
    mergeStrategy,
    bypassEnabled,
    verifyMain,
    ...(reviewWipLimit !== undefined ? { reviewWipLimit } : {}),
    ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
  });
  for (const id of itemIds) {
    orch.addItem(workItemMap.get(id)!);
  }

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

  // Compute hub repo NWO once at startup for absolute agent-link URLs in PR comments
  let hubRepoNwo = "";
  try {
    hubRepoNwo = getRepoOwner(projectRoot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Could not determine hub repo NWO: ${msg}`);
  }

  const ctx: ExecutionContext = { projectRoot, worktreeDir, workDir, aiTool, hubRepoNwo };
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
    launchReview: (itemId, prNumber, repoRoot, implementerWorktreePath) => {
      const autoFix = orch.config.reviewAutoFix;
      const result = launchReviewWorker(prNumber, itemId, autoFix, repoRoot, aiTool, mux, { implementerWorktreePath, hubRepoNwo });
      if (!result) return null;
      return { workspaceRef: result.workspaceRef, verdictPath: result.verdictPath };
    },
    bootstrapRepo: (alias, projRoot) => bootstrapRepo(alias, projRoot),
    cleanReview: (itemId, reviewWorkspaceRef) => {
      // Close the review workspace
      try { mux.closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
      // Clean the review worktree if it exists (only for direct/pr modes)
      try {
        cleanSingleWorktree(`review-${itemId}`, join(projectRoot, ".worktrees"), projectRoot);
      } catch { /* best-effort -- review worktree may not exist for off mode */ }
      return true;
    },
    launchRepair: (itemId, prNumber, repoRoot) => {
      const result = launchRepairWorker(prNumber, itemId, repoRoot, aiTool, mux, { hubRepoNwo });
      if (!result) return null;
      return { workspaceRef: result.workspaceRef };
    },
    cleanRepair: (itemId, repairWorkspaceRef) => {
      try { mux.closeWorkspace(repairWorkspaceRef); } catch { /* best-effort */ }
      return true;
    },
    setCommitStatus: (repoRoot, prNumber, state, context, description) => {
      const sha = prHeadSha(repoRoot, prNumber);
      if (!sha) return false;
      return ghSetCommitStatus(repoRoot, sha, state, context, description);
    },
    getMergeCommitSha: (repoRoot, prNumber) => ghGetMergeCommitSha(repoRoot, prNumber),
    checkCommitCI: (repoRoot, sha) => ghCheckCommitCI(repoRoot, sha),
    launchVerifier: (itemId, mergeCommitSha, repoRoot) => {
      const result = launchVerifierWorker(itemId, mergeCommitSha, repoRoot, aiTool, mux, { hubRepoNwo });
      if (!result) return null;
      return { worktreePath: result.worktreePath, workspaceRef: result.workspaceRef };
    },
    cleanVerifier: (itemId, verifyWorkspaceRef) => {
      try { mux.closeWorkspace(verifyWorkspaceRef); } catch { /* best-effort */ }
      try {
        cleanSingleWorktree(`ninthwave-verify-${itemId}`, join(projectRoot, ".worktrees"), projectRoot);
      } catch { /* best-effort -- verifier worktree may already be cleaned */ }
      return true;
    },
  };

  // ── Crew mode setup ──────────────────────────────────────────────
  let crewBroker: CrewBroker | undefined;
  let mockBrokerInstance: MockBroker | undefined;

  // Resolve git remote URL for crew repo verification
  let crewRepoUrl = "";
  try {
    const { execSync } = await import("child_process");
    crewRepoUrl = execSync("git remote get-url origin", { cwd: projectRoot, encoding: "utf-8" }).trim();
  } catch {
    // No git remote available
  }

  if (crewCreate) {
    // Start mock broker in-process
    mockBrokerInstance = new MockBroker({ port: crewPort || 0 });
    const brokerPort = mockBrokerInstance.start();

    // Create a crew
    const res = await fetch(`http://localhost:${brokerPort}/api/crews`, {
      method: "POST",
      body: JSON.stringify({ repoUrl: crewRepoUrl }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as { code: string };
    crewCode = body.code;
    crewUrl = `ws://localhost:${brokerPort}`;

    info(`Crew created: ${crewCode}`);
    info(`  Port: ${brokerPort}`);
    info(`  Join: ninthwave orchestrate --crew ${crewCode} --crew-url ws://localhost:${brokerPort} ...`);
  }

  let resolvedCrewName: string | undefined;
  if (crewCode) {
    // Resolve the crew URL: --crew-url takes priority, then --crew-port, then default cloud
    if (!crewUrl) {
      if (crewPort) {
        crewUrl = `ws://localhost:${crewPort}`;
      } else {
        crewUrl = "wss://ninthwave.sh";
      }
    }
    resolvedCrewName = crewName ?? (await import("os")).hostname();
    const broker = new WebSocketCrewBroker(projectRoot, crewUrl, crewCode, crewRepoUrl, {
      log: (level, msg) => log({ ts: new Date().toISOString(), level, event: "crew_client", message: msg }),
    }, resolvedCrewName);

    try {
      await broker.connect();
      info(`Connected to crew ${crewCode} as "${resolvedCrewName}"`);
    } catch (err) {
      die(`Failed to connect to crew server: ${(err as Error).message}`);
    }
    crewBroker = broker;
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
  const reviewExternalEnabled = reviewExternal || projectConfig["review_external"] === "true";
  const scheduleEnabled = projectConfig["schedule_enabled"] === "true";

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
      const items = orchestratorItemsToStatusItems(lastTuiItems, resolvedCrewName);
      const nonQueued = items.filter((i) => i.state !== "queued");
      return nonQueued[index]?.id;
    },
    getItemCount: () => {
      const items = orchestratorItemsToStatusItems(lastTuiItems, resolvedCrewName);
      return items.filter((i) => i.state !== "queued").length;
    },
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
          renderTuiPanelFrame(lastTuiItems, wipLimit, tuiState, undefined, resolvedCrewName);
        } catch {
          // Non-fatal
        }
      }
    },
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
        renderTuiPanelFrame(items, wipLimit, tuiState, undefined, resolvedCrewName);
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
    buildSnapshot: (o, pr, wd) => buildSnapshotAsync(o, pr, wd, mux, undefined, undefined, fetchTrustedPrComments, ghCheckCommitCI),
    sleep: (ms) => interruptibleSleep(ms, abortController.signal),
    log,
    actionDeps,
    getFreeMem: getAvailableMemory,
    reconcile,
    readScreen: (ref, lines) => mux.readScreen(ref, lines),
    onPollComplete,
    syncDisplay: (o, snap) => syncWorkerDisplay(o, snap, mux),
    externalReviewDeps,
    ...(watchMode ? { scanWorkItems: () => {
      try { fetchOrigin(projectRoot, "main"); } catch { /* non-fatal */ }
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
        renderTuiPanelFrame(allItems, wipLimit, tuiState, write, resolvedCrewName);
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
        const freshItems = parseWorkItems(workDir, worktreeDir, projectRoot);
        const interactiveResult = await runInteractiveFlow(freshItems, wipLimit);
        if (!interactiveResult) {
          // User cancelled selection -- restore keyboard and exit loop
          cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
          break;
        }

        // Add newly selected items to the orchestrator
        const freshMap = new Map<string, WorkItem>();
        for (const item of freshItems) freshMap.set(item.id, item);
        for (const id of interactiveResult.itemIds) {
          const wi = freshMap.get(id);
          if (wi && !orch.getItem(id)) {
            orch.addItem(wi);
          }
        }
        wipLimit = interactiveResult.wipLimit;
        mergeStrategy = interactiveResult.mergeStrategy;
        orch.setMergeStrategy(mergeStrategy);

        // Restore keyboard shortcuts for the main TUI
        cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);

        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "run_more_restart",
          newItems: interactiveResult.itemIds,
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

    // Clean up crew broker and mock broker
    if (crewBroker) {
      try { crewBroker.disconnect(); } catch { /* best-effort */ }
    }
    if (mockBrokerInstance) {
      try { mockBrokerInstance.stop(); } catch { /* best-effort */ }
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
