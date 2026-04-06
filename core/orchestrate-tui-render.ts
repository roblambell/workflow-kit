// TUI rendering bridge: converts orchestrator/daemon state to status items,
// manages panel layout, overlays, selection, and the standalone TUI runner.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  Orchestrator,
  DEFAULT_CONFIG,
  TIMEOUTS,
  type Action,
  type OrchestratorItem,
} from "./orchestrator.ts";
import type { WorkItem, LogEntry } from "./types.ts";
import type { CrewRemoteItemSnapshot, CrewStatus } from "./crew.ts";
import type { DaemonState, DaemonCrewStatus, WorkerProgress } from "./daemon.ts";
import { type Multiplexer, createMux, muxTypeForWorkspaceRef } from "./mux.ts";
import { ALT_SCREEN_ON, ALT_SCREEN_OFF, RED } from "./output.ts";
import {
  buildDisplayPrContext,
  buildVisibleStatusLayoutMetadata,
  daemonStateToStatusItems,
  formatStatusTable,
  mapDaemonItemState,
  normalizeRemoteItemState,
  getTerminalWidth,
  getTerminalHeight,
  buildStatusLayout,
  renderFullScreenFrame,
  renderHelpOverlay,
  renderControlsOverlay,
  renderPausedOverlay,
  renderDetailOverlay,
  renderCenteredOverlay,
  renderStartupOverlay,
  clampScrollOffset,
  scrollStatusItemIntoView,
  buildPanelLayout,
  renderPanelFrame,
  MIN_FULLSCREEN_ROWS,
  type StatusItem,
  type StartupOverlayState,
  type ViewOptions,
  type CrewStatusInfo,
  type PanelMode,
  type LogEntry as PanelLogEntry,
} from "./status-render.ts";
import {
  setupKeyboardShortcuts,
  applyRuntimeSnapshotToTuiState,
  isTuiPaused,
  filterLogsByLevel,
  pushLogBuffer,
  applyLogFollowMode,
  LOG_BUFFER_MAX,
  type TuiState,
  type LogLevelFilter,
} from "./tui-keyboard.ts";
import { getBundleDir } from "./paths.ts";
import {
  getPassiveUpdateState,
  getPassiveUpdateStartupState,
  type PassiveUpdateState,
  type PassiveUpdateStartupState,
} from "./update-check.ts";

// ── Version helper ──────────────────────────────────────────────────

let _cachedVersion: string | undefined;

export function readVersion(): string {
  if (_cachedVersion !== undefined) return _cachedVersion;
  try {
    const versionFile = join(getBundleDir(), "VERSION");
    if (existsSync(versionFile)) {
      _cachedVersion = readFileSync(versionFile, "utf-8").trim();
      return _cachedVersion;
    }
  } catch {}
  _cachedVersion = "unknown";
  return _cachedVersion;
}

// ── Types ───────────────────────────────────────────────────────────

export type RemoteItemRenderState = ReadonlySet<string> | ReadonlyMap<string, CrewRemoteItemSnapshot>;

export interface TuiDetailSnapshot {
  priority?: string;
  dependencies?: string[];
  ciFailCount?: number;
  retryCount?: number;
  descriptionBody?: string;
}

export type ActiveTuiOverlay = "engine-recovery" | "help" | "controls" | "paused" | "detail" | "startup" | "none";

/** Options for runTUI -- the reusable TUI lifecycle runner. */
export interface RunTUIOptions {
  /** Provide status items and optional session limit for each render cycle. */
  getItems: () => { items: StatusItem[]; sessionLimit?: number; sessionStartedAt?: string; viewOptions?: ViewOptions };
  /** Provide log entries for the log panel. If omitted, logBuffer is empty. */
  getLogEntries?: () => PanelLogEntry[];
  /** Poll interval in ms (default: 2000). */
  intervalMs?: number;
  /** External abort signal to stop the TUI loop. */
  signal?: AbortSignal;
  /** Starting panel mode (default: status-only). */
  panelMode?: PanelMode;
}

export interface BootstrapTuiUpdateNoticeDeps {
  getStartupState?: () => PassiveUpdateStartupState;
  refreshUpdateState?: () => Promise<PassiveUpdateState | null>;
  onUpdate?: () => void;
}

// ── Crew status conversions ─────────────────────────────────────────

export function crewStatusToRemoteItemSnapshots(
  crewStatus: CrewStatus | null | undefined,
): Map<string, CrewRemoteItemSnapshot> | undefined {
  if (!crewStatus?.remoteItems?.length) return undefined;
  return new Map(crewStatus.remoteItems.map((item) => [item.id, item]));
}

export function crewStatusToDaemonCrewStatus(
  crewStatus: CrewStatus | null | undefined,
  crewCode: string | null | undefined,
  connected: boolean,
): DaemonCrewStatus | undefined {
  if (!crewStatus && !crewCode) return undefined;
  return {
    crewCode: crewStatus?.crewCode ?? crewCode ?? "",
    daemonCount: crewStatus?.daemonCount ?? 0,
    availableCount: crewStatus?.availableCount ?? 0,
    claimedCount: crewStatus?.claimedCount ?? 0,
    completedCount: crewStatus?.completedCount ?? 0,
    connected,
  };
}

export function crewStatusToRemoteOwnedItemIds(
  crewStatus: CrewStatus | null | undefined,
): Set<string> | undefined {
  if (crewStatus?.remoteItems?.length) {
    const ownedIds = crewStatus.remoteItems
      .filter((item) => item.ownerDaemonId !== null)
      .map((item) => item.id);
    return ownedIds.length > 0 ? new Set(ownedIds) : undefined;
  }
  if (!crewStatus?.claimedItems?.length) return undefined;
  return new Set(crewStatus.claimedItems);
}

export function filterCrewRemoteWriteActions(
  actions: Action[],
  crewStatus: CrewStatus | null | undefined,
): Action[] {
  const remoteIds = crewStatusToRemoteOwnedItemIds(crewStatus);
  if (!remoteIds || remoteIds.size === 0) return actions;

  const WRITE_ACTIONS: ReadonlySet<string> = new Set([
    "merge", "clean", "retry", "rebase", "daemon-rebase",
    "launch-repair", "clean-repair", "launch-review", "clean-review",
    "launch-verifier", "clean-verifier", "workspace-close",
  ]);
  return actions.filter((action) => !(WRITE_ACTIONS.has(action.type) && remoteIds.has(action.itemId)));
}

// ── Status item conversion ──────────────────────────────────────────

export function orchestratorItemsToStatusItems(
  items: OrchestratorItem[],
  remoteItems?: RemoteItemRenderState,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
  heartbeats?: ReadonlyMap<string, WorkerProgress>,
): StatusItem[] {
  const now = Date.now();
  const remoteSnapshots = remoteItems instanceof Map ? remoteItems : undefined;
  const remoteIds = remoteItems instanceof Set ? remoteItems : undefined;
  return items.map((item) => {
    const remoteSnapshot = remoteSnapshots?.get(item.id);
    const heartbeat = remoteSnapshot ? undefined : heartbeats?.get(item.id);
    const mappedState = mapDaemonItemState(item.state, { rebaseRequested: item.rebaseRequested });
    const state = remoteSnapshot ? normalizeRemoteItemState(remoteSnapshot.state) : mappedState;
    const remote = remoteSnapshot
      ? remoteSnapshot.ownerDaemonId !== null
      : (remoteIds?.has(item.id) ?? false);
    const prContext = buildDisplayPrContext(
      item.prNumber,
      item.priorPrNumbers,
      remoteSnapshot ? (remoteSnapshot.prNumber ?? null) : undefined,
      remoteSnapshot?.priorPrNumbers,
    );

    return {
      id: item.id,
      title: remoteSnapshot?.title ?? item.workItem.title,
      ...(item.workItem.descriptionSnippet
        ? { descriptionSnippet: item.workItem.descriptionSnippet }
        : {}),
      ...(item.workItem.requiresManualReview ? { requiresManualReview: true } : {}),
      state,
      prNumber: prContext.prNumber,
      ...(prContext.priorPrNumbers ? { priorPrNumbers: prContext.priorPrNumbers } : {}),
      ageMs: now - new Date(item.lastTransition).getTime(),
      timeoutRemainingMs: item.timeoutDeadline
        ? Math.max(0, new Date(item.timeoutDeadline).getTime() - now)
        : undefined,
      timeoutExtensions: item.timeoutDeadline
        ? `${item.timeoutExtensionCount ?? 0}/${maxTimeoutExtensions}`
        : undefined,
      repoLabel: "",
      failureReason: item.failureReason,
      dependencies: item.workItem.dependencies ?? [],
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      exitCode: item.exitCode,
      stderrTail: item.stderrTail,
      remote,
      workspaceRef: item.workspaceRef,
      worktreePath: item.worktreePath,
      respawnDeadlineMs: item.ciNotifyWallAt
        ? new Date(item.ciNotifyWallAt).getTime() + TIMEOUTS.ciFixAck
        : undefined,
      progress: heartbeat?.progress,
      progressLabel: heartbeat?.label,
      progressTs: heartbeat?.ts,
    };
  });
}

// ── Mux helper ──────────────────────────────────────────────────────

export function muxForWorkspaceRef(workspaceRef: string, projectRoot: string): Multiplexer {
  return createMux(muxTypeForWorkspaceRef(workspaceRef), projectRoot);
}

// ── Selection and layout ────────────────────────────────────────────

export function getVisibleSelectableItemIds(items: StatusItem[]): string[] {
  return buildVisibleStatusLayoutMetadata(items).selectableItemIds;
}

export function normalizeSelectedItemId(
  nextVisibleItemIds: string[],
  selectedItemId?: string,
  previousVisibleItemIds: string[] = [],
): string | undefined {
  if (nextVisibleItemIds.length === 0) return undefined;
  if (!selectedItemId) return nextVisibleItemIds[0];
  if (nextVisibleItemIds.includes(selectedItemId)) return selectedItemId;

  const previousIndex = previousVisibleItemIds.indexOf(selectedItemId);
  if (previousIndex < 0) return nextVisibleItemIds[0];

  const nextVisibleItemIdSet = new Set(nextVisibleItemIds);
  for (let distance = 1; distance <= previousVisibleItemIds.length; distance++) {
    const nextId = previousVisibleItemIds[previousIndex + distance];
    if (nextId && nextVisibleItemIdSet.has(nextId)) return nextId;

    const previousId = previousVisibleItemIds[previousIndex - distance];
    if (previousId && nextVisibleItemIdSet.has(previousId)) return previousId;
  }

  return nextVisibleItemIds[Math.min(previousIndex, nextVisibleItemIds.length - 1)] ?? nextVisibleItemIds[0];
}

export function prepareStatusSelection(tuiState: TuiState, items: StatusItem[]): void {
  const previousVisibleItemIds = tuiState.statusLayout?.visibleLayout?.selectableItemIds
    ?? tuiState.visibleItemIds
    ?? [];
  const nextVisibleItemIds = getVisibleSelectableItemIds(items);
  tuiState.selectedItemId = normalizeSelectedItemId(
    nextVisibleItemIds,
    tuiState.selectedItemId,
    previousVisibleItemIds,
  );
  tuiState.visibleItemIds = nextVisibleItemIds;
  if (nextVisibleItemIds.length === 0) {
    tuiState.scrollOffset = 0;
  }
}

export function syncStatusLayout(tuiState: TuiState, panelLayout: ReturnType<typeof buildPanelLayout>, termRows: number): void {
  tuiState.statusLayout = panelLayout.statusPanel;
  tuiState.visibleItemIds = panelLayout.statusPanel?.visibleLayout?.selectableItemIds ?? tuiState.visibleItemIds ?? [];

  if (!panelLayout.statusPanel) return;

  if (tuiState.selectedItemId) {
    tuiState.scrollOffset = scrollStatusItemIntoView(
      panelLayout.statusPanel,
      termRows,
      tuiState.scrollOffset,
      tuiState.selectedItemId,
      1,
    );
    return;
  }

  const viewportHeight = Math.max(
    1,
    termRows - panelLayout.statusPanel.headerLines.length - panelLayout.footerLines.length,
  );
  tuiState.scrollOffset = clampScrollOffset(
    tuiState.scrollOffset,
    panelLayout.statusPanel.itemLines.length,
    viewportHeight,
  );
}

// ── Overlay rendering ───────────────────────────────────────────────

export function renderEngineRecoveryOverlay(
  termWidth: number,
  termRows: number,
  reason?: string,
): string[] {
  const detailLines = (reason?.split("\n") ?? ["The watch engine exited before acknowledging all controls."])
    .map((line) => line.trim())
    .filter(Boolean);
  return renderCenteredOverlay(termWidth, termRows, {
    title: "Engine disconnected",
    contentLines: detailLines,
    hint: "Press r to restart or q to quit",
    titleColor: RED,
  });
}

export function resolveActiveTuiOverlay(tuiState: TuiState): ActiveTuiOverlay {
  if (tuiState.engineDisconnected) return "engine-recovery";
  if (tuiState.showHelp || tuiState.viewOptions.showHelp) return "help";
  if (tuiState.showControls || tuiState.viewOptions.showControls) return "controls";
  if (isTuiPaused(tuiState)) return "paused";
  if (tuiState.detailItemId) return "detail";
  if (tuiState.startupOverlay) return "startup";
  return "none";
}

// ── Frame renderers ─────────────────────────────────────────────────

export function renderTuiPanelFrameFromStatusItems(
  statusItems: StatusItem[],
  sessionLimit: number | undefined,
  tuiState: TuiState,
  write: (s: string) => void = (s) => process.stdout.write(s),
  detailSnapshots?: ReadonlyMap<string, TuiDetailSnapshot>,
): void {
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();
  const fullScreenViewOptions = termRows >= MIN_FULLSCREEN_ROWS
    ? { ...(tuiState.viewOptions ?? {}), inlineModeIndicatorOnTitle: true }
    : tuiState.viewOptions;

  const renderDefaultPanel = () => {
    applyLogFollowMode(tuiState, termRows);
    const filteredLogs = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
    prepareStatusSelection(tuiState, statusItems);
    const panelLayout = buildPanelLayout(
      tuiState.panelMode,
      statusItems,
      filteredLogs,
      termWidth,
      termRows,
      {
        sessionLimit,
        viewOptions: fullScreenViewOptions,
        logScrollOffset: tuiState.logScrollOffset,
        statusScrollOffset: tuiState.scrollOffset,
        selectedItemId: tuiState.selectedItemId,
        logFollowMode: tuiState.logFollowMode,
      },
    );
    syncStatusLayout(tuiState, panelLayout, termRows);
    const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
    const content = frameLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  };

  write("\x1B[H");

  switch (resolveActiveTuiOverlay(tuiState)) {
    case "engine-recovery": {
      const overlayLines = renderEngineRecoveryOverlay(termWidth, termRows, tuiState.engineDisconnectReason);
      const content = overlayLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      break;
    }
    case "help": {
      const helpLines = renderHelpOverlay(termWidth, termRows, tuiState.sessionCode, tuiState.tmuxSessionName, readVersion());
      const content = helpLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      break;
    }
    case "controls": {
      const controlsLines = renderControlsOverlay(termWidth, termRows, {
        collaborationMode: tuiState.collaborationMode,
        pendingCollaborationMode: tuiState.pendingCollaborationMode,
        collaborationIntent: tuiState.collaborationIntent,
        sessionCode: tuiState.sessionCode,
        collaborationJoinInputActive: tuiState.collaborationJoinInputActive,
        collaborationJoinInputValue: tuiState.collaborationJoinInputValue,
        collaborationBusy: tuiState.collaborationBusy,
        collaborationError: tuiState.collaborationError,
        reviewMode: tuiState.reviewMode,
        pendingReviewMode: tuiState.pendingReviewMode,
        scheduleEnabled: tuiState.scheduleEnabled,
        pendingScheduleEnabled: tuiState.pendingScheduleEnabled,
        mergeStrategy: tuiState.mergeStrategy,
        pendingMergeStrategy: tuiState.pendingStrategy,
        bypassEnabled: tuiState.bypassEnabled,
        sessionLimit,
        pendingSessionLimit: tuiState.pendingSessionLimit,
        activeRowIndex: tuiState.controlsRowIndex,
      });
      const content = controlsLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      break;
    }
    case "paused": {
      const overlayLines = renderPausedOverlay(termWidth, termRows, {
        ctrlCPending: tuiState.viewOptions.ctrlCPending,
        pendingQuitKey: tuiState.viewOptions.pendingQuitKey,
        shutdownInProgress: tuiState.viewOptions.shutdownInProgress,
      });
      const content = overlayLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      break;
    }
    case "detail": {
      const detailStatusItem = statusItems.find((item) => item.id === tuiState.detailItemId);
      if (detailStatusItem) {
        const detailSnapshot = detailSnapshots?.get(tuiState.detailItemId!);
        const { lines: overlayLines, totalContentLines } = renderDetailOverlay(detailStatusItem, termWidth, termRows, {
          repoUrl: tuiState.viewOptions.repoUrl,
          priority: detailSnapshot?.priority,
          dependencies: detailSnapshot?.dependencies,
          ciFailCount: detailSnapshot?.ciFailCount,
          retryCount: detailSnapshot?.retryCount,
          scrollOffset: tuiState.detailScrollOffset ?? 0,
          descriptionBody: detailSnapshot?.descriptionBody,
        });
        tuiState.detailContentLines = totalContentLines;
        const content = overlayLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
        break;
      }

      tuiState.detailItemId = null;
      renderDefaultPanel();
      break;
    }
    case "startup": {
      const overlayLines = renderStartupOverlay(termWidth, termRows, tuiState.startupOverlay!);
      const content = overlayLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      break;
    }
    case "none": {
      renderDefaultPanel();
      break;
    }
  }

  write("\x1B[J");
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
  sessionLimit: number | undefined,
  write: (s: string) => void = (s) => process.stdout.write(s),
  viewOptions?: ViewOptions,
  scrollOffset: number = 0,
  remoteItems?: RemoteItemRenderState,
  sessionCode?: string,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
  heartbeats?: ReadonlyMap<string, WorkerProgress>,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, remoteItems, maxTimeoutExtensions, heartbeats);
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();
  const fullScreenViewOptions = termRows >= MIN_FULLSCREEN_ROWS
    ? { ...(viewOptions ?? {}), inlineModeIndicatorOnTitle: true }
    : viewOptions;

  write("\x1B[H");

  if (viewOptions?.showHelp) {
    // Render help overlay instead of the normal frame
    const helpLines = renderHelpOverlay(termWidth, termRows, sessionCode, undefined, readVersion());
    const content = helpLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (termRows >= MIN_FULLSCREEN_ROWS) {
    const layout = buildStatusLayout(statusItems, termWidth, sessionLimit, false, fullScreenViewOptions);
    const clamped = clampScrollOffset(scrollOffset, layout.itemLines.length, Math.max(1, termRows - layout.headerLines.length - layout.footerLines.length));
    const frameLines = renderFullScreenFrame(layout, termRows, termWidth, clamped);
    const content = frameLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else {
    const content = formatStatusTable(statusItems, termWidth, sessionLimit, false, viewOptions);
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  }

  write("\x1B[J");
}

/**
 * Render a panel-aware TUI frame with status/log full-screen pages.
 * Uses buildPanelLayout + renderPanelFrame from status-render.ts.
 * Falls back to renderTuiFrame when the help overlay is active.
 */
export function renderTuiPanelFrame(
  items: OrchestratorItem[],
  sessionLimit: number | undefined,
  tuiState: TuiState,
  write: (s: string) => void = (s) => process.stdout.write(s),
  remoteItems?: RemoteItemRenderState,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
  heartbeats?: ReadonlyMap<string, WorkerProgress>,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, remoteItems, maxTimeoutExtensions, heartbeats);
  const detailSnapshots = new Map<string, TuiDetailSnapshot>(
    items.map((item) => [item.id, {
      priority: item.workItem.priority,
      dependencies: item.workItem.dependencies,
      ciFailCount: item.ciFailCount,
      retryCount: item.retryCount,
      descriptionBody: item.workItem.rawText,
    }]),
  );
  renderTuiPanelFrameFromStatusItems(statusItems, sessionLimit, tuiState, write, detailSnapshots);
}

export function daemonStateToDetailSnapshots(state: DaemonState): Map<string, TuiDetailSnapshot> {
  return new Map<string, TuiDetailSnapshot>(
    state.items.map((item) => [item.id, {
      priority: item.priority,
      dependencies: item.dependencies,
      ciFailCount: item.ciFailCount,
      retryCount: item.retryCount,
      descriptionBody: item.descriptionBody,
    }]),
  );
}

// ── Standalone TUI runner ───────────────────────────────────────────

/**
 * Run a panel-aware TUI loop.
 *
 * Sets up the alternate screen buffer, keyboard shortcuts (Tab, j/k, l, G, q, d, ?, up/down),
 * and a poll-render loop. Returns when the user presses `q` or the signal is aborted.
 *
 * Designed for read-only mode: status.ts can call this to get the full panel TUI
 * without needing the orchestrate event loop.
 */
export async function runTUI(opts: RunTUIOptions): Promise<void> {
  const { getItems, getLogEntries, intervalMs = 2000, signal, panelMode = "status-only" } = opts;
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
    sessionLimit: 1,
    pendingSessionLimit: undefined,
    mergeStrategy: "auto",
    bypassEnabled: false,
    ctrlCPending: false,
    shutdownInProgress: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    showControls: false,
    collaborationMode: "local",
    pendingCollaborationMode: undefined,
    collaborationIntent: "local",
    collaborationJoinInputActive: false,
    collaborationJoinInputValue: "",
    collaborationBusy: false,
    reviewMode: "ninthwave-prs",
    pendingReviewMode: undefined,
    panelMode,
    logBuffer,
    logScrollOffset: 0,
    logFollowMode: true,
    logLevelFilter: "all",
    selectedItemId: undefined,
    visibleItemIds: [],
    detailItemId: null,
    detailScrollOffset: 0,
    detailContentLines: 0,
    savedLogScrollOffset: 0,
    statusLayout: null,
    onUpdate: () => {
      try { render(); } catch { /* non-fatal */ }
    },
    engineDisconnected: false,
  };

  // Noop log for keyboard shortcuts (read-only mode has no orchestrator log)
  const noopLog = (_entry: LogEntry) => {};

  function render() {
    const data = getItems();
    if (data.sessionStartedAt) {
      tuiState.viewOptions.sessionStartedAt = data.sessionStartedAt;
    }
    tuiState.sessionLimit = data.sessionLimit ?? tuiState.sessionLimit;
    tuiState.viewOptions.emptyState = data.viewOptions?.emptyState;
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

    const renderDefaultPanel = () => {
      applyLogFollowMode(tuiState, termRows);
      const filteredLogs = filterLogsByLevel(logBuffer, tuiState.logLevelFilter);

      prepareStatusSelection(tuiState, data.items);
      const panelLayout = buildPanelLayout(
        tuiState.panelMode,
        data.items,
        filteredLogs,
        termWidth,
        termRows,
        {
          sessionLimit: data.sessionLimit,
          viewOptions: tuiState.viewOptions,
          logScrollOffset: tuiState.logScrollOffset,
          statusScrollOffset: tuiState.scrollOffset,
          selectedItemId: tuiState.selectedItemId,
          logFollowMode: tuiState.logFollowMode,
        },
      );
      syncStatusLayout(tuiState, panelLayout, termRows);
      const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
      const content = frameLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    };

    write("\x1B[H");

    switch (resolveActiveTuiOverlay(tuiState)) {
      case "help": {
        const helpLines = renderHelpOverlay(termWidth, termRows, tuiState.sessionCode, tuiState.tmuxSessionName, readVersion());
        const content = helpLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
        break;
      }
      case "controls": {
        const controlsLines = renderControlsOverlay(termWidth, termRows, {
          collaborationMode: tuiState.collaborationMode,
          pendingCollaborationMode: tuiState.pendingCollaborationMode,
          collaborationIntent: tuiState.collaborationIntent,
          sessionCode: tuiState.sessionCode,
          collaborationJoinInputActive: tuiState.collaborationJoinInputActive,
          collaborationJoinInputValue: tuiState.collaborationJoinInputValue,
          collaborationBusy: tuiState.collaborationBusy,
          collaborationError: tuiState.collaborationError,
          reviewMode: tuiState.reviewMode,
          pendingReviewMode: tuiState.pendingReviewMode,
          scheduleEnabled: tuiState.scheduleEnabled,
          pendingScheduleEnabled: tuiState.pendingScheduleEnabled,
          mergeStrategy: tuiState.mergeStrategy,
          pendingMergeStrategy: tuiState.pendingStrategy,
          bypassEnabled: tuiState.bypassEnabled,
          sessionLimit: data.sessionLimit,
          pendingSessionLimit: tuiState.pendingSessionLimit,
        });
        const content = controlsLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
        break;
      }
      case "detail": {
        const detailItem = data.items.find((i) => i.id === tuiState.detailItemId);
        if (detailItem) {
          const { lines: overlayLines, totalContentLines } = renderDetailOverlay(detailItem, termWidth, termRows, {
            repoUrl: tuiState.viewOptions.repoUrl,
            scrollOffset: tuiState.detailScrollOffset ?? 0,
          });
          tuiState.detailContentLines = totalContentLines;
          const content = overlayLines.join("\n");
          write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
          break;
        }

        tuiState.detailItemId = null;
        renderDefaultPanel();
        break;
      }
      case "engine-recovery": {
        const overlayLines = renderEngineRecoveryOverlay(termWidth, termRows, tuiState.engineDisconnectReason);
        const content = overlayLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
        break;
      }
      case "startup": {
        const overlayLines = renderStartupOverlay(termWidth, termRows, tuiState.startupOverlay!);
        const content = overlayLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
        break;
      }
      case "none": {
        renderDefaultPanel();
        break;
      }
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

// ── Update notice ───────────────────────────────────────────────────

export function bootstrapTuiUpdateNotice(
  viewOptions: ViewOptions,
  deps: BootstrapTuiUpdateNoticeDeps = {},
): Promise<void> | null {
  const startupState = (deps.getStartupState ?? getPassiveUpdateStartupState)();
  viewOptions.updateState = startupState.cachedState ?? undefined;
  if (!startupState.shouldRefresh) {
    return null;
  }

  return (deps.refreshUpdateState ?? getPassiveUpdateState)()
    .then((refreshedState) => {
      if (!refreshedState) return;
      viewOptions.updateState = refreshedState;
      deps.onUpdate?.();
    })
    .catch(() => {
      // Best-effort only. Keep any cached notice already shown.
    });
}
