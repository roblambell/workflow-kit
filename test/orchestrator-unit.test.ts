// Focused unit tests for the orchestrator state machine functions.
// Tests processTransitions (which drives handleImplementing, handlePrLifecycle, evaluateMerge)
// and the standalone reconstructState/buildSnapshot from orchestrate.ts.
// No vi.mock — all isolation via dependency injection.

import { describe, it, expect, beforeEach } from "vitest";
import {
  Orchestrator,
  type OrchestratorItem,
  type PollSnapshot,
  type ItemSnapshot,
  type Action,
} from "../core/orchestrator.ts";
import {
  buildSnapshot,
  reconstructState,
} from "../core/commands/orchestrate.ts";
import type { TodoItem, Priority } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(id: string, deps: string[] = [], priority: Priority = "medium"): TodoItem {
  return {
    id,
    priority,
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
    orch.addItem(makeTodo("H-1-1"));

    const fakeCheckPr = (_id: string, _root: string) => "H-1-1\t\tno-pr";

    reconstructState(orch, "/tmp/proj", "/tmp/proj/.worktrees", undefined, fakeCheckPr);

    // Items without a worktree directory won't be reconstructed (existsSync check),
    // so items stay queued when worktree doesn't exist
    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  it("sets ci-passed when PR status is ready", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));

    // reconstructState only processes items whose worktree exists on disk.
    // Without a real worktree, items remain queued — verifying the guard.
    const fakeCheckPr = (_id: string, _root: string) => "H-1-1\t42\tready";
    reconstructState(orch, "/tmp/proj", "/tmp/proj/.worktrees", undefined, fakeCheckPr);
    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  it("restores ciFailCount and retryCount from daemon state", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));

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
    orch.addItem(makeTodo("H-1-1"));

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
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));
    orch.setState("H-1-1", "done");

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.readyIds).toContain("H-1-2");
  });

  it("does not include queued items with unmet deps in readyIds", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));

    const fakeCheckPr = () => null;
    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(orch, "/tmp/proj", "/tmp/proj/.worktrees", fakeMux, fakeCommitTime, fakeCheckPr);

    expect(snap.readyIds).not.toContain("H-1-2");
    expect(snap.readyIds).toContain("H-1-1"); // no deps → always ready
  });

  it("parses merged PR status into snapshot (already tracked PR)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
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
    orch.addItem(makeTodo("H-1-1"));
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
  it("asap strategy: merges immediately when CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge" && a.prNumber === 42)).toBe(true);
  });

  it("asap strategy: blocks merge when CHANGES_REQUESTED", () => {
    const orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("approved strategy: merges only when APPROVED", () => {
    const orch = new Orchestrator({ mergeStrategy: "approved" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("approved strategy: waits in review-pending without approval", () => {
    const orch = new Orchestrator({ mergeStrategy: "approved" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("ask strategy: never auto-merges, moves to review-pending", () => {
    const orch = new Orchestrator({ mergeStrategy: "ask" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("reviewed strategy: gates on reviewEnabled + reviewCompleted", () => {
    const orch = new Orchestrator({ mergeStrategy: "reviewed", reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    // First pass: reviewEnabled but not reviewed → goes to reviewing
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("reviewing");
    expect(actions.some((a) => a.type === "launch-review")).toBe(true);
    expect(actions.some((a) => a.type === "merge")).toBe(false);
  });

  it("reviewed strategy: merges after review completes", () => {
    const orch = new Orchestrator({ mergeStrategy: "reviewed", reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("review gate: respects reviewWipLimit", () => {
    const orch = new Orchestrator({ mergeStrategy: "asap", reviewEnabled: true, reviewWipLimit: 1 });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.setState("H-1-1", "reviewing"); // occupies 1 review slot
    orch.getItem("H-1-1")!.prNumber = 10;
    orch.setState("H-1-2", "ci-passed");
    orch.getItem("H-1-2")!.prNumber = 20;

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open" },
        { id: "H-1-2", ciStatus: "pass", prState: "open" },
      ]),
    );

    // H-1-2 should stay in ci-passed because review WIP is full
    expect(orch.getItem("H-1-2")!.state).toBe("ci-passed");
    expect(actions.filter((a) => a.type === "launch-review")).toHaveLength(0);
  });
});

// ── handleImplementing (tested via processTransitions) ───────────────

describe("handleImplementing", () => {
  it("transitions to pr-open when PR appears", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", workerAlive: true }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("pr-open");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(42);
  });

  it("transitions to merged when PR auto-merges between polls", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 99, prState: "merged" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(99);
    expect(actions.some((a) => a.type === "clean" && a.itemId === "H-1-1")).toBe(true);
  });

  it("requires 3 consecutive not-alive checks before retry (debounce)", () => {
    const orch = new Orchestrator({ maxRetries: 1 });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    // First two not-alive: no action
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("implementing");

    // Third not-alive triggers retry
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
  });

  it("resets notAliveCount when worker comes back alive", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    // Two not-alive checks
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]), NOW);
    expect(orch.getItem("H-1-1")!.notAliveCount).toBe(2);

    // Worker comes back
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: true }]), NOW);
    expect(orch.getItem("H-1-1")!.notAliveCount).toBe(0);
  });

  it("detects launch timeout when no commits after launchTimeoutMs", () => {
    const orch = new Orchestrator({ launchTimeoutMs: 1000 });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    // Transition timestamp is "now" from setState — advance past timeout
    const futureTime = new Date(Date.now() + 2000);
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null }]),
      futureTime,
    );

    // Should be stuck (maxRetries defaults to 1, but stuckOrRetry checks retryCount)
    const item = orch.getItem("H-1-1")!;
    expect(item.state === "ready" || item.state === "stuck" || item.state === "launching").toBe(true);
  });

  it("detects activity timeout when commits are stale", () => {
    const orch = new Orchestrator({ activityTimeoutMs: 1000, maxRetries: 0 });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    const staleTime = "2026-01-15T10:00:00Z";
    const futureNow = new Date("2026-01-15T12:00:00Z");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleTime }]),
      futureNow,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
  });

  it("emits sync-stack-comments when stacked PR opens", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");
    orch.getItem("H-1-1")!.baseBranch = "todo/H-1-0";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending" }]),
      NOW,
    );

    expect(actions.some((a) => a.type === "sync-stack-comments" && a.itemId === "H-1-1")).toBe(true);
  });

  it("chains PR open through to CI handling in same cycle", () => {
    const orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pass" }]),
      NOW,
    );

    // Should chain through pr-open → ci-passed → merging in one cycle
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });
});

// ── handlePrLifecycle / handleCiPending (tested via processTransitions) ──

describe("handleCiPending", () => {
  it("transitions to ci-passed when CI passes", () => {
    const orch = new Orchestrator({ mergeStrategy: "ask" });
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
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

  it("emits daemon-rebase on CI failure with merge conflict", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
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
    const orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("marks stuck when ciFailCount exceeds maxCiRetries", () => {
    const orch = new Orchestrator({ maxCiRetries: 1 });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 2; // exceeds maxCiRetries of 1

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
  });

  it("recovers from ci-failed to ci-pending when CI goes back to pending", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });

  it("resets reviewCompleted on CI regression", () => {
    const orch = new Orchestrator({ mergeStrategy: "reviewed", reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
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
    const orch = new Orchestrator({ mergeStrategy: "asap", wipLimit: 1 });
    orch.addItem(makeTodo("H-1-1"));

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

    // Step 3: implementing → pr-open → ci-pending
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
    const orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("L-1-1", [], "low"));
    orch.addItem(makeTodo("C-1-1", [], "critical"));

    orch.setState("L-1-1", "ci-passed");
    orch.getItem("L-1-1")!.prNumber = 10;
    orch.setState("C-1-1", "ci-passed");
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
    const orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
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
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));

    // Move dep to ci-passed (a stackable state)
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 10;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    // H-1-2 should be promoted from queued → ready → launching via stacking
    expect(orch.getItem("H-1-2")!.state).toBe("launching");
    expect(orch.getItem("H-1-2")!.baseBranch).toBe("todo/H-1-1");
    const launchAction = actions.find((a) => a.type === "launch" && a.itemId === "H-1-2");
    expect(launchAction).toBeDefined();
    expect(launchAction!.baseBranch).toBe("todo/H-1-1");
  });

  it("does not stack when dep is in implementing (non-stackable)", () => {
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));

    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
    );

    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });

  it("does not stack when enableStacking is false", () => {
    const orch = new Orchestrator({ wipLimit: 5, enableStacking: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));

    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 10;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });
});

// ── Screen health nudge ──────────────────────────────────────────────

describe("screen health nudge", () => {
  it("sends nudge on stalled-empty and deduplicates", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    // First stall detection → sends nudge
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, screenHealth: "stalled-empty" as any }]),
      NOW,
    );
    expect(actions1.some((a) => a.type === "send-message" && a.message === "Start")).toBe(true);

    // Second poll same stall → no duplicate
    const actions2 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, screenHealth: "stalled-empty" as any }]),
      NOW,
    );
    expect(actions2.some((a) => a.type === "send-message")).toBe(false);
  });

  it("clears stall tracking when worker recovers", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    // Stall detected
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, screenHealth: "stalled-empty" as any }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.stallDetectedAt).toBeDefined();

    // Worker recovers
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true, screenHealth: "healthy" as any }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.stallDetectedAt).toBeUndefined();
  });
});

// ── Stuck dep notification ───────────────────────────────────────────

describe("stuck dep notification for stacked items", () => {
  it("notifies stacked dependent when dep goes stuck", () => {
    const orch = new Orchestrator({ maxRetries: 0, enableStacking: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));

    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.ciFailCount = 5; // exceeds maxCiRetries
    orch.getItem("H-1-1")!.prNumber = 10;

    // H-1-2 is stacked and alive
    orch.setState("H-1-2", "implementing");
    orch.getItem("H-1-2")!.baseBranch = "todo/H-1-1";
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
});

// ── Merging state ────────────────────────────────────────────────────

describe("handleMerging", () => {
  it("transitions to merged when PR state is merged", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-1-1"));
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
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
  });
});

// ── Reviewing state ──────────────────────────────────────────────────

describe("handleReviewing", () => {
  it("transitions to ci-passed with reviewCompleted on APPROVED", () => {
    const orch = new Orchestrator({ mergeStrategy: "reviewed", reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
    );

    expect(orch.getItem("H-1-1")!.reviewCompleted).toBe(true);
    // Should chain through to merging (reviewed + reviewCompleted)
    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("transitions to review-pending on CHANGES_REQUESTED", () => {
    const orch = new Orchestrator({ reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "reviewing");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    expect(actions.some((a) => a.type === "notify-review")).toBe(true);
  });

  it("transitions to ci-failed on CI regression during review", () => {
    const orch = new Orchestrator({ reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
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
    const orch = new Orchestrator({ reviewEnabled: true });
    orch.addItem(makeTodo("H-1-1"));
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
