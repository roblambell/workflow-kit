// Tests for clean commands: cmdClean, cmdCleanSingle, cmdCloseWorkspace, cmdCloseWorkspaces.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { setupTempRepo, cleanupTempRepos, captureOutput } from "./helpers.ts";
import type { Multiplexer } from "../core/mux.ts";
import {
  type CleanDeps,
  cmdClean,
  cmdCleanSingle,
  cleanSingleWorktree,
  cmdCloseWorkspace,
  cmdCloseWorkspaces,
} from "../core/commands/clean.ts";
import { checkInbox, writeInbox } from "../core/commands/inbox.ts";

/** Create a mock Multiplexer for dependency injection (avoids vi.mock leaking). */
function createMockMux(): Multiplexer & Record<string, Mock> {
  return {
    type: "cmux",
    isAvailable: vi.fn(() => true),
    diagnoseUnavailable: vi.fn(() => "not available"),
    launchWorkspace: vi.fn(() => "workspace:1"),
    splitPane: vi.fn(() => "pane:1"),
    sendMessage: vi.fn(() => true),
    writeInbox: vi.fn(),
    readScreen: vi.fn(() => ""),
    listWorkspaces: vi.fn(() => ""),
    closeWorkspace: vi.fn(() => true),
  };
}

/** Create mock CleanDeps for dependency injection. */
function createMockCleanDeps(): CleanDeps & Record<string, Mock> {
  return {
    isBranchMerged: vi.fn(() => false),
    removeWorktree: vi.fn(),
    deleteBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    prList: vi.fn(() => ({ ok: true as const, data: [] as Array<{ number: number; title: string }> })),
  };
}

function writeWorkItemFile(
  repo: string,
  id: string,
  title: string,
  lineageToken?: string,
): void {
  const workDir = join(repo, ".ninthwave", "work");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    join(workDir, `2-test--${id}.md`),
    [
      `# ${title} (${id})`,
      "",
      "**Priority:** High",
      "**Domain:** test",
      ...(lineageToken ? [`**Lineage:** ${lineageToken}`] : []),
    ].join("\n"),
  );
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

  it("closes matching workspaces", () => {
    const mockMux = createMockMux();
    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-2 some title\nworkspace:2 TODO M-CI-1 another title",
    );

    const output = captureOutput(() => cmdCloseWorkspaces(mockMux));
    expect(output).toContain("Closed 2 workspace(s)");
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
  afterEach(() => cleanupTempRepos());

  it("returns false when worktree directory does not exist", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
    expect(result).toBe(false);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("returns true and cleans up when worktree exists", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
    expect(result).toBe(true);
    expect(deps.removeWorktree).toHaveBeenCalled();
    expect(deps.deleteBranch).toHaveBeenCalledWith(repo, "ninthwave/H-CI-2");
    expect(deps.deleteRemoteBranch).toHaveBeenCalledWith(repo, "ninthwave/H-CI-2");
  });

  it("closes workspace when mux is provided", () => {
    const deps = createMockCleanDeps();
    const mux = createMockMux();
    mux.listWorkspaces.mockReturnValue("workspace:1 TODO H-CI-2 some title");
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps, mux);
    expect(result).toBe(true);
    expect(mux.closeWorkspace).toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalled();
  });

  it("clears inbox messages when cleaning a worktree", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const worktreePath = join(worktreeDir, "ninthwave-H-CI-2");
    mkdirSync(worktreePath, { recursive: true });

    writeInbox(worktreePath, "H-CI-2", "stale cleanup message");
    expect(checkInbox(worktreePath, "H-CI-2")).toBe("stale cleanup message");
    writeInbox(worktreePath, "H-CI-2", "stale cleanup message");

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);

    expect(result).toBe(true);
    expect(checkInbox(worktreePath, "H-CI-2")).toBeNull();
  });

  it("works without mux parameter (backward compatibility)", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    // No mux parameter -- should not throw
    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
    expect(result).toBe(true);
    expect(deps.removeWorktree).toHaveBeenCalled();
  });

  it("continues cleanup when workspace close throws", () => {
    const deps = createMockCleanDeps();
    const mux = createMockMux();
    mux.listWorkspaces.mockImplementation(() => { throw new Error("cmux error"); });
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps, mux);
    expect(result).toBe(true);
    // Worktree cleanup still runs despite workspace close failure
    expect(deps.removeWorktree).toHaveBeenCalled();
  });

  it("falls back to rmSync and logs warning when removeWorktree throws", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });
    deps.removeWorktree.mockImplementation(() => {
      throw new Error("git worktree remove failed");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
      expect(result).toBe(true);
    });
    expect(deps.removeWorktree).toHaveBeenCalled();
    expect(output).toContain("Failed to remove worktree for H-CI-2");
    expect(output).toContain("git worktree remove failed");
  });

  it("logs warning when deleteBranch fails and continues cleanup", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("branch not found");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
      expect(result).toBe(true);
    });
    expect(deps.deleteBranch).toHaveBeenCalled();
    expect(deps.deleteRemoteBranch).toHaveBeenCalled();
    expect(output).toContain("Failed to delete local branch ninthwave/H-CI-2");
    expect(output).toContain("branch not found");
  });

  it("logs warning when deleteRemoteBranch fails and continues cleanup", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });
    deps.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("remote branch not found");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
      expect(result).toBe(true);
    });
    expect(deps.deleteRemoteBranch).toHaveBeenCalled();
    expect(output).toContain("Failed to delete remote branch ninthwave/H-CI-2");
    expect(output).toContain("remote branch not found");
  });

  it("completes cleanup even when all operations fail", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });
    deps.removeWorktree.mockImplementation(() => {
      throw new Error("worktree failed");
    });
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("branch failed");
    });
    deps.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("remote failed");
    });

    const output = captureOutput(() => {
      const result = cleanSingleWorktree("H-CI-2", worktreeDir, repo, deps);
      expect(result).toBe(true);
    });
    // All three warnings should be logged
    expect(output).toContain("Failed to remove worktree");
    expect(output).toContain("Failed to delete local branch");
    expect(output).toContain("Failed to delete remote branch");
  });
});

describe("cmdCleanSingle", () => {
  afterEach(() => cleanupTempRepos());

  it("dies with no target ID", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = captureOutput(() =>
      cmdCleanSingle([], worktreeDir, repo, deps),
    );

    expect(output).toContain("Usage");
  });

  it("reports no worktree found when directory doesn't exist", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = captureOutput(() =>
      cmdCleanSingle(["H-CI-2"], worktreeDir, repo, deps),
    );

    expect(output).toContain("No worktree found");
  });

  it("cleans existing worktree", () => {
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    // Create a fake worktree directory
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    const output = captureOutput(() =>
      cmdCleanSingle(["H-CI-2"], worktreeDir, repo, deps),
    );

    expect(output).toContain("Cleaned worktree for H-CI-2");
    expect(deps.removeWorktree).toHaveBeenCalled();
  });
});

describe("cmdClean", () => {
  afterEach(() => cleanupTempRepos());

  it("reports no worktrees when directory doesn't exist", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();

    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("No worktrees to clean");
  });

  it("cleans merged worktrees", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    deps.isBranchMerged.mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(deps.removeWorktree).toHaveBeenCalled();
  });

  it("does not clean unmerged worktrees without target ID", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    deps.isBranchMerged.mockReturnValue(false);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not clean reused IDs when merged PR lineage mismatches", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-9"), { recursive: true });
    writeWorkItemFile(repo, "H-CI-9", "New work", "11111111-1111-4111-8111-111111111111");

    deps.isBranchMerged.mockReturnValue(true);
    deps.prList.mockReturnValue({
      ok: true,
      data: [{
        number: 9,
        title: "fix: old work (H-CI-9)",
        body: "## Work Item Reference\nID: H-CI-9\nLineage: 22222222-2222-4222-8222-222222222222",
      }],
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(mockMux.closeWorkspace).not.toHaveBeenCalled();
  });

  it("preserves legacy token-less cleanup when merged PR title matches", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-10"), { recursive: true });
    writeWorkItemFile(repo, "H-CI-10", "Legacy work");

    deps.isBranchMerged.mockReturnValue(false);
    deps.prList.mockReturnValue({
      ok: true,
      data: [{ number: 10, title: "fix: legacy work (H-CI-10)", body: "## Work Item Reference\nID: H-CI-10" }],
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("only closes the targeted workspace when cleaning a specific ID", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    // Create worktrees for H-1 (target), H-2, and H-3
    mkdirSync(join(worktreeDir, "ninthwave-H-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-2"), { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-3"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-1 first task\nworkspace:2 TODO H-2 second task\nworkspace:3 TODO H-3 third task",
    );
    deps.isBranchMerged.mockReturnValue(false);

    captureOutput(() => cmdClean(["H-1"], worktreeDir, repo, mockMux, deps));

    // Should only close workspace:1 (H-1), not workspace:2 or workspace:3
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(1);
    expect(mockMux.closeWorkspace).toHaveBeenCalledWith("workspace:1");
  });

  it("closes workspaces only for merged items when no target ID is specified", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second",
    );
    deps.isBranchMerged.mockReturnValue(true);

    captureOutput(() => cmdClean([], worktreeDir, repo, mockMux, deps));

    // Should close workspaces for both items since both are merged
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("does not close workspaces for non-merged items (broad cleanup)", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    // Create worktrees for two items: H-CI-1 (merged) and H-CI-2 (not merged)
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second",
    );
    // H-CI-1 is merged, H-CI-2 is not
    deps.isBranchMerged.mockImplementation(
      (_repo: string, branch: string) => branch === "ninthwave/H-CI-1",
    );

    captureOutput(() => cmdClean([], worktreeDir, repo, mockMux, deps));

    // Should only close workspace:1 (H-CI-1 is merged), NOT workspace:2
    expect(mockMux.closeWorkspace).toHaveBeenCalledTimes(1);
    expect(mockMux.closeWorkspace).toHaveBeenCalledWith("workspace:1");
    // Worktree removal should only happen for the merged item
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("preserves active workers for non-merged items", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    // Three items: all have active workspaces, none are merged
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-3"), { recursive: true });

    mockMux.listWorkspaces.mockReturnValue(
      "workspace:1 TODO H-CI-1 first\nworkspace:2 TODO H-CI-2 second\nworkspace:3 TODO H-CI-3 third",
    );
    deps.isBranchMerged.mockReturnValue(false);

    captureOutput(() => cmdClean([], worktreeDir, repo, mockMux, deps));

    // No workspaces should be closed -- all items are still active
    expect(mockMux.closeWorkspace).not.toHaveBeenCalled();
    // No worktrees should be removed
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("logs warning when removeWorktree fails in cleanItem", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    deps.isBranchMerged.mockReturnValue(true);
    deps.removeWorktree.mockImplementation(() => {
      throw new Error("worktree remove failed");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(output).toContain("Failed to remove worktree for H-CI-2");
    expect(output).toContain("worktree remove failed");
  });

  it("logs warning when deleteBranch fails in cleanItem", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    deps.isBranchMerged.mockReturnValue(true);
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("branch not found");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(output).toContain("Failed to delete local branch ninthwave/H-CI-2");
  });

  it("logs warning when deleteRemoteBranch fails in cleanItem", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    deps.isBranchMerged.mockReturnValue(true);
    deps.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("remote branch not found");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(output).toContain("Failed to delete remote branch ninthwave/H-CI-2");
  });

  it("completes cleanItem when all operations fail", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(join(worktreeDir, "ninthwave-H-CI-2"), { recursive: true });

    deps.isBranchMerged.mockReturnValue(true);
    deps.removeWorktree.mockImplementation(() => {
      throw new Error("worktree failed");
    });
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("branch failed");
    });
    deps.deleteRemoteBranch.mockImplementation(() => {
      throw new Error("remote failed");
    });

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
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
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Create a fake cross-repo worktree directory at a different location
    const crossRepoPath = join(repo, "external-repo", ".ninthwave", ".worktrees", "ninthwave-X-CR-1");
    mkdirSync(crossRepoPath, { recursive: true });
    const crossRepoRoot = join(repo, "external-repo");
    mkdirSync(join(crossRepoRoot, ".git"), { recursive: true });

    // Write a cross-repo index entry
    const indexPath = join(worktreeDir, ".cross-repo-index");
    writeFileSync(indexPath, `X-CR-1\t${crossRepoRoot}\t${crossRepoPath}\n`);

    // Mark the branch as merged so cmdClean will clean it
    deps.isBranchMerged.mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      crossRepoRoot,
      crossRepoPath,
      true,
    );
    expect(deps.deleteBranch).toHaveBeenCalledWith(
      crossRepoRoot,
      "ninthwave/X-CR-1",
    );
    expect(deps.deleteRemoteBranch).toHaveBeenCalledWith(
      crossRepoRoot,
      "ninthwave/X-CR-1",
    );
  });

  it("skips malformed cross-repo index entries", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
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

    deps.isBranchMerged.mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    // None of the malformed entries should be cleaned
    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("skips cross-repo index entries where worktree path does not exist", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Write an index entry pointing to a nonexistent path
    const indexPath = join(worktreeDir, ".cross-repo-index");
    writeFileSync(
      indexPath,
      `X-GONE-1\t/nonexistent/repo\t/nonexistent/worktree\n`,
    );

    deps.isBranchMerged.mockReturnValue(true);

    const output = captureOutput(() =>
      cmdClean([], worktreeDir, repo, mockMux, deps),
    );

    // The entry should be skipped because the worktree path doesn't exist
    expect(output).toContain("Cleaned 0 worktree(s)");
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("cleans specific cross-repo worktree by target ID", () => {
    const mockMux = createMockMux();
    const deps = createMockCleanDeps();
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Create two cross-repo entries, only target one
    const crossRepoPath1 = join(repo, "ext1", ".ninthwave", ".worktrees", "ninthwave-X-CR-1");
    const crossRepoPath2 = join(repo, "ext2", ".ninthwave", ".worktrees", "ninthwave-X-CR-2");
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

    // Target only X-CR-1 -- should clean regardless of merge status
    deps.isBranchMerged.mockReturnValue(false);

    const output = captureOutput(() =>
      cmdClean(["X-CR-1"], worktreeDir, repo, mockMux, deps),
    );

    expect(output).toContain("Cleaned 1 worktree(s)");
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      crossRepoRoot1,
      crossRepoPath1,
      true,
    );
    // Should NOT have cleaned X-CR-2
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });
});
