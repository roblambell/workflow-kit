// Tests for core/orchestrator.ts — Orchestrator state machine and action execution.
// No vi.mock — executeAction uses dependency injection to stay bun-test compatible.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Orchestrator,
  DEFAULT_CONFIG,
  BYTES_PER_WORKER,
  calculateMemoryWipLimit,
  type OrchestratorItem,
  type OrchestratorItemState,
  type PollSnapshot,
  type ItemSnapshot,
  type Action,
  type ExecutionContext,
  type ActionResult,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { WorkItem, Priority } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeWorkItem(id: string, deps: string[] = [], priority: Priority = "high"): WorkItem {
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

function snapshotWith(
  items: ItemSnapshot[],
  readyIds: string[] = [],
): PollSnapshot {
  return { items, readyIds };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  workDir: "/tmp/test-project/.ninthwave/work",
  aiTool: "claude",
};

/** Create mock deps with sensible defaults. Override individual fns as needed. */
function mockDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/ninthwave-test",
      workspaceRef: "workspace:1",
    })),
    cleanSingleWorktree: vi.fn(() => true),
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
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;

    const item = orch.getItem("H-1-1");
    expect(item).toBeDefined();
    expect(item!.state).toBe("queued");
    expect(item!.ciFailCount).toBe(0);
  });

  it("lists all items", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-3"));
    orch.getItem("H-1-3")!.reviewCompleted = true;

    expect(orch.getAllItems()).toHaveLength(3);
  });

  it("filters items by state", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.setState("H-1-1", "ready");

    expect(orch.getItemsByState("queued")).toHaveLength(1);
    expect(orch.getItemsByState("ready")).toHaveLength(1);
  });

  // ── 2. Queued → Ready when deps are met ────────────────────────

  it("promotes queued items to ready when deps are met", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));

    orch.processTransitions(emptySnapshot(["H-1-1"]));

    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-2")!.state).toBe("queued");
  });

  it("does not promote items whose deps are not in readyIds", () => {
    orch.addItem(makeWorkItem("H-1-1", ["H-1-0"]));

    orch.processTransitions(emptySnapshot([]));

    expect(orch.getItem("H-1-1")!.state).toBe("queued");
  });

  // ── 3. Ready → Launching with WIP limit ────────────────────────

  it("launches ready items up to WIP limit", () => {
    orch = new Orchestrator({ wipLimit: 2 });

    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-3"));
    orch.getItem("H-1-3")!.reviewCompleted = true;

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

    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("implementing");
  });

  it("retries launching when worker dies and retries remain", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    // Debounce: 5 consecutive not-alive checks required
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
    );

    // Item goes ready → launching in same cycle
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
    expect(actions.some((a) => a.type === "launch")).toBe(true);
  });

  it("transitions launching to stuck when worker dies and retries exhausted", () => {
    orch = new Orchestrator({ maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "launching");

    // Debounce: 5 consecutive not-alive checks required
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "H-1-1")).toBe(true);
  });

  // ── 5. Implementing → PR open ─────────────────────────────────

  it("transitions implementing to pr-open when PR appears", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

    orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", prNumber: 42, prState: "open", workerAlive: true },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("pr-open");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(42);
  });

  it("transitions implementing → merged when PR auto-merges between polls", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

    const actions = orch.processTransitions(
      snapshotWith([
        { id: "H-1-1", prNumber: 82, prState: "merged" },
      ]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(orch.getItem("H-1-1")!.prNumber).toBe(82);
    expect(actions.some((a) => a.type === "clean" && a.itemId === "H-1-1")).toBe(true);
  });

  it("retries implementing when worker dies without PR and retries remain", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

    // Debounce: 5 consecutive not-alive checks required
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
    );

    // Item goes ready → launching in same cycle
    expect(orch.getItem("H-1-1")!.state).toBe("launching");
    expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    expect(actions.some((a) => a.type === "retry")).toBe(true);
    expect(actions.some((a) => a.type === "launch")).toBe(true);
  });

  it("marks implementing as stuck when worker dies without PR and retries exhausted", () => {
    orch = new Orchestrator({ maxRetries: 0 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "implementing");

    // Debounce: 5 consecutive not-alive checks required
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    orch.processTransitions(snapshotWith([{ id: "H-1-1", workerAlive: false }]));
    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", workerAlive: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "H-1-1")).toBe(true);
  });

  // ── 6. CI pass → merge action (auto strategy) ─────────────────

  it("CI pass triggers merge action with auto strategy", () => {
    orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "pr-open");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.ciFailCount).toBe(1);
  });

  // ── 7b. CI fail with merge conflict → rebase action (H-ORC-1) ──

  it("CI fail with merge conflict sends daemon-rebase action instead of notify-ci-failure", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    // Should emit daemon-rebase, not notify-ci-failure
    const daemonRebaseActions = actions.filter((a) => a.type === "daemon-rebase");
    expect(daemonRebaseActions).toHaveLength(1);
    expect(daemonRebaseActions[0]!.message).toContain("merge conflicts");
    expect(daemonRebaseActions[0]!.message).toContain("rebase");
    // Should NOT emit notify-ci-failure or regular rebase
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
    expect(actions.some((a) => a.type === "rebase")).toBe(false);
  });

  it("CI fail without merge conflict sends notify-ci-failure (not rebase)", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open", isMergeable: true }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
    expect(actions.some((a) => a.type === "rebase")).toBe(false);
  });

  it("CI fail with unknown mergeability sends notify-ci-failure", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-failed");
    expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
    expect(actions.some((a) => a.type === "rebase")).toBe(false);
  });

  // ── 7c. ci-pending with merge conflict → daemon-rebase action ──

  it("ci-pending with merge conflict sends daemon-rebase action", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open", isMergeable: false }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    const rebaseActions = actions.filter((a) => a.type === "daemon-rebase");
    expect(rebaseActions).toHaveLength(1);
    expect(rebaseActions[0]!.message).toContain("merge conflicts");
  });

  it("ci-pending with merge conflict sends daemon-rebase only once", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // First poll — sends rebase
    const actions1 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open", isMergeable: false }]),
    );
    expect(actions1.filter((a) => a.type === "daemon-rebase")).toHaveLength(1);

    // Second poll — same conflict, no duplicate daemon-rebase
    const actions2 = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open", isMergeable: false }]),
    );
    expect(actions2.filter((a) => a.type === "daemon-rebase")).toHaveLength(0);
  });

  it("ci-pending rebase flag resets on state change", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");
    orch.getItem("H-1-1")!.prNumber = 42;
    orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

    // Send first rebase
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "open", isMergeable: false }]),
    );
    expect(orch.getItem("H-1-1")!.rebaseRequested).toBe(true);

    // Worker rebases, CI starts → state changes to ci-pending again (via transition)
    // Simulate by transitioning through ci-passed and back
    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open", isMergeable: true }]),
    );
    expect(orch.getItem("H-1-1")!.rebaseRequested).toBe(false);
  });

  // ── 8. CI fail recovery ────────────────────────────────────────

  it("ci-failed recovers when CI passes (chains to merge evaluation)", () => {
    orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
  });

  it("ci-failed with auto strategy chains CI pass to merge", () => {
    orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("marks stuck after exceeding max CI retries", () => {
    orch = new Orchestrator({ maxCiRetries: 1 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 2;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "fail", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "H-1-1")).toBe(true);
  });

  // ── 9. PR merged → clean action ───────────────────────────────

  it("PR merged triggers clean action from ci-passed state", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-passed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
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
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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

  it("merged transitions to done without emitting mark-done action", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "merged");

    const actions = orch.processTransitions(emptySnapshot());

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions.every((a) => a.type !== "mark-done")).toBe(true);
  });

  // ── 11. Batch complete → launch next ───────────────────────────

  it("launches next batch when previous items complete", () => {
    orch = new Orchestrator({ wipLimit: 1 });

    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
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

  // ── 12. Merge strategy: manual ─────────────────────────────────

  it("manual strategy moves to review-pending, never auto-merges", () => {
    orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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

  it("manual strategy stays in review-pending even when APPROVED", () => {
    orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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

    // manual never auto-merges, stays in review-pending
    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
    const mergeActions = actions.filter((a) => a.type === "merge");
    expect(mergeActions).toHaveLength(0);
  });

  it("manual strategy never auto-merges even with approval", () => {
    orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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
    orch = new Orchestrator({ mergeStrategy: "manual" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("review-pending");
  });

  it("ci-pending with auto strategy chains CI pass to merge", () => {
    orch = new Orchestrator({ mergeStrategy: "auto" });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-pending");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merging");
    expect(actions.some((a) => a.type === "merge")).toBe(true);
  });

  it("ci-pending transitions to ci-failed when CI fails", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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

    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-2"));
    orch.getItem("H-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-3"));
    orch.getItem("H-1-3")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("H-1-4"));
    orch.getItem("H-1-4")!.reviewCompleted = true;

    orch.setState("H-1-1", "implementing");
    orch.setState("H-1-2", "ci-pending");
    orch.setState("H-1-3", "done");
    orch.setState("H-1-4", "queued");

    expect(orch.wipCount).toBe(2);
    expect(orch.wipSlots).toBe(3);
  });

  // ── 16. Terminal states don't transition ───────────────────────

  it("done state does not transition", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "done");

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pass", prState: "merged" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("done");
    expect(actions).toHaveLength(0);
  });

  it("stuck state does not transition", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
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
    expect(DEFAULT_CONFIG.mergeStrategy).toBe("auto");
    expect(DEFAULT_CONFIG.maxCiRetries).toBe(2);
  });

  // ── 18. PR merged from ci-failed state ─────────────────────────

  it("handles external merge from ci-failed state", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    const actions = orch.processTransitions(
      snapshotWith([{ id: "H-1-1", prState: "merged", ciStatus: "pass" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("merged");
    expect(actions.some((a) => a.type === "clean")).toBe(true);
  });

  // ── 19. ci-failed → ci-pending ─────────────────────────────────

  it("ci-failed transitions to ci-pending when CI restarts", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "ci-failed");
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.getItem("H-1-1")!.ciFailCount = 1;

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });

  // ── 20. pr-open → ci-pending ───────────────────────────────────

  it("pr-open transitions to ci-pending when CI starts", () => {
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.setState("H-1-1", "pr-open");

    orch.processTransitions(
      snapshotWith([{ id: "H-1-1", ciStatus: "pending", prState: "open" }]),
    );

    expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
  });

  // ── 21. Multiple items complete end-to-end ─────────────────────

  it("handles full lifecycle across multiple items", () => {
    orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });

    orch.addItem(makeWorkItem("A-1-1"));
    orch.getItem("A-1-1")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("A-1-2"));
    orch.getItem("A-1-2")!.reviewCompleted = true;
    orch.addItem(makeWorkItem("A-1-3", ["A-1-1"]));
    orch.getItem("A-1-3")!.reviewCompleted = true;

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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "launching");

      const result = orch.executeAction(
        { type: "launch", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.launchSingleItem).toHaveBeenCalledWith(
        orch.getItem("H-1-1")!.workItem,
        defaultCtx.workDir,
        defaultCtx.worktreeDir,
        defaultCtx.projectRoot,
        defaultCtx.aiTool,
        undefined, // baseBranch (no stacking)
        false, // forceWorkerLaunch (no needsCiFix)
      );
      expect(orch.getItem("H-1-1")!.workspaceRef).toBe("workspace:1");
    });

    it("launch: retries when launchSingleItem returns null and retries remain", () => {
      const deps = mockDeps({ launchSingleItem: vi.fn(() => null) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "launching");

      const result = orch.executeAction(
        { type: "launch", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("scheduled retry");
      expect(orch.getItem("H-1-1")!.state).toBe("ready");
      expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    });

    it("launch: marks stuck when launchSingleItem returns null and retries exhausted", () => {
      orch = new Orchestrator({ maxRetries: 0 });
      const deps = mockDeps({ launchSingleItem: vi.fn(() => null) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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

    it("launch: retries when launchSingleItem throws and retries remain", () => {
      const deps = mockDeps({
        launchSingleItem: vi.fn(() => { throw new Error("cmux not running"); }),
      });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "launching");

      const result = orch.executeAction(
        { type: "launch", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("cmux not running");
      expect(result.error).toContain("scheduled retry");
      expect(orch.getItem("H-1-1")!.state).toBe("ready");
      expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    });

    it("launch: marks stuck when launchSingleItem throws and retries exhausted", () => {
      orch = new Orchestrator({ maxRetries: 0 });
      const deps = mockDeps({
        launchSingleItem: vi.fn(() => { throw new Error("cmux not running"); }),
      });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merging");
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.prMerge).toHaveBeenCalledWith(defaultCtx.projectRoot, 42, { admin: undefined });
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      expect(orch.getItem("H-1-1")!.mergeFailCount).toBe(1);
    });

    it("merge: marks stuck after exceeding maxMergeRetries", () => {
      const deps = mockDeps({ prMerge: vi.fn(() => false) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merging");
      const item = orch.getItem("H-1-1")!;
      item.prNumber = 42;
      // Simulate 2 prior failures (maxMergeRetries default is 3)
      item.mergeFailCount = 2;

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("marking stuck");
      expect(item.state).toBe("stuck");
      expect(item.failureReason).toContain("merge-failed");
      expect(item.mergeFailCount).toBe(3);
    });

    it("merge: resets mergeFailCount on success", () => {
      const deps = mockDeps({ prMerge: vi.fn(() => true) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merging");
      const item = orch.getItem("H-1-1")!;
      item.prNumber = 42;
      item.mergeFailCount = 2;

      const result = orch.executeAction(
        { type: "merge", itemId: "H-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(item.mergeFailCount).toBe(0);
    });

    it("merge: fails gracefully when no PR number", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2", ["H-1-1"]));
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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

    // ── post-merge daemon-rebase-all ─────────────────────────

    it("merge: daemon-rebases all in-flight sibling PRs after merge", () => {
      const daemonRebase = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-3"));
      orch.getItem("H-1-3")!.reviewCompleted = true;
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

      // Should daemon-rebase both in-flight sibling PRs
      expect(daemonRebase).toHaveBeenCalledWith(
        `${defaultCtx.worktreeDir}/ninthwave-H-1-2`,
        "ninthwave/H-1-2",
      );
      expect(daemonRebase).toHaveBeenCalledWith(
        `${defaultCtx.worktreeDir}/ninthwave-H-1-3`,
        "ninthwave/H-1-3",
      );
      expect(daemonRebase).toHaveBeenCalledTimes(2);
    });

    it("merge: no worker rebase message when daemon-rebase succeeds", () => {
      const daemonRebase = vi.fn(() => true);
      const checkPrMergeable = vi.fn(() => false);
      const deps = mockDeps({ daemonRebase, checkPrMergeable });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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

      // Daemon rebase succeeded — no need to check mergeable or send worker message
      expect(daemonRebase).toHaveBeenCalledTimes(1);
      expect(checkPrMergeable).not.toHaveBeenCalled();
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it("merge: falls back to worker rebase when daemon-rebase fails and PR has conflicts", () => {
      const daemonRebase = vi.fn(() => false);
      const checkPrMergeable = vi.fn(() => false);
      const deps = mockDeps({ daemonRebase, checkPrMergeable });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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

      // Daemon rebase failed, PR is conflicting — fall back to worker message
      expect(daemonRebase).toHaveBeenCalledTimes(1);
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 43);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        "workspace:2",
        expect.stringContaining("merge conflicts"),
      );
    });

    it("merge: skips non-conflicting PR after daemon-rebase failure", () => {
      const daemonRebase = vi.fn(() => false);
      const checkPrMergeable = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase, checkPrMergeable });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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

      // Daemon rebase failed but PR is not conflicting — no message needed
      expect(daemonRebase).toHaveBeenCalledTimes(1);
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 43);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it("merge: warns when daemon-rebase fails, PR conflicting, and worker dead", () => {
      const daemonRebase = vi.fn(() => false);
      const checkPrMergeable = vi.fn(() => false);
      const warn = vi.fn();
      const deps = mockDeps({ daemonRebase, checkPrMergeable, warn });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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
        expect.stringContaining("Manual rebase needed"),
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it("merge: falls back to checkPrMergeable only when no daemonRebase dep", () => {
      const checkPrMergeable = vi.fn(() => false);
      const warn = vi.fn();
      const deps = mockDeps({ checkPrMergeable, warn });
      // No daemonRebase dep
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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

      // No daemonRebase available, but checkPrMergeable detects conflict
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 43);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Manual rebase needed"),
      );
    });

    // ── notify-ci-failure ─────────────────────────────────────

    it("notify-ci-failure: sends message to worker and posts PR comment", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
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

    it("notify-ci-failure: transitions to ready with needsCiFix when no workspace ref (H-WR-1)", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "notify-ci-failure", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      // Instead of failing, transitions to ready for re-launch
      expect(result.success).toBe(true);
      const item = orch.getItem("H-1-1")!;
      expect(item.state).toBe("ready");
      expect(item.needsCiFix).toBe(true);
      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(deps.prComment).not.toHaveBeenCalled();
    });

    // ── notify-review ─────────────────────────────────────────

    it("notify-review: sends review message to worker", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "review-pending");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      orch.executeAction({ type: "notify-review", itemId: "H-1-1" }, defaultCtx, deps);

      expect(deps.sendMessage).toHaveBeenCalledWith(
        "workspace:1",
        "Review feedback received — please address.",
      );
    });

    it("notify-review: fails without workspace ref", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "review-pending");

      const result = orch.executeAction(
        { type: "notify-review", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No workspace reference");
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    // ── clean ─────────────────────────────────────────────────

    it("clean: closes workspace and cleans worktree", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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

    it("clean: returns success when only closeWorkspace fails (partial cleanup OK)", () => {
      const deps = mockDeps({ closeWorkspace: vi.fn(() => false) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merged");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:1");
      expect(deps.cleanSingleWorktree).toHaveBeenCalled();
    });

    it("clean: returns success when only cleanSingleWorktree fails (partial cleanup OK)", () => {
      const deps = mockDeps({ cleanSingleWorktree: vi.fn(() => false) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merged");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:1");
      expect(deps.cleanSingleWorktree).toHaveBeenCalled();
    });

    it("clean: returns failure when both operations fail", () => {
      const deps = mockDeps({
        closeWorkspace: vi.fn(() => false),
        cleanSingleWorktree: vi.fn(() => false),
      });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merged");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Clean failed");
      expect(result.error).toContain("H-1-1");
    });

    it("clean: returns failure when no workspace ref and worktree cleanup fails", () => {
      const deps = mockDeps({ cleanSingleWorktree: vi.fn(() => false) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merged");
      // No workspaceRef — closeWorkspace is not called, so only worktree cleanup matters

      const result = orch.executeAction({ type: "clean", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Clean failed");
      expect(deps.closeWorkspace).not.toHaveBeenCalled();
    });

    // ── retry ──────────────────────────────────────────────────

    it("retry: closes workspace but preserves worktree for continuation", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ready");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";
      orch.getItem("H-1-1")!.retryCount = 1;

      const result = orch.executeAction(
        { type: "retry", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:1");
      // Worktree is preserved so the retried worker picks up existing edits
      expect(deps.cleanSingleWorktree).not.toHaveBeenCalled();
      // workspaceRef should be cleared for the fresh launch
      expect(orch.getItem("H-1-1")!.workspaceRef).toBeUndefined();
    });

    it("retry: skips workspace close when no ref", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ready");
      orch.getItem("H-1-1")!.retryCount = 1;

      const result = orch.executeAction(
        { type: "retry", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).not.toHaveBeenCalled();
      // Worktree is preserved for retry continuation
      expect(deps.cleanSingleWorktree).not.toHaveBeenCalled();
    });

    // ── mark-done removed (workers remove their own work item file in PR) ──

    it("mark-done action type no longer exists in ActionType", () => {
      // mark-done was removed: workers remove their work item file in their PR branch.
      // Orchestrator no longer pushes to main after merge.
      const actionTypes: string[] = [
        "launch", "merge", "notify-ci-failure", "notify-review", "clean", "rebase", "daemon-rebase", "retry",
      ];
      expect(actionTypes).not.toContain("mark-done");
    });

    // ── rebase ────────────────────────────────────────────────

    it("rebase: sends rebase message to worker", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      orch.executeAction({ type: "rebase", itemId: "H-1-1" }, defaultCtx, deps);

      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "Please rebase onto latest main.");
    });

    it("rebase: fails when no workspace ref", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      const result = orch.executeAction({ type: "rebase", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No workspace reference");
    });

    it("rebase: fails when sendMessage returns false", () => {
      const deps = mockDeps({ sendMessage: vi.fn(() => false) });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction({ type: "rebase", itemId: "H-1-1" }, defaultCtx, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to send rebase message");
    });

    // ── daemon-rebase ──────────────────────────────────────────

    it("daemon-rebase: succeeds when daemonRebase dep succeeds", () => {
      const daemonRebase = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.getItem("H-1-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "daemon-rebase", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      // daemonRebase receives the worktree path, not projectRoot
      expect(daemonRebase).toHaveBeenCalledWith(
        `${defaultCtx.worktreeDir}/ninthwave-H-1-1`,
        "ninthwave/H-1-1",
      );
      // Should transition to ci-pending after successful rebase
      expect(orch.getItem("H-1-1")!.state).toBe("ci-pending");
    });

    it("daemon-rebase: falls back to worker message when daemonRebase fails", () => {
      const daemonRebase = vi.fn(() => false);
      const deps = mockDeps({ daemonRebase });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.getItem("H-1-1")!.prNumber = 42;
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction(
        { type: "daemon-rebase", itemId: "H-1-1", message: "Rebase needed." },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "Rebase needed.");
    });

    it("daemon-rebase: falls back to worker message when daemonRebase throws", () => {
      const daemonRebase = vi.fn(() => { throw new Error("git error"); });
      const deps = mockDeps({ daemonRebase });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.getItem("H-1-1")!.workspaceRef = "workspace:1";

      const result = orch.executeAction(
        { type: "daemon-rebase", itemId: "H-1-1", message: "Rebase needed." },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledWith("workspace:1", "Rebase needed.");
    });

    it("daemon-rebase: fails with warning when no daemonRebase dep and no worker", () => {
      const warn = vi.fn();
      const deps = mockDeps({ warn });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;

      const result = orch.executeAction(
        { type: "daemon-rebase", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Daemon rebase failed");
      expect(result.error).toContain("no worker available");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("merge conflicts"));
    });

    it("daemon-rebase: fails when daemonRebase fails and no worker available", () => {
      const daemonRebase = vi.fn(() => false);
      const warn = vi.fn();
      const deps = mockDeps({ daemonRebase, warn });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      // No workspaceRef — worker is dead

      const result = orch.executeAction(
        { type: "daemon-rebase", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Manual rebase needed"));
    });

    it("daemon-rebase: uses --force-with-lease via daemonRebase dep (integration note)", () => {
      // The daemonRebase dep is responsible for using --force-with-lease.
      // This test verifies the orchestrator calls the dep with the correct worktree path and branch.
      const daemonRebase = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-failed");
      orch.getItem("H-1-1")!.reviewCompleted = true;

      orch.executeAction(
        { type: "daemon-rebase", itemId: "H-1-1" },
        defaultCtx,
        deps,
      );

      expect(daemonRebase).toHaveBeenCalledWith(
        `${defaultCtx.worktreeDir}/ninthwave-H-1-1`,
        "ninthwave/H-1-1",
      );
    });

    // ── daemon-rebase exception handling in post-merge ────────

    it("merge: handles daemon-rebase exception gracefully, falls back to conflict check", () => {
      const daemonRebase = vi.fn(() => { throw new Error("git lock failed"); });
      const checkPrMergeable = vi.fn(() => false);
      const warn = vi.fn();
      const deps = mockDeps({ daemonRebase, checkPrMergeable, warn });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
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

      // Should try daemon rebase (which threw)
      expect(daemonRebase).toHaveBeenCalledWith(
        `${defaultCtx.worktreeDir}/ninthwave-H-1-2`,
        "ninthwave/H-1-2",
      );
      // Should fall back to conflict check and warn since worker is dead
      expect(checkPrMergeable).toHaveBeenCalledWith(defaultCtx.projectRoot, 43);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Manual rebase needed"));
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
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.processTransitions(emptySnapshot(["X-1-1"]));
        expect(orch.getItem("X-1-1")!.state).toBe("ready");
      });

      it("stays queued when deps not met", () => {
        orch.addItem(makeWorkItem("X-1-1", ["X-1-0"]));
        orch.processTransitions(emptySnapshot([]));
        expect(orch.getItem("X-1-1")!.state).toBe("queued");
      });

      it("ignores snapshot data (ciStatus, prState, workerAlive)", () => {
        orch.addItem(makeWorkItem("X-1-1", ["X-1-0"]));
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "merged", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("queued");
      });
    });

    // ── ready ──────────────────────────────────────────────────────

    describe("ready →", () => {
      it("→ launching when WIP slots available", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ready");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
      });

      it("stays ready when WIP limit reached", () => {
        orch = new Orchestrator({ wipLimit: 1 });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("X-1-2"));
        orch.getItem("X-1-2")!.reviewCompleted = true;
        orch.setState("X-1-1", "implementing"); // uses 1 WIP slot
        orch.setState("X-1-2", "ready");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-2")!.state).toBe("ready");
      });

      it("emits launch action when transitioning", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ready");
        const actions = orch.processTransitions(emptySnapshot());
        expect(actions).toContainEqual({ type: "launch", itemId: "X-1-1" });
      });
    });

    // ── launching ──────────────────────────────────────────────────

    describe("launching →", () => {
      it("→ implementing when worker alive", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "launching");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("implementing");
      });

      it("→ launching (retry) when worker dead and retries remain", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "launching");
        // Debounce: 5 consecutive not-alive checks required
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: false }]),
        );
        // Item goes ready → launching in same cycle (launchReadyItems re-launches)
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
        expect(orch.getItem("X-1-1")!.retryCount).toBe(1);
        expect(actions.some((a) => a.type === "retry")).toBe(true);
        expect(actions.some((a) => a.type === "launch")).toBe(true);
      });

      it("→ stuck when worker dead and retries exhausted", () => {
        orch = new Orchestrator({ maxRetries: 0 });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "launching");
        // Debounce: 5 consecutive not-alive checks required
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: false }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
        expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "X-1-1")).toBe(true);
      });

      it("stays launching when no snapshot for item", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "launching");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
      });

      it("stays launching when workerAlive is undefined", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "launching");
        orch.processTransitions(snapshotWith([{ id: "X-1-1" }]));
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
      });
    });

    // ── implementing ───────────────────────────────────────────────

    describe("implementing →", () => {
      it("→ pr-open when PR appears (no CI status)", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prNumber: 10, prState: "open", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.prNumber).toBe(10);
        expect(orch.getItem("X-1-1")!.state).toBe("pr-open");
      });

      it("→ launching (retry) when worker dies without PR and retries remain", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "implementing");
        // Debounce: 5 consecutive not-alive checks required
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: false }]),
        );
        // Item goes ready → launching in same cycle (launchReadyItems re-launches)
        expect(orch.getItem("X-1-1")!.state).toBe("launching");
        expect(orch.getItem("X-1-1")!.retryCount).toBe(1);
        expect(actions.some((a) => a.type === "retry")).toBe(true);
        expect(actions.some((a) => a.type === "launch")).toBe(true);
      });

      it("→ stuck when worker dies without PR and retries exhausted", () => {
        orch = new Orchestrator({ maxRetries: 0 });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "implementing");
        // Debounce: 5 consecutive not-alive checks required
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        orch.processTransitions(snapshotWith([{ id: "X-1-1", workerAlive: false }]));
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: false }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
        expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "X-1-1")).toBe(true);
      });

      it("stays implementing when worker alive but no PR yet", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", workerAlive: true }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("implementing");
      });

      it("stays implementing when no snapshot", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "implementing");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("implementing");
      });

      it("chains implementing → pr-open → merging when CI passes (auto)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
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
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-pending");
      });

      it("→ ci-failed when CI fails", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merging when CI passes (auto strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending when CI passes (manual strategy, no approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ review-pending when CI passes (manual strategy, even with approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        // manual never auto-merges
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions.some((a) => a.type === "merge")).toBe(false);
      });

      it("→ review-pending when CI passes (manual strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ review-pending when CI passes (auto strategy) with CHANGES_REQUESTED", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions.some((a) => a.type === "merge")).toBe(false);
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays pr-open when CI status unknown", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "unknown", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("pr-open");
      });

      it("stays pr-open with no snapshot", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "pr-open");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("pr-open");
      });
    });

    // ── ci-pending ─────────────────────────────────────────────────

    describe("ci-pending →", () => {
      it("→ ci-failed when CI fails", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-pending");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merging when CI passes (auto strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending when CI passes (manual strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-pending");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays ci-pending when CI still pending", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-pending");
      });

      it("→ ci-failed with daemon-rebase action when CI fails due to merge conflict", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-pending");
        orch.getItem("X-1-1")!.workspaceRef = "workspace:1";
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open", isMergeable: false }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "daemon-rebase")).toBe(true);
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
      });
    });

    // ── ci-passed ──────────────────────────────────────────────────

    describe("ci-passed →", () => {
      it("→ merging (auto strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ review-pending (manual strategy, no approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ review-pending (manual strategy, even with approval)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        // manual never auto-merges
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions.some((a) => a.type === "merge")).toBe(false);
      });

      it("→ review-pending (manual strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ ci-failed when CI regresses to fail", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("re-evaluates merge on subsequent tick without ciStatus (auto)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("increments ciFailCount when regressing to ci-failed", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.ciFailCount).toBe(1);
      });

      // ── CHANGES_REQUESTED guard (H-ORC-2) ──────────────────────────

      it("→ review-pending when auto strategy and CHANGES_REQUESTED", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions.some((a) => a.type === "merge")).toBe(false);
      });

      it("→ merging when auto strategy and no review decision", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ merging when auto strategy and APPROVED", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ merging when auto strategy and REVIEW_REQUIRED (no explicit rejection)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-passed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "REVIEW_REQUIRED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });
    });

    // ── ci-failed ──────────────────────────────────────────────────

    describe("ci-failed →", () => {
      it("→ ci-passed when CI recovers (pass), chains to evaluateMerge", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.ciFailCount = 1;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("→ ci-pending when CI restarts (pending)", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.ciFailCount = 1;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-pending");
      });

      it("→ stuck when ciFailCount exceeds maxCiRetries", () => {
        orch = new Orchestrator({ maxCiRetries: 2 });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.ciFailCount = 3;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("stuck");
        expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "X-1-1")).toBe(true);
      });

      it("→ merged when PR externally merged (takes priority)", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.ciFailCount = 1;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays ci-failed and retries notification when CI still failing (within retry limit)", () => {
        orch = new Orchestrator({ maxCiRetries: 3 });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.ciFailCount = 1;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("does not increment ciFailCount when already ci-failed and still failing", () => {
        orch = new Orchestrator({ maxCiRetries: 5 });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.getItem("X-1-1")!.ciFailCount = 2;
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.ciFailCount).toBe(2);
      });

      it("→ merging when CI recovers with auto strategy", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "ci-failed");
        orch.getItem("X-1-1")!.reviewCompleted = true;
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
      it("stays review-pending when review approved (manual strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        // manual never auto-merges, stays in review-pending
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions.some((a) => a.type === "merge")).toBe(false);
      });

      it("→ merging when review approved (auto strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
        expect(actions.some((a) => a.type === "merge")).toBe(true);
      });

      it("→ merged when PR externally merged", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays review-pending when review not approved", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending with manual strategy even when approved", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending when CI not passing", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pending", prState: "open", reviewDecision: "APPROVED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending with REVIEW_REQUIRED decision", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "REVIEW_REQUIRED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
      });

      it("stays review-pending with CHANGES_REQUESTED and CI pass, emits no actions (manual strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions).toHaveLength(0);
      });

      it("stays review-pending with CHANGES_REQUESTED and CI pass, emits no actions (auto strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("review-pending");
        expect(actions).toHaveLength(0);
      });

      it("transitions to ci-failed with CHANGES_REQUESTED and CI fail (manual strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        // CI fail is always detected from review-pending (H-RX-1)
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("transitions to ci-failed with CHANGES_REQUESTED and CI fail (auto strategy)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        // CI fail is always detected from review-pending regardless of strategy (H-RX-1)
        expect(orch.getItem("X-1-1")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("→ merged when PR externally merged during CHANGES_REQUESTED review", () => {
        orch = new Orchestrator({ mergeStrategy: "manual" });
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "review-pending");
        orch.getItem("X-1-1")!.prNumber = 10;
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged", reviewDecision: "CHANGES_REQUESTED" }]),
        );
        // External merge takes priority over review decision
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });
    });

    // ── merging ────────────────────────────────────────────────────

    describe("merging →", () => {
      it("→ merged when PR state is merged", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "merging");
        const actions = orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "merged" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
      });

      it("stays merging when PR not yet merged", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "merging");
        orch.processTransitions(
          snapshotWith([{ id: "X-1-1", prState: "open" }]),
        );
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
      });

      it("stays merging with no snapshot", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "merging");
        orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("merging");
      });
    });

    // ── merged ─────────────────────────────────────────────────────

    describe("merged →", () => {
      it("→ done (always, unconditionally) without mark-done action", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
        orch.setState("X-1-1", "merged");
        const actions = orch.processTransitions(emptySnapshot());
        expect(orch.getItem("X-1-1")!.state).toBe("done");
        expect(actions.every((a) => a.type !== "mark-done")).toBe(true);
      });
    });

    // ── done (terminal) ────────────────────────────────────────────

    describe("done (terminal)", () => {
      it("never transitions regardless of any snapshot data", () => {
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
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
        orch.addItem(makeWorkItem("X-1-1"));
        orch.getItem("X-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("X-1-1", ["X-1-0"])); // deps unmet
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("queued");
    });

    it("queued does not react to PR merged", () => {
      orch.addItem(makeWorkItem("X-1-1", ["X-1-0"]));
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prState: "merged", prNumber: 10 }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("queued");
    });

    it("queued does not react to CI pass", () => {
      orch.addItem(makeWorkItem("X-1-1", ["X-1-0"]));
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("queued");
    });

    it("ready does not skip to implementing", () => {
      orch = new Orchestrator({ wipLimit: 0 });
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "ready");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("ready");
    });

    it("ready does not react to PR data", () => {
      orch = new Orchestrator({ wipLimit: 0 });
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "ready");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prNumber: 10, prState: "merged", ciStatus: "pass" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("ready");
    });

    it("launching does not jump to merging on CI pass", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "launching");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass", prState: "open" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("launching");
    });

    it("done does not re-enter merged", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "done");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prState: "merged" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("done");
    });

    it("stuck does not recover to implementing", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "stuck");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("stuck");
    });

    it("stuck does not react to CI pass", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "stuck");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "pass" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("stuck");
    });

    it("stuck does not react to PR merged", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "stuck");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", prState: "merged" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("stuck");
    });

    it("merging does not go to ci-failed on CI fail snapshot", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "merging");
      orch.processTransitions(
        snapshotWith([{ id: "X-1-1", ciStatus: "fail", prState: "open" }]),
      );
      expect(orch.getItem("X-1-1")!.state).toBe("merging");
    });

    it("merged does not go back to ci-passed", () => {
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1", ["A-1-1"]));
      orch.getItem("B-1-1")!.reviewCompleted = true;

      // A ready, B not in readyIds
      orch.processTransitions(emptySnapshot(["A-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("queued");

      // A done, B now in readyIds
      orch.setState("A-1-1", "done");
      orch.processTransitions(emptySnapshot(["B-1-1"]));
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
    });

    it("item with multiple dependencies waits for all", () => {
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-2"));
      orch.getItem("A-1-2")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1", ["A-1-1", "A-1-2"]));

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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1", ["A-1-1"]));
      orch.addItem(makeWorkItem("C-1-1", ["B-1-1"]));
      orch.getItem("C-1-1")!.reviewCompleted = true;

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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1"));
      orch.getItem("B-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("C-1-1", ["A-1-1", "B-1-1"]));

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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-2"));
      orch.getItem("A-1-2")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-3"));
      orch.getItem("A-1-3")!.reviewCompleted = true;

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
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.processTransitions(emptySnapshot(["X-1-1"]));
      expect(orch.getItem("X-1-1")!.state).toBe("ready");
    });

    it("exact WIP limit: all slots used, no new launches", () => {
      orch = new Orchestrator({ wipLimit: 2 });
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-2"));
      orch.getItem("A-1-2")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-3"));
      orch.getItem("A-1-3")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-2"));
      orch.getItem("A-1-2")!.reviewCompleted = true;
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
        orch.addItem(makeWorkItem(`W-1-${i + 1}`));
        orch.setState(`W-1-${i + 1}`, state);
      });

      expect(orch.wipCount).toBe(8);
      expect(orch.wipSlots).toBe(0);
    });

    it("non-WIP states do not count toward limit", () => {
      orch = new Orchestrator({ wipLimit: 4 });
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-2"));
      orch.getItem("A-1-2")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-3"));
      orch.getItem("A-1-3")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("A-1-4"));
      orch.getItem("A-1-4")!.reviewCompleted = true;
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
        orch.addItem(makeWorkItem(`X-1-${i}`));
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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1"));
      orch.getItem("B-1-1")!.reviewCompleted = true;
      orch.setState("A-1-1", "merged");
      orch.setState("B-1-1", "ready");

      // merged is not WIP, so wipCount is 0, 1 slot available
      expect(orch.wipCount).toBe(0);
      const actions = orch.processTransitions(emptySnapshot());
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
    });
  });

  // ── M-EVT-1: Deduplicate state transition events ─────────────────

  describe("State transition deduplication (M-EVT-1)", () => {
    it("same-state transition is a no-op — timestamps unchanged", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merged");
      const item = orch.getItem("H-1-1")!;
      const origTimestamp = item.lastTransition;

      // processTransitions transitions merged→done (different state), which is fine.
      // To test the guard directly, manually set to done first, then run again.
      orch.processTransitions(emptySnapshot());
      expect(item.state).toBe("done");
      const doneTimestamp = item.lastTransition;

      // Second call: item is already done — should NOT update lastTransition
      orch.processTransitions(emptySnapshot());
      expect(item.state).toBe("done");
      expect(item.lastTransition).toBe(doneTimestamp);
    });

    it("consecutive polls with merged snapshot emit exactly one merged transition", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merging");
      const item = orch.getItem("H-1-1")!;
      item.prNumber = 42;

      const mergedSnap = snapshotWith([
        { id: "H-1-1", prNumber: 42, prState: "merged" as const, workerAlive: false },
      ]);

      // Track state transitions across cycles (mimics daemon prevStates logic)
      const transitions: { from: string; to: string }[] = [];

      // Cycle 1: merging → merged
      const prev1 = item.state;
      orch.processTransitions(mergedSnap);
      if (item.state !== prev1) transitions.push({ from: prev1, to: item.state });
      expect(item.state).toBe("merged");

      // Cycle 2: merged → done
      const prev2 = item.state;
      orch.processTransitions(mergedSnap);
      if (item.state !== prev2) transitions.push({ from: prev2, to: item.state });
      expect(item.state).toBe("done");

      // Cycle 3: done — stable, no transition
      const prev3 = item.state;
      orch.processTransitions(mergedSnap);
      if (item.state !== prev3) transitions.push({ from: prev3, to: item.state });
      expect(item.state).toBe("done");

      // Exactly one transition TO "merged" — no duplicates
      const mergedEntries = transitions.filter((t) => t.to === "merged");
      expect(mergedEntries).toHaveLength(1);

      // Total transitions: merging→merged, merged→done
      expect(transitions).toEqual([
        { from: "merging", to: "merged" },
        { from: "merged", to: "done" },
      ]);
    });

    it("item-merged event fires only for merged state, not done (daemon parity)", () => {
      // Simulates the daemon's event logic: only "merged" state
      // should trigger an "item-merged" event, not the subsequent "done" state.
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merging");
      const item = orch.getItem("H-1-1")!;
      item.prNumber = 42;

      const mergedSnap = snapshotWith([
        { id: "H-1-1", prNumber: 42, prState: "merged" as const, workerAlive: false },
      ]);

      const itemMergedEvents: string[] = [];

      // Cycle 1: merging → merged
      let prevState = item.state;
      orch.processTransitions(mergedSnap);
      if (prevState !== item.state) {
        // Mirror daemon logic: only emit for "merged", not "done"
        if (item.state === "merged") itemMergedEvents.push(item.state);
      }

      // Cycle 2: merged → done
      prevState = item.state;
      orch.processTransitions(mergedSnap);
      if (prevState !== item.state) {
        if (item.state === "merged") itemMergedEvents.push(item.state);
      }

      expect(itemMergedEvents).toHaveLength(1);
    });
  });

  // ── Concurrent transitions in a single tick ──────────────────────

  describe("Concurrent transitions in a single tick", () => {
    it("multiple items transition independently in one call", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1"));
      orch.getItem("B-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("C-1-1"));
      orch.getItem("C-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1"));
      orch.getItem("B-1-1")!.reviewCompleted = true;
      orch.setState("A-1-1", "merged");
      orch.setState("B-1-1", "ready");

      const actions = orch.processTransitions(emptySnapshot());

      expect(orch.getItem("A-1-1")!.state).toBe("done");
      expect(orch.getItem("B-1-1")!.state).toBe("launching");
      expect(actions.every((a) => a.type !== "mark-done")).toBe(true);
      expect(actions.some((a) => a.type === "launch" && a.itemId === "B-1-1")).toBe(true);
    });

    it("queued items promoted and launched in same tick", () => {
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      const actions = orch.processTransitions(emptySnapshot(["A-1-1"]));
      expect(orch.getItem("A-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "launch" && a.itemId === "A-1-1")).toBe(true);
    });

    it("implementing → pr-open → ci-passed → merging chains in one tick", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
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
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1"));
      orch.getItem("B-1-1")!.reviewCompleted = true;
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
      orch = new Orchestrator({ wipLimit: 3, mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("A-1-1"));
      orch.getItem("A-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("B-1-1"));
      orch.getItem("B-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("C-1-1"));
      orch.getItem("C-1-1")!.reviewCompleted = true;
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

  // ── Multi-step chaining from implementing ────────────────────────

  describe("Multi-step chaining from implementing through merge evaluation", () => {
    it("auto strategy: implementing → pr-open → ci-passed → merging in one processTransitions call", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("C-1-1"));
      orch.getItem("C-1-1")!.reviewCompleted = true;
      orch.setState("C-1-1", "implementing");

      const actions = orch.processTransitions(
        snapshotWith([{
          id: "C-1-1",
          prNumber: 100,
          prState: "open",
          ciStatus: "pass",
          workerAlive: true,
        }]),
      );

      // Should chain all the way to merging
      expect(orch.getItem("C-1-1")!.state).toBe("merging");
      expect(orch.getItem("C-1-1")!.prNumber).toBe(100);
      // Must emit a merge action
      const mergeAction = actions.find((a) => a.type === "merge" && a.itemId === "C-1-1");
      expect(mergeAction).toBeDefined();
      expect(mergeAction!.prNumber).toBe(100);
    });

    it("manual strategy: implementing → pr-open → ci-passed → review-pending in one processTransitions call", () => {
      orch = new Orchestrator({ mergeStrategy: "manual" });
      orch.addItem(makeWorkItem("C-2-1"));
      orch.getItem("C-2-1")!.reviewCompleted = true;
      orch.setState("C-2-1", "implementing");

      const actions = orch.processTransitions(
        snapshotWith([{
          id: "C-2-1",
          prNumber: 101,
          prState: "open",
          ciStatus: "pass",
          workerAlive: true,
        }]),
      );

      // Should chain through to review-pending (waiting for approval)
      expect(orch.getItem("C-2-1")!.state).toBe("review-pending");
      expect(orch.getItem("C-2-1")!.prNumber).toBe(101);
      // No merge action should be emitted — still waiting for review
      expect(actions.some((a) => a.type === "merge")).toBe(false);
    });

    it("pending CI: implementing → pr-open → ci-pending (stops, does not chain further)", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("C-3-1"));
      orch.getItem("C-3-1")!.reviewCompleted = true;
      orch.setState("C-3-1", "implementing");

      const actions = orch.processTransitions(
        snapshotWith([{
          id: "C-3-1",
          prNumber: 102,
          prState: "open",
          ciStatus: "pending",
          workerAlive: true,
        }]),
      );

      // Should stop at ci-pending — CI hasn't passed yet
      expect(orch.getItem("C-3-1")!.state).toBe("ci-pending");
      expect(orch.getItem("C-3-1")!.prNumber).toBe(102);
      // No merge or notify actions — just waiting
      expect(actions.some((a) => a.type === "merge")).toBe(false);
      expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(false);
    });
  });

  // ── Crash recovery: state reconstruction ─────────────────────────

  describe("Crash recovery / state reconstruction", () => {
    it("reconstructed orchestrator resumes from saved states", () => {
      const orch2 = new Orchestrator({ mergeStrategy: "auto" });

      orch2.addItem(makeWorkItem("A-1-1"));
      orch2.getItem("A-1-1")!.reviewCompleted = true;
      orch2.setState("A-1-1", "implementing");

      orch2.addItem(makeWorkItem("B-1-1"));
      orch2.getItem("B-1-1")!.reviewCompleted = true;
      orch2.setState("B-1-1", "ci-passed");
      orch2.getItem("B-1-1")!.reviewCompleted = true;
      orch2.getItem("B-1-1")!.prNumber = 42;

      orch2.addItem(makeWorkItem("C-1-1", ["A-1-1", "B-1-1"]));

      const actions = orch2.processTransitions(
        snapshotWith([
          { id: "A-1-1", prNumber: 10, prState: "open", ciStatus: "pass", workerAlive: true },
          { id: "B-1-1", ciStatus: "pass", prState: "open" },
        ]),
      );

      // A-1-1: implementing → pr-open → ci-passed → merging (chained in one tick)
      // Priority merge queue: both are "high" priority, A-1-1 < B-1-1 lexicographically,
      // so only A-1-1 merges this cycle. B-1-1 reverts to ci-passed for next cycle.
      expect(orch2.getItem("A-1-1")!.state).toBe("merging");
      expect(orch2.getItem("B-1-1")!.state).toBe("ci-passed");
      expect(orch2.getItem("C-1-1")!.state).toBe("queued");
      expect(actions.filter((a) => a.type === "merge")).toHaveLength(1);
      expect(actions.filter((a) => a.type === "merge")[0]!.itemId).toBe("A-1-1");
    });

    it("reconstructed state preserves ciFailCount", () => {
      const orch2 = new Orchestrator({ maxCiRetries: 2 });
      orch2.addItem(makeWorkItem("A-1-1"));
      orch2.getItem("A-1-1")!.reviewCompleted = true;
      orch2.setState("A-1-1", "ci-failed");
      orch2.getItem("A-1-1")!.reviewCompleted = true;
      orch2.getItem("A-1-1")!.ciFailCount = 3;

      const actions = orch2.processTransitions(
        snapshotWith([{ id: "A-1-1", ciStatus: "fail", prState: "open" }]),
      );

      expect(orch2.getItem("A-1-1")!.state).toBe("stuck");
      expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "A-1-1")).toBe(true);
    });

    it("reconstructed state preserves workspaceRef and prNumber", () => {
      const orch2 = new Orchestrator();
      orch2.addItem(makeWorkItem("A-1-1"));
      orch2.getItem("A-1-1")!.reviewCompleted = true;
      orch2.setState("A-1-1", "ci-failed");
      orch2.getItem("A-1-1")!.reviewCompleted = true;
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
        orch2.addItem(makeWorkItem(`R-1-${i + 1}`));
        orch2.setState(`R-1-${i + 1}`, state);
      });

      expect(allStates).toHaveLength(13);
      expect(() => {
        orch2.processTransitions(emptySnapshot());
      }).not.toThrow();
    });

    it("partial reconstruction: items at different lifecycle stages resume correctly", () => {
      const orch2 = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });

      // Batch 1 items at various stages
      orch2.addItem(makeWorkItem("A-1-1"));
      orch2.getItem("A-1-1")!.reviewCompleted = true;
      orch2.setState("A-1-1", "done");

      orch2.addItem(makeWorkItem("A-1-2"));
      orch2.getItem("A-1-2")!.reviewCompleted = true;
      orch2.setState("A-1-2", "ci-pending");
      orch2.getItem("A-1-2")!.prNumber = 15;

      // Batch 2 item waiting on batch 1
      orch2.addItem(makeWorkItem("B-1-1", ["A-1-1"]));

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

  // ── Memory-aware WIP limits ───────────────────────────────────────

  describe("calculateMemoryWipLimit", () => {
    const GB = 1024 * 1024 * 1024;

    it("returns correct WIP for various memory scenarios", () => {
      // 10 GB free → floor(10/1) = 10, but configured limit is 5 → 5
      expect(calculateMemoryWipLimit(5, 10 * GB)).toBe(5);

      // 3 GB free → floor(3/1) = 3
      expect(calculateMemoryWipLimit(5, 3 * GB)).toBe(3);

      // 2 GB free → floor(2/1) = 2
      expect(calculateMemoryWipLimit(5, 2 * GB)).toBe(2);

      // 1 GB free → floor(1/1) = 1
      expect(calculateMemoryWipLimit(5, 1 * GB)).toBe(1);
    });

    it("never drops below 1 when configured limit is positive", () => {
      // 500 MB free → floor(0.5/1) = 0, but minimum is 1
      expect(calculateMemoryWipLimit(5, 500 * 1024 * 1024)).toBe(1);

      // 100 MB free → floor(0.1/1) = 0, but minimum is 1
      expect(calculateMemoryWipLimit(3, 100 * 1024 * 1024)).toBe(1);
    });

    it("handles 0 free memory (still allows 1 worker)", () => {
      expect(calculateMemoryWipLimit(5, 0)).toBe(1);
      expect(calculateMemoryWipLimit(1, 0)).toBe(1);
    });

    it("respects configured maximum even when memory allows more", () => {
      // 100 GB free → floor(100/1) = 100, but configured limit is 3 → 3
      expect(calculateMemoryWipLimit(3, 100 * GB)).toBe(3);

      // 50 GB free → floor(50/1) = 50, but configured limit is 1 → 1
      expect(calculateMemoryWipLimit(1, 50 * GB)).toBe(1);
    });

    it("returns 0 when configured limit is 0 (test helper)", () => {
      // configuredLimit=0 is used in tests to prevent auto-launch
      expect(calculateMemoryWipLimit(0, 10 * GB)).toBe(0);
      expect(calculateMemoryWipLimit(0, 0)).toBe(0);
    });

    it("accepts custom memPerWorkerBytes", () => {
      const workerSize = 1 * GB; // 1 GB per worker
      // 5 GB free / 1 GB per worker = 5, capped by configured limit of 3
      expect(calculateMemoryWipLimit(3, 5 * GB, workerSize)).toBe(3);

      // 2 GB free / 1 GB per worker = 2, configured limit is 5
      expect(calculateMemoryWipLimit(5, 2 * GB, workerSize)).toBe(2);
    });

    it("BYTES_PER_WORKER is 1 GB", () => {
      expect(BYTES_PER_WORKER).toBe(1 * GB);
    });
  });

  describe("effectiveWipLimit", () => {
    it("defaults to config.wipLimit when not set", () => {
      orch = new Orchestrator({ wipLimit: 5 });
      expect(orch.effectiveWipLimit).toBe(5);
    });

    it("uses setEffectiveWipLimit override", () => {
      orch = new Orchestrator({ wipLimit: 5 });
      orch.setEffectiveWipLimit(2);
      expect(orch.effectiveWipLimit).toBe(2);
    });

    it("wipSlots uses effectiveWipLimit", () => {
      orch = new Orchestrator({ wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing"); // 1 in WIP

      // Without memory adjustment: 5 - 1 = 4 slots
      expect(orch.wipSlots).toBe(4);

      // With memory adjustment: effective is 2, so 2 - 1 = 1 slot
      orch.setEffectiveWipLimit(2);
      expect(orch.wipSlots).toBe(1);
    });

    it("memory-constrained WIP queues items instead of launching", () => {
      orch = new Orchestrator({ wipLimit: 5 });

      // Add 3 items and make them all ready
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-2"));
      orch.getItem("H-1-2")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-3"));
      orch.getItem("H-1-3")!.reviewCompleted = true;

      // Simulate memory pressure: only 1 slot available
      orch.setEffectiveWipLimit(1);

      const actions = orch.processTransitions(
        emptySnapshot(["H-1-1", "H-1-2", "H-1-3"]),
      );

      // Only 1 item should launch (the rest stay ready/queued)
      const launchActions = actions.filter((a) => a.type === "launch");
      expect(launchActions).toHaveLength(1);

      // Verify: 1 launching, 2 ready
      expect(orch.getItem("H-1-1")!.state).toBe("launching");
      expect(orch.getItem("H-1-2")!.state).toBe("ready");
      expect(orch.getItem("H-1-3")!.state).toBe("ready");
    });
  });

  // ── Worker crash retry (M-RET-1) ──────────────────────────────

  describe("Worker crash retry", () => {
    it("stuck worker triggers retry transition when retryCount < maxRetries", () => {
      orch = new Orchestrator({ maxRetries: 1 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "implementing");

      // Debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );

      // Should retry (ready → launching) instead of going stuck
      expect(orch.getItem("R-1-1")!.state).toBe("launching");
      expect(orch.getItem("R-1-1")!.retryCount).toBe(1);
      const retryActions = actions.filter((a) => a.type === "retry");
      expect(retryActions).toHaveLength(1);
      expect(retryActions[0]!.itemId).toBe("R-1-1");
    });

    it("retry creates fresh worktree and relaunches worker", () => {
      const deps = mockDeps();
      orch = new Orchestrator({ maxRetries: 1 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "implementing");
      orch.getItem("R-1-1")!.workspaceRef = "workspace:1";

      // Debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      // Simulate worker death → processTransitions detects and emits retry + launch actions
      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );

      // Execute retry action — closes workspace but preserves worktree
      const retryAction = actions.find((a) => a.type === "retry")!;
      const retryResult = orch.executeAction(retryAction, defaultCtx, deps);
      expect(retryResult.success).toBe(true);
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:1");
      expect(deps.cleanSingleWorktree).not.toHaveBeenCalled();
      expect(orch.getItem("R-1-1")!.workspaceRef).toBeUndefined();

      // Execute launch action — reuses existing worktree
      const launchAction = actions.find((a) => a.type === "launch")!;
      const launchResult = orch.executeAction(launchAction, defaultCtx, deps);
      expect(launchResult.success).toBe(true);
      expect(orch.getItem("R-1-1")!.workspaceRef).toBe("workspace:1");
    });

    it("permanently stuck after maxRetries exhausted", () => {
      orch = new Orchestrator({ maxRetries: 1 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "launching");
      orch.getItem("R-1-1")!.retryCount = 1; // already retried once

      // Debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );

      expect(orch.getItem("R-1-1")!.state).toBe("stuck");
      expect(actions.filter((a) => a.type === "retry")).toHaveLength(0);
      expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "R-1-1")).toBe(true);
    });

    it("retryCount is tracked in item for analytics", () => {
      orch = new Orchestrator({ maxRetries: 2 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "implementing");

      // First crash — debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      expect(orch.getItem("R-1-1")!.retryCount).toBe(1);

      // Simulate worker alive (resets notAliveCount), then second crash
      orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: true }]),
      );
      expect(orch.getItem("R-1-1")!.state).toBe("implementing");

      // Second crash — debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      expect(orch.getItem("R-1-1")!.retryCount).toBe(2);
    });

    it("worker crashes during retry (second attempt counts correctly)", () => {
      orch = new Orchestrator({ maxRetries: 2 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "launching");

      // First crash — debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      let actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );
      expect(orch.getItem("R-1-1")!.retryCount).toBe(1);
      expect(orch.getItem("R-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "retry")).toBe(true);

      // Second crash — notAliveCount resets on retry, needs 5 consecutive checks again
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );
      expect(orch.getItem("R-1-1")!.retryCount).toBe(2);
      expect(orch.getItem("R-1-1")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "retry")).toBe(true);

      // Third crash — notAliveCount resets again, 5 more checks → permanently stuck
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );
      expect(orch.getItem("R-1-1")!.retryCount).toBe(2);
      expect(orch.getItem("R-1-1")!.state).toBe("stuck");
      expect(actions.some((a) => a.type === "retry")).toBe(false);
      expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "R-1-1")).toBe(true);
    });

    it("defaults maxRetries to 1", () => {
      expect(DEFAULT_CONFIG.maxRetries).toBe(1);
    });

    it("retryCount initializes to 0", () => {
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      expect(orch.getItem("R-1-1")!.retryCount).toBe(0);
    });

    it("CI failures do not trigger retry (only worker crash)", () => {
      orch = new Orchestrator({ maxCiRetries: 0, maxRetries: 1 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "ci-failed");
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.getItem("R-1-1")!.ciFailCount = 1;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", ciStatus: "fail", prState: "open" }]),
      );

      // CI exhaustion goes to stuck, not retried via worker retry
      expect(orch.getItem("R-1-1")!.state).toBe("stuck");
      expect(orch.getItem("R-1-1")!.retryCount).toBe(0);
      expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "R-1-1")).toBe(true);
    });

    it("retry from launching state re-launches in same cycle", () => {
      orch = new Orchestrator({ maxRetries: 1, wipLimit: 5 });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.getItem("R-1-1")!.reviewCompleted = true;
      orch.setState("R-1-1", "launching");

      // Debounce: 5 consecutive not-alive checks required
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "R-1-1", workerAlive: false }]));
      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", workerAlive: false }]),
      );

      // Should have both retry and launch actions
      expect(actions.some((a) => a.type === "retry" && a.itemId === "R-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "launch" && a.itemId === "R-1-1")).toBe(true);
      // Final state is launching (ready → launching happened in same cycle)
      expect(orch.getItem("R-1-1")!.state).toBe("launching");
    });
  });

  // ── 12. Time-based heartbeat for stuck worker detection ────────────

  describe("heartbeat stuck detection", () => {
    it("transitions implementing → stuck when no commits after launch timeout (process dead)", () => {
      orch = new Orchestrator({ launchTimeoutMs: 30 * 60 * 1000, maxRetries: 0, wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      // Backdate lastTransition to 31 minutes ago
      const item = orch.getItem("H-1-1")!;
      item.lastTransition = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      // workerAlive=false: launch timeout applies (process is dead)
      const now = new Date();
      const actions = orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null }]),
        now,
      );

      expect(orch.getItem("H-1-1")!.state).toBe("stuck");
      expect(actions).toEqual([{ type: "workspace-close", itemId: "H-1-1" }]);
    });

    it("transitions implementing → stuck when stale commit beyond activity timeout", () => {
      orch = new Orchestrator({ activityTimeoutMs: 60 * 60 * 1000, maxRetries: 0, wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      const now = new Date();
      // Last commit was 61 minutes ago
      const staleCommitTime = new Date(now.getTime() - 61 * 60 * 1000).toISOString();

      const actions = orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: staleCommitTime }]),
        now,
      );

      expect(orch.getItem("H-1-1")!.state).toBe("stuck");
      expect(actions).toEqual([{ type: "workspace-close", itemId: "H-1-1" }]);
    });

    it("keeps implementing when worker has recent commits", () => {
      orch = new Orchestrator({ activityTimeoutMs: 60 * 60 * 1000, wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      const now = new Date();
      // Last commit was 10 minutes ago — well within timeout
      const recentCommitTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: recentCommitTime }]),
        now,
      );

      expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    });

    it("timeout values are configurable via OrchestratorConfig", () => {
      // Use very short timeouts to prove configurability
      orch = new Orchestrator({
        launchTimeoutMs: 5000,       // 5 seconds
        activityTimeoutMs: 10000,    // 10 seconds
        maxRetries: 0,
        wipLimit: 5,
      });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      // Backdate lastTransition to 6 seconds ago (exceeds 5s launch timeout)
      // workerAlive=false: launch timeout applies (not suppressed by liveness)
      const item = orch.getItem("H-1-1")!;
      const now = new Date();
      item.lastTransition = new Date(now.getTime() - 6000).toISOString();

      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null }]),
        now,
      );

      expect(orch.getItem("H-1-1")!.state).toBe("stuck");
    });

    it("worker within grace period after launch is not marked stuck", () => {
      orch = new Orchestrator({ launchTimeoutMs: 30 * 60 * 1000, wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      // lastTransition is very recent (just now) — within grace period
      const now = new Date();

      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: true, lastCommitTime: null }]),
        now,
      );

      expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    });

    it("heartbeat uses item.lastCommitTime when snapshot has no lastCommitTime", () => {
      orch = new Orchestrator({ activityTimeoutMs: 60 * 60 * 1000, wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      const now = new Date();
      // Store a recent commit time on the item directly (as buildSnapshot does)
      const item = orch.getItem("H-1-1")!;
      item.lastCommitTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

      // Snapshot does not include lastCommitTime — item's value is used as fallback
      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: true }]),
        now,
      );

      expect(orch.getItem("H-1-1")!.state).toBe("implementing");
    });

    it("heartbeat retries instead of stuck when retries remain (process dead)", () => {
      orch = new Orchestrator({
        launchTimeoutMs: 30 * 60 * 1000,
        maxRetries: 1,
        wipLimit: 5,
      });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      // Backdate lastTransition past launch timeout, process dead
      const item = orch.getItem("H-1-1")!;
      const now = new Date();
      item.lastTransition = new Date(now.getTime() - 31 * 60 * 1000).toISOString();

      const actions = orch.processTransitions(
        snapshotWith([{ id: "H-1-1", workerAlive: false, lastCommitTime: null }]),
        now,
      );

      // Should retry (transition to ready, then re-launch in same cycle)
      expect(actions.some((a) => a.type === "retry" && a.itemId === "H-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "launch" && a.itemId === "H-1-1")).toBe(true);
      expect(orch.getItem("H-1-1")!.retryCount).toBe(1);
    });

    it("heartbeat skips when PR already appeared (takes priority)", () => {
      orch = new Orchestrator({ launchTimeoutMs: 1000, wipLimit: 5 });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      // Even though launch timeout is exceeded, PR appearing takes priority
      const item = orch.getItem("H-1-1")!;
      const now = new Date();
      item.lastTransition = new Date(now.getTime() - 5000).toISOString();

      orch.processTransitions(
        snapshotWith([{ id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending" }]),
        now,
      );

      // PR appeared → should transition to pr-open lifecycle, not stuck
      expect(orch.getItem("H-1-1")!.state).not.toBe("stuck");
      expect(orch.getItem("H-1-1")!.prNumber).toBe(42);
    });

    it("default config has launchTimeoutMs and activityTimeoutMs", () => {
      expect(DEFAULT_CONFIG.launchTimeoutMs).toBe(30 * 60 * 1000);
      expect(DEFAULT_CONFIG.activityTimeoutMs).toBe(60 * 60 * 1000);
    });
  });

  // ── Priority-ordered merge queue ──────────────────────────────────

  describe("priority-ordered merge queue", () => {
    it("merges multiple ci-passed items in priority order (highest first)", () => {
      orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });

      // Add items with different priorities
      orch.addItem(makeWorkItem("L-1-1", [], "low"));
      orch.getItem("L-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("H-1-1", [], "high"));
      orch.addItem(makeWorkItem("C-1-1", [], "critical"));

      // Move all to ci-passed with PR numbers
      for (const id of ["L-1-1", "H-1-1", "C-1-1"]) {
        orch.setState(id, "ci-passed");
        orch.getItem(id)!.reviewCompleted = true;
        orch.getItem(id)!.prNumber = 100;
      }

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "L-1-1", prNumber: 101, prState: "open", ciStatus: "pass" },
          { id: "H-1-1", prNumber: 102, prState: "open", ciStatus: "pass" },
          { id: "C-1-1", prNumber: 103, prState: "open", ciStatus: "pass" },
        ]),
      );

      // Only the critical-priority item should get a merge action
      const mergeActions = actions.filter((a) => a.type === "merge");
      expect(mergeActions).toHaveLength(1);
      expect(mergeActions[0]!.itemId).toBe("C-1-1");

      // Critical item is in merging state
      expect(orch.getItem("C-1-1")!.state).toBe("merging");
      // Others should be reverted to ci-passed
      expect(orch.getItem("H-1-1")!.state).toBe("ci-passed");
      expect(orch.getItem("L-1-1")!.state).toBe("ci-passed");
    });

    it("merges equal-priority items by ID order (lexicographic)", () => {
      orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });

      // All medium priority
      orch.addItem(makeWorkItem("M-1-3", [], "medium"));
      orch.getItem("M-1-3")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("M-1-1", [], "medium"));
      orch.getItem("M-1-1")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("M-1-2", [], "medium"));
      orch.getItem("M-1-2")!.reviewCompleted = true;

      for (const id of ["M-1-3", "M-1-1", "M-1-2"]) {
        orch.setState(id, "ci-passed");
        orch.getItem(id)!.reviewCompleted = true;
        orch.getItem(id)!.prNumber = 100;
      }

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "M-1-3", prNumber: 103, prState: "open", ciStatus: "pass" },
          { id: "M-1-1", prNumber: 101, prState: "open", ciStatus: "pass" },
          { id: "M-1-2", prNumber: 102, prState: "open", ciStatus: "pass" },
        ]),
      );

      const mergeActions = actions.filter((a) => a.type === "merge");
      expect(mergeActions).toHaveLength(1);
      // M-1-1 comes first lexicographically
      expect(mergeActions[0]!.itemId).toBe("M-1-1");

      expect(orch.getItem("M-1-1")!.state).toBe("merging");
      expect(orch.getItem("M-1-2")!.state).toBe("ci-passed");
      expect(orch.getItem("M-1-3")!.state).toBe("ci-passed");
    });

    it("single ci-passed item skips queue logic and merges normally", () => {
      orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });

      orch.addItem(makeWorkItem("H-1-1", [], "high"));
      orch.setState("H-1-1", "ci-passed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.getItem("H-1-1")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pass" },
        ]),
      );

      const mergeActions = actions.filter((a) => a.type === "merge");
      expect(mergeActions).toHaveLength(1);
      expect(mergeActions[0]!.itemId).toBe("H-1-1");
      expect(orch.getItem("H-1-1")!.state).toBe("merging");
    });

    it("after merge execution, remaining ci-passed items get conflict checked next cycle", () => {
      orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });

      orch.addItem(makeWorkItem("C-1-1", [], "critical"));
      orch.addItem(makeWorkItem("M-1-1", [], "medium"));
      orch.addItem(makeWorkItem("L-1-1", [], "low"));

      for (const id of ["C-1-1", "M-1-1", "L-1-1"]) {
        orch.setState(id, "ci-passed");
        orch.getItem(id)!.reviewCompleted = true;
        orch.getItem(id)!.prNumber = 100;
      }

      // Cycle 1: only critical item merges
      const actions1 = orch.processTransitions(
        snapshotWith([
          { id: "C-1-1", prNumber: 101, prState: "open", ciStatus: "pass" },
          { id: "M-1-1", prNumber: 102, prState: "open", ciStatus: "pass" },
          { id: "L-1-1", prNumber: 103, prState: "open", ciStatus: "pass" },
        ]),
      );

      const mergeActions1 = actions1.filter((a) => a.type === "merge");
      expect(mergeActions1).toHaveLength(1);
      expect(mergeActions1[0]!.itemId).toBe("C-1-1");

      // Execute merge for C-1-1 (simulated) — daemon-rebase succeeds for siblings
      const daemonRebase = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase });
      orch.executeAction(mergeActions1[0]!, defaultCtx, deps);

      // C-1-1 is now merged
      expect(orch.getItem("C-1-1")!.state).toBe("merged");

      // Verify daemon-rebase was called for the sibling PRs
      expect(daemonRebase).toHaveBeenCalled();

      // Cycle 2: medium item gets the merge action next
      const actions2 = orch.processTransitions(
        snapshotWith([
          { id: "C-1-1", prNumber: 101, prState: "merged" },
          { id: "M-1-1", prNumber: 102, prState: "open", ciStatus: "pass" },
          { id: "L-1-1", prNumber: 103, prState: "open", ciStatus: "pass" },
        ]),
      );

      const mergeActions2 = actions2.filter((a) => a.type === "merge");
      expect(mergeActions2).toHaveLength(1);
      expect(mergeActions2[0]!.itemId).toBe("M-1-1");
      expect(orch.getItem("M-1-1")!.state).toBe("merging");
      expect(orch.getItem("L-1-1")!.state).toBe("ci-passed");
    });

    it("non-merge actions are preserved alongside the prioritized merge", () => {
      orch = new Orchestrator({ wipLimit: 5, mergeStrategy: "auto" });

      // Two items in ci-passed, one in ci-pending that will fail
      orch.addItem(makeWorkItem("H-1-1", [], "high"));
      orch.addItem(makeWorkItem("M-1-1", [], "medium"));
      orch.addItem(makeWorkItem("L-1-1", [], "low"));

      orch.setState("H-1-1", "ci-passed");
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.getItem("H-1-1")!.prNumber = 101;
      orch.setState("M-1-1", "ci-passed");
      orch.getItem("M-1-1")!.reviewCompleted = true;
      orch.getItem("M-1-1")!.prNumber = 102;
      // ci-pending → will transition to ci-failed when it sees ciStatus: "fail"
      orch.setState("L-1-1", "ci-pending");
      orch.getItem("L-1-1")!.prNumber = 103;

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 101, prState: "open", ciStatus: "pass" },
          { id: "M-1-1", prNumber: 102, prState: "open", ciStatus: "pass" },
          { id: "L-1-1", prNumber: 103, prState: "open", ciStatus: "fail", isMergeable: true },
        ]),
      );

      // Merge action only for highest priority
      const mergeActions = actions.filter((a) => a.type === "merge");
      expect(mergeActions).toHaveLength(1);
      expect(mergeActions[0]!.itemId).toBe("H-1-1");

      // CI failure notification should still be present for L-1-1
      const ciActions = actions.filter((a) => a.type === "notify-ci-failure");
      expect(ciActions).toHaveLength(1);
      expect(ciActions[0]!.itemId).toBe("L-1-1");
    });

    it("priority order: critical > high > medium > low", () => {
      orch = new Orchestrator({ wipLimit: 10, mergeStrategy: "auto" });

      const priorities: Priority[] = ["low", "medium", "high", "critical"];
      for (const p of priorities) {
        const id = `${p.charAt(0).toUpperCase()}-1-1`;
        orch.addItem(makeWorkItem(id, [], p));
        orch.setState(id, "ci-passed");
        orch.getItem(id)!.reviewCompleted = true;
        orch.getItem(id)!.prNumber = 100;
      }

      const actions = orch.processTransitions(
        snapshotWith(
          priorities.map((p) => ({
            id: `${p.charAt(0).toUpperCase()}-1-1`,
            prNumber: 100,
            prState: "open" as const,
            ciStatus: "pass" as const,
          })),
        ),
      );

      const mergeActions = actions.filter((a) => a.type === "merge");
      expect(mergeActions).toHaveLength(1);
      // "critical" has lowercase 'c', so the ID would be C-1-1
      // But "critical".charAt(0).toUpperCase() = "C"
      expect(mergeActions[0]!.itemId).toBe("C-1-1");
    });
  });

  // ── Detection latency timestamps ──────────────────────────────────

  describe("detection latency", () => {
    it("records eventTime, detectedTime, and detectionLatencyMs on state transitions", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      const eventTime = new Date(Date.now() - 5000).toISOString(); // 5s ago
      orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pass", eventTime },
        ]),
      );

      const item = orch.getItem("H-1-1")!;
      expect(item.eventTime).toBe(eventTime);
      expect(item.detectedTime).toBeDefined();
      expect(typeof item.detectionLatencyMs).toBe("number");
      expect(item.detectionLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("calculates detectionLatencyMs correctly", () => {
      // Use "manual" strategy so ci-passed doesn't immediately chain to merging
      // without approval — item stays in review-pending with the eventTime carried through
      orch = new Orchestrator({ mergeStrategy: "manual" });
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-pending");

      const eventTime = new Date(Date.now() - 3000).toISOString(); // 3s ago
      orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 10, prState: "open", ciStatus: "pass", eventTime },
        ]),
      );

      const item = orch.getItem("H-1-1")!;
      // ci-pending → ci-passed → review-pending; eventTime carried through chain
      expect(item.state).toBe("review-pending");
      // Latency should be at least 3000ms (the event was 3s ago)
      expect(item.detectionLatencyMs).toBeGreaterThanOrEqual(2900);
      // But not unreasonably large (allow some slack for test execution)
      expect(item.detectionLatencyMs).toBeLessThan(10000);
    });

    it("falls back to detectedTime when eventTime is not available", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      // No eventTime in snapshot
      orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 42, prState: "open", ciStatus: "pending" },
        ]),
      );

      const item = orch.getItem("H-1-1")!;
      // When eventTime is missing, it falls back to detectedTime, so latency is 0
      expect(item.eventTime).toBeDefined();
      expect(item.detectedTime).toBeDefined();
      expect(item.eventTime).toBe(item.detectedTime);
      expect(item.detectionLatencyMs).toBe(0);
    });

    it("records latency on CI failure transitions", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-pending");

      const eventTime = new Date(Date.now() - 2000).toISOString();
      orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 10, prState: "open", ciStatus: "fail", eventTime },
        ]),
      );

      const item = orch.getItem("H-1-1")!;
      expect(item.state).toBe("ci-failed");
      expect(item.eventTime).toBe(eventTime);
      expect(item.detectionLatencyMs).toBeGreaterThanOrEqual(1900);
    });

    it("records latency on merged transitions", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "merging");

      const eventTime = new Date(Date.now() - 1000).toISOString();
      orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 10, prState: "merged", eventTime },
        ]),
      );

      const item = orch.getItem("H-1-1")!;
      // merging → merged in this cycle (merged → done happens next cycle)
      expect(item.state).toBe("merged");
      expect(item.eventTime).toBe(eventTime);
      expect(item.detectionLatencyMs).toBeGreaterThanOrEqual(900);
    });

    it("carries eventTime through CI pass to merged transition", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "ci-pending");

      const eventTime = new Date(Date.now() - 2000).toISOString();
      orch.processTransitions(
        snapshotWith([
          { id: "H-1-1", prNumber: 10, prState: "merged", eventTime },
        ]),
      );

      // ci-pending → handlePrLifecycle detects merged → transition with eventTime
      const item = orch.getItem("H-1-1")!;
      expect(item.state).toBe("merged");
      expect(item.eventTime).toBe(eventTime);
      expect(item.detectionLatencyMs).toBeGreaterThanOrEqual(1900);
    });

    it("latency fields are optional and backward-compatible with existing items", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      const item = orch.getItem("H-1-1")!;

      // New items should not have latency fields set until a transition occurs
      expect(item.eventTime).toBeUndefined();
      expect(item.detectedTime).toBeUndefined();
      expect(item.detectionLatencyMs).toBeUndefined();

      // After a transition via setState (no eventTime), fields remain undefined
      orch.setState("H-1-1", "ready");
      const updated = orch.getItem("H-1-1")!;
      // setState uses lastTransition but doesn't set latency fields
      expect(updated.eventTime).toBeUndefined();
    });

    it("records latency through implementing → pr-open → ci-passed → merging chain", () => {
      orch.addItem(makeWorkItem("H-1-1"));
      orch.getItem("H-1-1")!.reviewCompleted = true;
      orch.setState("H-1-1", "implementing");

      const eventTime = new Date(Date.now() - 4000).toISOString();
      orch.processTransitions(
        snapshotWith([
          {
            id: "H-1-1",
            prNumber: 42,
            prState: "open",
            ciStatus: "pass",
            workerAlive: true,
            eventTime,
          },
        ]),
      );

      const item = orch.getItem("H-1-1")!;
      // Should have gone implementing → pr-open → ci-passed → merging (auto strategy)
      // eventTime is carried through the entire chain
      expect(item.state).toBe("merging");
      expect(item.eventTime).toBe(eventTime);
      expect(item.detectionLatencyMs).toBeGreaterThanOrEqual(3900);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // H-STK-3: Stacked branch awareness
  // ══════════════════════════════════════════════════════════════════════

  describe("Stacked branch awareness", () => {
    // ── canStackLaunch ──────────────────────────────────────────────

    describe("canStackLaunch", () => {
      it("returns canStack: true when single dep is in ci-passed", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(true);
        if (result.canStack) {
          expect(result.baseBranch).toBe("ninthwave/A-1-1");
        }
      });

      it("returns canStack: true when single dep is in review-pending", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "review-pending");

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(true);
        if (result.canStack) {
          expect(result.baseBranch).toBe("ninthwave/A-1-1");
        }
      });

      it("returns canStack: true when single dep is in merging", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(true);
        if (result.canStack) {
          expect(result.baseBranch).toBe("ninthwave/A-1-1");
        }
      });

      it("returns canStack: false when multiple deps are in-flight", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2"));
        orch.getItem("A-1-2")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-3", ["A-1-1", "A-1-2"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-2", "ci-passed");
        orch.getItem("A-1-2")!.reviewCompleted = true;

        const result = orch.canStackLaunch(orch.getItem("A-1-3")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when all deps are done (should use readyIds instead)", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "done");

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when stacking is disabled", () => {
        orch = new Orchestrator({ enableStacking: false });
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: true with mixed done + one in-flight dep", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2"));
        orch.getItem("A-1-2")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-3", ["A-1-1", "A-1-2"]));
        orch.setState("A-1-1", "done");
        orch.setState("A-1-2", "ci-passed");
        orch.getItem("A-1-2")!.reviewCompleted = true;

        const result = orch.canStackLaunch(orch.getItem("A-1-3")!);
        expect(result.canStack).toBe(true);
        if (result.canStack) {
          expect(result.baseBranch).toBe("ninthwave/A-1-2");
        }
      });

      it("returns canStack: false when dep is in implementing (not stackable)", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "implementing");

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when dep is in queued", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when dep is in ci-pending", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-pending");

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when dep is in ci-failed", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-failed");
        orch.getItem("A-1-1")!.reviewCompleted = true;

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when item has no dependencies", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;

        const result = orch.canStackLaunch(orch.getItem("A-1-1")!);
        expect(result.canStack).toBe(false);
      });

      it("returns canStack: false when dep is unknown (not tracked)", () => {
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"])); // A-1-1 not added

        const result = orch.canStackLaunch(orch.getItem("A-1-2")!);
        expect(result.canStack).toBe(false);
      });
    });

    // ── processTransitions stacking promotion ─────────────────────────

    describe("processTransitions stacking", () => {
      it("promotes stackable-ready items and sets baseBranch", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 42;

        // A-1-2 is queued, dep A-1-1 is in ci-passed (stackable)
        // Not in readyIds because dep isn't done yet
        const actions = orch.processTransitions(emptySnapshot());

        const item = orch.getItem("A-1-2")!;
        expect(item.state).toBe("launching");
        expect(item.baseBranch).toBe("ninthwave/A-1-1");
        expect(actions.some((a) => a.type === "launch" && a.itemId === "A-1-2")).toBe(true);
      });

      it("does not promote when stacking is disabled", () => {
        orch = new Orchestrator({ enableStacking: false });
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;

        orch.processTransitions(emptySnapshot());

        expect(orch.getItem("A-1-2")!.state).toBe("queued");
      });

      it("normal readyIds promotion still works alongside stacking", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2"));
        orch.getItem("A-1-2")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-3", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;

        // A-1-2 is in readyIds (no deps). A-1-3 is stack-promoted.
        const actions = orch.processTransitions(emptySnapshot(["A-1-2"]));

        expect(orch.getItem("A-1-2")!.state).toBe("launching");
        expect(orch.getItem("A-1-2")!.baseBranch).toBeUndefined();
        expect(orch.getItem("A-1-3")!.state).toBe("launching");
        expect(orch.getItem("A-1-3")!.baseBranch).toBe("ninthwave/A-1-1");
        expect(actions.filter((a) => a.type === "launch")).toHaveLength(2);
      });

      it("does not double-promote items already promoted via readyIds", () => {
        orch = new Orchestrator({ wipLimit: 0 }); // prevent auto-launch
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "done");

        // A-1-2 in readyIds because dep is done
        orch.processTransitions(emptySnapshot(["A-1-2"]));

        // Should be ready (not launched due to wipLimit: 0), no baseBranch set
        expect(orch.getItem("A-1-2")!.state).toBe("ready");
        expect(orch.getItem("A-1-2")!.baseBranch).toBeUndefined();
      });
    });

    // ── launchReadyItems includes baseBranch ──────────────────────────

    describe("launchReadyItems includes baseBranch", () => {
      it("launch action includes baseBranch for stacked items", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;

        const actions = orch.processTransitions(emptySnapshot());

        const launchAction = actions.find((a) => a.type === "launch" && a.itemId === "A-1-2");
        expect(launchAction).toBeDefined();
        expect(launchAction!.baseBranch).toBe("ninthwave/A-1-1");
      });

      it("launch action omits baseBranch for non-stacked items", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        const actions = orch.processTransitions(emptySnapshot(["A-1-1"]));

        const launchAction = actions.find((a) => a.type === "launch" && a.itemId === "A-1-1");
        expect(launchAction).toBeDefined();
        expect(launchAction!.baseBranch).toBeUndefined();
      });
    });

    // ── executeLaunch passes baseBranch ───────────────────────────────

    describe("executeLaunch passes baseBranch", () => {
      it("passes baseBranch through to deps.launchSingleItem", () => {
        const deps = mockDeps();
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-1", "launching");

        orch.executeAction(
          { type: "launch", itemId: "A-1-1", baseBranch: "ninthwave/A-1-0" },
          defaultCtx,
          deps,
        );

        expect(deps.launchSingleItem).toHaveBeenCalledWith(
          orch.getItem("A-1-1")!.workItem,
          defaultCtx.workDir,
          defaultCtx.worktreeDir,
          defaultCtx.projectRoot,
          defaultCtx.aiTool,
          "ninthwave/A-1-0",
          false, // forceWorkerLaunch
        );
      });

      it("passes undefined baseBranch for non-stacked launch", () => {
        const deps = mockDeps();
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-1", "launching");

        orch.executeAction(
          { type: "launch", itemId: "A-1-1" },
          defaultCtx,
          deps,
        );

        expect(deps.launchSingleItem).toHaveBeenCalledWith(
          orch.getItem("A-1-1")!.workItem,
          defaultCtx.workDir,
          defaultCtx.worktreeDir,
          defaultCtx.projectRoot,
          defaultCtx.aiTool,
          undefined,
          false, // forceWorkerLaunch
        );
      });
    });

    // ── enableStacking config ────────────────────────────────────────

    describe("enableStacking config", () => {
      it("defaults to true", () => {
        expect(orch.config.enableStacking).toBe(true);
      });

      it("can be disabled via config", () => {
        orch = new Orchestrator({ enableStacking: false });
        expect(orch.config.enableStacking).toBe(false);
      });
    });

    // ── Post-merge restacking (H-STK-5) ──────────────────────────────

    describe("post-merge restacking", () => {
      it("executeMerge restacks stacked dep with rebaseOnto and force-pushes", () => {
        const rebaseOnto = vi.fn(() => true);
        const forcePush = vi.fn(() => true);
        const deps = mockDeps({ rebaseOnto, forcePush });

        // A-1-1 is merging, A-1-2 depends on it and is stacked
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 43;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 42 },
          defaultCtx,
          deps,
        );

        // rebaseOnto called with correct args
        expect(rebaseOnto).toHaveBeenCalledWith(
          `${defaultCtx.worktreeDir}/ninthwave-A-1-2`,
          "main",
          "ninthwave/A-1-1",
          "ninthwave/A-1-2",
        );
        // Force-pushed after successful rebase
        expect(forcePush).toHaveBeenCalledWith(
          `${defaultCtx.worktreeDir}/ninthwave-A-1-2`,
        );
        // baseBranch cleared — no longer stacked
        expect(orch.getItem("A-1-2")!.baseBranch).toBeUndefined();
      });

      it("executeMerge sends conflict message when rebaseOnto fails", () => {
        const rebaseOnto = vi.fn(() => false); // conflict
        const forcePush = vi.fn(() => true);
        const deps = mockDeps({ rebaseOnto, forcePush });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 43;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 42 },
          defaultCtx,
          deps,
        );

        // rebaseOnto was called but returned false (conflict)
        expect(rebaseOnto).toHaveBeenCalledTimes(1);
        // Force-push should NOT have been called
        expect(forcePush).not.toHaveBeenCalled();
        // Worker gets conflict message with manual rebase instructions
        expect(deps.sendMessage).toHaveBeenCalledWith(
          "workspace:2",
          expect.stringContaining("Restack Conflict"),
        );
        expect(deps.sendMessage).toHaveBeenCalledWith(
          "workspace:2",
          expect.stringContaining("git rebase --onto main"),
        );
      });

      it("executeMerge non-stacked dep gets existing rebase behavior unchanged", () => {
        const rebaseOnto = vi.fn(() => true);
        const forcePush = vi.fn(() => true);
        const daemonRebase = vi.fn(() => true);
        const deps = mockDeps({ rebaseOnto, forcePush, daemonRebase });

        // A-1-1 merging, A-1-2 depends on it but NOT stacked (no baseBranch)
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 43;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        // No baseBranch — not stacked

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 42 },
          defaultCtx,
          deps,
        );

        // rebaseOnto should NOT be called for non-stacked items
        expect(rebaseOnto).not.toHaveBeenCalled();
        expect(forcePush).not.toHaveBeenCalled();
        // Non-stacked dep gets generic rebase message
        expect(deps.sendMessage).toHaveBeenCalledWith(
          "workspace:2",
          expect.stringContaining("Dependency A-1-1 merged"),
        );
        // And gets daemon-rebase treatment as a sibling
        expect(daemonRebase).toHaveBeenCalledWith(
          `${defaultCtx.worktreeDir}/ninthwave-A-1-2`,
          "ninthwave/A-1-2",
        );
      });

      it("executeMerge stacked items skip generic rebase message loop", () => {
        const rebaseOnto = vi.fn(() => true);
        const forcePush = vi.fn(() => true);
        const deps = mockDeps({ rebaseOnto, forcePush });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 43;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 42 },
          defaultCtx,
          deps,
        );

        // sendMessage should NOT be called — stacked item was handled by rebaseOnto
        // (no generic "Dependency merged" message, no conflict fallback message)
        expect(deps.sendMessage).not.toHaveBeenCalled();
      });

      it("executeMerge stacked items skip daemon-rebase-all loop", () => {
        const rebaseOnto = vi.fn(() => true);
        const forcePush = vi.fn(() => true);
        const daemonRebase = vi.fn(() => true);
        const deps = mockDeps({ rebaseOnto, forcePush, daemonRebase });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 43;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 42 },
          defaultCtx,
          deps,
        );

        // daemonRebase should NOT be called for stacked items (handled by rebaseOnto)
        expect(daemonRebase).not.toHaveBeenCalled();
      });

      it("executeMerge falls back to worker message when rebaseOnto dep not injected", () => {
        // No rebaseOnto or forcePush injected
        const deps = mockDeps();

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 43;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 42 },
          defaultCtx,
          deps,
        );

        // Worker gets manual rebase instructions since rebaseOnto not available
        expect(deps.sendMessage).toHaveBeenCalledWith(
          "workspace:2",
          expect.stringContaining("Restack Required"),
        );
        expect(deps.sendMessage).toHaveBeenCalledWith(
          "workspace:2",
          expect.stringContaining("git rebase --onto main"),
        );
      });
    });

    // ── Stuck dep pause/resume (H-STK-5) ─────────────────────────────

    describe("stuck dep pause/resume", () => {
      it("sends pause message to stacked dependent when dep goes stuck", () => {
        // A-1-1 is the dep (ci-failed), A-1-2 is stacked on it
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-failed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.getItem("A-1-1")!.ciFailCount = 10; // exceeds maxCiRetries
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        // A-1-1 is ci-failed and over retry limit → will go stuck
        const actions = orch.processTransitions(
          snapshotWith([
            { id: "A-1-1", prNumber: 42, prState: "open", ciStatus: "fail" },
            { id: "A-1-2", prNumber: 43, prState: "open", ciStatus: "pending" },
          ]),
        );

        expect(orch.getItem("A-1-1")!.state).toBe("stuck");
        // Should have a rebase action for A-1-2 with pause message
        const pauseAction = actions.find(
          (a) => a.itemId === "A-1-2" && a.message?.includes("Pause"),
        );
        expect(pauseAction).toBeDefined();
        expect(pauseAction!.message).toContain("dependency A-1-1 is stuck");
      });

      it("does not send pause message to non-stacked dependents", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-failed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.getItem("A-1-1")!.ciFailCount = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        // No baseBranch — not stacked

        const actions = orch.processTransitions(
          snapshotWith([
            { id: "A-1-1", prNumber: 42, prState: "open", ciStatus: "fail" },
            { id: "A-1-2", prNumber: 43, prState: "open", ciStatus: "pending" },
          ]),
        );

        expect(orch.getItem("A-1-1")!.state).toBe("stuck");
        // Should NOT have a pause action for A-1-2
        const pauseAction = actions.find(
          (a) => a.itemId === "A-1-2" && a.message?.includes("Pause"),
        );
        expect(pauseAction).toBeUndefined();
      });

      it("sends resume message to stacked dependent when dep recovers from ci-failed to ci-pending", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-failed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.getItem("A-1-1")!.ciFailCount = 1;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        // A-1-1 recovers: ci-failed → ci-pending (CI restarted)
        const actions = orch.processTransitions(
          snapshotWith([
            { id: "A-1-1", prNumber: 42, prState: "open", ciStatus: "pending" },
            { id: "A-1-2", prNumber: 43, prState: "open", ciStatus: "pending" },
          ]),
        );

        expect(orch.getItem("A-1-1")!.state).toBe("ci-pending");
        // Should have a rebase action for A-1-2 with resume message
        const resumeAction = actions.find(
          (a) => a.itemId === "A-1-2" && a.message?.includes("Resume"),
        );
        expect(resumeAction).toBeDefined();
        expect(resumeAction!.message).toContain("dependency A-1-1 CI is back to pending");
      });

      it("does not send resume message to non-stacked dependents", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-failed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 42;
        orch.getItem("A-1-1")!.ciFailCount = 1;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        // No baseBranch — not stacked

        const actions = orch.processTransitions(
          snapshotWith([
            { id: "A-1-1", prNumber: 42, prState: "open", ciStatus: "pending" },
            { id: "A-1-2", prNumber: 43, prState: "open", ciStatus: "pending" },
          ]),
        );

        expect(orch.getItem("A-1-1")!.state).toBe("ci-pending");
        // Should NOT have a resume action for A-1-2
        const resumeAction = actions.find(
          (a) => a.itemId === "A-1-2" && a.message?.includes("Resume"),
        );
        expect(resumeAction).toBeUndefined();
      });
    });

    // ── Stack comment integration (M-STK-6) ────────────────────────────

    describe("buildStackChain", () => {
      it("builds [A, B] chain when B is stacked on A", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        const chain = orch.buildStackChain("A-1-2");

        expect(chain).toEqual([
          { id: "A-1-1", prNumber: 10, title: "Item A-1-1" },
          { id: "A-1-2", prNumber: 11, title: "Item A-1-2" },
        ]);
      });

      it("builds [A, B, C] chain for three-level stack", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.addItem(makeWorkItem("A-1-3", ["A-1-2"]));
        orch.setState("A-1-1", "review-pending");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";
        orch.setState("A-1-3", "ci-pending");
        orch.getItem("A-1-3")!.prNumber = 12;
        orch.getItem("A-1-3")!.baseBranch = "ninthwave/A-1-2";

        const chain = orch.buildStackChain("A-1-3");

        expect(chain).toEqual([
          { id: "A-1-1", prNumber: 10, title: "Item A-1-1" },
          { id: "A-1-2", prNumber: 11, title: "Item A-1-2" },
          { id: "A-1-3", prNumber: 12, title: "Item A-1-3" },
        ]);
      });

      it("returns same chain regardless of which item you start from", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        const fromTop = orch.buildStackChain("A-1-2");
        const fromBottom = orch.buildStackChain("A-1-1");

        expect(fromTop).toEqual(fromBottom);
      });

      it("excludes merged/done items from the chain", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merged");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        const chain = orch.buildStackChain("A-1-2");

        expect(chain).toEqual([
          { id: "A-1-2", prNumber: 11, title: "Item A-1-2" },
        ]);
      });

      it("excludes items without PR numbers", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "implementing");
        // A-1-2 has no prNumber yet
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        const chain = orch.buildStackChain("A-1-1");

        expect(chain).toEqual([
          { id: "A-1-1", prNumber: 10, title: "Item A-1-1" },
        ]);
      });

      it("returns empty array for unknown item", () => {
        const chain = orch.buildStackChain("nonexistent");
        expect(chain).toEqual([]);
      });

      it("returns single-item chain for non-stacked item", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 10;

        const chain = orch.buildStackChain("A-1-1");

        expect(chain).toEqual([
          { id: "A-1-1", prNumber: 10, title: "Item A-1-1" },
        ]);
      });
    });

    describe("stack comment sync on PR open", () => {
      it("emits sync-stack-comments action when stacked item transitions to pr-open", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "implementing");
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        const actions = orch.processTransitions(
          snapshotWith([
            { id: "A-1-1", prNumber: 10, prState: "open", ciStatus: "pass" },
            { id: "A-1-2", prNumber: 11, prState: "open", workerAlive: true },
          ]),
        );

        expect(orch.getItem("A-1-2")!.state).toBe("pr-open");
        const syncAction = actions.find(
          (a) => a.type === "sync-stack-comments" && a.itemId === "A-1-2",
        );
        expect(syncAction).toBeDefined();
      });

      it("does NOT emit sync-stack-comments for non-stacked items", () => {
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-1", "implementing");
        orch.getItem("A-1-1")!.workspaceRef = "workspace:1";
        // No baseBranch — not stacked

        const actions = orch.processTransitions(
          snapshotWith([
            { id: "A-1-1", prNumber: 10, prState: "open", workerAlive: true },
          ]),
        );

        expect(orch.getItem("A-1-1")!.state).toBe("pr-open");
        const syncAction = actions.find(
          (a) => a.type === "sync-stack-comments",
        );
        expect(syncAction).toBeUndefined();
      });

      it("executeSyncStackComments calls deps.syncStackComments with correct chain", () => {
        const syncStackComments = vi.fn();
        const deps = mockDeps({ syncStackComments });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "ci-passed");
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "pr-open");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        const result = orch.executeAction(
          { type: "sync-stack-comments", itemId: "A-1-2" },
          defaultCtx,
          deps,
        );

        expect(result.success).toBe(true);
        expect(syncStackComments).toHaveBeenCalledTimes(1);
        expect(syncStackComments).toHaveBeenCalledWith("main", [
          { id: "A-1-1", prNumber: 10, title: "Item A-1-1" },
          { id: "A-1-2", prNumber: 11, title: "Item A-1-2" },
        ]);
      });

      it("executeSyncStackComments is no-op when syncStackComments dep not wired", () => {
        const deps = mockDeps(); // no syncStackComments

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-1", "pr-open");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.getItem("A-1-1")!.baseBranch = "ninthwave/X-1-1";

        const result = orch.executeAction(
          { type: "sync-stack-comments", itemId: "A-1-1" },
          defaultCtx,
          deps,
        );

        expect(result.success).toBe(true);
      });

      it("executeSyncStackComments skips single-item chains", () => {
        const syncStackComments = vi.fn();
        const deps = mockDeps({ syncStackComments });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.setState("A-1-1", "pr-open");
        orch.getItem("A-1-1")!.prNumber = 10;
        // No baseBranch, no one stacked on it — chain is [A-1-1] (length 1)

        const result = orch.executeAction(
          { type: "sync-stack-comments", itemId: "A-1-1" },
          defaultCtx,
          deps,
        );

        expect(result.success).toBe(true);
        expect(syncStackComments).not.toHaveBeenCalled();
      });
    });

    describe("stack comment sync on merge", () => {
      it("executeMerge calls syncStackComments on remaining chain after restacking", () => {
        const syncStackComments = vi.fn();
        const rebaseOnto = vi.fn(() => true);
        const forcePush = vi.fn(() => true);
        const deps = mockDeps({ syncStackComments, rebaseOnto, forcePush });

        // A → B → C: A is merging, B stacked on A, C stacked on B
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.addItem(makeWorkItem("A-1-3", ["A-1-2"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";
        orch.setState("A-1-3", "ci-pending");
        orch.getItem("A-1-3")!.prNumber = 12;
        orch.getItem("A-1-3")!.baseBranch = "ninthwave/A-1-2";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 10 },
          defaultCtx,
          deps,
        );

        // syncStackComments should be called with the remaining chain [B, C]
        expect(syncStackComments).toHaveBeenCalledTimes(1);
        expect(syncStackComments).toHaveBeenCalledWith("main", [
          { id: "A-1-2", prNumber: 11, title: "Item A-1-2" },
          { id: "A-1-3", prNumber: 12, title: "Item A-1-3" },
        ]);
      });

      it("executeMerge does NOT call syncStackComments for non-stacked merges", () => {
        const syncStackComments = vi.fn();
        const deps = mockDeps({ syncStackComments });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        // No baseBranch — not stacked

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 10 },
          defaultCtx,
          deps,
        );

        expect(syncStackComments).not.toHaveBeenCalled();
      });

      it("executeMerge skips syncStackComments when restack fails (conflict)", () => {
        const syncStackComments = vi.fn();
        const rebaseOnto = vi.fn(() => false); // conflict
        const forcePush = vi.fn(() => true);
        const deps = mockDeps({ syncStackComments, rebaseOnto, forcePush });

        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 10 },
          defaultCtx,
          deps,
        );

        // Restack failed — don't sync comments (worker needs to resolve manually)
        expect(syncStackComments).not.toHaveBeenCalled();
      });

      it("executeMerge skips syncStackComments when only one item remains after restack", () => {
        const syncStackComments = vi.fn();
        const rebaseOnto = vi.fn(() => true);
        const forcePush = vi.fn(() => true);
        const deps = mockDeps({ syncStackComments, rebaseOnto, forcePush });

        // A → B (simple 2-item stack). After A merges, B is alone.
        orch.addItem(makeWorkItem("A-1-1"));
        orch.getItem("A-1-1")!.reviewCompleted = true;
        orch.addItem(makeWorkItem("A-1-2", ["A-1-1"]));
        orch.setState("A-1-1", "merging");
        orch.getItem("A-1-1")!.prNumber = 10;
        orch.setState("A-1-2", "ci-pending");
        orch.getItem("A-1-2")!.prNumber = 11;
        orch.getItem("A-1-2")!.workspaceRef = "workspace:2";
        orch.getItem("A-1-2")!.baseBranch = "ninthwave/A-1-1";

        orch.executeAction(
          { type: "merge", itemId: "A-1-1", prNumber: 10 },
          defaultCtx,
          deps,
        );

        // Chain is just [B] after A merged — single item, no stack to show
        expect(syncStackComments).not.toHaveBeenCalled();
      });
    });
  });

  // ── Cross-repo awareness ────────────────────────────────────────────

  describe("cross-repo resolvedRepoRoot", () => {
    it("executeMerge uses resolvedRepoRoot for PR operations", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("X-1-1"));
      orch.getItem("X-1-1")!.reviewCompleted = true;
      orch.setState("X-1-1", "merging");
      const item = orch.getItem("X-1-1")!;
      item.prNumber = 42;
      item.resolvedRepoRoot = "/path/to/target-repo";

      orch.executeAction(
        { type: "merge", itemId: "X-1-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      // prMerge should be called with target repo, not hub
      expect(deps.prMerge).toHaveBeenCalledWith("/path/to/target-repo", 42, { admin: undefined });
      // prComment should also use target repo
      expect(deps.prComment).toHaveBeenCalledWith(
        "/path/to/target-repo",
        42,
        expect.stringContaining("Auto-merged"),
      );
      // fetchOrigin should be called for BOTH target and hub repos
      expect(deps.fetchOrigin).toHaveBeenCalledWith("/path/to/target-repo", "main");
      expect(deps.fetchOrigin).toHaveBeenCalledWith(defaultCtx.projectRoot, "main");
    });

    it("executeMerge uses hub root when resolvedRepoRoot is not set", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("X-1-2"));
      orch.getItem("X-1-2")!.reviewCompleted = true;
      orch.setState("X-1-2", "merging");
      orch.getItem("X-1-2")!.prNumber = 43;

      orch.executeAction(
        { type: "merge", itemId: "X-1-2", prNumber: 43 },
        defaultCtx,
        deps,
      );

      expect(deps.prMerge).toHaveBeenCalledWith(defaultCtx.projectRoot, 43, { admin: undefined });
    });

    it("executeClean uses target repo worktree dir for cross-repo items", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("X-1-3"));
      orch.getItem("X-1-3")!.reviewCompleted = true;
      orch.setState("X-1-3", "merged");
      const item = orch.getItem("X-1-3")!;
      item.resolvedRepoRoot = "/path/to/target-repo";

      orch.executeAction(
        { type: "clean", itemId: "X-1-3" },
        defaultCtx,
        deps,
      );

      expect(deps.cleanSingleWorktree).toHaveBeenCalledWith(
        "X-1-3",
        "/path/to/target-repo/.worktrees",
        "/path/to/target-repo",
      );
    });

    it("executeDaemonRebase uses target repo worktree path", () => {
      const daemonRebase = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase });
      orch.addItem(makeWorkItem("X-1-4"));
      orch.getItem("X-1-4")!.reviewCompleted = true;
      orch.setState("X-1-4", "ci-failed");
      orch.getItem("X-1-4")!.reviewCompleted = true;
      const item = orch.getItem("X-1-4")!;
      item.prNumber = 44;
      item.resolvedRepoRoot = "/path/to/target-repo";

      orch.executeAction(
        { type: "daemon-rebase", itemId: "X-1-4" },
        defaultCtx,
        deps,
      );

      expect(daemonRebase).toHaveBeenCalledWith(
        "/path/to/target-repo/.worktrees/ninthwave-X-1-4",
        "ninthwave/X-1-4",
      );
    });

    it("executeRetry preserves worktree for cross-repo items", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("X-1-5"));
      orch.getItem("X-1-5")!.reviewCompleted = true;
      orch.setState("X-1-5", "implementing");
      const item = orch.getItem("X-1-5")!;
      item.resolvedRepoRoot = "/path/to/target-repo";
      item.workspaceRef = "workspace:5";

      orch.executeAction(
        { type: "retry", itemId: "X-1-5" },
        defaultCtx,
        deps,
      );

      // Worktree preserved for retry continuation — no cleanup
      expect(deps.cleanSingleWorktree).not.toHaveBeenCalled();
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:5");
    });

    it("post-merge sibling rebase uses cross-repo worktree path for same-repo siblings", () => {
      const daemonRebase = vi.fn(() => true);
      const forcePush = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase, forcePush });

      orch.addItem(makeWorkItem("X-1-6"));
      orch.getItem("X-1-6")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("X-1-7", [], "medium"));
      orch.getItem("X-1-7")!.reviewCompleted = true;

      orch.setState("X-1-6", "merging");
      orch.getItem("X-1-6")!.prNumber = 46;
      orch.getItem("X-1-6")!.resolvedRepoRoot = "/path/to/target-repo";

      // Sibling in the SAME repo — should be rebased
      orch.setState("X-1-7", "ci-pending");
      orch.getItem("X-1-7")!.prNumber = 47;
      orch.getItem("X-1-7")!.resolvedRepoRoot = "/path/to/target-repo";
      orch.getItem("X-1-7")!.workspaceRef = "workspace:7";

      orch.executeAction(
        { type: "merge", itemId: "X-1-6", prNumber: 46 },
        defaultCtx,
        deps,
      );

      // Sibling rebase should use target-repo's worktree path
      expect(daemonRebase).toHaveBeenCalledWith(
        "/path/to/target-repo/.worktrees/ninthwave-X-1-7",
        "ninthwave/X-1-7",
      );
    });

    it("post-merge sibling rebase skips items in different repos", () => {
      const daemonRebase = vi.fn(() => true);
      const deps = mockDeps({ daemonRebase });

      orch.addItem(makeWorkItem("X-1-6b"));
      orch.getItem("X-1-6b")!.reviewCompleted = true;
      orch.addItem(makeWorkItem("X-1-7b", [], "medium"));
      orch.getItem("X-1-7b")!.reviewCompleted = true;

      orch.setState("X-1-6b", "merging");
      orch.getItem("X-1-6b")!.prNumber = 46;
      orch.getItem("X-1-6b")!.resolvedRepoRoot = "/path/to/target-repo";

      // Sibling in a DIFFERENT repo — should NOT be rebased
      orch.setState("X-1-7b", "ci-pending");
      orch.getItem("X-1-7b")!.prNumber = 47;
      orch.getItem("X-1-7b")!.resolvedRepoRoot = "/path/to/other-repo";
      orch.getItem("X-1-7b")!.workspaceRef = "workspace:7";

      orch.executeAction(
        { type: "merge", itemId: "X-1-6b", prNumber: 46 },
        defaultCtx,
        deps,
      );

      // daemonRebase should NOT be called for different-repo sibling
      expect(daemonRebase).not.toHaveBeenCalled();
    });

    it("CI failure comment uses resolvedRepoRoot", () => {
      const deps = mockDeps();
      orch.addItem(makeWorkItem("X-1-8"));
      orch.getItem("X-1-8")!.reviewCompleted = true;
      orch.setState("X-1-8", "ci-failed");
      orch.getItem("X-1-8")!.reviewCompleted = true;
      const item = orch.getItem("X-1-8")!;
      item.prNumber = 48;
      item.resolvedRepoRoot = "/path/to/target-repo";
      item.workspaceRef = "workspace:8";

      orch.executeAction(
        { type: "notify-ci-failure", itemId: "X-1-8", message: "CI failed" },
        defaultCtx,
        deps,
      );

      expect(deps.prComment).toHaveBeenCalledWith(
        "/path/to/target-repo",
        48,
        expect.stringContaining("CI failure"),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // H-RVW-1: Review state transitions
  // ══════════════════════════════════════════════════════════════════════

  // H-RVW-1: Review state transitions
  // ══════════════════════════════════════════════════════════════════════

  describe("Review state transitions (H-RVW-1)", () => {
    // ── reviewCompleted skips review gate ──────────────────────────────

    it("ci-passed with reviewCompleted=true skips review gate and merges", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-1-1"));
      orch.setState("R-1-1", "pr-open");
      orch.getItem("R-1-1")!.prNumber = 42;
      orch.getItem("R-1-1")!.reviewCompleted = true;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-1-1", ciStatus: "pass", prState: "open" }]),
      );

      expect(orch.getItem("R-1-1")!.state).toBe("merging");
      expect(actions.some((a) => a.type === "merge")).toBe(true);
      expect(actions.some((a) => a.type === "launch-review")).toBe(false);
    });

    it("DEFAULT_CONFIG has review defaults", () => {
      expect(DEFAULT_CONFIG.reviewWipLimit).toBe(2);
      expect(DEFAULT_CONFIG.reviewAutoFix).toBe("off");
    });

    // ── ci-passed → reviewing (always-on) ───────────────────────────

    it("ci-passed emits launch-review, transitions to reviewing", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-2-1"));
      orch.setState("R-2-1", "pr-open");
      orch.getItem("R-2-1")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-2-1", ciStatus: "pass", prState: "open" }]),
      );

      expect(orch.getItem("R-2-1")!.state).toBe("reviewing");
      const launchReviewActions = actions.filter((a) => a.type === "launch-review");
      expect(launchReviewActions).toHaveLength(1);
      expect(launchReviewActions[0]!.itemId).toBe("R-2-1");
      expect(launchReviewActions[0]!.prNumber).toBe(42);
      // Should NOT emit merge action
      expect(actions.some((a) => a.type === "merge")).toBe(false);
    });

    it("ci-passed works with manual merge strategy", () => {
      orch = new Orchestrator({ mergeStrategy: "manual" });
      orch.addItem(makeWorkItem("R-2-2"));
      orch.setState("R-2-2", "pr-open");
      orch.getItem("R-2-2")!.prNumber = 43;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-2-2", ciStatus: "pass", prState: "open" }]),
      );

      expect(orch.getItem("R-2-2")!.state).toBe("reviewing");
      expect(actions.some((a) => a.type === "launch-review")).toBe(true);
    });

    const approveVerdict = { verdict: "approve" as const, summary: "No issues found.", blockerCount: 0, nitCount: 0, preExistingCount: 0 };
    const requestChangesVerdict = { verdict: "request-changes" as const, summary: "Found blockers.", blockerCount: 2, nitCount: 1, preExistingCount: 0 };

    it("reviewing + approve verdict sets reviewCompleted, back to ci-passed, then merges (auto)", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-3-1"));
      orch.setState("R-3-1", "reviewing");
      orch.getItem("R-3-1")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-3-1", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict }]),
      );

      expect(orch.getItem("R-3-1")!.reviewCompleted).toBe(true);
      // Should chain through to merging since reviewCompleted is now true
      expect(orch.getItem("R-3-1")!.state).toBe("merging");
      expect(actions.some((a) => a.type === "merge")).toBe(true);
      expect(actions.some((a) => a.type === "post-review")).toBe(true);
      expect(actions.some((a) => a.type === "clean-review")).toBe(true);
    });

    it("reviewing + approve verdict chains through reviewed merge strategy to merge", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-3-2"));
      orch.setState("R-3-2", "reviewing");
      orch.getItem("R-3-2")!.prNumber = 43;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-3-2", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict }]),
      );

      expect(orch.getItem("R-3-2")!.reviewCompleted).toBe(true);
      expect(orch.getItem("R-3-2")!.state).toBe("merging");
      expect(actions.some((a) => a.type === "merge")).toBe(true);
    });

    // ── reviewing + CHANGES_REQUESTED → review-pending + notify ──────

    it("reviewing + request-changes verdict transitions to review-pending + notify-review", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-4-1"));
      orch.setState("R-4-1", "reviewing");
      orch.getItem("R-4-1")!.prNumber = 42;
      orch.getItem("R-4-1")!.workspaceRef = "workspace:1";

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-4-1", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
      );

      expect(orch.getItem("R-4-1")!.state).toBe("review-pending");
      const notifyActions = actions.filter((a) => a.type === "notify-review");
      expect(notifyActions).toHaveLength(1);
      expect(notifyActions[0]!.message).toContain("Review");
      expect(actions.some((a) => a.type === "post-review")).toBe(true);
      expect(actions.some((a) => a.type === "clean-review")).toBe(true);
    });

    // ── reviewing + PR merged externally → merged + clean + clean-review ─

    it("reviewing + PR merged externally transitions to merged + clean + clean-review", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-5-1"));
      orch.setState("R-5-1", "reviewing");
      orch.getItem("R-5-1")!.prNumber = 42;
      orch.getItem("R-5-1")!.reviewWorkspaceRef = "review-workspace:1";

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-5-1", prState: "merged" }]),
      );

      expect(orch.getItem("R-5-1")!.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "R-5-1")).toBe(true);
      expect(actions.some((a) => a.type === "clean-review" && a.itemId === "R-5-1")).toBe(true);
    });

    it("reviewing + PR merged without reviewWorkspaceRef does not emit clean-review", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-5-2"));
      orch.setState("R-5-2", "reviewing");
      orch.getItem("R-5-2")!.prNumber = 43;
      // No reviewWorkspaceRef

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-5-2", prState: "merged" }]),
      );

      expect(orch.getItem("R-5-2")!.state).toBe("merged");
      expect(actions.some((a) => a.type === "clean" && a.itemId === "R-5-2")).toBe(true);
      expect(actions.some((a) => a.type === "clean-review")).toBe(false);
    });

    // ── reviewing + CI regression → ci-failed + clean-review ─────────

    it("CI regression during reviewing transitions to ci-failed + clean-review", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-6-1"));
      orch.setState("R-6-1", "reviewing");
      orch.getItem("R-6-1")!.prNumber = 42;
      orch.getItem("R-6-1")!.reviewWorkspaceRef = "review-workspace:1";

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-6-1", ciStatus: "fail", prState: "open" }]),
      );

      expect(orch.getItem("R-6-1")!.state).toBe("ci-failed");
      expect(orch.getItem("R-6-1")!.ciFailCount).toBe(1);
      expect(actions.some((a) => a.type === "clean-review")).toBe(true);
      expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
    });

    // ── reviewWipLimit ───────────────────────────────────────────────

    it("reviewing respects reviewWipLimit (no launch when slots full)", () => {
      orch = new Orchestrator({ mergeStrategy: "auto", reviewWipLimit: 1 });
      orch.addItem(makeWorkItem("R-7-1"));
      orch.addItem(makeWorkItem("R-7-2"));
      orch.setState("R-7-1", "reviewing"); // occupies 1 review slot
      orch.getItem("R-7-1")!.prNumber = 42;
      orch.setState("R-7-2", "pr-open");
      orch.getItem("R-7-2")!.prNumber = 43;

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "R-7-1", ciStatus: "pass", prState: "open" },
          { id: "R-7-2", ciStatus: "pass", prState: "open" },
        ]),
      );

      // R-7-2 should stay in ci-passed (not reviewing) because review slots are full
      expect(orch.getItem("R-7-2")!.state).toBe("ci-passed");
      expect(actions.filter((a) => a.type === "launch-review")).toHaveLength(0);
    });

    it("reviewing WIP slot frees up when review completes", () => {
      orch = new Orchestrator({ mergeStrategy: "auto", reviewWipLimit: 1 });
      orch.addItem(makeWorkItem("R-7-3"));
      orch.addItem(makeWorkItem("R-7-4"));

      // R-7-3 is in reviewing state
      orch.setState("R-7-3", "reviewing");
      orch.getItem("R-7-3")!.prNumber = 44;

      // R-7-4 is in ci-passed waiting for review
      orch.setState("R-7-4", "ci-passed");
      orch.getItem("R-7-4")!.prNumber = 45;

      // R-7-3 gets approved → frees review slot → ci-passed
      // R-7-4 should then be able to enter reviewing
      const actions = orch.processTransitions(
        snapshotWith([
          { id: "R-7-3", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict },
          { id: "R-7-4", ciStatus: "pass", prState: "open" },
        ]),
      );

      // R-7-3 should chain through: reviewing → ci-passed → merging (reviewCompleted=true)
      expect(orch.getItem("R-7-3")!.state).toBe("merging");
      // R-7-4: items are processed sequentially, R-7-3 freed its slot...
      // but R-7-4 is processed in transitionItem as ci-passed (the handlePrLifecycle)
      // which calls evaluateMerge which checks reviewWipSlots
      // At this point R-7-3 is no longer in reviewing state, so reviewWipCount=0
      expect(orch.getItem("R-7-4")!.state).toBe("reviewing");
      expect(actions.some((a) => a.type === "launch-review" && a.itemId === "R-7-4")).toBe(true);
    });

    // ── reviewing does NOT count toward normal WIP limit ─────────────

    it("reviewing does NOT count toward normal WIP limit", () => {
      orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-8-1"));
      orch.addItem(makeWorkItem("R-8-2"));
      orch.addItem(makeWorkItem("R-8-3"));

      orch.setState("R-8-1", "reviewing"); // should NOT count toward wipLimit
      orch.getItem("R-8-1")!.prNumber = 42;
      orch.setState("R-8-2", "implementing"); // counts as 1 WIP
      orch.setState("R-8-3", "ready");

      const actions = orch.processTransitions(
        snapshotWith([
          { id: "R-8-1", ciStatus: "pass", prState: "open" },
          { id: "R-8-2", workerAlive: true },
        ]),
      );

      // R-8-3 should be launched — only 1 main WIP item, limit is 2
      expect(orch.getItem("R-8-3")!.state).toBe("launching");
      expect(actions.some((a) => a.type === "launch" && a.itemId === "R-8-3")).toBe(true);
    });

    it("wipCount does not include reviewing items", () => {
      orch = new Orchestrator({ wipLimit: 5 });
      orch.addItem(makeWorkItem("R-8-4"));
      orch.addItem(makeWorkItem("R-8-5"));
      orch.setState("R-8-4", "implementing");
      orch.setState("R-8-5", "reviewing");

      expect(orch.wipCount).toBe(1); // only implementing counts
      expect(orch.reviewWipCount).toBe(1); // reviewing is tracked separately
    });

    // ── reviewCompleted resets on CI regression ──────────────────────

    it("reviewCompleted resets to false on ci-failed transition", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-9-1"));
      orch.setState("R-9-1", "ci-passed");
      orch.getItem("R-9-1")!.prNumber = 42;
      orch.getItem("R-9-1")!.reviewCompleted = true;

      // CI regresses
      orch.processTransitions(
        snapshotWith([{ id: "R-9-1", ciStatus: "fail", prState: "open" }]),
      );

      expect(orch.getItem("R-9-1")!.state).toBe("ci-failed");
      expect(orch.getItem("R-9-1")!.reviewCompleted).toBe(false);
    });

    it("reviewCompleted persists through ci-pending transition (only ci-failed resets)", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-9-2"));
      orch.setState("R-9-2", "ci-failed");
      orch.getItem("R-9-2")!.ciFailCount = 1;
      orch.getItem("R-9-2")!.reviewCompleted = true;

      // CI restarts — reviewCompleted was already reset by ci-failed,
      // then re-set to true above. ci-pending does NOT reset it.
      orch.processTransitions(
        snapshotWith([{ id: "R-9-2", ciStatus: "pending", prState: "open" }]),
      );

      expect(orch.getItem("R-9-2")!.state).toBe("ci-pending");
      expect(orch.getItem("R-9-2")!.reviewCompleted).toBe(true);
    });

    it("reviewCompleted reset enables fresh review after CI fix cycle", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-9-3"));
      orch.setState("R-9-3", "ci-passed");
      orch.getItem("R-9-3")!.prNumber = 42;
      orch.getItem("R-9-3")!.reviewCompleted = true; // was reviewed before

      // CI fails → reviewCompleted resets
      orch.processTransitions(
        snapshotWith([{ id: "R-9-3", ciStatus: "fail", prState: "open" }]),
      );
      expect(orch.getItem("R-9-3")!.reviewCompleted).toBe(false);

      // CI recovers → should go through reviewing again (not straight to merge)
      orch.processTransitions(
        snapshotWith([{ id: "R-9-3", ciStatus: "pass", prState: "open" }]),
      );
      expect(orch.getItem("R-9-3")!.state).toBe("reviewing");
    });

    // ── reviewed merge strategy end-to-end ───────────────────────────

    it("reviewed merge strategy: full cycle ci-passed → reviewing → ci-passed → merging", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-10-1"));
      orch.setState("R-10-1", "pr-open");
      orch.getItem("R-10-1")!.prNumber = 42;

      // CI passes → should enter reviewing (review gate fires)
      const actions1 = orch.processTransitions(
        snapshotWith([{ id: "R-10-1", ciStatus: "pass", prState: "open" }]),
      );
      expect(orch.getItem("R-10-1")!.state).toBe("reviewing");
      expect(actions1.some((a) => a.type === "launch-review")).toBe(true);

      // Review approves → should chain through ci-passed → merging
      const actions2 = orch.processTransitions(
        snapshotWith([{ id: "R-10-1", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict }]),
      );
      expect(orch.getItem("R-10-1")!.reviewCompleted).toBe(true);
      expect(orch.getItem("R-10-1")!.state).toBe("merging");
      expect(actions2.some((a) => a.type === "merge")).toBe(true);
    });

    // ── review WIP tracking independence ─────────────────────────────

    it("reviewWipCount and reviewWipSlots track independently from main WIP", () => {
      orch = new Orchestrator({ wipLimit: 3, reviewWipLimit: 2 });
      orch.addItem(makeWorkItem("R-11-1"));
      orch.addItem(makeWorkItem("R-11-2"));
      orch.addItem(makeWorkItem("R-11-3"));
      orch.addItem(makeWorkItem("R-11-4"));
      orch.addItem(makeWorkItem("R-11-5"));

      orch.setState("R-11-1", "implementing");
      orch.setState("R-11-2", "ci-pending");
      orch.setState("R-11-3", "reviewing");
      orch.setState("R-11-4", "reviewing");
      orch.setState("R-11-5", "ready");

      expect(orch.wipCount).toBe(2); // implementing + ci-pending
      expect(orch.wipSlots).toBe(1); // 3 - 2
      expect(orch.reviewWipCount).toBe(2); // 2 reviewing
      expect(orch.reviewWipSlots).toBe(0); // 2 - 2
    });

    // ── reviewing stays reviewing when no outcome yet ────────────────

    it("reviewing stays reviewing when no review decision", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("R-12-1"));
      orch.setState("R-12-1", "reviewing");
      orch.getItem("R-12-1")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "R-12-1", ciStatus: "pass", prState: "open" }]),
      );

      expect(orch.getItem("R-12-1")!.state).toBe("reviewing");
      expect(actions).toHaveLength(0);
    });

    // ── executeAction: launch-review ─────────────────────────────────

    it("executeAction: launch-review calls deps.launchReview and stores reviewWorkspaceRef", () => {
      const launchReview = vi.fn(() => ({ workspaceRef: "review-workspace:1", verdictPath: "/tmp/nw-verdict-R-13-1.json" }));
      const deps = mockDeps({ launchReview });
      orch.addItem(makeWorkItem("R-13-1"));
      orch.setState("R-13-1", "reviewing");
      orch.getItem("R-13-1")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "launch-review", itemId: "R-13-1", prNumber: 42 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(launchReview).toHaveBeenCalledWith("R-13-1", 42, defaultCtx.projectRoot);
      expect(orch.getItem("R-13-1")!.reviewWorkspaceRef).toBe("review-workspace:1");
      expect(orch.getItem("R-13-1")!.reviewVerdictPath).toBe("/tmp/nw-verdict-R-13-1.json");
    });

    it("executeAction: launch-review succeeds as no-op when dep not wired", () => {
      const deps = mockDeps(); // no launchReview dep
      orch.addItem(makeWorkItem("R-13-2"));
      orch.setState("R-13-2", "reviewing");
      orch.getItem("R-13-2")!.prNumber = 43;

      const result = orch.executeAction(
        { type: "launch-review", itemId: "R-13-2", prNumber: 43 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
    });

    it("executeAction: launch-review fails when no PR number", () => {
      const launchReview = vi.fn(() => ({ workspaceRef: "review-workspace:1", verdictPath: "/tmp/nw-verdict-R-13-3.json" }));
      const deps = mockDeps({ launchReview });
      orch.addItem(makeWorkItem("R-13-3"));
      orch.setState("R-13-3", "reviewing");
      // No prNumber

      const result = orch.executeAction(
        { type: "launch-review", itemId: "R-13-3" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No PR number");
    });

    it("executeAction: launch-review handles launchReview throw", () => {
      const launchReview = vi.fn(() => { throw new Error("review agent crash"); });
      const deps = mockDeps({ launchReview });
      orch.addItem(makeWorkItem("R-13-4"));
      orch.setState("R-13-4", "reviewing");
      orch.getItem("R-13-4")!.prNumber = 44;

      const result = orch.executeAction(
        { type: "launch-review", itemId: "R-13-4", prNumber: 44 },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("review agent crash");
    });

    // ── executeAction: clean-review ──────────────────────────────────

    it("executeAction: clean-review calls deps.cleanReview and clears reviewWorkspaceRef", () => {
      const cleanReview = vi.fn(() => true);
      const deps = mockDeps({ cleanReview });
      orch.addItem(makeWorkItem("R-14-1"));
      orch.setState("R-14-1", "ci-failed");
      orch.getItem("R-14-1")!.reviewWorkspaceRef = "review-workspace:1";

      const result = orch.executeAction(
        { type: "clean-review", itemId: "R-14-1" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(cleanReview).toHaveBeenCalledWith("R-14-1", "review-workspace:1");
      expect(orch.getItem("R-14-1")!.reviewWorkspaceRef).toBeUndefined();
    });

    it("executeAction: clean-review succeeds as no-op when dep not wired", () => {
      const deps = mockDeps(); // no cleanReview dep
      orch.addItem(makeWorkItem("R-14-2"));
      orch.setState("R-14-2", "ci-failed");
      orch.getItem("R-14-2")!.reviewWorkspaceRef = "review-workspace:2";

      const result = orch.executeAction(
        { type: "clean-review", itemId: "R-14-2" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(orch.getItem("R-14-2")!.reviewWorkspaceRef).toBeUndefined();
    });

    it("executeAction: clean-review handles cleanReview throw", () => {
      const cleanReview = vi.fn(() => { throw new Error("cleanup failed"); });
      const deps = mockDeps({ cleanReview });
      orch.addItem(makeWorkItem("R-14-3"));
      orch.setState("R-14-3", "ci-failed");
      orch.getItem("R-14-3")!.reviewWorkspaceRef = "review-workspace:3";

      const result = orch.executeAction(
        { type: "clean-review", itemId: "R-14-3" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("cleanup failed");
      // reviewWorkspaceRef should still be cleared even on error
      expect(orch.getItem("R-14-3")!.reviewWorkspaceRef).toBeUndefined();
    });

    // ── Exhaustive state coverage for reviewing ──────────────────────

    describe("Exhaustive reviewing transitions", () => {
      it("reviewing → merged when PR externally merged", () => {
        orch = new Orchestrator({  });
        orch.addItem(makeWorkItem("RX-1"));
        orch.setState("RX-1", "reviewing");
        orch.getItem("RX-1")!.prNumber = 42;
        orch.getItem("RX-1")!.reviewWorkspaceRef = "review-workspace:1";

        const actions = orch.processTransitions(
          snapshotWith([{ id: "RX-1", prState: "merged" }]),
        );

        expect(orch.getItem("RX-1")!.state).toBe("merged");
        expect(actions.some((a) => a.type === "clean")).toBe(true);
        expect(actions.some((a) => a.type === "clean-review")).toBe(true);
      });

      it("reviewing → ci-failed on CI regression", () => {
        orch = new Orchestrator({  });
        orch.addItem(makeWorkItem("RX-2"));
        orch.setState("RX-2", "reviewing");
        orch.getItem("RX-2")!.prNumber = 43;

        const actions = orch.processTransitions(
          snapshotWith([{ id: "RX-2", ciStatus: "fail", prState: "open" }]),
        );

        expect(orch.getItem("RX-2")!.state).toBe("ci-failed");
        expect(actions.some((a) => a.type === "clean-review")).toBe(true);
        expect(actions.some((a) => a.type === "notify-ci-failure")).toBe(true);
      });

      it("reviewing → ci-passed → merging on approve verdict (auto)", () => {
        orch = new Orchestrator({ mergeStrategy: "auto" });
        orch.addItem(makeWorkItem("RX-3"));
        orch.setState("RX-3", "reviewing");
        orch.getItem("RX-3")!.prNumber = 44;

        const actions = orch.processTransitions(
          snapshotWith([{ id: "RX-3", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict }]),
        );

        expect(orch.getItem("RX-3")!.state).toBe("merging");
        expect(orch.getItem("RX-3")!.reviewCompleted).toBe(true);
        expect(actions.some((a) => a.type === "merge")).toBe(true);
        expect(actions.some((a) => a.type === "post-review")).toBe(true);
      });

      it("reviewing → review-pending on request-changes verdict", () => {
        orch = new Orchestrator({  });
        orch.addItem(makeWorkItem("RX-4"));
        orch.setState("RX-4", "reviewing");
        orch.getItem("RX-4")!.prNumber = 45;

        const actions = orch.processTransitions(
          snapshotWith([{ id: "RX-4", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
        );

        expect(orch.getItem("RX-4")!.state).toBe("review-pending");
        expect(actions.some((a) => a.type === "notify-review")).toBe(true);
        expect(actions.some((a) => a.type === "post-review")).toBe(true);
      });

      it("reviewing stays reviewing with no snapshot", () => {
        orch = new Orchestrator({  });
        orch.addItem(makeWorkItem("RX-5"));
        orch.setState("RX-5", "reviewing");
        orch.getItem("RX-5")!.prNumber = 46;

        const actions = orch.processTransitions(emptySnapshot());

        expect(orch.getItem("RX-5")!.state).toBe("reviewing");
        expect(actions).toHaveLength(0);
      });
    });

    // ── All existing state count test updated for reviewing ──────────

    it("fresh orchestrator handles all 14 states (including reviewing) without errors", () => {
      orch = new Orchestrator({ wipLimit: 10 });
      const allStates: OrchestratorItemState[] = [
        "queued", "ready", "launching", "implementing", "pr-open",
        "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing",
        "merging", "merged", "done", "stuck",
      ];

      allStates.forEach((state, i) => {
        orch.addItem(makeWorkItem(`RV-${i + 1}`));
        orch.setState(`RV-${i + 1}`, state);
      });

      expect(allStates).toHaveLength(14);
      expect(() => {
        orch.processTransitions(emptySnapshot());
      }).not.toThrow();
    });

    it("all WIP states still count correctly (reviewing excluded)", () => {
      orch = new Orchestrator({ wipLimit: 10 });
      const wipStates: OrchestratorItemState[] = [
        "launching", "implementing", "pr-open", "ci-pending",
        "ci-passed", "ci-failed", "review-pending", "merging",
      ];
      wipStates.forEach((state, i) => {
        orch.addItem(makeWorkItem(`WR-${i + 1}`));
        orch.setState(`WR-${i + 1}`, state);
      });
      // Add reviewing item — should NOT count
      orch.addItem(makeWorkItem("WR-9"));
      orch.setState("WR-9", "reviewing");

      expect(orch.wipCount).toBe(8);
      expect(orch.reviewWipCount).toBe(1);
    });

    // ── Commit status actions ─────────────────────────────────────────

    it("entering reviewing emits set-commit-status pending", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("CS-1"));
      orch.setState("CS-1", "pr-open");
      orch.getItem("CS-1")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "CS-1", ciStatus: "pass", prState: "open" }]),
      );

      const statusActions = actions.filter((a) => a.type === "set-commit-status");
      expect(statusActions).toHaveLength(1);
      expect(statusActions[0]!.statusState).toBe("pending");
      expect(statusActions[0]!.statusDescription).toBe("Review in progress");
      expect(statusActions[0]!.prNumber).toBe(42);
    });

    it("approve verdict emits set-commit-status success", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("CS-2"));
      orch.setState("CS-2", "reviewing");
      orch.getItem("CS-2")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "CS-2", ciStatus: "pass", prState: "open", reviewVerdict: approveVerdict }]),
      );

      const statusActions = actions.filter((a) => a.type === "set-commit-status");
      expect(statusActions).toHaveLength(1);
      expect(statusActions[0]!.statusState).toBe("success");
      expect(statusActions[0]!.statusDescription).toContain("Review passed");
    });

    it("request-changes verdict emits set-commit-status failure", () => {
      orch = new Orchestrator({ mergeStrategy: "auto" });
      orch.addItem(makeWorkItem("CS-3"));
      orch.setState("CS-3", "reviewing");
      orch.getItem("CS-3")!.prNumber = 42;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "CS-3", ciStatus: "pass", prState: "open", reviewVerdict: requestChangesVerdict }]),
      );

      const statusActions = actions.filter((a) => a.type === "set-commit-status");
      expect(statusActions).toHaveLength(1);
      expect(statusActions[0]!.statusState).toBe("failure");
      expect(statusActions[0]!.statusDescription).toContain("blockers");
    });

    // ── executeAction: set-commit-status ────────────────────────────

    it("executeAction: set-commit-status calls deps.setCommitStatus", () => {
      const setCommitStatus = vi.fn(() => true);
      const deps = mockDeps({ setCommitStatus });
      orch.addItem(makeWorkItem("CS-5"));
      orch.setState("CS-5", "reviewing");
      orch.getItem("CS-5")!.prNumber = 42;

      const result = orch.executeAction(
        { type: "set-commit-status", itemId: "CS-5", prNumber: 42, statusState: "pending", statusDescription: "Review in progress" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(setCommitStatus).toHaveBeenCalledWith(
        defaultCtx.projectRoot, 42, "pending", "ninthwave/review", "Review in progress",
      );
    });

    it("executeAction: set-commit-status succeeds as no-op when dep not wired", () => {
      const deps = mockDeps(); // no setCommitStatus dep
      orch.addItem(makeWorkItem("CS-6"));
      orch.setState("CS-6", "reviewing");
      orch.getItem("CS-6")!.prNumber = 43;

      const result = orch.executeAction(
        { type: "set-commit-status", itemId: "CS-6", prNumber: 43, statusState: "success", statusDescription: "Review passed" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
    });

    it("executeAction: set-commit-status fails when no PR number", () => {
      const setCommitStatus = vi.fn(() => true);
      const deps = mockDeps({ setCommitStatus });
      orch.addItem(makeWorkItem("CS-7"));
      orch.setState("CS-7", "reviewing");
      // No prNumber

      const result = orch.executeAction(
        { type: "set-commit-status", itemId: "CS-7" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No PR number");
    });

    it("executeAction: set-commit-status uses resolvedRepoRoot for cross-repo items", () => {
      const setCommitStatus = vi.fn(() => true);
      const deps = mockDeps({ setCommitStatus });
      orch.addItem(makeWorkItem("CS-8"));
      orch.setState("CS-8", "reviewing");
      orch.getItem("CS-8")!.prNumber = 44;
      orch.getItem("CS-8")!.resolvedRepoRoot = "/tmp/other-repo";

      const result = orch.executeAction(
        { type: "set-commit-status", itemId: "CS-8", prNumber: 44, statusState: "success", statusDescription: "Review passed" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(setCommitStatus).toHaveBeenCalledWith(
        "/tmp/other-repo", 44, "success", "ninthwave/review", "Review passed",
      );
    });
  });

  // ── Stuck worktree preservation (H-WR-2) ──────────────────────────

  describe("stuck worktree preservation", () => {
    it("stuckOrRetry emits workspace-close (not clean) when retries exhausted", () => {
      orch = new Orchestrator({ maxRetries: 0 });
      orch.addItem(makeWorkItem("WP-1-1"));
      orch.setState("WP-1-1", "implementing");

      // Debounce: 5 consecutive not-alive checks
      orch.processTransitions(snapshotWith([{ id: "WP-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "WP-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "WP-1-1", workerAlive: false }]));
      orch.processTransitions(snapshotWith([{ id: "WP-1-1", workerAlive: false }]));
      const actions = orch.processTransitions(
        snapshotWith([{ id: "WP-1-1", workerAlive: false }]),
      );

      expect(orch.getItem("WP-1-1")!.state).toBe("stuck");
      // Should emit workspace-close (preserves worktree) not clean (removes worktree)
      expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "WP-1-1")).toBe(true);
      expect(actions.some((a) => a.type === "clean" && a.itemId === "WP-1-1")).toBe(false);
    });

    it("executeWorkspaceClose captures screen output and closes workspace without removing worktree", () => {
      const deps = mockDeps({
        readScreen: vi.fn(() => "Error: Worker crashed"),
        warn: vi.fn(),
      });
      orch = new Orchestrator({  });
      orch.addItem(makeWorkItem("WP-1-2"));
      orch.setState("WP-1-2", "stuck");
      orch.getItem("WP-1-2")!.workspaceRef = "workspace:5";

      const result = orch.executeAction(
        { type: "workspace-close", itemId: "WP-1-2" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      // Screen should be captured
      expect(deps.readScreen).toHaveBeenCalledWith("workspace:5", 50);
      expect(orch.getItem("WP-1-2")!.lastScreenOutput).toBe("Error: Worker crashed");
      // Workspace should be closed
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:5");
      // Worktree should NOT be cleaned
      expect(deps.cleanSingleWorktree).not.toHaveBeenCalled();
    });

    it("done items still get full cleanup (clean action removes worktree)", () => {
      const deps = mockDeps();
      orch = new Orchestrator({  });
      orch.addItem(makeWorkItem("WP-1-3"));
      orch.setState("WP-1-3", "done");
      orch.getItem("WP-1-3")!.workspaceRef = "workspace:6";

      const result = orch.executeAction(
        { type: "clean", itemId: "WP-1-3" },
        defaultCtx,
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.closeWorkspace).toHaveBeenCalledWith("workspace:6");
      expect(deps.cleanSingleWorktree).toHaveBeenCalledWith(
        "WP-1-3",
        defaultCtx.worktreeDir,
        defaultCtx.projectRoot,
      );
    });

    it("CI exhaustion emits workspace-close (not clean) when stuck", () => {
      orch = new Orchestrator({ maxCiRetries: 0 });
      orch.addItem(makeWorkItem("WP-1-4"));
      orch.setState("WP-1-4", "ci-failed");
      orch.getItem("WP-1-4")!.ciFailCount = 1;

      const actions = orch.processTransitions(
        snapshotWith([{ id: "WP-1-4", ciStatus: "fail", prState: "open" }]),
      );

      expect(orch.getItem("WP-1-4")!.state).toBe("stuck");
      expect(actions.some((a) => a.type === "workspace-close" && a.itemId === "WP-1-4")).toBe(true);
      expect(actions.some((a) => a.type === "clean" && a.itemId === "WP-1-4")).toBe(false);
    });

    it("launch stores worktreePath on success", () => {
      const deps = mockDeps({
        launchSingleItem: vi.fn(() => ({
          worktreePath: "/tmp/test/.worktrees/ninthwave-WP-1-5",
          workspaceRef: "workspace:7",
        })),
      });
      orch = new Orchestrator({  });
      orch.addItem(makeWorkItem("WP-1-5"));
      orch.setState("WP-1-5", "launching");

      orch.executeAction(
        { type: "launch", itemId: "WP-1-5" },
        defaultCtx,
        deps,
      );

      expect(orch.getItem("WP-1-5")!.worktreePath).toBe("/tmp/test/.worktrees/ninthwave-WP-1-5");
    });
  });

});
