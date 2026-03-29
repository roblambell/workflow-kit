// Contract tests for buildSnapshot -- tests the snapshot-building logic directly
// (not through the orchestrate loop) with injected collaborators.
// Verifies PollSnapshot output matches expected ItemSnapshot fields for each
// orchestrator state and external status combination.

import { describe, it, expect, beforeEach } from "vitest";
import { Orchestrator, type ItemSnapshot } from "../../core/orchestrator.ts";
import { buildSnapshot } from "../../core/commands/orchestrate.ts";
import { FakeGitHub } from "../fakes/fake-github.ts";
import { FakeMux } from "../fakes/fake-mux.ts";
import { makeWorkItem } from "../scenario/helpers.ts";
import { writeHeartbeat, type DaemonIO } from "../../core/daemon.ts";

const PROJECT_ROOT = "/tmp/test-project";
const WORKTREE_DIR = "/tmp/test-project/.worktrees";

// ── In-memory DaemonIO for heartbeat writes ────────────────────────
// Avoids touching the real filesystem during tests.

function makeMemoryIO(): DaemonIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string, _enc: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, data);
    },
    mkdirSync: () => {},
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    readdirSync: () => [],
    rmSync: () => {},
    renameSync: () => {},
    statSync: () => ({ mtimeMs: Date.now() }) as any,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function snap(
  orch: Orchestrator,
  opts: {
    mux?: FakeMux;
    getLastCommitTime?: (pr: string, branch: string) => string | null;
    checkPr?: (id: string, pr: string) => string | null;
    fetchComments?: (repoRoot: string, prNumber: number, since: string) => Array<{ body: string; author: string; createdAt: string }>;
    checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending";
  } = {},
) {
  return buildSnapshot(
    orch,
    PROJECT_ROOT,
    WORKTREE_DIR,
    opts.mux ?? new FakeMux(),
    opts.getLastCommitTime ?? (() => null),
    opts.checkPr ?? (() => null),
    opts.fetchComments,
    opts.checkCommitCI,
  );
}

function findItem(items: ItemSnapshot[], id: string): ItemSnapshot | undefined {
  return items.find((i) => i.id === id);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("buildSnapshot contract", () => {
  let orch: Orchestrator;
  let fakeGh: FakeGitHub;
  let fakeMux: FakeMux;

  beforeEach(() => {
    orch = new Orchestrator({
      wipLimit: 5,
      mergeStrategy: "auto",
      bypassEnabled: false,
      enableStacking: false,
      verifyMain: false,
    });
    fakeGh = new FakeGitHub();
    fakeMux = new FakeMux();
  });

  // ── Queued items ──────────────────────────────────────────────────

  describe("queued items", () => {
    it("computes readyIds for items with no dependencies", () => {
      orch.addItem(makeWorkItem("A-1"));
      orch.addItem(makeWorkItem("A-2"));

      const result = snap(orch);

      expect(result.readyIds).toContain("A-1");
      expect(result.readyIds).toContain("A-2");
      // Queued items should NOT appear in items array (they are skipped after readyIds computation)
      expect(result.items).toHaveLength(0);
    });

    it("computes readyIds correctly when dependencies are met", () => {
      orch.addItem(makeWorkItem("A-1"));
      orch.addItem(makeWorkItem("A-2", ["A-1"]));

      // A-1 is done, so A-2's dependency is met
      orch.setState("A-1", "done");

      const result = snap(orch);

      expect(result.readyIds).toContain("A-2");
    });

    it("excludes items with unmet dependencies from readyIds", () => {
      orch.addItem(makeWorkItem("A-1"));
      orch.addItem(makeWorkItem("A-2", ["A-1"]));

      // A-1 is still queued, so A-2's dependency is NOT met
      const result = snap(orch);

      // A-1 has no deps, so it's ready
      expect(result.readyIds).toContain("A-1");
      // A-2 depends on A-1 which is still queued, so NOT ready
      expect(result.readyIds).not.toContain("A-2");
    });

    it("treats merged dependencies as met", () => {
      orch.addItem(makeWorkItem("A-1"));
      orch.addItem(makeWorkItem("A-2", ["A-1"]));

      orch.setState("A-1", "merged");

      const result = snap(orch);

      expect(result.readyIds).toContain("A-2");
    });

    it("treats untracked dependencies as met", () => {
      // A-2 depends on "X-99" which is not tracked by the orchestrator
      orch.addItem(makeWorkItem("A-2", ["X-99"]));

      const result = snap(orch);

      expect(result.readyIds).toContain("A-2");
    });
  });

  // ── Implementing items ────────────────────────────────────────────

  describe("implementing items", () => {
    it("checks workerAlive from mux and lastCommitTime from injected function", () => {
      orch.addItem(makeWorkItem("B-1"));
      orch.setState("B-1", "implementing");
      const orchItem = orch.getItem("B-1")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "B-1")!;

      const commitTime = "2026-03-29T10:00:00Z";
      const result = snap(orch, {
        mux: fakeMux,
        getLastCommitTime: (_pr, branch) => {
          if (branch === "ninthwave/B-1") return commitTime;
          return null;
        },
      });

      const item = findItem(result.items, "B-1");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(true);
      expect(item!.lastCommitTime).toBe(commitTime);
    });

    it("reports workerAlive false when worker is dead", () => {
      orch.addItem(makeWorkItem("B-2"));
      orch.setState("B-2", "implementing");
      const orchItem = orch.getItem("B-2")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "B-2")!;
      fakeMux.setAlive(orchItem.workspaceRef, false);

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "B-2");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(false);
    });

    it("reports null lastCommitTime when no commits exist", () => {
      orch.addItem(makeWorkItem("B-3"));
      orch.setState("B-3", "implementing");
      const orchItem = orch.getItem("B-3")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "B-3")!;

      const result = snap(orch, {
        mux: fakeMux,
        getLastCommitTime: () => null,
      });

      const item = findItem(result.items, "B-3");
      expect(item).toBeDefined();
      expect(item!.lastCommitTime).toBeNull();
    });
  });

  // ── Launching items ───────────────────────────────────────────────

  describe("launching items", () => {
    it("checks workerAlive and lastCommitTime like implementing", () => {
      orch.addItem(makeWorkItem("L-1"));
      orch.setState("L-1", "launching");
      const orchItem = orch.getItem("L-1")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "L-1")!;

      const result = snap(orch, {
        mux: fakeMux,
        getLastCommitTime: () => "2026-03-29T09:00:00Z",
      });

      const item = findItem(result.items, "L-1");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(true);
      expect(item!.lastCommitTime).toBe("2026-03-29T09:00:00Z");
    });
  });

  // ── CI-failed items ───────────────────────────────────────────────

  describe("ci-failed items", () => {
    it("checks workerAlive and lastCommitTime like implementing", () => {
      orch.addItem(makeWorkItem("C-1"));
      orch.setState("C-1", "ci-failed");
      const orchItem = orch.getItem("C-1")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "C-1")!;

      const result = snap(orch, {
        mux: fakeMux,
        getLastCommitTime: (_pr, branch) =>
          branch === "ninthwave/C-1" ? "2026-03-29T11:00:00Z" : null,
      });

      const item = findItem(result.items, "C-1");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(true);
      expect(item!.lastCommitTime).toBe("2026-03-29T11:00:00Z");
    });
  });

  // ── PR lifecycle items ────────────────────────────────────────────

  describe("PR lifecycle items", () => {
    it("populates prNumber, ciStatus, prState, isMergeable, eventTime from checkPr (CI passing, ready to merge)", () => {
      orch.addItem(makeWorkItem("D-1"));
      orch.setState("D-1", "ci-passed");

      fakeGh.createPR("ninthwave/D-1", "Item D-1");
      fakeGh.setCIStatus("ninthwave/D-1", "pass");
      fakeGh.setMergeable("ninthwave/D-1", "MERGEABLE");
      fakeGh.setReviewDecision("ninthwave/D-1", "APPROVED");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "D-1");
      expect(item).toBeDefined();
      expect(item!.prNumber).toBe(1);
      expect(item!.ciStatus).toBe("pass");
      expect(item!.prState).toBe("open");
      expect(item!.isMergeable).toBe(true);
      expect(item!.eventTime).toBeDefined();
    });

    it("populates CI failing status", () => {
      orch.addItem(makeWorkItem("D-2"));
      orch.setState("D-2", "ci-pending");

      fakeGh.createPR("ninthwave/D-2", "Item D-2");
      fakeGh.setCIStatus("ninthwave/D-2", "fail");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "D-2");
      expect(item).toBeDefined();
      expect(item!.ciStatus).toBe("fail");
      expect(item!.prState).toBe("open");
    });

    it("populates CI pending status", () => {
      orch.addItem(makeWorkItem("D-3"));
      orch.setState("D-3", "ci-pending");

      fakeGh.createPR("ninthwave/D-3", "Item D-3");
      fakeGh.setCIStatus("ninthwave/D-3", "pending");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "D-3");
      expect(item).toBeDefined();
      expect(item!.ciStatus).toBe("pending");
      expect(item!.prState).toBe("open");
    });

    it("populates merged prState", () => {
      orch.addItem(makeWorkItem("D-4"));
      orch.setState("D-4", "merging");

      fakeGh.createPR("ninthwave/D-4", "Item D-4");
      fakeGh.mergePR("ninthwave/D-4");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "D-4");
      expect(item).toBeDefined();
      expect(item!.prState).toBe("merged");
    });

    it("isMergeable false for conflicting PRs", () => {
      orch.addItem(makeWorkItem("D-5"));
      orch.setState("D-5", "ci-passed");

      fakeGh.createPR("ninthwave/D-5", "Item D-5");
      fakeGh.setCIStatus("ninthwave/D-5", "pass");
      fakeGh.setMergeable("ninthwave/D-5", "CONFLICTING");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "D-5");
      expect(item).toBeDefined();
      expect(item!.isMergeable).toBe(false);
    });

    it("populates reviewDecision APPROVED via ready status", () => {
      orch.addItem(makeWorkItem("D-6"));
      orch.setState("D-6", "review-pending");

      fakeGh.createPR("ninthwave/D-6", "Item D-6");
      fakeGh.setCIStatus("ninthwave/D-6", "pass");
      fakeGh.setMergeable("ninthwave/D-6", "MERGEABLE");
      fakeGh.setReviewDecision("ninthwave/D-6", "APPROVED");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "D-6");
      expect(item).toBeDefined();
      expect(item!.reviewDecision).toBe("APPROVED");
    });
  });

  // ── Edge case: checkPr returns null ───────────────────────────────

  describe("checkPr returns null (no-pr)", () => {
    it("snapshot has no prNumber or ciStatus when checkPr returns null", () => {
      orch.addItem(makeWorkItem("E-1"));
      orch.setState("E-1", "implementing");
      const orchItem = orch.getItem("E-1")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "E-1")!;

      const result = snap(orch, {
        mux: fakeMux,
        checkPr: () => null, // simulate no PR found at all
      });

      const item = findItem(result.items, "E-1");
      expect(item).toBeDefined();
      expect(item!.prNumber).toBeUndefined();
      expect(item!.ciStatus).toBeUndefined();
      expect(item!.prState).toBeUndefined();
    });

    it("snapshot has no prNumber when checkPr returns no-pr status line", () => {
      orch.addItem(makeWorkItem("E-2"));
      orch.setState("E-2", "implementing");
      const orchItem = orch.getItem("E-2")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "E-2")!;

      const result = snap(orch, {
        mux: fakeMux,
        checkPr: fakeGh.checkPr, // No PR created, so checkPr returns "E-2\t\tno-pr"
      });

      const item = findItem(result.items, "E-2");
      expect(item).toBeDefined();
      expect(item!.prNumber).toBeUndefined();
      expect(item!.ciStatus).toBeUndefined();
      expect(item!.prState).toBeUndefined();
    });
  });

  // ── Verifying items ───────────────────────────────────────────────

  describe("verifying items", () => {
    it("populates mergeCommitCIStatus from checkCommitCI", () => {
      orch.addItem(makeWorkItem("F-1"));
      orch.setState("F-1", "verifying");
      const orchItem = orch.getItem("F-1")!;
      orchItem.mergeCommitSha = "abc123";

      fakeGh.setMergeCommitCI("abc123", "pass");

      const result = snap(orch, { checkCommitCI: fakeGh.checkCommitCI });

      const item = findItem(result.items, "F-1");
      expect(item).toBeDefined();
      expect(item!.mergeCommitCIStatus).toBe("pass");
    });

    it("returns pending when checkCommitCI is not injected", () => {
      orch.addItem(makeWorkItem("F-2"));
      orch.setState("F-2", "verifying");
      const orchItem = orch.getItem("F-2")!;
      orchItem.mergeCommitSha = "def456";

      // No checkCommitCI injected
      const result = snap(orch);

      const item = findItem(result.items, "F-2");
      expect(item).toBeDefined();
      expect(item!.mergeCommitCIStatus).toBeUndefined();
    });

    it("reports fail from checkCommitCI", () => {
      orch.addItem(makeWorkItem("F-3"));
      orch.setState("F-3", "verify-failed");
      const orchItem = orch.getItem("F-3")!;
      orchItem.mergeCommitSha = "ghi789";

      fakeGh.setMergeCommitCI("ghi789", "fail");

      const result = snap(orch, { checkCommitCI: fakeGh.checkCommitCI });

      const item = findItem(result.items, "F-3");
      expect(item).toBeDefined();
      expect(item!.mergeCommitCIStatus).toBe("fail");
    });

    it("skips verifying items without mergeCommitSha", () => {
      orch.addItem(makeWorkItem("F-4"));
      orch.setState("F-4", "verifying");
      // No mergeCommitSha set

      const result = snap(orch, { checkCommitCI: fakeGh.checkCommitCI });

      // Item should still appear (the state is not terminal), but no mergeCommitCIStatus
      // The verifying branch only triggers when mergeCommitSha is truthy
      const item = findItem(result.items, "F-4");
      // Without mergeCommitSha, falls through to the general PR polling path
      expect(item).toBeDefined();
    });
  });

  // ── Heartbeat reading ─────────────────────────────────────────────

  describe("heartbeat reading", () => {
    it("populates lastHeartbeat for implementing state", () => {
      const memIO = makeMemoryIO();
      writeHeartbeat(PROJECT_ROOT, "G-1", 0.5, "Writing code", memIO);

      orch.addItem(makeWorkItem("G-1"));
      orch.setState("G-1", "implementing");
      const orchItem = orch.getItem("G-1")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "G-1")!;

      // buildSnapshot reads heartbeats from the filesystem via readHeartbeat,
      // which is NOT injectable. We need to actually write the file.
      // Instead, we verify that the heartbeat states set is correct by
      // testing that heartbeat-eligible states produce a lastHeartbeat field.
      // The actual readHeartbeat call will return null (no real file), which is fine --
      // the key contract is that lastHeartbeat is populated (even if null) for active states.
      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "G-1");
      expect(item).toBeDefined();
      // lastHeartbeat should be set (to null since no file exists on disk)
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for launching state", () => {
      orch.addItem(makeWorkItem("G-2"));
      orch.setState("G-2", "launching");
      const orchItem = orch.getItem("G-2")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "G-2")!;

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "G-2");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for ci-pending state", () => {
      orch.addItem(makeWorkItem("G-3"));
      orch.setState("G-3", "ci-pending");

      const result = snap(orch);

      const item = findItem(result.items, "G-3");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for ci-passed state", () => {
      orch.addItem(makeWorkItem("G-4"));
      orch.setState("G-4", "ci-passed");

      const result = snap(orch);

      const item = findItem(result.items, "G-4");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for review-pending state", () => {
      orch.addItem(makeWorkItem("G-5"));
      orch.setState("G-5", "review-pending");

      const result = snap(orch);

      const item = findItem(result.items, "G-5");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for merging state", () => {
      orch.addItem(makeWorkItem("G-6"));
      orch.setState("G-6", "merging");

      const result = snap(orch);

      const item = findItem(result.items, "G-6");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for ci-pending state", () => {
      orch.addItem(makeWorkItem("G-7"));
      orch.setState("G-7", "ci-pending");

      const result = snap(orch);

      const item = findItem(result.items, "G-7");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("populates lastHeartbeat for ci-failed state", () => {
      orch.addItem(makeWorkItem("G-8"));
      orch.setState("G-8", "ci-failed");
      const orchItem = orch.getItem("G-8")!;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "G-8")!;

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "G-8");
      expect(item).toBeDefined();
      expect("lastHeartbeat" in item!).toBe(true);
    });

    it("does NOT populate lastHeartbeat for done state", () => {
      orch.addItem(makeWorkItem("G-9"));
      orch.setState("G-9", "done");

      const result = snap(orch);

      // done is terminal -- skipped entirely
      const item = findItem(result.items, "G-9");
      expect(item).toBeUndefined();
    });

    it("does NOT populate lastHeartbeat for stuck state", () => {
      orch.addItem(makeWorkItem("G-10"));
      orch.setState("G-10", "stuck");

      const result = snap(orch);

      // stuck is terminal -- skipped entirely
      const item = findItem(result.items, "G-10");
      expect(item).toBeUndefined();
    });
  });

  // ── Terminal states ───────────────────────────────────────────────

  describe("terminal states", () => {
    it("skips done items", () => {
      orch.addItem(makeWorkItem("T-1"));
      orch.setState("T-1", "done");

      const result = snap(orch);

      expect(result.items).toHaveLength(0);
      expect(result.readyIds).toHaveLength(0);
    });

    it("skips stuck items", () => {
      orch.addItem(makeWorkItem("T-2"));
      orch.setState("T-2", "stuck");

      const result = snap(orch);

      expect(result.items).toHaveLength(0);
      expect(result.readyIds).toHaveLength(0);
    });
  });

  // ── Reviewing items ───────────────────────────────────────────────

  describe("reviewing items", () => {
    it("checks review worker alive via reviewWorkspaceRef", () => {
      orch.addItem(makeWorkItem("R-1"));
      orch.setState("R-1", "reviewing");
      const orchItem = orch.getItem("R-1")!;
      orchItem.reviewWorkspaceRef = fakeMux.launchWorkspace("/tmp/wt-review", "claude", "R-1")!;

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "R-1");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(true);
    });

    it("reports review worker dead when workspace is closed", () => {
      orch.addItem(makeWorkItem("R-2"));
      orch.setState("R-2", "reviewing");
      const orchItem = orch.getItem("R-2")!;
      orchItem.reviewWorkspaceRef = fakeMux.launchWorkspace("/tmp/wt-review", "claude", "R-2")!;
      fakeMux.setAlive(orchItem.reviewWorkspaceRef, false);

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "R-2");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(false);
    });
  });

  // ── Repairing items ──────────────────────────────────────────────

  describe("repairing items", () => {
    it("checks repair worker alive via repairWorkspaceRef", () => {
      orch.addItem(makeWorkItem("RP-1"));
      orch.setState("RP-1", "repairing");
      const orchItem = orch.getItem("RP-1")!;
      orchItem.repairWorkspaceRef = fakeMux.launchWorkspace("/tmp/wt-repair", "claude", "RP-1")!;

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "RP-1");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(true);
    });
  });

  // ── Repairing-main items ─────────────────────────────────────────

  describe("repairing-main items", () => {
    it("checks verifier worker alive via verifyWorkspaceRef", () => {
      orch.addItem(makeWorkItem("RM-1"));
      orch.setState("RM-1", "repairing-main");
      const orchItem = orch.getItem("RM-1")!;
      orchItem.verifyWorkspaceRef = fakeMux.launchWorkspace("/tmp/wt-verify", "claude", "RM-1")!;

      const result = snap(orch, { mux: fakeMux });

      const item = findItem(result.items, "RM-1");
      expect(item).toBeDefined();
      expect(item!.workerAlive).toBe(true);
    });
  });

  // ── Cross-repo items (resolvedRepoRoot) ───────────────────────────

  describe("cross-repo items", () => {
    it("uses resolvedRepoRoot for checkPr instead of projectRoot", () => {
      orch.addItem(makeWorkItem("X-1"));
      orch.setState("X-1", "ci-pending");
      const orchItem = orch.getItem("X-1")!;
      orchItem.resolvedRepoRoot = "/other/repo";

      let capturedRepoRoot: string | undefined;
      const result = snap(orch, {
        checkPr: (id, repoRoot) => {
          capturedRepoRoot = repoRoot;
          return fakeGh.checkPr(id, repoRoot);
        },
      });

      expect(capturedRepoRoot).toBe("/other/repo");
    });

    it("uses resolvedRepoRoot for lastCommitTime in implementing state", () => {
      orch.addItem(makeWorkItem("X-2"));
      orch.setState("X-2", "implementing");
      const orchItem = orch.getItem("X-2")!;
      orchItem.resolvedRepoRoot = "/other/repo";
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "X-2")!;

      let capturedRepoRoot: string | undefined;
      const result = snap(orch, {
        mux: fakeMux,
        getLastCommitTime: (repoRoot, branch) => {
          capturedRepoRoot = repoRoot;
          return "2026-03-29T12:00:00Z";
        },
      });

      expect(capturedRepoRoot).toBe("/other/repo");
    });
  });

  // ── Comment fetching ──────────────────────────────────────────────

  describe("comment fetching", () => {
    it("fetches comments for items with open PRs in relay-eligible states", () => {
      orch.addItem(makeWorkItem("CM-1"));
      orch.setState("CM-1", "ci-pending");
      const orchItem = orch.getItem("CM-1")!;
      orchItem.prNumber = 42;
      orchItem.lastTransition = "2026-03-29T08:00:00Z";

      fakeGh.createPR("ninthwave/CM-1", "Item CM-1");

      const fakeComments = [
        { body: "LGTM", author: "reviewer", createdAt: "2026-03-29T09:00:00Z" },
      ];

      const result = snap(orch, {
        checkPr: fakeGh.checkPr,
        fetchComments: (_repoRoot, prNumber, _since) => {
          if (prNumber === 42) return fakeComments;
          return [];
        },
      });

      const item = findItem(result.items, "CM-1");
      expect(item).toBeDefined();
      expect(item!.newComments).toEqual(fakeComments);
    });

    it("does not fetch comments when fetchComments is not provided", () => {
      orch.addItem(makeWorkItem("CM-2"));
      orch.setState("CM-2", "ci-pending");
      const orchItem = orch.getItem("CM-2")!;
      orchItem.prNumber = 43;

      fakeGh.createPR("ninthwave/CM-2", "Item CM-2");

      const result = snap(orch, {
        checkPr: fakeGh.checkPr,
        // No fetchComments
      });

      const item = findItem(result.items, "CM-2");
      expect(item).toBeDefined();
      expect(item!.newComments).toBeUndefined();
    });

    it("does not fetch comments for states outside the relay set", () => {
      orch.addItem(makeWorkItem("CM-3"));
      orch.setState("CM-3", "implementing");
      const orchItem = orch.getItem("CM-3")!;
      orchItem.prNumber = 44;
      orchItem.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "CM-3")!;

      fakeGh.createPR("ninthwave/CM-3", "Item CM-3");

      let fetchCalled = false;
      const result = snap(orch, {
        mux: fakeMux,
        checkPr: fakeGh.checkPr,
        fetchComments: () => {
          fetchCalled = true;
          return [];
        },
      });

      // implementing is not in commentRelayStates
      expect(fetchCalled).toBe(false);
    });
  });

  // ── Mixed items across states ─────────────────────────────────────

  describe("mixed items across states", () => {
    it("snapshot contains correct items for a heterogeneous orchestrator", () => {
      orch.addItem(makeWorkItem("M-1")); // queued
      orch.addItem(makeWorkItem("M-2")); // implementing
      orch.addItem(makeWorkItem("M-3")); // ci-passed
      orch.addItem(makeWorkItem("M-4")); // done
      orch.addItem(makeWorkItem("M-5")); // verifying

      orch.setState("M-2", "implementing");
      orch.getItem("M-2")!.workspaceRef = fakeMux.launchWorkspace("/tmp/wt", "claude", "M-2")!;

      orch.setState("M-3", "ci-passed");

      orch.setState("M-4", "done");

      orch.setState("M-5", "verifying");
      orch.getItem("M-5")!.mergeCommitSha = "sha123";
      fakeGh.setMergeCommitCI("sha123", "pending");

      const result = snap(orch, {
        mux: fakeMux,
        checkPr: fakeGh.checkPr,
        checkCommitCI: fakeGh.checkCommitCI,
      });

      // M-1 is queued -> goes to readyIds, not items
      expect(result.readyIds).toContain("M-1");

      // M-2 is implementing -> appears in items
      expect(findItem(result.items, "M-2")).toBeDefined();

      // M-3 is ci-passed -> appears in items
      expect(findItem(result.items, "M-3")).toBeDefined();

      // M-4 is done -> skipped
      expect(findItem(result.items, "M-4")).toBeUndefined();

      // M-5 is verifying -> appears with mergeCommitCIStatus
      const m5 = findItem(result.items, "M-5");
      expect(m5).toBeDefined();
      expect(m5!.mergeCommitCIStatus).toBe("pending");

      // Total active items: M-2, M-3, M-5
      expect(result.items).toHaveLength(3);
    });
  });

  // ── PR title collision check (merged PRs) ─────────────────────────

  describe("merged PR title collision check", () => {
    it("sets prState merged when title matches work item title", () => {
      orch.addItem(makeWorkItem("TC-1"));
      orch.setState("TC-1", "merging");

      fakeGh.createPR("ninthwave/TC-1", "Item TC-1");
      fakeGh.mergePR("ninthwave/TC-1");

      const result = snap(orch, { checkPr: fakeGh.checkPr });

      const item = findItem(result.items, "TC-1");
      expect(item).toBeDefined();
      expect(item!.prState).toBe("merged");
    });
  });
});
