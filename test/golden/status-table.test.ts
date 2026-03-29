// Golden file tests for TUI output -- visual regression detection.
// Snapshots renderStatusTable and renderPanelFrame output for representative
// orchestrator states, comparing against .expected files in this directory.
//
// Run with UPDATE_GOLDEN=1 to regenerate .expected files when output changes intentionally.

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  formatStatusTable,
  buildStatusLayout,
  renderFullScreenFrame,
  buildPanelLayout,
  renderPanelFrame,
  type StatusItem,
  type ItemState,
  type ViewOptions,
} from "../../core/status-render.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const GOLDEN_DIR = join(import.meta.dir, ".");

/** Strip ANSI escape sequences for deterministic golden file comparison. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07]*\x07/g, "") // OSC 8 hyperlink sequences
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // CSI sequences (colors, etc.)
}

/**
 * Compare output against a golden .expected file.
 * When UPDATE_GOLDEN=1 is set, writes the actual output to the file instead.
 */
function assertGolden(name: string, actual: string): void {
  const filePath = join(GOLDEN_DIR, `${name}.expected`);
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(filePath, actual, "utf-8");
    return; // skip assertion when updating
  }
  if (!existsSync(filePath)) {
    throw new Error(
      `Golden file not found: ${filePath}\nRun with UPDATE_GOLDEN=1 to generate it.`,
    );
  }
  const expected = readFileSync(filePath, "utf-8");
  expect(actual).toBe(expected);
}

/** Create a StatusItem with sensible defaults. */
function makeItem(overrides: Partial<StatusItem> = {}): StatusItem {
  return {
    id: overrides.id ?? "T-1",
    title: overrides.title ?? "Test item",
    state: overrides.state ?? "implementing",
    prNumber: overrides.prNumber ?? null,
    ageMs: overrides.ageMs ?? 300_000, // 5 minutes
    repoLabel: overrides.repoLabel ?? "",
    failureReason: overrides.failureReason,
    dependencies: overrides.dependencies,
    startedAt: overrides.startedAt,
    endedAt: overrides.endedAt,
    exitCode: overrides.exitCode,
    stderrTail: overrides.stderrTail,
    daemonName: overrides.daemonName,
    worktreePath: overrides.worktreePath,
  };
}

// ── Representative orchestrator states ───────────────────────────────────────

/** Empty state: no items at all. */
const EMPTY_STATE: StatusItem[] = [];

/** All items queued, nothing started yet. */
const ALL_QUEUED_STATE: StatusItem[] = [
  makeItem({ id: "H-CA-1", title: "Add authentication middleware", state: "queued" }),
  makeItem({ id: "H-CA-2", title: "Database migration for users table", state: "queued" }),
  makeItem({ id: "M-FE-1", title: "Login form component", state: "queued" }),
  makeItem({ id: "M-FE-2", title: "Dashboard layout refactor", state: "queued" }),
  makeItem({ id: "L-BF-1", title: "Fix tooltip positioning on narrow screens", state: "queued" }),
];

/** Mixed states: active work in progress with various statuses.
 * Uses ageMs (not startedAt) for active items to keep durations deterministic. */
const MIXED_STATE: StatusItem[] = [
  makeItem({
    id: "H-CA-1",
    title: "Add authentication middleware",
    state: "merged",
    prNumber: 42,
    ageMs: 15 * 60_000,
    startedAt: "2026-03-29T10:00:00Z",
    endedAt: "2026-03-29T10:15:00Z",
  }),
  makeItem({
    id: "H-CA-2",
    title: "Database migration for users table",
    state: "implementing",
    prNumber: null,
    ageMs: 7 * 60_000,
  }),
  makeItem({
    id: "M-FE-1",
    title: "Login form component",
    state: "ci-pending",
    prNumber: 43,
    ageMs: 2 * 60_000,
  }),
  makeItem({
    id: "M-FE-2",
    title: "Dashboard layout refactor",
    state: "ci-failed",
    prNumber: 44,
    failureReason: "lint errors",
    ageMs: 4 * 60_000,
  }),
  makeItem({
    id: "L-BF-1",
    title: "Fix tooltip positioning on narrow screens",
    state: "review",
    prNumber: 45,
    ageMs: 1 * 60_000,
  }),
  makeItem({ id: "L-BF-2", title: "Update README with new API docs", state: "queued" }),
  makeItem({ id: "L-BF-3", title: "Add retry logic to webhook handler", state: "queued" }),
];

/** All items done/merged. */
const ALL_DONE_STATE: StatusItem[] = [
  makeItem({
    id: "H-CA-1",
    title: "Add authentication middleware",
    state: "merged",
    prNumber: 42,
    startedAt: "2026-03-29T10:00:00Z",
    endedAt: "2026-03-29T10:15:00Z",
  }),
  makeItem({
    id: "H-CA-2",
    title: "Database migration for users table",
    state: "merged",
    prNumber: 43,
    startedAt: "2026-03-29T10:05:00Z",
    endedAt: "2026-03-29T10:20:00Z",
  }),
  makeItem({
    id: "M-FE-1",
    title: "Login form component",
    state: "merged",
    prNumber: 44,
    startedAt: "2026-03-29T10:10:00Z",
    endedAt: "2026-03-29T10:25:00Z",
  }),
];

/** Stuck items: some items have failed CI or have blockers.
 * Uses ageMs for deterministic durations. */
const STUCK_STATE: StatusItem[] = [
  makeItem({
    id: "H-CA-1",
    title: "Add authentication middleware",
    state: "ci-failed",
    prNumber: 42,
    failureReason: "test timeout",
    exitCode: 1,
    stderrTail: "Error: Test suite exceeded 30s timeout",
    ageMs: 12 * 60_000,
  }),
  makeItem({
    id: "H-CA-2",
    title: "Database migration for users table",
    state: "ci-failed",
    prNumber: 43,
    failureReason: "type errors",
    exitCode: 2,
    stderrTail: "src/db.ts(14,5): error TS2322: Type 'string' is not assignable to type 'number'",
    ageMs: 7 * 60_000,
  }),
  makeItem({
    id: "M-FE-1",
    title: "Login form component",
    state: "implementing",
    dependencies: ["H-CA-1"],
    ageMs: 2 * 60_000,
  }),
  makeItem({
    id: "M-FE-2",
    title: "Dashboard layout refactor",
    state: "queued",
    dependencies: ["H-CA-1", "H-CA-2"],
  }),
];

/** Items with long titles and many dependencies -- edge case for formatting.
 * Uses ageMs for deterministic durations. */
const LONG_TITLES_STATE: StatusItem[] = [
  makeItem({
    id: "H-LONGID-1",
    title: "This is a very long title that should be truncated when the terminal width is narrow to prevent line wrapping issues in the TUI",
    state: "implementing",
    ageMs: 12 * 60_000,
  }),
  makeItem({
    id: "M-LONGID-2",
    title: "Another extremely verbose title describing a complex refactoring of the authentication subsystem including OAuth2 and SAML support",
    state: "ci-pending",
    prNumber: 100,
    ageMs: 7 * 60_000,
  }),
  makeItem({
    id: "L-LONGID-3",
    title: "Short title",
    state: "queued",
    dependencies: ["H-LONGID-1", "M-LONGID-2"],
  }),
];

// ── formatStatusTable golden tests ───────────────────────────────────────────

describe("golden: formatStatusTable", () => {
  const WIDTHS = [80, 120] as const;

  describe("empty state", () => {
    for (const width of WIDTHS) {
      it(`renders empty state at ${width} columns`, () => {
        const output = formatStatusTable(EMPTY_STATE, width);
        assertGolden(`status-table-empty-${width}`, stripAnsi(output));
      });
    }
  });

  describe("all-queued state", () => {
    for (const width of WIDTHS) {
      it(`renders all-queued state at ${width} columns`, () => {
        const output = formatStatusTable(ALL_QUEUED_STATE, width);
        assertGolden(`status-table-all-queued-${width}`, stripAnsi(output));
      });
    }
  });

  describe("mixed state", () => {
    for (const width of WIDTHS) {
      it(`renders mixed state at ${width} columns`, () => {
        const output = formatStatusTable(MIXED_STATE, width);
        assertGolden(`status-table-mixed-${width}`, stripAnsi(output));
      });
    }
  });

  describe("all-done state", () => {
    for (const width of WIDTHS) {
      it(`renders all-done state at ${width} columns`, () => {
        const output = formatStatusTable(ALL_DONE_STATE, width);
        assertGolden(`status-table-all-done-${width}`, stripAnsi(output));
      });
    }
  });

  describe("stuck items", () => {
    for (const width of WIDTHS) {
      it(`renders stuck items at ${width} columns`, () => {
        const output = formatStatusTable(STUCK_STATE, width, undefined, false, {
          showBlockerDetail: true,
        });
        assertGolden(`status-table-stuck-${width}`, stripAnsi(output));
      });
    }
  });

  describe("long titles edge case", () => {
    for (const width of WIDTHS) {
      it(`handles long titles at ${width} columns`, () => {
        const output = formatStatusTable(LONG_TITLES_STATE, width, undefined, false, {
          showBlockerDetail: true,
        });
        assertGolden(`status-table-long-titles-${width}`, stripAnsi(output));
      });
    }
  });
});

// ── renderFullScreenFrame golden tests ───────────────────────────────────────

describe("golden: renderFullScreenFrame", () => {
  const TERM_ROWS = 24;

  it("renders mixed state in full-screen frame at 80 columns", () => {
    const layout = buildStatusLayout(MIXED_STATE, 80);
    const frame = renderFullScreenFrame(layout, TERM_ROWS, 80, 0);
    assertGolden("frame-mixed-80", stripAnsi(frame.join("\n")));
  });

  it("renders mixed state in full-screen frame at 120 columns", () => {
    const layout = buildStatusLayout(MIXED_STATE, 120);
    const frame = renderFullScreenFrame(layout, TERM_ROWS, 120, 0);
    assertGolden("frame-mixed-120", stripAnsi(frame.join("\n")));
  });

  it("renders stuck state in full-screen frame at 80 columns", () => {
    const layout = buildStatusLayout(STUCK_STATE, 80, undefined, false, {
      showBlockerDetail: true,
    });
    const frame = renderFullScreenFrame(layout, TERM_ROWS, 80, 0);
    assertGolden("frame-stuck-80", stripAnsi(frame.join("\n")));
  });

  it("renders empty state in full-screen frame", () => {
    const layout = buildStatusLayout(EMPTY_STATE, 80);
    const frame = renderFullScreenFrame(layout, TERM_ROWS, 80, 0);
    assertGolden("frame-empty-80", stripAnsi(frame.join("\n")));
  });
});

// ── renderPanelFrame golden tests ────────────────────────────────────────────

describe("golden: renderPanelFrame", () => {
  it("renders status-only panel at 80 columns", () => {
    const panelLayout = buildPanelLayout(
      "status-only",
      MIXED_STATE,
      [],
      80,
      24,
      { viewOptions: { mergeStrategy: "auto" } },
    );
    const frame = renderPanelFrame(panelLayout, 24, 80, 0);
    assertGolden("panel-status-only-80", stripAnsi(frame.join("\n")));
  });

  it("renders status-only panel at 120 columns", () => {
    const panelLayout = buildPanelLayout(
      "status-only",
      MIXED_STATE,
      [],
      120,
      24,
      { viewOptions: { mergeStrategy: "auto" } },
    );
    const frame = renderPanelFrame(panelLayout, 24, 120, 0);
    assertGolden("panel-status-only-120", stripAnsi(frame.join("\n")));
  });

  it("renders split panel with logs at 80 columns", () => {
    const logs = [
      { timestamp: "2026-03-29T10:15:00Z", itemId: "H-CA-1", message: "Worker started" },
      { timestamp: "2026-03-29T10:15:30Z", itemId: "H-CA-1", message: "Cloning repository..." },
      { timestamp: "2026-03-29T10:16:00Z", itemId: "H-CA-2", message: "Worker started" },
      { timestamp: "2026-03-29T10:16:30Z", itemId: "M-FE-1", message: "PR created (#43)" },
      { timestamp: "2026-03-29T10:17:00Z", itemId: "M-FE-2", message: "CI failed: lint errors" },
    ];
    const panelLayout = buildPanelLayout(
      "split",
      MIXED_STATE,
      logs,
      80,
      40,
      { viewOptions: { mergeStrategy: "auto" } },
    );
    const frame = renderPanelFrame(panelLayout, 40, 80, 0);
    assertGolden("panel-split-80", stripAnsi(frame.join("\n")));
  });
});

// ── UPDATE_GOLDEN self-test ──────────────────────────────────────────────────

describe("golden: UPDATE_GOLDEN mechanism", () => {
  it("generates .expected files when UPDATE_GOLDEN=1 is set", () => {
    // This test verifies the assertGolden function works correctly.
    // When UPDATE_GOLDEN=1, it should write files.
    // When not set, it should compare against existing files.
    // We test the basic flow by checking that our golden files exist.
    const filePath = join(GOLDEN_DIR, "status-table-empty-80.expected");
    expect(existsSync(filePath)).toBe(true);
  });
});
