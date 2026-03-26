// Tests for clean commands: cmdClean, cmdCleanSingle, cmdCloseWorkspace, cmdCloseWorkspaces.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import type { Multiplexer } from "../core/mux.ts";

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

// Import mocked modules for assertions
import * as git from "../core/git.ts";

// Import after mocks
import {
  cmdClean,
  cmdCleanSingle,
  cleanSingleWorktree,
  cmdCloseWorkspace,
  cmdCloseWorkspaces,
} from "../core/commands/clean.ts";

/** Create a mock Multiplexer for dependency injection (avoids vi.mock leaking). */
function createMockMux(): Multiplexer & Record<string, Mock> {
  return {
    type: "cmux",
    isAvailable: vi.fn(() => true),
    diagnoseUnavailable: vi.fn(() => "not available"),
    launchWorkspace: vi.fn(() => "workspace:1"),
    splitPane: vi.fn(() => "pane:1"),
    sendMessage: vi.fn(() => true),
    readScreen: vi.fn(() => ""),
    listWorkspaces: vi.fn(() => ""),
    closeWorkspace: vi.fn(() => true),
  };
}

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
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);

    const output = captureOutput(() => cmdCloseWorkspaces(mockMux));
    expect(output).toContain("cmux not available");
  });

  it("reports no workspaces when list is empty", () => {
    const mockMux = createMockMux();
    mockMux.listWorkspaces.mockReturnValue("");

    const output = captureOutput(() => cmdCloseWorkspaces(mockMux));
    expect(output).toContain("No cmux workspaces");
  });

  it("closes matching todo workspaces", () => {
    const mockMux = createMockMux();
    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-2 some title\nworkspace:2 TODO M-CI-1 another title",
    );

    const output = captureOutput(() => cmdCloseWorkspaces(mockMux));
    expect(output).toContain("Closed 2 todo workspace(s)");
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(2);
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
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);

    const output = captureOutput(() => cmdCloseWorkspace("H-CI-2", mockMux));
    expect(output).toContain("cmux not available");
  });

  it("closes the matching workspace", () => {
    const mockMux = createMockMux();
    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-2 some title\nworkspace:2 TODO M-CI-1 another",
    );

    captureOutput(() => cmdCloseWorkspace("H-CI-2", mockMux));
    expect(mockMux.closeWorkspace).toHaveBeenCalledWith("workspace:1");
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(1);
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

  it("falls back to rmSync and logs warning when removeWorktree throws", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    (git.removeWorktree as Mock).mockImplementation(() => {
      throw new Error("git worktree remove failed");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
      expect(result).toBe(true);
    });
    expect(git.removeWorktree as Mock).toHaveBeenCalled();
    expect(output).toContain("Failed to remove worktree for H-CI-2");
    expect(output).toContain("git worktree remove failed");
  });

  it("logs warning when deleteBranch fails and continues cleanup", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    (git.deleteBranch as Mock).mockImplementation(() => {
      throw new Error("branch not found");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
      expect(result).toBe(true);
    });
    expect(git.deleteBranch as Mock).toHaveBeenCalled();
    expect(git.deleteRemoteBranch as Mock).toHaveBeenCalled();
    expect(output).toContain("Failed to delete local branch todo/H-CI-2");
    expect(output).toContain("branch not found");
  });

  it("logs warning when deleteRemoteBranch fails and continues cleanup", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    (git.deleteRemoteBranch as Mock).mockImplementation(() => {
      throw new Error("remote branch not found");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
      expect(result).toBe(true);
    });
    expect(git.deleteRemoteBranch as Mock).toHaveBeenCalled();
    expect(output).toContain("Failed to delete remote branch todo/H-CI-2");
    expect(output).toContain("remote branch not found");
  });

  it("completes cleanup even when all operations fail", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    (git.removeWorktree as Mock).mockImplementation(() => {
      throw new Error("worktree failed");
    });
    (git.deleteBranch as Mock).mockImplementation(() => {
      throw new Error("branch failed");
    });
    (git.deleteRemoteBranch as Mock).mockImplementation(() => {
      throw new Error("remote failed");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo);
      expect(result).toBe(true);
    });
    // All three warnings should be logged
    expect(output).toContain("Failed to remove worktree");
    expect(output).toContain("Failed to delete local branch");
    expect(output).toContain("Failed to delete remote branch");
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
    const mockMux = createMockMux();

    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("No worktrees to clean");
  });

  it("cleans merged worktrees", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (git.isBranchMerged as Mock).mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(git.removeWorktree as Mock).toHaveBeenCalled();
  });

  it("does not clean unmerged worktrees without target ID", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (git.isBranchMerged as Mock).mockReturnValue(false);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(git.removeWorktree as Mock).not.toHaveBeenCalled();
  });

  it("only closes the targeted workspace when cleaning a specific ID", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    // Create worktrees for H-1 (target), H-2, and H-3
    mkdirSync(join(worktreeDir, "todo-H-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-2"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-3"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-1 first task\nworkspace:2 TODO H-2 second task\nworkspace:3 TODO H-3 third task",
    );
    (git.isBranchMerged as Mock).mockReturnValue(false);

    captureOutput(() => cmdClean(["H-1"], worktreeDir, repo, mockMux));

    // Should only close workspace:1 (H-1), not workspace:2 or workspace:3
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(1);
    expect(mockMux.closeWorkspace).toHaveBeenCalledWith("workspace:1");
  });

  it("closes workspaces only for merged items when no target ID is specified", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second",
    );
    (git.isBranchMerged as Mock).mockReturnValue(true);

    captureOutput(() => cmdClean([], worktreeDir, repo, mockMux));

    // Should close workspaces for both items since both are merged
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("does not close workspaces for non-merged items (broad cleanup)", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    // Create worktrees for two items: H-CI-1 (merged) and H-CI-2 (not merged)
    mkdirSync(join(worktreeDir, "todo-H-CI-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second",
    );
    // H-CI-1 is merged, H-CI-2 is not
    (git.isBranchMerged as Mock).mockImplementation(
      (_repo: string, branch: string) => branch === "todo/H-CI-1",
    );

    captureOutput(() => cmdClean([], worktreeDir, repo, mockMux));

    // Should only close workspace:1 (H-CI-1 is merged), NOT workspace:2
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(1);
    expect(mockMux.closeWorkspace).toHaveBeenCalledWith("workspace:1");
    // Worktree removal should only happen for the merged item
    expect(git.removeWorktree as Mock).toHaveBeenCalledTimes(1);
  });

  it("preserves active workers for non-merged items", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    // Three items: all have active workspaces, none are merged
    mkdirSync(join(worktreeDir, "todo-H-CI-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-H-CI-3"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second\nworkspace:3 TODO H-CI-3 third",
    );
    (git.isBranchMerged as Mock).mockReturnValue(false);

    captureOutput(() => cmdClean([], worktreeDir, repo, mockMux));

    // No workspaces should be closed — all items are still active
    expect(mockMux.closeWorkspace).not.toHaveBeenCalled();
    // No worktrees should be removed
    expect(git.removeWorktree as Mock).not.toHaveBeenCalled();
  });

  it("logs warning when removeWorktree fails in cleanItem", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (git.isBranchMerged as Mock).mockReturnValue(true);
    (git.removeWorktree as Mock).mockImplementation(() => {
      throw new Error("worktree remove failed");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(output).toContain("Failed to remove worktree for H-CI-2");
    expect(output).toContain("worktree remove failed");
  });

  it("logs warning when deleteBranch fails in cleanItem", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (git.isBranchMerged as Mock).mockReturnValue(true);
    (git.deleteBranch as Mock).mockImplementation(() => {
      throw new Error("branch not found");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(output).toContain("Failed to delete local branch todo/H-CI-2");
  });

  it("logs warning when deleteRemoteBranch fails in cleanItem", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (git.isBranchMerged as Mock).mockReturnValue(true);
    (git.deleteRemoteBranch as Mock).mockImplementation(() => {
      throw new Error("remote branch not found");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(output).toContain("Failed to delete remote branch todo/H-CI-2");
  });

  it("completes cleanItem when all operations fail", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (git.isBranchMerged as Mock).mockReturnValue(true);
    (git.removeWorktree as Mock).mockImplementation(() => {
      throw new Error("worktree failed");
    });
    (git.deleteBranch as Mock).mockImplementation(() => {
      throw new Error("branch failed");
    });
    (git.deleteRemoteBranch as Mock).mockImplementation(() => {
      throw new Error("remote failed");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    // Should still complete and report cleaned
    expect(output).toContain("Cleaned 1 worktree(s)");
    // All three warnings should be logged
    expect(output).toContain("Failed to remove worktree");
    expect(output).toContain("Failed to delete local branch");
    expect(output).toContain("Failed to delete remote branch");
  });

  it("cleans cross-repo worktrees from index file", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Create a fake cross-repo worktree directory at a different location
    const crossRepoPath = join(repo, "external-repo", ".worktrees", "todo-X-CR-1");
    mkdirSync(crossRepoPath, { recursive: true });
    const crossRepoRoot = join(repo, "external-repo");
    mkdirSync(join(crossRepoRoot, ".git"), { recursive: true });

    // Write a cross-repo index entry
    const indexPath = join(worktreeDir, ".cross-repo-index");
    writeFileSync(indexPath, `X-CR-1\t${crossRepoRoot}\t${crossRepoPath}\n`);

    // Mark the branch as merged so cmdClean will clean it
    (git.isBranchMerged as Mock).mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(git.removeWorktree as Mock).toHaveBeenCalledWith(
      crossRepoRoot,
      crossRepoPath,
      true,
    );
    expect(git.deleteBranch as Mock).toHaveBeenCalledWith(
      crossRepoRoot,
      "todo/X-CR-1",
    );
    expect(git.deleteRemoteBranch as Mock).toHaveBeenCalledWith(
      crossRepoRoot,
      "todo/X-CR-1",
    );
  });

  it("skips malformed cross-repo index entries", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Write a cross-repo index with malformed entries
    const indexPath = join(worktreeDir, ".cross-repo-index");
    writeFileSync(
      indexPath,
      [
        "",                           // empty line
        "# comment line",             // comment
        "only-id-no-tabs",            // missing repo and path fields
        "X-BAD-1\t/some/repo",        // missing worktree path (only 2 fields)
        `X-BAD-2\t\t/some/path`,      // empty repo field
      ].join("\n"),
    );

    (git.isBranchMerged as Mock).mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    // None of the malformed entries should be cleaned
    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(git.removeWorktree as Mock).not.toHaveBeenCalled();
  });

  it("skips cross-repo index entries where worktree path does not exist", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Write an index entry pointing to a nonexistent path
    const indexPath = join(worktreeDir, ".cross-repo-index");
    writeFileSync(
      indexPath,
      `X-GONE-1\t/nonexistent/repo\t/nonexistent/worktree\n`,
    );

    (git.isBranchMerged as Mock).mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux),
    );

    // The entry should be skipped because the worktree path doesn't exist
    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(git.removeWorktree as Mock).not.toHaveBeenCalled();
  });

  it("cleans specific cross-repo worktree by target ID", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Create two cross-repo entries, only target one
    const crossRepoPath1 = join(repo, "ext1", ".worktrees", "todo-X-CR-1");
    const crossRepoPath2 = join(repo, "ext2", ".worktrees", "todo-X-CR-2");
    const crossRepoRoot1 = join(repo, "ext1");
    const crossRepoRoot2 = join(repo, "ext2");
    mkdirSync(crossRepoPath1, { recursive: true });
    mkdirSync(crossRepoPath2, { recursive: true });
    mkdirSync(join(crossRepoRoot1, ".git"), { recursive: true });
    mkdirSync(join(crossRepoRoot2, ".git"), { recursive: true });

    const indexPath = join(worktreeDir, ".cross-repo-index");
    writeFileSync(
      indexPath,
      [
        `X-CR-1\t${crossRepoRoot1}\t${crossRepoPath1}`,
        `X-CR-2\t${crossRepoRoot2}\t${crossRepoPath2}`,
      ].join("\n"),
    );

    // Target only X-CR-1 — should clean regardless of merge status
    (git.isBranchMerged as Mock).mockReturnValue(false);

    const output = captureOutput(() =>
      cmdClean(["X-CR-1"], worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(git.removeWorktree as Mock).toHaveBeenCalledWith(
      crossRepoRoot1,
      crossRepoPath1,
      true,
    );
    // Should NOT have cleaned X-CR-2
    expect(git.removeWorktree as Mock).toHaveBeenCalledTimes(1);
  });
});
