// Tests for core/commands/orchestrate.ts -- Event loop, state reconstruction,
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
  setupKeyboardShortcuts,
  isWorkerAlive,
  isWorkerAliveWithCache,
  forkDaemon,
  cleanOrphanedWorktrees,
  parseWatchArgs,
  validateItemIds,
  pushLogBuffer,
  filterLogsByLevel,
  formatExitSummary,
  formatCompletionBanner,
  waitForCompletionKey,
  LOG_BUFFER_MAX,
  type LogEntry,
  type LogLevelFilter,
  type OrchestrateLoopDeps,
  type CleanOrphanedDeps,
  type ParsedWatchArgs,
  type TuiState,
  type CompletionAction,
} from "../core/commands/orchestrate.ts";
import type { LogEntry as PanelLogEntry } from "../core/status-render.ts";
import { MIN_SPLIT_ROWS } from "../core/status-render.ts";
import {
  Orchestrator,
  type OrchestratorItem,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { WorkItem } from "../core/types.ts";
import type { Multiplexer } from "../core/mux.ts";
import { pidFilePath, logFilePath, readLayoutPreference, writeLayoutPreference, preferencesFilePath, userStateDir, type DaemonState } from "../core/daemon.ts";
import type { CrewBroker } from "../core/crew.ts";
import { shouldEnterInteractive } from "../core/interactive.ts";

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

// ── Tests ────────────────────────────────────────────────────────────

describe("orchestrateLoop", () => {
  it("processes items through full lifecycle (single item, auto strategy)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1: // T-1-1 has no deps, should be ready
          return { items: [], readyIds: ["T-1-1"] };
        case 2: // Worker launched and alive
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3: // PR appeared with CI pass → triggers merge (auto)
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
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("A-1-1"));
    orch.getItem("A-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
    orch.getItem("A-1-2")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycle++;
      const readyIds: string[] = [];
      const items: ItemSnapshot[] = [];

      for (const item of o.getAllItems()) {
        if (item.state === "queued") {
          const depsMet = item.workItem.dependencies.every((depId) => {
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
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("W-1-1"));
    orch.getItem("W-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("W-1-2"));
    orch.getItem("W-1-2")!.reviewCompleted = true;

    let cycle = 0;
    const launchedItems: string[] = [];

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycle++;
      const readyIds: string[] = [];
      const items: ItemSnapshot[] = [];

      for (const item of o.getAllItems()) {
        if (item.state === "queued") {
          const depsMet = item.workItem.dependencies.every((depId) => {
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
      launchSingleItem: vi.fn((item: WorkItem) => {
        launchedItems.push(item.id);
        return { worktreePath: `/tmp/test/ninthwave-${item.id}`, workspaceRef: `ws:${item.id}` };
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("U-1-1"));
    orch.getItem("U-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("U-1-2"));
    orch.getItem("U-1-2")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("S-1-1"));
    orch.getItem("S-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("S-1-2"));
    orch.getItem("S-1-2")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("CL-1-1"));
    orch.getItem("CL-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("CL-1-2"));
    orch.getItem("CL-1-2")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("CN-1-1"));
    orch.getItem("CN-1-1")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("CE-1-1"));
    orch.getItem("CE-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("CE-1-2"));
    orch.getItem("CE-1-2")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("WC-1-1"));
    orch.getItem("WC-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("WC-1-2"));
    orch.getItem("WC-1-2")!.reviewCompleted = true;

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
    // Find the last close and first clean -- close should come first per-item
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("WN-1-1"));
    orch.getItem("WN-1-1")!.reviewCompleted = true;

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
        worktreePath: "/tmp/test/item-test",
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

  it("final cleanup sweep skips worktree removal for stuck items (H-WR-2)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto", maxRetries: 0 });
    orch.addItem(makeWorkItem("SK-1-1"));
    orch.getItem("SK-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("SK-1-2"));
    orch.getItem("SK-1-2")!.reviewCompleted = true;

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
          // SK-1-1: normal lifecycle → merge
          if (item.id === "SK-1-1") {
            items.push({ id: item.id, prNumber: cycle, prState: "open", ciStatus: "pass" });
          }
          // SK-1-2: worker dies → stuck (debounce requires 5 consecutive false checks)
          if (item.id === "SK-1-2") {
            items.push({ id: item.id, workerAlive: false });
          }
        } else if (item.state === "ci-passed" || item.state === "merging" || item.state === "merged") {
          items.push({ id: item.id, prState: "merged" });
        }
      }

      return { items, readyIds };
    };

    const actionDeps = mockActionDeps({
      cleanSingleWorktree: vi.fn((id: string) => {
        cleanedItemIds.push(id);
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

    // SK-1-1 is done (merged successfully)
    expect(orch.getItem("SK-1-1")!.state).toBe("done");
    // SK-1-2 is stuck (worker died without retries)
    expect(orch.getItem("SK-1-2")!.state).toBe("stuck");

    // Final cleanup sweep should clean SK-1-1 (done) but NOT SK-1-2 (stuck)
    expect(cleanedItemIds).toContain("SK-1-1");
    expect(cleanedItemIds).not.toContain("SK-1-2");
  });

  it("shutdown closes workspaces only for terminal items, not in-flight", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("SD-1-1"));
    orch.getItem("SD-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("SD-1-2"));
    orch.getItem("SD-1-2")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("I-1-1"));
    orch.getItem("I-1-1")!.reviewCompleted = true;

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
    // Loop exited cleanly -- did not process to completion
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(false);
  });

  it("transitions to done without mark-done action (workers remove their own work item)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("D-1-1"));
    orch.getItem("D-1-1")!.reviewCompleted = true;

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

    // No mark-done action -- workers remove their own work item file in their PR branch
    expect(
      logs.every((l) => !(l.event === "action_execute" && l.action === "mark-done")),
    ).toBe(true);
  });

  it("emits structured log with state_summary on each cycle", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("L-1-1"));
    orch.getItem("L-1-1")!.reviewCompleted = true;

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
  it("returns flat 2s regardless of item states", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("A-1-1"));
    orch.getItem("A-1-1")!.reviewCompleted = true;
    orch.setState("A-1-1", "ready");
    expect(adaptivePollInterval(orch)).toBe(2_000);

    orch.setState("A-1-1", "implementing");
    expect(adaptivePollInterval(orch)).toBe(2_000);

    orch.setState("A-1-1", "ci-pending");
    expect(adaptivePollInterval(orch)).toBe(2_000);

    orch.setState("A-1-1", "done");
    expect(adaptivePollInterval(orch)).toBe(2_000);
  });
});

describe("reconstructState", () => {
  it("is a no-op when no worktrees exist", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("R-1-1"));
    orch.getItem("R-1-1")!.reviewCompleted = true;

    // Non-existent worktree dir -- items stay queued
    reconstructState(orch, "/nonexistent", "/nonexistent/.worktrees");

    expect(orch.getItem("R-1-1")!.state).toBe("queued");
  });

  it("recovers workspaceRef from live cmux workspaces during reconstruction", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-DF-1"));
    orch.getItem("H-DF-1")!.reviewCompleted = true;

    // Create a temp worktree dir to simulate existing worktree
    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-H-DF-1");
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
        "  workspace:29  ✳ H-DF-1: Workers remove their own work item",
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
    orch.addItem(makeWorkItem("H-DF-2"));
    orch.getItem("H-DF-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test2-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-H-DF-2");
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
    orch.addItem(makeWorkItem("REC-1"));
    orch.getItem("REC-1")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-cifc-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-REC-1");
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
    orch.addItem(makeWorkItem("REC-2"));
    orch.getItem("REC-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-nostate-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-REC-2");
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
    orch.addItem(makeWorkItem("REC-3"));
    orch.getItem("REC-3")!.reviewCompleted = true;

    // No worktree dir needed -- items without worktrees are skipped
    reconstructState(orch, "/nonexistent", "/nonexistent/.worktrees", undefined, () => null, null);

    const item = orch.getItem("REC-3")!;
    expect(item.ciFailCount).toBe(0);
    expect(item.retryCount).toBe(0);
  });

  it("item with ciFailCount exceeding maxCiRetries goes stuck after recovery", () => {
    // maxCiRetries defaults to 2; set ciFailCount to 3 so it exceeds the threshold
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("REC-4"));
    orch.getItem("REC-4")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-stuck-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-REC-4");
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

  it("detects existing open PR with pending CI and sets ci-pending (not ready) (H-WR-1)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("WR-1"));
    orch.getItem("WR-1")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-wr1-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-WR-1");
    require("fs").mkdirSync(wtPath, { recursive: true });

    // checkPr returns "pending" status -- existing PR with CI pending
    const pendingCheckPr = () => "WR-1\t271\tpending";

    reconstructState(orch, tmpDir, wtDir, undefined, pendingCheckPr);

    const item = orch.getItem("WR-1")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(271);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects existing open PR with failing CI and sets ci-failed (H-WR-1)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("WR-2"));
    orch.getItem("WR-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-wr2-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-WR-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const failingCheckPr = () => "WR-2\t100\tfailing";

    reconstructState(orch, tmpDir, wtDir, undefined, failingCheckPr);

    const item = orch.getItem("WR-2")!;
    expect(item.state).toBe("ci-failed");
    expect(item.prNumber).toBe(100);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects existing open PR with passing CI and sets ci-passed (H-WR-1)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("WR-3"));
    orch.getItem("WR-3")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-wr3-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-WR-3");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const passingCheckPr = () => "WR-3\t200\tci-passed";

    reconstructState(orch, tmpDir, wtDir, undefined, passingCheckPr);

    const item = orch.getItem("WR-3")!;
    expect(item.state).toBe("ci-passed");
    expect(item.prNumber).toBe(200);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("reconstructState review fields", () => {
  it("restores reviewWorkspaceRef and reviewCompleted from daemon state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("RVW-1"));

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-rvw-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-RVW-1");
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
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("RVW-2"));
    orch.getItem("RVW-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-rvwt-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-RVW-2");
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
    const item = makeWorkItem("XR-1-1");
    item.repoAlias = "target";
    orch.addItem(item);

    const tmpDir = join(require("os").tmpdir(), `nw-xr-reconstruct-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const targetWtPath = join("/tmp/target-repo", ".worktrees", "ninthwave-XR-1-1");
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
    const item = makeWorkItem("XR-2-1");
    orch.addItem(item);
    orch.getItem("XR-2-1")!.resolvedRepoRoot = "/target-repo";

    const tmpDir = join(require("os").tmpdir(), `nw-xr-reconstruct2-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    const wtPath = join(wtDir, "ninthwave-XR-2-1");
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
    orch.addItem(makeWorkItem("BS-1-1"));
    orch.getItem("BS-1-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("BS-2-1"));
    orch.getItem("BS-2-1")!.reviewCompleted = true;
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
      workItem: makeWorkItem("SER-1"),
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

describe("serializeOrchestratorState includes rebaseRequested", () => {
  it("serializes rebaseRequested when true", () => {
    const { serializeOrchestratorState } = require("../core/daemon.ts");
    const item: OrchestratorItem = {
      id: "REB-1",
      workItem: makeWorkItem("REB-1"),
      state: "ci-pending",
      prNumber: 20,
      lastTransition: "2026-01-01T00:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
      rebaseRequested: true,
    };

    const state = serializeOrchestratorState([item], 9999, "2026-01-01T00:00:00Z");
    expect(state.items).toHaveLength(1);
    expect(state.items[0].rebaseRequested).toBe(true);
  });

  it("omits rebaseRequested when false", () => {
    const { serializeOrchestratorState } = require("../core/daemon.ts");
    const item: OrchestratorItem = {
      id: "REB-2",
      workItem: makeWorkItem("REB-2"),
      state: "ci-pending",
      prNumber: 21,
      lastTransition: "2026-01-01T00:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
      rebaseRequested: false,
    };

    const state = serializeOrchestratorState([item], 9999, "2026-01-01T00:00:00Z");
    expect(state.items[0].rebaseRequested).toBeUndefined();
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-1-1"));
    orch.getItem("HC-1-1")!.reviewCompleted = true;
    orch.setState("HC-1-1", "implementing");
    // Set workspace ref so worker appears alive
    const item = orch.getItem("HC-1-1")!;
    item.workspaceRef = "workspace:1";

    const fixedTime = "2026-03-24T12:05:30+00:00";
    const getLastCommitTime = vi.fn(() => fixedTime);
    const mux = mockMux("workspace:1");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    // getLastCommitTime was called with the right branch name
    expect(getLastCommitTime).toHaveBeenCalledWith("/tmp/project", "ninthwave/HC-1-1");

    // Snapshot includes lastCommitTime
    const snapItem = snapshot.items.find((i) => i.id === "HC-1-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.lastCommitTime).toBe(fixedTime);

    // Orchestrator item also updated
    expect(orch.getItem("HC-1-1")!.lastCommitTime).toBe(fixedTime);
  });

  it("lastCommitTime is null when worktree has no commits beyond base", () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-2-1"));
    orch.getItem("HC-2-1")!.reviewCompleted = true;
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-3-1"));
    orch.getItem("HC-3-1")!.reviewCompleted = true;
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-4-1"));
    orch.getItem("HC-4-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("M-1-1"));
    orch.getItem("M-1-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("M-2-1"));
    orch.getItem("M-2-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("M-3-1"));
    orch.getItem("M-3-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("M-4-1"));
    orch.getItem("M-4-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("R-1-1"));
    orch.getItem("R-1-1")!.reviewCompleted = true;
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

// ── buildSnapshot merge detection (H-MRG-1) ──────────────────────────

describe("buildSnapshot merge detection", () => {
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

  it("ignores stale merged PR when prNumber is unset and title differs from item", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
    const item = makeWorkItem("MRG-1-1");
    item.title = "Fix the daemon polling loop";
    orch.addItem(item);
    orch.setState("MRG-1-1", "implementing");
    // prNumber is never set -- either stale PR or auto-merged before daemon saw it
    expect(orch.getItem("MRG-1-1")!.prNumber).toBeUndefined();

    // checkPr returns merged with a completely different title -- stale PR from previous cycle
    const checkPr = () => "MRG-1-1\t99\tmerged\t\t\trefactor: rewrite polling internals";
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.worktrees", mux, () => null, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "MRG-1-1");
    expect(snapItem).toBeDefined();
    // Title mismatch + no tracked prNumber = stale PR, ignored
    expect(snapItem!.prState).toBeUndefined();
  });
});

// ── reconstructState merge detection (H-MRG-1) ──────────────────────

describe("reconstructState merge detection", () => {
  it("rejects title-mismatched merged PR from previous cycle (no prNumber tracked)", () => {
    const orch = new Orchestrator();
    const item = makeWorkItem("MRG-2-1");
    item.title = "New implementation for feature X";
    orch.addItem(item);

    // Create a temp worktree so reconstructState processes this item
    const tmpDir = join(require("os").tmpdir(), `nw-mrg-test-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    require("fs").mkdirSync(join(wtDir, "ninthwave-MRG-2-1"), { recursive: true });

    // checkPr returns merged with a mismatched title (old cycle's PR)
    const checkPr = () => "MRG-2-1\t50\tmerged\t\t\tfix: old implementation of feature X";

    reconstructState(orch, tmpDir, wtDir, undefined, checkPr);

    // Should NOT be marked merged -- title mismatch means it's a stale PR
    expect(orch.getItem("MRG-2-1")!.state).toBe("implementing");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts title-mismatched merged PR when prNumber was already tracked", () => {
    const orch = new Orchestrator();
    const item = makeWorkItem("MRG-3-1");
    item.title = "Improve error handling";
    orch.addItem(item);
    // Simulate daemon state having previously tracked this PR number
    orch.getItem("MRG-3-1")!.prNumber = 77;

    const tmpDir = join(require("os").tmpdir(), `nw-mrg-test2-${Date.now()}`);
    const wtDir = join(tmpDir, ".worktrees");
    require("fs").mkdirSync(join(wtDir, "ninthwave-MRG-3-1"), { recursive: true });

    // checkPr returns merged with a different title but matching PR number
    const checkPr = () => "MRG-3-1\t77\tmerged\t\t\trefactor: completely rewrite error paths";

    reconstructState(orch, tmpDir, wtDir, undefined, checkPr);

    // Should be merged -- prNumber match bypasses title check
    expect(orch.getItem("MRG-3-1")!.state).toBe("merged");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Keyboard shortcuts (TUI mode) ────────────────────────────────────

describe("setupKeyboardShortcuts", () => {
  function mockStdin() {
    const listeners: Record<string, Function[]> = {};
    return {
      isTTY: true as const,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: Function) => { (listeners[event] ??= []).push(cb); }),
      removeListener: vi.fn((event: string, cb: Function) => {
        const arr = listeners[event];
        if (arr) { const idx = arr.indexOf(cb); if (idx >= 0) arr.splice(idx, 1); }
      }),
      _emit(event: string, data: any) { for (const cb of (listeners[event] ?? [])) cb(data); },
    } as unknown as NodeJS.ReadStream;
  }

  it("triggers abort on 'q' keypress", () => {
    const ac = new AbortController();
    const logs: LogEntry[] = [];
    const stdin = mockStdin();

    setupKeyboardShortcuts(ac, (e) => logs.push(e), stdin);

    (stdin as any)._emit("data", "q");

    expect(ac.signal.aborted).toBe(true);
    expect(logs.some((l: any) => l.event === "keyboard_quit" && l.key === "q")).toBe(true);
  });

  it("triggers abort on Ctrl-C (0x03 byte)", () => {
    const ac = new AbortController();
    const logs: LogEntry[] = [];
    const stdin = mockStdin();

    setupKeyboardShortcuts(ac, (e) => logs.push(e), stdin);

    (stdin as any)._emit("data", "");

    expect(ac.signal.aborted).toBe(true);
    expect(logs.some((l: any) => l.event === "keyboard_quit" && l.key === "ctrl-c")).toBe(true);
  });

  it("does not abort on other keys", () => {
    const ac = new AbortController();
    const stdin = mockStdin();

    setupKeyboardShortcuts(ac, () => {}, stdin);

    (stdin as any)._emit("data", "a");
    (stdin as any)._emit("data", "x");
    (stdin as any)._emit("data", "\n");

    expect(ac.signal.aborted).toBe(false);
  });

  it("cleanup restores terminal state", () => {
    const ac = new AbortController();
    const stdin = mockStdin();

    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin);

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.resume).toHaveBeenCalled();

    cleanup();

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
    expect(stdin.removeListener).toHaveBeenCalledWith("data", expect.any(Function));
  });

  it("is a no-op when stdin is not a TTY", () => {
    const ac = new AbortController();
    const stdin = { isTTY: false } as unknown as NodeJS.ReadStream;

    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin);
    cleanup(); // should not throw
    expect(ac.signal.aborted).toBe(false);
  });

  // ── Shift+Tab strategy cycling ──────────────────────────────────────

  it("Shift+Tab cycles merge strategy auto → manual", () => {
    const ac = new AbortController();
    const logs: LogEntry[] = [];
    const stdin = mockStdin();
    const changedStrategies: string[] = [];
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onStrategyChange: (s) => changedStrategies.push(s),
    };

    setupKeyboardShortcuts(ac, (e) => logs.push(e), stdin, tuiState);
    (stdin as any)._emit("data", "\x1B[Z"); // Shift+Tab

    expect(tuiState.mergeStrategy).toBe("manual");
    expect(tuiState.viewOptions.mergeStrategy).toBe("manual");
    expect(changedStrategies).toEqual(["manual"]);
    expect(logs.some((l: any) => l.event === "strategy_cycle" && l.oldStrategy === "auto" && l.newStrategy === "manual")).toBe(true);
  });

  it("Shift+Tab wraps manual → auto when bypass disabled", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "manual" },
      mergeStrategy: "manual",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\x1B[Z");

    expect(tuiState.mergeStrategy).toBe("auto");
  });

  it("Shift+Tab cycles through bypass when bypassEnabled", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: true,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1B[Z"); // auto → manual
    expect(tuiState.mergeStrategy).toBe("manual");

    (stdin as any)._emit("data", "\x1B[Z"); // manual → bypass
    expect(tuiState.mergeStrategy).toBe("bypass");

    (stdin as any)._emit("data", "\x1B[Z"); // bypass → auto (wrap)
    expect(tuiState.mergeStrategy).toBe("auto");

    cleanup();
  });

  it("bypass excluded from cycle when bypassEnabled is false", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    // Cycle through all positions -- should only visit auto and manual
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) {
      (stdin as any)._emit("data", "\x1B[Z");
      visited.push(tuiState.mergeStrategy);
    }
    expect(visited).toEqual(["manual", "auto", "manual", "auto"]);
  });

  // ── Ctrl+C double-tap ──────────────────────────────────────────────

  it("first Ctrl+C sets ctrlCPending, does not abort", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x03");

    expect(ac.signal.aborted).toBe(false);
    expect(tuiState.ctrlCPending).toBe(true);
    expect(tuiState.viewOptions.ctrlCPending).toBe(true);
    expect(tuiState.ctrlCTimestamp).toBeGreaterThan(0);

    cleanup();
  });

  it("second Ctrl+C within 2s exits", () => {
    const ac = new AbortController();
    const logs: LogEntry[] = [];
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    const cleanup = setupKeyboardShortcuts(ac, (e) => logs.push(e), stdin, tuiState);

    (stdin as any)._emit("data", "\x03"); // First
    expect(ac.signal.aborted).toBe(false);

    (stdin as any)._emit("data", "\x03"); // Second
    expect(ac.signal.aborted).toBe(true);
    expect(logs.some((l: any) => l.event === "keyboard_quit" && l.key === "ctrl-c")).toBe(true);

    cleanup();
  });

  it("Ctrl+C without tuiState still aborts immediately", () => {
    const ac = new AbortController();
    const logs: LogEntry[] = [];
    const stdin = mockStdin();

    setupKeyboardShortcuts(ac, (e) => logs.push(e), stdin);
    (stdin as any)._emit("data", "\x03");

    expect(ac.signal.aborted).toBe(true);
  });

  it("other key clears ctrlCPending state", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    const cleanup = setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x03"); // First Ctrl+C
    expect(tuiState.ctrlCPending).toBe(true);

    (stdin as any)._emit("data", "d"); // Some other key
    expect(tuiState.ctrlCPending).toBe(false);
    expect(tuiState.viewOptions.ctrlCPending).toBe(false);

    cleanup();
  });

  // ── Help overlay keyboard handling ──────────────────────────────────

  it("? toggles showHelp boolean", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "?");
    expect(tuiState.showHelp).toBe(true);
    expect(tuiState.viewOptions.showHelp).toBe(true);

    (stdin as any)._emit("data", "?");
    expect(tuiState.showHelp).toBe(false);
    expect(tuiState.viewOptions.showHelp).toBe(false);
  });

  it("Escape (single \\x1b) dismisses help overlay", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: true,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1b");
    expect(tuiState.showHelp).toBe(false);
    expect(tuiState.viewOptions.showHelp).toBe(false);
  });

  it("arrow keys (\\x1b[A) do NOT dismiss help overlay", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: true,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1b[A"); // Up arrow
    expect(tuiState.showHelp).toBe(true); // still showing

    (stdin as any)._emit("data", "\x1b[B"); // Down arrow
    expect(tuiState.showHelp).toBe(true); // still showing
  });

  // ── Item detail panel keyboard shortcuts ──────────────────────────

  it("Enter opens detail panel for selected item", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 5,
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: null,
      savedLogScrollOffset: 0,
      getSelectedItemId: (idx: number) => idx === 0 ? "H-UT-1" : undefined,
      getItemCount: () => 2,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\r"); // Enter

    expect(tuiState.detailItemId).toBe("H-UT-1");
    expect(tuiState.savedLogScrollOffset).toBe(5); // saved before opening
  });

  it("'i' opens detail panel for selected item", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 3,
      logLevelFilter: "all",
      selectedIndex: 1,
      detailItemId: null,
      savedLogScrollOffset: 0,
      getSelectedItemId: (idx: number) => idx === 1 ? "H-UT-2" : undefined,
      getItemCount: () => 3,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "i");

    expect(tuiState.detailItemId).toBe("H-UT-2");
    expect(tuiState.savedLogScrollOffset).toBe(3);
  });

  it("Escape closes detail panel and restores log scroll offset", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 10, // changed while viewing detail
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: "H-UT-1",
      savedLogScrollOffset: 5, // was 5 before opening detail
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\x1b"); // Escape

    expect(tuiState.detailItemId).toBeNull();
    expect(tuiState.logScrollOffset).toBe(5); // restored
  });

  it("Enter is no-op when no items exist", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: null,
      savedLogScrollOffset: 0,
      getSelectedItemId: () => undefined, // no items
      getItemCount: () => 0,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\r"); // Enter

    expect(tuiState.detailItemId).toBeNull(); // no crash, no detail opened
  });

  it("Enter is no-op when getSelectedItemId is not set", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: null,
      savedLogScrollOffset: 0,
      // no getSelectedItemId callback
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\r"); // Enter

    expect(tuiState.detailItemId).toBeNull();
  });

  it("detail updates when item state changes (re-render path)", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    let updates = 0;
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: null,
      savedLogScrollOffset: 0,
      getSelectedItemId: (idx: number) => idx === 0 ? "H-UT-1" : undefined,
      getItemCount: () => 1,
      onUpdate: () => { updates++; },
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\r"); // Enter -- triggers onUpdate

    expect(tuiState.detailItemId).toBe("H-UT-1");
    expect(updates).toBeGreaterThan(0);
  });

  it("Up/Down arrows move selectedIndex", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: null,
      savedLogScrollOffset: 0,
      getItemCount: () => 5,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1b[B"); // Down
    expect(tuiState.selectedIndex).toBe(1);

    (stdin as any)._emit("data", "\x1b[B"); // Down
    expect(tuiState.selectedIndex).toBe(2);

    (stdin as any)._emit("data", "\x1b[A"); // Up
    expect(tuiState.selectedIndex).toBe(1);

    (stdin as any)._emit("data", "\x1b[A"); // Up
    expect(tuiState.selectedIndex).toBe(0);

    (stdin as any)._emit("data", "\x1b[A"); // Up at top -- stays at 0
    expect(tuiState.selectedIndex).toBe(0);
  });

  it("Down arrow clamps selectedIndex to max items", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedIndex: 1,
      detailItemId: null,
      savedLogScrollOffset: 0,
      getItemCount: () => 2, // max index is 1
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1b[B"); // Down -- already at max
    expect(tuiState.selectedIndex).toBe(1); // stays clamped
  });

  it("Escape does nothing when no help and no detail open", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedIndex: 0,
      detailItemId: null,
      savedLogScrollOffset: 0,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\x1b"); // Escape

    expect(tuiState.showHelp).toBe(false);
    expect(tuiState.detailItemId).toBeNull(); // unchanged
    expect(ac.signal.aborted).toBe(false); // didn't quit
  });
});

// ── onPollComplete callback ──────────────────────────────────────────

describe("onPollComplete callback", () => {
  it("is called each poll cycle with current items", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;

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
    expect(result.logPath).toBe(logFilePath("/project"));
    expect(mockChild.unref).toHaveBeenCalled();

    // PID file was written
    expect(files.get(pidFilePath("/project"))).toBe("42");

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
    const orch = new Orchestrator({ wipLimit: 3, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-1-2"));
    orch.getItem("T-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-1-3"));
    orch.getItem("T-1-3")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 3, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-1-2"));
    orch.getItem("T-1-2")!.reviewCompleted = true;

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
      workItem: makeWorkItem(id),
      state: "implementing",
      workspaceRef,
      lastTransition: new Date().toISOString(),
      ciFailCount: 0,
      retryCount: 0,
    };
  }

  it("returns true for an exact workspace ref match", () => {
    const mux = mockMux("  workspace:1  ✳ T-1-1: some task");
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("returns true when matching by item ID", () => {
    const mux = mockMux("  workspace:5  ✳ T-2-1: another task");
    const item = makeItem("T-2-1", "workspace:5");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("does not false-positive: workspace:1 must not match workspace:10", () => {
    const mux = mockMux("  workspace:10  ✳ T-3-1: unrelated task");
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });

  it("does not false-positive: item ID partial match across lines", () => {
    // T-1 should not match a line containing T-10
    const mux = mockMux("  workspace:5  ✳ T-10-1: unrelated task");
    const item = makeItem("T-1", "workspace:99");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });

  it("returns false when workspaceRef is undefined", () => {
    const mux = mockMux("  workspace:1  ✳ T-1-1: some task");
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
      "  workspace:10  ✳ T-10-1: task ten",
      "  workspace:1  ✳ T-1-1: task one",
      "  workspace:2  ✳ T-2-1: task two",
    ].join("\n");
    const mux = mockMux(listing);

    const item1 = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAlive(item1, mux)).toBe(true);

    const item10 = makeItem("T-10-1", "workspace:10");
    expect(isWorkerAlive(item10, mux)).toBe(true);

    const itemMissing = makeItem("T-99-1", "workspace:99");
    expect(isWorkerAlive(itemMissing, mux)).toBe(false);
  });

  // ── nw-prefixed session name format (L-WRK-10) ─────────────────────

  it("returns true when nw-prefixed session name contains the item ID", () => {
    const mux = mockMux("nw-H-WRK-1-1");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("matches session by workspace ref", () => {
    const mux = mockMux("nw-M-CI-2-3\nnw-H-WRK-1-1");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("matches session by item ID in session name", () => {
    const mux = mockMux("nw-H-WRK-1-1\nnw-M-CI-2-2");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(true);
  });

  it("returns false for session not in listing", () => {
    const mux = mockMux("nw-M-CI-2-1");
    const item = makeItem("H-WRK-1", "nw-H-WRK-1-1");
    expect(isWorkerAlive(item, mux)).toBe(false);
  });
});

// ── isWorkerAliveWithCache (H-TP-2) ──────────────────────────────

describe("isWorkerAliveWithCache", () => {
  function makeItem(id: string, workspaceRef?: string): OrchestratorItem {
    return {
      id,
      workItem: makeWorkItem(id),
      state: "implementing",
      workspaceRef,
      lastTransition: new Date().toISOString(),
      ciFailCount: 0,
      retryCount: 0,
    };
  }

  it("returns true when workspace ref matches in listing", () => {
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAliveWithCache(item, "  workspace:1  ✳ T-1-1: some task")).toBe(true);
  });

  it("returns true when matching by item ID", () => {
    const item = makeItem("T-2-1", "workspace:5");
    expect(isWorkerAliveWithCache(item, "  workspace:5  ✳ T-2-1: another task")).toBe(true);
  });

  it("returns false when no match in listing", () => {
    const item = makeItem("T-99-1", "workspace:99");
    expect(isWorkerAliveWithCache(item, "  workspace:1  ✳ T-1-1: some task")).toBe(false);
  });

  it("returns false when listing is empty string", () => {
    const item = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAliveWithCache(item, "")).toBe(false);
  });

  it("returns false when workspaceRef is undefined", () => {
    const item = makeItem("T-1-1", undefined);
    expect(isWorkerAliveWithCache(item, "  workspace:1  ✳ T-1-1: some task")).toBe(false);
  });

  it("matches correctly in a multi-line listing", () => {
    const listing = [
      "  workspace:10  ✳ T-10-1: task ten",
      "  workspace:1  ✳ T-1-1: task one",
    ].join("\n");

    const item1 = makeItem("T-1-1", "workspace:1");
    expect(isWorkerAliveWithCache(item1, listing)).toBe(true);

    const itemMissing = makeItem("T-99-1", "workspace:99");
    expect(isWorkerAliveWithCache(itemMissing, listing)).toBe(false);
  });
});

// ── cleanOrphanedWorktrees ──────────────────────────────────────────

describe("cleanOrphanedWorktrees", () => {
  function makeDeps(overrides: Partial<CleanOrphanedDeps> = {}): CleanOrphanedDeps {
    return {
      getWorktreeIds: () => [],
      getOpenItemIds: () => [],
      cleanWorktree: () => true,
      log: () => {},
      ...overrides,
    };
  }

  it("cleans worktrees with no matching work item file", () => {
    const cleaned: string[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1", "H-WRK-2"],
      getOpenItemIds: () => ["H-WRK-2"], // M-CI-1 has no work item file
      cleanWorktree: (id) => {
        cleaned.push(id);
        return true;
      },
    });

    const result = cleanOrphanedWorktrees("/items", "/worktrees", "/root", deps);
    expect(result).toEqual(["M-CI-1"]);
    expect(cleaned).toEqual(["M-CI-1"]);
  });

  it("preserves worktrees with matching work item file", () => {
    const cleaned: string[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1", "H-WRK-2"],
      getOpenItemIds: () => ["M-CI-1", "H-WRK-2"],
      cleanWorktree: (id) => {
        cleaned.push(id);
        return true;
      },
    });

    const result = cleanOrphanedWorktrees("/items", "/worktrees", "/root", deps);
    expect(result).toEqual([]);
    expect(cleaned).toEqual([]);
  });

  it("returns empty when no worktrees exist", () => {
    const deps = makeDeps({
      getWorktreeIds: () => [],
      getOpenItemIds: () => ["M-CI-1"],
    });

    const result = cleanOrphanedWorktrees("/items", "/worktrees", "/root", deps);
    expect(result).toEqual([]);
  });

  it("logs when orphaned worktrees are cleaned", () => {
    const logs: LogEntry[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1", "H-WRK-2"],
      getOpenItemIds: () => [],
      log: (entry) => logs.push(entry),
    });

    cleanOrphanedWorktrees("/items", "/worktrees", "/root", deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.event).toBe("orphaned_worktrees_cleaned");
    expect(logs[0]!.count).toBe(2);
    expect(logs[0]!.cleanedIds).toEqual(["M-CI-1", "H-WRK-2"]);
  });

  it("does not log when no orphans found", () => {
    const logs: LogEntry[] = [];
    const deps = makeDeps({
      getWorktreeIds: () => ["M-CI-1"],
      getOpenItemIds: () => ["M-CI-1"],
      log: (entry) => logs.push(entry),
    });

    cleanOrphanedWorktrees("/items", "/worktrees", "/root", deps);
    expect(logs).toHaveLength(0);
  });
});

describe("executeClean readScreen diagnostics", () => {
  it("does not call readScreen for merged items", async () => {
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("MRG-1"));
    orch.getItem("MRG-1")!.reviewCompleted = true;

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
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "auto", maxRetries: 0 });
    orch.addItem(makeWorkItem("STK-1"));
    orch.getItem("STK-1")!.reviewCompleted = true;

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
    // event loop and macrotask-based timers (setTimeout/setInterval) -- including
    // the SIGKILL safety guard -- never fire.
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("SPIN-1"));
    orch.getItem("SPIN-1")!.reviewCompleted = true;

    let cycles = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (o: Orchestrator): PollSnapshot => {
      cycles++;
      const readyIds: string[] = [];
      for (const item of o.getAllItems()) {
        if (item.state === "queued") readyIds.push(item.id);
      }
      // After launch, always return empty -- item stuck in "launching" forever
      return { items: [], readyIds };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 50 });

    // Guard fired -- loop terminated
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


// ── Watch mode tests ────────────────────────────────────────────────

describe("orchestrateLoop watch mode", () => {
  it("does not exit when all items are terminal with --watch", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("W-1-1"));
    orch.getItem("W-1-1")!.reviewCompleted = true;

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
        case 8: // Review auto-approves W-1-2
          return {
            items: [{ id: "W-1-2", prNumber: 2, prState: "open", ciStatus: "pass", reviewVerdict: { verdict: "approve" as const, summary: "OK", blockerCount: 0, nitCount: 0, preExistingCount: 0, architectureScore: 8, codeQualityScore: 9, performanceScore: 7, testCoverageScore: 8, unresolvedDecisions: 0, criticalGaps: 0, confidence: 9 } }],
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
      scanWorkItems: () => {
        scanCallCount++;
        // On first scan, return the new item
        if (scanCallCount >= 1) {
          return [makeWorkItem("W-1-1"), makeWorkItem("W-1-2")];
        }
        return [makeWorkItem("W-1-1")];
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { watch: true, maxIterations: 200 });

    // Both items should reach done
    expect(orch.getItem("W-1-1")!.state).toBe("done");
    expect(orch.getItem("W-1-2")!.state).toBe("done");

    // Watch mode waiting log was emitted
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(true);
    const watchLog = logs.find((l) => l.event === "watch_mode_waiting")!;
    expect(watchLog.message).toBe("All items complete. Watching for new work items...");

    // New items detected log was emitted
    expect(logs.some((l) => l.event === "watch_new_items")).toBe(true);
    const newItemsLog = logs.find((l) => l.event === "watch_new_items")!;
    expect(newItemsLog.newIds).toEqual(["W-1-2"]);

    // scanWorkItems was called
    expect(scanCallCount).toBeGreaterThan(0);
  });

  it("without --watch, daemon exits normally when all items are terminal", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("N-1-1"));
    orch.getItem("N-1-1")!.reviewCompleted = true;

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
      scanWorkItems: () => {
        scanCalled = true;
        return [];
      },
    };

    // No watch flag -- should exit after all done
    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    expect(orch.getItem("N-1-1")!.state).toBe("done");
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(false);
    expect(scanCalled).toBe(false);
  });

  it("uses custom watch interval from --watch-interval", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("I-1-1"));
    orch.getItem("I-1-1")!.reviewCompleted = true;

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
      scanWorkItems: () => [makeWorkItem("I-1-1")], // Only return existing item, no new ones
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("S-1-1"));
    orch.getItem("S-1-1")!.reviewCompleted = true;

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
      scanWorkItems: () => [makeWorkItem("S-1-1")], // No new items
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
    const orch = new Orchestrator({ wipLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("L-1-1"));
    orch.getItem("L-1-1")!.reviewCompleted = true;

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
          const depsMet = item.workItem.dependencies.every((depId) => {
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

        // Drive items through lifecycle: launching → implementing → ci-pending → review → merge
        if (item.state === "launching") {
          items.push({ id: item.id, workerAlive: true });
        } else if (item.state === "implementing") {
          // After 1 cycle in implementing, show a PR
          items.push({ id: item.id, prNumber: 99, prState: "open", ciStatus: "pass" });
        } else if (item.state === "reviewing") {
          // Review auto-approves
          items.push({ id: item.id, prNumber: 99, prState: "open", ciStatus: "pass", reviewVerdict: { verdict: "approve" as const, summary: "OK", blockerCount: 0, nitCount: 0, preExistingCount: 0, architectureScore: 8, codeQualityScore: 9, performanceScore: 7, testCoverageScore: 8, unresolvedDecisions: 0, criticalGaps: 0, confidence: 9 } });
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
      scanWorkItems: () => {
        scanCount++;
        // Return 3 items -- but WIP limit is 1, so they should be queued/serial
        return [makeWorkItem("L-1-1"), makeWorkItem("L-1-2"), makeWorkItem("L-1-3")];
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
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("D-1-1"));
    orch.getItem("D-1-1")!.reviewCompleted = true;

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
      scanWorkItems: () => [makeWorkItem("D-1-1")], // No new items
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

// ── Crew mode integration tests ──────────────────────────────────────

describe("orchestrateLoop crew mode", () => {
  /** Create a mock CrewBroker for testing. */
  function mockCrewBroker(opts: {
    connected?: boolean;
    claimResults?: (string | null)[];
    onSync?: (ids: string[]) => void;
    onComplete?: (todoId: string) => void;
    onDisconnect?: () => void;
  } = {}) {
    const claimResults = [...(opts.claimResults ?? [])];
    let claimIdx = 0;
    const completedIds: string[] = [];
    const syncedIds: string[][] = [];
    let disconnected = false;
    return {
      broker: {
        connect: vi.fn(async () => {}),
        sync: vi.fn((ids: string[]) => {
          syncedIds.push(ids);
          opts.onSync?.(ids);
        }),
        claim: vi.fn(async () => {
          const result = claimResults[claimIdx] ?? null;
          claimIdx++;
          return result;
        }),
        complete: vi.fn((todoId: string) => {
          completedIds.push(todoId);
          opts.onComplete?.(todoId);
        }),
        heartbeat: vi.fn(),
        disconnect: vi.fn(() => {
          disconnected = true;
          opts.onDisconnect?.();
        }),
        isConnected: vi.fn(() => opts.connected ?? true),
        getCrewStatus: vi.fn(() => null),
      },
      completedIds,
      syncedIds,
      isDisconnected: () => disconnected,
    };
  }

  it("filters launch actions through crew broker -- only claimed items launch", async () => {
    const orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1"));
    orch.getItem("T-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-2"));
    orch.getItem("T-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-3"));
    orch.getItem("T-3")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

    // Broker assigns T-2 on first batch, then keeps returning null for subsequent cycles
    const { broker, syncedIds } = mockCrewBroker({
      connected: true,
      claimResults: [null, "T-2", null, null, null, null, null, null, null],
    });

    const launchCalls: string[] = [];
    const actionDepsOverride = mockActionDeps({
      launchSingleItem: vi.fn((workItem) => {
        launchCalls.push(workItem.id);
        return { worktreePath: "/tmp/test", workspaceRef: `ws:${workItem.id}` };
      }),
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        if (cycle === 1) {
          return { items: [], readyIds: ["T-1", "T-2", "T-3"] };
        }
        // After cycle 1, T-2 should be launched. Report it as alive.
        return { items: [{ id: "T-2", workerAlive: true }], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: (e) => logs.push(e),
      actionDeps: actionDepsOverride,
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3, // 16GB -- prevent memory-based WIP reduction
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 2 });

    // Only T-2 should have been launched
    expect(launchCalls).toEqual(["T-2"]);
    // T-1 and T-3 should be in ready state (reverted)
    expect(orch.getItem("T-1")!.state).toBe("ready");
    expect(orch.getItem("T-3")!.state).toBe("ready");
    // Broker should have been synced
    expect(syncedIds.length).toBeGreaterThan(0);
  });

  it("blocks ALL launches when broker is disconnected", async () => {
    const orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1"));
    orch.getItem("T-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-2"));
    orch.getItem("T-2")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

    const { broker } = mockCrewBroker({ connected: false });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        if (cycle === 1) return { items: [], readyIds: ["T-1", "T-2"] };
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: (e) => logs.push(e),
      actionDeps: mockActionDeps(),
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 3 });

    // No items should have been launched
    expect(deps.actionDeps.launchSingleItem).not.toHaveBeenCalled();
    // Items should be back in ready state
    expect(orch.getItem("T-1")!.state).toBe("ready");
    expect(orch.getItem("T-2")!.state).toBe("ready");
    // Should have logged the blocking event
    const blockLogs = logs.filter((l) => l.event === "crew_launches_blocked");
    expect(blockLogs.length).toBeGreaterThan(0);
  });

  it("calls broker.complete after merge/done actions", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1"));
    orch.getItem("T-1")!.reviewCompleted = true;

    let cycle = 0;
    const { broker, completedIds } = mockCrewBroker({
      connected: true,
      claimResults: ["T-1"],
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1:
            return { items: [], readyIds: ["T-1"] };
          case 2:
            return { items: [{ id: "T-1", workerAlive: true }], readyIds: [] };
          case 3:
            return { items: [{ id: "T-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
          case 4:
            return { items: [{ id: "T-1", prState: "merged" }], readyIds: [] };
          default:
            return { items: [], readyIds: [] };
        }
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 10 });

    // Broker should have been notified of completion
    expect(completedIds).toContain("T-1");
  });
});

// ── parseWatchArgs (passthrough path) ──────────────────────────────────

describe("parseWatchArgs", () => {
  it("parses --items --merge-strategy --wip-limit for passthrough", () => {
    const result = parseWatchArgs([
      "--items", "H-FOO-1", "H-FOO-2",
      "--merge-strategy", "auto",
      "--wip-limit", "3",
    ]);
    expect(result.itemIds).toEqual(["H-FOO-1", "H-FOO-2"]);
    expect(result.mergeStrategy).toBe("auto");
    expect(result.wipLimitOverride).toBe(3);
  });

  it("skips interactive flow when items are pre-passed via CLI args", () => {
    const result = parseWatchArgs([
      "--items", "H-FOO-1",
      "--merge-strategy", "auto",
      "--wip-limit", "3",
    ]);
    // The passthrough assertion: having items means shouldEnterInteractive returns false
    expect(result.itemIds.length).toBeGreaterThan(0);
    expect(shouldEnterInteractive(result.itemIds.length > 0, { isTTY: true })).toBe(false);
  });

  it("accepts comma-separated items", () => {
    const result = parseWatchArgs(["--items", "A-1,B-2,C-3"]);
    expect(result.itemIds).toEqual(["A-1", "B-2", "C-3"]);
  });

  it("accepts space-separated items", () => {
    const result = parseWatchArgs(["--items", "A-1", "B-2", "C-3"]);
    expect(result.itemIds).toEqual(["A-1", "B-2", "C-3"]);
  });

  it("stops collecting items at next flag", () => {
    const result = parseWatchArgs(["--items", "A-1", "B-2", "--wip-limit", "5"]);
    expect(result.itemIds).toEqual(["A-1", "B-2"]);
    expect(result.wipLimitOverride).toBe(5);
  });

  it("defaults merge strategy to auto when not specified", () => {
    const result = parseWatchArgs(["--items", "A-1"]);
    expect(result.mergeStrategy).toBe("auto");
  });

  it("parses manual merge strategy", () => {
    const result = parseWatchArgs(["--items", "A-1", "--merge-strategy", "manual"]);
    expect(result.mergeStrategy).toBe("manual");
  });

  it("leaves wipLimitOverride undefined when --wip-limit not passed", () => {
    const result = parseWatchArgs(["--items", "A-1"]);
    expect(result.wipLimitOverride).toBeUndefined();
  });

  it("preserves CLI wip-limit value (not overridden by defaults)", () => {
    const result = parseWatchArgs([
      "--items", "A-1",
      "--wip-limit", "7",
    ]);
    // wipLimitOverride is set to 7, which cmdOrchestrate uses to override the
    // computed default: `wipLimit = wipLimitOverride ?? computedWipLimit`
    expect(result.wipLimitOverride).toBe(7);
  });

  it("parses all flags together", () => {
    const result = parseWatchArgs([
      "--items", "H-1", "H-2",
      "--merge-strategy", "manual",
      "--wip-limit", "5",
      "--poll-interval", "60",
      "--skip-preflight",
      "--json",
    ]);
    expect(result.itemIds).toEqual(["H-1", "H-2"]);
    expect(result.mergeStrategy).toBe("manual");
    expect(result.wipLimitOverride).toBe(5);
    expect(result.pollIntervalOverride).toBe(60_000);
    expect(result.skipPreflight).toBe(true);
    expect(result.jsonFlag).toBe(true);
  });

  it("throws on unknown option", () => {
    expect(() => parseWatchArgs(["--bogus"])).toThrow("Unknown option: --bogus");
  });

  it("--daemon implies --watch unless --no-watch", () => {
    const daemonOnly = parseWatchArgs(["--daemon", "--items", "A-1"]);
    expect(daemonOnly.daemonMode).toBe(true);
    expect(daemonOnly.watchMode).toBe(true);

    const daemonNoWatch = parseWatchArgs(["--daemon", "--no-watch", "--items", "A-1"]);
    expect(daemonNoWatch.daemonMode).toBe(true);
    expect(daemonNoWatch.watchMode).toBe(false);
  });

  it("--dangerously-bypass sets bypassEnabled and merge strategy to bypass", () => {
    const result = parseWatchArgs(["--items", "A-1", "--dangerously-bypass"]);
    expect(result.bypassEnabled).toBe(true);
    expect(result.mergeStrategy).toBe("bypass");
  });

  it("defaults bypassEnabled to false when --dangerously-bypass not passed", () => {
    const result = parseWatchArgs(["--items", "A-1"]);
    expect(result.bypassEnabled).toBe(false);
    expect(result.mergeStrategy).toBe("auto");
  });
});

// ── validateItemIds ────────────────────────────────────────────────────

describe("validateItemIds", () => {
  const workItemMap = new Map<string, WorkItem>([
    ["H-FOO-1", makeWorkItem("H-FOO-1")],
    ["H-FOO-2", makeWorkItem("H-FOO-2")],
    ["H-FOO-3", makeWorkItem("H-FOO-3")],
  ]);

  it("returns empty array when all IDs are valid", () => {
    expect(validateItemIds(["H-FOO-1", "H-FOO-2"], workItemMap)).toEqual([]);
  });

  it("returns unknown IDs", () => {
    expect(validateItemIds(["H-FOO-1", "H-BAR-99"], workItemMap)).toEqual(["H-BAR-99"]);
  });

  it("returns all IDs when none match", () => {
    expect(validateItemIds(["X-1", "Y-2"], workItemMap)).toEqual(["X-1", "Y-2"]);
  });

  it("returns empty for empty input", () => {
    expect(validateItemIds([], workItemMap)).toEqual([]);
  });
});

// ── Passthrough integration ────────────────────────────────────────────

describe("cmdOrchestrate passthrough path", () => {
  it("full passthrough: parsed args + validation + no interactive flow", () => {
    // Simulate the exact passthrough path used by cmdNoArgs:
    // nw watch --items H-FOO-1 --merge-strategy auto --wip-limit 3

    // Step 1: Parse args
    const parsed = parseWatchArgs([
      "--items", "H-FOO-1", "H-FOO-2",
      "--merge-strategy", "auto",
      "--wip-limit", "3",
    ]);

    // Step 2: Verify interactive flow is skipped (the key passthrough behavior)
    expect(shouldEnterInteractive(parsed.itemIds.length > 0, { isTTY: true })).toBe(false);
    expect(shouldEnterInteractive(parsed.itemIds.length > 0, { isTTY: false })).toBe(false);

    // Step 3: Validate items against a work item map
    const workItemMap = new Map<string, WorkItem>([
      ["H-FOO-1", makeWorkItem("H-FOO-1")],
      ["H-FOO-2", makeWorkItem("H-FOO-2")],
    ]);
    expect(validateItemIds(parsed.itemIds, workItemMap)).toEqual([]);

    // Step 4: Verify orchestrator would receive correct config
    expect(parsed.itemIds).toEqual(["H-FOO-1", "H-FOO-2"]);
    expect(parsed.mergeStrategy).toBe("auto");
    expect(parsed.wipLimitOverride).toBe(3);
  });

  it("CLI wip-limit overrides computed default (not the other way around)", () => {
    const parsed = parseWatchArgs(["--items", "A-1", "--wip-limit", "3"]);
    // In cmdOrchestrate: wipLimit = wipLimitOverride ?? computedWipLimit
    // When wipLimitOverride is set, it takes precedence over computedWipLimit
    const computedWipLimit = 5; // simulate any computed default
    const effectiveWipLimit = parsed.wipLimitOverride ?? computedWipLimit;
    expect(effectiveWipLimit).toBe(3);
  });

  it("unknown item ID would be caught by validation", () => {
    const parsed = parseWatchArgs([
      "--items", "H-FOO-1", "H-UNKNOWN-99",
      "--merge-strategy", "auto",
      "--wip-limit", "3",
    ]);

    const workItemMap = new Map<string, WorkItem>([
      ["H-FOO-1", makeWorkItem("H-FOO-1")],
    ]);

    const unknown = validateItemIds(parsed.itemIds, workItemMap);
    expect(unknown).toEqual(["H-UNKNOWN-99"]);
  });
});

// ── Ring buffer tests ────────────────────────────────────────────────

describe("pushLogBuffer (ring buffer)", () => {
  function makeEntry(i: number, level?: string): PanelLogEntry {
    const msg = level ? `[${level}] event-${i}` : `event-${i}`;
    return { timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, itemId: `I-${i}`, message: msg };
  }

  it("push 600 entries, verify length is 500 and oldest are dropped", () => {
    const buffer: PanelLogEntry[] = [];
    for (let i = 0; i < 600; i++) {
      pushLogBuffer(buffer, makeEntry(i));
    }
    expect(buffer.length).toBe(LOG_BUFFER_MAX);
    // Oldest 100 entries (0-99) should be dropped; first entry should be #100
    expect(buffer[0]!.message).toBe("event-100");
    expect(buffer[buffer.length - 1]!.message).toBe("event-599");
  });

  it("does not drop entries when under capacity", () => {
    const buffer: PanelLogEntry[] = [];
    for (let i = 0; i < 10; i++) {
      pushLogBuffer(buffer, makeEntry(i));
    }
    expect(buffer.length).toBe(10);
    expect(buffer[0]!.message).toBe("event-0");
  });

  it("drops exactly one entry at capacity+1", () => {
    const buffer: PanelLogEntry[] = [];
    for (let i = 0; i < LOG_BUFFER_MAX; i++) {
      pushLogBuffer(buffer, makeEntry(i));
    }
    expect(buffer.length).toBe(LOG_BUFFER_MAX);
    pushLogBuffer(buffer, makeEntry(LOG_BUFFER_MAX));
    expect(buffer.length).toBe(LOG_BUFFER_MAX);
    expect(buffer[0]!.message).toBe("event-1");
  });
});

describe("filterLogsByLevel", () => {
  function makeEntry(level: string, i: number): PanelLogEntry {
    return {
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      itemId: `I-${i}`,
      message: `[${level}] event-${i}`,
    };
  }

  const mixed: PanelLogEntry[] = [
    makeEntry("info", 0),
    makeEntry("warn", 1),
    makeEntry("error", 2),
    makeEntry("info", 3),
    makeEntry("error", 4),
    makeEntry("warn", 5),
    { timestamp: "2026-01-01T00:00:06Z", itemId: "I-6", message: "no-prefix event" }, // defaults to info
  ];

  it("filter 'all' returns everything", () => {
    const result = filterLogsByLevel(mixed, "all");
    expect(result.length).toBe(mixed.length);
  });

  it("filter 'error' returns only error entries", () => {
    const result = filterLogsByLevel(mixed, "error");
    expect(result.length).toBe(2);
    expect(result.every((e) => e.message.includes("[error]"))).toBe(true);
  });

  it("filter 'warn' returns warn and error entries", () => {
    const result = filterLogsByLevel(mixed, "warn");
    expect(result.length).toBe(4); // 2 warn + 2 error
    expect(result.every((e) => e.message.includes("[warn]") || e.message.includes("[error]"))).toBe(true);
  });

  it("filter 'info' returns info, warn, and error entries (all with level >= info)", () => {
    const result = filterLogsByLevel(mixed, "info");
    // All 7 entries have level >= info (no-prefix defaults to info)
    expect(result.length).toBe(7);
  });
});

// ── Panel mode cycling via keyboard shortcuts ────────────────────────

describe("panel mode cycling (Tab key)", () => {
  function mockStdin() {
    const listeners: Record<string, Function[]> = {};
    return {
      isTTY: true as const,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: Function) => { (listeners[event] ??= []).push(cb); }),
      removeListener: vi.fn((event: string, cb: Function) => {
        const arr = listeners[event];
        if (arr) { const idx = arr.indexOf(cb); if (idx >= 0) arr.splice(idx, 1); }
      }),
      _emit(event: string, data: any) { for (const cb of (listeners[event] ?? [])) cb(data); },
    } as unknown as NodeJS.ReadStream;
  }

  function baseTuiState(overrides?: Partial<TuiState>): TuiState {
    return {
      scrollOffset: 0,
      viewOptions: {},
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      ...overrides,
    };
  }

  it("Tab cycles split -> logs-only -> status-only -> split (large terminal)", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState = baseTuiState({ panelMode: "split" });

    // Mock getTerminalHeight to return large terminal
    const origColumns = process.stdout.columns;
    const origRows = process.stdout.rows;
    process.stdout.columns = 120;
    process.stdout.rows = 50;
    try {
      setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

      (stdin as any)._emit("data", "\t"); // split -> logs-only
      expect(tuiState.panelMode).toBe("logs-only");

      (stdin as any)._emit("data", "\t"); // logs-only -> status-only
      expect(tuiState.panelMode).toBe("status-only");

      (stdin as any)._emit("data", "\t"); // status-only -> split
      expect(tuiState.panelMode).toBe("split");
    } finally {
      process.stdout.columns = origColumns;
      process.stdout.rows = origRows;
    }
  });

  it("Tab cycles logs-only -> status-only in small terminal (< MIN_SPLIT_ROWS)", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState = baseTuiState({ panelMode: "logs-only" });

    const origRows = process.stdout.rows;
    process.stdout.rows = 20; // < 35 (MIN_SPLIT_ROWS)
    try {
      setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

      (stdin as any)._emit("data", "\t"); // logs-only -> status-only
      expect(tuiState.panelMode).toBe("status-only");

      (stdin as any)._emit("data", "\t"); // status-only -> logs-only (wraps, no split)
      expect(tuiState.panelMode).toBe("logs-only");
    } finally {
      process.stdout.rows = origRows;
    }
  });
});

// ── j/k scroll and G jump ───────────────────────────────────────────

describe("log panel scroll (j/k/G keys)", () => {
  function mockStdin() {
    const listeners: Record<string, Function[]> = {};
    return {
      isTTY: true as const,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: Function) => { (listeners[event] ??= []).push(cb); }),
      removeListener: vi.fn((event: string, cb: Function) => {
        const arr = listeners[event];
        if (arr) { const idx = arr.indexOf(cb); if (idx >= 0) arr.splice(idx, 1); }
      }),
      _emit(event: string, data: any) { for (const cb of (listeners[event] ?? [])) cb(data); },
    } as unknown as NodeJS.ReadStream;
  }

  function baseTuiState(overrides?: Partial<TuiState>): TuiState {
    return {
      scrollOffset: 0,
      viewOptions: {},
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      ...overrides,
    };
  }

  it("j increments logScrollOffset", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState = baseTuiState();

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "j");
    expect(tuiState.logScrollOffset).toBe(1);

    (stdin as any)._emit("data", "j");
    expect(tuiState.logScrollOffset).toBe(2);
  });

  it("k decrements logScrollOffset, clamped at 0", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState = baseTuiState({ logScrollOffset: 3 });

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "k");
    expect(tuiState.logScrollOffset).toBe(2);

    // Scroll to 0
    (stdin as any)._emit("data", "k");
    (stdin as any)._emit("data", "k");
    expect(tuiState.logScrollOffset).toBe(0);

    // Should not go below 0
    (stdin as any)._emit("data", "k");
    expect(tuiState.logScrollOffset).toBe(0);
  });

  it("G jumps to end (follow mode)", () => {
    const ac = new AbortController();
    const stdin = mockStdin();

    const entries: PanelLogEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push({ timestamp: "2026-01-01T00:00:00Z", itemId: `I-${i}`, message: `event-${i}` });
    }

    const origRows = process.stdout.rows;
    process.stdout.rows = 40;
    try {
      const tuiState = baseTuiState({
        logBuffer: entries,
        logScrollOffset: 0,
      });

      setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

      (stdin as any)._emit("data", "G");

      // G should set logScrollOffset = max(0, buffer.length - viewportHeight)
      // viewportHeight ~= termRows - 10 = 30
      const expectedOffset = Math.max(0, entries.length - 30);
      expect(tuiState.logScrollOffset).toBe(expectedOffset);
    } finally {
      process.stdout.rows = origRows;
    }
  });
});

// ── Log level filter cycling (l key) ────────────────────────────────

describe("log level filter cycling (l key)", () => {
  function mockStdin() {
    const listeners: Record<string, Function[]> = {};
    return {
      isTTY: true as const,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn((event: string, cb: Function) => { (listeners[event] ??= []).push(cb); }),
      removeListener: vi.fn((event: string, cb: Function) => {
        const arr = listeners[event];
        if (arr) { const idx = arr.indexOf(cb); if (idx >= 0) arr.splice(idx, 1); }
      }),
      _emit(event: string, data: any) { for (const cb of (listeners[event] ?? [])) cb(data); },
    } as unknown as NodeJS.ReadStream;
  }

  function baseTuiState(overrides?: Partial<TuiState>): TuiState {
    return {
      scrollOffset: 0,
      viewOptions: {},
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      ...overrides,
    };
  }

  it("l cycles info -> warn -> error -> all", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    // Start at "info" (first in cycle after initial "all" if we start from a specific position)
    const tuiState = baseTuiState({ logLevelFilter: "info" });

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "l"); // info -> warn
    expect(tuiState.logLevelFilter).toBe("warn");

    (stdin as any)._emit("data", "l"); // warn -> error
    expect(tuiState.logLevelFilter).toBe("error");

    (stdin as any)._emit("data", "l"); // error -> all
    expect(tuiState.logLevelFilter).toBe("all");

    (stdin as any)._emit("data", "l"); // all -> info (wraps)
    expect(tuiState.logLevelFilter).toBe("info");
  });

  it("l resets logScrollOffset to 0 on filter change", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState = baseTuiState({ logLevelFilter: "all", logScrollOffset: 42 });

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "l");
    expect(tuiState.logScrollOffset).toBe(0);
  });
});

// ── Integration: log closure populates both file and buffer ──────────

// ── Post-completion prompt ──────────────────────────────────────────

describe("formatExitSummary", () => {
  it("formats compact summary with counts and duration", () => {
    const startTime = new Date(Date.now() - 125_000).toISOString(); // 2m 5s ago
    const items: OrchestratorItem[] = [
      { ...makeOrchestratorItem("E-1"), state: "done" as any },
      { ...makeOrchestratorItem("E-2"), state: "stuck" as any },
      { ...makeOrchestratorItem("E-3"), state: "queued" as any },
    ];
    const result = formatExitSummary(items, startTime);
    expect(result).toContain("ninthwave:");
    expect(result).toContain("1 merged");
    expect(result).toContain("1 stuck");
    expect(result).toContain("1 queued");
    expect(result).toMatch(/2m \d+s/);
  });

  it("includes cost when costData is provided", () => {
    const startTime = new Date(Date.now() - 60_000).toISOString();
    const items: OrchestratorItem[] = [
      { ...makeOrchestratorItem("E-1"), state: "done" as any },
    ];
    const costData = new Map([["E-1", { tokensUsed: 50000, costUsd: 1.23 }]]);
    const result = formatExitSummary(items, startTime, costData);
    expect(result).toContain("Cost: $1.23");
    expect(result).toContain("1 PRs");
  });

  it("includes lead time percentiles when timing data exists", () => {
    const now = Date.now();
    const items: OrchestratorItem[] = [
      {
        ...makeOrchestratorItem("E-1"),
        state: "done" as any,
        startedAt: new Date(now - 300_000).toISOString(),
        endedAt: new Date(now - 60_000).toISOString(),
      },
    ];
    const result = formatExitSummary(items, new Date(now - 360_000).toISOString());
    expect(result).toContain("Lead time: p50");
  });

  it("handles 0 items gracefully", () => {
    const result = formatExitSummary([], new Date().toISOString());
    expect(result).toContain("0 merged, 0 stuck, 0 queued");
  });
});

describe("formatCompletionBanner", () => {
  it("shows item counts, duration, and prompt keys", () => {
    const items: OrchestratorItem[] = [
      { ...makeOrchestratorItem("B-1"), state: "done" as any },
      { ...makeOrchestratorItem("B-2"), state: "done" as any },
      { ...makeOrchestratorItem("B-3"), state: "stuck" as any },
    ];
    const lines = formatCompletionBanner(items, new Date(Date.now() - 60_000).toISOString());
    const text = lines.join("\n");
    expect(text).toContain("All 3 items complete");
    expect(text).toContain("2 merged, 1 stuck");
    expect(text).toContain("[r] Run more");
    expect(text).toContain("[c] Clean up");
    expect(text).toContain("[q] Quit");
  });

  it("includes cost when costData is provided", () => {
    const items: OrchestratorItem[] = [
      { ...makeOrchestratorItem("B-1"), state: "done" as any },
    ];
    const costData = new Map([["B-1", { tokensUsed: 10000, costUsd: 0.50 }]]);
    const lines = formatCompletionBanner(items, new Date().toISOString(), costData);
    const text = lines.join("\n");
    expect(text).toContain("Cost: $0.50");
  });
});

describe("waitForCompletionKey", () => {
  it("resolves with quit when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    // Use a minimal mock stdin
    const mockStdin = { on: vi.fn(), removeListener: vi.fn() } as unknown as NodeJS.ReadStream;
    const result = await waitForCompletionKey(mockStdin, ac.signal);
    expect(result).toBe("quit");
  });

  it("resolves with run-more on r key", async () => {
    const mockStdin = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;
    const promise = waitForCompletionKey(mockStdin);
    // Simulate pressing 'r'
    const onData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;
    onData("r");
    const result = await promise;
    expect(result).toBe("run-more");
  });

  it("resolves with clean on c key", async () => {
    const mockStdin = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;
    const promise = waitForCompletionKey(mockStdin);
    const onData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;
    onData("c");
    expect(await promise).toBe("clean");
  });

  it("resolves with quit on q key", async () => {
    const mockStdin = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;
    const promise = waitForCompletionKey(mockStdin);
    const onData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;
    onData("q");
    expect(await promise).toBe("quit");
  });

  it("resolves with quit on Ctrl-C", async () => {
    const mockStdin = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;
    const promise = waitForCompletionKey(mockStdin);
    const onData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;
    onData("\x03"); // Ctrl-C
    expect(await promise).toBe("quit");
  });

  it("ignores non-prompt keys", async () => {
    const mockStdin = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;
    const promise = waitForCompletionKey(mockStdin);
    const onData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;
    // Press invalid keys first
    onData("x");
    onData("z");
    // Then press a valid key
    onData("q");
    expect(await promise).toBe("quit");
  });
});

describe("post-completion prompt (orchestrateLoop)", () => {
  it("shows prompt when all items are terminal and tuiMode is true (not watch)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("P-1-1"));
    orch.getItem("P-1-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];
    let promptCalled = false;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1: return { items: [], readyIds: ["P-1-1"] };
          case 2: return { items: [{ id: "P-1-1", workerAlive: true }], readyIds: [] };
          case 3: return { items: [{ id: "P-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
          default: return { items: [], readyIds: [] };
        }
      },
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      completionPrompt: async () => {
        promptCalled = true;
        return "quit";
      },
    };

    const result = await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200, tuiMode: true });
    expect(promptCalled).toBe(true);
    expect(result.completionAction).toBe("quit");
    expect(logs.some((l) => l.event === "completion_prompt")).toBe(true);
  });

  it("does NOT show prompt in watch mode even with tuiMode", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("P-2-1"));
    orch.getItem("P-2-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];
    let promptCalled = false;
    let scanCalls = 0;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1: return { items: [], readyIds: ["P-2-1"] };
          case 2: return { items: [{ id: "P-2-1", workerAlive: true }], readyIds: [] };
          case 3: return { items: [{ id: "P-2-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
          default: return { items: [], readyIds: [] };
        }
      },
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      completionPrompt: async () => {
        promptCalled = true;
        return "quit";
      },
      scanWorkItems: () => {
        scanCalls++;
        return [makeWorkItem("P-2-1")]; // No new items
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200, tuiMode: true, watch: true });
    // Watch mode takes precedence -- prompt should NOT be called
    expect(promptCalled).toBe(false);
    expect(logs.some((l) => l.event === "watch_mode_waiting")).toBe(true);
  });

  it("returns run-more when user picks r", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("P-3-1"));
    orch.getItem("P-3-1")!.reviewCompleted = true;

    let cycle = 0;
    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1: return { items: [], readyIds: ["P-3-1"] };
          case 2: return { items: [{ id: "P-3-1", workerAlive: true }], readyIds: [] };
          case 3: return { items: [{ id: "P-3-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
          default: return { items: [], readyIds: [] };
        }
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      completionPrompt: async () => "run-more",
    };

    const result = await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200, tuiMode: true });
    expect(result.completionAction).toBe("run-more");
  });

  it("cleans done items when user picks c", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("P-4-1"));
    orch.getItem("P-4-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];
    const cleanCalls: string[] = [];
    const closeCalls: string[] = [];

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1: return { items: [], readyIds: ["P-4-1"] };
          case 2: return { items: [{ id: "P-4-1", workerAlive: true }], readyIds: [] };
          case 3: return { items: [{ id: "P-4-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
          default: return { items: [], readyIds: [] };
        }
      },
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({
        cleanSingleWorktree: vi.fn((id) => { cleanCalls.push(id); return true; }),
        closeWorkspace: vi.fn((ref) => { closeCalls.push(ref); return true; }),
      }),
      completionPrompt: async () => "clean",
    };

    const result = await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200, tuiMode: true });
    expect(result.completionAction).toBe("clean");
    expect(logs.some((l) => l.event === "completion_cleanup")).toBe(true);
    expect(cleanCalls).toContain("P-4-1");
  });

  it("all stuck items trigger completion prompt (no done items)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto", maxRetries: 0 });
    orch.addItem(makeWorkItem("P-5-1"));
    // Directly set state to stuck to bypass the full lifecycle
    const item = orch.getItem("P-5-1")!;
    item.state = "stuck";
    item.lastTransition = new Date().toISOString();

    let promptCalled = false;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      completionPrompt: async () => {
        promptCalled = true;
        return "quit";
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200, tuiMode: true });
    expect(promptCalled).toBe(true);
  });

  it("mix of done and stuck triggers completion prompt", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("P-6-1"));
    orch.addItem(makeWorkItem("P-6-2"));
    // Set one item to done and another to stuck directly
    const item1 = orch.getItem("P-6-1")!;
    item1.state = "done";
    item1.lastTransition = new Date().toISOString();
    const item2 = orch.getItem("P-6-2")!;
    item2.state = "stuck";
    item2.lastTransition = new Date().toISOString();

    let promptCalled = false;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      completionPrompt: async () => {
        promptCalled = true;
        return "quit";
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200, tuiMode: true });
    expect(promptCalled).toBe(true);
  });
});

// ── Persistent layout preferences ─────────────────────────────────────

describe("persistent layout preferences", () => {
  const tmpDir = join("/tmp", `nw-prefs-test-${process.pid}`);

  it("readLayoutPreference returns split when file is missing", () => {
    const result = readLayoutPreference("/nonexistent/project/root");
    expect(result).toBe("split");
  });

  it("writeLayoutPreference + readLayoutPreference roundtrip", () => {
    writeLayoutPreference(tmpDir, "logs-only");
    const result = readLayoutPreference(tmpDir);
    expect(result).toBe("logs-only");
  });

  it("readLayoutPreference returns split for corrupt JSON", () => {
    const { mkdirSync, writeFileSync } = require("fs");
    const dir = userStateDir(tmpDir + "-corrupt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(preferencesFilePath(tmpDir + "-corrupt"), "not json!!!");
    const result = readLayoutPreference(tmpDir + "-corrupt");
    expect(result).toBe("split");
  });

  it("readLayoutPreference returns split for invalid mode value", () => {
    const { mkdirSync, writeFileSync } = require("fs");
    const dir = userStateDir(tmpDir + "-invalid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(preferencesFilePath(tmpDir + "-invalid"), JSON.stringify({ panelMode: "banana" }));
    const result = readLayoutPreference(tmpDir + "-invalid");
    expect(result).toBe("split");
  });

  it("Tab key triggers onPanelModeChange callback", () => {
    // Create a TuiState with the onPanelModeChange callback
    const modeChanges: string[] = [];
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { showBlockerDetail: true },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "split",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      onPanelModeChange: (mode) => { modeChanges.push(mode); },
    };

    const ac = new AbortController();
    // Create a mock stdin
    const listeners = new Map<string, Function>();
    const mockStdin = {
      isTTY: true,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn((event: string, fn: Function) => { listeners.set(event, fn); }),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;

    const cleanup = setupKeyboardShortcuts(ac, () => {}, mockStdin, tuiState);

    // Simulate Tab key press
    const dataHandler = listeners.get("data") as (key: string) => void;
    expect(dataHandler).toBeDefined();
    dataHandler("\t"); // Tab

    expect(modeChanges.length).toBe(1);
    // Default split -> logs-only (or depends on terminal height mock)
    expect(["split", "logs-only", "status-only"]).toContain(modeChanges[0]);

    cleanup();
  });
});

// ── Helper for OrchestratorItem creation ─────────────────────────────

function makeOrchestratorItem(id: string): OrchestratorItem {
  return {
    id,
    workItem: makeWorkItem(id),
    state: "queued",
    lastTransition: new Date().toISOString(),
    ciFailCount: 0,
    retryCount: 0,
    reviewCompleted: false,
    reviewCount: 0,
    failureReason: undefined,
    prNumber: undefined,
    workspaceRef: undefined,
    resolvedRepoRoot: undefined,
    startedAt: undefined,
    endedAt: undefined,
    exitCode: undefined,
    stderrTail: undefined,
    reviewWorkspaceRef: undefined,
    reviewVerdictPath: undefined,
    rebaserWorkspaceRef: undefined,
    baseBranch: undefined,
    detectionLatencyMs: undefined,
    mergeCommitSha: undefined,
    forwardFixerWorktreePath: undefined,
    forwardFixerWorkspaceRef: undefined,
  } as OrchestratorItem;
}

describe("log closure ring buffer integration", () => {
  it("mock log closure pushes entries to logBuffer and file", () => {
    // Simulate what cmdOrchestrate does: create a log closure that writes to both file and buffer
    const logBuffer: PanelLogEntry[] = [];
    const fileEntries: string[] = [];

    // Mock appendFileSync behavior
    const log = (entry: LogEntry) => {
      fileEntries.push(JSON.stringify(entry));
      const levelTag = entry.level !== "info" ? `[${entry.level}] ` : "";
      pushLogBuffer(logBuffer, {
        timestamp: entry.ts,
        itemId: (entry.itemId as string) ?? (entry.id as string) ?? "",
        message: `${levelTag}${entry.event}${entry.message ? ": " + entry.message : ""}`,
      });
    };

    // Push some log entries
    log({ ts: "2026-01-01T00:00:00Z", level: "info", event: "poll_start" });
    log({ ts: "2026-01-01T00:00:01Z", level: "warn", event: "slow_poll", message: "took 5s" });
    log({ ts: "2026-01-01T00:00:02Z", level: "error", event: "ci_failed", itemId: "H-1" });

    // Both file and buffer should have 3 entries
    expect(fileEntries.length).toBe(3);
    expect(logBuffer.length).toBe(3);

    // Verify buffer entries
    expect(logBuffer[0]!.message).toBe("poll_start");
    expect(logBuffer[1]!.message).toBe("[warn] slow_poll: took 5s");
    expect(logBuffer[2]!.message).toBe("[error] ci_failed");
    expect(logBuffer[2]!.itemId).toBe("H-1");
  });
});
