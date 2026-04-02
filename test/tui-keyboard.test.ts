// Tests for core/tui-keyboard.ts -- keyboard handler, controls overlay,
// WIP +/- shortcuts, and runtime control state management.

import { describe, it, expect, vi } from "vitest";
import {
  setupKeyboardShortcuts,
  applyRuntimeSnapshotToTuiState,
  pushLogBuffer,
  filterLogsByLevel,
  LOG_BUFFER_MAX,
  LOG_LEVEL_CYCLE,
  REVIEW_MODE_CYCLE,
  COLLABORATION_MODE_CYCLE,
  STRATEGY_DEBOUNCE_MS,
  type TuiState,
  type LogLevelFilter,
} from "../core/tui-keyboard.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";
import {
  buildStatusLayout,
  getStatusVisibleLineRange,
  type ViewOptions,
  type PanelMode,
  type StatusItem,
  type LogEntry as PanelLogEntry,
} from "../core/status-render.ts";
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
    paused: false,
    pendingPaused: undefined,
    wipLimit: 3,
    mergeStrategy: "manual" as MergeStrategy,
    pendingStrategy: undefined,
    pendingStrategyDeadlineMs: undefined,
    pendingStrategyTimer: undefined,
    pendingStrategyCountdownTimer: undefined,
    bypassEnabled: false,
    ctrlCPending: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    showControls: false,
    controlsRowIndex: 0,
    collaborationMode: "local",
    collaborationIntent: "local",
    collaborationJoinInputActive: false,
    collaborationJoinInputValue: "",
    collaborationBusy: false,
    reviewMode: "off",
    panelMode: "status-only" as PanelMode,
    logBuffer: [],
    logScrollOffset: 0,
    logLevelFilter: "all" as LogLevelFilter,
    selectedItemId: undefined,
    visibleItemIds: [],
    detailItemId: null,
    detailScrollOffset: 0,
    detailContentLines: 0,
    savedLogScrollOffset: 0,
    ...overrides,
  };
}

function makeStatusItem(overrides: Partial<StatusItem> & Pick<StatusItem, "id">): StatusItem {
  return {
    ...overrides,
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    state: overrides.state ?? "implementing",
    prNumber: overrides.prNumber ?? null,
    ageMs: overrides.ageMs ?? 60_000,
    repoLabel: overrides.repoLabel ?? "ninthwave",
    dependencies: overrides.dependencies ?? [],
  };
}

function makeStatusNavigationState(
  items: StatusItem[],
  overrides: Partial<TuiState> = {},
  viewOptions: ViewOptions = { showBlockerDetail: true },
): TuiState {
  const statusLayout = buildStatusLayout(items, 100, undefined, false, viewOptions);
  const selectableItemIds = statusLayout.visibleLayout?.selectableItemIds ?? [];
  return makeTuiState({
    panelMode: "status-only",
    viewOptions,
    statusLayout,
    selectedItemId: selectableItemIds[0],
    visibleItemIds: selectableItemIds,
    ...overrides,
  });
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

  it("q routes shutdown through onShutdown when provided", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onShutdown = vi.fn();
    const state = makeTuiState({ onShutdown });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "q");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(false);
    cleanup();
  });

  it("Escape pauses from the base dashboard", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onPauseChange = vi.fn();
    const state = makeTuiState({ onPauseChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b");

    expect(state.pendingPaused).toBe(true);
    expect(onPauseChange).toHaveBeenCalledWith(true);
    cleanup();
  });

  it("Escape resumes from the paused overlay", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onPauseChange = vi.fn();
    const state = makeTuiState({ paused: true, onPauseChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b");

    expect(state.pendingPaused).toBe(false);
    expect(onPauseChange).toHaveBeenCalledWith(false);
    cleanup();
  });

  it("p toggles pause and resume", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onPauseChange = vi.fn();
    const state = makeTuiState({ onPauseChange });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "p");
    expect(state.pendingPaused).toBe(true);
    expect(onPauseChange).toHaveBeenNthCalledWith(1, true);

    applyRuntimeSnapshotToTuiState(state, {
      paused: true,
      mergeStrategy: state.mergeStrategy,
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: state.collaborationMode,
    });
    expect(state.paused).toBe(true);
    expect(state.pendingPaused).toBeUndefined();

    stdin.emit("data", "p");
    expect(state.pendingPaused).toBe(false);
    expect(onPauseChange).toHaveBeenNthCalledWith(2, false);
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

  it("c key is swallowed while help is open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showHelp: true });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "c");
    expect(state.showControls).toBe(false);
    expect(state.showHelp).toBe(true);
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

  it("Escape dismisses overlays before pausing", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onPauseChange = vi.fn();

    const helpState = makeTuiState({ showHelp: true, onPauseChange });
    helpState.viewOptions.showHelp = true;
    let cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, helpState);
    stdin.emit("data", "\x1b");
    expect(helpState.showHelp).toBe(false);
    expect(onPauseChange).not.toHaveBeenCalled();
    cleanup();

    const controlsState = makeTuiState({ showControls: true, onPauseChange });
    controlsState.viewOptions.showControls = true;
    cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, controlsState);
    stdin.emit("data", "\x1b");
    expect(controlsState.showControls).toBe(false);
    expect(onPauseChange).not.toHaveBeenCalled();
    cleanup();

    const detailState = makeTuiState({ detailItemId: "X-1", onPauseChange });
    cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, detailState);
    stdin.emit("data", "\x1b");
    expect(detailState.detailItemId).toBeNull();
    expect(onPauseChange).not.toHaveBeenCalled();
    cleanup();

    const joinState = makeTuiState({
      showControls: true,
      collaborationJoinInputActive: true,
      collaborationJoinInputValue: "CODE",
      collaborationIntent: "join",
      onPauseChange,
    });
    joinState.viewOptions.showControls = true;
    cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, joinState);
    stdin.emit("data", "\x1b");
    expect(joinState.showControls).toBe(true);
    expect(joinState.collaborationJoinInputActive).toBe(false);
    expect(onPauseChange).not.toHaveBeenCalled();
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

  it("Enter dismisses help overlay without opening detail", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      showHelp: true,
      selectedItemId: "A-1",
      visibleItemIds: ["A-1", "B-2"],
      detailItemId: null,
    });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\r");

    expect(state.showHelp).toBe(false);
    expect(state.viewOptions.showHelp).toBe(false);
    expect(state.detailItemId).toBeNull();
    cleanup();
  });

  it("? dismisses help overlay without opening controls", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showHelp: true, showControls: false });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "?");

    expect(state.showHelp).toBe(false);
    expect(state.viewOptions.showHelp).toBe(false);
    expect(state.showControls).toBe(false);
    cleanup();
  });

  it("swallows non-dismiss help keys so background state does not change", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onWipChange = vi.fn();
    const onExtendTimeout = vi.fn(() => true);
    const state = makeStatusNavigationState([
      makeStatusItem({ id: "A-1", state: "implementing" }),
      makeStatusItem({ id: "B-2", state: "review" }),
    ], {
      showHelp: true,
      panelMode: "status-only",
      detailItemId: null,
      controlsRowIndex: 0,
      onWipChange,
      onExtendTimeout,
    });
    state.viewOptions.showHelp = true;
    state.viewOptions.showBlockerDetail = true;
    const initialSelectedItemId = state.selectedItemId;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[B");
    stdin.emit("data", "i");
    stdin.emit("data", "d");
    stdin.emit("data", "x");
    stdin.emit("data", "\t");
    stdin.emit("data", "+");
    stdin.emit("data", "-");
    stdin.emit("data", "c");

    expect(state.showHelp).toBe(true);
    expect(state.selectedItemId).toBe(initialSelectedItemId);
    expect(state.detailItemId).toBeNull();
    expect(state.viewOptions.showBlockerDetail).toBe(true);
    expect(state.panelMode).toBe("status-only");
    expect(state.showControls).toBe(false);
    expect(onExtendTimeout).not.toHaveBeenCalled();
    expect(onWipChange).not.toHaveBeenCalled();
    cleanup();
  });

  it("q still routes shutdown while help is visible", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onShutdown = vi.fn();
    const state = makeTuiState({ showHelp: true, onShutdown });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "q");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(false);
    expect(state.showHelp).toBe(true);
    cleanup();
  });

  it("q still routes shutdown while paused", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onShutdown = vi.fn();
    const state = makeTuiState({ paused: true, onShutdown });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "q");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(false);
    cleanup();
  });

  it("double Ctrl+C still quits while help is visible", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onShutdown = vi.fn();
    const state = makeTuiState({ showHelp: true, onShutdown });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x03");
    expect(state.ctrlCPending).toBe(true);
    expect(onShutdown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    stdin.emit("data", "\x03");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(false);
    cleanup();
    vi.useRealTimers();
  });

  it("double Ctrl+C still quits while paused", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onShutdown = vi.fn();
    const state = makeTuiState({ paused: true, onShutdown });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x03");
    expect(state.ctrlCPending).toBe(true);
    expect(onShutdown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    stdin.emit("data", "\x03");

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(false);
    cleanup();
    vi.useRealTimers();
  });

  it("controls still work normally after dismissing help", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showHelp: true, controlsRowIndex: 0 });
    state.viewOptions.showHelp = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\r");
    expect(state.showHelp).toBe(false);

    stdin.emit("data", "c");
    expect(state.showControls).toBe(true);

    stdin.emit("data", "\x1b[B");
    expect(state.controlsRowIndex).toBe(1);
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

  it("Up/Down wrap through the visible selectable order on the status page", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeStatusNavigationState([
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"] }),
      makeStatusItem({ id: "C-3", state: "review" }),
      makeStatusItem({ id: "A-1", state: "implementing" }),
    ], {
      selectedItemId: "A-1",
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[A");
    expect(state.selectedItemId).toBe("B-2");

    stdin.emit("data", "\x1b[B");
    expect(state.selectedItemId).toBe("A-1");

    cleanup();
  });

  it("j/k use the same status-mode movement rules as arrow keys", () => {
    const ac = new AbortController();
    const arrowStdin = makeFakeStdin();
    const vimStdin = makeFakeStdin();
    const items = [
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"] }),
      makeStatusItem({ id: "C-3", state: "review" }),
      makeStatusItem({ id: "A-1", state: "implementing" }),
    ];
    const arrowState = makeStatusNavigationState(items, { selectedItemId: "A-1" });
    const vimState = makeStatusNavigationState(items, { selectedItemId: "A-1" });
    const arrowCleanup = setupKeyboardShortcuts(ac, () => {}, arrowStdin as any, arrowState);
    const vimCleanup = setupKeyboardShortcuts(ac, () => {}, vimStdin as any, vimState);

    arrowStdin.emit("data", "\x1b[A");
    vimStdin.emit("data", "k");
    expect(vimState.selectedItemId).toBe(arrowState.selectedItemId);
    expect(vimState.scrollOffset).toBe(arrowState.scrollOffset);

    arrowStdin.emit("data", "\x1b[B");
    vimStdin.emit("data", "j");
    expect(vimState.selectedItemId).toBe(arrowState.selectedItemId);
    expect(vimState.scrollOffset).toBe(arrowState.scrollOffset);

    arrowCleanup();
    vimCleanup();
  });

  it("keeps help, quit, navigation, and controls local while engine confirmation is pending", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onShutdown = vi.fn();
    const state = makeStatusNavigationState([
      makeStatusItem({ id: "A-1", state: "implementing" }),
      makeStatusItem({ id: "B-2", state: "review" }),
    ], {
      pendingWipLimit: 4,
      pendingStrategy: "auto",
      pendingReviewMode: "all-prs",
      pendingCollaborationMode: "shared",
      onShutdown,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "?");
    expect(state.showHelp).toBe(true);

    stdin.emit("data", "\x1b");
    expect(state.showHelp).toBe(false);

    stdin.emit("data", "\x1b[B");
    expect(state.selectedItemId).toBe("B-2");

    stdin.emit("data", "c");
    expect(state.showControls).toBe(true);

    stdin.emit("data", "\x1b[B");
    expect(state.controlsRowIndex).toBe(1);

    stdin.emit("data", "q");
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(false);

    cleanup();
  });

  it("Up/Down scroll logs on the logs page", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      panelMode: "logs-only",
      logScrollOffset: 2,
      selectedItemId: "B-2",
      visibleItemIds: ["A-1", "B-2", "C-3", "D-4"],
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[A");
    expect(state.logScrollOffset).toBe(1);
    expect(state.selectedItemId).toBe("B-2");

    stdin.emit("data", "\x1b[B");
    expect(state.logScrollOffset).toBe(2);
    expect(state.selectedItemId).toBe("B-2");

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

  it("status scrolling follows rendered line spans when blocker detail adds extra lines", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      ...Array.from({ length: 7 }, (_, index) => makeStatusItem({
        id: `B-${index + 2}`,
        state: "review",
        dependencies: ["A-1"],
      })),
    ];
    const originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });
    try {
      const state = makeStatusNavigationState(items, {
        selectedItemId: "A-1",
        scrollOffset: 0,
      });
      const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);
      try {
        for (let i = 0; i < 7; i++) {
          stdin.emit("data", "\x1b[B");
        }

        const selectedItemId = state.selectedItemId;
        const span = state.statusLayout?.visibleLayout?.renderedLineSpans[selectedItemId ?? ""];
        const visibleRange = getStatusVisibleLineRange(state.statusLayout!, process.stdout.rows ?? 24, state.scrollOffset);

        expect(selectedItemId).toBe("B-8");
        expect(span).toBeDefined();
        expect(span!.startLineIndex).toBeGreaterThan(0);
        expect(state.scrollOffset).toBeGreaterThan(0);
        expect(span!.startLineIndex).toBeGreaterThanOrEqual(visibleRange.visibleStartLineIndex);
        expect(span!.endLineIndex).toBeLessThanOrEqual(visibleRange.visibleEndLineIndex);
      } finally {
        cleanup();
      }
    } finally {
      Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
    }
  });
});

// ── Controls overlay row navigation ─────────────────────────────────────────

describe("controls overlay row navigation", () => {
  it("Up/Down move between setting rows", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showControls: true, controlsRowIndex: 0 });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[B");
    expect(state.controlsRowIndex).toBe(1);

    stdin.emit("data", "\x1b[B");
    expect(state.controlsRowIndex).toBe(2);

    stdin.emit("data", "\x1b[A");
    expect(state.controlsRowIndex).toBe(1);

    stdin.emit("data", "\x1b[A");
    stdin.emit("data", "\x1b[A");
    expect(state.controlsRowIndex).toBe(0);
    cleanup();
  });

  it("Left/Right select collaboration intents and Enter invokes Share/Local callbacks", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onCollaborationLocal = vi.fn(() => ({ mode: "local" as const }));
    const onCollaborationShare = vi.fn(() => ({ mode: "shared" as const }));
    const onUpdate = vi.fn();
    const state = makeTuiState({
      showControls: true,
      controlsRowIndex: 0,
      collaborationMode: "local",
      collaborationIntent: "local",
      onCollaborationLocal,
      onCollaborationShare,
      onUpdate,
    });
    state.viewOptions.collaborationMode = "local";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[C");
    expect(state.collaborationIntent).toBe("share");
    expect(state.viewOptions.collaborationIntent).toBe("share");
    expect(state.collaborationMode).toBe("local");
    expect(onCollaborationShare).not.toHaveBeenCalled();

    stdin.emit("data", "\r");
    expect(state.collaborationMode).toBe("local");
    expect(state.pendingCollaborationMode).toBe("shared");
    expect(state.viewOptions.collaborationMode).toBe("local");
    expect(onCollaborationShare).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalled();

    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: state.mergeStrategy,
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: "shared",
    });
    expect(state.collaborationMode).toBe("shared");
    expect(state.pendingCollaborationMode).toBeUndefined();

    stdin.emit("data", "\x1b[D");
    expect(state.collaborationIntent).toBe("local");
    expect(state.collaborationMode).toBe("shared");
    expect(onCollaborationLocal).not.toHaveBeenCalled();

    stdin.emit("data", "\r");
    expect(state.collaborationMode).toBe("shared");
    expect(state.pendingCollaborationMode).toBe("local");
    expect(state.collaborationIntent).toBe("local");
    expect(onCollaborationLocal).toHaveBeenCalledTimes(1);

    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: state.mergeStrategy,
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: "local",
    });
    expect(state.collaborationMode).toBe("local");
    expect(state.pendingCollaborationMode).toBeUndefined();
    cleanup();
  });

  it("entering Join from the controls overlay enables join input and mirrors it to viewOptions", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({
      showControls: true,
      controlsRowIndex: 0,
      collaborationMode: "local",
      collaborationIntent: "local",
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[C");
    stdin.emit("data", "\x1b[C");
    expect(state.collaborationMode).toBe("local");
    expect(state.collaborationIntent).toBe("join");
    expect(state.collaborationJoinInputActive).toBe(false);

    stdin.emit("data", "\r");

    expect(state.collaborationMode).toBe("local");
    expect(state.collaborationJoinInputActive).toBe(true);
    expect(state.viewOptions.collaborationIntent).toBe("join");
    expect(state.viewOptions.collaborationJoinInputActive).toBe(true);
    expect(state.viewOptions.collaborationJoinInputValue).toBe("");
    cleanup();
  });

  it("printable input, backspace, Enter submit, and Escape cancel stay inside join-input mode", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onCollaborationJoinSubmit = vi.fn((code: string) => ({
      mode: "joined" as const,
      error: code === "AB12" ? undefined : "unexpected code",
    }));
    const state = makeTuiState({
      showControls: true,
      controlsRowIndex: 0,
      collaborationMode: "local",
      collaborationIntent: "join",
      collaborationJoinInputActive: true,
      onCollaborationJoinSubmit,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "a");
    stdin.emit("data", "b");
    stdin.emit("data", "1");
    stdin.emit("data", "2");
    expect(state.collaborationJoinInputValue).toBe("AB12");
    expect(state.viewOptions.collaborationJoinInputValue).toBe("AB12");

    stdin.emit("data", "\x7f");
    expect(state.collaborationJoinInputValue).toBe("AB1");
    expect(state.controlsRowIndex).toBe(0);

    stdin.emit("data", "2");
    stdin.emit("data", "\r");
    expect(onCollaborationJoinSubmit).toHaveBeenCalledWith("AB12");
    expect(state.collaborationMode).toBe("local");
    expect(state.pendingCollaborationMode).toBe("joined");
    expect(state.collaborationIntent).toBe("join");
    expect(state.collaborationJoinInputActive).toBe(false);

    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: state.mergeStrategy,
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: "joined",
    });
    expect(state.collaborationMode).toBe("joined");
    expect(state.pendingCollaborationMode).toBeUndefined();

    stdin.emit("data", "\x1b[C");
    expect(state.collaborationJoinInputActive).toBe(false);

    state.collaborationMode = "local";
    state.collaborationIntent = "join";
    state.collaborationJoinInputActive = true;
    state.collaborationJoinInputValue = "CODE";
    state.viewOptions.collaborationMode = "local";
    state.viewOptions.collaborationIntent = "join";
    state.viewOptions.collaborationJoinInputActive = true;
    state.viewOptions.collaborationJoinInputValue = "CODE";

    stdin.emit("data", "\x1b");
    expect(state.showControls).toBe(true);
    expect(state.collaborationMode).toBe("local");
    expect(state.collaborationIntent).toBe("local");
    expect(state.collaborationJoinInputActive).toBe(false);
    expect(state.viewOptions.collaborationJoinInputActive).toBe(false);
    cleanup();
  });

  it("Left/Right change review mode on the active row", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onReviewChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      controlsRowIndex: 1,
      reviewMode: "off",
      onReviewChange,
    });
    state.viewOptions.reviewMode = "off";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[C");
    expect(state.reviewMode).toBe("off");
    expect(state.pendingReviewMode).toBe("ninthwave-prs");
    expect(state.viewOptions.reviewMode).toBe("off");
    expect(onReviewChange).toHaveBeenCalledWith("ninthwave-prs");

    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: state.mergeStrategy,
      wipLimit: state.wipLimit ?? 3,
      reviewMode: "ninthwave-prs",
      collaborationMode: state.collaborationMode,
    });
    expect(state.reviewMode).toBe("ninthwave-prs");
    expect(state.pendingReviewMode).toBeUndefined();

    stdin.emit("data", "\x1b[C");
    expect(state.reviewMode).toBe("ninthwave-prs");
    expect(state.pendingReviewMode).toBe("all-prs");
    expect(onReviewChange).toHaveBeenCalledWith("all-prs");

    stdin.emit("data", "\x1b[D");
    expect(state.pendingReviewMode).toBeUndefined();
    cleanup();
  });

  it("Left/Right queue merge strategy changes on the active row", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      controlsRowIndex: 2,
      mergeStrategy: "manual",
      onStrategyChange,
    });
    state.viewOptions.mergeStrategy = "manual";
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[C");
    expect(state.mergeStrategy).toBe("manual");
    expect(state.pendingStrategy).toBe("auto");
    expect(onStrategyChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS + 1);
    expect(state.mergeStrategy).toBe("manual");
    expect(state.pendingStrategy).toBe("auto");
    expect(onStrategyChange).toHaveBeenCalledWith("auto");

    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: "auto",
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: state.collaborationMode,
    });
    expect(state.mergeStrategy).toBe("auto");
    expect(state.pendingStrategy).toBeUndefined();

    cleanup();
    vi.useRealTimers();
  });

  it("Left/Right adjust WIP limit on the active row", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onWipChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      controlsRowIndex: 3,
      onWipChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1b[C");
    expect(onWipChange).toHaveBeenCalledWith(1);
    expect(state.pendingWipLimit).toBe(4);

    stdin.emit("data", "\x1b[D");
    expect(onWipChange).toHaveBeenCalledWith(-1);
    expect(state.pendingWipLimit).toBeUndefined();
    cleanup();
  });

  it("Enter dismisses the controls overlay on non-collaboration rows", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const state = makeTuiState({ showControls: true, controlsRowIndex: 1 });
    state.viewOptions.showControls = true;
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\r");
    expect(state.showControls).toBe(false);
    expect(state.viewOptions.showControls).toBe(false);
    cleanup();
  });

  it("number keys do nothing even while controls are open", () => {
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onCollaborationChange = vi.fn();
    const state = makeTuiState({
      showControls: true,
      collaborationMode: "local",
      onCollaborationChange,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "2");
    expect(state.collaborationMode).toBe("local");
    expect(onCollaborationChange).not.toHaveBeenCalled();
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
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBe(5);
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

    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS + 1);
    expect(state.mergeStrategy).toBe("auto");
    expect(state.pendingStrategy).toBe("bypass");
    expect(onStrategyChange).toHaveBeenCalledTimes(1);
    expect(onStrategyChange).toHaveBeenCalledWith("bypass");

    cleanup();
    vi.useRealTimers();
  });

  it("updates the pending strategy countdown and clears it after apply", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = makeFakeStdin();
    const onStrategyChange = vi.fn();
    const countdowns: Array<number | undefined> = [];
    let state!: TuiState;
    const onUpdate = () => {
      countdowns.push(state.viewOptions.pendingStrategyCountdownSeconds);
    };
    state = makeTuiState({
      mergeStrategy: "auto",
      bypassEnabled: false,
      onStrategyChange,
      onUpdate,
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    stdin.emit("data", "\x1B[Z");
    expect(state.pendingStrategy).toBe("manual");
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBe(5);

    vi.advanceTimersByTime(1000);
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBe(4);
    vi.advanceTimersByTime(1000);
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBe(1);
    vi.advanceTimersByTime(1000);

    expect(countdowns).toContain(undefined);
    expect(state.mergeStrategy).toBe("auto");
    expect(state.pendingStrategy).toBe("manual");
    expect(state.viewOptions.pendingStrategy).toBe("manual");
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBeUndefined();
    expect(onStrategyChange).toHaveBeenCalledWith("manual");

    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: "manual",
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: state.collaborationMode,
    });
    expect(state.mergeStrategy).toBe("manual");
    expect(state.pendingStrategy).toBeUndefined();
    expect(state.viewOptions.pendingStrategy).toBeUndefined();
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBeUndefined();

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
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS + 1);
    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: "bypass",
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: state.collaborationMode,
    });
    expect(state.mergeStrategy).toBe("bypass");

    stdin.emit("data", "\x1B[Z");
    vi.advanceTimersByTime(STRATEGY_DEBOUNCE_MS + 1);
    applyRuntimeSnapshotToTuiState(state, {
      paused: state.paused ?? false,
      mergeStrategy: "auto",
      wipLimit: state.wipLimit ?? 3,
      reviewMode: state.reviewMode,
      collaborationMode: state.collaborationMode,
    });
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

    expect(state.pendingStrategyCountdownTimer).toBeUndefined();
    expect(state.pendingStrategyDeadlineMs).toBeUndefined();
    expect(state.pendingStrategyTimer).toBeUndefined();
    expect(state.pendingStrategy).toBeUndefined();
    expect(state.viewOptions.pendingStrategyCountdownSeconds).toBeUndefined();
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
    expect(state.selectedItemId).toBeUndefined();
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
      selectedItemId: "X-2",
      detailItemId: null,
      detailScrollOffset: 5, // stale from previous open
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
      selectedItemId: "B-2",
      visibleItemIds: ["A-1", "B-2", "C-3", "D-4", "E-5"],
    });
    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin as any, state);

    // Close overlay
    stdin.emit("data", "\x1b");
    expect(state.detailItemId).toBeNull();

    // Now arrows should move selection
    stdin.emit("data", "\x1b[B"); // Down
    expect(state.selectedItemId).toBe("C-3");
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
