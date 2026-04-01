// Tests for core/tui-keyboard.ts -- keyboard handler, controls overlay,
// WIP +/- shortcuts, and runtime control state management.

import { describe, it, expect, vi } from "vitest";
import {
  setupKeyboardShortcuts,
  pushLogBuffer,
  filterLogsByLevel,
  LOG_BUFFER_MAX,
  LOG_LEVEL_CYCLE,
  REVIEW_MODE_CYCLE,
  COLLABORATION_MODE_CYCLE,
  STRATEGY_DEBOUNCE_MS,
  type TuiState,
  type LogLevelFilter,
  type CollaborationMode,
  type ReviewMode,
} from "../core/tui-keyboard.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";
import type { ViewOptions, PanelMode, LogEntry as PanelLogEntry } from "../core/status-render.ts";
import { EventEmitter } from "events";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fake TTY stdin that supports raw mode and data events. */
function makeFakeStdin(): EventEmitter & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; setEncoding: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as any;
  emitter.isTTY = true;
  emitter.setRawMode = vi.fn();
  emitter.resume = vi.fn();
  emitter.setEncoding = vi.fn();
  emitter.pause = vi.fn();
  return emitter;
}

/** Create a minimal TuiState for testing. */
function makeTuiState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    scrollOffset: 0,
    viewOptions: { showBlockerDetail: true },
    mergeStrategy: "manual" as MergeStrategy,
    pendingStrategy: undefined,
    pendingStrategyTimer: undefined,
    bypassEnabled: false,
    ctrlCPending: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    showControls: false,
    collaborationMode: "local",
    reviewMode: "off",
    panelMode: "status-only" as PanelMode,
    logBuffer: [],
    logScrollOffset: 0,
    logLevelFilter: "all" as LogLevelFilter,
    selectedIndex: 0,
    detailItemId: null,
    detailScrollOffset: 0,
    detailContentLines: 0,
    savedLogScrollOffset: 0,
    ...overrides,
  };
}

// ── Log ring buffer ──────────────────────────────────────────────────────────

describe("pushLogBuffer", () => {
  it("appends entries up to LOG_BUFFER_MAX", () => {
    const buffer: PanelLogEntry[] = [];
    for (let i = 0; i < LOG_BUFFER_MAX + 10; i++) {
      pushLogBuffer(buffer, { timestamp: `t${i}`, itemId: `I-${i}`, message: `msg ${i}` });
    }
    expect(buffer.length).toBe(LOG_BUFFER_MAX);
    expect(buffer[0]!.message).toBe(`msg 10`);
  });
});

describe("filterLogsByLevel", () => {
  const buffer: PanelLogEntry[] = [
    { timestamp: "t1", itemId: "I-1", message: "[error] something failed" },
    { timestamp: "t2", itemId: "I-2", message: "[warn] something off" },
    { timestamp: "t3", itemId: "I-3", message: "[info] all good" },
    { timestamp: "t4", itemId: "I-4", message: "no prefix" },
  ];

  it("returns all entries for 'all' filter", () => {
    expect(filterLogsByLevel(buffer, "all")).toHaveLength(4);
  });

  it("filters by error level", () => {
    expect(filterLogsByLevel(buffer, "error")).toHaveLength(1);
    expect(filterLogsByLevel(buffer, "error")[0]!.message).toContain("error");
  });

  it("filters by warn level (includes error)", () => {
    expect(filterLogsByLevel(buffer, "warn")).toHaveLength(2);
  });

  it("filters by info level (includes warn, error, and untagged)", () => {
    expect(filterLogsByLevel(buffer, "info")).toHaveLength(4);
  });
});

// ── Type exports ─────────────────────────────────────────────────────────────

describe("runtime control type cycle arrays", () => {
  it("REVIEW_MODE_CYCLE contains all three modes", () => {
    expect(REVIEW_MODE_CYCLE).toEqual(["off", "ninthwave-prs", "all-prs"]);
  });

  it("COLLABORATION_MODE_CYCLE contains all three modes", () => {
    expect(COLLABORATION_MODE_CYCLE).toEqual(["local", "shared", "joined"]);
  });
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

describe("setupKeyboardShortcuts", () => {
  it("returns a noop cleanup when stdin is not a TTY", () => {
    const ac = new AbortController();
    const cleanup = setupKeyboardShortcuts(ac, () => {}, { isTTY: false } as any);
    expect(typeof cleanup).toBe("function");
    cleanup();
    expect(ac.signal.aborted).toBe(false);
  });

  it("q key triggers abort", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any);
    stdin.emit("data", "q");
    expect(ac.signal.aborted).toBe(true);
    cleanup();
  });

  it("? key toggles help overlay", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState();
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "?");
    expect(state.showHelp).toBe(true);
    expect(state.viewOptions.showHelp).toBe(true);

    stdin.emit("data", "?");
    expect(state.showHelp).toBe(false);
    cleanup();
  });

  it("c key toggles controls overlay", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState();
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "c");
    expect(state.showControls).toBe(true);
    expect(state.viewOptions.showControls).toBe(true);

    stdin.emit("data", "c");
    expect(state.showControls).toBe(false);
    expect(state.viewOptions.showControls).toBe(false);
    cleanup();
  });

  it("c key closes help when opening controls", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showHelp: true });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "c");
    expect(state.showControls).toBe(true);
    expect(state.showHelp).toBe(false);
    cleanup();
  });

  it("? key closes controls when opening help", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showControls: true });
    state.viewOptions.showControls = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "?");
    expect(state.showHelp).toBe(true);
    expect(state.showControls).toBe(false);
    cleanup();
  });

  it("Escape dismisses controls overlay", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showControls: true });
    state.viewOptions.showControls = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b");
    expect(state.showControls).toBe(false);
    expect(state.viewOptions.showControls).toBe(false);
    cleanup();
  });

  it("Escape dismisses help overlay before controls", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showHelp: true });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b");
    expect(state.showHelp).toBe(false);
    cleanup();
  });

  it("+ and = increase WIP via onWipChange", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onWipChange = vi.fn();
    const state = makeTuiState({ onWipChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "+");
    expect(onWipChange).toHaveBeenCalledWith(1);

    stdin.emit("data", "=");
    expect(onWipChange).toHaveBeenCalledTimes(2);
    expect(onWipChange).toHaveBeenLastCalledWith(1);
    cleanup();
  });

  it("- and _ decrease WIP via onWipChange", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onWipChange = vi.fn();
    const state = makeTuiState({ onWipChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "-");
    expect(onWipChange).toHaveBeenCalledWith(-1);

    stdin.emit("data", "_");
    expect(onWipChange).toHaveBeenCalledTimes(2);
    expect(onWipChange).toHaveBeenLastCalledWith(-1);
    cleanup();
  });

  it("+/- work while controls overlay is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onWipChange = vi.fn();
    const state = makeTuiState({ showControls: true, onWipChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "+");
    expect(onWipChange).toHaveBeenCalledWith(1);

    stdin.emit("data", "-");
    expect(onWipChange).toHaveBeenCalledWith(-1);
    cleanup();
  });

  it("Tab toggles between exactly two panel modes", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onPanelModeChange = vi.fn();
    const state = makeTuiState({ panelMode: "status-only", onPanelModeChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\t");
    expect(state.panelMode).toBe("logs-only");
    expect(onPanelModeChange).toHaveBeenLastCalledWith("logs-only");

    stdin.emit("data", "\t");
    expect(state.panelMode).toBe("status-only");
    expect(onPanelModeChange).toHaveBeenLastCalledWith("status-only");

    cleanup();
  });

  it("Up/Down navigate items on the status page", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      panelMode: "status-only",
      selectedIndex: 1,
      getItemCount: () => 4,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[A");
    expect(state.selectedIndex).toBe(0);
    expect(state.logScrollOffset).toBe(0);

    stdin.emit("data", "\x1b[B");
    expect(state.selectedIndex).toBe(1);
    expect(state.scrollOffset).toBe(1);

    cleanup();
  });

  it("Up/Down scroll logs on the logs page", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      panelMode: "logs-only",
      logScrollOffset: 2,
      selectedIndex: 1,
      getItemCount: () => 4,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[A");
    expect(state.logScrollOffset).toBe(1);
    expect(state.selectedIndex).toBe(1);

    stdin.emit("data", "\x1b[B");
    expect(state.logScrollOffset).toBe(2);
    expect(state.selectedIndex).toBe(1);

    cleanup();
  });

  it("j/k remain log scroll aliases on the logs page", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ panelMode: "logs-only", logScrollOffset: 1 });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "j");
    expect(state.logScrollOffset).toBe(2);

    stdin.emit("data", "k");
    expect(state.logScrollOffset).toBe(1);

    cleanup();
  });
});

// ── Controls overlay number-key selection ────────────────────────────────────

describe("controls overlay number-key selection", () => {
  it("keys 1-3 change collaboration mode", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onCollabChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      collaborationMode: "local",
      onCollaborationChange: onCollabChange,
    });
    state.viewOptions.collaborationMode = "local";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "2");
    expect(state.collaborationMode).toBe("shared");
    expect(onCollabChange).toHaveBeenCalledWith("shared");

    stdin.emit("data", "3");
    expect(state.collaborationMode).toBe("joined");
    expect(onCollabChange).toHaveBeenCalledWith("joined");

    stdin.emit("data", "1");
    expect(state.collaborationMode).toBe("local");
    expect(onCollabChange).toHaveBeenCalledWith("local");
    cleanup();
  });

  it("keys 4-6 change review mode", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onReviewChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      reviewMode: "off",
      onReviewChange,
    });
    state.viewOptions.reviewMode = "off";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "5");
    expect(state.reviewMode).toBe("ninthwave-prs");
    expect(onReviewChange).toHaveBeenCalledWith("ninthwave-prs");

    stdin.emit("data", "6");
    expect(state.reviewMode).toBe("all-prs");
    expect(onReviewChange).toHaveBeenCalledWith("all-prs");

    stdin.emit("data", "4");
    expect(state.reviewMode).toBe("off");
    expect(onReviewChange).toHaveBeenCalledWith("off");
    cleanup();
  });

  it("keys 7-8 change merge strategy", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      mergeStrategy: "manual",
      onStrategyChange,
    });
    state.viewOptions.mergeStrategy = "manual";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "8");
    expect(state.mergeStrategy).toBe("manual");
    expect(state.pendingStrategy).toBe("auto");
    expect(onStrategyChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);
    expect(state.mergeStrategy).toBe("auto");
    expect(state.pendingStrategy).toBeUndefined();
    expect(onStrategyChange).toHaveBeenCalledWith("auto");

    stdin.emit("data", "7");
    expect(state.pendingStrategy).toBe("manual");
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);
    expect(state.mergeStrategy).toBe("manual");
    expect(onStrategyChange).toHaveBeenCalledWith("manual");
    cleanup();
    vi.useRealTimers();
  });

  it("key 9 is a no-op when bypass is hidden", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      mergeStrategy: "manual",
      bypassEnabled: false,
      onStrategyChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "9");
    expect(state.mergeStrategy).toBe("manual");
    expect(onStrategyChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("key 9 sets bypass when bypassEnabled", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      mergeStrategy: "manual",
      bypassEnabled: true,
      onStrategyChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "9");
    expect(state.mergeStrategy).toBe("manual");
    expect(state.pendingStrategy).toBe("bypass");
    expect(onStrategyChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);
    expect(state.pendingStrategy).toBeUndefined();
    expect(state.mergeStrategy).toBe("bypass");
    expect(onStrategyChange).toHaveBeenCalledWith("bypass");
    cleanup();
    vi.useRealTimers();
  });

  it("number keys are not handled when controls overlay is closed", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onCollabChange = vi.fn();
    const onUpdate = vi.fn();
    const state = makeTuiState({
      showControls: false,
      onCollaborationChange: onCollabChange,
      onUpdate,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "2");
    expect(onCollabChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("selecting the already-active mode does not fire callback", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onReviewChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      reviewMode: "off",
      onReviewChange,
    });
    state.viewOptions.reviewMode = "off";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "4"); // 4 = Off, already active
    expect(onReviewChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("onUpdate is called after number-key selection in controls", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onUpdate = vi.fn();
    const state = makeTuiState({
      showControls: true,
      collaborationMode: "local",
      onUpdate,
    });
    state.viewOptions.collaborationMode = "local";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "2");
    expect(onUpdate).toHaveBeenCalled();
    cleanup();
  });
});

// ── Shift+Tab merge strategy cycle ───────────────────────────────────────────

describe("Shift+Tab merge strategy cycle", () => {
  it("sets pending strategy without applying immediately", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      mergeStrategy: "auto",
      bypassEnabled: false,
      onStrategyChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1B[Z"); // Shift+Tab
    expect(state.mergeStrategy).toBe("auto");
    expect(state.pendingStrategy).toBe("manual");
    expect(state.viewOptions.pendingStrategy).toBe("manual");
    expect(onStrategyChange).not.toHaveBeenCalled();

    cleanup();
    vi.useRealTimers();
  });

  it("resets the debounce timer on rapid Shift+Tab presses", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      mergeStrategy: "auto",
      bypassEnabled: false,
      onStrategyChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1B[Z");
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS - 1000);

    stdin.emit("data", "\x1B[Z");
    expect(state.pendingStrategy).toBeUndefined();
    expect(state.mergeStrategy).toBe("auto");

    vi.advanceTimersByTime(1000);
    expect(onStrategyChange).not.toHaveBeenCalled();
    expect(state.mergeStrategy).toBe("auto");

    cleanup();
    vi.useRealTimers();
  });

  it("applies the final strategy after the debounce period", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      mergeStrategy: "auto",
      bypassEnabled: true,
      onStrategyChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1B[Z");
    stdin.emit("data", "\x1B[Z");
    expect(state.pendingStrategy).toBe("bypass");

    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);
    expect(state.mergeStrategy).toBe("bypass");
    expect(state.pendingStrategy).toBeUndefined();
    expect(onStrategyChange).toHaveBeenCalledTimes(1);
    expect(onStrategyChange).toHaveBeenCalledWith("bypass");

    cleanup();
    vi.useRealTimers();
  });

  it("includes bypass in cycle when enabled", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      mergeStrategy: "manual",
      bypassEnabled: true,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1B[Z");
    expect(state.pendingStrategy).toBe("bypass");
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);
    expect(state.mergeStrategy).toBe("bypass");

    stdin.emit("data", "\x1B[Z");
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);
    expect(state.mergeStrategy).toBe("auto");
    cleanup();
    vi.useRealTimers();
  });
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

describe("cleanup function", () => {
  it("restores terminal state and pauses stdin", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState();
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    cleanup();
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
  });

  it("clears the pending strategy timer on cleanup", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      mergeStrategy: "auto",
      onStrategyChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1B[Z");
    expect(state.pendingStrategyTimer).toBeDefined();

    cleanup();
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS);

    expect(state.pendingStrategyTimer).toBeUndefined();
    expect(state.pendingStrategy).toBeUndefined();
    expect(onStrategyChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ── Detail overlay scroll ────────────────────────────────────────────────────

describe("detail overlay scroll keys", () => {
  it("down arrow scrolls detail content when overlay is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 0,
      detailContentLines: 500, // enough to overflow any terminal
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[B"); // Down arrow
    expect(state.detailScrollOffset).toBe(1);
    // Selection should NOT have moved
    expect(state.selectedIndex).toBe(0);
    cleanup();
  });

  it("up arrow scrolls detail content up when overlay is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 5,
      detailContentLines: 500,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[A"); // Up arrow
    expect(state.detailScrollOffset).toBe(4);
    cleanup();
  });

  it("up arrow does not scroll below 0", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 0,
      detailContentLines: 500,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[A");
    expect(state.detailScrollOffset).toBe(0);
    cleanup();
  });

  it("j scrolls detail content down when overlay is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 2,
      detailContentLines: 500,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "j");
    expect(state.detailScrollOffset).toBe(3);
    // Log panel should not have scrolled
    expect(state.logScrollOffset).toBe(0);
    cleanup();
  });

  it("k scrolls detail content up when overlay is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 3,
      detailContentLines: 500,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "k");
    expect(state.detailScrollOffset).toBe(2);
    cleanup();
  });

  it("G jumps to end of detail content when overlay is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 0,
      detailContentLines: 500,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "G");
    expect(state.detailScrollOffset).toBeGreaterThan(0);
    cleanup();
  });

  it("Escape closes detail overlay and resets scroll offset", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 10,
      savedLogScrollOffset: 5,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b");
    expect(state.detailItemId).toBeNull();
    expect(state.detailScrollOffset).toBe(0);
    expect(state.logScrollOffset).toBe(5); // restored
    cleanup();
  });

  it("Enter opens detail and resets detailScrollOffset to 0", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      selectedIndex: 0,
      detailItemId: null,
      detailScrollOffset: 5, // stale from previous open
      getSelectedItemId: () => "X-2",
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\r");
    expect(state.detailItemId).toBe("X-2");
    expect(state.detailScrollOffset).toBe(0);
    cleanup();
  });

  it("closing overlay restores list navigation (arrows move selection, not detail scroll)", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 3,
      selectedIndex: 1,
      getItemCount: () => 5,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    // Close overlay
    stdin.emit("data", "\x1b");
    expect(state.detailItemId).toBeNull();

    // Now arrows should move selection
    stdin.emit("data", "\x1b[B"); // Down
    expect(state.selectedIndex).toBe(2);
    cleanup();
  });

  it("down arrow does not scroll if content fits in viewport (no overflow)", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      detailItemId: "X-1",
      detailScrollOffset: 0,
      detailContentLines: 5, // very short, fits in any terminal
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[B");
    expect(state.detailScrollOffset).toBe(0);
    cleanup();
  });
});
