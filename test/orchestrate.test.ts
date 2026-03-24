// Tests for core/commands/orchestrate.ts — Event loop, state reconstruction,
// adaptive polling, structured logging, SIGINT handling, and daemon mode.

import { describe, it, expect, vi } from "vitest";
import { join } from "path";
import {
  orchestrateLoop,
  adaptivePollInterval,
  reconstructState,
  interruptibleSleep,
  computeDefaultWipLimit,
  buildSnapshot,
  launchStatusPane,
  closeStatusPane,
  isInsideWorkspace,
  isWorkerAlive,
  forkDaemon,
  STATUS_PANE_NAME,
  type LogEntry,
  type OrchestrateLoopDeps,
  type EnvAccessor,
} from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type OrchestratorItem,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";
import type { Multiplexer } from "../core/mux.ts";

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

    // Complete event includes items array
    const complete = logs.find((l) => l.event === "orchestrate_complete");
    expect(complete).toBeDefined();
    const items = complete!.items as Array<{ id: string; state: string; prUrl: string | null }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: "T-1-1", state: "done", prUrl: null });
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

    // Complete event shows both done with items array
    const complete = logs.find((l) => l.event === "orchestrate_complete");
    expect(complete).toBeDefined();
    expect(complete!.done).toBe(2);
    expect(complete!.stuck).toBe(0);
    const items = complete!.items as Array<{ id: string; state: string; prUrl: string | null }>;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.state === "done")).toBe(true);
    expect(items.map((i) => i.id).sort()).toEqual(["A-1-1", "A-1-2"]);
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

  it("includes items with prUrl in orchestrate_complete when repoUrl is configured", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("U-1-1"));
    orch.addItem(makeTodo("U-1-2"));

    let cycle = 0;
    const logs: LogEntry[] = [];

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
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          // U-1-1 gets a PR, U-1-2 worker dies (no PR → stuck)
          if (item.id === "U-1-1") {
            items.push({ id: item.id, prNumber: 42, prState: "open", ciStatus: "pass" });
          } else {
            items.push({ id: item.id, workerAlive: false });
          }
        } else if (item.state === "merging" || item.state === "merged") {
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

    await orchestrateLoop(orch, defaultCtx, deps, {
      repoUrl: "https://github.com/test-org/test-repo",
    });

    expect(orch.getItem("U-1-1")!.state).toBe("done");
    expect(orch.getItem("U-1-2")!.state).toBe("stuck");

    const complete = logs.find((l) => l.event === "orchestrate_complete");
    expect(complete).toBeDefined();
    const items = complete!.items as Array<{ id: string; state: string; prUrl: string | null }>;
    expect(items).toHaveLength(2);

    // U-1-1 has a PR URL (it got merged via PR #42)
    const item1 = items.find((i) => i.id === "U-1-1")!;
    expect(item1.state).toBe("done");
    expect(item1.prUrl).toBe("https://github.com/test-org/test-repo/pull/42");

    // U-1-2 is stuck with no PR
    const item2 = items.find((i) => i.id === "U-1-2")!;
    expect(item2.state).toBe("stuck");
    expect(item2.prUrl).toBeNull();
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
    const items = complete!.items as Array<{ id: string; state: string; prUrl: string | null }>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.id === "S-1-1")!.state).toBe("stuck");
    expect(items.find((i) => i.id === "S-1-2")!.state).toBe("done");
  });

  it("runs worktree cleanup sweep for all managed items before orchestrate_complete", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("CL-1-1"));
    orch.addItem(makeTodo("CL-1-2"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const cleanedItemIds: string[] = [];

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
      cleanSingleWorktree: vi.fn((id: string) => {
        cleanedItemIds.push(id);
        return true; // simulate stale worktree found and cleaned
      }),
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // Both items completed
    expect(orch.getItem("CL-1-1")!.state).toBe("done");
    expect(orch.getItem("CL-1-2")!.state).toBe("done");

    // Cleanup sweep ran for both items (final sweep calls cleanSingleWorktree for all managed items)
    expect(cleanedItemIds).toContain("CL-1-1");
    expect(cleanedItemIds).toContain("CL-1-2");

    // worktree_cleanup_sweep log emitted before orchestrate_complete
    const sweepLog = logs.find((l) => l.event === "worktree_cleanup_sweep");
    expect(sweepLog).toBeDefined();
    expect(sweepLog!.count).toBe(2);
    expect(sweepLog!.cleanedIds).toEqual(expect.arrayContaining(["CL-1-1", "CL-1-2"]));

    // Verify sweep log appears before complete log
    const sweepIndex = logs.findIndex((l) => l.event === "worktree_cleanup_sweep");
    const completeIndex = logs.findIndex((l) => l.event === "orchestrate_complete");
    expect(sweepIndex).toBeLessThan(completeIndex);
  });

  it("cleanup sweep is no-op when no stale worktrees exist", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("CN-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle === 1) return { items: [], readyIds: ["CN-1-1"] };
      if (cycle === 2) return { items: [{ id: "CN-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3)
        return { items: [{ id: "CN-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const actionDeps = mockActionDeps({
      cleanSingleWorktree: vi.fn(() => false), // no stale worktree found
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // No sweep log emitted when nothing was cleaned
    expect(logs.some((l) => l.event === "worktree_cleanup_sweep")).toBe(false);
    // But orchestrate_complete still emitted
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);
  });

  it("cleanup sweep handles errors gracefully without blocking exit", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("CE-1-1"));
    orch.addItem(makeTodo("CE-1-2"));

    let cycle = 0;
    const logs: LogEntry[] = [];

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
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          items.push({ id: item.id, prNumber: cycle, prState: "open", ciStatus: "pass" });
        } else if (item.state === "merging" || item.state === "merged") {
          items.push({ id: item.id, prState: "merged" });
        }
      }

      return { items, readyIds };
    };

    let callCount = 0;
    const actionDeps = mockActionDeps({
      cleanSingleWorktree: vi.fn(() => {
        callCount++;
        if (callCount === 1) throw new Error("git worktree remove failed");
        return true; // second item cleaned successfully
      }),
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // Loop completed despite error in cleanup
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);

    // Sweep log only shows the successfully cleaned item
    const sweepLog = logs.find((l) => l.event === "worktree_cleanup_sweep");
    expect(sweepLog).toBeDefined();
    expect(sweepLog!.count).toBe(1);
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

  it("transitions to done without mark-done action (workers remove their own TODO)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("D-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const actionDeps = mockActionDeps();

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1: // Ready
          return { items: [], readyIds: ["D-1-1"] };
        case 2: // Worker alive
          return { items: [{ id: "D-1-1", workerAlive: true }], readyIds: [] };
        case 3: // PR with CI pass → merge
          return {
            items: [{ id: "D-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4: // After merge, item transitions merged → done without mark-done
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // Item reaches done
    expect(orch.getItem("D-1-1")!.state).toBe("done");

    // No mark-done action — workers remove their own TODO in their PR branch
    expect(
      logs.every((l) => !(l.event === "action_execute" && l.action === "mark-done")),
    ).toBe(true);
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
  it("returns 5s when items are ready", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "ready");

    expect(adaptivePollInterval(orch)).toBe(5_000);
  });

  it("returns 10s when workers are active", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "implementing");

    expect(adaptivePollInterval(orch)).toBe(10_000);
  });

  it("returns 10s when workers are launching", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "launching");

    expect(adaptivePollInterval(orch)).toBe(10_000);
  });

  it("returns 15s when waiting for CI", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "ci-pending");

    expect(adaptivePollInterval(orch)).toBe(15_000);
  });

  it("returns 30s when all items are in terminal states", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.setState("A-1-1", "done");

    expect(adaptivePollInterval(orch)).toBe(30_000);
  });

  it("prioritizes ready (5s) over implementing (10s)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("A-1-1"));
    orch.addItem(makeTodo("A-1-2"));
    orch.setState("A-1-1", "ready");
    orch.setState("A-1-2", "implementing");

    expect(adaptivePollInterval(orch)).toBe(5_000);
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

  it("recovers workspaceRef from live cmux workspaces during reconstruction", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-DF-1"));

    // Create a temp worktree dir to simulate existing worktree
    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-H-DF-1");
    require("fs").mkdirSync(wtPath, { recursive: true });

    // Mock mux that reports a live workspace matching the item ID
    const fakeMux = {
      isAvailable: () => true,
      launchWorkspace: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () =>
        "  workspace:29  ✳ TODO H-DF-1: Workers remove their own TODO item",
      closeWorkspace: () => true,
    };

    // Pass no-op checkPr to avoid shelling out
    const noopCheckPr = () => null;
    reconstructState(orch, tmpDir, wtDir, fakeMux, noopCheckPr);

    const item = orch.getItem("H-DF-1")!;
    expect(item.state).toBe("implementing");
    expect(item.workspaceRef).toBe("workspace:29");

    // Cleanup
    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves workspaceRef undefined when no matching workspace found", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-DF-2"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test2-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-H-DF-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    // Mock mux with no matching workspaces
    const fakeMux = {
      isAvailable: () => true,
      launchWorkspace: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "  workspace:1  main",
      closeWorkspace: () => true,
    };

    const noopCheckPr = () => null;
    reconstructState(orch, tmpDir, wtDir, fakeMux, noopCheckPr);

    const item = orch.getItem("H-DF-2")!;
    expect(item.state).toBe("implementing");
    expect(item.workspaceRef).toBeUndefined();

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
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

// ── buildSnapshot with lastCommitTime ─────────────────────────────

describe("buildSnapshot lastCommitTime", () => {
  /** Create a mock multiplexer that reports no workspaces. */
  function mockMux(workspaces: string = ""): Multiplexer {
    return {
      isAvailable: () => true,
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  /** No-op checkPr to avoid gh CLI dependency in tests. */
  const noOpCheckPr = () => null;

  it("includes lastCommitTime for implementing items", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("HC-1-1"));
    orch.setState("HC-1-1", "implementing");
    // Set workspace ref so worker appears alive
    const item = orch.getItem("HC-1-1")!;
    item.workspaceRef = "workspace:1";

    const fixedTime = "2026-03-24T12:05:30+00:00";
    const getLastCommitTime = vi.fn(() => fixedTime);
    const mux = mockMux("workspace:1");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    // getLastCommitTime was called with the right branch name
    expect(getLastCommitTime).toHaveBeenCalledWith("/tmp/project", "todo/HC-1-1");

    // Snapshot includes lastCommitTime
    const snapItem = snapshot.items.find((i) => i.id === "HC-1-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.lastCommitTime).toBe(fixedTime);

    // Orchestrator item also updated
    expect(orch.getItem("HC-1-1")!.lastCommitTime).toBe(fixedTime);
  });

  it("lastCommitTime is null when worktree has no commits beyond base", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("HC-2-1"));
    orch.setState("HC-2-1", "implementing");
    const item = orch.getItem("HC-2-1")!;
    item.workspaceRef = "workspace:2";

    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux("workspace:2");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "HC-2-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.lastCommitTime).toBeNull();

    // Orchestrator item also null
    expect(orch.getItem("HC-2-1")!.lastCommitTime).toBeNull();
  });

  it("includes lastCommitTime for launching items (branch may not exist yet)", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("HC-3-1"));
    orch.setState("HC-3-1", "launching");
    const item = orch.getItem("HC-3-1")!;
    item.workspaceRef = "workspace:3";

    // Branch doesn't exist yet → null
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux("workspace:3");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "HC-3-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.lastCommitTime).toBeNull();
  });

  it("does not query lastCommitTime for non-active states", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("HC-4-1"));
    orch.setState("HC-4-1", "ci-pending");

    const getLastCommitTime = vi.fn(() => "2026-03-24T12:00:00+00:00");
    const mux = mockMux();

    buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    // Should not have been called for ci-pending items
    expect(getLastCommitTime).not.toHaveBeenCalled();
  });
});

// ── buildSnapshot isMergeable propagation (H-ORC-1) ──────────────

describe("buildSnapshot isMergeable", () => {
  function mockMux(workspaces: string = ""): Multiplexer {
    return {
      isAvailable: () => true,
      launchWorkspace: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  it("sets isMergeable=true when checkPr returns MERGEABLE in 4th field", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("M-1-1"));
    orch.setState("M-1-1", "ci-pending");

    // Simulate checkPr returning: ID\tPR\tSTATUS\tMERGEABLE
    const checkPr = () => "M-1-1\t10\tfailing\tMERGEABLE";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-1-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBe(true);
    expect(snapItem!.ciStatus).toBe("fail");
  });

  it("sets isMergeable=false when checkPr returns CONFLICTING in 4th field", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("M-2-1"));
    orch.setState("M-2-1", "ci-pending");

    const checkPr = () => "M-2-1\t10\tfailing\tCONFLICTING";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-2-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBe(false);
    expect(snapItem!.ciStatus).toBe("fail");
  });

  it("does not set isMergeable when 4th field is UNKNOWN", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("M-3-1"));
    orch.setState("M-3-1", "ci-pending");

    const checkPr = () => "M-3-1\t10\tpending\tUNKNOWN";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-3-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBeUndefined();
  });

  it("does not set isMergeable when checkPr returns 3-field format (backward compat)", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("M-4-1"));
    orch.setState("M-4-1", "ci-pending");

    // Old 3-field format without mergeable
    const checkPr = () => "M-4-1\t10\tpending";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-4-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBeUndefined();
  });
});

// ── Status pane management ────────────────────────────────────────

describe("launchStatusPane", () => {
  function mockMux(overrides?: Partial<Multiplexer>): Multiplexer {
    return {
      isAvailable: () => true,
      launchWorkspace: vi.fn(() => "workspace:99"),
      splitPane: vi.fn(() => "pane:1"),
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: vi.fn(() => true),
      ...overrides,
    };
  }

  /** Env that simulates running outside any workspace. */
  const noWorkspaceEnv: EnvAccessor = () => undefined;

  /** Env that simulates running inside a cmux workspace. */
  const cmuxWorkspaceEnv: EnvAccessor = (key) =>
    key === "CMUX_WORKSPACE_ID" ? "workspace:5" : undefined;

  /** Env that simulates running inside a tmux session. */
  const tmuxWorkspaceEnv: EnvAccessor = (key) =>
    key === "TMUX" ? "/tmp/tmux-501/default,12345,0" : undefined;

  it("launches status pane via mux.launchWorkspace when not in a workspace", () => {
    const mux = mockMux();
    const ref = launchStatusPane(mux, "/tmp/project", noWorkspaceEnv);

    expect(ref).toBe("workspace:99");
    expect(mux.launchWorkspace).toHaveBeenCalledWith(
      "/tmp/project",
      "ninthwave status --watch",
    );
    expect(mux.splitPane).not.toHaveBeenCalled();
  });

  it("uses nw-status as the status pane identifier constant", () => {
    expect(STATUS_PANE_NAME).toBe("nw-status");
  });

  it("returns null when mux is not available", () => {
    const mux = mockMux({ isAvailable: () => false });
    const ref = launchStatusPane(mux, "/tmp/project", noWorkspaceEnv);

    expect(ref).toBeNull();
    expect(mux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("returns null when launchWorkspace fails and not in a workspace", () => {
    const mux = mockMux({ launchWorkspace: vi.fn(() => null) });
    const ref = launchStatusPane(mux, "/tmp/project", noWorkspaceEnv);

    expect(ref).toBeNull();
  });

  it("splits pane when CMUX_WORKSPACE_ID is set", () => {
    const mux = mockMux();
    const ref = launchStatusPane(mux, "/tmp/project", cmuxWorkspaceEnv);

    expect(ref).toBe("pane:1");
    expect(mux.splitPane).toHaveBeenCalledWith("ninthwave status --watch");
    expect(mux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("splits pane when TMUX env var is set", () => {
    const mux = mockMux();
    const ref = launchStatusPane(mux, "/tmp/project", tmuxWorkspaceEnv);

    expect(ref).toBe("pane:1");
    expect(mux.splitPane).toHaveBeenCalledWith("ninthwave status --watch");
    expect(mux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to launchWorkspace when splitPane fails inside a workspace", () => {
    const mux = mockMux({ splitPane: vi.fn(() => null) });
    const ref = launchStatusPane(mux, "/tmp/project", cmuxWorkspaceEnv);

    expect(ref).toBe("workspace:99");
    expect(mux.splitPane).toHaveBeenCalledWith("ninthwave status --watch");
    expect(mux.launchWorkspace).toHaveBeenCalledWith(
      "/tmp/project",
      "ninthwave status --watch",
    );
  });
});

describe("isInsideWorkspace", () => {
  it("returns true when CMUX_WORKSPACE_ID is set", () => {
    const env: EnvAccessor = (key) =>
      key === "CMUX_WORKSPACE_ID" ? "workspace:5" : undefined;
    expect(isInsideWorkspace(env)).toBe(true);
  });

  it("returns true when TMUX is set", () => {
    const env: EnvAccessor = (key) =>
      key === "TMUX" ? "/tmp/tmux-501/default,12345,0" : undefined;
    expect(isInsideWorkspace(env)).toBe(true);
  });

  it("returns false when neither env var is set", () => {
    const env: EnvAccessor = () => undefined;
    expect(isInsideWorkspace(env)).toBe(false);
  });

  it("returns true when both env vars are set", () => {
    const env: EnvAccessor = (key) => {
      if (key === "CMUX_WORKSPACE_ID") return "workspace:5";
      if (key === "TMUX") return "/tmp/tmux-501/default,12345,0";
      return undefined;
    };
    expect(isInsideWorkspace(env)).toBe(true);
  });
});

describe("closeStatusPane", () => {
  it("closes the status pane workspace", () => {
    const closeWorkspace = vi.fn(() => true);
    const mux: Multiplexer = {
      isAvailable: () => true,
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace,
    };

    closeStatusPane(mux, "workspace:99");
    expect(closeWorkspace).toHaveBeenCalledWith("workspace:99");
  });

  it("is a no-op when ref is null", () => {
    const closeWorkspace = vi.fn(() => true);
    const mux: Multiplexer = {
      isAvailable: () => true,
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace,
    };

    closeStatusPane(mux, null);
    expect(closeWorkspace).not.toHaveBeenCalled();
  });
});

// ── onPollComplete callback ──────────────────────────────────────────

describe("onPollComplete callback", () => {
  it("is called each poll cycle with current items", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const pollCompleteCalls: any[] = [];

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
        if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      onPollComplete: (items) => {
        pollCompleteCalls.push(items.map((i) => ({ id: i.id, state: i.state })));
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // Should have been called multiple times during the loop
    expect(pollCompleteCalls.length).toBeGreaterThan(0);
    // Each call should contain the current item states
    for (const call of pollCompleteCalls) {
      expect(call.length).toBe(1);
      expect(call[0].id).toBe("T-1-1");
    }
  });

  it("loop works fine without onPollComplete (undefined)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
        if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      // onPollComplete not set
    };

    await orchestrateLoop(orch, defaultCtx, deps);
    expect(orch.getItem("T-1-1")!.state).toBe("done");
  });
});

// ── forkDaemon ───────────────────────────────────────────────────────

describe("forkDaemon", () => {
  it("spawns a detached child and writes PID file", () => {
    const mockChild = { pid: 42, unref: vi.fn() };
    const spawnFn = vi.fn(() => mockChild) as any;
    const openFn = vi.fn(() => 3) as any; // fake fd

    const files = new Map<string, string>();
    const daemonIO = {
      writeFileSync: vi.fn((p: string, c: string) => files.set(p, c)),
      readFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      existsSync: vi.fn((p: string) => files.has(p)),
      mkdirSync: vi.fn(),
    };

    const result = forkDaemon(
      ["--items", "T-1-1", "--_daemon-child"],
      "/project",
      spawnFn,
      openFn,
      daemonIO,
    );

    expect(result.pid).toBe(42);
    expect(result.logPath).toBe("/project/.ninthwave/orchestrator.log");
    expect(mockChild.unref).toHaveBeenCalled();

    // PID file was written
    expect(files.get("/project/.ninthwave/orchestrator.pid")).toBe("42");

    // spawn was called with detached: true
    expect(spawnFn).toHaveBeenCalled();
    const spawnOpts = spawnFn.mock.calls[0][2];
    expect(spawnOpts.detached).toBe(true);
    expect(spawnOpts.stdio[0]).toBe("ignore");
  });
});

// ── Post-merge sibling conflict detection in orchestrateLoop ──────────

describe("orchestrateLoop post-merge conflict detection", () => {
  it("checks sibling PRs for conflicts after a merge and sends rebase to conflicting ones", async () => {
    const orch = new Orchestrator({ wipLimit: 3, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));
    orch.addItem(makeTodo("T-1-2"));
    orch.addItem(makeTodo("T-1-3"));

    // T-1-1 is in ci-pending (about to pass CI and get merged by orchestrator)
    // T-1-2 and T-1-3 are also in-flight with PRs
    orch.setState("T-1-1", "ci-pending");
    orch.getItem("T-1-1")!.prNumber = 10;
    orch.getItem("T-1-1")!.workspaceRef = "workspace:1";
    orch.setState("T-1-2", "ci-pending");
    orch.getItem("T-1-2")!.prNumber = 11;
    orch.getItem("T-1-2")!.workspaceRef = "workspace:2";
    orch.setState("T-1-3", "ci-pending");
    orch.getItem("T-1-3")!.prNumber = 12;
    orch.getItem("T-1-3")!.workspaceRef = "workspace:3";

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      const items: ItemSnapshot[] = [];
      for (const item of o.getAllItems()) {
        if (item.state === "done" || item.state === "stuck") continue;
        if (item.state === "merging" || item.state === "merged") {
          // After orchestrator merges, PR shows as merged next cycle
          items.push({ id: item.id, prNumber: item.prNumber, prState: "merged" });
        } else {
          // All PRs have CI pass
          items.push({
            id: item.id,
            prNumber: item.prNumber,
            prState: "open",
            ciStatus: "pass",
          });
        }
      }
      return { items, readyIds: [] };
    };

    // checkPrMergeable: T-1-2 (PR #11) has conflicts, T-1-3 (PR #12) is fine
    const checkPrMergeable = vi.fn((_: string, prNum: number) => prNum !== 11);
    const sendMessage = vi.fn(() => true);
    const warn = vi.fn();

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps({ checkPrMergeable, sendMessage, warn }),
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // checkPrMergeable should have been called for sibling PRs when T-1-1 merged
    expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 11);
    expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 12);

    // Rebase message should be sent to T-1-2 (conflicting)
    expect(sendMessage).toHaveBeenCalledWith(
      "workspace:2",
      expect.stringContaining("merge conflicts"),
    );
  });

  it("does not check sibling PRs when checkPrMergeable is not provided", async () => {
    const orch = new Orchestrator({ wipLimit: 3, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));
    orch.addItem(makeTodo("T-1-2"));

    // T-1-1 about to pass CI and get merged; T-1-2 also in-flight
    orch.setState("T-1-1", "ci-pending");
    orch.getItem("T-1-1")!.prNumber = 10;
    orch.getItem("T-1-1")!.workspaceRef = "workspace:1";
    orch.setState("T-1-2", "ci-pending");
    orch.getItem("T-1-2")!.prNumber = 11;
    orch.getItem("T-1-2")!.workspaceRef = "workspace:2";

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      const items: ItemSnapshot[] = [];
      for (const item of o.getAllItems()) {
        if (item.state === "done" || item.state === "stuck") continue;
        if (item.state === "merging" || item.state === "merged") {
          items.push({ id: item.id, prNumber: item.prNumber, prState: "merged" });
        } else {
          items.push({
            id: item.id,
            prNumber: item.prNumber,
            prState: "open",
            ciStatus: "pass",
          });
        }
      }
      return { items, readyIds: [] };
    };

    const sendMessage = vi.fn(() => true);

    // Explicitly omit checkPrMergeable from deps
    const actionDeps = mockActionDeps({ sendMessage });
    delete actionDeps.checkPrMergeable;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // No rebase-for-conflicts messages should be sent
    const conflictRebaseCalls = sendMessage.mock.calls.filter(
      (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("merge conflicts"),
    );
    expect(conflictRebaseCalls.length).toBe(0);
  });
});

// ── isWorkerAlive per-line matching (L-WRK-9) ────────────────────

describe("isWorkerAlive", () => {
  function mockMux(workspaces: string): Multiplexer {
    return {
      isAvailable: () => true,
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  function makeItem(id: string, workspaceRef?: string): OrchestratorItem {
    return {
      id,
      todo: makeTodo(id),
      state: "implementing",
      workspaceRef,
      lastTransition: new Date().toISOString(),
      ciFailCount: 0,
      retryCount: 0,
    };
  }

  it("returns true for an exact workspace ref match", () => {
    const mux = mockMux("  workspace:1  ✳ TODO T-1-1: some task");
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("returns true when matching by item ID", () => {
    const mux = mockMux("  workspace:5  ✳ TODO T-2-1: another task");
    const item = makeItem("T-2-1", "workspace:5");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("does not false-positive: workspace:1 must not match workspace:10", () => {
    const mux = mockMux("  workspace:10  ✳ TODO T-3-1: unrelated task");
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });

  it("does not false-positive: item ID partial match across lines", () => {
    // T-1 should not match a line containing T-10
    const mux = mockMux("  workspace:5  ✳ TODO T-10-1: unrelated task");
    const item = makeItem("T-1", "workspace:99");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });

  it("returns false when workspaceRef is undefined", () => {
    const mux = mockMux("  workspace:1  ✳ TODO T-1-1: some task");
    const item = makeItem("T-1-1", undefined);
    expect(isWorkerAlive(item, mux)).toBe(false);
  });

  it("returns false when workspace listing is empty", () => {
    const mux = mockMux("");
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });

  it("matches correctly in a multi-line listing", () => {
    const listing = [
      "  workspace:10  ✳ TODO T-10-1: task ten",
      "  workspace:1  ✳ TODO T-1-1: task one",
      "  workspace:2  ✳ TODO T-2-1: task two",
    ].join("\n");
    const mux = mockMux(listing);

    const item1 = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item1, mux)).toBe(true);

    const item10 = makeItem("T-10-1", "workspace:10");
    expect(isWorkerAlive(item10, mux)).toBe(true);

    const itemMissing = makeItem("T-99-1", "workspace:99");
    expect(isWorkerAlive(itemMissing, mux)).toBe(false);
  });
});
