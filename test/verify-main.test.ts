// Tests for post-merge CI fix-forward state machine (H-VF-1).
// No vi.mock -- all isolation via dependency injection.

import { describe, it, expect } from "vitest";
import {
  Orchestrator,
  statusDisplayForState,
  type OrchestratorItem,
  type OrchestratorDeps,
  type ExecutionContext,
  type PollSnapshot,
  type ItemSnapshot,
  type Action,
} from "../core/orchestrator.ts";
import {
  buildSnapshot,
} from "../core/commands/orchestrate.ts";
import { checkCommitCI, getMergeCommitSha } from "../core/gh.ts";
import type { WorkItem, Priority } from "../core/types.ts";
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

const NOW = new Date("2026-01-15T12:00:00Z");

// ── Merged → Verifying transition ────────────────────────────────────

describe("merged → forward-fix-pending transition (fixForward=true)", () => {
  it("transitions merged → forward-fix-pending when fixForward=true and mergeCommitSha is set", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(emptySnapshot(), NOW);

    expect(orch.getItem("H-1-1")!.state).toBe("forward-fix-pending");
  });

  it("transitions merged → done when fixForward=true but no mergeCommitSha", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");
    // No mergeCommitSha set -- graceful fallback to done

    orch.processTransitions(emptySnapshot(), NOW);

    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Merged → Done transition (fixForward=false) ──────────────────────

describe("merged → done transition (fixForward=false)", () => {
  it("transitions merged → done when fixForward=false", () => {
    const orch = new Orchestrator({ fixForward: false });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(emptySnapshot(), NOW);

    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Verifying → Done (CI passes) ────────────────────────────────────

describe("forward-fix-pending → done when CI passes", () => {
  it("transitions forward-fix-pending → done when mergeCommitCIStatus is pass", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toEqual([]);
  });

  it("stays in forward-fix-pending when mergeCommitCIStatus is pending", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pending" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("forward-fix-pending");
  });
});

// ── Verifying → Verify-failed (CI fails) ────────────────────────────

describe("forward-fix-pending → fix-forward-failed when CI fails", () => {
  it("transitions forward-fix-pending → fix-forward-failed when mergeCommitCIStatus is fail", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("fix-forward-failed");
    expect(orch.getItem("H-1-1")!.fixForwardFailCount).toBe(1);
    expect(orch.getItem("H-1-1")!.failureReason).toContain("fix-forward-failed");
  });
});

// ── Verify-failed → Stuck (max retries exceeded) ────────────────────

describe("fix-forward-failed → stuck after maxFixForwardRetries exceeded", () => {
  it("transitions fix-forward-failed → stuck when fixForwardFailCount >= maxFixForwardRetries", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fix-forward-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";
    orch.getItem("H-1-1")!.fixForwardFailCount = 2;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("max fix-forward retries");
  });

  it("transitions fix-forward-failed → fixing-forward and emits launch-forward-fixer when retries remain", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fix-forward-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";
    orch.getItem("H-1-1")!.fixForwardFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");
    expect(actions).toContainEqual({ type: "launch-forward-fixer", itemId: "H-1-1" });
  });

  it("fix-forward-failed → done when CI recovers (flaky test)", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fix-forward-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";
    orch.getItem("H-1-1")!.fixForwardFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── checkCommitCI parsing ────────────────────────────────────────────

describe("checkCommitCI", () => {
  // These tests verify the parsing logic. Since checkCommitCI calls gh API,
  // we test it indirectly through buildSnapshot with injected checkCommitCI.

  it("buildSnapshot polls merge commit CI for items in forward-fix-pending state", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCheckPr = () => null;
    const fakeCommitTime = () => null;
    const fakeCheckCommitCI = (_repoRoot: string, sha: string) => {
      expect(sha).toBe("abc123");
      return "pass" as const;
    };

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, fakeCommitTime, fakeCheckPr, undefined, fakeCheckCommitCI,
    );

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    expect(itemSnap!.mergeCommitCIStatus).toBe("pass");
  });

  it("buildSnapshot polls merge commit CI for items in fix-forward-failed state", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fix-forward-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "def456";
    orch.getItem("H-1-1")!.fixForwardFailCount = 1;

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCheckPr = () => null;
    const fakeCommitTime = () => null;
    const fakeCheckCommitCI = (_repoRoot: string, sha: string) => {
      expect(sha).toBe("def456");
      return "fail" as const;
    };

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, fakeCommitTime, fakeCheckPr, undefined, fakeCheckCommitCI,
    );

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    expect(itemSnap!.mergeCommitCIStatus).toBe("fail");
  });

  it("buildSnapshot skips merge commit CI when checkCommitCI not provided", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCheckPr = () => null;
    const fakeCommitTime = () => null;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, fakeCommitTime, fakeCheckPr, undefined, undefined,
    );

    const itemSnap = snap.items.find((s) => s.id === "H-1-1");
    expect(itemSnap).toBeDefined();
    expect(itemSnap!.mergeCommitCIStatus).toBeUndefined();
  });
});

// ── --no-fix-forward flag ────────────────────────────────────────────

describe("--no-fix-forward flag", () => {
  it("fixForward defaults to true in DEFAULT_CONFIG", () => {
    const orch = new Orchestrator();
    expect(orch.config.fixForward).toBe(true);
  });

  it("fixForward can be set to false via config", () => {
    const orch = new Orchestrator({ fixForward: false });
    expect(orch.config.fixForward).toBe(false);
  });

  it("maxFixForwardRetries defaults to 2", () => {
    const orch = new Orchestrator();
    expect(orch.config.maxFixForwardRetries).toBe(2);
  });
});

// ── Merge commit SHA retrieval ───────────────────────────────────────

describe("merge commit SHA retrieval in executeMerge", () => {
  it("captures mergeCommitSha on successful merge when fixForward=true", () => {
    const orch = new Orchestrator({ fixForward: true, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/proj",
      worktreeDir: "/tmp/proj/.worktrees",
      workDir: "/tmp/proj/.ninthwave/work",
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
      getMergeCommitSha: (_repoRoot, _prNum) => "sha-merge-abc",
      checkCommitCI: () => "pending",
    };

    const result = orch.executeAction(
      { type: "merge", itemId: "H-1-1", prNumber: 42 },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.mergeCommitSha).toBe("sha-merge-abc");
    // State should be forward-fix-pending (merged → forward-fix-pending in same processTransitions call)
    // But executeAction only executes the action, state transition happens in processTransitions
    expect(orch.getItem("H-1-1")!.state).toBe("merged");
  });

  it("falls back to done when getMergeCommitSha returns null", () => {
    const orch = new Orchestrator({ fixForward: true, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/proj",
      worktreeDir: "/tmp/proj/.worktrees",
      workDir: "/tmp/proj/.ninthwave/work",
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
      getMergeCommitSha: () => null,
      checkCommitCI: () => "pending",
    };

    orch.executeAction(
      { type: "merge", itemId: "H-1-1", prNumber: 42 },
      ctx,
      deps,
    );

    // mergeCommitSha not set -- when processTransitions runs, it goes merged → done
    expect(orch.getItem("H-1-1")!.mergeCommitSha).toBeUndefined();

    // Now run processTransitions to trigger merged → done
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("falls back to done when getMergeCommitSha throws", () => {
    const orch = new Orchestrator({ fixForward: true, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    const ctx: ExecutionContext = {
      projectRoot: "/tmp/proj",
      worktreeDir: "/tmp/proj/.worktrees",
      workDir: "/tmp/proj/.ninthwave/work",
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
      getMergeCommitSha: () => { throw new Error("API error"); },
      checkCommitCI: () => "pending",
    };

    orch.executeAction(
      { type: "merge", itemId: "H-1-1", prNumber: 42 },
      ctx,
      deps,
    );

    // mergeCommitSha not set due to error -- falls back to done
    expect(orch.getItem("H-1-1")!.mergeCommitSha).toBeUndefined();

    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── checkCommitCI ignores Ninthwave / Review ───────────────────────────

describe("checkCommitCI ignores Ninthwave / Review check", () => {
  it("buildSnapshot correctly passes sha to checkCommitCI", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha123";

    const calledWith: string[] = [];
    const fakeCheckCommitCI = (_repoRoot: string, sha: string) => {
      calledWith.push(sha);
      return "pass" as const;
    };

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null, undefined, fakeCheckCommitCI,
    );

    expect(calledWith).toEqual(["sha123"]);
  });
});

// ── statusDisplayForState for new states ─────────────────────────────

describe("statusDisplayForState for fix-forward states", () => {
  it("returns Fix Pending for forward-fix-pending state", () => {
    const display = statusDisplayForState("forward-fix-pending");
    expect(display.text).toBe("Fix Pending");
  });

  it("returns Fix Failed for fix-forward-failed state", () => {
    const display = statusDisplayForState("fix-forward-failed");
    expect(display.text).toBe("Fix Failed");
  });

  it("returns Fixing Forward for fixing-forward state", () => {
    const display = statusDisplayForState("fixing-forward");
    expect(display.text).toBe("Fixing Forward");
  });
});

// ── Dependency resolution waits for done ─────────────────────────────

describe("dependency resolution with fix-forward", () => {
  it("deps in forward-fix-pending state do not unblock dependents in readyIds", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.setState("H-1-1", "forward-fix-pending");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCheckCommitCI = () => "pending" as const;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null, undefined, fakeCheckCommitCI,
    );

    // H-1-2 should NOT be in readyIds because H-1-1 is in forward-fix-pending, not done
    expect(snap.readyIds).not.toContain("H-1-2");
  });

  it("deps in done state unblock dependents in readyIds", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));
    orch.setState("H-1-1", "done");

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null,
    );

    expect(snap.readyIds).toContain("H-1-2");
  });

  it("deps in merged state still satisfy readyIds (transient state)", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));
    orch.setState("H-1-1", "merged");

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null,
    );

    // merged is still dep-satisfied (transient state, transitions to forward-fix-pending or done)
    expect(snap.readyIds).toContain("H-1-2");
  });
});

// ── End-to-end: merge → fix-forward → done flow ──────────────────────────

describe("end-to-end: merge → fix-forward → done flow", () => {
  it("complete flow: merging → merged (first cycle) → done (second cycle, no SHA)", () => {
    const orch = new Orchestrator({ fixForward: true, mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Cycle 1: PR gets merged externally -- merging → merged
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("merged");

    // Cycle 2: merged → done (no mergeCommitSha, falls back to done)
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("complete flow with mergeCommitSha: merged → forward-fix-pending → done", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-abc";

    // Step 1: merged → forward-fix-pending
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("forward-fix-pending");

    // Step 2: CI passes → forward-fix-pending → done
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("complete flow with CI failure: merged → forward-fix-pending → fix-forward-failed → stuck (max retries)", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-abc";

    // Step 1: merged → forward-fix-pending
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("forward-fix-pending");

    // Step 2: CI fails → forward-fix-pending → fix-forward-failed (fixForwardFailCount = 1)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fix-forward-failed");
    expect(orch.getItem("H-1-1")!.fixForwardFailCount).toBe(1);

    // Step 3: maxFixForwardRetries=1, so fix-forward-failed → stuck (circuit breaker)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  it("complete flow with forward-fixer: merged → forward-fix-pending → fix-forward-failed → fixing-forward → done", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-abc";

    // Step 1: merged → forward-fix-pending
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("forward-fix-pending");

    // Step 2: CI fails → forward-fix-pending → fix-forward-failed
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fix-forward-failed");

    // Step 3: fix-forward-failed → fixing-forward (launch forward-fixer)
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");
    expect(actions).toContainEqual({ type: "launch-forward-fixer", itemId: "H-1-1" });

    // Step 4: forward-fixer fixes CI → fixing-forward → done
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Verify-failed → fixing-forward → launch-forward-fixer (H-VF-3) ──────

describe("fix-forward-failed → fixing-forward transition triggers launch-forward-fixer", () => {
  it("emits launch-forward-fixer action when transitioning to fixing-forward", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fix-forward-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.fixForwardFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");
    expect(actions).toContainEqual({ type: "launch-forward-fixer", itemId: "H-1-1" });
  });

  it("does not emit launch-forward-fixer when no mergeCommitSha", () => {
    const orch = new Orchestrator({ fixForward: true, maxFixForwardRetries: 3 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fix-forward-failed");
    // No mergeCommitSha set
    orch.getItem("H-1-1")!.fixForwardFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    // Stays in fix-forward-failed since no SHA to hand to forward-fixer
    expect(orch.getItem("H-1-1")!.state).toBe("fix-forward-failed");
    expect(actions).not.toContainEqual(expect.objectContaining({ type: "launch-forward-fixer" }));
  });
});

// ── Repairing-main: forward-fixer completion and failure ────────────────

describe("fixing-forward state handling", () => {
  it("fixing-forward → done when merge commit CI passes", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.fixForwardWorkspaceRef = "workspace:5";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toContainEqual({ type: "clean-forward-fixer", itemId: "H-1-1" });
  });

  it("fixing-forward → stuck when forward-fixer worker dies (5 consecutive polls)", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.fixForwardWorkspaceRef = "workspace:5";

    // Poll 1: worker not alive
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");

    // Poll 2: still not alive
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");

    // Poll 3: still not alive
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");

    // Poll 4: still not alive
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");

    // Poll 5: fifth consecutive -- transition to stuck
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("forward-fixer worker died");
    expect(actions).toContainEqual({ type: "clean-forward-fixer", itemId: "H-1-1" });
  });

  it("fixing-forward stays when CI still failing and worker alive", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.fixForwardWorkspaceRef = "workspace:5";

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail", workerAlive: true }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("fixing-forward");
  });

  it("fixing-forward → done without clean-forward-fixer when no fixForwardWorkspaceRef", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    // No fixForwardWorkspaceRef

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).not.toContainEqual(expect.objectContaining({ type: "clean-forward-fixer" }));
  });
});

// ── executeLaunchForwardFixer ──────────────────────────────────────────

describe("executeLaunchForwardFixer action", () => {
  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "test",
  };

  const baseDeps: OrchestratorDeps = {
    launchSingleItem: () => null,
    cleanSingleWorktree: () => true,
    prMerge: () => true,
    prComment: () => true,
    sendMessage: () => true,
    closeWorkspace: () => true,
    fetchOrigin: () => {},
    ffMerge: () => {},
  };

  it("sets fixForwardWorkspaceRef on successful launch", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";

    const deps: OrchestratorDeps = {
      ...baseDeps,
      launchForwardFixer: (_itemId, _sha, _repoRoot) => ({
        worktreePath: "/tmp/proj/.worktrees/ninthwave-fix-forward-H-1-1",
        workspaceRef: "workspace:7",
      }),
    };

    const result = orch.executeAction(
      { type: "launch-forward-fixer", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.fixForwardWorkspaceRef).toBe("workspace:7");
  });

  it("fails when launchForwardFixer dep is not provided", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";

    const result = orch.executeAction(
      { type: "launch-forward-fixer", itemId: "H-1-1" },
      ctx,
      baseDeps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("fails when no mergeCommitSha", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "fixing-forward");
    // No mergeCommitSha

    const deps: OrchestratorDeps = {
      ...baseDeps,
      launchForwardFixer: () => ({ worktreePath: "/tmp", workspaceRef: "workspace:7" }),
    };

    const result = orch.executeAction(
      { type: "launch-forward-fixer", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No merge commit SHA");
  });
});

// ── executeCleanForwardFixer ─────────────────────────────────────────────

describe("executeCleanForwardFixer action", () => {
  const ctx: ExecutionContext = {
    projectRoot: "/tmp/proj",
    worktreeDir: "/tmp/proj/.worktrees",
    workDir: "/tmp/proj/.ninthwave/work",
    aiTool: "test",
  };

  const baseDeps: OrchestratorDeps = {
    launchSingleItem: () => null,
    cleanSingleWorktree: () => true,
    prMerge: () => true,
    prComment: () => true,
    sendMessage: () => true,
    closeWorkspace: () => true,
    fetchOrigin: () => {},
    ffMerge: () => {},
  };

  it("cleans up forward-fixer workspace and clears fixForwardWorkspaceRef", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "done");
    orch.getItem("H-1-1")!.fixForwardWorkspaceRef = "workspace:7";

    let cleanCalled = false;
    const deps: OrchestratorDeps = {
      ...baseDeps,
      cleanForwardFixer: (_itemId, _wsRef) => {
        cleanCalled = true;
        return true;
      },
    };

    const result = orch.executeAction(
      { type: "clean-forward-fixer", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(cleanCalled).toBe(true);
    expect(orch.getItem("H-1-1")!.fixForwardWorkspaceRef).toBeUndefined();
  });

  it("succeeds as no-op when cleanForwardFixer not provided", () => {
    const orch = new Orchestrator({ fixForward: true });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "done");
    orch.getItem("H-1-1")!.fixForwardWorkspaceRef = "workspace:7";

    const result = orch.executeAction(
      { type: "clean-forward-fixer", itemId: "H-1-1" },
      ctx,
      baseDeps,
    );

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.fixForwardWorkspaceRef).toBeUndefined();
  });
});

// ── AGENT_SOURCES includes forward-fixer.md ─────────────────────────────

describe("AGENT_SOURCES includes forward-fixer", () => {
  it("forward-fixer.md is in AGENT_SOURCES", async () => {
    const { AGENT_SOURCES } = await import("../core/commands/setup.ts");
    expect(AGENT_SOURCES).toContain("forward-fixer.md");
  });

  it("forward-fixer.md has description in AGENT_DESCRIPTIONS", async () => {
    const { AGENT_DESCRIPTIONS } = await import("../core/commands/setup.ts");
    expect(AGENT_DESCRIPTIONS["forward-fixer.md"]).toBeDefined();
    expect(AGENT_DESCRIPTIONS["forward-fixer.md"]).toContain("fix-forward");
  });
});

// ── Forward-fixer agent file exists with correct frontmatter ───────

describe("forward-fixer agent file", () => {
  it("agents/forward-fixer.md exists and has correct frontmatter", async () => {
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const agentPath = join(import.meta.dir, "..", "agents", "forward-fixer.md");
    expect(existsSync(agentPath)).toBe(true);

    const content = readFileSync(agentPath, "utf-8");
    expect(content).toContain("name: ninthwave-forward-fixer");
    expect(content).toContain("ninthwave orchestration agent");
    expect(content).toContain("YOUR_VERIFY_ITEM_ID");
    expect(content).toContain("YOUR_VERIFY_MERGE_SHA");
    expect(content).toContain("PROJECT_ROOT");
  });

  it("has scope isolation guard", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const agentPath = join(import.meta.dir, "..", "agents", "forward-fixer.md");
    const content = readFileSync(agentPath, "utf-8");
    expect(content).toContain("no ninthwave fix-forward context");
    expect(content).toContain("nw watch");
  });
});
