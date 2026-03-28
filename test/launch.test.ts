// Tests for start command: detectAiTool and cmdStart.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { join } from "path";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import type { Multiplexer } from "../core/mux.ts";

// Only mock modules that don't have their own test files and aren't
// transitive dependencies of other tested modules.
// Avoid mocking shell.ts (used by version-bump.test.ts via git.ts)
// and partitions.ts / cross-repo.ts (have dedicated test files).
vi.mock("../core/git.ts", () => ({
  fetchOrigin: vi.fn(),
  ffMerge: vi.fn(),
  branchExists: vi.fn(() => false),
  deleteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  createWorktree: vi.fn(),
  attachWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  findWorktreeForBranch: vi.fn(() => null),
}));
// NOTE: findWorktreeForBranch and removeWorktree are added to the mock but
// are also tested directly in git.test.ts. git.test.ts handles mock leakage
// by using shell.ts run() for functions mocked elsewhere. If adding new
// functions to this mock, update the comment in git.test.ts lines 5-11.


import { detectAiTool, cmdStart, cmdRunItems, launchSingleItem, launchAiSession, launchReviewWorker, sanitizeTitle, extractItemText, cleanStaleBranchForReuse, WORK_ITEM_ID_CLI_PATTERN } from "../core/commands/launch.ts";
import { parseWorkItems } from "../core/parser.ts";
import { fetchOrigin, ffMerge, createWorktree, branchExists, deleteBranch, findWorktreeForBranch, removeWorktree } from "../core/git.ts";

/** Create a mock Multiplexer for dependency injection (avoids vi.mock leaking). */
function createMockMux(): Multiplexer & Record<string, Mock> {
  return {
    type: "cmux",
    isAvailable: vi.fn(() => true),
    diagnoseUnavailable: vi.fn(() => "not available"),
    launchWorkspace: vi.fn(() => "workspace:1"),
    splitPane: vi.fn(() => "pane:1"),
    sendMessage: vi.fn(() => true),
    readScreen: vi.fn(() => "line1\nline2\nline3\nline4\n"),
    listWorkspaces: vi.fn(() => ""),
    closeWorkspace: vi.fn(() => true),
  };
}

/**
 * Set up a work items directory with individual work item files matching the valid.md fixture.
 * Returns the path to the work items directory.
 */
function setupWorkItemsDir(repo: string): string {
  const workDir = join(repo, ".ninthwave", "work");
  mkdirSync(workDir, { recursive: true });

  writeFileSync(
    join(workDir, "2-cloud-infrastructure--M-CI-1.md"),
    [
      "# Upgrade CI runners (M-CI-1)",
      "",
      "**Priority:** Medium",
      "**Source:** Manual request 2026-03-22",
      "**Depends on:** None",
      "**Domain:** cloud-infrastructure",
      "",
      "Upgrade test CI runners from 2 to 4 vCPUs for faster execution.",
      "",
      "**Test plan:**",
      "- Verify updated workflow YAML specifies 4 vCPU runner labels",
      "- Check deploy workflows still reference 2 vCPU runners",
      "- Edge case: ensure ARM vs x86 platform is unchanged",
      "",
      "Acceptance: Test workflows use 4 vCPU runners. Deploy workflows remain on 2 vCPU.",
      "",
      "Key files: `.github/workflows/test-api.yml`, `.github/workflows/ci.yml`",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(workDir, "1-cloud-infrastructure--H-CI-2.md"),
    [
      "# Flaky connection pool timeout (H-CI-2)",
      "",
      "**Priority:** High",
      "**Source:** Eng review 2026-03-22",
      "**Depends on:** M-CI-1",
      "**Domain:** cloud-infrastructure",
      "",
      "Fix intermittent connection pool timeout errors in test suite by increasing pool size.",
      "",
      "Acceptance: No more timeout errors in CI. Pool size configurable via env var.",
      "",
      "Key files: `config/test.exs`",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(workDir, "0-user-onboarding--C-UO-1.md"),
    [
      "# Add welcome email (C-UO-1)",
      "",
      "**Priority:** Critical",
      "**Source:** Product review 2026-03-20",
      "**Depends on:** None",
      "**Domain:** user-onboarding",
      "",
      "Send a welcome email when a new user completes onboarding.",
      "",
      "Acceptance: Email sent within 30s of onboarding completion. Email contains user name.",
      "",
      "Key files: `lib/onboarding/email.ex`, `lib/mailer.ex`",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(workDir, "1-user-onboarding--H-UO-2.md"),
    [
      "# Add onboarding checklist (H-UO-2)",
      "",
      "**Priority:** High",
      "**Source:** Product review 2026-03-20",
      "**Depends on:** C-UO-1, M-CI-1",
      "**Bundle with:** H-CI-2",
      "**Domain:** user-onboarding",
      "",
      "Display an onboarding checklist on the dashboard after signup.",
      "",
      "Acceptance: Checklist shows on first login. Items check off as completed.",
      "",
      "Key files: `lib/onboarding/checklist.ex`, `assets/js/checklist.tsx`",
      "",
    ].join("\n"),
  );

  // Commit work item files so pre-flight checks pass
  spawnSync("git", ["-C", repo, "add", ".ninthwave/work/"], { stdio: "pipe" });
  spawnSync("git", ["-C", repo, "commit", "-m", "Add work item files", "--quiet"], { stdio: "pipe" });

  return workDir;
}

async function captureOutput(fn: () => void | Promise<void>): Promise<string> {
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
    await fn();
  } catch (e: unknown) {
    if (e instanceof Error && !e.message.startsWith("EXIT:")) throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return lines.join("\n");
}

describe("detectAiTool", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear relevant env vars
    delete process.env.NINTHWAVE_AI_TOOL;
    delete process.env.OPENCODE;
    delete process.env.CLAUDE_CODE_SESSION;
    delete process.env.CLAUDE_SESSION_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    cleanupTempRepos();
  });

  it("returns NINTHWAVE_AI_TOOL when set", () => {
    process.env.NINTHWAVE_AI_TOOL = "custom-tool";
    expect(detectAiTool()).toBe("custom-tool");
  });

  it("returns opencode when OPENCODE=1", () => {
    process.env.OPENCODE = "1";
    expect(detectAiTool()).toBe("opencode");
  });

  it("returns claude when CLAUDE_CODE_SESSION is set", () => {
    process.env.CLAUDE_CODE_SESSION = "some-session-id";
    expect(detectAiTool()).toBe("claude");
  });

  it("returns claude when CLAUDE_SESSION_ID is set", () => {
    process.env.CLAUDE_SESSION_ID = "another-session-id";
    expect(detectAiTool()).toBe("claude");
  });

  it("NINTHWAVE_AI_TOOL takes priority over OPENCODE", () => {
    process.env.NINTHWAVE_AI_TOOL = "copilot";
    process.env.OPENCODE = "1";
    expect(detectAiTool()).toBe("copilot");
  });

  it("OPENCODE takes priority over CLAUDE_CODE_SESSION", () => {
    process.env.OPENCODE = "1";
    process.env.CLAUDE_CODE_SESSION = "some-id";
    expect(detectAiTool()).toBe("opencode");
  });
});

describe("cmdStart", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure AI tool is detectable
    process.env.NINTHWAVE_AI_TOOL = "claude";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    cleanupTempRepos();
  });

  it("dies with no arguments", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdStart([], workDir, worktreeDir, repo),
    );

    expect(output).toContain("Usage");
  });

  it("dies when item ID not found", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["NONEXISTENT-1"], workDir, worktreeDir, repo),
    );

    expect(output).toContain("not found");
  });

  it("launches session for a valid item", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Launched 1 session");
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("reports detected AI tool", async () => {
    process.env.NINTHWAVE_AI_TOOL = "opencode";

    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Detected AI tool: opencode");
  });

  it("dies early when mux is unavailable (before any git operations)", async () => {
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);
    mockMux.diagnoseUnavailable.mockReturnValue(
      "cmux is not available. Ensure cmux is installed and running.",
    );

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("cmux is not available");
    // Should NOT have attempted to launch a workspace
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
    // Should NOT have attempted worktree creation
    expect(createWorktree).not.toHaveBeenCalled();
  });
});

describe("launchSingleItem", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINTHWAVE_AI_TOOL = "claude";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    cleanupTempRepos();
  });

  it("creates worktree and launches session for a single item", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const result = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("ninthwave-M-CI-1");
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    expect(mockMux.launchWorkspace).toHaveBeenCalled();
    expect(result).toContain("Creating worktree for M-CI-1");
  });

  it("returns null when mux launch fails", async () => {
    const mockMux = createMockMux();
    mockMux.launchWorkspace.mockReturnValueOnce(null);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const result = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      expect(res).toBeNull();
    });

    expect(result).toContain("cmux launch failed");
  });

  it("allocates a partition for the item", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const result = await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
    });

    // Partition 1 should be allocated (first available)
    expect(result).toContain("partition 1");
  });

  it("ensures worktree directory is created", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // worktreeDir doesn't exist yet — launchSingleItem should create it
    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
    });

    const { existsSync } = require("fs");
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("logs warning when fetchOrigin fails but still creates worktree", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    (fetchOrigin as Mock).mockImplementationOnce(() => {
      throw new Error("network timeout");
    });

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("ninthwave-M-CI-1");
    });

    expect(output).toContain("Failed to fetch origin/main");
    expect(output).toContain("network timeout");
    expect(output).toContain("may be outdated");
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("logs warning when ffMerge fails but still creates worktree", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    (ffMerge as Mock).mockImplementationOnce(() => {
      throw new Error("not a fast-forward");
    });

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("ninthwave-M-CI-1");
    });

    expect(output).toContain("Failed to fast-forward main");
    expect(output).toContain("not a fast-forward");
    expect(output).toContain("may be based on outdated code");
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("warning includes actionable context about stale worktree", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    (fetchOrigin as Mock).mockImplementationOnce(() => {
      throw new Error("Could not resolve host: github.com");
    });
    (ffMerge as Mock).mockImplementationOnce(() => {
      throw new Error("diverged branches");
    });

    const output = await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
    });

    // Both warnings should appear
    expect(output).toContain("Failed to fetch origin/main");
    expect(output).toContain("Could not resolve host: github.com");
    expect(output).toContain("Failed to fast-forward main");
    expect(output).toContain("diverged branches");
    // Both should include the item ID for context
    expect(output).toContain("M-CI-1");
  });

  it("returns correct worktreePath for hub repo items", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toBe(join(worktreeDir, "ninthwave-M-CI-1"));
    });
  });

  it("creates worktree from dep branch when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/H-1-1",
      });
      expect(res).not.toBeNull();
    });

    // createWorktree should be called with the dep branch as startPoint
    expect(createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("ninthwave-M-CI-1"),
      "ninthwave/M-CI-1",
      "origin/ninthwave/H-1-1",
    );
  });

  it("fetches dep branch instead of main when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const output = await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/H-1-1",
      });
    });

    // Should fetch the dep branch, not main
    expect(fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/H-1-1");
    // Should NOT fetch main
    expect(fetchOrigin).not.toHaveBeenCalledWith(repo, "main");
    // Should NOT call ffMerge (stacked launches skip main ff-merge)
    expect(ffMerge).not.toHaveBeenCalled();
    // Output should mention the dep branch
    expect(output).toContain("Fetching dependency branch ninthwave/H-1-1");
  });

  it("includes BASE_BRANCH in system prompt when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Use opencode so the full system prompt is sent via sendMessage (not --append-system-prompt)
    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "opencode", mockMux, {
        baseBranch: "ninthwave/H-1-1",
      });
    });

    // For opencode, the system prompt is included in the initial message sent via sendMessage
    const sendCall = mockMux.sendMessage.mock.calls[0];
    expect(sendCall).toBeDefined();
    const sentPrompt = sendCall[1] as string;
    expect(sentPrompt).toContain("BASE_BRANCH: ninthwave/H-1-1");
  });

  it("does not include BASE_BRANCH in system prompt when baseBranch is not set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Use opencode so the full system prompt is sent via sendMessage
    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "opencode", mockMux);
    });

    // The system prompt should NOT contain BASE_BRANCH
    const sendCall = mockMux.sendMessage.mock.calls[0];
    expect(sendCall).toBeDefined();
    const sentPrompt = sendCall[1] as string;
    expect(sentPrompt).not.toContain("BASE_BRANCH:");
  });

  it("non-stacked launch still fetches main and calls ffMerge", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
    });

    // Non-stacked: should fetch main and call ffMerge
    expect(fetchOrigin).toHaveBeenCalledWith(repo, "main");
    expect(ffMerge).toHaveBeenCalledWith(repo, "main");
    // createWorktree should use default startPoint "HEAD"
    expect(createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("ninthwave-M-CI-1"),
      "ninthwave/M-CI-1",
      "HEAD",
    );
  });
});

describe("launchSingleItem external worktree handling", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINTHWAVE_AI_TOOL = "claude";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // Restore default mock return values to prevent leaking into other tests
    (branchExists as Mock).mockReturnValue(false);
    (findWorktreeForBranch as Mock).mockReturnValue(null);
    (deleteBranch as Mock).mockReset();
    (removeWorktree as Mock).mockReset();
    cleanupTempRepos();
  });

  it("removes external worktree and retries branch deletion on failure", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Branch exists and is checked out in an external worktree
    (branchExists as Mock).mockReturnValue(true);
    // First deleteBranch fails (branch checked out in worktree)
    (deleteBranch as Mock)
      .mockImplementationOnce(() => { throw new Error("Cannot delete branch checked out in worktree"); })
      .mockImplementationOnce(() => {}); // Retry succeeds
    // findWorktreeForBranch returns an external worktree path
    const externalWtPath = "/tmp/fake-external-worktree";
    (findWorktreeForBranch as Mock)
      .mockReturnValueOnce(externalWtPath)  // First call (line 456 — pre-check)
      .mockReturnValueOnce(externalWtPath); // Second call (in catch block)

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      expect(res).not.toBeNull();
    });

    // removeWorktree should have been called twice: once in the pre-check (line 462) and once in the catch retry
    expect(removeWorktree).toHaveBeenCalledWith(repo, externalWtPath, true);
    // deleteBranch should have been called twice (initial + retry)
    expect(deleteBranch).toHaveBeenCalledTimes(2);
    // createWorktree should have been called (branch deletion succeeded on retry)
    expect(createWorktree).toHaveBeenCalled();
    expect(output).toContain("Removing and retrying");
  });

  it("propagates error when external worktree removal fails on retry", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    (branchExists as Mock).mockReturnValue(true);
    // deleteBranch always fails
    (deleteBranch as Mock).mockImplementation(() => {
      throw new Error("Cannot delete branch checked out in worktree");
    });
    const externalWtPath = "/tmp/fake-external-worktree";
    (findWorktreeForBranch as Mock)
      .mockReturnValueOnce(externalWtPath)  // pre-check
      .mockReturnValueOnce(externalWtPath); // catch block
    // removeWorktree fails on the retry (in catch block)
    (removeWorktree as Mock)
      .mockImplementationOnce(() => {})  // pre-check succeeds
      .mockImplementationOnce(() => { throw new Error("permission denied"); }); // retry fails

    // The error should propagate — no silent failures
    let thrownError: Error | null = null;
    await captureOutput(() => {
      try {
        launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      } catch (e) {
        thrownError = e as Error;
      }
    });

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Failed to delete branch");
    expect(thrownError!.message).toContain("after removing external worktree");
    // createWorktree should NOT have been called (error propagated)
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("propagates error when no external worktree found but branch deletion fails", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    (branchExists as Mock).mockReturnValue(true);
    // deleteBranch fails for non-worktree reason
    (deleteBranch as Mock).mockImplementation(() => {
      throw new Error("branch is protected");
    });
    // No external worktree found
    (findWorktreeForBranch as Mock).mockReturnValue(null);

    let thrownError: Error | null = null;
    await captureOutput(() => {
      try {
        launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      } catch (e) {
        thrownError = e as Error;
      }
    });

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Failed to delete branch");
    expect(thrownError!.message).toContain("branch is protected");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("handles branch in both orchestrator worktree and external worktree", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;
    const expectedWorktreePath = join(worktreeDir, "ninthwave-M-CI-1");

    (branchExists as Mock).mockReturnValue(true);

    // First findWorktreeForBranch: returns the orchestrator's own worktree path
    // (should be skipped since it matches worktreePath)
    (findWorktreeForBranch as Mock)
      .mockReturnValueOnce(expectedWorktreePath)  // pre-check: same as target, skip
      .mockReturnValueOnce(null); // catch block: no external worktree found

    // deleteBranch fails (branch exists but no external worktree to remove)
    (deleteBranch as Mock).mockImplementation(() => {
      throw new Error("Cannot delete branch");
    });

    let thrownError: Error | null = null;
    await captureOutput(() => {
      try {
        launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
      } catch (e) {
        thrownError = e as Error;
      }
    });

    // Should propagate error since no external worktree to remove
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Failed to delete branch");
  });
});

describe("cleanStaleBranchForReuse no-external-worktree regression", () => {
  it("works correctly when no external worktrees exist", () => {
    const deps = {
      prList: vi.fn(() => [{ number: 1, title: "fix: old change (OLD-1)" }]),
      branchExists: vi.fn(() => true),
      deleteBranch: vi.fn(),
      deleteRemoteBranch: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };

    const result = cleanStaleBranchForReuse(
      "OLD-1",
      "New work for OLD-1",
      "/fake/repo",
      deps,
    );

    expect(result).toBe(true);
    expect(deps.deleteBranch).toHaveBeenCalledWith("/fake/repo", "ninthwave/OLD-1");
    expect(deps.info).toHaveBeenCalledWith(expect.stringContaining("Deleted local branch"));
    expect(deps.deleteRemoteBranch).toHaveBeenCalled();
  });

  it("returns false when no merged PRs exist", () => {
    const deps = {
      prList: vi.fn(() => []),
      branchExists: vi.fn(() => false),
      deleteBranch: vi.fn(),
      deleteRemoteBranch: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };

    const result = cleanStaleBranchForReuse(
      "FRESH-1",
      "Fresh work",
      "/fake/repo",
      deps,
    );

    expect(result).toBe(false);
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });

  it("warns but continues when branch deletion fails", () => {
    const deps = {
      prList: vi.fn(() => [{ number: 1, title: "fix: stale (X-1)" }]),
      branchExists: vi.fn(() => true),
      deleteBranch: vi.fn(() => { throw new Error("Cannot delete"); }),
      deleteRemoteBranch: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };

    // cleanStaleBranchForReuse catches the error and continues
    const result = cleanStaleBranchForReuse(
      "X-1",
      "New work",
      "/fake/repo",
      deps,
    );

    expect(result).toBe(true);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to delete local branch"));
    // Remote deletion should still be attempted
    expect(deps.deleteRemoteBranch).toHaveBeenCalled();
  });
});

describe("sanitizeTitle", () => {
  it("passes through normal alphanumeric titles unchanged", () => {
    expect(sanitizeTitle("Fix the login bug")).toBe("Fix the login bug");
  });

  it("preserves hyphens and underscores", () => {
    expect(sanitizeTitle("my-feature_name")).toBe("my-feature_name");
  });

  it("replaces double quotes", () => {
    expect(sanitizeTitle('title with "quotes"')).toBe("title with _quotes_");
  });

  it("replaces backslashes", () => {
    expect(sanitizeTitle("title with \\backslash")).toBe("title with _backslash");
  });

  it("replaces semicolons", () => {
    expect(sanitizeTitle("title; rm -rf /")).toBe("title_ rm -rf _");
  });

  it("replaces pipe characters", () => {
    expect(sanitizeTitle("title | cat /etc/passwd")).toBe("title _ cat _etc_passwd");
  });

  it("replaces ampersands", () => {
    expect(sanitizeTitle("title && echo pwned")).toBe("title __ echo pwned");
  });

  it("replaces newlines", () => {
    expect(sanitizeTitle("title\ninjected")).toBe("title_injected");
  });

  it("replaces backticks (command substitution)", () => {
    expect(sanitizeTitle("title `whoami`")).toBe("title _whoami_");
  });

  it("replaces dollar signs (variable expansion)", () => {
    expect(sanitizeTitle("title $HOME")).toBe("title _HOME");
  });

  it("replaces single quotes", () => {
    expect(sanitizeTitle("title 'injected'")).toBe("title _injected_");
  });

  it("replaces parentheses (subshells)", () => {
    expect(sanitizeTitle("title $(whoami)")).toBe("title __whoami_");
  });

  it("handles empty title", () => {
    expect(sanitizeTitle("")).toBe("");
  });

  it("handles title that is entirely metacharacters", () => {
    expect(sanitizeTitle(";|&$`\"'\\")).toBe("________");
  });

  it("handles mixed safe and unsafe characters", () => {
    expect(sanitizeTitle("Fix bug #123 (critical)")).toBe("Fix bug _123 _critical_");
  });
});

describe("extractItemText", () => {
  afterEach(() => cleanupTempRepos());

  /** Helper to create a work items directory with individual work item files. */
  function createWorkItemsDir(repo: string): string {
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    return workDir;
  }

  it("returns full file contents for a valid ID", () => {
    const repo = setupTempRepo();
    const workDir = createWorkItemsDir(repo);
    const fileContent = [
      "# Fix: Some bug (H-BUG-1)",
      "",
      "**Priority:** High",
      "**Source:** Manual",
      "**Depends on:** None",
      "**Domain:** bugs",
      "",
      "Description of the bug.",
      "",
      "Acceptance: Bug is fixed.",
      "",
      "Key files: `src/foo.ts`",
      "",
    ].join("\n");
    writeFileSync(join(workDir, "1-bugs--H-BUG-1.md"), fileContent);
    // Another file should not be returned
    writeFileSync(
      join(workDir, "2-features--M-FT-2.md"),
      "# Feat: Another item (M-FT-2)\n\n**Priority:** Medium\n**Depends on:** None\n**Domain:** features\n",
    );

    const text = extractItemText(workDir, "H-BUG-1");
    expect(text).toContain("# Fix: Some bug (H-BUG-1)");
    expect(text).toContain("**Priority:** High");
    expect(text).toContain("Description of the bug.");
    expect(text).toContain("Acceptance: Bug is fixed.");
    expect(text).toContain("Key files: `src/foo.ts`");
    // Should NOT include the other item
    expect(text).not.toContain("M-FT-2");
    expect(text).not.toContain("Another item");
  });

  it("returns empty string when ID is not found", () => {
    const repo = setupTempRepo();
    const workDir = createWorkItemsDir(repo);
    writeFileSync(
      join(workDir, "1-bugs--H-BUG-1.md"),
      "# Fix: Some bug (H-BUG-1)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** bugs\n",
    );

    const text = extractItemText(workDir, "NONEXISTENT-99");
    expect(text).toBe("");
  });

  it("returns empty string when workDir does not exist", () => {
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    // Directory does not exist

    const text = extractItemText(workDir, "H-BUG-1");
    expect(text).toBe("");
  });

  it("returns correct file for ID that is a prefix of another", () => {
    const repo = setupTempRepo();
    const workDir = createWorkItemsDir(repo);
    writeFileSync(
      join(workDir, "1-bugs--H-BUG-10.md"),
      "# Fix: Item ten (H-BUG-10)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** bugs\n\nDescription for 10.\n",
    );
    writeFileSync(
      join(workDir, "1-bugs--H-BUG-1.md"),
      "# Fix: Item one (H-BUG-1)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** bugs\n\nDescription for 1.\n",
    );

    // File-per-item uses exact suffix matching (--H-BUG-1.md), so H-BUG-1 matches exactly
    const text = extractItemText(workDir, "H-BUG-1");
    expect(text).toContain("Item one");
    expect(text).toContain("Description for 1.");
    expect(text).not.toContain("Item ten");
  });

  it("returns file contents including acceptance criteria", () => {
    const repo = setupTempRepo();
    const workDir = createWorkItemsDir(repo);
    writeFileSync(
      join(workDir, "3-misc--L-LAST-1.md"),
      [
        "# Fix: Only item (L-LAST-1)",
        "",
        "**Priority:** Low",
        "**Depends on:** None",
        "**Domain:** misc",
        "",
        "This is the last item.",
        "",
        "Acceptance: Done.",
        "",
      ].join("\n"),
    );

    const text = extractItemText(workDir, "L-LAST-1");
    expect(text).toContain("# Fix: Only item (L-LAST-1)");
    expect(text).toContain("This is the last item.");
    expect(text).toContain("Acceptance: Done.");
  });

  it("returns empty string when directory is empty", () => {
    const repo = setupTempRepo();
    const workDir = createWorkItemsDir(repo);

    const text = extractItemText(workDir, "H-BUG-1");
    expect(text).toBe("");
  });
});

describe("launchAiSession agentName", () => {
  afterEach(() => cleanupTempRepos());

  it("defaults agentName to ninthwave-implementer when not specified", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux);

    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-implementer");
  });

  it("passes custom agentName to claude command", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-reviewer");
    expect(cmd).not.toContain("--agent ninthwave-implementer");
  });

  it("passes custom agentName to opencode command", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("opencode", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-reviewer");
  });

  it("passes custom agentName to copilot command", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("copilot", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    // cmd is a launcher script path in /tmp
    expect(cmd).toMatch(/^\/tmp\/nw-launch-.*\.sh$/);
    const script = readFileSync(cmd, "utf-8");
    expect(script).toContain("--agent=ninthwave-reviewer");
    expect(script).toContain("--allow-all");
    expect(script).toContain("-i ");
  });

  it("embeds prompt inline via -i for copilot (no post-launch send)", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "do the thing");

    const wsRef = launchAiSession("copilot", repo, "T-1", "Test", promptFile, mockMux);

    expect(wsRef).not.toBeNull();
    // No message should be sent after launch — prompt is embedded in -i
    expect(mockMux.sendMessage.mock.calls.length).toBe(0);
    // Launcher script should exist and contain the prompt file reference
    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    const cmd = launchCall[1] as string;
    expect(cmd).toMatch(/^\/tmp\/nw-launch-.*\.sh$/);
  });

  it("passes Start as positional CLI arg for claude (no post-launch send)", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "implement the work item");

    const wsRef = launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux);

    expect(wsRef).not.toBeNull();
    // Command should include -- Start as positional argument
    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("-- Start");
    // No message should be sent after launch — prompt is embedded as positional arg
    expect(mockMux.sendMessage.mock.calls.length).toBe(0);
  });

  it("opencode still uses sendMessage for post-launch prompt delivery", () => {
    const mockMux = createMockMux();
    // Return processing indicators so sendWithReadyWait succeeds
    mockMux.readScreen = vi.fn(() => "⠋ Thinking...\nLine2\nLine3\nLine4");
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "implement the work item");

    const wsRef = launchAiSession("opencode", repo, "T-1", "Test", promptFile, mockMux);

    expect(wsRef).not.toBeNull();
    // OpenCode command should NOT include -- Start
    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    const cmd = launchCall[1] as string;
    expect(cmd).not.toContain("-- Start");
    // OpenCode should use sendMessage for post-launch delivery
    expect(mockMux.sendMessage.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("launchSingleItem agentName default", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINTHWAVE_AI_TOOL = "claude";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    cleanupTempRepos();
  });

  it("launches with --agent ninthwave-implementer by default", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-implementer");
  });
});

describe("launchReviewWorker", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINTHWAVE_AI_TOOL = "claude";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    cleanupTempRepos();
  });

  it("off mode does not create a worktree and returns worktreePath null", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    const result = await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toBeNull();
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    // Should NOT create a worktree (no createWorktree call)
    expect(createWorktree).not.toHaveBeenCalled();
    // Should NOT call fetchOrigin (no branch to fetch)
    expect(fetchOrigin).not.toHaveBeenCalled();
    // Should launch with ninthwave-reviewer agent
    const launchCall = mockMux.launchWorkspace.mock.calls[0];
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-reviewer");
    // Info message should mention off mode
    expect(result).toContain("off mode");
  });

  it("direct mode creates worktree from ninthwave/{id} branch", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    const result = await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "direct", repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("review-H-RVW-1");
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    // Should fetch the item branch
    expect(fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/H-RVW-1");
    // Should create worktree with review branch from origin/ninthwave/{id}
    expect(createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("review-H-RVW-1"),
      "review/H-RVW-1",
      "origin/ninthwave/H-RVW-1",
    );
    // Should log info about creating the review worktree
    expect(result).toContain("Creating review worktree for H-RVW-1");
  });

  it("pr mode creates worktree same as direct mode", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "pr", repo, "claude", mockMux);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("review-H-RVW-1");
    });

    // Same worktree creation as direct mode
    expect(fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/H-RVW-1");
    expect(createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("review-H-RVW-1"),
      "review/H-RVW-1",
      "origin/ninthwave/H-RVW-1",
    );
  });

  it("system prompt contains correct YOUR_REVIEW_PR and AUTO_FIX_MODE", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    // Use opencode so the system prompt is sent via sendMessage
    await captureOutput(() => {
      launchReviewWorker(99, "H-RVW-2", "direct", repo, "opencode", mockMux);
    });

    const sendCall = mockMux.sendMessage.mock.calls[0];
    expect(sendCall).toBeDefined();
    const sentPrompt = sendCall[1] as string;
    expect(sentPrompt).toContain("YOUR_REVIEW_PR: 99");
    expect(sentPrompt).toContain("YOUR_REVIEW_ITEM_ID: H-RVW-2");
    expect(sentPrompt).toContain("AUTO_FIX_MODE: direct");
    expect(sentPrompt).toContain(`PROJECT_ROOT: ${repo}`);
    expect(sentPrompt).toContain(`REPO_ROOT: ${repo}`);
  });

  it("system prompt contains AUTO_FIX_MODE off for off mode", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(50, "H-RVW-3", "off", repo, "opencode", mockMux);
    });

    const sendCall = mockMux.sendMessage.mock.calls[0];
    expect(sendCall).toBeDefined();
    const sentPrompt = sendCall[1] as string;
    expect(sentPrompt).toContain("YOUR_REVIEW_PR: 50");
    expect(sentPrompt).toContain("AUTO_FIX_MODE: off");
  });

  it("includes BASE_BRANCH in system prompt when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(42, "H-RVW-1", "off", repo, "opencode", mockMux, {
        baseBranch: "ninthwave/H-DEP-1",
      });
    });

    const sendCall = mockMux.sendMessage.mock.calls[0];
    expect(sendCall).toBeDefined();
    const sentPrompt = sendCall[1] as string;
    expect(sentPrompt).toContain("BASE_BRANCH: ninthwave/H-DEP-1");
  });

  it("does not include BASE_BRANCH when baseBranch is not set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(42, "H-RVW-1", "off", repo, "opencode", mockMux);
    });

    const sendCall = mockMux.sendMessage.mock.calls[0];
    expect(sendCall).toBeDefined();
    const sentPrompt = sendCall[1] as string;
    expect(sentPrompt).not.toContain("BASE_BRANCH:");
  });

  it("launches with --agent ninthwave-reviewer for all modes", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    for (const mode of ["off", "direct", "pr"] as const) {
      vi.clearAllMocks();
      await captureOutput(() => {
        launchReviewWorker(42, "H-RVW-1", mode, repo, "claude", mockMux);
      });

      const launchCall = mockMux.launchWorkspace.mock.calls[0];
      expect(launchCall).toBeDefined();
      const cmd = launchCall[1] as string;
      expect(cmd).toContain("--agent ninthwave-reviewer");
      expect(cmd).not.toContain("--agent ninthwave-implementer");
    }
  });

  it("returns null when fetch fails in direct mode", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    (fetchOrigin as Mock).mockImplementationOnce(() => {
      throw new Error("branch not found");
    });

    const result = await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "direct", repo, "claude", mockMux);
      expect(res).toBeNull();
    });

    expect(result).toContain("Failed to fetch origin/ninthwave/H-RVW-1");
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("returns null when mux launch fails", async () => {
    const mockMux = createMockMux();
    mockMux.launchWorkspace.mockReturnValueOnce(null);
    const repo = setupTempRepo();

    await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux);
      expect(res).toBeNull();
    });

    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("deletes stale review branch before creating worktree", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();

    (branchExists as Mock).mockReturnValueOnce(true);

    await captureOutput(() => {
      launchReviewWorker(42, "H-RVW-1", "direct", repo, "claude", mockMux);
    });

    const { deleteBranch } = require("../core/git.ts");
    expect(deleteBranch).toHaveBeenCalledWith(repo, "review/H-RVW-1");
  });
});

// ── WORK_ITEM_ID_CLI_PATTERN tests ───────────────────────────────────────

describe("WORK_ITEM_ID_CLI_PATTERN", () => {
  it("matches valid uppercase item IDs", () => {
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H-RR-1")).toBe(true);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("M-SF-1")).toBe(true);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("L-VIS-15")).toBe(true);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("C-UO-1")).toBe(true);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H-CR-5")).toBe(true);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H-BF5-1")).toBe(true);
  });

  it("matches IDs with lowercase suffix (split items)", () => {
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H-CP-7a")).toBe(true);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H-CP-7b")).toBe(true);
  });

  it("rejects regular command names", () => {
    expect(WORK_ITEM_ID_CLI_PATTERN.test("watch")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("init")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("list")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("start")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("status")).toBe(false);
  });

  it("rejects lowercase item IDs", () => {
    expect(WORK_ITEM_ID_CLI_PATTERN.test("h-rr-1")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("m-sf-1")).toBe(false);
  });

  it("rejects partial matches", () => {
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H-RR")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("H")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("RR-1")).toBe(false);
  });

  it("rejects flags and other formats", () => {
    expect(WORK_ITEM_ID_CLI_PATTERN.test("--help")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("-v")).toBe(false);
    expect(WORK_ITEM_ID_CLI_PATTERN.test("")).toBe(false);
  });
});

// ── cmdRunItems tests ───────────────────────────────────────────────

describe("cmdRunItems", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINTHWAVE_AI_TOOL = "claude";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    cleanupTempRepos();
  });

  /** Set up items with a dependency diamond: A -> B, A -> C, B -> D, C -> D */
  function setupDiamondItems(repo: string): string {
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-test--H-D-1.md"),
      [
        "# Item A (H-D-1)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** None",
        "**Domain:** test",
        "",
        "Item A — no deps.",
        "",
        "Acceptance: A works.",
        "",
        "Key files: `a.ts`",
      ].join("\n"),
    );

    writeFileSync(
      join(workDir, "1-test--H-D-2.md"),
      [
        "# Item B (H-D-2)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** H-D-1",
        "**Domain:** test",
        "",
        "Item B — depends on A.",
        "",
        "Acceptance: B works.",
        "",
        "Key files: `b.ts`",
      ].join("\n"),
    );

    writeFileSync(
      join(workDir, "1-test--H-D-3.md"),
      [
        "# Item C (H-D-3)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** H-D-1",
        "**Domain:** test",
        "",
        "Item C — depends on A.",
        "",
        "Acceptance: C works.",
        "",
        "Key files: `c.ts`",
      ].join("\n"),
    );

    writeFileSync(
      join(workDir, "1-test--H-D-4.md"),
      [
        "# Item D (H-D-4)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** H-D-2, H-D-3",
        "**Domain:** test",
        "",
        "Item D — depends on B and C.",
        "",
        "Acceptance: D works.",
        "",
        "Key files: `d.ts`",
      ].join("\n"),
    );

    spawnSync("git", ["-C", repo, "add", ".ninthwave/work/"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Add diamond items", "--quiet"], { stdio: "pipe" });

    return workDir;
  }

  /** Set up items with circular dependency: A -> B, B -> A */
  function setupCircularItems(repo: string): string {
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-test--H-CYC-1.md"),
      [
        "# Cycle A (H-CYC-1)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** H-CYC-2",
        "**Domain:** test",
        "",
        "Circular dep A.",
      ].join("\n"),
    );

    writeFileSync(
      join(workDir, "1-test--H-CYC-2.md"),
      [
        "# Cycle B (H-CYC-2)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** H-CYC-1",
        "**Domain:** test",
        "",
        "Circular dep B.",
      ].join("\n"),
    );

    spawnSync("git", ["-C", repo, "add", ".ninthwave/work/"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Add circular items", "--quiet"], { stdio: "pipe" });

    return workDir;
  }

  it("dies when an ID is not found", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["NONEXISTENT-1"], workDir, worktreeDir, repo),
    );

    expect(output).toContain("not found");
    expect(output).toContain("nw list");
  });

  it("dies when a dependency is not included and not completed", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    // H-CI-2 depends on M-CI-1, which is not passed and not completed
    const output = await captureOutput(() =>
      cmdRunItems(["H-CI-2"], workDir, worktreeDir, repo),
    );

    expect(output).toContain("Cannot launch H-CI-2");
    expect(output).toContain("depends on M-CI-1");
    expect(output).toContain("neither completed nor included");
  });

  it("suggests including the missing dependency", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["H-CI-2"], workDir, worktreeDir, repo),
    );

    // Should suggest including the dep
    expect(output).toContain("nw H-CI-2 M-CI-1");
  });

  it("launches single ID with no deps (degenerates to simple launch)", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Launch plan:");
    expect(output).toContain("1 item(s) in 1 batch(es)");
    expect(output).toContain("Launched 1 session(s)");
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("launches two items in same batch when no inter-deps", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    // M-CI-1 and C-UO-1 have no inter-dependencies
    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1", "C-UO-1"], workDir, worktreeDir, repo, mockMux, 10),
    );

    expect(output).toContain("2 item(s) in 1 batch(es)");
    expect(output).toContain("Launched 2 session(s)");
    expect(mockMux.launchWorkspace).toHaveBeenCalledTimes(2);
  });

  it("computes correct topo-sort for dependency diamond", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupDiamondItems(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["H-D-1", "H-D-2", "H-D-3", "H-D-4"], workDir, worktreeDir, repo, mockMux, 10),
    );

    // Should show 3 batches: [A], [B, C], [D]
    // Batch 1 has A (H-D-1)
    // Batch 2 has B and C (H-D-2, H-D-3)
    // Batch 3 has D (H-D-4)
    expect(output).toContain("4 item(s) in 3 batch(es)");
    expect(output).toContain("Batch 1:");
    expect(output).toContain("Batch 2:");
    expect(output).toContain("Batch 3:");
    expect(output).toContain("Launched 4 session(s)");
  });

  it("dies with helpful message on circular dependency", async () => {
    const repo = setupTempRepo();
    const workDir = setupCircularItems(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["H-CYC-1", "H-CYC-2"], workDir, worktreeDir, repo),
    );

    expect(output).toContain("Circular dependency detected");
    expect(output).toContain("H-CYC-1");
    expect(output).toContain("H-CYC-2");
  });

  it("allows dependency that's been completed (not in item list)", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    // Create only H-CI-2 which depends on M-CI-1, but M-CI-1 doesn't exist (completed)
    writeFileSync(
      join(workDir, "1-cloud-infrastructure--H-CI-2.md"),
      [
        "# Flaky connection pool timeout (H-CI-2)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** M-CI-1",
        "**Domain:** cloud-infrastructure",
        "",
        "Fix timeout errors.",
        "",
        "Acceptance: No more timeout errors.",
        "",
        "Key files: `config/test.exs`",
      ].join("\n"),
    );

    spawnSync("git", ["-C", repo, "add", ".ninthwave/work/"], { stdio: "pipe" });
    spawnSync("git", ["-C", repo, "commit", "-m", "Add work item", "--quiet"], { stdio: "pipe" });

    const worktreeDir = join(repo, ".worktrees");

    // M-CI-1 doesn't exist in the item list → treated as completed → should be OK
    const output = await captureOutput(() =>
      cmdRunItems(["H-CI-2"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Launched 1 session(s)");
    expect(output).not.toContain("Cannot launch");
  });

  it("dies if launch fails for an item in a batch", async () => {
    const mockMux = createMockMux();
    // Make the mux launch fail
    mockMux.launchWorkspace.mockReturnValue(null);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Failed to launch M-CI-1");
    expect(output).toContain("Aborting remaining items");
  });

  it("logs batch plan before launching", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Launch plan:");
    expect(output).toContain("Batch 1:");
    expect(output).toContain("M-CI-1");
  });

  it("dies early when mux is unavailable (before any worktree creation)", async () => {
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);
    mockMux.diagnoseUnavailable.mockReturnValue(
      "cmux is not available. Ensure cmux is installed and running.",
    );

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("cmux is not available");
    // Should NOT have attempted to launch a workspace
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
    // Should NOT have attempted worktree creation
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("uses same error message as diagnoseUnavailable()", async () => {
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);
    const diagMsg = "Custom diagnostic: install cmux first";
    mockMux.diagnoseUnavailable.mockReturnValue(diagMsg);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain(diagMsg);
  });
});
