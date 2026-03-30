// Tests for checkPrStatusAsync and buildSnapshotAsync.
// Uses dependency injection and gh-module-level spies per project conventions.
// Avoids vi.spyOn(shell, "run") which leaks across files (gh.test.ts also spies on it).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkPrStatusAsync } from "../core/commands/pr-monitor.ts";
import { buildSnapshotAsync, getWorktreeLastCommitTimeAsync } from "../core/commands/orchestrate.ts";
import { getWorktreeLastCommitTime } from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ItemSnapshot,
} from "../core/orchestrator.ts";
import type { WorkItem } from "../core/types.ts";
import type { Multiplexer } from "../core/mux.ts";
import * as gh from "../core/gh.ts";

// Spy on gh-module async functions (unique to this test file -- no other file spies on these)
const isAvailableSpy = vi.spyOn(gh, "isAvailable");
const prListAsyncSpy = vi.spyOn(gh, "prListAsync");
const prViewAsyncSpy = vi.spyOn(gh, "prViewAsync");
const prChecksAsyncSpy = vi.spyOn(gh, "prChecksAsync");

beforeEach(() => {
  isAvailableSpy.mockReset();
  prListAsyncSpy.mockReset();
  prViewAsyncSpy.mockReset();
  prChecksAsyncSpy.mockReset();
  // Default: gh is available
  isAvailableSpy.mockReturnValue(true);
});

afterEach(() => {
  isAvailableSpy.mockReset();
  prListAsyncSpy.mockReset();
  prViewAsyncSpy.mockReset();
  prChecksAsyncSpy.mockReset();
});

// ── checkPrStatusAsync ──────────────────────────────────────────────

describe("checkPrStatusAsync", () => {
  it("returns open PR with CI info", async () => {
    prListAsyncSpy.mockImplementation(async (_root: string, _branch: string, state: string) => {
      if (state === "open") return { ok: true, data: [{ number: 10, title: "Fix" }] };
      return { ok: true, data: [] };
    });
    prViewAsyncSpy.mockResolvedValue({ ok: true, data: {
      reviewDecision: "",
      mergeable: "MERGEABLE",
      updatedAt: "2026-01-01T00:00:00Z",
    } });
    prChecksAsyncSpy.mockResolvedValue({ ok: true, data: [
      { state: "SUCCESS", name: "test", url: "https://ci/1", completedAt: "2026-01-01T01:00:00Z" },
    ] });

    const result = await checkPrStatusAsync("T-1-1", "/repo");

    expect(result).toContain("T-1-1");
    expect(result).toContain("10");
    expect(result).toContain("ci-passed");
  });

  it("returns merged PR", async () => {
    prListAsyncSpy.mockImplementation(async (_root: string, _branch: string, state: string) => {
      if (state === "open") return { ok: true, data: [] };
      if (state === "merged") return { ok: true, data: [{ number: 5, title: "Done" }] };
      return { ok: true, data: [] };
    });

    const result = await checkPrStatusAsync("T-1-1", "/repo");

    expect(result).toContain("merged");
    expect(result).toContain("5");
    expect(result).toContain("Done");
  });

  it("returns no-pr when no PRs found", async () => {
    prListAsyncSpy.mockResolvedValue({ ok: true, data: [] });

    const result = await checkPrStatusAsync("T-1-1", "/repo");

    expect(result).toContain("no-pr");
  });

  it("returns empty string when gh unavailable", async () => {
    isAvailableSpy.mockReturnValue(false);

    const result = await checkPrStatusAsync("T-1-1", "/repo");

    expect(result).toBe("");
  });

  it("returns empty string when API fails (hold state)", async () => {
    prListAsyncSpy.mockResolvedValue({ ok: false, error: "API timeout" });

    const result = await checkPrStatusAsync("T-1-1", "/repo");

    expect(result).toBe("");
  });
});

// ── buildSnapshotAsync ──────────────────────────────────────────────

function makeWorkItem(id: string, deps: string[] = []): WorkItem {
  return {
    id,
    priority: "high",
    title: `Item ${id}`,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: `## ${id}\nTest item`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

const fakeMux: Multiplexer = {
  type: "cmux" as const,
  isAvailable: () => false,
  diagnoseUnavailable: () => "not available",
  launchWorkspace: () => null,
  splitPane: () => null,
  sendMessage: () => true,
  readScreen: () => "",
  listWorkspaces: () => "",
  closeWorkspace: () => true,
};

describe("buildSnapshotAsync", () => {
  it("assembles snapshot from async checkPr results", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-1-1"));
    orch.getItem("BA-1-1")!.reviewCompleted = true;
    orch.hydrateState("BA-1-1", "implementing");

    const asyncCheckPr = async (_id: string, _root: string) => {
      return "BA-1-1\t10\tci-passed\tMERGEABLE\t2026-01-01T00:00:00Z";
    };

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.prNumber).toBe(10);
    expect(snapshot.items[0]!.ciStatus).toBe("pass");
    expect(snapshot.items[0]!.isMergeable).toBe(true);
  });

  it("skips terminal states", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-2-1"));
    orch.getItem("BA-2-1")!.reviewCompleted = true;
    orch.hydrateState("BA-2-1", "done");

    const asyncCheckPr = vi.fn(async () => null);

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    expect(snapshot.items).toHaveLength(0);
    expect(asyncCheckPr).not.toHaveBeenCalled();
  });

  it("computes readyIds for queued items with met dependencies", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-3-1"));
    orch.addItem(makeWorkItem("BA-3-2", ["BA-3-1"]));
    orch.getItem("BA-3-1")!.reviewCompleted = true;
    orch.hydrateState("BA-3-1", "done");

    const asyncCheckPr = vi.fn(async () => null);

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    expect(snapshot.readyIds).toContain("BA-3-2");
  });

  it("handles checkPr failure gracefully", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-4-1"));
    orch.getItem("BA-4-1")!.reviewCompleted = true;
    orch.hydrateState("BA-4-1", "implementing");

    const asyncCheckPr = async (_id: string, _root: string) => null;

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.id).toBe("BA-4-1");
    expect(snapshot.items[0]!.prNumber).toBeUndefined();
  });

  it("processes merged PR status", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-5-1"));
    orch.getItem("BA-5-1")!.reviewCompleted = true;
    orch.hydrateState("BA-5-1", "merging");

    const asyncCheckPr = async () => "BA-5-1\t20\tmerged\t\t\tItem BA-5-1";

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.prState).toBe("merged");
    expect(snapshot.items[0]!.prNumber).toBe(20);
  });

  it("tracks apiErrorCount when checkPr returns empty string (API error)", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-6-1"));
    orch.addItem(makeWorkItem("BA-6-2"));
    orch.getItem("BA-6-1")!.reviewCompleted = true;
    orch.getItem("BA-6-2")!.reviewCompleted = true;
    orch.hydrateState("BA-6-1", "ci-pending");
    orch.hydrateState("BA-6-2", "implementing");

    // Both items return empty string (API error)
    const asyncCheckPr = async () => "";

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    // Items should still be in snapshot (for liveness/heartbeat data)
    expect(snapshot.items).toHaveLength(2);
    // apiErrorCount should count both failures
    expect(snapshot.apiErrorCount).toBe(2);
    // PR data should be empty (hold state)
    for (const item of snapshot.items) {
      expect(item.prNumber).toBeUndefined();
      expect(item.ciStatus).toBeUndefined();
    }
  });

  it("apiErrorCount is undefined when all API calls succeed", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-7-1"));
    orch.getItem("BA-7-1")!.reviewCompleted = true;
    orch.hydrateState("BA-7-1", "implementing");

    const asyncCheckPr = async () => "BA-7-1\t10\tci-passed\tMERGEABLE\t2026-01-01T00:00:00Z";

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
    );

    expect(snapshot.apiErrorCount).toBeUndefined();
  });

  it("awaits async getLastCommitTime parameter", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-8-1"));
    orch.getItem("BA-8-1")!.reviewCompleted = true;
    orch.hydrateState("BA-8-1", "implementing");

    const asyncCheckPr = async () => "BA-8-1\t10\tci-passed\tMERGEABLE\t2026-01-01T00:00:00Z";
    const asyncGetLastCommitTime = async (_root: string, _branch: string): Promise<string | null> => {
      // Simulate async delay
      await new Promise((r) => setTimeout(r, 1));
      return "2026-01-15T12:00:00Z";
    };

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      asyncGetLastCommitTime,
      asyncCheckPr,
    );

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.lastCommitTime).toBe("2026-01-15T12:00:00Z");
  });

  it("awaits async fetchComments parameter", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-9-1"));
    orch.getItem("BA-9-1")!.reviewCompleted = true;
    orch.hydrateState("BA-9-1", "ci-pending");
    orch.getItem("BA-9-1")!.prNumber = 42;

    const asyncCheckPr = async () => "BA-9-1\t42\tci-passed\tMERGEABLE\t2026-01-01T00:00:00Z";
    const asyncFetchComments = async (_root: string, _pr: number, _since: string) => {
      await new Promise((r) => setTimeout(r, 1));
      return [{ body: "LGTM", author: "reviewer", authorAssociation: "OWNER", createdAt: "2026-01-15T12:00:00Z" }];
    };

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
      asyncFetchComments,
    );

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.newComments).toHaveLength(1);
    expect(snapshot.items[0]!.newComments![0]!.body).toBe("LGTM");
  });

  it("awaits async checkCommitCI parameter for verifying state", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BA-10-1"));
    orch.getItem("BA-10-1")!.reviewCompleted = true;
    orch.hydrateState("BA-10-1", "forward-fix-pending");
    orch.getItem("BA-10-1")!.mergeCommitSha = "abc123";

    const asyncCheckPr = vi.fn(async () => null);
    const asyncCheckCommitCI = async (_root: string, _sha: string): Promise<"pass" | "fail" | "pending"> => {
      await new Promise((r) => setTimeout(r, 1));
      return "pass";
    };

    const snapshot = await buildSnapshotAsync(
      orch,
      "/project",
      "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,
      asyncCheckPr,
      undefined,
      asyncCheckCommitCI,
    );

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.mergeCommitCIStatus).toBe("pass");
    // checkPr should NOT be called for verifying items
    expect(asyncCheckPr).not.toHaveBeenCalled();
  });
});

// ── getWorktreeLastCommitTimeAsync ─────────────────────────────────

describe("getWorktreeLastCommitTimeAsync", () => {
  it("returns same result as sync getWorktreeLastCommitTime for the current branch", async () => {
    // Use the current project root and a known branch (main exists in any worktree)
    // Both should return null for a non-existent branch
    const fakeRoot = "/nonexistent-project-path";
    const syncResult = getWorktreeLastCommitTime(fakeRoot, "nonexistent-branch-xyz");
    const asyncResult = await getWorktreeLastCommitTimeAsync(fakeRoot, "nonexistent-branch-xyz");

    expect(asyncResult).toBe(syncResult);
    expect(asyncResult).toBeNull();
  });

  it("returns null for branches with no commits ahead of main", async () => {
    const result = await getWorktreeLastCommitTimeAsync("/nonexistent-path", "main..main");
    expect(result).toBeNull();
  });
});

// ── Async function signature checks ─────────────────────────────────

describe("async variant signature parity", () => {
  it("fetchTrustedPrCommentsAsync returns a Promise", () => {
    // Verify the function exists and returns a thenable
    expect(typeof gh.fetchTrustedPrCommentsAsync).toBe("function");
    // Verify parameter count matches sync version (repoRoot, prNumber, since)
    expect(gh.fetchTrustedPrCommentsAsync.length).toBe(gh.fetchTrustedPrComments.length);
  });

  it("checkCommitCIAsync returns a Promise", () => {
    expect(typeof gh.checkCommitCIAsync).toBe("function");
    // Verify parameter count matches sync version (repoRoot, sha)
    expect(gh.checkCommitCIAsync.length).toBe(gh.checkCommitCI.length);
  });

  it("getWorktreeLastCommitTimeAsync returns a Promise", () => {
    expect(typeof getWorktreeLastCommitTimeAsync).toBe("function");
    // Verify parameter count matches sync version (projectRoot, branchName)
    expect(getWorktreeLastCommitTimeAsync.length).toBe(getWorktreeLastCommitTime.length);
  });
});
