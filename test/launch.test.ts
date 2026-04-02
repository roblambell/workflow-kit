// Tests for start command and launch functions.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { join } from "path";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { setupTempRepo, cleanupTempRepos, captureOutputAsync } from "./helpers.ts";
import type { Multiplexer } from "../core/mux.ts";
import { runtimeAgentNameForTool } from "../core/ai-tools.ts";
import { type LaunchGitDeps, launchSingleItem, launchAiSession, launchReviewWorker, launchRebaserWorker, launchForwardFixerWorker, sanitizeTitle, extractItemText, validatePickupCandidate } from "../core/commands/launch.ts";
import { cmdStart, cmdRunItems, WORK_ITEM_ID_CLI_PATTERN } from "../core/commands/run-items.ts";
import { cleanStaleBranchForReuse } from "../core/branch-cleanup.ts";
import { parseWorkItems } from "../core/parser.ts";
import { checkInbox, writeInbox } from "../core/commands/inbox.ts";

type MockMux = Multiplexer & {
  isAvailable: Mock;
  diagnoseUnavailable: Mock;
  launchWorkspace: Mock;
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
  branchExists: Mock;
  createWorktree: Mock;
  attachWorktree: Mock;
  removeWorktree: Mock;
  deleteBranch: Mock;
  findWorktreeForBranch: Mock;
  prList: Mock;
};

/** Create a mock Multiplexer for dependency injection (avoids vi.mock leaking). */
function createMockMux(type: Multiplexer["type"] = "cmux"): MockMux {
  return {
    type,
    isAvailable: vi.fn(() => true),
    diagnoseUnavailable: vi.fn(() => "not available"),
    launchWorkspace: vi.fn(() => type === "headless" ? "headless:test" : "workspace:1"),
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

/** Create mock LaunchGitDeps for dependency injection. */
function createMockLaunchDeps(): MockLaunchDeps {
  return {
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
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

function extractPromptDataFile(cmd: string): string {
  const match = cmd.match(/PROMPT=\$\(cat '([^']+)'\)/);
  expect(match?.[1]).toBeDefined();
  return match![1]!;
}

function seedCanonicalAgent(repo: string, filename: string, instructions: string): void {
  const agentsDir = join(repo, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, filename),
    [
      "---",
      `name: ninthwave-${filename.replace(/\.md$/, "")}`,
      'description: "test agent"',
      "---",
      "",
      instructions,
      "",
    ].join("\n"),
  );
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

// Alias: launch.test.ts previously used `captureOutput` for the async variant
const captureOutput = captureOutputAsync;

// detectAiTool tests removed -- replaced by selectAiTool in test/tool-select.test.ts

describe("cmdStart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("dies with no arguments", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["--tool", "claude"], workDir, worktreeDir, repo),
    );

    expect(output).toContain("Usage");
  });

  it("dies when item ID not found", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["NONEXISTENT-1", "--tool", "claude"], workDir, worktreeDir, repo),
    );

    expect(output).toContain("not found");
  });

  it("launches session for a valid item", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["M-CI-1", "--tool", "claude"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Launched 1 session");
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("uses --tool override when provided", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["M-CI-1", "--tool", "opencode"], workDir, worktreeDir, repo, mockMux),
    );

    // Tool should be used for launching (opencode uses inline command)
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("exec opencode");
  });

  it("uses --tool codex to launch with a composed inline prompt", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    seedCanonicalAgent(repo, "implementer.md", "You are a focused implementation agent.");
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    await captureOutput(() =>
      cmdStart(["M-CI-1", "--tool", "codex"], workDir, worktreeDir, repo, mockMux),
    );

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain('exec codex --dangerously-bypass-approvals-and-sandbox "$PROMPT"');
    expect(cmd).not.toContain("--agent");

    const promptPath = join(worktreeDir, "ninthwave-M-CI-1", ".ninthwave", ".prompt");
    const systemPrompt = readFileSync(promptPath, "utf-8");
    expect(systemPrompt).toContain("YOUR_TODO_ID: M-CI-1");
    expect(systemPrompt).toContain("Upgrade test CI runners from 2 to 4 vCPUs for faster execution.");
    expect(systemPrompt).toContain("Acceptance: Test workflows use 4 vCPU runners. Deploy workflows remain on 2 vCPU.");

    const promptData = readFileSync(extractPromptDataFile(cmd), "utf-8");
    expect(promptData).toContain("You are a focused implementation agent.");
    expect(promptData).toContain(systemPrompt);
    expect(promptData.indexOf("You are a focused implementation agent.")).toBeLessThan(
      promptData.indexOf("YOUR_TODO_ID: M-CI-1"),
    );
  });

  it("dies early when mux is unavailable (before any git operations)", async () => {
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);
    mockMux.diagnoseUnavailable.mockReturnValue(
      "cmux is not available. Ensure cmux is installed and running.",
    );

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdStart(["M-CI-1"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("cmux is not available");
    // Should NOT have attempted to launch a workspace
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("skips a blocked item and continues to a later valid item", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    writeFileSync(
      join(workDir, "1-queue-admission--H-BAD-9.md"),
      [
        "# Broken cross-repo launch (H-BAD-9)",
        "",
        "**Priority:** High",
        "**Source:** Test",
        "**Depends on:** None",
        "**Domain:** queue-admission",
        "**Repo:** missing-repo",
        "",
        "Exercise blocked direct-launch validation.",
        "",
        "Acceptance: Item is blocked before launch side effects.",
        "",
        "Key files: `core/commands/run-items.ts`",
      ].join("\n"),
    );

    const output = await captureOutput(() =>
      cmdStart(["H-BAD-9", "M-CI-1", "--tool", "claude"], workDir, worktreeDir, repo, mockMux),
    );

    expect(output).toContain("Blocking H-BAD-9:");
    expect(output).toContain("Launched 1 session");
    expect(output).toContain("M-CI-1");
    expect(mockMux.launchWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("validatePickupCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("returns merged when a matching merged PR already exists", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const item = parseWorkItems(workDir, worktreeDir).find((candidate) => candidate.id === "M-CI-1")!;
    const deps = createMockLaunchDeps();
    deps.prList.mockImplementation((_repo: string, _branch: string, state: string) => {
      if (state === "open") return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
      return {
        ok: true as const,
        data: [{ number: 42, title: "fix: Upgrade CI runners" }],
      };
    });

    const result = validatePickupCandidate(item, repo, deps);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked result");
    expect(result.code).toBe("merged");
    expect(result.failureReason).toContain("merged PR #42");
  });

  it("returns stale when the branch has an open PR for different work", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const item = parseWorkItems(workDir, worktreeDir).find((candidate) => candidate.id === "M-CI-1")!;
    const deps = createMockLaunchDeps();
    deps.prList.mockImplementation((_repo: string, _branch: string, state: string) => {
      if (state === "open") {
        return {
          ok: true as const,
          data: [{ number: 7, title: "fix: stale launch from previous cycle" }],
        };
      }
      return { ok: true as const, data: [] as Array<{ number: number; title: string }> };
    });

    const result = validatePickupCandidate(item, repo, deps);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked result");
    expect(result.code).toBe("stale");
    expect(result.failureReason).toContain("open PR #7");
    expect(result.failureReason).toContain("Resolve the stale PR");
  });

  it("returns unlaunchable when the target repo cannot be resolved", () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const item = parseWorkItems(workDir, worktreeDir).find((candidate) => candidate.id === "M-CI-1")!;
    item.repoAlias = "missing-repo";

    const result = validatePickupCandidate(item, repo);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked result");
    expect(result.code).toBe("unlaunchable");
    expect(result.failureReason).toContain("Repo 'missing-repo' not found");
  });
});

describe("launchSingleItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("creates worktree and launches session for a single item", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const result = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("ninthwave-M-CI-1");
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    expect(mockMux.launchWorkspace).toHaveBeenCalled();
    expect(result).toContain("Creating worktree for M-CI-1");
  });

  it("uses the runtime-resolved tmux backend instead of the ambient mux", async () => {
    const ambientMux = createMockMux("cmux");
    const resolvedMux = createMockMux("tmux");
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", ambientMux, {
        resolveMux: () => resolvedMux,
      }, deps);
      expect(res).not.toBeNull();
    });

    expect(ambientMux.launchWorkspace).not.toHaveBeenCalled();
    expect(resolvedMux.launchWorkspace).toHaveBeenCalled();
    expect(output).toContain("backend tmux");
    expect(output).toContain("overriding cmux");
  });

  it("uses the runtime-resolved cmux backend inside a tmux session", async () => {
    const ambientMux = createMockMux("tmux");
    const resolvedMux = createMockMux("cmux");
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", ambientMux, {
        resolveMux: () => resolvedMux,
      }, deps);
      expect(res).not.toBeNull();
    });

    expect(ambientMux.launchWorkspace).not.toHaveBeenCalled();
    expect(resolvedMux.launchWorkspace).toHaveBeenCalled();
  });

  it("logs detached headless workers with their log path", async () => {
    const ambientMux = createMockMux("cmux");
    const resolvedMux = createMockMux("headless");
    resolvedMux.launchWorkspace.mockReturnValue("headless:M-CI-1");
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", ambientMux, {
        resolveMux: () => resolvedMux,
      }, deps);
      expect(res).not.toBeNull();
      expect(res!.workspaceRef).toBe("headless:M-CI-1");
    });

    expect(output).toContain("backend headless");
    expect(output).toContain("Headless worker detached for M-CI-1");
    expect(output).toContain("Logs:");
  });

  it("clears stale inbox messages before launching a worker", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;
    const worktreePath = join(worktreeDir, "ninthwave-M-CI-1");

    writeInbox(worktreePath, item.id, "stale message from prior run");
    expect(checkInbox(worktreePath, item.id)).toBe("stale message from prior run");
    writeInbox(worktreePath, item.id, "stale message from prior run");

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
    });

    expect(checkInbox(worktreePath, item.id)).toBeNull();
  });

  it("returns null and cleans up when mux launch fails", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    mockMux.launchWorkspace.mockReturnValueOnce(null);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const result = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).toBeNull();
    });

    expect(result).toContain("cmux launch failed");
    // Cleanup should run after launch failure
    expect(result).toContain("Launch failed for M-CI-1, cleaning up");
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      repo,
      join(worktreeDir, "ninthwave-M-CI-1"),
      true,
    );
  });

  it("allocates a partition for the item", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const result = await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
    });

    // Partition 1 should be allocated (first available)
    expect(result).toContain("partition 1");
  });

  it("ensures worktree directory is created", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // worktreeDir doesn't exist yet -- launchSingleItem should create it
    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
    });

    const { existsSync } = require("fs");
    expect(existsSync(worktreeDir)).toBe(true);
  });

  it("logs warning when fetchOrigin fails but still creates worktree", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    deps.fetchOrigin.mockImplementationOnce(() => {
      throw new Error("network timeout");
    });

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
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
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    deps.ffMerge.mockImplementationOnce(() => {
      throw new Error("not a fast-forward");
    });

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("ninthwave-M-CI-1");
    });

    expect(output).toContain("Failed to fast-forward main");
    expect(output).toContain("not a fast-forward");
    expect(output).toContain("may be outdated");
    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("warning includes actionable context about stale worktree", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    deps.fetchOrigin.mockImplementationOnce(() => {
      throw new Error("Could not resolve host: github.com");
    });
    deps.ffMerge.mockImplementationOnce(() => {
      throw new Error("diverged branches");
    });

    const output = await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
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
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toBe(join(worktreeDir, "ninthwave-M-CI-1"));
    });
  });

  it("creates worktree from dep branch when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/H-1-1",
      }, deps);
      expect(res).not.toBeNull();
    });

    // createWorktree should be called with the dep branch as startPoint
    expect(deps.createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("ninthwave-M-CI-1"),
      "ninthwave/M-CI-1",
      "origin/ninthwave/H-1-1",
    );
  });

  it("fetches dep branch instead of main when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const output = await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/H-1-1",
      }, deps);
    });

    // Should fetch the dep branch, not main
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/H-1-1");
    // Should NOT fetch main
    expect(deps.fetchOrigin).not.toHaveBeenCalledWith(repo, "main");
    // Should NOT call ffMerge (stacked launches skip main ff-merge)
    expect(deps.ffMerge).not.toHaveBeenCalled();
    // Output should mention the dep branch
    expect(output).toContain("Fetching dependency branch ninthwave/H-1-1");
  });

  it("includes BASE_BRANCH in system prompt when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/H-1-1",
      }, deps);
    });

    const promptPath = join(worktreeDir, "ninthwave-M-CI-1", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("BASE_BRANCH: ninthwave/H-1-1");
  });

  it("does not include BASE_BRANCH in system prompt when baseBranch is not set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
    });

    const promptPath = join(worktreeDir, "ninthwave-M-CI-1", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).not.toContain("BASE_BRANCH:");
  });

  it("non-stacked launch still fetches main and calls ffMerge", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
    });

    // Non-stacked: should fetch main and call ffMerge
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "main");
    expect(deps.ffMerge).toHaveBeenCalledWith(repo, "main");
    // createWorktree should use default startPoint "HEAD"
    expect(deps.createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("ninthwave-M-CI-1"),
      "ninthwave/M-CI-1",
      "HEAD",
    );
  });
});

// ── Stacked launch fallback when dep branch is gone (H-SL-1) ───────

describe("launchSingleItem stacked fallback on fetch failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("falls back to main when fetchOrigin throws on baseBranch", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // fetchOrigin throws when called with the dep branch (simulating deleted branch)
    deps.fetchOrigin = vi.fn((repoRoot: string, branch: string) => {
      if (branch === "ninthwave/A-1") {
        throw new Error("fatal: invalid reference: origin/ninthwave/A-1");
      }
      // Allow main fetch to succeed
    });

    await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/A-1",
      }, deps);
      expect(res).not.toBeNull();
    });

    // Should have attempted to fetch the dep branch, then fallen back to main
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/A-1");
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "main");

    // createWorktree should be called with "HEAD" (not "origin/ninthwave/A-1")
    expect(deps.createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("ninthwave-M-CI-1"),
      "ninthwave/M-CI-1",
      "HEAD",
    );
  });

  it("preserves origin/baseBranch startPoint when fetchOrigin succeeds", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // fetchOrigin succeeds for all branches
    deps.fetchOrigin = vi.fn();

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {
        baseBranch: "ninthwave/A-1",
      }, deps);
    });

    // Should only fetch the dep branch (not main)
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/A-1");
    expect(deps.fetchOrigin).not.toHaveBeenCalledWith(repo, "main");

    // createWorktree should use the dep branch as startPoint
    expect(deps.createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("ninthwave-M-CI-1"),
      "ninthwave/M-CI-1",
      "origin/ninthwave/A-1",
    );
  });
});

describe("launchForwardFixerWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("creates the forward-fixer worktree from the repo default branch", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const result = launchForwardFixerWorker(
        "H-PMV-2",
        "merge-sha-123",
        repo,
        "claude",
        mockMux,
        { defaultBranch: "develop" },
        deps,
      );
      expect(result).not.toBeNull();
    });

    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "develop");
    expect(deps.createWorktree).toHaveBeenCalledWith(
      repo,
      join(repo, ".ninthwave", ".worktrees", "ninthwave-fix-forward-H-PMV-2"),
      "ninthwave/fix-forward-H-PMV-2",
      "origin/develop",
    );
  });

  it("writes the resolved default branch into the forward-fixer prompt", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const result = launchForwardFixerWorker(
        "H-PMV-2",
        "merge-sha-123",
        repo,
        "claude",
        mockMux,
        { defaultBranch: "develop" },
        deps,
      );
      expect(result).not.toBeNull();
    });

    const prompt = readFileSync(
      join(repo, ".ninthwave", ".worktrees", "ninthwave-fix-forward-H-PMV-2", ".ninthwave", ".prompt"),
      "utf-8",
    );
    expect(prompt).toContain("REPO_DEFAULT_BRANCH: develop");
    expect(prompt).toContain("REPAIR_PR_OUTCOMES: fix-forward,revert");
    expect(prompt).toContain("CREATE_SYNTHETIC_CHILD_WORK_ITEM: false");
  });
});

describe("launchSingleItem external worktree handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("removes external worktree and retries branch deletion on failure", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Branch exists and is checked out in an external worktree
    deps.branchExists.mockReturnValue(true);
    // First deleteBranch fails (branch checked out in worktree)
    deps.deleteBranch
      .mockImplementationOnce(() => { throw new Error("Cannot delete branch checked out in worktree"); })
      .mockImplementationOnce(() => {}); // Retry succeeds
    // findWorktreeForBranch returns an external worktree path
    const externalWtPath = "/tmp/fake-external-worktree";
    deps.findWorktreeForBranch
      .mockReturnValueOnce(externalWtPath)  // First call (pre-check)
      .mockReturnValueOnce(externalWtPath); // Second call (in catch block)

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
    });

    // removeWorktree should have been called twice: once in the pre-check and once in the catch retry
    expect(deps.removeWorktree).toHaveBeenCalledWith(repo, externalWtPath, true);
    // deleteBranch should have been called twice (initial + retry)
    expect(deps.deleteBranch).toHaveBeenCalledTimes(2);
    // createWorktree should have been called (branch deletion succeeded on retry)
    expect(deps.createWorktree).toHaveBeenCalled();
    expect(output).toContain("Removing and retrying");
  });

  it("propagates error when external worktree removal fails on retry", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    deps.branchExists.mockReturnValue(true);
    // deleteBranch always fails
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("Cannot delete branch checked out in worktree");
    });
    const externalWtPath = "/tmp/fake-external-worktree";
    deps.findWorktreeForBranch
      .mockReturnValueOnce(externalWtPath)  // pre-check
      .mockReturnValueOnce(externalWtPath); // catch block
    // removeWorktree fails on the retry (in catch block)
    deps.removeWorktree
      .mockImplementationOnce(() => {})  // pre-check succeeds
      .mockImplementationOnce(() => { throw new Error("permission denied"); }); // retry fails

    // The error should propagate -- no silent failures
    let thrownError: Error | null = null;
    await captureOutput(() => {
      try {
        launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      } catch (e) {
        thrownError = e as Error;
      }
    });

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Failed to delete branch");
    expect(thrownError!.message).toContain("after worktree removal");
    // createWorktree should NOT have been called (error propagated)
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it("propagates error when no external worktree found but branch deletion fails", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    deps.branchExists.mockReturnValue(true);
    // deleteBranch fails for non-worktree reason
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("branch is protected");
    });
    // No external worktree found
    deps.findWorktreeForBranch.mockReturnValue(null);

    let thrownError: Error | null = null;
    await captureOutput(() => {
      try {
        launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      } catch (e) {
        thrownError = e as Error;
      }
    });

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Failed to delete branch");
    expect(thrownError!.message).toContain("branch is protected");
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it("handles branch in both orchestrator worktree and external worktree", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;
    const expectedWorktreePath = join(worktreeDir, "ninthwave-M-CI-1");

    deps.branchExists.mockReturnValue(true);

    // First findWorktreeForBranch: returns the orchestrator's own worktree path
    // (should be skipped since it matches worktreePath)
    deps.findWorktreeForBranch
      .mockReturnValueOnce(expectedWorktreePath)  // pre-check: same as target, skip
      .mockReturnValueOnce(null); // catch block: no external worktree found

    // deleteBranch fails (branch exists but no external worktree to remove)
    deps.deleteBranch.mockImplementation(() => {
      throw new Error("Cannot delete branch");
    });

    let thrownError: Error | null = null;
    await captureOutput(() => {
      try {
        launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      } catch (e) {
        thrownError = e as Error;
      }
    });

    // Should propagate error since no external worktree to remove
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("Failed to delete branch");
  });
});

describe("launchSingleItem resource cleanup on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("cleans up partition and worktree when launchAiSession returns null", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    // launchAiSession returns null when mux.launchWorkspace fails
    mockMux.launchWorkspace.mockReturnValueOnce(null);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).toBeNull();
    });

    // Cleanup should have been attempted
    expect(output).toContain("Launch failed for M-CI-1, cleaning up");
    // removeWorktree should be called for cleanup
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      repo,
      join(worktreeDir, "ninthwave-M-CI-1"),
      true,
    );
    // Partition should have been released (file should not exist)
    const { existsSync, readdirSync, readFileSync: readFs } = require("fs");
    const partitionDir = join(worktreeDir, ".partitions");
    if (existsSync(partitionDir)) {
      const files = readdirSync(partitionDir);
      for (const f of files) {
        const content = readFs(join(partitionDir, f), "utf-8").trim();
        expect(content).not.toBe("M-CI-1");
      }
    }
  });

  it("cleans up partition and worktree when prompt file write throws", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Make the .ninthwave/.prompt path a directory so writeFileSync throws
    deps.createWorktree.mockImplementationOnce((_repo: string, wtPath: string) => {
      mkdirSync(wtPath, { recursive: true });
      mkdirSync(join(wtPath, ".ninthwave", ".prompt"), { recursive: true });
    });

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      expect(res).toBeNull();
    });

    // Cleanup should have been attempted
    expect(output).toContain("Launch failed for M-CI-1, cleaning up");
    // removeWorktree called for cleanup
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      repo,
      join(worktreeDir, "ninthwave-M-CI-1"),
      true,
    );
    // Partition should have been released
    const { existsSync, readdirSync, readFileSync: readFs } = require("fs");
    const partitionDir = join(worktreeDir, ".partitions");
    if (existsSync(partitionDir)) {
      const files = readdirSync(partitionDir);
      for (const f of files) {
        const content = readFs(join(partitionDir, f), "utf-8").trim();
        expect(content).not.toBe("M-CI-1");
      }
    }
  });

  it("cleanup continues even when individual cleanup steps fail", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    mockMux.launchWorkspace.mockReturnValueOnce(null);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    // Make removeWorktree throw to verify cleanup continues
    deps.removeWorktree.mockImplementationOnce(() => {
      throw new Error("worktree removal failed");
    });

    const output = await captureOutput(() => {
      const res = launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux, {}, deps);
      // Should still return null (not throw)
      expect(res).toBeNull();
    });

    // Should warn about failed cleanup
    expect(output).toContain("Failed to remove worktree for M-CI-1");
    expect(output).toContain("worktree removal failed");
  });
});

describe("cleanStaleBranchForReuse no-external-worktree regression", () => {
  it("works correctly when no external worktrees exist", () => {
    const deps = {
      prList: vi.fn(() => ({ ok: true as const, data: [{ number: 1, title: "fix: old change (OLD-1)" }] })),
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
      prList: vi.fn(() => ({ ok: true as const, data: [] as Array<{ number: number; title: string }> })),
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
      prList: vi.fn(() => ({ ok: true as const, data: [{ number: 1, title: "fix: stale (X-1)" }] })),
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

  it("dispatches to buildHeadlessCmd when mux.type is headless", () => {
    const mockMux = createMockMux("headless");
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux);

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("claude --print");
    expect(cmd).toContain('"Start"');
    expect(cmd).not.toContain("--name 'T-1 Test'");
  });

  it("uses the supported headless opencode command shape", () => {
    const mockMux = createMockMux("headless");
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("opencode", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("OPENCODE_PERMISSION");
    expect(cmd).toContain('exec opencode run "$PROMPT" --agent ninthwave-reviewer');
  });

  it("uses the supported headless copilot command shape", () => {
    const mockMux = createMockMux("headless");
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");
    const expectedAgent = runtimeAgentNameForTool("copilot", "ninthwave-reviewer");

    launchAiSession("copilot", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain('exec copilot -p "$PROMPT"');
    expect(cmd).toContain(`--agent=${expectedAgent}`);
    expect(cmd).toContain("--allow-all-tools");
    expect(cmd).toContain("--allow-all-paths");
    expect(cmd).toContain("--allow-all-urls");
    expect(cmd).toContain("--no-ask-user");
    expect(cmd).not.toContain("-i ");
  });

  it("uses the supported headless codex command shape with reviewer instructions composed into the prompt", () => {
    const mockMux = createMockMux("headless");
    const repo = setupTempRepo();
    seedCanonicalAgent(repo, "reviewer.md", "You are a focused code review agent.");
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, [
      "YOUR_REVIEW_PR: 99",
      "YOUR_REVIEW_ITEM_ID: H-RVW-2",
      "AUTO_FIX_MODE: direct",
    ].join("\n"));

    launchAiSession("codex", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
      projectRoot: repo,
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain('exec codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT"');
    expect(cmd).not.toContain("--agent");

    const promptData = readFileSync(extractPromptDataFile(cmd), "utf-8");
    expect(promptData).toContain("You are a focused code review agent.");
    expect(promptData).toContain("YOUR_REVIEW_PR: 99");
    expect(promptData).toContain("AUTO_FIX_MODE: direct");
    expect(promptData.indexOf("You are a focused code review agent.")).toBeLessThan(
      promptData.indexOf("YOUR_REVIEW_PR: 99"),
    );
  });

  it.each(["cmux", "tmux"] as const)(
    "dispatches to buildLaunchCmd when mux.type is %s",
    (muxType) => {
      const mockMux = createMockMux(muxType);
      const repo = setupTempRepo();
      const promptFile = join(repo, "prompt.txt");
      writeFileSync(promptFile, "test prompt");

      launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux);

      const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
      expect(launchCall).toBeDefined();
      const cmd = launchCall[1] as string;
      expect(cmd).toContain("--name 'T-1 Test'");
      expect(cmd).toContain("-- Start");
      expect(cmd).not.toContain("claude -p \"Start\"");
    },
  );

  it("defaults agentName to ninthwave-implementer when not specified", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux);

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
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

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
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

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    // cmd is an inline shell command (no .sh script)
    expect(cmd).toContain("--agent ninthwave-reviewer");
    expect(cmd).toContain("--prompt");
  });

  it("passes custom agentName to copilot command", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");
    const expectedAgent = runtimeAgentNameForTool("copilot", "ninthwave-reviewer");

    launchAiSession("copilot", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    // cmd is an inline shell command (no .sh script)
    expect(cmd).toContain(`--agent=${expectedAgent}`);
    expect(cmd).toContain("--allow-all");
    expect(cmd).toContain("-i ");
  });

  it("embeds prompt inline via -i for copilot (no post-launch send)", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "do the thing");

    const wsRef = launchAiSession("copilot", repo, "T-1", "Test", promptFile, mockMux);

    expect(wsRef).not.toBeNull();
    // No message should be sent after launch -- prompt is embedded in -i
    expect(mockMux.sendMessage.mock.calls.length).toBe(0);
    // Inline command should reference the prompt data file
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("exec copilot");
  });

  it("passes Start as positional CLI arg for claude (no post-launch send)", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "implement the work item");

    const wsRef = launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux);

    expect(wsRef).not.toBeNull();
    // Command should include -- Start as positional argument
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("-- Start");
    // No message should be sent after launch -- prompt is embedded as positional arg
    expect(mockMux.sendMessage.mock.calls.length).toBe(0);
  });

  it("opencode embeds prompt via --prompt in inline command (no post-launch send)", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "implement the work item");

    const wsRef = launchAiSession("opencode", repo, "T-1", "Test", promptFile, mockMux);

    expect(wsRef).not.toBeNull();
    // No message should be sent after launch -- prompt is embedded via --prompt
    expect(mockMux.sendMessage.mock.calls.length).toBe(0);
    // Inline command should contain --prompt and OPENCODE_PERMISSION
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--prompt");
    expect(cmd).toContain("OPENCODE_PERMISSION");
  });

  it("throws for an unregistered tool ID", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "implement the work item");

    expect(() =>
      launchAiSession("my-custom-tool", repo, "T-1", "Test", promptFile, mockMux)
    ).toThrow("Unknown AI tool: my-custom-tool. Supported: claude, opencode, codex, copilot");
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("passes shared launch override context through launchAiSession", () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const promptFile = join(repo, "prompt.txt");
    writeFileSync(promptFile, "test prompt");

    launchAiSession("claude", repo, "T-1", "Test", promptFile, mockMux, {
      agentName: "ninthwave-reviewer",
      launchOverride: {
        command: "/bin/echo",
        args: ["deterministic-launch"],
      },
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("NINTHWAVE_LAUNCH_TOOL='claude'");
    expect(cmd).toContain("NINTHWAVE_LAUNCH_MODE='launch'");
    expect(cmd).toContain("NINTHWAVE_LAUNCH_AGENT='ninthwave-reviewer'");
    expect(cmd).toContain(`NINTHWAVE_LAUNCH_PROMPT_FILE='${promptFile}'`);
    expect(cmd).toMatch(/NINTHWAVE_LAUNCH_STATE_DIR='[^']+'/);
    expect(cmd).toContain("NINTHWAVE_LAUNCH_ITEM_ID='T-1'");
    expect(cmd).toContain(`NINTHWAVE_LAUNCH_PROJECT_ROOT='${repo}'`);
    expect(cmd).toContain("NINTHWAVE_LAUNCH_WORKSPACE_NAME='T-1 Test'");
    expect(cmd).toContain("exec '/bin/echo' 'deterministic-launch'");
    expect(cmd).not.toContain("exec claude");
  });
});

describe("launchSingleItem agentName default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("launches with --agent ninthwave-implementer by default", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");
    const items = parseWorkItems(workDir, worktreeDir);
    const item = items.find((i) => i.id === "M-CI-1")!;

    await captureOutput(() => {
      launchSingleItem(item, workDir, worktreeDir, repo, "claude", mockMux);
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall).toBeDefined();
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-implementer");
  });
});

describe("launchReviewWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTempRepos();
  });

  it("off mode does not create a worktree and returns worktreePath null", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    const result = await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toBeNull();
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    // Should NOT create a worktree (no createWorktree call)
    expect(deps.createWorktree).not.toHaveBeenCalled();
    // Should NOT call fetchOrigin (no branch to fetch)
    expect(deps.fetchOrigin).not.toHaveBeenCalled();
    // Should launch with ninthwave-reviewer agent
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-reviewer");
    // Info message should mention off mode
    expect(result).toContain("off mode");
  });

  it("direct mode creates worktree from ninthwave/{id} branch", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    const result = await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "direct", repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("review-H-RVW-1");
      expect(res!.workspaceRef).toBe("workspace:1");
    });

    // Should fetch the item branch
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/H-RVW-1");
    // Should create worktree with review branch from origin/ninthwave/{id}
    expect(deps.createWorktree).toHaveBeenCalledWith(
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
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "pr", repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toContain("review-H-RVW-1");
    });

    // Same worktree creation as direct mode
    expect(deps.fetchOrigin).toHaveBeenCalledWith(repo, "ninthwave/H-RVW-1");
    expect(deps.createWorktree).toHaveBeenCalledWith(
      repo,
      expect.stringContaining("review-H-RVW-1"),
      "review/H-RVW-1",
      "origin/ninthwave/H-RVW-1",
    );
  });

  it("system prompt contains correct YOUR_REVIEW_PR and AUTO_FIX_MODE", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(99, "H-RVW-2", "direct", repo, "claude", mockMux, {}, deps);
    });

    const promptPath = join(repo, ".ninthwave", ".worktrees", "review-H-RVW-2", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("YOUR_REVIEW_PR: 99");
    expect(prompt).toContain("YOUR_REVIEW_ITEM_ID: H-RVW-2");
    expect(prompt).toContain("AUTO_FIX_MODE: direct");
    expect(prompt).toContain(`PROJECT_ROOT: ${join(repo, ".ninthwave", ".worktrees", "review-H-RVW-2")}`);
    expect(prompt).toContain(`REPO_ROOT: ${repo}`);
  });

  it("system prompt contains AUTO_FIX_MODE off for off mode", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(50, "H-RVW-3", "off", repo, "claude", mockMux, {}, deps);
    });

    const promptPath = join(repo, ".ninthwave", ".worktrees", "review-H-RVW-3", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("YOUR_REVIEW_PR: 50");
    expect(prompt).toContain("AUTO_FIX_MODE: off");
  });

  it("includes BASE_BRANCH in system prompt when baseBranch is set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux, {
        baseBranch: "ninthwave/H-DEP-1",
      }, deps);
    });

    const promptPath = join(repo, ".ninthwave", ".worktrees", "review-H-RVW-1", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("BASE_BRANCH: ninthwave/H-DEP-1");
  });

  it("does not include BASE_BRANCH when baseBranch is not set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux, {}, deps);
    });

    const promptPath = join(repo, ".ninthwave", ".worktrees", "review-H-RVW-1", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).not.toContain("BASE_BRANCH:");
  });

  it("launches with --agent ninthwave-reviewer for all modes", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    for (const mode of ["off", "direct", "pr"] as const) {
      vi.clearAllMocks();
      await captureOutput(() => {
        launchReviewWorker(42, "H-RVW-1", mode, repo, "claude", mockMux, {}, deps);
      });

      const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
      expect(launchCall).toBeDefined();
      const cmd = launchCall[1] as string;
      expect(cmd).toContain("--agent ninthwave-reviewer");
      expect(cmd).not.toContain("--agent ninthwave-implementer");
    }
  });

  it("keeps reviewer tool, prompt, and repo context unchanged when no override is set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const res = launchReviewWorker(77, "H-RVW-CTX", "off", repo, "opencode", mockMux, {}, deps);
      expect(res).not.toBeNull();
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain('exec opencode --agent ninthwave-reviewer --prompt "$PROMPT"');

    const promptPath = join(repo, ".ninthwave", ".worktrees", "review-H-RVW-CTX", ".ninthwave", ".prompt");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("YOUR_REVIEW_PR: 77");
    expect(prompt).toContain("YOUR_REVIEW_ITEM_ID: H-RVW-CTX");
    expect(prompt).toContain(`PROJECT_ROOT: ${join(repo, ".ninthwave", ".worktrees", "review-H-RVW-CTX")}`);
    expect(prompt).toContain(`REPO_ROOT: ${repo}`);
  });

  it("returns null when fetch fails in direct mode", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    deps.fetchOrigin.mockImplementationOnce(() => {
      throw new Error("branch not found");
    });

    const result = await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "direct", repo, "claude", mockMux, {}, deps);
      expect(res).toBeNull();
    });

    expect(result).toContain("Failed to fetch origin/ninthwave/H-RVW-1");
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("returns null when mux launch fails", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    mockMux.launchWorkspace.mockReturnValueOnce(null);
    const repo = setupTempRepo();

    await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux, {}, deps);
      expect(res).toBeNull();
    });

    expect(mockMux.launchWorkspace).toHaveBeenCalled();
  });

  it("deletes stale review branch before creating worktree", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    deps.branchExists.mockReturnValueOnce(true);

    await captureOutput(() => {
      launchReviewWorker(42, "H-RVW-1", "direct", repo, "claude", mockMux, {}, deps);
    });

    expect(deps.deleteBranch).toHaveBeenCalledWith(repo, "review/H-RVW-1");
  });

  it("off mode uses implementerWorktreePath when provided, does not create a new directory", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();
    const implWorktree = join(repo, ".ninthwave", ".worktrees", "ninthwave-H-RVW-1");
    mkdirSync(implWorktree, { recursive: true });

    await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux, {
        implementerWorktreePath: implWorktree,
      }, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toBeNull();
    });

    // Should NOT create a worktree (no createWorktree call)
    expect(deps.createWorktree).not.toHaveBeenCalled();
    // Should NOT call fetchOrigin
    expect(deps.fetchOrigin).not.toHaveBeenCalled();
    // The review-{id} directory should NOT have been created
    const { existsSync } = require("fs");
    expect(existsSync(join(repo, ".ninthwave", ".worktrees", "review-H-RVW-1"))).toBe(false);
    // The launch should have been called with the implementer's worktree as workDir
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall[0]).toBe(implWorktree);
  });

  it("off mode without implementerWorktreePath falls back to creating plain directory", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const res = launchReviewWorker(42, "H-RVW-1", "off", repo, "claude", mockMux, {}, deps);
      expect(res).not.toBeNull();
      expect(res!.worktreePath).toBeNull();
    });

    // Should have launched from the review-{id} directory (fallback behavior)
    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    expect(launchCall[0]).toContain("review-H-RVW-1");
  });
});

describe("launchRebaserWorker", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("launches Copilot with the runtime agent id exposed by the rebaser artifact", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreePath = join(repo, ".ninthwave", ".worktrees", "ninthwave-H-RB-1");
    mkdirSync(worktreePath, { recursive: true });

    await captureOutput(() => {
      const result = launchRebaserWorker(17, "H-RB-1", repo, "copilot", mockMux);
      expect(result).not.toBeNull();
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain(`--agent=${runtimeAgentNameForTool("copilot", "ninthwave-rebaser")}`);
    expect(cmd).toContain("exec copilot");
  });

  it("keeps rebaser tool, prompt, and worktree context unchanged when no override is set", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const worktreePath = join(repo, ".ninthwave", ".worktrees", "ninthwave-H-RB-CTX");
    mkdirSync(worktreePath, { recursive: true });

    await captureOutput(() => {
      const result = launchRebaserWorker(23, "H-RB-CTX", repo, "claude", mockMux);
      expect(result).not.toBeNull();
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-rebaser");

    const prompt = readFileSync(join(worktreePath, ".ninthwave", ".prompt"), "utf-8");
    expect(prompt).toContain("YOUR_REBASE_ITEM_ID: H-RB-CTX");
    expect(prompt).toContain("YOUR_REBASE_PR: 23");
    expect(prompt).toContain(`PROJECT_ROOT: ${worktreePath}`);
  });
});

describe("launchForwardFixerWorker no override context", () => {
  afterEach(() => {
    cleanupTempRepos();
  });

  it("keeps forward-fixer tool, prompt, and state context unchanged when no override is set", async () => {
    const mockMux = createMockMux();
    const deps = createMockLaunchDeps();
    const repo = setupTempRepo();

    await captureOutput(() => {
      const result = launchForwardFixerWorker(
        "H-FWD-CTX",
        "merge-sha-456",
        repo,
        "claude",
        mockMux,
        { defaultBranch: "develop" },
        deps,
      );
      expect(result).not.toBeNull();
    });

    const launchCall = mockMux.launchWorkspace.mock.calls[0]!;
    const cmd = launchCall[1] as string;
    expect(cmd).toContain("--agent ninthwave-forward-fixer");

    const prompt = readFileSync(
      join(repo, ".ninthwave", ".worktrees", "ninthwave-fix-forward-H-FWD-CTX", ".ninthwave", ".prompt"),
      "utf-8",
    );
    expect(prompt).toContain("YOUR_VERIFY_ITEM_ID: H-FWD-CTX");
    expect(prompt).toContain("YOUR_VERIFY_MERGE_SHA: merge-sha-456");
    expect(prompt).toContain(`REPO_ROOT: ${repo}`);
    expect(prompt).toContain("REPO_DEFAULT_BRANCH: develop");
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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
        "Item A -- no deps.",
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
        "Item B -- depends on A.",
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
        "Item C -- depends on A.",
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
        "Item D -- depends on B and C.",
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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["NONEXISTENT-1"], workDir, worktreeDir, repo, undefined, undefined, "claude"),
    );

    expect(output).toContain("not found");
    expect(output).toContain("nw list");
  });

  it("dies when a dependency is not included and not completed", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    // H-CI-2 depends on M-CI-1, which is not passed and not completed
    const output = await captureOutput(() =>
      cmdRunItems(["H-CI-2"], workDir, worktreeDir, repo, undefined, undefined, "claude"),
    );

    expect(output).toContain("Cannot launch H-CI-2");
    expect(output).toContain("depends on M-CI-1");
    expect(output).toContain("neither completed nor included");
  });

  it("suggests including the missing dependency", async () => {
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["H-CI-2"], workDir, worktreeDir, repo, undefined, undefined, "claude"),
    );

    // Should suggest including the dep
    expect(output).toContain("nw H-CI-2 M-CI-1");
  });

  it("launches single ID with no deps (degenerates to simple launch)", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux, undefined, "claude"),
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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    // M-CI-1 and C-UO-1 have no inter-dependencies
    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1", "C-UO-1"], workDir, worktreeDir, repo, mockMux, 10, "claude"),
    );

    expect(output).toContain("2 item(s) in 1 batch(es)");
    expect(output).toContain("Launched 2 session(s)");
    expect(mockMux.launchWorkspace).toHaveBeenCalledTimes(2);
  });

  it("computes correct topo-sort for dependency diamond", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupDiamondItems(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["H-D-1", "H-D-2", "H-D-3", "H-D-4"], workDir, worktreeDir, repo, mockMux, 10, "claude"),
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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["H-CYC-1", "H-CYC-2"], workDir, worktreeDir, repo, undefined, undefined, "claude"),
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

    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    // M-CI-1 doesn't exist in the item list → treated as completed → should be OK
    const output = await captureOutput(() =>
      cmdRunItems(["H-CI-2"], workDir, worktreeDir, repo, mockMux, undefined, "claude"),
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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux, undefined, "claude"),
    );

    expect(output).toContain("Failed to launch M-CI-1");
    expect(output).toContain("Aborting remaining items");
  });

  it("logs batch plan before launching", async () => {
    const mockMux = createMockMux();
    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux, undefined, "claude"),
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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux, undefined, "claude"),
    );

    expect(output).toContain("cmux is not available");
    // Should NOT have attempted to launch a workspace
    expect(mockMux.launchWorkspace).not.toHaveBeenCalled();
  });

  it("uses same error message as diagnoseUnavailable()", async () => {
    const mockMux = createMockMux();
    mockMux.isAvailable.mockReturnValue(false);
    const diagMsg = "Custom diagnostic: install cmux first";
    mockMux.diagnoseUnavailable.mockReturnValue(diagMsg);

    const repo = setupTempRepo();
    const workDir = setupWorkItemsDir(repo);
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = await captureOutput(() =>
      cmdRunItems(["M-CI-1"], workDir, worktreeDir, repo, mockMux, undefined, "claude"),
    );

    expect(output).toContain(diagMsg);
  });
});
