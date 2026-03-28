// Tests for core/status-render.ts -- shared rendering module, TUI mode detection,
// and OrchestratorItem → StatusItem conversion.

import { describe, it, expect } from "vitest";
import {
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  formatDuration,
  formatTelemetrySuffix,
  pad,
  osc8Link,
  stripAnsiForWidth,
  computeStateColWidth,
  formatStateLabelWithPr,
  formatItemRow,
  formatQueuedItemRow,
  formatBatchProgress,
  formatSummary,
  formatStatusTable,
  formatCrewStatusPanel,
  computeBlockedBy,
  sortByBlockedThenId,
  computeSessionMetrics,
  mapDaemonItemState,
  daemonStateToStatusItems,
  getTerminalWidth,
  getTerminalHeight,
  buildStatusLayout,
  renderFullScreenFrame,
  clampScrollOffset,
  strategyIndicator,
  formatCompactMetrics,
  formatUnifiedProgress,
  formatTitleMetrics,
  blockerIcon,
  formatBlockerSubline,
  MIN_FULLSCREEN_ROWS,
  MIN_SPLIT_ROWS,
  buildPanelLayout,
  renderPanelFrame,
  formatItemDetail,
  type StatusItem,
  type ItemState,
  type ViewOptions,
  type SessionMetrics,
  type FrameLayout,
  type PanelMode,
  type PanelLayout,
  type LogEntry,
  renderHelpOverlay,
} from "../core/status-render.ts";
import {
  detectTuiMode,
  orchestratorItemsToStatusItems,
  renderTuiFrame,
} from "../core/commands/orchestrate.ts";
import type { OrchestratorItem } from "../core/orchestrator.ts";
import type { DaemonState } from "../core/daemon.ts";
import type { WorkItem } from "../core/types.ts";
import { RED, YELLOW, DIM, RESET } from "../core/output.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")   // Strip OSC 8 hyperlink sequences
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");  // Strip CSI sequences (colors, etc.)
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

function makeWorkItem(id: string, deps: string[] = []): WorkItem {
  return {
    id,
    priority: "high",
    title: `Item ${id}`,
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
    workItem: makeWorkItem(id),
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
      "merged", "bootstrapping", "implementing", "rebasing", "ci-failed", "ci-pending",
      "review", "pr-open", "in-progress", "queued",
    ];
    for (const state of states) {
      expect(typeof stateColor(state)).toBe("string");
    }
  });
  it("returns YELLOW for rebasing", () => {
    // rebasing shares the same color as bootstrapping/implementing/in-progress
    expect(stateColor("rebasing")).toBe(stateColor("implementing"));
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
      "merged", "bootstrapping", "implementing", "rebasing", "ci-failed", "ci-pending",
      "review", "pr-open", "in-progress", "queued",
    ];
    for (const state of states) {
      expect(typeof stateIcon(state)).toBe("string");
    }
  });
  it("returns the rebasing icon", () => {
    expect(stateIcon("rebasing")).toBe("⟲");
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
  it("returns Rebasing label for rebasing state", () => {
    expect(stateLabel("rebasing")).toBe("Rebasing");
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

describe("blockerIcon", () => {
  it("returns RED ⧗ for count >= 2", () => {
    expect(blockerIcon(2)).toBe(`${RED}⧗${RESET}`);
    expect(blockerIcon(5)).toBe(`${RED}⧗${RESET}`);
  });

  it("returns YELLOW ⧗ for count === 1", () => {
    expect(blockerIcon(1)).toBe(`${YELLOW}⧗${RESET}`);
  });

  it("returns a single space for count === 0", () => {
    expect(blockerIcon(0)).toBe(" ");
  });

  it("output is always 1 visible character wide", () => {
    // Icon or space -- strip ANSI, should be 1 char
    expect(stripAnsi(blockerIcon(0))).toHaveLength(1);
    expect(stripAnsi(blockerIcon(1))).toHaveLength(1);
    expect(stripAnsi(blockerIcon(3))).toHaveLength(1);
  });
});

describe("formatBlockerSubline", () => {
  // Default stateColWidth=14, no daemon → blockerColOffset = 26 + 14 + 0 = 40
  const defaultOffset = 40;

  it("pads └ to blockerColOffset so it aligns under ⧗ icon", () => {
    const result = formatBlockerSubline(["H-CA-1", "H-CA-3"], 30, false, defaultOffset);
    const text = stripAnsi(result);
    // └ should start at column 40 (defaultOffset)
    expect(text.indexOf("└")).toBe(defaultOffset);
    expect(text).toBe(" ".repeat(defaultOffset) + "└ H-CA-1, H-CA-3");
  });

  it("aligns with wider state column (e.g. CI Pending (#123))", () => {
    // stateColWidth=24 → offset = 26 + 24 + 0 = 50
    const wideStateOffset = 50;
    const result = formatBlockerSubline(["H-CA-1"], 20, false, wideStateOffset);
    const text = stripAnsi(result);
    expect(text.indexOf("└")).toBe(wideStateOffset);
    expect(text).toBe(" ".repeat(wideStateOffset) + "└ H-CA-1");
  });

  it("aligns with daemon column active (crew mode)", () => {
    // stateColWidth=14, daemonColWidth=9 → offset = 26 + 14 + 9 = 49
    const crewOffset = 49;
    const result = formatBlockerSubline(["H-CA-1"], 20, false, crewOffset);
    const text = stripAnsi(result);
    expect(text.indexOf("└")).toBe(crewOffset);
    expect(text).toBe(" ".repeat(crewOffset) + "└ H-CA-1");
  });

  it("wraps output in DIM for normal mode", () => {
    const result = formatBlockerSubline(["H-CA-1"], 40, false, defaultOffset);
    expect(result).toBe(`${DIM}${" ".repeat(defaultOffset)}└ H-CA-1${RESET}`);
  });

  it("wraps output in DIM for queued mode", () => {
    const result = formatBlockerSubline(["H-CA-1"], 40, true, defaultOffset);
    expect(result).toBe(`${DIM}${" ".repeat(defaultOffset)}└ H-CA-1${RESET}`);
  });

  it("truncates with ... when IDs exceed titleWidth", () => {
    // titleWidth=20, available=20
    // "H-CA-1, H-CA-3, H-CA-5" is 23 chars → needs truncation
    const result = formatBlockerSubline(["H-CA-1", "H-CA-3", "H-CA-5"], 20, false, defaultOffset);
    const text = stripAnsi(result);
    expect(text).toContain("...");
    expect(text.indexOf("└")).toBe(defaultOffset);
    // Content after "└ " should not exceed titleWidth
    const content = text.slice(defaultOffset + 2);
    expect(content.length).toBeLessThanOrEqual(20);
  });

  it("handles zero titleWidth gracefully", () => {
    const result = formatBlockerSubline(["H-1"], 0, false, defaultOffset);
    const text = stripAnsi(result);
    // available=0, so content is empty
    expect(text).toBe(" ".repeat(defaultOffset) + "└ ");
  });

  it("renders single ID without truncation", () => {
    const result = formatBlockerSubline(["H-1"], 30, false, defaultOffset);
    const text = stripAnsi(result);
    expect(text).toBe(" ".repeat(defaultOffset) + "└ H-1");
  });

  it("uses default offset of 4 when blockerColOffset is omitted", () => {
    const result = formatBlockerSubline(["H-1"], 30, false);
    const text = stripAnsi(result);
    expect(text).toBe("    └ H-1");
    expect(text.indexOf("└")).toBe(4);
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

  it("returns dash for queued items", () => {
    const item = makeStatusItem({
      state: "queued",
      ageMs: 10 * 60_000,
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(formatDuration(item)).toBe("-");
  });

  it("returns real duration for implementing items", () => {
    const item = makeStatusItem({
      state: "implementing",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:45:00Z",
    });
    expect(formatDuration(item)).toBe("45m");
  });

  it("returns real duration for ci-pending items", () => {
    const item = makeStatusItem({
      state: "ci-pending",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T02:00:00Z",
    });
    expect(formatDuration(item)).toBe("2h");
  });

  it("returns real duration for merged items", () => {
    const item = makeStatusItem({
      state: "merged",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:05:00Z",
    });
    expect(formatDuration(item)).toBe("5m");
  });
});

describe("formatTelemetrySuffix", () => {
  it("returns empty string for active items (no elapsed)", () => {
    const item = makeStatusItem({
      state: "implementing",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(formatTelemetrySuffix(item)).toBe("");
  });

  it("returns empty string for bootstrapping items", () => {
    const item = makeStatusItem({
      state: "bootstrapping",
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    expect(formatTelemetrySuffix(item)).toBe("");
  });

  it("includes exit code for ci-failed items", () => {
    const item = makeStatusItem({
      state: "ci-failed",
      exitCode: 1,
    });
    const result = stripAnsi(formatTelemetrySuffix(item));
    expect(result).toContain("exit: 1");
  });

  it("includes stderr for ci-failed items", () => {
    const item = makeStatusItem({
      state: "ci-failed",
      stderrTail: "Error: module not found",
    });
    const result = stripAnsi(formatTelemetrySuffix(item));
    expect(result).toContain("stderr: Error: module not found");
  });

  it("includes both exit and stderr for ci-failed items", () => {
    const item = makeStatusItem({
      state: "ci-failed",
      exitCode: 2,
      stderrTail: "Segfault",
    });
    const result = stripAnsi(formatTelemetrySuffix(item));
    expect(result).toContain("exit: 2");
    expect(result).toContain("stderr: Segfault");
  });

  it("returns empty string for merged items", () => {
    const item = makeStatusItem({ state: "merged" });
    expect(formatTelemetrySuffix(item)).toBe("");
  });

  it("shows worktree path for stuck items", () => {
    const item = makeStatusItem({
      state: "stuck",
      worktreePath: "/tmp/project/.worktrees/ninthwave-H-FOO-1",
    });
    const result = stripAnsi(formatTelemetrySuffix(item));
    expect(result).toContain("worktree: /tmp/project/.worktrees/ninthwave-H-FOO-1");
  });

  it("does not show worktree path for stuck items without worktreePath", () => {
    const item = makeStatusItem({ state: "stuck" });
    expect(formatTelemetrySuffix(item)).toBe("");
  });

  it("does not show worktree path for non-stuck items", () => {
    const item = makeStatusItem({
      state: "implementing",
      worktreePath: "/tmp/project/.worktrees/ninthwave-H-FOO-1",
    });
    expect(formatTelemetrySuffix(item)).toBe("");
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
  it("includes PR number inline with state when present", () => {
    const item = makeStatusItem({ prNumber: 42 });
    const row = stripAnsi(formatItemRow(item, 20));
    expect(row).toContain("(#42)");
    expect(row).toContain("Implementing (#42)");
  });
  it("shows state only when no PR number", () => {
    const item = makeStatusItem({ prNumber: null });
    const row = stripAnsi(formatItemRow(item, 20));
    expect(row).toContain("Implementing");
    expect(row).not.toContain("#");
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

describe("formatItemRow with depIndicator", () => {
  it("includes depIndicator string before title when provided", () => {
    const item = makeStatusItem({ id: "C-1-1", title: "My feature" });
    const indicator = "⧗ "; // 2-char indicator
    const row = stripAnsi(formatItemRow(item, 20, indicator));
    expect(row).toContain("⧗");
    expect(row).toContain("My feature");
  });

  it("omits indicator when not provided", () => {
    const item = makeStatusItem({ id: "C-1-1", title: "My feature" });
    const row = stripAnsi(formatItemRow(item, 20));
    expect(row).not.toContain("⧗");
    expect(row).toContain("My feature");
  });
});

describe("formatQueuedItemRow", () => {
  it("renders without ANSI color markers in test env", () => {
    const item = makeStatusItem({ state: "queued", id: "C-1-2" });
    const row = stripAnsi(formatQueuedItemRow(item, 20));
    expect(row).toContain("C-1-2");
  });

  it("includes depIndicator string before title when provided", () => {
    const item = makeStatusItem({ state: "queued", id: "C-1-2", title: "Waiting" });
    const indicator = "⧗ ";
    const row = stripAnsi(formatQueuedItemRow(item, 20, indicator));
    expect(row).toContain("⧗");
    expect(row).toContain("Waiting");
  });
});

// ── Inline PR suffix and OSC 8 hyperlink tests (H-TUI-4) ─────────────────────

describe("osc8Link", () => {
  it("wraps text in OSC 8 escape sequences", () => {
    const link = osc8Link("https://github.com/org/repo/pull/265", "(#265)");
    expect(link).toBe("\x1b]8;;https://github.com/org/repo/pull/265\x07(#265)\x1b]8;;\x07");
  });

  it("produces plain text when stripped", () => {
    const link = osc8Link("https://github.com/org/repo/pull/265", "(#265)");
    expect(stripAnsi(link)).toBe("(#265)");
  });
});

describe("stripAnsiForWidth", () => {
  it("strips CSI sequences", () => {
    expect(stripAnsiForWidth("\x1b[33mhello\x1b[0m")).toBe("hello");
  });

  it("strips OSC 8 hyperlink sequences", () => {
    const withLink = "\x1b]8;;https://example.com\x07text\x1b]8;;\x07";
    expect(stripAnsiForWidth(withLink)).toBe("text");
  });

  it("strips both CSI and OSC 8 combined", () => {
    const mixed = "\x1b[33m\x1b]8;;url\x07click\x1b]8;;\x07\x1b[0m";
    expect(stripAnsiForWidth(mixed)).toBe("click");
  });
});

describe("computeStateColWidth", () => {
  it("returns 14 when no items have PRs", () => {
    const items = [
      makeStatusItem({ state: "implementing", prNumber: null }),
      makeStatusItem({ state: "queued", prNumber: null }),
    ];
    expect(computeStateColWidth(items)).toBe(14);
  });

  it("expands width when items have PRs", () => {
    const items = [
      makeStatusItem({ state: "ci-pending", prNumber: 265 }),
      makeStatusItem({ state: "implementing", prNumber: null }),
    ];
    // "CI Pending (#265)" = 17 chars
    expect(computeStateColWidth(items)).toBe(17);
  });

  it("caps at 24 even with very large PR numbers", () => {
    const items = [
      makeStatusItem({ state: "bootstrapping", prNumber: 999999 }),
    ];
    // "Bootstrapping (#999999)" = 23 chars, within cap
    expect(computeStateColWidth(items)).toBeLessThanOrEqual(24);
  });

  it("returns 14 for empty items list", () => {
    expect(computeStateColWidth([])).toBe(14);
  });
});

describe("formatStateLabelWithPr", () => {
  it("returns padded state label when no PR", () => {
    const result = formatStateLabelWithPr("implementing", null, 14);
    expect(result).toBe("Implementing  ");
    expect(result.length).toBe(14);
  });

  it("includes PR number inline when present", () => {
    const result = formatStateLabelWithPr("ci-pending", 265, 20);
    expect(stripAnsi(result)).toContain("CI Pending (#265)");
  });

  it("pads to stateColWidth based on display width", () => {
    const result = formatStateLabelWithPr("merged", 42, 20);
    const display = stripAnsi(result);
    // "Merged (#42)" = 12 chars, padded to 20
    expect(display.length).toBe(20);
  });

  it("generates OSC 8 hyperlink when repoUrl is provided", () => {
    const result = formatStateLabelWithPr("ci-pending", 265, 20, "https://github.com/org/repo");
    // Should contain OSC 8 escape sequences
    expect(result).toContain("\x1b]8;;");
    expect(result).toContain("https://github.com/org/repo/pull/265");
    expect(result).toContain("\x1b]8;;\x07");
    // But display text should still be correct
    expect(stripAnsi(result).trimEnd()).toBe("CI Pending (#265)");
  });

  it("does not generate OSC 8 when repoUrl is not provided", () => {
    const result = formatStateLabelWithPr("ci-pending", 265, 20);
    expect(result).not.toContain("\x1b]8;;");
    expect(result).toContain("CI Pending (#265)");
  });
});

describe("formatItemRow with inline PR", () => {
  it("shows state only with no extra padding when no PR", () => {
    const item = makeStatusItem({ state: "implementing", prNumber: null });
    const row = stripAnsi(formatItemRow(item, 30));
    expect(row).toContain("Implementing");
    expect(row).not.toContain("(#");
  });

  it("shows state with PR suffix when PR present", () => {
    const item = makeStatusItem({ state: "ci-pending", prNumber: 265 });
    const row = stripAnsi(formatItemRow(item, 30, undefined, 20));
    expect(row).toContain("CI Pending (#265)");
  });

  it("includes OSC 8 hyperlink when repoUrl is passed", () => {
    const item = makeStatusItem({ state: "ci-pending", prNumber: 265 });
    const row = formatItemRow(item, 30, undefined, 20, "https://github.com/org/repo");
    // Raw row contains OSC 8 sequences
    expect(row).toContain("\x1b]8;;https://github.com/org/repo/pull/265\x07");
    // Stripped row shows clean text
    expect(stripAnsi(row)).toContain("CI Pending (#265)");
  });

  it("does not include OSC 8 when repoUrl is omitted", () => {
    const item = makeStatusItem({ state: "ci-pending", prNumber: 265 });
    const row = formatItemRow(item, 30, undefined, 20);
    expect(row).not.toContain("\x1b]8;;");
  });
});

describe("formatStatusTable dynamic state column width", () => {
  it("uses narrow state column when no items have PRs", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", prNumber: null }),
      makeStatusItem({ id: "A-2", state: "queued", prNumber: null }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    const lines = table.split("\n");
    const headerLine = lines.find(l => l.includes("STATE"));
    const dataLine = lines.find(l => l.includes("A-1"));
    expect(headerLine).toBeDefined();
    expect(dataLine).toBeDefined();
    // STATE header and data should align at same position
    const headerStatePos = headerLine!.indexOf("STATE");
    const dataStatePos = dataLine!.indexOf("Implementing");
    expect(headerStatePos).toBe(dataStatePos);
  });

  it("expands state column when items have PRs", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", prNumber: 42 }),
      makeStatusItem({ id: "A-2", state: "ci-pending", prNumber: 265 }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    expect(table).toContain("Implementing (#42)");
    expect(table).toContain("CI Pending (#265)");
  });

  it("header DURATION aligns with row DURATION when PR widths vary", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", prNumber: 42, ageMs: 60_000 }),
      makeStatusItem({ id: "A-2", state: "ci-pending", prNumber: 9999, ageMs: 120_000 }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    const headerLine = lines.find(l => l.includes("DURATION"));
    const a1Line = lines.find(l => l.includes("A-1"));
    const a2Line = lines.find(l => l.includes("A-2"));
    expect(headerLine).toBeDefined();
    expect(a1Line).toBeDefined();
    expect(a2Line).toBeDefined();
    // DURATION header position should match data duration positions
    const headerDurPos = headerLine!.indexOf("DURATION");
    // Both rows should have their duration at the same horizontal position
    const a1DurPos = a1Line!.indexOf("1m");
    const a2DurPos = a2Line!.indexOf("2m");
    expect(a1DurPos).toBe(a2DurPos);
    // Duration should be to the right of the state column
    expect(a1DurPos).toBeGreaterThan(headerLine!.indexOf("STATE"));
  });

  it("PR column header is not present", () => {
    const items = [makeStatusItem({ prNumber: 42 })];
    const table = stripAnsi(formatStatusTable(items, 80));
    const lines = table.split("\n");
    const headerLine = lines.find(l => l.includes("STATE"));
    expect(headerLine).toBeDefined();
    // Should not have a standalone PR header column
    expect(headerLine).not.toMatch(/\bPR\s+DURATION/);
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

  it("renders unified footer progress line", () => {
    const items = [makeStatusItem({ state: "merged" })];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("merged");
    expect(table).toContain("1 item");
    // Old-style lines should not appear
    expect(table).not.toContain("Progress:");
    expect(table).not.toContain("Total:");
  });

  it("handles various terminal widths without crashing", () => {
    const items = [makeStatusItem()];
    expect(() => formatStatusTable(items, 40)).not.toThrow();
    expect(() => formatStatusTable(items, 80)).not.toThrow();
    expect(() => formatStatusTable(items, 200)).not.toThrow();
  });

  it("renders rebasing icon and label for rebasing state items", () => {
    const items = [makeStatusItem({ id: "REB-1", title: "Rebasing item", state: "rebasing" })];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("Rebasing");
    expect(table).toContain("⟲");
  });

  it("renders DURATION header instead of AGE", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("DURATION");
    expect(table).not.toContain(" AGE ");
  });

  it("shows dash in duration column for queued rows", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", ageMs: 10 * 60_000 }),
      makeStatusItem({ id: "B-2", state: "queued", ageMs: 5 * 60_000 }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    const lines = table.split("\n");
    const queuedLine = lines.find(l => l.includes("B-2"));
    expect(queuedLine).toBeDefined();
    // Queued row should show "-" in the duration column, not a time value
    expect(queuedLine).toMatch(/\b-\b/);
    // Active row should still show a real duration
    const activeLine = lines.find(l => l.includes("A-1"));
    expect(activeLine).toBeDefined();
    expect(activeLine).toContain("10m");
  });

  it("separator width matches data row content width across terminal widths", () => {
    const items = [makeStatusItem({ id: "TEST-1", title: "A title" })];
    // No deps, no PRs: stateColWidth=14, depIndicatorWidth=0, fixedWidth=26+14=40
    // titleWidth=max(10, termWidth-40)
    // Separator visible width = 2 + min(termWidth-2, fixedWidth+titleWidth)
    const fixedWidth = 40;
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

  it("separator width with deps (hasDeps=true) uses 2-char indicator slot", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"], title: "A longer title for testing width" }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    const sepLines = lines.filter(l => /^\s+─+$/.test(l));
    expect(sepLines.length).toBeGreaterThan(0);
    // With a 120-char terminal and 2-char dep indicator, separator should span most of the width
    // fixedWidth = 26 + 14 + 0 + 2 = 42, titleWidth = max(10, 120 - 42) = 78
    // sep = 2 + min(118, 42 + 78) = 2 + 118 = 120
    expect(sepLines[0]!.length).toBe(120);
  });

  it("no DEPS header when items have dependencies (inline indicator only)", () => {
    const items = [
      makeStatusItem({ id: "A", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "B", state: "queued", dependencies: ["A"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    // DEPS column header is removed -- indicator is inline before title
    expect(table).not.toContain("DEPS");
  });

  it("does not show DEPS header when no items have dependencies", () => {
    const items = [
      makeStatusItem({ id: "A", state: "implementing" }),
      makeStatusItem({ id: "B", state: "queued" }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100));
    expect(table).not.toContain("DEPS");
  });

  it("shows ⧗ icon before blocked item titles", () => {
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
    // M-NW-5 has 1 unresolved blocker (H-NW-2) -- blocker icon should appear
    const m5Line = lines.find(l => l.includes("M-NW-5"));
    expect(m5Line).toBeDefined();
    expect(m5Line).toContain("⧗");
    // M-NW-6 has 1 unresolved blocker (M-NW-5) -- blocker icon should appear
    const m6Line = lines.find(l => l.includes("M-NW-6"));
    expect(m6Line).toBeDefined();
    expect(m6Line).toContain("⧗");
    // Should NOT use tree nesting
    expect(table).not.toContain("└──");
    expect(table).not.toContain("├──");
  });

  it("sub-lines show blocker IDs by default (showBlockerDetail defaults to undefined/true in callers)", () => {
    // Create an item with many unresolved blockers
    const deps = Array.from({ length: 15 }, (_, i) => `DEP-${i}`);
    const items = [
      ...deps.map(id => makeStatusItem({ id, state: "implementing", dependencies: [] })),
      makeStatusItem({ id: "TARGET", state: "queued", dependencies: deps }),
    ];
    // With showBlockerDetail=true, sub-lines appear showing blocker IDs
    const table = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showBlockerDetail: true,
    }));
    const lines = table.split("\n");
    const targetLine = lines.find(l => l.includes("TARGET"));
    expect(targetLine).toBeDefined();
    // ⧗ icon should appear on the TARGET row (RED for 15 blockers >= 2)
    expect(targetLine).toContain("⧗");
    // Sub-line with └ prefix should appear below TARGET
    const subLine = lines.find(l => l.includes("└"));
    expect(subLine).toBeDefined();
    // No DEPS header
    expect(table).not.toContain("DEPS");
  });

  it("no icon and no sub-line when all deps resolved", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 100, undefined, false, {
      showBlockerDetail: true,
    }));
    const lines = table.split("\n");
    // B-2's only dep (A-1) is merged, so no ⧗ icon and no sub-line
    const b2Line = lines.find(l => l.includes("B-2"));
    expect(b2Line).toBeDefined();
    expect(b2Line).not.toContain("⧗");
    // No sub-line with └
    expect(table).not.toContain("└");
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

  it("titles align whether or not item has blockers (2-char slot consistent)", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", title: "No blockers here", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "queued", title: "Blocked item", dependencies: ["A-1"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120));
    const lines = table.split("\n");
    const a1Line = lines.find(l => l.includes("A-1"));
    const b2Line = lines.find(l => l.includes("B-2"));
    expect(a1Line).toBeDefined();
    expect(b2Line).toBeDefined();
    // Both titles should start at the same column position
    // A-1 has "  " (2 spaces) before title, B-2 has "⧗ " (icon + space)
    const a1TitlePos = a1Line!.indexOf("No blockers here");
    const b2TitlePos = b2Line!.indexOf("Blocked item");
    expect(a1TitlePos).toBe(b2TitlePos);
  });

  it("RED ⧗ for 2+ blockers, YELLOW ⧗ for 1 blocker in formatStatusTable", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "C-3", state: "queued", dependencies: ["A-1"] }),       // 1 blocker
      makeStatusItem({ id: "D-4", state: "queued", dependencies: ["A-1", "B-2"] }), // 2 blockers
    ];
    // Use raw (non-stripped) output to check colors
    const table = formatStatusTable(items, 120);
    // C-3 has 1 blocker → YELLOW ⧗
    expect(table).toContain(`${YELLOW}⧗${RESET}`);
    // D-4 has 2 blockers → RED ⧗
    expect(table).toContain(`${RED}⧗${RESET}`);
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

  it("returns rebasing when rebaseRequested is true and state is ci-pending", () => {
    expect(mapDaemonItemState("ci-pending", { rebaseRequested: true })).toBe("rebasing");
  });

  it("returns rebasing when rebaseRequested is true and state is ci-failed", () => {
    expect(mapDaemonItemState("ci-failed", { rebaseRequested: true })).toBe("rebasing");
  });

  it("returns ci-pending when rebaseRequested is false", () => {
    expect(mapDaemonItemState("ci-pending", { rebaseRequested: false })).toBe("ci-pending");
  });

  it("returns ci-pending when no flags passed (backward compat)", () => {
    expect(mapDaemonItemState("ci-pending")).toBe("ci-pending");
  });

  it("ignores rebaseRequested for non ci-pending/ci-failed states", () => {
    expect(mapDaemonItemState("implementing", { rebaseRequested: true })).toBe("implementing");
    expect(mapDaemonItemState("merged", { rebaseRequested: true })).toBe("merged");
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

  it("maps rebaseRequested flag to rebasing display state", () => {
    const now = new Date().toISOString();
    const state: DaemonState = {
      pid: 1,
      startedAt: now,
      updatedAt: now,
      items: [
        {
          id: "C-1-3",
          state: "ci-pending",
          prNumber: 10,
          title: "Rebasing item",
          lastTransition: now,
          ciFailCount: 0,
          retryCount: 0,
          rebaseRequested: true,
        },
      ],
    };
    const items = daemonStateToStatusItems(state);
    expect(items[0]!.state).toBe("rebasing");
  });

  it("does not map to rebasing when rebaseRequested is absent", () => {
    const now = new Date().toISOString();
    const state: DaemonState = {
      pid: 1,
      startedAt: now,
      updatedAt: now,
      items: [
        {
          id: "C-1-4",
          state: "ci-pending",
          prNumber: 10,
          title: "Normal item",
          lastTransition: now,
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };
    const items = daemonStateToStatusItems(state);
    expect(items[0]!.state).toBe("ci-pending");
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
    expect(result[0]!.title).toBe("Item C-1-1");
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

  it("threads viewOptions with sessionStartedAt to formatTitleMetrics", () => {
    const written: string[] = [];
    const items = [
      makeOrchestratorItem("A-1", "merged"),
      makeOrchestratorItem("A-2", "merged"),
      makeOrchestratorItem("A-3", "merged"),
    ];
    const sessionStart = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2 hours ago
    renderTuiFrame(items, undefined, (s) => written.push(s), {
      sessionStartedAt: sessionStart,
    });
    const full = stripAnsi(written.join(""));
    // Session duration should appear in the title metrics line
    expect(full).toContain("Session:");
  });

  it("does not render old metrics panel (removed)", () => {
    const written: string[] = [];
    const items = [makeOrchestratorItem("C-1-1", "merged")];
    renderTuiFrame(items, undefined, (s) => written.push(s));
    const full = stripAnsi(written.join(""));
    // The DORA-style metrics panel was removed -- only title-line metrics remain
    expect(full).not.toContain("Session Metrics");
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

// ── formatStatusTable with ViewOptions ────────────────────────────────────────

describe("formatStatusTable with ViewOptions", () => {
  it("backward compatible: calling without viewOptions still works", () => {
    const items = [makeStatusItem()];
    const table = stripAnsi(formatStatusTable(items, 80));
    expect(table).toContain("ninthwave status");
    expect(table).toContain("TEST-1");
  });

  it("showBlockerDetail=true shows sub-lines with blocker IDs", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "C-3", state: "queued", dependencies: ["A-1", "B-2"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showBlockerDetail: true,
    }));
    const lines = table.split("\n");
    // C-3 should have ⧗ icon and a sub-line with └ prefix showing blocker IDs
    const c3Line = lines.find(l => l.includes("C-3"));
    expect(c3Line).toBeDefined();
    expect(c3Line).toContain("⧗");
    // Sub-line should contain both blocker IDs
    const subLine = lines.find(l => l.includes("└"));
    expect(subLine).toBeDefined();
    expect(subLine).toContain("A-1");
    expect(subLine).toContain("B-2");
  });

  it("showBlockerDetail=false hides sub-lines but icon persists", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "C-3", state: "queued", dependencies: ["A-1", "B-2"] }),
    ];
    const table = stripAnsi(formatStatusTable(items, 120, undefined, false, {
      showBlockerDetail: false,
    }));
    const lines = table.split("\n");
    // C-3 should still have ⧗ icon
    const c3Line = lines.find(l => l.includes("C-3"));
    expect(c3Line).toBeDefined();
    expect(c3Line).toContain("⧗");
    // But no sub-line with └
    expect(table).not.toContain("└");
  });

  it("sub-line truncates with ... for many deps", () => {
    const items = [
      makeStatusItem({ id: "LONG-ID-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "LONG-ID-2", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "LONG-ID-3", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "LONG-ID-4", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "LONG-ID-5", state: "implementing", dependencies: [] }),
      makeStatusItem({
        id: "TARGET",
        state: "queued",
        dependencies: ["LONG-ID-1", "LONG-ID-2", "LONG-ID-3", "LONG-ID-4", "LONG-ID-5"],
      }),
    ];
    // Use a narrow terminal to force truncation of sub-line
    const table = stripAnsi(formatStatusTable(items, 60, undefined, false, {
      showBlockerDetail: true,
    }));
    const lines = table.split("\n");
    // Sub-line should exist and may be truncated with ...
    const subLine = lines.find(l => l.includes("└"));
    expect(subLine).toBeDefined();
    // Sub-line should contain at least the first ID
    expect(subLine).toContain("LONG-ID-1");
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
      showBlockerDetail: true,
      sessionStartedAt: "2026-01-01T00:00:00Z",
    }));
    // A-1 is merged, so B-2 has no unresolved blockers -- no icon, no sub-line
    expect(table).not.toContain("⧗");
    expect(table).not.toContain("└");
    // No DEPS header
    expect(table).not.toContain("DEPS");
  });
});

// ── Full-screen scrollable layout ───────────────────────────────────────────

describe("getTerminalHeight", () => {
  it("returns a positive number", () => {
    const height = getTerminalHeight();
    expect(typeof height).toBe("number");
    expect(height).toBeGreaterThan(0);
  });
});

describe("buildStatusLayout", () => {
  it("returns correct header/item/footer structure", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing" }),
      makeStatusItem({ id: "A-2", state: "merged" }),
      makeStatusItem({ id: "A-3", state: "queued" }),
    ];
    const layout = buildStatusLayout(items, 80);

    // Header should include the title and column headers
    const headerText = layout.headerLines.map(stripAnsi).join("\n");
    expect(headerText).toContain("ninthwave status");
    expect(headerText).toContain("ID");
    expect(headerText).toContain("STATE");

    // Items should include our item rows
    expect(layout.itemLines.length).toBeGreaterThan(0);
    const itemText = layout.itemLines.map(stripAnsi).join("\n");
    expect(itemText).toContain("A-1");
    expect(itemText).toContain("A-2");
    expect(itemText).toContain("A-3");

    // Footer should include unified progress line and keyboard shortcuts
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("implementing");
    expect(footerText).toContain("3 items");
    expect(footerText).toContain("scroll");
    expect(footerText).toContain("quit");
  });

  it("returns empty itemLines for empty items array", () => {
    const layout = buildStatusLayout([], 80);
    expect(layout.itemLines).toHaveLength(0);
    // Header should show no-items message
    const headerText = layout.headerLines.map(stripAnsi).join("\n");
    expect(headerText).toContain("No active items");
  });

  it("includes unified progress in footer", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "implementing" }),
    ];
    const layout = buildStatusLayout(items, 80);
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("merged");
    expect(footerText).toContain("implementing");
    expect(footerText).toContain("2 items");
  });

  it("footer has 1 progress line instead of 3 (saves 2 vertical lines)", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "implementing" }),
      makeStatusItem({ id: "A-3", state: "ci-pending" }),
    ];
    const layout = buildStatusLayout(items, 80);
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    // Should NOT contain old-style Progress:/Total: lines
    expect(footerText).not.toContain("Progress:");
    expect(footerText).not.toContain("Total:");
    // Should contain unified progress with icons and state counts
    expect(footerText).toContain("merged");
    expect(footerText).toContain("implementing");
    expect(footerText).toContain("ci pending");
    expect(footerText).toContain("3 items");
  });

  it("title line shows right-aligned Lead/Thru when metrics available", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 600_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      sessionStartedAt: new Date(now - 3_600_000).toISOString(),
    });
    const headerText = layout.headerLines.map(stripAnsi).join("\n");
    expect(headerText).toContain("ninthwave status");
    expect(headerText).toContain("Lead:");
    expect(headerText).toContain("Thru:");
  });

  it("counts sub-lines in itemLines.length when showBlockerDetail is true", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing", dependencies: [] }),
      makeStatusItem({ id: "B-2", state: "queued", dependencies: ["A-1"] }),
    ];
    const layoutWithDetail = buildStatusLayout(items, 100, undefined, false, {
      showBlockerDetail: true,
    });
    const layoutWithoutDetail = buildStatusLayout(items, 100, undefined, false, {
      showBlockerDetail: false,
    });
    // With showBlockerDetail=true, B-2 has 1 unresolved blocker → sub-line emitted
    // So itemLines should have 1 extra line
    expect(layoutWithDetail.itemLines.length).toBeGreaterThan(layoutWithoutDetail.itemLines.length);
    // The extra line should be a sub-line with └ prefix
    const subLine = layoutWithDetail.itemLines.find(l => stripAnsi(l).includes("└"));
    expect(subLine).toBeDefined();
  });

  it("includes keyboard shortcuts in footer", () => {
    const items = [makeStatusItem({ id: "A-1" })];
    const layout = buildStatusLayout(items, 80);
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("quit");
    expect(footerText).toContain("scroll");
    // Removed shortcuts should not appear
    expect(footerText).not.toContain("metrics");
    expect(footerText).not.toContain("help");
  });

  it("renders strategy indicator in footer when mergeStrategy is set", () => {
    const items = [makeStatusItem({ id: "A-1" })];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      mergeStrategy: "auto",
    });
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("› auto");
    expect(footerText).toContain("shift+tab to cycle");
    expect(footerText).toContain("? for help");
    // Old shortcuts should NOT appear
    expect(footerText).not.toContain("quit");
    expect(footerText).not.toContain("scroll");
  });

  it("renders manual strategy with ‖ icon", () => {
    const items = [makeStatusItem({ id: "A-1" })];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      mergeStrategy: "manual",
    });
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("‖ manual");
    expect(footerText).toContain("shift+tab to cycle");
  });

  it("renders bypass strategy with » icon", () => {
    const items = [makeStatusItem({ id: "A-1" })];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      mergeStrategy: "bypass",
    });
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("» bypass");
    expect(footerText).toContain("shift+tab to cycle");
  });

  it("renders Ctrl+C confirmation footer when ctrlCPending is true", () => {
    const items = [makeStatusItem({ id: "A-1" })];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      mergeStrategy: "auto",
      ctrlCPending: true,
    });
    const footerText = layout.footerLines.map(stripAnsi).join("\n");
    expect(footerText).toContain("Press Ctrl-C again to exit");
    // Strategy indicator should NOT appear during Ctrl+C pending
    expect(footerText).not.toContain("shift+tab");
  });
});

describe("strategyIndicator", () => {
  it("returns correct icon and label for auto", () => {
    const result = strategyIndicator("auto");
    const plain = stripAnsi(result);
    expect(plain).toBe("› auto");
  });

  it("returns correct icon and label for manual", () => {
    const result = strategyIndicator("manual");
    const plain = stripAnsi(result);
    expect(plain).toBe("‖ manual");
  });

  it("returns correct icon and label for bypass", () => {
    const result = strategyIndicator("bypass");
    const plain = stripAnsi(result);
    expect(plain).toBe("» bypass");
  });
});

describe("renderFullScreenFrame", () => {
  function makeLayout(itemCount: number): FrameLayout {
    return {
      headerLines: ["HEADER 1", "HEADER 2"],
      itemLines: Array.from({ length: itemCount }, (_, i) => `ITEM ${i}`),
      footerLines: ["FOOTER 1", "FOOTER 2"],
    };
  }

  it("with viewport smaller than items: slices and shows scroll indicators", () => {
    const layout = makeLayout(20);
    // termRows = 10, header = 2, footer = 2 => 6 lines for items+indicators
    const frame = renderFullScreenFrame(layout, 10, 80, 0);

    const text = frame.join("\n");
    // Should contain header and footer
    expect(text).toContain("HEADER 1");
    expect(text).toContain("FOOTER 1");
    // Should have scroll-down indicator (items overflow)
    expect(stripAnsi(text)).toContain("more below");
    // Should not have scroll-up indicator (at top)
    expect(stripAnsi(text)).not.toContain("more above");

    // Total frame lines should not exceed termRows
    expect(frame.length).toBeLessThanOrEqual(10);
  });

  it("with viewport larger than items: no scroll indicators", () => {
    const layout = makeLayout(3);
    // termRows = 30, header = 2, footer = 2 => 26 lines for items (3 items fit easily)
    const frame = renderFullScreenFrame(layout, 30, 80, 0);

    const text = stripAnsi(frame.join("\n"));
    expect(text).not.toContain("more above");
    expect(text).not.toContain("more below");
    // All items should be present
    expect(text).toContain("ITEM 0");
    expect(text).toContain("ITEM 1");
    expect(text).toContain("ITEM 2");
  });

  it("scroll offset > 0 shows up indicator", () => {
    const layout = makeLayout(20);
    const frame = renderFullScreenFrame(layout, 10, 80, 5);

    const text = stripAnsi(frame.join("\n"));
    expect(text).toContain("more above");
    // With offset 5, ITEM 0 should not be visible
    expect(text).not.toContain("ITEM 0");
    // Should contain ITEM 5
    expect(text).toContain("ITEM 5");
  });

  it("scroll offset at bottom shows only up indicator", () => {
    const layout = makeLayout(20);
    // Scroll to end
    const frame = renderFullScreenFrame(layout, 10, 80, 999);

    const text = stripAnsi(frame.join("\n"));
    expect(text).toContain("more above");
    expect(text).not.toContain("more below");
    // Last item should be visible
    expect(text).toContain("ITEM 19");
  });
});

describe("clampScrollOffset", () => {
  it("returns 0 when items fit in viewport", () => {
    expect(clampScrollOffset(5, 3, 10)).toBe(0);
    expect(clampScrollOffset(0, 10, 10)).toBe(0);
  });

  it("clamps to max offset when exceeding bounds", () => {
    // 20 items, 6 viewport => max offset = 14
    expect(clampScrollOffset(100, 20, 6)).toBe(14);
    expect(clampScrollOffset(14, 20, 6)).toBe(14);
    expect(clampScrollOffset(15, 20, 6)).toBe(14);
  });

  it("returns 0 for negative offsets", () => {
    expect(clampScrollOffset(-5, 20, 6)).toBe(0);
  });

  it("preserves valid offset", () => {
    expect(clampScrollOffset(5, 20, 6)).toBe(5);
  });

  it("terminal resize handler resets scroll if exceeds new bounds", () => {
    // Simulate: 20 items, was at offset 15 with viewport 5
    // Terminal resizes to viewport 10 => max offset = 10
    expect(clampScrollOffset(15, 20, 10)).toBe(10);
    // Terminal resizes large enough to show all items
    expect(clampScrollOffset(15, 20, 25)).toBe(0);
  });
});

describe("formatCompactMetrics", () => {
  it("formats compact single-line metrics", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "merged" }),
      makeStatusItem({ id: "B-1", state: "implementing" }),
      makeStatusItem({ id: "B-2", state: "implementing" }),
      makeStatusItem({ id: "C-1", state: "queued" }),
      makeStatusItem({ id: "C-2", state: "queued" }),
      makeStatusItem({ id: "C-3", state: "queued" }),
    ];
    const text = stripAnsi(formatCompactMetrics(items));
    expect(text).toContain("2 merged");
    expect(text).toContain("2 active");
    expect(text).toContain("3 queued");
  });

  it("shows lead time and throughput when sessionStartedAt is provided", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 600_000).toISOString(), // 10 min ago
        endedAt: new Date(now - 300_000).toISOString(),   // 5 min ago (5m lead time)
      }),
    ];
    const text = stripAnsi(formatCompactMetrics(items, new Date(now - 3_600_000).toISOString()));
    expect(text).toContain("Lead:");
    expect(text).toContain("Thru:");
  });
});

describe("formatUnifiedProgress", () => {
  it("returns empty string for no items", () => {
    expect(formatUnifiedProgress([], 80)).toBe("");
  });

  it("shows all merged with icon and total count", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "merged" }),
      makeStatusItem({ id: "A-3", state: "merged" }),
    ];
    const text = stripAnsi(formatUnifiedProgress(items, 80));
    expect(text).toContain("✓ 3 merged");
    expect(text).toContain("3 items");
  });

  it("shows mixed active states with icons", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "implementing" }),
      makeStatusItem({ id: "A-3", state: "ci-pending" }),
    ];
    const text = stripAnsi(formatUnifiedProgress(items, 100));
    expect(text).toContain("✓ 1 merged");
    expect(text).toContain("▸ 1 implementing");
    expect(text).toContain("◌ 1 ci pending");
    expect(text).toContain("3 items");
  });

  it("shows single active state", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing" }),
    ];
    const text = stripAnsi(formatUnifiedProgress(items, 80));
    expect(text).toContain("▸ 1 implementing");
    expect(text).toContain("1 item");
    // Singular "item" not "items"
    expect(text).not.toContain("1 items");
  });

  it("shows queued items", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "implementing" }),
      makeStatusItem({ id: "A-3", state: "queued" }),
      makeStatusItem({ id: "A-4", state: "queued" }),
    ];
    const text = stripAnsi(formatUnifiedProgress(items, 100));
    expect(text).toContain("✓ 1 merged");
    expect(text).toContain("▸ 1 implementing");
    expect(text).toContain("· 2 queued");
    expect(text).toContain("4 items");
  });

  it("right-aligns total count at end of line", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing" }),
    ];
    const text = stripAnsi(formatUnifiedProgress(items, 80));
    // Total count should be at the right edge
    expect(text.trimEnd()).toMatch(/1 item$/);
  });

  it("handles narrow terminal gracefully", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "merged" }),
      makeStatusItem({ id: "A-2", state: "implementing" }),
    ];
    // Very narrow -- should still contain the data
    const text = stripAnsi(formatUnifiedProgress(items, 30));
    expect(text).toContain("merged");
    expect(text).toContain("implementing");
    expect(text).toContain("2 items");
  });
});

describe("formatTitleMetrics", () => {
  it("shows plain title when no metrics available", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const text = stripAnsi(formatTitleMetrics(items, 80));
    expect(text).toBe("ninthwave status");
  });

  it("shows right-aligned Lead/Thru/Session when metrics available", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 600_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    const termWidth = 120;
    const text = stripAnsi(formatTitleMetrics(items, termWidth, new Date(now - 3_600_000).toISOString()));
    expect(text).toContain("ninthwave status");
    expect(text).toContain("Lead:");
    expect(text).toContain("Thru:");
    expect(text).toContain("Session:");
    // Output must never fill termWidth exactly -- leave 1 char safety margin
    expect(text.length).toBeLessThanOrEqual(termWidth - 1);
  });

  it("falls back to plain title when terminal is too narrow (< 60)", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 600_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    const text = stripAnsi(formatTitleMetrics(items, 50, new Date(now - 3_600_000).toISOString()));
    expect(text).toBe("ninthwave status");
    expect(text).not.toContain("Lead:");
  });

  it("falls back to plain title when terminal width insufficient for gap", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 600_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    // Width of 60 -- right at the threshold, should still show metrics if they fit
    const text60 = stripAnsi(formatTitleMetrics(items, 60, new Date(now - 3_600_000).toISOString()));
    expect(text60).toContain("ninthwave status");
  });

  it("shows only Lead when throughput is null (no sessionStartedAt)", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 600_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    // No sessionStartedAt → throughput and session duration are null
    const text = stripAnsi(formatTitleMetrics(items, 80));
    expect(text).toContain("ninthwave status");
    expect(text).toContain("Lead:");
    expect(text).not.toContain("Thru:");
    expect(text).not.toContain("Session:");
  });

  it("shows Session duration in minutes when session is available", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 2_700_000).toISOString(), // 45m ago
        endedAt: new Date(now - 2_400_000).toISOString(),   // 40m ago
      }),
    ];
    // Session started 12 minutes ago
    const text = stripAnsi(formatTitleMetrics(items, 120, new Date(now - 720_000).toISOString()));
    expect(text).toContain("Session: 12m");
  });

  it("shows Session alongside Lead and Thru (e.g., Lead: 45s  Thru: 8.2/hr  Session: 12m)", () => {
    const now = Date.now();
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 50_000).toISOString(),
        endedAt: new Date(now - 5_000).toISOString(),
      }),
    ];
    const sessionStart = new Date(now - 720_000).toISOString(); // 12m ago
    const text = stripAnsi(formatTitleMetrics(items, 120, sessionStart));
    // All three metrics should appear on the same line
    expect(text).toMatch(/Lead:.*Thru:.*Session:/);
  });

  it("shows full metrics including unit suffix at exact boundary width", () => {
    const now = Date.now();
    // Use longer durations to produce metrics string > 40 chars (so minWidth > 60)
    // Lead: 2h 25m requires endedAt - startedAt = 8_700_000ms
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 9_000_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    // Session: 1h 30m
    const sessionStart = new Date(now - 5_400_000).toISOString();

    const plainTitle = "ninthwave status";
    // Get the actual metrics string at a wide width
    const wideText = stripAnsi(formatTitleMetrics(items, 200, sessionStart));
    const metricsStr = wideText.trimEnd().slice(wideText.trimEnd().lastIndexOf("Lead:"));

    // termWidth exactly at minWidth = titlePlain.length + 4 (min gap) + metricsStr.length
    const minWidth = plainTitle.length + 4 + metricsStr.length;
    expect(minWidth).toBeGreaterThanOrEqual(60); // sanity check

    const text = stripAnsi(formatTitleMetrics(items, minWidth, sessionStart));
    // Full metrics string including unit suffix must be present
    expect(text).toContain(metricsStr);
    // Session duration must have its unit suffix (e.g., "1h 30m" not "1h 30")
    expect(text).toMatch(/Session: \d+h \d+m/);
    // Output stays within safety margin -- never fills termWidth exactly
    expect(text.length).toBeLessThanOrEqual(minWidth - 1);
  });

  it("falls back to plain title when termWidth is too narrow for metrics with gap", () => {
    const now = Date.now();
    // Use longer durations so minWidth > 60 (otherwise < 60 check triggers first)
    const items = [
      makeStatusItem({
        id: "A-1",
        state: "merged",
        startedAt: new Date(now - 9_000_000).toISOString(),
        endedAt: new Date(now - 300_000).toISOString(),
      }),
    ];
    const sessionStart = new Date(now - 5_400_000).toISOString();

    const plainTitle = "ninthwave status";
    const wideText = stripAnsi(formatTitleMetrics(items, 200, sessionStart));
    const metricsStr = wideText.trimEnd().slice(wideText.trimEnd().lastIndexOf("Lead:"));
    const minWidth = plainTitle.length + 4 + metricsStr.length;

    // Set width 1 below minWidth -- enough for the 60-char threshold but not for the gap
    const tooNarrow = minWidth - 1;
    expect(tooNarrow).toBeGreaterThanOrEqual(60); // sanity: not hitting the < 60 fallback

    const text = stripAnsi(formatTitleMetrics(items, tooNarrow, sessionStart));
    // Should gracefully fall back to plain title without metrics
    expect(text).toBe("ninthwave status");
    expect(text).not.toContain("Lead:");
  });
});

describe("MIN_FULLSCREEN_ROWS", () => {
  it("is 10", () => {
    expect(MIN_FULLSCREEN_ROWS).toBe(10);
  });
});

describe("small terminal fallback", () => {
  it("buildStatusLayout produces valid output for any terminal size", () => {
    const items = [
      makeStatusItem({ id: "A-1", state: "implementing" }),
    ];
    // Even with very small width, should not crash
    const layout = buildStatusLayout(items, 30);
    expect(layout.headerLines.length).toBeGreaterThan(0);
    expect(layout.itemLines.length).toBeGreaterThan(0);
    expect(layout.footerLines.length).toBeGreaterThan(0);
  });

  it("renderFullScreenFrame handles very small viewport gracefully", () => {
    const layout: FrameLayout = {
      headerLines: ["H"],
      itemLines: ["I1", "I2", "I3"],
      footerLines: ["F"],
    };
    // Only 4 rows total -- barely enough for header + footer + 1 item
    const frame = renderFullScreenFrame(layout, 4, 40, 0);
    // Should not crash and should contain header/footer
    expect(frame.join("\n")).toContain("H");
    expect(frame.join("\n")).toContain("F");
  });
});

// ── Crew mode TUI tests ──────────────────────────────────────────────

describe("crew mode TUI rendering", () => {
  it("formatCrewStatusPanel shows connected crew status", () => {
    const output = formatCrewStatusPanel({
      crewCode: "A7K-M2P",
      daemonCount: 2,
      availableCount: 3,
      claimedCount: 5,
      completedCount: 2,
      connected: true,
    });
    const text = stripAnsi(output);
    expect(text).toContain("Crew: A7K-M2P");
    expect(text).toContain("Daemons: 2");
    expect(text).toContain("Avail: 3");
    expect(text).toContain("Claimed: 5");
    expect(text).toContain("Done: 2");
  });

  it("formatCrewStatusPanel shows OFFLINE when disconnected", () => {
    const output = formatCrewStatusPanel({
      crewCode: "A7K-M2P",
      daemonCount: 0,
      availableCount: 0,
      claimedCount: 0,
      completedCount: 0,
      connected: false,
    });
    const text = stripAnsi(output);
    expect(text).toContain("OFFLINE");
    expect(text).toContain("reconnecting");
  });

  it("formatStatusTable includes crew status panel when crewStatus is set", () => {
    const items: StatusItem[] = [
      { ...makeStatusItem(), daemonName: "laptop" },
    ];
    const output = formatStatusTable(items, 120, undefined, false, {
      crewStatus: {
        crewCode: "X1Y-Z2W",
        daemonCount: 1,
        availableCount: 0,
        claimedCount: 1,
        completedCount: 0,
        connected: true,
      },
    });
    const text = stripAnsi(output);
    expect(text).toContain("Crew: X1Y-Z2W");
    expect(text).toContain("DAEMON");
    expect(text).toContain("laptop");
  });

  it("formatStatusTable shows DAEMON column with correct values", () => {
    const items: StatusItem[] = [
      { ...makeStatusItem({ id: "T-1", state: "implementing" }), daemonName: "mac-1" },
      { ...makeStatusItem({ id: "T-2", state: "queued" }), daemonName: "--" },
    ];
    const output = formatStatusTable(items, 120, 5, false, {
      crewStatus: {
        crewCode: "ABC-DEF",
        daemonCount: 2,
        availableCount: 1,
        claimedCount: 1,
        completedCount: 0,
        connected: true,
      },
    });
    const text = stripAnsi(output);
    expect(text).toContain("mac-1");
    expect(text).toContain("--");
  });

  it("buildStatusLayout includes crew status in header", () => {
    const items: StatusItem[] = [makeStatusItem()];
    const layout = buildStatusLayout(items, 100, undefined, false, {
      crewStatus: {
        crewCode: "ABC-DEF",
        daemonCount: 2,
        availableCount: 3,
        claimedCount: 1,
        completedCount: 0,
        connected: true,
      },
    });
    const headerText = stripAnsi(layout.headerLines.join("\n"));
    expect(headerText).toContain("Crew: ABC-DEF");
    expect(headerText).toContain("DAEMON");
  });
});

// ── Help overlay ──────────────────────────────────────────────────────────────

describe("renderHelpOverlay", () => {
  it("returns expected number of lines matching termRows", () => {
    const lines = renderHelpOverlay(80, 30);
    expect(lines.length).toBe(30);
  });

  it("box-drawing characters are correct (top-left, top-right, bottom-left, bottom-right)", () => {
    const lines = renderHelpOverlay(80, 30);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const plain = nonEmpty.map(stripAnsi);
    // First non-empty line should be the top border
    expect(plain[0]).toMatch(/┌─+┐/);
    // Last non-empty line should be the bottom border
    expect(plain[plain.length - 1]).toMatch(/└─+┘/);
  });

  it("content fits within termWidth", () => {
    const termWidth = 60;
    const lines = renderHelpOverlay(termWidth, 30);
    for (const line of lines) {
      const displayLen = stripAnsi(line).length;
      expect(displayLen).toBeLessThanOrEqual(termWidth);
    }
  });

  it("contains key help sections", () => {
    const lines = renderHelpOverlay(100, 40);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("Metrics");
    expect(text).toContain("Lead time");
    expect(text).toContain("Throughput");
    expect(text).toContain("Session");
    expect(text).toContain("Merge Strategies");
    expect(text).toContain("auto");
    expect(text).toContain("manual");
    expect(text).toContain("bypass");
    expect(text).toContain("Keyboard Shortcuts");
    expect(text).toContain("Shift+Tab");
    expect(text).toContain("ninthwave");
    expect(text).toContain("Apache-2.0");
    expect(text).toContain("ninthwave.dev");
  });

  it("strategy section uses strategyIndicator icons", () => {
    const lines = renderHelpOverlay(100, 40);
    const text = stripAnsi(lines.join("\n"));
    // strategyIndicator uses these icons
    expect(text).toMatch(/›.*auto/);
    expect(text).toMatch(/‖.*manual/);
    expect(text).toMatch(/».*bypass/);
  });

  it("documents all keyboard shortcuts removed from footer in H-TUI-4", () => {
    const lines = renderHelpOverlay(100, 40);
    const text = stripAnsi(lines.join("\n"));
    // These shortcuts were previously in the footer before H-TUI-4:
    expect(text).toContain("q");        // quit
    expect(text).toContain("d");        // deps toggle
    expect(text).toContain("Up/Down");  // scroll
    expect(text).toContain("Ctrl+C");   // double-tap quit
    expect(text).toContain("Escape");   // dismiss help
    expect(text).toContain("?");        // toggle help
  });

  it("help content is ASCII-only except strategy icons", () => {
    const lines = renderHelpOverlay(100, 40);
    const text = stripAnsi(lines.join("\n"));
    // Remove the three known strategy icon chars and box-drawing chars
    const cleaned = text.replace(/[›‖»┌┐└┘─│]/g, "");
    // All remaining chars should be ASCII (0x00–0x7F)
    for (const ch of cleaned) {
      expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x7F);
    }
  });
});

// ── renderTuiFrame with showHelp ──────────────────────────────────────────────

describe("renderTuiFrame with showHelp", () => {
  function makeOrchestratorItem(overrides: Partial<OrchestratorItem> = {}): OrchestratorItem {
    return {
      id: "T-1",
      workItem: { id: "T-1", title: "Test item", priority: "medium", source: "test", domain: "test", affectedFiles: [] } as WorkItem,
      state: "implementing",
      prNumber: null,
      lastTransition: new Date().toISOString(),
      failureReason: undefined,
      worktreeCreated: true,
      resolvedRepoRoot: "/test",
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      exitCode: null,
      stderrTail: undefined,
      reviewCycleStartedAt: undefined,
      ciRetries: 0,
      lastReviewPollCursor: undefined,
      workspaceRef: undefined,
      ...overrides,
    } as OrchestratorItem;
  }

  it("renders help overlay when showHelp is true", () => {
    const chunks: string[] = [];
    const write = (s: string) => chunks.push(s);
    const items = [makeOrchestratorItem()];

    renderTuiFrame(items, 5, write, { showHelp: true }, 0);

    const output = chunks.join("");
    const text = stripAnsi(output);
    expect(text).toContain("Help");
    expect(text).toContain("Keyboard Shortcuts");
    // Should NOT contain normal status table content
    expect(text).not.toContain("ninthwave status");
  });

  it("renders normal frame when showHelp is false", () => {
    const chunks: string[] = [];
    const write = (s: string) => chunks.push(s);
    const items = [makeOrchestratorItem()];

    renderTuiFrame(items, 5, write, { showHelp: false }, 0);

    const output = chunks.join("");
    const text = stripAnsi(output);
    expect(text).toContain("ninthwave status");
  });
});

// ── Panel layout infrastructure (H-UT-2) ────────────────────────────────────

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    itemId: "T-1",
    message: "Test log message",
    ...overrides,
  };
}

function makeLogEntries(count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeLogEntry({ itemId: `T-${i}`, message: `Log entry ${i}` }),
  );
}

describe("MIN_SPLIT_ROWS", () => {
  it("is 35", () => {
    expect(MIN_SPLIT_ROWS).toBe(35);
  });
});

describe("buildPanelLayout", () => {
  const items = [
    makeStatusItem({ id: "A-1", state: "implementing" }),
    makeStatusItem({ id: "A-2", state: "merged" }),
    makeStatusItem({ id: "A-3", state: "queued" }),
  ];
  const logs = makeLogEntries(10);

  describe("status-only mode", () => {
    it("returns status panel and no log panel at 80x40", () => {
      const layout = buildPanelLayout("status-only", items, logs, 80, 40);
      expect(layout.mode).toBe("status-only");
      expect(layout.statusPanel).not.toBeNull();
      expect(layout.logPanel).toBeNull();
      expect(layout.footerLines.length).toBeGreaterThan(0);
    });

    it("returns status-only at 80x20", () => {
      const layout = buildPanelLayout("status-only", items, logs, 80, 20);
      expect(layout.mode).toBe("status-only");
      expect(layout.statusPanel).not.toBeNull();
      expect(layout.logPanel).toBeNull();
    });

    it("returns status-only at 80x8 (below MIN_FULLSCREEN_ROWS)", () => {
      const layout = buildPanelLayout("status-only", items, logs, 80, 8);
      expect(layout.mode).toBe("status-only");
      expect(layout.statusPanel).not.toBeNull();
      expect(layout.logPanel).toBeNull();
    });
  });

  describe("split mode", () => {
    it("returns split layout at 80x40 (>= MIN_SPLIT_ROWS)", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 40);
      expect(layout.mode).toBe("split");
      expect(layout.statusPanel).not.toBeNull();
      expect(layout.logPanel).not.toBeNull();
      expect(layout.logPanel!.lines.length).toBeGreaterThan(0);
    });

    it("degrades split to status-only at 34 rows (< MIN_SPLIT_ROWS)", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 34);
      expect(layout.mode).toBe("status-only");
      expect(layout.statusPanel).not.toBeNull();
      expect(layout.logPanel).toBeNull();
    });

    it("degrades split to status-only at 20 rows", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 20);
      expect(layout.mode).toBe("status-only");
      expect(layout.logPanel).toBeNull();
    });

    it("degrades split to status-only at 8 rows (below MIN_FULLSCREEN_ROWS)", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 8);
      expect(layout.mode).toBe("status-only");
      expect(layout.logPanel).toBeNull();
    });

    it("split at exactly MIN_SPLIT_ROWS (35) works", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 35);
      expect(layout.mode).toBe("split");
      expect(layout.statusPanel).not.toBeNull();
      expect(layout.logPanel).not.toBeNull();
    });

    it("status panel has no footer in split mode (footer is separate)", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 40);
      expect(layout.statusPanel!.footerLines).toHaveLength(0);
    });

    it("footer lines include separator in split mode", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 40);
      const footerText = layout.footerLines.map(stripAnsi).join("\n");
      // Separator contains "Logs (N)"
      expect(footerText).toContain("Logs (10)");
    });

    it("split gives status ~60% and logs ~40%", () => {
      const layout = buildPanelLayout("split", items, logs, 80, 40);
      // The log panel should have visible lines
      expect(layout.logPanel!.lines.length).toBeGreaterThan(0);
      // Status panel should have items
      expect(layout.statusPanel!.itemLines.length).toBeGreaterThan(0);
    });
  });

  describe("logs-only mode", () => {
    it("returns logs-only at 80x40", () => {
      const layout = buildPanelLayout("logs-only", items, logs, 80, 40);
      expect(layout.mode).toBe("logs-only");
      expect(layout.statusPanel).toBeNull();
      expect(layout.logPanel).not.toBeNull();
      expect(layout.logPanel!.lines.length).toBeGreaterThan(0);
    });

    it("returns logs-only at 80x20", () => {
      const layout = buildPanelLayout("logs-only", items, logs, 80, 20);
      expect(layout.mode).toBe("logs-only");
      expect(layout.statusPanel).toBeNull();
      expect(layout.logPanel).not.toBeNull();
    });

    it("returns status-only at 80x8 (below MIN_FULLSCREEN_ROWS overrides all)", () => {
      const layout = buildPanelLayout("logs-only", items, logs, 80, 8);
      // Below MIN_FULLSCREEN_ROWS, always status-only (legacy flat)
      expect(layout.mode).toBe("status-only");
    });
  });
});

describe("renderPanelFrame", () => {
  const items = [
    makeStatusItem({ id: "A-1", state: "implementing" }),
    makeStatusItem({ id: "A-2", state: "merged" }),
  ];
  const logs = makeLogEntries(20);

  it("status-only frame matches terminal height exactly", () => {
    const layout = buildPanelLayout("status-only", items, logs, 80, 40);
    const frame = renderPanelFrame(layout, 40, 80);
    expect(frame).toHaveLength(40);
  });

  it("split frame matches terminal height exactly", () => {
    const layout = buildPanelLayout("split", items, logs, 80, 40);
    const frame = renderPanelFrame(layout, 40, 80);
    expect(frame).toHaveLength(40);
  });

  it("logs-only frame matches terminal height exactly", () => {
    const layout = buildPanelLayout("logs-only", items, logs, 80, 40);
    const frame = renderPanelFrame(layout, 40, 80);
    expect(frame).toHaveLength(40);
  });

  it("logs-only frame with scroll offset does not exceed terminal height", () => {
    // Regression: scroll indicators were added without reducing viewport,
    // causing output to exceed termRows before padToHeight truncated footer
    const manyLogs = makeLogEntries(100);
    const layout = buildPanelLayout("logs-only", items, manyLogs, 80, 40, {
      logScrollOffset: 5,
    });
    const frame = renderPanelFrame(layout, 40, 80);
    expect(frame).toHaveLength(40);
    // Footer should not be truncated -- last non-empty lines should contain progress/shortcuts
    const nonEmpty = frame.filter(l => l.trim() !== "");
    const lastNonEmpty = stripAnsi(nonEmpty[nonEmpty.length - 1]!);
    // Footer should contain shortcuts or progress, not a scroll indicator or log line
    expect(
      lastNonEmpty.includes("quit") ||
      lastNonEmpty.includes("scroll") ||
      lastNonEmpty.includes("items") ||
      lastNonEmpty.includes("shift+tab"),
    ).toBe(true);
  });

  it("split frame at exactly MIN_SPLIT_ROWS matches height", () => {
    const layout = buildPanelLayout("split", items, logs, 80, 35);
    const frame = renderPanelFrame(layout, 35, 80);
    expect(frame).toHaveLength(35);
  });

  it("status-only frame at 20 rows matches height", () => {
    const layout = buildPanelLayout("status-only", items, logs, 80, 20);
    const frame = renderPanelFrame(layout, 20, 80);
    expect(frame).toHaveLength(20);
  });

  it("logs-only frame at 20 rows matches height", () => {
    const layout = buildPanelLayout("logs-only", items, logs, 80, 20);
    const frame = renderPanelFrame(layout, 20, 80);
    expect(frame).toHaveLength(20);
  });

  it("frame at 8 rows (below MIN_FULLSCREEN_ROWS) matches height", () => {
    const layout = buildPanelLayout("split", items, logs, 80, 8);
    const frame = renderPanelFrame(layout, 8, 80);
    expect(frame).toHaveLength(8);
  });
});

describe("panel separator formatting", () => {
  it("shows log count in separator", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const logs = makeLogEntries(42);
    const layout = buildPanelLayout("split", items, logs, 80, 40);
    const allText = layout.footerLines.map(stripAnsi).join("\n");
    expect(allText).toContain("Logs (42)");
  });

  it("shows shortcut hints in separator", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const logs = makeLogEntries(5);
    const layout = buildPanelLayout("split", items, logs, 80, 40);
    const allText = layout.footerLines.map(stripAnsi).join("\n");
    expect(allText).toContain("tab: switch");
    expect(allText).toContain("scroll");
  });

  it("shows zero logs in separator when no entries", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const layout = buildPanelLayout("split", items, [], 80, 40);
    const allText = layout.footerLines.map(stripAnsi).join("\n");
    expect(allText).toContain("Logs (0)");
  });

  it("handles large log counts", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const logs = makeLogEntries(1234);
    const layout = buildPanelLayout("split", items, logs, 80, 40);
    const allText = layout.footerLines.map(stripAnsi).join("\n");
    expect(allText).toContain("Logs (1234)");
  });
});

describe("scroll indicators in panel frames", () => {
  it("status panel shows scroll indicators when items overflow", () => {
    const manyItems = Array.from({ length: 30 }, (_, i) =>
      makeStatusItem({ id: `I-${i}`, state: "implementing" }),
    );
    const logs = makeLogEntries(5);
    const layout = buildPanelLayout("split", manyItems, logs, 80, 40);
    const frame = renderPanelFrame(layout, 40, 80, 0);
    const text = frame.map(stripAnsi).join("\n");
    // With 30 items in the status panel (60% of ~40 rows = ~20 rows for header+items),
    // there should be a scroll-down indicator
    expect(text).toContain("more below");
  });

  it("log panel shows scroll indicators when logs overflow", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const manyLogs = makeLogEntries(100);
    const layout = buildPanelLayout("split", items, manyLogs, 80, 40, {
      logScrollOffset: 5,
    });
    const frame = renderPanelFrame(layout, 40, 80);
    const text = frame.map(stripAnsi).join("\n");
    // With 100 logs and offset 5, should show both scroll indicators
    expect(text).toContain("more above");
  });

  it("no scroll indicators when content fits", () => {
    const items = [makeStatusItem({ id: "A-1", state: "implementing" })];
    const fewLogs = makeLogEntries(2);
    const layout = buildPanelLayout("split", items, fewLogs, 80, 40);
    const frame = renderPanelFrame(layout, 40, 80);
    const text = frame.map(stripAnsi).join("\n");
    // Few items and few logs should have no overflow
    // (status panel might not overflow with just 1 item)
    // Check the log section specifically -- 2 logs should fit
    const logSection = frame.slice(frame.findIndex(l => stripAnsi(l).includes("Logs")));
    const logText = logSection.map(stripAnsi).join("\n");
    expect(logText).not.toContain("more above");
  });
});

describe("formatItemDetail", () => {
  it("renders implementing state with all fields", () => {
    const item = makeStatusItem({
      id: "H-UT-2",
      title: "Panel layout infrastructure",
      state: "implementing",
      prNumber: 42,
      startedAt: new Date(Date.now() - 300_000).toISOString(),
    });
    const lines = formatItemDetail(item, {
      repoUrl: "https://github.com/org/repo",
      progressLabel: "Writing tests",
      tokensIn: 45000,
      tokensOut: 12000,
    });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("H-UT-2");
    expect(text).toContain("Panel layout infrastructure");
    expect(text).toContain("Implementing");
    expect(text).toContain("#42");
    expect(text).toContain("Writing tests");
    expect(text).toContain("45,000 in");
    expect(text).toContain("12,000 out");
    expect(text).toContain("Duration:");
  });

  it("renders ci-failed state with failure reason", () => {
    const item = makeStatusItem({
      id: "H-CI-1",
      title: "Fix CI",
      state: "ci-failed",
      prNumber: 100,
      failureReason: "Tests timed out",
      stderrTail: "Error: timeout after 30s\n",
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("CI Failed");
    expect(text).toContain("Tests timed out");
    expect(text).toContain("timeout after 30s");
  });

  it("renders merged state", () => {
    const item = makeStatusItem({
      id: "H-MG-1",
      title: "Feature done",
      state: "merged",
      prNumber: 200,
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      endedAt: new Date(Date.now() - 300_000).toISOString(),
    });
    const lines = formatItemDetail(item, {
      repoUrl: "https://github.com/org/repo",
    });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Merged");
    expect(text).toContain("#200");
    expect(text).toContain("Passed");
  });

  it("renders stuck (ci-failed) state", () => {
    const item = makeStatusItem({
      id: "H-ST-1",
      title: "Stuck item",
      state: "ci-failed",
      failureReason: "Max retries exceeded",
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("CI Failed");
    expect(text).toContain("Max retries exceeded");
  });

  it("renders without PR number", () => {
    const item = makeStatusItem({
      id: "H-NP-1",
      title: "No PR yet",
      state: "implementing",
      prNumber: null,
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("--");
    expect(text).not.toContain("#");
  });

  it("renders PR as OSC 8 clickable link when repoUrl provided", () => {
    const item = makeStatusItem({
      id: "H-LK-1",
      title: "Linked PR",
      state: "review",
      prNumber: 55,
    });
    const lines = formatItemDetail(item, {
      repoUrl: "https://github.com/org/repo",
    });
    const raw = lines.join("");
    // OSC 8 sequence should be present
    expect(raw).toContain("\x1b]8;;https://github.com/org/repo/pull/55\x07");
  });

  it("renders with missing optional fields", () => {
    const item = makeStatusItem({
      id: "H-MN-1",
      title: "Minimal item",
      state: "queued",
      prNumber: null,
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("H-MN-1");
    expect(text).toContain("Minimal item");
    // No crash, renders cleanly
    expect(lines.length).toBeGreaterThan(2);
  });

  it("renders ci-pending state", () => {
    const item = makeStatusItem({
      id: "H-CP-1",
      title: "CI pending",
      state: "ci-pending",
      prNumber: 77,
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("CI Pending");
    expect(text).toContain("Pending");
  });

  it("renders without cost when tokens not provided", () => {
    const item = makeStatusItem({ id: "H-NC-1", state: "implementing" });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("Cost:");
  });
});

// ── Item detail panel integration with buildPanelLayout ─────────────────────

describe("buildPanelLayout with detailLines", () => {
  it("replaces log panel with detail lines in split mode", () => {
    const items = [
      makeStatusItem({ id: "H-1", state: "implementing" }),
      makeStatusItem({ id: "H-2", state: "ci-pending" }),
    ];
    const logEntries: LogEntry[] = [
      { timestamp: "2026-03-28T10:00:00Z", itemId: "H-1", message: "Starting" },
    ];
    const detailLines = [
      "  H-1  Panel layout",
      "",
      "  State: Implementing",
      "  PR:    --",
    ];
    const layout = buildPanelLayout("split", items, logEntries, 80, 50, {
      detailLines,
    });
    expect(layout.mode).toBe("split");
    expect(layout.logPanel).not.toBeNull();
    // Detail lines should appear in the log panel slot
    expect(layout.logPanel!.lines.some((l) => stripAnsi(l).includes("H-1"))).toBe(true);
    // Log entries should NOT appear (replaced by detail)
    const allText = layout.logPanel!.lines.map(stripAnsi).join("\n");
    expect(allText).not.toContain("Starting");
  });

  it("shows separator with 'Detail' label when detailLines provided", () => {
    const items = [makeStatusItem({ id: "H-1", state: "implementing" })];
    const layout = buildPanelLayout("split", items, [], 80, 50, {
      detailLines: ["  Detail content"],
    });
    const allFooter = layout.footerLines.map(stripAnsi).join("\n");
    expect(allFooter).toContain("Detail");
    expect(allFooter).toContain("esc: back");
  });

  it("shows log separator when no detailLines", () => {
    const items = [makeStatusItem({ id: "H-1", state: "implementing" })];
    const logEntries: LogEntry[] = [
      { timestamp: "2026-03-28T10:00:00Z", itemId: "H-1", message: "Log msg" },
    ];
    const layout = buildPanelLayout("split", items, logEntries, 80, 50);
    const allFooter = layout.footerLines.map(stripAnsi).join("\n");
    expect(allFooter).toContain("Logs");
    expect(allFooter).not.toContain("Detail");
  });

  it("does not show detail in logs-only mode", () => {
    const items = [makeStatusItem({ id: "H-1", state: "implementing" })];
    const logEntries: LogEntry[] = [
      { timestamp: "2026-03-28T10:00:00Z", itemId: "H-1", message: "Log msg" },
    ];
    const layout = buildPanelLayout("logs-only", items, logEntries, 80, 50, {
      detailLines: ["  Should not appear"],
    });
    expect(layout.mode).toBe("logs-only");
    // Log panel should show logs, not detail
    const panelText = layout.logPanel!.lines.map(stripAnsi).join("\n");
    expect(panelText).toContain("Log msg");
  });

  it("truncates detail lines to fit available rows", () => {
    const items = [makeStatusItem({ id: "H-1", state: "implementing" })];
    // Generate many detail lines
    const detailLines = Array.from({ length: 50 }, (_, i) => `  Line ${i}`);
    const layout = buildPanelLayout("split", items, [], 80, 40, {
      detailLines,
    });
    // Log panel lines should be fewer than total detail lines
    expect(layout.logPanel!.lines.length).toBeLessThan(50);
  });
});

describe("formatItemDetail for each item state", () => {
  it("renders implementing state", () => {
    const item = makeStatusItem({ id: "H-I-1", state: "implementing", prNumber: 10 });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Implementing");
    expect(text).toContain("#10");
  });

  it("renders ci-failed state", () => {
    const item = makeStatusItem({
      id: "H-CF-1",
      state: "ci-failed",
      failureReason: "test timeout",
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("CI Failed");
    expect(text).toContain("test timeout");
  });

  it("renders merged state", () => {
    const item = makeStatusItem({ id: "H-M-1", state: "merged", prNumber: 50 });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Merged");
    expect(text).toContain("Passed");
  });

  it("renders queued state", () => {
    const item = makeStatusItem({ id: "H-Q-1", state: "queued", prNumber: null });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Queued");
    expect(text).toContain("--"); // No PR
  });

  it("renders ci-pending state", () => {
    const item = makeStatusItem({ id: "H-CP-1", state: "ci-pending", prNumber: 77 });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("CI Pending");
    expect(text).toContain("Pending");
  });

  it("renders missing optional fields as --", () => {
    const item = makeStatusItem({
      id: "H-MF-1",
      state: "implementing",
      prNumber: null,
    });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("--"); // No PR
    expect(text).not.toContain("Cost:");
    expect(text).not.toContain("Progress:");
  });

  it("renders PR as clickable OSC 8 link when repoUrl provided", () => {
    const item = makeStatusItem({ id: "H-LNK-1", state: "review", prNumber: 99 });
    const lines = formatItemDetail(item, {
      repoUrl: "https://github.com/org/repo",
    });
    const raw = lines.join("");
    expect(raw).toContain("\x1b]8;;https://github.com/org/repo/pull/99\x07");
    expect(raw).toContain("#99");
  });

  it("renders without PR link when no repoUrl and no PR", () => {
    const item = makeStatusItem({ id: "H-NL-1", state: "implementing", prNumber: null });
    const lines = formatItemDetail(item);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("--");
    expect(text).not.toContain("\x1b]8;;");
  });
});
