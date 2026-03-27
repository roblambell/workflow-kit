// Tests for core/status-render.ts — shared rendering module, TUI mode detection,
// and OrchestratorItem → StatusItem conversion.

import { describe, it, expect } from "vitest";
import {
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  formatDuration,
  pad,
  formatItemRow,
  formatQueuedItemRow,
  formatBatchProgress,
  formatSummary,
  formatStatusTable,
  computeBlockedBy,
  sortByBlockedThenId,
  computeSessionMetrics,
  formatMetricsPanel,
  formatHelpFooter,
  mapDaemonItemState,
  daemonStateToStatusItems,
  getTerminalWidth,
  type StatusItem,
  type ItemState,
  type ViewOptions,
  type SessionMetrics,
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

describe("formatDuration", () => {
  it("uses startedAt and endedAt when both are present", () => {
    const item = makeStatusItem({
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:30:00Z",
      ageMs: 999 * 60_000, // should be ignored
    });
    expect(formatDuration(item)).toBe("1h 30m");
  });

  it("uses startedAt to now for active items (no endedAt)", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const item = makeStatusItem({
      startedAt: tenMinAgo,
      ageMs: 999 * 60_000, // should be ignored
    });
    // Should be approximately 10m (allow some test execution time)
    expect(formatDuration(item)).toBe("10m");
  });

  it("falls back to ageMs when startedAt is not set", () => {
    const item = makeStatusItem({
      ageMs: 2 * 3600_000 + 15 * 60_000,
    });
    expect(formatDuration(item)).toBe("2h 15m");
  });

  it("falls back to ageMs when startedAt is invalid", () => {
    const item = makeStatusItem({
      startedAt: "not-a-date",
      ageMs: 5 * 60_000,
    });
    expect(formatDuration(item)).toBe("5m");
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

  it("renders DURATION header instead of AGE", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("DURATION");
    expect(table).not.toContain(" AGE ");
  });

  it("separator width matches data row content width across terminal widths", () => {
    const items = [makeStatusItem({ id: "TEST-1", title: "A title" })];
    // No deps: fixedWidth=48, titleWidth=max(10, termWidth-48)
    // Separator visible width = 2 + min(termWidth-2, fixedWidth+titleWidth)
    const fixedWidth = 48;
    for (const termWidth of [40, 80, 120, 200]) {
      const table = stripAnsi(formatStatusTable(items, termWidth));
      const lines = table.split("\n");
      // Find separator lines (consist of ─ chars after leading spaces)
      const sepLines = lines.filter(l => /^\s+─+$/.test(l));
      expect(sepLines.length).toBeGreaterThan(0);
      const sepWidth = sepLines[0]!.length;
      const titleWidth = Math.max(10, termWidth - fixedWidth);
      const expectedSepWidth = 2 + Math.min(termWidth - 2, fixedWidth + titleWidth);
      expect(sepWidth, `separator at termWidth=${termWidth}`).toBe(expectedSepWidth);
    }
  });

  it("separator width with DEPS column active (hasDeps=true) exceeds 78", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"], title: "A longer title for testing width" }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    const sepLines = lines.filter(l => /^\s+─+$/.test(l));
    expect(sepLines.length).toBeGreaterThan(0);
    // With a 120-char terminal and DEPS column, separator should be wider than 80 (2 + 78)
    expect(sepLines[0]!.length).toBeGreaterThan(80);
  });

  it("shows DEPS header when items have dependencies", () => {
    const items = [
      makeStatusItem({ id: "A", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "B", state: "queued", dependencies: ["A"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    expect(table).toContain("DEPS");
  });

  it("does not show DEPS header when no items have dependencies", () => {
    const items = [
      makeStatusItem({ id: "A", state: "implementing" }),
      makeStatusItem({ id: "B", state: "queued" }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    expect(table).not.toContain("DEPS");
  });

  it("shows unresolved blocker count for multi-dep items", () => {
    const items = [
      makeStatusItem({ id: "H-NW-1", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "H-NW-2", state: "ci-pending", dependencies: [] }),
      makeStatusItem({ id: "H-NW-3", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "H-NW-4", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "M-NW-5", state: "queued", dependencies: ["H-NW-1", "H-NW-2", "H-NW-3", "H-NW-4"] }),
      makeStatusItem({ id: "M-NW-6", state: "queued", dependencies: ["M-NW-5"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    // M-NW-5 has 1 unresolved blocker (H-NW-2) — DEPS column shows "1"
    const m5Line = lines.find(l => l.includes("M-NW-5"));
    expect(m5Line).toBeDefined();
    expect(m5Line).toContain("1");
    // M-NW-6 has 1 unresolved blocker (M-NW-5) — DEPS column shows "1"
    const m6Line = lines.find(l => l.includes("M-NW-6"));
    expect(m6Line).toBeDefined();
    expect(m6Line).toContain("1");
    // Should NOT use tree nesting
    expect(table).not.toContain("└──");
    expect(table).not.toContain("├──");
  });

  it("DEPS column shows count and never overflows 5 chars", () => {
    // Create an item with many unresolved blockers
    const deps = Array.from({ length: 15 }, (_, i) => `DEP-${i}`);
    const items = [
      ...deps.map(id => makeStatusItem({ id, state: "implementing", dependencies: [] })),
      makeStatusItem({ id: "TARGET", state: "queued", dependencies: deps }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    const targetLine = lines.find(l => l.includes("TARGET"));
    expect(targetLine).toBeDefined();
    // DEPS column should show "15" (count), not the full list of IDs
    expect(targetLine).toContain("15");
    // Verify DEPS header is present and only 4 chars + space
    expect(table).toContain("DEPS");
    // The column header "DEPS " is 5 chars, verify it doesn't say "BLOCKED BY"
    expect(table).not.toContain("BLOCKED BY");
  });

  it("DEPS column shows dash for items with no unresolved blockers", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    const lines = table.split("\n");
    // B-2's only dep (A-1) is merged, so DEPS should show "-"
    const b2Line = lines.find(l => l.includes("B-2"));
    expect(b2Line).toBeDefined();
    expect(b2Line).toContain("-");
  });

  it("sorts by blocked-by count ascending then ID alphanumeric", () => {
    const items = [
      makeStatusItem({ id: "Z-3", state: "queued", dependencies: ["A-1", "B-2"] }),
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "C-4", state: "queued", dependencies: ["A-1"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    // Find data lines containing our IDs
    const a1Line = lines.findIndex(l => l.includes("A-1"));
    const b2Line = lines.findIndex(l => l.includes("B-2"));
    const c4Line = lines.findIndex(l => l.includes("C-4"));
    const z3Line = lines.findIndex(l => l.includes("Z-3"));
    // A-1 and B-2 (0 blockers) before C-4 (1 blocker) before Z-3 (2 blockers)
    expect(a1Line).toBeLessThan(c4Line);
    expect(b2Line).toBeLessThan(c4Line);
    expect(c4Line).toBeLessThan(z3Line);
  });
});

// ── computeBlockedBy ──────────────────────────────────────────────────────────

describe("computeBlockedBy", () => {
  it("returns empty arrays for items with no deps", () => {
    const items = [
      makeStatusItem({ id: "A", dependencies: [] }),
      makeStatusItem({ id: "B" }),
    ];
    const blocked = computeBlockedBy(items);
    expect(blocked.get("A")).toEqual([]);
    expect(blocked.get("B")).toEqual([]);
  });

  it("returns only unresolved (non-merged) blockers", () => {
    const items = [
      makeStatusItem({ id: "A", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "B", state: "ci-pending", dependencies: [] }),
      makeStatusItem({ id: "C", state: "queued", dependencies: ["A", "B"] }),
    ];
    const blocked = computeBlockedBy(items);
    // A is merged, so only B blocks C
    expect(blocked.get("C")).toEqual(["B"]);
  });

  it("returns empty when all deps are merged", () => {
    const items = [
      makeStatusItem({ id: "A", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "B", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "C", state: "queued", dependencies: ["A", "B"] }),
    ];
    const blocked = computeBlockedBy(items);
    expect(blocked.get("C")).toEqual([]);
  });

  it("ignores deps not in the current item set", () => {
    const items = [
      makeStatusItem({ id: "B", state: "queued", dependencies: ["UNKNOWN-1", "UNKNOWN-2"] }),
    ];
    const blocked = computeBlockedBy(items);
    expect(blocked.get("B")).toEqual([]);
  });
});

// ── sortByBlockedThenId ───────────────────────────────────────────────────────

describe("sortByBlockedThenId", () => {
  it("sorts by blocked count ascending then ID alpha", () => {
    const items = [
      makeStatusItem({ id: "Z" }),
      makeStatusItem({ id: "A" }),
      makeStatusItem({ id: "M" }),
    ];
    const blockedBy = new Map([
      ["Z", ["dep1", "dep2"]],
      ["A", []],
      ["M", ["dep1"]],
    ]);
    const sorted = sortByBlockedThenId(items, blockedBy);
    expect(sorted.map(i => i.id)).toEqual(["A", "M", "Z"]);
  });

  it("sorts alphabetically within same blocked count", () => {
    const items = [
      makeStatusItem({ id: "C" }),
      makeStatusItem({ id: "A" }),
      makeStatusItem({ id: "B" }),
    ];
    const blockedBy = new Map([
      ["C", ["x"]],
      ["A", ["x"]],
      ["B", ["x"]],
    ]);
    const sorted = sortByBlockedThenId(items, blockedBy);
    expect(sorted.map(i => i.id)).toEqual(["A", "B", "C"]);
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
  it("falls back to 80 when columns is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(getTerminalWidth()).toBe(80);
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, "columns", original);
      } else {
        delete (process.stdout as Record<string, unknown>)["columns"];
      }
    }
  });
});

// ── computeSessionMetrics ─────────────────────────────────────────────────────

describe("computeSessionMetrics", () => {
  it("returns nulls when no merged items", () => {
    const items = [
      makeStatusItem({ state: "implementing" }),
      makeStatusItem({ id: "B", state: "queued" }),
    ];
    const metrics = computeSessionMetrics(items);
    expect(metrics.leadTimeMedianMs).toBeNull();
    expect(metrics.leadTimeP95Ms).toBeNull();
    expect(metrics.successRate).toBeNull();
    expect(metrics.throughputPerHour).toBeNull();
    expect(metrics.sessionDurationMs).toBeNull();
  });

  it("computes lead time for all merged items", () => {
    const items = [
      makeStatusItem({
        id: "A",
        state: "merged",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:30:00Z",
      }),
      makeStatusItem({
        id: "B",
        state: "merged",
        startedAt: "2026-01-01T01:00:00Z",
        endedAt: "2026-01-01T02:00:00Z",
      }),
    ];
    const metrics = computeSessionMetrics(items);
    // Lead times: 30min (1.8M ms), 60min (3.6M ms). Median = (1.8M + 3.6M) / 2 = 2.7M
    expect(metrics.leadTimeMedianMs).toBe(2_700_000);
    // P95 with 2 items: nearest-rank index = ceil(0.95 * 2) - 1 = 1 → 60min
    expect(metrics.leadTimeP95Ms).toBe(3_600_000);
  });

  it("computes lead time for a mix of merged and failed items", () => {
    const items = [
      makeStatusItem({
        id: "A",
        state: "merged",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:10:00Z",
      }),
      makeStatusItem({
        id: "B",
        state: "ci-failed",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T01:00:00Z",
      }),
    ];
    const metrics = computeSessionMetrics(items);
    // Only merged item A contributes to lead time: 10min = 600_000ms
    expect(metrics.leadTimeMedianMs).toBe(600_000);
    // Success rate: 1 merged / (1 merged + 1 failed) = 0.5
    expect(metrics.successRate).toBe(0.5);
  });

  it("handles single merged item", () => {
    const items = [
      makeStatusItem({
        id: "A",
        state: "merged",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:45:00Z",
      }),
    ];
    const metrics = computeSessionMetrics(items);
    expect(metrics.leadTimeMedianMs).toBe(2_700_000); // 45min
    expect(metrics.leadTimeP95Ms).toBe(2_700_000);
    expect(metrics.successRate).toBe(1);
  });

  it("skips merged items without startedAt", () => {
    const items = [
      makeStatusItem({ id: "A", state: "merged" }), // no startedAt
      makeStatusItem({
        id: "B",
        state: "merged",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:20:00Z",
      }),
    ];
    const metrics = computeSessionMetrics(items);
    // Only B contributes: 20min = 1_200_000ms
    expect(metrics.leadTimeMedianMs).toBe(1_200_000);
  });

  it("computes throughput when sessionStartedAt is provided", () => {
    const sessionStart = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2 hours ago
    const items = [
      makeStatusItem({ id: "A", state: "merged" }),
      makeStatusItem({ id: "B", state: "merged" }),
      makeStatusItem({ id: "C", state: "merged" }),
    ];
    const metrics = computeSessionMetrics(items, sessionStart);
    // 3 merged in ~2 hours ≈ 1.5/hr
    expect(metrics.throughputPerHour).toBeCloseTo(1.5, 0);
    expect(metrics.sessionDurationMs).toBeGreaterThan(0);
  });

  it("returns null throughput without sessionStartedAt", () => {
    const items = [makeStatusItem({ id: "A", state: "merged" })];
    const metrics = computeSessionMetrics(items);
    expect(metrics.throughputPerHour).toBeNull();
    expect(metrics.sessionDurationMs).toBeNull();
  });

  it("handles zero session duration (avoid division by zero)", () => {
    // sessionStartedAt = now → 0ms duration
    const items = [makeStatusItem({ id: "A", state: "merged" })];
    const metrics = computeSessionMetrics(items, new Date().toISOString());
    // sessionDurationMs is 0, throughput should be null (avoids division by zero)
    // Note: Due to timing, sessionDurationMs may be 0 or a small positive number
    if (metrics.sessionDurationMs === 0) {
      expect(metrics.throughputPerHour).toBeNull();
    } else {
      // Very small duration → very high throughput, which is fine
      expect(metrics.throughputPerHour).not.toBeNull();
    }
  });

  it("returns null success rate when all items are queued (no lead time data)", () => {
    const items = [
      makeStatusItem({ id: "A", state: "queued" }),
      makeStatusItem({ id: "B", state: "queued" }),
    ];
    const metrics = computeSessionMetrics(items);
    expect(metrics.successRate).toBeNull();
    expect(metrics.leadTimeMedianMs).toBeNull();
  });

  it("computes correct success rate for all merged (100%)", () => {
    const items = [
      makeStatusItem({ id: "A", state: "merged" }),
      makeStatusItem({ id: "B", state: "merged" }),
    ];
    const metrics = computeSessionMetrics(items);
    expect(metrics.successRate).toBe(1);
  });
});

// ── formatMetricsPanel ────────────────────────────────────────────────────────

describe("formatMetricsPanel", () => {
  it("renders layout structure with all sections", () => {
    const metrics: SessionMetrics = {
      leadTimeMedianMs: 1_800_000,  // 30min
      leadTimeP95Ms: 3_600_000,     // 1h
      throughputPerHour: 2.5,
      successRate: 0.85,
      sessionDurationMs: 7_200_000, // 2h
    };
    const panel = stripAnsi(formatMetricsPanel(metrics));
    expect(panel).toContain("Session Metrics");
    expect(panel).toContain("─");
  });

  it("formats lead time values", () => {
    const metrics: SessionMetrics = {
      leadTimeMedianMs: 1_800_000,
      leadTimeP95Ms: 3_600_000,
      throughputPerHour: null,
      successRate: null,
      sessionDurationMs: null,
    };
    const panel = stripAnsi(formatMetricsPanel(metrics));
    expect(panel).toContain("Lead Time (median):  30m");
    expect(panel).toContain("Lead Time (P95):     1h");
  });

  it("formats throughput", () => {
    const metrics: SessionMetrics = {
      leadTimeMedianMs: null,
      leadTimeP95Ms: null,
      throughputPerHour: 2.5,
      successRate: null,
      sessionDurationMs: null,
    };
    const panel = stripAnsi(formatMetricsPanel(metrics));
    expect(panel).toContain("Throughput:          2.5/hr");
  });

  it("formats success rate as percentage", () => {
    const metrics: SessionMetrics = {
      leadTimeMedianMs: null,
      leadTimeP95Ms: null,
      throughputPerHour: null,
      successRate: 0.75,
      sessionDurationMs: null,
    };
    const panel = stripAnsi(formatMetricsPanel(metrics));
    expect(panel).toContain("Success Rate:        75%");
  });

  it("formats session duration", () => {
    const metrics: SessionMetrics = {
      leadTimeMedianMs: null,
      leadTimeP95Ms: null,
      throughputPerHour: null,
      successRate: null,
      sessionDurationMs: 5_400_000, // 1h 30m
    };
    const panel = stripAnsi(formatMetricsPanel(metrics));
    expect(panel).toContain("Session Duration:    1h 30m");
  });

  it("shows dashes for null values", () => {
    const metrics: SessionMetrics = {
      leadTimeMedianMs: null,
      leadTimeP95Ms: null,
      throughputPerHour: null,
      successRate: null,
      sessionDurationMs: null,
    };
    const panel = stripAnsi(formatMetricsPanel(metrics));
    const lines = panel.split("\n").filter(l => l.includes(":"));
    // All metric lines should show "-"
    for (const line of lines) {
      expect(line).toMatch(/-$/);
    }
  });
});

// ── formatHelpFooter ──────────────────────────────────────────────────────────

describe("formatHelpFooter", () => {
  it("renders key bindings", () => {
    const footer = stripAnsi(formatHelpFooter());
    expect(footer).toContain("q: quit");
    expect(footer).toContain("m: metrics");
    expect(footer).toContain("b: blocker detail");
    expect(footer).toContain("h: help");
  });
});

// ── formatStatusTable with ViewOptions ────────────────────────────────────────

describe("formatStatusTable with ViewOptions", () => {
  it("backward compatible: calling without viewOptions still works", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("ninthwave status");
    expect(table).toContain("TEST-1");
    // Should NOT contain metrics or help by default
    expect(table).not.toContain("Session Metrics");
    expect(table).not.toContain("q: quit");
  });

  it("showMetrics=true includes metrics panel", () => {
    const items = [
      makeStatusItem({
        id: "A",
        state: "merged",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:30:00Z",
      }),
      makeStatusItem({
        id: "B",
        state: "merged",
        startedAt: "2026-01-01T01:00:00Z",
        endedAt: "2026-01-01T02:00:00Z",
      }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100, undefined, false, {
      showMetrics: true,
      sessionStartedAt: "2026-01-01T00:00:00Z",
    }));
    expect(table).toContain("Session Metrics");
    expect(table).toContain("Lead Time (median):");
    expect(table).toContain("Lead Time (P95):");
    expect(table).toContain("Throughput:");
    expect(table).toContain("Success Rate:");
    expect(table).toContain("Session Duration:");
  });

  it("showMetrics=false does not include metrics panel", () => {
    const items = [makeStatusItem({ state: "merged" })];
    const table = stripAnsi(formatStatusTable(items, 100, undefined, false, {
      showMetrics: false,
    }));
    expect(table).not.toContain("Session Metrics");
  });

  it("showBlockerDetail=true shows full blocker IDs in DEPS column", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "C-3", state: "queued", dependencies: ["A-1", "B-2"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showBlockerDetail: true,
    }));
    const lines = table.split("\n");
    const c3Line = lines.find(l => l.includes("C-3"));
    expect(c3Line).toBeDefined();
    // Should show full IDs instead of count
    expect(c3Line).toContain("A-1,B-2");
  });

  it("showBlockerDetail=false shows counts (default behavior)", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "C-3", state: "queued", dependencies: ["A-1", "B-2"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showBlockerDetail: false,
    }));
    const lines = table.split("\n");
    const c3Line = lines.find(l => l.includes("C-3"));
    expect(c3Line).toBeDefined();
    // Should show count "2", not full IDs
    expect(c3Line).toContain("2");
    expect(c3Line).not.toContain("A-1,B-2");
  });

  it("showBlockerDetail widens DEPS column dynamically", () => {
    const items = [
      makeStatusItem({ id: "LONG-ID-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "LONG-ID-2", state: "implementing", dependencies: [] }),
      makeStatusItem({
        id: "TARGET",
        state: "queued",
        dependencies: ["LONG-ID-1", "LONG-ID-2"],
      }),
    ];
    const tableNormal = stripAnsi(formatStatusTable(items, 120));
    const tableDetail = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showBlockerDetail: true,
    }));
    const detailLines = tableDetail.split("\n");
    const targetLine = detailLines.find(l => l.includes("TARGET"));
    expect(targetLine).toContain("LONG-ID-1,LONG-ID-2");
    // Header should still say DEPS
    expect(tableDetail).toContain("DEPS");
  });

  it("showHelp=true shows key legend footer", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80, undefined, false, {
      showHelp: true,
    }));
    expect(table).toContain("q: quit");
    expect(table).toContain("m: metrics");
    expect(table).toContain("h: help");
  });

  it("showHelp=false does not show key legend", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80, undefined, false, {
      showHelp: false,
    }));
    expect(table).not.toContain("q: quit");
  });

  it("all options can be combined", () => {
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:30:00Z",
        dependencies: [],
      }),
      makeStatusItem({
        id: "B-2",
        state: "queued",
        dependencies: ["A-1"],
      }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showMetrics: true,
      showBlockerDetail: true,
      showHelp: true,
      sessionStartedAt: "2026-01-01T00:00:00Z",
    }));
    expect(table).toContain("Session Metrics");
    expect(table).toContain("q: quit");
    // A-1 is merged, so B-2 has no unresolved blockers → shows "-"
    expect(table).toContain("DEPS");
  });
});
