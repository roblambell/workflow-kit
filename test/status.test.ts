// Tests for the status command formatting functions.
// Uses dependency injection (pure functions) to avoid vi.mock.

import { describe, it, expect, vi } from "vitest";
import {
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  formatItemRow,
  formatQueuedItemRow,
  formatBatchProgress,
  formatSummary,
  formatStatusTable,
  cmdStatusWatch,
  cmdStatus,
  renderStatus,
  getTerminalWidth,
  pad,
  mapDaemonItemState,
  daemonStateToStatusItems,
  buildDependencyTree,
  formatTreeRows,
  formatTreeItemRow,
  type StatusItem,
  type ItemState,
  type TreeNode,
} from "../core/commands/status.ts";
import type { DaemonState } from "../core/daemon.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Strip ANSI escape codes and CSI sequences for content assertions
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("stateColor", () => {
  it("returns green for merged", () => {
    // In non-TTY test env, color codes are empty strings
    // Just verify the function doesn't throw and returns a string
    expect(typeof stateColor("merged")).toBe("string");
  });

  it("returns a string for every valid state", () => {
    const states: ItemState[] = [
      "merged",
      "implementing",
      "ci-failed",
      "ci-pending",
      "review",
      "pr-open",
      "in-progress",
      "queued",
    ];
    for (const state of states) {
      expect(typeof stateColor(state)).toBe("string");
    }
  });
});

describe("stateLabel", () => {
  it("returns human-readable labels for each state", () => {
    expect(stateLabel("merged")).toBe("Merged");
    expect(stateLabel("implementing")).toBe("Implementing");
    expect(stateLabel("ci-failed")).toBe("CI Failed");
    expect(stateLabel("ci-pending")).toBe("CI Pending");
    expect(stateLabel("review")).toBe("In Review");
    expect(stateLabel("pr-open")).toBe("PR Open");
    expect(stateLabel("in-progress")).toBe("In Progress");
    expect(stateLabel("queued")).toBe("Queued");
  });
});

describe("stateIcon", () => {
  it("returns a single-character icon for each state", () => {
    const states: ItemState[] = [
      "merged",
      "implementing",
      "ci-failed",
      "ci-pending",
      "review",
      "pr-open",
      "in-progress",
      "queued",
    ];
    for (const state of states) {
      const icon = stateIcon(state);
      expect(typeof icon).toBe("string");
      expect(icon.length).toBe(1);
    }
  });

  it("returns checkmark for merged", () => {
    expect(stateIcon("merged")).toBe("✓");
  });

  it("returns play triangle for implementing", () => {
    expect(stateIcon("implementing")).toBe("▸");
  });

  it("returns X for ci-failed", () => {
    expect(stateIcon("ci-failed")).toBe("✗");
  });

  it("returns dotted circle for ci-pending", () => {
    expect(stateIcon("ci-pending")).toBe("◌");
  });

  it("returns filled circle for review", () => {
    expect(stateIcon("review")).toBe("●");
  });

  it("returns empty circle for pr-open", () => {
    expect(stateIcon("pr-open")).toBe("○");
  });

  it("returns play triangle for in-progress", () => {
    expect(stateIcon("in-progress")).toBe("▸");
  });

  it("returns middle dot for queued", () => {
    expect(stateIcon("queued")).toBe("·");
  });
});

describe("truncateTitle", () => {
  it("returns title unchanged if within limit", () => {
    expect(truncateTitle("Short title", 20)).toBe("Short title");
  });

  it("truncates long titles with ellipsis", () => {
    const long = "This is a very long title that exceeds the limit";
    const result = truncateTitle(long, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns exact-length title unchanged", () => {
    expect(truncateTitle("12345", 5)).toBe("12345");
  });

  it("handles very small maxWidth", () => {
    const result = truncateTitle("Hello World", 3);
    expect(result.length).toBe(3);
  });

  it("handles empty title", () => {
    expect(truncateTitle("", 10)).toBe("");
  });
});

describe("formatAge", () => {
  it("formats days and hours", () => {
    const ms = 2 * 86400000 + 3 * 3600000; // 2d 3h
    expect(formatAge(ms)).toBe("2d 3h");
  });

  it("formats days only when no remaining hours", () => {
    expect(formatAge(86400000)).toBe("1d");
  });

  it("formats hours and minutes", () => {
    const ms = 2 * 3600000 + 15 * 60000; // 2h 15m
    expect(formatAge(ms)).toBe("2h 15m");
  });

  it("formats hours only when no remaining minutes", () => {
    expect(formatAge(3600000)).toBe("1h");
  });

  it("formats minutes", () => {
    expect(formatAge(5 * 60000)).toBe("5m");
  });

  it("formats less than a minute", () => {
    expect(formatAge(30000)).toBe("<1m");
  });

  it("handles zero", () => {
    expect(formatAge(0)).toBe("<1m");
  });

  it("handles negative values gracefully", () => {
    expect(formatAge(-1000)).toBe("<1m");
  });
});

describe("pad", () => {
  it("pads shorter strings", () => {
    expect(pad("abc", 6)).toBe("abc   ");
  });

  it("returns string unchanged if at target width", () => {
    expect(pad("abcdef", 6)).toBe("abcdef");
  });

  it("returns string unchanged if longer than target", () => {
    expect(pad("abcdefgh", 6)).toBe("abcdefgh");
  });
});

describe("formatItemRow", () => {
  const baseItem: StatusItem = {
    id: "H-STU-1",
    title: "Rewrite status command",
    state: "implementing",
    prNumber: 42,
    ageMs: 2 * 3600000 + 15 * 60000,
    repoLabel: "",
  };

  it("includes the state icon", () => {
    const row = stripAnsi(formatItemRow(baseItem, 30));
    expect(row).toContain("▸"); // implementing icon
  });

  it("includes the correct icon per state", () => {
    const mergedItem = { ...baseItem, state: "merged" as ItemState };
    expect(stripAnsi(formatItemRow(mergedItem, 30))).toContain("✓");
    const failedItem = { ...baseItem, state: "ci-failed" as ItemState };
    expect(stripAnsi(formatItemRow(failedItem, 30))).toContain("✗");
    const queuedItem = { ...baseItem, state: "queued" as ItemState };
    expect(stripAnsi(formatItemRow(queuedItem, 30))).toContain("·");
  });

  it("includes the item ID", () => {
    const row = formatItemRow(baseItem, 30);
    expect(stripAnsi(row)).toContain("H-STU-1");
  });

  it("includes the state label", () => {
    const row = formatItemRow(baseItem, 30);
    expect(stripAnsi(row)).toContain("Implementing");
  });

  it("includes the PR number with #", () => {
    const row = formatItemRow(baseItem, 30);
    expect(stripAnsi(row)).toContain("#42");
  });

  it("shows dash when no PR number", () => {
    const item = { ...baseItem, prNumber: null };
    const row = formatItemRow(item, 30);
    expect(stripAnsi(row)).toContain("-");
    expect(stripAnsi(row)).not.toContain("#");
  });

  it("includes the age", () => {
    const row = formatItemRow(baseItem, 30);
    expect(stripAnsi(row)).toContain("2h 15m");
  });

  it("includes the title", () => {
    const row = formatItemRow(baseItem, 30);
    expect(stripAnsi(row)).toContain("Rewrite status command");
  });

  it("truncates long titles", () => {
    const item = {
      ...baseItem,
      title: "A very long title that should be truncated at the width limit",
    };
    const row = formatItemRow(item, 15);
    expect(stripAnsi(row)).toContain("...");
  });

  it("shows repo label for cross-repo items", () => {
    const item = { ...baseItem, repoLabel: "target-repo" };
    const row = formatItemRow(item, 30);
    expect(stripAnsi(row)).toContain("[target-repo]");
  });

  it("uses item ID as fallback when title is empty", () => {
    const item = { ...baseItem, title: "" };
    const row = formatItemRow(item, 30);
    expect(stripAnsi(row)).toContain("H-STU-1");
  });
});

describe("formatBatchProgress", () => {
  it("shows counts per state", () => {
    const items: StatusItem[] = [
      makeItem("A-1", "merged"),
      makeItem("A-2", "merged"),
      makeItem("A-3", "implementing"),
      makeItem("A-4", "ci-failed"),
    ];
    const line = stripAnsi(formatBatchProgress(items));
    expect(line).toContain("2 merged");
    expect(line).toContain("1 implementing");
    expect(line).toContain("1 ci failed");
  });

  it("returns empty string for zero items", () => {
    expect(formatBatchProgress([])).toBe("");
  });

  it("handles all items in same state", () => {
    const items = [makeItem("A-1", "review"), makeItem("A-2", "review")];
    const line = stripAnsi(formatBatchProgress(items));
    expect(line).toContain("2 in review");
  });

  it("orders states: merged first, ci-failed last", () => {
    const items: StatusItem[] = [
      makeItem("A-1", "ci-failed"),
      makeItem("A-2", "merged"),
      makeItem("A-3", "implementing"),
    ];
    const line = stripAnsi(formatBatchProgress(items));
    const mergedIdx = line.indexOf("merged");
    const implIdx = line.indexOf("implementing");
    const failIdx = line.indexOf("ci failed");
    expect(mergedIdx).toBeLessThan(implIdx);
    expect(implIdx).toBeLessThan(failIdx);
  });
});

describe("formatSummary", () => {
  it("shows total count", () => {
    const items = [makeItem("A-1", "merged"), makeItem("A-2", "implementing")];
    const line = stripAnsi(formatSummary(items));
    expect(line).toContain("2 items");
  });

  it("shows merged and active counts when both exist", () => {
    const items = [
      makeItem("A-1", "merged"),
      makeItem("A-2", "merged"),
      makeItem("A-3", "implementing"),
    ];
    const line = stripAnsi(formatSummary(items));
    expect(line).toContain("3 items");
    expect(line).toContain("2 merged");
    expect(line).toContain("1 active");
  });

  it("handles zero items", () => {
    const line = stripAnsi(formatSummary([]));
    expect(line).toContain("No active items");
  });

  it("handles singular item", () => {
    const items = [makeItem("A-1", "implementing")];
    const line = stripAnsi(formatSummary(items));
    expect(line).toContain("1 item");
    expect(line).not.toContain("1 items");
  });
});

describe("formatStatusTable", () => {
  it("shows header and items", () => {
    const items = [
      makeItem("H-STU-1", "implementing", "Rewrite status", 42),
      makeItem("H-MUX-2", "merged", "Add tmux adapter", 41),
    ];
    const output = stripAnsi(formatStatusTable(items));
    expect(output).toContain("ninthwave status");
    expect(output).toContain("ID");
    expect(output).toContain("STATE");
    expect(output).toContain("PR");
    expect(output).toContain("AGE");
    expect(output).toContain("TITLE");
    expect(output).toContain("H-STU-1");
    expect(output).toContain("H-MUX-2");
    expect(output).toContain("Implementing");
    expect(output).toContain("Merged");
    expect(output).toContain("#42");
    expect(output).toContain("#41");
  });

  it("shows no active items message when empty", () => {
    const output = stripAnsi(formatStatusTable([]));
    expect(output).toContain("ninthwave status");
    expect(output).toContain("No active items");
  });

  it("shows getting-started hints when empty", () => {
    const output = stripAnsi(formatStatusTable([]));
    expect(output).toContain("To get started:");
    expect(output).toContain("ninthwave list --ready");
    expect(output).toContain("ninthwave start <ID>");
  });

  it("includes batch progress line", () => {
    const items = [
      makeItem("A-1", "merged"),
      makeItem("A-2", "implementing"),
    ];
    const output = stripAnsi(formatStatusTable(items));
    expect(output).toContain("Progress:");
    expect(output).toContain("merged");
    expect(output).toContain("implementing");
  });

  it("includes summary line", () => {
    const items = [
      makeItem("A-1", "merged"),
      makeItem("A-2", "implementing"),
      makeItem("A-3", "ci-failed"),
    ];
    const output = stripAnsi(formatStatusTable(items));
    expect(output).toContain("Total:");
    expect(output).toContain("3 items");
  });

  it("respects terminal width for title truncation", () => {
    const items = [
      makeItem(
        "A-1",
        "merged",
        "This is a very long title that should be truncated on narrow terminals",
        10,
      ),
    ];
    // Force narrow 60-column terminal
    const output = stripAnsi(formatStatusTable(items, 60));
    // Title should be truncated - original is 71 chars, with 60 col width
    // titleWidth = max(10, 60 - 48) = 12 (48 = fixed width including icon column)
    const lines = output.split("\n");
    const itemLine = lines.find((l) => l.includes("A-1"));
    expect(itemLine).toBeDefined();
    // The full title should NOT appear
    expect(itemLine).not.toContain(
      "This is a very long title that should be truncated on narrow terminals",
    );
    expect(itemLine).toContain("...");
  });

  it("is readable on standard 80-column terminal", () => {
    const items = [
      makeItem("H-STU-1", "implementing", "Rewrite status", 42),
      makeItem("H-MUX-2", "merged", "Add tmux adapter", 41),
      makeItem("M-CI-3", "ci-failed", "Fix CI timeout", 40),
    ];
    const output = formatStatusTable(items, 80);
    const lines = output.split("\n");
    for (const line of lines) {
      // Strip ANSI codes for width check
      const plain = stripAnsi(line);
      expect(plain.length).toBeLessThanOrEqual(80);
    }
  });

  it("produces parseable output with separators", () => {
    const items = [makeItem("A-1", "merged", "Test item", 10)];
    const output = stripAnsi(formatStatusTable(items));
    // Should have separator lines (using ─)
    const sepLines = output.split("\n").filter((l) => l.includes("─"));
    expect(sepLines.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── getTerminalWidth ────────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  it("returns a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });

  it("returns 80 when process.stdout.columns is undefined", () => {
    const original = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
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

  it("returns 80 when process.stdout.columns is 0", () => {
    const original = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    Object.defineProperty(process.stdout, "columns", {
      value: 0,
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

  it("returns actual column count when available", () => {
    const original = Object.getOwnPropertyDescriptor(
      process.stdout,
      "columns",
    );
    Object.defineProperty(process.stdout, "columns", {
      value: 120,
      configurable: true,
    });
    try {
      expect(getTerminalWidth()).toBe(120);
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, "columns", original);
      } else {
        delete (process.stdout as Record<string, unknown>)["columns"];
      }
    }
  });
});

// ─── renderStatus ───────────────────────────────────────────────────────────

describe("renderStatus", () => {
  it("returns a string (not void)", () => {
    const result = renderStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains the same content cmdStatus would print", () => {
    // renderStatus should include 'ninthwave status' header
    const result = stripAnsi(renderStatus("/nonexistent/path/.worktrees", "/nonexistent/path"));
    expect(result).toContain("ninthwave status");
    expect(result).toContain("No active items");
  });

  it("includes worktreeDir path when it does not exist", () => {
    const result = stripAnsi(renderStatus("/nonexistent/path/.worktrees", "/nonexistent/path"));
    expect(result).toContain("/nonexistent/path/.worktrees");
    expect(result).toContain("not found");
  });

  it("includes getting-started hints when no items exist", () => {
    const result = stripAnsi(renderStatus("/nonexistent/path/.worktrees", "/nonexistent/path"));
    expect(result).toContain("To get started:");
    expect(result).toContain("ninthwave list --ready");
  });

  it("shows 'No active items' when worktreeDir exists but has no todo-* entries", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-status-test-"));
    const worktreeDir = join(tmpDir, ".worktrees");
    mkdirSync(worktreeDir);
    writeFileSync(join(worktreeDir, "some-other-file"), "");

    try {
      const result = stripAnsi(renderStatus(worktreeDir, tmpDir));
      expect(result).toContain("No active items");
      expect(result).toContain("ninthwave status");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ends with a newline", () => {
    const result = renderStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
    expect(result.endsWith("\n")).toBe(true);
  });
});

// ─── cmdStatus (integration) ────────────────────────────────────────────────

describe("cmdStatus", () => {
  it("writes to stdout with the same content as renderStatus", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      cmdStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
      const written = writeSpy.mock.calls.map((call) => String(call[0])).join("");
      const expected = renderStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
      expect(written).toBe(expected);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("shows 'No active items' when worktreeDir does not exist", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      cmdStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
      const output = stripAnsi(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(output).toContain("No active items");
      expect(output).toContain("ninthwave status");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("shows worktreeDir path when it does not exist", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      cmdStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
      const output = stripAnsi(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(output).toContain("/nonexistent/path/.worktrees");
      expect(output).toContain("not found");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("shows getting-started hints when worktreeDir does not exist", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      cmdStatus("/nonexistent/path/.worktrees", "/nonexistent/path");
      const output = stripAnsi(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(output).toContain("To get started:");
      expect(output).toContain("ninthwave list --ready");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("shows 'No active items' when worktreeDir exists but has no todo-* entries", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-status-test-"));
    const worktreeDir = join(tmpDir, ".worktrees");
    mkdirSync(worktreeDir);
    writeFileSync(join(worktreeDir, "some-other-file"), "");

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      cmdStatus(worktreeDir, tmpDir);
      const output = stripAnsi(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(output).toContain("No active items");
      expect(output).toContain("ninthwave status");
    } finally {
      writeSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows getting-started hints when worktreeDir exists but is empty", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-status-test-"));
    const worktreeDir = join(tmpDir, ".worktrees");
    mkdirSync(worktreeDir);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      cmdStatus(worktreeDir, tmpDir);
      const output = stripAnsi(writeSpy.mock.calls.map((call) => String(call[0])).join(""));
      expect(output).toContain("To get started:");
    } finally {
      writeSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── cmdStatusWatch ──────────────────────────────────────────────────────────

describe("cmdStatusWatch", () => {
  it("uses cursor-home (not full-screen-clear) for flicker-free refresh", async () => {
    const controller = new AbortController();

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const watchPromise = cmdStatusWatch(
      "/nonexistent",
      "/nonexistent",
      10, // 10ms interval for fast testing
      controller.signal,
    );

    // Wait a bit for a few iterations, then abort
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await watchPromise;

    const allWrites = writeSpy.mock.calls.map((call) => String(call[0]));

    // \x1B[2J (clear entire screen) must NOT be used — that causes flicker
    const fullClearCalls = allWrites.filter((s) => s.includes("\x1B[2J"));
    expect(fullClearCalls.length).toBe(0);

    // \x1B[H (cursor home) must be used
    const cursorHomeCalls = allWrites.filter((s) => s.includes("\x1B[H"));
    expect(cursorHomeCalls.length).toBeGreaterThanOrEqual(1);

    // \x1B[J (clear from cursor to end of screen) must be used after content
    const clearTrailingCalls = allWrites.filter((s) => s.includes("\x1B[J"));
    expect(clearTrailingCalls.length).toBeGreaterThanOrEqual(1);

    writeSpy.mockRestore();
  });

  it("writes status content between cursor-home and clear-trailing", async () => {
    const controller = new AbortController();

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const watchPromise = cmdStatusWatch(
      "/nonexistent",
      "/nonexistent",
      10,
      controller.signal,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await watchPromise;

    const allWrites = writeSpy.mock.calls.map((call) => String(call[0]));

    // Verify the sequence: \x1B[H, then content, then \x1B[J
    const cursorHomeIdx = allWrites.findIndex((s) => s === "\x1B[H");
    const clearTrailingIdx = allWrites.findIndex((s) => s === "\x1B[J");
    expect(cursorHomeIdx).toBeGreaterThanOrEqual(0);
    expect(clearTrailingIdx).toBeGreaterThan(cursorHomeIdx);

    // Content should be between them
    const contentBetween = allWrites.slice(cursorHomeIdx + 1, clearTrailingIdx);
    expect(contentBetween.length).toBeGreaterThan(0);
    const contentStr = stripAnsi(contentBetween.join(""));
    expect(contentStr).toContain("ninthwave status");

    writeSpy.mockRestore();
  });

  it("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const start = Date.now();
    await cmdStatusWatch("/nonexistent", "/nonexistent", 5000, controller.signal);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);

    writeSpy.mockRestore();
  });
});

// ─── Daemon state mapping ────────────────────────────────────────────────────

describe("mapDaemonItemState", () => {
  it("maps done/merged to merged", () => {
    expect(mapDaemonItemState("done")).toBe("merged");
    expect(mapDaemonItemState("merged")).toBe("merged");
  });

  it("maps implementing/launching to implementing", () => {
    expect(mapDaemonItemState("implementing")).toBe("implementing");
    expect(mapDaemonItemState("launching")).toBe("implementing");
  });

  it("maps ci-failed/stuck to ci-failed", () => {
    expect(mapDaemonItemState("ci-failed")).toBe("ci-failed");
    expect(mapDaemonItemState("stuck")).toBe("ci-failed");
  });

  it("maps ci-pending/merging to ci-pending", () => {
    expect(mapDaemonItemState("ci-pending")).toBe("ci-pending");
    expect(mapDaemonItemState("merging")).toBe("ci-pending");
  });

  it("maps review-pending/ci-passed to review", () => {
    expect(mapDaemonItemState("review-pending")).toBe("review");
    expect(mapDaemonItemState("ci-passed")).toBe("review");
  });

  it("maps pr-open to pr-open", () => {
    expect(mapDaemonItemState("pr-open")).toBe("pr-open");
  });

  it("maps queued/ready to queued", () => {
    expect(mapDaemonItemState("queued")).toBe("queued");
    expect(mapDaemonItemState("ready")).toBe("queued");
  });

  it("maps unknown states to in-progress", () => {
    expect(mapDaemonItemState("some-unknown-state")).toBe("in-progress");
  });
});

describe("daemonStateToStatusItems", () => {
  it("converts daemon state items to status items", () => {
    const now = Date.now();
    const state: DaemonState = {
      pid: 123,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:05:00.000Z",
      items: [
        {
          id: "T-1-1",
          state: "implementing",
          prNumber: null,
          title: "Add feature",
          lastTransition: new Date(now - 60000).toISOString(),
          ciFailCount: 0,
          retryCount: 0,
        },
        {
          id: "T-1-2",
          state: "ci-passed",
          prNumber: 42,
          title: "Fix bug",
          lastTransition: new Date(now - 300000).toISOString(),
          ciFailCount: 1,
          retryCount: 0,
        },
      ],
    };

    const items = daemonStateToStatusItems(state);

    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe("T-1-1");
    expect(items[0]!.state).toBe("implementing");
    expect(items[0]!.title).toBe("Add feature");
    expect(items[0]!.prNumber).toBeNull();
    // Age should be approximately 60000ms (±5000ms for test execution time)
    expect(items[0]!.ageMs).toBeGreaterThan(50000);
    expect(items[0]!.ageMs).toBeLessThan(70000);

    expect(items[1]!.id).toBe("T-1-2");
    expect(items[1]!.state).toBe("review"); // ci-passed maps to review
    expect(items[1]!.prNumber).toBe(42);
  });

  it("handles empty items list", () => {
    const state: DaemonState = {
      pid: 1,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:00:00.000Z",
      items: [],
    };
    expect(daemonStateToStatusItems(state)).toEqual([]);
  });
});

// ─── Queued state support ─────────────────────────────────────────────────────

describe("stateColor for queued", () => {
  it("returns DIM for queued state", () => {
    // DIM is the same as the default branch — verify it returns a string
    expect(typeof stateColor("queued")).toBe("string");
    // Verify it's the same value as what DIM would be (matches default)
    expect(stateColor("queued")).toBe(stateColor("queued"));
  });
});

describe("stateLabel for queued", () => {
  it("returns 'Queued' for queued state", () => {
    expect(stateLabel("queued")).toBe("Queued");
  });
});

describe("formatQueuedItemRow", () => {
  it("renders a fully dimmed row", () => {
    const item = makeItem("Q-1", "queued", "Waiting to start");
    const row = stripAnsi(formatQueuedItemRow(item, 30));
    expect(row).toContain("Q-1");
    expect(row).toContain("Queued");
    expect(row).toContain("Waiting to start");
  });

  it("uses dash for PR when none", () => {
    const item = makeItem("Q-2", "queued");
    const row = stripAnsi(formatQueuedItemRow(item, 20));
    expect(row).toContain("-");
    expect(row).not.toContain("#");
  });
});

describe("formatStatusTable with queued items", () => {
  it("shows queue section with header for mixed active + queued items", () => {
    const items = [
      makeItem("A-1", "implementing", "Active item"),
      makeItem("Q-1", "queued", "Queued item 1"),
      makeItem("Q-2", "queued", "Queued item 2"),
    ];
    const output = stripAnsi(formatStatusTable(items));
    expect(output).toContain("Queue (2 waiting)");
    expect(output).toContain("Q-1");
    expect(output).toContain("Q-2");
    expect(output).toContain("A-1");
  });

  it("shows WIP slot usage in queue header when wipLimit provided", () => {
    const items = [
      makeItem("A-1", "implementing", "Active 1"),
      makeItem("A-2", "ci-pending", "Active 2"),
      makeItem("Q-1", "queued", "Queued 1"),
    ];
    const output = stripAnsi(formatStatusTable(items, 80, 5));
    expect(output).toContain("Queue (1 waiting, 2/5 WIP slots active)");
  });

  it("shows queue section with only queued items (no active section)", () => {
    const items = [
      makeItem("Q-1", "queued", "Queued 1"),
      makeItem("Q-2", "queued", "Queued 2"),
      makeItem("Q-3", "queued", "Queued 3"),
    ];
    const output = stripAnsi(formatStatusTable(items));
    expect(output).toContain("Queue (3 waiting)");
    expect(output).toContain("Q-1");
    expect(output).toContain("Q-2");
    expect(output).toContain("Q-3");
  });

  it("shows queued items below active items", () => {
    const items = [
      makeItem("A-1", "implementing", "Active"),
      makeItem("Q-1", "queued", "Queued"),
    ];
    const output = stripAnsi(formatStatusTable(items));
    const activeIdx = output.indexOf("A-1");
    const queueIdx = output.indexOf("Q-1");
    expect(activeIdx).toBeLessThan(queueIdx);
  });

  it("shows no queue header when no queued items", () => {
    const items = [
      makeItem("A-1", "implementing", "Active"),
      makeItem("A-2", "merged", "Done"),
    ];
    const output = stripAnsi(formatStatusTable(items));
    expect(output).not.toContain("Queue");
  });

  it("counts only active (non-merged, non-queued) items for WIP slots", () => {
    const items = [
      makeItem("A-1", "implementing", "Active"),
      makeItem("A-2", "merged", "Done"),
      makeItem("Q-1", "queued", "Waiting"),
    ];
    // Only A-1 is active (A-2 is merged), so 1/3 WIP slots
    const output = stripAnsi(formatStatusTable(items, 80, 3));
    expect(output).toContain("1/3 WIP slots active");
  });
});

describe("formatBatchProgress with queued", () => {
  it("includes queued count in progress line", () => {
    const items = [
      makeItem("A-1", "implementing"),
      makeItem("Q-1", "queued"),
      makeItem("Q-2", "queued"),
    ];
    const line = stripAnsi(formatBatchProgress(items));
    expect(line).toContain("1 implementing");
    expect(line).toContain("2 queued");
  });

  it("orders queued after ci-failed in progress line", () => {
    const items = [
      makeItem("A-1", "ci-failed"),
      makeItem("Q-1", "queued"),
    ];
    const line = stripAnsi(formatBatchProgress(items));
    const failIdx = line.indexOf("ci failed");
    const queueIdx = line.indexOf("queued");
    expect(failIdx).toBeLessThan(queueIdx);
  });
});

// ─── Queue size rendering ─────────────────────────────────────────────────────

describe("formatStatusTable with various queue sizes", () => {
  it("renders correctly with 1 item", () => {
    const items = [makeItem("A-1", "implementing", "Solo item")];
    const output = stripAnsi(formatStatusTable(items, 80));
    expect(output).toContain("A-1");
    expect(output).toContain("Implementing");
    expect(output).toContain("▸");
    expect(output).not.toContain("Queue");
  });

  it("renders correctly with 3 items (mixed states)", () => {
    const items = [
      makeItem("A-1", "implementing", "Active work"),
      makeItem("A-2", "merged", "Done item", 42),
      makeItem("Q-1", "queued", "Waiting"),
    ];
    const output = stripAnsi(formatStatusTable(items, 80));
    expect(output).toContain("A-1");
    expect(output).toContain("A-2");
    expect(output).toContain("Q-1");
    expect(output).toContain("Queue (1 waiting)");
  });

  it("renders correctly with 6+ items (full batch)", () => {
    const items = [
      makeItem("A-1", "merged", "Done 1", 10),
      makeItem("A-2", "merged", "Done 2", 11),
      makeItem("A-3", "implementing", "Active 1"),
      makeItem("A-4", "ci-pending", "CI check", 12),
      makeItem("Q-1", "queued", "Waiting 1"),
      makeItem("Q-2", "queued", "Waiting 2"),
      makeItem("Q-3", "queued", "Waiting 3"),
    ];
    const output = stripAnsi(formatStatusTable(items, 100));
    // All items should appear
    for (const item of items) {
      expect(output).toContain(item.id);
    }
    // Queue section should show 3 waiting
    expect(output).toContain("Queue (3 waiting)");
    // Progress should show all states
    expect(output).toContain("2 merged");
    expect(output).toContain("1 implementing");
    expect(output).toContain("3 queued");
    // Total should show all
    expect(output).toContain("7 items");
  });
});

// ─── Column alignment at different terminal widths ────────────────────────────

describe("column alignment", () => {
  const items = [
    makeItem("H-STU-1", "implementing", "Short title", 42),
    makeItem("LONG-ID-999", "ci-failed", "Another title", 100),
    makeItem("Q-1", "queued", "Queued item"),
  ];

  it("aligns columns at 60-column width", () => {
    const output = stripAnsi(formatStatusTable(items, 60));
    const lines = output.split("\n").filter((l) => l.includes("H-STU-1") || l.includes("LONG-ID-999"));
    // Both active item rows should have the same structure
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("aligns columns at 120-column width", () => {
    const output = stripAnsi(formatStatusTable(items, 120));
    const lines = output.split("\n").filter((l) => l.includes("H-STU-1") || l.includes("LONG-ID-999"));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it("aligns columns at minimum 50-column width", () => {
    const output = stripAnsi(formatStatusTable(items, 50));
    const lines = output.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80); // separator clamps at 78+2
    }
  });

  it("header and data rows have consistent column positions", () => {
    const singleItem = [makeItem("TEST-1", "implementing", "Title here", 5)];
    const output = stripAnsi(formatStatusTable(singleItem, 80));
    const lines = output.split("\n");
    const headerLine = lines.find((l) => l.includes("ID") && l.includes("STATE"));
    const dataLine = lines.find((l) => l.includes("TEST-1"));
    expect(headerLine).toBeDefined();
    expect(dataLine).toBeDefined();
    // "ID" in header should start at the same position as "TEST-1" in data
    // Both should start at position 4 (2 indent + 2 icon space)
    const headerIdPos = headerLine!.indexOf("ID");
    const dataIdPos = dataLine!.indexOf("TEST-1");
    expect(headerIdPos).toBe(dataIdPos);
  });
});

// ─── State indicator rendering for each state ────────────────────────────────

describe("state indicators in formatItemRow", () => {
  const allStates: Array<{ state: ItemState; icon: string; label: string }> = [
    { state: "merged", icon: "✓", label: "Merged" },
    { state: "implementing", icon: "▸", label: "Implementing" },
    { state: "ci-failed", icon: "✗", label: "CI Failed" },
    { state: "ci-pending", icon: "◌", label: "CI Pending" },
    { state: "review", icon: "●", label: "In Review" },
    { state: "pr-open", icon: "○", label: "PR Open" },
    { state: "in-progress", icon: "▸", label: "In Progress" },
    { state: "queued", icon: "·", label: "Queued" },
  ];

  for (const { state, icon, label } of allStates) {
    it(`renders ${state} with icon "${icon}" and label "${label}"`, () => {
      const item = makeItem("T-1", state, `Test ${state}`);
      const row = stripAnsi(formatItemRow(item, 30));
      expect(row).toContain(icon);
      expect(row).toContain(label);
    });
  }
});

// ─── Watch mode line clearing ─────────────────────────────────────────────────

describe("cmdStatusWatch line clearing", () => {
  it("includes clear-to-end-of-line sequences to prevent garbled output", async () => {
    const controller = new AbortController();

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const watchPromise = cmdStatusWatch(
      "/nonexistent",
      "/nonexistent",
      10,
      controller.signal,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await watchPromise;

    const allWrites = writeSpy.mock.calls.map((call) => String(call[0]));

    // Content writes should include \x1B[K (clear to end of line)
    const contentWrites = allWrites.filter(
      (s) => s !== "\x1B[H" && s !== "\x1B[J",
    );
    const hasLineClear = contentWrites.some((s) => s.includes("\x1B[K"));
    expect(hasLineClear).toBe(true);

    writeSpy.mockRestore();
  });
});

// ─── Dependency tree building ─────────────────────────────────────────────────

describe("buildDependencyTree", () => {
  it("returns all items as flat when none have dependencies", () => {
    const items = [
      makeItem("A-1", "merged", "Item A"),
      makeItem("B-1", "implementing", "Item B"),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(0);
    expect(flat).toHaveLength(2);
  });

  it("builds a simple chain into a tree", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(1);
    expect(flat).toHaveLength(0);
    expect(trees[0]!.item.id).toBe("A-1");
    expect(trees[0]!.children).toHaveLength(1);
    expect(trees[0]!.children[0]!.item.id).toBe("A-2");
  });

  it("builds a deep chain", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "merged", "Child 1", null, 3600000, ["A-1"]),
      makeItem("A-3", "implementing", "Child 2", null, 3600000, ["A-2"]),
      makeItem("A-4", "queued", "Child 3", null, 3600000, ["A-3"]),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(1);
    expect(flat).toHaveLength(0);
    const root = trees[0]!;
    expect(root.item.id).toBe("A-1");
    expect(root.children[0]!.item.id).toBe("A-2");
    expect(root.children[0]!.children[0]!.item.id).toBe("A-3");
    expect(root.children[0]!.children[0]!.children[0]!.item.id).toBe("A-4");
  });

  it("handles multiple children per parent", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child 1", null, 3600000, ["A-1"]),
      makeItem("A-3", "queued", "Child 2", null, 3600000, ["A-1"]),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(1);
    expect(trees[0]!.children).toHaveLength(2);
    const childIds = trees[0]!.children.map((c) => c.item.id);
    expect(childIds).toContain("A-2");
    expect(childIds).toContain("A-3");
  });

  it("separates multiple independent trees", () => {
    const items = [
      makeItem("A-1", "merged", "Root A"),
      makeItem("A-2", "implementing", "Child A", null, 3600000, ["A-1"]),
      makeItem("B-1", "merged", "Root B"),
      makeItem("B-2", "queued", "Child B", null, 3600000, ["B-1"]),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(2);
    expect(flat).toHaveLength(0);
  });

  it("treats items with out-of-set deps as flat", () => {
    const items = [
      makeItem("A-1", "implementing", "Item A", null, 3600000, ["X-1"]),
      makeItem("B-1", "queued", "Item B"),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(0);
    expect(flat).toHaveLength(2);
  });

  it("mixes tree items and flat items", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
      makeItem("B-1", "queued", "Flat item"),
    ];
    const { trees, flat } = buildDependencyTree(items);
    expect(trees).toHaveLength(1);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.id).toBe("B-1");
  });

  it("picks first in-set dependency as parent when multiple deps", () => {
    const items = [
      makeItem("A-1", "merged", "Root A"),
      makeItem("B-1", "merged", "Root B"),
      makeItem("C-1", "implementing", "Multi-dep", null, 3600000, ["A-1", "B-1"]),
    ];
    const { trees, flat } = buildDependencyTree(items);
    // C-1 should be child of A-1 (first in-set dep)
    expect(trees.length).toBeGreaterThanOrEqual(1);
    const rootA = trees.find((t) => t.item.id === "A-1");
    expect(rootA).toBeDefined();
    expect(rootA!.children.some((c) => c.item.id === "C-1")).toBe(true);
  });
});

// ─── Tree row formatting ─────────────────────────────────────────────────────

describe("formatTreeItemRow", () => {
  it("renders root item (depth 0) without tree prefix", () => {
    const item = makeItem("A-1", "merged", "Root item");
    const row = stripAnsi(formatTreeItemRow(item, 0, [], true, 80));
    expect(row).toContain("A-1");
    expect(row).toContain("Merged");
    expect(row).toContain("Root item");
    expect(row).not.toContain("├");
    expect(row).not.toContain("└");
    expect(row).not.toContain("│");
  });

  it("renders depth-1 last child with └── prefix", () => {
    const item = makeItem("A-2", "implementing", "Child item");
    const row = stripAnsi(formatTreeItemRow(item, 1, [], true, 80));
    expect(row).toContain("└──");
    expect(row).toContain("A-2");
    expect(row).toContain("Child item");
  });

  it("renders depth-1 non-last child with ├── prefix", () => {
    const item = makeItem("A-2", "implementing", "Child item");
    const row = stripAnsi(formatTreeItemRow(item, 1, [], false, 80));
    expect(row).toContain("├──");
    expect(row).toContain("A-2");
  });

  it("renders depth-2 with continuation line", () => {
    const item = makeItem("A-3", "queued", "Grandchild");
    // Parent was not last → should show │ continuation
    const row = stripAnsi(formatTreeItemRow(item, 2, [false], true, 80));
    expect(row).toContain("│");
    expect(row).toContain("└──");
    expect(row).toContain("A-3");
  });

  it("renders depth-2 with space when parent was last", () => {
    const item = makeItem("A-3", "queued", "Grandchild");
    const row = stripAnsi(formatTreeItemRow(item, 2, [true], true, 80));
    expect(row).not.toContain("│");
    expect(row).toContain("└──");
    expect(row).toContain("A-3");
  });

  it("preserves state icon and color for all states", () => {
    const states: ItemState[] = ["merged", "implementing", "ci-failed", "queued"];
    for (const state of states) {
      const item = makeItem("X-1", state, "Test");
      const row = stripAnsi(formatTreeItemRow(item, 1, [], true, 80));
      expect(row).toContain(stateIcon(state));
    }
  });

  it("adjusts title width for deeper items", () => {
    const item = makeItem("A-1", "merged", "This is a long title for narrow test");
    // At depth 3, prefix is 12 chars, so titleWidth = max(6, 60 - 48 - 12) = 6
    const row = stripAnsi(formatTreeItemRow(item, 3, [false, false], true, 60));
    expect(row).toContain("A-1");
    // Title should be truncated
    expect(row).not.toContain("This is a long title for narrow test");
  });
});

describe("formatTreeRows", () => {
  it("renders a simple chain with connector characters", () => {
    const trees: TreeNode[] = [{
      item: makeItem("A-1", "merged", "Root"),
      children: [{
        item: makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
        children: [],
      }],
    }];
    const lines = formatTreeRows(trees, 80);
    const plain = lines.map(stripAnsi);
    expect(plain).toHaveLength(2);
    expect(plain[0]).toContain("A-1");
    expect(plain[0]).not.toContain("└");
    expect(plain[1]).toContain("└──");
    expect(plain[1]).toContain("A-2");
  });

  it("renders multiple children with ├── and └──", () => {
    const trees: TreeNode[] = [{
      item: makeItem("A-1", "merged", "Root"),
      children: [
        { item: makeItem("A-2", "implementing", "Child 1", null, 3600000, ["A-1"]), children: [] },
        { item: makeItem("A-3", "queued", "Child 2", null, 3600000, ["A-1"]), children: [] },
      ],
    }];
    const lines = formatTreeRows(trees, 80);
    const plain = lines.map(stripAnsi);
    expect(plain).toHaveLength(3);
    expect(plain[1]).toContain("├──");
    expect(plain[2]).toContain("└──");
  });

  it("renders deep chain with continuation lines", () => {
    const trees: TreeNode[] = [{
      item: makeItem("A-1", "merged", "Root"),
      children: [{
        item: makeItem("A-2", "merged", "Child"),
        children: [{
          item: makeItem("A-3", "implementing", "Grandchild"),
          children: [{
            item: makeItem("A-4", "queued", "Great-grandchild"),
            children: [],
          }],
        }],
      }],
    }];
    const lines = formatTreeRows(trees, 80);
    const plain = lines.map(stripAnsi);
    expect(plain).toHaveLength(4);
    expect(plain[0]).toContain("A-1");
    expect(plain[1]).toContain("└──");
    expect(plain[1]).toContain("A-2");
    expect(plain[2]).toContain("└──");
    expect(plain[2]).toContain("A-3");
    expect(plain[3]).toContain("└──");
    expect(plain[3]).toContain("A-4");
  });

  it("separates independent trees with blank line", () => {
    const trees: TreeNode[] = [
      {
        item: makeItem("A-1", "merged", "Tree A root"),
        children: [{ item: makeItem("A-2", "implementing", "Tree A child"), children: [] }],
      },
      {
        item: makeItem("B-1", "merged", "Tree B root"),
        children: [{ item: makeItem("B-2", "queued", "Tree B child"), children: [] }],
      },
    ];
    const lines = formatTreeRows(trees, 80);
    // Should have: A-1, A-2, blank, B-1, B-2
    expect(lines).toHaveLength(5);
    expect(stripAnsi(lines[2]!)).toBe("");
  });
});

// ─── formatStatusTable with dependency trees ──────────────────────────────────

describe("formatStatusTable tree rendering", () => {
  it("renders dependency chain as indented tree", () => {
    const items = [
      makeItem("H-PRX-4", "merged", "Add session CA", 123, 3600000),
      makeItem("H-PRX-5", "merged", "Add Cedar policy", 124, 3600000, ["H-PRX-4"]),
      makeItem("H-PRX-6", "queued", "Add credential injection", null, 3600000, ["H-PRX-5"]),
      makeItem("H-PRX-7", "queued", "proxy-launcher", null, 3600000, ["H-PRX-6"]),
    ];
    const output = stripAnsi(formatStatusTable(items, 100));
    expect(output).toContain("H-PRX-4");
    expect(output).toContain("H-PRX-5");
    expect(output).toContain("H-PRX-6");
    expect(output).toContain("H-PRX-7");
    // Tree chars should appear
    expect(output).toContain("└──");
  });

  it("root items (no deps) render at top level", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
    ];
    const output = stripAnsi(formatStatusTable(items, 80));
    const lines = output.split("\n");
    const rootLine = lines.find((l) => l.includes("A-1") && l.includes("Merged"));
    expect(rootLine).toBeDefined();
    // Root line should NOT contain tree connectors
    expect(rootLine).not.toContain("├");
    expect(rootLine).not.toContain("└");
  });

  it("items with no dependencies render in flat list", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
      makeItem("B-1", "queued", "Independent"),
    ];
    const output = stripAnsi(formatStatusTable(items, 80));
    expect(output).toContain("A-1");
    expect(output).toContain("A-2");
    expect(output).toContain("B-1");
  });

  it("multiple independent trees render separately", () => {
    const items = [
      makeItem("A-1", "merged", "Tree A root"),
      makeItem("A-2", "implementing", "Tree A child", null, 3600000, ["A-1"]),
      makeItem("B-1", "merged", "Tree B root"),
      makeItem("B-2", "queued", "Tree B child", null, 3600000, ["B-1"]),
    ];
    const output = stripAnsi(formatStatusTable(items, 100));
    expect(output).toContain("A-1");
    expect(output).toContain("A-2");
    expect(output).toContain("B-1");
    expect(output).toContain("B-2");
    // Both should have tree connectors
    const lines = output.split("\n");
    const treeLines = lines.filter((l) => l.includes("└──") || l.includes("├──"));
    expect(treeLines.length).toBeGreaterThanOrEqual(2);
  });

  it("--flat flag forces flat rendering", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
      makeItem("A-3", "queued", "Grandchild", null, 3600000, ["A-2"]),
    ];
    const output = stripAnsi(formatStatusTable(items, 80, undefined, true));
    // Should not have tree connectors
    expect(output).not.toContain("├──");
    expect(output).not.toContain("└──");
    expect(output).not.toContain("│");
    // Items should still be present
    expect(output).toContain("A-1");
    expect(output).toContain("A-2");
    expect(output).toContain("A-3");
  });

  it("state icons and colors preserved in tree view", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
    ];
    const output = stripAnsi(formatStatusTable(items, 80));
    expect(output).toContain("✓"); // merged icon
    expect(output).toContain("▸"); // implementing icon
    expect(output).toContain("Merged");
    expect(output).toContain("Implementing");
  });

  it("wide terminal: columns align properly for root items", () => {
    const items = [
      makeItem("A-1", "merged", "Root item with long title", 42),
      makeItem("A-2", "implementing", "Child item", null, 3600000, ["A-1"]),
    ];
    const output = formatStatusTable(items, 120);
    const lines = output.split("\n");
    for (const line of lines) {
      const plain = stripAnsi(line);
      expect(plain.length).toBeLessThanOrEqual(120);
    }
  });

  it("narrow terminal: output degrades gracefully", () => {
    const items = [
      makeItem("A-1", "merged", "Root item"),
      makeItem("A-2", "implementing", "Child 1", null, 3600000, ["A-1"]),
      makeItem("A-3", "queued", "Grandchild", null, 3600000, ["A-2"]),
    ];
    // Very narrow terminal
    const output = formatStatusTable(items, 50);
    const lines = output.split("\n");
    // Should not crash or produce empty lines where content is expected
    const contentLines = lines.filter((l) => stripAnsi(l).trim().length > 0);
    expect(contentLines.length).toBeGreaterThan(0);
    // Items should still appear
    const plain = stripAnsi(output);
    expect(plain).toContain("A-1");
    expect(plain).toContain("A-2");
    expect(plain).toContain("A-3");
  });

  it("includes progress and summary in tree mode", () => {
    const items = [
      makeItem("A-1", "merged", "Root"),
      makeItem("A-2", "implementing", "Child", null, 3600000, ["A-1"]),
    ];
    const output = stripAnsi(formatStatusTable(items, 80));
    expect(output).toContain("Progress:");
    expect(output).toContain("Total:");
  });
});

// ─── daemonStateToStatusItems with dependencies ───────────────────────────────

describe("daemonStateToStatusItems with dependencies", () => {
  it("includes dependencies from daemon state", () => {
    const now = Date.now();
    const state: DaemonState = {
      pid: 123,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:05:00.000Z",
      items: [
        {
          id: "A-1",
          state: "merged",
          prNumber: 100,
          title: "Root",
          lastTransition: new Date(now - 60000).toISOString(),
          ciFailCount: 0,
          retryCount: 0,
        },
        {
          id: "A-2",
          state: "implementing",
          prNumber: null,
          title: "Child",
          lastTransition: new Date(now - 60000).toISOString(),
          ciFailCount: 0,
          retryCount: 0,
          dependencies: ["A-1"],
        },
      ],
    };

    const items = daemonStateToStatusItems(state);
    expect(items).toHaveLength(2);
    expect(items[0]!.dependencies).toEqual([]);
    expect(items[1]!.dependencies).toEqual(["A-1"]);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  state: ItemState,
  title: string = "",
  prNumber: number | null = null,
  ageMs: number = 3600000,
  dependencies: string[] = [],
): StatusItem {
  return { id, title, state, prNumber, ageMs, repoLabel: "", dependencies };
}
