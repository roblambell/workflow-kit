// Tests for core/orchestrator.ts — Orchestrator state machine and action execution.
// No vi.mock — executeAction uses dependency injection to stay bun-test compatible.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Orchestrator,
  DEFAULT_CONFIG,
  type OrchestratorItem,
  type OrchestratorItemState,
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
    testPlan: "",
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
    gitAdd: vi.fn(),
    gitCommit: vi.fn(),
    gitPush: vi.fn(),
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

  it("merged transitions to done and emits mark-done action", () => {
    orch.addItem(makeTodo("H-1-1"));
    orch.setState("H-1-1", "merged");

    const actions = orch.processTransitions(emptySnapshot());

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toContainEqual({ type: "mark-done", itemId: "H-1-1" });
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

    // ── post-merge conflict detection ────────────────────────

    it("merge: checks all in-flight sibling PRs for mergeable status", () => {
      const checkPrMergeable = vi.fn(() => true);
      const deps = mockDeps({ checkPrMergeable });
      orch.addItem(makeTodo("H-1-1"));
      orch.addItem(makeTodo("H-1-2"));
      orch.addItem(makeTodo("H-1-3"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.setState("H-1-2", "ci-pending");
      orch.getItem("H-1-2")!.prNumber = 43;
      orch.getItem("H-1-2")!.workspaceRef = "workspace:2";
      orch.setState("H-1-3", "implementing");
      orch.getItem("H-1-3")!.prNumber = 44;
      orch.getItem("H-1-3")!.workspaceRef = "workspace:3";

      orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      // Should check mergeable status for both in-flight sibling PRs
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 43);
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 44);
      expect(checkPrMergeable).toHaveBeenCalledTimes(2);
    });

    it("merge: sends rebase message to worker when sibling PR has conflicts", () => {
      const checkPrMergeable = vi.fn((_, prNum: number) => prNum !== 43);
      const deps = mockDeps({ checkPrMergeable });
      orch.addItem(makeTodo("H-1-1"));
      orch.addItem(makeTodo("H-1-2"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.setState("H-1-2", "ci-pending");
      orch.getItem("H-1-2")!.prNumber = 43;
      orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

      orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(deps.sendMessage).toHaveBeenCalledWith(
        "workspace:2",
        expect.stringContaining("merge conflicts"),
      );
    });

    it("merge: logs warning when conflicting PR has dead worker (no workspace ref)", () => {
      const checkPrMergeable = vi.fn(() => false);
      const warn = vi.fn();
      const deps = mockDeps({ checkPrMergeable, warn });
      orch.addItem(makeTodo("H-1-1"));
      orch.addItem(makeTodo("H-1-2"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.setState("H-1-2", "ci-pending");
      orch.getItem("H-1-2")!.prNumber = 43;
      // No workspaceRef — worker is dead

      orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("PR #43"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("merge conflicts"),
      );
      // Should NOT try to send a message to a non-existent workspace
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it("merge: does not send rebase for non-conflicting sibling PRs", () => {
      const checkPrMergeable = vi.fn(() => true);
      const deps = mockDeps({ checkPrMergeable });
      orch.addItem(makeTodo("H-1-1"));
      orch.addItem(makeTodo("H-1-2"));
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.setState("H-1-2", "ci-pending");
      orch.getItem("H-1-2")!.prNumber = 43;
      orch.getItem("H-1-2")!.workspaceRef = "workspace:2";

      orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      // checkPrMergeable was called, but sendMessage should NOT be called
      // (the existing dep rebase logic only fires for dependents, and H-1-2 is not a dependent)
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 43);
      expect(deps.sendMessage).not.toHaveBeenCalled();
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

    it("mark-done: calls cmdMarkDone, commits, pushes, and transitions to done", () => {
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
      expect(deps.gitAdd).toHaveBeenCalledWith(defaultCtx.projectRoot, [defaultCtx.todosFile]);
      expect(deps.gitCommit).toHaveBeenCalledWith(
        defaultCtx.projectRoot,
        "chore: mark H-1-1 done in TODOS.md",
      );
      expect(deps.gitPush).toHaveBeenCalledWith(defaultCtx.projectRoot);
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

  // ══════════════════════════════════════════════════════════════════════
  // M-TST-1: Exhaustive state machine transition coverage
  // ══════════════════════════════════════════════════════════════════════

  describe("Exhaustive state transitions", () => {
    // Tests organized by source state. Each valid outgoing transition
    // has at least one dedicated test. Terminal states confirm stability.

    // ── queued ─────────────────────────────────────────────────────

    describe("queued →", () => {
      it("→ ready when deps met (id in readyIds)", () => {
        orch = new Orchestrator({ wipLimit: 0 }); // prevent auto-launch
        orch.addItem(makeTodo("X-1-1"));
        orch.processTransitions(emptySnapshot(["X-1-1"]));
        expect(orch.getItem("X-1-1")!.state).toBe("ready");
      });

      it("stays queued when deps not met", () => {
        orch.addItem(makeTodo("X-1-1", ["X-1-0"]));
        orch.processTransitions(emptySnapshot([]));
        expect(orch.getItem("X-1-1")!.state).toBe("queued");
      });

      it("ignores snapshot data (ciStatus, prState, workerAlive)", () => {
        orch.addItem(makeTodo("X-1-1", ["X-1-0"]));
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "merged", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("queued");
      });
    });

    // ── ready ──────────────────────────────────────────────────────

    describe("ready →", () => {
      it("→ launching when WIP slots available", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ready");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
      });

      it("stays ready when WIP limit reached", () => {
        orch = new Orchestrator({ wipLimit: 1 });
        orch.addItem(makeTodo("X-1-1"));
        orch.addItem(makeTodo("X-1-2"));
        orch.setState("X-1-1", "implementing"); // uses 1 WIP slot
        orch.setState("X-1-2", "ready");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-2")!.state).toBe("ready");
      });

      it("emits launch action when transitioning", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ready");
        const actions = orch.processTransitions(emptySnapshot());
        expect(actions).toContainEqual({ type: "launch", itemId: "X-1-1" });
      });
    });

    // ── launching ──────────────────────────────────────────────────

    describe("launching →", () => {
      it("→ implementing when worker alive", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "launching");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("implementing");
      });

      it("→ stuck when worker dead", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "launching");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: false }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
      });

      it("stays launching when no snapshot for item", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "launching");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
      });

      it("stays launching when workerAlive is undefined", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "launching");
        orch.processTransitions(snapshotWith([{ id: "X-1-1" }]));
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
      });
    });

    // ── implementing ───────────────────────────────────────────────

    describe("implementing →", () => {
      it("→ pr-open when PR appears (no CI status)", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prNumber: 10, prState: "open", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.prNumber).toBe(10);
        expect(orch.getItem("X-1-1")!.state).toBe("pr-open");
      });

      it("→ stuck when worker dies without PR", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: false }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
      });

      it("stays implementing when worker alive but no PR yet", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("implementing");
      });

      it("stays implementing when no snapshot", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("implementing");
      });

      it("chains implementing → pr-open → merging when CI passes (asap)", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "implementing");
        const actions = orch.processTransitions(
          snapshotWith([{
            id: "X-1-1",
            prNumber: 50,
            prState: "open",
            ciStatus: "pass",
            workerAlive: true,
          }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(orch.getItem("X-1-1")!.prNumber).toBe(50);
        expect(actions.some((a) => a.type === "merge" && a.itemId === "X-1-1")).toBe(true);
      });
    });

    // ── pr-open ────────────────────────────────────────────────────

    describe("pr-open →", () => {
      it("→ ci-pending when CI starts", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-pending");
      });

      it("→ ci-failed when CI fails", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merging when CI passes (asap strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending when CI passes (approved strategy, no approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ merging when CI passes (approved strategy, with approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending when CI passes (ask strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "ask" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays pr-open when CI status unknown", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "unknown", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("pr-open");
      });

      it("stays pr-open with no snapshot", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("pr-open");
      });
    });

    // ── ci-pending ─────────────────────────────────────────────────

    describe("ci-pending →", () => {
      it("→ ci-failed when CI fails", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-pending");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merging when CI passes (asap strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending when CI passes (ask strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "ask" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-pending");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays ci-pending when CI still pending", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-pending");
      });
    });

    // ── ci-passed ──────────────────────────────────────────────────

    describe("ci-passed →", () => {
      it("→ merging (asap strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending (approved strategy, no approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ merging (approved strategy, with approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending (ask strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "ask" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ ci-failed when CI regresses to fail", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("re-evaluates merge on subsequent tick without ciStatus (asap)", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("increments ciFailCount when regressing to ci-failed", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-passed");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.ciFailCount).toBe(1);
      });
    });

    // ── ci-failed ──────────────────────────────────────────────────

    describe("ci-failed →", () => {
      it("→ ci-passed when CI recovers (pass), chains to evaluateMerge", () => {
        orch = new Orchestrator({ mergeStrategy: "ask" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 1;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ ci-pending when CI restarts (pending)", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 1;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-pending");
      });

      it("→ stuck when ciFailCount exceeds maxCiRetries", () => {
        orch = new Orchestrator({ maxCiRetries: 2 });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 3;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
      });

      it("→ merged when PR externally merged (takes priority)", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 1;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays ci-failed when CI still failing (within retry limit)", () => {
        orch = new Orchestrator({ maxCiRetries: 3 });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 1;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
      });

      it("does not increment ciFailCount when already ci-failed and still failing", () => {
        orch = new Orchestrator({ maxCiRetries: 5 });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 2;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.ciFailCount).toBe(2);
      });

      it("→ merging when CI recovers with asap strategy", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.ciFailCount = 1;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });
    });

    // ── review-pending ─────────────────────────────────────────────

    describe("review-pending →", () => {
      it("→ merging when review approved and CI passes (approved strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ merging when review approved (asap strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "asap" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays review-pending when review not approved", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending with ask strategy even when approved", () => {
        orch = new Orchestrator({ mergeStrategy: "ask" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending when CI not passing", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending with REVIEW_REQUIRED decision", () => {
        orch = new Orchestrator({ mergeStrategy: "approved" });
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "REVIEW_REQUIRED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });
    });

    // ── merging ────────────────────────────────────────────────────

    describe("merging →", () => {
      it("→ merged when PR state is merged", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "merging");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays merging when PR not yet merged", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "merging");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
      });

      it("stays merging with no snapshot", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "merging");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
      });
    });

    // ── merged ─────────────────────────────────────────────────────

    describe("merged →", () => {
      it("→ done (always, unconditionally) with mark-done action", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "merged");
        const actions = orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("done");
        expect(actions).toContainEqual({ type: "mark-done", itemId: "X-1-1" });
      });
    });

    // ── done (terminal) ────────────────────────────────────────────

    describe("done (terminal)", () => {
      it("never transitions regardless of any snapshot data", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "done");
        const actions = orch.processTransitions(
          snapshotWith(
            [{ id: "X-1-1", ciStatus: "pass", prState: "merged", workerAlive: true, reviewDecision: "APPROVED" }],
            ["X-1-1"],
          ),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("done");
        expect(actions).toHaveLength(0);
      });
    });

    // ── stuck (terminal) ───────────────────────────────────────────

    describe("stuck (terminal)", () => {
      it("never transitions regardless of any snapshot data", () => {
        orch.addItem(makeTodo("X-1-1"));
        orch.setState("X-1-1", "stuck");
        const actions = orch.processTransitions(
          snapshotWith(
            [{ id: "X-1-1", ciStatus: "pass", prState: "merged", workerAlive: true, reviewDecision: "APPROVED" }],
            ["X-1-1"],
          ),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
        expect(actions).toHaveLength(0);
      });
    });
  });

  // ── Invalid transition rejection ─────────────────────────────────

  describe("Invalid transitions are rejected", () => {
    it("queued does not jump to implementing even with workerAlive", () => {
      orch.addItem(makeTodo("X-1-1", ["X-1-0"])); // deps unmet
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("queued");
    });

    it("queued does not react to PR merged", () => {
      orch.addItem(makeTodo("X-1-1", ["X-1-0"]));
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prState: "merged", prNumber: 10 }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("queued");
    });

    it("queued does not react to CI pass", () => {
      orch.addItem(makeTodo("X-1-1", ["X-1-0"]));
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("queued");
    });

    it("ready does not skip to implementing", () => {
      orch = new Orchestrator({ wipLimit: 0 });
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "ready");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("ready");
    });

    it("ready does not react to PR data", () => {
      orch = new Orchestrator({ wipLimit: 0 });
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "ready");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prNumber: 10, prState: "merged", ciStatus: "pass" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("ready");
    });

    it("launching does not jump to merging on CI pass", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "launching");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("launching");
    });

    it("done does not re-enter merged", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "done");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prState: "merged" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("done");
    });

    it("stuck does not recover to implementing", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "stuck");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("stuck");
    });

    it("stuck does not react to CI pass", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "stuck");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("stuck");
    });

    it("stuck does not react to PR merged", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "stuck");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prState: "merged" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("stuck");
    });

    it("merging does not go to ci-failed on CI fail snapshot", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "merging");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("merging");
    });

    it("merged does not go back to ci-passed", () => {
      orch.addItem(makeTodo("X-1-1"));
      orch.setState("X-1-1", "merged");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
      );
      // merged → done (not back to ci-passed)
      expect(orch.getItem("X-1-1")!.state).toBe("done");
    });
  });

  // ── Dependency-gated transitions ─────────────────────────────────

  describe("Dependency-gated transitions", () => {
    it("item with single dependency stays queued until dep completes", () => {
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1", ["A-1-1"]));

      // A ready, B not in readyIds
      orch.processTransitions(emptySnapshot(["A-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("queued");

      // A done, B now in readyIds
      orch.setState("A-1-1", "done");
      orch.processTransitions(emptySnapshot(["B-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
    });

    it("item with multiple dependencies waits for all", () => {
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("A-1-2"));
      orch.addItem(makeTodo("B-1-1", ["A-1-1", "A-1-2"]));

      // Only A-1-1 in readyIds, B-1-1 not
      orch.processTransitions(emptySnapshot(["A-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("queued");

      // Both deps done, B now ready
      orch.setState("A-1-1", "done");
      orch.setState("A-1-2", "done");
      orch.processTransitions(emptySnapshot(["B-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
    });

    it("multi-level dependency chain (A → B → C)", () => {
      orch = new Orchestrator({ wipLimit: 1 });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1", ["A-1-1"]));
      orch.addItem(makeTodo("C-1-1", ["B-1-1"]));

      // Launch A
      orch.processTransitions(emptySnapshot(["A-1-1"]));
      expect(orch.getItem("A-1-1")!.state).toBe("launching");
      expect(orch.getItem("B-1-1")!.state).toBe("queued");
      expect(orch.getItem("C-1-1")!.state).toBe("queued");

      // A completes, B becomes ready
      orch.setState("A-1-1", "done");
      orch.processTransitions(emptySnapshot(["B-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
      expect(orch.getItem("C-1-1")!.state).toBe("queued");

      // B completes, C becomes ready
      orch.setState("B-1-1", "done");
      orch.processTransitions(emptySnapshot(["C-1-1"]));
      expect(orch.getItem("C-1-1")!.state).toBe("launching");
    });

    it("diamond dependency (A → C, B → C)", () => {
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1"));
      orch.addItem(makeTodo("C-1-1", ["A-1-1", "B-1-1"]));

      // Both A and B ready to launch, C stays queued
      orch.processTransitions(emptySnapshot(["A-1-1", "B-1-1"]));
      expect(orch.getItem("C-1-1")!.state).toBe("queued");

      // A done, B still in progress — C not ready
      orch.setState("A-1-1", "done");
      orch.processTransitions(emptySnapshot([]));
      expect(orch.getItem("C-1-1")!.state).toBe("queued");

      // Both done — C ready
      orch.setState("B-1-1", "done");
      orch.processTransitions(emptySnapshot(["C-1-1"]));
      expect(orch.getItem("C-1-1")!.state).toBe("launching");
    });

    it("independent items with no deps all launch immediately", () => {
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("A-1-2"));
      orch.addItem(makeTodo("A-1-3"));

      orch.processTransitions(emptySnapshot(["A-1-1", "A-1-2", "A-1-3"]));
      expect(orch.getItem("A-1-1")!.state).toBe("launching");
      expect(orch.getItem("A-1-2")!.state).toBe("launching");
      expect(orch.getItem("A-1-3")!.state).toBe("launching");
    });
  });

  // ── WIP-limited transitions ──────────────────────────────────────

  describe("WIP-limited transitions", () => {
    it("zero WIP limit prevents any launches", () => {
      orch = new Orchestrator({ wipLimit: 0 });
      orch.addItem(makeTodo("X-1-1"));
      orch.processTransitions(emptySnapshot(["X-1-1"]));
      expect(orch.getItem("X-1-1")!.state).toBe("ready");
    });

    it("exact WIP limit: all slots used, no new launches", () => {
      orch = new Orchestrator({ wipLimit: 2 });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("A-1-2"));
      orch.addItem(makeTodo("A-1-3"));
      orch.setState("A-1-1", "implementing");
      orch.setState("A-1-2", "ci-pending");
      orch.setState("A-1-3", "ready");

      orch.processTransitions(
        snapshotWith([
          { id: "A-1-1", workerAlive: true },
          { id: "A-1-2", ciStatus: "pending", prState: "open" },
        ]),
      );
      expect(orch.getItem("A-1-3")!.state).toBe("ready");
      expect(orch.wipCount).toBe(2);
    });

    it("WIP slot freed by done transition allows new launch in same tick", () => {
      orch = new Orchestrator({ wipLimit: 1 });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("A-1-2"));
      orch.setState("A-1-1", "merged");
      orch.setState("A-1-2", "ready");

      const actions = orch.processTransitions(emptySnapshot());
      expect(orch.getItem("A-1-1")!.state).toBe("done");
      expect(orch.getItem("A-1-2")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "launch")).toBe(true);
    });

    it("all WIP states count toward limit", () => {
      orch = new Orchestrator({ wipLimit: 8 });
      const wipStates: OrchestratorItemState[] = [
        "launching", "implementing", "pr-open", "ci-pending",
        "ci-passed", "ci-failed", "review-pending", "merging",
      ];
      wipStates.forEach((state, i) => {
        orch.addItem(makeTodo(`W-1-${i + 1}`));
        orch.setState(`W-1-${i + 1}`, state);
      });

      expect(orch.wipCount).toBe(8);
      expect(orch.wipSlots).toBe(0);
    });

    it("non-WIP states do not count toward limit", () => {
      orch = new Orchestrator({ wipLimit: 4 });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("A-1-2"));
      orch.addItem(makeTodo("A-1-3"));
      orch.addItem(makeTodo("A-1-4"));
      orch.setState("A-1-1", "queued");
      orch.setState("A-1-2", "ready");
      orch.setState("A-1-3", "done");
      orch.setState("A-1-4", "stuck");

      expect(orch.wipCount).toBe(0);
      expect(orch.wipSlots).toBe(4);
    });

    it("launches exactly up to WIP limit, no more", () => {
      orch = new Orchestrator({ wipLimit: 3 });
      for (let i = 1; i <= 5; i++) {
        orch.addItem(makeTodo(`X-1-${i}`));
      }

      const actions = orch.processTransitions(
        emptySnapshot(["X-1-1", "X-1-2", "X-1-3", "X-1-4", "X-1-5"]),
      );

      const launched = actions.filter((a) => a.type === "launch");
      expect(launched).toHaveLength(3);
      expect(orch.getItemsByState("launching")).toHaveLength(3);
      expect(orch.getItemsByState("ready")).toHaveLength(2);
    });

    it("merged state does not count toward WIP (allows launches)", () => {
      orch = new Orchestrator({ wipLimit: 1 });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1"));
      orch.setState("A-1-1", "merged");
      orch.setState("B-1-1", "ready");

      // merged is not WIP, so wipCount is 0, 1 slot available
      expect(orch.wipCount).toBe(0);
      const actions = orch.processTransitions(emptySnapshot());
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
    });
  });

  // ── Concurrent transitions in a single tick ──────────────────────

  describe("Concurrent transitions in a single tick", () => {
    it("multiple items transition independently in one call", () => {
      orch = new Orchestrator({ mergeStrategy: "asap" });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1"));
      orch.addItem(makeTodo("C-1-1"));
      orch.setState("A-1-1", "launching");
      orch.setState("B-1-1", "pr-open");
      orch.getItem("B-1-1")!.prNumber = 20;
      orch.setState("C-1-1", "merging");

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "A-1-1", workerAlive: true },
          { id: "B-1-1", ciStatus: "pass", prState: "open" },
          { id: "C-1-1", prState: "merged" },
        ]),
      );

      expect(orch.getItem("A-1-1")!.state).toBe("implementing");
      expect(orch.getItem("B-1-1")!.state).toBe("merging");
      expect(orch.getItem("C-1-1")!.state).toBe("merged");

      expect(actions.some((a) => a.type === "merge" && a.itemId === "B-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "clean" && a.itemId === "C-1-1")).toBe(true);
    });

    it("merged items free WIP slots for ready items in the same tick", () => {
      orch = new Orchestrator({ wipLimit: 1 });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1"));
      orch.setState("A-1-1", "merged");
      orch.setState("B-1-1", "ready");

      const actions = orch.processTransitions(emptySnapshot());

      expect(orch.getItem("A-1-1")!.state).toBe("done");
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "mark-done" && a.itemId === "A-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "launch" && a.itemId === "B-1-1")).toBe(true);
    });

    it("queued items promoted and launched in same tick", () => {
      orch.addItem(makeTodo("A-1-1"));
      const actions = orch.processTransitions(emptySnapshot(["A-1-1"]));
      expect(orch.getItem("A-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "launch" && a.itemId === "A-1-1")).toBe(true);
    });

    it("implementing → pr-open → ci-passed → merging chains in one tick", () => {
      orch = new Orchestrator({ mergeStrategy: "asap" });
      orch.addItem(makeTodo("A-1-1"));
      orch.setState("A-1-1", "implementing");

      const actions = orch.processTransitions(
        snapshotWith([{
          id: "A-1-1",
          prNumber: 50,
          prState: "open",
          ciStatus: "pass",
          workerAlive: true,
        }]),
      );

      expect(orch.getItem("A-1-1")!.state).toBe("merging");
      expect(orch.getItem("A-1-1")!.prNumber).toBe(50);
      expect(actions.some((a) => a.type === "merge" && a.itemId === "A-1-1")).toBe(true);
    });

    it("multiple CI failures in one tick all emit notify actions", () => {
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1"));
      orch.setState("A-1-1", "pr-open");
      orch.getItem("A-1-1")!.prNumber = 10;
      orch.setState("B-1-1", "ci-pending");
      orch.getItem("B-1-1")!.prNumber = 20;

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "A-1-1", ciStatus: "fail", prState: "open" },
          { id: "B-1-1", ciStatus: "fail", prState: "open" },
        ]),
      );

      expect(orch.getItem("A-1-1")!.state).toBe("ci-failed");
      expect(orch.getItem("B-1-1")!.state).toBe("ci-failed");
      const notifies = actions.filter((a) => a.type === "notify-ci-failure");
      expect(notifies).toHaveLength(2);
    });

    it("mixed: merge + CI fail + launch in one tick", () => {
      orch = new Orchestrator({ wipLimit: 3, mergeStrategy: "asap" });
      orch.addItem(makeTodo("A-1-1"));
      orch.addItem(makeTodo("B-1-1"));
      orch.addItem(makeTodo("C-1-1"));
      orch.setState("A-1-1", "merging");
      orch.getItem("A-1-1")!.prNumber = 10;
      orch.setState("B-1-1", "pr-open");
      orch.getItem("B-1-1")!.prNumber = 20;
      // C-1-1 starts queued

      const actions = orch.processTransitions(
        snapshotWith(
          [
            { id: "A-1-1", prState: "merged" },
            { id: "B-1-1", ciStatus: "fail", prState: "open" },
          ],
          ["C-1-1"],
        ),
      );

      expect(orch.getItem("A-1-1")!.state).toBe("merged");
      expect(orch.getItem("B-1-1")!.state).toBe("ci-failed");
      expect(orch.getItem("C-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "A-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "notify-ci-failure" && a.itemId === "B-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "launch" && a.itemId === "C-1-1")).toBe(true);
    });
  });

  // ── Crash recovery: state reconstruction ─────────────────────────

  describe("Crash recovery / state reconstruction", () => {
    it("reconstructed orchestrator resumes from saved states", () => {
      const orch2 = new Orchestrator({ mergeStrategy: "asap" });

      orch2.addItem(makeTodo("A-1-1"));
      orch2.setState("A-1-1", "implementing");

      orch2.addItem(makeTodo("B-1-1"));
      orch2.setState("B-1-1", "ci-passed");
      orch2.getItem("B-1-1")!.prNumber = 42;

      orch2.addItem(makeTodo("C-1-1", ["A-1-1", "B-1-1"]));

      const actions = orch2.processTransitions(
        snapshotWith([
          { id: "A-1-1", prNumber: 10, prState: "open", ciStatus: "pass", workerAlive: true },
          { id: "B-1-1", ciStatus: "pass", prState: "open" },
        ]),
      );

      // A-1-1: implementing → pr-open → ci-passed → merging (chained in one tick)
      expect(orch2.getItem("A-1-1")!.state).toBe("merging");
      expect(orch2.getItem("B-1-1")!.state).toBe("merging");
      expect(orch2.getItem("C-1-1")!.state).toBe("queued");
      expect(actions.filter((a) => a.type === "merge")).toHaveLength(2);
    });

    it("reconstructed state preserves ciFailCount", () => {
      const orch2 = new Orchestrator({ maxCiRetries: 2 });
      orch2.addItem(makeTodo("A-1-1"));
      orch2.setState("A-1-1", "ci-failed");
      orch2.getItem("A-1-1")!.ciFailCount = 3;

      orch2.processTransitions(
        snapshotWith([{ id: "A-1-1", ciStatus: "fail", prState: "open" }]),
      );

      expect(orch2.getItem("A-1-1")!.state).toBe("stuck");
    });

    it("reconstructed state preserves workspaceRef and prNumber", () => {
      const orch2 = new Orchestrator();
      orch2.addItem(makeTodo("A-1-1"));
      orch2.setState("A-1-1", "ci-failed");
      orch2.getItem("A-1-1")!.prNumber = 99;
      orch2.getItem("A-1-1")!.workspaceRef = "workspace:5";
      orch2.getItem("A-1-1")!.ciFailCount = 1;

      expect(orch2.getItem("A-1-1")!.prNumber).toBe(99);
      expect(orch2.getItem("A-1-1")!.workspaceRef).toBe("workspace:5");
      expect(orch2.getItem("A-1-1")!.ciFailCount).toBe(1);

      orch2.processTransitions(
        snapshotWith([{ id: "A-1-1", ciStatus: "pass", prState: "open" }]),
      );
      expect(orch2.getItem("A-1-1")!.state).toBe("merging");
    });

    it("fresh orchestrator handles items in all 13 states without errors", () => {
      const orch2 = new Orchestrator({ wipLimit: 10 });
      const allStates: OrchestratorItemState[] = [
        "queued", "ready", "launching", "implementing", "pr-open",
        "ci-pending", "ci-passed", "ci-failed", "review-pending",
        "merging", "merged", "done", "stuck",
      ];

      allStates.forEach((state, i) => {
        orch2.addItem(makeTodo(`R-1-${i + 1}`));
        orch2.setState(`R-1-${i + 1}`, state);
      });

      expect(allStates).toHaveLength(13);
      expect(() => {
        orch2.processTransitions(emptySnapshot());
      }).not.toThrow();
    });

    it("partial reconstruction: items at different lifecycle stages resume correctly", () => {
      const orch2 = new Orchestrator({ wipLimit: 5, mergeStrategy: "asap" });

      // Batch 1 items at various stages
      orch2.addItem(makeTodo("A-1-1"));
      orch2.setState("A-1-1", "done");

      orch2.addItem(makeTodo("A-1-2"));
      orch2.setState("A-1-2", "ci-pending");
      orch2.getItem("A-1-2")!.prNumber = 15;

      // Batch 2 item waiting on batch 1
      orch2.addItem(makeTodo("B-1-1", ["A-1-1"]));

      const actions = orch2.processTransitions(
        snapshotWith(
          [{ id: "A-1-2", ciStatus: "pass", prState: "open" }],
          ["B-1-1"],
        ),
      );

      expect(orch2.getItem("A-1-1")!.state).toBe("done");
      expect(orch2.getItem("A-1-2")!.state).toBe("merging");
      expect(orch2.getItem("B-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "merge" && a.itemId === "A-1-2")).toBe(true);
      expect(actions.some((a) => a.type === "launch" && a.itemId === "B-1-1")).toBe(true);
    });
  });
});
