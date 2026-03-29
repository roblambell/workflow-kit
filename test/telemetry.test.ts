// Tests for worker session telemetry (M-TEL-1).
// Verifies telemetry capture on state transitions, status formatting, and analytics schema.
// Uses dependency injection (no vi.mock) per project conventions.

import { describe, it, expect, vi } from "vitest";
import {
  Orchestrator,
  type PollSnapshot,
  type OrchestratorItem,
  type OrchestratorConfig,
} from "../core/orchestrator.ts";
import {
  formatItemRow,
  formatElapsed,
  formatTelemetrySuffix,
  daemonStateToStatusItems,
  type StatusItem,
} from "../core/commands/status.ts";
import {
  collectRunMetrics,
  parseWorkerTelemetry,
  type ItemMetric,
} from "../core/analytics.ts";
import {
  serializeOrchestratorState,
  type DaemonState,
} from "../core/daemon.ts";
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

// Strip ANSI escape codes, CSI sequences, and OSC 8 hyperlinks for content assertions
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")   // Strip OSC 8 hyperlink sequences
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");  // Strip CSI sequences (colors, etc.)
}

// ── Telemetry capture on state transitions ───────────────────────────

describe("telemetry: startedAt / endedAt on transitions", () => {
  it("sets startedAt when item transitions to implementing", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto", maxCiRetries: 2, maxRetries: 1 });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

    // Transition to ready, then launch
    const snapshot: PollSnapshot = { items: [], readyIds: ["T-1-1"] };
    orch.processTransitions(snapshot);

    // Item should be launching now -- simulate worker alive
    const item = orch.getItem("T-1-1")!;
    expect(item.state).toBe("launching");

    // Worker comes alive → implementing
    const snapshot2: PollSnapshot = {
      items: [{ id: "T-1-1", workerAlive: true }],
      readyIds: [],
    };
    orch.processTransitions(snapshot2);

    const updated = orch.getItem("T-1-1")!;
    expect(updated.state).toBe("implementing");
    expect(updated.startedAt).toBeDefined();
    expect(new Date(updated.startedAt!).getTime()).toBeGreaterThan(0);
  });

  it("sets endedAt when item transitions to done", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto", maxCiRetries: 2, maxRetries: 1 });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

    // Fast-track to implementing
    const snap1: PollSnapshot = { items: [], readyIds: ["T-1-1"] };
    orch.processTransitions(snap1);
    orch.processTransitions({ items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] });

    const afterImpl = orch.getItem("T-1-1")!;
    expect(afterImpl.state).toBe("implementing");
    expect(afterImpl.startedAt).toBeDefined();

    // PR appears, CI passes, auto-merged
    const snap2: PollSnapshot = {
      items: [{
        id: "T-1-1",
        prNumber: 42,
        prState: "merged",
        workerAlive: true,
      }],
      readyIds: [],
    };
    orch.processTransitions(snap2);

    // Should be merged, then next cycle → done
    const afterMerge = orch.getItem("T-1-1")!;
    expect(afterMerge.state).toBe("merged");

    orch.processTransitions({ items: [], readyIds: [] });
    const afterDone = orch.getItem("T-1-1")!;
    expect(afterDone.state).toBe("done");
    expect(afterDone.endedAt).toBeDefined();
    expect(new Date(afterDone.endedAt!).getTime()).toBeGreaterThan(0);
  });

  it("sets endedAt when item transitions to stuck", () => {
    const orch = new Orchestrator({
      wipLimit: 2,
      mergeStrategy: "auto",
      maxCiRetries: 2,
      maxRetries: 0,
    });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

    // Launch → implementing
    orch.processTransitions({ items: [], readyIds: ["T-1-1"] });
    orch.processTransitions({ items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] });

    const item = orch.getItem("T-1-1")!;
    expect(item.state).toBe("implementing");

    // Worker dies (5 consecutive not-alive checks for debounce)
    for (let i = 0; i < 5; i++) {
      orch.processTransitions({ items: [{ id: "T-1-1", workerAlive: false }], readyIds: [] });
    }

    const stuck = orch.getItem("T-1-1")!;
    expect(stuck.state).toBe("stuck");
    expect(stuck.endedAt).toBeDefined();
  });

  it("does not overwrite startedAt on re-entry to implementing", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto", maxCiRetries: 2, maxRetries: 1 });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

    // First launch → implementing
    orch.processTransitions({ items: [], readyIds: ["T-1-1"] });
    orch.processTransitions({ items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] });

    const firstStart = orch.getItem("T-1-1")!.startedAt;
    expect(firstStart).toBeDefined();

    // Manually set state back to launching and then implementing again
    // (simulating a scenario where the item re-enters implementing)
    orch.setState("T-1-1", "launching");
    orch.processTransitions({ items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] });

    const secondStart = orch.getItem("T-1-1")!.startedAt;
    // startedAt should be preserved from the first time
    expect(secondStart).toBe(firstStart);
  });
});

// ── parseWorkerTelemetry ─────────────────────────────────────────────

describe("parseWorkerTelemetry", () => {
  it("returns null exit code and empty stderr for empty input", () => {
    const result = parseWorkerTelemetry("");
    expect(result.exitCode).toBeNull();
    expect(result.stderrTail).toBe("");
  });

  it("parses 'exit code 1' pattern", () => {
    const result = parseWorkerTelemetry("Process finished\nexit code 1\nDone.");
    expect(result.exitCode).toBe(1);
  });

  it("parses 'Exit status: 0' pattern", () => {
    const result = parseWorkerTelemetry("Worker completed successfully\nExit status: 0");
    expect(result.exitCode).toBe(0);
  });

  it("parses 'exited with code 137' pattern", () => {
    const result = parseWorkerTelemetry("Worker killed\nexited with code 137");
    expect(result.exitCode).toBe(137);
  });

  it("parses 'Process exited with code 2' pattern", () => {
    const result = parseWorkerTelemetry("error\nProcess exited with code 2\ncleanup");
    expect(result.exitCode).toBe(2);
  });

  it("extracts last 20 non-empty lines as stderr tail", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const result = parseWorkerTelemetry(lines.join("\n"));
    const tailLines = result.stderrTail.split("\n");
    expect(tailLines.length).toBe(20);
    expect(tailLines[0]).toBe("line 11");
    expect(tailLines[19]).toBe("line 30");
  });

  it("handles screen with blank lines (filters them)", () => {
    const screen = "error output\n\n\nmore errors\n\n";
    const result = parseWorkerTelemetry(screen);
    const tailLines = result.stderrTail.split("\n");
    expect(tailLines.length).toBe(2);
    expect(tailLines[0]).toBe("error output");
    expect(tailLines[1]).toBe("more errors");
  });
});

// ── Status formatting with telemetry ─────────────────────────────────

describe("formatElapsed", () => {
  it("returns empty string when no startedAt", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "implementing",
      prNumber: null,
      ageMs: 0,
      repoLabel: "",
    };
    expect(formatElapsed(item)).toBe("");
  });

  it("returns elapsed time for active worker", () => {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "implementing",
      prNumber: null,
      ageMs: 0,
      repoLabel: "",
      startedAt: tenMinAgo,
    };
    const elapsed = formatElapsed(item);
    expect(elapsed).toBe("10m");
  });

  it("returns duration between startedAt and endedAt for completed workers", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "merged",
      prNumber: 42,
      ageMs: 0,
      repoLabel: "",
      startedAt: "2026-03-25T10:00:00.000Z",
      endedAt: "2026-03-25T12:30:00.000Z",
    };
    const elapsed = formatElapsed(item);
    expect(elapsed).toBe("2h 30m");
  });
});

describe("formatTelemetrySuffix", () => {
  it("returns empty string for items without telemetry", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "implementing",
      prNumber: null,
      ageMs: 0,
      repoLabel: "",
    };
    expect(formatTelemetrySuffix(item)).toBe("");
  });

  it("does not show elapsed duration for active workers (shown in duration column instead)", () => {
    const now = new Date();
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "implementing",
      prNumber: null,
      ageMs: 0,
      repoLabel: "",
      startedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    };
    const suffix = formatTelemetrySuffix(item);
    expect(suffix).toBe("");
  });

  it("shows exit code for ci-failed items", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "ci-failed",
      prNumber: 42,
      ageMs: 0,
      repoLabel: "",
      exitCode: 1,
    };
    const suffix = stripAnsi(formatTelemetrySuffix(item));
    expect(suffix).toContain("exit: 1");
  });

  it("shows stderr tail for ci-failed items", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "ci-failed",
      prNumber: 42,
      ageMs: 0,
      repoLabel: "",
      stderrTail: "Error: test failed\nassert.equal expected 1 got 2",
    };
    const suffix = stripAnsi(formatTelemetrySuffix(item));
    expect(suffix).toContain("stderr: Error: test failed");
  });

  it("does not show exit code for non-failed states", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test",
      state: "merged",
      prNumber: 42,
      ageMs: 0,
      repoLabel: "",
      exitCode: 0,
    };
    const suffix = stripAnsi(formatTelemetrySuffix(item));
    expect(suffix).not.toContain("exit:");
  });
});

describe("formatItemRow includes telemetry", () => {
  it("does not show elapsed suffix for active items", () => {
    const now = new Date();
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test item",
      state: "implementing",
      prNumber: null,
      ageMs: 60_000,
      repoLabel: "",
      startedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    };
    const row = stripAnsi(formatItemRow(item, 30));
    expect(row).not.toContain("elapsed:");
  });

  it("shows exit code suffix for failed items", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Test item",
      state: "ci-failed",
      prNumber: 42,
      ageMs: 60_000,
      repoLabel: "",
      exitCode: 1,
    };
    const row = stripAnsi(formatItemRow(item, 30));
    expect(row).toContain("exit: 1");
  });
});

// ── daemonStateToStatusItems with telemetry ──────────────────────────

describe("daemonStateToStatusItems passes telemetry", () => {
  it("maps telemetry fields from daemon state to status items", () => {
    const state: DaemonState = {
      pid: 1234,
      startedAt: "2026-03-25T10:00:00.000Z",
      updatedAt: new Date().toISOString(),
      items: [{
        id: "T-1-1",
        state: "stuck",
        prNumber: 42,
        title: "Test item",
        lastTransition: new Date().toISOString(),
        ciFailCount: 2,
        retryCount: 1,
        failureReason: "worker-crashed",
        startedAt: "2026-03-25T10:01:00.000Z",
        endedAt: "2026-03-25T10:15:00.000Z",
        exitCode: 1,
        stderrTail: "Error: something went wrong",
      }],
    };

    const items = daemonStateToStatusItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]!.startedAt).toBe("2026-03-25T10:01:00.000Z");
    expect(items[0]!.endedAt).toBe("2026-03-25T10:15:00.000Z");
    expect(items[0]!.exitCode).toBe(1);
    expect(items[0]!.stderrTail).toBe("Error: something went wrong");
  });

  it("handles missing telemetry fields gracefully", () => {
    const state: DaemonState = {
      pid: 1234,
      startedAt: "2026-03-25T10:00:00.000Z",
      updatedAt: new Date().toISOString(),
      items: [{
        id: "T-1-1",
        state: "implementing",
        prNumber: null,
        title: "Test item",
        lastTransition: new Date().toISOString(),
        ciFailCount: 0,
        retryCount: 0,
      }],
    };

    const items = daemonStateToStatusItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]!.startedAt).toBeUndefined();
    expect(items[0]!.endedAt).toBeUndefined();
    expect(items[0]!.exitCode).toBeUndefined();
    expect(items[0]!.stderrTail).toBeUndefined();
  });
});

// ── serializeOrchestratorState includes telemetry ────────────────────

describe("serializeOrchestratorState includes telemetry", () => {
  it("includes startedAt, endedAt, exitCode, stderrTail in serialized state", () => {
    const items: OrchestratorItem[] = [{
      id: "T-1-1",
      workItem: makeWorkItem("T-1-1"),
      state: "stuck",
      ciFailCount: 2,
      retryCount: 1,
      lastTransition: new Date().toISOString(),
      startedAt: "2026-03-25T10:01:00.000Z",
      endedAt: "2026-03-25T10:15:00.000Z",
      exitCode: 1,
      stderrTail: "Error: test failed",
    }];

    const state = serializeOrchestratorState(items, 1234, "2026-03-25T10:00:00.000Z");
    expect(state.items[0]!.startedAt).toBe("2026-03-25T10:01:00.000Z");
    expect(state.items[0]!.endedAt).toBe("2026-03-25T10:15:00.000Z");
    expect(state.items[0]!.exitCode).toBe(1);
    expect(state.items[0]!.stderrTail).toBe("Error: test failed");
  });

  it("omits telemetry fields when not present (sparse serialization)", () => {
    const items: OrchestratorItem[] = [{
      id: "T-1-1",
      workItem: makeWorkItem("T-1-1"),
      state: "implementing",
      ciFailCount: 0,
      retryCount: 0,
      lastTransition: new Date().toISOString(),
    }];

    const state = serializeOrchestratorState(items, 1234, "2026-03-25T10:00:00.000Z");
    expect(state.items[0]!.startedAt).toBeUndefined();
    expect(state.items[0]!.endedAt).toBeUndefined();
    expect(state.items[0]!.exitCode).toBeUndefined();
    expect(state.items[0]!.stderrTail).toBeUndefined();
  });
});

// ── Analytics JSON includes telemetry ────────────────────────────────

describe("collectRunMetrics includes telemetry fields", () => {
  it("includes startedAt, endedAt, exitCode in item metrics", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        workItem: makeWorkItem("T-1-1"),
        state: "done",
        ciFailCount: 0,
        retryCount: 0,
        lastTransition: new Date().toISOString(),
        startedAt: "2026-03-25T10:01:00.000Z",
        endedAt: "2026-03-25T10:15:00.000Z",
        exitCode: 0,
      },
      {
        id: "T-1-2",
        workItem: makeWorkItem("T-1-2"),
        state: "stuck",
        ciFailCount: 2,
        retryCount: 1,
        lastTransition: new Date().toISOString(),
        startedAt: "2026-03-25T10:02:00.000Z",
        endedAt: "2026-03-25T10:10:00.000Z",
        exitCode: 1,
      },
    ];

    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "auto",
      maxCiRetries: 2,
      maxRetries: 1,
      launchTimeoutMs: 30 * 60 * 1000,
      activityTimeoutMs: 60 * 60 * 1000,
      enableStacking: true,
      reviewAutoFix: "off",
    };

    const metrics = collectRunMetrics(items, config, "2026-03-25T10:00:00.000Z", "2026-03-25T10:20:00.000Z", "claude");

    // First item (done) should have startedAt and endedAt
    const item1 = metrics.items.find((i) => i.id === "T-1-1")!;
    expect(item1.startedAt).toBe("2026-03-25T10:01:00.000Z");
    expect(item1.endedAt).toBe("2026-03-25T10:15:00.000Z");
    expect(item1.exitCode).toBe(0);

    // Second item (stuck) should have telemetry too
    const item2 = metrics.items.find((i) => i.id === "T-1-2")!;
    expect(item2.startedAt).toBe("2026-03-25T10:02:00.000Z");
    expect(item2.endedAt).toBe("2026-03-25T10:10:00.000Z");
    expect(item2.exitCode).toBe(1);
  });

  it("omits telemetry fields when not present on orchestrator items", () => {
    const items: OrchestratorItem[] = [{
      id: "T-1-1",
      workItem: makeWorkItem("T-1-1"),
      state: "done",
      ciFailCount: 0,
      retryCount: 0,
      lastTransition: new Date().toISOString(),
    }];

    const config: OrchestratorConfig = {
      wipLimit: 4,
      mergeStrategy: "auto",
      maxCiRetries: 2,
      maxRetries: 1,
      launchTimeoutMs: 30 * 60 * 1000,
      activityTimeoutMs: 60 * 60 * 1000,
      enableStacking: true,
      reviewAutoFix: "off",
    };

    const metrics = collectRunMetrics(items, config, "2026-03-25T10:00:00.000Z", "2026-03-25T10:20:00.000Z", "claude");

    const item1 = metrics.items[0]!;
    expect(item1.startedAt).toBeUndefined();
    expect(item1.endedAt).toBeUndefined();
    expect(item1.exitCode).toBeUndefined();
  });
});

// ── Edge case: worker that never starts ──────────────────────────────

describe("edge case: worker that never starts", () => {
  it("shows null telemetry when worker has no screen content", () => {
    const result = parseWorkerTelemetry("");
    expect(result.exitCode).toBeNull();
    expect(result.stderrTail).toBe("");
  });

  it("items without startedAt show no elapsed in status", () => {
    const item: StatusItem = {
      id: "T-1-1",
      title: "Never started",
      state: "implementing",
      prNumber: null,
      ageMs: 0,
      repoLabel: "",
      // No startedAt -- worker never initialized
    };
    const suffix = formatTelemetrySuffix(item);
    expect(suffix).toBe("");
  });

  it("daemon state with null telemetry does not crash daemonStateToStatusItems", () => {
    const state: DaemonState = {
      pid: 1234,
      startedAt: "2026-03-25T10:00:00.000Z",
      updatedAt: new Date().toISOString(),
      items: [{
        id: "T-1-1",
        state: "stuck",
        prNumber: null,
        title: "Test",
        lastTransition: new Date().toISOString(),
        ciFailCount: 0,
        retryCount: 0,
        // All telemetry fields absent
      }],
    };

    const items = daemonStateToStatusItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]!.startedAt).toBeUndefined();
    expect(items[0]!.endedAt).toBeUndefined();
    expect(items[0]!.exitCode).toBeUndefined();
    expect(items[0]!.stderrTail).toBeUndefined();
  });
});
