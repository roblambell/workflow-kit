// Tests for core/commands/history.ts — item state timeline display.

import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  loadSnapshots,
  extractTransitions,
  buildTimeline,
  resolveTitle,
  formatTimeline,
  type HistoryIO,
  type StateTransition,
  type TimelineEntry,
} from "../core/commands/history.ts";
import {
  userStateDir,
  stateArchiveDir,
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

/** Create a DaemonState snapshot with the given items. */
function makeState(
  startedAt: string,
  updatedAt: string,
  items: { id: string; state: string; title: string; lastTransition: string }[],
): DaemonState {
  return {
    pid: 1,
    startedAt,
    updatedAt,
    items: items.map((i) => ({
      id: i.id,
      state: i.state,
      prNumber: null,
      title: i.title,
      lastTransition: i.lastTransition,
      ciFailCount: 0,
      retryCount: 0,
    })),
  };
}

/** Create a mock IO backed by in-memory files. */
function createMockIO(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
): HistoryIO {
  return {
    existsSync: (path: string) => path in files || path in dirs,
    readdirSync: (path: string) => dirs[path] ?? [],
    readFileSync: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

// ── loadSnapshots ───────────────────────────────────────────────────

describe("loadSnapshots", () => {
  it("loads archive files and current state", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const archDir = stateArchiveDir(projectRoot);
      const curPath = stateFilePath(projectRoot);

      const archive1 = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:15:00.000Z",
        [{ id: "H-CR-1", state: "ready", title: "Test item", lastTransition: "2026-03-28T10:00:00.000Z" }],
      );
      const current = makeState(
        "2026-03-28T11:00:00.000Z",
        "2026-03-28T11:30:00.000Z",
        [{ id: "H-CR-1", state: "merged", title: "Test item", lastTransition: "2026-03-28T11:25:00.000Z" }],
      );

      const io = createMockIO(
        {
          [join(archDir, "orchestrator.state.2026-03-28T10-00-00-000Z.json")]: JSON.stringify(archive1),
          [curPath]: JSON.stringify(current),
        },
        {
          [archDir]: ["orchestrator.state.2026-03-28T10-00-00-000Z.json"],
        },
      );

      const snapshots = loadSnapshots(projectRoot, io);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]!.state.items[0]!.state).toBe("ready");
      expect(snapshots[1]!.state.items[0]!.state).toBe("merged");
    } finally {
      restoreHome();
    }
  });

  it("skips corrupt files gracefully", () => {
    setHome("/home/test");
    try {
      const projectRoot = "/project";
      const archDir = stateArchiveDir(projectRoot);

      const io = createMockIO(
        { [join(archDir, "corrupt.json")]: "not valid json {{{" },
        { [archDir]: ["corrupt.json"] },
      );

      const snapshots = loadSnapshots(projectRoot, io);
      expect(snapshots).toHaveLength(0);
    } finally {
      restoreHome();
    }
  });

  it("returns empty when no archive or current state", () => {
    setHome("/home/test");
    try {
      const io = createMockIO({}, {});
      const snapshots = loadSnapshots("/project", io);
      expect(snapshots).toHaveLength(0);
    } finally {
      restoreHome();
    }
  });
});

// ── extractTransitions ──────────────────────────────────────────────

describe("extractTransitions", () => {
  it("extracts transitions for a specific item across snapshots", () => {
    const snapshots = [
      {
        timestamp: "2026-03-28T10:15:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:15:00.000Z",
          [{ id: "H-CR-1", state: "ready", title: "Test", lastTransition: "2026-03-28T10:15:03.000Z" }],
        ),
      },
      {
        timestamp: "2026-03-28T10:17:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:17:00.000Z",
          [{ id: "H-CR-1", state: "launching", title: "Test", lastTransition: "2026-03-28T10:17:17.000Z" }],
        ),
      },
      {
        timestamp: "2026-03-28T10:29:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:29:00.000Z",
          [{ id: "H-CR-1", state: "implementing", title: "Test", lastTransition: "2026-03-28T10:17:25.000Z" }],
        ),
      },
    ];

    const transitions = extractTransitions("H-CR-1", snapshots);
    expect(transitions).toHaveLength(3);
    expect(transitions[0]!.state).toBe("ready");
    expect(transitions[1]!.state).toBe("launching");
    expect(transitions[2]!.state).toBe("implementing");
  });

  it("deduplicates consecutive identical states", () => {
    const snapshots = [
      {
        timestamp: "2026-03-28T10:00:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:00:00.000Z",
          [{ id: "H-CR-1", state: "implementing", title: "Test", lastTransition: "2026-03-28T10:00:00.000Z" }],
        ),
      },
      {
        timestamp: "2026-03-28T10:05:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:05:00.000Z",
          [{ id: "H-CR-1", state: "implementing", title: "Test", lastTransition: "2026-03-28T10:00:00.000Z" }],
        ),
      },
      {
        timestamp: "2026-03-28T10:10:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:10:00.000Z",
          [{ id: "H-CR-1", state: "implementing", title: "Test", lastTransition: "2026-03-28T10:00:00.000Z" }],
        ),
      },
      {
        timestamp: "2026-03-28T10:15:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:15:00.000Z",
          [{ id: "H-CR-1", state: "ci-pending", title: "Test", lastTransition: "2026-03-28T10:15:00.000Z" }],
        ),
      },
    ];

    const transitions = extractTransitions("H-CR-1", snapshots);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]!.state).toBe("implementing");
    expect(transitions[1]!.state).toBe("ci-pending");
  });

  it("returns empty for unknown item ID", () => {
    const snapshots = [
      {
        timestamp: "2026-03-28T10:00:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:00:00.000Z",
          [{ id: "H-CR-1", state: "implementing", title: "Test", lastTransition: "2026-03-28T10:00:00.000Z" }],
        ),
      },
    ];

    const transitions = extractTransitions("UNKNOWN-99", snapshots);
    expect(transitions).toHaveLength(0);
  });

  it("handles single-snapshot case", () => {
    const snapshots = [
      {
        timestamp: "2026-03-28T10:00:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:00:00.000Z",
          [{ id: "H-CR-1", state: "merged", title: "Test", lastTransition: "2026-03-28T10:31:38.000Z" }],
        ),
      },
    ];

    const transitions = extractTransitions("H-CR-1", snapshots);
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
  it("resolves title from snapshots", () => {
    const snapshots = [
      {
        timestamp: "2026-03-28T10:00:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:00:00.000Z",
          [{ id: "H-CR-1", state: "ready", title: "Rename watch.ts to pr-monitor.ts", lastTransition: "2026-03-28T10:00:00.000Z" }],
        ),
      },
    ];

    expect(resolveTitle("H-CR-1", snapshots)).toBe("Rename watch.ts to pr-monitor.ts");
  });

  it("returns null for unknown ID", () => {
    const snapshots = [
      {
        timestamp: "2026-03-28T10:00:00.000Z",
        state: makeState(
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:00:00.000Z",
          [{ id: "H-CR-1", state: "ready", title: "Test", lastTransition: "2026-03-28T10:00:00.000Z" }],
        ),
      },
    ];

    expect(resolveTitle("UNKNOWN-1", snapshots)).toBeNull();
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
      const archDir = stateArchiveDir(projectRoot);
      const curPath = stateFilePath(projectRoot);

      // Simulate multiple archive snapshots capturing state changes
      const snap1 = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:15:00.000Z",
        [{ id: "H-CR-1", state: "ready", title: "Rename watch.ts", lastTransition: "2026-03-28T10:15:03.000Z" }],
      );
      const snap2 = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:17:00.000Z",
        [{ id: "H-CR-1", state: "launching", title: "Rename watch.ts", lastTransition: "2026-03-28T10:17:17.000Z" }],
      );
      const snap3 = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:20:00.000Z",
        [{ id: "H-CR-1", state: "implementing", title: "Rename watch.ts", lastTransition: "2026-03-28T10:17:25.000Z" }],
      );
      const snap4 = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:30:00.000Z",
        [{ id: "H-CR-1", state: "ci-pending", title: "Rename watch.ts", lastTransition: "2026-03-28T10:29:28.000Z" }],
      );
      const snap5 = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:31:00.000Z",
        [{ id: "H-CR-1", state: "ci-passed", title: "Rename watch.ts", lastTransition: "2026-03-28T10:31:13.000Z" }],
      );
      // Current state = merged
      const currentState = makeState(
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:32:00.000Z",
        [{ id: "H-CR-1", state: "merged", title: "Rename watch.ts", lastTransition: "2026-03-28T10:31:38.000Z" }],
      );

      const io = createMockIO(
        {
          [join(archDir, "orchestrator.state.2026-03-28T10-00-00-000Z.json")]: JSON.stringify(snap1),
          [join(archDir, "orchestrator.state.2026-03-28T10-17-00-000Z.json")]: JSON.stringify(snap2),
          [join(archDir, "orchestrator.state.2026-03-28T10-20-00-000Z.json")]: JSON.stringify(snap3),
          [join(archDir, "orchestrator.state.2026-03-28T10-30-00-000Z.json")]: JSON.stringify(snap4),
          [join(archDir, "orchestrator.state.2026-03-28T10-31-00-000Z.json")]: JSON.stringify(snap5),
          [curPath]: JSON.stringify(currentState),
        },
        {
          [archDir]: [
            "orchestrator.state.2026-03-28T10-00-00-000Z.json",
            "orchestrator.state.2026-03-28T10-17-00-000Z.json",
            "orchestrator.state.2026-03-28T10-20-00-000Z.json",
            "orchestrator.state.2026-03-28T10-30-00-000Z.json",
            "orchestrator.state.2026-03-28T10-31-00-000Z.json",
          ],
        },
      );

      const snapshots = loadSnapshots(projectRoot, io);
      const transitions = extractTransitions("H-CR-1", snapshots);
      const timeline = buildTimeline(transitions);
      const title = resolveTitle("H-CR-1", snapshots);

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
