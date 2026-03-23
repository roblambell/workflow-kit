// Tests for watch commands: cmdWatchReady, cmdAutopilotWatch, cmdPrWatch.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

// Mock gh module (no dedicated test file)
vi.mock("../core/gh.ts", () => ({
  prList: vi.fn(() => []),
  prView: vi.fn(() => ({})),
  prChecks: vi.fn(() => []),
  getRepoOwner: vi.fn(() => "owner/repo"),
  apiGet: vi.fn(() => "0"),
  isAvailable: vi.fn(() => true),
}));

// Import mocked module for assertions
import * as gh from "../core/gh.ts";

// Import after mocks
import { cmdWatchReady, cmdAutopilotWatch, cmdPrWatch } from "../core/commands/watch.ts";

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

async function captureOutputAsync(fn: () => Promise<void>): Promise<string> {
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

describe("cmdWatchReady", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("reports no active worktrees when directory doesn't exist", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdWatchReady(worktreeDir, repo),
    );

    expect(output).toContain("No active worktrees");
  });

  it("classifies merged PRs as merged", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    // No open PRs, but has merged PRs
    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [];
        if (state === "merged") return [{ number: 42 }];
        return [];
      },
    );

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("H-CI-2");
    expect(result).toContain("merged");
  });

  it("classifies items with no PR as no-pr", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-M-CI-1"), { recursive: true });

    (gh.prList as Mock).mockReturnValue([]);

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("M-CI-1");
    expect(result).toContain("no-pr");
  });

  it("classifies failing CI as failing", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [{ number: 10 }];
        return [];
      },
    );
    (gh.prView as Mock).mockReturnValue({
      reviewDecision: "",
      mergeable: "MERGEABLE",
    });
    (gh.prChecks as Mock).mockReturnValue([
      { state: "FAILURE", name: "test", url: "" },
    ]);

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("failing");
  });

  it("classifies passing CI with approval as ready", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [{ number: 10 }];
        return [];
      },
    );
    (gh.prView as Mock).mockReturnValue({
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
    });
    (gh.prChecks as Mock).mockReturnValue([
      { state: "SUCCESS", name: "test", url: "" },
    ]);

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("ready");
  });

  it("classifies pending CI as pending", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-M-CI-1"), { recursive: true });

    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [{ number: 5 }];
        return [];
      },
    );
    (gh.prView as Mock).mockReturnValue({
      reviewDecision: "",
      mergeable: "MERGEABLE",
    });
    (gh.prChecks as Mock).mockReturnValue([
      { state: "PENDING", name: "build", url: "" },
    ]);

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("pending");
  });
});

describe("cmdAutopilotWatch", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("reports transitions immediately when state changes from previous", async () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-H-CI-2"), { recursive: true });

    const stateFile = join(repo, ".watch-state");

    // Write a previous state with "pending"
    writeFileSync(stateFile, "H-CI-2\t10\tpending");

    // Now the current state is "merged"
    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [];
        if (state === "merged") return [{ number: 10 }];
        return [];
      },
    );

    const output = await captureOutputAsync(() =>
      cmdAutopilotWatch(
        ["--state-file", stateFile, "--interval", "1"],
        worktreeDir,
        repo,
      ),
    );

    expect(output).toContain("H-CI-2");
    expect(output).toContain("pending");
    expect(output).toContain("merged");
  });
});

describe("cmdPrWatch", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("dies without --pr argument", async () => {
    const repo = setupTempRepo();

    const output = await captureOutputAsync(() =>
      cmdPrWatch([], repo),
    );

    expect(output).toContain("Usage");
  });

  it("detects activity on first poll", async () => {
    const repo = setupTempRepo();

    // Return activity count > 0 on first poll
    (gh.apiGet as Mock).mockReturnValue("3");

    const output = await captureOutputAsync(() =>
      cmdPrWatch(["--pr", "42", "--interval", "0", "--since", "2026-01-01T00:00:00Z"], repo),
    );

    expect(output).toContain("activity");
    expect(output).toContain("42");
  });
});
