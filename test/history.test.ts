// Tests for core/commands/history.ts -- item state timeline display.
// Now reads transition events from structured JSONL log files.

import { describe, it, expect } from "vitest";
import {
  loadSnapshots,
  extractTransitions,
  buildTimeline,
  resolveTitle,
  formatTimeline,
  type HistoryIO,
  type StateTransition,
  type TimelineEntry,
  type LogTransitionEvent,
} from "../core/commands/history.ts";
import {
  logFilePath,
  stateFilePath,
  type DaemonState,
} from "../core/daemon.ts";

// ── Helpers ──────────────────────────────────────────────────────────

const origHome = process.env.HOME;

function setHome(home: string) {
  process.env.HOME = home;
}

function restoreHome() {
  process.env.HOME = origHome;
}

/** Build a JSONL log line for a transition event. */
function transitionLine(
  itemId: string,
  from: string,
  to: string,
  ts: string,
): string {
  return JSON.stringify({ ts, level: "info", event: "transition", itemId, from, to });
}

/** Build a JSONL log line for a non-transition event (should be ignored). */
function otherLine(event: string, ts: string): string {
  return JSON.stringify({ ts, level: "info", event });
}

/** Create a mock HistoryIO backed by in-memory files. */
function createMockIO(files: Record<string, string>): HistoryIO {
  return {
    existsSync: (path: string) => path in files,
    readFileSync: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

// ── loadSnapshots ───────────────────────────────────────────────────

describe("loadSnapshots", () => {
  it("loads transition events from the log file", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const logPath = logFilePath(projectRoot);

      const logContent = [
        transitionLine("H-CR-1", "queued", "ready", "2026-03-28T10:00:00.000Z"),
        otherLine("poll_complete", "2026-03-28T10:00:01.000Z"),
        transitionLine("H-CR-1", "ready", "launching", "2026-03-28T10:01:00.000Z"),
      ].join("\n");

      const io = createMockIO({ [logPath]: logContent });
      const events = loadSnapshots(projectRoot, io);

      expect(events).toHaveLength(2);
      expect(events[0]!.itemId).toBe("H-CR-1");
      expect(events[0]!.to).toBe("ready");
      expect(events[1]!.to).toBe("launching");
    } finally {
      restoreHome();
    }
  });

  it("loads from rotated log files in chronological order", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const logPath = logFilePath(projectRoot);

      const rotated1 = transitionLine("H-CR-1", "queued", "ready", "2026-03-28T08:00:00.000Z");
      const current = transitionLine("H-CR-1", "ready", "launching", "2026-03-28T10:00:00.000Z");

      const io = createMockIO({
        [`${logPath}.1`]: rotated1,
        [logPath]: current,
      });

      const events = loadSnapshots(projectRoot, io);
      expect(events).toHaveLength(2);
      // Oldest first
      expect(events[0]!.to).toBe("ready");
      expect(events[1]!.to).toBe("launching");
    } finally {
      restoreHome();
    }
  });

  it("skips malformed JSON lines gracefully", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const logPath = logFilePath(projectRoot);

      const logContent = [
        "not valid json {{{",
        transitionLine("H-CR-1", "queued", "ready", "2026-03-28T10:00:00.000Z"),
        "",
      ].join("\n");

      const io = createMockIO({ [logPath]: logContent });
      const events = loadSnapshots(projectRoot, io);
      expect(events).toHaveLength(1);
      expect(events[0]!.to).toBe("ready");
    } finally {
      restoreHome();
    }
  });

  it("returns empty when no log files exist", () => {
    setHome("/home/test");
    try {
      const io = createMockIO({});
      const events = loadSnapshots("/project", io);
      expect(events).toHaveLength(0);
    } finally {
      restoreHome();
    }
  });

  it("returns empty for empty log file", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const logPath = logFilePath(projectRoot);
      const io = createMockIO({ [logPath]: "" });
      const events = loadSnapshots(projectRoot, io);
      expect(events).toHaveLength(0);
    } finally {
      restoreHome();
    }
  });
});

// ── extractTransitions ──────────────────────────────────────────────

describe("extractTransitions", () => {
  it("extracts transitions for a specific item", () => {
    const events: LogTransitionEvent[] = [
      { ts: "2026-03-28T10:15:03.000Z", itemId: "H-CR-1", from: "queued", to: "ready" },
      { ts: "2026-03-28T10:17:17.000Z", itemId: "H-CR-1", from: "ready", to: "launching" },
      { ts: "2026-03-28T10:17:25.000Z", itemId: "H-CR-1", from: "launching", to: "implementing" },
    ];

    const transitions = extractTransitions("H-CR-1", events);
    expect(transitions).toHaveLength(3);
    expect(transitions[0]!.state).toBe("ready");
    expect(transitions[1]!.state).toBe("launching");
    expect(transitions[2]!.state).toBe("implementing");
  });

  it("filters out other items", () => {
    const events: LogTransitionEvent[] = [
      { ts: "2026-03-28T10:00:00.000Z", itemId: "H-CR-1", from: "queued", to: "ready" },
      { ts: "2026-03-28T10:01:00.000Z", itemId: "H-OTHER-1", from: "queued", to: "ready" },
      { ts: "2026-03-28T10:02:00.000Z", itemId: "H-CR-1", from: "ready", to: "launching" },
    ];

    const transitions = extractTransitions("H-CR-1", events);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]!.state).toBe("ready");
    expect(transitions[1]!.state).toBe("launching");
  });

  it("deduplicates consecutive identical states", () => {
    const events: LogTransitionEvent[] = [
      { ts: "2026-03-28T10:00:00.000Z", itemId: "H-CR-1", from: "queued", to: "implementing" },
      { ts: "2026-03-28T10:05:00.000Z", itemId: "H-CR-1", from: "queued", to: "implementing" },
      { ts: "2026-03-28T10:15:00.000Z", itemId: "H-CR-1", from: "implementing", to: "ci-pending" },
    ];

    const transitions = extractTransitions("H-CR-1", events);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]!.state).toBe("implementing");
    expect(transitions[1]!.state).toBe("ci-pending");
  });

  it("returns empty for unknown item ID", () => {
    const events: LogTransitionEvent[] = [
      { ts: "2026-03-28T10:00:00.000Z", itemId: "H-CR-1", from: "queued", to: "ready" },
    ];

    const transitions = extractTransitions("UNKNOWN-99", events);
    expect(transitions).toHaveLength(0);
  });

  it("handles single event", () => {
    const events: LogTransitionEvent[] = [
      { ts: "2026-03-28T10:31:38.000Z", itemId: "H-CR-1", from: "ci-passed", to: "merged" },
    ];

    const transitions = extractTransitions("H-CR-1", events);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.state).toBe("merged");
    expect(transitions[0]!.timestamp).toBe("2026-03-28T10:31:38.000Z");
  });
});

// ── buildTimeline ───────────────────────────────────────────────────

describe("buildTimeline", () => {
  it("calculates durations between transitions", () => {
    const transitions: StateTransition[] = [
      { state: "ready", timestamp: "2026-03-28T10:15:03.000Z" },
      { state: "launching", timestamp: "2026-03-28T10:17:17.000Z" },
      { state: "implementing", timestamp: "2026-03-28T10:17:25.000Z" },
    ];

    const timeline = buildTimeline(transitions);
    expect(timeline).toHaveLength(3);

    // ready → launching: 2m 14s = 134000ms
    expect(timeline[0]!.state).toBe("ready");
    expect(timeline[0]!.durationMs).toBe(134000);

    // launching → implementing: 8s = 8000ms
    expect(timeline[1]!.state).toBe("launching");
    expect(timeline[1]!.durationMs).toBe(8000);

    // implementing (final): no duration
    expect(timeline[2]!.state).toBe("implementing");
    expect(timeline[2]!.durationMs).toBeNull();
  });

  it("returns empty for empty transitions", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  it("handles single transition (no duration)", () => {
    const transitions: StateTransition[] = [
      { state: "merged", timestamp: "2026-03-28T10:31:38.000Z" },
    ];

    const timeline = buildTimeline(transitions);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.durationMs).toBeNull();
  });
});

// ── resolveTitle ────────────────────────────────────────────────────

describe("resolveTitle", () => {
  it("resolves title from current state file", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const curPath = stateFilePath(projectRoot);

      const state: DaemonState = {
        pid: 1,
        startedAt: "2026-03-28T10:00:00.000Z",
        updatedAt: "2026-03-28T10:00:00.000Z",
        items: [{
          id: "H-CR-1",
          state: "merged",
          prNumber: 42,
          title: "Rename watch.ts to pr-monitor.ts",
          lastTransition: "2026-03-28T10:00:00.000Z",
          ciFailCount: 0,
          retryCount: 0,
        }],
      };

      const io = createMockIO({ [curPath]: JSON.stringify(state) });
      expect(resolveTitle("H-CR-1", projectRoot, io)).toBe("Rename watch.ts to pr-monitor.ts");
    } finally {
      restoreHome();
    }
  });

  it("returns null for unknown ID", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const curPath = stateFilePath(projectRoot);

      const state: DaemonState = {
        pid: 1,
        startedAt: "2026-03-28T10:00:00.000Z",
        updatedAt: "2026-03-28T10:00:00.000Z",
        items: [{
          id: "H-CR-1",
          state: "ready",
          prNumber: null,
          title: "Test",
          lastTransition: "2026-03-28T10:00:00.000Z",
          ciFailCount: 0,
          retryCount: 0,
        }],
      };

      const io = createMockIO({ [curPath]: JSON.stringify(state) });
      expect(resolveTitle("UNKNOWN-1", projectRoot, io)).toBeNull();
    } finally {
      restoreHome();
    }
  });

  it("returns null when no state file exists", () => {
    setHome("/home/test");
    try {
      const io = createMockIO({});
      expect(resolveTitle("H-CR-1", "/project", io)).toBeNull();
    } finally {
      restoreHome();
    }
  });
});

// ── formatTimeline ──────────────────────────────────────────────────

describe("formatTimeline", () => {
  it("shows helpful message for unknown items", () => {
    const lines = formatTimeline("UNKNOWN-1", null, []);
    expect(lines.some((l) => l.includes("No history found for UNKNOWN-1"))).toBe(true);
    expect(lines.some((l) => l.includes("nw list"))).toBe(true);
  });

  it("displays timeline entries with state, timestamp, and duration", () => {
    const timeline: TimelineEntry[] = [
      { state: "ready", timestamp: "2026-03-28T10:15:03.000Z", durationMs: 134000 },
      { state: "launching", timestamp: "2026-03-28T10:17:17.000Z", durationMs: 8000 },
      { state: "implementing", timestamp: "2026-03-28T10:17:25.000Z", durationMs: null },
    ];

    const lines = formatTimeline("H-CR-1", "Test item", timeline);

    // Header should contain ID and title
    expect(lines[0]).toContain("H-CR-1");
    expect(lines[0]).toContain("Test item");

    // Check timeline entries contain state names
    const content = lines.join("\n");
    expect(content).toContain("ready");
    expect(content).toContain("launching");
    expect(content).toContain("implementing");

    // Duration should appear for non-final entries
    expect(content).toContain("2m 14s");
    expect(content).toContain("8s");
  });

  it("shows total wall-clock time when multiple entries exist", () => {
    const timeline: TimelineEntry[] = [
      { state: "ready", timestamp: "2026-03-28T10:15:03.000Z", durationMs: 134000 },
      { state: "merged", timestamp: "2026-03-28T10:31:38.000Z", durationMs: null },
    ];

    const lines = formatTimeline("H-CR-1", "Test", timeline);
    const content = lines.join("\n");
    expect(content).toContain("Total:");
    expect(content).toContain("16m 35s");
  });

  it("omits total for single-entry timeline", () => {
    const timeline: TimelineEntry[] = [
      { state: "merged", timestamp: "2026-03-28T10:31:38.000Z", durationMs: null },
    ];

    const lines = formatTimeline("H-CR-1", "Test", timeline);
    const content = lines.join("\n");
    expect(content).not.toContain("Total:");
  });
});

// ── Full lifecycle integration ──────────────────────────────────────

describe("full lifecycle integration", () => {
  it("traces item through ready → launching → implementing → ci-pending → ci-passed → merged", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const logPath = logFilePath(projectRoot);
      const curPath = stateFilePath(projectRoot);

      // Simulate log events for the full lifecycle
      const logContent = [
        transitionLine("H-CR-1", "queued", "ready", "2026-03-28T10:15:03.000Z"),
        transitionLine("H-CR-1", "ready", "launching", "2026-03-28T10:17:17.000Z"),
        transitionLine("H-CR-1", "launching", "implementing", "2026-03-28T10:17:25.000Z"),
        transitionLine("H-CR-1", "implementing", "ci-pending", "2026-03-28T10:29:28.000Z"),
        transitionLine("H-CR-1", "ci-pending", "ci-passed", "2026-03-28T10:31:13.000Z"),
        transitionLine("H-CR-1", "ci-passed", "merged", "2026-03-28T10:31:38.000Z"),
      ].join("\n");

      // Current state for title resolution
      const currentState: DaemonState = {
        pid: 1,
        startedAt: "2026-03-28T10:00:00.000Z",
        updatedAt: "2026-03-28T10:32:00.000Z",
        items: [{
          id: "H-CR-1",
          state: "merged",
          prNumber: 42,
          title: "Rename watch.ts",
          lastTransition: "2026-03-28T10:31:38.000Z",
          ciFailCount: 0,
          retryCount: 0,
        }],
      };

      const io = createMockIO({
        [logPath]: logContent,
        [curPath]: JSON.stringify(currentState),
      });

      const events = loadSnapshots(projectRoot, io);
      const transitions = extractTransitions("H-CR-1", events);
      const timeline = buildTimeline(transitions);
      const title = resolveTitle("H-CR-1", projectRoot, io);

      // Verify full lifecycle
      expect(transitions).toHaveLength(6);
      expect(transitions.map((t) => t.state)).toEqual([
        "ready",
        "launching",
        "implementing",
        "ci-pending",
        "ci-passed",
        "merged",
      ]);

      expect(title).toBe("Rename watch.ts");

      // Verify timeline durations
      expect(timeline[0]!.durationMs).toBe(134000); // ready → launching: 2m 14s
      expect(timeline[1]!.durationMs).toBe(8000);   // launching → implementing: 8s
      expect(timeline[2]!.durationMs).toBe(723000);  // implementing → ci-pending: 12m 3s
      expect(timeline[3]!.durationMs).toBe(105000);  // ci-pending → ci-passed: 1m 45s
      expect(timeline[4]!.durationMs).toBe(25000);   // ci-passed → merged: 25s
      expect(timeline[5]!.durationMs).toBeNull();     // merged (final)

      // Verify formatted output
      const lines = formatTimeline("H-CR-1", title, timeline);
      const output = lines.join("\n");
      expect(output).toContain("H-CR-1");
      expect(output).toContain("Rename watch.ts");
      expect(output).toContain("ready");
      expect(output).toContain("merged");
      expect(output).toContain("Total:");
    } finally {
      restoreHome();
    }
  });
});
