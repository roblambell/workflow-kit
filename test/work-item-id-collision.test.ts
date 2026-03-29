// Tests for item ID collision detection (H-MID-1).
// Verifies that reusing an item ID that matches an old merged PR does NOT
// result in the new item being auto-completed, and that reconcile does not
// delete work item files whose titles don't match the merged PR.

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeTitleForComparison,
  prTitleMatchesWorkItem,
} from "../core/work-item-files.ts";
import { reconcile, type ReconcileDeps } from "../core/commands/reconcile.ts";
import { captureOutput } from "./helpers.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ItemSnapshot,
} from "../core/orchestrator.ts";
import { reconstructState, buildSnapshot } from "../core/commands/orchestrate.ts";
import type { WorkItem } from "../core/types.ts";

// ── Test helpers ──────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `nw-test-collision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

function makeWorkItem(id: string, title: string, deps: string[] = []): WorkItem {
  return {
    id,
    priority: "high",
    title,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: `# ${title} (${id})\n\n**Priority:** High\n**Domain:** test\n`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function setupWorkItemsDir(files: Record<string, string>): {
  workDir: string;
  worktreeDir: string;
  projectRoot: string;
} {
  const dir = makeTmpDir();
  const workDir = join(dir, ".ninthwave", "work");
  const worktreeDir = join(dir, ".worktrees");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(workDir, name), content);
  }
  return { workDir, worktreeDir, projectRoot: dir };
}


function makeDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    pullRebase: () => ({ ok: true, conflict: false }),
    getMergedTodoIds: () => [],
    getOpenItemIds: (workDir: string) => {
      if (!existsSync(workDir)) return [];
      try {
        const entries = readdirSync(workDir).filter((f) => f.endsWith(".md"));
        const ids: string[] = [];
        for (const entry of entries) {
          const match = entry.match(/--([A-Z]-[A-Za-z0-9]+-[0-9]+)\.md$/);
          if (match) ids.push(match[1]!);
        }
        return ids;
      } catch {
        return [];
      }
    },
    markDone: () => {},
    getWorktreeIds: () => [],
    cleanWorktree: () => false,
    closeStaleWorkspaces: () => 0,
    commitAndPush: () => false,
    worktreeHasCommits: () => true,
    branchHasOpenPR: () => false,
    ...overrides,
  };
}

// ── Title comparison tests ───────────────────────────────────────────

describe("normalizeTitleForComparison", () => {
  it("strips conventional commit prefixes", () => {
    expect(normalizeTitleForComparison("fix: handle null case")).toBe(
      "handle null case",
    );
    expect(normalizeTitleForComparison("feat(core): new feature")).toBe(
      "new feature",
    );
    expect(normalizeTitleForComparison("refactor: clean up code")).toBe(
      "clean up code",
    );
  });

  it("strips item ID references", () => {
    expect(normalizeTitleForComparison("fix: handle null (H-MUX-1)")).toBe(
      "handle null",
    );
    expect(
      normalizeTitleForComparison("feat: new feature (H-MUX-1)"),
    ).toBe("new feature");
  });

  it("lowercases and collapses whitespace", () => {
    expect(normalizeTitleForComparison("  Handle  NULL  Case  ")).toBe(
      "handle null case",
    );
  });

  it("handles empty strings", () => {
    expect(normalizeTitleForComparison("")).toBe("");
  });
});

describe("prTitleMatchesWorkItem", () => {
  it("matches identical titles", () => {
    expect(prTitleMatchesWorkItem("extract Multiplexer interface", "extract Multiplexer interface")).toBe(true);
  });

  it("matches after stripping commit prefix and ID", () => {
    expect(
      prTitleMatchesWorkItem(
        "refactor: extract Multiplexer interface (H-MUX-1)",
        "extract Multiplexer interface",
      ),
    ).toBe(true);
  });

  it("rejects different titles", () => {
    expect(
      prTitleMatchesWorkItem("extract Multiplexer interface", "fail fast when mux unavailable"),
    ).toBe(false);
  });

  it("rejects substring matches (not exact)", () => {
    // PR title is a substring of item title -- should be treated as mismatch
    expect(
      prTitleMatchesWorkItem("old work", "old work extended"),
    ).toBe(false);
  });

  it("rejects when item title is a substring of PR title", () => {
    expect(
      prTitleMatchesWorkItem("old work extended", "old work"),
    ).toBe(false);
  });

  it("returns false for empty titles", () => {
    expect(prTitleMatchesWorkItem("", "some title")).toBe(false);
    expect(prTitleMatchesWorkItem("some title", "")).toBe(false);
    expect(prTitleMatchesWorkItem("", "")).toBe(false);
  });
});

// ── Reconcile collision tests ────────────────────────────────────────

describe("reconcile: item ID collision safety", () => {
  it("does not delete work item file when merged PR title doesn't match", () => {
    // Setup: item FOO-1 with title "new work" and a merged PR titled "old work"
    const { workDir, worktreeDir, projectRoot } = setupWorkItemsDir({
      "2-test--H-FOO-1.md": `# New work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "fix: old work (H-FOO-1)" }],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    const output = captureOutput(() => reconcile(workDir, worktreeDir, projectRoot, deps));
    expect(markedIds).toEqual([]);
    expect(output).toContain("collision");
    expect(output).toContain("H-FOO-1");
  });

  it("deletes work item file when merged PR title matches", () => {
    const { workDir, worktreeDir, projectRoot } = setupWorkItemsDir({
      "2-test--H-FOO-1.md": `# Old work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "fix: old work (H-FOO-1)" }],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    reconcile(workDir, worktreeDir, projectRoot, deps);
    expect(markedIds).toEqual(["H-FOO-1"]);
  });

  it("handles mixed: some titles match, some don't", () => {
    const { workDir, worktreeDir, projectRoot } = setupWorkItemsDir({
      "2-test--H-FOO-1.md": `# New work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
      "2-test--H-BAR-1.md": `# Fix a bug (H-BAR-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [
        { id: "H-FOO-1", prTitle: "fix: old work (H-FOO-1)" }, // title mismatch
        { id: "H-BAR-1", prTitle: "fix: fix a bug (H-BAR-1)" }, // title match
      ],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    captureOutput(() => reconcile(workDir, worktreeDir, projectRoot, deps));
    expect(markedIds).toEqual(["H-BAR-1"]);
  });

  it("still marks done when merged PR has no title (fallback to legacy behavior)", () => {
    const { workDir, worktreeDir, projectRoot } = setupWorkItemsDir({
      "2-test--H-FOO-1.md": `# Some work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "" }],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    reconcile(workDir, worktreeDir, projectRoot, deps);
    // Empty PR title → skip title check → mark done (legacy behavior)
    expect(markedIds).toEqual(["H-FOO-1"]);
  });

  it("does not clean worktrees for collision-skipped items", () => {
    const { workDir, worktreeDir, projectRoot } = setupWorkItemsDir({
      "2-test--H-FOO-1.md": `# New work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    const cleanedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "fix: old work (H-FOO-1)" }],
      getWorktreeIds: () => ["H-FOO-1"],
      cleanWorktree: (id) => {
        cleanedIds.push(id);
        return true;
      },
    });

    captureOutput(() => reconcile(workDir, worktreeDir, projectRoot, deps));
    // Should NOT clean the worktree for H-FOO-1 since title didn't match
    expect(cleanedIds).not.toContain("H-FOO-1");
  });
});

// ── Orchestrator reconstructState collision tests ────────────────────

describe("reconstructState: item ID collision safety", () => {
  it("does not fast-track to merged when PR title doesn't match item title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "new work"));
    orch.getItem("H-FOO-1")!.reviewCompleted = true;

    const tmpDir = makeTmpDir();
    const wtDir = join(tmpDir, ".worktrees");
    mkdirSync(join(wtDir, "ninthwave-H-FOO-1"), { recursive: true });

    // Mock checkPr: returns "merged" with a title that doesn't match
    // Format: ID\tPR_NUMBER\tSTATUS\tMERGEABLE\tEVENT_TIME\tPR_TITLE
    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (H-FOO-1)";
      }
      return null;
    };

    reconstructState(orch, tmpDir, wtDir, undefined, mockCheckPr);

    const item = orch.getItem("H-FOO-1")!;
    // Should NOT be "merged" -- the title doesn't match
    expect(item.state).toBe("implementing");
  });

  it("fast-tracks to merged when PR title matches item title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "old work"));

    const tmpDir = makeTmpDir();
    const wtDir = join(tmpDir, ".worktrees");
    mkdirSync(join(wtDir, "ninthwave-H-FOO-1"), { recursive: true });

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (H-FOO-1)";
      }
      return null;
    };

    reconstructState(orch, tmpDir, wtDir, undefined, mockCheckPr);

    const item = orch.getItem("H-FOO-1")!;
    expect(item.state).toBe("merged");
    expect(item.prNumber).toBe(42);
  });

  it("falls back to merged when PR title is empty (no title data available)", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "some work"));

    const tmpDir = makeTmpDir();
    const wtDir = join(tmpDir, ".worktrees");
    mkdirSync(join(wtDir, "ninthwave-H-FOO-1"), { recursive: true });

    // Simulate old-format checkPr that doesn't include title (3 fields only)
    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged";
      }
      return null;
    };

    reconstructState(orch, tmpDir, wtDir, undefined, mockCheckPr);

    const item = orch.getItem("H-FOO-1")!;
    // No title to compare → fallback to merged (legacy behavior)
    expect(item.state).toBe("merged");
  });
});

// ── buildSnapshot collision tests ────────────────────────────────────

describe("buildSnapshot: item ID collision safety", () => {
  it("ignores stale merged PR when title does not match item (ID collision)", () => {
    // When an item ID is reused, the old merged PR still shows up for the same
    // branch name. buildSnapshot must compare titles and ignore the stale PR.
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "new work"));
    orch.setState("H-FOO-1", "implementing");

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (H-FOO-1)";
      }
      return null;
    };

    const noopMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    const snapshot = buildSnapshot(
      orch,
      "/tmp/test",
      "/tmp/test/.worktrees",
      noopMux,
      () => null,
      mockCheckPr,
    );

    const snap = snapshot.items.find((s) => s.id === "H-FOO-1");
    expect(snap).toBeDefined();
    // prState should be undefined -- title mismatch means this is a stale PR
    expect(snap!.prState).toBeUndefined();
  });

  it("reports merged when orchestrator already tracks the PR number (skips title check)", () => {
    // This is the key fix: when the orchestrator has already assigned prNumber to an item
    // (because it saw the PR created during this run), a title mismatch should NOT
    // prevent merge detection. The worker may use a different PR title than the item title.
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "update decompose skill output format"));
    orch.setState("H-FOO-1", "ci-passed");
    orch.getItem("H-FOO-1")!.reviewCompleted = true;
    // Simulate: orchestrator already tracked this PR during the run
    const item = orch.getItem("H-FOO-1")!;
    item.prNumber = 42;

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        // Worker used a completely different PR title -- should still detect merge
        return "H-FOO-1\t42\tmerged\t\t\trefactor: remove legacy reference (H-FOO-1)";
      }
      return null;
    };

    const noopMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    const snapshot = buildSnapshot(
      orch,
      "/tmp/test",
      "/tmp/test/.worktrees",
      noopMux,
      () => null,
      mockCheckPr,
    );

    const snap = snapshot.items.find((s) => s.id === "H-FOO-1");
    expect(snap).toBeDefined();
    // prState SHOULD be "merged" -- prNumber matches, title check skipped
    expect(snap!.prState).toBe("merged");
  });

  it("ignores stale merged PR when prNumber differs and title doesn't match", () => {
    // When the orchestrator tracks prNumber=99 but finds a merged PR #42 with a
    // different title, it should ignore it -- this is an old PR from a previous cycle.
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "new work"));
    orch.setState("H-FOO-1", "ci-passed");
    orch.getItem("H-FOO-1")!.reviewCompleted = true;
    const item = orch.getItem("H-FOO-1")!;
    item.prNumber = 99; // Different PR number -- not the one that merged

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (H-FOO-1)";
      }
      return null;
    };

    const noopMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    const snapshot = buildSnapshot(
      orch,
      "/tmp/test",
      "/tmp/test/.worktrees",
      noopMux,
      () => null,
      mockCheckPr,
    );

    const snap = snapshot.items.find((s) => s.id === "H-FOO-1");
    expect(snap).toBeDefined();
    // prState should be undefined -- title mismatch + different PR number
    expect(snap!.prState).toBeUndefined();
  });

  it("reports merged when PR title matches item title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeWorkItem("H-FOO-1", "old work"));
    orch.setState("H-FOO-1", "implementing");

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (H-FOO-1)";
      }
      return null;
    };

    const noopMux = {
      type: "cmux" as const,
      isAvailable: () => true,
      diagnoseUnavailable: () => "not available",
      launchWorkspace: () => null,
      splitPane: () => null,
      sendMessage: () => true,
      readScreen: () => "",
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };

    const snapshot = buildSnapshot(
      orch,
      "/tmp/test",
      "/tmp/test/.worktrees",
      noopMux,
      () => null,
      mockCheckPr,
    );

    const snap = snapshot.items.find((s) => s.id === "H-FOO-1");
    expect(snap).toBeDefined();
    expect(snap!.prState).toBe("merged");
  });
});
