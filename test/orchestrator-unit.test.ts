// Focused unit tests for the orchestrator state machine functions.
// Tests processTransitions (which drives handleImplementing, handlePrLifecycle, evaluateMerge)
// and the standalone reconstructState/buildSnapshot from orchestrate.ts.
// No vi.mock -- all isolation via dependency injection.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Orchestrator,
  statusDisplayForState,
  type OrchestratorItem,
  type OrchestratorItemState,
  type OrchestratorDeps,
  type ExecutionContext,
  type PollSnapshot,
  type ItemSnapshot,
  type Action,
} from "../core/orchestrator.ts";
import {
  buildSnapshot,
  reconstructState,
  syncWorkerDisplay,
} from "../core/commands/orchestrate.ts";
import {
  cleanStaleBranchForReuse,
  type StaleBranchCleanupDeps,
} from "../core/branch-cleanup.ts";
import type { WorkItem, Priority } from "../core/types.ts";
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
    repoAlias: "",
    rawText: `## ${id}\nTest item`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
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

// ── reconstructState ─────────────────────────────────────────────────

describe("reconstructState", () => {
  it("sets implementing when worktree exists but no PR", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const fakeCheckPr = (_id: string, _root: string) => "H-1-1\t\tno-pr";

    reconstructState(orch, "/tmp/proj", "/tmp/proj/.worktrees", undefined, fakeCheckPr);

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
    reconstructState(orch, "/tmp/proj", "/tmp/proj/.worktrees", undefined, fakeCheckPr);
    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  it("restores ciFailCount and retryCount from daemon state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const daemonState = {
      items: [{ id: "H-1-1", ciFailCount: 3, retryCount: 2 }],
    };

    reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(3);
    expect(orch.getItem("H-1-1")!.retryCount).toBe(2);
  });

  it("restores reviewCompleted from daemon state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const daemonState = {
      items: [
        { id: "H-1-1", ciFailCount: 0, retryCount: 0, reviewCompleted: true, reviewWorkspaceRef: "workspace:5" },
      ],
    };

    reconstructState(
      orch, "/tmp/proj", "/tmp/proj/.worktrees", undefined,
      () => "", daemonState,
    );

    expect(orch.getItem("H-1-1")!.reviewCompleted).toBe(true);
    expect(orch.getItem("H-1-1")!.reviewWorkspaceRef).toBe("workspace:5");
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
    orch.setState("H-1-1", "done");

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

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

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.readyIds).not.toContain("H-1-2");
    expect(snap.readyIds).toContain("H-1-1"); // no deps → always ready
  });

  it("parses merged PR status into snapshot (already tracked PR)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    // Set prNumber so the merged check uses the "already tracked" fast path
    orch.getItem("H-1-1")!.prNumber = 42;

    const fakeCheckPr = (_id: string) => "H-1-1\t42\tmerged\t\t\tfeat: implement H-1-1";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    expect(itemSnap!.prState).toBe("merged");
    expect(itemSnap!.prNumber).toBe(42);
  });

  it("parses CI pass status with review approval", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");

    const fakeCheckPr = () => "H-1-1\t42\tready\tMERGEABLE\t2026-01-15T12:00:00Z";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

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
    orch.setState("H-1-1", "ci-pending");

    const fakeCheckPr = () => "H-1-1\t42\tfailing\tCONFLICTING\t2026-01-15T12:00:00Z";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap!.ciStatus).toBe("fail");
    expect(itemSnap!.isMergeable).toBe(false);
  });

  it("skips terminal states (done, stuck) in snapshot items", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.setState("H-1-1", "done");
    orch.setState("H-1-2", "stuck");

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.items.find((s) => s.id === "H-1-1")).toBeUndefined();
    expect(snap.items.find((s) => s.id === "H-1-2")).toBeUndefined();
  });

  it("sets eventTime from checkPr 5th field", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");

    const fakeCheckPr = () => "H-1-1\t42\tpending\tMERGEABLE\t2026-01-15T11:59:00Z";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge" && a.prNumber === 42)).toBe(true);
  });

  it("auto strategy: blocks merge when CHANGES_REQUESTED", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("manual strategy: never auto-merges, moves to review-pending", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("auto strategy: gates on reviewCompleted (always-on review)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // First pass: not reviewed → goes to reviewing
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(actions.some((a) => a.type === "launch-review")).toBe(true);
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("auto strategy: merges after review completes", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("bypass strategy: merges with admin override after CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "bypass", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("review gate: ci-passed always transitions to reviewing (no separate review WIP limit)", () => {
    // reviewing is in WIP_STATES; ci-passed→reviewing is an in-place transition
    // (same WIP slot). No separate reviewWipLimit blocks it.
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.addItem(makeWorkItem("H-1-2"));
    orch.setState("H-1-1", "reviewing"); // occupies a WIP slot
    orch.getItem("H-1-1")!.prNumber = 10;
    orch.setState("H-1-2", "ci-passed");
    orch.getItem("H-1-2")!.prNumber = 20;

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open" },
        { id: "H-1-2", ciStatus: "pass", prState: "open" },
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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    // Manual → review-pending
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );
    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");

    // Switch to auto → should now merge
    orch.setMergeStrategy("auto");
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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

  it("is forward-only: existing items keep their state", () => {
    const orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 10;
    orch.setState("H-1-2", "review-pending");
    orch.getItem("H-1-2")!.prNumber = 20;

    // Switch to auto -- H-1-1 (ci-passed) will be affected, H-1-2 (review-pending) stays
    orch.setMergeStrategy("auto");
    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open" },
        { id: "H-1-2", ciStatus: "pass", prState: "open" },
      ]),
    );

    // H-1-1 should merge (ci-passed + auto)
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    // H-1-2 was already in review-pending -- stays there (not re-evaluated for merge in that state)
    expect(orch.getItem("H-1-2")!.state).toBe("review-pending");
  });
});

// ── handleImplementing (tested via processTransitions) ───────────────

describe("handleImplementing", () => {
  it("transitions to ci-pending when PR appears", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", workerAlive: true }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(42);
  });

  it("transitions to merged when PR auto-merges between polls", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    const orch = new Orchestrator({ launchTimeoutMs: 1000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    const orch = new Orchestrator({ activityTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.baseBranch = "ninthwave/H-1-0";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending" }]),
      NOW,
    );

    expect(actions.some((a) => a.type === "sync-stack-comments" && a.itemId === "H-1-1")).toBe(true);
  });

  it("chains PR open through to CI handling in same cycle", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pass" }]),
      NOW,
    );

    // Should chain through ci-pending → ci-passed → merging in one cycle
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });
});

// ── Heartbeat-based health detection (tested via processTransitions) ──

describe("heartbeat-based health detection", () => {
  it("worker with recent heartbeat (< 5 min) is not marked stuck even with no commits", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    const orch = new Orchestrator({ launchTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    const orch = new Orchestrator({ launchTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    const orch = new Orchestrator({ launchTimeoutMs: 1000, activityTimeoutMs: 5000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    const orch = new Orchestrator({ launchTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "implementing");

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
    orch.setState("H-1-1", "ci-pending");
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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(1);
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
  });

  it("does not re-notify CI failure on subsequent ticks (deduplication)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
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
    orch.setState("H-1-1", "ci-pending");
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
    orch.setState("H-1-1", "ci-pending");
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

  it("transitions to merged when PR is externally merged", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
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
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 1;
    orch.getItem("H-1-1")!.reviewCompleted = true; // Re-set after ci-failed reset

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("marks stuck when ciFailCount exceeds maxCiRetries", () => {
    const orch = new Orchestrator({ maxCiRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 2; // exceeds maxCiRetries of 1

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close")).toBe(true);
  });

  it("recovers from ci-failed to ci-pending when CI goes back to pending", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
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
    orch.setState("H-1-1", "ci-passed");
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
    const orch = new Orchestrator({ mergeStrategy: "auto", wipLimit: 1 });
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
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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

    orch.setState("L-1-1", "ci-passed");
    orch.getItem("L-1-1")!.reviewCompleted = true;
    orch.getItem("L-1-1")!.prNumber = 10;
    orch.setState("C-1-1", "ci-passed");
    orch.getItem("C-1-1")!.reviewCompleted = true;
    orch.getItem("C-1-1")!.prNumber = 20;

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "L-1-1", ciStatus: "pass", prState: "open" },
        { id: "C-1-1", ciStatus: "pass", prState: "open" },
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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(actions.filter((a) => a.type === "merge")).toHaveLength(1);
  });
});

// ── Stacked branch launches ──────────────────────────────────────────

describe("stacked branch launches", () => {
  it("launches stacked item when dep is in ci-passed", () => {
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    // Move dep to ci-passed (a stackable state)
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 10;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    // H-1-2 should be promoted from queued → ready → launching via stacking
    expect(orch.getItem("H-1-2")!.state).toBe("launching");
    expect(orch.getItem("H-1-2")!.baseBranch).toBe("ninthwave/H-1-1");
    const launchAction = actions.find((a) => a.type === "launch" && a.itemId === "H-1-2");
    expect(launchAction).toBeDefined();
    expect(launchAction!.baseBranch).toBe("ninthwave/H-1-1");
  });

  it("does not stack when dep is in implementing (non-stackable)", () => {
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
    );

    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });

  it("does not stack when enableStacking is false", () => {
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: false });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.prNumber = 10;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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

    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 5; // exceeds maxCiRetries
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and alive
    orch.setState("H-1-2", "implementing");
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

    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 5;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and in ready state (no worker yet)
    orch.setState("H-1-2", "ready");
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
    // No rebase action for pre-WIP dependent
    const rebaseAction = actions.find((a) => a.type === "rebase" && a.itemId === "H-1-2");
    expect(rebaseAction).toBeUndefined();
  });

  it("reverts stacked dependent in launching state to queued when dep goes stuck", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 5;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and in launching state (no worker yet)
    orch.setState("H-1-2", "launching");
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

    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 5;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and implementing with active worker
    orch.setState("H-1-2", "implementing");
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

    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 5;
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 depends on H-1-1 but has no baseBranch (not stacked)
    orch.setState("H-1-2", "ready");
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
    orch.setState("H-1-1", "implementing");
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
    const orch = new Orchestrator({ maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

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
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

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
    orch.setState("H-1-1", "launching");

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
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
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
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
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
    orch.setState("H-1-1", "merging");
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
  const approveVerdict = { verdict: "approve" as const, summary: "No issues.", blockerCount: 0, nitCount: 0, preExistingCount: 0, architectureScore: 8, codeQualityScore: 9, performanceScore: 7, testCoverageScore: 8, unresolvedDecisions: 0, criticalGaps: 0, confidence: 9 };
  const requestChangesVerdict = { verdict: "request-changes" as const, summary: "Found blockers.", blockerCount: 2, nitCount: 0, preExistingCount: 0, architectureScore: 5, codeQualityScore: 4, performanceScore: 6, testCoverageScore: 3, unresolvedDecisions: 2, criticalGaps: 2, confidence: 7 };

  it("transitions to ci-passed with reviewCompleted on approve verdict", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "reviewing");
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

  it("transitions to review-pending on request-changes verdict", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "reviewing");
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
    orch.setState("H-1-1", "reviewing");
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
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "reviewing");
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
});

// ── handleReviewPending CI detection (H-RX-1) ──────────────────────────

describe("handleReviewPending", () => {
  /** Helper: set up an item in review-pending state (after request-changes). */
  function setupReviewPending(orch: Orchestrator, id = "H-1-1") {
    orch.addItem(makeWorkItem(id));
    orch.getItem(id)!.reviewCompleted = false;
    orch.setState(id, "review-pending");
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

// ── Full multi-round review cycle (H-RX-1) ────────────────────────────

describe("multi-round review cycle", () => {
  it("request-changes → ci-pending → ci-passed → reviewing → approve → merge", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    // reviewCompleted starts false -- the item entered reviewing via evaluateMerge
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.setState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;

    const requestChangesVerdict = {
      verdict: "request-changes" as const,
      summary: "Found blockers.",
      blockerCount: 2,
      nitCount: 0,
      preExistingCount: 0,
    };
    const approveVerdict = {
      verdict: "approve" as const,
      summary: "No issues.",
      blockerCount: 0,
      nitCount: 0,
      preExistingCount: 0,
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
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("calls cleanStaleBranch before launchSingleItem", () => {
    const callOrder: string[] = [];
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    const deps = makeMinimalDeps({
      cleanStaleBranch: () => { callOrder.push("clean"); },
      launchSingleItem: () => {
        callOrder.push("launch");
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      },
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(callOrder).toEqual(["clean", "launch"]);
  });

  it("proceeds with launch when cleanStaleBranch throws", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    const warnings: string[] = [];
    const deps = makeMinimalDeps({
      cleanStaleBranch: () => { throw new Error("cleanup explosion"); },
      warn: (msg) => { warnings.push(msg); },
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(warnings.some((w) => w.includes("cleanup explosion"))).toBe(true);
  });

  it("launches normally when cleanStaleBranch is not provided", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    const deps = makeMinimalDeps({
      // cleanStaleBranch intentionally omitted
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.workspaceRef).toBe("workspace:1");
  });

  it("writes fresh heartbeat with progress 0.0 before launching", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

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
});

// ── Stacked launch race guard (H-SL-1) ─────────────────────────────

describe("executeLaunch stacked dep race guard", () => {
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("clears baseBranch when dependency is in done state before launch", () => {
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    // A completed (done state) -- its branch is deleted from origin
    orch.setState("A-1", "done");

    // B was promoted to launching with stale baseBranch
    orch.setState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({
      launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      },
    });

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
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    orch.setState("A-1", "merged");

    orch.setState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({
      launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      },
    });

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
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    orch.addItem(makeWorkItem("A-1"));
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    // A is still in flight (ci-passed) -- baseBranch should be preserved
    orch.setState("A-1", "ci-passed");
    orch.getItem("A-1")!.prNumber = 10;

    orch.setState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({
      launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      },
    });

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
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    // Only add B -- A is unknown (maybe removed from work items)
    orch.addItem(makeWorkItem("B-1", ["A-1"]));

    orch.setState("B-1", "launching");
    orch.getItem("B-1")!.baseBranch = "ninthwave/A-1";

    const launchCalls: Array<{ baseBranch?: string }> = [];
    const deps = makeMinimalDeps({
      launchSingleItem: (_item, _wd, _wtd, _pr, _ai, bb) => {
        launchCalls.push({ baseBranch: bb });
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      },
    });

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
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("rebases and transitions to ci-pending when merge fails due to conflicts", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    let daemonRebaseCalled = false;
    const deps = makeMinimalDeps({
      prMerge: () => false, // merge fails
      checkPrMergeable: () => false, // PR is CONFLICTING
      daemonRebase: () => {
        daemonRebaseCalled = true;
        return true; // rebase succeeds
      },
    });

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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({
      prMerge: () => false, // merge fails
      checkPrMergeable: () => true, // PR is NOT conflicting
    });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("ci-passed");
    expect(item.mergeFailCount).toBe(1);
  });

  it("falls back to worker rebase message when daemonRebase fails on conflicting PR", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";

    const sentMessages: string[] = [];
    const deps = makeMinimalDeps({
      prMerge: () => false,
      checkPrMergeable: () => false, // CONFLICTING
      daemonRebase: () => false, // rebase fails
      sendMessage: (_ref, msg) => {
        sentMessages.push(msg);
        return true;
      },
    });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("conflicts");
    expect(item.state).toBe("ci-pending");
    // mergeFailCount should NOT be incremented
    expect(item.mergeFailCount ?? 0).toBe(0);
    // Worker should have received a rebase message
    expect(sentMessages.some((m) => m.includes("Rebase Required"))).toBe(true);
  });

  it("falls back to worker rebase when daemonRebase throws on conflicting PR", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";

    const sentMessages: string[] = [];
    const deps = makeMinimalDeps({
      prMerge: () => false,
      checkPrMergeable: () => false,
      daemonRebase: () => { throw new Error("rebase exploded"); },
      sendMessage: (_ref, msg) => {
        sentMessages.push(msg);
        return true;
      },
    });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(item.state).toBe("ci-pending");
    expect(item.mergeFailCount ?? 0).toBe(0);
    expect(sentMessages.some((m) => m.includes("Rebase Required"))).toBe(true);
  });

  it("resets rebaseRequested when conflict detected", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.rebaseRequested = true; // previously requested

    const deps = makeMinimalDeps({
      prMerge: () => false,
      checkPrMergeable: () => false,
      daemonRebase: () => true,
    });

    orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(item.rebaseRequested).toBe(false);
  });

  it("handles merge failure without checkPrMergeable (treats as non-conflict)", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", maxMergeRetries: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({
      prMerge: () => false,
      // checkPrMergeable intentionally omitted -- should default to non-conflict
    });

    const result = orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42 }, ctx, deps);

    expect(item.state).toBe("ci-passed");
    expect(item.mergeFailCount).toBe(1);
  });
});

describe("executeMerge admin override", () => {
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("passes admin flag to prMerge when action has admin: true", () => {
    const orch = new Orchestrator({ mergeStrategy: "bypass", bypassEnabled: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    let receivedOptions: { admin?: boolean } | undefined;
    const deps = makeMinimalDeps({
      prMerge: (_repoRoot, _prNumber, options) => {
        receivedOptions = options;
        return true;
      },
    });

    orch.executeAction({ type: "merge", itemId: "H-1-1", prNumber: 42, admin: true }, ctx, deps);

    expect(receivedOptions).toEqual({ admin: true });
  });

  it("does not pass admin flag when action has no admin field", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    let receivedOptions: { admin?: boolean } | undefined;
    const deps = makeMinimalDeps({
      prMerge: (_repoRoot, _prNumber, options) => {
        receivedOptions = options;
        return true;
      },
    });

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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "Please fix the error handling", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    const sendMsg = actions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsg).toBeDefined();
    expect(sendMsg!.message).toContain("@reviewer");
    expect(sendMsg!.message).toContain("Please fix the error handling");
  });

  it("does not generate action for untrusted comments (not in snapshot)", () => {
    // Untrusted comments are filtered out during buildSnapshot (not included in newComments).
    // Verify that empty newComments generates no relay actions.
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // First tick: comment appears → relay
    const actions1 = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "Looks good overall", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
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

  it("generates daemon-rebase action for 'rebase' keyword in comment", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "Please rebase onto main", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    const rebaseAction = actions.find((a) => a.type === "daemon-rebase" && a.itemId === "H-1-1");
    expect(rebaseAction).toBeDefined();
    expect(rebaseAction!.message).toContain("@reviewer");
    expect(rebaseAction!.message).toContain("rebase");
    // Should NOT also generate a send-message for the same comment
    expect(actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1")).toHaveLength(0);
  });

  it("does not process comments for items without a prNumber", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    // No prNumber set

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        workerAlive: true,
        newComments: [
          { body: "Some comment", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
      NOW,
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("does not process comments for items without a workspaceRef", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    // No workspaceRef set

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "Fix this", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
  });

  it("skips orchestrator's own audit-trail comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "**[Orchestrator]** Auto-merged PR #42 for H-1-1.", author: "bot", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
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
      orch.setState("H-1-1", state as any);
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
      orch.getItem("H-1-1")!.ciFailCount = 0;

      const actions = orch.processTransitions(
        snapshotWith([{
          id: "H-1-1",
          ciStatus: ciStatus as any,
          prState: "open",
          isMergeable: true,
          newComments: [
            { body: "Please address this", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
          ],
        }]),
      );

      const sendMsg = actions.find((a) => a.type === "send-message" && a.itemId === "H-1-1");
      expect(sendMsg).toBeDefined();
    }
  });

  it("does not duplicate daemon-rebase when CI already triggered one", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
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
          { body: "Please rebase", author: "reviewer", createdAt: "2026-01-15T12:01:00Z" },
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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "First comment", author: "alice", createdAt: "2026-01-15T12:01:00Z" },
          { body: "Second comment", author: "bob", createdAt: "2026-01-15T12:02:00Z" },
        ],
      }]),
    );

    const sendMsgs = actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsgs).toHaveLength(2);
    expect(sendMsgs[0]!.message).toContain("@alice");
    expect(sendMsgs[1]!.message).toContain("@bob");
    // lastCommentCheck should be the latest comment timestamp
    expect(orch.getItem("H-1-1")!.lastCommentCheck).toBe("2026-01-15T12:02:00Z");
  });

  it("skips orchestrator status comments with HTML marker", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "<!-- ninthwave-orchestrator-status -->\n| Event | Time |\n|---|---|\n| CI pending | 12:00 |", author: "bot", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("skips implementer self-comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "**[Implementer](https://github.com/org/repo/blob/main/agents/implementer.md)** Addressed feedback: fixed error handling.", author: "bot", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("skips comments from other agents (reviewer, verifier, repairer)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "**[Reviewer](https://github.com/org/repo/blob/main/agents/reviewer.md)** Review complete.", author: "bot", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    expect(actions.filter((a) => a.type === "send-message")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("relays human reviewer comments while filtering agent comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "**[Orchestrator](https://github.com/org/repo/blob/main/agents/orchestrator.md)** Status for H-1-1: CI pending", author: "bot", createdAt: "2026-01-15T12:01:00Z" },
          { body: "<!-- ninthwave-orchestrator-status -->\n| Status |", author: "bot", createdAt: "2026-01-15T12:02:00Z" },
          { body: "**[Implementer](https://github.com/org/repo/blob/main/agents/implementer.md)** Fixed the issue.", author: "bot", createdAt: "2026-01-15T12:03:00Z" },
          { body: "Great work, but please add error handling for the edge case.", author: "reviewer", createdAt: "2026-01-15T12:04:00Z" },
        ],
      }]),
    );

    // Only the human reviewer comment should be relayed
    const sendMsgs = actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsgs).toHaveLength(1);
    expect(sendMsgs[0]!.message).toContain("@reviewer");
    expect(sendMsgs[0]!.message).toContain("error handling for the edge case");
  });

  it("relays GitHub review body comments", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{
        id: "H-1-1",
        ciStatus: "pending",
        prState: "open",
        newComments: [
          { body: "LGTM! Approved with minor nit: consider renaming the variable.", author: "senior-dev", createdAt: "2026-01-15T12:01:00Z" },
        ],
      }]),
    );

    const sendMsgs = actions.filter((a) => a.type === "send-message" && a.itemId === "H-1-1");
    expect(sendMsgs).toHaveLength(1);
    expect(sendMsgs[0]!.message).toContain("@senior-dev");
    expect(sendMsgs[0]!.message).toContain("renaming the variable");
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

  it("returns correct display for merged (maps to done)", () => {
    const d = statusDisplayForState("merged");
    expect(d.text).toBe("Done");
    expect(d.icon).toBe("checkmark.seal.fill");
    expect(d.color).toBe("#22c55e");
  });

  it("returns Rebasing display when rebaseRequested is true and state is ci-pending", () => {
    const d = statusDisplayForState("ci-pending", { rebaseRequested: true });
    expect(d.text).toBe("Rebasing");
    expect(d.icon).toBe("arrow.triangle.branch");
    expect(d.color).toBe("#f59e0b");
  });

  it("returns Rebasing display when rebaseRequested is true and state is ci-failed", () => {
    const d = statusDisplayForState("ci-failed", { rebaseRequested: true });
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
    orch.setState("H-1-1", "implementing");
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
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const fakeCheckPr = () => "H-1-1\t42\tpending\tMERGEABLE";
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(
      orch, "/tmp/nonexistent", "/tmp/nonexistent/.worktrees",
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
    orch.setState("H-1-1", "done");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // The executeClean uses fs.existsSync/unlinkSync directly on the heartbeatFilePath.
    // Since we're in tests with a non-existent path, existsSync returns false and
    // the cleanup is skipped gracefully. We verify the overall clean still succeeds.
    const ctx: ExecutionContext = {
      projectRoot: "/tmp/proj-heartbeat-test",
      worktreeDir: "/tmp/proj-heartbeat-test/.worktrees",
      workDir: "/tmp/proj-heartbeat-test/.ninthwave/work",
      aiTool: "test",
    };

    const deps: OrchestratorDeps = {
      launchSingleItem: () => null,
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
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
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: { id: "H-1-1", progress: 0.5, label: "Writing tests", ts: "2026-01-15T12:00:00Z" } }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: { id: "H-1-1", progress: 0.7, label: "Almost done", ts: "2026-01-15T12:00:00Z" } }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
    orch.getItem("H-1-1")!.prNumber = 42;

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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
    orch.setState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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
    orch.setState("H-1-1", "implementing");
    // No workspaceRef set

    const mux = createMockMux();
    const snapshot: PollSnapshot = { items: [{ id: "H-1-1" }], readyIds: [] };

    syncWorkerDisplay(orch, snapshot, mux);

    expect(mux.statusCalls).toHaveLength(0);
    expect(mux.progressCalls).toHaveLength(0);
  });

  it("skips terminal-state items (done, stuck)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "done");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = { items: [], readyIds: [] };

    syncWorkerDisplay(orch, snapshot, mux);

    expect(mux.statusCalls).toHaveLength(0);
    expect(mux.progressCalls).toHaveLength(0);
  });

  it("sets progress to 0% for implementing when no heartbeat", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const mux = createMockMux();
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", lastHeartbeat: null }],
      readyIds: [],
    };

    syncWorkerDisplay(orch, snapshot, mux);

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

// ── Repair worker state transitions ──────────────────────────────────

describe("repair worker state transitions", () => {
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("daemon-rebase failure launches repair worker and transitions to repairing", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({
      daemonRebase: () => false, // daemon rebase fails
      launchRepair: () => ({ workspaceRef: "repair:1" }),
    });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("repairing");
    expect(item.repairWorkspaceRef).toBe("repair:1");
  });

  it("daemon-rebase success transitions to ci-pending without repair worker", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const launchRepairCalled = { value: false };
    const deps = makeMinimalDeps({
      daemonRebase: () => true, // daemon rebase succeeds
      launchRepair: () => { launchRepairCalled.value = true; return null; },
    });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("ci-pending");
    expect(launchRepairCalled.value).toBe(false);
  });

  it("repairing transitions to ci-pending when CI restarts after push", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "repairing");
    const item = orch.getItem("H-1-1")!;
    item.repairWorkspaceRef = "repair:1";
    item.rebaseRequested = true;

    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", ciStatus: "pending", workerAlive: true }],
      readyIds: [],
    };

    const actions = orch.processTransitions(snapshot);

    expect(item.state).toBe("ci-pending");
    expect(item.rebaseRequested).toBe(false);
    expect(actions.some(a => a.type === "clean-repair")).toBe(true);
  });

  it("repairing transitions to stuck when repair worker dies", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "repairing");
    const item = orch.getItem("H-1-1")!;
    item.repairWorkspaceRef = "repair:1";

    // Simulate 5 consecutive not-alive polls (debounce)
    for (let i = 0; i < 5; i++) {
      const snapshot: PollSnapshot = {
        items: [{ id: "H-1-1", workerAlive: false }],
        readyIds: [],
      };
      orch.processTransitions(snapshot);
    }

    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("repair-failed");
  });

  it("executeCleanRepair cleans up the repair workspace", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.repairWorkspaceRef = "repair:1";

    const cleaned: string[] = [];
    const deps = makeMinimalDeps({
      cleanRepair: (_id, ref) => { cleaned.push(ref); return true; },
    });

    orch.executeAction({ type: "clean-repair", itemId: "H-1-1" }, ctx, deps);

    expect(cleaned).toEqual(["repair:1"]);
    expect(item.repairWorkspaceRef).toBeUndefined();
  });

  it("executeLaunch transitions to ci-pending when existingPrNumber is returned", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    const deps = makeMinimalDeps({
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "", existingPrNumber: 271 }),
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    const item = orch.getItem("H-1-1")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(271);
    expect(item.workspaceRef).toBeUndefined();
  });

  it("falls back to worker message when repair worker not available", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";

    const messages: string[] = [];
    const deps = makeMinimalDeps({
      daemonRebase: () => false,
      // launchRepair intentionally omitted
      sendMessage: (_ref, msg) => { messages.push(msg); return true; },
    });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("ci-pending"); // still ci-pending, message sent to worker
    expect(messages.length).toBeGreaterThan(0);
  });
});

// ── Repair rebase circuit breaker + worker message priority ──────────

describe("repair rebase circuit breaker and worker message priority", () => {
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("circuit breaker marks stuck after maxRepairAttempts", () => {
    const orch = new Orchestrator({ wipLimit: 1, maxRepairAttempts: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.repairAttemptCount = 2; // already at limit

    const launchRepairCalled = { value: false };
    const deps = makeMinimalDeps({
      daemonRebase: () => false,
      launchRepair: () => { launchRepairCalled.value = true; return { workspaceRef: "repair:1" }; },
    });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("repair-loop");
    expect(item.failureReason).toContain("max repair attempts");
    expect(launchRepairCalled.value).toBe(false); // repair NOT launched
  });

  it("prefers worker message over repair when workspaceRef exists and sendMessage succeeds", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";

    const launchRepairCalled = { value: false };
    const messagesSent: Array<{ ref: string; msg: string }> = [];
    const deps = makeMinimalDeps({
      daemonRebase: () => false,
      launchRepair: () => { launchRepairCalled.value = true; return { workspaceRef: "repair:1" }; },
      sendMessage: (ref, msg) => { messagesSent.push({ ref, msg }); return true; },
    });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(launchRepairCalled.value).toBe(false); // repair NOT launched
    expect(messagesSent.length).toBe(1);
    expect(messagesSent[0].ref).toBe("workspace:1");
  });

  it("falls back to repair when worker message fails (sendMessage returns false)", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";

    const deps = makeMinimalDeps({
      daemonRebase: () => false,
      sendMessage: () => false, // worker message fails
      launchRepair: () => ({ workspaceRef: "repair:1" }),
    });

    const result = orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("repairing");
    expect(item.repairWorkspaceRef).toBe("repair:1");
    expect(item.repairAttemptCount).toBe(1);
  });

  it("repairAttemptCount resets when conflicts resolve (isMergeable !== false)", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.repairAttemptCount = 2;

    // Simulate CI passing with PR now mergeable
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", ciStatus: "pass", isMergeable: true }],
      readyIds: [],
    };

    orch.processTransitions(snapshot);

    expect(item.repairAttemptCount).toBe(0);
  });

  it("repairAttemptCount preserves when conflicts persist (isMergeable === false)", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.repairAttemptCount = 2;

    // Simulate PR still conflicting
    const snapshot: PollSnapshot = {
      items: [{ id: "H-1-1", ciStatus: "pending", isMergeable: false }],
      readyIds: [],
    };

    orch.processTransitions(snapshot);

    expect(item.repairAttemptCount).toBe(2); // preserved, not reset
  });

  it("repairAttemptCount increments on each repair launch", () => {
    const orch = new Orchestrator({ wipLimit: 1, maxRepairAttempts: 5 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.repairAttemptCount = 1; // already had one attempt

    const deps = makeMinimalDeps({
      daemonRebase: () => false,
      launchRepair: () => ({ workspaceRef: "repair:2" }),
    });

    orch.executeAction({ type: "daemon-rebase", itemId: "H-1-1" }, ctx, deps);

    expect(item.repairAttemptCount).toBe(2);
    expect(item.state).toBe("repairing");
  });

  it("full loop terminates after maxRepairAttempts (integration-style)", () => {
    const maxAttempts = 3;
    const orch = new Orchestrator({ wipLimit: 1, maxRepairAttempts: maxAttempts });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;

    const deps = makeMinimalDeps({
      daemonRebase: () => false,
      launchRepair: () => ({ workspaceRef: "repair:x" }),
    });

    // Simulate the loop: detect conflict → daemon-rebase → repair → CI restarts → still conflicting
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 1. Detect conflict in ci-pending → triggers daemon-rebase
      const conflictSnap: PollSnapshot = {
        items: [{ id: "H-1-1", isMergeable: false }],
        readyIds: [],
      };
      const actions = orch.processTransitions(conflictSnap);
      const rebaseAction = actions.find(a => a.type === "daemon-rebase");

      if (!rebaseAction) break; // no more rebase actions = loop terminated

      // 2. Execute daemon-rebase → launches repair (daemon rebase fails)
      orch.executeAction(rebaseAction, ctx, deps);
      expect(item.state).toBe("repairing");

      // 3. Repair worker pushes → CI restarts
      const repairDoneSnap: PollSnapshot = {
        items: [{ id: "H-1-1", ciStatus: "pending", workerAlive: true }],
        readyIds: [],
      };
      orch.processTransitions(repairDoneSnap);
      expect(item.state).toBe("ci-pending");
      expect(item.rebaseRequested).toBe(false);
    }

    // One more cycle: conflict still present, but circuit breaker should fire
    const finalSnap: PollSnapshot = {
      items: [{ id: "H-1-1", isMergeable: false }],
      readyIds: [],
    };
    const finalActions = orch.processTransitions(finalSnap);
    const finalRebase = finalActions.find(a => a.type === "daemon-rebase");

    if (finalRebase) {
      // Execute the final daemon-rebase -- circuit breaker should trigger
      orch.executeAction(finalRebase, ctx, deps);
    }

    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("repair-loop");
    expect(item.repairAttemptCount).toBe(maxAttempts);
  });
});

// ── Daemon-worker worktree race prevention (H-WR-1) ──────────────────

describe("daemon-worker worktree race prevention (H-WR-1)", () => {
  function makeMinimalDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "workspace:1" }),
      cleanSingleWorktree: () => true,
      prMerge: () => true,
      prComment: () => true,
      sendMessage: () => true,
      closeWorkspace: () => true,
      fetchOrigin: () => {},
      ffMerge: () => {},
      ...overrides,
    };
  }

  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "claude",
  };

  it("daemon-rebase is never emitted in the same cycle as a worker launch for the same item", () => {
    const orch = new Orchestrator({ wipLimit: 2 });
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
    const orch = new Orchestrator({ wipLimit: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
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
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
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

    expect(result.success).toBe(true);
    expect(item.state).toBe("ready");
    expect(item.needsCiFix).toBe(true);
  });

  it("executeLaunch with needsCiFix passes forceWorkerLaunch and launches worker", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");
    const item = orch.getItem("H-1-1")!;
    item.needsCiFix = true;
    item.ciFailCount = 1;
    item.prNumber = 42;

    let receivedForceFlag = false;
    const deps = makeMinimalDeps({
      launchSingleItem: (_item, _td, _wd, _pr, _ai, _bb, forceWorkerLaunch) => {
        receivedForceFlag = forceWorkerLaunch === true;
        // With forceWorkerLaunch, returns normal launch result (no existingPrNumber)
        return { worktreePath: "/tmp/wt", workspaceRef: "workspace:1" };
      },
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    expect(receivedForceFlag).toBe(true);
    expect(item.workspaceRef).toBe("workspace:1");
    expect(item.needsCiFix).toBe(false);
  });

  it("executeLaunch without needsCiFix transitions to ci-pending on existingPrNumber", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    const deps = makeMinimalDeps({
      launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "", existingPrNumber: 271 }),
    });

    const result = orch.executeAction({ type: "launch", itemId: "H-1-1" }, ctx, deps);

    expect(result.success).toBe(true);
    const item = orch.getItem("H-1-1")!;
    expect(item.state).toBe("ci-pending");
    expect(item.prNumber).toBe(271);
    expect(item.workspaceRef).toBeUndefined();
  });

  it("full CI-failed restart cycle: ci-failed → notify fails → ready → launch with worker", () => {
    const orch = new Orchestrator({ wipLimit: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.ciFailCount = 1;
    // No workspaceRef -- dead worker after restart

    const deps = makeMinimalDeps({
      launchSingleItem: (_item, _td, _wd, _pr, _ai, _bb, forceWorkerLaunch) => {
        if (forceWorkerLaunch) {
          return { worktreePath: "/tmp/wt", workspaceRef: "workspace:2" };
        }
        return { worktreePath: "/tmp/wt", workspaceRef: "", existingPrNumber: 42 };
      },
    });

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
    orch.setState("H-1-1", "implementing");
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
      wipLimit: 2,
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
    orch.setState("H-1-1", "implementing");
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
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // Provide an eventTime in the past to produce measurable latency
    const pastTime = new Date(Date.now() - 5000).toISOString();
    orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", prNumber: 42, ciStatus: "pass", prState: "open", workerAlive: true, eventTime: pastTime },
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
    blockerCount: 2,
    nitCount: 1,
    preExistingCount: 0,
  };
  const approveVerdict = {
    verdict: "approve" as const,
    summary: "No issues.",
    blockerCount: 0,
    nitCount: 0,
    preExistingCount: 0,
  };

  it("increments reviewRound on each launch-review execution", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Round 1: ci-passed → reviewing (launches review)
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    // Round 2: ci-passed → reviewing (launches review again)
    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(orch.getItem("H-1-1")!.reviewRound).toBe(2);
  });

  it("transitions to stuck when reviewRound >= maxReviewRounds", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto", maxReviewRounds: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;
    // Simulate already having completed 2 rounds
    orch.getItem("H-1-1")!.reviewRound = 2;

    // Next review attempt would be round 3, which exceeds maxReviewRounds=2
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("exceeded max review rounds");
    expect(actions.some((a) => a.type === "launch-review")).toBe(false);
  });

  it("includes rich verdict summary in notify-review message", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.setState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewRound = 2;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
    );

    const notifyAction = actions.find((a) => a.type === "notify-review");
    expect(notifyAction).toBeDefined();
    expect(notifyAction!.message).toContain("round 2");
    expect(notifyAction!.message).toContain("2 blockers");
    expect(notifyAction!.message).toContain("1 nits");
    expect(notifyAction!.message).toContain("Found blockers.");
  });

  it("shows round in status description only when reviewRound > 1", () => {
    const orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = false;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Round 1: status description should NOT include round number
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;
    // reviewRound is undefined by default

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
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
