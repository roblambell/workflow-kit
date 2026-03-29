// TUI keyboard handling: raw-mode stdin listener, scroll/strategy/panel key bindings.
// Also houses log ring-buffer utilities and LogLevelFilter type used by the TUI log panel.
// Extracted from core/commands/orchestrate.ts for modularity.

import type { MergeStrategy } from "./orchestrator.ts";
import type { LogEntry } from "./types.ts";
import {
  type ViewOptions,
  type PanelMode,
  type LogEntry as PanelLogEntry,
  getTerminalHeight,
  clampScrollOffset,
  MIN_SPLIT_ROWS,
} from "./status-render.ts";

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

// ── TUI keyboard state ────────────────────────────────────────────

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
      case "\x1b[A": { // Up arrow
        if ((tuiState.selectedIndex ?? 0) > 0) {
          tuiState.selectedIndex = (tuiState.selectedIndex ?? 0) - 1;
        }
        // Scroll follows selection: keep selected item in view
        tuiState.scrollOffset = Math.min(tuiState.scrollOffset, tuiState.selectedIndex ?? 0);
        break;
      }
      case "\x1b[B": { // Down arrow
        const maxIdx = (tuiState.getItemCount?.() ?? 0) - 1;
        const curIdx = tuiState.selectedIndex ?? 0;
        if (curIdx < maxIdx) {
          tuiState.selectedIndex = curIdx + 1;
        }
        // Scroll follows selection: ensure selected item stays visible
        tuiState.scrollOffset = tuiState.selectedIndex ?? 0;
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
