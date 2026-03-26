// Tests for orchestrator dashboard lifecycle integration (H-REM-2).
// Covers: --remote flag, dashboard start/stop, PR comment posting,
// graceful degradation, and status display.

import { describe, it, expect, vi } from "vitest";
import {
  orchestrateLoop,
  type LogEntry,
  type OrchestrateLoopDeps,
  type OrchestrateLoopConfig,
} from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type OrchestratorItem,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";
import { renderStatus, daemonStateToStatusItems } from "../core/commands/status.ts";
import type { DaemonState } from "../core/daemon.ts";
import { serializeOrchestratorState } from "../core/daemon.ts";

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
    filePath: "",
    repoAlias: "",
    rawText: `## ${id}\nTest todo`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function mockActionDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/todo-test",
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

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  todosDir: "/tmp/test-project/.ninthwave/todos",
  aiTool: "claude",
};

// ── Tests ────────────────────────────────────────────────────────────

describe("orchestrateLoop — dashboard lifecycle", () => {
  it("starts dashboard with orchestrator when --remote is set (via dashboardPublicUrl in config)", async () => {
    // The dashboard server is started in cmdOrchestrate (integration-level),
    // but the loop receives the public URL via config. When the URL is present
    // and a PR is detected, it should post a comment.
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const prCommentFn = vi.fn(() => true);

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 42, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ prComment: prCommentFn }),
    };

    const config: OrchestrateLoopConfig = {
      dashboardPublicUrl: "https://my-project.ninthwave.sh/dashboard",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // Dashboard comment should have been posted once
    const commentCalls = prCommentFn.mock.calls.filter((call) =>
      (call[2] as string).includes("Live dashboard"),
    );
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]![2]).toContain("https://my-project.ninthwave.sh/dashboard");
    expect(commentCalls[0]![1]).toBe(42);

    // Log entry should confirm comment was posted
    expect(logs.some((l) => l.event === "dashboard_comment_posted")).toBe(true);
    const commentLog = logs.find((l) => l.event === "dashboard_comment_posted");
    expect(commentLog?.prNumber).toBe(42);
    expect(commentLog?.url).toBe("https://my-project.ninthwave.sh/dashboard");
  });

  it("does NOT start dashboard when --remote is not set (no dashboardPublicUrl)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const prCommentFn = vi.fn(() => true);

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 10, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ prComment: prCommentFn }),
    };

    // No dashboardPublicUrl — --remote not enabled
    await orchestrateLoop(orch, defaultCtx, deps, { maxIterations: 200 });

    // No dashboard comment should be posted (prComment only called for merge actions)
    const commentCalls = prCommentFn.mock.calls.filter((call) =>
      (call[2] as string).includes("Live dashboard"),
    );
    expect(commentCalls).toHaveLength(0);
    expect(logs.some((l) => l.event === "dashboard_comment_posted")).toBe(false);
  });

  it("posts PR comment once per run, not per item", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));
    orch.addItem(makeTodo("T-1-2"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const prCommentFn = vi.fn(() => true);

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1", "T-1-2"] };
        case 2:
          return {
            items: [
              { id: "T-1-1", workerAlive: true },
              { id: "T-1-2", workerAlive: true },
            ],
            readyIds: [],
          };
        case 3:
          // Both get PRs in the same cycle
          return {
            items: [
              { id: "T-1-1", prNumber: 10, prState: "open", ciStatus: "pass" },
              { id: "T-1-2", prNumber: 11, prState: "open", ciStatus: "pass" },
            ],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ prComment: prCommentFn }),
    };

    const config: OrchestrateLoopConfig = {
      dashboardPublicUrl: "https://dashboard.example.com",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // Only ONE dashboard comment should be posted across all items
    const commentCalls = prCommentFn.mock.calls.filter((call) =>
      (call[2] as string).includes("Live dashboard"),
    );
    expect(commentCalls).toHaveLength(1);

    // Only one log entry for dashboard comment
    const commentLogs = logs.filter((l) => l.event === "dashboard_comment_posted");
    expect(commentLogs).toHaveLength(1);
  });

  it("does not post PR comment when provider returns null (no dashboardPublicUrl)", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const prCommentFn = vi.fn(() => true);

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 5, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ prComment: prCommentFn }),
    };

    // dashboardPublicUrl is undefined — simulates provider returning null
    const config: OrchestrateLoopConfig = {};

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // No dashboard comment posted
    const commentCalls = prCommentFn.mock.calls.filter((call) =>
      (call[2] as string).includes("Live dashboard"),
    );
    expect(commentCalls).toHaveLength(0);
  });

  it("handles graceful degradation when dashboard comment fails", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    // Only throw for dashboard comments, not merge-related prComment calls
    const prCommentFn = vi.fn((_root: string, _pr: number, body: string) => {
      if (body.includes("Live dashboard")) {
        throw new Error("GitHub API error");
      }
      return true;
    });

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 99, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps({ prComment: prCommentFn }),
    };

    const config: OrchestrateLoopConfig = {
      dashboardPublicUrl: "https://dashboard.example.com",
    };

    // Should NOT throw — graceful degradation
    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // Item should still complete normally
    expect(orch.getItem("T-1-1")!.state).toBe("done");

    // Warning log should be emitted
    expect(logs.some((l) => l.event === "dashboard_comment_failed")).toBe(true);
  });
});

describe("status display — dashboard URL", () => {
  it("includes dashboard URL in state serialization", () => {
    const items: OrchestratorItem[] = [
      {
        id: "T-1-1",
        state: "implementing",
        todo: makeTodo("T-1-1"),
        prNumber: null,
        workspaceRef: "workspace:1",
        lastTransition: new Date().toISOString(),
        ciFailCount: 0,
        retryCount: 0,
      },
    ];

    const state = serializeOrchestratorState(items, 12345, new Date().toISOString(), {
      dashboardUrl: "http://localhost:19042",
      wipLimit: 3,
    });

    expect(state.dashboardUrl).toBe("http://localhost:19042");
    expect(state.wipLimit).toBe(3);
  });

  it("state serialization works without dashboard URL", () => {
    const items: OrchestratorItem[] = [];
    const state = serializeOrchestratorState(items, 12345, new Date().toISOString(), {
      wipLimit: 3,
    });

    expect(state.dashboardUrl).toBeUndefined();
  });
});

describe("cleanup on shutdown", () => {
  it("orchestrateLoop completes normally even with dashboard config", async () => {
    // Verifies the orchestrate loop doesn't break with dashboard config present
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1-1"] };
        case 2:
          return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
        case 3:
          return {
            items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }],
            readyIds: [],
          };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    const config: OrchestrateLoopConfig = {
      dashboardPublicUrl: "https://dashboard.example.com",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 });

    // Loop should complete normally with item done
    expect(orch.getItem("T-1-1")!.state).toBe("done");
    expect(logs.some((l) => l.event === "orchestrate_complete")).toBe(true);
  });

  it("shutdown via signal works with dashboard config", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    const abortController = new AbortController();

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle >= 2) {
        // Signal abort after first cycle
        abortController.abort();
      }
      return { items: [], readyIds: ["T-1-1"] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
    };

    const config: OrchestrateLoopConfig = {
      dashboardPublicUrl: "https://dashboard.example.com",
    };

    await orchestrateLoop(orch, defaultCtx, deps, { ...config, maxIterations: 200 }, abortController.signal);

    // Shutdown log emitted
    expect(logs.some((l) => l.event === "shutdown")).toBe(true);
  });
});
