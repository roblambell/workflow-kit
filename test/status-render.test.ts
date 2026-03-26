// Tests for core/status-render.ts — shared rendering module, TUI mode detection,
// and OrchestratorItem → StatusItem conversion.

import { describe, it, expect } from "vitest";
import {
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  pad,
  formatItemRow,
  formatQueuedItemRow,
  formatBatchProgress,
  formatSummary,
  formatStatusTable,
  mapDaemonItemState,
  daemonStateToStatusItems,
  getTerminalWidth,
  type StatusItem,
  type ItemState,
} from "../core/status-render.ts";
import {
  detectTuiMode,
  orchestratorItemsToStatusItems,
  renderTuiFrame,
} from "../core/commands/orchestrate.ts";
import type { OrchestratorItem } from "../core/orchestrator.ts";
import type { DaemonState } from "../core/daemon.ts";
import type { TodoItem } from "../core/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function makeStatusItem(overrides: Partial<StatusItem> = {}): StatusItem {
  return {
    id: "TEST-1",
    title: "Test item",
    state: "implementing",
    prNumber: null,
    ageMs: 5 * 60 * 1000, // 5 minutes
    repoLabel: "",
    ...overrides,
  };
}

function makeTodo(id: string, deps: string[] = []): TodoItem {
  return {
    id,
    priority: "high",
    title: `TODO ${id}`,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
  };
}

function makeOrchestratorItem(id: string, state: OrchestratorItem["state"] = "implementing"): OrchestratorItem {
  return {
    id,
    todo: makeTodo(id),
    state,
    lastTransition: new Date(Date.now() - 10_000).toISOString(),
    ciFailCount: 0,
    retryCount: 0,
    prNumber: undefined,
  };
}

// ── status-render module: pure formatting functions ───────────────────────────

describe("stateColor", () => {
  it("returns a string for every valid state", () => {
    const states: ItemState[] = [
      "merged", "bootstrapping", "implementing", "ci-failed", "ci-pending",
      "review", "pr-open", "in-progress", "queued",
    ];
    for (const state of states) {
      expect(typeof stateColor(state)).toBe("string");
    }
  });
});

describe("stateIcon", () => {
  it("returns the checkmark for merged", () => {
    expect(stateIcon("merged")).toBe("✓");
  });
  it("returns the arrow for implementing", () => {
    expect(stateIcon("implementing")).toBe("▸");
  });
  it("returns x for ci-failed", () => {
    expect(stateIcon("ci-failed")).toBe("✗");
  });
  it("returns a string for every valid state", () => {
    const states: ItemState[] = [
      "merged", "bootstrapping", "implementing", "ci-failed", "ci-pending",
      "review", "pr-open", "in-progress", "queued",
    ];
    for (const state of states) {
      expect(typeof stateIcon(state)).toBe("string");
    }
  });
});

describe("stateLabel", () => {
  it("returns correct labels", () => {
    expect(stateLabel("merged")).toBe("Merged");
    expect(stateLabel("ci-failed")).toBe("CI Failed");
    expect(stateLabel("ci-pending")).toBe("CI Pending");
    expect(stateLabel("review")).toBe("In Review");
    expect(stateLabel("queued")).toBe("Queued");
  });
});

describe("truncateTitle", () => {
  it("returns full title when within maxWidth", () => {
    expect(truncateTitle("Hello", 10)).toBe("Hello");
  });
  it("truncates with ellipsis when over maxWidth", () => {
    expect(truncateTitle("Hello World", 8)).toBe("Hello...");
  });
  it("handles very small maxWidth", () => {
    expect(truncateTitle("Hello", 2)).toBe("He");
  });
});

describe("formatAge", () => {
  it("returns '<1m' for less than one minute", () => {
    expect(formatAge(30_000)).toBe("<1m");
  });
  it("returns minutes for less than one hour", () => {
    expect(formatAge(5 * 60_000)).toBe("5m");
  });
  it("returns hours and minutes for less than one day", () => {
    expect(formatAge(2 * 3600_000 + 15 * 60_000)).toBe("2h 15m");
  });
  it("returns days and hours for multi-day age", () => {
    expect(formatAge(3 * 86400_000 + 2 * 3600_000)).toBe("3d 2h");
  });
  it("handles negative values as zero", () => {
    expect(formatAge(-1000)).toBe("<1m");
  });
});

describe("pad", () => {
  it("pads shorter strings to specified width", () => {
    expect(pad("AB", 5)).toBe("AB   ");
  });
  it("returns string unchanged if already at width", () => {
    expect(pad("ABCDE", 5)).toBe("ABCDE");
  });
  it("returns string unchanged if longer than width", () => {
    expect(pad("ABCDEFG", 5)).toBe("ABCDEFG");
  });
});

describe("formatItemRow", () => {
  it("includes the item id in the row", () => {
    const item = makeStatusItem({ id: "C-1-1" });
    const row = stripAnsi(formatItemRow(item, 20));
    expect(row).toContain("C-1-1");
  });
  it("includes the title in the row", () => {
    const item = makeStatusItem({ title: "My great feature" });
    const row = stripAnsi(formatItemRow(item, 30));
    expect(row).toContain("My great feature");
  });
  it("includes PR number when present", () => {
    const item = makeStatusItem({ prNumber: 42 });
    const row = stripAnsi(formatItemRow(item, 20));
    expect(row).toContain("#42");
  });
  it("shows dash when no PR number", () => {
    const item = makeStatusItem({ prNumber: null });
    const row = stripAnsi(formatItemRow(item, 20));
    expect(row).toContain("-");
  });
  it("includes failure reason when present", () => {
    const item = makeStatusItem({ state: "ci-failed", failureReason: "test timeout" });
    const row = stripAnsi(formatItemRow(item, 40));
    expect(row).toContain("test timeout");
  });
  it("includes repo label when present", () => {
    const item = makeStatusItem({ repoLabel: "my-repo" });
    const row = stripAnsi(formatItemRow(item, 40));
    expect(row).toContain("[my-repo]");
  });
});

describe("formatQueuedItemRow", () => {
  it("renders without ANSI color markers in test env", () => {
    const item = makeStatusItem({ state: "queued", id: "C-1-2" });
    const row = stripAnsi(formatQueuedItemRow(item, 20));
    expect(row).toContain("C-1-2");
  });
});

describe("formatBatchProgress", () => {
  it("returns empty string for no items", () => {
    expect(stripAnsi(formatBatchProgress([]))).toBe("");
  });
  it("includes progress counts", () => {
    const items: StatusItem[] = [
      makeStatusItem({ state: "merged" }),
      makeStatusItem({ state: "implementing" }),
      makeStatusItem({ state: "implementing" }),
    ];
    const progress = stripAnsi(formatBatchProgress(items));
    expect(progress).toContain("Progress:");
    expect(progress).toContain("1 merged");
    expect(progress).toContain("2 implementing");
  });
});

describe("formatSummary", () => {
  it("shows 'No active items' for empty list", () => {
    const summary = stripAnsi(formatSummary([]));
    expect(summary).toContain("No active items");
  });
  it("shows total count for items", () => {
    const items = [makeStatusItem(), makeStatusItem({ id: "C-1-2" })];
    const summary = stripAnsi(formatSummary(items));
    expect(summary).toContain("2 items");
  });
});

describe("formatStatusTable", () => {
  it("renders header row with column names", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("ninthwave status");
    expect(table).toContain("ID");
    expect(table).toContain("STATE");
  });

  it("renders empty state message when no items", () => {
    const table = stripAnsi(formatStatusTable([], 80));
    expect(table).toContain("No active items");
    expect(table).toContain("ninthwave list --ready");
  });

  it("renders items in the table", () => {
    const items = [
      makeStatusItem({ id: "C-1-1", title: "Feature A", state: "implementing" }),
      makeStatusItem({ id: "C-1-2", title: "Feature B", state: "queued" }),
    ];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("C-1-1");
    expect(table).toContain("Feature A");
    expect(table).toContain("C-1-2");
  });

  it("includes WIP slot count in queue header when wipLimit provided", () => {
    const items = [
      makeStatusItem({ state: "implementing" }),
      makeStatusItem({ id: "C-1-2", state: "queued" }),
    ];
    const table = stripAnsi(formatStatusTable(items, 80, 4));
    expect(table).toContain("1/4 WIP slots active");
  });

  it("renders footer progress line", () => {
    const items = [makeStatusItem({ state: "merged" })];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("Progress:");
    expect(table).toContain("Total:");
  });

  it("handles various terminal widths without crashing", () => {
    const items = [makeStatusItem()];
    expect(() => formatStatusTable(items, 40)).not.toThrow();
    expect(() => formatStatusTable(items, 80)).not.toThrow();
    expect(() => formatStatusTable(items, 200)).not.toThrow();
  });
});

// ── mapDaemonItemState ─────────────────────────────────────────────────────────

describe("mapDaemonItemState", () => {
  it("maps orchestrator states to display states correctly", () => {
    expect(mapDaemonItemState("merged")).toBe("merged");
    expect(mapDaemonItemState("done")).toBe("merged");
    expect(mapDaemonItemState("bootstrapping")).toBe("bootstrapping");
    expect(mapDaemonItemState("implementing")).toBe("implementing");
    expect(mapDaemonItemState("launching")).toBe("implementing");
    expect(mapDaemonItemState("ci-failed")).toBe("ci-failed");
    expect(mapDaemonItemState("stuck")).toBe("ci-failed");
    expect(mapDaemonItemState("ci-pending")).toBe("ci-pending");
    expect(mapDaemonItemState("merging")).toBe("ci-pending");
    expect(mapDaemonItemState("review-pending")).toBe("review");
    expect(mapDaemonItemState("ci-passed")).toBe("review");
    expect(mapDaemonItemState("pr-open")).toBe("pr-open");
    expect(mapDaemonItemState("queued")).toBe("queued");
    expect(mapDaemonItemState("ready")).toBe("queued");
  });
  it("maps unknown states to in-progress", () => {
    expect(mapDaemonItemState("unknown-state")).toBe("in-progress");
  });
});

// ── daemonStateToStatusItems ──────────────────────────────────────────────────

describe("daemonStateToStatusItems", () => {
  it("converts daemon state items to StatusItems", () => {
    const now = new Date().toISOString();
    const state: DaemonState = {
      pid: 1234,
      startedAt: now,
      updatedAt: now,
      items: [
        {
          id: "C-1-1",
          state: "implementing",
          prNumber: null,
          title: "Test Item",
          lastTransition: now,
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };
    const items = daemonStateToStatusItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("C-1-1");
    expect(items[0]!.state).toBe("implementing");
    expect(items[0]!.title).toBe("Test Item");
    expect(items[0]!.prNumber).toBeNull();
  });

  it("maps failureReason, dependencies, and telemetry fields", () => {
    const now = new Date().toISOString();
    const state: DaemonState = {
      pid: 1,
      startedAt: now,
      updatedAt: now,
      items: [
        {
          id: "C-1-2",
          state: "ci-failed",
          prNumber: 42,
          title: "Failed item",
          lastTransition: now,
          ciFailCount: 2,
          retryCount: 1,
          failureReason: "test timeout",
          dependencies: ["C-1-1"],
          exitCode: 1,
          stderrTail: "Error: test failed",
        },
      ],
    };
    const items = daemonStateToStatusItems(state);
    expect(items[0]!.failureReason).toBe("test timeout");
    expect(items[0]!.dependencies).toEqual(["C-1-1"]);
    expect(items[0]!.exitCode).toBe(1);
    expect(items[0]!.stderrTail).toBe("Error: test failed");
  });
});

// ── TUI mode detection ────────────────────────────────────────────────────────

describe("detectTuiMode", () => {
  it("returns true when stdout is TTY and not daemon child and no --json", () => {
    expect(detectTuiMode(false, false, true)).toBe(true);
  });
  it("returns false when isDaemonChild is true", () => {
    expect(detectTuiMode(true, false, true)).toBe(false);
  });
  it("returns false when jsonFlag is true", () => {
    expect(detectTuiMode(false, true, true)).toBe(false);
  });
  it("returns false when stdout is not a TTY (piped output)", () => {
    expect(detectTuiMode(false, false, false)).toBe(false);
  });
  it("returns false when all flags set", () => {
    expect(detectTuiMode(true, true, false)).toBe(false);
  });
});

// ── orchestratorItemsToStatusItems ───────────────────────────────────────────

describe("orchestratorItemsToStatusItems", () => {
  it("converts OrchestratorItem to StatusItem correctly", () => {
    const items = [makeOrchestratorItem("C-1-1", "implementing")];
    const result = orchestratorItemsToStatusItems(items);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("C-1-1");
    expect(result[0]!.state).toBe("implementing");
    expect(result[0]!.title).toBe("TODO C-1-1");
    expect(result[0]!.prNumber).toBeNull();
  });

  it("maps all orchestrator states to display states", () => {
    const stateMappings: Array<[OrchestratorItem["state"], ItemState]> = [
      ["merged", "merged"],
      ["done", "merged"],
      ["bootstrapping", "bootstrapping"],
      ["implementing", "implementing"],
      ["launching", "implementing"],
      ["ci-failed", "ci-failed"],
      ["stuck", "ci-failed"],
      ["ci-pending", "ci-pending"],
      ["merging", "ci-pending"],
      ["review-pending", "review"],
      ["ci-passed", "review"],
      ["pr-open", "pr-open"],
      ["queued", "queued"],
      ["ready", "queued"],
    ];
    for (const [orchState, expected] of stateMappings) {
      const item = makeOrchestratorItem("TEST", orchState);
      const [result] = orchestratorItemsToStatusItems([item]);
      expect(result!.state, `${orchState} → ${expected}`).toBe(expected);
    }
  });

  it("uses resolvedRepoRoot basename as repoLabel for cross-repo items", () => {
    const item: OrchestratorItem = {
      ...makeOrchestratorItem("C-1-1"),
      resolvedRepoRoot: "/Users/rob/code/my-service",
    };
    const [result] = orchestratorItemsToStatusItems([item]);
    expect(result!.repoLabel).toBe("my-service");
  });

  it("uses empty repoLabel for hub-local items", () => {
    const item = makeOrchestratorItem("C-1-1");
    const [result] = orchestratorItemsToStatusItems([item]);
    expect(result!.repoLabel).toBe("");
  });

  it("passes through prNumber, failureReason, telemetry fields", () => {
    const item: OrchestratorItem = {
      ...makeOrchestratorItem("C-1-1", "ci-failed"),
      prNumber: 99,
      failureReason: "build broke",
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T01:00:00Z",
      exitCode: 2,
      stderrTail: "npm ERR!",
    };
    const [result] = orchestratorItemsToStatusItems([item]);
    expect(result!.prNumber).toBe(99);
    expect(result!.failureReason).toBe("build broke");
    expect(result!.startedAt).toBe("2024-01-01T00:00:00Z");
    expect(result!.endedAt).toBe("2024-01-01T01:00:00Z");
    expect(result!.exitCode).toBe(2);
    expect(result!.stderrTail).toBe("npm ERR!");
  });

  it("handles empty item list", () => {
    const result = orchestratorItemsToStatusItems([]);
    expect(result).toEqual([]);
  });
});

// ── renderTuiFrame ─────────────────────────────────────────────────────────────

describe("renderTuiFrame", () => {
  it("writes cursor-home sequence first", () => {
    const written: string[] = [];
    const items = [makeOrchestratorItem("C-1-1")];
    renderTuiFrame(items, undefined, (s) => written.push(s));
    expect(written[0]).toBe("\x1B[H");
  });

  it("clears to end of screen last", () => {
    const written: string[] = [];
    const items = [makeOrchestratorItem("C-1-1")];
    renderTuiFrame(items, undefined, (s) => written.push(s));
    expect(written[written.length - 1]).toBe("\x1B[J");
  });

  it("embeds clear-to-end-of-line in content lines", () => {
    const written: string[] = [];
    const items = [makeOrchestratorItem("C-1-1")];
    renderTuiFrame(items, undefined, (s) => written.push(s));
    const content = written[1]!;
    expect(content).toContain("\x1B[K\n");
  });

  it("renders item id in the output", () => {
    const written: string[] = [];
    const items = [makeOrchestratorItem("C-1-1")];
    renderTuiFrame(items, undefined, (s) => written.push(s));
    const full = written.join("");
    expect(stripAnsi(full)).toContain("C-1-1");
  });

  it("renders the empty state without crashing when items list is empty", () => {
    const written: string[] = [];
    expect(() => renderTuiFrame([], undefined, (s) => written.push(s))).not.toThrow();
    const full = stripAnsi(written.join(""));
    expect(full).toContain("No active items");
  });

  it("passes wipLimit to the table formatter", () => {
    const written: string[] = [];
    const items = [
      makeOrchestratorItem("C-1-1", "implementing"),
      { ...makeOrchestratorItem("C-1-2"), state: "queued" as const },
    ];
    renderTuiFrame(items, 5, (s) => written.push(s));
    const full = stripAnsi(written.join(""));
    expect(full).toContain("1/5 WIP slots active");
  });

  it("does not crash when a large number of items is rendered (terminal resize simulation)", () => {
    const written: string[] = [];
    const items = Array.from({ length: 20 }, (_, i) =>
      makeOrchestratorItem(`C-1-${i + 1}`, i % 3 === 0 ? "merged" : "implementing"),
    );
    expect(() => renderTuiFrame(items, 5, (s) => written.push(s))).not.toThrow();
  });
});

// ── getTerminalWidth ──────────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  it("returns a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });
  it("returns 80 in non-TTY test environment", () => {
    // Tests run with stdout redirected, so columns is undefined → defaults to 80
    expect(getTerminalWidth()).toBe(80);
  });
});
