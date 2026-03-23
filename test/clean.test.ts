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
});
