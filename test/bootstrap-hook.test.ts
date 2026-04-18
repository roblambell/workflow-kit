// Tests for the post-worktree-create bootstrap hook and stale index.lock cleanup.

import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "path";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import type { Mock } from "vitest";
import { setupTempRepo, cleanupTempRepos, captureOutput } from "./helpers.ts";
import type { Multiplexer } from "../core/mux.ts";
import {
  type LaunchGitDeps,
  cleanStaleIndexLocks,
  runBootstrapHook,
  launchSingleItem,
  BOOTSTRAP_HOOK_TIMEOUT_MS,
} from "../core/commands/launch.ts";
import { parseWorkItems } from "../core/parser.ts";

type MockMux = Multiplexer & {
  isAvailable: Mock;
  diagnoseUnavailable: Mock;
  launchWorkspace: Mock;
  getLastLaunchError: Mock;
  splitPane: Mock;
  sendMessage: Mock;
  writeInbox: Mock;
  readScreen: Mock;
  listWorkspaces: Mock;
  closeWorkspace: Mock;
  setStatus: Mock;
  setProgress: Mock;
};

type MockLaunchDeps = LaunchGitDeps & {
  fetchOrigin: Mock;
  ffMerge: Mock;
  resetHard: Mock;
  branchExists: Mock;
  createWorktree: Mock;
  attachWorktree: Mock;
  removeWorktree: Mock;
  deleteBranch: Mock;
  findWorktreeForBranch: Mock;
  prList: Mock;
};

function createMockMux(type: Multiplexer["type"] = "cmux"): MockMux {
  return {
    type,
    isAvailable: vi.fn(() => true),
    diagnoseUnavailable: vi.fn(() => "not available"),
    launchWorkspace: vi.fn(() => "workspace:1"),
    getLastLaunchError: vi.fn(() => undefined),
    splitPane: vi.fn(() => "pane:1"),
    sendMessage: vi.fn(() => true),
    writeInbox: vi.fn(),
    readScreen: vi.fn(() => "line1\nline2\nline3\nline4\n"),
    listWorkspaces: vi.fn(() => ""),
    closeWorkspace: vi.fn(() => true),
    setStatus: vi.fn(() => true),
    setProgress: vi.fn(() => true),
  } as MockMux;
}

function createMockLaunchDeps(): MockLaunchDeps {
  return {
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
    resetHard: vi.fn(),
    branchExists: vi.fn(() => false),
    createWorktree: vi.fn((_repo: string, wtPath: string) => {
      mkdirSync(wtPath, { recursive: true });
    }),
    attachWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    deleteBranch: vi.fn(),
    findWorktreeForBranch: vi.fn(() => null),
    prList: vi.fn(() => ({ ok: true as const, data: [] as Array<{ number: number; title: string }> })),
  } as MockLaunchDeps;
}

function setupWorkItemsDir(repo: string): string {
  const workDir = join(repo, ".ninthwave", "work");
  mkdirSync(workDir, { recursive: true });

  writeFileSync(
    join(workDir, "2-test-domain--M-CI-1.md"),
    [
      "# Upgrade CI runners (M-CI-1)",
      "",
      "**Priority:** Medium",
      "**Source:** Manual request",
      "**Depends on:** None",
      "**Domain:** test-domain",
      "",
      "Upgrade CI runners.",
      "",
      "Acceptance: CI runners upgraded.",
      "",
      "Key files: `.github/workflows/ci.yml`",
      "",
    ].join("\n"),
  );

  // Commit and push so origin/main-sourced readers can see the files.
  const { spawnSync } = require("child_process");
  spawnSync("git", ["-C", repo, "add", ".ninthwave/work/"], { stdio: "pipe" });
  spawnSync("git", ["-C", repo, "commit", "-m", "add work items", "--allow-empty"], { stdio: "pipe" });
  spawnSync("git", ["-C", repo, "push", "--quiet"], { stdio: "pipe" });

  return workDir;
}

// ── cleanStaleIndexLocks ──────────────────────────────────────────────

describe("cleanStaleIndexLocks", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("removes stale index.lock files older than 60 seconds", () => {
    const repo = setupTempRepo();
    const worktreesDir = join(repo, ".git", "worktrees", "test-wt");
    mkdirSync(worktreesDir, { recursive: true });

    const lockPath = join(worktreesDir, "index.lock");
    writeFileSync(lockPath, "");

    // Backdate the file's mtime to make it stale (> 60s)
    const past = new Date(Date.now() - 120_000);
    const { utimesSync } = require("fs");
    utimesSync(lockPath, past, past);

    const output = captureOutput(() => {
      cleanStaleIndexLocks(repo);
    });

    expect(existsSync(lockPath)).toBe(false);
    expect(output).toContain("Removed stale index.lock");
  });

  it("does not remove fresh index.lock files", () => {
    const repo = setupTempRepo();
    const worktreesDir = join(repo, ".git", "worktrees", "test-wt");
    mkdirSync(worktreesDir, { recursive: true });

    const lockPath = join(worktreesDir, "index.lock");
    writeFileSync(lockPath, "");
    // File was just created -- mtime is now, which is < 60s

    captureOutput(() => {
      cleanStaleIndexLocks(repo);
    });

    expect(existsSync(lockPath)).toBe(true);
  });

  it("is a no-op when no .git/worktrees directory exists", () => {
    const repo = setupTempRepo();
    // A fresh git repo may not have .git/worktrees/ at all
    expect(() => cleanStaleIndexLocks(repo)).not.toThrow();
  });

  it("handles multiple worktree entries", () => {
    const repo = setupTempRepo();
    const { utimesSync } = require("fs");
    const past = new Date(Date.now() - 120_000);

    for (const name of ["wt-a", "wt-b", "wt-c"]) {
      const dir = join(repo, ".git", "worktrees", name);
      mkdirSync(dir, { recursive: true });
      const lockPath = join(dir, "index.lock");
      writeFileSync(lockPath, "");
      utimesSync(lockPath, past, past);
    }

    captureOutput(() => {
      cleanStaleIndexLocks(repo);
    });

    for (const name of ["wt-a", "wt-b", "wt-c"]) {
      expect(existsSync(join(repo, ".git", "worktrees", name, "index.lock"))).toBe(false);
    }
  });
});

// ── runBootstrapHook ──────────────────────────────────────────────────

describe("runBootstrapHook", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("calls the hook with correct args (worktreePath, hubRoot, workItemId)", () => {
    const repo = setupTempRepo();
    const hooksDir = join(repo, ".ninthwave", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    // Write a hook that echoes its args to a marker file
    const hookPath = join(hooksDir, "post-worktree-create");
    const markerFile = join(repo, "hook-args.txt");
    writeFileSync(hookPath, `#!/usr/bin/env bash\necho "$1 $2 $3" > "${markerFile}"\n`);
    chmodSync(hookPath, 0o755);

    const worktreePath = join(repo, ".ninthwave", ".worktrees", "ninthwave-T-1");
    const result = runBootstrapHook(repo, worktreePath, "T-1");

    expect(result.ok).toBe(true);
    const { readFileSync } = require("fs");
    const args = readFileSync(markerFile, "utf-8").trim();
    expect(args).toBe(`${worktreePath} ${repo} T-1`);
  });

  it("returns ok:false when hook exits non-zero", () => {
    const repo = setupTempRepo();
    const hooksDir = join(repo, ".ninthwave", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    const hookPath = join(hooksDir, "post-worktree-create");
    writeFileSync(hookPath, `#!/usr/bin/env bash\necho "setup failed" >&2\nexit 1\n`);
    chmodSync(hookPath, 0o755);

    const output = captureOutput(() => {
      const result = runBootstrapHook(repo, "/tmp/wt", "T-1");
      expect(result.ok).toBe(false);
      expect(result.output).toContain("setup failed");
    });

    expect(output).toContain("Bootstrap hook failed for T-1");
  });

  it("returns ok:false when hook is not executable", () => {
    const repo = setupTempRepo();
    const hooksDir = join(repo, ".ninthwave", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    const hookPath = join(hooksDir, "post-worktree-create");
    writeFileSync(hookPath, `#!/usr/bin/env bash\necho "hello"\n`);
    chmodSync(hookPath, 0o644); // not executable

    const output = captureOutput(() => {
      const result = runBootstrapHook(repo, "/tmp/wt", "T-1");
      expect(result.ok).toBe(false);
      expect(result.output).toContain("not executable");
    });

    expect(output).toContain("not executable");
  });

  it("is a silent no-op when hook file is missing", () => {
    const repo = setupTempRepo();
    // No .ninthwave/hooks/ directory at all

    const result = runBootstrapHook(repo, "/tmp/wt", "T-1");

    expect(result.ok).toBe(true);
    expect(result.output).toBeUndefined();
  });

  it("captures stdout and stderr from the hook", () => {
    const repo = setupTempRepo();
    const hooksDir = join(repo, ".ninthwave", "hooks");
    mkdirSync(hooksDir, { recursive: true });

    const hookPath = join(hooksDir, "post-worktree-create");
    writeFileSync(hookPath, `#!/usr/bin/env bash\necho "installing deps"\necho "warning: cache miss" >&2\n`);
    chmodSync(hookPath, 0o755);

    const result = runBootstrapHook(repo, "/tmp/wt", "T-1");

    expect(result.ok).toBe(true);
    expect(result.output).toContain("installing deps");
    expect(result.output).toContain("warning: cache miss");
  });

  it("exports the correct timeout constant (5 minutes)", () => {
    expect(BOOTSTRAP_HOOK_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

// ── launchSingleItem + bootstrap hook integration ─────────────────────

describe("launchSingleItem bootstrap hook integration", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("calls bootstrap hook after worktree creation and before AI session", () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Create a hook that writes a marker file in the worktree
    const hooksDir = join(repo, ".ninthwave", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "post-worktree-create");
    writeFileSync(hookPath, `#!/usr/bin/env bash\nmkdir -p "$1/node_modules"\ntouch "$1/node_modules/.installed"\n`);
    chmodSync(hookPath, 0o755);

    const output = captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    // Verify the hook ran (marker file exists)
    const worktreePath = join(worktreeDir, "ninthwave-M-CI-1");
    expect(existsSync(join(worktreePath, "node_modules", ".installed"))).toBe(true);

    // Verify the AI session was still launched
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
    expect(output).toContain("Bootstrap hook completed for M-CI-1");
  });

  it("returns null when bootstrap hook fails (exit non-zero)", () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Create a hook that fails
    const hooksDir = join(repo, ".ninthwave", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "post-worktree-create");
    writeFileSync(hookPath, `#!/usr/bin/env bash\necho "npm install failed" >&2\nexit 1\n`);
    chmodSync(hookPath, 0o755);

    const output = captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).toBeNull();
    });

    // AI session should NOT have been launched
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
    // Cleanup should run
    expect(output).toContain("Launch failed for M-CI-1, cleaning up");
    expect(output).toContain("Bootstrap hook failed");
  });

  it("succeeds when no bootstrap hook exists (backwards compatible)", () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // No hooks directory -- should be a no-op
    const output = captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    // AI session should still be launched
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
    // No bootstrap hook output
    expect(output).not.toContain("Bootstrap hook");
  });

  it("cleans stale index.lock before creating worktree", () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Create a stale index.lock
    const staleDir = join(repo, ".git", "worktrees", "old-wt");
    mkdirSync(staleDir, { recursive: true });
    const lockPath = join(staleDir, "index.lock");
    writeFileSync(lockPath, "");
    const { utimesSync } = require("fs");
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockPath, past, past);

    const output = captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
    });

    // Stale lock should have been cleaned
    expect(existsSync(lockPath)).toBe(false);
    expect(output).toContain("Removed stale index.lock");
  });
});
