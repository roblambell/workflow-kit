// Tests for external PR review: scanExternalPRs, ExternalReviewItem persistence,
// and processExternalReviews orchestration.
// No vi.mock -- uses dependency injection to stay bun-test compatible.

import { describe, it, expect, vi } from "vitest";
import { scanExternalPRs, type ExternalPR, type ScanExternalPRsDeps } from "../core/commands/pr-monitor.ts";
import {
  readExternalReviews,
  writeExternalReviews,
  externalReviewsPath,
  type ExternalReviewItem,
  type DaemonIO,
} from "../core/daemon.ts";
import {
  processExternalReviews,
  type ExternalReviewDeps,
  type LogEntry,
} from "../core/commands/orchestrate.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeExternalPR(overrides: Partial<ExternalPR> = {}): ExternalPR {
  return {
    prNumber: 42,
    headBranch: "feature/add-login",
    author: "alice",
    isDraft: false,
    headSha: "abc123",
    authorAssociation: "MEMBER",
    labels: [],
    ...overrides,
  };
}

function makeReviewItem(overrides: Partial<ExternalReviewItem> = {}): ExternalReviewItem {
  return {
    prNumber: 42,
    headBranch: "feature/add-login",
    author: "alice",
    state: "detected",
    lastTransition: "2026-03-25T00:00:00.000Z",
    ...overrides,
  };
}

function mockScanDeps(prs: Array<Record<string, unknown>>): import("../core/commands/pr-monitor.ts").ScanExternalPRsDeps {
  return {
    ghRunner: (_root, _args) => ({
      exitCode: 0,
      stdout: JSON.stringify(prs),
    }),
    isAvailable: () => true,
    getOwnerRepo: () => "owner/repo",
  };
}

function makeDaemonIO(store: Map<string, string> = new Map()): DaemonIO {
  return {
    writeFileSync: (path, data) => store.set(String(path), String(data)),
    readFileSync: (path) => {
      const content = store.get(String(path));
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content as any;
    },
    unlinkSync: (path) => store.delete(String(path)),
    existsSync: (path) => store.has(String(path)),
    mkdirSync: () => {},
    renameSync: (from, to) => {
      const content = store.get(String(from));
      if (content !== undefined) {
        store.set(String(to), content);
        store.delete(String(from));
      }
    },
  };
}

function makeExternalReviewDeps(
  externalPRs: ExternalPR[],
  overrides: Partial<ExternalReviewDeps> = {},
): { deps: ExternalReviewDeps; logs: LogEntry[]; launched: number[] } {
  const logs: LogEntry[] = [];
  const launched: number[] = [];
  const deps: ExternalReviewDeps = {
    scanExternalPRs: () => externalPRs,
    launchReview: (prNumber) => {
      launched.push(prNumber);
      return { workspaceRef: `workspace:ext-${prNumber}` };
    },
    cleanReview: () => true,
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs, launched };
}

// ── scanExternalPRs ──────────────────────────────────────────────────

describe("scanExternalPRs", () => {
  it("filters out ninthwave/* branches", () => {
    const deps = mockScanDeps([
      { number: 1, head: { ref: "ninthwave/H-1-1", sha: "aaa" }, user: { login: "bot" }, draft: false, author_association: "MEMBER", labels: [] },
      { number: 2, head: { ref: "feature/login", sha: "bbb" }, user: { login: "alice" }, draft: false, author_association: "MEMBER", labels: [] },
      { number: 3, head: { ref: "ninthwave/M-2-1", sha: "ccc" }, user: { login: "bot" }, draft: false, author_association: "MEMBER", labels: [] },
      { number: 4, head: { ref: "fix/bug-42", sha: "ddd" }, user: { login: "bob" }, draft: false, author_association: "COLLABORATOR", labels: [] },
    ]);

    const result = scanExternalPRs("/tmp/repo", deps);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.prNumber)).toEqual([2, 4]);
    expect(result[0]!.headBranch).toBe("feature/login");
    expect(result[1]!.headBranch).toBe("fix/bug-42");
  });

  it("maps all fields correctly", () => {
    const deps = mockScanDeps([
      {
        number: 10,
        head: { ref: "feature/x", sha: "sha123" },
        user: { login: "alice" },
        draft: true,
        author_association: "OWNER",
        labels: [{ name: "bug" }, { name: "urgent" }],
      },
    ]);

    const result = scanExternalPRs("/tmp/repo", deps);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      prNumber: 10,
      headBranch: "feature/x",
      author: "alice",
      isDraft: true,
      headSha: "sha123",
      authorAssociation: "OWNER",
      labels: ["bug", "urgent"],
    });
  });

  it("returns empty array on gh failure", () => {
    const deps = mockScanDeps([]);
    deps.ghRunner = () => ({ exitCode: 1, stdout: "" });
    const result = scanExternalPRs("/tmp/repo", deps);
    expect(result).toEqual([]);
  });

  it("returns empty array on invalid JSON", () => {
    const deps = mockScanDeps([]);
    deps.ghRunner = () => ({ exitCode: 0, stdout: "not json" });
    const result = scanExternalPRs("/tmp/repo", deps);
    expect(result).toEqual([]);
  });

  it("returns empty array when no PRs exist", () => {
    const deps = mockScanDeps([]);
    const result = scanExternalPRs("/tmp/repo", deps);
    expect(result).toEqual([]);
  });

  it("filters out all PRs when all are ninthwave/*", () => {
    const deps = mockScanDeps([
      { number: 1, head: { ref: "ninthwave/A-1-1", sha: "a" }, user: { login: "bot" }, draft: false, author_association: "MEMBER", labels: [] },
      { number: 2, head: { ref: "ninthwave/B-2-1", sha: "b" }, user: { login: "bot" }, draft: false, author_association: "MEMBER", labels: [] },
    ]);

    const result = scanExternalPRs("/tmp/repo", deps);
    expect(result).toEqual([]);
  });

  it("returns empty array when gh is not available", () => {
    const deps = mockScanDeps([
      { number: 1, head: { ref: "feature/x", sha: "a" }, user: { login: "alice" }, draft: false, author_association: "MEMBER", labels: [] },
    ]);
    deps.isAvailable = () => false;
    const result = scanExternalPRs("/tmp/repo", deps);
    expect(result).toEqual([]);
  });
});

// ── ExternalReviewItem persistence ──────────────────────────────────

describe("ExternalReviewItem persistence", () => {
  it("writes and reads external reviews", () => {
    const store = new Map<string, string>();
    const io = makeDaemonIO(store);

    const items: ExternalReviewItem[] = [
      makeReviewItem({ prNumber: 1, state: "detected" }),
      makeReviewItem({ prNumber: 2, state: "reviewing", reviewWorkspaceRef: "ws:1" }),
    ];

    writeExternalReviews("/tmp/proj", items, io);
    const loaded = readExternalReviews("/tmp/proj", io);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.prNumber).toBe(1);
    expect(loaded[0]!.state).toBe("detected");
    expect(loaded[1]!.prNumber).toBe(2);
    expect(loaded[1]!.state).toBe("reviewing");
    expect(loaded[1]!.reviewWorkspaceRef).toBe("ws:1");
  });

  it("returns empty array when file does not exist", () => {
    const io = makeDaemonIO();
    const loaded = readExternalReviews("/tmp/proj", io);
    expect(loaded).toEqual([]);
  });

  it("returns empty array on corrupted JSON", () => {
    const store = new Map<string, string>();
    const io = makeDaemonIO(store);
    store.set(externalReviewsPath("/tmp/proj"), "not valid json");

    const loaded = readExternalReviews("/tmp/proj", io);
    expect(loaded).toEqual([]);
  });

  it("survives restart by reading persisted state", () => {
    const store = new Map<string, string>();
    const io = makeDaemonIO(store);

    const items: ExternalReviewItem[] = [
      makeReviewItem({
        prNumber: 99,
        state: "reviewed",
        lastReviewedCommit: "abc123",
        reviewWorkspaceRef: "ws:5",
      }),
    ];

    writeExternalReviews("/tmp/proj", items, io);

    // Simulate restart -- read from same store
    const restored = readExternalReviews("/tmp/proj", io);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.prNumber).toBe(99);
    expect(restored[0]!.state).toBe("reviewed");
    expect(restored[0]!.lastReviewedCommit).toBe("abc123");
  });
});

// ── processExternalReviews ──────────────────────────────────────────

describe("processExternalReviews", () => {
  it("detects new external PRs and launches reviews", () => {
    const prs = [makeExternalPR({ prNumber: 10, headSha: "sha1" })];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", [], 2, deps);

    expect(result).toHaveLength(1);
    expect(result[0]!.prNumber).toBe(10);
    expect(result[0]!.state).toBe("reviewing");
    expect(result[0]!.reviewWorkspaceRef).toBe("workspace:ext-10");
    expect(launched).toEqual([10]);
  });

  it("skips draft PRs", () => {
    const prs = [makeExternalPR({ prNumber: 10, isDraft: true })];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", [], 2, deps);

    // Draft PR is filtered out -- not tracked at all
    expect(result).toHaveLength(0);
    expect(launched).toEqual([]);
  });

  it("skips PRs with ninthwave: skip-review label", () => {
    const prs = [makeExternalPR({ prNumber: 10, labels: ["ninthwave: skip-review"] })];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", [], 2, deps);

    expect(result).toHaveLength(0);
    expect(launched).toEqual([]);
  });

  it("skips PRs from non-write-access contributors", () => {
    const prs = [
      makeExternalPR({ prNumber: 10, authorAssociation: "NONE" }),
      makeExternalPR({ prNumber: 11, authorAssociation: "CONTRIBUTOR" }),
      makeExternalPR({ prNumber: 12, authorAssociation: "FIRST_TIME_CONTRIBUTOR" }),
    ];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", [], 5, deps);

    expect(result).toHaveLength(0);
    expect(launched).toEqual([]);
  });

  it("allows OWNER, MEMBER, and COLLABORATOR", () => {
    const prs = [
      makeExternalPR({ prNumber: 10, authorAssociation: "OWNER" }),
      makeExternalPR({ prNumber: 11, authorAssociation: "MEMBER" }),
      makeExternalPR({ prNumber: 12, authorAssociation: "COLLABORATOR" }),
    ];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", [], 5, deps);

    expect(result).toHaveLength(3);
    expect(launched).toEqual([10, 11, 12]);
  });

  it("does not re-review already-reviewed PRs with same HEAD commit", () => {
    const prs = [makeExternalPR({ prNumber: 10, headSha: "abc123" })];
    const existing = [
      makeReviewItem({
        prNumber: 10,
        state: "reviewed",
        lastReviewedCommit: "abc123",
      }),
    ];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", existing, 2, deps);

    // Still tracked, but not re-launched
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("reviewed");
    expect(launched).toEqual([]);
  });

  it("triggers re-review when HEAD commit changes", () => {
    const prs = [makeExternalPR({ prNumber: 10, headSha: "new-sha" })];
    const existing = [
      makeReviewItem({
        prNumber: 10,
        state: "reviewed",
        lastReviewedCommit: "old-sha",
      }),
    ];
    const { deps, launched, logs } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", existing, 2, deps);

    // Re-detected and relaunched
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("reviewing");
    expect(launched).toEqual([10]);

    // Log event for HEAD change
    const headChangedLog = logs.find((l) => l.event === "external_review_head_changed");
    expect(headChangedLog).toBeDefined();
    expect(headChangedLog!.prNumber).toBe(10);
  });

  it("respects unified WIP limit (1 internal reviewing reduces available slots)", () => {
    const prs = [
      makeExternalPR({ prNumber: 10, headSha: "a" }),
      makeExternalPR({ prNumber: 11, headSha: "b" }),
      makeExternalPR({ prNumber: 12, headSha: "c" }),
    ];
    const { deps, launched } = makeExternalReviewDeps(prs);

    // availableWipSlots=1 (1 slot left after internal reviewing item occupies one)
    // → only 1 slot available for external reviews
    const result = processExternalReviews("/tmp/repo", [], 1, deps);

    expect(launched).toHaveLength(1);
    expect(launched).toEqual([10]);
    expect(result.filter((r) => r.state === "reviewing")).toHaveLength(1);
    expect(result.filter((r) => r.state === "detected")).toHaveLength(2);
  });

  it("respects unified WIP limit when external reviews are already in progress", () => {
    const prs = [
      makeExternalPR({ prNumber: 10, headSha: "a" }),
      makeExternalPR({ prNumber: 11, headSha: "b" }),
    ];
    const existing = [
      makeReviewItem({
        prNumber: 10,
        state: "reviewing",
        reviewWorkspaceRef: "ws:1",
      }),
    ];
    const { deps, launched } = makeExternalReviewDeps(prs);

    // availableWipSlots=2, but 1 external review already reviewing → 1 slot left
    const result = processExternalReviews("/tmp/repo", existing, 2, deps);

    // PR 10 already reviewing, PR 11 is new and should launch
    expect(launched).toEqual([11]);
  });

  it("cleans up reviews for closed/merged PRs", () => {
    // No open PRs returned by scan
    const prs: ExternalPR[] = [];
    const existing = [
      makeReviewItem({
        prNumber: 10,
        state: "reviewing",
        reviewWorkspaceRef: "ws:1",
      }),
      makeReviewItem({
        prNumber: 11,
        state: "reviewed",
        lastReviewedCommit: "abc",
      }),
    ];
    const cleaned: string[] = [];
    const { deps, logs } = makeExternalReviewDeps(prs, {
      cleanReview: (ref) => {
        cleaned.push(ref);
        return true;
      },
    });

    const result = processExternalReviews("/tmp/repo", existing, 2, deps);

    // Both items removed since their PRs are no longer open
    expect(result).toHaveLength(0);
    // Only the reviewing one had a workspace to clean
    expect(cleaned).toEqual(["ws:1"]);
    // Logs should show cleanup
    const cleanLogs = logs.filter((l) => l.event === "external_review_cleaned");
    expect(cleanLogs).toHaveLength(2);
  });

  it("handles launch failure gracefully", () => {
    const prs = [makeExternalPR({ prNumber: 10 })];
    const { deps, logs } = makeExternalReviewDeps(prs, {
      launchReview: () => null, // launch fails
    });

    const result = processExternalReviews("/tmp/repo", [], 2, deps);

    // Item stays in detected state
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("detected");
  });

  it("does not re-detect already-tracked PRs in non-reviewed state", () => {
    const prs = [makeExternalPR({ prNumber: 10, headSha: "abc" })];
    const existing = [
      makeReviewItem({
        prNumber: 10,
        state: "reviewing",
        reviewWorkspaceRef: "ws:1",
        lastReviewedCommit: "abc",
      }),
    ];
    const { deps, launched } = makeExternalReviewDeps(prs);

    const result = processExternalReviews("/tmp/repo", existing, 2, deps);

    // Should not re-launch -- already reviewing
    expect(launched).toEqual([]);
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("reviewing");
  });
});
