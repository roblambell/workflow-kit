// Tests for reconcile command using dependency injection (no vi.mock).

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { reconcile, type ReconcileDeps } from "../core/commands/reconcile.ts";

// --- Test helpers ---

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `nw-test-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const SAMPLE_TODOS = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

### Flaky connection pool (H-CI-2)

**Priority:** High

## User Onboarding

### Onboarding wizard (C-UO-1)

**Priority:** Critical

### Welcome email (H-UO-2)

**Priority:** High
`;

function setupTodos(content: string): { todosFile: string; worktreeDir: string; projectRoot: string } {
  const dir = makeTmpDir();
  const todosFile = join(dir, "TODOS.md");
  const worktreeDir = join(dir, ".worktrees");
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(todosFile, content);
  return { todosFile, worktreeDir, projectRoot: dir };
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
    getOpenTodoIds: (todosFile: string) => {
      if (!existsSync(todosFile)) return [];
      const content = readFileSync(todosFile, "utf-8");
      const ids: string[] = [];
      for (const line of content.split("\n")) {
        if (!line.startsWith("### ")) continue;
        const match = line.match(/\(([A-Z]-[A-Za-z0-9]+-[0-9]+)/);
        if (match) ids.push(match[1]!);
      }
      return ids;
    },
    markDone: () => {},
    getWorktreeIds: () => [],
    cleanWorktree: () => false,
    commitAndPush: () => false,
    ...overrides,
  };
}

// --- Tests ---

describe("reconcile", () => {
  it("pulls latest main as first step", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let pullCalled = false;

    const deps = makeDeps({
      pullRebase: () => {
        pullCalled = true;
        return { ok: true, conflict: false };
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    expect(pullCalled).toBe(true);
  });

  it("stops and warns on pull failure", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let mergedCalled = false;

    const deps = makeDeps({
      pullRebase: () => ({ ok: false, conflict: false, error: "network error" }),
      getMergedTodoIds: () => {
        mergedCalled = true;
        return [];
      },
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    expect(output).toContain("Pull failed");
    expect(output).toContain("network error");
    expect(mergedCalled).toBe(false);
  });

  it("warns about merge conflict and suggests manual resolution", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);

    const deps = makeDeps({
      pullRebase: () => ({ ok: false, conflict: true, error: "CONFLICT in TODOS.md" }),
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    expect(output).toContain("Merge conflict");
    expect(output).toContain("Resolve conflicts manually");
  });

  it("queries GitHub for merged todo/* PRs", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let queriedProject: string | undefined;

    const deps = makeDeps({
      getMergedTodoIds: (root) => {
        queriedProject = root;
        return [];
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    expect(queriedProject).toBe(projectRoot);
  });

  it("marks merged items as done in TODOS.md", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let markedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1", "H-CI-2"],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    expect(markedIds).toEqual(["M-CI-1", "H-CI-2"]);
  });

  it("only marks items that are still open in TODOS.md", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let markedIds: string[] = [];

    const deps = makeDeps({
      // GitHub says these are merged, but X-GONE-1 is not in TODOS.md
      getMergedTodoIds: () => ["M-CI-1", "X-GONE-1"],
      markDone: (ids) => {
        markedIds = ids;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    // Should only mark M-CI-1 (which is in TODOS.md), not X-GONE-1
    expect(markedIds).toEqual(["M-CI-1"]);
  });

  it("cleans worktrees for merged items", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    const cleaned: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1", "H-CI-2"],
      getWorktreeIds: () => ["M-CI-1", "H-CI-2", "C-UO-1"],
      cleanWorktree: (id) => {
        cleaned.push(id);
        return true;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    // Should clean M-CI-1 and H-CI-2 (merged), not C-UO-1 (not merged)
    expect(cleaned).toEqual(["M-CI-1", "H-CI-2"]);
  });

  it("commits and pushes TODOS.md when items were marked done", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let committed = false;

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1"],
      commitAndPush: () => {
        committed = true;
        return true;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    expect(committed).toBe(true);
  });

  it("is a no-op when everything is in sync (no empty commits)", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let markDoneCalled = false;
    let commitCalled = false;

    const deps = makeDeps({
      getMergedTodoIds: () => [],
      markDone: () => {
        markDoneCalled = true;
      },
      commitAndPush: () => {
        commitCalled = true;
        return true;
      },
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    expect(markDoneCalled).toBe(false);
    expect(commitCalled).toBe(false);
    expect(output).toContain("no changes needed");
  });

  it("is a no-op when merged IDs are not in TODOS.md", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let markDoneCalled = false;
    let commitCalled = false;

    const deps = makeDeps({
      // These IDs were merged but already removed from TODOS.md
      getMergedTodoIds: () => ["X-OLD-1", "X-OLD-2"],
      markDone: () => {
        markDoneCalled = true;
      },
      commitAndPush: () => {
        commitCalled = true;
        return true;
      },
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    expect(markDoneCalled).toBe(false);
    expect(commitCalled).toBe(false);
    expect(output).toContain("no changes needed");
  });

  it("reports summary with counts", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1", "H-CI-2"],
      getWorktreeIds: () => ["M-CI-1"],
      cleanWorktree: () => true,
      commitAndPush: () => true,
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    expect(output).toContain("2 item(s) done");
    expect(output).toContain("1 worktree(s)");
  });

  it("still cleans worktrees even when no commit needed", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    const cleaned: string[] = [];

    const deps = makeDeps({
      // X-OLD-1 is merged but not in TODOS.md (already removed)
      getMergedTodoIds: () => ["X-OLD-1"],
      getWorktreeIds: () => ["X-OLD-1"],
      cleanWorktree: (id) => {
        cleaned.push(id);
        return true;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    // Worktree for X-OLD-1 should still be cleaned even though nothing to mark done
    expect(cleaned).toEqual(["X-OLD-1"]);
  });

  it("handles empty TODOS.md gracefully", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos("# TODOS\n");

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1"],
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    // No items to mark done (TODOS.md has no items)
    expect(output).toContain("no changes needed");
  });

  it("does not attempt commit+push when no items were marked done", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let commitCalled = false;

    const deps = makeDeps({
      getMergedTodoIds: () => [],
      commitAndPush: () => {
        commitCalled = true;
        return true;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    expect(commitCalled).toBe(false);
  });
});
