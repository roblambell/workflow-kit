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
import {
  cmdWatchReady,
  cmdAutopilotWatch,
  cmdPrWatch,
  cmdPrActivity,
  checkPrStatus,
  getWatchReadyState,
  findTransitions,
  findGoneItems,
  TRUSTED_ASSOC,
} from "../core/commands/watch.ts";

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
    // Ensure it's not ci-passed (which also contains "passed")
    expect(result).not.toContain("ci-passed");
  });

  it("classifies passing CI without approval as ci-passed", () => {
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
      { state: "SUCCESS", name: "test", url: "" },
    ]);

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("ci-passed");
  });

  it("classifies passing CI with non-mergeable as ci-passed", () => {
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
      mergeable: "CONFLICTING",
    });
    (gh.prChecks as Mock).mockReturnValue([
      { state: "SUCCESS", name: "test", url: "" },
    ]);

    const result = cmdWatchReady(worktreeDir, repo);
    expect(result).toContain("ci-passed");
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

// =============================================================================
// Direct tests for exported helper functions
// =============================================================================

describe("checkPrStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (gh.isAvailable as Mock).mockReturnValue(true);
  });

  it("returns merged status when PR is merged", () => {
    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [];
        if (state === "merged") return [{ number: 99 }];
        return [];
      },
    );

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t99\tmerged");
  });

  it("returns no-pr when no PR exists", () => {
    (gh.prList as Mock).mockReturnValue([]);

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t\tno-pr");
  });

  it("returns empty string when gh is not available", () => {
    (gh.isAvailable as Mock).mockReturnValue(false);

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("");
  });

  it("returns ready when CI passes and PR is approved and mergeable", () => {
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

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t10\tready");
  });

  it("returns ci-passed when CI passes but not approved", () => {
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
      { state: "SUCCESS", name: "test", url: "" },
    ]);

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t10\tci-passed");
  });

  it("returns ci-passed when CI passes but not mergeable", () => {
    (gh.prList as Mock).mockImplementation(
      (_root: string, _branch: string, state: string) => {
        if (state === "open") return [{ number: 10 }];
        return [];
      },
    );
    (gh.prView as Mock).mockReturnValue({
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
    });
    (gh.prChecks as Mock).mockReturnValue([
      { state: "SUCCESS", name: "test", url: "" },
    ]);

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t10\tci-passed");
  });

  it("returns failing when CI fails", () => {
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

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t10\tfailing");
  });

  it("returns pending when CI is pending", () => {
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
      { state: "PENDING", name: "build", url: "" },
    ]);

    const result = checkPrStatus("H-1-1", "/fake/repo");
    expect(result).toBe("H-1-1\t10\tpending");
  });
});

describe("getWatchReadyState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (gh.isAvailable as Mock).mockReturnValue(true);
  });
  afterEach(() => cleanupTempRepos());

  it("returns empty string when worktree dir does not exist", () => {
    const result = getWatchReadyState("/nonexistent/path", "/fake/repo");
    expect(result).toBe("");
  });

  it("returns status lines for worktrees", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-A-1-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "todo-B-2-1"), { recursive: true });

    (gh.prList as Mock).mockReturnValue([]);

    const result = getWatchReadyState(worktreeDir, repo);
    expect(result).toContain("A-1-1");
    expect(result).toContain("B-2-1");
    expect(result).toContain("no-pr");
  });

  it("skips non-todo entries", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(join(worktreeDir, "todo-A-1-1"), { recursive: true });
    mkdirSync(join(worktreeDir, "other-dir"), { recursive: true });

    (gh.prList as Mock).mockReturnValue([]);

    const result = getWatchReadyState(worktreeDir, repo);
    expect(result).toContain("A-1-1");
    expect(result).not.toContain("other-dir");
  });
});

describe("findTransitions", () => {
  it("detects status change from pending to ready", () => {
    const prev = "H-1-1\t10\tpending";
    const curr = "H-1-1\t10\tready";

    const result = findTransitions(curr, prev);
    expect(result).toBe("H-1-1\t10\tpending\tready\n");
  });

  it("detects status change from pending to ci-passed", () => {
    const prev = "H-1-1\t10\tpending";
    const curr = "H-1-1\t10\tci-passed";

    const result = findTransitions(curr, prev);
    expect(result).toBe("H-1-1\t10\tpending\tci-passed\n");
  });

  it("detects status change from ci-passed to ready", () => {
    const prev = "H-1-1\t10\tci-passed";
    const curr = "H-1-1\t10\tready";

    const result = findTransitions(curr, prev);
    expect(result).toBe("H-1-1\t10\tci-passed\tready\n");
  });

  it("returns empty string when no transitions", () => {
    const state = "H-1-1\t10\tpending";
    const result = findTransitions(state, state);
    expect(result).toBe("");
  });

  it("handles new items not in previous state", () => {
    const prev = "";
    const curr = "H-1-1\t10\tpending";

    const result = findTransitions(curr, prev);
    // New item: prevStatus defaults to "no-pr", current is "pending"
    expect(result).toBe("H-1-1\t10\tno-pr\tpending\n");
  });

  it("handles multiple items with mixed transitions", () => {
    const prev = "A-1-1\t10\tpending\nB-2-1\t20\tfailing";
    const curr = "A-1-1\t10\tci-passed\nB-2-1\t20\tfailing";

    const result = findTransitions(curr, prev);
    expect(result).toContain("A-1-1\t10\tpending\tci-passed\n");
    expect(result).not.toContain("B-2-1");
  });
});

describe("findGoneItems", () => {
  it("detects items that disappeared", () => {
    const prev = "H-1-1\t10\tready\nH-2-1\t20\tpending";
    const curr = "H-1-1\t10\tready";

    const result = findGoneItems(curr, prev);
    expect(result).toBe("H-2-1\t20\tpending\tgone\n");
  });

  it("returns empty string when no items disappeared", () => {
    const state = "H-1-1\t10\tready";
    const result = findGoneItems(state, state);
    expect(result).toBe("");
  });

  it("returns empty string when no previous state", () => {
    const result = findGoneItems("H-1-1\t10\tready", "");
    expect(result).toBe("");
  });

  it("detects multiple gone items", () => {
    const prev = "A-1-1\t10\tready\nB-2-1\t20\tpending\nC-3-1\t30\tfailing";
    const curr = "B-2-1\t20\tpending";

    const result = findGoneItems(curr, prev);
    expect(result).toContain("A-1-1\t10\tready\tgone\n");
    expect(result).toContain("C-3-1\t30\tfailing\tgone\n");
    expect(result).not.toContain("B-2-1");
  });
});

// =============================================================================
// Author association filtering tests
// =============================================================================

describe("TRUSTED_ASSOC constant", () => {
  it("includes OWNER, MEMBER, and COLLABORATOR associations", () => {
    expect(TRUSTED_ASSOC).toContain("OWNER");
    expect(TRUSTED_ASSOC).toContain("MEMBER");
    expect(TRUSTED_ASSOC).toContain("COLLABORATOR");
  });

  it("does not include untrusted associations", () => {
    expect(TRUSTED_ASSOC).not.toContain("NONE");
    expect(TRUSTED_ASSOC).not.toContain("FIRST_TIME_CONTRIBUTOR");
    expect(TRUSTED_ASSOC).not.toContain("CONTRIBUTOR");
  });
});

describe("cmdPrActivity author_association filtering", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("passes author_association filter in jq queries", () => {
    const repo = setupTempRepo();

    // Track all apiGet calls to verify jq filters
    (gh.apiGet as Mock).mockReturnValue("0");

    captureOutput(() =>
      cmdPrActivity(["42", "--since", "2026-01-01T00:00:00Z"], repo),
    );

    // Every apiGet call should include the trusted association filter
    const calls = (gh.apiGet as Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const jqFilter = call[2] as string;
      expect(jqFilter).toContain("author_association");
      expect(jqFilter).toContain("OWNER");
      expect(jqFilter).toContain("MEMBER");
      expect(jqFilter).toContain("COLLABORATOR");
    }
  });

  it("reports no activity when only non-collaborator comments exist", () => {
    const repo = setupTempRepo();

    // apiGet returns "0" for all filtered queries (no trusted comments)
    (gh.apiGet as Mock).mockReturnValue("0");

    const output = captureOutput(() =>
      cmdPrActivity(["42", "--since", "2026-01-01T00:00:00Z"], repo),
    );

    expect(output).toContain("42\tnone");
  });
});

describe("cmdPrWatch author_association filtering", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("passes author_association filter in jq queries for activity detection", async () => {
    const repo = setupTempRepo();

    // Return > 0 count to trigger activity detection on first poll
    (gh.apiGet as Mock).mockReturnValue("3");

    await captureOutputAsync(() =>
      cmdPrWatch(
        ["--pr", "42", "--interval", "0", "--since", "2026-01-01T00:00:00Z"],
        repo,
      ),
    );

    // Check that apiGet calls include author_association filtering
    const calls = (gh.apiGet as Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const jqFilter = call[2] as string;
      if (jqFilter) {
        expect(jqFilter).toContain("author_association");
      }
    }
  });
});
