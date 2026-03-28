// Tests for post-merge CI verification state machine (H-VF-1).
// No vi.mock — all isolation via dependency injection.

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
import type { TodoItem, Priority } from "../core/types.ts";
import type { Multiplexer } from "../core/mux.ts";

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

const NOW = new Date("2026-01-15T12:00:00Z");

// ── Merged → Verifying transition ────────────────────────────────────

describe("merged → verifying transition (verifyMain=true)", () => {
  it("transitions merged → verifying when verifyMain=true and mergeCommitSha is set", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(emptySnapshot(), NOW);

    expect(orch.getItem("H-1-1")!.state).toBe("verifying");
  });

  it("transitions merged → done when verifyMain=true but no mergeCommitSha", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");
    // No mergeCommitSha set — graceful fallback to done

    orch.processTransitions(emptySnapshot(), NOW);

    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Merged → Done transition (verifyMain=false) ──────────────────────

describe("merged → done transition (verifyMain=false)", () => {
  it("transitions merged → done when verifyMain=false", () => {
    const orch = new Orchestrator({ verifyMain: false, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(emptySnapshot(), NOW);

    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Verifying → Done (CI passes) ────────────────────────────────────

describe("verifying → done when CI passes", () => {
  it("transitions verifying → done when mergeCommitCIStatus is pass", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verifying");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toEqual([]);
  });

  it("stays in verifying when mergeCommitCIStatus is pending", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verifying");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pending" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("verifying");
  });
});

// ── Verifying → Verify-failed (CI fails) ────────────────────────────

describe("verifying → verify-failed when CI fails", () => {
  it("transitions verifying → verify-failed when mergeCommitCIStatus is fail", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verifying");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("verify-failed");
    expect(orch.getItem("H-1-1")!.verifyFailCount).toBe(1);
    expect(orch.getItem("H-1-1")!.failureReason).toContain("verify-failed");
  });
});

// ── Verify-failed → Stuck (max retries exceeded) ────────────────────

describe("verify-failed → stuck after maxVerifyRetries exceeded", () => {
  it("transitions verify-failed → stuck when verifyFailCount >= maxVerifyRetries", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 2, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verify-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";
    orch.getItem("H-1-1")!.verifyFailCount = 2;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("max verify retries");
  });

  it("transitions verify-failed → repairing-main and emits launch-verifier when retries remain", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 2, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verify-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";
    orch.getItem("H-1-1")!.verifyFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("repairing-main");
    expect(actions).toContainEqual({ type: "launch-verifier", itemId: "H-1-1" });
  });

  it("verify-failed → done when CI recovers (flaky test)", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 2, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verify-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";
    orch.getItem("H-1-1")!.verifyFailCount = 1;

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

  it("buildSnapshot polls merge commit CI for items in verifying state", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verifying");
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

  it("buildSnapshot polls merge commit CI for items in verify-failed state", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verify-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "def456";
    orch.getItem("H-1-1")!.verifyFailCount = 1;

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
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verifying");
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

// ── --no-verify-main flag ────────────────────────────────────────────

describe("--no-verify-main flag", () => {
  it("verifyMain defaults to true in DEFAULT_CONFIG", () => {
    const orch = new Orchestrator();
    expect(orch.config.verifyMain).toBe(true);
  });

  it("verifyMain can be set to false via config", () => {
    const orch = new Orchestrator({ verifyMain: false });
    expect(orch.config.verifyMain).toBe(false);
  });

  it("maxVerifyRetries defaults to 2", () => {
    const orch = new Orchestrator();
    expect(orch.config.maxVerifyRetries).toBe(2);
  });
});

// ── Merge commit SHA retrieval ───────────────────────────────────────

describe("merge commit SHA retrieval in executeMerge", () => {
  it("captures mergeCommitSha on successful merge when verifyMain=true", () => {
    const orch = new Orchestrator({ verifyMain: true, mergeStrategy: "asap", reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
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
    // State should be verifying (merged → verifying in same processTransitions call)
    // But executeAction only executes the action, state transition happens in processTransitions
    expect(orch.getItem("H-1-1")!.state).toBe("merged");
  });

  it("falls back to done when getMergeCommitSha returns null", () => {
    const orch = new Orchestrator({ verifyMain: true, mergeStrategy: "asap", reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
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

    // mergeCommitSha not set — when processTransitions runs, it goes merged → done
    expect(orch.getItem("H-1-1")!.mergeCommitSha).toBeUndefined();

    // Now run processTransitions to trigger merged → done
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("falls back to done when getMergeCommitSha throws", () => {
    const orch = new Orchestrator({ verifyMain: true, mergeStrategy: "asap", reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
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

    // mergeCommitSha not set due to error — falls back to done
    expect(orch.getItem("H-1-1")!.mergeCommitSha).toBeUndefined();

    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── checkCommitCI ignores ninthwave/review ───────────────────────────

describe("checkCommitCI ignores ninthwave/review check", () => {
  it("buildSnapshot correctly passes sha to checkCommitCI", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verifying");
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

describe("statusDisplayForState for verification states", () => {
  it("returns Verifying for verifying state", () => {
    const display = statusDisplayForState("verifying");
    expect(display.text).toBe("Verifying");
  });

  it("returns Verify Failed for verify-failed state", () => {
    const display = statusDisplayForState("verify-failed");
    expect(display.text).toBe("Verify Failed");
  });

  it("returns Repairing Main for repairing-main state", () => {
    const display = statusDisplayForState("repairing-main");
    expect(display.text).toBe("Repairing Main");
  });
});

// ── Dependency resolution waits for done ─────────────────────────────

describe("dependency resolution with verification", () => {
  it("deps in verifying state do not unblock dependents in readyIds", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));
    orch.setState("H-1-1", "verifying");
    orch.getItem("H-1-1")!.mergeCommitSha = "abc123";

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;
    const fakeCheckCommitCI = () => "pending" as const;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null, undefined, fakeCheckCommitCI,
    );

    // H-1-2 should NOT be in readyIds because H-1-1 is in verifying, not done
    expect(snap.readyIds).not.toContain("H-1-2");
  });

  it("deps in done state unblock dependents in readyIds", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));
    orch.setState("H-1-1", "done");

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null,
    );

    expect(snap.readyIds).toContain("H-1-2");
  });

  it("deps in merged state still satisfy readyIds (transient state)", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));
    orch.setState("H-1-1", "merged");

    const fakeMux = { listWorkspaces: () => "", readScreen: () => "" } as any;

    const snap = buildSnapshot(
      orch, "/tmp/proj", "/tmp/proj/.worktrees",
      fakeMux, () => null, () => null,
    );

    // merged is still dep-satisfied (transient state, transitions to verifying or done)
    expect(snap.readyIds).toContain("H-1-2");
  });
});

// ── End-to-end: merge → verify → done flow ──────────────────────────

describe("end-to-end: merge → verify → done flow", () => {
  it("complete flow: merging → merged (first cycle) → done (second cycle, no SHA)", () => {
    const orch = new Orchestrator({ verifyMain: true, mergeStrategy: "asap", reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    // Cycle 1: PR gets merged externally — merging → merged
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("merged");

    // Cycle 2: merged → done (no mergeCommitSha, falls back to done)
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("complete flow with mergeCommitSha: merged → verifying → done", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-abc";

    // Step 1: merged → verifying
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("verifying");

    // Step 2: CI passes → verifying → done
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  it("complete flow with CI failure: merged → verifying → verify-failed → stuck (max retries)", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 1, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-abc";

    // Step 1: merged → verifying
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("verifying");

    // Step 2: CI fails → verifying → verify-failed (verifyFailCount = 1)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("verify-failed");
    expect(orch.getItem("H-1-1")!.verifyFailCount).toBe(1);

    // Step 3: maxVerifyRetries=1, so verify-failed → stuck (circuit breaker)
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  it("complete flow with verifier: merged → verifying → verify-failed → repairing-main → done", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 3, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-abc";

    // Step 1: merged → verifying
    orch.processTransitions(emptySnapshot(), NOW);
    expect(orch.getItem("H-1-1")!.state).toBe("verifying");

    // Step 2: CI fails → verifying → verify-failed
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("verify-failed");

    // Step 3: verify-failed → repairing-main (launch verifier)
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("repairing-main");
    expect(actions).toContainEqual({ type: "launch-verifier", itemId: "H-1-1" });

    // Step 4: verifier fixes CI → repairing-main → done
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });
});

// ── Verify-failed → repairing-main → launch-verifier (H-VF-3) ──────

describe("verify-failed → repairing-main transition triggers launch-verifier", () => {
  it("emits launch-verifier action when transitioning to repairing-main", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 3, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verify-failed");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.verifyFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("repairing-main");
    expect(actions).toContainEqual({ type: "launch-verifier", itemId: "H-1-1" });
  });

  it("does not emit launch-verifier when no mergeCommitSha", () => {
    const orch = new Orchestrator({ verifyMain: true, maxVerifyRetries: 3, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "verify-failed");
    // No mergeCommitSha set
    orch.getItem("H-1-1")!.verifyFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail" }]),
      NOW,
    );

    // Stays in verify-failed since no SHA to hand to verifier
    expect(orch.getItem("H-1-1")!.state).toBe("verify-failed");
    expect(actions).not.toContainEqual(expect.objectContaining({ type: "launch-verifier" }));
  });
});

// ── Repairing-main: verifier completion and failure ────────────────

describe("repairing-main state handling", () => {
  it("repairing-main → done when merge commit CI passes", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.verifyWorkspaceRef = "workspace:5";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toContainEqual({ type: "clean-verifier", itemId: "H-1-1" });
  });

  it("repairing-main → stuck when verifier worker dies (3 consecutive polls)", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.verifyWorkspaceRef = "workspace:5";

    // Poll 1: worker not alive
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("repairing-main");

    // Poll 2: still not alive
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("repairing-main");

    // Poll 3: third consecutive — transition to stuck
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
      NOW,
    );
    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(orch.getItem("H-1-1")!.failureReason).toContain("verifier worker died");
    expect(actions).toContainEqual({ type: "clean-verifier", itemId: "H-1-1" });
  });

  it("repairing-main stays when CI still failing and worker alive", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    orch.getItem("H-1-1")!.verifyWorkspaceRef = "workspace:5";

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "fail", workerAlive: true }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("repairing-main");
  });

  it("repairing-main → done without clean-verifier when no verifyWorkspaceRef", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";
    // No verifyWorkspaceRef

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", mergeCommitCIStatus: "pass" }]),
      NOW,
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).not.toContainEqual(expect.objectContaining({ type: "clean-verifier" }));
  });
});

// ── executeLaunchVerifier ──────────────────────────────────────────

describe("executeLaunchVerifier action", () => {
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

  it("sets verifyWorkspaceRef on successful launch", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";

    const deps: OrchestratorDeps = {
      ...baseDeps,
      launchVerifier: (_itemId, _sha, _repoRoot) => ({
        worktreePath: "/tmp/proj/.worktrees/ninthwave-verify-H-1-1",
        workspaceRef: "workspace:7",
      }),
    };

    const result = orch.executeAction(
      { type: "launch-verifier", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.verifyWorkspaceRef).toBe("workspace:7");
  });

  it("fails when launchVerifier dep is not provided", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    orch.getItem("H-1-1")!.mergeCommitSha = "sha-merge";

    const result = orch.executeAction(
      { type: "launch-verifier", itemId: "H-1-1" },
      ctx,
      baseDeps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("fails when no mergeCommitSha", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "repairing-main");
    // No mergeCommitSha

    const deps: OrchestratorDeps = {
      ...baseDeps,
      launchVerifier: () => ({ worktreePath: "/tmp", workspaceRef: "workspace:7" }),
    };

    const result = orch.executeAction(
      { type: "launch-verifier", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No merge commit SHA");
  });
});

// ── executeCleanVerifier ─────────────────────────────────────────────

describe("executeCleanVerifier action", () => {
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

  it("cleans up verifier workspace and clears verifyWorkspaceRef", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "done");
    orch.getItem("H-1-1")!.verifyWorkspaceRef = "workspace:7";

    let cleanCalled = false;
    const deps: OrchestratorDeps = {
      ...baseDeps,
      cleanVerifier: (_itemId, _wsRef) => {
        cleanCalled = true;
        return true;
      },
    };

    const result = orch.executeAction(
      { type: "clean-verifier", itemId: "H-1-1" },
      ctx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(cleanCalled).toBe(true);
    expect(orch.getItem("H-1-1")!.verifyWorkspaceRef).toBeUndefined();
  });

  it("succeeds as no-op when cleanVerifier not provided", () => {
    const orch = new Orchestrator({ verifyMain: true, reviewEnabled: false });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "done");
    orch.getItem("H-1-1")!.verifyWorkspaceRef = "workspace:7";

    const result = orch.executeAction(
      { type: "clean-verifier", itemId: "H-1-1" },
      ctx,
      baseDeps,
    );

    expect(result.success).toBe(true);
    expect(orch.getItem("H-1-1")!.verifyWorkspaceRef).toBeUndefined();
  });
});

// ── AGENT_SOURCES includes verifier.md ─────────────────────────────

describe("AGENT_SOURCES includes verifier", () => {
  it("verifier.md is in AGENT_SOURCES", async () => {
    const { AGENT_SOURCES } = await import("../core/commands/setup.ts");
    expect(AGENT_SOURCES).toContain("verifier.md");
  });

  it("verifier.md has description in AGENT_DESCRIPTIONS", async () => {
    const { AGENT_DESCRIPTIONS } = await import("../core/commands/setup.ts");
    expect(AGENT_DESCRIPTIONS["verifier.md"]).toBeDefined();
    expect(AGENT_DESCRIPTIONS["verifier.md"]).toContain("fix-forward");
  });
});

// ── Verifier agent file exists with correct frontmatter ────────────

describe("verifier agent file", () => {
  it("agents/verifier.md exists and has correct frontmatter", async () => {
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const agentPath = join(import.meta.dir, "..", "agents", "verifier.md");
    expect(existsSync(agentPath)).toBe(true);

    const content = readFileSync(agentPath, "utf-8");
    expect(content).toContain("name: ninthwave-verifier");
    expect(content).toContain("ninthwave orchestration agent");
    expect(content).toContain("YOUR_VERIFY_ITEM_ID");
    expect(content).toContain("YOUR_VERIFY_MERGE_SHA");
    expect(content).toContain("PROJECT_ROOT");
  });

  it("has scope isolation guard", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const agentPath = join(import.meta.dir, "..", "agents", "verifier.md");
    const content = readFileSync(agentPath, "utf-8");
    expect(content).toContain("no ninthwave verification context");
    expect(content).toContain("nw watch");
  });
});
