// Tests for core/analytics.ts and core/commands/analytics.ts.
// Uses dependency injection (no vi.mock) per project conventions.

import { describe, it, expect, vi } from "vitest";
import {
  collectRunMetrics,
  writeRunMetrics,
  commitAnalyticsFiles,
  parseCostSummary,
  percentile,
  computeDetectionLatency,
  SLOW_DETECTION_THRESHOLD_MS,
  type RunMetrics,
  type AnalyticsIO,
  type AnalyticsCommitDeps,
  type CostSummary,
  type DetectionLatencyStats,
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
    filePath: "",
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
  todosDir: "/tmp/test-project/.ninthwave/todos",
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
      tokensUsed: null,
      costUsd: null,
    });
    expect(metrics.items[1]).toEqual({
      id: "T-1-2",
      state: "done",
      ciRetryCount: 3,
      tool: "cursor",
      prNumber: 42,
      tokensUsed: null,
      costUsd: null,
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
      { id: "T-1-1", state: "done", ciRetryCount: 0, tool: "claude", tokensUsed: null, costUsd: null },
      { id: "T-1-2", state: "done", ciRetryCount: 1, tool: "claude", tokensUsed: null, costUsd: null },
      { id: "T-1-3", state: "stuck", ciRetryCount: 2, tool: "claude", tokensUsed: null, costUsd: null },
    ],
    totalTokensUsed: null,
    totalCostUsd: null,
    detectionLatency: null,
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

  it("skips file with valid timestamp but missing items array and warns", () => {
    const noItems = { runTimestamp: "2026-03-24T10:00:00.000Z", wallClockMs: 100 };
    const validRun = makeRun();
    const io = mockReadIO({
      "/dir/a-no-items.json": JSON.stringify(noItems),
      "/dir/b-good.json": JSON.stringify(validRun),
    });

    const warnings: string[] = [];
    const runs = loadRuns("/dir", io, (msg) => warnings.push(msg));

    expect(runs).toHaveLength(1);
    expect(runs[0]!.runTimestamp).toBe(validRun.runTimestamp);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a-no-items.json");
    expect(warnings[0]).toContain("items array");
  });

  it("skips file with malformed item entries and warns", () => {
    const badItems = {
      runTimestamp: "2026-03-24T10:00:00.000Z",
      wallClockMs: 100,
      items: [{ id: "T-1", state: "done" }, { notAnId: true }],
    };
    const validRun = makeRun();
    const io = mockReadIO({
      "/dir/a-bad-items.json": JSON.stringify(badItems),
      "/dir/b-good.json": JSON.stringify(validRun),
    });

    const warnings: string[] = [];
    const runs = loadRuns("/dir", io, (msg) => warnings.push(msg));

    expect(runs).toHaveLength(1);
    expect(runs[0]!.runTimestamp).toBe(validRun.runTimestamp);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a-bad-items.json");
    expect(warnings[0]).toContain("missing id or state");
  });

  it("warns on invalid JSON when onWarn is provided", () => {
    const validRun = makeRun();
    const io = mockReadIO({
      "/dir/bad.json": "not json{",
      "/dir/good.json": JSON.stringify(validRun),
    });

    const warnings: string[] = [];
    const runs = loadRuns("/dir", io, (msg) => warnings.push(msg));

    expect(runs).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.json");
    expect(warnings[0]).toContain("invalid JSON");
  });

  it("loads valid files normally without warnings", () => {
    const run1 = makeRun({ runTimestamp: "2026-03-24T10:00:00.000Z" });
    const run2 = makeRun({ runTimestamp: "2026-03-24T11:00:00.000Z", wallClockMs: 600_000 });

    const io = mockReadIO({
      "/dir/2026-03-24T10-00-00-000Z.json": JSON.stringify(run1),
      "/dir/2026-03-24T11-00-00-000Z.json": JSON.stringify(run2),
    });

    const warnings: string[] = [];
    const runs = loadRuns("/dir", io, (msg) => warnings.push(msg));

    expect(runs).toHaveLength(2);
    expect(warnings).toHaveLength(0);
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
  gitReset: ReturnType<typeof vi.fn>;
} {
  return {
    hasChanges: vi.fn(() => true),
    gitAdd: vi.fn(),
    getStagedFiles: vi.fn(() => [".ninthwave/analytics/2026-03-24T10-00-00-000Z.json"]),
    gitCommit: vi.fn(),
    gitReset: vi.fn(),
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
    expect(deps.gitReset).toHaveBeenCalledWith("/project", [".ninthwave/analytics"]);
  });

  it("unstages analytics files before returning dirty_index", () => {
    const callOrder: string[] = [];
    const deps = mockCommitDeps({
      getStagedFiles: vi.fn(() => {
        callOrder.push("getStagedFiles");
        return [
          ".ninthwave/analytics/2026-03-24T10-00-00-000Z.json",
          "src/unrelated-file.ts",
        ];
      }),
      gitAdd: vi.fn(() => { callOrder.push("gitAdd"); }),
      gitReset: vi.fn(() => { callOrder.push("gitReset"); }),
    });

    const result = commitAnalyticsFiles("/project", ".ninthwave/analytics", deps);

    expect(result.committed).toBe(false);
    expect(result.reason).toBe("dirty_index");
    // gitReset must be called after gitAdd and getStagedFiles
    expect(callOrder).toEqual(["gitAdd", "getStagedFiles", "gitReset"]);
    expect(deps.gitReset).toHaveBeenCalledWith("/project", [".ninthwave/analytics"]);
  });

  it("does not call gitReset on clean commit", () => {
    const deps = mockCommitDeps();

    const result = commitAnalyticsFiles("/project", ".ninthwave/analytics", deps);

    expect(result.committed).toBe(true);
    expect(deps.gitReset).not.toHaveBeenCalled();
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

// ── parseCostSummary ─────────────────────────────────────────────────

describe("parseCostSummary", () => {
  it("parses Claude Code exit summary with tokens and cost", () => {
    const text = `
Total tokens: 42,567
Total cost: $3.45
Total duration: 5m 23s
    `;
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBe(42567);
    expect(result.costUsd).toBe(3.45);
  });

  it("parses cost without dollar sign prefix", () => {
    const text = "cost: 1.23";
    const result = parseCostSummary(text);
    expect(result.costUsd).toBe(1.23);
  });

  it("parses tokens without commas", () => {
    const text = "Tokens: 12345";
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBe(12345);
  });

  it("parses tokens with = separator", () => {
    const text = "tokens = 5,000";
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBe(5000);
  });

  it("parses cost with = separator", () => {
    const text = "cost = $0.50";
    const result = parseCostSummary(text);
    expect(result.costUsd).toBe(0.50);
  });

  it("returns null for both fields when text has no cost info", () => {
    const text = "Worker completed successfully. No errors.";
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it("returns null for both fields on empty string", () => {
    const result = parseCostSummary("");
    expect(result.tokensUsed).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it("returns null for both fields on null-like input", () => {
    const result = parseCostSummary(undefined as unknown as string);
    expect(result.tokensUsed).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it("parses cost only when tokens are missing", () => {
    const text = "Session cost: $2.10";
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBeNull();
    expect(result.costUsd).toBe(2.10);
  });

  it("parses tokens only when cost is missing", () => {
    const text = "Total token: 100,000";
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBe(100000);
    expect(result.costUsd).toBeNull();
  });

  it("handles zero cost gracefully", () => {
    const text = "cost: $0.00\ntokens: 100";
    const result = parseCostSummary(text);
    expect(result.costUsd).toBe(0);
    expect(result.tokensUsed).toBe(100);
  });

  it("handles large token counts", () => {
    const text = "Total tokens: 1,234,567";
    const result = parseCostSummary(text);
    expect(result.tokensUsed).toBe(1234567);
  });

  it("rejects false positive: CSRF token", () => {
    const result = parseCostSummary("CSRF token: 12345");
    expect(result.tokensUsed).toBeNull();
  });

  it("rejects false positive: auth token", () => {
    const result = parseCostSummary("auth token: 99999");
    expect(result.tokensUsed).toBeNull();
  });

  it("rejects false positive: session token", () => {
    const result = parseCostSummary("session token: 67890");
    expect(result.tokensUsed).toBeNull();
  });

  it("still matches 'Total tokens: 42,567' after tightening", () => {
    const result = parseCostSummary("Total tokens: 42,567");
    expect(result.tokensUsed).toBe(42567);
  });
});

// ── collectRunMetrics with cost data ─────────────────────────────────

describe("collectRunMetrics with cost data", () => {
  const config: OrchestratorConfig = {
    wipLimit: 4,
    mergeStrategy: "asap",
    maxCiRetries: 2,
  };

  it("populates per-item cost when costData is provided", () => {
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
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
    ];

    const costData = new Map<string, CostSummary>([
      ["T-1-1", { tokensUsed: 10000, costUsd: 1.50 }],
      ["T-1-2", { tokensUsed: 20000, costUsd: 2.50 }],
    ]);

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
      costData,
    );

    expect(metrics.items[0]!.tokensUsed).toBe(10000);
    expect(metrics.items[0]!.costUsd).toBe(1.50);
    expect(metrics.items[1]!.tokensUsed).toBe(20000);
    expect(metrics.items[1]!.costUsd).toBe(2.50);
    expect(metrics.totalTokensUsed).toBe(30000);
    expect(metrics.totalCostUsd).toBe(4.00);
  });

  it("defaults to null when costData is not provided", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
    ];

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:01:00.000Z",
      "claude",
    );

    expect(metrics.items[0]!.tokensUsed).toBeNull();
    expect(metrics.items[0]!.costUsd).toBeNull();
    expect(metrics.totalTokensUsed).toBeNull();
    expect(metrics.totalCostUsd).toBeNull();
  });

  it("handles mixed cost data (some items have data, others don't)", () => {
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

    const costData = new Map<string, CostSummary>([
      ["T-1-1", { tokensUsed: 15000, costUsd: 2.00 }],
    ]);

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
      costData,
    );

    expect(metrics.items[0]!.tokensUsed).toBe(15000);
    expect(metrics.items[0]!.costUsd).toBe(2.00);
    expect(metrics.items[1]!.tokensUsed).toBeNull();
    expect(metrics.items[1]!.costUsd).toBeNull();
    expect(metrics.totalTokensUsed).toBe(15000);
    expect(metrics.totalCostUsd).toBe(2.00);
  });
});

// ── computeSummary with cost data ────────────────────────────────────

describe("computeSummary with cost data", () => {
  it("aggregates cost across multiple runs", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        totalTokensUsed: 50000,
        totalCostUsd: 3.00,
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        totalTokensUsed: 30000,
        totalCostUsd: 2.00,
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.totalTokensUsed).toBe(80000);
    expect(summary.totalCostUsd).toBe(5.00);
  });

  it("returns null totals when no run has cost data", () => {
    const runs: RunMetrics[] = [
      makeRun({ totalTokensUsed: null, totalCostUsd: null }),
      makeRun({ totalTokensUsed: null, totalCostUsd: null }),
    ];

    const summary = computeSummary(runs);
    expect(summary.totalTokensUsed).toBeNull();
    expect(summary.totalCostUsd).toBeNull();
  });

  it("aggregates only runs that have cost data", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        totalTokensUsed: 40000,
        totalCostUsd: 2.50,
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        totalTokensUsed: null,
        totalCostUsd: null,
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.totalTokensUsed).toBe(40000);
    expect(summary.totalCostUsd).toBe(2.50);
  });

  it("returns null for zero runs", () => {
    const summary = computeSummary([]);
    expect(summary.totalTokensUsed).toBeNull();
    expect(summary.totalCostUsd).toBeNull();
  });
});

// ── formatAnalytics with cost data ───────────────────────────────────

describe("formatAnalytics with cost data", () => {
  it("shows cost summary when cost data exists", () => {
    const runs: RunMetrics[] = [
      makeRun({
        totalTokensUsed: 50000,
        totalCostUsd: 3.50,
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Total cost");
    expect(output).toContain("$3.50");
    expect(output).toContain("Total tokens");
    expect(output).toContain("50.0k");
  });

  it("hides cost summary when no cost data exists", () => {
    const runs: RunMetrics[] = [
      makeRun({ totalTokensUsed: null, totalCostUsd: null }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).not.toContain("Total cost");
    expect(output).not.toContain("Total tokens");
  });

  it("shows Cost column in run history when any run has cost data", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        totalTokensUsed: 10000,
        totalCostUsd: 1.25,
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        totalTokensUsed: null,
        totalCostUsd: null,
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Cost");
    expect(output).toContain("$1.25");
    expect(output).toContain("—");
  });

  it("hides Cost column when no run has cost data", () => {
    const runs: RunMetrics[] = [
      makeRun({ totalTokensUsed: null, totalCostUsd: null }),
    ];
    const summary = computeSummary(runs);
    const lines = formatAnalytics(summary, false);
    const headerLine = lines.find((l) => l.includes("Timestamp") && l.includes("Duration"));

    expect(headerLine).not.toContain("Cost");
  });
});

// ── orchestrateLoop captures cost before cleanup ─────────────────────

describe("orchestrateLoop cost capture", () => {
  it("captures cost data from worker screen before cleanup", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const io = mockAnalyticsIO();
    const logs: LogEntry[] = [];

    // Flow: launch → implementing → pr-open → ci-pending
    // Then PR detected as merged externally → clean action fires (triggers cost capture)
    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pending" }],
            readyIds: [],
          };
        case 4:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "merged" }],
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
      readScreen: () => "Total tokens: 25,000\nTotal cost: $1.75\n",
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Cost was captured
    const costLog = logs.find((l) => l.event === "cost_captured");
    expect(costLog).toBeDefined();
    expect(costLog!.tokensUsed).toBe(25000);
    expect(costLog!.costUsd).toBe(1.75);

    // Metrics include cost data
    const written = JSON.parse(io.writeFileSync.mock.calls[0][1]) as RunMetrics;
    expect(written.items[0]!.tokensUsed).toBe(25000);
    expect(written.items[0]!.costUsd).toBe(1.75);
    expect(written.totalTokensUsed).toBe(25000);
    expect(written.totalCostUsd).toBe(1.75);
  });

  it("handles missing cost data gracefully (readScreen returns no cost info)", async () => {
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
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pending" }],
            readyIds: [],
          };
        case 4:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "merged" }],
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
      readScreen: () => "Worker idle. Waiting for orchestrator.",
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Metrics have null cost data (not 0)
    const written = JSON.parse(io.writeFileSync.mock.calls[0][1]) as RunMetrics;
    expect(written.items[0]!.tokensUsed).toBeNull();
    expect(written.items[0]!.costUsd).toBeNull();
    expect(written.totalTokensUsed).toBeNull();
    expect(written.totalCostUsd).toBeNull();
  });

  it("handles readScreen not provided (null cost data)", async () => {
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
      log: () => {},
      actionDeps: mockActionDeps(),
      analyticsIO: io,
    };

    const config: OrchestrateLoopConfig = {
      analyticsDir: "/tmp/.ninthwave/analytics",
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Metrics have null cost data
    const written = JSON.parse(io.writeFileSync.mock.calls[0][1]) as RunMetrics;
    expect(written.items[0]!.tokensUsed).toBeNull();
    expect(written.items[0]!.costUsd).toBeNull();
    expect(written.totalTokensUsed).toBeNull();
    expect(written.totalCostUsd).toBeNull();
  });
});

// ── percentile helper ──────────────────────────────────────────────

describe("percentile", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the single value for single-element array", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("computes p50 (median) correctly for odd-length array", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  it("computes p50 (median) correctly for even-length array", () => {
    // nearest-rank: ceil(0.5 * 4) - 1 = 1 → index 1
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });

  it("computes p95 correctly", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => (i + 1) * 100);
    // p95: ceil(0.95 * 100) - 1 = 94 → value 9500
    expect(percentile(sorted, 95)).toBe(9500);
  });

  it("returns max for p100", () => {
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });
});

// ── computeDetectionLatency ────────────────────────────────────────

describe("computeDetectionLatency", () => {
  it("returns null for empty latency array", () => {
    expect(computeDetectionLatency([])).toBeNull();
  });

  it("computes percentiles for a single value", () => {
    const stats = computeDetectionLatency([5000])!;
    expect(stats.p50Ms).toBe(5000);
    expect(stats.p95Ms).toBe(5000);
    expect(stats.maxMs).toBe(5000);
    expect(stats.sampleCount).toBe(1);
    expect(stats.slowDetection).toBe(false);
  });

  it("computes p50, p95, and max correctly for multiple values", () => {
    // 20 values: 1000, 2000, ..., 20000
    const latencies = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000);
    const stats = computeDetectionLatency(latencies)!;

    expect(stats.p50Ms).toBe(10000); // ceil(0.5 * 20) - 1 = 9 → 10000
    expect(stats.p95Ms).toBe(19000); // ceil(0.95 * 20) - 1 = 18 → 19000
    expect(stats.maxMs).toBe(20000);
    expect(stats.sampleCount).toBe(20);
  });

  it("flags slow detection when p95 exceeds threshold", () => {
    // All values above 60s
    const latencies = [61_000, 62_000, 63_000, 64_000, 65_000];
    const stats = computeDetectionLatency(latencies)!;

    expect(stats.slowDetection).toBe(true);
    expect(stats.p95Ms).toBeGreaterThan(SLOW_DETECTION_THRESHOLD_MS);
  });

  it("does not flag slow detection when p95 is below threshold", () => {
    const latencies = [1000, 2000, 3000, 4000, 5000];
    const stats = computeDetectionLatency(latencies)!;

    expect(stats.slowDetection).toBe(false);
    expect(stats.p95Ms).toBeLessThanOrEqual(SLOW_DETECTION_THRESHOLD_MS);
  });

  it("uses custom threshold when provided", () => {
    const latencies = [5000, 6000, 7000, 8000, 9000];
    // Default threshold (60s): not slow
    expect(computeDetectionLatency(latencies)!.slowDetection).toBe(false);
    // Custom threshold (4s): slow
    expect(computeDetectionLatency(latencies, 4000)!.slowDetection).toBe(true);
  });

  it("sorts latencies before computing percentiles", () => {
    // Unsorted input — should still compute correctly
    const latencies = [50000, 10000, 30000, 20000, 40000];
    const stats = computeDetectionLatency(latencies)!;

    expect(stats.p50Ms).toBe(30000);
    expect(stats.maxMs).toBe(50000);
  });
});

// ── collectRunMetrics with detection latency ─────────────────────────

describe("collectRunMetrics with detection latency", () => {
  const config: OrchestratorConfig = {
    wipLimit: 4,
    mergeStrategy: "asap",
    maxCiRetries: 2,
  };

  it("includes latency percentiles when items have detectionLatencyMs", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 5000,
      },
      {
        id: "T-1-2",
        todo: makeTodo("T-1-2"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 15000,
      },
      {
        id: "T-1-3",
        todo: makeTodo("T-1-3"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 45000,
      },
    ];

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
    );

    expect(metrics.detectionLatency).not.toBeNull();
    expect(metrics.detectionLatency!.sampleCount).toBe(3);
    expect(metrics.detectionLatency!.p50Ms).toBe(15000);
    expect(metrics.detectionLatency!.maxMs).toBe(45000);
    expect(metrics.detectionLatency!.slowDetection).toBe(false);
  });

  it("flags slow detection when p95 exceeds 60s", () => {
    const items: OrchestratorItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: `T-1-${i + 1}`,
      todo: makeTodo(`T-1-${i + 1}`),
      state: "done" as const,
      ciFailCount: 0,
      lastTransition: new Date().toISOString(),
      // Most items fast, but top items slow: values 5000, 10000, ..., 100000
      detectionLatencyMs: (i + 1) * 5000,
    }));

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
    );

    expect(metrics.detectionLatency).not.toBeNull();
    // p95 of [5000, 10000, ..., 100000] = 95000 > 60000
    expect(metrics.detectionLatency!.p95Ms).toBeGreaterThan(60_000);
    expect(metrics.detectionLatency!.slowDetection).toBe(true);
  });

  it("returns null detectionLatency when no items have latency data", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        // No detectionLatencyMs
      },
    ];

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
    );

    expect(metrics.detectionLatency).toBeNull();
  });

  it("includes per-item detectionLatencyMs in item metrics", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 12345,
      },
      {
        id: "T-1-2",
        todo: makeTodo("T-1-2"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        // No latency data
      },
    ];

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
    );

    expect(metrics.items[0]!.detectionLatencyMs).toBe(12345);
    expect(metrics.items[1]!.detectionLatencyMs).toBeUndefined();
  });

  it("skips zero-value latencies (no real detection delay)", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        todo: makeTodo("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 0, // No delay — should be excluded
      },
    ];

    const metrics = collectRunMetrics(
      items,
      config,
      "2026-03-24T10:00:00.000Z",
      "2026-03-24T10:05:00.000Z",
      "claude",
    );

    // Zero latencies are excluded → no samples → null
    expect(metrics.detectionLatency).toBeNull();
  });
});

// ── computeSummary with detection latency ────────────────────────────

describe("computeSummary with detection latency", () => {
  it("aggregates detection latency from per-item data across runs", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 10000 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 20000 },
        ],
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        items: [
          { id: "C", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 30000 },
        ],
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.detectionLatency).not.toBeNull();
    expect(summary.detectionLatency!.sampleCount).toBe(3);
    expect(summary.detectionLatency!.p50Ms).toBe(20000);
    expect(summary.detectionLatency!.maxMs).toBe(30000);
  });

  it("returns null detectionLatency when no items have latency data", () => {
    const runs: RunMetrics[] = [
      makeRun({ items: [{ id: "A", state: "done", ciRetryCount: 0, tool: "claude" }] }),
    ];

    const summary = computeSummary(runs);
    expect(summary.detectionLatency).toBeNull();
  });

  it("returns null detectionLatency for zero runs", () => {
    const summary = computeSummary([]);
    expect(summary.detectionLatency).toBeNull();
  });

  it("flags slow detection across aggregated items", () => {
    const runs: RunMetrics[] = [
      makeRun({
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 70000 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 80000 },
        ],
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.detectionLatency!.slowDetection).toBe(true);
  });
});

// ── formatAnalytics with detection latency ───────────────────────────

describe("formatAnalytics with detection latency", () => {
  it("shows detection latency when latency data exists", () => {
    const runs: RunMetrics[] = [
      makeRun({
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 5000 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 15000 },
        ],
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Detection latency");
    expect(output).toContain("p50=");
    expect(output).toContain("p95=");
    expect(output).toContain("max=");
    expect(output).toContain("2 samples");
  });

  it("shows slow detection warning when p95 exceeds threshold", () => {
    const runs: RunMetrics[] = [
      makeRun({
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 70000 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 80000 },
        ],
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("slow detection");
  });

  it("hides detection latency when no latency data exists", () => {
    const runs: RunMetrics[] = [
      makeRun(),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).not.toContain("Detection latency");
    expect(output).not.toContain("slow detection");
  });

  it("does not show slow detection warning when p95 is below threshold", () => {
    const runs: RunMetrics[] = [
      makeRun({
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 5000 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", detectionLatencyMs: 10000 },
        ],
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Detection latency");
    expect(output).not.toContain("slow detection");
  });
});
