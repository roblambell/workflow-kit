/**
 * Integration test for the full merge detection lifecycle:
 * buildSnapshot → processTransitions → handleImplementing/handlePrLifecycle
 *
 * Covers the fast auto-merge scenario where orchItem.prNumber was never set
 * before checkPrStatus returns "merged".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  Orchestrator,
  type ItemSnapshot,
  type PollSnapshot,
  type OrchestratorItem,
} from "../core/orchestrator.ts";
import {
  buildSnapshot,
  reconstructState,
} from "../core/commands/orchestrate.ts";
import type { Multiplexer } from "../core/mux.ts";
import type { TodoItem, Priority } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(
  id: string,
  title = `TODO ${id}`,
  deps: string[] = [],
  priority: Priority = "high",
): TodoItem {
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

/** Stub multiplexer — all operations are no-ops. */
function stubMux(): Multiplexer {
  return {
    type: "cmux" as any,
    isAvailable: () => true,
    diagnoseUnavailable: () => "",
    launchWorkspace: () => null,
    splitPane: () => null,
    sendMessage: () => true,
    readScreen: () => "",
    listWorkspaces: () => "",
    closeWorkspace: () => true,
  };
}

const NOW = new Date("2026-03-27T10:00:00Z");
const PROJECT_ROOT = "/tmp/nw-merge-test";

// ── Integration tests ────────────────────────────────────────────────

describe("Merge detection lifecycle (integration)", () => {
  describe("buildSnapshot → processTransitions (live polling)", () => {
    it("happy path: fast auto-merge detected via buildSnapshot, produces clean action", () => {
      const orch = new Orchestrator();
      orch.addItem(makeTodo("MRG-HP-1", "Implement feature X"));
      orch.setState("MRG-HP-1", "implementing");

      // checkPr returns merged status — simulates fast auto-merge
      // where prNumber was never set on the orchestrator item
      const checkPr = (_id: string, _root: string) =>
        "MRG-HP-1\t42\tmerged\t\t\tfeat: implement feature X";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".worktrees"),
        stubMux(),
        () => null, // getLastCommitTime — not relevant for merged
        checkPr,
      );

      // Verify snapshot captures merged state
      const snap = snapshot.items.find((s) => s.id === "MRG-HP-1");
      expect(snap).toBeDefined();
      expect(snap!.prState).toBe("merged");
      expect(snap!.prNumber).toBe(42);

      // Feed snapshot into processTransitions
      const actions = orch.processTransitions(snapshot, NOW);

      // Item transitions to merged
      expect(orch.getItem("MRG-HP-1")!.state).toBe("merged");
      expect(orch.getItem("MRG-HP-1")!.prNumber).toBe(42);

      // Produces a clean action
      const cleanAction = actions.find(
        (a) => a.type === "clean" && a.itemId === "MRG-HP-1",
      );
      expect(cleanAction).toBeDefined();
    });

    it("rephrased title: PR title differs but prNumber is tracked, still detected as merged", () => {
      const orch = new Orchestrator();
      orch.addItem(makeTodo("MRG-RT-1", "Add error handling to parser"));
      orch.setState("MRG-RT-1", "ci-passed");
      // Orchestrator tracked this PR during the run (worker created it, snapshot detected it)
      orch.getItem("MRG-RT-1")!.prNumber = 55;

      // Worker used a completely different PR title than the TODO title.
      // Since prNumber matches, title check is skipped.
      const checkPr = (_id: string, _root: string) =>
        "MRG-RT-1\t55\tmerged\t\t\trefactor: rewrite parser error paths";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      const snap = snapshot.items.find((s) => s.id === "MRG-RT-1");
      expect(snap).toBeDefined();
      expect(snap!.prState).toBe("merged");

      const actions = orch.processTransitions(snapshot, NOW);

      // Detected as merged — prNumber is tracked so title is irrelevant
      expect(orch.getItem("MRG-RT-1")!.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "MRG-RT-1")).toBe(true);
    });

    it("stale merged PR with different title and no tracked prNumber is ignored", () => {
      const orch = new Orchestrator();
      orch.addItem(makeTodo("MRG-RT-1", "Add error handling to parser"));
      orch.setState("MRG-RT-1", "implementing");
      // No prNumber tracked — worker hasn't created a PR yet

      // Old merged PR from previous cycle with different title
      const checkPr = (_id: string, _root: string) =>
        "MRG-RT-1\t55\tmerged\t\t\trefactor: rewrite parser error paths";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      const snap = snapshot.items.find((s) => s.id === "MRG-RT-1");
      expect(snap).toBeDefined();
      // prState should be undefined — title mismatch + no tracked prNumber = stale PR
      expect(snap!.prState).toBeUndefined();
    });
  });

  describe("reconstructState: restart recovery with title collision detection", () => {
    let tmpDir: string;
    let wtDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `nw-mrg-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      wtDir = join(tmpDir, ".worktrees");
    });

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
    });

    it("rejects merged PR with mismatched title from a previous cycle (prNumber never tracked)", () => {
      const orch = new Orchestrator();
      const todo = makeTodo("MRG-RR-1", "New implementation of feature Y");
      orch.addItem(todo);
      // prNumber was never set — simulates first run for this TODO ID

      // Create worktree directory so reconstructState processes this item
      mkdirSync(join(wtDir, "todo-MRG-RR-1"), { recursive: true });

      // checkPr returns a merged PR with a completely different title
      // (from a previous TODO cycle that reused the same ID)
      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-1\t30\tmerged\t\t\tfix: old bug in feature Y";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr);

      // Should NOT be marked merged — title mismatch + no tracked prNumber
      // means this is a stale PR from a previous cycle
      expect(orch.getItem("MRG-RR-1")!.state).toBe("implementing");
    });

    it("accepts merged PR with matching title when prNumber was never tracked", () => {
      const orch = new Orchestrator();
      const todo = makeTodo("MRG-RR-2", "New implementation of feature Y");
      orch.addItem(todo);

      mkdirSync(join(wtDir, "todo-MRG-RR-2"), { recursive: true });

      // Title matches the TODO after normalization (prefix stripped, ID stripped)
      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-2\t31\tmerged\t\t\tfeat: New implementation of feature Y";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr);

      // Should be merged — title matches
      expect(orch.getItem("MRG-RR-2")!.state).toBe("merged");
    });

    it("accepts merged PR with mismatched title when prNumber WAS already tracked", () => {
      const orch = new Orchestrator();
      const todo = makeTodo("MRG-RR-3", "Improve error handling");
      orch.addItem(todo);
      // Simulate daemon state having previously tracked this PR number
      orch.getItem("MRG-RR-3")!.prNumber = 77;

      mkdirSync(join(wtDir, "todo-MRG-RR-3"), { recursive: true });

      // Title is completely different, but PR number matches what was tracked
      const checkPr = (_id: string, _root: string) =>
        "MRG-RR-3\t77\tmerged\t\t\trefactor: completely rewrite error paths";

      reconstructState(orch, tmpDir, wtDir, stubMux(), checkPr);

      // Should be merged — prNumber match bypasses the title check
      expect(orch.getItem("MRG-RR-3")!.state).toBe("merged");
    });
  });

  describe("end-to-end: buildSnapshot feeds processTransitions for merged item with no prior prNumber", () => {
    it("completes full pipeline from implementing to merged with clean action", () => {
      const orch = new Orchestrator();
      orch.addItem(makeTodo("MRG-E2E-1", "End to end merge test"));
      orch.setState("MRG-E2E-1", "implementing");

      // Verify starting state: no prNumber set
      expect(orch.getItem("MRG-E2E-1")!.prNumber).toBeUndefined();

      // Phase 1: buildSnapshot detects merged PR
      const checkPr = (_id: string, _root: string) =>
        "MRG-E2E-1\t100\tmerged\t\t\tfeat: end to end merge test";

      const snapshot = buildSnapshot(
        orch,
        PROJECT_ROOT,
        join(PROJECT_ROOT, ".worktrees"),
        stubMux(),
        () => null,
        checkPr,
      );

      // Phase 2: processTransitions produces actions
      const actions = orch.processTransitions(snapshot, NOW);

      // Verify final state
      const item = orch.getItem("MRG-E2E-1")!;
      expect(item.state).toBe("merged");
      expect(item.prNumber).toBe(100);

      // Verify exactly one clean action for this item
      const cleanActions = actions.filter(
        (a) => a.type === "clean" && a.itemId === "MRG-E2E-1",
      );
      expect(cleanActions).toHaveLength(1);

      // Verify no other action types were produced for this item
      const otherActions = actions.filter(
        (a) => a.itemId === "MRG-E2E-1" && a.type !== "clean",
      );
      expect(otherActions).toHaveLength(0);
    });
  });
});
