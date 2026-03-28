// Tests for cross-repo TODO bootstrap support (H-ORC-9).
// Covers: bootstrap field parsing, bootstrapRepo function, orchestrator bootstrap actions,
// and status display mapping for the bootstrapping state.

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { setupTempRepo, setupTempRepoPair, cleanupTempRepos, writeTodoFiles } from "./helpers.ts";
import { parseTodoFile } from "../core/todo-files.ts";
import { parseTodos } from "../core/parser.ts";
import { bootstrapRepo, detectGhOrg } from "../core/cross-repo.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
  type Action,
} from "../core/orchestrator.ts";
import { mapDaemonItemState, stateLabel, stateColor, stateIcon } from "../core/commands/status.ts";
import type { TodoItem, Priority } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

afterEach(() => cleanupTempRepos());

function makeTodo(
  id: string,
  overrides: Partial<TodoItem> = {},
): TodoItem {
  return {
    id,
    priority: "high" as Priority,
    title: `TODO ${id}`,
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: `## ${id}\nTest todo`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
    ...overrides,
  };
}

function emptySnapshot(readyIds: string[] = []): PollSnapshot {
  return { items: [], readyIds };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  workDir: "/tmp/test-project/.ninthwave/work",
  aiTool: "claude",
};

function mockDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
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

// ── Bootstrap field parsing ──────────────────────────────────────────

describe("bootstrap field parsing", () => {
  it("parses bootstrap: true from a todo file", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-test--H-BST-1.md"),
      `# Bootstrap new repo (H-BST-1)

**Priority:** High
**Depends on:** None
**Domain:** test
**Repo:** new-repo
**Bootstrap:** true

Create a new repo and scaffold it.
`,
    );

    const item = parseTodoFile(join(workDir, "1-test--H-BST-1.md"));
    expect(item).not.toBeNull();
    expect(item!.bootstrap).toBe(true);
    expect(item!.repoAlias).toBe("new-repo");
  });

  it("parses bootstrap: false from a todo file", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-test--H-BST-2.md"),
      `# Normal todo (H-BST-2)

**Priority:** High
**Depends on:** None
**Domain:** test
**Repo:** existing-repo
**Bootstrap:** false

Work in existing repo.
`,
    );

    const item = parseTodoFile(join(workDir, "1-test--H-BST-2.md"));
    expect(item).not.toBeNull();
    expect(item!.bootstrap).toBe(false);
  });

  it("defaults bootstrap to false when not specified", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-test--H-BST-3.md"),
      `# Normal todo (H-BST-3)

**Priority:** High
**Depends on:** None
**Domain:** test

A standard todo without bootstrap field.
`,
    );

    const item = parseTodoFile(join(workDir, "1-test--H-BST-3.md"));
    expect(item).not.toBeNull();
    expect(item!.bootstrap).toBe(false);
  });

  it("bootstrap field is case-insensitive", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-test--H-BST-4.md"),
      `# Bootstrap case test (H-BST-4)

**Priority:** High
**Depends on:** None
**Domain:** test
**Repo:** new-repo
**Bootstrap:** True

Case insensitive.
`,
    );

    const item = parseTodoFile(join(workDir, "1-test--H-BST-4.md"));
    expect(item).not.toBeNull();
    expect(item!.bootstrap).toBe(true);
  });
});

// ── bootstrapRepo function ──────────────────────────────────────────

describe("bootstrapRepo", () => {
  it("returns exists for hub-local aliases (empty, self, hub)", () => {
    const repo = setupTempRepo();
    expect(bootstrapRepo("", repo)).toEqual({ status: "exists" });
    expect(bootstrapRepo("self", repo)).toEqual({ status: "exists" });
    expect(bootstrapRepo("hub", repo)).toEqual({ status: "exists" });
  });

  it("returns exists when repo already exists as sibling", () => {
    const hub = setupTempRepoPair();
    const result = bootstrapRepo("target-repo-a", hub);
    expect(result.status).toBe("exists");
  });

  it("bootstrap: true without Repo field is ignored (hub-local)", () => {
    const repo = setupTempRepo();
    const result = bootstrapRepo("", repo);
    expect(result.status).toBe("exists");
  });
});

// ── detectGhOrg ─────────────────────────────────────────────────────

describe("detectGhOrg", () => {
  it("returns empty string for repo without remote", () => {
    const repo = setupTempRepo();
    expect(detectGhOrg(repo)).toBe("");
  });
});

// ── Orchestrator bootstrap state machine ────────────────────────────

describe("orchestrator bootstrap", () => {
  it("emits bootstrap action for cross-repo item with bootstrap: true and no resolvedRepoRoot", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-1", {
      repoAlias: "new-repo",
      bootstrap: true,
    });

    orch.addItem(todo);
    // Mark as ready manually (simulating deps met)
    const item = orch.getItem("H-BST-1")!;
    item.state = "ready" as any;

    const actions = orch.processTransitions(emptySnapshot());

    // Should emit bootstrap, not launch
    const bootstrapAction = actions.find((a) => a.type === "bootstrap");
    expect(bootstrapAction).toBeDefined();
    expect(bootstrapAction!.itemId).toBe("H-BST-1");

    // Item should be in bootstrapping state
    expect(orch.getItem("H-BST-1")!.state).toBe("bootstrapping");
  });

  it("emits launch action for regular items (no bootstrap)", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-REG-1");

    orch.addItem(todo);
    const item = orch.getItem("H-REG-1")!;
    item.state = "ready" as any;

    const actions = orch.processTransitions(emptySnapshot());

    const launchAction = actions.find((a) => a.type === "launch");
    expect(launchAction).toBeDefined();
    expect(launchAction!.itemId).toBe("H-REG-1");

    // No bootstrap action
    expect(actions.find((a) => a.type === "bootstrap")).toBeUndefined();
    expect(orch.getItem("H-REG-1")!.state).toBe("launching");
  });

  it("emits launch (not bootstrap) when bootstrap: true but resolvedRepoRoot is already set", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-2", {
      repoAlias: "existing-repo",
      bootstrap: true,
    });

    orch.addItem(todo);
    const item = orch.getItem("H-BST-2")!;
    item.state = "ready" as any;
    item.resolvedRepoRoot = "/path/to/existing-repo"; // Already resolved

    const actions = orch.processTransitions(emptySnapshot());

    // Should emit launch, not bootstrap
    const launchAction = actions.find((a) => a.type === "launch");
    expect(launchAction).toBeDefined();
    expect(actions.find((a) => a.type === "bootstrap")).toBeUndefined();
  });

  it("emits launch (not bootstrap) when bootstrap: true but alias is hub-local", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-3", {
      repoAlias: "",
      bootstrap: true,
    });

    orch.addItem(todo);
    const item = orch.getItem("H-BST-3")!;
    item.state = "ready" as any;

    const actions = orch.processTransitions(emptySnapshot());

    expect(actions.find((a) => a.type === "launch")).toBeDefined();
    expect(actions.find((a) => a.type === "bootstrap")).toBeUndefined();
  });

  it("bootstrapping state counts toward WIP limit", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 1 });

    // Add bootstrap item
    const todo1 = makeTodo("H-BST-4", { repoAlias: "new-repo", bootstrap: true });
    orch.addItem(todo1);
    const item1 = orch.getItem("H-BST-4")!;
    item1.state = "ready" as any;

    // Add regular item
    const todo2 = makeTodo("H-REG-2");
    orch.addItem(todo2);
    const item2 = orch.getItem("H-REG-2")!;
    item2.state = "ready" as any;

    const actions = orch.processTransitions(emptySnapshot());

    // Only one action should be emitted (WIP limit = 1)
    expect(actions.length).toBe(1);
    expect(orch.wipCount).toBe(1);
  });
});

// ── executeBootstrap ────────────────────────────────────────────────

describe("executeBootstrap", () => {
  it("transitions to launching on successful bootstrap (cloned)", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-5", { repoAlias: "new-repo", bootstrap: true });
    orch.addItem(todo);

    const item = orch.getItem("H-BST-5")!;
    item.state = "bootstrapping" as any;

    const deps = mockDeps({
      bootstrapRepo: () => ({ status: "cloned" as const, path: "/tmp/new-repo" }),
    });

    const action: Action = { type: "bootstrap", itemId: "H-BST-5" };
    const result = orch.executeAction(action, defaultCtx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("launching");
    expect(item.resolvedRepoRoot).toBe("/tmp/new-repo");
  });

  it("transitions to launching on successful bootstrap (created)", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-6", { repoAlias: "brand-new-repo", bootstrap: true });
    orch.addItem(todo);

    const item = orch.getItem("H-BST-6")!;
    item.state = "bootstrapping" as any;

    const deps = mockDeps({
      bootstrapRepo: () => ({ status: "created" as const, path: "/tmp/brand-new-repo" }),
    });

    const action: Action = { type: "bootstrap", itemId: "H-BST-6" };
    const result = orch.executeAction(action, defaultCtx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("launching");
    expect(item.resolvedRepoRoot).toBe("/tmp/brand-new-repo");
  });

  it("transitions to stuck on bootstrap failure", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-7", { repoAlias: "new-repo", bootstrap: true });
    orch.addItem(todo);

    const item = orch.getItem("H-BST-7")!;
    item.state = "bootstrapping" as any;

    const deps = mockDeps({
      bootstrapRepo: () => ({ status: "failed" as const, reason: "network-error: connection refused" }),
    });

    const action: Action = { type: "bootstrap", itemId: "H-BST-7" };
    const result = orch.executeAction(action, defaultCtx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("bootstrap-failed");
    expect(item.failureReason).toContain("network-error");
  });

  it("transitions to stuck when bootstrapRepo dep is not provided", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-8", { repoAlias: "new-repo", bootstrap: true });
    orch.addItem(todo);

    const item = orch.getItem("H-BST-8")!;
    item.state = "bootstrapping" as any;

    const deps = mockDeps(); // No bootstrapRepo dep

    const action: Action = { type: "bootstrap", itemId: "H-BST-8" };
    const result = orch.executeAction(action, defaultCtx, deps);

    expect(result.success).toBe(false);
    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("bootstrap-failed");
  });

  it("bootstrap success with status exists does not set resolvedRepoRoot", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-9", { repoAlias: "existing", bootstrap: true });
    orch.addItem(todo);

    const item = orch.getItem("H-BST-9")!;
    item.state = "bootstrapping" as any;

    const deps = mockDeps({
      bootstrapRepo: () => ({ status: "exists" as const }),
    });

    const action: Action = { type: "bootstrap", itemId: "H-BST-9" };
    const result = orch.executeAction(action, defaultCtx, deps);

    expect(result.success).toBe(true);
    expect(item.state).toBe("launching");
    // resolvedRepoRoot should not be set since "exists" means it was already resolved
    expect(item.resolvedRepoRoot).toBeUndefined();
  });
});

// ── Existing cross-repo behavior preserved ──────────────────────────

describe("existing cross-repo behavior unchanged", () => {
  it("non-bootstrap cross-repo item goes to launch (not bootstrap)", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-XR-1", { repoAlias: "target-repo", bootstrap: false });
    orch.addItem(todo);

    const item = orch.getItem("H-XR-1")!;
    item.state = "ready" as any;
    item.resolvedRepoRoot = "/tmp/target-repo";

    const actions = orch.processTransitions(emptySnapshot());

    expect(actions.find((a) => a.type === "launch")).toBeDefined();
    expect(actions.find((a) => a.type === "bootstrap")).toBeUndefined();
    expect(item.state).toBe("launching");
  });

  it("items depending on a bootstrap item wait in queued", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 3 });

    // Bootstrap item
    const bootstrapTodo = makeTodo("H-BST-10", { repoAlias: "new-repo", bootstrap: true });
    orch.addItem(bootstrapTodo);
    const bootstrapItem = orch.getItem("H-BST-10")!;
    bootstrapItem.state = "bootstrapping" as any;

    // Dependent item
    const depTodo = makeTodo("H-DEP-1", { dependencies: ["H-BST-10"] });
    orch.addItem(depTodo);

    // Process — dep should stay queued since bootstrap isn't done
    const actions = orch.processTransitions(emptySnapshot([]));

    const depItem = orch.getItem("H-DEP-1")!;
    expect(depItem.state).toBe("queued");
  });
});

// ── Status display mapping ──────────────────────────────────────────

describe("bootstrapping status display", () => {
  it("mapDaemonItemState maps bootstrapping to bootstrapping", () => {
    expect(mapDaemonItemState("bootstrapping")).toBe("bootstrapping");
  });

  it("stateLabel shows Bootstrapping for bootstrapping state", () => {
    expect(stateLabel("bootstrapping")).toBe("Bootstrapping");
  });

  it("stateColor returns same color as implementing for bootstrapping", () => {
    // Both bootstrapping and implementing should use the same color (YELLOW)
    expect(stateColor("bootstrapping")).toBe(stateColor("implementing"));
  });

  it("stateIcon returns ▸ for bootstrapping", () => {
    expect(stateIcon("bootstrapping")).toBe("▸");
  });
});

// ── bootstrapping state in transitionItem ───────────────────────────

describe("bootstrapping state in transitionItem", () => {
  it("bootstrapping state emits no actions from transitionItem (handled by executeBootstrap)", () => {
    const orch = new Orchestrator({ reviewEnabled: false, wipLimit: 2 });
    const todo = makeTodo("H-BST-11", { repoAlias: "new-repo", bootstrap: true });
    orch.addItem(todo);

    const item = orch.getItem("H-BST-11")!;
    item.state = "bootstrapping" as any;

    // Process transitions with a snapshot — bootstrapping items should be inert
    const snapshot: PollSnapshot = {
      items: [{ id: "H-BST-11" }],
      readyIds: [],
    };
    const actions = orch.processTransitions(snapshot);

    // No actions should be emitted for the bootstrapping item
    const bootstrapActions = actions.filter((a) => a.itemId === "H-BST-11");
    expect(bootstrapActions).toHaveLength(0);
  });
});
