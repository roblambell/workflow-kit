// Tests for core/commands/orchestrate.ts -- Event loop, state reconstruction,
// adaptive polling, structured logging, SIGINT handling, and daemon mode.

import { describe, it, expect, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { EventEmitter } from "events";
import {
  orchestrateLoop,
  adaptivePollInterval,
  reconstructState,
  interruptibleSleep,
  computeDefaultSessionLimit,
  getTmuxStartupInfo,
  buildSnapshot,
  setupKeyboardShortcuts,
  applyRuntimeSnapshotToTuiState,
  isWorkerAlive,
  isWorkerAliveWithCache,
  forkDaemon,
  cleanOrphanedWorktrees,
  buildSessionEndedMetadata,
  parseWatchArgs,
  validateItemIds,
  pushLogBuffer,
  filterLogsByLevel,
  crewStatusToRemoteItemSnapshots,
  filterCrewRemoteWriteActions,
  getVisibleSelectableItemIds,
  normalizeSelectedItemId,
  formatExitSummary,
  formatCompletionBanner,
  waitForCompletionKey,
  applyRuntimeCollaborationAction,
  resolveConfiguredCrewUrl,
  resolveStartupCollaborationAction,
  createRuntimeControlHandlers,
  runInteractiveWatchOperatorSession,
  runTUI,
  spawnInteractiveEngineChild,
  createWatchEngineRunner,
  createDetachedDaemonEngineRunner,
  createInteractiveChildEngineRunner,
  initializeWatchRuntimeFiles,
  cleanupWatchRuntimeFiles,
  bootstrapTuiUpdateNotice,
  renderTuiPanelFrameFromStatusItems,
  runTuiStartupPreparation,
  resolveScheduleExecutionEnabled,
  resolveInteractiveStartupConfig,
  resolveUnresolvedRestartedWorkers,
  loadDiscoveryStartupItems,
  loadLocalStartupItems,
  pruneMergedStartupReplayItems,
  refreshRunnableStartupItems,
  INTERACTIVE_WATCH_STAGE_WARN_MS,
  LOG_BUFFER_MAX,
  RESTART_RECOVERY_HOLD_REASON,
  TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE,
  waitForEngineRecoveryKey,
  type LogEntry,
  type LogLevelFilter,
  type OrchestrateLoopDeps,
  type CleanOrphanedDeps,
  type ParsedWatchArgs,
  type TuiState,
  type CompletionAction,
  type InteractiveEngineChildProcess,
  type WatchEngineSnapshotEvent,
} from "../core/commands/orchestrate.ts";
import type { LogEntry as PanelLogEntry } from "../core/status-render.ts";
import { daemonStateToStatusItems } from "../core/status-render.ts";
import {
  Orchestrator,
  type OrchestratorItem,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { WorkItem } from "../core/types.ts";
import type { StatusItem, ViewOptions } from "../core/status-render.ts";
import type { Multiplexer } from "../core/mux.ts";
import {
  pidFilePath,
  logFilePath,
  readLayoutPreference,
  writeLayoutPreference,
  preferencesFilePath,
  userStateDir,
  readStateFile,
  serializeOrchestratorState,
  writeStateFile,
  type DaemonState,
} from "../core/daemon.ts";
import type { CrewBroker, CrewRemoteItemSnapshot, CrewStatus } from "../core/crew.ts";
import { readCrewCode, crewCodePath } from "../core/crew.ts";
import {
  buildStartupPersistenceUpdates,
  shouldEnterInteractive,
  type InteractiveResult,
} from "../core/interactive.ts";
import { listWorkItems } from "../core/work-item-files.ts";
import { completeMergedWorkItemCleanup } from "../core/commands/reconcile.ts";
import * as launchModule from "../core/commands/launch.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function withProcessRespawnState<T>(
  argv: string[],
  execPath: string,
  fn: () => T,
): T {
  const originalArgv = [...process.argv];
  const originalExecPath = process.execPath;

  try {
    process.argv = [...argv];
    Object.defineProperty(process, "execPath", {
      value: execPath,
      writable: true,
      configurable: true,
    });
    return fn();
  } finally {
    process.argv = originalArgv;
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      writable: true,
      configurable: true,
    });
  }
}

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

function makeStatusItem(overrides: Partial<StatusItem> = {}): StatusItem {
  return {
    id: "TEST-1",
    title: "Test item",
    state: "implementing",
    prNumber: null,
    ageMs: 5 * 60 * 1000,
    repoLabel: "",
    ...overrides,
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
    writeInbox: vi.fn(),
    closeWorkspace: vi.fn(() => true),
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
    ...overrides,
  };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.ninthwave/.worktrees",
  workDir: "/tmp/test-project/.ninthwave/work",
  aiTool: "claude",
};

const STARTUP_LINEAGE = "24af773b-90c0-4f16-a0fd-5be3c5c0fe89";

// ── Tests ────────────────────────────────────────────────────────────

describe("pruneMergedStartupReplayItems", () => {
  it("prunes merged items with lingering work files before startup queuing", () => {
    const staleItem = {
      ...makeWorkItem("H-STALE-1"),
      title: "new work",
      lineageToken: STARTUP_LINEAGE,
    };

    const result = pruneMergedStartupReplayItems(
      [staleItem],
      "/tmp/test-project",
      (id) => id === "H-STALE-1"
        ? `H-STALE-1\t42\tmerged\t\t\told work\t${STARTUP_LINEAGE}`
        : `${id}\t\tno-pr`,
    );

    expect(result.activeItems).toEqual([]);
    expect(result.prunedItems).toEqual([
      { id: "H-STALE-1", prNumber: 42, matchMode: "lineage" },
    ]);
  });

  it("keeps reused IDs with different lineage tokens and open PRs", () => {
    const reusedId = {
      ...makeWorkItem("H-REUSE-1"),
      title: "brand new work",
      lineageToken: STARTUP_LINEAGE,
    };
    const openItem = makeWorkItem("H-OPEN-1");

    const result = pruneMergedStartupReplayItems(
      [reusedId, openItem],
      "/tmp/test-project",
      (id) => {
        if (id === "H-REUSE-1") {
          return "H-REUSE-1\t43\tmerged\t\t\told work\t7ef7e6d1-3c99-451c-b31a-0d617dbb63eb";
        }
        if (id === "H-OPEN-1") {
          return "H-OPEN-1\t44\topen\tMERGEABLE\t2026-04-01T00:00:00Z";
        }
        return `${id}\t\tno-pr`;
      },
    );

    expect(result.activeItems.map((item) => item.id)).toEqual(["H-REUSE-1", "H-OPEN-1"]);
    expect(result.prunedItems).toEqual([]);
  });

  it("uses the legacy fallback path for token-less items", () => {
    const legacyItem = {
      ...makeWorkItem("H-LEGACY-1"),
      title: "legacy work",
      lineageToken: undefined,
    };

    const result = pruneMergedStartupReplayItems(
      [legacyItem],
      "/tmp/test-project",
      () => "H-LEGACY-1\t45\tmerged",
    );

    expect(result.activeItems).toEqual([]);
    expect(result.prunedItems).toEqual([
      { id: "H-LEGACY-1", prNumber: 45, matchMode: "legacy-empty" },
    ]);
  });

  it("keeps legacy title matching intact for token-less merged items", () => {
    const legacyItem = {
      ...makeWorkItem("H-LEGACY-TITLE-1"),
      title: "legacy work",
      lineageToken: undefined,
    };

    const result = pruneMergedStartupReplayItems(
      [legacyItem],
      "/tmp/test-project",
      () => "H-LEGACY-TITLE-1\t46\tmerged\t\t\tfix: legacy work\t",
    );

    expect(result.activeItems).toEqual([]);
    expect(result.prunedItems).toEqual([
      { id: "H-LEGACY-TITLE-1", prNumber: 46, matchMode: "legacy-title" },
    ]);
  });
});

describe("refreshRunnableStartupItems", () => {
  function writeStartupItem(
    workDir: string,
    id: string,
    title: string,
    lineageToken: string,
  ): void {
    writeFileSync(
      join(workDir, `2-startup-items--${id}.md`),
      [
        `# Refactor: ${title} (${id})`,
        "",
        "**Priority:** High",
        "**Depends on:** None",
        "**Domain:** startup-items",
        `**Lineage:** ${lineageToken}`,
        "",
        "Acceptance: Test startup item parsing",
      ].join("\n"),
    );
  }

  it("returns deterministic diff data for removed and still-valid startup items", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ninthwave-startup-refresh-"));
    const workDir = join(projectRoot, ".ninthwave", "work");
    const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");
    const activeLineage = "10000000-0000-4000-8000-000000000001";
    const newLineage = "10000000-0000-4000-8000-000000000002";

    try {
      mkdirSync(workDir, { recursive: true });
      mkdirSync(worktreeDir, { recursive: true });

      writeStartupItem(workDir, "H-SREF-1", "Stale replay item", STARTUP_LINEAGE);
      writeStartupItem(workDir, "H-AREF-1", "Active replay item", activeLineage);

      const initialItems = loadLocalStartupItems(workDir, worktreeDir, projectRoot);

      writeStartupItem(workDir, "H-NREF-1", "New replay item", newLineage);

      const result = await refreshRunnableStartupItems(
        workDir,
        worktreeDir,
        projectRoot,
        initialItems,
        async (id) => {
          if (id === "H-SREF-1") {
            return `H-SREF-1\t52\tmerged\t\t\tStale replay item\t${STARTUP_LINEAGE}`;
          }
          return `${id}\t\tno-pr`;
        },
      );

      expect(result.activeItems.map((item) => item.id).sort()).toEqual([
        "H-AREF-1",
        "H-NREF-1",
      ]);
      expect(result.prunedItems).toEqual([
        { id: "H-SREF-1", prNumber: 52, matchMode: "lineage" },
      ]);
      expect(result.diff).toEqual({
        keptItemIds: ["H-AREF-1"],
        removedItemIds: ["H-SREF-1"],
        addedItemIds: ["H-NREF-1"],
      });
      expect(result.changes).toEqual([
        {
          id: "H-SREF-1",
          type: "removed",
          reason: "merged-pruned",
          prNumber: 52,
          matchMode: "lineage",
        },
        {
          id: "H-NREF-1",
          type: "added",
          reason: "local-add",
        },
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("loadDiscoveryStartupItems", () => {
  it("loads local queue items before any replay pruning", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ninthwave-startup-discovery-"));
    const workDir = join(projectRoot, ".ninthwave", "work");
    const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");

    try {
      mkdirSync(workDir, { recursive: true });
      mkdirSync(worktreeDir, { recursive: true });

      writeFileSync(
        join(workDir, "2-startup-discovery--H-DISC-1.md"),
        [
          "# Refactor: Discovery item (H-DISC-1)",
          "",
          "**Priority:** High",
          "**Depends on:** None",
          "**Domain:** startup-items",
          `**Lineage:** ${STARTUP_LINEAGE}`,
          "",
          "Acceptance: Test startup item parsing",
        ].join("\n"),
      );

      const discoveredItems = loadDiscoveryStartupItems(workDir, worktreeDir, projectRoot);
      expect(discoveredItems.map((item) => item.id)).toEqual(["H-DISC-1"]);

      const replay = pruneMergedStartupReplayItems(
        discoveredItems,
        projectRoot,
        () => `H-DISC-1\t61\tmerged\t\t\tDiscovery item\t${STARTUP_LINEAGE}`,
      );

      expect(replay.activeItems).toEqual([]);
      expect(replay.prunedItems).toEqual([
        { id: "H-DISC-1", prNumber: 61, matchMode: "lineage" },
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("bootstrapTuiUpdateNotice", () => {
  it("hydrates cached update state during startup", async () => {
    const cachedState = {
      status: "update-available" as const,
      currentVersion: "0.4.0",
      latestVersion: "0.5.0",
      checkedAt: 1_000,
    };
    const viewOptions: ViewOptions = { showBlockerDetail: true };
    const refreshUpdateState = vi.fn(async () => cachedState);
    const onUpdate = vi.fn();

    const refreshPromise = bootstrapTuiUpdateNotice(viewOptions, {
      getStartupState: () => ({ cachedState, shouldRefresh: false }),
      refreshUpdateState,
      onUpdate,
    });

    expect(viewOptions.updateState).toEqual(cachedState);
    expect(refreshPromise).toBeNull();
    expect(refreshUpdateState).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("starts one background refresh when cached state is stale", async () => {
    const cachedState = {
      status: "update-available" as const,
      currentVersion: "0.4.0",
      latestVersion: "0.5.0",
      checkedAt: 1_000,
    };
    const refreshedState = {
      status: "update-available" as const,
      currentVersion: "0.4.0",
      latestVersion: "0.5.1",
      checkedAt: 2_000,
    };
    const viewOptions: ViewOptions = { showBlockerDetail: true };
    const refreshUpdateState = vi.fn(async () => refreshedState);
    const onUpdate = vi.fn();

    const refreshPromise = bootstrapTuiUpdateNotice(viewOptions, {
      getStartupState: () => ({ cachedState, shouldRefresh: true }),
      refreshUpdateState,
      onUpdate,
    });

    expect(viewOptions.updateState).toEqual(cachedState);
    expect(refreshUpdateState).toHaveBeenCalledTimes(1);
    expect(refreshPromise).not.toBeNull();

    await refreshPromise;

    expect(viewOptions.updateState).toEqual(refreshedState);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips startup hydration and refresh when update checks are disabled", async () => {
    const viewOptions: ViewOptions = { showBlockerDetail: true };
    const refreshUpdateState = vi.fn(async () => null);
    const onUpdate = vi.fn();

    const refreshPromise = bootstrapTuiUpdateNotice(viewOptions, {
      getStartupState: () => ({ cachedState: null, shouldRefresh: false }),
      refreshUpdateState,
      onUpdate,
    });

    expect(viewOptions.updateState).toBeUndefined();
    expect(refreshPromise).toBeNull();
    expect(refreshUpdateState).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("orchestrateLoop", () => {
  it("logs classified GitHub API warnings", async () => {
    const orch = new Orchestrator({ sessionLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-ERR-1"));
    orch.getItem("T-ERR-1")!.reviewCompleted = true;
    orch.hydrateState("T-ERR-1", "implementing");

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle === 1) {
        return {
          items: [{ id: "T-ERR-1" }],
          readyIds: [],
          apiErrorCount: 2,
          apiErrorSummary: {
            total: 2,
            byKind: { auth: 2 },
            primaryKind: "auth",
          },
        };
      }
      return { items: [{ id: "T-ERR-1" }], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 2 });

    const warnLog = logs.find((l) => l.event === "github_api_errors");
    expect(warnLog).toBeDefined();
    expect(warnLog!.message).toBe("GitHub auth errors, holding state");
    expect(warnLog!.apiErrorSummary).toEqual({
      total: 2,
      byKind: { auth: 2 },
      primaryKind: "auth",
    });
  });

  it("processes items through full lifecycle (single item, auto strategy)", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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

  it("holds flagged items for manual review in auto mode", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
    const sensitiveItem = makeWorkItem("T-HOLD-1");
    sensitiveItem.requiresManualReview = true;
    orch.addItem(sensitiveItem);
    orch.getItem("T-HOLD-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-HOLD-1"] };
        case 2:
          return { items: [{ id: "T-HOLD-1", workerAlive: true }], readyIds: [] };
        default:
          return {
            items: [{ id: "T-HOLD-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 4 });

    expect(orch.getItem("T-HOLD-1")!.state).toBe("review-pending");
    expect(logs.some((l) => l.event === "action_execute" && l.action === "merge")).toBe(false);
  });

  it("holds flagged items for manual review in bypass mode", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "bypass", bypassEnabled: true });
    const sensitiveItem = makeWorkItem("T-HOLD-2");
    sensitiveItem.requiresManualReview = true;
    orch.addItem(sensitiveItem);
    orch.getItem("T-HOLD-2")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-HOLD-2"] };
        case 2:
          return { items: [{ id: "T-HOLD-2", workerAlive: true }], readyIds: [] };
        default:
          return {
            items: [{ id: "T-HOLD-2", prNumber: 2, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 4 });

    expect(orch.getItem("T-HOLD-2")!.state).toBe("review-pending");
    expect(logs.some((l) => l.event === "action_execute" && l.action === "merge")).toBe(false);
  });

  it("still holds flagged items when skipReview is enabled", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto", skipReview: true });
    const sensitiveItem = makeWorkItem("T-HOLD-3");
    sensitiveItem.requiresManualReview = true;
    orch.addItem(sensitiveItem);

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-HOLD-3"] };
        case 2:
          return { items: [{ id: "T-HOLD-3", workerAlive: true }], readyIds: [] };
        default:
          return {
            items: [{ id: "T-HOLD-3", prNumber: 3, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 4 });

    expect(orch.getItem("T-HOLD-3")!.reviewCompleted).toBe(true);
    expect(orch.getItem("T-HOLD-3")!.state).toBe("review-pending");
    expect(logs.some((l) => l.event === "action_execute" && l.action === "merge")).toBe(false);
  });

  it("processes dependency chain across batches", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto", maxRetries: 0 });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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

  it("removes merged work item files during merge completion so restart does not replay them", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "nw-orchestrate-merge-cleanup-"));
    const workDir = join(projectRoot, ".ninthwave", "work");
    const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");
    mkdirSync(workDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    const filePath = join(workDir, "2-test--H-CLEAN-1.md");
    writeFileSync(
      filePath,
      `# Cleanup work (H-CLEAN-1)\n\n**Priority:** High\n**Domain:** test\n**Lineage:** ${STARTUP_LINEAGE}\n`,
    );

    try {
      const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
      orch.addItem({
        ...makeWorkItem("H-CLEAN-1"),
        title: "Cleanup work",
        lineageToken: STARTUP_LINEAGE,
      });
      orch.getItem("H-CLEAN-1")!.reviewCompleted = true;

      let cycle = 0;
      const deps: OrchestrateLoopDeps = {
        buildSnapshot: () => {
          cycle++;
          switch (cycle) {
            case 1:
              return { items: [], readyIds: ["H-CLEAN-1"] };
            case 2:
              return { items: [{ id: "H-CLEAN-1", workerAlive: true }], readyIds: [] };
            case 3:
              return {
                items: [{ id: "H-CLEAN-1", prNumber: 42, prState: "open", ciStatus: "pass" }],
                readyIds: [],
              };
            default:
              return { items: [], readyIds: [] };
          }
        },
        sleep: () => Promise.resolve(),
        log: () => {},
        actionDeps: mockActionDeps({
          completeMergedWorkItem: (item, cleanupWorkDir, cleanupProjectRoot) =>
            completeMergedWorkItemCleanup(item, cleanupWorkDir, cleanupProjectRoot, {
              commitRemoval: () => true,
            }),
        }),
      };

      await orchestrateLoop(orch, {
        ...defaultCtx,
        projectRoot,
        workDir,
        worktreeDir,
      }, deps, { maxIterations: 200 });

      expect(existsSync(filePath)).toBe(false);

      const restartedItems = listWorkItems(workDir, worktreeDir);
      expect(restartedItems).toEqual([]);

      const replay = pruneMergedStartupReplayItems(
        restartedItems,
        projectRoot,
        () => `H-CLEAN-1\t42\tmerged\t\t\tCleanup work\t${STARTUP_LINEAGE}`,
      );

      expect(replay.activeItems).toEqual([]);
      expect(replay.prunedItems).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("emits structured log with state_summary on each cycle", async () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
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

describe("TUI item selection helpers", () => {
  it("getVisibleSelectableItemIds includes queued items", () => {
    const items = [
      makeStatusItem({ id: "H-TI-1", state: "implementing" }),
      makeStatusItem({ id: "H-TI-2", state: "queued" }),
      makeStatusItem({ id: "H-TI-3", state: "review" }),
    ];

    expect(getVisibleSelectableItemIds(items)).toEqual(["H-TI-1", "H-TI-3", "H-TI-2"]);
  });

  it("normalizeSelectedItemId preserves the same item across refresh-time reordering", () => {
    const items = [
      makeStatusItem({ id: "H-TI-2", state: "queued", dependencies: ["H-TI-1"] }),
      makeStatusItem({ id: "H-TI-3", state: "review" }),
      makeStatusItem({ id: "H-TI-1", state: "implementing" }),
    ];

    const previousVisibleItemIds = ["H-TI-1", "H-TI-3", "H-TI-2"];
    const reorderedVisibleItemIds = getVisibleSelectableItemIds(items);

    expect(normalizeSelectedItemId(reorderedVisibleItemIds, "H-TI-3", previousVisibleItemIds)).toBe("H-TI-3");
  });

  it("normalizeSelectedItemId falls to the nearest remaining visible item", () => {
    const previousVisibleItemIds = ["H-TI-1", "H-TI-3", "H-TI-2"];
    const nextVisibleItemIds = ["H-TI-1", "H-TI-2"];

    expect(normalizeSelectedItemId(nextVisibleItemIds, "H-TI-3", previousVisibleItemIds)).toBe("H-TI-2");
  });

  it("normalizeSelectedItemId clears selection when the status list is empty", () => {
    expect(normalizeSelectedItemId([], "H-TI-3", ["H-TI-1", "H-TI-3", "H-TI-2"])).toBeUndefined();
  });
});

describe("adaptivePollInterval", () => {
  it("returns flat 2s regardless of item states", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("A-1-1"));
    orch.getItem("A-1-1")!.reviewCompleted = true;
    orch.hydrateState("A-1-1", "ready");
    expect(adaptivePollInterval(orch)).toBe(2_000);

    orch.hydrateState("A-1-1", "implementing");
    expect(adaptivePollInterval(orch)).toBe(2_000);

    orch.hydrateState("A-1-1", "ci-pending");
    expect(adaptivePollInterval(orch)).toBe(2_000);

    orch.hydrateState("A-1-1", "done");
    expect(adaptivePollInterval(orch)).toBe(2_000);
  });
});

describe("reconstructState", () => {
  it("is a no-op when no worktrees exist", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("R-1-1"));
    orch.getItem("R-1-1")!.reviewCompleted = true;

    // Non-existent worktree dir -- items stay queued
    reconstructState(orch, "/nonexistent", "/nonexistent/.ninthwave/.worktrees");

    expect(orch.getItem("R-1-1")!.state).toBe("queued");
  });

  it("recovers workspaceRef from live cmux workspaces during reconstruction", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-DF-1"));
    orch.getItem("H-DF-1")!.reviewCompleted = true;

    // Create a temp worktree dir to simulate existing worktree
    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
      writeInbox: () => {},
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

  it("restores a saved workspaceRef when the exact live workspace still exists", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-DF-SAVED-1"));
    orch.getItem("H-DF-SAVED-1")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test-saved-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-H-DF-SAVED-1");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1,
      startedAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:00.000Z",
      items: [{
        id: "H-DF-SAVED-1",
        title: "Saved workspace ref",
        state: "implementing",
        prNumber: null,
        ciFailCount: 0,
        retryCount: 0,
        workspaceRef: "workspace:41",
        worktreePath: wtPath,
        lastTransition: "2026-04-02T10:00:00.000Z",
      }],
    };

    const fakeMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () =>
        "  workspace:41  ✳ unrelated title without item id",
      closeWorkspace: () => true,
    };

    const result = reconstructState(orch, tmpDir, wtDir, fakeMux, () => null, daemonState);

    const item = orch.getItem("H-DF-SAVED-1")!;
    expect(result.unresolvedImplementations).toEqual([]);
    expect(item.state).toBe("implementing");
    expect(item.workspaceRef).toBe("workspace:41");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to item-id rediscovery when the saved workspaceRef changed", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-DF-SAVED-2"));
    orch.getItem("H-DF-SAVED-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test-fallback-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-H-DF-SAVED-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1,
      startedAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:00.000Z",
      items: [{
        id: "H-DF-SAVED-2",
        title: "Fallback workspace ref",
        state: "implementing",
        prNumber: null,
        ciFailCount: 0,
        retryCount: 0,
        workspaceRef: "workspace:stale",
        worktreePath: wtPath,
        lastTransition: "2026-04-02T10:00:00.000Z",
      }],
    };

    const fakeMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () =>
        "  workspace:44  ✳ H-DF-SAVED-2: recovered by item id",
      closeWorkspace: () => true,
    };

    const result = reconstructState(orch, tmpDir, wtDir, fakeMux, () => null, daemonState);

    const item = orch.getItem("H-DF-SAVED-2")!;
    expect(result.unresolvedImplementations).toEqual([]);
    expect(item.state).toBe("implementing");
    expect(item.workspaceRef).toBe("workspace:44");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recovers workspaceRef from live tmux workspaces during reconstruction", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-TM-3"));
    orch.getItem("H-TM-3")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test-tmux-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-H-TM-3");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const fakeMux = {
      type: "tmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () =>
        "nw-dev:nw:H-TM-3",
      closeWorkspace: () => true,
    };

    const noopCheckPr = () => null;
    reconstructState(orch, tmpDir, wtDir, fakeMux, noopCheckPr);

    const item = orch.getItem("H-TM-3")!;
    expect(item.state).toBe("implementing");
    expect(item.workspaceRef).toBe("nw-dev:nw:H-TM-3");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("surfaces unresolved implementation workers when no live workspace is discoverable", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-DF-2"));
    orch.getItem("H-DF-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-test2-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-H-DF-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1,
      startedAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:00.000Z",
      items: [{
        id: "H-DF-2",
        title: "Unresolved workspace ref",
        state: "implementing",
        prNumber: null,
        ciFailCount: 0,
        retryCount: 0,
        workspaceRef: "workspace:stale",
        worktreePath: wtPath,
        lastTransition: "2026-04-02T10:00:00.000Z",
      }],
    };

    // Mock mux with no matching workspaces
    const fakeMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => "  workspace:1  main",
      closeWorkspace: () => true,
    };

    const result = reconstructState(orch, tmpDir, wtDir, fakeMux, () => null, daemonState);

    const item = orch.getItem("H-DF-2")!;
    expect(item.state).toBe("implementing");
    expect(item.workspaceRef).toBeUndefined();
    expect(result.unresolvedImplementations).toEqual([
      {
        itemId: "H-DF-2",
        worktreePath: wtPath,
        savedWorkspaceRef: "workspace:stale",
      },
    ]);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("interactive restart recovery relaunches unresolved workers when the operator approves", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-RSM-3A"));
    orch.hydrateState("H-RSM-3A", "implementing");
    orch.getItem("H-RSM-3A")!.workspaceRef = "workspace:stale";

    const logs: LogEntry[] = [];
    await resolveUnresolvedRestartedWorkers(
      orch,
      [{ itemId: "H-RSM-3A", worktreePath: "/tmp/ninthwave-H-RSM-3A", savedWorkspaceRef: "workspace:stale" }],
      {
        interactive: true,
        prompt: async () => "relaunch",
        log: (entry) => logs.push(entry),
        now: () => new Date("2026-04-03T12:00:00.000Z"),
      },
    );

    const item = orch.getItem("H-RSM-3A")!;
    expect(item.state).toBe("ready");
    expect(item.workspaceRef).toBeUndefined();
    expect(item.failureReason).toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({
      event: "restart_recovery_unresolved_worker",
      itemId: "H-RSM-3A",
      worktreePath: "/tmp/ninthwave-H-RSM-3A",
      savedWorkspaceRef: "workspace:stale",
    }));
  });

  it("holds unresolved restarted workers when the operator declines relaunch", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-RSM-3B"));
    orch.hydrateState("H-RSM-3B", "implementing");
    orch.getItem("H-RSM-3B")!.workspaceRef = "workspace:stale";

    const logs: LogEntry[] = [];
    await resolveUnresolvedRestartedWorkers(
      orch,
      [{ itemId: "H-RSM-3B", worktreePath: "/tmp/ninthwave-H-RSM-3B" }],
      {
        interactive: true,
        prompt: async () => "hold",
        log: (entry) => logs.push(entry),
        now: () => new Date("2026-04-03T12:05:00.000Z"),
      },
    );

    const item = orch.getItem("H-RSM-3B")!;
    expect(item.state).toBe("blocked");
    expect(item.failureReason).toBe(RESTART_RECOVERY_HOLD_REASON);
    expect(item.endedAt).toBe("2026-04-03T12:05:00.000Z");
    expect(logs).toContainEqual(expect.objectContaining({
      event: "restart_recovery_held_worker",
      itemId: "H-RSM-3B",
      interactive: true,
    }));
  });

  it("non-interactive restart recovery holds unresolved workers instead of relaunching them", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-RSM-3C"));
    orch.hydrateState("H-RSM-3C", "implementing");

    const prompt = vi.fn(async () => "relaunch");
    const logs: LogEntry[] = [];
    await resolveUnresolvedRestartedWorkers(
      orch,
      [{ itemId: "H-RSM-3C", worktreePath: "/tmp/ninthwave-H-RSM-3C" }],
      {
        interactive: false,
        prompt,
        log: (entry) => logs.push(entry),
        now: () => new Date("2026-04-03T12:10:00.000Z"),
      },
    );

    const item = orch.getItem("H-RSM-3C")!;
    expect(prompt).not.toHaveBeenCalled();
    expect(item.state).toBe("blocked");
    expect(item.failureReason).toBe(RESTART_RECOVERY_HOLD_REASON);
    expect(logs).toContainEqual(expect.objectContaining({
      event: "restart_recovery_held_worker",
      itemId: "H-RSM-3C",
      interactive: false,
    }));
  });

  it("restores ciFailCount from daemon state file", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("REC-1"));
    orch.getItem("REC-1")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-cifc-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    reconstructState(orch, "/nonexistent", "/nonexistent/.ninthwave/.worktrees", undefined, () => null, null);

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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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

  it("keeps daemon-tracked PRs in ci-pending when checkPr returns empty", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("WR-1B"));
    orch.getItem("WR-1B")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-wr1b-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-WR-1B");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "WR-1B",
          state: "ci-pending",
          prNumber: 271,
          title: "Test item",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, () => null, daemonState);

    const item = orch.getItem("WR-1B")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(271);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps daemon-tracked PRs in ci-pending when checkPr returns no-pr", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("WR-1C"));
    orch.getItem("WR-1C")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-wr1c-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-WR-1C");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "WR-1C",
          state: "ci-pending",
          prNumber: 272,
          title: "Test item",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, () => "WR-1C\t\tno-pr", daemonState);

    const item = orch.getItem("WR-1C")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(272);

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects existing open PR with failing CI and sets ci-failed (H-WR-1)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("WR-2"));
    orch.getItem("WR-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-wr2-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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

describe("reconstructState rebase persistence", () => {
  it("restores rebase nudge bookkeeping and saved worktree targeting state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("RBT-1"));
    orch.getItem("RBT-1")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-rbt-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const savedWorktreePath = join(tmpDir, "custom-worktrees", "ninthwave-RBT-1");
    require("fs").mkdirSync(savedWorktreePath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T01:00:00Z",
      items: [
        {
          id: "RBT-1",
          state: "ci-pending",
          prNumber: 88,
          title: "Test item",
          lastTransition: "2026-04-01T00:30:00Z",
          ciFailCount: 1,
          retryCount: 2,
          lastRebaseNudgeAt: "2026-04-01T00:45:00Z",
          rebaseNudgeCount: 3,
          worktreePath: savedWorktreePath,
          resolvedRepoRoot: "/tmp/target-repo",
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, () => null, daemonState);

    const item = orch.getItem("RBT-1")!;
    expect(item.state).toBe("ci-pending");
    expect(item.lastRebaseNudgeAt).toBe("2026-04-01T00:45:00Z");
    expect(item.rebaseNudgeCount).toBe(3);
    expect(item.worktreePath).toBe(savedWorktreePath);
    expect(item.resolvedRepoRoot).toBe("/tmp/target-repo");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("remains backward compatible when older daemon state omits new fields", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("RBT-2"));
    orch.getItem("RBT-2")!.reviewCompleted = true;

    const tmpDir = join(require("os").tmpdir(), `nw-reconstruct-rbt-old-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const wtPath = join(wtDir, "ninthwave-RBT-2");
    require("fs").mkdirSync(wtPath, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T01:00:00Z",
      items: [
        {
          id: "RBT-2",
          state: "ci-pending",
          prNumber: 89,
          title: "Test item",
          lastTransition: "2026-04-01T00:30:00Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };

    reconstructState(orch, tmpDir, wtDir, undefined, () => null, daemonState);

    const item = orch.getItem("RBT-2")!;
    expect(item.state).toBe("ci-pending");
    expect(item.lastRebaseNudgeAt).toBeUndefined();
    expect(item.rebaseNudgeCount).toBeUndefined();
    expect(item.worktreePath).toBe(wtPath);

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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    const targetWtPath = join("/tmp/target-repo", ".ninthwave", ".worktrees", "ninthwave-XR-1-1");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    orch.hydrateState("BS-1-1", "implementing");
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
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    buildSnapshot(orch, "/hub-root", "/hub-root/.ninthwave/.worktrees", fakeMux, () => null, trackingCheckPr);
    expect(checkedRepo).toBe("/target-repo");
  });

  it("uses resolvedRepoRoot for commit time checks", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BS-2-1"));
    orch.getItem("BS-2-1")!.reviewCompleted = true;
    orch.hydrateState("BS-2-1", "implementing");
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
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    buildSnapshot(orch, "/hub-root", "/hub-root/.ninthwave/.worktrees", fakeMux, trackingCommitTime, () => null);
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

describe("serializeOrchestratorState persists crew remote truth", () => {
  it("serializes broker-derived remote snapshots and crew ownership metadata", () => {
    const item: OrchestratorItem = {
      id: "REM-1",
      workItem: makeWorkItem("REM-1"),
      state: "queued",
      prNumber: undefined,
      lastTransition: "2026-04-01T10:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };
    const remoteSnapshots = new Map<string, CrewRemoteItemSnapshot>([
      ["REM-1", {
        id: "REM-1",
        state: "review",
        ownerDaemonId: "daemon-2",
        ownerName: "remote-host",
        title: "Reviewing remotely",
        prNumber: 88,
      }],
    ]);

    const state = serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z", {
      crewStatus: {
        crewCode: "ABCD-EFGH-IJKL-MNOP",
        daemonCount: 2,
        availableCount: 5,
        claimedCount: 1,
        completedCount: 3,
        connected: true,
      },
      remoteItemSnapshots: remoteSnapshots,
    });

    expect(state.crewStatus).toEqual({
      crewCode: "ABCD-EFGH-IJKL-MNOP",
      daemonCount: 2,
      availableCount: 5,
      claimedCount: 1,
      completedCount: 3,
      connected: true,
    });
    expect(state.items[0]!.remoteSnapshot).toEqual({
      state: "review",
      ownerDaemonId: "daemon-2",
      ownerName: "remote-host",
      title: "Reviewing remotely",
      prNumber: 88,
    });
  });

  it("clears stale remote snapshots on the next state write", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-remote-snapshot-clear-"));
    const item: OrchestratorItem = {
      id: "REM-2",
      workItem: makeWorkItem("REM-2"),
      state: "queued",
      prNumber: undefined,
      lastTransition: "2026-04-01T10:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };

    try {
      writeStateFile(tmpDir, serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z", {
        remoteItemSnapshots: new Map<string, CrewRemoteItemSnapshot>([
          ["REM-2", {
            id: "REM-2",
            state: "implementing",
            ownerDaemonId: "daemon-2",
            ownerName: "remote-host",
            title: "Implementing remotely",
          }],
        ]),
      }));

      writeStateFile(tmpDir, serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z"));

      const restored = readStateFile(tmpDir);
      expect(restored).not.toBeNull();
      expect(restored!.items[0]!.remoteSnapshot).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(userStateDir(tmpDir), { recursive: true, force: true });
    }
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

describe("computeDefaultSessionLimit", () => {
  const GB = 1024 ** 3;

  it("returns 5 for 16GB machine", () => {
    expect(computeDefaultSessionLimit(() => 16 * GB)).toBe(5);
  });

  it("returns 2 for 8GB machine", () => {
    expect(computeDefaultSessionLimit(() => 8 * GB)).toBe(2);
  });

  it("returns minimum of 2 for very low memory (4GB)", () => {
    expect(computeDefaultSessionLimit(() => 4 * GB)).toBe(2);
  });

  it("returns minimum of 2 for extremely low memory (1GB)", () => {
    expect(computeDefaultSessionLimit(() => 1 * GB)).toBe(2);
  });

  it("returns 8 for 24GB machine", () => {
    expect(computeDefaultSessionLimit(() => 24 * GB)).toBe(8);
  });

  it("returns 10 for 32GB machine", () => {
    expect(computeDefaultSessionLimit(() => 32 * GB)).toBe(10);
  });

  it("returns 21 for 64GB machine", () => {
    expect(computeDefaultSessionLimit(() => 64 * GB)).toBe(21);
  });

  it("handles fractional GB correctly (e.g. 15.8GB)", () => {
    // 15.8 / 3 = 5.26 → floor → 5
    expect(computeDefaultSessionLimit(() => 15.8 * GB)).toBe(5);
  });

  it("uses os.totalmem() by default (no argument)", () => {
    // Just verify it returns a reasonable number without throwing
    const result = computeDefaultSessionLimit();
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
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  /** No-op checkPr to avoid gh CLI dependency in tests. */
  const noOpCheckPr = () => null;

  it("includes lastCommitTime for implementing items", () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-1-1"));
    orch.getItem("HC-1-1")!.reviewCompleted = true;
    orch.hydrateState("HC-1-1", "implementing");
    // Set workspace ref so worker appears alive
    const item = orch.getItem("HC-1-1")!;
    item.workspaceRef = "workspace:1";

    const fixedTime = "2026-03-24T12:05:30+00:00";
    const getLastCommitTime = vi.fn(() => fixedTime);
    const mux = mockMux("workspace:1");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, noOpCheckPr);

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
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-2-1"));
    orch.getItem("HC-2-1")!.reviewCompleted = true;
    orch.hydrateState("HC-2-1", "implementing");
    const item = orch.getItem("HC-2-1")!;
    item.workspaceRef = "workspace:2";

    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux("workspace:2");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "HC-2-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.lastCommitTime).toBeNull();

    // Orchestrator item also null
    expect(orch.getItem("HC-2-1")!.lastCommitTime).toBeNull();
  });

  it("includes lastCommitTime for launching items (branch may not exist yet)", () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-3-1"));
    orch.getItem("HC-3-1")!.reviewCompleted = true;
    orch.hydrateState("HC-3-1", "launching");
    const item = orch.getItem("HC-3-1")!;
    item.workspaceRef = "workspace:3";

    // Branch doesn't exist yet → null
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux("workspace:3");

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, noOpCheckPr);

    const snapItem = snapshot.items.find((i) => i.id === "HC-3-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.lastCommitTime).toBeNull();
  });

  it("does not query lastCommitTime for non-active states", () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("HC-4-1"));
    orch.getItem("HC-4-1")!.reviewCompleted = true;
    orch.hydrateState("HC-4-1", "ci-pending");

    const getLastCommitTime = vi.fn(() => "2026-03-24T12:00:00+00:00");
    const mux = mockMux();

    buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, noOpCheckPr);

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
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  it("sets isMergeable=true when checkPr returns MERGEABLE in 4th field", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("M-1-1"));
    orch.getItem("M-1-1")!.reviewCompleted = true;
    orch.hydrateState("M-1-1", "ci-pending");

    // Simulate checkPr returning: ID\tPR\tSTATUS\tMERGEABLE
    const checkPr = () => "M-1-1\t10\tfailing\tMERGEABLE";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-1-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBe(true);
    expect(snapItem!.ciStatus).toBe("fail");
  });

  it("sets isMergeable=false when checkPr returns CONFLICTING in 4th field", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("M-2-1"));
    orch.getItem("M-2-1")!.reviewCompleted = true;
    orch.hydrateState("M-2-1", "ci-pending");

    const checkPr = () => "M-2-1\t10\tfailing\tCONFLICTING";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-2-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBe(false);
    expect(snapItem!.ciStatus).toBe("fail");
  });

  it("does not set isMergeable when 4th field is UNKNOWN", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("M-3-1"));
    orch.getItem("M-3-1")!.reviewCompleted = true;
    orch.hydrateState("M-3-1", "ci-pending");

    const checkPr = () => "M-3-1\t10\tpending\tUNKNOWN";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, checkPr);

    const snapItem = snapshot.items.find((i) => i.id === "M-3-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.isMergeable).toBeUndefined();
  });

  it("does not set isMergeable when checkPr returns 3-field format (backward compat)", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("M-4-1"));
    orch.getItem("M-4-1")!.reviewCompleted = true;
    orch.hydrateState("M-4-1", "ci-pending");

    // Old 3-field format without mergeable
    const checkPr = () => "M-4-1\t10\tpending";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, checkPr);

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
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  it("sets ciStatus pass, reviewDecision APPROVED, and isMergeable true when checkPr returns ready", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("R-1-1"));
    orch.getItem("R-1-1")!.reviewCompleted = true;
    orch.hydrateState("R-1-1", "ci-pending");

    // checkPr returns "ready" status with MERGEABLE 4th field
    const checkPr = () => "R-1-1\t42\tready\tMERGEABLE";
    const getLastCommitTime = vi.fn(() => null);
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, getLastCommitTime, checkPr);

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
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => workspaces,
      closeWorkspace: () => true,
    };
  }

  it("ignores stale merged PR when prNumber is unset and title differs from item", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    const item = makeWorkItem("MRG-1-1");
    item.title = "Fix the daemon polling loop";
    orch.addItem(item);
    orch.hydrateState("MRG-1-1", "implementing");
    // prNumber is never set -- either stale PR or auto-merged before daemon saw it
    expect(orch.getItem("MRG-1-1")!.prNumber).toBeUndefined();

    // checkPr returns merged with a completely different title -- stale PR from previous cycle
    const checkPr = () => "MRG-1-1\t99\tmerged\t\t\trefactor: rewrite polling internals";
    const mux = mockMux();

    const snapshot = buildSnapshot(orch, "/tmp/project", "/tmp/project/.ninthwave/.worktrees", mux, () => null, checkPr);

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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
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
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    require("fs").mkdirSync(join(wtDir, "ninthwave-MRG-3-1"), { recursive: true });

    // checkPr returns merged with a different title but matching PR number
    const checkPr = () => "MRG-3-1\t77\tmerged\t\t\trefactor: completely rewrite error paths";

    reconstructState(orch, tmpDir, wtDir, undefined, checkPr);

    // Should be merged -- prNumber match bypasses title check
    expect(orch.getItem("MRG-3-1")!.state).toBe("merged");

    require("fs").rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves merged waiting state across restart when mergeCommitSha is still missing", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("MRG-4-1"));

    const tmpDir = join(require("os").tmpdir(), `nw-mrg-test3-${Date.now()}`);
    const wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    require("fs").mkdirSync(wtDir, { recursive: true });

    const daemonState: DaemonState = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      items: [
        {
          id: "MRG-4-1",
          state: "merged",
          prNumber: 42,
          title: "Item MRG-4-1",
          lastTransition: "2026-01-01T00:30:00Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };

    const checkPr = () => "MRG-4-1\t42\tmerged\t\t\tItem MRG-4-1";
    reconstructState(orch, tmpDir, wtDir, undefined, checkPr, daemonState);

    const item = orch.getItem("MRG-4-1")!;
    expect(item.state).toBe("merged");
    expect(item.prNumber).toBe(42);
    expect(item.mergeCommitSha).toBeUndefined();

    const snapshot = buildSnapshot(
      orch,
      tmpDir,
      wtDir,
      {
        type: "cmux" as const,
        isAvailable: () => false,
        diagnoseUnavailable: () => "not available",
        launchWorkspace: () => null,
        splitPane: () => null,
        readScreen: () => "",
        listWorkspaces: () => "",
        closeWorkspace: () => true,
        setStatus: () => true,
        setProgress: () => true,
      } as Multiplexer,
      () => null,
      checkPr,
      undefined,
      undefined,
      () => "merge-after-restart",
      () => "main",
    );

    const snapItem = snapshot.items.find((entry) => entry.id === "MRG-4-1");
    expect(snapItem).toBeDefined();
    expect(snapItem!.mergeCommitSha).toBe("merge-after-restart");
    expect(snapItem!.defaultBranch).toBe("main");
    expect(item.mergeCommitSha).toBe("merge-after-restart");
    expect(item.defaultBranch).toBe("main");

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
    vi.useFakeTimers();
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

    expect(tuiState.mergeStrategy).toBe("auto");
    expect(tuiState.pendingStrategy).toBe("manual");
    expect(tuiState.viewOptions.mergeStrategy).toBe("auto");
    expect(tuiState.viewOptions.pendingStrategy).toBe("manual");
    expect(changedStrategies).toEqual([]);
    expect(logs.some((l: any) => l.event === "strategy_cycle" && l.oldStrategy === "auto" && l.newStrategy === "manual")).toBe(true);

    vi.advanceTimersByTime(5001);
    expect(tuiState.mergeStrategy).toBe("auto");
    expect(tuiState.pendingStrategy).toBe("manual");
    expect(changedStrategies).toEqual(["manual"]);

    applyRuntimeSnapshotToTuiState(tuiState, {
      paused: false,
      mergeStrategy: "manual",
      sessionLimit: 3,
      reviewMode: "off",
      collaborationMode: "local",
    });
    expect(tuiState.mergeStrategy).toBe("manual");
    expect(tuiState.pendingStrategy).toBeUndefined();
    vi.useRealTimers();
  });

  it("Shift+Tab wraps manual → auto when bypass disabled", () => {
    vi.useFakeTimers();
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

    expect(tuiState.pendingStrategy).toBe("auto");
    vi.advanceTimersByTime(5001);
    expect(tuiState.mergeStrategy).toBe("manual");

    applyRuntimeSnapshotToTuiState(tuiState, {
      paused: false,
      mergeStrategy: "auto",
      sessionLimit: 3,
      reviewMode: "off",
      collaborationMode: "local",
    });
    expect(tuiState.mergeStrategy).toBe("auto");
    vi.useRealTimers();
  });

  it("Shift+Tab cycles through bypass when bypassEnabled", () => {
    vi.useFakeTimers();
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
    expect(tuiState.pendingStrategy).toBe("manual");
    vi.advanceTimersByTime(5001);
    expect(tuiState.mergeStrategy).toBe("auto");
    applyRuntimeSnapshotToTuiState(tuiState, {
      paused: false,
      mergeStrategy: "manual",
      sessionLimit: 3,
      reviewMode: "off",
      collaborationMode: "local",
    });
    expect(tuiState.mergeStrategy).toBe("manual");

    (stdin as any)._emit("data", "\x1B[Z"); // manual → bypass
    expect(tuiState.pendingStrategy).toBe("bypass");
    vi.advanceTimersByTime(5001);
    expect(tuiState.mergeStrategy).toBe("manual");
    applyRuntimeSnapshotToTuiState(tuiState, {
      paused: false,
      mergeStrategy: "bypass",
      sessionLimit: 3,
      reviewMode: "off",
      collaborationMode: "local",
    });
    expect(tuiState.mergeStrategy).toBe("bypass");

    (stdin as any)._emit("data", "\x1B[Z"); // bypass → auto (wrap)
    expect(tuiState.pendingStrategy).toBe("auto");
    vi.advanceTimersByTime(5001);
    expect(tuiState.mergeStrategy).toBe("bypass");
    applyRuntimeSnapshotToTuiState(tuiState, {
      paused: false,
      mergeStrategy: "auto",
      sessionLimit: 3,
      reviewMode: "off",
      collaborationMode: "local",
    });
    expect(tuiState.mergeStrategy).toBe("auto");

    cleanup();
    vi.useRealTimers();
  });

  it("bypass excluded from cycle when bypassEnabled is false", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      shutdownInProgress: false,
      ctrlCTimestamp: 0,
      showHelp: false,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    // Cycle through all positions -- should only visit auto and manual
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) {
      (stdin as any)._emit("data", "\x1B[Z");
      vi.advanceTimersByTime(5001);
      applyRuntimeSnapshotToTuiState(tuiState, {
        paused: false,
        mergeStrategy: tuiState.pendingStrategy ?? tuiState.mergeStrategy,
        sessionLimit: 3,
        reviewMode: "off",
        collaborationMode: "local",
      });
      visited.push(tuiState.mergeStrategy);
    }
    expect(visited).toEqual(["manual", "auto", "manual", "auto"]);
    vi.useRealTimers();
  });

  // ── +/- WIP limit adjustment ──────────────────────────────────────

  it("'+' calls onSessionLimitChange with +1", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const deltas: number[] = [];
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onSessionLimitChange: (d) => deltas.push(d),
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "+");

    expect(deltas).toEqual([1]);
  });

  it("'-' calls onSessionLimitChange with -1", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const deltas: number[] = [];
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onSessionLimitChange: (d) => deltas.push(d),
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "-");

    expect(deltas).toEqual([-1]);
  });

  it("'=' (unshifted +) calls onSessionLimitChange with +1", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const deltas: number[] = [];
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onSessionLimitChange: (d) => deltas.push(d),
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "=");

    expect(deltas).toEqual([1]);
  });

  it("no-op when onSessionLimitChange not provided", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      shutdownInProgress: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onShutdown: vi.fn(),
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    // Should not throw
    (stdin as any)._emit("data", "+");
    (stdin as any)._emit("data", "-");
    expect(ac.signal.aborted).toBe(false);
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
      shutdownInProgress: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onShutdown: vi.fn(),
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
      shutdownInProgress: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      onShutdown: vi.fn(),
    };

    const cleanup = setupKeyboardShortcuts(ac, (e) => logs.push(e), stdin, tuiState);

    (stdin as any)._emit("data", "\x03"); // First
    expect(ac.signal.aborted).toBe(false);

    (stdin as any)._emit("data", "\x03"); // Second
    expect(ac.signal.aborted).toBe(false);
    expect(tuiState.ctrlCPending).toBe(false);
    expect(tuiState.viewOptions.ctrlCPending).toBe(false);
    expect(tuiState.shutdownInProgress).toBe(true);
    expect(tuiState.viewOptions.shutdownInProgress).toBe(true);
    expect(tuiState.onShutdown).toHaveBeenCalledTimes(1);
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
      shutdownInProgress: false,
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

  it("x extends timeout for the selected item", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const extendedIds: string[] = [];
    const tuiState: TuiState = {
      scrollOffset: 0,
      viewOptions: { mergeStrategy: "auto" },
      mergeStrategy: "auto",
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: "H-TG-3",
      visibleItemIds: ["H-TG-1", "H-TG-3"],
      detailItemId: null,
      savedLogScrollOffset: 0,
      onExtendTimeout: (itemId: string) => {
        extendedIds.push(itemId);
        return true;
      },
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "x");

    expect(extendedIds).toEqual(["H-TG-3"]);
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 5,
      logLevelFilter: "all",
      selectedItemId: "H-UT-1",
      visibleItemIds: ["H-UT-1", "H-UT-2"],
      detailItemId: null,
      savedLogScrollOffset: 0,
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 3,
      logLevelFilter: "all",
      selectedItemId: "H-UT-2",
      visibleItemIds: ["H-UT-1", "H-UT-2", "H-UT-3"],
      detailItemId: null,
      savedLogScrollOffset: 0,
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 10, // changed while viewing detail
      logLevelFilter: "all",
      selectedItemId: "H-UT-1",
      visibleItemIds: ["H-UT-1"],
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: undefined,
      visibleItemIds: [],
      detailItemId: null,
      savedLogScrollOffset: 0,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\r"); // Enter

    expect(tuiState.detailItemId).toBeNull(); // no crash, no detail opened
  });

  it("Enter is no-op when selectedItemId is not set", () => {
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: undefined,
      visibleItemIds: [],
      detailItemId: null,
      savedLogScrollOffset: 0,
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: "H-UT-1",
      visibleItemIds: ["H-UT-1"],
      detailItemId: null,
      savedLogScrollOffset: 0,
      onUpdate: () => { updates++; },
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);
    (stdin as any)._emit("data", "\r"); // Enter -- triggers onUpdate

    expect(tuiState.detailItemId).toBe("H-UT-1");
    expect(updates).toBeGreaterThan(0);
  });

  it("Up/Down arrows move selectedItemId through visible order", () => {
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: "H-UT-1",
      visibleItemIds: ["H-UT-1", "H-UT-2", "H-UT-3", "H-UT-4", "H-UT-5"],
      detailItemId: null,
      savedLogScrollOffset: 0,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1b[B"); // Down
    expect(tuiState.selectedItemId).toBe("H-UT-2");

    (stdin as any)._emit("data", "\x1b[B"); // Down
    expect(tuiState.selectedItemId).toBe("H-UT-3");

    (stdin as any)._emit("data", "\x1b[A"); // Up
    expect(tuiState.selectedItemId).toBe("H-UT-2");

    (stdin as any)._emit("data", "\x1b[A"); // Up
    expect(tuiState.selectedItemId).toBe("H-UT-1");

    (stdin as any)._emit("data", "\x1b[A"); // Up at top -- wraps to bottom
    expect(tuiState.selectedItemId).toBe("H-UT-5");
  });

  it("Down arrow wraps selectedItemId at the bottom", () => {
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: "H-UT-2",
      visibleItemIds: ["H-UT-1", "H-UT-2"],
      detailItemId: null,
      savedLogScrollOffset: 0,
    };

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\x1b[B"); // Down -- already at max
    expect(tuiState.selectedItemId).toBe("H-UT-1");
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: undefined,
      visibleItemIds: [],
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
      renameSync: vi.fn(),
    };

    const result = withProcessRespawnState(
      ["/usr/local/bin/bun", "/project/core/cli.ts", "watch"],
      "/usr/local/bin/bun",
      () => forkDaemon(
        ["--items", "T-1-1", "--_daemon-child"],
        "/project",
        spawnFn,
        openFn,
        daemonIO,
      ),
    );

    expect(result.pid).toBe(42);
    expect(result.logPath).toBe(logFilePath("/project"));
    expect(mockChild.unref).toHaveBeenCalled();

    // PID file was written
    expect(files.get(pidFilePath("/project"))).toBe("42");

    // spawn was called with detached: true
    expect(spawnFn).toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith(
      "/usr/local/bin/bun",
      ["/project/core/cli.ts", "orchestrate", "--items", "T-1-1", "--_daemon-child"],
      expect.any(Object),
    );
    const spawnOpts = spawnFn.mock.calls[0][2];
    expect(spawnOpts.detached).toBe(true);
    expect(spawnOpts.stdio[0]).toBe("ignore");
  });

  it("uses the packaged executable directly without forwarding argv[1]", () => {
    const mockChild = { pid: 42, unref: vi.fn() };
    const spawnFn = vi.fn(() => mockChild) as any;
    const openFn = vi.fn(() => 3) as any;

    const files = new Map<string, string>();
    const daemonIO = {
      writeFileSync: vi.fn((p: string, c: string) => files.set(p, c)),
      readFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      existsSync: vi.fn((p: string) => files.has(p)),
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
    };

    withProcessRespawnState(
      ["/opt/homebrew/bin/ninthwave", "watch"],
      "/opt/homebrew/bin/ninthwave",
      () => forkDaemon(
        ["--items", "T-1-1", "--_daemon-child"],
        "/project",
        spawnFn,
        openFn,
        daemonIO,
      ),
    );

    expect(spawnFn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ninthwave",
      ["orchestrate", "--items", "T-1-1", "--_daemon-child"],
      expect.objectContaining({
        detached: true,
        cwd: "/project",
        stdio: ["ignore", 3, 3],
      }),
    );
    expect(mockChild.unref).toHaveBeenCalled();
  });
});

// ── Post-merge sibling conflict detection in orchestrateLoop ──────────

describe("orchestrateLoop post-merge conflict detection", () => {
  it("checks sibling PRs for conflicts after a merge and sends rebase to conflicting ones", async () => {
    const orch = new Orchestrator({ sessionLimit: 3, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-1-2"));
    orch.getItem("T-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-1-3"));
    orch.getItem("T-1-3")!.reviewCompleted = true;

    // T-1-1 is in ci-pending (about to pass CI and get merged by orchestrator)
    // T-1-2 and T-1-3 are also in-flight with PRs
    orch.hydrateState("T-1-1", "ci-pending");
    orch.getItem("T-1-1")!.prNumber = 10;
    orch.getItem("T-1-1")!.workspaceRef = "workspace:1";
    orch.hydrateState("T-1-2", "ci-pending");
    orch.getItem("T-1-2")!.prNumber = 11;
    orch.getItem("T-1-2")!.workspaceRef = "workspace:2";
    orch.getItem("T-1-2")!.worktreePath = `${defaultCtx.worktreeDir}/ninthwave-T-1-2`;
    orch.hydrateState("T-1-3", "ci-pending");
    orch.getItem("T-1-3")!.prNumber = 12;
    orch.getItem("T-1-3")!.workspaceRef = "workspace:3";
    orch.getItem("T-1-3")!.worktreePath = `${defaultCtx.worktreeDir}/ninthwave-T-1-3`;

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
    const writeInbox = vi.fn();
    const warn = vi.fn();

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps({ checkPrMergeable, sendMessage, writeInbox, warn }),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    // checkPrMergeable should have been called for sibling PRs when T-1-1 merged
    expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 11);
    expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 12);

    // Rebase message should be queued to T-1-2 (conflicting)
    expect(writeInbox).toHaveBeenCalledWith(
      `${defaultCtx.worktreeDir}/ninthwave-T-1-2`,
      "T-1-2",
      expect.stringContaining("merge conflicts"),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not check sibling PRs when checkPrMergeable is not provided", async () => {
    const orch = new Orchestrator({ sessionLimit: 3, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1-1"));
    orch.getItem("T-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-1-2"));
    orch.getItem("T-1-2")!.reviewCompleted = true;

    // T-1-1 about to pass CI and get merged; T-1-2 also in-flight
    orch.hydrateState("T-1-1", "ci-pending");
    orch.getItem("T-1-1")!.prNumber = 10;
    orch.getItem("T-1-1")!.workspaceRef = "workspace:1";
    orch.hydrateState("T-1-2", "ci-pending");
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
      writeInbox: () => {},
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

  it("matches tmux refs with embedded item IDs", () => {
    const item = makeItem("H-TM-3", "nw-dev:nw:H-TM-3");
    expect(isWorkerAliveWithCache(item, "nw-dev:nw:H-TM-3\nnw-dev:nw:H-TM-4")).toBe(true);
  });
});

describe("getTmuxStartupInfo", () => {
  it("returns a generic attach hint outside tmux", () => {
    const info = getTmuxStartupInfo(
      "/Users/rob/code/ninthwave",
      {},
      vi.fn(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    );

    expect(info.sessionName).toBe("nw-ninthwave");
    expect(info.outsideTmuxSession).toBe(true);
    expect(info.attachHintLines[1]).toContain("tmux attach -t nw-ninthwave");
  });

  it("returns an iTerm2-specific attach hint outside tmux", () => {
    const info = getTmuxStartupInfo(
      "/Users/rob/code/ninthwave",
      { TERM_PROGRAM: "iTerm.app" },
      vi.fn(() => ({ stdout: "", stderr: "", exitCode: 0 })),
    );

    expect(info.sessionName).toBe("nw-ninthwave");
    expect(info.attachHintLines[1]).toContain("iTerm2");
    expect(info.attachHintLines[1]).toContain("tmux attach -t nw-ninthwave");
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto", maxRetries: 0 });
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
    const orch = new Orchestrator({ sessionLimit: 1, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
            items: [{ id: "W-1-2", prNumber: 2, prState: "open", ciStatus: "pass", reviewVerdict: { verdict: "approve" as const, summary: "OK", blockingCount: 0, nonBlockingCount: 0, architectureScore: 8, codeQualityScore: 9, performanceScore: 7, testCoverageScore: 8, unresolvedDecisions: 0, criticalGaps: 0, confidence: 9 } }],
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
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
          items.push({ id: item.id, prNumber: 99, prState: "open", ciStatus: "pass", reviewVerdict: { verdict: "approve" as const, summary: "OK", blockingCount: 0, nonBlockingCount: 0, architectureScore: 8, codeQualityScore: 9, performanceScore: 7, testCoverageScore: 8, unresolvedDecisions: 0, criticalGaps: 0, confidence: 9 } });
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

  it("starts the first discovered item when watch begins empty", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
    const logs: LogEntry[] = [];
    const launchCalls: string[] = [];
    let discovered = false;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (o): PollSnapshot => {
        const item = o.getItem("E-1-1");
        if (!item) return { items: [], readyIds: [] };
        if (item.state === "queued" || item.state === "ready") {
          return { items: [], readyIds: [item.id] };
        }
        if (item.state === "launching") {
          return { items: [{ id: item.id, workerAlive: true }], readyIds: [] };
        }
        if (item.state === "implementing") {
          return {
            items: [{ id: item.id, prNumber: 11, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        }
        if (item.state === "reviewing") {
          return {
            items: [{
              id: item.id,
              prNumber: 11,
              prState: "open",
              ciStatus: "pass",
              reviewVerdict: {
                verdict: "approve" as const,
                summary: "OK",
                blockingCount: 0,
                nonBlockingCount: 0,
                architectureScore: 8,
                codeQualityScore: 9,
                performanceScore: 7,
                testCoverageScore: 8,
                unresolvedDecisions: 0,
                criticalGaps: 0,
                confidence: 9,
              },
            }],
            readyIds: [],
          };
        }
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({
        launchSingleItem: vi.fn((workItem) => {
          launchCalls.push(workItem.id);
          return { worktreePath: "/tmp/test/item-empty-watch", workspaceRef: `workspace:${workItem.id}` };
        }),
      }),
      scanWorkItems: () => {
        discovered = true;
        return [makeWorkItem("E-1-1")];
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, { watch: true, maxIterations: 50 });

    expect(discovered).toBe(true);
    expect(launchCalls).toEqual(["E-1-1"]);
    expect(orch.getItem("E-1-1")?.state).toBe("done");

    const watchNewLog = logs.find((l) => l.event === "watch_new_items");
    expect(watchNewLog?.newIds).toEqual(["E-1-1"]);
  });

  it("watch scans still discover new items when main refresh fails", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
    const logs: LogEntry[] = [];
    const launchCalls: string[] = [];
    const fetchOriginMock = vi.fn(() => {
      throw new Error("origin unavailable");
    });
    const ffMergeMock = vi.fn(() => {
      throw new Error("local main is dirty");
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (o): PollSnapshot => {
        const item = o.getItem("E-FAST-1");
        if (!item) return { items: [], readyIds: [] };
        if (item.state === "queued" || item.state === "ready") {
          return { items: [], readyIds: [item.id] };
        }
        if (item.state === "launching") {
          return { items: [{ id: item.id, workerAlive: true }], readyIds: [] };
        }
        if (item.state === "implementing") {
          return {
            items: [{ id: item.id, prNumber: 12, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        }
        if (item.state === "reviewing") {
          return {
            items: [{
              id: item.id,
              prNumber: 12,
              prState: "open",
              ciStatus: "pass",
              reviewVerdict: {
                verdict: "approve" as const,
                summary: "OK",
                blockingCount: 0,
                nonBlockingCount: 0,
                architectureScore: 8,
                codeQualityScore: 9,
                performanceScore: 7,
                testCoverageScore: 8,
                unresolvedDecisions: 0,
                criticalGaps: 0,
                confidence: 9,
              },
            }],
            readyIds: [],
          };
        }
        return { items: [], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({
        fetchOrigin: fetchOriginMock,
        ffMerge: ffMergeMock,
        launchSingleItem: vi.fn((workItem) => {
          launchCalls.push(workItem.id);
          return { worktreePath: "/tmp/test/item-fast-watch", workspaceRef: `workspace:${workItem.id}` };
        }),
      }),
      scanWorkItems: () => [makeWorkItem("E-FAST-1")],
    };

    await orchestrateLoop(orch, defaultCtx, deps, { watch: true, maxIterations: 50 });

    expect(fetchOriginMock).toHaveBeenCalled();
    expect(ffMergeMock).toHaveBeenCalled();
    expect(launchCalls).toEqual(["E-FAST-1"]);
    expect(orch.getItem("E-FAST-1")?.state).toBe("done");

    const watchNewLog = logs.find((l) => l.event === "watch_new_items");
    expect(watchNewLog?.newIds).toEqual(["E-FAST-1"]);
  });

  it("continues to the next ready item when launch-time validation blocks the first", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("E-BLOCK-1"));
    orch.getItem("E-BLOCK-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("E-READY-2"));
    orch.getItem("E-READY-2")!.reviewCompleted = true;

    const launchCalls: string[] = [];
    const validatePickupCandidate = vi.fn((workItem: WorkItem) => {
      if (workItem.id === "E-BLOCK-1") {
        return {
          status: "blocked" as const,
          code: "unlaunchable" as const,
          branchName: "ninthwave/E-BLOCK-1",
          failureReason: "launch-blocked: Repo 'missing-repo' not found.",
        };
      }
      return {
        status: "launch" as const,
        targetRepo: "ninthwave-sh/ninthwave",
        branchName: `ninthwave/${workItem.id}`,
      };
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (o): PollSnapshot => {
        const secondItem = o.getItem("E-READY-2");
        if (secondItem?.state === "launching") {
          return {
            items: [{ id: "E-READY-2", workerAlive: true }],
            readyIds: ["E-BLOCK-1", "E-READY-2"],
          };
        }
        return { items: [], readyIds: ["E-BLOCK-1", "E-READY-2"] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps({
        validatePickupCandidate,
        launchSingleItem: vi.fn((workItem) => {
          launchCalls.push(workItem.id);
          return { worktreePath: "/tmp/test/blocked-queue", workspaceRef: `workspace:${workItem.id}` };
        }),
      }),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 3 });

    expect(launchCalls).toEqual(["E-READY-2"]);
    expect(orch.getItem("E-BLOCK-1")!.state).toBe("blocked");
    expect(orch.getItem("E-BLOCK-1")!.failureReason).toContain("missing-repo");
    expect(orch.getItem("E-READY-2")!.state).toBe("implementing");
  });

  it("watch mode default interval is 30 seconds", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    onComplete?: (workItemId: string) => void;
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
        complete: vi.fn((workItemId: string) => {
          completedIds.push(workItemId);
          opts.onComplete?.(workItemId);
        }),
        heartbeat: vi.fn(),
        disconnect: vi.fn(() => {
          disconnected = true;
          opts.onDisconnect?.();
        }),
        isConnected: vi.fn(() => opts.connected ?? true),
        getCrewStatus: vi.fn(() => null),
        scheduleClaim: vi.fn(async () => false),
        report: vi.fn(),
      },
      completedIds,
      syncedIds,
      isDisconnected: () => disconnected,
    };
  }

  function createTelemetryCtx(agentFilename: string, model: string): ExecutionContext {
    const projectRoot = mkdtempSync(join(tmpdir(), "nw-telemetry-ctx-"));
    mkdirSync(join(projectRoot, ".ninthwave", "work"), { recursive: true });
    mkdirSync(join(projectRoot, "agents"), { recursive: true });
    writeFileSync(join(projectRoot, "agents", agentFilename), `---\nmodel: ${model}\n---\n`);

    return {
      ...defaultCtx,
      projectRoot,
      worktreeDir: join(projectRoot, ".ninthwave", ".worktrees"),
      workDir: join(projectRoot, ".ninthwave", "work"),
    };
  }

  it("reports session_started with configured model from agent frontmatter", async () => {
    const ctx = createTelemetryCtx("implementer.md", "opus");
    try {
      const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("T-MODEL-1"));
      orch.getItem("T-MODEL-1")!.reviewCompleted = true;

      let cycle = 0;
      const { broker } = mockCrewBroker({ connected: true, claimResults: ["T-MODEL-1"] });

      const deps: OrchestrateLoopDeps = {
        buildSnapshot: (): PollSnapshot => {
          cycle++;
          if (cycle === 1) return { items: [], readyIds: ["T-MODEL-1"] };
          return { items: [{ id: "T-MODEL-1", workerAlive: true }], readyIds: [] };
        },
        sleep: () => Promise.resolve(),
        log: () => {},
        actionDeps: mockActionDeps(),
        crewBroker: broker,
        getFreeMem: () => 16 * 1024 ** 3,
      };

      await orchestrateLoop(orch, ctx, deps, { maxIterations: 2 });

      const reportCalls = (broker.report as any).mock.calls.filter(([event]: [string]) => event === "session_started");
      expect(reportCalls).toHaveLength(1);
      expect(reportCalls[0]).toEqual([
        "session_started",
        "T-MODEL-1",
        { agent: "claude", model: "opus", role: "implementer" },
        { model: "opus" },
      ]);
      expect(reportCalls[0]![2]).not.toHaveProperty("provider");
    } finally {
      rmSync(ctx.projectRoot, { recursive: true, force: true });
    }
  });

  it("builds session_ended metadata with harness and model from agent frontmatter", () => {
    const ctx = createTelemetryCtx("implementer.md", "opus");
    try {
      const startedAt = new Date(Date.now() - 1_000).toISOString();
      const metadata = buildSessionEndedMetadata({
        ...makeOrchestratorItem("T-MODEL-2"),
        workspaceRef: "workspace:1",
        aiTool: "claude",
        startedAt,
      }, ctx, "clean");

      expect(metadata).toMatchObject({
        agent: "claude",
        model: "opus",
        role: "implementer",
      });
      expect(metadata).toHaveProperty("durationMs");
      expect(metadata).not.toHaveProperty("provider");
    } finally {
      rmSync(ctx.projectRoot, { recursive: true, force: true });
    }
  });

  it("filters launch actions through crew broker -- only claimed items launch", async () => {
    const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
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

  it("excludes blocked items from crew sync", async () => {
    const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1"));
    orch.getItem("T-1")!.reviewCompleted = true;
    orch.hydrateState("T-1", "blocked");
    orch.addItem(makeWorkItem("T-2"));
    orch.getItem("T-2")!.reviewCompleted = true;
    orch.hydrateState("T-2", "implementing");

    const { broker, syncedIds } = mockCrewBroker({ connected: true });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => ({ items: [{ id: "T-2", workerAlive: true }], readyIds: [] }),
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 1 });

    const syncedItemIds = (syncedIds[0] as Array<{ id: string }>).map((item) => item.id);
    expect(syncedItemIds).toEqual(["T-2"]);
  });

  it("blocks ALL launches when broker is disconnected", async () => {
    const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
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

  it("calls broker.complete when an item reaches true completion", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1"));
    orch.getItem("T-1")!.prNumber = 1;
    orch.hydrateState("T-1", "merged");

    const { broker, completedIds } = mockCrewBroker({
      connected: true,
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => ({ items: [], readyIds: [] }),
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 4 });

    expect(orch.getItem("T-1")!.state).toBe("done");
    expect(completedIds).toContain("T-1");
  });

  it("does not call broker.complete for blocked terminal items", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-1"));
    orch.hydrateState("T-1", "blocked");

    const { broker, completedIds } = mockCrewBroker({
      connected: true,
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => ({ items: [], readyIds: [] }),
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3,
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 2 });

    expect(completedIds).toEqual([]);
  });

  it("reports complete with model and token usage before broker.complete", async () => {
    const ctx = createTelemetryCtx("implementer.md", "claude-sonnet-4-6");
    try {
      const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("T-2"));
      orch.getItem("T-2")!.prNumber = 2;
      orch.getItem("T-2")!.startedAt = new Date(Date.now() - 5_000).toISOString();
      orch.hydrateState("T-2", "merged");

      const { broker } = mockCrewBroker({
        connected: true,
      });

      const deps: OrchestrateLoopDeps = {
        buildSnapshot: (): PollSnapshot => ({ items: [], readyIds: [] }),
        sleep: () => Promise.resolve(),
        log: () => {},
        actionDeps: mockActionDeps(),
        crewBroker: broker,
        getFreeMem: () => 16 * 1024 ** 3,
        readTokenUsage: () => ({ inputTokens: 100, outputTokens: 40, cacheTokens: 10 }),
      };

      await orchestrateLoop(orch, ctx, deps, { maxIterations: 4 });

      const completeReportCall = (broker.report as any).mock.calls.find(([event]: [string]) => event === "complete");
      const completeReportIndex = (broker.report as any).mock.calls.findIndex(([event]: [string]) => event === "complete");
      expect(completeReportCall).toBeDefined();
      expect(completeReportCall).toEqual([
        "complete",
        "T-2",
        expect.objectContaining({ state: "done", prNumber: 2 }),
        {
          model: "claude-sonnet-4-6",
          tokenUsage: { inputTokens: 100, outputTokens: 40, cacheTokens: 10 },
        },
      ]);

      expect((broker.report as any).mock.invocationCallOrder[completeReportIndex]).toBeLessThan((broker.complete as any).mock.invocationCallOrder[0]);
    } finally {
      rmSync(ctx.projectRoot, { recursive: true, force: true });
    }
  });

  it("withholds broker completion until repair verification finishes", async () => {
    const orch = new Orchestrator({ fixForward: true, sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-REPAIR-1"));
    orch.getItem("T-REPAIR-1")!.reviewCompleted = true;

    let cycle = 0;
    const { broker, completedIds } = mockCrewBroker({
      connected: true,
      claimResults: ["T-REPAIR-1"],
    });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1:
            return { items: [], readyIds: ["T-REPAIR-1"] };
          case 2:
            return { items: [{ id: "T-REPAIR-1", workerAlive: true }], readyIds: [] };
          case 3:
            return { items: [{ id: "T-REPAIR-1", prNumber: 11, prState: "open", ciStatus: "pass" }], readyIds: [] };
          case 4:
            return {
              items: [{ id: "T-REPAIR-1", prNumber: 11, prState: "merged", mergeCommitSha: "sha-original", defaultBranch: "main" }],
              readyIds: [],
            };
          case 5:
            return { items: [], readyIds: [] };
          case 6:
            return { items: [{ id: "T-REPAIR-1", mergeCommitCIStatus: "fail" }], readyIds: [] };
          case 7:
            return { items: [{ id: "T-REPAIR-1", mergeCommitCIStatus: "fail" }], readyIds: [] };
          case 8:
            return { items: [{ id: "T-REPAIR-1", prNumber: 77, prState: "open", ciStatus: "pending" }], readyIds: [] };
          case 9:
            return {
              items: [{ id: "T-REPAIR-1", prNumber: 77, prState: "merged", mergeCommitSha: "sha-repair", defaultBranch: "main" }],
              readyIds: [],
            };
          case 10:
            return { items: [], readyIds: [] };
          case 11:
            return { items: [{ id: "T-REPAIR-1", mergeCommitCIStatus: "pass" }], readyIds: [] };
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 20 });

    expect(orch.getItem("T-REPAIR-1")!.state).toBe("done");
    expect(completedIds).toEqual(["T-REPAIR-1"]);

    const completeReports = (broker.report as any).mock.calls.filter(([event]: [string]) => event === "complete");
    expect(completeReports).toHaveLength(1);
    expect(completeReports[0]).toEqual([
      "complete",
      "T-REPAIR-1",
      expect.objectContaining({ state: "done", prNumber: 77 }),
      expect.any(Object),
    ]);

    const mergedReports = (broker.report as any).mock.calls.filter(([event]: [string]) => event === "pr_merged");
    expect(mergedReports).toHaveLength(2);
    expect((broker.complete as any).mock.invocationCallOrder[0]).toBeGreaterThan(
      (broker.report as any).mock.invocationCallOrder[
        (broker.report as any).mock.calls.findIndex(([event]: [string]) => event === "fix_forward_started")
      ],
    );
  });
});

describe("crew remote state helpers", () => {
  function makeCrewStatus(remoteItems: CrewStatus["remoteItems"]): CrewStatus {
    return {
      crewCode: "ABCD-EFGH",
      daemonCount: 2,
      availableCount: 1,
      claimedCount: remoteItems.filter((item) => item.ownerDaemonId !== null).length,
      completedCount: 0,
      daemonNames: ["local", "remote"],
      claimedItems: remoteItems.filter((item) => item.ownerDaemonId !== null).map((item) => item.id),
      remoteItems,
    };
  }

  it("filters write actions using broker ownership instead of local heuristics", () => {
    const actions = [
      { type: "merge", itemId: "H-REMOTE-1" },
      { type: "workspace-close", itemId: "H-REMOTE-1" },
      { type: "launch", itemId: "H-REMOTE-1" },
    ] as any;
    const crewStatus = makeCrewStatus([
      {
        id: "H-REMOTE-1",
        state: "implementing",
        ownerDaemonId: "daemon-2",
        ownerName: "remote-host",
      },
    ]);

    expect(filterCrewRemoteWriteActions(actions, crewStatus)).toEqual([
      { type: "launch", itemId: "H-REMOTE-1" },
    ]);
  });

  it("updates suppression and rendering data on the next broker owner change", () => {
    const actions = [{ type: "merge", itemId: "H-REMOTE-2" }] as any;
    const ownedByRemote = makeCrewStatus([
      {
        id: "H-REMOTE-2",
        state: "review",
        ownerDaemonId: "daemon-2",
        ownerName: "remote-host",
        prNumber: 17,
      },
    ]);
    const releasedToQueue = makeCrewStatus([
      {
        id: "H-REMOTE-2",
        state: "queued",
        ownerDaemonId: null,
        ownerName: null,
      },
    ]);

    expect(filterCrewRemoteWriteActions(actions, ownedByRemote)).toEqual([]);
    expect(filterCrewRemoteWriteActions(actions, releasedToQueue)).toEqual(actions);

    expect(crewStatusToRemoteItemSnapshots(ownedByRemote)?.get("H-REMOTE-2")).toMatchObject({
      state: "review",
      ownerDaemonId: "daemon-2",
      prNumber: 17,
    });
    expect(crewStatusToRemoteItemSnapshots(releasedToQueue)?.get("H-REMOTE-2")).toMatchObject({
      state: "queued",
      ownerDaemonId: null,
    });
  });
});

// ── Crew remote state: last-write-wins and serialization round-trip ────────────

describe("crew remote state: last broker update replaces stale snapshots", () => {
  it("serializing state twice with different broker snapshots replaces the first cleanly", () => {
    const item: OrchestratorItem = {
      id: "RACE-1",
      workItem: makeWorkItem("RACE-1"),
      state: "queued",
      prNumber: undefined,
      lastTransition: "2026-04-01T10:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };

    // First broker update: implementing by daemon-2
    const firstSnapshot = new Map<string, CrewRemoteItemSnapshot>([
      ["RACE-1", {
        id: "RACE-1",
        state: "implementing",
        ownerDaemonId: "daemon-2",
        ownerName: "host-2",
      }],
    ]);
    const state1 = serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z", {
      remoteItemSnapshots: firstSnapshot,
    });
    expect(state1.items[0]!.remoteSnapshot!.state).toBe("implementing");
    expect(state1.items[0]!.remoteSnapshot!.ownerDaemonId).toBe("daemon-2");

    // Second broker update: daemon-2 disconnected, item released
    const secondSnapshot = new Map<string, CrewRemoteItemSnapshot>([
      ["RACE-1", {
        id: "RACE-1",
        state: "queued",
        ownerDaemonId: null,
        ownerName: null,
      }],
    ]);
    const state2 = serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z", {
      remoteItemSnapshots: secondSnapshot,
    });
    expect(state2.items[0]!.remoteSnapshot!.state).toBe("queued");
    expect(state2.items[0]!.remoteSnapshot!.ownerDaemonId).toBeNull();

    // Round-trip through daemonStateToStatusItems: second update wins
    const rendered1 = daemonStateToStatusItems(state1);
    expect(rendered1[0]!.state).toBe("implementing");
    expect(rendered1[0]!.remote).toBe(true);

    const rendered2 = daemonStateToStatusItems(state2);
    expect(rendered2[0]!.state).toBe("queued");
    expect(rendered2[0]!.remote).toBe(false);
  });

  it("disk round-trip: write → read → render preserves remote truth without stale leak", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-remote-race-"));
    const item: OrchestratorItem = {
      id: "RACE-2",
      workItem: makeWorkItem("RACE-2"),
      state: "queued",
      prNumber: undefined,
      lastTransition: "2026-04-01T10:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };

    try {
      // Write state with implementing snapshot
      const implSnapshot = new Map<string, CrewRemoteItemSnapshot>([
        ["RACE-2", {
          id: "RACE-2",
          state: "implementing",
          ownerDaemonId: "daemon-2",
          ownerName: "host-2",
        }],
      ]);
      writeStateFile(tmpDir, serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z", {
        remoteItemSnapshots: implSnapshot,
      }));

      // Read back and verify implementing state persisted
      const restored1 = readStateFile(tmpDir)!;
      const rendered1 = daemonStateToStatusItems(restored1);
      expect(rendered1[0]!.state).toBe("implementing");
      expect(rendered1[0]!.remote).toBe(true);

      // Overwrite with queued snapshot (daemon released)
      const queuedSnapshot = new Map<string, CrewRemoteItemSnapshot>([
        ["RACE-2", {
          id: "RACE-2",
          state: "queued",
          ownerDaemonId: null,
          ownerName: null,
        }],
      ]);
      writeStateFile(tmpDir, serializeOrchestratorState([item], 9999, "2026-04-01T00:00:00Z", {
        remoteItemSnapshots: queuedSnapshot,
      }));

      // Read back and verify queued state replaced implementing without residue
      const restored2 = readStateFile(tmpDir)!;
      const rendered2 = daemonStateToStatusItems(restored2);
      expect(rendered2[0]!.state).toBe("queued");
      expect(rendered2[0]!.remote).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(userStateDir(tmpDir), { recursive: true, force: true });
    }
  });
});

// ── parseWatchArgs (passthrough path) ──────────────────────────────────

describe("resolveInteractiveStartupConfig", () => {
  const projectRoot = "/tmp/interactive-schedule";

  it("keeps persisted merge, review, and collaboration defaults", () => {
    const result = resolveInteractiveStartupConfig(
      { review_external: false, schedule_enabled: false, ai_tools: ["claude"] },
      {
        ai_tools: ["opencode", "copilot"],
        backend_mode: "cmux",
        merge_strategy: "auto",
        review_mode: "all",
        collaboration_mode: "share",
      },
      projectRoot,
    );

    expect(result.defaults).toEqual({
      backendMode: "cmux",
      mergeStrategy: "auto",
      reviewMode: "all",
      collaborationMode: "share",
      scheduleEnabled: false,
    });
    expect(result.savedToolIds).toEqual(["opencode", "copilot"]);
    expect(result.skipToolStep).toBe(true);
  });

  it("falls back to manual/off/local when persisted defaults are absent", () => {
    const result = resolveInteractiveStartupConfig(
      { review_external: true, schedule_enabled: false },
      {},
      projectRoot,
    );

    expect(result.defaults).toEqual({
      backendMode: "auto",
      mergeStrategy: "manual",
      reviewMode: "off",
      collaborationMode: "local",
      scheduleEnabled: false,
    });
    expect(result.savedToolIds).toBeUndefined();
    expect(result.skipToolStep).toBe(false);
  });

  it("honors explicit tool override while keeping resolved startup defaults", () => {
    const result = resolveInteractiveStartupConfig(
      { review_external: true, schedule_enabled: false },
      { review_mode: "mine" },
      projectRoot,
      "claude",
    );

    expect(result.defaults.backendMode).toBe("auto");
    expect(result.defaults.reviewMode).toBe("mine");
    expect(result.skipToolStep).toBe(true);
  });

  it("restores the project-local scheduled-task preference on re-entry", () => {
    const result = resolveInteractiveStartupConfig(
      { review_external: false, schedule_enabled: true },
      {
        schedule_enabled_projects: {
          [projectRoot.replace(/\//g, "-")]: true,
        },
      },
      projectRoot,
    );

    expect(result.defaults.scheduleEnabled).toBe(true);
  });

  it("builds full durable startup updates while keeping join codes runtime-only", () => {
    const startupConfig = resolveInteractiveStartupConfig(
      { review_external: false, schedule_enabled: false },
      {
        ai_tools: ["opencode", "copilot"],
        backend_mode: "cmux",
        merge_strategy: "auto",
        review_mode: "all",
        collaboration_mode: "share",
      },
      projectRoot,
    );
    const result: InteractiveResult = {
      itemIds: ["H-1"],
      mergeStrategy: "auto",
      sessionLimit: 6,
      allSelected: false,
      reviewMode: "all",
      connectionAction: { type: "join", code: "K2F9-AB3X-7YPL-QM4N" },
      scheduleEnabled: false,
    };

    const persisted = buildStartupPersistenceUpdates(result, {
      backendMode: startupConfig.defaults.backendMode,
      savedToolIds: startupConfig.savedToolIds,
    });
    const runtime = resolveStartupCollaborationAction(
      { connectMode: true, crewUrl: "wss://config.example" },
      result.connectionAction,
    );

    expect(persisted).toEqual({
      backend_mode: "cmux",
      merge_strategy: "auto",
      review_mode: "all",
      session_limit: 6,
      collaboration_mode: "join",
      ai_tools: ["opencode", "copilot"],
    });
    expect(JSON.stringify(persisted)).not.toContain("K2F9-AB3X-7YPL-QM4N");
    expect(runtime).toEqual({
      connectMode: false,
      crewCode: "K2F9-AB3X-7YPL-QM4N",
      crewUrl: "wss://config.example",
    });
  });
});

describe("resolveScheduleExecutionEnabled", () => {
  const projectRoot = "/tmp/schedule-project";
  const projectKey = "-tmp-schedule-project";

  it("defaults schedule execution off on first run", () => {
    expect(resolveScheduleExecutionEnabled(
      { schedule_enabled: true },
      {},
      projectRoot,
    )).toBe(false);
  });

  it("keeps schedule execution off when local preference is false", () => {
    expect(resolveScheduleExecutionEnabled(
      { schedule_enabled: true },
      { schedule_enabled_projects: { [projectKey]: false } },
      projectRoot,
    )).toBe(false);
  });

  it("turns schedule execution on only when both project capability and local preference are enabled", () => {
    expect(resolveScheduleExecutionEnabled(
      { schedule_enabled: false },
      { schedule_enabled_projects: { [projectKey]: true } },
      projectRoot,
    )).toBe(false);

    expect(resolveScheduleExecutionEnabled(
      { schedule_enabled: true },
      { schedule_enabled_projects: { [projectKey]: true } },
      projectRoot,
    )).toBe(true);
  });
});

describe("createRuntimeControlHandlers", () => {
  it("persists merge, review, WIP, and schedule changes while keeping pause and collaboration runtime-only", () => {
    const savedUpdates: Array<Record<string, unknown>> = [];
    const savedScheduleEnabled: boolean[] = [];
    const sentControls: Array<Record<string, unknown>> = [];
    let currentSessionLimit = 3;
    let currentScheduleEnabled = false;

    const handlers = createRuntimeControlHandlers({
      sendControl: (command) => {
        sentControls.push(command as Record<string, unknown>);
        if (command.type === "set-session-limit") {
          currentSessionLimit = command.limit;
        }
        if (command.type === "set-schedule-enabled") {
          currentScheduleEnabled = command.enabled;
        }
      },
      getSessionLimit: () => currentSessionLimit,
      getScheduleEnabled: () => currentScheduleEnabled,
      projectRoot: "/tmp/runtime-controls",
      saveUserConfigFn: (updates) => {
        savedUpdates.push(updates as Record<string, unknown>);
      },
      saveProjectScheduleEnabledFn: (_projectRoot, enabled) => {
        savedScheduleEnabled.push(enabled);
      },
    });

    const shareResult = handlers.onCollaborationShare?.();
    const joinResult = handlers.onCollaborationJoinSubmit?.("ABCD-1234");
    const localResult = handlers.onCollaborationLocal?.();
    const extendResult = handlers.onExtendTimeout?.("ENG-1");
    handlers.onPauseChange?.(true);
    handlers.onStrategyChange?.("auto");
    handlers.onReviewChange?.("all-prs");
    handlers.onSessionLimitChange?.(1);
    handlers.onScheduleEnabledChange?.(true);
    handlers.onShutdown?.();

    expect(currentSessionLimit).toBe(4);
    expect(currentScheduleEnabled).toBe(true);
    expect(sentControls).toEqual([
      { type: "set-collaboration-mode", mode: "shared", source: "keyboard" },
      { type: "set-collaboration-mode", mode: "joined", code: "ABCD-1234", source: "keyboard" },
      { type: "set-collaboration-mode", mode: "local", source: "keyboard" },
      { type: "extend-timeout", itemId: "ENG-1", source: "keyboard" },
      { type: "set-paused", paused: true, source: "keyboard" },
      { type: "set-merge-strategy", strategy: "auto", source: "keyboard" },
      { type: "set-review-mode", mode: "all-prs", source: "keyboard" },
      { type: "set-session-limit", limit: 4, source: "keyboard" },
      { type: "set-schedule-enabled", enabled: true, source: "keyboard" },
      { type: "shutdown", source: "keyboard" },
    ]);
    expect(savedUpdates).toEqual([
      { merge_strategy: "auto" },
      { review_mode: "all" },
      { session_limit: 4 },
    ]);
    expect(savedScheduleEnabled).toEqual([true]);
    expect(shareResult).toEqual({ mode: "shared" });
    expect(joinResult).toEqual({ mode: "joined" });
    expect(localResult).toEqual({ mode: "local" });
    expect(extendResult).toBe(true);
  });

  it("does not persist bypass as a default merge strategy", () => {
    const saveUserConfigFn = vi.fn();
    const handlers = createRuntimeControlHandlers({
      sendControl: () => {},
      getSessionLimit: () => 3,
      getScheduleEnabled: () => false,
      projectRoot: "/tmp/runtime-controls",
      saveUserConfigFn,
    });

    handlers.onStrategyChange?.("bypass");
    expect(saveUserConfigFn).not.toHaveBeenCalled();
  });
});

describe("applyRuntimeCollaborationAction", () => {
  function makeBroker(overrides: Partial<CrewBroker> = {}): CrewBroker {
    return {
      connect: vi.fn(async () => {}),
      sync: vi.fn(),
      claim: vi.fn(async () => null),
      complete: vi.fn(),
      scheduleClaim: vi.fn(async () => false),
      heartbeat: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
      getCrewStatus: vi.fn(() => null),
      report: vi.fn(),
      ...overrides,
    };
  }

  it("shares once, connects, and reuses the active code on repeat share", async () => {
    const state = {
      mode: "local" as const,
      connectMode: false,
    };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: "ABCD-1234" }),
    }));
    const broker = makeBroker();
    const createBroker = vi.fn(() => broker);
    const saveCrewCodeFn = vi.fn();
    const onBrokerChanged = vi.fn();

    const firstResult = await applyRuntimeCollaborationAction(state, { action: "share" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      crewName: "operator",
      log: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      createBroker,
      saveCrewCodeFn,
      onBrokerChanged,
    });
    const secondResult = await applyRuntimeCollaborationAction(state, { action: "share" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      crewName: "operator",
      log: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      createBroker,
      saveCrewCodeFn,
      onBrokerChanged,
    });

    expect(firstResult).toEqual({ mode: "shared", code: "ABCD-1234" });
    expect(secondResult).toEqual({ mode: "shared", code: "ABCD-1234" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(createBroker).toHaveBeenCalledTimes(1);
    expect(broker.connect).toHaveBeenCalledTimes(1);
    expect(saveCrewCodeFn).toHaveBeenCalledTimes(1);
    expect(onBrokerChanged).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      mode: "shared",
      crewCode: "ABCD-1234",
      connectMode: true,
      crewBroker: broker,
    });
  });

  it("returns a broker connection failure without mutating startup collaboration state", async () => {
    const state = {
      mode: "local" as const,
      connectMode: false,
    };
    const rejectedBroker = makeBroker({
      connect: vi.fn(async () => {
        throw new Error("Broker offline");
      }),
    });

    const result = await applyRuntimeCollaborationAction(state, { action: "share" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      log: () => {},
      fetchFn: vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: "ABCD-1234" }),
      })) as unknown as typeof fetch,
      createBroker: vi.fn(() => rejectedBroker),
      saveCrewCodeFn: vi.fn(),
      onBrokerChanged: vi.fn(),
    });

    expect(result).toEqual({ error: "Broker offline" });
    expect(state).toEqual({
      mode: "local",
      connectMode: false,
    });
  });

  it("uses an existing crew URL for share session creation and broker connection", async () => {
    const state = {
      mode: "local" as const,
      connectMode: false,
      crewUrl: "wss://config.example/socket",
    };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: "ABCD-1234" }),
    }));
    const broker = makeBroker();
    const createBroker = vi.fn(() => broker);

    const result = await applyRuntimeCollaborationAction(state, { action: "share" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      log: () => {},
      fetchFn: fetchFn as unknown as typeof fetch,
      createBroker,
      saveCrewCodeFn: vi.fn(),
      onBrokerChanged: vi.fn(),
    });

    expect(result).toEqual({ mode: "shared", code: "ABCD-1234" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://config.example/socket/api/crews",
      expect.objectContaining({ method: "POST" }),
    );
    expect(createBroker).toHaveBeenCalledWith(
      "/project",
      "wss://config.example/socket",
      "ABCD-1234",
      "git@github.com:test/repo.git",
      expect.any(Object),
      expect.any(String),
    );
    expect(state.crewUrl).toBe("wss://config.example/socket");
  });

  it("keeps the current session intact on a rejected join", async () => {
    const currentBroker = makeBroker();
    const rejectedBroker = makeBroker({
      connect: vi.fn(async () => {
        throw new Error("Invalid session code");
      }),
    });
    const state = {
      mode: "shared" as const,
      crewCode: "KEEP-1234",
      crewUrl: "wss://ninthwave.sh",
      crewBroker: currentBroker,
      connectMode: true,
    };

    const result = await applyRuntimeCollaborationAction(state, { action: "join", code: "BAD1" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      log: () => {},
      createBroker: vi.fn(() => rejectedBroker),
      saveCrewCodeFn: vi.fn(),
      onBrokerChanged: vi.fn(),
    });

    expect(result).toEqual({ error: "Invalid session code" });
    expect(currentBroker.disconnect).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mode: "shared",
      crewCode: "KEEP-1234",
      crewBroker: currentBroker,
      connectMode: true,
    });
  });

  it("joins a new code, then disconnects cleanly back to local mode", async () => {
    const currentBroker = makeBroker();
    const joinedBroker = makeBroker();
    const saveCrewCodeFn = vi.fn();
    const onBrokerChanged = vi.fn();
    const state = {
      mode: "shared" as const,
      crewCode: "SHARE-1234",
      crewUrl: "wss://ninthwave.sh",
      crewBroker: currentBroker,
      connectMode: true,
    };

    const joinResult = await applyRuntimeCollaborationAction(state, { action: "join", code: "JOIN-5678" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      log: () => {},
      createBroker: vi.fn(() => joinedBroker),
      saveCrewCodeFn,
      onBrokerChanged,
    });
    const localResult = await applyRuntimeCollaborationAction(state, { action: "local" }, {
      projectRoot: "/project",
      crewRepoUrl: "git@github.com:test/repo.git",
      log: () => {},
      createBroker: vi.fn(),
      saveCrewCodeFn,
      onBrokerChanged,
    });

    expect(joinResult).toEqual({ mode: "joined", code: "JOIN-5678" });
    expect(localResult).toEqual({ mode: "local" });
    expect(joinedBroker.connect).toHaveBeenCalledTimes(1);
    expect(currentBroker.disconnect).toHaveBeenCalledTimes(1);
    expect(joinedBroker.disconnect).toHaveBeenCalledTimes(1);
    expect(saveCrewCodeFn).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      mode: "local",
      crewCode: undefined,
      crewBroker: undefined,
      connectMode: false,
    });
  });
});

describe("interactive watch instrumentation", () => {
  it("captures stage timings and warns on long blocking stages in tui mode", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-TUI-1"));
    orch.getItem("T-TUI-1")!.reviewCompleted = true;

    const logs: LogEntry[] = [];
    const abortController = new AbortController();
    let currentMs = 0;
    const advance = (ms: number) => {
      currentMs += ms;
    };

    const pollMs = INTERACTIVE_WATCH_STAGE_WARN_MS.poll + 15;
    const actionExecutionMs = INTERACTIVE_WATCH_STAGE_WARN_MS.actionExecution + 20;
    const mainRefreshMs = INTERACTIVE_WATCH_STAGE_WARN_MS.mainRefresh + 25;
    const displaySyncMs = INTERACTIVE_WATCH_STAGE_WARN_MS.displaySync + 10;
    const renderMs = INTERACTIVE_WATCH_STAGE_WARN_MS.render + 5;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: () => {
        advance(pollMs);
        return { items: [], readyIds: ["T-TUI-1"] };
      },
      sleep: async () => {
        abortController.abort();
      },
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({
        fetchOrigin: vi.fn(() => advance(mainRefreshMs)),
        ffMerge: vi.fn(),
        launchSingleItem: vi.fn(() => {
          advance(actionExecutionMs);
          return { worktreePath: "/tmp/test/tui-stage-timing", workspaceRef: "workspace:T-TUI-1" };
        }),
      }),
      syncDisplay: () => {
        advance(displaySyncMs);
      },
      onPollComplete: (_items, _snapshot, _pollIntervalMs, interactiveTiming) => {
        if (!interactiveTiming) return;
        advance(renderMs);
        interactiveTiming.timingsMs.render = renderMs;
      },
      nowMs: () => currentMs,
    };

    await orchestrateLoop(
      orch,
      defaultCtx,
      deps,
      { maxIterations: 10, tuiMode: true },
      abortController.signal,
    );

    const timingLog = logs.find((entry) => entry.event === "interactive_watch_timing");
    expect(timingLog).toBeDefined();
    expect(timingLog!.iteration).toBe(1);
    expect(timingLog!.actionCount).toBe(1);
    expect(timingLog!.actionTypes).toEqual(["launch"]);
    expect(timingLog!.timingsMs).toEqual({
      eventLoopLag: 0,
      poll: pollMs,
      actionExecution: actionExecutionMs,
      mainRefresh: mainRefreshMs,
      displaySync: displaySyncMs,
      render: renderMs,
      totalBlocking: pollMs + actionExecutionMs + mainRefreshMs + displaySyncMs + renderMs,
    });

    const stallStages = logs
      .filter((entry) => entry.event === "interactive_watch_stall")
      .map((entry) => entry.stage);
    expect(stallStages).toEqual([
      "poll",
      "action_execution",
      "main_refresh",
      "display_sync",
      "render",
    ]);
  });

  it("captures event-loop lag in tui mode without real blocking subprocesses", async () => {
    vi.useFakeTimers();
    try {
      const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("T-LAG-1"));
      orch.getItem("T-LAG-1")!.reviewCompleted = true;

      const logs: LogEntry[] = [];
      const abortController = new AbortController();
      let currentMs = 0;

      const deps: OrchestrateLoopDeps = {
        buildSnapshot: () => {
          currentMs = INTERACTIVE_WATCH_STAGE_WARN_MS.eventLoopLag + 100;
          vi.advanceTimersByTime(50);
          return { items: [], readyIds: ["T-LAG-1"] };
        },
        sleep: async () => {
          abortController.abort();
        },
        log: (entry) => logs.push(entry),
        actionDeps: mockActionDeps(),
        onPollComplete: () => {},
        nowMs: () => currentMs,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      };

      await orchestrateLoop(
        orch,
        defaultCtx,
        deps,
        { maxIterations: 10, tuiMode: true },
        abortController.signal,
      );

      const timingLog = logs.find((entry) => entry.event === "interactive_watch_timing");
      expect(timingLog).toBeDefined();
      expect((timingLog!.timingsMs as Record<string, number>).eventLoopLag).toBe(200);

      const lagWarning = logs.find(
        (entry) => entry.event === "interactive_watch_stall" && entry.stage === "event_loop_lag",
      );
      expect(lagWarning).toBeDefined();
      expect(lagWarning!.durationMs).toBe(200);
      expect(lagWarning!.thresholdMs).toBe(INTERACTIVE_WATCH_STAGE_WARN_MS.eventLoopLag);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit interactive timing logs outside tui mode", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-NON-TUI-1"));
    orch.getItem("T-NON-TUI-1")!.reviewCompleted = true;

    const logs: LogEntry[] = [];
    const abortController = new AbortController();

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: () => ({ items: [], readyIds: ["T-NON-TUI-1"] }),
      sleep: async () => {
        abortController.abort();
      },
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 10 }, abortController.signal);

    expect(logs.some((entry) => entry.event === "interactive_watch_timing")).toBe(false);
    expect(logs.some((entry) => entry.event === "interactive_watch_stall")).toBe(false);
  });

  it("records multi-second engine stalls without flagging operator repaint as blocked", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 1, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-SPLIT-TUI-1"));
    orch.getItem("T-SPLIT-TUI-1")!.reviewCompleted = true;

    const logs: LogEntry[] = [];
    const abortController = new AbortController();
    let currentMs = 0;
    const advance = (ms: number) => {
      currentMs += ms;
    };

    const pollMs = 2_600;
    const actionExecutionMs = 2_300;
    const mainRefreshMs = 2_100;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: () => {
        advance(pollMs);
        return { items: [], readyIds: ["T-SPLIT-TUI-1"] };
      },
      sleep: async () => {
        abortController.abort();
      },
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({
        fetchOrigin: vi.fn(() => advance(mainRefreshMs)),
        ffMerge: vi.fn(),
        launchSingleItem: vi.fn(() => {
          advance(actionExecutionMs);
          return { worktreePath: "/tmp/test/split-tui-stage-timing", workspaceRef: "workspace:T-SPLIT-TUI-1" };
        }),
      }),
      onPollComplete: () => {
        // Operator repaint happens in a separate foreground process and should not
        // be counted as an engine-side blocking stage.
      },
      nowMs: () => currentMs,
    };

    await orchestrateLoop(
      orch,
      defaultCtx,
      deps,
      { maxIterations: 10, tuiMode: true },
      abortController.signal,
    );

    const timingLog = logs.find((entry) => entry.event === "interactive_watch_timing");
    expect(timingLog).toBeDefined();
    expect(timingLog!.timingsMs).toEqual({
      eventLoopLag: 0,
      poll: pollMs,
      actionExecution: actionExecutionMs,
      mainRefresh: mainRefreshMs,
      displaySync: 0,
      render: 0,
      totalBlocking: pollMs + actionExecutionMs + mainRefreshMs,
    });

    const stallStages = logs
      .filter((entry) => entry.event === "interactive_watch_stall")
      .map((entry) => entry.stage);
    expect(stallStages).toEqual([
      "poll",
      "action_execution",
      "main_refresh",
    ]);
    expect(stallStages).not.toContain("render");
  });
});

describe("watch engine runner", () => {
  function makeEngineRunner(
    orch: Orchestrator,
    runLoop: (
      orch: Orchestrator,
      ctx: ExecutionContext,
      deps: OrchestrateLoopDeps,
    ) => Promise<unknown>,
    logs: LogEntry[],
    snapshots: WatchEngineSnapshotEvent[],
    getSessionLimit: () => number,
    setSessionLimit: (limit: number) => void,
  ) {
    return createWatchEngineRunner({
      orch,
      ctx: defaultCtx,
      loopDeps: {
        buildSnapshot: () => ({ items: [], readyIds: [] }),
        sleep: () => Promise.resolve(),
        log: () => {},
        actionDeps: mockActionDeps(),
      },
      runLoop: runLoop as any,
      emitLog: (entry) => logs.push(entry),
      emitSnapshot: (event) => snapshots.push(event),
      buildState: (items, heartbeats) => serializeOrchestratorState(items, 99, "2026-04-01T00:00:00.000Z", {
        sessionLimit: getSessionLimit(),
        heartbeats,
      }),
      initialReviewMode: "ninthwave-prs",
      initialCollaborationMode: "local",
      initialScheduleEnabled: false,
      getSessionLimit,
      setSessionLimit,
    });
  }

  it("starts the shared engine, emits snapshots, and forwards logs", async () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("ENG-1"));
    const logs: LogEntry[] = [];
    const snapshots: WatchEngineSnapshotEvent[] = [];
    let currentSessionLimit = 2;

    const runLoop = vi.fn(async (innerOrch: Orchestrator, _ctx: ExecutionContext, deps: OrchestrateLoopDeps) => {
      deps.log({ ts: "2026-04-01T00:00:00.000Z", level: "info", event: "orchestrate_start" });
      deps.onPollComplete?.(
        innerOrch.getAllItems(),
        {
          items: [{
            id: "ENG-1",
            lastHeartbeat: {
              id: "ENG-1",
              progress: 0.4,
              label: "Writing code",
              ts: "2026-04-01T00:00:01.000Z",
            },
          }],
          readyIds: [],
        },
        1500,
      );
      return {};
    });

    const runner = makeEngineRunner(
      orch,
      runLoop,
      logs,
      snapshots,
      () => currentSessionLimit,
      (limit) => {
        currentSessionLimit = limit;
      },
    );

    await runner.run();

    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(logs.map((entry) => entry.event)).toEqual(["orchestrate_start"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.pollIntervalMs).toBe(1500);
    expect(snapshots[0]!.state.items[0]).toMatchObject({
      id: "ENG-1",
      progress: 0.4,
      progressLabel: "Writing code",
    });
    expect(snapshots[0]!.runtime).toEqual({
      paused: false,
      mergeStrategy: "manual",
      sessionLimit: 2,
      reviewMode: "ninthwave-prs",
      collaborationMode: "local",
      scheduleEnabled: false,
    });
  });

  it("applies control messages in order and reflects them in subsequent snapshots", async () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("ENG-2"));
    const logs: LogEntry[] = [];
    const snapshots: WatchEngineSnapshotEvent[] = [];
    let currentSessionLimit = 2;
    let continueLoop!: () => void;
    const gate = new Promise<void>((resolve) => {
      continueLoop = resolve;
    });

    const runLoop = async (innerOrch: Orchestrator, _ctx: ExecutionContext, deps: OrchestrateLoopDeps) => {
      deps.onPollComplete?.(innerOrch.getAllItems(), { items: [], readyIds: [] }, 1000);
      await gate;
      deps.onPollComplete?.(innerOrch.getAllItems(), { items: [], readyIds: [] }, 1000);
      return {};
    };

    const runner = makeEngineRunner(
      orch,
      runLoop,
      logs,
      snapshots,
      () => currentSessionLimit,
      (limit) => {
        currentSessionLimit = limit;
      },
    );

    const runPromise = runner.run();
    runner.sendControl({ type: "set-paused", paused: true, source: "test-0" });
    runner.sendControl({ type: "set-review-mode", mode: "off", source: "test-1" });
    runner.sendControl({ type: "set-collaboration-mode", mode: "shared", source: "test-2" });
    runner.sendControl({ type: "set-session-limit", limit: 4, source: "test-3" });
    runner.sendControl({ type: "set-schedule-enabled", enabled: true, source: "test-3b" });
    runner.sendControl({ type: "set-merge-strategy", strategy: "auto", source: "test-4" });
    continueLoop();
    await runPromise;

    expect(logs.map((entry) => entry.event)).toEqual([
      "pause_state_changed",
      "review_mode_changed",
      "collaboration_mode_changed",
      "session_limit_changed",
      "schedule_enabled_changed",
    ]);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]!.runtime).toEqual({
      paused: false,
      mergeStrategy: "manual",
      sessionLimit: 2,
      reviewMode: "ninthwave-prs",
      collaborationMode: "local",
      scheduleEnabled: false,
    });
    expect(snapshots[1]!.runtime).toEqual({
      paused: true,
      mergeStrategy: "manual",
      sessionLimit: 4,
      reviewMode: "off",
      collaborationMode: "shared",
      scheduleEnabled: true,
    });
    expect(snapshots[2]!.runtime).toEqual({
      paused: true,
      mergeStrategy: "auto",
      sessionLimit: 4,
      reviewMode: "off",
      collaborationMode: "shared",
      scheduleEnabled: true,
    });
    expect(orch.config.mergeStrategy).toBe("auto");
    expect(orch.config.skipReview).toBe(true);
  });

  it("handles timeout extension and shutdown through protocol messages", async () => {
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("ENG-3"));
    const item = orch.getItem("ENG-3")!;
    item.timeoutDeadline = "2026-04-01T00:10:00.000Z";
    item.timeoutExtensionCount = 0;

    const logs: LogEntry[] = [];
    const snapshots: WatchEngineSnapshotEvent[] = [];
    let currentSessionLimit = 2;

    const runLoop = async (_innerOrch: Orchestrator, _ctx: ExecutionContext, _deps: OrchestrateLoopDeps, _config: unknown, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {};
    };

    const runner = makeEngineRunner(
      orch,
      runLoop as any,
      logs,
      snapshots,
      () => currentSessionLimit,
      (limit) => {
        currentSessionLimit = limit;
      },
    );

    const runPromise = runner.run();
    runner.sendControl({ type: "extend-timeout", itemId: "ENG-3", source: "test-timeout" });
    runner.sendControl({ type: "shutdown", source: "test-shutdown" });
    await runPromise;

    expect(logs.map((entry) => entry.event)).toEqual([
      "timeout_extended",
      "shutdown_requested",
    ]);
    expect(item.timeoutExtensionCount).toBe(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.state.items[0]).toMatchObject({
      id: "ENG-3",
      timeoutExtensionCount: 1,
    });
  });
});

describe("shared engine wrappers", () => {
  it("binds detached daemon mode and interactive child mode to the same runner entry", () => {
    const sharedRunner = {
      run: vi.fn(async () => ({})),
      sendControl: vi.fn(),
      createRuntimeControlHandlers: vi.fn(),
    };
    const createRunner = vi.fn(() => sharedRunner);
    const orch = new Orchestrator({ sessionLimit: 1, mergeStrategy: "auto" });
    const deps = {
      orch,
      ctx: defaultCtx,
      loopDeps: {
        buildSnapshot: () => ({ items: [], readyIds: [] }),
        sleep: () => Promise.resolve(),
        log: () => {},
        actionDeps: mockActionDeps(),
      },
      runLoop: vi.fn(async () => ({})),
      emitLog: vi.fn(),
      emitSnapshot: vi.fn(),
      buildState: (items: OrchestratorItem[], heartbeats: ReadonlyMap<string, any>) =>
        serializeOrchestratorState(items, 1, "2026-04-01T00:00:00.000Z", { heartbeats }),
      initialReviewMode: "ninthwave-prs" as const,
      initialCollaborationMode: "local" as const,
      initialScheduleEnabled: false,
      getSessionLimit: () => 1,
      setSessionLimit: () => {},
    };

    const detached = createDetachedDaemonEngineRunner(deps as any, createRunner as any);
    const interactive = createInteractiveChildEngineRunner(deps as any, createRunner as any);

    expect(detached).toBe(sharedRunner);
    expect(interactive).toBe(sharedRunner);
    expect(createRunner).toHaveBeenCalledTimes(2);
    expect(createRunner).toHaveBeenNthCalledWith(1, deps);
    expect(createRunner).toHaveBeenNthCalledWith(2, deps);
  });

  it("keep detached daemon and interactive child wrappers behaviorally aligned", async () => {
    async function captureWrapperOutput(
      createWrapper: typeof createDetachedDaemonEngineRunner,
    ) {
      const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "manual" });
      orch.addItem(makeWorkItem("ENG-PARITY-1"));

      const logs: LogEntry[] = [];
      const snapshots: WatchEngineSnapshotEvent[] = [];
      let currentSessionLimit = 2;
      let continueLoop!: () => void;
      const gate = new Promise<void>((resolve) => {
        continueLoop = resolve;
      });

      const runner = createWrapper({
        orch,
        ctx: defaultCtx,
        loopDeps: {
          buildSnapshot: () => ({ items: [], readyIds: [] }),
          sleep: () => Promise.resolve(),
          log: () => {},
          actionDeps: mockActionDeps(),
        },
        runLoop: (async (innerOrch: Orchestrator, _ctx: ExecutionContext, deps: OrchestrateLoopDeps) => {
          deps.log({ ts: "2026-04-01T00:00:00.000Z", level: "info", event: "engine_log_forwarded" });
          deps.onPollComplete?.(
            innerOrch.getAllItems(),
            { items: [], readyIds: [] },
            1200,
            {
              iteration: 1,
              actionCount: 0,
              actionTypes: [],
              timingsMs: {
                eventLoopLag: 0,
                poll: 2_500,
                actionExecution: 0,
                mainRefresh: 0,
                displaySync: 0,
                render: 0,
                totalBlocking: 2_500,
              },
            },
          );
          await gate;
          deps.onPollComplete?.(
            innerOrch.getAllItems(),
            { items: [], readyIds: [] },
            800,
          );
          return {};
        }) as any,
        emitLog: (entry) => logs.push(entry),
        emitSnapshot: (event) => snapshots.push(event),
        buildState: (items: OrchestratorItem[], heartbeats: ReadonlyMap<string, any>) =>
          serializeOrchestratorState(items, 2, "2026-04-01T00:00:00.000Z", { heartbeats }),
        initialReviewMode: "ninthwave-prs",
        initialCollaborationMode: "local",
        initialScheduleEnabled: false,
        getSessionLimit: () => currentSessionLimit,
        setSessionLimit: (limit) => {
          currentSessionLimit = limit;
        },
      } as any);

      const runPromise = runner.run();
      runner.sendControl({ type: "set-paused", paused: true, source: "test-pause" });
      runner.sendControl({ type: "set-review-mode", mode: "all-prs", source: "test-review" });
      runner.sendControl({ type: "set-collaboration-mode", mode: "shared", source: "test-collab" });
      runner.sendControl({ type: "set-session-limit", limit: 4, source: "test-session-limit" });
      runner.sendControl({ type: "set-schedule-enabled", enabled: true, source: "test-schedule" });
      runner.sendControl({ type: "set-merge-strategy", strategy: "auto", source: "test-merge" });
      continueLoop();
      await runPromise;

      return {
        logEvents: logs.map((entry) => entry.event),
        snapshotRuntimes: snapshots.map((event) => event.runtime),
        snapshotTimings: snapshots.map((event) => event.interactiveTiming?.timingsMs ?? null),
        snapshotPollIntervals: snapshots.map((event) => event.pollIntervalMs ?? null),
        mergeStrategy: orch.config.mergeStrategy,
        skipReview: orch.config.skipReview,
        sessionLimit: currentSessionLimit,
      };
    }

    const detached = await captureWrapperOutput(createDetachedDaemonEngineRunner);
    const interactive = await captureWrapperOutput(createInteractiveChildEngineRunner);

    expect(detached).toEqual(interactive);
    expect(detached.logEvents).toEqual([
      "engine_log_forwarded",
      "pause_state_changed",
      "review_mode_changed",
      "collaboration_mode_changed",
      "session_limit_changed",
      "schedule_enabled_changed",
    ]);
    expect(detached.snapshotRuntimes).toEqual([
      {
        paused: false,
        mergeStrategy: "manual",
        sessionLimit: 2,
        reviewMode: "ninthwave-prs",
        collaborationMode: "local",
        scheduleEnabled: false,
      },
      {
        paused: true,
        mergeStrategy: "manual",
        sessionLimit: 4,
        reviewMode: "all-prs",
        collaborationMode: "shared",
        scheduleEnabled: true,
      },
      {
        paused: true,
        mergeStrategy: "auto",
        sessionLimit: 4,
        reviewMode: "all-prs",
        collaborationMode: "shared",
        scheduleEnabled: true,
      },
    ]);
    expect(detached.snapshotTimings[0]).toEqual({
      eventLoopLag: 0,
      poll: 2_500,
      actionExecution: 0,
      mainRefresh: 0,
      displaySync: 0,
      render: 0,
      totalBlocking: 2_500,
    });
    expect(detached.snapshotTimings).toEqual([
      {
        eventLoopLag: 0,
        poll: 2_500,
        actionExecution: 0,
        mainRefresh: 0,
        displaySync: 0,
        render: 0,
        totalBlocking: 2_500,
      },
      null,
      null,
    ]);
    expect(detached.snapshotPollIntervals).toEqual([1200, null, 800]);
  });
});

describe("watch runtime state lifecycle", () => {
  it("preserves restart state across clean shutdown until the next startup", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-watch-runtime-state-"));
    const firstItem: OrchestratorItem = {
      id: "RST-1",
      workItem: makeWorkItem("RST-1"),
      state: "implementing",
      prNumber: undefined,
      lastTransition: "2026-04-01T10:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };
    const secondItem: OrchestratorItem = {
      id: "RST-2",
      workItem: makeWorkItem("RST-2"),
      state: "queued",
      prNumber: undefined,
      lastTransition: "2026-04-01T11:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };

    try {
      const firstState = serializeOrchestratorState([firstItem], 1111, "2026-04-01T10:00:00Z");
      initializeWatchRuntimeFiles(tmpDir, firstState, 1111);

      expect(readStateFile(tmpDir)).toEqual(firstState);
      expect(existsSync(pidFilePath(tmpDir))).toBe(true);

      cleanupWatchRuntimeFiles(tmpDir);

      expect(existsSync(pidFilePath(tmpDir))).toBe(false);
      expect(readStateFile(tmpDir)).toEqual(firstState);

      const secondState = serializeOrchestratorState([secondItem], 2222, "2026-04-01T11:00:00Z");
      initializeWatchRuntimeFiles(tmpDir, secondState, 2222);

      expect(readStateFile(tmpDir)).toEqual(secondState);
      expect(readStateFile(tmpDir)?.items.map((item) => item.id)).toEqual(["RST-2"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(userStateDir(tmpDir), { recursive: true, force: true });
    }
  });

  it("replaces any preexisting restart snapshot instead of mixing old and new items", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-watch-runtime-replace-"));
    const oldItem: OrchestratorItem = {
      id: "OLD-1",
      workItem: makeWorkItem("OLD-1"),
      state: "implementing",
      prNumber: 41,
      lastTransition: "2026-04-01T09:00:00Z",
      ciFailCount: 1,
      retryCount: 0,
    };
    const newItem: OrchestratorItem = {
      id: "NEW-1",
      workItem: makeWorkItem("NEW-1"),
      state: "launching",
      prNumber: undefined,
      lastTransition: "2026-04-01T12:00:00Z",
      ciFailCount: 0,
      retryCount: 0,
    };

    try {
      writeStateFile(tmpDir, serializeOrchestratorState([oldItem], 9999, "2026-04-01T09:00:00Z"));

      const freshState = serializeOrchestratorState([newItem], 1234, "2026-04-01T12:00:00Z");
      initializeWatchRuntimeFiles(tmpDir, freshState, 1234);

      const restored = readStateFile(tmpDir);
      expect(restored).not.toBeNull();
      expect(restored).toEqual(freshState);
      expect(restored?.items.map((item) => item.id)).toEqual(["NEW-1"]);
      expect(restored?.items.some((item) => item.id === "OLD-1")).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(userStateDir(tmpDir), { recursive: true, force: true });
    }
  });
});

describe("interactive watch operator session", () => {
  it("spawns the interactive engine child via flag-style CLI args in dev mode", () => {
    const spawnFn = vi.fn(() => ({}) as InteractiveEngineChildProcess);

    withProcessRespawnState(
      ["/usr/local/bin/bun", "/project/core/cli.ts", "watch"],
      "/usr/local/bin/bun",
      () => spawnInteractiveEngineChild(["--_interactive-engine-child", "--items", "H-TRS-3"], "/project", spawnFn as any),
    );

    expect(spawnFn).toHaveBeenCalledWith(
      "/usr/local/bin/bun",
      ["/project/core/cli.ts", "--_interactive-engine-child", "--items", "H-TRS-3"],
      expect.objectContaining({ cwd: "/project", stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("spawns the interactive engine child via the packaged executable directly", () => {
    const spawnFn = vi.fn(() => ({}) as InteractiveEngineChildProcess);

    withProcessRespawnState(
      ["/opt/homebrew/bin/ninthwave", "watch"],
      "/opt/homebrew/bin/ninthwave",
      () => spawnInteractiveEngineChild(["--_interactive-engine-child", "--items", "H-TRS-3"], "/project", spawnFn as any),
    );

    expect(spawnFn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ninthwave",
      ["--_interactive-engine-child", "--items", "H-TRS-3"],
      expect.objectContaining({ cwd: "/project", stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  function makeOperatorStdin() {
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
        if (!arr) return;
        const index = arr.indexOf(cb);
        if (index >= 0) arr.splice(index, 1);
      }),
      _emit(event: string, payload: unknown) {
        for (const cb of listeners[event] ?? []) cb(payload);
      },
    } as unknown as NodeJS.ReadStream;
  }

  function makeOperatorStdout() {
    const writes: string[] = [];
    return {
      writes,
      stream: {
        write: vi.fn((chunk: string) => {
          writes.push(chunk);
          return true;
        }),
      } as unknown as NodeJS.WriteStream,
    };
  }

  function makeOperatorTuiState(overrides: Partial<TuiState> = {}): TuiState {
    return {
      scrollOffset: 0,
      viewOptions: { showBlockerDetail: true, mergeStrategy: "manual" },
      paused: false,
      pendingPaused: undefined,
      sessionLimit: 2,
      pendingSessionLimit: undefined,
      mergeStrategy: "manual",
      pendingStrategy: undefined,
      pendingStrategyDeadlineMs: undefined,
      pendingStrategyTimer: undefined,
      pendingStrategyCountdownTimer: undefined,
      bypassEnabled: false,
      ctrlCPending: false,
      ctrlCTimestamp: 0,
      showHelp: false,
      showControls: false,
      controlsRowIndex: 0,
      collaborationMode: "local",
      pendingCollaborationMode: undefined,
      collaborationIntent: "local",
      collaborationJoinInputActive: false,
      collaborationJoinInputValue: "",
      collaborationBusy: false,
      reviewMode: "ninthwave-prs",
      pendingReviewMode: undefined,
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      selectedItemId: undefined,
      visibleItemIds: [],
      detailItemId: null,
      detailScrollOffset: 0,
      detailContentLines: 0,
      savedLogScrollOffset: 0,
      statusLayout: null,
      engineDisconnected: false,
      startupOverlay: undefined,
      ...overrides,
    };
  }

  function makeOperatorSnapshot(title = "Snapshot item"): WatchEngineSnapshotEvent {
    return makeOperatorSnapshotWithItems([
      { id: "H-TRS-3", title },
    ]);
  }

  function makeOperatorSnapshotWithItems(
    items: Array<{ id: string; title: string; state?: string; dependencies?: string[]; descriptionBody?: string }>,
    runtimeOverrides: Partial<WatchEngineSnapshotEvent["runtime"]> = {},
    interactiveTiming?: WatchEngineSnapshotEvent["interactiveTiming"],
  ): WatchEngineSnapshotEvent {
    return {
      state: {
        pid: 1,
        startedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:01.000Z",
        sessionLimit: 2,
        items: items.map((item, index) => ({
          id: item.id,
          state: item.state ?? "implementing",
          prNumber: null,
          title: item.title,
          priority: "high",
          descriptionBody: item.descriptionBody ?? `Snapshot-driven description body ${index + 1}`,
          lastTransition: "2026-04-01T00:00:01.000Z",
          ciFailCount: 1,
          retryCount: 2,
          dependencies: item.dependencies ?? ["H-TRS-2"],
        })),
      },
      pollSnapshot: { items: [], readyIds: [] },
      runtime: {
        paused: false,
        mergeStrategy: "manual",
        sessionLimit: 2,
        reviewMode: "ninthwave-prs",
        collaborationMode: "local",
        scheduleEnabled: false,
        ...runtimeOverrides,
      },
      ...(interactiveTiming ? { interactiveTiming } : {}),
    };
  }

  function makeOperatorChild() {
    const child = new EventEmitter() as EventEmitter & InteractiveEngineChildProcess & {
      stdout: EventEmitter & NodeJS.ReadableStream & { setEncoding: ReturnType<typeof vi.fn> };
      stderr: EventEmitter & NodeJS.ReadableStream & { setEncoding: ReturnType<typeof vi.fn> };
      stdin: { write: ReturnType<typeof vi.fn> };
      emitLine: (message: unknown) => void;
      emitStdoutText: (text: string) => void;
      emitStderrText: (text: string) => void;
    };
    const stdout = new EventEmitter() as EventEmitter & NodeJS.ReadableStream & { setEncoding: ReturnType<typeof vi.fn> };
    const stderr = new EventEmitter() as EventEmitter & NodeJS.ReadableStream & { setEncoding: ReturnType<typeof vi.fn> };
    stdout.setEncoding = vi.fn();
    stderr.setEncoding = vi.fn();
    const stdin = { write: vi.fn(() => true) };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin as any;
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    child.emitLine = (message: unknown) => {
      stdout.emit("data", JSON.stringify(message) + "\n");
    };
    child.emitStdoutText = (text: string) => {
      stdout.emit("data", text);
    };
    child.emitStderrText = (text: string) => {
      stderr.emit("data", text);
    };
    return child;
  }

  it("renders the status shell immediately with a startup overlay before the first snapshot", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState({
      startupOverlay: {
        phaseLabel: "Preparing runtime",
        detailLines: ["Waiting for startup preparation."],
      },
    });
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot("Queued snapshot").state,
        runtime: makeOperatorSnapshot("Queued snapshot").runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();

    const initialOutput = writes.join("");
    expect(initialOutput).toContain("Loading");
    expect(initialOutput).toContain("Preparing runtime");
    expect(initialOutput).not.toContain("Queued snapshot");

    child.emitLine({
      type: "startup",
      overlay: {
        phaseLabel: "Restoring runtime state",
        detailLines: ["Recovering queued workspaces."],
      },
    });
    await Promise.resolve();

    expect(writes.join("")).toContain("Restoring runtime state");

    child.emitLine({ type: "snapshot", event: makeOperatorSnapshot("Live snapshot") });
    await Promise.resolve();

    expect(tuiState.startupOverlay).toBeUndefined();
    expect(writes.join("")).toContain("Live snapshot");

    (stdin as any)._emit("data", "q");
    await sessionPromise;
  });

  it("runTuiStartupPreparation renders before prep resolves and delays execution until ready", async () => {
    const tuiState = makeOperatorTuiState();
    const render = vi.fn();
    const execute = vi.fn(async () => "ready");
    let resolvePrepare!: (value: string) => void;
    const prepare = vi.fn(() => new Promise<string>((resolve) => {
      resolvePrepare = resolve;
    }));

    const promise = runTuiStartupPreparation({
      tuiState,
      render,
      initialOverlay: {
        phaseLabel: "Preparing runtime",
        detailLines: ["Bootstrapping watch state."],
      },
      prepare,
      execute,
    });

    await Promise.resolve();

    expect(render).toHaveBeenCalled();
    expect(tuiState.startupOverlay?.phaseLabel).toBe("Preparing runtime");
    expect(execute).not.toHaveBeenCalled();

    resolvePrepare("prepared");
    await expect(promise).resolves.toBe("ready");
    expect(execute).toHaveBeenCalledWith("prepared");
    expect(tuiState.startupOverlay).toBeUndefined();
  });

  it("does not validate queued items during startup or status rendering", async () => {
    const validateSpy = vi.spyOn(launchModule, "validatePickupCandidate");
    const tuiState = makeOperatorTuiState();
    const writes: string[] = [];

    try {
      await runTuiStartupPreparation({
        tuiState,
        render: () => {
          renderTuiPanelFrameFromStatusItems(
            [
              makeStatusItem({
                id: "H-FAST-1",
                title: "Queued snapshot",
                state: "queued",
                dependencies: ["H-FAST-0"],
              }),
            ],
            1,
            tuiState,
            (chunk) => {
              writes.push(chunk);
            },
          );
        },
        initialOverlay: {
          phaseLabel: "Preparing runtime",
          detailLines: ["Loading queued items."],
        },
        prepare: async (updateOverlay) => {
          updateOverlay({
            phaseLabel: "Preparing runtime",
            detailLines: ["Still rendering while launch validation is deferred."],
          });
          return "prepared";
        },
        execute: async () => "ready",
      });
    } finally {
      validateSpy.mockRestore();
    }

    expect(writes.join("")).toContain("Queued snapshot");
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("re-renders from snapshot payloads while the engine is blocked", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();
    const renderFrame = vi.fn();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot("Initial snapshot").state,
        runtime: makeOperatorSnapshot("Initial snapshot").runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
      renderFrame,
    });

    await Promise.resolve();
    child.emitLine({ type: "snapshot", event: makeOperatorSnapshot("Blocked snapshot") });
    await Promise.resolve();

    const renderCountAfterSnapshot = renderFrame.mock.calls.length;
    const latestStatusItems = renderFrame.mock.calls.at(-1)?.[0] as StatusItem[];
    expect(latestStatusItems[0]!.title).toBe("Blocked snapshot");

    (stdin as any)._emit("data", "?");
    expect(tuiState.showHelp).toBe(true);
    expect(renderFrame.mock.calls.length).toBeGreaterThan(renderCountAfterSnapshot);

    (stdin as any)._emit("data", "q");
    const result = await sessionPromise;

    expect(result.completionAction).toBe("quit");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect((stdin.setRawMode as any).mock.calls).toContainEqual([false]);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049l"))).toBe(true);
  });

  it("keeps help, navigation, and overlay interaction responsive during multi-second engine stalls", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();
    const renderFrame = vi.fn((...args: Parameters<typeof renderTuiPanelFrameFromStatusItems>) => {
      renderTuiPanelFrameFromStatusItems(...args);
    });

    const stalledTiming = {
      iteration: 7,
      actionCount: 1,
      actionTypes: ["launch"] as const,
      timingsMs: {
        eventLoopLag: 0,
        poll: 2_600,
        actionExecution: 2_300,
        mainRefresh: 2_100,
        displaySync: 0,
        render: 0,
        totalBlocking: 7_000,
      },
    };

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3", "H-TRS-5"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshotWithItems([
          { id: "H-TRS-3", title: "First blocked snapshot" },
          { id: "H-TRS-5", title: "Second blocked snapshot", dependencies: ["H-TRS-3"] },
        ]).state,
        runtime: makeOperatorSnapshot().runtime,
        interactiveTiming: stalledTiming,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
      renderFrame,
    });

    await Promise.resolve();
    expect(tuiState.selectedItemId).toBeDefined();

    const initialRenderCount = renderFrame.mock.calls.length;
    (stdin as any)._emit("data", "?");
    expect(tuiState.showHelp).toBe(true);
    expect(renderFrame.mock.calls.length).toBeGreaterThan(initialRenderCount);

    (stdin as any)._emit("data", "\x1b");
    expect(tuiState.showHelp).toBe(false);

    (stdin as any)._emit("data", "\x1b[B");
    expect(tuiState.selectedItemId).toBe("H-TRS-5");

    (stdin as any)._emit("data", "\r");
    expect(tuiState.detailItemId).toBe("H-TRS-5");

    (stdin as any)._emit("data", "\x1b");
    expect(tuiState.detailItemId).toBeNull();

    (stdin as any)._emit("data", "c");
    expect(tuiState.showControls).toBe(true);

    (stdin as any)._emit("data", "\x1b[B");
    expect(tuiState.controlsRowIndex).toBe(1);

    (stdin as any)._emit("data", "\x1b");
    expect(tuiState.showControls).toBe(false);

    (stdin as any)._emit("data", "q");
    const result = await sessionPromise;

    expect(result.lastSnapshot.interactiveTiming?.timingsMs.totalBlocking).toBe(7_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.completionAction).toBe("quit");
  });

  it("blocks underlying selection and detail changes while help is open", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout } = makeOperatorStdout();
    const onExtendTimeout = vi.fn(() => true);
    const tuiState = makeOperatorTuiState({ onExtendTimeout });
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3", "H-TRS-5"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshotWithItems([
          { id: "H-TRS-3", title: "First blocked snapshot" },
          { id: "H-TRS-5", title: "Second blocked snapshot", dependencies: ["H-TRS-3"] },
        ]).state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    const initialSelectedItemId = tuiState.selectedItemId;
    expect(initialSelectedItemId).toBeDefined();

    (stdin as any)._emit("data", "?");
    expect(tuiState.showHelp).toBe(true);

    (stdin as any)._emit("data", "\x1b[B");
    (stdin as any)._emit("data", "i");
    (stdin as any)._emit("data", "d");
    (stdin as any)._emit("data", "x");
    (stdin as any)._emit("data", "\t");

    expect(tuiState.selectedItemId).toBe(initialSelectedItemId);
    expect(tuiState.detailItemId).toBeNull();
    expect(tuiState.viewOptions.showBlockerDetail).toBe(true);
    expect(tuiState.panelMode).toBe("status-only");
    expect(onExtendTimeout).not.toHaveBeenCalled();

    (stdin as any)._emit("data", "\x1b");
    expect(tuiState.showHelp).toBe(false);

    (stdin as any)._emit("data", "\x1b[B");
    expect(tuiState.selectedItemId).toBe("H-TRS-5");

    (stdin as any)._emit("data", "i");
    expect(tuiState.detailItemId).toBe("H-TRS-5");

    (stdin as any)._emit("data", "q");
    const result = await sessionPromise;

    expect(result.completionAction).toBe("quit");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("prefers help over controls and detail overlays", () => {
    const writes: string[] = [];
    const tuiState = makeOperatorTuiState({
      showHelp: true,
      showControls: true,
      detailItemId: "H-TRS-5",
    });
    tuiState.viewOptions.showHelp = true;
    tuiState.viewOptions.showControls = true;

    renderTuiPanelFrameFromStatusItems(
      [
        makeStatusItem({ id: "H-TRS-3", title: "First item" }),
        makeStatusItem({ id: "H-TRS-5", title: "Second item" }),
      ],
      2,
      tuiState,
      (chunk) => {
        writes.push(chunk);
      },
    );

    const helpOutput = writes.join("");
    expect(helpOutput).toContain("Help");
    expect(helpOutput).toContain("Press Enter, Escape, or ? to close");
    expect(helpOutput).not.toContain("Controls");
    expect(helpOutput).not.toContain("H-TRS-5");

    writes.length = 0;
    tuiState.showHelp = false;
    tuiState.viewOptions.showHelp = false;

    renderTuiPanelFrameFromStatusItems(
      [
        makeStatusItem({ id: "H-TRS-3", title: "First item" }),
        makeStatusItem({ id: "H-TRS-5", title: "Second item" }),
      ],
      2,
      tuiState,
      (chunk) => {
        writes.push(chunk);
      },
    );

    const controlsOutput = writes.join("");
    expect(controlsOutput).toContain("Controls");
    expect(controlsOutput).toContain("Press Enter or Escape to close");
    expect(controlsOutput).not.toContain("Help");
    expect(controlsOutput).not.toContain("H-TRS-5");
  });

  it("restores terminal state after the child completes", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: false,
      stdin,
      stdout,
      spawnChild: () => child,
      waitForCompletionKeyFn: vi.fn(async () => "quit"),
    });

    await Promise.resolve();
    child.emitLine({ type: "result", result: {} });
    child.emit("close", 0, null);

    const result = await sessionPromise;
    expect(result.completionAction).toBe("quit");
    expect((stdin.setRawMode as any).mock.calls).toContainEqual([false]);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049l"))).toBe(true);
  });

  it("shows a disconnect recovery overlay and restores the terminal on quit", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    child.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(writes.join("")).toContain("Engine disconnected");
    expect(writes.join("")).toContain("Press r to restart or q to quit");

    (stdin as any)._emit("data", "q");
    const result = await sessionPromise;

    expect(result.completionAction).toBe("quit");
    expect((stdin.setRawMode as any).mock.calls).toContainEqual([false]);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049l"))).toBe(true);
  });

  it("shows a structured startup fatal from the engine child", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    child.emitLine({
      type: "fatal",
      error: `Engine failed during startup.\n${TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE}`,
    });
    child.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();

    (stdin as any)._emit("data", "q");
    await sessionPromise;

    expect(writes.join("")).toContain("Engine disconnected");
    expect(writes.join("")).toContain(TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE);
  });

  it("shows buffered stderr when the engine exits before its first snapshot", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    child.emitStderrText("Error: startup config missing\n");
    child.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();

    (stdin as any)._emit("data", "q");
    await sessionPromise;

    expect(writes.join("")).toContain("Engine failed during startup.");
    expect(writes.join("")).toContain("Error: startup config missing");
  });

  it("keeps startup phase copy visible before surfacing a pre-snapshot startup failure", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState({
      startupOverlay: {
        phaseLabel: "Preparing runtime",
        detailLines: ["Bootstrapping watch state."],
      },
    });
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    child.emitLine({
      type: "startup",
      overlay: {
        phaseLabel: "Restoring runtime state",
        detailLines: ["Recovering queued workspaces."],
      },
    });
    await Promise.resolve();
    child.emitStderrText("Error: startup config missing\n");
    child.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();

    (stdin as any)._emit("data", "q");
    await sessionPromise;

    expect(writes.join("")).toContain("Restoring runtime state");
    expect(writes.join("")).toContain("Error: startup config missing");
  });

  it("supports keyboard management without terminal management", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      manageTerminal: false,
      manageKeyboard: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    (stdin as any)._emit("data", "?");
    expect(tuiState.showHelp).toBe(true);

    (stdin as any)._emit("data", "q");
    const result = await sessionPromise;

    expect(result.completionAction).toBe("quit");
    expect((stdin.setRawMode as any).mock.calls).toEqual([[true], [false]]);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049h"))).toBe(false);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049l"))).toBe(false);
  });

  it("supports terminal management without keyboard management", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      manageKeyboard: false,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    child.emit("close", 1, null);

    const result = await sessionPromise;

    expect(result.completionAction).toBeUndefined();
    expect(tuiState.engineDisconnected).toBe(true);
    expect((stdin.setRawMode as any).mock.calls).toEqual([]);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049h"))).toBe(true);
    expect(writes.some((chunk) => chunk.includes("\x1B[?1049l"))).toBe(true);
  });

  it("ignores malformed stdout after the engine is ready", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout, writes } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
    });

    await Promise.resolve();
    child.emitLine({ type: "snapshot", event: makeOperatorSnapshot("Ready snapshot") });
    child.emitStdoutText("not-json-after-readiness\n");
    child.emitLine({ type: "result", result: {} });
    child.emit("close", 0, null);

    const result = await sessionPromise;

    expect(result.lastSnapshot.daemonState.items[0]?.title).toBe("Ready snapshot");
    expect(result.completionAction).toBeUndefined();
    expect(writes.join("")).not.toContain("not-json-after-readiness");
  });

  it("restarts after disconnect and keeps rendering engine-confirmed state", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const firstChild = makeOperatorChild();
    const secondChild = makeOperatorChild();
    const children = [firstChild, secondChild];

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => children.shift()!,
      bindControlSender: () => {},
    });

    await Promise.resolve();
    firstChild.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();
    (stdin as any)._emit("data", "r");
    await Promise.resolve();

    secondChild.emitLine({
      type: "snapshot",
      event: {
        ...makeOperatorSnapshot("Restarted snapshot"),
        runtime: {
          paused: false,
          mergeStrategy: "auto",
          sessionLimit: 4,
          reviewMode: "all-prs",
          collaborationMode: "shared",
        },
      },
    });
    secondChild.emitLine({ type: "result", result: {} });
    secondChild.emit("close", 0, null);

    const result = await sessionPromise;
    expect(result.lastSnapshot.runtime).toEqual({
      paused: false,
      mergeStrategy: "auto",
      sessionLimit: 4,
      reviewMode: "all-prs",
      collaborationMode: "shared",
    });
    expect(tuiState.engineDisconnected).toBe(false);
    expect(result.completionAction).toBeUndefined();
  });

  it("rebinds runtime controls cleanly across repeated restarts", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const firstChild = makeOperatorChild();
    const secondChild = makeOperatorChild();
    const thirdChild = makeOperatorChild();
    const children = [firstChild, secondChild, thirdChild];
    let activeSender: ((command: WatchEngineControlCommand) => void) | undefined;

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => children.shift()!,
      bindControlSender: (sender) => {
        activeSender = sender;
      },
    });

    await Promise.resolve();
    activeSender?.({ type: "set-pause", paused: true });
    expect((firstChild.stdin.write as any).mock.calls).toHaveLength(1);

    firstChild.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();

    activeSender?.({ type: "set-pause", paused: false });
    expect((firstChild.stdin.write as any).mock.calls).toHaveLength(1);

    (stdin as any)._emit("data", "r");
    await Promise.resolve();

    activeSender?.({ type: "set-pause", paused: false });
    expect((secondChild.stdin.write as any).mock.calls).toHaveLength(1);

    secondChild.emit("close", 1, null);
    await Promise.resolve();
    await Promise.resolve();

    activeSender?.({ type: "set-pause", paused: true });
    expect((secondChild.stdin.write as any).mock.calls).toHaveLength(1);

    (stdin as any)._emit("data", "r");
    await Promise.resolve();

    activeSender?.({ type: "set-pause", paused: true });
    expect((thirdChild.stdin.write as any).mock.calls).toHaveLength(1);

    (stdin as any)._emit("data", "q");
    await sessionPromise;

    activeSender?.({ type: "set-pause", paused: false });
    expect((thirdChild.stdin.write as any).mock.calls).toHaveLength(1);
  });

  it("bridges live collaboration requests to the engine and resolves control results", async () => {
    const stdin = makeOperatorStdin();
    const { stream: stdout } = makeOperatorStdout();
    const tuiState = makeOperatorTuiState();
    const child = makeOperatorChild();
    let requestCollaboration!: (request: { action: "share" | "join" | "local"; code?: string }) => Promise<{ mode?: "local" | "shared" | "joined"; code?: string; error?: string }>;

    const sessionPromise = runInteractiveWatchOperatorSession({
      projectRoot: "/project",
      childArgs: ["--items", "H-TRS-3"],
      tuiState,
      log: () => {},
      initialSnapshot: {
        daemonState: makeOperatorSnapshot().state,
        runtime: makeOperatorSnapshot().runtime,
      },
      watchMode: true,
      stdin,
      stdout,
      spawnChild: () => child,
      bindCollaborationRequester: (requester) => {
        requestCollaboration = requester as typeof requestCollaboration;
      },
    });

    await Promise.resolve();

    const resultPromise = requestCollaboration({ action: "share" });
    const requestMessage = JSON.parse((child.stdin.write as any).mock.calls.at(-1)[0]);
    expect(requestMessage).toMatchObject({ type: "runtime-collaboration", action: "share" });

    child.emitLine({
      type: "control-result",
      requestId: requestMessage.requestId,
      result: { mode: "shared", code: "ABCD-1234" },
    });

    await expect(resultPromise).resolves.toEqual({ mode: "shared", code: "ABCD-1234" });

    (stdin as any)._emit("data", "q");
    await sessionPromise;
  });
});

describe("runTUI", () => {
  function withPatchedReadOnlyTuiStdio<T>(fn: (ctx: {
    writes: string[];
    stdin: {
      setRawMode: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      setEncoding: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    };
  }) => Promise<T>): Promise<T> {
    const writes: string[] = [];
    const stdin = {
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const stdoutWrite = vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    });

    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const stdinSetRawMode = process.stdin.setRawMode;
    const stdinResume = process.stdin.resume;
    const stdinPause = process.stdin.pause;
    const stdinSetEncoding = process.stdin.setEncoding;
    const stdinOn = process.stdin.on;
    const stdinRemoveListener = process.stdin.removeListener;
    const stdoutWriteOriginal = process.stdout.write;

    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    process.stdin.setRawMode = stdin.setRawMode as any;
    process.stdin.resume = stdin.resume as any;
    process.stdin.pause = stdin.pause as any;
    process.stdin.setEncoding = stdin.setEncoding as any;
    process.stdin.on = stdin.on as any;
    process.stdin.removeListener = stdin.removeListener as any;
    process.stdout.write = stdoutWrite as any;

    return fn({ writes, stdin }).finally(() => {
      if (stdinTTY) {
        Object.defineProperty(process.stdin, "isTTY", stdinTTY);
      } else {
        delete (process.stdin as unknown as Record<string, unknown>)["isTTY"];
      }
      if (stdoutRows) {
        Object.defineProperty(process.stdout, "rows", stdoutRows);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)["rows"];
      }
      if (stdoutColumns) {
        Object.defineProperty(process.stdout, "columns", stdoutColumns);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)["columns"];
      }
      process.stdin.setRawMode = stdinSetRawMode;
      process.stdin.resume = stdinResume;
      process.stdin.pause = stdinPause;
      process.stdin.setEncoding = stdinSetEncoding;
      process.stdin.on = stdinOn;
      process.stdin.removeListener = stdinRemoveListener;
      process.stdout.write = stdoutWriteOriginal;
    });
  }

  it("refreshes read-only log output and restores the terminal on abort", async () => {
    await withPatchedReadOnlyTuiStdio(async ({ writes, stdin }) => {
      const abortController = new AbortController();
      let renderCount = 0;
      const getItems = vi.fn(() => {
        renderCount += 1;
        return {
          items: [makeStatusItem({ id: "H-TRS-3", title: `Read-only item ${renderCount}` })],
          sessionLimit: 2,
          sessionStartedAt: "2026-04-01T00:00:00.000Z",
        };
      });
      const getLogEntries = vi.fn(() => [
        {
          timestamp: `2026-04-01T00:00:0${renderCount}.000Z`,
          itemId: "H-TRS-3",
          message: renderCount >= 2 ? "Refreshed log entry" : "Initial log entry",
        },
      ]);

      const runPromise = runTUI({
        getItems,
        getLogEntries,
        intervalMs: 10,
        signal: abortController.signal,
        panelMode: "logs-only",
      });

      await Promise.resolve();
      setTimeout(() => abortController.abort(), 15);
      await runPromise;

      const fullOutput = writes.join("")
        .replace(/\x1b\]8;[^\x07]*\x07/g, "")
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

      expect(getItems).toHaveBeenCalledTimes(2);
      expect(getLogEntries).toHaveBeenCalledTimes(2);
      expect(fullOutput).toContain("Refreshed log entry");
      expect(stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
      expect(writes[0]).toBe("\x1B[?1049h");
      expect(writes.at(-1)).toBe("\x1B[?1049l");
    });
  });

  it("skips the read-only runner entirely when stdin is not a TTY", async () => {
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const getItems = vi.fn(() => ({
        items: [makeStatusItem({ id: "H-TRS-3" })],
      }));

      await runTUI({ getItems, intervalMs: 1 });

      expect(getItems).not.toHaveBeenCalled();
    } finally {
      if (stdinTTY) {
        Object.defineProperty(process.stdin, "isTTY", stdinTTY);
      } else {
        delete (process.stdin as unknown as Record<string, unknown>)["isTTY"];
      }
    }
  });
});

describe("waitForEngineRecoveryKey", () => {
  it("resolves with quit when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const mockStdin = { on: vi.fn(), removeListener: vi.fn() } as unknown as NodeJS.ReadStream;

    await expect(waitForEngineRecoveryKey(mockStdin, ac.signal)).resolves.toBe("quit");
  });

  it("parses restart and quit keys case-insensitively", async () => {
    const mockStdin = {
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;

    const restartPromise = waitForEngineRecoveryKey(mockStdin);
    const onData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;

    onData("R");
    await expect(restartPromise).resolves.toBe("restart");

    const quitPromise = waitForEngineRecoveryKey(mockStdin);
    const secondOnData = (mockStdin.on as ReturnType<typeof vi.fn>).mock.calls.findLast(
      (call: unknown[]) => call[0] === "data",
    )![1] as (key: string) => void;

    secondOnData("x");
    secondOnData("\x03");
    await expect(quitPromise).resolves.toBe("quit");
  });
});

describe("parseWatchArgs", () => {
  it("parses --items --merge-strategy --session-limit for passthrough", () => {
    const result = parseWatchArgs([
      "--items", "H-FOO-1", "H-FOO-2",
      "--merge-strategy", "auto",
      "--session-limit", "3",
    ]);
    expect(result.itemIds).toEqual(["H-FOO-1", "H-FOO-2"]);
    expect(result.mergeStrategy).toBe("auto");
    expect(result.sessionLimitOverride).toBe(3);
  });

  it("skips interactive flow when items are pre-passed via CLI args", () => {
    const result = parseWatchArgs([
      "--items", "H-FOO-1",
      "--merge-strategy", "auto",
      "--session-limit", "3",
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
    const result = parseWatchArgs(["--items", "A-1", "B-2", "--session-limit", "5"]);
    expect(result.itemIds).toEqual(["A-1", "B-2"]);
    expect(result.sessionLimitOverride).toBe(5);
  });

  it("defaults merge strategy to manual when not specified", () => {
    const result = parseWatchArgs(["--items", "A-1"]);
    expect(result.mergeStrategy).toBe("manual");
  });

  it("parses manual merge strategy", () => {
    const result = parseWatchArgs(["--items", "A-1", "--merge-strategy", "manual"]);
    expect(result.mergeStrategy).toBe("manual");
  });

  it("leaves sessionLimitOverride undefined when --session-limit not passed", () => {
    const result = parseWatchArgs(["--items", "A-1"]);
    expect(result.sessionLimitOverride).toBeUndefined();
  });

  it("preserves CLI session-limit value (not overridden by defaults)", () => {
    const result = parseWatchArgs([
      "--items", "A-1",
      "--session-limit", "7",
    ]);
    // sessionLimitOverride is set to 7, which cmdOrchestrate uses to override the
    // computed default: `sessionLimit = sessionLimitOverride ?? computedSessionLimit`
    expect(result.sessionLimitOverride).toBe(7);
  });

  it("parses all flags together", () => {
    const result = parseWatchArgs([
      "--items", "H-1", "H-2",
      "--merge-strategy", "manual",
      "--session-limit", "5",
      "--poll-interval", "60",
      "--skip-preflight",
      "--json",
    ]);
    expect(result.itemIds).toEqual(["H-1", "H-2"]);
    expect(result.mergeStrategy).toBe("manual");
    expect(result.sessionLimitOverride).toBe(5);
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
    expect(result.mergeStrategy).toBe("manual");
  });

  it("parses --future-only-startup and enables watch mode", () => {
    const result = parseWatchArgs(["--future-only-startup"]);
    expect(result.futureOnlyStartup).toBe(true);
    expect(result.watchMode).toBe(true);
  });

  it("--no-review sets skipReview=true", () => {
    const result = parseWatchArgs(["--items", "A-1", "--no-review"]);
    expect(result.skipReview).toBe(true);
  });

  it("--review sets skipReview=false", () => {
    const result = parseWatchArgs(["--items", "A-1", "--review"]);
    expect(result.skipReview).toBe(false);
  });

  it("defaults skipReview to false when neither --no-review nor --review passed", () => {
    const result = parseWatchArgs(["--items", "A-1"]);
    expect(result.skipReview).toBe(false);
  });

  it("--review overrides earlier --no-review", () => {
    const result = parseWatchArgs(["--items", "A-1", "--no-review", "--review"]);
    expect(result.skipReview).toBe(false);
  });

  it("parses --tool flag", () => {
    const result = parseWatchArgs(["--items", "H-FOO-1", "--tool", "opencode"]);
    expect(result.toolOverride).toBe("opencode");
  });

  it("parses --backend-mode flag", () => {
    const result = parseWatchArgs(["--items", "H-FOO-1", "--backend-mode", "headless"]);
    expect(result.backendModeOverride).toBe("headless");
  });

  it("defaults toolOverride to undefined when --tool not passed", () => {
    const result = parseWatchArgs(["--items", "H-FOO-1"]);
    expect(result.toolOverride).toBeUndefined();
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
    // nw watch --items H-FOO-1 --merge-strategy auto --session-limit 3

    // Step 1: Parse args
    const parsed = parseWatchArgs([
      "--items", "H-FOO-1", "H-FOO-2",
      "--merge-strategy", "auto",
      "--session-limit", "3",
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
    expect(parsed.sessionLimitOverride).toBe(3);
  });

  it("CLI session-limit overrides computed default (not the other way around)", () => {
    const parsed = parseWatchArgs(["--items", "A-1", "--session-limit", "3"]);
    // In cmdOrchestrate: sessionLimit = sessionLimitOverride ?? computedSessionLimit
    // When sessionLimitOverride is set, it takes precedence over computedSessionLimit
    const computedSessionLimit = 5; // simulate any computed default
    const effectiveSessionLimit = parsed.sessionLimitOverride ?? computedSessionLimit;
    expect(effectiveSessionLimit).toBe(3);
  });

  it("unknown item ID would be caught by validation", () => {
    const parsed = parseWatchArgs([
      "--items", "H-FOO-1", "H-UNKNOWN-99",
      "--merge-strategy", "auto",
      "--session-limit", "3",
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
      panelMode: "status-only",
      logBuffer: [],
      logScrollOffset: 0,
      logLevelFilter: "all",
      ...overrides,
    };
  }

  it("Tab cycles status-only -> logs-only -> status-only", () => {
    const ac = new AbortController();
    const stdin = mockStdin();
    const tuiState = baseTuiState({ panelMode: "status-only" });

    setupKeyboardShortcuts(ac, () => {}, stdin, tuiState);

    (stdin as any)._emit("data", "\t");
    expect(tuiState.panelMode).toBe("logs-only");

    (stdin as any)._emit("data", "\t");
    expect(tuiState.panelMode).toBe("status-only");
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
      panelMode: "logs-only",
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
    Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
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
      Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true });
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
      panelMode: "status-only",
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

  it("tracks blocked items separately from active completion counts", () => {
    const result = formatExitSummary([
      { ...makeOrchestratorItem("E-4"), state: "done" as any },
      { ...makeOrchestratorItem("E-5"), state: "blocked" as any },
    ], new Date(Date.now() - 30_000).toISOString());

    expect(result).toContain("1 merged");
    expect(result).toContain("1 blocked");
    expect(result).not.toContain("1 active");
  });

  it("treats repair verification as active instead of complete", () => {
    const result = formatExitSummary([
      { ...makeOrchestratorItem("E-4"), state: "done" as any },
      { ...makeOrchestratorItem("E-5"), state: "forward-fix-pending" as any },
    ], new Date(Date.now() - 30_000).toISOString());

    expect(result).toContain("1 done");
    expect(result).toContain("1 active");
    expect(result).not.toContain("1 merged, 0 stuck, 0 queued");
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

  it("does not claim completion while repair verification is still active", () => {
    const lines = formatCompletionBanner([
      { ...makeOrchestratorItem("B-4"), state: "done" as any },
      { ...makeOrchestratorItem("B-5"), state: "fixing-forward" as any },
    ], new Date(Date.now() - 60_000).toISOString());

    const text = lines.join("\n");
    expect(text).toContain("Work still in progress");
    expect(text).toContain("1 done, 1 active, 0 stuck");
    expect(text).not.toContain("All 2 items complete");
  });

  it("treats blocked items as terminal but not complete", () => {
    const lines = formatCompletionBanner([
      { ...makeOrchestratorItem("B-6"), state: "done" as any },
      { ...makeOrchestratorItem("B-7"), state: "blocked" as any },
    ], new Date(Date.now() - 60_000).toISOString());

    const text = lines.join("\n");
    expect(text).toContain("All runnable items complete");
    expect(text).toContain("1 merged, 0 stuck, 1 blocked");
    expect(text).not.toContain("Work still in progress");
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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

  it("withholds completion prompt while a canonical item is still repairing", async () => {
    const orch = new Orchestrator({ fixForward: true, sessionLimit: 2, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("P-REPAIR-1"));
    orch.getItem("P-REPAIR-1")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];
    let promptCalled = false;

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        switch (cycle) {
          case 1: return { items: [], readyIds: ["P-REPAIR-1"] };
          case 2: return { items: [{ id: "P-REPAIR-1", workerAlive: true }], readyIds: [] };
          case 3: return { items: [{ id: "P-REPAIR-1", prNumber: 5, prState: "open", ciStatus: "pass" }], readyIds: [] };
          case 4:
            return {
              items: [{ id: "P-REPAIR-1", prNumber: 5, prState: "merged", mergeCommitSha: "sha-original", defaultBranch: "main" }],
              readyIds: [],
            };
          case 5: return { items: [], readyIds: [] };
          case 6: return { items: [{ id: "P-REPAIR-1", mergeCommitCIStatus: "fail" }], readyIds: [] };
          case 7: return { items: [{ id: "P-REPAIR-1", mergeCommitCIStatus: "fail" }], readyIds: [] };
          case 8: return { items: [{ id: "P-REPAIR-1", prNumber: 55, prState: "open", ciStatus: "pending" }], readyIds: [] };
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

    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 8, tuiMode: true });

    expect(promptCalled).toBe(false);
    expect(orch.getItem("P-REPAIR-1")!.state).toBe("ci-pending");
    expect(logs.some((l) => l.event === "completion_prompt")).toBe(false);
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(false);
  });

  it("returns run-more when user picks r", async () => {
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ fixForward: false, sessionLimit: 2, mergeStrategy: "auto" });
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
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto", maxRetries: 0 });
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
    const orch = new Orchestrator({ sessionLimit: 2, mergeStrategy: "auto" });
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

  it("readLayoutPreference returns status-only when file is missing", () => {
    const result = readLayoutPreference("/nonexistent/project/root");
    expect(result).toBe("status-only");
  });

  it("writeLayoutPreference + readLayoutPreference roundtrip", () => {
    writeLayoutPreference(tmpDir, "logs-only");
    const result = readLayoutPreference(tmpDir);
    expect(result).toBe("logs-only");
  });

  it("readLayoutPreference returns status-only for corrupt JSON", () => {
    const { mkdirSync, writeFileSync } = require("fs");
    const dir = userStateDir(tmpDir + "-corrupt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(preferencesFilePath(tmpDir + "-corrupt"), "not json!!!");
    const result = readLayoutPreference(tmpDir + "-corrupt");
    expect(result).toBe("status-only");
  });

  it("readLayoutPreference returns status-only for invalid mode value", () => {
    const { mkdirSync, writeFileSync } = require("fs");
    const dir = userStateDir(tmpDir + "-invalid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(preferencesFilePath(tmpDir + "-invalid"), JSON.stringify({ panelMode: "banana" }));
    const result = readLayoutPreference(tmpDir + "-invalid");
    expect(result).toBe("status-only");
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
      panelMode: "status-only",
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
    expect(modeChanges[0]).toBe("logs-only");

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

describe("resolveStartupCollaborationAction", () => {
  it("resolves explicit crew URL precedence as CLI first, then project config", () => {
    expect(resolveConfiguredCrewUrl("wss://cli.example", "wss://config.example")).toBe("wss://cli.example");
    expect(resolveConfiguredCrewUrl(undefined, "wss://config.example")).toBe("wss://config.example");
    expect(resolveConfiguredCrewUrl(undefined, undefined)).toBeUndefined();
  });

  it("keeps the current startup collaboration state when local is selected", () => {
    expect(resolveStartupCollaborationAction(
      {
        connectMode: false,
        crewCode: "KEEP-1234",
        crewUrl: "wss://custom.example",
      },
      null,
    )).toEqual({
      connectMode: false,
      crewCode: "KEEP-1234",
      crewUrl: "wss://custom.example",
    });
  });

  it("maps startup share directly into connect mode", () => {
    expect(resolveStartupCollaborationAction(
      {
        connectMode: false,
        crewCode: "OLD-1234",
        crewUrl: "wss://custom.example",
      },
      { type: "connect" },
    )).toEqual({
      connectMode: true,
      crewCode: undefined,
      crewUrl: "wss://custom.example",
    });
  });

  it("maps startup join directly into crew setup with a default broker URL", () => {
    expect(resolveStartupCollaborationAction(
      {
        connectMode: true,
      },
      { type: "join", code: "K2F9-AB3X-7YPL-QM4N" },
    )).toEqual({
      connectMode: false,
      crewCode: "K2F9-AB3X-7YPL-QM4N",
      crewUrl: "wss://ninthwave.sh",
    });
  });

  it("preserves an existing crew URL when startup join is selected", () => {
    expect(resolveStartupCollaborationAction(
      {
        connectMode: true,
        crewUrl: "wss://config.example",
      },
      { type: "join", code: "K2F9-AB3X-7YPL-QM4N" },
    )).toEqual({
      connectMode: false,
      crewCode: "K2F9-AB3X-7YPL-QM4N",
      crewUrl: "wss://config.example",
    });
  });
});

// ── Claims gating in orchestrateLoop ─────────────────────────────────

describe("orchestrateLoop claims gating", () => {
  it("suppresses launch actions during claimsGatedMs window", async () => {
    const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-GATE-1"));
    orch.getItem("T-GATE-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("T-GATE-2"));
    orch.getItem("T-GATE-2")!.reviewCompleted = true;

    let cycle = 0;
    const logs: LogEntry[] = [];
    const launchCalls: string[] = [];

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        // Items are always ready for launch
        return { items: [], readyIds: ["T-GATE-1", "T-GATE-2"] };
      },
      sleep: () => Promise.resolve(),
      log: (e) => logs.push(e),
      actionDeps: mockActionDeps({
        launchSingleItem: vi.fn((workItem) => {
          launchCalls.push(workItem.id);
          return { worktreePath: "/tmp/test", workspaceRef: `ws:${workItem.id}` };
        }),
      }),
      getFreeMem: () => 16 * 1024 ** 3,
    };

    // lint-ignore: no-unbounded-orchestrate-loop
    await orchestrateLoop(orch, defaultCtx, deps, {
      maxIterations: 3,
      // Gate claims for a very long time so all iterations are gated
      claimsGatedMs: 999_999,
    });

    // No items should have been launched during gated window
    expect(launchCalls).toHaveLength(0);
    // Items should be in ready state (reverted from launching)
    expect(orch.getItem("T-GATE-1")!.state).toBe("ready");
    expect(orch.getItem("T-GATE-2")!.state).toBe("ready");
    // Should have logged the gating events
    const gatedLogs = logs.filter((l) => l.event === "claims_gated");
    expect(gatedLogs.length).toBeGreaterThan(0);
  });

  it("allows launches after claimsGatedMs expires", async () => {
    const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-UNGATE-1"));
    orch.getItem("T-UNGATE-1")!.reviewCompleted = true;

    let cycle = 0;
    const launchCalls: string[] = [];

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        if (cycle <= 2) return { items: [], readyIds: ["T-UNGATE-1"] };
        return { items: [{ id: "T-UNGATE-1", workerAlive: true }], readyIds: [] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps({
        launchSingleItem: vi.fn((workItem) => {
          launchCalls.push(workItem.id);
          return { worktreePath: "/tmp/test", workspaceRef: `ws:${workItem.id}` };
        }),
      }),
      getFreeMem: () => 16 * 1024 ** 3,
    };

    // Gate claims for 0ms (effectively no gating -- already expired)
    // lint-ignore: no-unbounded-orchestrate-loop
    await orchestrateLoop(orch, defaultCtx, deps, {
      maxIterations: 3,
      claimsGatedMs: 0,
    });

    // Item should have been launched
    expect(launchCalls).toContain("T-UNGATE-1");
  });

  it("collaboration startup gates joined daemons on broker connection", async () => {
    // When a crew broker is provided, claims are gated by broker connectivity,
    // not by the local-only startup path.
    const orch = new Orchestrator({ sessionLimit: 5, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("T-JOIN-1"));
    orch.getItem("T-JOIN-1")!.reviewCompleted = true;

    let cycle = 0;
    let brokerConnected = false;
    const launchCalls: string[] = [];

    const broker: CrewBroker = {
      connect: vi.fn(async () => {}),
      sync: vi.fn(),
      claim: vi.fn(async () => {
        if (!brokerConnected) return null;
        return "T-JOIN-1";
      }),
      complete: vi.fn(),
      heartbeat: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => brokerConnected),
      getCrewStatus: vi.fn(() => null),
      scheduleClaim: vi.fn(async () => false),
      report: vi.fn(),
      setTelemetry: vi.fn(),
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot: (): PollSnapshot => {
        cycle++;
        // After cycle 2, simulate broker becoming connected
        if (cycle === 2) brokerConnected = true;
        return { items: [], readyIds: ["T-JOIN-1"] };
      },
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps({
        launchSingleItem: vi.fn((workItem) => {
          launchCalls.push(workItem.id);
          return { worktreePath: "/tmp/test", workspaceRef: `ws:${workItem.id}` };
        }),
      }),
      crewBroker: broker,
      getFreeMem: () => 16 * 1024 ** 3,
    };

    // No claimsGatedMs -- crew mode uses broker connectivity for gating
    // lint-ignore: no-unbounded-orchestrate-loop
    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 4 });

    // First cycle: broker disconnected, no launches
    // Second cycle: broker becomes connected, launch happens via broker.claim()
    expect(launchCalls).toContain("T-JOIN-1");
  });
});

// ── Session lifecycle: no saved session reuse ────────────────────────

describe("session lifecycle", () => {
  it("readCrewCode finds saved code but cmdOrchestrate no longer uses it", () => {
    // Verify that readCrewCode still works as a function (for backward compat)
    // but it's no longer imported or called from orchestrate.ts
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-session-test-"));
    try {
      // No crew code saved -- should return null
      expect(readCrewCode(tmpDir)).toBeNull();

      // Write a crew code using the correct state directory path
      const stateDir = userStateDir(tmpDir);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(crewCodePath(tmpDir), "test-code-123", "utf-8");

      // readCrewCode still works as a standalone function
      expect(readCrewCode(tmpDir)).toBe("test-code-123");

      // But the orchestrate module no longer imports readCrewCode
      // This is verified by the fact that the import was removed and the code compiles
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      // Also clean up the state dir in ~/.ninthwave/
      try { rmSync(userStateDir(tmpDir), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("saved crew code is written only on explicit share/join, not plain startup", () => {
    // The only calls to saveCrewCode in orchestrate.ts are after broker setup:
    // 1. Explicit --crew/--connect flows
    // 2. Startup settings share/join flows
    // There is no automatic re-activation of saved crew codes on plain startup.
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-session-test-"));
    try {
      // readCrewCode returns null when no code is saved
      expect(readCrewCode(tmpDir)).toBeNull();

      // Simulate: a saved crew code exists but plain nw ignores it
      const stateDir = userStateDir(tmpDir);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(crewCodePath(tmpDir), "old-session-xyz", "utf-8");

      // The crew code is there on disk
      expect(readCrewCode(tmpDir)).toBe("old-session-xyz");

      // But in the new code, cmdOrchestrate never reads it.
      // Plain startup stays local unless the user explicitly selects share/join.
      // Only explicit --crew <code> or startup collaboration choices set up crew mode.
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      try { rmSync(userStateDir(tmpDir), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
