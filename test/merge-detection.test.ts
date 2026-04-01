/**
 * End-to-end test suite for the merge detection pipeline.
 *
 * Covers the full path: buildSnapshot → processTransitions → state transitions → actions
 * using the Orchestrator class with injected dependencies (no vi.mock).
 *
 * These tests address recurring friction in merge detection:
 * - Friction #20: handleImplementing not checking prState === "merged"
 * - Friction #22: CONFLICTING PRs in merge-retry loop
 * - Friction #23: CI-pending PRs with merge conflicts hanging
 * - Title collision check too aggressive
 * - Daemon missing merged PRs despite prior fixes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  Orchestrator,
  type ItemSnapshot,
  type PollSnapshot,
  type OrchestratorDeps,
  type ExecutionContext,
} from "../core/orchestrator.ts";
import {
  buildSnapshot,
  reconstructState,
} from "../core/commands/orchestrate.ts";
import type { Multiplexer } from "../core/mux.ts";
import type { WorkItem, Priority } from "../core/types.ts";
import type { DaemonState } from "../core/daemon.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeWorkItem(
  id: string,
  title = `Item ${id}`,
  deps: string[] = [],
  priority: Priority = "high",
): WorkItem {
  return {
    id,
    priority,
    title,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: `## ${id}\n${title}`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function snapshotWith(
  items: ItemSnapshot[],
  readyIds: string[] = [],
): PollSnapshot {
  return { items, readyIds };
}

/** Stub multiplexer -- all operations are no-ops. */
function stubMux(): Multiplexer {
  return {
    type: "cmux" as any,
    isAvailable: () => true,
    diagnoseUnavailable: () => "",
    launchWorkspace: () => null,
    splitPane: () => null,
    sendMessage: () => true,
    writeInbox: () => {},
    readScreen: () => "",
    listWorkspaces: () => "",
    closeWorkspace: () => true,
  };
}

/** Create a stub ExecutionContext for executeAction calls. */
function stubCtx(): ExecutionContext {
  return {
    projectRoot: PROJECT_ROOT,
    worktreeDir: join(PROJECT_ROOT, ".ninthwave", ".worktrees"),
    workDir: join(PROJECT_ROOT, ".ninthwave", "work"),
    aiTool: "claude",
  };
}

/** Create stub OrchestratorDeps with all required functions. */
function stubDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    launchSingleItem: () => ({ worktreePath: "/tmp/wt", workspaceRef: "ws:1" }),
    cleanSingleWorktree: () => true,
    prMerge: () => true,
    prComment: () => true,
    sendMessage: () => true,
    writeInbox: () => {},
    closeWorkspace: () => true,
    fetchOrigin: () => {},
    ffMerge: () => {},
    checkPrMergeable: () => true,
    ...overrides,
  };
}

const NOW = new Date("2026-03-27T10:00:00Z");
const PROJECT_ROOT = "/tmp/nw-merge-test";

// ── Test cases ───────────────────────────────────────────────────────

describe("Merge detection pipeline (end-to-end)", () => {
  // ── Test 1: Happy path -- PR auto-merges between polls ──────────
  describe("1. Happy path: PR auto-merges between polls", () => {
    it("worker creates PR → PR auto-merges → buildSnapshot returns merged → handleImplementing transitions to merged → clean action emitted", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-1", "Implement feature X"));
      orch.getItem("MRG-1")!.reviewCompleted = true;
      orch.hydrateState("MRG-1", "implementing");

      // Simulate: PR was created and auto-merged via `gh pr merge --squash --auto`
      // between polls, so buildSnapshot sees it as merged directly
      const checkPr = (_id: string, _root: string) =>
        "MRG-1\t42\tmerged\t\t\tfeat: implement feature X";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".ninthwave", ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      // Verify snapshot captures merged state
      const snap = snapshot.items.find((s) => s.id === "MRG-1");
      expect(snap).toBeDefined();
      expect(snap!.prState).toBe("merged");
      expect(snap!.prNumber).toBe(42);

      // Feed snapshot into processTransitions
      const actions = orch.processTransitions(snapshot, NOW);

      // Item transitions to merged (merged → done happens on next processTransitions cycle)
      const item = orch.getItem("MRG-1")!;
      expect(item.state).toBe("merged");
      expect(item.prNumber).toBe(42);

      // Second cycle completes: merged → done
      const actions2 = orch.processTransitions(snapshotWith([]), NOW);
      expect(item.state).toBe("done");

      // Produces a clean action
      const cleanAction = actions.find(
        (a) => a.type === "clean" && a.itemId === "MRG-1",
      );
      expect(cleanAction).toBeDefined();
    });
  });

  // ── Test 2: PR merges while in ci-pending state ────────────────
  describe("2. PR merges while in ci-pending state", () => {
    it("item in ci-pending → PR merges externally → handlePrLifecycle detects merged → transitions correctly", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-2", "Fix parsing bug"));
      orch.getItem("MRG-2")!.reviewCompleted = true;
      orch.hydrateState("MRG-2", "ci-pending");
      orch.getItem("MRG-2")!.prNumber = 50;

      // Simulate: someone merged the PR externally while CI was still pending
      const snapshot = snapshotWith([
        {
          id: "MRG-2",
          prNumber: 50,
          prState: "merged",
        },
      ]);

      const actions = orch.processTransitions(snapshot, NOW);

      // handlePrLifecycle checks prState === "merged" first
      const item = orch.getItem("MRG-2")!;
      expect(item.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "MRG-2")).toBe(true);

      // Second cycle: merged → done
      orch.processTransitions(snapshotWith([]), NOW);
      expect(item.state).toBe("done");
    });
  });

  // ── Test 3: PR merges while in ci-passed state ─────────────────
  describe("3. PR merges while in ci-passed state", () => {
    it("item in ci-passed → PR merges → handlePrLifecycle detects → transitions to done", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-3", "Add new endpoint"));
      orch.getItem("MRG-3")!.reviewCompleted = true;
      orch.hydrateState("MRG-3", "ci-passed");
      orch.getItem("MRG-3")!.reviewCompleted = true;
      orch.getItem("MRG-3")!.prNumber = 60;

      const snapshot = snapshotWith([
        {
          id: "MRG-3",
          prNumber: 60,
          prState: "merged",
          ciStatus: "pass",
        },
      ]);

      const actions = orch.processTransitions(snapshot, NOW);

      const item = orch.getItem("MRG-3")!;
      expect(item.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "MRG-3")).toBe(true);

      // Second cycle: merged → done
      orch.processTransitions(snapshotWith([]), NOW);
      expect(item.state).toBe("done");
    });
  });

  // ── Test 4: Title collision -- reused item ID with stale merged PR ──
  describe("4. Title collision: reused item ID with stale merged PR", () => {
    it("old PR merged → new item with same ID → buildSnapshot ignores stale merged PR (title mismatch) → returns no prState", () => {
      const orch = new Orchestrator();
      // New item with same ID but different title
      orch.addItem(makeWorkItem("H-FOO-1", "Brand new feature for v2"));
      orch.getItem("H-FOO-1")!.reviewCompleted = true;
      orch.hydrateState("H-FOO-1", "implementing");
      // No prNumber tracked -- this is a fresh launch

      // Old merged PR has a completely different title
      const checkPr = (_id: string, _root: string) =>
        "H-FOO-1\t30\tmerged\t\t\tfix: old bug from v1 cycle";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".ninthwave", ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      const snap = snapshot.items.find((s) => s.id === "H-FOO-1");
      expect(snap).toBeDefined();
      // Title mismatch + no tracked prNumber = stale PR, prState should be undefined
      expect(snap!.prState).toBeUndefined();

      // processTransitions should NOT transition to merged
      const actions = orch.processTransitions(snapshot, NOW);
      expect(orch.getItem("H-FOO-1")!.state).toBe("implementing");
      // No clean action should be emitted for this item from merge detection
      expect(actions.some((a) => a.type === "clean" && a.itemId === "H-FOO-1")).toBe(false);
    });
  });

  // ── Test 5: Title collision -- tracked PR number matches ────────
  describe("5. Title collision: tracked PR number matches", () => {
    it("orchestrator tracks PR #42 → buildSnapshot sees merged PR #42 → trusts it regardless of title → returns merged", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("H-FOO-2", "Original item title"));
      orch.getItem("H-FOO-2")!.reviewCompleted = true;
      orch.hydrateState("H-FOO-2", "ci-passed");
      orch.getItem("H-FOO-2")!.reviewCompleted = true;
      // Orchestrator already tracked this PR number
      orch.getItem("H-FOO-2")!.prNumber = 42;

      // Worker used a completely different PR title -- but PR number matches
      const checkPr = (_id: string, _root: string) =>
        "H-FOO-2\t42\tmerged\t\t\trefactor: completely rewritten implementation";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".ninthwave", ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      const snap = snapshot.items.find((s) => s.id === "H-FOO-2");
      expect(snap).toBeDefined();
      // prNumber matches tracked → trusted as merged despite title mismatch
      expect(snap!.prState).toBe("merged");

      const actions = orch.processTransitions(snapshot, NOW);
      expect(orch.getItem("H-FOO-2")!.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "H-FOO-2")).toBe(true);

      // Second cycle: merged → done
      orch.processTransitions(snapshotWith([]), NOW);
      expect(orch.getItem("H-FOO-2")!.state).toBe("done");
    });
  });

  // ── Test 6: Merge conflict detection in ci-pending ─────────────
  describe("6. Merge conflict detection: CONFLICTING in ci-pending", () => {
    it("item in ci-pending → snapshot shows isMergeable: false → daemon-rebase action emitted", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-6", "Update config"));
      orch.getItem("MRG-6")!.reviewCompleted = true;
      orch.hydrateState("MRG-6", "ci-pending");
      orch.getItem("MRG-6")!.prNumber = 70;
      orch.getItem("MRG-6")!.workspaceRef = "ws:6";

      const snapshot = snapshotWith([
        {
          id: "MRG-6",
          prNumber: 70,
          prState: "open",
          ciStatus: "pending",
          isMergeable: false,
        },
      ]);

      const actions = orch.processTransitions(snapshot, NOW);

      // Should emit a daemon-rebase action
      const rebaseAction = actions.find(
        (a) => a.type === "daemon-rebase" && a.itemId === "MRG-6",
      );
      expect(rebaseAction).toBeDefined();
      expect(rebaseAction!.message).toContain("merge conflicts");

      // Item should have rebaseRequested set
      expect(orch.getItem("MRG-6")!.rebaseRequested).toBe(true);
    });

    it("does not send duplicate rebase requests when rebaseRequested is already true", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-6B", "Update config v2"));
      orch.getItem("MRG-6B")!.reviewCompleted = true;
      orch.hydrateState("MRG-6B", "ci-pending");
      orch.getItem("MRG-6B")!.prNumber = 71;
      orch.getItem("MRG-6B")!.workspaceRef = "ws:6b";
      orch.getItem("MRG-6B")!.rebaseRequested = true; // already requested

      const snapshot = snapshotWith([
        {
          id: "MRG-6B",
          prNumber: 71,
          prState: "open",
          ciStatus: "pending",
          isMergeable: false,
        },
      ]);

      const actions = orch.processTransitions(snapshot, NOW);

      // No daemon-rebase action -- already requested
      const rebaseActions = actions.filter(
        (a) => a.type === "daemon-rebase" && a.itemId === "MRG-6B",
      );
      expect(rebaseActions).toHaveLength(0);
    });
  });

  // ── Test 7: Merge retry limit -- 3 failures → stuck ────────────
  describe("7. Merge retry limit: 3 failures → stuck", () => {
    it("executeMerge fails 3 times → item transitions to stuck (not infinite loop)", () => {
      const orch = new Orchestrator({ mergeStrategy: "auto", maxMergeRetries: 3 });
      orch.addItem(makeWorkItem("MRG-7", "Feature with flaky merge"));
      orch.getItem("MRG-7")!.reviewCompleted = true;
      orch.hydrateState("MRG-7", "ci-passed");
      orch.getItem("MRG-7")!.reviewCompleted = true;
      orch.getItem("MRG-7")!.prNumber = 80;

      const ctx = stubCtx();
      // prMerge always fails, checkPrMergeable returns true (not a conflict -- genuine failure)
      const deps = stubDeps({
        prMerge: () => false,
        checkPrMergeable: () => true,
      });

      // Attempt 1: ci-passed → merging (via processTransitions) → executeMerge fails → ci-passed
      let snapshot = snapshotWith([
        { id: "MRG-7", prNumber: 80, prState: "open", ciStatus: "pass" },
      ]);
      let actions = orch.processTransitions(snapshot, NOW);
      expect(orch.getItem("MRG-7")!.state).toBe("merging");
      let mergeAction = actions.find((a) => a.type === "merge" && a.itemId === "MRG-7");
      expect(mergeAction).toBeDefined();
      let result = orch.executeAction(mergeAction!, ctx, deps);
      expect(result.success).toBe(false);
      expect(orch.getItem("MRG-7")!.mergeFailCount).toBe(1);
      expect(orch.getItem("MRG-7")!.state).toBe("ci-passed"); // back to ci-passed for retry

      // Attempt 2
      snapshot = snapshotWith([
        { id: "MRG-7", prNumber: 80, prState: "open", ciStatus: "pass" },
      ]);
      actions = orch.processTransitions(snapshot, NOW);
      mergeAction = actions.find((a) => a.type === "merge" && a.itemId === "MRG-7");
      expect(mergeAction).toBeDefined();
      result = orch.executeAction(mergeAction!, ctx, deps);
      expect(orch.getItem("MRG-7")!.mergeFailCount).toBe(2);
      expect(orch.getItem("MRG-7")!.state).toBe("ci-passed");

      // Attempt 3: reaches maxMergeRetries → stuck
      snapshot = snapshotWith([
        { id: "MRG-7", prNumber: 80, prState: "open", ciStatus: "pass" },
      ]);
      actions = orch.processTransitions(snapshot, NOW);
      mergeAction = actions.find((a) => a.type === "merge" && a.itemId === "MRG-7");
      expect(mergeAction).toBeDefined();
      result = orch.executeAction(mergeAction!, ctx, deps);
      expect(orch.getItem("MRG-7")!.mergeFailCount).toBe(3);
      expect(orch.getItem("MRG-7")!.state).toBe("stuck");
      expect(orch.getItem("MRG-7")!.failureReason).toContain("merge-failed");
      expect(orch.getItem("MRG-7")!.failureReason).toContain("3");

      // Attempt 4: should NOT happen because item is stuck
      snapshot = snapshotWith([
        { id: "MRG-7", prNumber: 80, prState: "open", ciStatus: "pass" },
      ]);
      actions = orch.processTransitions(snapshot, NOW);
      // No merge action should be emitted for stuck items
      const postStuckMerge = actions.filter(
        (a) => a.type === "merge" && a.itemId === "MRG-7",
      );
      expect(postStuckMerge).toHaveLength(0);
    });
  });

  // ── Test 8: Branch deleted after squash merge ──────────────────
  describe("8. Branch deleted after squash merge", () => {
    it("PR squash-merged → branch auto-deleted → prList(open) empty → prList(merged) returns PR → snapshot has prState: merged", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-8", "Cleanup dead code"));
      orch.getItem("MRG-8")!.reviewCompleted = true;
      orch.hydrateState("MRG-8", "ci-passed");
      orch.getItem("MRG-8")!.reviewCompleted = true;
      orch.getItem("MRG-8")!.prNumber = 90;

      // After squash merge, GitHub deletes the branch automatically.
      // checkPrStatus calls prList("open") → empty, then prList("merged") → finds it.
      // The checkPr mock simulates the final output format.
      const checkPr = (_id: string, _root: string) =>
        "MRG-8\t90\tmerged\t\t\tchore: cleanup dead code";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".ninthwave", ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      const snap = snapshot.items.find((s) => s.id === "MRG-8");
      expect(snap).toBeDefined();
      expect(snap!.prState).toBe("merged");
      expect(snap!.prNumber).toBe(90);

      // Process transitions -- should go to merged
      const actions = orch.processTransitions(snapshot, NOW);
      expect(orch.getItem("MRG-8")!.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "MRG-8")).toBe(true);

      // Second cycle: merged → done
      orch.processTransitions(snapshotWith([]), NOW);
      expect(orch.getItem("MRG-8")!.state).toBe("done");
    });
  });

  // ── Additional edge cases ──────────────────────────────────────
  describe("Edge cases", () => {
    it("PR merges while in ci-failed state → handlePrLifecycle detects merged → clean action", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-E1", "Fix flaky test"));
      orch.getItem("MRG-E1")!.reviewCompleted = true;
      orch.hydrateState("MRG-E1", "ci-failed");
      orch.getItem("MRG-E1")!.reviewCompleted = true;
      orch.getItem("MRG-E1")!.prNumber = 95;
      orch.getItem("MRG-E1")!.ciFailCount = 1;

      const snapshot = snapshotWith([
        { id: "MRG-E1", prNumber: 95, prState: "merged" },
      ]);

      const actions = orch.processTransitions(snapshot, NOW);
      expect(orch.getItem("MRG-E1")!.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "MRG-E1")).toBe(true);

      // Second cycle: merged → done
      orch.processTransitions(snapshotWith([]), NOW);
      expect(orch.getItem("MRG-E1")!.state).toBe("done");
    });

    it("merge conflict during executeMerge triggers rebase instead of counting as merge failure", () => {
      const orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("MRG-E2", "Conflict scenario"));
      orch.getItem("MRG-E2")!.reviewCompleted = true;
      orch.hydrateState("MRG-E2", "ci-passed");
      orch.getItem("MRG-E2")!.reviewCompleted = true;
      orch.getItem("MRG-E2")!.prNumber = 100;
      orch.getItem("MRG-E2")!.workspaceRef = "ws:e2";

      const ctx = stubCtx();
      // prMerge fails AND checkPrMergeable returns false (conflict)
      const deps = stubDeps({
        prMerge: () => false,
        checkPrMergeable: () => false,
        daemonRebase: () => true, // daemon rebase succeeds
      });

      // Get merge action
      const snapshot = snapshotWith([
        { id: "MRG-E2", prNumber: 100, prState: "open", ciStatus: "pass" },
      ]);
      const actions = orch.processTransitions(snapshot, NOW);
      const mergeAction = actions.find((a) => a.type === "merge" && a.itemId === "MRG-E2");
      expect(mergeAction).toBeDefined();

      // Execute merge -- should detect conflict and rebase
      const result = orch.executeAction(mergeAction!, ctx, deps);
      expect(result.success).toBe(false);

      // Should transition to ci-pending (not stay in merging or go to stuck)
      expect(orch.getItem("MRG-E2")!.state).toBe("ci-pending");
      // mergeFailCount should NOT be incremented for conflict-caused failures
      expect(orch.getItem("MRG-E2")!.mergeFailCount ?? 0).toBe(0);
    });

    it("CI fails due to merge conflicts → daemon-rebase emitted instead of generic CI failure", () => {
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-E3", "Conflict CI scenario"));
      orch.getItem("MRG-E3")!.reviewCompleted = true;
      orch.hydrateState("MRG-E3", "ci-pending");
      orch.getItem("MRG-E3")!.prNumber = 110;
      orch.getItem("MRG-E3")!.workspaceRef = "ws:e3";

      const snapshot = snapshotWith([
        {
          id: "MRG-E3",
          prNumber: 110,
          prState: "open",
          ciStatus: "fail",
          isMergeable: false, // CONFLICTING
        },
      ]);

      const actions = orch.processTransitions(snapshot, NOW);

      // Should emit daemon-rebase (not just notify-ci-failure)
      const daemonRebase = actions.find(
        (a) => a.type === "daemon-rebase" && a.itemId === "MRG-E3",
      );
      expect(daemonRebase).toBeDefined();
      expect(daemonRebase!.message).toContain("merge conflicts");

      // State should be ci-failed
      expect(orch.getItem("MRG-E3")!.state).toBe("ci-failed");
    });

    it("buildSnapshot integration: checkPr returns open PR with various CI states", () => {
      // Verify buildSnapshot correctly translates checkPr status strings
      const orch = new Orchestrator();
      orch.addItem(makeWorkItem("MRG-E4-P", "Pending PR"));
      orch.getItem("MRG-E4-P")!.reviewCompleted = true;
      orch.hydrateState("MRG-E4-P", "implementing");
      orch.addItem(makeWorkItem("MRG-E4-F", "Failing PR"));
      orch.getItem("MRG-E4-F")!.reviewCompleted = true;
      orch.hydrateState("MRG-E4-F", "implementing");
      orch.addItem(makeWorkItem("MRG-E4-R", "Ready PR"));
      orch.getItem("MRG-E4-R")!.reviewCompleted = true;
      orch.hydrateState("MRG-E4-R", "implementing");

      const checkPr = (id: string, _root: string) => {
        switch (id) {
          case "MRG-E4-P":
            return "MRG-E4-P\t200\tpending\tMERGEABLE\t2026-03-27T09:00:00Z";
          case "MRG-E4-F":
            return "MRG-E4-F\t201\tfailing\tCONFLICTING\t2026-03-27T09:01:00Z";
          case "MRG-E4-R":
            return "MRG-E4-R\t202\tready\tMERGEABLE\t2026-03-27T09:02:00Z";
          default:
            return `${id}\t\tno-pr`;
        }
      };

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".ninthwave", ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      const pending = snapshot.items.find((s) => s.id === "MRG-E4-P");
      expect(pending!.ciStatus).toBe("pending");
      expect(pending!.prState).toBe("open");
      expect(pending!.isMergeable).toBe(true);

      const failing = snapshot.items.find((s) => s.id === "MRG-E4-F");
      expect(failing!.ciStatus).toBe("fail");
      expect(failing!.prState).toBe("open");
      expect(failing!.isMergeable).toBe(false);

      const ready = snapshot.items.find((s) => s.id === "MRG-E4-R");
      expect(ready!.ciStatus).toBe("pass");
      expect(ready!.prState).toBe("open");
      expect(ready!.reviewDecision).toBe("APPROVED");
      expect(ready!.isMergeable).toBe(true);
    });
  });

  // ── reconstructState edge cases ────────────────────────────────
  describe("reconstructState: restart recovery", () => {
    let tmpDir: string;
    let wtDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `nw-mrg-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      wtDir = join(tmpDir, ".ninthwave", ".worktrees");
    });

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
    });

    it("rejects merged PR with mismatched title from a previous cycle (prNumber never tracked)", () => {
      const orch = new Orchestrator();
      const item = makeWorkItem("MRG-RR-1", "New implementation of feature Y");
      orch.addItem(item);

      // Create worktree directory so reconstructState processes this item
      mkdirSync(join(wtDir, "ninthwave-MRG-RR-1"), { recursive: true });

      // checkPr returns a merged PR with a completely different title
      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-1\t30\tmerged\t\t\tfix: old bug in feature Y";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr);

      // Should NOT be marked merged -- title mismatch + no tracked prNumber
      expect(orch.getItem("MRG-RR-1")!.state).not.toBe("merged");
    });

    it("accepts merged PR with matching title when prNumber was never tracked", () => {
      const orch = new Orchestrator();
      const item = makeWorkItem("MRG-RR-2", "New implementation of feature Y");
      orch.addItem(item);

      mkdirSync(join(wtDir, "ninthwave-MRG-RR-2"), { recursive: true });

      // Title matches the item after normalization
      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-2\t31\tmerged\t\t\tfeat: New implementation of feature Y";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr);

      expect(orch.getItem("MRG-RR-2")!.state).toBe("merged");
    });

    it("accepts merged PR with mismatched title when prNumber WAS already tracked", () => {
      const orch = new Orchestrator();
      const item = makeWorkItem("MRG-RR-3", "Improve error handling");
      orch.addItem(item);
      orch.getItem("MRG-RR-3")!.prNumber = 77;

      mkdirSync(join(wtDir, "ninthwave-MRG-RR-3"), { recursive: true });

      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-3\t77\tmerged\t\t\trefactor: completely rewrite error paths";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr);

      expect(orch.getItem("MRG-RR-3")!.state).toBe("merged");
    });

    it("accepts merged PR with mismatched title when daemon state already tracked the PR number", () => {
      const orch = new Orchestrator();
      const item = makeWorkItem("MRG-RR-4", "Improve error handling");
      orch.addItem(item);

      const daemonState: DaemonState = {
        pid: 1234,
        startedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T01:00:00Z",
        items: [
          {
            id: "MRG-RR-4",
            state: "ci-pending",
            prNumber: 78,
            title: "Improve error handling",
            lastTransition: "2026-01-01T00:30:00Z",
            ciFailCount: 0,
            retryCount: 0,
          },
        ],
      };

      mkdirSync(join(wtDir, "ninthwave-MRG-RR-4"), { recursive: true });

      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-4\t78\tmerged\t\t\trefactor: completely rewrite error paths";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr, daemonState);

      expect(orch.getItem("MRG-RR-4")!.state).toBe("merged");
      expect(orch.getItem("MRG-RR-4")!.prNumber).toBe(78);
    });
  });
});
