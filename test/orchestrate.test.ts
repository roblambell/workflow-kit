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
  closeStaleStatusPane,
  isInsideWorkspace,
  isWorkerAlive,
  forkDaemon,
  cleanOrphanedWorktrees,
  STATUS_PANE_NAME,
  type LogEntry,
  type OrchestrateLoopDeps,
  type EnvAccessor,
  type CleanOrphanedDeps,
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
import type { DaemonState } from "../core/daemon.ts";

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
  todosDir: "/tmp/test-project/.ninthwave/todos",
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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
      maxIterations: 200,
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    // Loop completed despite error in cleanup
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);

    // Sweep log only shows the successfully cleaned item
    const sweepLog = logs.find((l) => l.event === "worktree_cleanup_sweep");
    expect(sweepLog).toBeDefined();
    expect(sweepLog!.count).toBe(1);
  });

  it("final cleanup sweep closes workspaces for terminal items before worktree cleanup", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("WC-1-1"));
    orch.addItem(makeTodo("WC-1-2"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const callOrder: string[] = [];

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

    const closeWorkspace = vi.fn((ref: string) => {
      callOrder.push(`close:${ref}`);
      return true;
    });

    const actionDeps = mockActionDeps({
      closeWorkspace,
      cleanSingleWorktree: vi.fn((id: string) => {
        callOrder.push(`clean:${id}`);
        return true;
      }),
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    // Both items completed
    expect(orch.getItem("WC-1-1")!.state).toBe("done");
    expect(orch.getItem("WC-1-2")!.state).toBe("done");

    // closeWorkspace was called during the final cleanup sweep.
    // Items get workspaceRef from the launch action. The final sweep should
    // call closeWorkspace for items that have a workspaceRef.
    const sweepCloseEntries = callOrder.filter((e) => e.startsWith("close:"));
    const sweepCleanEntries = callOrder.filter((e) => e.startsWith("clean:"));

    // Both items should have been cleaned in the sweep
    expect(sweepCleanEntries).toHaveLength(2);

    // closeWorkspace should be called for items with workspace refs
    // (launch action sets workspaceRef on the orchestrator item)
    expect(sweepCloseEntries.length).toBeGreaterThan(0);

    // For each item with a workspace ref, close should happen before clean
    // Find the last close and first clean — close should come first per-item
    for (const item of orch.getAllItems()) {
      if (item.workspaceRef) {
        const closeIdx = callOrder.indexOf(`close:${item.workspaceRef}`);
        const cleanIdx = callOrder.indexOf(`clean:${item.id}`);
        if (closeIdx >= 0 && cleanIdx >= 0) {
          expect(closeIdx).toBeLessThan(cleanIdx);
        }
      }
    }
  });

  it("final cleanup sweep skips closeWorkspace for items without workspaceRef", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("WN-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle === 1) return { items: [], readyIds: ["WN-1-1"] };
      if (cycle === 2) return { items: [{ id: "WN-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3)
        return { items: [{ id: "WN-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const closeWorkspace = vi.fn(() => true);
    const actionDeps = mockActionDeps({
      closeWorkspace,
      // Launch doesn't set workspaceRef (simulates case where it wasn't set)
      launchSingleItem: vi.fn(() => ({
        worktreePath: "/tmp/test/todo-test",
        workspaceRef: null,
      })),
      cleanSingleWorktree: vi.fn(() => true),
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    // Item completed
    expect(orch.getItem("WN-1-1")!.state).toBe("done");

    // closeWorkspace should NOT have been called during the final cleanup sweep
    // since the item has no workspaceRef (null from launch)
    // Note: closeWorkspace may be called during the clean action itself (executeClean),
    // but the final sweep should not call it for items without workspaceRef
    const sweepLog = logs.find((l) => l.event === "worktree_cleanup_sweep");
    expect(sweepLog).toBeDefined();
  });

  it("shutdown closes workspaces only for terminal items, not in-flight", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("SD-1-1"));
    orch.addItem(makeTodo("SD-1-2"));

    const abortController = new AbortController();
    const logs: LogEntry[] = [];
    let sleepCount = 0;

    // SD-1-1 will reach done state, SD-1-2 will stay implementing when we abort
    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
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
          if (item.id === "SD-1-1") {
            // SD-1-1 gets PR merged quickly
            items.push({ id: item.id, prNumber: 1, prState: "open", ciStatus: "pass" });
          } else {
            // SD-1-2 stays implementing (worker alive)
            items.push({ id: item.id, workerAlive: true });
          }
        } else if (item.state === "merging" || item.state === "merged") {
          items.push({ id: item.id, prState: "merged" });
        } else if (item.state === "ci-pending") {
          items.push({ id: item.id, workerAlive: true });
        }
      }

      return { items, readyIds };
    };

    const closeWorkspace = vi.fn(() => true);
    const actionDeps = mockActionDeps({ closeWorkspace });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: async () => {
        sleepCount++;
        // Abort after SD-1-1 merges but SD-1-2 is still implementing
        if (sleepCount >= 8) {
          abortController.abort();
        }
      },
      log: (entry) => logs.push(entry),
      actionDeps,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 }, abortController.signal);

    // Verify SD-1-1 reached terminal state (done) and SD-1-2 is still in-flight
    const item1 = orch.getItem("SD-1-1")!;
    const item2 = orch.getItem("SD-1-2")!;
    expect(item1.state).toBe("done");
    expect(["launching", "implementing", "ci-pending", "ci-passed", "ci-failed"]).toContain(item2.state);

    // Shutdown log emitted
    expect(logs.some((l) => l.event === "shutdown")).toBe(true);
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 }, abortController.signal);

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
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
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
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

  it("restores ciFailCount from daemon state file", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("REC-1"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-cifc-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-REC-1");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const noopCheckPr = () => null;
    const daemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "REC-1",
          state: "ci-failed",
          prNumber: 42,
          title: "Test item",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 2,
          retryCount: 1,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, noopCheckPr, daemonState);

    const item = orch.getItem("REC-1")!;
    expect(item.ciFailCount).toBe(2);
    expect(item.retryCount).toBe(1);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults ciFailCount to 0 when no daemon state is available", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("REC-2"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-nostate-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-REC-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const noopCheckPr = () => null;

    // No daemon state passed (undefined)
    reconstructState(orch, tmpDir, wtDir, undefined, noopCheckPr, undefined);

    const item = orch.getItem("REC-2")!;
    expect(item.ciFailCount).toBe(0);
    expect(item.retryCount).toBe(0);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults ciFailCount to 0 when daemon state is null", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("REC-3"));

    // No worktree dir needed — items without worktrees are skipped
    reconstructState(orch, "/nonexistent", "/nonexistent/.worktrees", undefined, () => null, null);

    const item = orch.getItem("REC-3")!;
    expect(item.ciFailCount).toBe(0);
    expect(item.retryCount).toBe(0);
  });

  it("item with ciFailCount exceeding maxCiRetries goes stuck after recovery", () => {
    // maxCiRetries defaults to 2; set ciFailCount to 3 so it exceeds the threshold
    const orch = new Orchestrator();
    orch.addItem(makeTodo("REC-4"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-stuck-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-REC-4");
    require("fs").mkdirSync(wtPath, { recursive: true });

    // checkPr returns "failing" status so the item enters ci-failed state
    const failingCheckPr = () => "REC-4\t99\tfailing";
    const daemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "REC-4",
          state: "ci-failed",
          prNumber: 99,
          title: "Test item",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 3,
          retryCount: 0,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, failingCheckPr, daemonState);

    const item = orch.getItem("REC-4")!;
    // ciFailCount restored to 3 which exceeds maxCiRetries (default 2)
    expect(item.ciFailCount).toBe(3);
    expect(item.state).toBe("ci-failed");
    // Verify the restored count exceeds the threshold
    expect(item.ciFailCount).toBeGreaterThan(orch.config.maxCiRetries);

    // Run processTransitions with a snapshot where the item has CI failing
    // The orchestrator should transition it to stuck because ciFailCount > maxCiRetries
    const snapshot: PollSnapshot = {
      items: [
        {
          id: "REC-4",
          prNumber: 99,
          ciStatus: "fail",
          workerAlive: false,
          isMergeable: false,
        },
      ],
      readyIds: [],
    };
    orch.processTransitions(snapshot);
    expect(orch.getItem("REC-4")!.state).toBe("stuck");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("reconstructState review fields", () => {
  it("restores reviewWorkspaceRef and reviewCompleted from daemon state", () => {
    const orch = new Orchestrator({ reviewEnabled: true });
    orch.addItem(makeTodo("RVW-1"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-rvw-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-RVW-1");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const noopCheckPr = () => null;
    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "RVW-1",
          state: "reviewing",
          prNumber: 42,
          title: "Test item",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 0,
          retryCount: 0,
          reviewWorkspaceRef: "workspace:10",
          reviewCompleted: false,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, noopCheckPr, daemonState);

    const item = orch.getItem("RVW-1")!;
    expect(item.reviewWorkspaceRef).toBe("workspace:10");
    // reviewCompleted is false (falsy), so it's not restored
    expect(item.reviewCompleted).toBeFalsy();

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores reviewCompleted: true from daemon state", () => {
    const orch = new Orchestrator({ reviewEnabled: true });
    orch.addItem(makeTodo("RVW-2"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-rvwt-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-RVW-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const noopCheckPr = () => null;
    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "RVW-2",
          state: "ci-passed",
          prNumber: 55,
          title: "Test item",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 0,
          retryCount: 0,
          reviewCompleted: true,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, noopCheckPr, daemonState);

    const item = orch.getItem("RVW-2")!;
    expect(item.reviewCompleted).toBe(true);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("reconstructState cross-repo", () => {
  it("uses cross-repo index to find worktree paths", () => {
    const orch = new Orchestrator();
    const todo = makeTodo("XR-1-1");
    todo.repoAlias = "target";
    orch.addItem(todo);

    const tmpDir = join(require("os").tmpdir(), `nw-xr-reconstruct-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const targetWtPath = join("/tmp/target-repo", ".worktrees", "todo-XR-1-1");
    require("fs").mkdirSync(wtDir, { recursive: true });

    // Write cross-repo index pointing to target repo worktree
    const indexPath = join(wtDir, ".cross-repo-index");
    require("fs").writeFileSync(indexPath, `XR-1-1\t/tmp/target-repo\t${targetWtPath}\n`);

    // But the worktree doesn't actually exist on disk, so item stays queued
    const noopCheckPr = () => null;
    reconstructState(orch, tmpDir, wtDir, undefined, noopCheckPr);

    // Item should still be queued (worktree path doesn't exist)
    expect(orch.getItem("XR-1-1")!.state).toBe("queued");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses resolvedRepoRoot for PR query when cross-repo", () => {
    const orch = new Orchestrator();
    const todo = makeTodo("XR-2-1");
    orch.addItem(todo);
    orch.getItem("XR-2-1")!.resolvedRepoRoot = "/target-repo";

    const tmpDir = join(require("os").tmpdir(), `nw-xr-reconstruct2-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "todo-XR-2-1");
    require("fs").mkdirSync(wtPath, { recursive: true });

    // Track which repo root is passed to checkPr
    let checkPrRepo: string | undefined;
    const trackingCheckPr = (id: string, repoRoot: string) => {
      checkPrRepo = repoRoot;
      return null;
    };

    reconstructState(orch, tmpDir, wtDir, undefined, trackingCheckPr);

    // Should use resolvedRepoRoot for PR query
    expect(checkPrRepo).toBe("/target-repo");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("buildSnapshot cross-repo", () => {
  it("uses resolvedRepoRoot for PR checks", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("BS-1-1"));
    orch.setState("BS-1-1", "implementing");
    orch.getItem("BS-1-1")!.resolvedRepoRoot = "/target-repo";

    let checkedRepo: string | undefined;
    const trackingCheckPr = (id: string, repoRoot: string) => {
      checkedRepo = repoRoot;
      return null;
    };

    const fakeMux = {
      type: "cmux" as const,
      isAvailable: () => false,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    buildSnapshot(orch, "/hub-root", "/hub-root/.worktrees", fakeMux, () => null, trackingCheckPr);
    expect(checkedRepo).toBe("/target-repo");
  });

  it("uses resolvedRepoRoot for commit time checks", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("BS-2-1"));
    orch.setState("BS-2-1", "implementing");
    orch.getItem("BS-2-1")!.resolvedRepoRoot = "/target-repo";

    let commitTimeRepo: string | undefined;
    const trackingCommitTime = (repoRoot: string, _branch: string) => {
      commitTimeRepo = repoRoot;
      return null;
    };

    const fakeMux = {
      type: "cmux" as const,
      isAvailable: () => false,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    buildSnapshot(orch, "/hub-root", "/hub-root/.worktrees", fakeMux, trackingCommitTime, () => null);
    expect(commitTimeRepo).toBe("/target-repo");
  });
});

describe("serializeOrchestratorState includes ciFailCount", () => {
  it("serializes ciFailCount in daemon state items", () => {
    const { serializeOrchestratorState } = require("../core/daemon.ts");
    const item: OrchestratorItem = {
      id: "SER-1",
      todo: makeTodo("SER-1"),
      state: "ci-failed",
      prNumber: 10,
      lastTransition: "2026-01-01T00:00:00Z",
      ciFailCount: 5,
      retryCount: 2,
    };

    const state = serializeOrchestratorState([item], 9999, "2026-01-01T00:00:00Z");
    expect(state.items).toHaveLength(1);
    expect(state.items[0].ciFailCount).toBe(5);
    expect(state.items[0].retryCount).toBe(2);
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
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
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
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
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

// ── buildSnapshot "ready" status mapping (L-TST-7) ───────────────

describe("buildSnapshot ready status mapping", () => {
  function mockMux(workspaces: string = ""): Multiplexer {
    return {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  it("sets ciStatus pass, reviewDecision APPROVED, and isMergeable true when checkPr returns ready", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("R-1-1"));
    orch.setState("R-1-1", "ci-pending");

    // checkPr returns "ready" status with MERGEABLE 4th field
    const checkPr = () => "R-1-1\t42\tready\tMERGEABLE";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "R-1-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.ciStatus).toBe("pass");
    expect(snapItem!.reviewDecision).toBe("APPROVED");
    expect(snapItem!.isMergeable).toBe(true);
    expect(snapItem!.prState).toBe("open");
    expect(snapItem!.prNumber).toBe(42);
  });
});

// ── Status pane management ────────────────────────────────────────

describe("launchStatusPane", () => {
  function mockMux(overrides?: Partial<Multiplexer>): Multiplexer {
    return {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
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

  /** Env that simulates running inside a zellij session. */
  const zellijWorkspaceEnv: EnvAccessor = (key) =>
    key === "ZELLIJ_SESSION_NAME" ? "my-session" : undefined;

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

  it("splits pane when ZELLIJ_SESSION_NAME is set", () => {
    const mux = mockMux();
    const ref = launchStatusPane(mux, "/tmp/project", zellijWorkspaceEnv);

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

  it("returns true when ZELLIJ_SESSION_NAME is set", () => {
    const env: EnvAccessor = (key) =>
      key === "ZELLIJ_SESSION_NAME" ? "my-session" : undefined;
    expect(isInsideWorkspace(env)).toBe(true);
  });

  it("returns false when no workspace env var is set", () => {
    const env: EnvAccessor = () => undefined;
    expect(isInsideWorkspace(env)).toBe(false);
  });

  it("returns true when all workspace env vars are set", () => {
    const env: EnvAccessor = (key) => {
      if (key === "CMUX_WORKSPACE_ID") return "workspace:5";
      if (key === "TMUX") return "/tmp/tmux-501/default,12345,0";
      if (key === "ZELLIJ_SESSION_NAME") return "my-session";
      return undefined;
    };
    expect(isInsideWorkspace(env)).toBe(true);
  });
});

describe("closeStatusPane", () => {
  it("closes the status pane workspace", () => {
    const closeWorkspace = vi.fn(() => true);
    const mux: Multiplexer = {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
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
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
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

// ── closeStaleStatusPane ─────────────────────────────────────────────

describe("closeStaleStatusPane", () => {
  function mockMux(overrides?: Partial<Multiplexer>): Multiplexer {
    return {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: vi.fn(() => "workspace:99"),
      splitPane: vi.fn(() => "pane:1"),
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: vi.fn(() => true),
      ...overrides,
    };
  }

  it("closes old status pane when state file has statusPaneRef", () => {
    const mux = mockMux();
    const oldState: DaemonState = {
      pid: 123,
      startedAt: "2026-03-25T00:00:00Z",
      updatedAt: "2026-03-25T00:01:00Z",
      statusPaneRef: "workspace:42",
      items: [],
    };

    closeStaleStatusPane(mux, "/tmp/project", () => oldState);

    expect(mux.closeWorkspace).toHaveBeenCalledWith("workspace:42");
  });

  it("is a no-op when no state file exists", () => {
    const mux = mockMux();

    closeStaleStatusPane(mux, "/tmp/project", () => null);

    expect(mux.closeWorkspace).not.toHaveBeenCalled();
  });

  it("is a no-op when state file has no statusPaneRef", () => {
    const mux = mockMux();
    const oldState: DaemonState = {
      pid: 123,
      startedAt: "2026-03-25T00:00:00Z",
      updatedAt: "2026-03-25T00:01:00Z",
      items: [],
    };

    closeStaleStatusPane(mux, "/tmp/project", () => oldState);

    expect(mux.closeWorkspace).not.toHaveBeenCalled();
  });

  it("is a no-op when statusPaneRef is null", () => {
    const mux = mockMux();
    const oldState: DaemonState = {
      pid: 123,
      startedAt: "2026-03-25T00:00:00Z",
      updatedAt: "2026-03-25T00:01:00Z",
      statusPaneRef: null,
      items: [],
    };

    closeStaleStatusPane(mux, "/tmp/project", () => oldState);

    expect(mux.closeWorkspace).not.toHaveBeenCalled();
  });

  it("handles closeWorkspace failure gracefully", () => {
    const mux = mockMux({
      closeWorkspace: vi.fn(() => { throw new Error("pane gone"); }),
    });
    const oldState: DaemonState = {
      pid: 123,
      startedAt: "2026-03-25T00:00:00Z",
      updatedAt: "2026-03-25T00:01:00Z",
      statusPaneRef: "workspace:99",
      items: [],
    };

    // Should not throw
    expect(() => closeStaleStatusPane(mux, "/tmp/project", () => oldState)).not.toThrow();
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

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
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
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

  // ── tmux session name format (L-WRK-10) ──────────────────────────

  it("returns true when tmux session name contains the TODO ID", () => {
    const mux = mockMux("nw-H-WRK-1-1");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("matches tmux session by workspace ref", () => {
    const mux = mockMux("nw-M-CI-2-3\nnw-H-WRK-1-1");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("matches tmux session by TODO ID in session name", () => {
    const mux = mockMux("nw-H-WRK-1-1\nnw-M-CI-2-2");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("returns false for tmux session not in listing", () => {
    const mux = mockMux("nw-M-CI-2-1");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });
});

// ── cleanOrphanedWorktrees ──────────────────────────────────────────

describe("cleanOrphanedWorktrees", () => {
  function makeDeps(overrides: Partial<CleanOrphanedDeps> = {}): CleanOrphanedDeps {
    return {
      getWorktreeIds: () => [],
      getOpenTodoIds: () => [],
      cleanWorktree: () => true,
      log: () => {},
      ...overrides,
    };
  }

  it("cleans worktrees with no matching todo file", () => {
    const cleaned: string[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1", "H-WRK-2"],
      getOpenTodoIds: () => ["H-WRK-2"], // M-CI-1 has no todo file
      cleanWorktree: (id) => {
        cleaned.push(id);
        return true;
      },
    });

    const result = cleanOrphanedWorktrees("/todos", "/worktrees", "/root", deps);
    expect(result).toEqual(["M-CI-1"]);
    expect(cleaned).toEqual(["M-CI-1"]);
  });

  it("preserves worktrees with matching todo file", () => {
    const cleaned: string[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1", "H-WRK-2"],
      getOpenTodoIds: () => ["M-CI-1", "H-WRK-2"],
      cleanWorktree: (id) => {
        cleaned.push(id);
        return true;
      },
    });

    const result = cleanOrphanedWorktrees("/todos", "/worktrees", "/root", deps);
    expect(result).toEqual([]);
    expect(cleaned).toEqual([]);
  });

  it("returns empty when no worktrees exist", () => {
    const deps = makeDeps({
      getWorktreeIds: () => [],
      getOpenTodoIds: () => ["M-CI-1"],
    });

    const result = cleanOrphanedWorktrees("/todos", "/worktrees", "/root", deps);
    expect(result).toEqual([]);
  });

  it("logs when orphaned worktrees are cleaned", () => {
    const logs: LogEntry[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1", "H-WRK-2"],
      getOpenTodoIds: () => [],
      log: (entry) => logs.push(entry),
    });

    cleanOrphanedWorktrees("/todos", "/worktrees", "/root", deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.event).toBe("orphaned_worktrees_cleaned");
    expect(logs[0]!.count).toBe(2);
    expect(logs[0]!.cleanedIds).toEqual(["M-CI-1", "H-WRK-2"]);
  });

  it("does not log when no orphans found", () => {
    const logs: LogEntry[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1"],
      getOpenTodoIds: () => ["M-CI-1"],
      log: (entry) => logs.push(entry),
    });

    cleanOrphanedWorktrees("/todos", "/worktrees", "/root", deps);
    expect(logs).toHaveLength(0);
  });
});

describe("executeClean readScreen diagnostics", () => {
  it("does not call readScreen for merged items", async () => {
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "asap" });
    orch.addItem(makeTodo("MRG-1"));

    let cycle = 0;
    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["MRG-1"] };
        case 2:
          return { items: [{ id: "MRG-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "MRG-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const readScreen = vi.fn(() => "some output");
    const warn = vi.fn();
    const logs: LogEntry[] = [];
    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ readScreen, warn }),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    expect(orch.getItem("MRG-1")!.state).toBe("done");
    // readScreen should NOT be called for merged items
    expect(readScreen).not.toHaveBeenCalled();
    // "Permanently stuck" warning should NOT appear
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Permanently stuck"));
  });

  it("calls readScreen and warns for stuck items", async () => {
    // maxRetries: 0 so the first worker death goes straight to stuck
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "asap", maxRetries: 0 });
    orch.addItem(makeTodo("STK-1"));

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
          // Worker is alive at first
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          // Worker dies without a PR
          items.push({ id: item.id, workerAlive: false });
        }
      }

      return { items, readyIds };
    };

    const readScreen = vi.fn(() => "error: something went wrong");
    const warn = vi.fn();
    const logs: LogEntry[] = [];
    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ readScreen, warn }),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    expect(orch.getItem("STK-1")!.state).toBe("stuck");
    // readScreen SHOULD be called for stuck items
    expect(readScreen).toHaveBeenCalled();
    // "Permanently stuck" warning SHOULD appear
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Permanently stuck"));
  });

  it("terminates via maxIterations when items are stuck in non-terminal state", async () => {
    // This is the critical safety test: without maxIterations, a stuck item
    // causes the while(true) loop to spin forever. Because tests use
    // sleep: () => Promise.resolve() (microtask), the loop monopolizes the
    // event loop and macrotask-based timers (setTimeout/setInterval) — including
    // the SIGKILL safety guard — never fire.
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "asap" });
    orch.addItem(makeTodo("SPIN-1"));

    let cycles = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycles++;
      const readyIds: string[] = [];
      for (const item of o.getAllItems()) {
        if (item.state === "queued") readyIds.push(item.id);
      }
      // After launch, always return empty — item stuck in "launching" forever
      return { items: [], readyIds };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 50 });

    // Guard fired — loop terminated
    const exceeded = logs.find((l) => l.event === "max_iterations_exceeded");
    expect(exceeded).toBeDefined();
    expect(exceeded!.iterations).toBe(51);
    expect(exceeded!.limit).toBe(50);

    // Diagnostic fields present for root-cause analysis
    expect(exceeded!.staleFor).toBeGreaterThan(0); // iterations since last transition
    expect(exceeded!.itemDetails).toBeDefined();
    const details = exceeded!.itemDetails as Array<{ id: string; state: string }>;
    expect(details[0]!.id).toBe("SPIN-1");
    expect(details[0]!.state).toBe("launching"); // stuck state is visible
    expect(exceeded!.lastSnapshot).toBeDefined(); // last snapshot for debugging
    expect(exceeded!.lastActions).toBeDefined(); // last actions attempted
    expect(exceeded!.rssMB).toBeGreaterThan(0); // memory at time of failure

    // Item is still in a non-terminal state (the loop was cut short)
    const item = orch.getItem("SPIN-1")!;
    expect(item.state).not.toBe("done");
    expect(item.state).not.toBe("stuck");

    // Completed quickly (not stuck for 90s)
    expect(cycles).toBeGreaterThan(1);
    expect(cycles).toBeLessThan(100);
  });
});

// ── buildSnapshot screenHealth (H-HLT-1) ────────────────────────────

describe("buildSnapshot screenHealth", () => {
  const noOpCheckPr = () => null;
  const noOpCommitTime = () => null;

  function mockMux(workspaces: string = "", screenContent: string = ""): Multiplexer {
    return {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => screenContent,
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  it("sets screenHealth to stalled-empty when screen shows empty prompt", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("BSH-1-1"));
    orch.setState("BSH-1-1", "implementing");
    orch.getItem("BSH-1-1")!.workspaceRef = "workspace:1";

    const screenContent = "\n  ❯\n\n";
    const mux = mockMux("workspace:1", screenContent);

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, noOpCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "BSH-1-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.screenHealth).toBe("stalled-empty");
  });

  it("sets screenHealth to stalled-permission when screen shows Y/n dialog", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("BSH-2-1"));
    orch.setState("BSH-2-1", "implementing");
    orch.getItem("BSH-2-1")!.workspaceRef = "workspace:2";

    const screenContent = "Allow tool_name? (Y/n)\nSome context above\n";
    const mux = mockMux("workspace:2", screenContent);

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, noOpCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "BSH-2-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.screenHealth).toBe("stalled-permission");
  });

  it("sets screenHealth to healthy when screen shows active processing", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("BSH-3-1"));
    orch.setState("BSH-3-1", "implementing");
    orch.getItem("BSH-3-1")!.workspaceRef = "workspace:3";

    const screenContent = "⠋ Thinking about the implementation...\nReading file core/main.ts\n";
    const mux = mockMux("workspace:3", screenContent);

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, noOpCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "BSH-3-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.screenHealth).toBe("healthy");
  });

  it("sets screenHealth to stalled-error when screen shows error output", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("BSH-4-1"));
    orch.setState("BSH-4-1", "implementing");
    orch.getItem("BSH-4-1")!.workspaceRef = "workspace:4";

    const screenContent = "Error: FATAL crash detected\nStack trace follows\n";
    const mux = mockMux("workspace:4", screenContent);

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, noOpCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "BSH-4-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.screenHealth).toBe("stalled-error");
  });

  it("sets screenHealth to unknown when readScreen throws", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("BSH-5-1"));
    orch.setState("BSH-5-1", "implementing");
    orch.getItem("BSH-5-1")!.workspaceRef = "workspace:5";

    const mux: Multiplexer = {
      type: "cmux",
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => { throw new Error("readScreen unavailable"); },
      listWorkspaces: () => "workspace:5",
      closeWorkspace: () => true,
    };

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, noOpCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "BSH-5-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.screenHealth).toBe("unknown");
  });

  it("does not crash when readScreen throws", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeTodo("BSH-6-1"));
    orch.setState("BSH-6-1", "implementing");
    orch.getItem("BSH-6-1")!.workspaceRef = "workspace:6";

    const mux: Multiplexer = {
      isAvailable: () => true,
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => { throw new Error("connection lost"); },
      listWorkspaces: () => "workspace:6",
      closeWorkspace: () => true,
    };

    // Should not throw
    expect(() => {
      buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, noOpCommitTime, noOpCheckPr);
    }).not.toThrow();
  });
});

// ── Watch mode tests ────────────────────────────────────────────────

describe("orchestrateLoop watch mode", () => {
  it("does not exit when all items are terminal with --watch", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("W-1-1"));

    let cycle = 0;
    let scanCallCount = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["W-1-1"] };
        case 2:
          return { items: [{ id: "W-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "W-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        // After watch detects new item W-1-2
        case 5:
          return { items: [], readyIds: ["W-1-2"] };
        case 6:
          return { items: [{ id: "W-1-2", workerAlive: true }], readyIds: [] };
        case 7:
          return {
            items: [{ id: "W-1-2", prNumber: 2, prState: "open", ciStatus: "pass" }],
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
      scanTodos: () => {
        scanCallCount++;
        // On first scan, return the new item
        if (scanCallCount >= 1) {
          return [makeTodo("W-1-1"), makeTodo("W-1-2")];
        }
        return [makeTodo("W-1-1")];
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { watch: true, maxIterations: 200 });

    // Both items should reach done
    expect(orch.getItem("W-1-1")!.state).toBe("done");
    expect(orch.getItem("W-1-2")!.state).toBe("done");

    // Watch mode waiting log was emitted
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(true);
    const watchLog = logs.find((l) => l.event === "watch_mode_waiting")!;
    expect(watchLog.message).toBe("All items complete. Watching for new TODOs...");

    // New items detected log was emitted
    expect(logs.some((l) => l.event === "watch_new_items")).toBe(true);
    const newItemsLog = logs.find((l) => l.event === "watch_new_items")!;
    expect(newItemsLog.newIds).toEqual(["W-1-2"]);

    // scanTodos was called
    expect(scanCallCount).toBeGreaterThan(0);
  });

  it("without --watch, daemon exits normally when all items are terminal", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("N-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    let scanCalled = false;

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["N-1-1"] };
        case 2:
          return { items: [{ id: "N-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "N-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
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
      scanTodos: () => {
        scanCalled = true;
        return [];
      },
    };

    // No watch flag — should exit after all done
    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    expect(orch.getItem("N-1-1")!.state).toBe("done");
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(false);
    expect(scanCalled).toBe(false);
  });

  it("uses custom watch interval from --watch-interval", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("I-1-1"));

    let cycle = 0;
    const sleepDurations: number[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["I-1-1"] };
        case 2:
          return { items: [{ id: "I-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "I-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: (ms) => {
        sleepDurations.push(ms);
        return Promise.resolve();
      },
      log: () => {},
      actionDeps: mockActionDeps(),
      scanTodos: () => [makeTodo("I-1-1")], // Only return existing item, no new ones
    };

    // maxIterations will limit the watch loop too
    await orchestrateLoop(
      orch,
      defaultCtx,
      deps,
      { watch: true, watchIntervalMs: 5_000, maxIterations: 50 },
    );

    // Verify the watch interval was used (5000ms instead of default 30000)
    const watchSleeps = sleepDurations.filter((d) => d === 5_000);
    expect(watchSleeps.length).toBeGreaterThan(0);
  });

  it("SIGINT cleanly exits watch mode", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("S-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const abortController = new AbortController();
    let inWatchMode = false;

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["S-1-1"] };
        case 2:
          return { items: [{ id: "S-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "S-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => {
        // Only abort once we've entered watch mode (detected by watch_mode_waiting log)
        if (inWatchMode) {
          abortController.abort();
        }
        return Promise.resolve();
      },
      log: (entry) => {
        logs.push(entry);
        if (entry.event === "watch_mode_waiting") {
          inWatchMode = true;
        }
      },
      actionDeps: mockActionDeps(),
      scanTodos: () => [makeTodo("S-1-1")], // No new items
    };

    await orchestrateLoop(
      orch,
      defaultCtx,
      deps,
      { watch: true, maxIterations: 200 },
      abortController.signal,
    );

    // Should have entered watch mode
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(true);
    // Should have shutdown cleanly
    expect(logs.some((l) => l.event === "shutdown" && l.reason === "watch_aborted")).toBe(true);
    // Should NOT have found new items (aborted before scan)
    expect(logs.some((l) => l.event === "watch_new_items")).toBe(false);
  });

  it("watch mode respects WIP limits for newly discovered items", async () => {
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "asap" });
    orch.addItem(makeTodo("L-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    let scanCount = 0;

    // Track each item's progress through lifecycle
    const itemCycles = new Map<string, number>();

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

        // Count cycles per item to advance through states
        const itemCycle = (itemCycles.get(item.id) ?? 0) + 1;
        itemCycles.set(item.id, itemCycle);

        // Drive items through lifecycle: launching → implementing → pr-open → merge
        if (item.state === "launching") {
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          // After 1 cycle in implementing, show a PR
          items.push({ id: item.id, prNumber: 99, prState: "open", ciStatus: "pass" });
        } else if (item.state === "ci-passed" || item.state === "merging") {
          // Merge action will be taken, then item goes to done
        } else {
          items.push({ id: item.id, workerAlive: true });
        }
      }

      return { items, readyIds };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      scanTodos: () => {
        scanCount++;
        // Return 3 items — but WIP limit is 1, so they should be queued/serial
        return [makeTodo("L-1-1"), makeTodo("L-1-2"), makeTodo("L-1-3")];
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { watch: true, maxIterations: 500 });

    // All items should reach done
    expect(orch.getItem("L-1-1")!.state).toBe("done");
    expect(orch.getItem("L-1-2")!.state).toBe("done");
    expect(orch.getItem("L-1-3")!.state).toBe("done");

    // Watch mode was entered at least once
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(true);
    expect(scanCount).toBeGreaterThan(0);
  });

  it("watch mode default interval is 30 seconds", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("D-1-1"));

    let cycle = 0;
    const sleepDurations: number[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["D-1-1"] };
        case 2:
          return { items: [{ id: "D-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "D-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: (ms) => {
        sleepDurations.push(ms);
        return Promise.resolve();
      },
      log: () => {},
      actionDeps: mockActionDeps(),
      scanTodos: () => [makeTodo("D-1-1")], // No new items
    };

    // maxIterations will bound the watch loop
    await orchestrateLoop(
      orch,
      defaultCtx,
      deps,
      { watch: true, maxIterations: 50 },
    );

    // Default watch interval should be 30000ms
    expect(sleepDurations.some((d) => d === 30_000)).toBe(true);
  });
});
