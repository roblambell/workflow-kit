// Tests for core/commands/orchestrate.ts — Event loop, state reconstruction,
// adaptive polling, structured logging, and SIGINT handling.

import { describe, it, expect, vi } from "vitest";
import {
  orchestrateLoop,
  adaptivePollInterval,
  reconstructState,
  interruptibleSleep,
  computeDefaultWipLimit,
  type LogEntry,
  type OrchestrateLoopDeps,
} from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
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
  };
}

function mockActionDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/todo-test",
      workspaceRef: "workspace:1",
    })),
    cleanSingleWorktree: vi.fn(() => true),
    cmdMarkDone: vi.fn(),
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
  todosFile: "/tmp/test-project/TODOS.md",
  aiTool: "claude",
};

// ── Tests ────────────────────────────────────────────────────────────

describe("orchestrateLoop", () => {
  it("processes items through full lifecycle (single item, asap strategy)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1: // T-1-1 has no deps, should be ready
          return { items: [], readyIds: ["T-1-1"] };
        case 2: // Worker launched and alive
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3: // PR appeared with CI pass → triggers merge (asap)
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4: // PR merged (after merge action)
          return { items: [], readyIds: [] };
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

    await orchestrateLoop(orch, defaultCtx, deps);

    // Item should be fully done
    expect(orch.getItem("T-1-1")!.state).toBe("done");

    // Structured logs include start and complete events
    expect(logs.some((l) => l.event === "orchestrate_start")).toBe(true);
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);

    // Transition logs were emitted
    const transitions = logs.filter((l) => l.event === "transition");
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.some((l) => l.itemId === "T-1-1")).toBe(true);

    // Action logs were emitted
    expect(logs.some((l) => l.event === "action_execute" && l.action === "launch")).toBe(true);
    expect(logs.some((l) => l.event === "action_execute" && l.action === "merge")).toBe(true);
  });

  it("processes dependency chain across batches", async () => {
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "asap" });
    orch.addItem(makeTodo("A-1-1"));
    orch.addItem(makeTodo("A-1-2", ["A-1-1"]));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycle++;
      const readyIds: string[] = [];
      const items: ItemSnapshot[] = [];

      for (const item of o.getAllItems()) {
        if (item.state === "queued") {
          const depsMet = item.todo.dependencies.every((depId) => {
            const dep = o.getItem(depId);
            return !dep || dep.state === "done" || dep.state === "merged";
          });
          if (depsMet) readyIds.push(item.id);
          continue;
        }
        if (item.state === "done" || item.state === "stuck") continue;

        // Simulate lifecycle progression based on current state
        if (item.state === "launching") {
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          items.push({
            id: item.id,
            prNumber: cycle,
            prState: "open",
            ciStatus: "pass",
          });
        } else if (item.state === "merging" || item.state === "merged") {
          // After merge action, PR shows as merged
          items.push({ id: item.id, prState: "merged" });
        }
      }

      return { items, readyIds };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    expect(orch.getItem("A-1-1")!.state).toBe("done");
    expect(orch.getItem("A-1-2")!.state).toBe("done");

    // Both items had launch actions
    const launchActions = logs.filter((l) => l.event === "action_execute" && l.action === "launch");
    expect(launchActions).toHaveLength(2);
    expect(launchActions.some((l) => l.itemId === "A-1-1")).toBe(true);
    expect(launchActions.some((l) => l.itemId === "A-1-2")).toBe(true);

    // Complete event shows both done
    const complete = logs.find((l) => l.event === "orchestrate_complete");
    expect(complete).toBeDefined();
    expect(complete!.done).toBe(2);
    expect(complete!.stuck).toBe(0);
  });

  it("respects WIP limit during batch processing", async () => {
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "asap" });
    orch.addItem(makeTodo("W-1-1"));
    orch.addItem(makeTodo("W-1-2"));

    let cycle = 0;
    const launchedItems: string[] = [];

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycle++;
      const readyIds: string[] = [];
      const items: ItemSnapshot[] = [];

      for (const item of o.getAllItems()) {
        if (item.state === "queued") {
          const depsMet = item.todo.dependencies.every((depId) => {
            const dep = o.getItem(depId);
            return !dep || dep.state === "done" || dep.state === "merged";
          });
          if (depsMet) readyIds.push(item.id);
          continue;
        }
        if (item.state === "done" || item.state === "stuck") continue;

        if (item.state === "launching") {
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          items.push({ id: item.id, prNumber: cycle, prState: "open", ciStatus: "pass" });
        } else if (item.state === "merging" || item.state === "merged") {
          items.push({ id: item.id, prState: "merged" });
        }
      }

      return { items, readyIds };
    };

    const actionDeps = mockActionDeps({
      launchSingleItem: vi.fn((item: TodoItem) => {
        launchedItems.push(item.id);
        return { worktreePath: `/tmp/test/todo-${item.id}`, workspaceRef: `ws:${item.id}` };
      }),
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // Both items completed, but W-1-1 launched before W-1-2
    expect(orch.getItem("W-1-1")!.state).toBe("done");
    expect(orch.getItem("W-1-2")!.state).toBe("done");
    expect(launchedItems[0]).toBe("W-1-1");
    expect(launchedItems[1]).toBe("W-1-2");
  });

  it("handles stuck items and completes remaining", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("S-1-1"));
    orch.addItem(makeTodo("S-1-2"));

    let cycle = 0;

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycle++;
      const readyIds: string[] = [];
      const items: ItemSnapshot[] = [];

      for (const item of o.getAllItems()) {
        if (item.state === "queued") {
          readyIds.push(item.id);
          continue;
        }
        if (item.state === "done" || item.state === "stuck") continue;

        if (item.state === "launching") {
          if (item.id === "S-1-1") {
            // S-1-1 worker dies without PR
            items.push({ id: item.id, workerAlive: false });
          } else {
            items.push({ id: item.id, workerAlive: true });
          }
        } else if (item.state === "implementing") {
          items.push({ id: item.id, prNumber: cycle, prState: "open", ciStatus: "pass" });
        } else if (item.state === "merging" || item.state === "merged") {
          items.push({ id: item.id, prState: "merged" });
        }
      }

      return { items, readyIds };
    };

    const logs: LogEntry[] = [];
    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    expect(orch.getItem("S-1-1")!.state).toBe("stuck");
    expect(orch.getItem("S-1-2")!.state).toBe("done");

    const complete = logs.find((l) => l.event === "orchestrate_complete");
    expect(complete!.done).toBe(1);
    expect(complete!.stuck).toBe(1);
  });

  it("stops on SIGINT and emits shutdown log", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("I-1-1"));

    const abortController = new AbortController();
    const logs: LogEntry[] = [];
    let sleepCount = 0;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: () => ({ items: [], readyIds: ["I-1-1"] }),
      sleep: async () => {
        sleepCount++;
        if (sleepCount >= 2) {
          abortController.abort();
        }
      },
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, {}, abortController.signal);

    expect(logs.some((l) => l.event === "shutdown" && l.reason === "SIGINT")).toBe(true);
    // Loop exited cleanly — did not process to completion
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(false);
  });

  it("emits structured log with state_summary on each cycle", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("L-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle === 1) return { items: [], readyIds: ["L-1-1"] };
      if (cycle === 2) return { items: [{ id: "L-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3)
        return { items: [{ id: "L-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    const summaries = logs.filter((l) => l.event === "state_summary");
    expect(summaries.length).toBeGreaterThan(0);
    // Each summary has a states object
    for (const s of summaries) {
      expect(s.states).toBeDefined();
    }
  });
});

describe("adaptivePollInterval", () => {
  it("returns 10s when items are ready", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "ready");

    expect(adaptivePollInterval(orch)).toBe(10_000);
  });

  it("returns 30s when workers are active", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "implementing");

    expect(adaptivePollInterval(orch)).toBe(30_000);
  });

  it("returns 30s when workers are launching", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "launching");

    expect(adaptivePollInterval(orch)).toBe(30_000);
  });

  it("returns 120s when waiting for reviews/CI", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "ci-pending");

    expect(adaptivePollInterval(orch)).toBe(120_000);
  });

  it("returns 120s when all items are in terminal states", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "done");

    expect(adaptivePollInterval(orch)).toBe(120_000);
  });

  it("prioritizes ready (10s) over implementing (30s)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.addItem(makeTodo("A-1-2"));
    orch.setState("A-1-1", "ready");
    orch.setState("A-1-2", "implementing");

    expect(adaptivePollInterval(orch)).toBe(10_000);
  });
});

describe("reconstructState", () => {
  it("is a no-op when no worktrees exist", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("R-1-1"));

    // Non-existent worktree dir — items stay queued
    reconstructState(orch, "/nonexistent", "/nonexistent/.worktrees");

    expect(orch.getItem("R-1-1")!.state).toBe("queued");
  });
});

describe("interruptibleSleep", () => {
  it("resolves after timeout", async () => {
    const start = Date.now();
    await interruptibleSleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await interruptibleSleep(5000, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("resolves early when signal fires during sleep", async () => {
    const controller = new AbortController();

    const start = Date.now();
    const sleepPromise = interruptibleSleep(5000, controller.signal);

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50);

    await sleepPromise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

describe("computeDefaultWipLimit", () => {
  const GB = 1024 ** 3;

  it("returns 5 for 16GB machine", () => {
    expect(computeDefaultWipLimit(() => 16 * GB)).toBe(5);
  });

  it("returns 2 for 8GB machine", () => {
    expect(computeDefaultWipLimit(() => 8 * GB)).toBe(2);
  });

  it("returns minimum of 2 for very low memory (4GB)", () => {
    expect(computeDefaultWipLimit(() => 4 * GB)).toBe(2);
  });

  it("returns minimum of 2 for extremely low memory (1GB)", () => {
    expect(computeDefaultWipLimit(() => 1 * GB)).toBe(2);
  });

  it("returns 8 for 24GB machine", () => {
    expect(computeDefaultWipLimit(() => 24 * GB)).toBe(8);
  });

  it("returns 10 for 32GB machine", () => {
    expect(computeDefaultWipLimit(() => 32 * GB)).toBe(10);
  });

  it("returns 21 for 64GB machine", () => {
    expect(computeDefaultWipLimit(() => 64 * GB)).toBe(21);
  });

  it("handles fractional GB correctly (e.g. 15.8GB)", () => {
    // 15.8 / 3 = 5.26 → floor → 5
    expect(computeDefaultWipLimit(() => 15.8 * GB)).toBe(5);
  });

  it("uses os.totalmem() by default (no argument)", () => {
    // Just verify it returns a reasonable number without throwing
    const result = computeDefaultWipLimit();
    expect(result).toBeGreaterThanOrEqual(2);
    expect(typeof result).toBe("number");
  });
});
