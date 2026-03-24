// Tests for core/analytics.ts and core/commands/analytics.ts.
// Uses dependency injection (no vi.mock) per project conventions.

import { describe, it, expect, vi } from "vitest";
import {
  collectRunMetrics,
  writeRunMetrics,
  commitAnalyticsFiles,
  type RunMetrics,
  type AnalyticsIO,
  type AnalyticsCommitDeps,
} from "../core/analytics.ts";
import {
  loadRuns,
  computeSummary,
  formatAnalytics,
  trendArrow,
  type AnalyticsReadIO,
  type AnalyticsSummary,
} from "../core/commands/analytics.ts";
import {
  orchestrateLoop,
  type LogEntry,
  type OrchestrateLoopDeps,
  type OrchestrateLoopConfig,
} from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
  type OrchestratorConfig,
  type OrchestratorItem,
} from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(id: string, deps: string[] = []): TodoItem {
  return {
    id,
    priority: "high",
    title: `TODO ${id}`,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    lineNumber: 1,
    lineEndNumber: 5,
    repoAlias: "",
    rawText: `## ${id}\nTest todo`,
    filePaths: [],
    testPlan: "",
  };
}

function mockActionDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/todo-test",
      workspaceRef: "workspace:1",
    })),
    cleanSingleWorktree: vi.fn(() => true),
    prMerge: vi.fn(() => true),
    prComment: vi.fn(() => true),
    sendMessage: vi.fn(() => true),
    closeWorkspace: vi.fn(() => true),
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
    ...overrides,
  };
}

function mockAnalyticsIO(): AnalyticsIO & {
  mkdirSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
} {
  return {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  todosFile: "/tmp/test-project/TODOS.md",
  aiTool: "claude",
};

// ── collectRunMetrics ────────────────────────────────────────────────

describe("collectRunMetrics", () => {
  it("computes wall-clock duration and item counts", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
      {
        id: "T-1-2",
        todo: makeTodo("T-1-2"),
        state: "stuck",
        ciFailCount: 2,
        lastTransition: new Date().toISOString(),
      },
    ];

    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "asap",
      maxCiRetries: 2,
    };

    const start = "2026-03-24T10:00:00.000Z";
    const end = "2026-03-24T10:05:30.000Z";

    const metrics = collectRunMetrics(items, config, start, end, "claude");

    expect(metrics.runTimestamp).toBe(start);
    expect(metrics.wallClockMs).toBe(330_000); // 5min 30sec
    expect(metrics.itemsAttempted).toBe(2);
    expect(metrics.itemsCompleted).toBe(1);
    expect(metrics.itemsFailed).toBe(1);
    expect(metrics.mergeStrategy).toBe("asap");
  });

  it("tracks CI retry count per item", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
      {
        id: "T-1-2",
        todo: makeTodo("T-1-2"),
        state: "done",
        ciFailCount: 3,
        prNumber: 42,
        lastTransition: new Date().toISOString(),
      },
    ];

    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "approved",
      maxCiRetries: 3,
    };

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:01:00.000Z",
      "cursor",
    );

    expect(metrics.items).toHaveLength(2);
    expect(metrics.items[0]).toEqual({
      id: "T-1-1",
      state: "done",
      ciRetryCount: 0,
      tool: "cursor",
    });
    expect(metrics.items[1]).toEqual({
      id: "T-1-2",
      state: "done",
      ciRetryCount: 3,
      tool: "cursor",
      prNumber: 42,
    });
  });

  it("handles zero-item run gracefully", () => {
    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "asap",
      maxCiRetries: 2,
    };

    const metrics = collectRunMetrics(
      [],
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:00:01.000Z",
      "claude",
    );

    expect(metrics.itemsAttempted).toBe(0);
    expect(metrics.itemsCompleted).toBe(0);
    expect(metrics.itemsFailed).toBe(0);
    expect(metrics.items).toEqual([]);
    expect(metrics.wallClockMs).toBe(1000);
    expect(metrics.mergeStrategy).toBe("asap");
  });
});

// ── writeRunMetrics ──────────────────────────────────────────────────

describe("writeRunMetrics", () => {
  it("creates the analytics directory and writes a JSON file", () => {
    const io = mockAnalyticsIO();
    const metrics: RunMetrics = {
      runTimestamp: "2026-03-24T10:05:30.123Z",
      wallClockMs: 5000,
      itemsAttempted: 1,
      itemsCompleted: 1,
      itemsFailed: 0,
      mergeStrategy: "asap",
      items: [{ id: "T-1-1", state: "done", ciRetryCount: 0, tool: "claude" }],
    };

    const path = writeRunMetrics(metrics, "/tmp/.ninthwave/analytics", io);

    expect(io.mkdirSync).toHaveBeenCalledWith("/tmp/.ninthwave/analytics", { recursive: true });
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);

    const writtenPath = io.writeFileSync.mock.calls[0][0];
    expect(writtenPath).toContain("2026-03-24T10-05-30-123Z.json");
    expect(path).toBe(writtenPath);

    const writtenContent = JSON.parse(io.writeFileSync.mock.calls[0][1]);
    expect(writtenContent.runTimestamp).toBe("2026-03-24T10:05:30.123Z");
    expect(writtenContent.wallClockMs).toBe(5000);
    expect(writtenContent.items).toHaveLength(1);
  });

  it("names file by timestamp in filesystem-safe format", () => {
    const io = mockAnalyticsIO();
    const metrics: RunMetrics = {
      runTimestamp: "2026-01-15T23:59:59.999Z",
      wallClockMs: 0,
      itemsAttempted: 0,
      itemsCompleted: 0,
      itemsFailed: 0,
      mergeStrategy: "asap",
      items: [],
    };

    writeRunMetrics(metrics, "/analytics", io);

    const writtenPath = io.writeFileSync.mock.calls[0][0];
    expect(writtenPath).toBe("/analytics/2026-01-15T23-59-59-999Z.json");
    // No colons or dots in the filename
    const filename = writtenPath.split("/").pop()!;
    expect(filename).not.toContain(":");
    expect(filename.replace(".json", "")).not.toContain(".");
  });
});

// ── Integration: orchestrateLoop writes metrics ──────────────────────

describe("orchestrateLoop analytics integration", () => {
  it("writes metrics file on orchestrate_complete", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const io = mockAnalyticsIO();

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Metrics file was written
    expect(io.mkdirSync).toHaveBeenCalledWith("/tmp/.ninthwave/analytics", { recursive: true });
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);

    // Parse and validate written metrics
    const written = JSON.parse(io.writeFileSync.mock.calls[0][1]) as RunMetrics;
    expect(written.itemsAttempted).toBe(1);
    expect(written.itemsCompleted).toBe(1);
    expect(written.itemsFailed).toBe(0);
    expect(written.mergeStrategy).toBe("asap");
    expect(written.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(written.items).toHaveLength(1);
    expect(written.items[0].id).toBe("T-1-1");
    expect(written.items[0].tool).toBe("claude");

    // analytics_written log event was emitted
    expect(logs.some((l) => l.event === "analytics_written")).toBe(true);
  });

  it("includes CI retry count in metrics for items with failures", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const io = mockAnalyticsIO();

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3: // PR opened, CI fails
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "fail" }],
            readyIds: [],
          };
        case 4: // CI recovers
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      analyticsIO: io,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    const written = JSON.parse(io.writeFileSync.mock.calls[0][1]) as RunMetrics;
    expect(written.items[0].ciRetryCount).toBe(1);
  });

  it("skips analytics when analyticsDir is not configured", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      // No analyticsIO provided
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // No analytics events
    expect(logs.some((l) => l.event === "analytics_written")).toBe(false);
    expect(logs.some((l) => l.event === "analytics_error")).toBe(false);
  });

  it("handles analytics write failure gracefully", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const io: AnalyticsIO = {
      mkdirSync: vi.fn(() => {
        throw new Error("permission denied");
      }),
      writeFileSync: vi.fn(),
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    // Should not throw — analytics failure is non-fatal
    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Item still completes
    expect(orch.getItem("T-1-1")!.state).toBe("done");

    // Error was logged
    const errorLog = logs.find((l) => l.event === "analytics_error");
    expect(errorLog).toBeDefined();
    expect(errorLog!.error).toContain("permission denied");
  });

  it("handles zero-item run gracefully in the loop", async () => {
    // Create orchestrator with no items — all terminal immediately
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });

    const io = mockAnalyticsIO();
    const logs: LogEntry[] = [];

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: () => ({ items: [], readyIds: [] }),
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Metrics written even for zero items
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(io.writeFileSync.mock.calls[0][1]) as RunMetrics;
    expect(written.itemsAttempted).toBe(0);
    expect(written.itemsCompleted).toBe(0);
    expect(written.itemsFailed).toBe(0);
    expect(written.items).toEqual([]);
    expect(written.mergeStrategy).toBe("asap");
  });
});

// ── Analytics display command tests ──────────────────────────────────

function makeRun(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runTimestamp: "2026-03-24T10:00:00.000Z",
    wallClockMs: 300_000,
    itemsAttempted: 3,
    itemsCompleted: 2,
    itemsFailed: 1,
    mergeStrategy: "asap",
    items: [
      { id: "T-1-1", state: "done", ciRetryCount: 0, tool: "claude" },
      { id: "T-1-2", state: "done", ciRetryCount: 1, tool: "claude" },
      { id: "T-1-3", state: "stuck", ciRetryCount: 2, tool: "claude" },
    ],
    ...overrides,
  };
}

function mockReadIO(files: Record<string, string>): AnalyticsReadIO {
  return {
    existsSync: (path: string) => path in files || Object.keys(files).some((f) => f.startsWith(path + "/")),
    readdirSync: (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length));
    },
    readFileSync: (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

describe("loadRuns", () => {
  it("parses metrics files correctly", () => {
    const run1 = makeRun({ runTimestamp: "2026-03-24T10:00:00.000Z" });
    const run2 = makeRun({ runTimestamp: "2026-03-24T11:00:00.000Z", wallClockMs: 600_000 });

    const io = mockReadIO({
      "/project/.ninthwave/analytics/2026-03-24T10-00-00-000Z.json": JSON.stringify(run1),
      "/project/.ninthwave/analytics/2026-03-24T11-00-00-000Z.json": JSON.stringify(run2),
    });

    const runs = loadRuns("/project/.ninthwave/analytics", io);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.wallClockMs).toBe(300_000);
    expect(runs[1]!.wallClockMs).toBe(600_000);
  });

  it("returns empty array when directory does not exist", () => {
    const io = mockReadIO({});
    const runs = loadRuns("/nonexistent", io);
    expect(runs).toEqual([]);
  });

  it("skips malformed JSON files", () => {
    const validRun = makeRun();
    const io = mockReadIO({
      "/dir/bad.json": "not json{",
      "/dir/good.json": JSON.stringify(validRun),
    });

    const runs = loadRuns("/dir", io);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runTimestamp).toBe(validRun.runTimestamp);
  });

  it("sorts runs chronologically by filename", () => {
    const early = makeRun({ runTimestamp: "2026-03-24T08:00:00.000Z" });
    const late = makeRun({ runTimestamp: "2026-03-24T16:00:00.000Z" });

    const io = mockReadIO({
      "/dir/2026-03-24T16-00-00-000Z.json": JSON.stringify(late),
      "/dir/2026-03-24T08-00-00-000Z.json": JSON.stringify(early),
    });

    const runs = loadRuns("/dir", io);
    expect(runs[0]!.runTimestamp).toBe("2026-03-24T08:00:00.000Z");
    expect(runs[1]!.runTimestamp).toBe("2026-03-24T16:00:00.000Z");
  });
});

describe("computeSummary", () => {
  it("computes averages across multiple runs", () => {
    const runs = [
      makeRun({ wallClockMs: 200_000, itemsAttempted: 4, itemsCompleted: 3, itemsFailed: 1 }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        wallClockMs: 400_000,
        itemsAttempted: 6,
        itemsCompleted: 5,
        itemsFailed: 1,
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.totalRuns).toBe(2);
    expect(summary.avgWallClockMs).toBe(300_000);
    expect(summary.avgItemsPerBatch).toBe(5); // (4+6)/2
    expect(summary.totalItemsShipped).toBe(8); // 3+5
  });

  it("handles single run (no trend) gracefully", () => {
    const summary = computeSummary([makeRun()]);
    expect(summary.totalRuns).toBe(1);
    expect(summary.avgWallClockMs).toBe(300_000);
    expect(summary.latestWallClockMs).toBe(300_000);
    // Items per day with a single run = totalItemsShipped (span is 0)
    expect(summary.itemsPerDay).toBe(2);
  });

  it("handles zero runs", () => {
    const summary = computeSummary([]);
    expect(summary.totalRuns).toBe(0);
    expect(summary.totalItemsShipped).toBe(0);
    expect(summary.avgWallClockMs).toBe(0);
    expect(summary.ciRetryRate).toBe(0);
  });

  it("computes CI retry rate correctly", () => {
    const runs = [
      makeRun({
        itemsAttempted: 4,
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude" },
          { id: "B", state: "done", ciRetryCount: 2, tool: "claude" },
          { id: "C", state: "done", ciRetryCount: 0, tool: "claude" },
          { id: "D", state: "stuck", ciRetryCount: 1, tool: "claude" },
        ],
      }),
    ];

    const summary = computeSummary(runs);
    // 3 total retries / 4 items = 0.75
    expect(summary.ciRetryRate).toBe(0.75);
  });
});

describe("trendArrow", () => {
  it("shows up arrow when current > average", () => {
    const arrow = trendArrow(10, 5, true);
    expect(arrow).toContain("↑");
  });

  it("shows down arrow when current < average", () => {
    const arrow = trendArrow(3, 10, true);
    expect(arrow).toContain("↓");
  });

  it("shows right arrow when roughly equal", () => {
    const arrow = trendArrow(100, 102, true, 0.05);
    expect(arrow).toContain("→");
  });

  it("uses green for higher-is-better up", () => {
    // When higherIsBetter=true, going up is good (green)
    const arrow = trendArrow(10, 5, true);
    expect(arrow).toContain("↑");
  });

  it("uses red for higher-is-worse up (e.g., wall-clock time)", () => {
    // When higherIsBetter=false, going up is bad (red)
    const arrow = trendArrow(10, 5, false);
    expect(arrow).toContain("↑");
  });

  it("handles zero average", () => {
    const arrow = trendArrow(5, 0, true);
    expect(arrow).toContain("↑");
  });

  it("handles both zero", () => {
    const arrow = trendArrow(0, 0, true);
    expect(arrow).toContain("→");
  });
});

describe("formatAnalytics", () => {
  it("shows readable message when no data", () => {
    const summary = computeSummary([]);
    const lines = formatAnalytics(summary, false);
    expect(lines.join("\n")).toContain("No analytics data");
  });

  it("shows summary metrics for multiple runs", () => {
    const runs = [
      makeRun({ runTimestamp: "2026-03-24T10:00:00.000Z", wallClockMs: 200_000 }),
      makeRun({ runTimestamp: "2026-03-25T10:00:00.000Z", wallClockMs: 400_000 }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Analytics");
    expect(output).toContain("wall-clock");
    expect(output).toContain("items per batch");
    expect(output).toContain("CI retry rate");
    expect(output).toContain("Total items shipped");
    expect(output).toContain("Items per day");
  });

  it("shows last 10 runs by default", () => {
    const runs = Array.from({ length: 15 }, (_, i) =>
      makeRun({
        runTimestamp: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        wallClockMs: (i + 1) * 60_000,
      }),
    );
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    // Should show 15 total but only last 10 in table
    expect(output).toContain("15 total");
    // The first run (March 1) should NOT be in the output
    expect(output).not.toContain("2026-03-01");
    // The last run (March 15) should be in the output
    expect(output).toContain("2026-03-15");
  });

  it("--all flag includes all runs", () => {
    const runs = Array.from({ length: 15 }, (_, i) =>
      makeRun({
        runTimestamp: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        wallClockMs: (i + 1) * 60_000,
      }),
    );
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, true).join("\n");

    expect(output).toContain("All runs");
    // First run should now be visible
    expect(output).toContain("2026-03-01");
    expect(output).toContain("2026-03-15");
  });

  it("handles single run without trend arrows", () => {
    const summary = computeSummary([makeRun()]);
    const output = formatAnalytics(summary, false).join("\n");

    // Should not have trend arrows with a single run
    expect(output).not.toContain("↑");
    expect(output).not.toContain("↓");
    expect(output).not.toContain("→");
  });

  it("output is pipe-friendly (plain text)", () => {
    const summary = computeSummary([makeRun()]);
    const lines = formatAnalytics(summary, false);

    // All lines should be strings
    for (const line of lines) {
      expect(typeof line).toBe("string");
    }
    // Should be joinable for piping
    const output = lines.join("\n");
    expect(output.length).toBeGreaterThan(0);
  });
});

// ── commitAnalyticsFiles ──────────────────────────────────────────────

function mockCommitDeps(overrides?: Partial<AnalyticsCommitDeps>): AnalyticsCommitDeps & {
  hasChanges: ReturnType<typeof vi.fn>;
  gitAdd: ReturnType<typeof vi.fn>;
  getStagedFiles: ReturnType<typeof vi.fn>;
  gitCommit: ReturnType<typeof vi.fn>;
} {
  return {
    hasChanges: vi.fn(() => true),
    gitAdd: vi.fn(),
    getStagedFiles: vi.fn(() => [".ninthwave/analytics/2026-03-24T10-00-00-000Z.json"]),
    gitCommit: vi.fn(),
    ...overrides,
  };
}

describe("commitAnalyticsFiles", () => {
  it("commits when analytics files have changes", () => {
    const deps = mockCommitDeps();

    const result = commitAnalyticsFiles("/project", ".ninthwave/analytics", deps);

    expect(result.committed).toBe(true);
    expect(result.reason).toBe("committed");
    expect(deps.hasChanges).toHaveBeenCalledWith("/project", ".ninthwave/analytics");
    expect(deps.gitAdd).toHaveBeenCalledWith("/project", [".ninthwave/analytics"]);
    expect(deps.gitCommit).toHaveBeenCalledWith(
      "/project",
      "chore: update orchestration analytics",
    );
  });

  it("skips commit when no analytics files changed", () => {
    const deps = mockCommitDeps({
      hasChanges: vi.fn(() => false),
    });

    const result = commitAnalyticsFiles("/project", ".ninthwave/analytics", deps);

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("no_changes");
    expect(deps.gitAdd).not.toHaveBeenCalled();
    expect(deps.gitCommit).not.toHaveBeenCalled();
  });

  it("skips commit when non-analytics files are staged (dirty index)", () => {
    const deps = mockCommitDeps({
      getStagedFiles: vi.fn(() => [
        ".ninthwave/analytics/2026-03-24T10-00-00-000Z.json",
        "src/unrelated-file.ts",
      ]),
    });

    const result = commitAnalyticsFiles("/project", ".ninthwave/analytics", deps);

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("dirty_index");
    expect(deps.gitAdd).toHaveBeenCalled(); // analytics were staged
    expect(deps.gitCommit).not.toHaveBeenCalled(); // but commit was skipped
  });

  it("handles multiple analytics files", () => {
    const deps = mockCommitDeps({
      getStagedFiles: vi.fn(() => [
        ".ninthwave/analytics/2026-03-24T10-00-00-000Z.json",
        ".ninthwave/analytics/2026-03-24T11-00-00-000Z.json",
      ]),
    });

    const result = commitAnalyticsFiles("/project", ".ninthwave/analytics", deps);

    expect(result.committed).toBe(true);
    expect(result.reason).toBe("committed");
  });
});

// ── Integration: orchestrateLoop auto-commits analytics ──────────────

describe("orchestrateLoop analytics auto-commit", () => {
  it("auto-commits analytics files after writing metrics", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const io = mockAnalyticsIO();
    const commitDeps = mockCommitDeps();

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
      analyticsCommit: commitDeps,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Analytics were written
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);

    // Analytics were auto-committed
    expect(commitDeps.gitCommit).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.event === "analytics_committed")).toBe(true);
  });

  it("logs skip when no analytics changes to commit", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const io = mockAnalyticsIO();
    const commitDeps = mockCommitDeps({
      hasChanges: vi.fn(() => false),
    });

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
      analyticsCommit: commitDeps,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    expect(commitDeps.gitCommit).not.toHaveBeenCalled();
    expect(logs.some((l) => l.event === "analytics_commit_skipped")).toBe(true);
  });

  it("handles analytics commit failure gracefully", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const io = mockAnalyticsIO();
    const commitDeps = mockCommitDeps({
      gitCommit: vi.fn(() => { throw new Error("nothing to commit"); }),
    });

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
      analyticsCommit: commitDeps,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    // Should not throw
    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Item still completes
    expect(orch.getItem("T-1-1")!.state).toBe("done");

    // Error was logged
    const errorLog = logs.find((l) => l.event === "analytics_commit_error");
    expect(errorLog).toBeDefined();
    expect(errorLog!.error).toContain("nothing to commit");
  });

  it("skips auto-commit when analyticsCommit deps not provided", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const io = mockAnalyticsIO();

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      analyticsIO: io,
      // No analyticsCommit provided
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Analytics were written but no commit events
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.event === "analytics_committed")).toBe(false);
    expect(logs.some((l) => l.event === "analytics_commit_skipped")).toBe(false);
    expect(logs.some((l) => l.event === "analytics_commit_error")).toBe(false);
  });
});
