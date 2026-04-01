// TUI keyboard handling: raw-mode stdin listener, scroll/strategy/panel key bindings.
// Also houses log ring-buffer utilities and LogLevelFilter type used by the TUI log panel.
// Extracted from core/commands/orchestrate.ts for modularity.

import type { MergeStrategy } from "./orchestrator.ts";
import type { LogEntry } from "./types.ts";
import {
  type FrameLayout,
  type ViewOptions,
  type PanelMode,
  type LogEntry as PanelLogEntry,
  getTerminalHeight,
  clampScrollOffset,
  detailOverlayMaxScroll,
  scrollStatusItemIntoView,
} from "./status-render.ts";
import {
  TUI_SETTINGS_ROWS,
  collaborationIntentFromMode,
  collaborationIntentToMode,
  runtimeOptionsForSettingsRow,
  type CollaborationIntent,
  type CollaborationMode,
  type ReviewMode,
} from "./tui-settings.ts";

// ── Log ring buffer ────────────────────────────────────────────────

/** Maximum number of log entries retained in the ring buffer for the TUI log panel. */
export const LOG_BUFFER_MAX = 500;

/** Log level filter cycle order for the `l` keyboard shortcut. */
export type LogLevelFilter = "info" | "warn" | "error" | "all";

/** The cycle order for log level filter. */
export const LOG_LEVEL_CYCLE: LogLevelFilter[] = ["info", "warn", "error", "all"];

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

// Re-export runtime control types from status-render for consumers
export type { CollaborationIntent, CollaborationMode, ReviewMode } from "./tui-settings.ts";
export { REVIEW_MODE_CYCLE, COLLABORATION_MODE_CYCLE } from "./tui-settings.ts";

/** Debounce window for merge strategy changes triggered from the TUI. */
export const STRATEGY_DEBOUNCE_MS = 5000;

export interface CollaborationActionResult {
  mode?: CollaborationMode;
  error?: string;
}

type CollaborationActionHandler = () => void | CollaborationActionResult | Promise<void | CollaborationActionResult>;
type CollaborationJoinSubmitHandler = (code: string) => void | CollaborationActionResult | Promise<void | CollaborationActionResult>;

// ── TUI keyboard state ────────────────────────────────────────────

/** Shared mutable state for TUI keyboard shortcuts and scroll. */
export interface TuiState {
  scrollOffset: number;
  viewOptions: ViewOptions;
  /** Engine-confirmed WIP limit from the latest snapshot. */
  wipLimit?: number;
  /** Pending WIP limit request awaiting engine acknowledgement. */
  pendingWipLimit?: number;
  /** Current merge strategy (per-daemon, cycled via Shift+Tab). */
  mergeStrategy: MergeStrategy;
  /** Pending merge strategy selection waiting for debounce to settle. */
  pendingStrategy?: MergeStrategy;
  /** Absolute deadline for the pending strategy debounce window. */
  pendingStrategyDeadlineMs?: number;
  /** Timer for the pending merge strategy debounce window. */
  pendingStrategyTimer?: ReturnType<typeof setTimeout>;
  /** Once-per-second ticker for the pending strategy countdown. */
  pendingStrategyCountdownTimer?: ReturnType<typeof setInterval>;
  /** Whether bypass is available in the cycle (from --dangerously-bypass). */
  bypassEnabled: boolean;
  /** First Ctrl+C pressed -- waiting for confirmation. */
  ctrlCPending: boolean;
  /** Timestamp of the first Ctrl+C press (for 2s timeout). */
  ctrlCTimestamp: number;
  /** Whether the help overlay is visible. */
  showHelp: boolean;
  /** Whether the controls overlay is visible. */
  showControls: boolean;
  /** Active row cursor within the controls overlay (0-based). */
  controlsRowIndex?: number;
  /** Current collaboration mode (per-run, not persisted). */
  collaborationMode: CollaborationMode;
  /** Pending collaboration mode awaiting engine acknowledgement. */
  pendingCollaborationMode?: CollaborationMode;
  /** Active collaboration intent shown in the controls overlay. */
  collaborationIntent?: CollaborationIntent;
  /** Whether the controls overlay is capturing join-session text input. */
  collaborationJoinInputActive?: boolean;
  /** Current join-session input value. */
  collaborationJoinInputValue?: string;
  /** Whether a collaboration action is currently in flight. */
  collaborationBusy?: boolean;
  /** Inline collaboration error shown in the controls overlay. */
  collaborationError?: string;
  /** Current AI review mode (per-run, not persisted). */
  reviewMode: ReviewMode;
  /** Pending review mode awaiting engine acknowledgement. */
  pendingReviewMode?: ReviewMode;
  /** Active page mode: status-only or logs-only. */
  panelMode: PanelMode;
  /** Ring buffer of log entries for the TUI log panel (max LOG_BUFFER_MAX). */
  logBuffer: PanelLogEntry[];
  /** Scroll offset within the log panel. */
  logScrollOffset: number;
  /** Current log level filter. */
  logLevelFilter: LogLevelFilter;
  /** Item ID currently selected in the visible status list. */
  selectedItemId?: string;
  /** Most recent visible selectable item order from the status panel. */
  visibleItemIds?: string[];
  /** Item ID currently shown in the detail panel (null = log panel visible). */
  detailItemId?: string | null;
  /** Scroll offset within the detail overlay content (0 = top). */
  detailScrollOffset?: number;
  /** Saved log scroll offset, restored when returning from detail view. */
  savedLogScrollOffset?: number;
  /** Total content lines in the current detail overlay (set by render loop for clamping). */
  detailContentLines?: number;
  /** Most recent status layout rendered for status-mode navigation/scroll alignment. */
  statusLayout?: FrameLayout | null;
  /** Called after a debounced merge strategy change is applied. */
  onStrategyChange?: (strategy: MergeStrategy) => void;
  /** Called when the user cycles panel mode via Tab (for preference persistence). */
  onPanelModeChange?: (mode: PanelMode) => void;
  /** Called when the user presses +/- to adjust WIP limit. Receives the delta (+1 or -1). */
  onWipChange?: (delta: number) => void;
  /** Called when the review mode changes from the controls overlay. */
  onReviewChange?: (mode: ReviewMode) => void;
  /** Called when the collaboration mode changes from the controls overlay. */
  onCollaborationChange?: (mode: CollaborationMode) => void;
  /** Called when the user selects Local in the controls overlay. */
  onCollaborationLocal?: CollaborationActionHandler;
  /** Called when the user selects Share in the controls overlay. */
  onCollaborationShare?: CollaborationActionHandler;
  /** Called when the user submits a Join code in the controls overlay. */
  onCollaborationJoinSubmit?: CollaborationJoinSubmitHandler;
  /** Called after any key that should trigger an immediate re-render. */
  onUpdate?: () => void;
  /** Extend timeout for the currently selected item in grace period. */
  onExtendTimeout?: (itemId: string) => boolean;
  /** Graceful shutdown request routed through the engine protocol. */
  onShutdown?: () => void;
  /** Session code (if sharing via ninthwave.sh). Shown in help overlay. */
  sessionCode?: string;
  /** Tmux session name (when running outside tmux). Shown in help overlay. */
  tmuxSessionName?: string;
  /** True when the operator lost its child engine and is showing recovery UI. */
  engineDisconnected?: boolean;
  /** Human-readable disconnect reason shown in the recovery overlay. */
  engineDisconnectReason?: string;
}

export interface TuiRuntimeSnapshot {
  mergeStrategy: MergeStrategy;
  wipLimit: number;
  reviewMode: ReviewMode;
  collaborationMode: CollaborationMode;
}

export function applyRuntimeSnapshotToTuiState(
  tuiState: TuiState,
  runtime: TuiRuntimeSnapshot,
): void {
  tuiState.wipLimit = runtime.wipLimit;
  tuiState.mergeStrategy = runtime.mergeStrategy;
  tuiState.viewOptions.mergeStrategy = runtime.mergeStrategy;
  tuiState.reviewMode = runtime.reviewMode;
  tuiState.viewOptions.reviewMode = runtime.reviewMode;
  tuiState.collaborationMode = runtime.collaborationMode;
  tuiState.viewOptions.collaborationMode = runtime.collaborationMode;

  if (tuiState.pendingStrategy === runtime.mergeStrategy) {
    tuiState.pendingStrategy = undefined;
    tuiState.pendingStrategyDeadlineMs = undefined;
    tuiState.viewOptions.pendingStrategy = undefined;
    tuiState.viewOptions.pendingStrategyCountdownSeconds = undefined;
  }
  if (tuiState.pendingReviewMode === runtime.reviewMode) {
    tuiState.pendingReviewMode = undefined;
  }
  if (tuiState.pendingCollaborationMode === runtime.collaborationMode) {
    tuiState.pendingCollaborationMode = undefined;
  }
  if (tuiState.pendingWipLimit === runtime.wipLimit) {
    tuiState.pendingWipLimit = undefined;
  }

  if (!tuiState.collaborationJoinInputActive) {
    tuiState.collaborationIntent = collaborationIntentFromMode(
      tuiState.pendingCollaborationMode ?? runtime.collaborationMode,
    );
    tuiState.viewOptions.collaborationIntent = tuiState.collaborationIntent;
  }
}

/**
 * Set up raw-mode stdin to capture individual keystrokes in TUI mode.
 *
 * - `q` triggers graceful shutdown via the AbortController
 * - Ctrl-C (0x03) triggers the same graceful shutdown
 * - `m` toggles metrics panel
 * - `d` toggles deps detail view
 * - `?` toggles full-screen help overlay
 * - While help is open, only Enter, Escape, and `?` dismiss it
 * - Up/Down arrows are page-aware: navigate items or scroll logs
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

  const pendingStrategyCountdownSeconds = (deadlineMs: number) => Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));

  const clearPendingStrategyTimer = () => {
    if (tuiState?.pendingStrategyTimer) {
      clearTimeout(tuiState.pendingStrategyTimer);
      tuiState.pendingStrategyTimer = undefined;
    }
  };

  const clearPendingStrategyCountdownTimer = () => {
    if (tuiState?.pendingStrategyCountdownTimer) {
      clearInterval(tuiState.pendingStrategyCountdownTimer);
      tuiState.pendingStrategyCountdownTimer = undefined;
    }
  };

  const clearPendingStrategy = () => {
    clearPendingStrategyTimer();
    clearPendingStrategyCountdownTimer();
    if (tuiState) {
      tuiState.pendingStrategy = undefined;
      tuiState.pendingStrategyDeadlineMs = undefined;
      tuiState.viewOptions.pendingStrategy = undefined;
      tuiState.viewOptions.pendingStrategyCountdownSeconds = undefined;
    }
  };

  const queueStrategyChange = (newStrategy: MergeStrategy) => {
    if (!tuiState) return;

    if (newStrategy === tuiState.mergeStrategy) {
      clearPendingStrategy();
      return;
    }

    clearPendingStrategyTimer();
    clearPendingStrategyCountdownTimer();
    const deadlineMs = Date.now() + STRATEGY_DEBOUNCE_MS;
    tuiState.pendingStrategy = newStrategy;
    tuiState.pendingStrategyDeadlineMs = deadlineMs;
    tuiState.viewOptions.pendingStrategy = newStrategy;
    tuiState.viewOptions.pendingStrategyCountdownSeconds = pendingStrategyCountdownSeconds(deadlineMs);
    tuiState.pendingStrategyCountdownTimer = setInterval(() => {
      if (!tuiState.pendingStrategy || tuiState.pendingStrategyDeadlineMs === undefined) return;
      const nextCountdownSeconds = pendingStrategyCountdownSeconds(tuiState.pendingStrategyDeadlineMs);
      if (nextCountdownSeconds !== tuiState.viewOptions.pendingStrategyCountdownSeconds) {
        tuiState.viewOptions.pendingStrategyCountdownSeconds = nextCountdownSeconds;
        tuiState.onUpdate?.();
      }
    }, 1000);
    tuiState.pendingStrategyTimer = setTimeout(() => {
      clearPendingStrategyTimer();
      clearPendingStrategyCountdownTimer();
      tuiState.pendingStrategyDeadlineMs = undefined;
      tuiState.viewOptions.pendingStrategyCountdownSeconds = undefined;
      tuiState.onUpdate?.();
      const pendingStrategy = tuiState.pendingStrategy;
      if (!pendingStrategy || pendingStrategy === tuiState.mergeStrategy) {
        clearPendingStrategy();
        tuiState.onUpdate?.();
        return;
      }
      tuiState.onStrategyChange?.(pendingStrategy);
      tuiState.onUpdate?.();
    }, STRATEGY_DEBOUNCE_MS);
  };

  const syncCollaborationView = () => {
    if (!tuiState) return;
    if (tuiState.collaborationIntent === undefined) {
      tuiState.collaborationIntent = collaborationIntentFromMode(tuiState.collaborationMode);
    }
    if (tuiState.collaborationJoinInputActive === undefined) {
      tuiState.collaborationJoinInputActive = false;
    }
    if (tuiState.collaborationJoinInputValue === undefined) {
      tuiState.collaborationJoinInputValue = "";
    }
    if (tuiState.collaborationBusy === undefined) {
      tuiState.collaborationBusy = false;
    }
    tuiState.viewOptions.collaborationMode = tuiState.collaborationMode;
    tuiState.viewOptions.collaborationIntent = tuiState.collaborationIntent;
    tuiState.viewOptions.collaborationJoinInputActive = tuiState.collaborationJoinInputActive;
    tuiState.viewOptions.collaborationJoinInputValue = tuiState.collaborationJoinInputValue;
    tuiState.viewOptions.collaborationBusy = tuiState.collaborationBusy;
    tuiState.viewOptions.collaborationError = tuiState.collaborationError;
  };

  const setCollaborationMode = (mode: CollaborationMode) => {
    if (!tuiState) return;
    tuiState.collaborationMode = mode;
    tuiState.collaborationIntent = collaborationIntentFromMode(mode);
    syncCollaborationView();
  };

  const resetCollaborationFeedback = () => {
    if (!tuiState) return;
    tuiState.collaborationBusy = false;
    tuiState.collaborationError = undefined;
    syncCollaborationView();
  };

  const exitJoinInput = (preserveIntent = false) => {
    if (!tuiState) return;
    tuiState.collaborationJoinInputActive = false;
    tuiState.collaborationJoinInputValue = "";
    tuiState.collaborationBusy = false;
    tuiState.collaborationError = undefined;
    if (!preserveIntent) {
      tuiState.collaborationIntent = collaborationIntentFromMode(tuiState.collaborationMode);
    }
    syncCollaborationView();
  };

  const enterJoinInput = () => {
    if (!tuiState) return;
    tuiState.collaborationIntent = "join";
    tuiState.collaborationJoinInputActive = true;
    tuiState.collaborationBusy = false;
    tuiState.collaborationError = undefined;
    syncCollaborationView();
  };

  const selectCollaborationIntent = (intent: CollaborationIntent) => {
    if (!tuiState) return;
    tuiState.collaborationIntent = intent;
    tuiState.collaborationError = undefined;
    syncCollaborationView();
  };

  const applyCollaborationActionResult = (
    fallbackMode: CollaborationMode,
    result?: void | CollaborationActionResult,
  ) => {
    if (!tuiState) return;
    if (result?.error) {
      tuiState.collaborationBusy = false;
      tuiState.collaborationError = result.error;
      syncCollaborationView();
      tuiState.onUpdate?.();
      return;
    }

    const nextMode = result?.mode ?? fallbackMode;
    tuiState.pendingCollaborationMode = nextMode;
    tuiState.collaborationBusy = false;
    tuiState.collaborationError = undefined;
    if (nextMode === "joined") {
      exitJoinInput(true);
    } else {
      exitJoinInput(true);
    }
    syncCollaborationView();
    tuiState.onUpdate?.();
  };

  const runCollaborationAction = (
    fallbackMode: CollaborationMode,
    handler?: CollaborationActionHandler | CollaborationJoinSubmitHandler,
    arg?: string,
  ) => {
    if (!tuiState) return;
    tuiState.collaborationBusy = true;
    tuiState.collaborationError = undefined;
    syncCollaborationView();
    tuiState.onUpdate?.();
    try {
      const maybePromise = arg === undefined
        ? (handler as CollaborationActionHandler | undefined)?.()
        : (handler as CollaborationJoinSubmitHandler | undefined)?.(arg);
      if (maybePromise && typeof (maybePromise as PromiseLike<void | CollaborationActionResult>).then === "function") {
        void (maybePromise as Promise<void | CollaborationActionResult>)
          .then((result) => applyCollaborationActionResult(fallbackMode, result))
          .catch((error: unknown) => {
            if (!tuiState) return;
            tuiState.collaborationBusy = false;
            tuiState.collaborationError = error instanceof Error ? error.message : String(error);
            syncCollaborationView();
            tuiState.onUpdate?.();
          });
        return;
      }
      applyCollaborationActionResult(fallbackMode, maybePromise as void | CollaborationActionResult);
    } catch (error: unknown) {
      tuiState.collaborationBusy = false;
      tuiState.collaborationError = error instanceof Error ? error.message : String(error);
      syncCollaborationView();
      tuiState.onUpdate?.();
    }
  };

  const triggerCollaborationIntent = (intent: CollaborationIntent) => {
    if (!tuiState) return;
    resetCollaborationFeedback();
    if (intent === "join") {
      enterJoinInput();
      return;
    }

    const fallbackMode = collaborationIntentToMode(intent);
    const handler = intent === "share"
      ? (tuiState.onCollaborationShare ?? (() => tuiState.onCollaborationChange?.("shared")))
      : (tuiState.onCollaborationLocal ?? (() => tuiState.onCollaborationChange?.("local")));
    runCollaborationAction(fallbackMode, handler);
  };

  const submitJoinInput = () => {
    if (!tuiState) return;
    const joinCode = (tuiState.collaborationJoinInputValue ?? "").trim();
    if (!joinCode) {
      tuiState.collaborationError = "Enter a session code to join.";
      syncCollaborationView();
      tuiState.onUpdate?.();
      return;
    }

    const handler = tuiState.onCollaborationJoinSubmit ?? (() => tuiState.onCollaborationChange?.("joined"));
    runCollaborationAction("joined", handler, joinCode);
  };

  const clampControlsRowIndex = () => {
    if (!tuiState) return;
    tuiState.controlsRowIndex = Math.max(0, Math.min(tuiState.controlsRowIndex ?? 0, TUI_SETTINGS_ROWS.length - 1));
  };

  const dismissControls = () => {
    if (!tuiState) return;
    exitJoinInput();
    tuiState.showControls = false;
    tuiState.viewOptions.showControls = false;
  };

  const setHelpVisible = (visible: boolean) => {
    if (!tuiState) return;
    tuiState.showHelp = visible;
    tuiState.viewOptions.showHelp = visible;
    if (visible) {
      dismissControls();
    }
  };

  const toggleHelp = () => {
    if (!tuiState) return;
    setHelpVisible(!tuiState.showHelp);
  };

  const setControlsVisible = (visible: boolean) => {
    if (!tuiState) return;
    if (visible) {
      setHelpVisible(false);
      clampControlsRowIndex();
      exitJoinInput();
      syncCollaborationView();
    } else {
      exitJoinInput();
    }
    tuiState.showControls = visible;
    tuiState.viewOptions.showControls = visible;
  };

  const moveControlsRow = (delta: number) => {
    if (!tuiState) return;
    clampControlsRowIndex();
    tuiState.controlsRowIndex = Math.max(
      0,
      Math.min((tuiState.controlsRowIndex ?? 0) + delta, TUI_SETTINGS_ROWS.length - 1),
    );
  };

  const adjustControlsValue = (delta: -1 | 1) => {
    if (!tuiState) return;
    clampControlsRowIndex();
    const row = TUI_SETTINGS_ROWS[tuiState.controlsRowIndex ?? 0] ?? TUI_SETTINGS_ROWS[0]!;
    if (row.kind === "number") {
      const baseLimit = tuiState.pendingWipLimit ?? tuiState.wipLimit ?? 1;
      const nextLimit = Math.max(1, baseLimit + delta);
      tuiState.pendingWipLimit = nextLimit === (tuiState.wipLimit ?? 1) ? undefined : nextLimit;
      tuiState.onWipChange?.(delta);
      return;
    }

    const options = runtimeOptionsForSettingsRow(row, tuiState.bypassEnabled);
    const currentValue = row.id === "collaboration_mode"
      ? (tuiState.pendingCollaborationMode
        ?? collaborationIntentToMode(tuiState.collaborationIntent ?? collaborationIntentFromMode(tuiState.collaborationMode)))
      : row.id === "review_mode"
        ? (tuiState.pendingReviewMode ?? tuiState.reviewMode)
        : (tuiState.pendingStrategy ?? tuiState.mergeStrategy);
    const currentIdx = options.findIndex((option) => option.runtimeValue === currentValue);
    if (currentIdx < 0) return;
    const nextIdx = Math.max(0, Math.min(currentIdx + delta, options.length - 1));
    if (nextIdx === currentIdx) return;
    const nextOption = options[nextIdx]!;

    if (row.id === "collaboration_mode") {
      const intent = collaborationIntentFromMode(nextOption.runtimeValue as CollaborationMode);
      selectCollaborationIntent(intent);
      return;
    }

    if (row.id === "review_mode") {
      const oldMode = tuiState.reviewMode;
      const newMode = nextOption.runtimeValue as ReviewMode;
      tuiState.pendingReviewMode = newMode === tuiState.reviewMode ? undefined : newMode;
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "review_mode_change",
        oldMode,
        newMode,
      });
      tuiState.onReviewChange?.(newMode);
      return;
    }

    const newStrategy = nextOption.runtimeValue as MergeStrategy;
    const oldStrategy = tuiState.pendingStrategy ?? tuiState.mergeStrategy;
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "strategy_cycle",
      oldStrategy,
      newStrategy,
    });
    queueStrategyChange(newStrategy);
  };

  const moveStatusSelection = (delta: -1 | 1) => {
    if (!tuiState) return;

    const selectableItemIds = tuiState.statusLayout?.visibleLayout?.selectableItemIds
      ?? tuiState.visibleItemIds
      ?? [];
    const count = selectableItemIds.length;
    if (count <= 0) return;

    const currentIndex = Math.max(
      0,
      Math.min(
        tuiState.selectedItemId ? selectableItemIds.indexOf(tuiState.selectedItemId) : 0,
        count - 1,
      ),
    );
    const nextIndex = (currentIndex + delta + count) % count;
    tuiState.selectedItemId = selectableItemIds[nextIndex];

    const selectedItemId = selectableItemIds[nextIndex];
    if (selectedItemId && tuiState.statusLayout) {
      tuiState.scrollOffset = scrollStatusItemIntoView(
        tuiState.statusLayout,
        getTerminalHeight(),
        tuiState.scrollOffset,
        selectedItemId,
        delta,
      );
      return;
    }

    if (delta < 0) {
      tuiState.scrollOffset = Math.min(tuiState.scrollOffset, nextIndex);
    } else {
      tuiState.scrollOffset = nextIndex;
    }
  };

  const onData = (key: string) => {
    // q still exits immediately (discoverable via ? help overlay)
    if (key === "q") {
      log({ ts: new Date().toISOString(), level: "info", event: "keyboard_quit", key: "q" });
      if (tuiState?.onShutdown) {
        tuiState.onShutdown();
      } else {
        abortController.abort();
      }
      return;
    }

    // Ctrl+C: double-tap to exit
    if (key === "\x03") {
      if (tuiState?.ctrlCPending && Date.now() - tuiState.ctrlCTimestamp < 2000) {
        // Second press within 2s -- exit
        if (ctrlCTimer) clearTimeout(ctrlCTimer);
        log({ ts: new Date().toISOString(), level: "info", event: "keyboard_quit", key: "ctrl-c" });
        if (tuiState?.onShutdown) {
          tuiState.onShutdown();
        } else {
          abortController.abort();
        }
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

    if (tuiState.showHelp) {
      switch (key) {
        case "\r":
        case "\x1b":
        case "?":
          setHelpVisible(false);
          tuiState.onUpdate?.();
          return;
        default:
          return;
      }
    }

    if (tuiState.showControls) {
      if (tuiState.collaborationJoinInputActive) {
        switch (key) {
          case "\r":
            submitJoinInput();
            return;
          case "\x1b":
            exitJoinInput();
            tuiState.onUpdate?.();
            return;
          case "\x7f":
          case "\b":
            if (!tuiState.collaborationBusy && (tuiState.collaborationJoinInputValue ?? "").length > 0) {
              tuiState.collaborationJoinInputValue = (tuiState.collaborationJoinInputValue ?? "").slice(0, -1);
              tuiState.collaborationError = undefined;
              syncCollaborationView();
              tuiState.onUpdate?.();
            }
            return;
          default:
            if (!tuiState.collaborationBusy && /^[\x20-\x7E]$/.test(key)) {
              tuiState.collaborationJoinInputValue += key.toUpperCase();
              tuiState.collaborationError = undefined;
              syncCollaborationView();
              tuiState.onUpdate?.();
              return;
            }
        }
      }

      switch (key) {
        case "\x1b[A":
          moveControlsRow(-1);
          tuiState.onUpdate?.();
          return;
        case "\x1b[B":
          moveControlsRow(1);
          tuiState.onUpdate?.();
          return;
        case "\x1b[D":
          adjustControlsValue(-1);
          tuiState.onUpdate?.();
          return;
        case "\x1b[C":
          adjustControlsValue(1);
          tuiState.onUpdate?.();
          return;
        case "\r": {
          clampControlsRowIndex();
          const row = TUI_SETTINGS_ROWS[tuiState.controlsRowIndex ?? 0] ?? TUI_SETTINGS_ROWS[0]!;
          if (row.id === "collaboration_mode") {
            if ((tuiState.collaborationIntent ?? collaborationIntentFromMode(tuiState.collaborationMode)) === "join") {
              enterJoinInput();
            } else {
              triggerCollaborationIntent(tuiState.collaborationIntent ?? collaborationIntentFromMode(tuiState.collaborationMode));
            }
            tuiState.onUpdate?.();
            return;
          }
          dismissControls();
          tuiState.onUpdate?.();
          return;
        }
        case "\x1b":
          dismissControls();
          tuiState.onUpdate?.();
          return;
      }
    }

    switch (key) {
      case "?":
        toggleHelp();
        break;
      case "c": // Toggle controls overlay
        setControlsVisible(!tuiState.showControls);
        break;
      case "\x1b": // Raw Escape (length 1) -- dismiss help, controls, or detail panel
        // Only treat single-byte \x1b as Escape. Arrow keys send \x1b[A etc.
        // which are longer sequences and won't match this case.
        if (tuiState.showControls) {
          setControlsVisible(false);
        } else if (tuiState.detailItemId) {
          // Return from detail view to log panel, restore scroll offset
          tuiState.detailItemId = null;
          tuiState.detailScrollOffset = 0;
          tuiState.logScrollOffset = tuiState.savedLogScrollOffset ?? 0;
        } else {
          handled = false;
        }
        break;
      case "d":
        tuiState.viewOptions.showBlockerDetail = !tuiState.viewOptions.showBlockerDetail;
        break;
      case "x": {
        if (tuiState.showHelp || tuiState.detailItemId) {
          handled = false;
          break;
        }
        const itemId = tuiState.selectedItemId;
        handled = itemId ? (tuiState.onExtendTimeout?.(itemId) ?? false) : false;
        break;
      }
      case "\r": // Enter -- open detail panel for selected item
      case "i": { // i -- open detail panel for selected item
        const itemId = tuiState.selectedItemId;
        if (itemId && !tuiState.detailItemId) {
          tuiState.savedLogScrollOffset = tuiState.logScrollOffset;
          tuiState.detailItemId = itemId;
          tuiState.detailScrollOffset = 0;
        }
        break;
      }
      case "\x1b[A": { // Up arrow
        if (tuiState.detailItemId) {
          // Scroll detail overlay up
          tuiState.detailScrollOffset = Math.max(0, (tuiState.detailScrollOffset ?? 0) - 1);
        } else if (tuiState.panelMode === "logs-only") {
          tuiState.logScrollOffset = Math.max(0, tuiState.logScrollOffset - 1);
        } else {
          moveStatusSelection(-1);
        }
        break;
      }
      case "\x1b[B": { // Down arrow
        if (tuiState.detailItemId) {
          // Scroll detail overlay down
          const maxScroll = detailOverlayMaxScroll(tuiState.detailContentLines ?? 0, getTerminalHeight());
          tuiState.detailScrollOffset = Math.min(maxScroll, (tuiState.detailScrollOffset ?? 0) + 1);
        } else if (tuiState.panelMode === "logs-only") {
          tuiState.logScrollOffset += 1;
        } else {
          moveStatusSelection(1);
        }
        break;
      }
      case "\t": { // Tab -- cycle panel mode (status-only <-> logs-only)
        const modes: PanelMode[] = ["status-only", "logs-only"];
        const currentIdx = modes.indexOf(tuiState.panelMode);
        const nextIdx = (currentIdx + 1) % modes.length;
        tuiState.panelMode = modes[nextIdx]!;
        tuiState.onPanelModeChange?.(tuiState.panelMode);
        break;
      }
      case "j": // Scroll down (detail overlay or log panel)
        if (tuiState.detailItemId) {
          const maxScroll = detailOverlayMaxScroll(tuiState.detailContentLines ?? 0, getTerminalHeight());
          tuiState.detailScrollOffset = Math.min(maxScroll, (tuiState.detailScrollOffset ?? 0) + 1);
        } else if (tuiState.panelMode === "logs-only") {
          tuiState.logScrollOffset += 1;
        } else {
          moveStatusSelection(1);
        }
        break;
      case "k": // Scroll up (detail overlay or log panel)
        if (tuiState.detailItemId) {
          tuiState.detailScrollOffset = Math.max(0, (tuiState.detailScrollOffset ?? 0) - 1);
        } else if (tuiState.panelMode === "logs-only") {
          tuiState.logScrollOffset = Math.max(0, tuiState.logScrollOffset - 1);
        } else {
          moveStatusSelection(-1);
        }
        break;
      case "l": { // Cycle log level filter (info -> warn -> error -> all)
        const currentIdx = LOG_LEVEL_CYCLE.indexOf(tuiState.logLevelFilter);
        const nextIdx = (currentIdx + 1) % LOG_LEVEL_CYCLE.length;
        tuiState.logLevelFilter = LOG_LEVEL_CYCLE[nextIdx]!;
        // Reset scroll when filter changes
        tuiState.logScrollOffset = 0;
        break;
      }
      case "G": { // Jump to end (detail overlay or log)
        if (tuiState.detailItemId) {
          const maxScroll = detailOverlayMaxScroll(tuiState.detailContentLines ?? 0, getTerminalHeight());
          tuiState.detailScrollOffset = maxScroll;
        } else if (tuiState.panelMode === "logs-only") {
          const filtered = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
          const termRows = getTerminalHeight();
          const viewportHeight = Math.max(1, termRows - 10); // approximate
          tuiState.logScrollOffset = Math.max(0, filtered.length - viewportHeight);
        } else {
          handled = false;
        }
        break;
      }
      case "\x1B[Z": { // Shift+Tab -- cycle merge strategy
        const strategies: MergeStrategy[] = tuiState.bypassEnabled
          ? ["auto", "manual", "bypass"]
          : ["auto", "manual"];
        const currentIdx = strategies.indexOf(tuiState.pendingStrategy ?? tuiState.mergeStrategy);
        const nextIdx = (currentIdx + 1) % strategies.length;
        const oldStrategy = tuiState.pendingStrategy ?? tuiState.mergeStrategy;
        const nextStrategy = strategies[nextIdx]!;
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "strategy_cycle",
          oldStrategy,
          newStrategy: nextStrategy,
        });
        queueStrategyChange(nextStrategy);
        break;
      }
      case "+":
      case "=": { // + (or = without shift) -- increase WIP limit
        const baseLimit = tuiState.pendingWipLimit ?? tuiState.wipLimit ?? 1;
        const nextLimit = Math.max(1, baseLimit + 1);
        tuiState.pendingWipLimit = nextLimit === (tuiState.wipLimit ?? 1) ? undefined : nextLimit;
        tuiState.onWipChange?.(1);
        break;
      }
      case "-":
      case "_": { // - (or _ with shift) -- decrease WIP limit
        const baseLimit = tuiState.pendingWipLimit ?? tuiState.wipLimit ?? 1;
        const nextLimit = Math.max(1, baseLimit - 1);
        tuiState.pendingWipLimit = nextLimit === (tuiState.wipLimit ?? 1) ? undefined : nextLimit;
        tuiState.onWipChange?.(-1);
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
      const viewportHeight = Math.max(1, termRows - 10); // approximate fallback
      const itemLineCount = tuiState.statusLayout?.itemLines.length ?? 999;
      tuiState.scrollOffset = clampScrollOffset(tuiState.scrollOffset, itemLineCount, viewportHeight);
      // Also clamp log scroll offset on resize
      const filtered = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
      tuiState.logScrollOffset = clampScrollOffset(tuiState.logScrollOffset, filtered.length, viewportHeight);
      tuiState.onUpdate?.();
    }
  };

  syncCollaborationView();

  stdin.on("data", onData);
  process.stdout.on("resize", onResize);

  return () => {
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    clearPendingStrategy();
    stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);
    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };
}
