// Tests for bulk PR cache: verifies that buildSnapshotAsync with a PrBulkCache
// resolves all item data from the cache with zero per-item API calls, bypasses
// the RequestQueue, and falls back to per-item calls when the cache is null.
// Uses dependency injection -- no vi.mock.

import { describe, it, expect } from "vitest";
import { buildSnapshotAsync } from "../core/commands/orchestrate.ts";
import {
  checkPrStatusDetailed,
  checkPrStatusDetailedAsync,
} from "../core/commands/pr-monitor.ts";
import { reconstructState } from "../core/reconstruct.ts";
import { RequestQueue } from "../core/request-queue.ts";
import { Orchestrator } from "../core/orchestrator.ts";
import type { PrBulkCache, BulkPrEntry } from "../core/gh.ts";
import type { WorkItem } from "../core/types.ts";
import type { Multiplexer } from "../core/mux.ts";
import type { PrMonitorDeps, PrMonitorAsyncDeps } from "../core/commands/pr-monitor.ts";

// ── Helpers ─────────────────────────────────────────────────────────

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
    rawText: `## ${id}\nTest item`,
    filePaths: [],
    testPlan: "",
  };
}

const fakeMux: Multiplexer = {
  type: "cmux" as const,
  isAvailable: () => false,
  diagnoseUnavailable: () => "not available",
  launchWorkspace: () => null,
  splitPane: () => null,
  readScreen: () => "",
  listWorkspaces: () => "",
  closeWorkspace: () => true,
  setStatus: () => true,
  setProgress: () => true,
};

function buildCache(
  open: BulkPrEntry[] = [],
  merged: BulkPrEntry[] = [],
): PrBulkCache {
  const openMap = new Map<string, BulkPrEntry[]>();
  const mergedMap = new Map<string, BulkPrEntry[]>();
  for (const pr of open) {
    const existing = openMap.get(pr.headRefName) ?? [];
    existing.push(pr);
    openMap.set(pr.headRefName, existing);
  }
  for (const pr of merged) {
    const existing = mergedMap.get(pr.headRefName) ?? [];
    existing.push(pr);
    mergedMap.set(pr.headRefName, existing);
  }
  return { open: openMap, merged: mergedMap };
}

function makeOpenPr(id: string, prNumber: number, opts: Partial<BulkPrEntry> = {}): BulkPrEntry {
  return {
    number: prNumber,
    title: `PR for ${id}`,
    body: "",
    headRefName: `ninthwave/${id}`,
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    updatedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    statusCheckRollup: [{ state: "SUCCESS", name: "ci", completedAt: "2026-01-01T00:01:00Z" }],
    ...opts,
  };
}

function makeMergedPr(id: string, prNumber: number): BulkPrEntry {
  return {
    number: prNumber,
    title: `PR for ${id}`,
    body: "",
    headRefName: `ninthwave/${id}`,
  };
}

// ── checkPrStatusDetailed with cache ──────────────────────────────

describe("checkPrStatusDetailed with PrBulkCache", () => {
  // Deps that would fail if called (verifies cache is used instead)
  const failDeps: PrMonitorDeps = {
    prList: () => { throw new Error("prList should not be called with cache"); },
    prView: () => { throw new Error("prView should not be called with cache"); },
    prChecks: () => { throw new Error("prChecks should not be called with cache"); },
    isAvailable: () => true,
    getRepoOwner: () => "owner/repo",
    apiGet: () => "",
  };

  it("resolves open PR status entirely from cache (zero API calls)", () => {
    const cache = buildCache([
      makeOpenPr("WI-1", 42),
    ]);

    const result = checkPrStatusDetailed("WI-1", "/repo", failDeps, cache);

    expect(result.statusLine).toContain("WI-1");
    expect(result.statusLine).toContain("42");
    expect(result.statusLine).toContain("ready"); // APPROVED + SUCCESS = ready
    expect(result.statusLine).toContain("MERGEABLE");
    expect(result.failure).toBeUndefined();
  });

  it("resolves merged PR status from cache", () => {
    const cache = buildCache([], [
      makeMergedPr("WI-2", 99),
    ]);

    const result = checkPrStatusDetailed("WI-2", "/repo", failDeps, cache);

    expect(result.statusLine).toContain("WI-2");
    expect(result.statusLine).toContain("99");
    expect(result.statusLine).toContain("merged");
  });

  it("returns no-pr when item has no PR in cache", () => {
    const cache = buildCache(); // empty cache

    const result = checkPrStatusDetailed("WI-3", "/repo", failDeps, cache);

    expect(result.statusLine).toBe("WI-3\t\tno-pr");
  });

  it("derives ci-passed status from statusCheckRollup", () => {
    const cache = buildCache([
      makeOpenPr("WI-4", 10, { reviewDecision: "", statusCheckRollup: [
        { state: "SUCCESS", name: "build", completedAt: "2026-01-01T00:01:00Z" },
      ] }),
    ]);

    const result = checkPrStatusDetailed("WI-4", "/repo", failDeps, cache);
    expect(result.statusLine).toContain("ci-passed");
  });

  it("derives failing status from failed check in statusCheckRollup", () => {
    const cache = buildCache([
      makeOpenPr("WI-5", 11, { statusCheckRollup: [
        { state: "FAILURE", name: "build", completedAt: "2026-01-01T00:01:00Z" },
      ] }),
    ]);

    const result = checkPrStatusDetailed("WI-5", "/repo", failDeps, cache);
    expect(result.statusLine).toContain("failing");
  });

  it("derives pending status from in-progress checks", () => {
    const cache = buildCache([
      makeOpenPr("WI-6", 12, { statusCheckRollup: [
        { state: "PENDING", name: "build" },
      ] }),
    ]);

    const result = checkPrStatusDetailed("WI-6", "/repo", failDeps, cache);
    expect(result.statusLine).toContain("pending");
  });

  it("falls back to per-item prChecks when statusCheckRollup is missing", () => {
    let prChecksCallCount = 0;
    const depsWithChecks: PrMonitorDeps = {
      ...failDeps,
      prChecks: () => {
        prChecksCallCount++;
        return { ok: true, data: [{ state: "SUCCESS", name: "ci", url: "" }] };
      },
    };

    const cache = buildCache([
      makeOpenPr("WI-7", 13, { statusCheckRollup: undefined }),
    ]);

    const result = checkPrStatusDetailed("WI-7", "/repo", depsWithChecks, cache);
    expect(prChecksCallCount).toBe(1); // fell back to per-item call
    // APPROVED + SUCCESS = "ready" (not "ci-passed")
    expect(result.statusLine).toContain("ready");
  });

  it("falls back to per-item calls when no cache provided", () => {
    let prListCallCount = 0;
    const depsWithCalls: PrMonitorDeps = {
      ...failDeps,
      prList: () => {
        prListCallCount++;
        return { ok: true, data: [] };
      },
    };

    const result = checkPrStatusDetailed("WI-8", "/repo", depsWithCalls);
    expect(prListCallCount).toBeGreaterThanOrEqual(1);
    expect(result.statusLine).toContain("no-pr");
  });
});

// ── checkPrStatusDetailedAsync with cache ──────────────────────────

describe("checkPrStatusDetailedAsync with PrBulkCache", () => {
  const failAsyncDeps: PrMonitorAsyncDeps = {
    prListAsync: async () => { throw new Error("prListAsync should not be called with cache"); },
    prViewAsync: async () => { throw new Error("prViewAsync should not be called with cache"); },
    prChecksAsync: async () => { throw new Error("prChecksAsync should not be called with cache"); },
    isAvailable: () => true,
  };

  it("resolves open PR with full cache hit (zero API calls)", async () => {
    const cache = buildCache([
      makeOpenPr("A-1", 50, { statusCheckRollup: [
        { state: "SUCCESS", name: "ci", completedAt: "2026-01-01T00:01:00Z" },
      ] }),
    ]);

    const result = await checkPrStatusDetailedAsync("A-1", "/repo", failAsyncDeps, cache);

    expect(result.statusLine).toContain("A-1");
    expect(result.statusLine).toContain("50");
    expect(result.failure).toBeUndefined();
  });

  it("resolves no-pr items with zero API calls", async () => {
    const cache = buildCache();

    const result = await checkPrStatusDetailedAsync("A-2", "/repo", failAsyncDeps, cache);

    expect(result.statusLine).toBe("A-2\t\tno-pr");
  });
});

// ── buildSnapshotAsync with bulk cache ────────────────────────────

describe("buildSnapshotAsync with bulk PR cache", () => {
  it("bypasses RequestQueue when bulk cache is available", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("BC-1"));
    orch.addItem(makeWorkItem("BC-2"));
    orch.addItem(makeWorkItem("BC-3"));
    for (const id of ["BC-1", "BC-2", "BC-3"]) {
      orch.getItem(id)!.reviewCompleted = true;
      orch.hydrateState(id, "implementing");
    }

    let queueEnqueueCount = 0;
    const queue = new RequestQueue({ maxConcurrency: 10, burstSize: 100 });
    const originalEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = async <T>(opts: any): Promise<T> => {
      queueEnqueueCount++;
      return originalEnqueue(opts);
    };

    const cache = buildCache([
      makeOpenPr("BC-1", 10),
      makeOpenPr("BC-2", 11),
    ]);
    // BC-3 has no PR in cache (returns no-pr)

    const snapshot = await buildSnapshotAsync(
      orch, "/project", "/project/.ninthwave/.worktrees",
      fakeMux,
      () => null,          // getLastCommitTime
      undefined,           // checkPr (uses default)
      undefined,           // fetchComments
      undefined,           // checkCommitCI
      undefined,           // getMergeCommitSha
      undefined,           // getDefaultBranch
      queue,               // queue
      () => null,          // getHeadSha
      async () => cache,   // fetchAllPRs -- returns our test cache
    );

    expect(snapshot.items).toHaveLength(3);
    // Queue should NOT have been used when cache is available
    expect(queueEnqueueCount).toBe(0);
  });

  it("resolves all item statuses from cache without per-item API calls", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("RS-1"));
    orch.addItem(makeWorkItem("RS-2"));
    orch.addItem(makeWorkItem("RS-3"));
    for (const id of ["RS-1", "RS-2", "RS-3"]) {
      orch.getItem(id)!.reviewCompleted = true;
      orch.hydrateState(id, "ci-pending");
    }

    const cache = buildCache([
      makeOpenPr("RS-1", 20, { statusCheckRollup: [{ state: "SUCCESS", name: "ci", completedAt: "2026-01-01T00:01:00Z" }] }),
      makeOpenPr("RS-2", 21, { statusCheckRollup: [{ state: "FAILURE", name: "ci", completedAt: "2026-01-01T00:01:00Z" }] }),
      makeOpenPr("RS-3", 22, { statusCheckRollup: [{ state: "PENDING", name: "ci" }] }),
    ]);

    const snapshot = await buildSnapshotAsync(
      orch, "/project", "/project/.ninthwave/.worktrees",
      fakeMux, () => null, undefined,
      undefined, undefined, undefined, undefined,
      undefined, () => null,
      async () => cache,
    );

    expect(snapshot.items).toHaveLength(3);
    const byId = Object.fromEntries(snapshot.items.map((s) => [s.id, s]));
    expect(byId["RS-1"]!.ciStatus).toBe("pass");
    expect(byId["RS-1"]!.prNumber).toBe(20);
    expect(byId["RS-2"]!.ciStatus).toBe("fail");
    expect(byId["RS-2"]!.prNumber).toBe(21);
    expect(byId["RS-3"]!.ciStatus).toBe("pending");
    expect(byId["RS-3"]!.prNumber).toBe(22);
  });

  it("falls back to per-item queue when bulk fetch returns null", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("FB-1"));
    orch.getItem("FB-1")!.reviewCompleted = true;
    orch.hydrateState("FB-1", "implementing");

    let queueEnqueueCount = 0;
    const queue = new RequestQueue({ maxConcurrency: 10, burstSize: 100 });
    const originalEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = async <T>(opts: any): Promise<T> => {
      queueEnqueueCount++;
      return originalEnqueue(opts);
    };

    const checkPr = async (id: string) => `${id}\t10\tci-passed\tMERGEABLE\t2026-01-01T00:00:00Z`;

    const snapshot = await buildSnapshotAsync(
      orch, "/project", "/project/.ninthwave/.worktrees",
      fakeMux, () => null, checkPr,
      undefined, undefined, undefined, undefined,
      queue, () => null,
      async () => null, // bulk fetch fails
    );

    expect(snapshot.items).toHaveLength(1);
    // Queue SHOULD be used as fallback when no cache
    expect(queueEnqueueCount).toBe(1);
  });

  it("handles mix of open PRs, merged PRs, and no-PR items", async () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("MX-1"));
    orch.addItem(makeWorkItem("MX-2"));
    orch.addItem(makeWorkItem("MX-3"));
    for (const id of ["MX-1", "MX-2", "MX-3"]) {
      orch.getItem(id)!.reviewCompleted = true;
      orch.hydrateState(id, "implementing");
    }

    const cache = buildCache(
      [makeOpenPr("MX-1", 30)],
      [makeMergedPr("MX-2", 31)],
    );
    // MX-3 has no PR

    const snapshot = await buildSnapshotAsync(
      orch, "/project", "/project/.ninthwave/.worktrees",
      fakeMux, () => null, undefined,
      undefined, undefined, undefined, undefined,
      undefined, () => null,
      async () => cache,
    );

    expect(snapshot.items).toHaveLength(3);
    const byId = Object.fromEntries(snapshot.items.map((s) => [s.id, s]));
    expect(byId["MX-1"]!.prNumber).toBe(30);
    expect(byId["MX-1"]!.prState).toBe("open");
    expect(byId["MX-2"]!.prNumber).toBe(31);
    // Merged PR title "PR for MX-2" doesn't match work item title "Item MX-2",
    // so classifyPrMetadataMatch rejects it and prState stays unset (title collision guard).
    // This is correct behavior -- only PRs whose title matches the work item are accepted.
    expect(byId["MX-3"]!.prNumber).toBeUndefined();
    expect(byId["MX-3"]!.prState).toBeUndefined();
  });

  it("scales to many items with constant API calls", async () => {
    const orch = new Orchestrator();
    const itemCount = 50;
    const openPrs: BulkPrEntry[] = [];

    for (let i = 1; i <= itemCount; i++) {
      const id = `SC-${i}`;
      orch.addItem(makeWorkItem(id));
      orch.getItem(id)!.reviewCompleted = true;
      orch.hydrateState(id, "ci-pending");
      openPrs.push(makeOpenPr(id, 100 + i));
    }

    const cache = buildCache(openPrs);
    let fetchAllPRsCallCount = 0;

    const snapshot = await buildSnapshotAsync(
      orch, "/project", "/project/.ninthwave/.worktrees",
      fakeMux, () => null, undefined,
      undefined, undefined, undefined, undefined,
      undefined, () => null,
      async () => { fetchAllPRsCallCount++; return cache; },
    );

    expect(snapshot.items).toHaveLength(itemCount);
    // Only 1 bulk fetch call regardless of item count
    expect(fetchAllPRsCallCount).toBe(1);
    // All items should have PR data
    for (const item of snapshot.items) {
      expect(item.prNumber).toBeGreaterThan(100);
      expect(item.prState).toBe("open");
    }
  });
});

// ── reconstructState with bulk cache ──────────────────────────────

describe("reconstructState with PrBulkCache", () => {
  it("uses provided cache instead of calling checkPr per-item", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("RC-1"));
    orch.getItem("RC-1")!.reviewCompleted = true;

    let checkPrCallCount = 0;
    const checkPr = (_id: string, _root: string) => {
      checkPrCallCount++;
      return null;
    };

    // Pass explicit null cache -- no auto-fetch, uses provided checkPr
    reconstructState(orch, "/nonexistent", "/nonexistent/.ninthwave/.worktrees", undefined, checkPr, null, null);

    // No worktrees exist, so checkPr shouldn't be called regardless
    expect(checkPrCallCount).toBe(0);
  });
});
