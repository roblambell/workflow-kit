// Tests for auto-save of uncommitted changes before session respawn.
// Covers autoSaveWorktree (git.ts) and executeRetry integration (orchestrator-actions.ts).

import { describe, it, expect, vi } from "vitest";
import { autoSaveWorktree } from "../core/git.ts";
import { executeRetry } from "../core/orchestrator-actions.ts";
import { setupTempRepo, registerCleanup } from "./helpers.ts";
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import type { RunResult } from "../core/types.ts";
import type {
  OrchestratorItem,
  ExecutionContext,
  OrchestratorDeps,
  DeepPartial,
} from "../core/orchestrator-types.ts";
import type { WorkItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

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

/** Create a mock shell runner that records calls and returns configured results. */
function mockRunner(results: Record<string, RunResult>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    // Find the git subcommand by skipping -C and its path argument.
    // Args are like: ["-C", "/path", "status", "--porcelain"]
    let i = 0;
    while (i < args.length) {
      if (args[i] === "-C") { i += 2; continue; }
      if (args[i]!.startsWith("-")) { i++; continue; }
      break;
    }
    const gitSubcmd = args[i];
    if (gitSubcmd && results[gitSubcmd]) return results[gitSubcmd]!;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { runner, calls };
}

function makeItem(id: string, overrides: Partial<OrchestratorItem> = {}): OrchestratorItem {
  return {
    id,
    state: "implementing",
    lastTransition: "2026-04-11T00:00:00Z",
    ciFailCount: 0,
    ciFailCountTotal: 0,
    retryCount: 0,
    workItem: {
      id,
      priority: "high",
      title: `Item ${id}`,
      domain: "test",
      dependencies: [],
      bundleWith: [],
      status: "open",
      filePath: "",
      rawText: "",
      filePaths: [],
      testPlan: "",
    },
    ...overrides,
  };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.ninthwave/.worktrees",
  workDir: "/tmp/test-project/.ninthwave/work",
  aiTool: "claude",
  hubRepoNwo: "test-owner/test-repo",
};

function mockDeps(overrides?: DeepPartial<OrchestratorDeps>): OrchestratorDeps {
  return {
    git: {
      fetchOrigin: vi.fn(),
      ffMerge: vi.fn(),
      ...overrides?.git,
    },
    gh: {
      prMerge: vi.fn(() => true),
      prComment: vi.fn(() => true),
      ...overrides?.gh,
    },
    mux: {
      sendMessage: vi.fn(() => true),
      closeWorkspace: vi.fn(() => true),
      ...overrides?.mux,
    },
    workers: {
      launchSingleItem: vi.fn(() => ({
        worktreePath: "/tmp/test/ninthwave-test",
        workspaceRef: "workspace:1",
      })),
      ...overrides?.workers,
    },
    cleanup: {
      cleanSingleWorktree: vi.fn(() => true),
      ...overrides?.cleanup,
    },
    io: {
      writeInbox: vi.fn(),
      ...overrides?.io,
    },
  };
}

// ── autoSaveWorktree unit tests (injectable runner) ──────────────────

describe("autoSaveWorktree", () => {
  it("runs git status --porcelain in the worktree", () => {
    const { runner, calls } = mockRunner({
      status: { stdout: "", stderr: "", exitCode: 0 },
    });

    autoSaveWorktree("/test/worktree", runner);

    const statusCall = calls.find((c) => c.args.includes("status"));
    expect(statusCall).toBeDefined();
    expect(statusCall!.args).toContain("-C");
    expect(statusCall!.args).toContain("/test/worktree");
    expect(statusCall!.args).toContain("--porcelain");
  });

  it("skips auto-save on clean worktree (no empty commits)", () => {
    const { runner, calls } = mockRunner({
      status: { stdout: "", stderr: "", exitCode: 0 },
    });

    const result = autoSaveWorktree("/test/worktree", runner);

    expect(result).toBe(true);
    // Should only have the status check -- no add, commit, or push
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("status");
  });

  it("commits and pushes dirty worktree with descriptive message", () => {
    const { runner, calls } = mockRunner({
      status: { stdout: " M file.ts\n?? new.ts", stderr: "", exitCode: 0 },
      add: { stdout: "", stderr: "", exitCode: 0 },
      commit: { stdout: "", stderr: "", exitCode: 0 },
      push: { stdout: "", stderr: "", exitCode: 0 },
    });

    const result = autoSaveWorktree("/test/worktree", runner);

    expect(result).toBe(true);
    expect(calls).toHaveLength(4);

    // Verify add -A
    const addCall = calls.find((c) => c.args.includes("add"));
    expect(addCall!.args).toContain("-A");

    // Verify commit message
    const commitCall = calls.find((c) => c.args.includes("commit"));
    expect(commitCall!.args).toContain("wip: ninthwave auto-save before respawn");

    // Verify push
    const pushCall = calls.find((c) => c.args.includes("push"));
    expect(pushCall!.args).toContain("--quiet");
  });

  it("returns false when git status fails", () => {
    const { runner } = mockRunner({
      status: { stdout: "", stderr: "fatal: not a git repo", exitCode: 128 },
    });

    const result = autoSaveWorktree("/test/worktree", runner);

    expect(result).toBe(false);
  });

  it("returns false when git add fails", () => {
    const { runner } = mockRunner({
      status: { stdout: " M file.ts", stderr: "", exitCode: 0 },
      add: { stdout: "", stderr: "error", exitCode: 1 },
    });

    const result = autoSaveWorktree("/test/worktree", runner);

    expect(result).toBe(false);
  });

  it("returns false when git commit fails", () => {
    const { runner } = mockRunner({
      status: { stdout: " M file.ts", stderr: "", exitCode: 0 },
      add: { stdout: "", stderr: "", exitCode: 0 },
      commit: { stdout: "", stderr: "error", exitCode: 1 },
    });

    const result = autoSaveWorktree("/test/worktree", runner);

    expect(result).toBe(false);
  });

  it("returns false when git push fails", () => {
    const { runner } = mockRunner({
      status: { stdout: " M file.ts", stderr: "", exitCode: 0 },
      add: { stdout: "", stderr: "", exitCode: 0 },
      commit: { stdout: "", stderr: "", exitCode: 0 },
      push: { stdout: "", stderr: "rejected", exitCode: 1 },
    });

    const result = autoSaveWorktree("/test/worktree", runner);

    expect(result).toBe(false);
  });
});

// ── autoSaveWorktree integration test (real git) ─────────────────────

describe("autoSaveWorktree with real git", () => {
  registerCleanup();

  it("auto-saves dirty worktree and pushes to remote", () => {
    // Setup: create a repo with a bare remote
    const origin = setupTempRepo();
    initWithCommit(origin);
    const bare = `${origin}-bare`;
    spawnSync("git", ["clone", "--bare", origin, bare], { stdio: "pipe" });

    // Create a worktree checkout
    const worktree = setupTempRepo();
    initWithCommit(worktree);
    gitSetup(worktree, "remote", "add", "origin", bare);
    gitSetup(worktree, "fetch", "origin", "--quiet");
    gitSetup(worktree, "checkout", "-b", "ninthwave/T-AUTO");
    gitSetup(worktree, "push", "-u", "origin", "ninthwave/T-AUTO");

    // Make dirty changes
    writeFileSync(`${worktree}/dirty.txt`, "uncommitted work");

    // Verify it's dirty
    const statusBefore = spawnSync("git", ["-C", worktree, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    expect(statusBefore.stdout!.trim()).toContain("dirty.txt");

    // Auto-save (uses real git via default run import)
    const result = autoSaveWorktree(worktree);
    expect(result).toBe(true);

    // Verify worktree is now clean
    const statusAfter = spawnSync("git", ["-C", worktree, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    expect(statusAfter.stdout!.trim()).toBe("");

    // Verify commit message
    const log = spawnSync("git", ["-C", worktree, "log", "--oneline", "-1"], {
      encoding: "utf-8",
    });
    expect(log.stdout!.trim()).toContain("wip: ninthwave auto-save before respawn");
  });

  it("skips clean worktree without creating empty commit", () => {
    const origin = setupTempRepo();
    initWithCommit(origin);
    const bare = `${origin}-bare`;
    spawnSync("git", ["clone", "--bare", origin, bare], { stdio: "pipe" });

    const worktree = setupTempRepo();
    initWithCommit(worktree);
    gitSetup(worktree, "remote", "add", "origin", bare);
    gitSetup(worktree, "fetch", "origin", "--quiet");

    // Get commit count before
    const logBefore = spawnSync("git", ["-C", worktree, "rev-list", "--count", "HEAD"], {
      encoding: "utf-8",
    });

    const result = autoSaveWorktree(worktree);
    expect(result).toBe(true);

    // Commit count should be unchanged
    const logAfter = spawnSync("git", ["-C", worktree, "rev-list", "--count", "HEAD"], {
      encoding: "utf-8",
    });
    expect(logAfter.stdout!.trim()).toBe(logBefore.stdout!.trim());
  });
});

// ── executeRetry integration tests ───────────────────────────────────

describe("executeRetry auto-save", () => {
  registerCleanup();

  it("calls autoSaveWorktree before closing workspace", () => {
    const autoSave = vi.fn(() => true);
    const closeWorkspace = vi.fn(() => true);
    const warn = vi.fn();
    const deps = mockDeps({
      git: { autoSaveWorktree: autoSave },
      mux: { closeWorkspace },
      io: { warn },
    });

    // Create a real directory so existsSync passes
    const worktreeDir = setupTempRepo();
    const ctx = { ...defaultCtx, worktreeDir };
    // Create the worktree path directory
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(worktreeDir, "ninthwave-H-TEST-1"), { recursive: true });

    const item = makeItem("H-TEST-1", {
      pendingRetryWorkspaceRef: "workspace:5",
    });

    executeRetry(item, ctx, deps);

    // autoSaveWorktree should be called before closeWorkspace
    expect(autoSave).toHaveBeenCalledWith(
      join(worktreeDir, "ninthwave-H-TEST-1"),
    );
    expect(closeWorkspace).toHaveBeenCalledWith("workspace:5");

    // Verify call order: autoSave before closeWorkspace
    const autoSaveOrder = autoSave.mock.invocationCallOrder[0];
    const closeOrder = closeWorkspace.mock.invocationCallOrder[0];
    expect(autoSaveOrder).toBeLessThan(closeOrder!);
  });

  it("logs when auto-save preserves changes", () => {
    const warn = vi.fn();
    const deps = mockDeps({
      git: { autoSaveWorktree: vi.fn(() => true) },
      io: { warn },
    });

    const worktreeDir = setupTempRepo();
    const ctx = { ...defaultCtx, worktreeDir };
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(worktreeDir, "ninthwave-H-TEST-1"), { recursive: true });

    const item = makeItem("H-TEST-1", {
      pendingRetryWorkspaceRef: "workspace:5",
    });

    executeRetry(item, ctx, deps);

    expect(warn).toHaveBeenCalledWith(
      "[H-TEST-1] Auto-saved uncommitted changes before respawn",
    );
  });

  it("skips auto-save when worktree path does not exist", () => {
    const autoSave = vi.fn(() => true);
    const deps = mockDeps({ git: { autoSaveWorktree: autoSave } });

    const item = makeItem("H-TEST-1", {
      worktreePath: "/nonexistent/path",
      pendingRetryWorkspaceRef: "workspace:5",
    });

    const result = executeRetry(item, defaultCtx, deps);

    expect(result.success).toBe(true);
    expect(autoSave).not.toHaveBeenCalled();
  });

  it("skips auto-save when autoSaveWorktree is not provided", () => {
    const deps = mockDeps(); // no autoSaveWorktree in deps

    const worktreeDir = setupTempRepo();
    const ctx = { ...defaultCtx, worktreeDir };
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(worktreeDir, "ninthwave-H-TEST-1"), { recursive: true });

    const item = makeItem("H-TEST-1", {
      pendingRetryWorkspaceRef: "workspace:5",
    });

    const result = executeRetry(item, ctx, deps);

    expect(result.success).toBe(true);
  });

  it("does not block retry when auto-save throws", () => {
    const autoSave = vi.fn(() => {
      throw new Error("git crashed");
    });
    const deps = mockDeps({
      git: { autoSaveWorktree: autoSave },
      mux: { closeWorkspace: vi.fn(() => true) },
    });

    const worktreeDir = setupTempRepo();
    const ctx = { ...defaultCtx, worktreeDir };
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(worktreeDir, "ninthwave-H-TEST-1"), { recursive: true });

    const item = makeItem("H-TEST-1", {
      pendingRetryWorkspaceRef: "workspace:5",
    });

    const result = executeRetry(item, ctx, deps);

    // Retry should still succeed despite auto-save failure
    expect(result.success).toBe(true);
    // Workspace should still be closed
    expect(deps.mux.closeWorkspace).toHaveBeenCalledWith("workspace:5");
  });

  it("does not block retry when auto-save returns false", () => {
    const autoSave = vi.fn(() => false);
    const deps = mockDeps({
      git: { autoSaveWorktree: autoSave },
      mux: { closeWorkspace: vi.fn(() => true) },
    });

    const worktreeDir = setupTempRepo();
    const ctx = { ...defaultCtx, worktreeDir };
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(worktreeDir, "ninthwave-H-TEST-1"), { recursive: true });

    const item = makeItem("H-TEST-1", {
      pendingRetryWorkspaceRef: "workspace:5",
    });

    const result = executeRetry(item, ctx, deps);

    expect(result.success).toBe(true);
    expect(deps.mux.closeWorkspace).toHaveBeenCalledWith("workspace:5");
  });

  it("uses item.worktreePath when available", () => {
    const autoSave = vi.fn(() => true);
    const deps = mockDeps({ git: { autoSaveWorktree: autoSave } });

    const worktreeDir = setupTempRepo();
    const worktreePath = `${worktreeDir}/custom-path`;
    const { mkdirSync } = require("fs");
    mkdirSync(worktreePath, { recursive: true });

    const item = makeItem("H-TEST-1", {
      worktreePath,
      pendingRetryWorkspaceRef: "workspace:5",
    });

    executeRetry(item, defaultCtx, deps);

    expect(autoSave).toHaveBeenCalledWith(worktreePath);
  });
});
