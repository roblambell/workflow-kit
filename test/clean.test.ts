// Tests for clean commands: cmdClean, cmdCleanSingle, cmdCloseWorkspace, cmdCloseWorkspaces.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { join } from "path";
import { mkdirSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

// Only mock modules that don't have their own test files.
vi.mock("../core/git.ts", () => ({
  isBranchMerged: vi.fn(() => false),
  removeWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
}));

vi.mock("../core/gh.ts", () => ({
  prList: vi.fn(() => []),
}));

vi.mock("../core/cmux.ts", () => ({
  isAvailable: vi.fn(() => true),
  listWorkspaces: vi.fn(() => ""),
  closeWorkspace: vi.fn(() => true),
}));

// Import mocked modules for assertions
import * as cmux from "../core/cmux.ts";
import * as git from "../core/git.ts";

// Import after mocks
import {
  cmdClean,
  cmdCleanSingle,
  cleanSingleWorktree,
  cmdCloseWorkspace,
  cmdCloseWorkspaces,
} from "../core/commands/clean.ts";

function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never;

  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof Error && !e.message.startsWith("EXIT:")) throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return lines.join("\n");
}

describe("cmdCloseWorkspaces", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("warns when cmux is not available", () => {
    (cmux.isAvailable as Mock).mockReturnValue(false);

    const output = captureOutput(() => cmdCloseWorkspaces());
    expect(output).toContain("cmux not available");
  });

  it("reports no workspaces when list is empty", () => {
    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue("");

    const output = captureOutput(() => cmdCloseWorkspaces());
    expect(output).toContain("No cmux workspaces");
  });

  it("closes matching todo workspaces", () => {
    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue(
      "workspace:1 TODO H-CI-2 some title\nworkspace:2 TODO M-CI-1 another title",
    );
    (cmux.closeWorkspace as Mock).mockReturnValue(true);

    const output = captureOutput(() => cmdCloseWorkspaces());
    expect(output).toContain("Closed 2 todo workspace(s)");
    expect(cmux.closeWorkspace as Mock).toHaveBeenCalledTimes(2);
  });
});

describe("cmdCloseWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("dies with no target ID", () => {
    const output = captureOutput(() => cmdCloseWorkspace(""));
    expect(output).toContain("Usage");
  });

  it("warns when cmux is not available", () => {
    (cmux.isAvailable as Mock).mockReturnValue(false);

    const output = captureOutput(() => cmdCloseWorkspace("H-CI-2"));
    expect(output).toContain("cmux not available");
  });

  it("closes the matching workspace", () => {
    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue(
      "workspace:1 TODO H-CI-2 some title\nworkspace:2 TODO M-CI-1 another",
    );
    (cmux.closeWorkspace as Mock).mockReturnValue(true);

    captureOutput(() => cmdCloseWorkspace("H-CI-2"));
    expect(cmux.closeWorkspace as Mock).toHaveBeenCalledWith("workspace:1");
    expect(cmux.closeWorkspace as Mock).toHaveBeenCalledTimes(1);
  });
});

describe("cleanSingleWorktree", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("returns false when worktree directory does not exist", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
    expect(result).toBe(false);
    expect(git.removeWorktree as Mock).not.toHaveBeenCalled();
  });

  it("returns true and cleans up when worktree exists", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
    expect(result).toBe(true);
    expect(git.removeWorktree as Mock).toHaveBeenCalled();
    expect(git.deleteBranch as Mock).toHaveBeenCalledWith(repo, "todo/H-CI-2");
    expect(git.deleteRemoteBranch as Mock).toHaveBeenCalledWith(repo, "todo/H-CI-2");
  });

  it("falls back to rmSync when removeWorktree throws", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    (git.removeWorktree as Mock).mockImplementation(() => {
      throw new Error("git worktree remove failed");
    });

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
    expect(result).toBe(true);
    // Worktree dir should be cleaned up by rmSync fallback
    expect(git.removeWorktree as Mock).toHaveBeenCalled();
  });

  it("continues cleanup even if branch deletion fails", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    (git.deleteBranch as Mock).mockImplementation(() => {
      throw new Error("branch not found");
    });
    (git.deleteRemoteBranch as Mock).mockImplementation(() => {
      throw new Error("remote branch not found");
    });

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
    expect(result).toBe(true);
    // Should still have been called despite throwing
    expect(git.deleteBranch as Mock).toHaveBeenCalled();
    expect(git.deleteRemoteBranch as Mock).toHaveBeenCalled();
  });
});

describe("cmdCleanSingle", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("dies with no target ID", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdCleanSingle([], worktreeDir, repo),
    );

    expect(output).toContain("Usage");
  });

  it("reports no worktree found when directory doesn't exist", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdCleanSingle(["H-CI-2"], worktreeDir, repo),
    );

    expect(output).toContain("No worktree found");
  });

  it("cleans existing worktree", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    // Create a fake worktree directory
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    const output = captureOutput(() =>
      cmdCleanSingle(["H-CI-2"], worktreeDir, repo),
    );

    expect(output).toContain("Cleaned worktree for H-CI-2");
    expect(git.removeWorktree as Mock).toHaveBeenCalled();
  });
});

describe("cmdClean", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("reports no worktrees when directory doesn't exist", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue("");

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo),
    );

    expect(output).toContain("No worktrees to clean");
  });

  it("cleans merged worktrees", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue("");
    (git.isBranchMerged as Mock).mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(git.removeWorktree as Mock).toHaveBeenCalled();
  });

  it("does not clean unmerged worktrees without target ID", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue("");
    (git.isBranchMerged as Mock).mockReturnValue(false);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo),
    );

    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(git.removeWorktree as Mock).not.toHaveBeenCalled();
  });

  it("only closes the targeted workspace when cleaning a specific ID", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    // Create worktrees for H-1 (target), H-2, and H-3
    mkdirSync(join(worktreeDir, "todo-H-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-2"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-3"), { recursive: true });

    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue(
      "workspace:1 TODO H-1 first task\nworkspace:2 TODO H-2 second task\nworkspace:3 TODO H-3 third task",
    );
    (cmux.closeWorkspace as Mock).mockReturnValue(true);
    (git.isBranchMerged as Mock).mockReturnValue(false);

    captureOutput(() => cmdClean(["H-1"], worktreeDir, repo));

    // Should only close workspace:1 (H-1), not workspace:2 or workspace:3
    expect(cmux.closeWorkspace as Mock).toHaveBeenCalledTimes(1);
    expect(cmux.closeWorkspace as Mock).toHaveBeenCalledWith("workspace:1");
  });

  it("closes all workspaces when no target ID is specified", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-2"), { recursive: true });

    (cmux.isAvailable as Mock).mockReturnValue(true);
    (cmux.listWorkspaces as Mock).mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second",
    );
    (cmux.closeWorkspace as Mock).mockReturnValue(true);
    (git.isBranchMerged as Mock).mockReturnValue(true);

    captureOutput(() => cmdClean([], worktreeDir, repo));

    // Should close all todo workspaces when no target is specified
    expect(cmux.closeWorkspace as Mock).toHaveBeenCalledTimes(2);
  });
});
