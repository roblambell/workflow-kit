// Tests for core/orchestrator.ts — Orchestrator state machine and action execution.
// No vi.mock — executeAction uses dependency injection to stay bun-test compatible.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Orchestrator,
  DEFAULT_CONFIG,
  type OrchestratorItem,
  type PollSnapshot,
  type ItemSnapshot,
  type Action,
  type ExecutionContext,
  type ActionResult,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";

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
    lineNumber: 1,
    lineEndNumber: 5,
    repoAlias: "",
    rawText: `## ${id}\nTest todo`,
    filePaths: [],
  };
}

function emptySnapshot(readyIds: string[] = []): PollSnapshot {
  return { items: [], readyIds };
}

function snapshotWith(
  items: ItemSnapshot[],
  readyIds: string[] = [],
): PollSnapshot {
  return { items, readyIds };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  todosFile: "/tmp/test-project/TODOS.md",
  aiTool: "claude",
};

/** Create mock deps with sensible defaults. Override individual fns as needed. */
function mockDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/todo-test",
      workspaceRef: "workspace:1",
    })),
    cleanSingleWorktree: vi.fn(() => true),
    cmdMarkDone: vi.fn(),
    prMerge: vi.fn(() => true),
    prComment: vi.fn(() => true),
    sendMessage: vi.fn(() => true),
    closeWorkspace: vi.fn(() => true),
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Orchestrator", () => {
  let orch: Orchestrator;

  beforeEach(() => {
    orch = new Orchestrator();
  });

  // ── 1. Item management ─────────────────────────────────────────

  it("adds items in queued state", () => {
    orch.addItem(makeTodo("H-1-1"));

    const item = orch.getItem("H-1-1");
    expect(item).toBeDefined();
    expect(item!.state).toBe("queued");
    expect(item!.ciFailCount).toBe(0);
  });

  it("lists all items", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.addItem(makeTodo("H-1-3"));

    expect(orch.getAllItems()).toHaveLength(3);
  });

  it("filters items by state", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.setState("H-1-1", "ready");

    expect(orch.getItemsByState("queued")).toHaveLength(1);
    expect(orch.getItemsByState("ready")).toHaveLength(1);
  });

  // ── 2. Queued → Ready when deps are met ────────────────────────

  it("promotes queued items to ready when deps are met", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2", ["H-1-1"]));

    orch.processTransitions(emptySnapshot(["H-1-1"]));

    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });

  it("does not promote items whose deps are not in readyIds", () => {
    orch.addItem(makeTodo("H-1-1", ["H-1-0"]));

    orch.processTransitions(emptySnapshot([]));

    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  // ── 3. Ready → Launching with WIP limit ────────────────────────

  it("launches ready items up to WIP limit", () => {
    orch = new Orchestrator({ wipLimit: 2 });

    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.addItem(makeTodo("H-1-3"));

    const actions = orch.processTransitions(
      emptySnapshot(["H-1-1", "H-1-2", "H-1-3"]),
    );

    const launchActions = actions.filter((a) => a.type === "launch");
    expect(launchActions).toHaveLength(2);
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-2")!.state).toBe("launching");
    expect(orch.getItem("H-1-3")!.state).toBe("ready");
  });

  it("respects WIP limit across existing WIP items", () => {
    orch = new Orchestrator({ wipLimit: 2 });

    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.setState("H-1-1", "implementing"); // already in WIP

    const actions = orch.processTransitions(
      snapshotWith(
        [{ id: "H-1-1", workerAlive: true }],
        ["H-1-2"],
      ),
    );

    const launchActions = actions.filter((a) => a.type === "launch");
    expect(launchActions).toHaveLength(1);
    expect(launchActions[0]!.itemId).toBe("H-1-2");
  });

  // ── 4. Launching → Implementing ───────────────────────────────

  it("transitions launching to implementing when worker is alive", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "launching");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
  });

  it("transitions launching to stuck when worker dies", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "launching");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  // ── 5. Implementing → PR open ─────────────────────────────────

  it("transitions implementing to pr-open when PR appears", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", prNumber: 42, prState: "open", workerAlive: true },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("pr-open");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(42);
  });

  it("marks implementing as stuck when worker dies without PR", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  // ── 6. CI pass → merge action (asap strategy) ─────────────────

  it("CI pass triggers merge action with asap strategy", () => {
    orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "pr-open");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    const mergeActions = actions.filter((a) => a.type === "merge");
    expect(mergeActions).toHaveLength(1);
    expect(mergeActions[0]!.prNumber).toBe(42);
  });

  // ── 7. CI fail → notify-ci-failure action ──────────────────────

  it("CI fail triggers notify-ci-failure action", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "pr-open");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    const notifyActions = actions.filter((a) => a.type === "notify-ci-failure");
    expect(notifyActions).toHaveLength(1);
    expect(notifyActions[0]!.message).toContain("CI failed");
  });

  it("CI fail increments ciFailCount", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "pr-open");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(1);
  });

  // ── 8. CI fail recovery ────────────────────────────────────────

  it("ci-failed recovers when CI passes (chains to merge evaluation)", () => {
    orch = new Orchestrator({ mergeStrategy: "ask" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.ciFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
  });

  it("ci-failed with asap strategy chains CI pass to merge", () => {
    orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.ciFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("marks stuck after exceeding max CI retries", () => {
    orch = new Orchestrator({ maxCiRetries: 1 });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.ciFailCount = 2;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
  });

  // ── 9. PR merged → clean action ───────────────────────────────

  it("PR merged triggers clean action from ci-passed state", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    const cleanActions = actions.filter((a) => a.type === "clean");
    expect(cleanActions).toHaveLength(1);
    expect(cleanActions[0]!.itemId).toBe("H-1-1");
  });

  it("PR merged triggers clean action from merging state", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merging");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    const cleanActions = actions.filter((a) => a.type === "clean");
    expect(cleanActions).toHaveLength(1);
  });

  // ── 10. Merged → Done ─────────────────────────────────────────

  it("merged transitions to done on next cycle", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");

    orch.processTransitions(emptySnapshot());

    expect(orch.getItem("H-1-1")!.state).toBe("done");
  });

  // ── 11. Batch complete → launch next ───────────────────────────

  it("launches next batch when previous items complete", () => {
    orch = new Orchestrator({ wipLimit: 1 });

    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.setState("H-1-1", "merged");

    const actions = orch.processTransitions(
      emptySnapshot(["H-1-2"]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(orch.getItem("H-1-2")!.state).toBe("launching");
    const launchActions = actions.filter((a) => a.type === "launch");
    expect(launchActions).toHaveLength(1);
    expect(launchActions[0]!.itemId).toBe("H-1-2");
  });

  // ── 12. Merge strategy: approved ───────────────────────────────

  it("approved strategy waits for review before merging", () => {
    orch = new Orchestrator({ mergeStrategy: "approved" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "pr-open");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", ciStatus: "pass", prState: "open", reviewDecision: "" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    const mergeActions = actions.filter((a) => a.type === "merge");
    expect(mergeActions).toHaveLength(0);
  });

  it("approved strategy merges after review approval", () => {
    orch = new Orchestrator({ mergeStrategy: "approved" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "review-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([
        {
          id: "H-1-1",
          ciStatus: "pass",
          prState: "open",
          reviewDecision: "APPROVED",
        },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    const mergeActions = actions.filter((a) => a.type === "merge");
    expect(mergeActions).toHaveLength(1);
  });

  // ── 13. Merge strategy: ask ────────────────────────────────────

  it("ask strategy never auto-merges", () => {
    orch = new Orchestrator({ mergeStrategy: "ask" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "pr-open");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([
        {
          id: "H-1-1",
          ciStatus: "pass",
          prState: "open",
          reviewDecision: "APPROVED",
        },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    const mergeActions = actions.filter((a) => a.type === "merge");
    expect(mergeActions).toHaveLength(0);
  });

  // ── 14. ci-pending transitions ─────────────────────────────────

  it("ci-pending chains CI pass through merge evaluation", () => {
    orch = new Orchestrator({ mergeStrategy: "ask" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-pending");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
  });

  it("ci-pending with asap strategy chains CI pass to merge", () => {
    orch = new Orchestrator({ mergeStrategy: "asap" });
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-pending");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("ci-pending transitions to ci-failed when CI fails", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-pending");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
  });

  // ── 15. WIP count and slots ────────────────────────────────────

  it("wipCount reflects items in WIP states", () => {
    orch = new Orchestrator({ wipLimit: 5 });

    orch.addItem(makeTodo("H-1-1"));
    orch.addItem(makeTodo("H-1-2"));
    orch.addItem(makeTodo("H-1-3"));
    orch.addItem(makeTodo("H-1-4"));

    orch.setState("H-1-1", "implementing");
    orch.setState("H-1-2", "ci-pending");
    orch.setState("H-1-3", "done");
    orch.setState("H-1-4", "queued");

    expect(orch.wipCount).toBe(2);
    expect(orch.wipSlots).toBe(3);
  });

  // ── 16. Terminal states don't transition ───────────────────────

  it("done state does not transition", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "done");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toHaveLength(0);
  });

  it("stuck state does not transition", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "stuck");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions).toHaveLength(0);
  });

  // ── 17. Default config ─────────────────────────────────────────

  it("uses sensible defaults", () => {
    expect(DEFAULT_CONFIG.wipLimit).toBe(4);
    expect(DEFAULT_CONFIG.mergeStrategy).toBe("asap");
    expect(DEFAULT_CONFIG.maxCiRetries).toBe(2);
  });

  // ── 18. PR merged from ci-failed state ─────────────────────────

  it("handles external merge from ci-failed state", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.ciFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged", ciStatus: "pass" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
  });

  // ── 19. ci-failed → ci-pending ─────────────────────────────────

  it("ci-failed transitions to ci-pending when CI restarts", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.ciFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });

  // ── 20. pr-open → ci-pending ───────────────────────────────────

  it("pr-open transitions to ci-pending when CI starts", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "pr-open");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });

  // ── 21. Multiple items complete end-to-end ─────────────────────

  it("handles full lifecycle across multiple items", () => {
    orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });

    orch.addItem(makeTodo("A-1-1"));
    orch.addItem(makeTodo("A-1-2"));
    orch.addItem(makeTodo("A-1-3", ["A-1-1"]));

    orch.processTransitions(emptySnapshot(["A-1-1", "A-1-2"]));
    expect(orch.getItem("A-1-1")!.state).toBe("launching");
    expect(orch.getItem("A-1-2")!.state).toBe("launching");
    expect(orch.getItem("A-1-3")!.state).toBe("queued");

    orch.processTransitions(
      snapshotWith([
        { id: "A-1-1", workerAlive: true },
        { id: "A-1-2", workerAlive: true },
      ]),
    );
    expect(orch.getItem("A-1-1")!.state).toBe("implementing");
    expect(orch.getItem("A-1-2")!.state).toBe("implementing");

    orch.processTransitions(
      snapshotWith([
        { id: "A-1-1", prNumber: 10, prState: "open", workerAlive: true },
        { id: "A-1-2", prNumber: 11, prState: "open", workerAlive: true },
      ]),
    );
    expect(orch.getItem("A-1-1")!.state).toBe("pr-open");
    expect(orch.getItem("A-1-2")!.state).toBe("pr-open");

    const cycle4 = orch.processTransitions(
      snapshotWith([
        { id: "A-1-1", ciStatus: "pass", prState: "open" },
        { id: "A-1-2", ciStatus: "pending", prState: "open" },
      ]),
    );
    expect(orch.getItem("A-1-1")!.state).toBe("merging");
    expect(orch.getItem("A-1-2")!.state).toBe("ci-pending");
    expect(cycle4.some((a) => a.type === "merge" && a.itemId === "A-1-1")).toBe(true);

    const cycle5 = orch.processTransitions(
      snapshotWith(
        [
          { id: "A-1-1", prState: "merged" },
          { id: "A-1-2", ciStatus: "pass", prState: "open" },
        ],
        ["A-1-3"],
      ),
    );
    expect(orch.getItem("A-1-1")!.state).toBe("merged");
    expect(orch.getItem("A-1-2")!.state).toBe("merging");
    expect(orch.getItem("A-1-3")!.state).toBe("launching");
    expect(cycle5.some((a) => a.type === "clean" && a.itemId === "A-1-1")).toBe(true);
    expect(cycle5.some((a) => a.type === "launch" && a.itemId === "A-1-3")).toBe(true);

    const cycle6 = orch.processTransitions(
      snapshotWith([
        { id: "A-1-2", prState: "merged" },
        { id: "A-1-3", workerAlive: true },
      ]),
    );
    expect(orch.getItem("A-1-1")!.state).toBe("done");
    expect(orch.getItem("A-1-2")!.state).toBe("merged");
    expect(orch.getItem("A-1-3")!.state).toBe("implementing");
  });

  // ── 22. executeAction ─────────────────────────────────────────

  describe("executeAction", () => {
    // ── launch ────────────────────────────────────────────────

    it("launch: calls launchSingleItem and stores workspaceRef", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "launching");

      const result = orch.executeAction(
        { type: "launch", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.launchSingleItem).toHaveBeenCalledWith(
        orch.getItem("H-1-1")!.todo,
        defaultCtx.todosFile,
        defaultCtx.worktreeDir,
        defaultCtx.projectRoot,
        defaultCtx.aiTool,
      );
      expect(orch.getItem("H-1-1")!.workspaceRef).toBe("workspace:1");
    });

    it("launch: marks stuck when launchSingleItem returns null", () => {
      const deps = mockDeps({ launchSingleItem: vi.fn(() => null) });
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "launching");

      const result = orch.executeAction(
        { type: "launch", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Launch failed");
      expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    });

    it("launch: marks stuck when launchSingleItem throws", () => {
      const deps = mockDeps({
        launchSingleItem: vi.fn(() => { throw new Error("cmux not running"); }),
      });
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "launching");

      const result = orch.executeAction(
        { type: "launch", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("cmux not running");
      expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    });

    // ── merge ─────────────────────────────────────────────────

    it("merge: calls prMerge, posts audit comment, pulls main, transitions to merged", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.prMerge).toHaveBeenCalledWith(defaultCtx.projectRoot, 42);
      expect(deps.prComment).toHaveBeenCalledWith(
        defaultCtx.projectRoot,
        42,
        expect.stringContaining("[Orchestrator]"),
      );
      expect(deps.fetchOrigin).toHaveBeenCalledWith(defaultCtx.projectRoot, "main");
      expect(deps.ffMerge).toHaveBeenCalledWith(defaultCtx.projectRoot, "main");
      expect(orch.getItem("H-1-1")!.state).toBe("merged");
    });

    it("merge: reverts to ci-passed when prMerge fails", () => {
      const deps = mockDeps({ prMerge: vi.fn(() => false) });
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Merge failed");
      expect(orch.getItem("H-1-1")!.state).toBe("ci-passed");
    });

    it("merge: fails gracefully when no PR number", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merging");

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No PR number");
    });

    it("merge: sends rebase requests to dependent WIP items", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.addItem(makeTodo("H-1-2", ["H-1-1"]));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.setState("H-1-2", "implementing");
      orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

      orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(deps.sendMessage).toHaveBeenCalledWith(
        "workspace:2",
        expect.stringContaining("Dependency H-1-1 merged"),
      );
    });

    it("merge: does not send rebase to non-dependent items", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.addItem(makeTodo("H-1-2"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.setState("H-1-2", "implementing");
      orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

      orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it("merge: succeeds even when fetchOrigin/ffMerge throw", () => {
      const deps = mockDeps({
        fetchOrigin: vi.fn(() => { throw new Error("network error"); }),
      });
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(orch.getItem("H-1-1")!.state).toBe("merged");
    });

    // ── notify-ci-failure ─────────────────────────────────────

    it("notify-ci-failure: sends message to worker and posts PR comment", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction(
        { type: "notify-ci-failure", itemId: "H-1-1", message: "CI failed on job build" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "CI failed on job build");
      expect(deps.prComment).toHaveBeenCalledWith(
        defaultCtx.projectRoot,
        42,
        expect.stringContaining("CI failure detected"),
      );
    });

    it("notify-ci-failure: uses default message when none provided", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      orch.executeAction(
        { type: "notify-ci-failure", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(deps.sendMessage).toHaveBeenCalledWith(
        "workspace:1",
        "CI failed — please investigate and fix.",
      );
    });

    it("notify-ci-failure: succeeds without workspace ref (no message sent)", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "notify-ci-failure", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(deps.prComment).toHaveBeenCalled();
    });

    // ── notify-review ─────────────────────────────────────────

    it("notify-review: sends review message to worker", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "review-pending");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction(
        { type: "notify-review", itemId: "H-1-1", message: "Please address review comments." },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "Please address review comments.");
    });

    it("notify-review: uses default message when none provided", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "review-pending");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      orch.executeAction({ type: "notify-review", itemId: "H-1-1" }, defaultCtx, deps);

      expect(deps.sendMessage).toHaveBeenCalledWith(
        "workspace:1",
        "Review feedback received — please address.",
      );
    });

    it("notify-review: succeeds without workspace ref", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "review-pending");

      const result = orch.executeAction(
        { type: "notify-review", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    // ── clean ─────────────────────────────────────────────────

    it("clean: closes workspace and cleans worktree", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merged");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:1");
      expect(deps.cleanSingleWorktree).toHaveBeenCalledWith(
        "H-1-1",
        defaultCtx.worktreeDir,
        defaultCtx.projectRoot,
      );
    });

    it("clean: skips workspace close when no ref", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merged");

      const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).not.toHaveBeenCalled();
      expect(deps.cleanSingleWorktree).toHaveBeenCalledWith(
        "H-1-1",
        defaultCtx.worktreeDir,
        defaultCtx.projectRoot,
      );
    });

    // ── mark-done ─────────────────────────────────────────────

    it("mark-done: calls cmdMarkDone and transitions to done", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merged");

      const result = orch.executeAction(
        { type: "mark-done", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.cmdMarkDone).toHaveBeenCalledWith(["H-1-1"], defaultCtx.todosFile);
      expect(orch.getItem("H-1-1")!.state).toBe("done");
    });

    it("mark-done: handles cmdMarkDone failure gracefully", () => {
      const deps = mockDeps({
        cmdMarkDone: vi.fn(() => { throw new Error("TODOS.md not found"); }),
      });
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "merged");

      const result = orch.executeAction(
        { type: "mark-done", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("TODOS.md not found");
      expect(orch.getItem("H-1-1")!.state).toBe("merged");
    });

    // ── rebase ────────────────────────────────────────────────

    it("rebase: sends rebase message to worker", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "implementing");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction(
        { type: "rebase", itemId: "H-1-1", message: "Rebase onto main now." },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "Rebase onto main now.");
    });

    it("rebase: uses default message when none provided", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "implementing");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      orch.executeAction({ type: "rebase", itemId: "H-1-1" }, defaultCtx, deps);

      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "Please rebase onto latest main.");
    });

    it("rebase: fails when no workspace ref", () => {
      const deps = mockDeps();
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "implementing");

      const result = orch.executeAction({ type: "rebase", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No workspace reference");
    });

    it("rebase: fails when sendMessage returns false", () => {
      const deps = mockDeps({ sendMessage: vi.fn(() => false) });
      orch.addItem(makeTodo("H-1-1"));
      orch.setState("H-1-1", "implementing");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction({ type: "rebase", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to send rebase message");
    });

    // ── common error handling ─────────────────────────────────

    it("returns error for unknown item ID", () => {
      const deps = mockDeps();
      const result = orch.executeAction(
        { type: "launch", itemId: "NONEXISTENT" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("NONEXISTENT");
      expect(result.error).toContain("not found");
    });
  });
});
