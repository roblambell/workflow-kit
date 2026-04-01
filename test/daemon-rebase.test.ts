// Tests for daemonRebase() branch fetch fix -- verifies that daemonRebase
// fetches both origin/main and origin/<branch> before rebasing.
//
// Uses real temp git repos with a bare remote to exercise the actual
// git commands without mocks.

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { setupTempRepo, registerCleanup } from "./helpers.ts";
import { daemonRebase } from "../core/git.ts";
import {
  Orchestrator,
  type ExecutionContext,
  type OrchestratorDeps,
} from "../core/orchestrator.ts";
import type { WorkItem } from "../core/types.ts";

/** Helper: run a git command in a directory. */
function gitSetup(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return (result.stdout || "").trim();
}

/** Helper: create an initial commit. */
function initWithCommit(repo: string): void {
  writeFileSync(`${repo}/init.txt`, "init");
  gitSetup(repo, "add", ".");
  gitSetup(repo, "commit", "-m", "init", "--quiet");
  gitSetup(repo, "branch", "-M", "main");
}

describe("daemonRebase() fetches branch before rebasing", () => {
  registerCleanup();

  it("succeeds when both main and branch are fetchable", () => {
    // Setup: main repo with bare remote
    const origin = setupTempRepo();
    initWithCommit(origin);
    const bare = `${origin}-bare`;
    spawnSync("git", ["clone", "--bare", origin, bare], { stdio: "pipe" });

    // Create a worktree-like checkout that simulates the worker
    const worktree = setupTempRepo();
    initWithCommit(worktree);
    gitSetup(worktree, "remote", "add", "origin", bare);
    gitSetup(worktree, "fetch", "origin", "--quiet");

    // Create the branch on the worktree
    gitSetup(worktree, "checkout", "-b", "ninthwave/T-1");
    writeFileSync(`${worktree}/feature.txt`, "feature");
    gitSetup(worktree, "add", ".");
    gitSetup(worktree, "commit", "-m", "feature commit", "--quiet");
    gitSetup(worktree, "push", "origin", "ninthwave/T-1");

    // daemonRebase should succeed (fetches main + branch + rebases)
    const result = daemonRebase(worktree, "ninthwave/T-1");
    expect(result).toBe(true);
  });

  it("returns false when branch fetch fails (branch not on remote)", () => {
    const origin = setupTempRepo();
    initWithCommit(origin);
    const bare = `${origin}-bare`;
    spawnSync("git", ["clone", "--bare", origin, bare], { stdio: "pipe" });

    const worktree = setupTempRepo();
    initWithCommit(worktree);
    gitSetup(worktree, "remote", "add", "origin", bare);
    gitSetup(worktree, "fetch", "origin", "--quiet");

    // Create a local branch but DON'T push it to the remote
    gitSetup(worktree, "checkout", "-b", "ninthwave/UNPUSHED");
    writeFileSync(`${worktree}/local.txt`, "local only");
    gitSetup(worktree, "add", ".");
    gitSetup(worktree, "commit", "-m", "local commit", "--quiet");

    // daemonRebase should return false because fetching the branch fails
    const result = daemonRebase(worktree, "ninthwave/UNPUSHED");
    expect(result).toBe(false);
  });

  it("picks up remote changes to the branch via fetch", () => {
    // This is the key scenario: a worker pushed new commits to the branch
    // since the daemon last fetched. Without the branch fetch, the rebase
    // would operate on stale local state.
    const origin = setupTempRepo();
    initWithCommit(origin);
    const bare = `${origin}-bare`;
    spawnSync("git", ["clone", "--bare", origin, bare], { stdio: "pipe" });

    // Set up the worktree with the branch
    const worktree = setupTempRepo();
    initWithCommit(worktree);
    gitSetup(worktree, "remote", "add", "origin", bare);
    gitSetup(worktree, "fetch", "origin", "--quiet");
    gitSetup(worktree, "checkout", "-b", "ninthwave/T-2");
    writeFileSync(`${worktree}/feature.txt`, "v1");
    gitSetup(worktree, "add", ".");
    gitSetup(worktree, "commit", "-m", "feature v1", "--quiet");
    gitSetup(worktree, "push", "origin", "ninthwave/T-2");

    // Simulate a worker pushing a new commit to the branch on the remote
    // (by pushing directly to the bare repo from another clone)
    const worker = setupTempRepo();
    initWithCommit(worker);
    gitSetup(worker, "remote", "add", "origin", bare);
    gitSetup(worker, "fetch", "origin", "--quiet");
    gitSetup(worker, "checkout", "-b", "ninthwave/T-2", "origin/ninthwave/T-2");
    writeFileSync(`${worker}/feature.txt`, "v2 from worker");
    gitSetup(worker, "add", ".");
    gitSetup(worker, "commit", "-m", "feature v2", "--quiet");
    gitSetup(worker, "push", "origin", "ninthwave/T-2");

    // Now daemonRebase should fetch the latest branch state (with worker's commit)
    // and successfully rebase
    const result = daemonRebase(worktree, "ninthwave/T-2");
    expect(result).toBe(true);
  });
});

function makeWorkItem(id: string): WorkItem {
  return {
    id,
    priority: "high",
    title: `Item ${id}`,
    domain: "test",
    dependencies: [],
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

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.ninthwave/.worktrees",
  workDir: "/tmp/test-project/.ninthwave/work",
  aiTool: "claude",
  hubRepoNwo: "test-owner/test-repo",
};

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
    writeInbox: vi.fn(),
    closeWorkspace: vi.fn(() => true),
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
    ...overrides,
  };
}

describe("daemon-rebase action escalation", () => {
  it("escalates stale conflicts to the rebaser even when the worker is alive", () => {
    const daemonRebaseDep = vi.fn(() => false);
    const launchRebaser = vi.fn(() => ({ workspaceRef: "rebaser:1" }));
    const deps = mockDeps({ daemonRebase: daemonRebaseDep, launchRebaser });
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";

    const result = orch.executeAction(
      { type: "daemon-rebase", itemId: "H-1-1", message: "Rebase needed.", escalateToRebaser: true },
      defaultCtx,
      deps,
    );

    expect(result.success).toBe(true);
    expect(daemonRebaseDep).toHaveBeenCalled();
    expect(launchRebaser).toHaveBeenCalledWith("H-1-1", 42, defaultCtx.projectRoot, defaultCtx.aiTool);
    expect(deps.writeInbox).not.toHaveBeenCalled();
    expect(item.state).toBe("rebasing");
    expect(item.rebaseAttemptCount).toBe(1);
  });

  it("honors the maxRebaseAttempts circuit breaker during escalation", () => {
    const launchRebaser = vi.fn(() => ({ workspaceRef: "rebaser:1" }));
    const deps = mockDeps({ daemonRebase: vi.fn(() => false), launchRebaser });
    const orch = new Orchestrator({ maxRebaseAttempts: 2 });
    orch.addItem(makeWorkItem("H-1-1"));
    orch.getItem("H-1-1")!.reviewCompleted = true;
    orch.hydrateState("H-1-1", "ci-pending");
    const item = orch.getItem("H-1-1")!;
    item.prNumber = 42;
    item.workspaceRef = "workspace:1";
    item.rebaseAttemptCount = 2;

    const result = orch.executeAction(
      { type: "daemon-rebase", itemId: "H-1-1", escalateToRebaser: true },
      defaultCtx,
      deps,
    );

    expect(result.success).toBe(false);
    expect(item.state).toBe("stuck");
    expect(item.failureReason).toContain("rebase-loop");
    expect(launchRebaser).not.toHaveBeenCalled();
  });
});
