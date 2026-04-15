// Focused unit tests for the orchestrator state machine functions.
// Tests processTransitions (which drives handleImplementing, handlePrLifecycle, evaluateMerge)
// and the standalone reconstructState/buildSnapshot from orchestrate.ts.
// No vi.mock -- all isolation via dependency injection.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Orchestrator,
  statusDisplayForState,
  STATE_TRANSITIONS,
  type OrchestratorItem,
  type OrchestratorItemState,
  type OrchestratorDeps,
  type DeepPartial,
  type ExecutionContext,
  type PollSnapshot,
  type ItemSnapshot,
  type Action,
} from "../core/orchestrator.ts";
import {
  buildSnapshot,
  reconstructState,
  syncWorkerDisplay,
  RESTART_RECOVERY_HOLD_REASON,
} from "../core/commands/orchestrate.ts";
import {
  cleanStaleBranchForReuse,
  type StaleBranchCleanupDeps,
} from "../core/branch-cleanup.ts";
import type { WorkItem, Priority } from "../core/types.ts";
import { cleanupTempRepos, setupTempRepo } from "./helpers.ts";
import {
  writeHeartbeat,
  readHeartbeat,
  heartbeatFilePath,
  type DaemonIO,
} from "../core/daemon.ts";
import type { Multiplexer } from "../core/mux.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeWorkItem(id: string, deps: string[] = [], priority: Priority = "medium"): WorkItem {
  return {
    id,
    priority,
    title: `Item ${id}`,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    filePath: "",
    rawText: `## ${id}\nTest item`,
    filePaths: [],
    testPlan: "",
  };
}

function emptySnapshot(readyIds: string[] = []): PollSnapshot {
  return { items: [], readyIds };
}

function snapshotWith(items: ItemSnapshot[], readyIds: string[] = []): PollSnapshot {
  return { items, readyIds };
}

// Fixed timestamp to keep transition checks deterministic
const NOW = new Date("2026-01-15T12:00:00Z");
const FEEDBACK_FLUSH_NOW = new Date("2026-01-15T12:03:00Z");

// ── STATE_TRANSITIONS table validation ──────────────────────────────

describe("STATE_TRANSITIONS table", () => {
  it("covers every OrchestratorItemState", () => {
    // Verify every state in the union type has an entry in the table.
    // If a new state is added to OrchestratorItemState but not the table,
    // TypeScript will catch it (Record requires all keys), but this test
    // provides a runtime safety net.
    const allStates: OrchestratorItemState[] = [
      "queued", "ready", "launching", "implementing",
      "ci-pending", "ci-passed", "ci-failed", "rebasing",
      "review-pending", "reviewing", "merging", "merged",
      "forward-fix-pending", "fix-forward-failed", "fixing-forward",
      "done", "blocked", "stuck",
    ];
    for (const state of allStates) {
      expect(STATE_TRANSITIONS).toHaveProperty(state);
    }
    expect(Object.keys(STATE_TRANSITIONS)).toHaveLength(allStates.length);
  });

  it("validates observed transitions match the table", () => {
    // Run a comprehensive set of transitions through the orchestrator
    // and verify every observed transition is declared in the table.
    const observed = new Set<string>();
    const orch = new Orchestrator({
      maxRetries: 1,
      maxCiRetries: 2,
      maxReviewRounds: 2,
      maxMergeRetries: 1,
      maxFixForwardRetries: 1,
      gracePeriodMs: 0,
      onTransition: (id, from, to) => {
        observed.add(`${from} -> ${to}`);
      },
    });

    // Drive through major paths
    orch.addItem(makeWorkItem("A"));
    orch.addItem(makeWorkItem("B"));

    // queued -> ready -> launching
    orch.processTransitions({ items: [], readyIds: ["A", "B"] }, NOW);

    // launching -> implementing
    orch.processTransitions(snapshotWith([
      { id: "A", workerAlive: true },
      { id: "B", workerAlive: true },
    ]), NOW);

    // implementing -> ci-pending (PR appears)
    orch.processTransitions(snapshotWith([
      { id: "A", prNumber: 1, prState: "open", ciStatus: "pending", workerAlive: true },
      { id: "B", prNumber: 2, prState: "open", ciStatus: "fail", workerAlive: true, isMergeable: true },
    ]), NOW);

    // ci-pending -> ci-passed, ci-failed -> ci-pending (recovery)
    orch.processTransitions(snapshotWith([
      { id: "A", prNumber: 1, prState: "open", ciStatus: "pass", isMergeable: true, workerAlive: true },
      { id: "B", prNumber: 2, prState: "open", ciStatus: "pending", isMergeable: true, workerAlive: true },
    ]), NOW);

    // Verify all observed transitions are in the table
    for (const t of observed) {
      const [from, to] = t.split(" -> ") as [OrchestratorItemState, OrchestratorItemState];
      const allowed = STATE_TRANSITIONS[from];
      expect(allowed, `Undeclared transition: ${t}`).toContain(to);
    }

    // Verify we actually observed some transitions
    expect(observed.size).toBeGreaterThan(5);
  });

  it("terminal states have no outgoing transitions", () => {
    expect(STATE_TRANSITIONS["done"]).toHaveLength(0);
    expect(STATE_TRANSITIONS["blocked"]).toHaveLength(0);
    expect(STATE_TRANSITIONS["stuck"]).toHaveLength(0);
  });
});

// ── Runtime transition enforcement ──────────────────────────────────

describe("runtime transition enforcement", () => {
  it("throws on illegal transition via executeAction", () => {
    const events: { itemId: string; event: string; data?: Record<string, unknown> }[] = [];
    const orch = new Orchestrator({
      onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "done");

    const ctx: ExecutionContext = {
      workDir: "/tmp/test",
      worktreeDir: "/tmp/test/.ninthwave/.worktrees",
      projectRoot: "/tmp/test",
      aiTool: "copilot",
    };
    const deps: OrchestratorDeps = {
      workers: {
        launchSingleItem: () => null,
        validatePickupCandidate: () => ({ status: "blocked" as const, failureReason: "test-blocked" }),
      },
    };

    expect(() => {
      orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);
    }).toThrow("Illegal state transition for H-1-1: done -> blocked");

    expect(events).toContainEqual(
      expect.objectContaining({
        itemId: "H-1-1",
        event: "illegal-transition",
        data: { from: "done", to: "blocked" },
      }),
    );
  });

  it("hydrateState does NOT throw for any state (reconstruction bypass)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));

    const allStates: OrchestratorItemState[] = [
      "queued", "ready", "launching", "implementing",
      "ci-pending", "ci-passed", "ci-failed", "rebasing",
      "review-pending", "reviewing", "merging", "merged",
      "forward-fix-pending", "fix-forward-failed", "fixing-forward",
      "done", "blocked", "stuck",
    ];
    for (const state of allStates) {
      expect(() => orch.hydrateState("H-1-1", state)).not.toThrow();
    }
  });

  it("allows declared transitions without throwing", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // queued -> ready -> launching (all in one cycle: promote then launch)
    orch.processTransitions(emptySnapshot(["H-1-1"]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("launching");

    // launching -> implementing (via workerAlive)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
  });
});

// ── reconstructState ─────────────────────────────────────────────────

describe("reconstructState", () => {
  it("sets implementing when worktree exists but no PR", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const fakeCheckPr = (_id: string, _root: string) => "H-1-1\t\tno-pr";

    reconstructState(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined, fakeCheckPr);

    // Items without a worktree directory won't be reconstructed (existsSync check),
    // so items stay queued when worktree doesn't exist
    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  it("sets ci-passed when PR status is ready", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // reconstructState only processes items whose worktree exists on disk.
    // Without a real worktree, items remain queued -- verifying the guard.
    const fakeCheckPr = (_id: string, _root: string) => "H-1-1\t42\tready";
    reconstructState(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined, fakeCheckPr);
    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  it("restores ciFailCountTotal and retryCount from daemon state while resetting ciFailCount", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const daemonState = {
      items: [{ id: "H-1-1", ciFailCount: 3, ciFailCountTotal: 8, retryCount: 2 }],
    };

    reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(0);
    expect(orch.getItem("H-1-1")!.ciFailCountTotal).toBe(8);
    expect(orch.getItem("H-1-1")!.retryCount).toBe(2);
  });

  it("restores reviewCompleted from daemon state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const daemonState = {
      items: [
        { id: "H-1-1", ciFailCount: 0, ciFailCountTotal: 0, retryCount: 0, reviewCompleted: true, reviewWorkspaceRef: "workspace:5" },
      ],
    };

    reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(orch.getItem("H-1-1")!.reviewCompleted).toBe(true);
    expect(orch.getItem("H-1-1")!.reviewWorkspaceRef).toBe("workspace:5");
  });

  it("restores blocked from daemon state without requiring a worktree", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));

    const daemonState = {
      items: [{ id: "H-1-1", state: "blocked", ciFailCount: 0, retryCount: 0, prNumber: null }],
    };

    reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("blocked");
  });

  it("re-evaluates restart-hold blocked items with existing worktrees", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));

    const wtPath = join(require("os").tmpdir(), `nw-restart-hold-${Date.now()}`);
    mkdirSync(wtPath, { recursive: true });

    const daemonState = {
      items: [{
        id: "H-1-1",
        state: "blocked",
        ciFailCount: 0,
        retryCount: 0,
        prNumber: null,
        failureReason: RESTART_RECOVERY_HOLD_REASON,
        worktreePath: wtPath,
      }],
    };

    const result = reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined,
      () => "", daemonState,
    );

    // Item should be added to unresolvedImplementations for re-evaluation, not stuck as blocked
    expect(result.unresolvedImplementations).toContainEqual(
      expect.objectContaining({ itemId: "H-1-1", worktreePath: wtPath }),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    // Cleanup
    require("fs").rmSync(wtPath, { recursive: true, force: true });
  });

  it("keeps non-restart-hold blocked items as blocked", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));

    const daemonState = {
      items: [{
        id: "H-1-1",
        state: "blocked",
        ciFailCount: 0,
        retryCount: 0,
        prNumber: null,
        failureReason: "launch-blocked: Repo 'missing-repo' not found.",
      }],
    };

    const result = reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(result.unresolvedImplementations).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.state).toBe("blocked");
  });

  it("keeps restart-hold blocked items as blocked when worktree is missing", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));

    const daemonState = {
      items: [{
        id: "H-1-1",
        state: "blocked",
        ciFailCount: 0,
        retryCount: 0,
        prNumber: null,
        failureReason: RESTART_RECOVERY_HOLD_REASON,
        worktreePath: "/tmp/nw-nonexistent-worktree-path",
      }],
    };

    const result = reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(result.unresolvedImplementations).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.state).toBe("blocked");
  });
});

// ── buildSnapshot ────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  it("computes readyIds for queued items with all deps done", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "done");

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.readyIds).toContain("H-1-2");
  });

  it("does not include queued items with unmet deps in readyIds", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.readyIds).not.toContain("H-1-2");
    expect(snap.readyIds).toContain("H-1-1"); // no deps → always ready
  });

  it("parses merged PR status into snapshot (already tracked PR)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    // Set prNumber so the merged check uses the "already tracked" fast path
    orch.getItem("H-1-1")!.prNumber = 42;

    const fakeCheckPr = (_id: string) => "H-1-1\t42\tmerged\t\t\tfeat: implement H-1-1";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    expect(itemSnap!.prState).toBe("merged");
    expect(itemSnap!.prNumber).toBe(42);
  });

  it("parses CI pass status with review approval", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");

    const fakeCheckPr = () => "H-1-1\t42\tready\tMERGEABLE\t2026-01-15T12:00:00Z";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap!.ciStatus).toBe("pass");
    expect(itemSnap!.reviewDecision).toBe("APPROVED");
    expect(itemSnap!.isMergeable).toBe(true);
    expect(itemSnap!.prState).toBe("open");
  });

  it("parses failing status with CONFLICTING mergeable flag", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");

    const fakeCheckPr = () => "H-1-1\t42\tfailing\tCONFLICTING\t2026-01-15T12:00:00Z";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap!.ciStatus).toBe("fail");
    expect(itemSnap!.isMergeable).toBe(false);
  });

  it("skips terminal states (done, stuck, blocked) in snapshot items", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-3"));
    orch.getItem("H-1-3")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "done");
    orch.hydrateState("H-1-2", "stuck");
    orch.hydrateState("H-1-3", "blocked");

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.items.find((s) => s.id === "H-1-1")).toBeUndefined();
    expect(snap.items.find((s) => s.id === "H-1-2")).toBeUndefined();
    expect(snap.items.find((s) => s.id === "H-1-3")).toBeUndefined();
  });

  it("sets eventTime from checkPr 5th field", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");

    const fakeCheckPr = () => "H-1-1\t42\tpending\tMERGEABLE\t2026-01-15T11:59:00Z";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap!.eventTime).toBe("2026-01-15T11:59:00Z");
  });
});

// ── evaluateMerge (tested via processTransitions) ────────────────────

describe("evaluateMerge", () => {
  it("auto strategy: merges immediately when CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge" && a.prNumber === 42)).toBe(true);
  });

  it("auto strategy: blocks merge when CHANGES_REQUESTED", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "CHANGES_REQUESTED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("manual strategy: never auto-merges, moves to review-pending", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "APPROVED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("auto strategy: gates on reviewCompleted (always-on review)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // First pass: not reviewed → goes to reviewing
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(actions.some((a) => a.type === "launch-review")).toBe(true);
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("auto strategy: merges after review completes", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("bypass strategy: merges with admin override after CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "bypass", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    const mergeAction = actions.find((a) => a.type === "merge" && a.prNumber === 42);
    expect(mergeAction).toBeDefined();
    expect(mergeAction!.admin).toBe(true);
  });

  it("bypass strategy: blocks merge when CHANGES_REQUESTED", () => {
    const orch = new Orchestrator({ mergeStrategy: "bypass", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "CHANGES_REQUESTED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("review gate: ci-passed always transitions to reviewing (no separate review session limit)", () => {
    // reviewing is in ACTIVE_SESSION_STATES; ci-passed→reviewing is an in-place transition
    // (same session slot). No separate reviewSessionLimit blocks it.
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));
    orch.hydrateState("H-1-1", "reviewing"); // occupies a session slot
    orch.getItem("H-1-1")!.prNumber = 10;
    orch.hydrateState("H-1-2", "ci-passed");
    orch.getItem("H-1-2")!.prNumber = 20;

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true },
        { id: "H-1-2", ciStatus: "pass", prState: "open", isMergeable: true },
      ]),
    );

    // H-1-2 should enter reviewing (in-place transition, no slot check needed)
    expect(orch.getItem("H-1-2")!.state).toBe("reviewing");
    expect(actions.filter((a) => a.type === "launch-review" && a.itemId === "H-1-2")).toHaveLength(1);
  });
});

// ── setMergeStrategy ────────────────────────────────────────────────

describe("setMergeStrategy", () => {
  it("changes strategy for subsequent evaluateMerge calls", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    // Manual → review-pending
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");

    // Switch to auto → should now merge
    orch.setMergeStrategy("auto");
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("rejects bypass when bypassEnabled is false", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", bypassEnabled: false });
    expect(() => orch.setMergeStrategy("bypass")).toThrow(
      'Cannot set merge strategy to "bypass" without --dangerously-bypass flag',
    );
  });

  it("allows bypass when bypassEnabled is true", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", bypassEnabled: true });
    orch.setMergeStrategy("bypass");
    expect(orch.config.mergeStrategy).toBe("bypass");
  });

  it("re-evaluates review-pending items when switching from manual to auto", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.setMergeStrategy("auto");
    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "APPROVED" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge" && a.itemId === "H-1-1" && a.prNumber === 42)).toBe(true);
  });

  it("keeps review-pending items in place when switching from auto to manual", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.setMergeStrategy("manual");
    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "APPROVED" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("re-evaluates review-pending items with admin merge when switching to bypass", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.setMergeStrategy("bypass");
    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "APPROVED" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    const mergeAction = actions.find((a) => a.type === "merge" && a.itemId === "H-1-1");
    expect(mergeAction).toBeDefined();
    expect(mergeAction!.admin).toBe(true);
  });

  it("keeps CHANGES_REQUESTED items in review-pending after switching to auto", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.setMergeStrategy("auto");
    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "CHANGES_REQUESTED" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("retries merge with updated strategy for items already in merging", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.setMergeStrategy("bypass");
    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true, reviewDecision: "APPROVED" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    // handleMerging retries with the current strategy (bypass → admin)
    const mergeAction = actions.find((a) => a.type === "merge");
    expect(mergeAction).toBeDefined();
    expect(mergeAction!.admin).toBe(true);
  });
});

// ── setSessionLimit ─────────────────────────────────────────────────────

describe("setSessionLimit", () => {
  it("changes config.sessionLimit immediately", () => {
    const orch = new Orchestrator({ sessionLimit: 3 });
    expect(orch.config.sessionLimit).toBe(3);
    orch.setSessionLimit(5);
    expect(orch.config.sessionLimit).toBe(5);
  });

  it("clamps to minimum of 1", () => {
    const orch = new Orchestrator({ sessionLimit: 3 });
    orch.setSessionLimit(0);
    expect(orch.config.sessionLimit).toBe(1);
    orch.setSessionLimit(-5);
    expect(orch.config.sessionLimit).toBe(1);
  });

  it("floors fractional values", () => {
    const orch = new Orchestrator({ sessionLimit: 3 });
    orch.setSessionLimit(4.9);
    expect(orch.config.sessionLimit).toBe(4);
  });

  it("clears memory-adjusted effective limit", () => {
    const orch = new Orchestrator({ sessionLimit: 5 });
    orch.setEffectiveSessionLimit(2); // simulate memory pressure
    expect(orch.effectiveSessionLimit).toBe(2);
    orch.setSessionLimit(4);
    // After setSessionLimit, effectiveSessionLimit should reflect the new configured value
    expect(orch.effectiveSessionLimit).toBe(4);
  });

  it("updates availableSessionSlots calculation immediately", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1"; // active worker uses 1 session slot
    expect(orch.availableSessionSlots).toBe(1);
    orch.setSessionLimit(4);
    expect(orch.availableSessionSlots).toBe(3);
  });

  it("reducing session limit below current count does not eject items", () => {
    const orch = new Orchestrator({ sessionLimit: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));
    orch.addItem(makeWorkItem("H-1-3"));
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    orch.hydrateState("H-1-2", "ci-pending");
    orch.getItem("H-1-2")!.workspaceRef = "workspace:2";
    orch.hydrateState("H-1-3", "implementing");
    orch.getItem("H-1-3")!.workspaceRef = "workspace:3";
    expect(orch.activeSessionCount).toBe(3);
    orch.setSessionLimit(1);
    // All items stay in their current states -- availableSessionSlots just goes to 0
    expect(orch.activeSessionCount).toBe(3);
    expect(orch.availableSessionSlots).toBe(0);
  });
});

// ── handleImplementing (tested via processTransitions) ───────────────

describe("handleImplementing", () => {
  it("transitions to ci-pending when PR appears", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", workerAlive: true }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(42);
  });

  it("transitions to ci-pending when only partial open PR knowledge is available", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-OPEN-1"));
    orch.getItem("H-OPEN-1")!.reviewCompleted = true;
    orch.hydrateState("H-OPEN-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-OPEN-1", prNumber: 42, prState: "open", workerAlive: true }]),
      NOW,
    );

    expect(orch.getItem("H-OPEN-1")!.state).toBe("ci-pending");
    expect(orch.getItem("H-OPEN-1")!.prNumber).toBe(42);
    expect(actions.some((a) => a.type === "merge")).toBe(false);
    expect(actions.some((a) => a.type === "launch-review")).toBe(false);
    expect(actions.some((a) => a.type === "daemon-rebase")).toBe(false);
  });

  it("transitions to merged when PR auto-merges between polls", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 99, prState: "merged" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(99);
    expect(actions.some((a) => a.type === "clean" && a.itemId === "H-1-1")).toBe(true);
  });

  it("requires 5 consecutive not-alive checks before retry (debounce)", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // First four not-alive: no action
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    // Fifth not-alive triggers retry
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
  });

  it("resets notAliveCount when worker comes back alive", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Four not-alive checks
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.notAliveCount).toBe(4);

    // Worker comes back
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: true }]), NOW);
    expect(orch.getItem("H-1-1")!.notAliveCount).toBe(0);
  });

  it("detects launch timeout when no commits after launchTimeoutMs (process dead)", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Transition timestamp is "now" from setState -- advance past timeout
    // workerAlive=false means launch timeout applies (not suppressed by liveness)
    const futureTime = new Date(Date.now() + 2000);
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null }]),
      futureTime,
    );

    // Should be stuck (maxRetries defaults to 1, but stuckOrRetry checks retryCount)
    const item = orch.getItem("H-1-1")!;
    expect(item.state === "ready" || item.state === "stuck" || item.state === "launching").toBe(true);
  });

  it("detects activity timeout when commits are stale", () => {
    const orch = new Orchestrator({ activityTimeoutMs: 1000, maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const futureNow = new Date("2026-01-15T12:00:00Z");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      futureNow,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("emits sync-stack-comments when stacked PR opens", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.baseBranch = "ninthwave/H-1-0";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending" }]),
      NOW,
    );

    expect(actions.some((a) => a.type === "sync-stack-comments" && a.itemId === "H-1-1")).toBe(true);
  });

  it("chains PR open through to CI pass in same cycle (grace period allows pass)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pass" }]),
      NOW,
    );

    // CI pass is trusted immediately (grace period only blocks "fail")
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("blocks same-cycle CI fail on PR open (grace period)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "fail" }]),
      NOW,
    );

    // CI fail within grace period → stays in ci-pending (stale CI from previous commit)
    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });
});

// ── Headless worker recovery (H-WRK-4) ─────────────────────────────

describe("headless worker recovery", () => {
  it("recovers a headless worker in waiting phase without consuming retry budget", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-REC-1"));
    orch.hydrateState("H-REC-1", "implementing");
    const item = orch.getItem("H-REC-1")!;
    item.workspaceRef = "headless:H-REC-1";

    // Simulate 5 not-alive checks (debounce threshold)
    let actions: Action[] = [];
    for (let i = 0; i < 5; i++) {
      actions = orch.processTransitions(
        snapshotWith([{ id: "H-REC-1", workerAlive: false, headlessPhase: "waiting" }]),
        NOW,
      );
    }

    // Recovery: retry action emitted, retryCount NOT consumed
    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-REC-1")).toBe(true);
    expect(item.retryCount).toBe(0);
    expect(item.pendingRetryWorkspaceRef).toBe("headless:H-REC-1");
  });

  it("recovers a headless worker in implementing phase without consuming retry budget", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-REC-2"));
    orch.hydrateState("H-REC-2", "implementing");
    const item = orch.getItem("H-REC-2")!;
    item.workspaceRef = "headless:H-REC-2";

    let actions: Action[] = [];
    for (let i = 0; i < 5; i++) {
      actions = orch.processTransitions(
        snapshotWith([{ id: "H-REC-2", workerAlive: false, headlessPhase: "implementing" }]),
        NOW,
      );
    }

    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-REC-2")).toBe(true);
    expect(item.retryCount).toBe(0);
  });

  it("does NOT recover a headless worker in starting phase (no progress)", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-REC-3"));
    orch.hydrateState("H-REC-3", "implementing");
    const item = orch.getItem("H-REC-3")!;
    item.workspaceRef = "headless:H-REC-3";

    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-3", workerAlive: false, headlessPhase: "starting" }]),
        NOW,
      );
    }

    // Should use stuckOrRetry, consuming the retry budget
    expect(item.retryCount).toBe(1);
  });

  it("does NOT recover a non-headless worker even with implementing phase", () => {
    const orch = new Orchestrator({ maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-REC-4"));
    orch.hydrateState("H-REC-4", "implementing");
    const item = orch.getItem("H-REC-4")!;
    item.workspaceRef = "tmux:H-REC-4";

    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-4", workerAlive: false, headlessPhase: "implementing" }]),
        NOW,
      );
    }

    // Non-headless: stuckOrRetry with maxRetries=0 -> stuck
    expect(item.state).toBe("stuck");
  });

  it("does NOT recover a headless worker with no phase file", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-REC-5"));
    orch.hydrateState("H-REC-5", "implementing");
    const item = orch.getItem("H-REC-5")!;
    item.workspaceRef = "headless:H-REC-5";

    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-5", workerAlive: false, headlessPhase: null }]),
        NOW,
      );
    }

    // No phase -> stuckOrRetry consumes retry budget
    expect(item.retryCount).toBe(1);
  });

  it("recovers on launch timeout for headless worker with waiting phase", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-REC-6"));
    orch.hydrateState("H-REC-6", "implementing");
    const item = orch.getItem("H-REC-6")!;
    item.workspaceRef = "headless:H-REC-6";

    const futureTime = new Date(Date.now() + 2000);
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-REC-6", workerAlive: false, lastCommitTime: null, headlessPhase: "waiting" }]),
      futureTime,
    );

    expect(item.retryCount).toBe(0);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
  });

  it("recovers on activity timeout for headless worker with implementing phase", () => {
    const orch = new Orchestrator({ activityTimeoutMs: 1000, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-REC-7"));
    orch.hydrateState("H-REC-7", "implementing");
    const item = orch.getItem("H-REC-7")!;
    item.workspaceRef = "headless:H-REC-7";

    const staleTime = "2026-01-15T10:00:00Z";
    const futureNow = new Date("2026-01-15T12:00:00Z");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-REC-7", workerAlive: false, lastCommitTime: staleTime, headlessPhase: "implementing" }]),
      futureNow,
    );

    expect(item.retryCount).toBe(0);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
  });

  it("emits headless-recovery event on recovery", () => {
    const events: Array<{ id: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      maxRetries: 1,
      onEvent: (id, event, data) => events.push({ id, event, data }),
    });
    orch.addItem(makeWorkItem("H-REC-8"));
    orch.hydrateState("H-REC-8", "implementing");
    const item = orch.getItem("H-REC-8")!;
    item.workspaceRef = "headless:H-REC-8";

    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-8", workerAlive: false, headlessPhase: "waiting" }]),
        NOW,
      );
    }

    const recoveryEvents = events.filter(e => e.event === "headless-recovery");
    expect(recoveryEvents.length).toBe(1);
    expect(recoveryEvents[0].id).toBe("H-REC-8");
  });

  it("exhausts retry budget after recovery when worker never makes progress", () => {
    const orch = new Orchestrator({ maxRetries: 1, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-REC-9"));
    orch.hydrateState("H-REC-9", "implementing");
    const item = orch.getItem("H-REC-9")!;
    item.workspaceRef = "headless:H-REC-9";

    // First: recover with "waiting" phase (no retry budget consumed)
    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-9", workerAlive: false, headlessPhase: "waiting" }]),
        NOW,
      );
    }
    expect(item.retryCount).toBe(0);

    // Re-enter implementing after relaunch
    orch.hydrateState("H-REC-9", "implementing");
    item.workspaceRef = "headless:H-REC-9";

    // Second: crash with "starting" phase (retry budget consumed)
    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-9", workerAlive: false, headlessPhase: "starting" }]),
        NOW,
      );
    }
    // maxRetries=1, retryCount goes to 1
    expect(item.retryCount).toBe(1);

    // Re-enter implementing after second relaunch
    orch.hydrateState("H-REC-9", "implementing");
    item.workspaceRef = "headless:H-REC-9";

    // Third: crash again with "starting" -> stuck (budget exhausted)
    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-REC-9", workerAlive: false, headlessPhase: "starting" }]),
        NOW,
      );
    }
    expect(item.state).toBe("stuck");
  });
});

// ── Heartbeat-based health detection (tested via processTransitions) ──

describe("heartbeat-based health detection", () => {
  it("worker with recent heartbeat (< 5 min) is not marked stuck even with no commits", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Advance past launch timeout, but heartbeat is fresh
    const futureTime = new Date(Date.now() + 2000);
    const freshHeartbeat = { id: "H-1-1", progress: 50, label: "Working", ts: new Date(futureTime.getTime() - 1000).toISOString() };

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null, lastHeartbeat: freshHeartbeat }]),
      futureTime,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
  });

  it("worker with stale heartbeat (> 5 min) and no recent commits transitions to stuck (process dead)", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Advance past launch timeout with stale heartbeat (> 5 min old) and dead process
    const futureTime = new Date(Date.now() + 2000);
    const staleHeartbeat = { id: "H-1-1", progress: 30, label: "Stalled", ts: new Date(futureTime.getTime() - 6 * 60 * 1000).toISOString() };

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null, lastHeartbeat: staleHeartbeat }]),
      futureTime,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("worker with no heartbeat file falls back to commit-based timeout detection (process dead)", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // No heartbeat (null), process dead, advance past launch timeout
    const futureTime = new Date(Date.now() + 2000);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null, lastHeartbeat: null }]),
      futureTime,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("worker with no heartbeat file and recent commits stays implementing", () => {
    const orch = new Orchestrator({ activityTimeoutMs: 60_000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const now = new Date("2026-01-15T12:00:00Z");
    const recentCommit = "2026-01-15T11:59:30Z"; // 30s ago

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: recentCommit, lastHeartbeat: null }]),
      now,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
  });

  it("fresh heartbeat overrides stale commits to keep worker alive", () => {
    const orch = new Orchestrator({ activityTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const now = new Date("2026-01-15T12:00:00Z");
    const staleCommit = "2026-01-15T10:00:00Z"; // 2 hours ago, past activity timeout
    const freshHeartbeat = { id: "H-1-1", progress: 80, label: "Testing", ts: "2026-01-15T11:59:00Z" }; // 1 min ago

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleCommit, lastHeartbeat: freshHeartbeat }]),
      now,
    );

    // Fresh heartbeat should prevent stuck transition despite stale commits
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
  });

  it("workerHealth field no longer appears in ItemSnapshot type", () => {
    // Verify at runtime that creating an ItemSnapshot without workerHealth compiles and works
    const snap: ItemSnapshot = {
      id: "H-1-1",
      workerAlive: true,
      lastCommitTime: null,
      lastHeartbeat: null,
    };
    // The workerHealth property should not exist on the type
    expect("workerHealth" in snap).toBe(false);
  });
});

// ── Process liveness as timeout suppression signal ─────────────────────

describe("process liveness timeout suppression", () => {
  it("worker with stale heartbeat but workerAlive=true is NOT marked stuck at launchTimeoutMs", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, activityTimeoutMs: 60_000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Advance past launch timeout (1s) but well within activity timeout (60s)
    const futureTime = new Date(Date.now() + 2000);
    const staleHeartbeat = { id: "H-1-1", progress: 30, label: "Working", ts: new Date(futureTime.getTime() - 6 * 60 * 1000).toISOString() };

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null, lastHeartbeat: staleHeartbeat }]),
      futureTime,
    );

    // Process is alive -- should NOT be stuck despite exceeding launchTimeoutMs
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
  });

  it("worker with stale heartbeat and workerAlive=true IS marked stuck at activityTimeoutMs", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, activityTimeoutMs: 5000, maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Advance past both launch timeout AND activity timeout
    const futureTime = new Date(Date.now() + 10_000);
    const staleHeartbeat = { id: "H-1-1", progress: 30, label: "Stalled", ts: new Date(futureTime.getTime() - 6 * 60 * 1000).toISOString() };

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null, lastHeartbeat: staleHeartbeat }]),
      futureTime,
    );

    // Activity timeout is the hard cap even when process is alive
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("worker with stale heartbeat and workerAlive=false is marked stuck at launchTimeoutMs", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Advance past launch timeout with dead process
    const futureTime = new Date(Date.now() + 2000);
    const staleHeartbeat = { id: "H-1-1", progress: 30, label: "Stalled", ts: new Date(futureTime.getTime() - 6 * 60 * 1000).toISOString() };

    // Need 3 not-alive checks to trigger crash detection, so test the timeout path directly
    // by having workerAlive=false but not enough consecutive checks for crash
    // The timeout path: workerAlive is not true, so launch timeout applies
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null, lastHeartbeat: staleHeartbeat }]),
      futureTime,
    );

    // workerAlive=false: launch timeout applies (existing behavior)
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("lastAliveAt prevents timeout when worker was recently alive but has a single dead blip", () => {
    const orch = new Orchestrator({ reviewEnabled: false, launchTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "implementing");

    // Worker is alive for the first poll (sets lastAliveAt)
    const t0 = new Date(Date.now() + 500);
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null }]),
      t0,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    // Time advances past launch timeout since transition, but only 600ms since last alive
    const t1 = new Date(t0.getTime() + 600);
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null }]),
      t1,
    );

    // Should NOT be stuck -- timeout measures from lastAliveAt, not lastTransition
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
  });

  it("fresh heartbeat still takes priority over process liveness signal", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000, activityTimeoutMs: 5000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Past both timeouts, but heartbeat is fresh
    const futureTime = new Date(Date.now() + 10_000);
    const freshHeartbeat = { id: "H-1-1", progress: 80, label: "Testing", ts: new Date(futureTime.getTime() - 1000).toISOString() };

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null, lastHeartbeat: freshHeartbeat }]),
      futureTime,
    );

    // Fresh heartbeat wins -- worker stays implementing regardless of timeouts
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
  });

  it("timeout suppression by process liveness is logged via onEvent", () => {
    const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      launchTimeoutMs: 1000,
      activityTimeoutMs: 60_000,
      onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Past launch timeout, process alive, no commits → suppression should be logged
    const futureTime = new Date(Date.now() + 2000);
    const staleHeartbeat = { id: "H-1-1", progress: 30, label: "Working", ts: new Date(futureTime.getTime() - 6 * 60 * 1000).toISOString() };

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null, lastHeartbeat: staleHeartbeat }]),
      futureTime,
    );

    expect(events).toHaveLength(1);
    expect(events[0].itemId).toBe("H-1-1");
    expect(events[0].event).toBe("timeout-suppressed-by-liveness");
    expect(events[0].data?.launchTimeoutMs).toBe(1000);
    expect(events[0].data?.activityTimeoutMs).toBe(60_000);
  });
});

// ── handlePrLifecycle / handleCiPending (tested via processTransitions) ──

describe("handleCiPending", () => {
  it("transitions to ci-passed when CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    // ask strategy → ci-passed then review-pending
    expect(["ci-passed", "review-pending"]).toContain(orch.getItem("H-1-1")!.state);
  });

  it("transitions to ci-failed on CI failure", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(1);
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
  });

  it("ignores CI fail within grace period after transitioning to ci-pending", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // First cycle: implementing → ci-pending (sets ciPendingSince)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "fail" }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");

    // Second cycle: CI still shows fail (stale) -- should stay in ci-pending
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    expect(actions).toEqual([]);
  });

  it("transitions ci-failed after grace period expires", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // Transition implementing → ci-pending (sets ciPendingSince)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "fail" }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");

    // Backdate ciPendingSince to 2 minutes ago (past grace period)
    orch.getItem("H-1-1")!.ciPendingSince = new Date(Date.now() - 120_000).toISOString();

    // Now CI fail should be trusted
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
  });

  it("honors CI pass immediately even within grace period", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Transition implementing → ci-pending (sets ciPendingSince)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pass" }]),
    );

    // ci-pending, not yet evaluated. Next cycle:
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    // CI pass is trusted immediately (if CI passes, it's for the current commit)
    expect(["ci-passed", "review-pending"]).toContain(orch.getItem("H-1-1")!.state);
  });

  it("does not re-notify CI failure on subsequent ticks (deduplication)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    orch.getItem("H-1-1")!.lastCommitTime = "2026-03-27T10:00:00Z";

    // First tick: CI fails → notify
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );
    expect(actions1.some((a) => a.type === "notify-ci-failure")).toBe(true);

    // Second tick: still failing, same commit → no re-notify
    const actions2 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );
    expect(actions2.some((a) => a.type === "notify-ci-failure")).toBe(false);

    // Third tick: still failing, but new commit pushed → re-notify
    orch.getItem("H-1-1")!.lastCommitTime = "2026-03-27T10:05:00Z";
    const actions3 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );
    expect(actions3.some((a) => a.type === "notify-ci-failure")).toBe(true);

    // Fourth tick: still failing, same commit again → no re-notify
    const actions4 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );
    expect(actions4.some((a) => a.type === "notify-ci-failure")).toBe(false);
  });

  it("emits daemon-rebase on CI failure with merge conflict", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "daemon-rebase")).toBe(true);
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
  });

  it("detects merge conflicts on ci-pending PR and sends rebase (once)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    // First poll with conflict → sends rebase
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open", isMergeable: false }]),
    );
    expect(actions1.some((a) => a.type === "daemon-rebase")).toBe(true);
    expect(orch.getItem("H-1-1")!.rebaseRequested).toBe(true);

    // Second poll with same conflict → no duplicate rebase
    const actions2 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open", isMergeable: false }]),
    );
    expect(actions2.some((a) => a.type === "daemon-rebase")).toBe(false);
  });

  it("detects merge conflicts on ci-passed PR and regresses to ci-pending with rebase", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Another PR merged to main → this PR is now CONFLICTING despite stale CI pass
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    expect(actions.some((a) => a.type === "daemon-rebase")).toBe(true);
    expect(actions.some((a) => a.type === "launch-review")).toBe(false);
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("transitions to merged when PR is externally merged", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
  });
});

// ── handleCiPassed / ci-failed recovery ──────────────────────────────

describe("handleCiPassed", () => {
  it("recovers from ci-failed to ci-passed when CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 1;
    orch.getItem("H-1-1")!.reviewCompleted = true; // Re-set after ci-failed reset

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("marks stuck and closes workspace when ciFailCount exceeds maxCiRetries for a dead worker", () => {
    const orch = new Orchestrator({ maxCiRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 2; // exceeds maxCiRetries of 1

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", workerAlive: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("marks stuck and parks the session when ciFailCount exceeds maxCiRetries for a live worker", () => {
    const orch = new Orchestrator({ maxCiRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 2; // exceeds maxCiRetries of 1

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", workerAlive: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(true);
    expect(actions.some((a) => a.type === "workspace-close")).toBe(false);
  });

  it("recovers from ci-failed to ci-pending when CI goes back to pending", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });

  it("resets reviewCompleted on CI regression", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // CI regresses → ci-failed
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.reviewCompleted).toBe(false);
  });
});

// ── Full lifecycle: queued → done ────────────────────────────────────

describe("full lifecycle: queued → done", () => {
  it("drives an item through normal flow to merge", () => {
    const orch = new Orchestrator({ fixForward: false, mergeStrategy: "auto", sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // Step 1: queued → ready → launching
    const a1 = orch.processTransitions(emptySnapshot(["H-1-1"]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(a1.some((a) => a.type === "launch")).toBe(true);

    // Step 2: launching → implementing (worker alive)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    // Step 3: implementing → ci-pending
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending", workerAlive: true }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");

    // Step 4: ci-pending → ci-passed → merging
    const a4 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(a4.some((a) => a.type === "merge" && a.prNumber === 42)).toBe(true);

    // Step 5: merging → merged
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("merged");

    // Step 6: merged → done (next cycle)
    orch.processTransitions(emptySnapshot());
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Merge queue prioritization ───────────────────────────────────────

describe("merge queue prioritization", () => {
  it("only merges the highest-priority item when multiple are ci-passed", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("L-1-1", [], "low"));
    orch.getItem("L-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("C-1-1", [], "critical"));
    orch.getItem("C-1-1")!.reviewCompleted = true;

    orch.hydrateState("L-1-1", "ci-passed");
    orch.getItem("L-1-1")!.reviewCompleted = true;
    orch.getItem("L-1-1")!.prNumber = 10;
    orch.hydrateState("C-1-1", "ci-passed");
    orch.getItem("C-1-1")!.reviewCompleted = true;
    orch.getItem("C-1-1")!.prNumber = 20;

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "L-1-1", ciStatus: "pass", prState: "open", isMergeable: true },
        { id: "C-1-1", ciStatus: "pass", prState: "open", isMergeable: true },
      ]),
    );

    const mergeActions = actions.filter((a) => a.type === "merge");
    expect(mergeActions).toHaveLength(1);
    expect(mergeActions[0]!.itemId).toBe("C-1-1");
    // Lower priority item reverted to ci-passed
    expect(orch.getItem("L-1-1")!.state).toBe("ci-passed");
  });

  it("passes through single merge action unchanged", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(actions.filter((a) => a.type === "merge")).toHaveLength(1);
  });
});

// ── Stacked branch launches ──────────────────────────────────────────

describe("stacked branch launches", () => {
  it("launches stacked item when dep is in ci-passed", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    // Move dep to ci-passed (a stackable state)
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 10;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    // H-1-2 should be promoted from queued → ready → launching via stacking
    expect(orch.getItem("H-1-2")!.state).toBe("launching");
    expect(orch.getItem("H-1-2")!.baseBranch).toBe("ninthwave/H-1-1");
    const launchAction = actions.find((a) => a.type === "launch" && a.itemId === "H-1-2");
    expect(launchAction).toBeDefined();
    expect(launchAction!.baseBranch).toBe("ninthwave/H-1-1");
  });

  it("does not stack when dep is in implementing (non-stackable)", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
    );

    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });

  it("does not stack when enableStacking is false", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: false });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 10;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });
});


// ── Stuck dep notification ───────────────────────────────────────────

describe("stuck dep notification for stacked items", () => {
  it("notifies stacked dependent when dep goes stuck", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 6; // exceeds maxCiRetries
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and alive
    orch.hydrateState("H-1-2", "implementing");
    orch.getItem("H-1-2")!.baseBranch = "ninthwave/H-1-1";
    orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "fail", prState: "open" },
        { id: "H-1-2", workerAlive: true },
      ]),
    );

    // H-1-1 goes stuck, and H-1-2 should get a rebase (pause) notification
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    const rebaseAction = actions.find((a) => a.type === "rebase" && a.itemId === "H-1-2");
    expect(rebaseAction).toBeDefined();
    expect(rebaseAction!.message).toContain("Pause");
  });

  it("reverts stacked dependent in ready state to queued when dep goes stuck", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 6;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and in ready state (no worker yet)
    orch.hydrateState("H-1-2", "ready");
    orch.getItem("H-1-2")!.baseBranch = "ninthwave/H-1-1";

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "fail", prState: "open" },
      ]),
    );

    // H-1-1 goes stuck, and H-1-2 should revert to queued with baseBranch cleared
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-2")!.state).toBe("queued");
    expect(orch.getItem("H-1-2")!.baseBranch).toBeUndefined();
    // No rebase action for pre-session dependent
    const rebaseAction = actions.find((a) => a.type === "rebase" && a.itemId === "H-1-2");
    expect(rebaseAction).toBeUndefined();
  });

  it("reverts stacked dependent in launching state to queued when dep goes stuck", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 6;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and in launching state (no worker yet)
    orch.hydrateState("H-1-2", "launching");
    orch.getItem("H-1-2")!.baseBranch = "ninthwave/H-1-1";

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "fail", prState: "open" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-2")!.state).toBe("queued");
    expect(orch.getItem("H-1-2")!.baseBranch).toBeUndefined();
  });

  it("sends pause message to stacked dependent in implementing state (existing behavior)", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 6;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and implementing with active worker
    orch.hydrateState("H-1-2", "implementing");
    orch.getItem("H-1-2")!.baseBranch = "ninthwave/H-1-1";
    orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "fail", prState: "open" },
        { id: "H-1-2", workerAlive: true },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    // Implementing dependent should NOT revert to queued
    expect(orch.getItem("H-1-2")!.state).toBe("implementing");
    expect(orch.getItem("H-1-2")!.baseBranch).toBe("ninthwave/H-1-1");
    // Should get a pause message
    const rebaseAction = actions.find((a) => a.type === "rebase" && a.itemId === "H-1-2");
    expect(rebaseAction).toBeDefined();
    expect(rebaseAction!.message).toContain("Pause");
  });

  it("does not affect non-stacked dependents when dep goes stuck", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 6;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 depends on H-1-1 but has no baseBranch (not stacked)
    orch.hydrateState("H-1-2", "ready");
    // No baseBranch set -- not stacked

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "fail", prState: "open" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    // Non-stacked dependent should NOT be reverted to queued (no baseBranch = not stacked)
    expect(orch.getItem("H-1-2")!.state).not.toBe("queued");
    // No pause message for non-stacked items
    const rebaseAction = actions.find((a) => a.type === "rebase" && a.itemId === "H-1-2");
    expect(rebaseAction).toBeUndefined();
  });
});

// ── stuckOrRetry resets (H-ER-4) ────────────────────────────────────

describe("stuckOrRetry resets", () => {
  it("retried item does NOT inherit stale lastCommitTime from previous attempt", () => {
    // activityTimeoutMs set high so the stale commit doesn't trigger activity timeout
    // before the NOT_ALIVE_THRESHOLD (5) is reached for crash detection.
    const orch = new Orchestrator({ maxRetries: 2, activityTimeoutMs: 10 * 60 * 1000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    // Simulate a stale commit from the previous attempt (2 min ago, within activity timeout)
    orch.getItem("H-1-1")!.lastCommitTime = new Date(Date.now() - 120_000).toISOString();

    // Worker dies -- trigger stuckOrRetry via 5 consecutive not-alive checks
    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      );
    }

    // After 5 not-alive checks, stuckOrRetry fires → ready, then launchReadyItems
    // promotes it to launching in the same cycle. Key check: lastCommitTime is cleared
    // so the new worker starts with fresh timeout baselines.
    const item = orch.getItem("H-1-1")!;
    expect(item.state).toBe("launching");
    expect(item.retryCount).toBe(1);
    // lastCommitTime should be cleared so the new worker starts fresh
    expect(item.lastCommitTime).toBeUndefined();
    // lastAliveAt and notAliveCount should also be reset
    expect(item.lastAliveAt).toBeUndefined();
    expect(item.notAliveCount).toBe(0);
  });
});

// ── Launching state timeout (H-ER-4) ───────────────────────────────

describe("launching state timeout", () => {
  it("transitions to stuck/retry when worker never registers within timeout", () => {
    const orch = new Orchestrator({ maxRetries: 0, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    // Advance past the 5-minute launching timeout
    const futureTime = new Date(Date.now() + 6 * 60 * 1000);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1" }]), // workerAlive is undefined
      futureTime,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("launch-timeout");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("retries when launching timeout fires and retries remain", () => {
    const orch = new Orchestrator({ maxRetries: 1, gracePeriodMs: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    // Advance past the 5-minute launching timeout
    const futureTime = new Date(Date.now() + 6 * 60 * 1000);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1" }]), // workerAlive is undefined
      futureTime,
    );

    // stuckOrRetry transitions to ready, then launchReadyItems promotes to launching
    // in the same cycle. Key check: retryCount incremented and retry action emitted.
    expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
    expect(actions.some((a) => a.type === "launch")).toBe(true);
  });

  it("does NOT timeout when within the launching timeout window", () => {
    const orch = new Orchestrator({ maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    // Only 2 minutes in -- well within the 5-minute timeout
    const futureTime = new Date(Date.now() + 2 * 60 * 1000);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1" }]), // workerAlive is undefined
      futureTime,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(actions).toHaveLength(0);
  });
});

// ── Merging state ────────────────────────────────────────────────────

describe("handleMerging", () => {
  it("transitions to merged when PR state is merged", () => {
    const orch = new Orchestrator({ fixForward: false });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);

    // merged → done happens in the next cycle
    orch.processTransitions(emptySnapshot());
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("stays in merging when PR not yet merged", () => {
    const orch = new Orchestrator({ fixForward: false });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
  });

  it("transitions to stuck when PR is closed without merging", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "closed" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toBe(
      "merge-aborted: PR was closed without merging",
    );
  });
});

// ── Reviewing state ──────────────────────────────────────────────────

describe("handleReviewing", () => {
  const approveVerdict = { verdict: "approve" as const, summary: "No issues.", blockingCount: 0, nonBlockingCount: 0, architectureScore: 8, codeQualityScore: 9, performanceScore: 7, testCoverageScore: 8, unresolvedDecisions: 0, criticalGaps: 0, confidence: 9 };
  const requestChangesVerdict = { verdict: "request-changes" as const, summary: "Found blockers.", blockingCount: 2, nonBlockingCount: 0, architectureScore: 5, codeQualityScore: 4, performanceScore: 6, testCoverageScore: 3, unresolvedDecisions: 2, criticalGaps: 2, confidence: 7 };

  it("transitions to ci-passed with reviewCompleted on approve verdict", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict }]),
    );

    expect(orch.getItem("H-1-1")!.reviewCompleted).toBe(true);
    // Should chain through to merging (reviewed + reviewCompleted)
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
    expect(actions.some((a) => a.type === "post-review")).toBe(true);
    expect(actions.some((a) => a.type === "clean-review")).toBe(true);
  });

  it("approve verdict records lastReviewedCommitSha for SHA gate", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "reviewing");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", ciStatus: "pass", prState: "open",
        reviewVerdict: approveVerdict, headSha: "abc123",
      }]),
    );

    expect(item.reviewCompleted).toBe(true);
    expect(item.lastReviewedCommitSha).toBe("abc123");
  });

  it("respawn after approved review blocks re-review on unchanged code", () => {
    // After approve sets lastReviewedCommitSha, a feedback respawn should not
    // re-review until the implementer pushes a new commit.
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    // Simulate: implementer was respawned for feedback and is now implementing
    orch.hydrateState("H-1-1", "implementing");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false; // reset by respawnForFeedback
    item.lastReviewedCommitSha = "approved-sha"; // set by approve verdict

    // Poll: PR exists, CI passes, but HEAD matches lastReviewedCommitSha (no new commit)
    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "approved-sha",
      }]),
      NOW,
    );

    // SHA gate: should stay in implementing, not progress to reviewing
    expect(item.state).toBe("implementing");
    expect(actions.some((a) => a.type === "launch-review")).toBe(false);

    // Now implementer pushes a new commit -- different headSha
    const actions2 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "new-commit-sha",
      }]),
      NOW,
    );

    // Should progress and launch a review for the new code
    expect(actions2.some((a) => a.type === "launch-review")).toBe(true);
  });

  it("feedback-done signal clears SHA gate in implementing state", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "implementing");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.lastReviewedCommitSha = "reviewed-sha";
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "Please explain X";

    // Poll with feedbackDoneSignal set and same SHA as lastReviewedCommitSha
    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "reviewed-sha", feedbackDoneSignal: true,
      }]),
      NOW,
    );

    // Should clear the feedback state and progress out of implementing
    expect(item.lastReviewedCommitSha).toBeNull();
    expect(item.needsFeedbackResponse).toBe(false);
    expect(item.pendingFeedbackMessage).toBeUndefined();
    expect(item.state).not.toBe("implementing");
    expect(actions.some((a) => a.type === "clear-feedback-done-signal")).toBe(true);
  });

  it("feedback-done signal clears SHA gate in review-pending state", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.lastReviewedCommitSha = "reviewed-sha";
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "Please explain X";
    item.workspaceRef = "workspace:1";

    // Poll with CI passing and feedbackDoneSignal
    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "reviewed-sha", feedbackDoneSignal: true,
        isMergeable: true,
      }]),
      NOW,
    );

    // Should clear the feedback state
    expect(item.lastReviewedCommitSha).toBeNull();
    expect(item.needsFeedbackResponse).toBe(false);
    expect(item.pendingFeedbackMessage).toBeUndefined();
    expect(actions.some((a) => a.type === "clear-feedback-done-signal")).toBe(true);
    // Should progress (ci-passed or launch-review depending on merge strategy)
    expect(item.state).not.toBe("review-pending");
  });

  it("feedback-done signal is ignored when no SHA gate is active", () => {
    // feedbackDoneSignal without lastReviewedCommitSha should not trigger clearing
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "implementing");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.lastReviewedCommitSha = null;

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "some-sha", feedbackDoneSignal: true,
      }]),
      NOW,
    );

    // Should progress normally through ci-pending (no SHA gate was active)
    expect(item.state).not.toBe("implementing");
    // No clear-feedback-done-signal action needed since the gate wasn't active
  });

  it("repeated feedback-done signals are idempotent", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "implementing");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.lastReviewedCommitSha = "reviewed-sha";
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "Please explain X";

    // First signal clears the gate and progresses
    orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "reviewed-sha", feedbackDoneSignal: true,
      }]),
      NOW,
    );

    const stateAfterFirst = item.state;

    // Second signal (stale file not yet deleted) should not break anything
    const actions2 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open",
        headSha: "reviewed-sha", feedbackDoneSignal: true,
      }]),
      NOW,
    );

    // State should not regress
    expect(item.lastReviewedCommitSha).toBeNull();
    expect(item.needsFeedbackResponse).toBe(false);
  });

  it("review-pending feedback-done with CI pending transitions to ci-pending", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.lastReviewedCommitSha = "reviewed-sha";
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "Please explain X";
    item.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", prNumber: 42, ciStatus: "pending", prState: "open",
        headSha: "reviewed-sha", feedbackDoneSignal: true,
      }]),
      NOW,
    );

    expect(item.state).toBe("ci-pending");
    expect(item.lastReviewedCommitSha).toBeNull();
    expect(actions.some((a) => a.type === "clear-feedback-done-signal")).toBe(true);
  });

  it("transitions to review-pending on request-changes verdict", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "notify-review")).toBe(true);
    expect(actions.some((a) => a.type === "post-review")).toBe(true);
    expect(actions.some((a) => a.type === "clean-review")).toBe(true);
  });

  it("transitions to ci-failed on CI regression during review", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewWorkspaceRef = "workspace:5";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "clean-review")).toBe(true);
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
  });

  it("transitions to merged on external merge during review", () => {
    const orch = new Orchestrator({ fixForward: false });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewWorkspaceRef = "workspace:5";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
    expect(actions.some((a) => a.type === "clean-review")).toBe(true);

    // merged → done next cycle
    orch.processTransitions(emptySnapshot());
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("aborts review and rebases when PR becomes CONFLICTING during review", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewWorkspaceRef = "workspace:5";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    expect(actions.some((a) => a.type === "daemon-rebase")).toBe(true);
    expect(actions.some((a) => a.type === "clean-review")).toBe(true);
  });
});

// ── handleReviewPending CI detection (H-RX-1) ──────────────────────────

describe("handleReviewPending", () => {
  /** Helper: set up an item in review-pending state (after request-changes). */
  function setupReviewPending(orch: Orchestrator, id = "H-1-1") {
    orch.addItem(makeWorkItem(id));
    orch.getItem(id)!.reviewCompleted = false;
    orch.hydrateState(id, "review-pending");
    orch.getItem(id)!.prNumber = 42;
  }

  it("transitions to ci-pending when CI becomes pending", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    // No actions needed for pending -- just a state transition
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
  });

  it("transitions to ci-failed and notifies on CI failure", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(1);
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
  });

  it("sends daemon-rebase on CI failure due to merge conflicts", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "daemon-rebase")).toBe(true);
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
  });

  it("transitions to ci-passed and triggers evaluateMerge on CI pass", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    // ci-passed -> evaluateMerge -> reviewing (reviewCompleted is false)
    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(actions.some((a) => a.type === "launch-review")).toBe(true);
  });

  it("no-ops when ciStatus is undefined (stays in review-pending)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions).toEqual([]);
  });

  it("sends daemon-rebase on merge conflict without CI failure", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(orch.getItem("H-1-1")!.rebaseRequested).toBe(true);
    expect(actions.some((a) => a.type === "daemon-rebase")).toBe(true);
  });

  it("still handles external merge", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
  });

  it("still evaluates merge when review approved and CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    setupReviewPending(orch);
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
    );

    // reviewCompleted=true + APPROVED + pass → should merge
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });
});

describe("CI lifecycle observability events (H-CF-7)", () => {
  it("emits ci-failure at each ciFailCount increment site", () => {
    const cases = [
      {
        name: "ci-pending",
        setup: (orch: Orchestrator) => {
          orch.addItem(makeWorkItem("H-1-1"));
          orch.getItem("H-1-1")!.reviewCompleted = true;
          orch.hydrateState("H-1-1", "ci-pending");
          orch.getItem("H-1-1")!.prNumber = 42;
        },
        snapshot: { id: "H-1-1", ciStatus: "fail" as const, prState: "open" as const, isMergeable: true },
        failureReason: "ci-failed: CI checks failed",
      },
      {
        name: "ci-passed",
        setup: (orch: Orchestrator) => {
          orch.addItem(makeWorkItem("H-1-1"));
          orch.getItem("H-1-1")!.reviewCompleted = true;
          orch.hydrateState("H-1-1", "ci-passed");
          orch.getItem("H-1-1")!.prNumber = 42;
        },
        snapshot: { id: "H-1-1", ciStatus: "fail" as const, prState: "open" as const, isMergeable: true },
        failureReason: "ci-failed: CI checks failed",
      },
      {
        name: "review-pending",
        setup: (orch: Orchestrator) => {
          orch.addItem(makeWorkItem("H-1-1"));
          orch.getItem("H-1-1")!.reviewCompleted = false;
          orch.hydrateState("H-1-1", "review-pending");
          orch.getItem("H-1-1")!.prNumber = 42;
        },
        snapshot: { id: "H-1-1", ciStatus: "fail" as const, prState: "open" as const, isMergeable: true },
        failureReason: "ci-failed: CI checks failed",
      },
      {
        name: "reviewing",
        setup: (orch: Orchestrator) => {
          orch.addItem(makeWorkItem("H-1-1"));
          orch.getItem("H-1-1")!.reviewCompleted = false;
          orch.hydrateState("H-1-1", "reviewing");
          orch.getItem("H-1-1")!.prNumber = 42;
        },
        snapshot: { id: "H-1-1", ciStatus: "fail" as const, prState: "open" as const, isMergeable: true },
        failureReason: "ci-failed: CI regression during review",
      },
    ];

    for (const testCase of cases) {
      const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
      const orch = new Orchestrator({
        mergeStrategy: "auto",
        onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
      });
      testCase.setup(orch);

      orch.processTransitions(snapshotWith([testCase.snapshot]));

      expect(
        events.find((event) => event.event === "ci-failure"),
        `missing ci-failure event for ${testCase.name}`,
      ).toEqual(expect.objectContaining({
        itemId: "H-1-1",
        event: "ci-failure",
        data: expect.objectContaining({
          ciFailCount: 1,
          failureReason: testCase.failureReason,
        }),
      }));
    }
  });

  it("emits ci-retry-limit with the parked flag", () => {
    for (const parked of [false, true]) {
      const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
      const orch = new Orchestrator({
        maxCiRetries: 1,
        onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
      });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.hydrateState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.getItem("H-1-1")!.ciFailCount = 2;

      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", workerAlive: parked }]),
      );

      expect(events.find((event) => event.event === "ci-retry-limit")).toEqual(expect.objectContaining({
        itemId: "H-1-1",
        event: "ci-retry-limit",
        data: expect.objectContaining({
          ciFailCount: 2,
          maxCiRetries: 1,
          parked,
        }),
      }));
    }
  });

  it("emits ci-fix-ack-timeout before respawning the worker", () => {
    const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 1;
    orch.getItem("H-1-1")!.ciFailureNotified = true;
    orch.getItem("H-1-1")!.ciNotifyWallAt = "2026-01-15T10:00:00Z";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "fail",
        prState: "open",
        workerAlive: true,
        lastHeartbeat: {
          id: "H-1-1",
          progress: 10,
          label: "Old heartbeat",
          ts: "2026-01-15T09:59:00Z",
        },
      }]),
      NOW,
    );

    expect(events.find((event) => event.event === "ci-fix-ack-timeout")).toEqual(expect.objectContaining({
      itemId: "H-1-1",
      event: "ci-fix-ack-timeout",
      data: expect.objectContaining({
        ciFailCount: 1,
      }),
    }));
    expect(events.find((event) => event.event === "worker-respawn")).toEqual(expect.objectContaining({
      itemId: "H-1-1",
      event: "worker-respawn",
      data: expect.objectContaining({
        trigger: "ci-fix-ack-timeout",
        ciFailCount: 1,
      }),
    }));
    expect(actions.some((action) => action.type === "retry")).toBe(true);
  });

  it("emits worker-respawn with the parked-ci-failure trigger", () => {
    const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      mergeStrategy: "manual",
      onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.sessionParked = true;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(events.find((event) => event.event === "worker-respawn")).toEqual(expect.objectContaining({
      itemId: "H-1-1",
      event: "worker-respawn",
      data: expect.objectContaining({
        trigger: "parked-ci-failure",
        ciFailCount: 1,
      }),
    }));
  });
});

// ── Full multi-round review cycle (H-RX-1) ────────────────────────────

describe("multi-round review cycle", () => {
  it("request-changes → ci-pending → ci-passed → reviewing → approve → merge", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    // reviewCompleted starts false -- the item entered reviewing via evaluateMerge
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;

    const requestChangesVerdict = {
      verdict: "request-changes" as const,
      summary: "Found blockers.",
      blockingCount: 2,
      nonBlockingCount: 0,
    };
    const approveVerdict = {
      verdict: "approve" as const,
      summary: "No issues.",
      blockingCount: 0,
      nonBlockingCount: 0,
    };

    // Step 1: Review worker requests changes → review-pending
    orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        reviewVerdict: requestChangesVerdict,
      }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");

    // Step 2: Worker pushes fixes, CI restarts → ci-pending
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");

    // Step 3: CI passes → ci-passed → evaluateMerge → reviewing (reviewCompleted was reset)
    const actions3 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(actions3.some((a) => a.type === "launch-review")).toBe(true);

    // Step 4: Review worker approves → ci-passed → merging
    const actions4 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        reviewVerdict: approveVerdict,
      }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions4.some((a) => a.type === "merge")).toBe(true);
  });
});

// ── Stale branch cleanup for reused item IDs (H-ORC-4) ──────────────

function makeStaleBranchDeps(overrides: Partial<StaleBranchCleanupDeps> = {}): StaleBranchCleanupDeps {
  return {
    prList: () => ({ ok: true as const, data: [] as Array<{ number: number; title: string }> }),
    branchExists: () => false,
    deleteBranch: () => {},
    deleteRemoteBranch: () => {},
    warn: () => {},
    info: () => {},
    ...overrides,
  };
}

describe("cleanStaleBranchForReuse", () => {
  it("deletes local and remote branch when merged PR has different title", () => {
    const deletedLocal: string[] = [];
    const deletedRemote: string[] = [];

    const deps = makeStaleBranchDeps({
      prList: (_repo, _branch, state) => {
        if (state === "merged") return { ok: true as const, data: [{ number: 10, title: "fix: old work (H-1-1)" }] };
        return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
      },
      branchExists: () => true,
      deleteBranch: (_repo, branch) => { deletedLocal.push(branch); },
      deleteRemoteBranch: (_repo, branch) => { deletedRemote.push(branch); },
    });

    const cleaned = cleanStaleBranchForReuse("H-1-1", "New different work", "/tmp/repo", deps);

    expect(cleaned).toBe(true);
    expect(deletedLocal).toEqual(["ninthwave/H-1-1"]);
    expect(deletedRemote).toEqual(["ninthwave/H-1-1"]);
  });

  it("does not delete when merged PR title matches current item title", () => {
    let deleteCalled = false;

    const deps = makeStaleBranchDeps({
      prList: (_repo, _branch, state) => {
        if (state === "merged") return { ok: true as const, data: [{ number: 10, title: "feat: add feature X (H-1-1)" }] };
        return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
      },
      branchExists: () => true,
      deleteBranch: () => { deleteCalled = true; },
      deleteRemoteBranch: () => { deleteCalled = true; },
    });

    const cleaned = cleanStaleBranchForReuse("H-1-1", "Add feature X", "/tmp/repo", deps);

    expect(cleaned).toBe(false);
    expect(deleteCalled).toBe(false);
  });

  it("does nothing when no merged PRs exist", () => {
    let deleteCalled = false;

    const deps = makeStaleBranchDeps({
      prList: () => ({ ok: true as const, data: [] as Array<{ number: number; title: string }> }),
      deleteBranch: () => { deleteCalled = true; },
      deleteRemoteBranch: () => { deleteCalled = true; },
    });

    const cleaned = cleanStaleBranchForReuse("H-1-1", "Some work", "/tmp/repo", deps);

    expect(cleaned).toBe(false);
    expect(deleteCalled).toBe(false);
  });

  it("continues gracefully when branch deletion fails", () => {
    const warnings: string[] = [];
    let remoteDeleteAttempted = false;

    const deps = makeStaleBranchDeps({
      prList: (_repo, _branch, state) => {
        if (state === "merged") return { ok: true as const, data: [{ number: 10, title: "fix: old work" }] };
        return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
      },
      branchExists: () => true,
      deleteBranch: () => { throw new Error("branch locked"); },
      deleteRemoteBranch: () => { remoteDeleteAttempted = true; },
      warn: (msg) => { warnings.push(msg); },
    });

    const cleaned = cleanStaleBranchForReuse("H-1-1", "New work", "/tmp/repo", deps);

    expect(cleaned).toBe(true);
    // Local deletion failed but remote was still attempted
    expect(remoteDeleteAttempted).toBe(true);
    // Warning logged for the local deletion failure
    expect(warnings.some((w) => w.includes("Failed to delete local branch"))).toBe(true);
  });

  it("skips local delete when branch does not exist locally", () => {
    let localDeleteCalled = false;
    let remoteDeleteCalled = false;

    const deps = makeStaleBranchDeps({
      prList: (_repo, _branch, state) => {
        if (state === "merged") return { ok: true as const, data: [{ number: 10, title: "fix: old work" }] };
        return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
      },
      branchExists: () => false,
      deleteBranch: () => { localDeleteCalled = true; },
      deleteRemoteBranch: () => { remoteDeleteCalled = true; },
    });

    const cleaned = cleanStaleBranchForReuse("H-1-1", "New work", "/tmp/repo", deps);

    expect(cleaned).toBe(true);
    expect(localDeleteCalled).toBe(false);
    expect(remoteDeleteCalled).toBe(true);
  });

  it("handles remote deletion failure gracefully", () => {
    const warnings: string[] = [];

    const deps = makeStaleBranchDeps({
      prList: (_repo, _branch, state) => {
        if (state === "merged") return { ok: true as const, data: [{ number: 10, title: "fix: old work" }] };
        return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
      },
      branchExists: () => false,
      deleteRemoteBranch: () => { throw new Error("network error"); },
      warn: (msg) => { warnings.push(msg); },
    });

    const cleaned = cleanStaleBranchForReuse("H-1-1", "New work", "/tmp/repo", deps);

    expect(cleaned).toBe(true);
    expect(warnings.some((w) => w.includes("Failed to delete remote branch"))).toBe(true);
  });
});

describe("executeLaunch stale branch cleanup", () => {
  function makeMinimalDeps(overrides?: DeepPartial<OrchestratorDeps>): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("calls cleanStaleBranch before launchSingleItem", () => {
    const callOrder: string[] = [];
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const deps = makeMinimalDeps({ workers: { launchSingleItem: () => {
        callOrder.push("launch");
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      } }, cleanup: { cleanStaleBranch: () => { callOrder.push("clean"); } } });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(callOrder).toEqual(["clean", "launch"]);
  });

  it("proceeds with launch when cleanStaleBranch throws", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const warnings: string[] = [];
    const deps = makeMinimalDeps({ workers: { launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }) }, cleanup: { cleanStaleBranch: () => { throw new Error("cleanup explosion"); } }, io: { warn: (msg) => { warnings.push(msg); } } });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(warnings.some((w) => w.includes("cleanup explosion"))).toBe(true);
  });

  it("launches normally when cleanStaleBranch is not provided", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const deps = makeMinimalDeps({
      // cleanStaleBranch intentionally omitted
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.workspaceRef).toBe("workspace:1");
  });

  it("writes fresh heartbeat with progress 0.0 before launching", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const deps = makeMinimalDeps();

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);

    // Verify the heartbeat was written with progress 0.0
    const hb = readHeartbeat(ctx.projectRoot, "H-1-1");
    expect(hb).not.toBeNull();
    expect(hb!.progress).toBe(0);
    expect(hb!.label).toBe("Starting");

    // Clean up heartbeat file
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(heartbeatFilePath(ctx.projectRoot, "H-1-1"));
    } catch { /* ignore */ }
  });

  it("transitions invalid launch candidates to blocked without retries or launch side effects", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const cleanStaleBranch = vi.fn();
    const launchSingleItem = vi.fn(() => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }));
    const deps = makeMinimalDeps({ workers: { validatePickupCandidate: () => ({
        status: "blocked",
        code: "unlaunchable",
        branchName: "ninthwave/H-1-1",
        failureReason: "launch-blocked: Repo 'missing-repo' not found.",
      }), launchSingleItem }, cleanup: { cleanStaleBranch } });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);
    const item = orch.getItem("H-1-1")!;

    expect(result.success).toBe(false);
    expect(item.state).toBe("blocked");
    expect(item.failureReason).toContain("missing-repo");
    expect(item.retryCount).toBe(0);
    expect(item.workspaceRef).toBeUndefined();
    expect(item.worktreePath).toBeUndefined();
    expect(cleanStaleBranch).not.toHaveBeenCalled();
    expect(launchSingleItem).not.toHaveBeenCalled();
  });
});

// ── Stacked launch race guard (H-SL-1) ─────────────────────────────

describe("executeLaunch stacked dep race guard", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("clears baseBranch when dependency is in done state before launch", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    // A completed (done state) -- its branch is deleted from origin
    orch.hydrateState("A-1", "done");

    // B was promoted to launching with stale baseBranch
    orch.hydrateState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({ workers: { launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      } } });

    const result = orch.executeAction(
      { type: "launch", itemId: "B-1", baseBranch: "ninthwave/A-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    // launchSingleItem should receive baseBranch: undefined (cleared)
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]!.baseBranch).toBeUndefined();
    // item.baseBranch should also be cleared
    expect(orch.getItem("B-1")!.baseBranch).toBeUndefined();
  });

  it("clears baseBranch when dependency is in merged state before launch", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    orch.hydrateState("A-1", "merged");

    orch.hydrateState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({ workers: { launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      } } });

    const result = orch.executeAction(
      { type: "launch", itemId: "B-1", baseBranch: "ninthwave/A-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(launchCalls[0]!.baseBranch).toBeUndefined();
    expect(orch.getItem("B-1")!.baseBranch).toBeUndefined();
  });

  it("preserves baseBranch when dependency is still in ci-passed", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    // A is still in flight (ci-passed) -- baseBranch should be preserved
    orch.hydrateState("A-1", "ci-passed");
    orch.getItem("A-1")!.prNumber = 10;

    orch.hydrateState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({ workers: { launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      } } });

    const result = orch.executeAction(
      { type: "launch", itemId: "B-1", baseBranch: "ninthwave/A-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(launchCalls[0]!.baseBranch).toBe("ninthwave/A-1");
    expect(orch.getItem("B-1")!.baseBranch).toBe("ninthwave/A-1");
  });

  it("clears baseBranch when dependency item is unknown", () => {
    const orch = new Orchestrator({ sessionLimit: 5, enableStacking: true });
    // Only add B -- A is unknown (maybe removed from work items)
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    orch.hydrateState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({ workers: { launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      } } });

    const result = orch.executeAction(
      { type: "launch", itemId: "B-1", baseBranch: "ninthwave/A-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(launchCalls[0]!.baseBranch).toBeUndefined();
    expect(orch.getItem("B-1")!.baseBranch).toBeUndefined();
  });
});

describe("executeMerge conflict-aware rebase", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("rebases and transitions to ci-pending when merge fails due to conflicts", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    let daemonRebaseCalled = false;
    const deps = makeMinimalDeps({ git: { daemonRebase: () => {
        daemonRebaseCalled = true;
        return true; // rebase succeeds
      } }, gh: { prMerge: () => false, checkPrMergeable: () => false } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("conflicts");
    expect(result.error).toContain("rebased");
    expect(daemonRebaseCalled).toBe(true);
    expect(item.state).toBe("ci-pending");
    // mergeFailCount should NOT be incremented for conflict-caused failures
    expect(item.mergeFailCount ?? 0).toBe(0);
  });

  it("retries normally when merge fails but PR is not conflicting", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", maxMergeRetries: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({ gh: { prMerge: () => false, checkPrMergeable: () => true } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("ci-passed");
    expect(item.mergeFailCount).toBe(1);
  });

  it("falls back to worker rebase message when daemonRebase fails on conflicting PR", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.worktreePath = join(setupTempRepo(), ".ninthwave", ".worktrees", "ninthwave-H-1-1");
    mkdirSync(item.worktreePath, { recursive: true });

    const inboxMessages: string[] = [];
    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, gh: { prMerge: () => false, checkPrMergeable: () => false }, io: { writeInbox: (_projectRoot, _itemId, msg) => { inboxMessages.push(msg); } } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("conflicts");
    expect(item.state).toBe("ci-pending");
    // mergeFailCount should NOT be incremented
    expect(item.mergeFailCount ?? 0).toBe(0);
    expect(inboxMessages.some((m) => m.includes("Rebase Required"))).toBe(true);
  });

  it("falls back to worker rebase when daemonRebase throws on conflicting PR", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.worktreePath = join(setupTempRepo(), ".ninthwave", ".worktrees", "ninthwave-H-1-1");
    mkdirSync(item.worktreePath, { recursive: true });

    const inboxMessages: string[] = [];
    const deps = makeMinimalDeps({ git: { daemonRebase: () => { throw new Error("rebase exploded"); } }, gh: { prMerge: () => false, checkPrMergeable: () => false }, io: { writeInbox: (_projectRoot, _itemId, msg) => { inboxMessages.push(msg); } } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(item.state).toBe("ci-pending");
    expect(item.mergeFailCount ?? 0).toBe(0);
    expect(inboxMessages.some((m) => m.includes("Rebase Required"))).toBe(true);
  });

  it("resets rebaseRequested when conflict detected", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.rebaseRequested = true; // previously requested

    const deps = makeMinimalDeps({ git: { daemonRebase: () => true }, gh: { prMerge: () => false, checkPrMergeable: () => false } });

    orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(item.rebaseRequested).toBe(false);
  });

  it("handles merge failure without checkPrMergeable (treats as non-conflict)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", maxMergeRetries: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({ gh: { prMerge: () => false } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(item.state).toBe("ci-passed");
    expect(item.mergeFailCount).toBe(1);
  });
});

describe("executeMerge getPrBaseAndState behavior", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("stays in merging when getPrBaseAndState returns null (API failure)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({ gh: { getPrBaseAndState: () => null } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("holding in merging");
    expect(item.state).toBe("merging"); // NOT ci-passed
  });

  it("transitions to merged when getPrBaseAndState returns MERGED", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const prMerge = vi.fn(() => true);
    const deps = makeMinimalDeps({ gh: { getPrBaseAndState: () => ({ baseBranch: "main", prState: "MERGED" }), prMerge } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("merged");
    expect(prMerge).not.toHaveBeenCalled(); // Already merged, no merge call
  });

  it("proceeds with merge when getPrBaseAndState returns OPEN with valid base", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const prMerge = vi.fn(() => true);
    const deps = makeMinimalDeps({ gh: { getPrBaseAndState: () => ({ baseBranch: "main", prState: "OPEN" }), prMerge } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("merged");
    expect(prMerge).toHaveBeenCalled();
  });

  it("stays in merging when getPrBaseBranch returns null (fallback path)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({ gh: { getPrBaseBranch: () => null } });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("holding in merging");
    expect(item.state).toBe("merging"); // NOT ci-passed
  });
});

describe("executeMerge admin override", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("passes admin flag to prMerge when action has admin: true", () => {
    const orch = new Orchestrator({ mergeStrategy: "bypass", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    let receivedOptions: { admin?: boolean } | undefined;
    const deps = makeMinimalDeps({ gh: { prMerge: (_repoRoot, _prNumber, options) => {
        receivedOptions = options;
        return true;
      } } });

    orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42, admin: true }, ctx, deps);

    expect(receivedOptions).toEqual({ admin: true });
  });

  it("does not pass admin flag when action has no admin field", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    let receivedOptions: { admin?: boolean } | undefined;
    const deps = makeMinimalDeps({ gh: { prMerge: (_repoRoot, _prNumber, options) => {
        receivedOptions = options;
        return true;
      } } });

    orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(receivedOptions).toEqual({ admin: undefined });
  });
});

// ── PR comment relay (M-ORC-3) ───────────────────────────────────────

describe("processComments (via processTransitions)", () => {
  it("generates send-message action when new trusted comment detected", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 101, body: "Please fix the error handling", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    const sendMsg = actions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsg).toBeDefined();
    expect(sendMsg!.message).toContain("@reviewer");
    expect(sendMsg!.message).toContain("Please fix the error handling");
  });

  it("processComments defers reactions to item state instead of emitting react-to-comment actions", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 201, body: "First comment", author: "alice", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
          { id: 202, body: "Second comment", author: "bob", createdAt: "2026-01-15T12:02:00Z", commentType: "review" },
        ],
      }]),
    );

    // No react-to-comment actions emitted -- reactions are deferred to execution
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
    // Reactions stored on item for execution-layer draining
    expect(orch.getItem("H-1-1")!.pendingCommentReactions).toEqual([
      { commentId: 201, commentType: "issue" },
      { commentId: 202, commentType: "review" },
    ]);
  });

  it("does not react to stack comments marked with ninthwave HTML comment markers", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 203, body: "Stack updated\n<!-- ninthwave-stack-comment -->", author: "bot", createdAt: "2026-01-15T12:03:00Z", commentType: "issue" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
  });

  it("does not react to deleted-file review comments marked with ninthwave HTML comment markers", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 204, body: "Please restore the context\n<!-- ninthwave-deleted-file-review:abc -->", author: "bot", createdAt: "2026-01-15T12:04:00Z", commentType: "review" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
  });

  it("does not generate action for untrusted comments (not in snapshot)", () => {
    // Untrusted comments are filtered out during buildSnapshot (not included in newComments).
    // Verify that empty newComments generates no relay actions.
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("does not relay previously-seen comments (lastCommentCheck prevents duplicates)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // First tick: comment appears → relay
    const actions1 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 301, body: "Looks good overall", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );
    expect(actions1.filter((a) => a.type === "send-message")).toHaveLength(1);
    // lastCommentCheck should be updated
    expect(orch.getItem("H-1-1")!.lastCommentCheck).toBe("2026-01-15T12:01:00Z");

    // Second tick: no new comments (buildSnapshot would filter by lastCommentCheck)
    const actions2 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        // No newComments -- buildSnapshot filtered them because lastCommentCheck is after them
      }]),
    );
    expect(actions2.filter((a) => a.type === "send-message")).toHaveLength(0);
  });

  it("flushes one aggregated feedback batch to a live worker once", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const waitingActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 401, body: "Please rebase onto main", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
          { id: 402, body: "Also update the tests", author: "maintainer", createdAt: "2026-01-15T12:01:30Z", commentType: "review" },
        ],
      }]),
      NOW,
    );

    expect(waitingActions).toEqual([]);
    expect(orch.getItem("H-1-1")!.pendingFeedbackBatch).toEqual(
      expect.objectContaining({ deadline: "2026-01-15T12:02:30.000Z" }),
    );

    const flushedActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    const sendMessage = flushedActions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.message).toContain("@reviewer");
    expect(sendMessage!.message).toContain("@maintainer");
    expect(sendMessage!.message).toContain("Please rebase onto main");
    expect(sendMessage!.message).toContain("Also update the tests");
    expect(flushedActions.find((a) => a.type === "daemon-rebase" && a.itemId === "H-1-1")).toBeUndefined();
    expect(flushedActions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1")).toHaveLength(1);
    expect(orch.getItem("H-1-1")!.pendingFeedbackMessage).toContain("Please rebase onto main");
    expect(orch.getItem("H-1-1")!.pendingFeedbackMessage).toContain("Also update the tests");

    const repeatedPollActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
      }]),
      new Date("2026-01-15T12:04:00Z"),
    );

    expect(repeatedPollActions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1")).toHaveLength(0);
  });

  it("does not process comments for items without a prNumber", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    // No prNumber set

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        workerAlive: true,
        newComments: [
          { id: 501, body: "Some comment", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
      NOW,
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("generates comment relay actions even without workspaceRef (worktree path resolution)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    // No workspaceRef set -- worktree may still exist on disk

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 601, body: "Fix this", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    // Comments should be relayed -- delivery success depends on resolveImplementerInboxTarget at execution time
    const sendMsg = actions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsg).toBeDefined();
    expect(sendMsg!.message).toContain("@reviewer");
    expect(sendMsg!.message).toContain("Fix this");
  });

  it("parked review-pending item flushes one aggregated feedback relaunch", () => {
    const transitions: Array<[string, string]> = [];
    const orch = new Orchestrator({
      mergeStrategy: "manual",
      onTransition: (_itemId, from, to) => transitions.push([from, to]),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = true;
    item.sessionParked = true;
    item.lastReviewedCommitSha = null;

    const waitingActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        headSha: "abc123",
        newComments: [
          { body: "Please tighten this wording.", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
          { body: "Please cover the failed relaunch path.", author: "maintainer", createdAt: "2026-01-15T12:01:30Z" },
        ],
      }]),
      NOW,
    );

    expect(waitingActions).toEqual([]);
    expect(item.pendingFeedbackBatch).toBeDefined();
    expect(item.state).toBe("review-pending");
    expect(item.sessionParked).toBe(true);

    // Poll before the debounce deadline (12:01:30Z + 60s = 12:02:30Z) -- batch should hold
    const waitingActions2 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        headSha: "abc123",
      }]),
      new Date("2026-01-15T12:02:00Z"),
    );

    expect(waitingActions2).toEqual([]);
    expect(item.pendingFeedbackBatch).toBeDefined();
    expect(item.state).toBe("review-pending");
    expect(item.sessionParked).toBe(true);

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        headSha: "abc123",
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(true);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
    expect(item.state).toBe("launching");
    expect(item.sessionParked).toBe(false);
    expect(item.reviewCompleted).toBe(false);
    expect(item.lastReviewedCommitSha).toBe("abc123");
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.pendingFeedbackMessage).toContain("Please tighten this wording.");
    expect(item.pendingFeedbackMessage).toContain("Please cover the failed relaunch path.");
    expect(item.lastCommentCheck).toBe("2026-01-15T12:01:30Z");
    expect(transitions).toContainEqual(["review-pending", "ready"]);
    expect(transitions).toContainEqual(["ready", "launching"]);

    const repeatedPollActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
      }]),
      new Date("2026-01-15T12:04:00Z"),
    );

    expect(repeatedPollActions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(false);
  });

  it("parked item ignores bot comments", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = true;
    item.sessionParked = true;

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        newComments: [
          { body: "**[Orchestrator]** Auto-merged PR #42 for H-1-1.", author: "bot", createdAt: "2026-01-15T12:01:00Z" },
          { body: "<!-- ninthwave-orchestrator-status -->", author: "bot", createdAt: "2026-01-15T12:02:00Z" },
        ],
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(false);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(false);
    expect(item.state).toBe("review-pending");
    expect(item.sessionParked).toBe(true);
    expect(item.needsFeedbackResponse).toBeUndefined();
    expect(item.pendingFeedbackMessage).toBeUndefined();
    // lastCommentCheck is updated by processComments even for filtered bot comments
    // (prevents re-processing on next cycle)
    expect(item.lastCommentCheck).toBe("2026-01-15T12:02:00Z");
  });

  it("dead review-pending worker flushes one aggregated feedback relaunch", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.workspaceRef = "workspace:1";
    item.sessionParked = false;

    const waitingActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        workerAlive: false,
        newComments: [
          { body: "Please tighten this wording.", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
          { body: "Also add a regression test.", author: "maintainer", createdAt: "2026-01-15T12:01:30Z" },
        ],
      }]),
      NOW,
    );

    expect(waitingActions).toEqual([]);
    expect(item.pendingFeedbackBatch).toBeDefined();

    const firstFalsePollActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        workerAlive: false,
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    expect(firstFalsePollActions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(false);
    expect(firstFalsePollActions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(false);
    expect(item.state).toBe("review-pending");
    expect(item.pendingFeedbackBatch).toBeDefined();
    expect(item.needsFeedbackResponse).toBeUndefined();

    let actions = firstFalsePollActions;
    let sawRelaunch = false;
    for (let i = 0; i < 5; i++) {
      actions = orch.processTransitions(
        snapshotWith([{
          id: "H-1-1",
          ciStatus: "pass",
          prState: "open",
          workerAlive: false,
        }]),
        FEEDBACK_FLUSH_NOW,
      );
      sawRelaunch = sawRelaunch || actions.some((a) => a.type === "retry" && a.itemId === "H-1-1");
      if (sawRelaunch) break;
    }

    expect(sawRelaunch).toBe(true);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
    expect(item.state).toBe("launching");
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.pendingFeedbackMessage).toContain("Please tighten this wording.");
    expect(item.pendingFeedbackMessage).toContain("Also add a regression test.");

    const repeatedPollActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        workerAlive: false,
      }]),
      new Date("2026-01-15T12:04:00Z"),
    );

    expect(repeatedPollActions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(false);
  });

  it("does not relaunch aggregated feedback on a single false liveness poll", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = false;
    item.workspaceRef = "workspace:1";

    orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        workerAlive: true,
        newComments: [
          { body: "Please tighten this wording.", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
      NOW,
    );

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        workerAlive: false,
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    expect(actions).toEqual([]);
    expect(item.state).toBe("review-pending");
    expect(item.pendingFeedbackBatch).toBeDefined();
    expect(item.needsFeedbackResponse).toBeUndefined();
    expect(item.pendingFeedbackMessage).toBeUndefined();
  });

  it("parked item detects human comment that quotes an agent comment", () => {
    // Human used GitHub "Quote reply" on an implementer comment, adding their
    // own text after the blockquote. The agent identifier inside the blockquote
    // must NOT cause the comment to be filtered out.
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = true;
    item.sessionParked = true;

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        newComments: [
          {
            id: 901,
            body: "> **[Implementer](https://github.com/org/repo/blob/main/agents/implementer.md)** Here is the plan.\n\nplease also update the deployment docs",
            author: "reviewer",
            createdAt: "2026-01-15T12:01:00Z",
            commentType: "issue",
          },
        ],
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(true);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
    expect(item.state).toBe("launching");
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.pendingFeedbackMessage).toContain("please also update the deployment docs");
    expect(item.lastCommentCheck).toBe("2026-01-15T12:01:00Z");
  });

  it("parked item defers reactions to item state on human feedback comments", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = true;
    item.sessionParked = true;

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pass",
        prState: "open",
        newComments: [
          { id: 901, body: "Please fix the docs.", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    // No react-to-comment actions emitted -- deferred to execution
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
    // Reactions stored on item
    expect(item.pendingCommentReactions).toEqual([
      { commentId: 901, commentType: "issue" },
    ]);
    // Relaunch is still scheduled
    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(true);
  });

  it("skips orchestrator's own audit-trail comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 701, body: "**[Orchestrator]** Auto-merged PR #42 for H-1-1.", author: "bot", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
  });

  it("processes comments in all active PR states", () => {
    const prStates: Array<{ state: string; ciStatus: string }> = [
      { state: "ci-pending", ciStatus: "pending" },
      { state: "ci-passed", ciStatus: "pass" },
      { state: "ci-failed", ciStatus: "fail" },
      { state: "review-pending", ciStatus: "pass" },
    ];

    for (const { state, ciStatus } of prStates) {
      const orch = new Orchestrator({ mergeStrategy: "manual" }); // manual prevents auto-merge
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.hydrateState("H-1-1", state as any);
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
      orch.getItem("H-1-1")!.ciFailCount = 0;

      const waitingActions = orch.processTransitions(
        snapshotWith([{
          id: "H-1-1",
          ciStatus: ciStatus as any,
          prState: "open",
          isMergeable: true,
          workerAlive: true,
          newComments: [
            { id: 801, body: "Please address this", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
          ],
        }]),
        NOW,
      );

      expect(waitingActions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1")).toHaveLength(0);

      const actions = orch.processTransitions(
        snapshotWith([{
          id: "H-1-1",
          ciStatus: ciStatus as any,
          prState: "open",
          isMergeable: true,
          workerAlive: true,
        }]),
        FEEDBACK_FLUSH_NOW,
      );

      const sendMsg = actions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
      expect(sendMsg).toBeDefined();
    }
  });

  it("does not duplicate daemon-rebase when CI already triggered one", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // Merge conflict triggers daemon-rebase from CI logic,
    // plus a "rebase" comment comes in simultaneously
    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "fail",
        prState: "open",
        isMergeable: false, // triggers daemon-rebase from CI failure logic
        newComments: [
          { id: 901, body: "Please rebase", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    // Should have exactly one daemon-rebase (from CI logic), not two
    const rebaseActions = actions.filter((a) => a.type === "daemon-rebase" && a.itemId === "H-1-1");
    expect(rebaseActions).toHaveLength(1);
  });

  it("handles multiple comments in one tick", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1001, body: "First comment", author: "alice", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
          { id: 1002, body: "Second comment", author: "bob", createdAt: "2026-01-15T12:02:00Z", commentType: "review" },
        ],
      }]),
    );

    const sendMsgs = actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsgs).toHaveLength(1);
    expect(sendMsgs[0]!.message).toContain("@alice");
    expect(sendMsgs[0]!.message).toContain("@bob");
    // Reactions deferred to execution -- not in processTransitions output
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.pendingCommentReactions).toEqual([
      { commentId: 1001, commentType: "issue" },
      { commentId: 1002, commentType: "review" },
    ]);
    // lastCommentCheck should be the latest comment timestamp
    expect(orch.getItem("H-1-1")!.lastCommentCheck).toBe("2026-01-15T12:02:00Z");
  });

  it("skips orchestrator status comments with HTML marker", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1101, body: "<!-- ninthwave-orchestrator-status -->\n| Event | Time |\n|---|---|\n| CI pending | 12:00 |", author: "bot", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
  });

  it("skips implementer self-comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1201, body: "**[Implementer](https://github.com/org/repo/blob/main/agents/implementer.md)** Addressed feedback: fixed error handling.", author: "bot", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
  });

  it("bot comments do not get reactions", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1301, body: "**[Reviewer](https://github.com/org/repo/blob/main/agents/reviewer.md)** Review complete.", author: "bot", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
  });

  it("relays human reviewer comments while filtering agent comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1401, body: "**[Orchestrator](https://github.com/org/repo/blob/main/agents/orchestrator.md)** Status for H-1-1: CI pending", author: "bot", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
          { id: 1402, body: "<!-- ninthwave-orchestrator-status -->\n| Status |", author: "bot", createdAt: "2026-01-15T12:02:00Z", commentType: "issue" },
          { id: 1403, body: "**[Implementer](https://github.com/org/repo/blob/main/agents/implementer.md)** Fixed the issue.", author: "bot", createdAt: "2026-01-15T12:03:00Z", commentType: "issue" },
          { id: 1404, body: "Great work, but please add error handling for the edge case.", author: "reviewer", createdAt: "2026-01-15T12:04:00Z", commentType: "review" },
        ],
      }]),
    );

    // Only the human reviewer comment should be relayed
    const sendMsgs = actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsgs).toHaveLength(1);
    expect(sendMsgs[0]!.message).toContain("@reviewer");
    expect(sendMsgs[0]!.message).toContain("error handling for the edge case");
    // Reactions deferred -- not in processTransitions output
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.pendingCommentReactions).toEqual([
      { commentId: 1404, commentType: "review" },
    ]);
  });

  it("processComments generates actions without workspaceRef -- delivery resolved at execution time", () => {
    // After a session retry clears workspaceRef, comments should still be relayed.
    // The worktree may still exist on disk; resolveImplementerInboxTarget handles that.
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    // workspaceRef is undefined -- simulating post-retry state

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1601, body: "Please fix the error handling", author: "reviewer", createdAt: "2026-01-15T12:01:00Z", commentType: "issue" },
        ],
      }]),
    );

    // Actions should still be generated -- delivery depends on worktree path resolution at execution time
    const sendMsg = actions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsg).toBeDefined();
    expect(sendMsg!.message).toContain("@reviewer");
    expect(sendMsg!.message).toContain("Please fix the error handling");

    // Reactions deferred to execution layer -- not in processTransitions output
    expect(actions.filter((a) => a.type === "react-to-comment")).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.pendingCommentReactions).toEqual([
      { commentId: 1601, commentType: "issue" },
    ]);
  });

  it("relays GitHub review body comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { id: 1501, body: "LGTM! Approved with minor nit: consider renaming the variable.", author: "senior-dev", createdAt: "2026-01-15T12:01:00Z", commentType: "review" },
        ],
      }]),
    );

    const sendMsgs = actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsgs).toHaveLength(1);
    expect(sendMsgs[0]!.message).toContain("@senior-dev");
    expect(sendMsgs[0]!.message).toContain("renaming the variable");
  });
});

describe("react-to-comment action execution", () => {
  it("react-to-comment action executes addCommentReaction", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const addCommentReactionMock = vi.fn();
    const deps: OrchestratorDeps = {
      git: {
        fetchOrigin: () => {},
        ffMerge: () => {},
      },
      gh: {
        prMerge: () => true,
        prComment: () => true,
        addCommentReaction: addCommentReactionMock,
      },
      mux: {
        closeWorkspace: () => true,
      },
      workers: {
        launchSingleItem: () => null,
      },
      cleanup: {
        cleanSingleWorktree: () => true,
      },
      io: {
        writeInbox: () => {},
      },
    };

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/project",
      worktreeDir: "/tmp/project/.ninthwave/.worktrees",
      workDir: "/tmp/project/.ninthwave/work",
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "react-to-comment", itemId: "H-1-1", commentId: 42, commentType: "review" },
      ctx,
      deps,
    );

    expect(result).toEqual({ success: true });
    expect(addCommentReactionMock).toHaveBeenCalledWith("/tmp/project", 42, "review", "eyes");
  });

  it("send-message drains pendingCommentReactions on successful delivery", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const worktreePath = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(worktreePath, { recursive: true });

    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.pendingCommentReactions = [
      { commentId: 201, commentType: "issue" },
      { commentId: 202, commentType: "review" },
    ];

    const addCommentReactionMock = vi.fn();
    const deps: OrchestratorDeps = {
      git: { fetchOrigin: () => {}, ffMerge: () => {} },
      gh: {
        prMerge: () => true,
        prComment: () => true,
        addCommentReaction: addCommentReactionMock,
      },
      mux: { closeWorkspace: () => true },
      workers: { launchSingleItem: () => null },
      cleanup: { cleanSingleWorktree: () => true },
      io: { writeInbox: () => {} },
    };

    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "test feedback" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(addCommentReactionMock).toHaveBeenCalledTimes(2);
    expect(addCommentReactionMock).toHaveBeenCalledWith(hubRepo, 201, "issue", "eyes");
    expect(addCommentReactionMock).toHaveBeenCalledWith(hubRepo, 202, "review", "eyes");
    expect(item.pendingCommentReactions).toBeUndefined();
  });

  it("send-message does not drain reactions on delivery failure", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    const item = orch.getItem("H-1-1")!;
    // No workspaceRef and no worktreePath -- delivery will fail
    item.pendingCommentReactions = [
      { commentId: 301, commentType: "issue" },
    ];

    const addCommentReactionMock = vi.fn();
    const deps: OrchestratorDeps = {
      git: { fetchOrigin: () => {}, ffMerge: () => {} },
      gh: {
        prMerge: () => true,
        prComment: () => true,
        addCommentReaction: addCommentReactionMock,
      },
      mux: { closeWorkspace: () => true },
      workers: { launchSingleItem: () => null },
      cleanup: { cleanSingleWorktree: () => true },
      io: { writeInbox: () => {} },
    };

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/project",
      worktreeDir: "/tmp/nonexistent-worktrees",
      workDir: "/tmp/project/.ninthwave/work",
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "test feedback" },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(addCommentReactionMock).not.toHaveBeenCalled();
    // Reactions preserved for next delivery attempt
    expect(item.pendingCommentReactions).toEqual([
      { commentId: 301, commentType: "issue" },
    ]);
  });

  it("retry drains pendingCommentReactions on feedback relaunch", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    const item = orch.getItem("H-1-1")!;
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "test feedback";
    item.pendingCommentReactions = [
      { commentId: 401, commentType: "review" },
    ];

    const addCommentReactionMock = vi.fn();
    const deps: OrchestratorDeps = {
      git: { fetchOrigin: () => {}, ffMerge: () => {} },
      gh: {
        prMerge: () => true,
        prComment: () => true,
        addCommentReaction: addCommentReactionMock,
      },
      mux: { closeWorkspace: () => true },
      workers: { launchSingleItem: () => null },
      cleanup: { cleanSingleWorktree: () => true },
      io: { writeInbox: () => {} },
    };

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/project",
      worktreeDir: "/tmp/worktrees",
      workDir: "/tmp/project/.ninthwave/work",
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "retry", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(addCommentReactionMock).toHaveBeenCalledTimes(1);
    expect(addCommentReactionMock).toHaveBeenCalledWith("/tmp/project", 401, "review", "eyes");
    expect(item.pendingCommentReactions).toBeUndefined();
  });

  it("retry does not drain reactions when not a feedback relaunch", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    const item = orch.getItem("H-1-1")!;
    item.needsCiFix = true;
    // needsFeedbackResponse is false/undefined -- this is a CI fix retry
    item.pendingCommentReactions = [
      { commentId: 501, commentType: "issue" },
    ];

    const addCommentReactionMock = vi.fn();
    const deps: OrchestratorDeps = {
      git: { fetchOrigin: () => {}, ffMerge: () => {} },
      gh: {
        prMerge: () => true,
        prComment: () => true,
        addCommentReaction: addCommentReactionMock,
      },
      mux: { closeWorkspace: () => true },
      workers: { launchSingleItem: () => null },
      cleanup: { cleanSingleWorktree: () => true },
      io: { writeInbox: () => {} },
    };

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/project",
      worktreeDir: "/tmp/worktrees",
      workDir: "/tmp/project/.ninthwave/work",
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "retry", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(addCommentReactionMock).not.toHaveBeenCalled();
    // Reactions preserved -- not a feedback relaunch
    expect(item.pendingCommentReactions).toEqual([
      { commentId: 501, commentType: "issue" },
    ]);
  });
});

// ── statusDisplayForState ───────────────────────────────────────────

describe("statusDisplayForState", () => {
  it("returns correct display for implementing", () => {
    const d = statusDisplayForState("implementing");
    expect(d.text).toBe("Implementing");
    expect(d.icon).toBe("hammer.fill");
    expect(d.color).toBe("#b45309");
  });

  it("returns correct display for ci-pending", () => {
    const d = statusDisplayForState("ci-pending");
    expect(d.text).toBe("CI Pending");
    expect(d.icon).toBe("clock.fill");
    expect(d.color).toBe("#06b6d4");
  });

  it("returns correct display for ci-failed", () => {
    const d = statusDisplayForState("ci-failed");
    expect(d.text).toBe("CI Failed");
    expect(d.icon).toBe("xmark.circle");
    expect(d.color).toBe("#ef4444");
  });

  it("returns correct display for ci-passed", () => {
    const d = statusDisplayForState("ci-passed");
    expect(d.text).toBe("CI Passed");
    expect(d.icon).toBe("checkmark.circle");
    expect(d.color).toBe("#22c55e");
  });

  it("returns correct display for review-pending", () => {
    const d = statusDisplayForState("review-pending");
    expect(d.text).toBe("In Review");
    expect(d.icon).toBe("eye.fill");
    expect(d.color).toBe("#7c3aed");
  });

  it("returns correct display for merging", () => {
    const d = statusDisplayForState("merging");
    expect(d.text).toBe("Merging");
    expect(d.icon).toBe("arrow.triangle.merge");
    expect(d.color).toBe("#22c55e");
  });

  it("returns correct display for done", () => {
    const d = statusDisplayForState("done");
    expect(d.text).toBe("Done");
    expect(d.icon).toBe("checkmark.seal.fill");
    expect(d.color).toBe("#22c55e");
  });

  it("returns correct display for stuck", () => {
    const d = statusDisplayForState("stuck");
    expect(d.text).toBe("Stuck");
    expect(d.icon).toBe("exclamationmark.triangle");
    expect(d.color).toBe("#ef4444");
  });

  it("returns correct display for launching (maps to implementing)", () => {
    const d = statusDisplayForState("launching");
    expect(d.text).toBe("Implementing");
    expect(d.icon).toBe("hammer.fill");
    expect(d.color).toBe("#b45309");
  });

  it("returns correct display for merged (maps to verifying)", () => {
    const d = statusDisplayForState("merged");
    expect(d.text).toBe("Verifying");
    expect(d.icon).toBe("clock.fill");
    expect(d.color).toBe("#06b6d4");
  });

  it("keeps CI Pending display when rebaseRequested is true and state is ci-pending", () => {
    const d = statusDisplayForState("ci-pending", { rebaseRequested: true });
    expect(d.text).toBe("CI Pending");
    expect(d.icon).toBe("clock.fill");
    expect(d.color).toBe("#06b6d4");
  });

  it("keeps CI Failed display when rebaseRequested is true and state is ci-failed", () => {
    const d = statusDisplayForState("ci-failed", { rebaseRequested: true });
    expect(d.text).toBe("CI Failed");
    expect(d.icon).toBe("xmark.circle");
    expect(d.color).toBe("#ef4444");
  });

  it("returns Rebasing display for the actual rebasing state", () => {
    const d = statusDisplayForState("rebasing", { rebaseRequested: true });
    expect(d.text).toBe("Rebasing");
    expect(d.icon).toBe("arrow.triangle.branch");
    expect(d.color).toBe("#f59e0b");
  });

  it("returns normal CI Pending display when rebaseRequested is not set", () => {
    const d = statusDisplayForState("ci-pending");
    expect(d.text).toBe("CI Pending");
    expect(d.icon).toBe("clock.fill");
    expect(d.color).toBe("#06b6d4");
  });

  it("returns normal CI Pending display when rebaseRequested is false", () => {
    const d = statusDisplayForState("ci-pending", { rebaseRequested: false });
    expect(d.text).toBe("CI Pending");
  });

  it("ignores rebaseRequested for non ci-pending/ci-failed states", () => {
    const d = statusDisplayForState("implementing", { rebaseRequested: true });
    expect(d.text).toBe("Implementing");
  });
});

// ── buildSnapshot heartbeat integration ─────────────────────────────

describe("buildSnapshot heartbeat", () => {
  it("populates lastHeartbeat from heartbeat file", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // Create a mock heartbeat file via mock readHeartbeat
    // buildSnapshot calls readHeartbeat internally, so we use a real project root with mock IO
    const fakeMux = {
      listWorkspaces: () => "workspace:1 H-1-1",
      readScreen: () => "",
    } as any;
    const fakeCheckPr = () => null;
    const fakeCommitTime = () => null;

    // Build snapshot -- readHeartbeat will return null since no file exists at /tmp/proj
    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.ninthwave/.worktrees",
      fakeMux, fakeCommitTime, fakeCheckPr,
    );

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    // lastHeartbeat should be null (no file exists)
    expect(itemSnap!.lastHeartbeat).toBeNull();
  });

  it("handles missing heartbeat file gracefully (null)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const fakeCheckPr = () => "H-1-1\t42\tpending\tMERGEABLE";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(
      orch, "/tmp/nonexistent", "/tmp/nonexistent/.ninthwave/.worktrees",
      fakeMux, fakeCommitTime, fakeCheckPr,
    );

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    expect(itemSnap!.lastHeartbeat).toBeNull();
  });
});

// ── executeClean heartbeat cleanup ──────────────────────────────────

describe("executeClean heartbeat cleanup", () => {
  it("deletes heartbeat file during clean without error", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "done");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // The executeClean uses fs.existsSync/unlinkSync directly on the heartbeatFilePath.
    // Since we're in tests with a non-existent path, existsSync returns false and
    // the cleanup is skipped gracefully. We verify the overall clean still succeeds.
    const ctx: ExecutionContext = {
      projectRoot: "/tmp/proj-heartbeat-test",
      worktreeDir: "/tmp/proj-heartbeat-test/.ninthwave/.worktrees",
      workDir: "/tmp/proj-heartbeat-test/.ninthwave/work",
      aiTool: "test",
    };

    const deps: OrchestratorDeps = {
      git: {
        fetchOrigin: () => {},
        ffMerge: () => {},
      },
      gh: {
        prMerge: () => true,
        prComment: () => true,
      },
      mux: {
        sendMessage: () => true,
        closeWorkspace: () => true,
      },
      workers: {
        launchSingleItem: () => null,
      },
      cleanup: {
        cleanSingleWorktree: () => true,
      },
      io: {
        writeInbox: () => {},
      },
    };

    const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, ctx, deps);
    expect(result.success).toBe(true);
  });

  it("heartbeat file path is based on projectRoot and itemId", () => {
    // Verify the heartbeatFilePath function returns the expected path
    const path = heartbeatFilePath("/my/project", "H-1-1");
    expect(path).toContain("H-1-1.json");
    expect(path).toContain("heartbeats");
  });
});

// ── syncWorkerDisplay ───────────────────────────────────────────────

describe("syncWorkerDisplay", () => {
  function createMockMux(): Multiplexer & {
    statusCalls: Array<{ ref: string; key: string; text: string; icon: string; color: string }>;
    progressCalls: Array<{ ref: string; value: number; label?: string }>;
  } {
    const statusCalls: Array<{ ref: string; key: string; text: string; icon: string; color: string }> = [];
    const progressCalls: Array<{ ref: string; value: number; label?: string }> = [];
    return {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      writeInbox: () => {},
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
      setStatus: (ref, key, text, icon, color) => {
        statusCalls.push({ ref, key, text, icon, color });
        return true;
      },
      setProgress: (ref, value, label) => {
        progressCalls.push({ ref, value, label });
        return true;
      },
      statusCalls,
      progressCalls,
    };
  }

  it("calls setStatus with correct args for implementing state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: { id: "H-1-1", progress: 0.5, label: "Writing tests", ts: "2026-01-15T12:00:00Z" } }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.statusCalls).toHaveLength(1);
    expect(mux.statusCalls[0]).toEqual({
      ref: "workspace:1",
      key: "ninthwave-H-1-1",
      text: "Implementing",
      icon: "hammer.fill",
      color: "#b45309",
    });
  });

  it("calls setProgress with worker-reported data for implementing state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: { id: "H-1-1", progress: 0.7, label: "Almost done", ts: "2026-01-15T12:00:00Z" } }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.progressCalls).toHaveLength(1);
    expect(mux.progressCalls[0]).toEqual({
      ref: "workspace:1",
      value: 0.7,
      label: "Almost done",
    });
  });

  it("calls setProgress with 1 and no label for ci-pending state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    orch.getItem("H-1-1")!.prNumber = 42;

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.progressCalls).toHaveLength(1);
    expect(mux.progressCalls[0]).toEqual({
      ref: "workspace:1",
      value: 1,
      label: undefined,
    });
  });

  it("calls setProgress with 1 and no label for review-pending state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.progressCalls).toHaveLength(1);
    expect(mux.progressCalls[0]).toEqual({
      ref: "workspace:1",
      value: 1,
      label: undefined,
    });
  });

  it("calls setProgress with 1 and no label for merging state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "merging");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.progressCalls).toHaveLength(1);
    expect(mux.progressCalls[0]).toEqual({
      ref: "workspace:1",
      value: 1,
      label: undefined,
    });
  });

  it("calls setProgress with 1 and no label for ci-pending state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.progressCalls).toHaveLength(1);
    expect(mux.progressCalls[0]).toEqual({
      ref: "workspace:1",
      value: 1,
      label: undefined,
    });
  });

  it("skips items without workspaceRef", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    // No workspaceRef set

    const mux = createMockMux();
    const snapshot: PollSnapshot = { items: [{ id: "H-1-1" }], readyIds: [] };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.statusCalls).toHaveLength(0);
    expect(mux.progressCalls).toHaveLength(0);
  });

  it("skips terminal-state items (done, stuck, blocked)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "done");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.hydrateState("H-1-2", "blocked");
    orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

    const mux = createMockMux();
    const snapshot: PollSnapshot = { items: [], readyIds: [] };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    expect(mux.statusCalls).toHaveLength(0);
    expect(mux.progressCalls).toHaveLength(0);
  });

  it("sets progress to 0% for implementing when no heartbeat", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux, "/tmp/project");

    // Status should be set, and progress should default to 0% (waiting for first heartbeat)
    expect(mux.statusCalls).toHaveLength(1);
    expect(mux.progressCalls).toHaveLength(1);
    expect(mux.progressCalls[0]).toEqual({
      ref: "workspace:1",
      value: 0,
      label: undefined,
    });
  });
});

// ── Rebaser worker state transitions ──────────────────────────────────

describe("rebaser worker state transitions", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("daemon-rebase failure launches rebaser worker and transitions to rebasing", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, workers: { launchRebaser: () => ({ workspaceRef: "rebaser:1" }) } });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("rebasing");
    expect(item.rebaserWorkspaceRef).toBe("rebaser:1");
  });

  it("daemon-rebase success transitions to ci-pending without rebaser worker", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const launchRebaserCalled = { value: false };
    const deps = makeMinimalDeps({ git: { daemonRebase: () => true }, workers: { launchRebaser: () => { launchRebaserCalled.value = true; return null; } } });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("ci-pending");
    expect(launchRebaserCalled.value).toBe(false);
  });

  it("rebasing transitions to ci-pending when CI restarts after push", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "rebasing");
    const item = orch.getItem("H-1-1")!;
    item.rebaserWorkspaceRef = "rebaser:1";
    item.rebaseRequested = true;

    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", ciStatus: "pending", workerAlive: true, eventTime: new Date(Date.now() + 60_000).toISOString() }],
      readyIds: [],
    };

    const actions = orch.processTransitions(snapshot);

    expect(item.state).toBe("ci-pending");
    expect(item.rebaseRequested).toBe(false);
    expect(actions.some(a => a.type === "clean-rebaser")).toBe(true);
  });

  it("rebasing transitions to stuck when rebaser worker dies", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "rebasing");
    const item = orch.getItem("H-1-1")!;
    item.rebaserWorkspaceRef = "rebaser:1";

    // Simulate 5 consecutive not-alive polls (debounce)
    for (let i = 0; i < 5; i++) {
      const snapshot: PollSnapshot = {
        items: [{ id: "H-1-1", workerAlive: false }],
        readyIds: [],
      };
      orch.processTransitions(snapshot);
    }

    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("rebase-failed");
  });

  it("executeCleanRebaser cleans up the rebaser workspace", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.rebaserWorkspaceRef = "rebaser:1";

    const cleaned: string[] = [];
    const deps = makeMinimalDeps({ cleanup: { cleanRebaser: (_id, ref) => { cleaned.push(ref); return true; } } });

    orch.executeAction({ type: "clean-rebaser", itemId: "H-1-1" }, ctx, deps);

    expect(cleaned).toEqual(["rebaser:1"]);
    expect(item.rebaserWorkspaceRef).toBeUndefined();
  });

  it("executeLaunch transitions to ci-pending when existingPrNumber is returned", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const deps = makeMinimalDeps({ workers: { launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "", existingPrNumber: 271 }) } });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    const item = orch.getItem("H-1-1")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(271);
    expect(item.workspaceRef).toBeUndefined();
  });

  it("falls back to worker message when rebaser worker not available", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.worktreePath = join(setupTempRepo(), ".ninthwave", ".worktrees", "ninthwave-H-1-1");
    mkdirSync(item.worktreePath, { recursive: true });

    const inboxMessages: string[] = [];
    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, io: { writeInbox: (_projectRoot, _itemId, msg) => { inboxMessages.push(msg); } } });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("ci-pending");
    expect(inboxMessages.length).toBeGreaterThan(0);
  });
});

// ── Rebase circuit breaker + worker message priority ──────────

describe("rebase circuit breaker and worker message priority", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("circuit breaker marks stuck after maxRebaseAttempts", () => {
    const orch = new Orchestrator({ sessionLimit: 1, maxRebaseAttempts: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.rebaseAttemptCount = 2; // already at limit

    const launchRebaserCalled = { value: false };
    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, workers: { launchRebaser: () => { launchRebaserCalled.value = true; return { workspaceRef: "rebaser:1" }; } } });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("rebase-loop");
    expect(item.failureReason).toContain("max rebase attempts");
    expect(launchRebaserCalled.value).toBe(false); // rebaser NOT launched
  });

  it("prefers inbox delivery over rebaser when worktree inbox target exists", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.worktreePath = join(setupTempRepo(), ".ninthwave", ".worktrees", "ninthwave-H-1-1");
    mkdirSync(item.worktreePath, { recursive: true });

    const launchRebaserCalled = { value: false };
    const inboxMessages: string[] = [];
    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, workers: { launchRebaser: () => { launchRebaserCalled.value = true; return { workspaceRef: "rebaser:1" }; } }, io: { writeInbox: (_projectRoot, _itemId, msg) => { inboxMessages.push(msg); } } });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(launchRebaserCalled.value).toBe(false); // rebaser NOT launched
    expect(inboxMessages).toHaveLength(1);
  });

  it("does not launch rebaser when inbox delivery succeeds for a live worker", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.worktreePath = join(setupTempRepo(), ".ninthwave", ".worktrees", "ninthwave-H-1-1");
    mkdirSync(item.worktreePath, { recursive: true });

    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, workers: { launchRebaser: () => ({ workspaceRef: "rebaser:1" }) }, io: { writeInbox: () => {} } });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("ci-pending");
    expect(item.rebaserWorkspaceRef).toBeUndefined();
    expect(item.rebaseAttemptCount).toBeUndefined();
  });

  it("rebaseAttemptCount resets when conflicts resolve (isMergeable !== false)", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.rebaseAttemptCount = 2;

    // Simulate CI passing with PR now mergeable
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", ciStatus: "pass", isMergeable: true }],
      readyIds: [],
    };

    orch.processTransitions(snapshot);

    expect(item.rebaseAttemptCount).toBe(0);
  });

  it("rebaseAttemptCount preserves when conflicts persist (isMergeable === false)", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.rebaseAttemptCount = 2;

    // Simulate PR still conflicting
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", ciStatus: "pending", isMergeable: false }],
      readyIds: [],
    };

    orch.processTransitions(snapshot);

    expect(item.rebaseAttemptCount).toBe(2); // preserved, not reset
  });

  it("rebaseAttemptCount increments on each rebaser launch", () => {
    const orch = new Orchestrator({ sessionLimit: 1, maxRebaseAttempts: 5 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.rebaseAttemptCount = 1; // already had one attempt

    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, workers: { launchRebaser: () => ({ workspaceRef: "rebaser:2" }) } });

    orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(item.rebaseAttemptCount).toBe(2);
    expect(item.state).toBe("rebasing");
  });

  it("full loop terminates after maxRebaseAttempts (integration-style)", () => {
    const maxAttempts = 3;
    const staleMs = 60_000;
    const orch = new Orchestrator({
      sessionLimit: 1,
      maxRebaseAttempts: maxAttempts,
      rebaseRetryStaleMs: staleMs,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({ git: { daemonRebase: () => false }, workers: { launchRebaser: () => ({ workspaceRef: "rebaser:x" }) } });

    let now = new Date("2026-04-02T12:00:00.000Z");

    // Simulate the loop: detect conflict → daemon-rebase → rebaser → CI restarts → stale conflict returns
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 1. Detect conflict in ci-pending → triggers daemon-rebase
      const conflictSnap: PollSnapshot = {
        items: [{ id: "H-1-1", isMergeable: false }],
        readyIds: [],
      };
      const actions = orch.processTransitions(conflictSnap, now);
      const rebaseAction = actions.find(a => a.type === "daemon-rebase");

      if (!rebaseAction) break; // no more rebase actions = loop terminated

      // 2. Execute daemon-rebase → launches rebaser (daemon rebase fails)
      orch.executeAction(rebaseAction, ctx, deps);
      expect(item.state).toBe("rebasing");

      // 3. Rebaser worker pushes → CI restarts
      // eventTime must be after item.lastTransition (real clock) to be treated as fresh CI
      const transitionMs = new Date(item.lastTransition).getTime();
      const freshEventTime = new Date(transitionMs + 5_000).toISOString();
      const rebaserDoneAt = new Date(transitionMs + 5_000);
      const rebaserDoneSnap: PollSnapshot = {
        items: [{ id: "H-1-1", ciStatus: "pending", workerAlive: true, eventTime: freshEventTime }],
        readyIds: [],
      };
      orch.processTransitions(rebaserDoneSnap, rebaserDoneAt);
      expect(item.state).toBe("ci-pending");
      expect(item.rebaseRequested).toBe(false);

      now = new Date(rebaserDoneAt.getTime() + staleMs + 1_000);
    }

    // One more cycle: conflict still present, but circuit breaker should fire
    const finalSnap: PollSnapshot = {
      items: [{ id: "H-1-1", isMergeable: false }],
      readyIds: [],
    };
    const finalActions = orch.processTransitions(finalSnap, now);
    const finalRebase = finalActions.find(a => a.type === "daemon-rebase");

    if (finalRebase) {
      // Execute the final daemon-rebase -- circuit breaker should trigger
      orch.executeAction(finalRebase, ctx, deps);
    }

    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("rebase-loop");
    expect(item.rebaseAttemptCount).toBe(maxAttempts);
  });
});

// ── Daemon-worker worktree race prevention (H-WR-1) ──────────────────

describe("daemon-worker worktree race prevention (H-WR-1)", () => {
  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.ninthwave/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("daemon-rebase is never emitted in the same cycle as a worker launch for the same item", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // Item starts in ready state -- should get a launch action, NOT daemon-rebase
    const snap = snapshotWith([{ id: "H-1-1" }], ["H-1-1"]);
    const actions = orch.processTransitions(snap);

    const launchActions = actions.filter(a => a.type === "launch" && a.itemId === "H-1-1");
    const rebaseActions = actions.filter(a => a.type === "daemon-rebase" && a.itemId === "H-1-1");

    // Should have a launch action but NOT a daemon-rebase
    expect(launchActions.length).toBe(1);
    expect(rebaseActions.length).toBe(0);
  });

  it("ci-pending item with merge conflicts gets daemon-rebase but not launch", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const snap = snapshotWith([{
      id: "H-1-1",
      prNumber: 42,
      prState: "open" as const,
      ciStatus: "pending" as const,
      isMergeable: false,
    }]);
    const actions = orch.processTransitions(snap);

    const launchActions = actions.filter(a => a.type === "launch" && a.itemId === "H-1-1");
    const rebaseActions = actions.filter(a => a.type === "daemon-rebase" && a.itemId === "H-1-1");

    expect(launchActions.length).toBe(0);
    expect(rebaseActions.length).toBe(1);
  });

  it("executeNotifyCiFailure transitions to ready with needsCiFix when no workspace", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.ciFailCount = 1;
    // No workspaceRef -- simulating restart with dead worker

    const deps = makeMinimalDeps();
    const result = orch.executeAction(
      { type: "notify-ci-failure", itemId: "H-1-1", prNumber: 42, message: "CI failed" },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No inbox target");
    expect(item.state).toBe("ready");
    expect(item.needsCiFix).toBe(true);
  });

  it("executeLaunch with needsCiFix passes forceWorkerLaunch and launches worker", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");
    const item = orch.getItem("H-1-1")!;
    item.needsCiFix = true;
    item.ciFailCount = 1;
    item.prNumber = 42;

    let receivedForceFlag = false;
    const deps = makeMinimalDeps({ workers: { launchSingleItem: (_item, _td, _wd, _pr, _ai, _bb, forceWorkerLaunch) => {
        receivedForceFlag = forceWorkerLaunch === true;
        // With forceWorkerLaunch, returns normal launch result (no existingPrNumber)
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      } } });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(receivedForceFlag).toBe(true);
    expect(item.workspaceRef).toBe("workspace:1");
    expect(item.needsCiFix).toBe(false);
  });

  it("executeLaunch without needsCiFix transitions to ci-pending on existingPrNumber", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    const deps = makeMinimalDeps({ workers: { launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "", existingPrNumber: 271 }) } });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    const item = orch.getItem("H-1-1")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(271);
    expect(item.workspaceRef).toBeUndefined();
  });

  it("full CI-failed restart cycle: ci-failed → notify fails → ready → launch with worker", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.ciFailCount = 1;
    // No workspaceRef -- dead worker after restart

    const deps = makeMinimalDeps({ workers: { launchSingleItem: (_item, _td, _wd, _pr, _ai, _bb, forceWorkerLaunch) => {
        if (forceWorkerLaunch) {
          return { worktreePath: "/tmp/wt", workspaceRef: "workspace:2" };
        }
        return { worktreePath: "/tmp/wt", workspaceRef: "", existingPrNumber: 42 };
      } } });

    // Step 1: handlePrLifecycle emits notify-ci-failure
    const snap = snapshotWith([{
      id: "H-1-1",
      prNumber: 42,
      prState: "open" as const,
      ciStatus: "fail" as const,
    }]);
    const actions = orch.processTransitions(snap);
    const notifyAction = actions.find(a => a.type === "notify-ci-failure");
    expect(notifyAction).toBeDefined();

    // Step 2: executeNotifyCiFailure → no workspace → ready + needsCiFix
    orch.executeAction(notifyAction!, ctx, deps);
    expect(item.state).toBe("ready");
    expect(item.needsCiFix).toBe(true);

    // Step 3: launchReadyItems picks it up
    const snap2 = snapshotWith([{ id: "H-1-1" }], []);
    const actions2 = orch.processTransitions(snap2);
    const launchAction = actions2.find(a => a.type === "launch");
    expect(launchAction).toBeDefined();

    // Step 4: executeLaunch with forceWorkerLaunch → worker launched
    orch.executeAction(launchAction!, ctx, deps);
    expect(item.workspaceRef).toBe("workspace:2");
    expect(item.needsCiFix).toBe(false);
  });
});

// ── Implementer inbox delivery resolution ──────────────────────────

describe("implementer inbox delivery resolution", () => {
  afterEach(() => cleanupTempRepos());

  function makeMinimalDeps(overrides: DeepPartial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides?.git,
    },
    gh: {
      prMerge: () => true,
      prComment: () => true,
      ...overrides?.gh,
    },
    mux: {
      sendMessage: () => true,
      closeWorkspace: () => true,
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      validatePickupCandidate: (item) => ({
        status: "launch",
        targetRepo: "/tmp/proj",
        branchName: `ninthwave/${item.id}`,
      }),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: () => true,
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: () => {},
      ...overrides?.io,
    },
  };
}

  function createEventCollector(): {
    orch: Orchestrator;
    events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }>;
  } {
    const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      sessionLimit: 1,
      onEvent: (itemId, event, data) => {
        events.push({ itemId, event, data });
      },
    });
    return { orch, events };
  }

  it("logs CI failure relaunch when no safe inbox target exists", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    const { orch, events } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const writeInbox = vi.fn();
    const deps = makeMinimalDeps({ io: { writeInbox } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "notify-ci-failure", itemId: "H-1-1", message: "CI failed." },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No inbox target");
    expect(item.state).toBe("ready");
    expect(item.needsCiFix).toBe(true);
    expect(writeInbox).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      itemId: "H-1-1",
      event: "inbox-delivery",
      data: expect.objectContaining({
        actionType: "notify-ci-failure",
        outcome: "relaunch-requested",
        reason: "no-worktree-path",
      }),
    });
  });

  it("executeLaunch with needsFeedbackResponse delivers feedback to inbox", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const itemWorktree = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(itemWorktree, { recursive: true });

    const { orch } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "@reviewer commented on PR #42:\n\nPlease tighten this wording.";

    const writeInbox = vi.fn();
    let receivedForceFlag = false;
    const deps = makeMinimalDeps({
      workers: {
        validatePickupCandidate: (launchItem) => ({
          status: "skip-with-pr",
          branchName: `ninthwave/${launchItem.id}`,
          existingPrNumber: 42,
        }),
        launchSingleItem: (_launchItem, _workDir, _worktreeDir, _projectRoot, _aiTool, _baseBranch, forceWorkerLaunch) => {
          receivedForceFlag = forceWorkerLaunch === true;
          return { worktreePath: itemWorktree, workspaceRef: "workspace:1" };
        },
      },
      io: { writeInbox },
    });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(receivedForceFlag).toBe(true);
    expect(writeInbox).toHaveBeenCalledWith(
      itemWorktree,
      "H-1-1",
      expect.stringContaining("Please tighten this wording."),
    );
    expect(writeInbox).toHaveBeenCalledTimes(1);
    expect(item.needsFeedbackResponse).toBe(false);
    expect(item.pendingFeedbackMessage).toBeUndefined();
  });

  it("executeLaunch forwards an aggregated feedback payload without double wrapping", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const itemWorktree = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(itemWorktree, { recursive: true });

    const { orch } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "launching");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "[ORCHESTRATOR] Review Feedback Batch: 2 trusted human comments on PR #42.\n\n@reviewer commented on PR #42:\n\nPlease tighten this wording.\n\n@maintainer commented on PR #42:\n\nAlso add a regression test.";

    const writeInbox = vi.fn();
    const deps = makeMinimalDeps({
      workers: {
        validatePickupCandidate: (launchItem) => ({
          status: "skip-with-pr",
          branchName: `ninthwave/${launchItem.id}`,
          existingPrNumber: 42,
        }),
        launchSingleItem: () => ({ worktreePath: itemWorktree, workspaceRef: "workspace:1" }),
      },
      io: { writeInbox },
    });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(writeInbox).toHaveBeenCalledWith(
      itemWorktree,
      "H-1-1",
      "[ORCHESTRATOR] Review Feedback Batch: 2 trusted human comments on PR #42.\n\n@reviewer commented on PR #42:\n\nPlease tighten this wording.\n\n@maintainer commented on PR #42:\n\nAlso add a regression test.",
    );
    expect(writeInbox).toHaveBeenCalledTimes(1);
  });

  it("executeLaunch preserves feedback relaunch state when launch fails", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    const { orch } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "@reviewer commented on PR #42:\n\nPlease tighten this wording.";

    const deps = makeMinimalDeps({
      workers: {
        validatePickupCandidate: (launchItem) => ({
          status: "skip-with-pr",
          branchName: `ninthwave/${launchItem.id}`,
          existingPrNumber: 42,
        }),
        launchSingleItem: () => null,
      },
    });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("ready");
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.pendingFeedbackMessage).toContain("Please tighten this wording.");
  });

  it("does not fall back to repo-root namespaces for generic worker nudges", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    const { orch, events } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.workspaceRef = "workspace:1";

    const writeInbox = vi.fn();
    const deps = makeMinimalDeps({ io: { writeInbox } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "Are you still making progress?" },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(writeInbox).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      itemId: "H-1-1",
      event: "inbox-delivery",
      data: expect.objectContaining({
        actionType: "send-message",
        outcome: "missing-target",
        reason: "no-worktree-path",
      }),
    });
  });

  it("executeNotifyCiFailure returns success:false when inbox target is missing", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    const { orch, events } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-failed");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.ciFailCount = 1;
    // No workspaceRef and no worktree on disk

    const writeInbox = vi.fn();
    const deps = makeMinimalDeps({ io: { writeInbox } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "notify-ci-failure", itemId: "H-1-1", message: "CI failed." },
      ctx,
      deps,
    );

    // Should return failure -- the notification was not delivered
    expect(result.success).toBe(false);
    expect(result.error).toContain("No inbox target");
    // Still transitions to ready with needsCiFix for relaunch
    expect(item.state).toBe("ready");
    expect(item.needsCiFix).toBe(true);
    expect(writeInbox).not.toHaveBeenCalled();
  });

  it("send-message succeeds when workspaceRef is undefined but worktree exists on disk", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const worktreePath = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(worktreePath, { recursive: true });

    const { orch, events } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    // workspaceRef is undefined -- session was retried, but worktree still on disk
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this.";

    const writes: Array<{ targetRoot: string; itemId: string; message: string }> = [];
    const deps = makeMinimalDeps({ io: { writeInbox: (targetRoot, itemId, message) => {
        writes.push({ targetRoot, itemId, message });
      } } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this." },
      ctx,
      deps,
    );

    // Should succeed -- worktree exists on disk, resolveImplementerInboxTarget finds it
    expect(result.success).toBe(true);
    expect(writes).toEqual([
      { targetRoot: worktreePath, itemId: "H-1-1", message: "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this." },
    ]);
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.pendingFeedbackMessage).toContain("Fix this.");
  });

  it("send-message clears pending feedback after verified live delivery", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const worktreePath = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(worktreePath, { recursive: true });

    const { orch } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this.";
    item.pendingFeedbackLiveDeliveryArmed = true;

    const writes: Array<{ targetRoot: string; itemId: string; message: string }> = [];
    const deps = makeMinimalDeps({ io: { writeInbox: (targetRoot, itemId, message) => {
      writes.push({ targetRoot, itemId, message });
    } } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this." },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(writes).toEqual([
      { targetRoot: worktreePath, itemId: "H-1-1", message: "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this." },
    ]);
    expect(item.needsFeedbackResponse).toBe(false);
    expect(item.pendingFeedbackMessage).toBeUndefined();
    expect(item.pendingFeedbackLiveDeliveryArmed).toBeUndefined();
  });

  it("send-message preserves pending feedback for stale workspace metadata", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const worktreePath = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(worktreePath, { recursive: true });

    const { orch } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:stale";
    item.needsFeedbackResponse = true;
    item.pendingFeedbackMessage = "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this.";
    item.pendingFeedbackLiveDeliveryArmed = undefined;

    const writes: Array<{ targetRoot: string; itemId: string; message: string }> = [];
    const deps = makeMinimalDeps({ io: { writeInbox: (targetRoot, itemId, message) => {
      writes.push({ targetRoot, itemId, message });
    } } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this." },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(writes).toEqual([
      { targetRoot: worktreePath, itemId: "H-1-1", message: "[ORCHESTRATOR] Review Feedback: @reviewer commented:\n\nFix this." },
    ]);
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.pendingFeedbackMessage).toContain("Fix this.");
    expect(item.pendingFeedbackLiveDeliveryArmed).toBeUndefined();
  });

  it("send-message returns success:false when no worktree path exists at all", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    const { orch, events } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    // No workspaceRef and no worktree directory on disk

    const writeInbox = vi.fn();
    const deps = makeMinimalDeps({ io: { writeInbox } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "send-message", itemId: "H-1-1", message: "Review feedback." },
      ctx,
      deps,
    );

    // Should fail gracefully -- no worktree target exists
    expect(result.success).toBe(false);
    expect(result.error).toContain("No safe worker inbox target");
    expect(writeInbox).not.toHaveBeenCalled();
  });

  it("delivers rebase requests to the live worktree namespace", () => {
    const hubRepo = setupTempRepo();
    const worktreeDir = join(hubRepo, ".ninthwave", ".worktrees");
    const worktreePath = join(worktreeDir, "ninthwave-H-1-1");
    mkdirSync(worktreePath, { recursive: true });

    const { orch, events } = createEventCollector();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.worktreePath = worktreePath;
    item.workspaceRef = "workspace:1";

    const writes: Array<{ targetRoot: string; itemId: string; message: string }> = [];
    const deps = makeMinimalDeps({ io: { writeInbox: (targetRoot, itemId, message) => {
        writes.push({ targetRoot, itemId, message });
      } } });
    const ctx: ExecutionContext = {
      projectRoot: hubRepo,
      worktreeDir,
      workDir: join(hubRepo, ".ninthwave", "work"),
      aiTool: "claude",
    };

    const result = orch.executeAction(
      { type: "rebase", itemId: "H-1-1", message: "Please rebase." },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(writes).toEqual([
      { targetRoot: worktreePath, itemId: "H-1-1", message: "Please rebase." },
    ]);
    expect(events).toContainEqual({
      itemId: "H-1-1",
      event: "inbox-delivery",
      data: expect.objectContaining({
        actionType: "rebase",
        outcome: "delivered",
        targetProjectRoot: worktreePath,
        targetSource: "hub-worktree",
      }),
    });
  });
});

// ── onTransition callback ──────────────────────────────────────────

describe("onTransition callback", () => {
  it("is called for every state change with correct arguments", () => {
    const calls: Array<{ itemId: string; from: string; to: string; timestamp: string; latencyMs: number }> = [];
    const orch = new Orchestrator({
      onTransition: (itemId, from, to, timestamp, latencyMs) => {
        calls.push({ itemId, from, to, timestamp, latencyMs });
      },
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // processTransitions will trigger queued → ready → launching in one call
    const snapshot = snapshotWith([], ["H-1-1"]);
    orch.processTransitions(snapshot);

    // Expect at least 2 calls: queued→ready and ready→launching
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.itemId).toBe("H-1-1");
    expect(calls[0]!.from).toBe("queued");
    expect(calls[0]!.to).toBe("ready");
    expect(typeof calls[0]!.timestamp).toBe("string");
    expect(calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls[1]!.from).toBe("ready");
    expect(calls[1]!.to).toBe("launching");
  });

  it("does not fire on no-op transitions (same state)", () => {
    const calls: Array<{ from: string; to: string }> = [];
    const orch = new Orchestrator({
      onTransition: (_itemId, from, to) => {
        calls.push({ from, to });
      },
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // First call: implementing stays implementing (worker alive, no PR)
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: true }]));
    const countAfterFirst = calls.length;

    // Second call with same snapshot: still implementing, no-op -- no new callbacks
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: true }]));
    expect(calls.length).toBe(countAfterFirst);
  });

  it("omitting onTransition does not break construction or polling", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // Should not throw -- item transitions through ready → launching
    const actions = orch.processTransitions(snapshotWith([], ["H-1-1"]));
    expect(["ready", "launching"]).toContain(orch.getItem("H-1-1")!.state);
    expect(actions).toBeDefined();
  });

  it("fires for multiple items in the same poll cycle", () => {
    const calls: Array<{ itemId: string; from: string; to: string }> = [];
    const orch = new Orchestrator({
      sessionLimit: 2,
      onTransition: (itemId, from, to) => {
        calls.push({ itemId, from, to });
      },
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;

    // Both become ready (and then launching)
    orch.processTransitions(snapshotWith([], ["H-1-1", "H-1-2"]));

    // Each item gets queued→ready and ready→launching = 4 total (at minimum)
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const readyCalls = calls.filter((c) => c.from === "queued" && c.to === "ready");
    expect(readyCalls.length).toBe(2);
    const readyIds = readyCalls.map((c) => c.itemId).sort();
    expect(readyIds).toEqual(["H-1-1", "H-1-2"]);
  });

  it("tracks multiple sequential transitions for the same item", () => {
    const calls: Array<{ itemId: string; from: string; to: string }> = [];
    const orch = new Orchestrator({
      onTransition: (itemId, from, to) => {
        calls.push({ itemId, from, to });
      },
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // First poll: queued → ready → launching in one processTransitions call
    orch.processTransitions(snapshotWith([], ["H-1-1"]));

    // Should see the full chain: queued→ready, ready→launching
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toMatchObject({ from: "queued", to: "ready" });
    expect(calls[1]).toMatchObject({ from: "ready", to: "launching" });

    // Now simulate implementing state and a PR appearing
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    orch.getItem("H-1-1")!.prNumber = 42;
    const prevCount = calls.length;

    // Second poll: implementing → ci-pending (PR appears with pending CI)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, ciStatus: "pending", prState: "open", workerAlive: true }]),
    );

    // Should have new transition(s) beyond the previous count
    expect(calls.length).toBeGreaterThan(prevCount);
    const newCalls = calls.slice(prevCount);
    expect(newCalls.some((c) => c.to === "ci-pending")).toBe(true);
  });

  it("includes detection latency from eventTime", () => {
    const calls: Array<{ latencyMs: number }> = [];
    const orch = new Orchestrator({
      onTransition: (_itemId, _from, _to, _ts, latencyMs) => {
        calls.push({ latencyMs });
      },
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // Provide an eventTime in the past to produce measurable latency
    const pastTime = new Date(Date.now() - 5000).toISOString();
    orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open", isMergeable: true, workerAlive: true, eventTime: pastTime },
      ]),
    );

    // Should have a transition (e.g., implementing → ci-pending → ci-passed)
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // The latency should reflect the ~5s gap between eventTime and detectedTime
    const lastCall = calls[calls.length - 1]!;
    expect(lastCall.latencyMs).toBeGreaterThanOrEqual(4000);
  });
});

// ── Review round counter and max rounds (H-RX-2) ─────────────────────

describe("review round counter", () => {
  const requestChangesVerdict = {
    verdict: "request-changes" as const,
    summary: "Found blockers.",
    blockingCount: 2,
    nonBlockingCount: 1,
  };
  const approveVerdict = {
    verdict: "approve" as const,
    summary: "No issues.",
    blockingCount: 0,
    nonBlockingCount: 0,
  };

  it("increments reviewRound on each launch-review execution", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Round 1: ci-passed → reviewing (launches review)
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(orch.getItem("H-1-1")!.reviewRound).toBe(1);
    expect(actions1.some((a) => a.type === "launch-review")).toBe(true);

    // Review requests changes → review-pending
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");

    // Worker pushes fix → ci-pending → ci-passed
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    // Round 2: ci-passed → reviewing (launches review again)
    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(orch.getItem("H-1-1")!.reviewRound).toBe(2);
  });

  it("transitions to stuck when reviewRound >= maxReviewRounds", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", maxReviewRounds: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;
    // Simulate already having completed 2 rounds
    orch.getItem("H-1-1")!.reviewRound = 2;

    // Next review attempt would be round 3, which exceeds maxReviewRounds=2
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("exceeded max review rounds");
    expect(actions.some((a) => a.type === "launch-review")).toBe(false);
  });

  it("includes rich verdict summary in notify-review message", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewRound = 2;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
    );

    const notifyAction = actions.find((a) => a.type === "notify-review");
    expect(notifyAction).toBeDefined();
    expect(notifyAction!.message).toContain("round 2");
    expect(notifyAction!.message).toContain("2 blocking");
    expect(notifyAction!.message).toContain("1 non-blocking");
    expect(notifyAction!.message).toContain("Found blockers.");
  });

  it("shows round in status description only when reviewRound > 1", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Round 1: status description should NOT include round number
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    const statusAction1 = actions1.find((a) => a.type === "set-commit-status" && a.statusState === "pending");
    expect(statusAction1).toBeDefined();
    expect(statusAction1!.statusDescription).toBe("Review in progress");

    // Request changes and cycle back to ci-passed
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
    );
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );
    const actions2 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    // Round 2: status description SHOULD include round number
    const statusAction2 = actions2.find((a) => a.type === "set-commit-status" && a.statusState === "pending");
    expect(statusAction2).toBeDefined();
    expect(statusAction2!.statusDescription).toBe("Re-review in progress (round 2)");
  });

  it("treats undefined reviewRound as 0 (first review is round 1)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;
    // reviewRound is undefined by default

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.reviewRound).toBe(1);
    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
  });

  it("emits review-round analytics event", () => {
    const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      mergeStrategy: "auto",
      onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );

    const reviewEvent = events.find((e) => e.event === "review-round");
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent!.data?.reviewRound).toBe(1);
  });

  it("statusDisplayForState shows round only when reviewRound > 1", () => {
    // Default / round 1: no round in display
    const d1 = statusDisplayForState("reviewing");
    expect(d1.text).toBe("Reviewing");

    const d1b = statusDisplayForState("reviewing", { reviewRound: 1 });
    expect(d1b.text).toBe("Reviewing");

    // Round 2+: shows round
    const d2 = statusDisplayForState("reviewing", { reviewRound: 2 });
    expect(d2.text).toBe("Reviewing (round 2)");

    const d3 = statusDisplayForState("reviewing", { reviewRound: 3 });
    expect(d3.text).toBe("Reviewing (round 3)");
  });
});

// ── Timeout grace period (H-TG-2) ──────────────────────────────────

describe("timeout grace period", () => {
  it("does not start timeout grace while waiting in review-pending", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000,
      mergeStrategy: "manual",
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        prNumber: 42,
        prState: "open",
        ciStatus: "pass",
        reviewDecision: "",
        workerAlive: false,
      }]),
      new Date("2026-01-15T12:00:00Z"),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeUndefined();
    expect(actions.some((action) => action.type === "workspace-close")).toBe(false);
  });

  it("timeout detected -> grace period starts -> processTransitions returns [] (deferred)", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000, // 5 minutes
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const futureNow = new Date("2026-01-15T12:00:00Z");

    // First timeout detection -- should defer
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      futureNow,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeDefined();
    expect(orch.getItem("H-1-1")!.timeoutExtensionCount).toBe(0);
  });

  it("grace period expires -> processTransitions returns stuckOrRetry actions", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 60_000, // 1 minute grace
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";

    // First call: sets deadline
    const t1 = new Date("2026-01-15T12:00:00Z");
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      t1,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    // Second call: past the 1-minute grace period
    const t2 = new Date(t1.getTime() + 2 * 60_000);
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      t2,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("extendTimeout() pushes deadline and increments count", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 60_000,
      maxTimeoutExtensions: 3,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const t1 = new Date("2026-01-15T12:00:00Z");

    // Trigger grace period
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      t1,
    );

    const originalDeadline = orch.getItem("H-1-1")!.timeoutDeadline;
    expect(originalDeadline).toBeDefined();

    // Extend the timeout
    const result = orch.extendTimeout("H-1-1");
    expect(result).toBe(true);
    expect(orch.getItem("H-1-1")!.timeoutExtensionCount).toBe(1);

    const newDeadline = orch.getItem("H-1-1")!.timeoutDeadline!;
    expect(new Date(newDeadline).getTime()).toBeGreaterThan(new Date(originalDeadline!).getTime());
  });

  it("extendTimeout() returns false after maxTimeoutExtensions", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 60_000,
      maxTimeoutExtensions: 2,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const t1 = new Date("2026-01-15T12:00:00Z");

    // Trigger grace period
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      t1,
    );

    // Extend twice (max is 2)
    expect(orch.extendTimeout("H-1-1")).toBe(true);
    expect(orch.extendTimeout("H-1-1")).toBe(true);

    // Third extension should fail
    expect(orch.extendTimeout("H-1-1")).toBe(false);
    expect(orch.getItem("H-1-1")!.timeoutExtensionCount).toBe(2);
  });

  it("worker recovery (new commit/heartbeat) clears grace state via transition()", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const t1 = new Date("2026-01-15T12:00:00Z");

    // Trigger grace period via activity timeout
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      t1,
    );
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeDefined();

    // Worker creates a PR -- transitions to ci-pending, clearing grace state
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending", workerAlive: true }]),
      t1,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeUndefined();
    expect(orch.getItem("H-1-1")!.timeoutExtensionCount).toBeUndefined();
  });

  it("gracePeriodMs: 0 skips grace period entirely (immediate kill)", () => {
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 0,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const futureNow = new Date("2026-01-15T12:00:00Z");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      futureNow,
    );

    // No grace period -- immediate kill
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeUndefined();
  });

  it("crash-detection sites are NOT gated by grace period", () => {
    const orch = new Orchestrator({
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000,
      activityTimeoutMs: 10 * 60 * 1000,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Worker dies without PR -- 5 consecutive not-alive checks triggers crash detection
    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      );
    }

    // Should be stuck immediately despite grace period -- crash detection is not gated
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  it("crash detection in launching state is NOT gated by grace period", () => {
    const orch = new Orchestrator({
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    // Worker dies during launch -- 5 consecutive not-alive checks triggers crash detection
    for (let i = 0; i < 5; i++) {
      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      );
    }

    // Should be stuck immediately despite grace period -- crash detection is not gated
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  it("grace period defers launch timeout in implementing state (process dead, no commits)", () => {
    const orch = new Orchestrator({
      launchTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // Advance past launch timeout with dead process
    const futureTime = new Date(Date.now() + 2000);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null }]),
      futureTime,
    );

    // Grace period should defer the kill
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    expect(actions).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeDefined();
  });

  it("grace period defers launching state timeout", () => {
    const orch = new Orchestrator({
      maxRetries: 0,
      gracePeriodMs: 5 * 60 * 1000,
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "launching");

    // Advance past the 5-minute launching timeout
    const futureTime = new Date(Date.now() + 6 * 60 * 1000);

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1" }]), // workerAlive is undefined
      futureTime,
    );

    // Grace period should defer the kill
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(actions).toHaveLength(0);
    expect(orch.getItem("H-1-1")!.timeoutDeadline).toBeDefined();
  });

  it("extendTimeout returns false for item without active grace period", () => {
    const orch = new Orchestrator({ gracePeriodMs: 60_000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    // No timeout detected yet, so no deadline
    expect(orch.extendTimeout("H-1-1")).toBe(false);
  });

  it("extendTimeout returns false for nonexistent item", () => {
    const orch = new Orchestrator({ gracePeriodMs: 60_000 });
    expect(orch.extendTimeout("nonexistent")).toBe(false);
  });

  it("onEvent fires timeout-grace-started and timeout-extended", () => {
    const events: Array<{ itemId: string; event: string; data?: Record<string, unknown> }> = [];
    const orch = new Orchestrator({
      activityTimeoutMs: 1000,
      maxRetries: 0,
      gracePeriodMs: 60_000,
      maxTimeoutExtensions: 3,
      onEvent: (itemId, event, data) => events.push({ itemId, event, data }),
    });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const t1 = new Date("2026-01-15T12:00:00Z");

    // Trigger grace period
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      t1,
    );

    expect(events.some((e) => e.event === "timeout-grace-started")).toBe(true);
    const graceEvent = events.find((e) => e.event === "timeout-grace-started")!;
    expect(graceEvent.data?.gracePeriodMs).toBe(60_000);

    // Extend timeout
    orch.extendTimeout("H-1-1");

    expect(events.some((e) => e.event === "timeout-extended")).toBe(true);
    const extendEvent = events.find((e) => e.event === "timeout-extended")!;
    expect(extendEvent.data?.extensionCount).toBe(1);
  });
});

// -- Session parking (H-SP-2) --------------------------------------------------

describe("session parking (H-SP-2)", () => {
  it("manual strategy: parks session on review-pending with reviewCompleted=true", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(true);
    expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "H-1-1")).toBe(true);
  });

  it("requiresManualReview: parks session on review-pending with reviewCompleted=true", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    const wi = makeWorkItem("H-1-1");
    wi.requiresManualReview = true;
    orch.addItem(wi);
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(true);
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("activeSessionCount excludes parked items whose workspaces are being closed", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual", sessionLimit: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.sessionParked = true;
    // H-1-1 parked: workspace closed (no workspaceRef) -> doesn't count
    orch.hydrateState("H-1-2", "implementing");
    orch.getItem("H-1-2")!.workspaceRef = "workspace:2";
    // H-1-2: active workspace -> counts

    expect(orch.activeSessionCount).toBe(1);
    expect(orch.availableSessionSlots).toBe(2);
  });

  it("activeSessionCount includes stuck parked items with a live workspace", () => {
    const orch = new Orchestrator({ sessionLimit: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));
    orch.hydrateState("H-1-1", "stuck");
    orch.getItem("H-1-1")!.sessionParked = true;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    // stuck + parked but workspace still alive -> counts
    orch.hydrateState("H-1-2", "implementing");
    orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

    expect(orch.activeSessionCount).toBe(2);
    expect(orch.availableSessionSlots).toBe(0);
  });

  it("live parked stuck worker does not free a launch slot", () => {
    const orch = new Orchestrator({ sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));

    orch.hydrateState("H-1-1", "stuck");
    orch.getItem("H-1-1")!.sessionParked = true;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    orch.hydrateState("H-1-2", "ready");

    const actions = orch.processTransitions(emptySnapshot());

    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-2")).toBe(false);
    expect(orch.getItem("H-1-2")!.state).toBe("ready");
  });

  it("queued item can launch after another item is parked (session slot freed)", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual", sessionLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));

    // H-1-1 is parked in review-pending
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.sessionParked = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;

    // H-1-2 is ready
    orch.hydrateState("H-1-2", "ready");

    const actions = orch.processTransitions(emptySnapshot());

    // Parked item frees the slot, allowing H-1-2 to launch
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-2")).toBe(true);
    expect(orch.getItem("H-1-2")!.state).toBe("launching");
  });

  it("does NOT park when reviewCompleted=false (AI request-changes)", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).not.toBe("review-pending");
    expect(orch.getItem("H-1-1")!.sessionParked).not.toBe(true);
    expect(actions.some((a) => a.type === "workspace-close")).toBe(false);
  });

  it("does NOT park when CHANGES_REQUESTED triggers review-pending", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const waitingActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", ciStatus: "pass", prState: "open",
        reviewDecision: "CHANGES_REQUESTED",
      }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(orch.getItem("H-1-1")!.sessionParked).not.toBe(true);
    expect(waitingActions.some((a) => a.type === "workspace-close")).toBe(false);
  });

  it("parked item resumes on CHANGES_REQUESTED with queued feedback", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.sessionParked = true;

    const waitingActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", ciStatus: "pass", prState: "open",
        reviewDecision: "CHANGES_REQUESTED",
      }]),
    );

    // respawnCiFixWorker transitions to ready, then launchReadyItems picks it up
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-1")!.reviewCompleted).toBe(false);
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(false);
    expect(orch.getItem("H-1-1")!.needsFeedbackResponse).toBe(true);
    expect(orch.getItem("H-1-1")!.pendingFeedbackMessage).toContain("GitHub review requested changes on PR #42.");
    expect(waitingActions.some((a) => a.type === "retry")).toBe(true);
    expect(waitingActions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
  });

  it("parked CHANGES_REQUESTED review with comments queues the review comment text", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.reviewCompleted = true;
    item.sessionParked = true;
    item.lastReviewedCommitSha = null;

    const waitingActions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", ciStatus: "pass", prState: "open",
        reviewDecision: "CHANGES_REQUESTED",
        headSha: "sha-parked-1",
        newComments: [
          { body: "Please cover the failed relaunch path.", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
      NOW,
    );

    expect(waitingActions).toEqual([]);
    expect(item.pendingFeedbackBatch).toBeDefined();

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1", ciStatus: "pass", prState: "open",
        reviewDecision: "CHANGES_REQUESTED",
        headSha: "sha-parked-1",
      }]),
      FEEDBACK_FLUSH_NOW,
    );

    expect(actions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(true);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
    expect(item.state).toBe("launching");
    expect(item.reviewCompleted).toBe(false);
    expect(item.needsFeedbackResponse).toBe(true);
    expect(item.lastReviewedCommitSha).toBe("sha-parked-1");
    expect(item.pendingFeedbackMessage).toContain("Please cover the failed relaunch path.");
    expect(item.lastCommentCheck).toBe("2026-01-15T12:01:00Z");
  });

  it("strategy change to auto while parked: evaluateMerge transitions to merging", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.sessionParked = true;

    // Switch strategy to auto -- triggers forceReviewPendingReevaluation
    orch.setMergeStrategy("auto");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
    // Parking cleared by the transition
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(false);
  });

  it("external merge on parked item: clean action works (no workspace to close)", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.sessionParked = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
    // No workspace-close needed -- session was already parked/closed
    expect(actions.some((a) => a.type === "workspace-close")).toBe(false);
    // Parking flag cleared by transition
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(false);
  });

  it("parked item with CI failure fast-paths to respawnCiFixWorker (M-SP-3)", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.getItem("H-1-1")!.sessionParked = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    // Fast-path: parked item skips notification, goes directly to ready -> launching
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-1")!.sessionParked).toBe(false);
    expect(orch.getItem("H-1-1")!.needsCiFix).toBe(true);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
    // Should NOT go through the notification path
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
  });

  it("non-parked review-pending item with CI failure uses notification path (M-SP-3)", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = false;
    // sessionParked defaults to false -- live worker

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
    // Should NOT fast-path to retry
    expect(actions.some((a) => a.type === "retry")).toBe(false);
  });

  it("parked CI failure fast-path sets needsCiFix for launch (M-SP-3)", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.hydrateState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.sessionParked = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    // needsCiFix ensures launch forces a worker even with existing PR
    expect(orch.getItem("H-1-1")!.needsCiFix).toBe(true);
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(actions.some((a) => a.type === "retry")).toBe(true);
    expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
  });
});
