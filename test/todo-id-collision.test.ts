// Tests for TODO ID collision detection (H-MID-1).
// Verifies that reusing a TODO ID that matches an old merged PR does NOT
// result in the new TODO being auto-completed, and that reconcile does not
// delete TODO files whose titles don't match the merged PR.

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeTitleForComparison,
  prTitleMatchesTodo,
} from "../core/todo-utils.ts";
import { reconcile, type ReconcileDeps } from "../core/commands/reconcile.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ItemSnapshot,
} from "../core/orchestrator.ts";
import { reconstructState, buildSnapshot } from "../core/commands/orchestrate.ts";
import type { TodoItem } from "../core/types.ts";

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

function makeTodo(id: string, title: string, deps: string[] = []): TodoItem {
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

function setupTodosDir(files: Record<string, string>): {
  todosDir: string;
  worktreeDir: string;
  projectRoot: string;
} {
  const dir = makeTmpDir();
  const todosDir = join(dir, ".ninthwave", "todos");
  const worktreeDir = join(dir, ".worktrees");
  mkdirSync(todosDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(todosDir, name), content);
  }
  return { todosDir, worktreeDir, projectRoot: dir };
}

function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return lines.join("\n");
}

function makeDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    pullRebase: () => ({ ok: true, conflict: false }),
    getMergedTodoIds: () => [],
    getOpenTodoIds: (todosDir: string) => {
      if (!existsSync(todosDir)) return [];
      try {
        const entries = readdirSync(todosDir).filter((f) => f.endsWith(".md"));
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

  it("strips TODO ID references", () => {
    expect(normalizeTitleForComparison("fix: handle null (H-MUX-1)")).toBe(
      "handle null",
    );
    expect(
      normalizeTitleForComparison("feat: new feature (TODO H-MUX-1)"),
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

describe("prTitleMatchesTodo", () => {
  it("matches identical titles", () => {
    expect(prTitleMatchesTodo("extract Multiplexer interface", "extract Multiplexer interface")).toBe(true);
  });

  it("matches after stripping commit prefix and ID", () => {
    expect(
      prTitleMatchesTodo(
        "refactor: extract Multiplexer interface (TODO H-MUX-1)",
        "extract Multiplexer interface",
      ),
    ).toBe(true);
  });

  it("rejects different titles", () => {
    expect(
      prTitleMatchesTodo("extract Multiplexer interface", "fail fast when mux unavailable"),
    ).toBe(false);
  });

  it("rejects substring matches (not exact)", () => {
    // PR title is a substring of TODO title — should be treated as mismatch
    expect(
      prTitleMatchesTodo("old work", "old work extended"),
    ).toBe(false);
  });

  it("rejects when TODO title is a substring of PR title", () => {
    expect(
      prTitleMatchesTodo("old work extended", "old work"),
    ).toBe(false);
  });

  it("returns false for empty titles", () => {
    expect(prTitleMatchesTodo("", "some title")).toBe(false);
    expect(prTitleMatchesTodo("some title", "")).toBe(false);
    expect(prTitleMatchesTodo("", "")).toBe(false);
  });
});

// ── Reconcile collision tests ────────────────────────────────────────

describe("reconcile: TODO ID collision safety", () => {
  it("does not delete TODO file when merged PR title doesn't match", () => {
    // Setup: TODO FOO-1 with title "new work" and a merged PR titled "old work"
    const { todosDir, worktreeDir, projectRoot } = setupTodosDir({
      "2-test--H-FOO-1.md": `# New work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "fix: old work (TODO H-FOO-1)" }],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    const output = captureOutput(() => reconcile(todosDir, worktreeDir, projectRoot, deps));
    expect(markedIds).toEqual([]);
    expect(output).toContain("collision");
    expect(output).toContain("H-FOO-1");
  });

  it("deletes TODO file when merged PR title matches", () => {
    const { todosDir, worktreeDir, projectRoot } = setupTodosDir({
      "2-test--H-FOO-1.md": `# Old work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "fix: old work (TODO H-FOO-1)" }],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    reconcile(todosDir, worktreeDir, projectRoot, deps);
    expect(markedIds).toEqual(["H-FOO-1"]);
  });

  it("handles mixed: some titles match, some don't", () => {
    const { todosDir, worktreeDir, projectRoot } = setupTodosDir({
      "2-test--H-FOO-1.md": `# New work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
      "2-test--H-BAR-1.md": `# Fix a bug (H-BAR-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [
        { id: "H-FOO-1", prTitle: "fix: old work (TODO H-FOO-1)" }, // title mismatch
        { id: "H-BAR-1", prTitle: "fix: fix a bug (TODO H-BAR-1)" }, // title match
      ],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    captureOutput(() => reconcile(todosDir, worktreeDir, projectRoot, deps));
    expect(markedIds).toEqual(["H-BAR-1"]);
  });

  it("still marks done when merged PR has no title (fallback to legacy behavior)", () => {
    const { todosDir, worktreeDir, projectRoot } = setupTodosDir({
      "2-test--H-FOO-1.md": `# Some work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "" }],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    reconcile(todosDir, worktreeDir, projectRoot, deps);
    // Empty PR title → skip title check → mark done (legacy behavior)
    expect(markedIds).toEqual(["H-FOO-1"]);
  });

  it("does not clean worktrees for collision-skipped items", () => {
    const { todosDir, worktreeDir, projectRoot } = setupTodosDir({
      "2-test--H-FOO-1.md": `# New work (H-FOO-1)\n\n**Priority:** High\n**Domain:** test\n`,
    });
    const cleanedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => [{ id: "H-FOO-1", prTitle: "fix: old work (TODO H-FOO-1)" }],
      getWorktreeIds: () => ["H-FOO-1"],
      cleanWorktree: (id) => {
        cleanedIds.push(id);
        return true;
      },
    });

    captureOutput(() => reconcile(todosDir, worktreeDir, projectRoot, deps));
    // Should NOT clean the worktree for H-FOO-1 since title didn't match
    expect(cleanedIds).not.toContain("H-FOO-1");
  });
});

// ── Orchestrator reconstructState collision tests ────────────────────

describe("reconstructState: TODO ID collision safety", () => {
  it("does not fast-track to merged when PR title doesn't match TODO title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-FOO-1", "new work"));

    const tmpDir = makeTmpDir();
    const wtDir = join(tmpDir, ".worktrees");
    mkdirSync(join(wtDir, "todo-H-FOO-1"), { recursive: true });

    // Mock checkPr: returns "merged" with a title that doesn't match
    // Format: ID\tPR_NUMBER\tSTATUS\tMERGEABLE\tEVENT_TIME\tPR_TITLE
    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (TODO H-FOO-1)";
      }
      return null;
    };

    reconstructState(orch, tmpDir, wtDir, undefined, mockCheckPr);

    const item = orch.getItem("H-FOO-1")!;
    // Should NOT be "merged" — the title doesn't match
    expect(item.state).toBe("implementing");
  });

  it("fast-tracks to merged when PR title matches TODO title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-FOO-1", "old work"));

    const tmpDir = makeTmpDir();
    const wtDir = join(tmpDir, ".worktrees");
    mkdirSync(join(wtDir, "todo-H-FOO-1"), { recursive: true });

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (TODO H-FOO-1)";
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
    orch.addItem(makeTodo("H-FOO-1", "some work"));

    const tmpDir = makeTmpDir();
    const wtDir = join(tmpDir, ".worktrees");
    mkdirSync(join(wtDir, "todo-H-FOO-1"), { recursive: true });

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

describe("buildSnapshot: TODO ID collision safety", () => {
  it("does not report merged when PR title doesn't match TODO title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-FOO-1", "new work"));
    orch.setState("H-FOO-1", "implementing");

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (TODO H-FOO-1)";
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
    // prState should NOT be "merged" — title mismatch
    expect(snap!.prState).toBeUndefined();
  });

  it("reports merged when PR title matches TODO title", () => {
    const orch = new Orchestrator();
    orch.addItem(makeTodo("H-FOO-1", "old work"));
    orch.setState("H-FOO-1", "implementing");

    const mockCheckPr = (id: string) => {
      if (id === "H-FOO-1") {
        return "H-FOO-1\t42\tmerged\t\t\tfix: old work (TODO H-FOO-1)";
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
