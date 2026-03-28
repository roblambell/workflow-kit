// Tests for core/analytics.ts and core/commands/analytics.ts.
// Uses dependency injection (no vi.mock) per project conventions.

import { describe, it, expect, vi } from "vitest";
import {
  collectRunMetrics,
  parseCostSummary,
  percentile,
  computeDetectionLatency,
  SLOW_DETECTION_THRESHOLD_MS,
  type RunMetrics,
  type CostSummary,
  type DetectionLatencyStats,
} from "../core/analytics.ts";
import {
  estimateCost,
  MODEL_PRICING,
} from "../core/types.ts";
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
import type { WorkItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

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
    rawText: `## ${id}\nTest item`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function mockActionDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/item-test",
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

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  workDir: "/tmp/test-project/.ninthwave/work",
  aiTool: "claude",
};

// ── collectRunMetrics ────────────────────────────────────────────────

describe("collectRunMetrics", () => {
  it("computes wall-clock duration and item counts", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
        state: "stuck",
        ciFailCount: 2,
        lastTransition: new Date().toISOString(),
      },
    ];

    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "auto",
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
    expect(metrics.mergeStrategy).toBe("auto");
  });

  it("tracks CI retry count per item", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
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
      retryCount: undefined,
      tool: "cursor",
      tokensUsed: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      model: null,
    });
    expect(metrics.items[1]).toEqual({
      id: "T-1-2",
      state: "done",
      ciRetryCount: 3,
      retryCount: undefined,
      tool: "cursor",
      prNumber: 42,
      tokensUsed: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      model: null,
    });
  });

  it("handles zero-item run gracefully", () => {
    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "auto",
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
    expect(metrics.mergeStrategy).toBe("auto");
  });
});

// ── Integration: orchestrateLoop emits run_metrics log event ─────────

describe("orchestrateLoop analytics integration", () => {
  it("emits run_metrics log event on orchestrate_complete", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
    };

    const config: OrchestrateLoopConfig = {
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // run_metrics log event was emitted
    const metricsLog = logs.find((l) => l.event === "run_metrics");
    expect(metricsLog).toBeDefined();
    expect(metricsLog!.itemsAttempted).toBe(1);
    expect(metricsLog!.itemsCompleted).toBe(1);
    expect(metricsLog!.itemsFailed).toBe(0);
    expect(metricsLog!.mergeStrategy).toBe("auto");
  });

  it("includes CI retry count in run_metrics for items with failures", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

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
        case 5: // Review approves (reviewCompleted was reset by CI failure)
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass", reviewVerdict: { verdict: "approve" as const, summary: "OK", blockerCount: 0, nitCount: 0, preExistingCount: 0 } }],
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
    };

    const config: OrchestrateLoopConfig = {
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    const metricsLog = logs.find((l) => l.event === "run_metrics") as any;
    expect(metricsLog.items[0].ciRetryCount).toBe(1);
  });

  it("always emits run_metrics (no analyticsDir needed)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    // run_metrics is always emitted
    expect(logs.some((l) => l.event === "run_metrics")).toBe(true);
  });

  it("emits run_metrics even for zero-item runs", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });

    const logs: LogEntry[] = [];

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: () => ({ items: [], readyIds: [] }),
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    const config: OrchestrateLoopConfig = {
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    const metricsLog = logs.find((l) => l.event === "run_metrics") as any;
    expect(metricsLog).toBeDefined();
    expect(metricsLog.itemsAttempted).toBe(0);
    expect(metricsLog.itemsCompleted).toBe(0);
    expect(metricsLog.itemsFailed).toBe(0);
    expect(metricsLog.mergeStrategy).toBe("auto");
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
    mergeStrategy: "auto",
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
    existsSync: (path: string) => path in files,
    readFileSync: (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

/** Helper: build a JSONL run_metrics log line from a RunMetrics object. */
function metricsLine(run: RunMetrics): string {
  return JSON.stringify({ ts: run.runTimestamp, level: "info", event: "run_metrics", ...run });
}

describe("loadRuns (log-based)", () => {
  it("parses run_metrics events from JSONL log", () => {
    const run1 = makeRun({ runTimestamp: "2026-03-24T10:00:00.000Z" });
    const run2 = makeRun({ runTimestamp: "2026-03-24T11:00:00.000Z", wallClockMs: 600_000 });

    const logContent = [metricsLine(run1), metricsLine(run2)].join("\n");
    const io = mockReadIO({ "/log": logContent });

    const runs = loadRuns("/log", io);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.wallClockMs).toBe(300_000);
    expect(runs[1]!.wallClockMs).toBe(600_000);
  });

  it("returns empty array when log file does not exist", () => {
    const io = mockReadIO({});
    const runs = loadRuns("/nonexistent", io);
    expect(runs).toEqual([]);
  });

  it("skips malformed JSON lines", () => {
    const validRun = makeRun();
    const logContent = [
      "not json{",
      metricsLine(validRun),
    ].join("\n");

    const io = mockReadIO({ "/log": logContent });
    const runs = loadRuns("/log", io);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runTimestamp).toBe(validRun.runTimestamp);
  });

  it("skips non-run_metrics events", () => {
    const validRun = makeRun();
    const logContent = [
      JSON.stringify({ ts: "2026-03-24T10:00:00.000Z", level: "info", event: "transition", itemId: "T-1-1", from: "queued", to: "ready" }),
      metricsLine(validRun),
      JSON.stringify({ ts: "2026-03-24T12:00:00.000Z", level: "info", event: "orchestrate_complete" }),
    ].join("\n");

    const io = mockReadIO({ "/log": logContent });
    const runs = loadRuns("/log", io);
    expect(runs).toHaveLength(1);
  });

  it("sorts runs chronologically by runTimestamp", () => {
    const early = makeRun({ runTimestamp: "2026-03-24T08:00:00.000Z" });
    const late = makeRun({ runTimestamp: "2026-03-24T16:00:00.000Z" });

    // Intentionally in reverse order in the log
    const logContent = [metricsLine(late), metricsLine(early)].join("\n");
    const io = mockReadIO({ "/log": logContent });

    const runs = loadRuns("/log", io);
    expect(runs[0]!.runTimestamp).toBe("2026-03-24T08:00:00.000Z");
    expect(runs[1]!.runTimestamp).toBe("2026-03-24T16:00:00.000Z");
  });

  it("reads from rotated log files", () => {
    const run1 = makeRun({ runTimestamp: "2026-03-24T08:00:00.000Z" });
    const run2 = makeRun({ runTimestamp: "2026-03-24T12:00:00.000Z" });
    const run3 = makeRun({ runTimestamp: "2026-03-24T16:00:00.000Z" });

    const io = mockReadIO({
      "/log.2": metricsLine(run1),
      "/log.1": metricsLine(run2),
      "/log": metricsLine(run3),
    });

    const runs = loadRuns("/log", io);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.runTimestamp).toBe("2026-03-24T08:00:00.000Z");
    expect(runs[2]!.runTimestamp).toBe("2026-03-24T16:00:00.000Z");
  });

  it("skips run_metrics with missing items array and warns", () => {
    const noItems = { ts: "2026-03-24T10:00:00.000Z", level: "info", event: "run_metrics", runTimestamp: "2026-03-24T10:00:00.000Z", wallClockMs: 100 };
    const validRun = makeRun();
    const logContent = [JSON.stringify(noItems), metricsLine(validRun)].join("\n");
    const io = mockReadIO({ "/log": logContent });

    const warnings: string[] = [];
    const runs = loadRuns("/log", io, (msg) => warnings.push(msg));

    expect(runs).toHaveLength(1);
    expect(runs[0]!.runTimestamp).toBe(validRun.runTimestamp);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("items array");
  });

  it("skips run_metrics with malformed item entries and warns", () => {
    const badItems = { ts: "2026-03-24T10:00:00.000Z", level: "info", event: "run_metrics", runTimestamp: "2026-03-24T10:00:00.000Z", wallClockMs: 100, items: [{ id: "T-1", state: "done" }, { notAnId: true }] };
    const validRun = makeRun();
    const logContent = [JSON.stringify(badItems), metricsLine(validRun)].join("\n");
    const io = mockReadIO({ "/log": logContent });

    const warnings: string[] = [];
    const runs = loadRuns("/log", io, (msg) => warnings.push(msg));

    expect(runs).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing id or state");
  });

  it("handles empty log file", () => {
    const io = mockReadIO({ "/log": "" });
    const runs = loadRuns("/log", io);
    expect(runs).toEqual([]);
  });

  it("loads valid events without warnings", () => {
    const run1 = makeRun({ runTimestamp: "2026-03-24T10:00:00.000Z" });
    const run2 = makeRun({ runTimestamp: "2026-03-24T11:00:00.000Z", wallClockMs: 600_000 });

    const logContent = [metricsLine(run1), metricsLine(run2)].join("\n");
    const io = mockReadIO({ "/log": logContent });

    const warnings: string[] = [];
    const runs = loadRuns("/log", io, (msg) => warnings.push(msg));

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
    mergeStrategy: "auto",
    maxCiRetries: 2,
  };

  it("populates per-item cost when costData is provided", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
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
        workItem: makeWorkItem("T-1-1"),
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
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
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

    expect(output).toContain("Estimated cost");
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

    expect(output).not.toContain("Estimated cost");
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
    expect(output).toContain("-");
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
      readScreen: () => "Total tokens: 25,000\nTotal cost: $1.75\n",
    };

    const config: OrchestrateLoopConfig = {
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // Cost was captured
    const costLog = logs.find((l) => l.event === "cost_captured");
    expect(costLog).toBeDefined();
    expect(costLog!.tokensUsed).toBe(25000);
    expect(costLog!.costUsd).toBe(1.75);

    // run_metrics includes cost data
    const metricsLog = logs.find((l) => l.event === "run_metrics") as any;
    expect(metricsLog.items[0].tokensUsed).toBe(25000);
    expect(metricsLog.items[0].costUsd).toBe(1.75);
    expect(metricsLog.totalTokensUsed).toBe(25000);
    expect(metricsLog.totalCostUsd).toBe(1.75);
  });

  it("handles missing cost data gracefully (readScreen returns no cost info)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
      readScreen: () => "Worker idle. Waiting for orchestrator.",
    };

    const config: OrchestrateLoopConfig = {
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // run_metrics have null cost data (not 0)
    const metricsLog = logs.find((l) => l.event === "run_metrics") as any;
    expect(metricsLog.items[0].tokensUsed).toBeNull();
    expect(metricsLog.items[0].costUsd).toBeNull();
    expect(metricsLog.totalTokensUsed).toBeNull();
    expect(metricsLog.totalCostUsd).toBeNull();
  });

  it("handles readScreen not provided (null cost data)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
    };

    const config: OrchestrateLoopConfig = {
      aiTool: "claude",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // run_metrics have null cost data
    const metricsLog = logs.find((l) => l.event === "run_metrics") as any;
    expect(metricsLog.items[0].tokensUsed).toBeNull();
    expect(metricsLog.items[0].costUsd).toBeNull();
    expect(metricsLog.totalTokensUsed).toBeNull();
    expect(metricsLog.totalCostUsd).toBeNull();
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
    // Unsorted input -- should still compute correctly
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
    mergeStrategy: "auto",
    maxCiRetries: 2,
  };

  it("includes latency percentiles when items have detectionLatencyMs", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 5000,
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 15000,
      },
      {
        id: "T-1-3",
        workItem: makeWorkItem("T-1-3"),
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
      workItem: makeWorkItem(`T-1-${i + 1}`),
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
        workItem: makeWorkItem("T-1-1"),
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
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 12345,
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
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
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        lastTransition: new Date().toISOString(),
        detectionLatencyMs: 0, // No delay -- should be excluded
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


// ── estimateCost pricing lookup ─────────────────────────────────────

describe("estimateCost", () => {
  it("estimates cost for known model with both token types", () => {
    const cost = estimateCost("claude-sonnet-4-20250514", 100_000, 10_000);
    // input: 100k * 3/1M = 0.3, output: 10k * 15/1M = 0.15 → 0.45
    expect(cost).toBe(0.45);
  });

  it("estimates cost with only input tokens", () => {
    const cost = estimateCost("gpt-4o", 500_000, undefined);
    // 500k * 2.5/1M = 1.25
    expect(cost).toBe(1.25);
  });

  it("estimates cost with only output tokens", () => {
    const cost = estimateCost("gpt-4o", undefined, 200_000);
    // 200k * 10/1M = 2.0
    expect(cost).toBe(2.0);
  });

  it("returns null for unknown model", () => {
    expect(estimateCost("unknown-model", 10000, 5000)).toBeNull();
  });

  it("returns null when model is undefined", () => {
    expect(estimateCost(undefined, 10000, 5000)).toBeNull();
  });

  it("returns null when both token counts are undefined", () => {
    expect(estimateCost("gpt-4o", undefined, undefined)).toBeNull();
  });

  it("handles zero tokens", () => {
    const cost = estimateCost("gpt-4o", 0, 0);
    expect(cost).toBe(0);
  });

  it("pricing table has reasonable values for known models", () => {
    // All prices should be positive
    for (const [, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPerMillion).toBeGreaterThan(0);
      expect(pricing.outputPerMillion).toBeGreaterThan(0);
      // Output typically costs more than input
      expect(pricing.outputPerMillion).toBeGreaterThanOrEqual(pricing.inputPerMillion);
    }
  });
});

// ── collectRunMetrics with input/output tokens and model ────────────

describe("collectRunMetrics with detailed cost data", () => {
  const config: OrchestratorConfig = {
    wipLimit: 4,
    mergeStrategy: "auto",
    maxCiRetries: 2,
  };

  it("populates input/output tokens and model per item", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        prNumber: 10,
        lastTransition: new Date().toISOString(),
      },
    ];

    const costData = new Map<string, CostSummary>([
      ["T-1-1", {
        tokensUsed: 55000,
        costUsd: 0.45,
        inputTokens: 45000,
        outputTokens: 10000,
        model: "claude-sonnet-4-20250514",
      }],
    ]);

    const metrics = collectRunMetrics(items, config, "2026-03-24T10:00:00.000Z", "2026-03-24T10:05:00.000Z", "claude", costData);

    expect(metrics.items[0]!.inputTokens).toBe(45000);
    expect(metrics.items[0]!.outputTokens).toBe(10000);
    expect(metrics.items[0]!.model).toBe("claude-sonnet-4-20250514");
    expect(metrics.totalInputTokens).toBe(45000);
    expect(metrics.totalOutputTokens).toBe(10000);
  });

  it("computes model breakdown across items", () => {
    const items: OrchestratorItem[] = [
      { id: "T-1-1", workItem: makeWorkItem("T-1-1"), state: "done", ciFailCount: 0, prNumber: 1, lastTransition: new Date().toISOString() },
      { id: "T-1-2", workItem: makeWorkItem("T-1-2"), state: "done", ciFailCount: 0, prNumber: 2, lastTransition: new Date().toISOString() },
      { id: "T-1-3", workItem: makeWorkItem("T-1-3"), state: "done", ciFailCount: 0, prNumber: 3, lastTransition: new Date().toISOString() },
    ];

    const costData = new Map<string, CostSummary>([
      ["T-1-1", { tokensUsed: 10000, costUsd: 0.5, model: "claude-sonnet-4-20250514" }],
      ["T-1-2", { tokensUsed: 20000, costUsd: 1.0, model: "claude-sonnet-4-20250514" }],
      ["T-1-3", { tokensUsed: 15000, costUsd: 0.8, model: "gpt-4o" }],
    ]);

    const metrics = collectRunMetrics(items, config, "2026-03-24T10:00:00.000Z", "2026-03-24T10:05:00.000Z", "claude", costData);

    expect(metrics.modelBreakdown).toEqual({
      "claude-sonnet-4-20250514": 2,
      "gpt-4o": 1,
    });
  });

  it("computes cost-per-PR for completed items with PRs", () => {
    const items: OrchestratorItem[] = [
      { id: "T-1-1", workItem: makeWorkItem("T-1-1"), state: "done", ciFailCount: 0, prNumber: 1, lastTransition: new Date().toISOString() },
      { id: "T-1-2", workItem: makeWorkItem("T-1-2"), state: "done", ciFailCount: 0, prNumber: 2, lastTransition: new Date().toISOString() },
      { id: "T-1-3", workItem: makeWorkItem("T-1-3"), state: "stuck", ciFailCount: 2, lastTransition: new Date().toISOString() },
    ];

    const costData = new Map<string, CostSummary>([
      ["T-1-1", { tokensUsed: 10000, costUsd: 1.00 }],
      ["T-1-2", { tokensUsed: 20000, costUsd: 3.00 }],
      ["T-1-3", { tokensUsed: 5000, costUsd: 0.50 }],
    ]);

    const metrics = collectRunMetrics(items, config, "2026-03-24T10:00:00.000Z", "2026-03-24T10:05:00.000Z", "claude", costData);

    // Total cost = 4.50, completed with PR = 2 items → 4.50/2 = 2.25
    expect(metrics.costPerPr).toBe(2.25);
  });

  it("returns null costPerPr when no cost data", () => {
    const items: OrchestratorItem[] = [
      { id: "T-1-1", workItem: makeWorkItem("T-1-1"), state: "done", ciFailCount: 0, prNumber: 1, lastTransition: new Date().toISOString() },
    ];

    const metrics = collectRunMetrics(items, config, "2026-03-24T10:00:00.000Z", "2026-03-24T10:05:00.000Z", "claude");

    expect(metrics.costPerPr).toBeNull();
  });

  it("returns undefined modelBreakdown when no model data", () => {
    const items: OrchestratorItem[] = [
      { id: "T-1-1", workItem: makeWorkItem("T-1-1"), state: "done", ciFailCount: 0, lastTransition: new Date().toISOString() },
    ];

    const metrics = collectRunMetrics(items, config, "2026-03-24T10:00:00.000Z", "2026-03-24T10:05:00.000Z", "claude");

    expect(metrics.modelBreakdown).toBeUndefined();
  });
});

// ── computeSummary with detailed cost data ──────────────────────────

describe("computeSummary with detailed cost data", () => {
  it("aggregates input/output tokens across runs", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        totalTokensUsed: 55000,
        totalCostUsd: 1.00,
        totalInputTokens: 45000,
        totalOutputTokens: 10000,
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        totalTokensUsed: 80000,
        totalCostUsd: 2.00,
        totalInputTokens: 60000,
        totalOutputTokens: 20000,
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.totalInputTokens).toBe(105000);
    expect(summary.totalOutputTokens).toBe(30000);
  });

  it("returns null input/output tokens when no runs have them", () => {
    const runs: RunMetrics[] = [
      makeRun({ totalTokensUsed: 50000, totalCostUsd: 1.00 }),
    ];

    const summary = computeSummary(runs);
    expect(summary.totalInputTokens).toBeNull();
    expect(summary.totalOutputTokens).toBeNull();
  });

  it("aggregates model breakdown across runs", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        modelBreakdown: { "claude-sonnet-4-20250514": 3, "gpt-4o": 1 },
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        modelBreakdown: { "claude-sonnet-4-20250514": 2, "gpt-4o": 2 },
      }),
    ];

    const summary = computeSummary(runs);
    expect(summary.modelBreakdown).toEqual({
      "claude-sonnet-4-20250514": 5,
      "gpt-4o": 3,
    });
  });

  it("computes cost-per-PR across all runs", () => {
    const runs: RunMetrics[] = [
      makeRun({
        runTimestamp: "2026-03-24T10:00:00.000Z",
        totalCostUsd: 3.00,
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", prNumber: 1, tokensUsed: 10000, costUsd: 1.50 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", prNumber: 2, tokensUsed: 10000, costUsd: 1.50 },
        ],
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        totalCostUsd: 2.00,
        items: [
          { id: "C", state: "done", ciRetryCount: 0, tool: "claude", prNumber: 3, tokensUsed: 20000, costUsd: 2.00 },
        ],
      }),
    ];

    const summary = computeSummary(runs);
    // Total cost $5.00, 3 completed PRs → $1.67
    expect(summary.costPerPr).toBe(1.67);
  });

  it("returns null costPerPr when no cost data", () => {
    const runs: RunMetrics[] = [
      makeRun({ totalCostUsd: null }),
    ];
    const summary = computeSummary(runs);
    expect(summary.costPerPr).toBeNull();
  });
});

// ── formatAnalytics Cost Summary section ────────────────────────────

describe("formatAnalytics Cost Summary section", () => {
  it("shows Cost Summary header when cost data exists", () => {
    const runs: RunMetrics[] = [
      makeRun({
        totalTokensUsed: 1_200_000,
        totalCostUsd: 4.20,
        totalInputTokens: 890_000,
        totalOutputTokens: 310_000,
        costPerPr: 0.60,
        modelBreakdown: { "claude-sonnet-4-20250514": 5, "gpt-4o": 2 },
        items: [
          { id: "A", state: "done", ciRetryCount: 0, tool: "claude", prNumber: 1, tokensUsed: 100000, costUsd: 0.60 },
          { id: "B", state: "done", ciRetryCount: 0, tool: "claude", prNumber: 2, tokensUsed: 100000, costUsd: 0.60 },
        ],
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Cost Summary");
    expect(output).toContain("Total tokens");
    expect(output).toContain("1.2M");
    expect(output).toContain("890.0k in");
    expect(output).toContain("310.0k out");
    expect(output).toContain("Estimated cost");
    expect(output).toContain("$4.20");
    expect(output).toContain("Cost per PR");
    expect(output).toContain("Model breakdown");
    expect(output).toContain("claude-sonnet-4-20250514 (5)");
    expect(output).toContain("gpt-4o (2)");
  });

  it("hides Cost Summary section when no cost data", () => {
    const runs: RunMetrics[] = [
      makeRun({ totalTokensUsed: null, totalCostUsd: null }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).not.toContain("Cost Summary");
    expect(output).not.toContain("Model breakdown");
  });

  it("shows dash for workers without cost data in run history", () => {
    const runs: RunMetrics[] = [
      makeRun({
        totalTokensUsed: 10000,
        totalCostUsd: 1.00,
      }),
      makeRun({
        runTimestamp: "2026-03-25T10:00:00.000Z",
        totalTokensUsed: null,
        totalCostUsd: null,
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("$1.00");
    expect(output).toContain("-");
  });

  it("omits input/output breakdown when not available", () => {
    const runs: RunMetrics[] = [
      makeRun({
        totalTokensUsed: 50000,
        totalCostUsd: 2.00,
        // No totalInputTokens/totalOutputTokens
      }),
    ];
    const summary = computeSummary(runs);
    const output = formatAnalytics(summary, false).join("\n");

    expect(output).toContain("Total tokens");
    expect(output).toContain("50.0k");
    expect(output).not.toContain(" in /");
  });
});
