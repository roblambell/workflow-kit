// Tests for reconcile command using dependency injection (no vi.mock).

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { reconcile, mergeTodosThreeWay, parseTodosForMerge, type ReconcileDeps } from "../core/commands/reconcile.ts";
import { closeWorkspacesForIds } from "../core/commands/clean.ts";
import type { Multiplexer } from "../core/mux.ts";

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
    closeStaleWorkspaces: () => 0,
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

  it("closes stale workspaces for merged items", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);
    let closedIds: string[] = [];

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1", "H-CI-2"],
      closeStaleWorkspaces: (ids) => {
        closedIds = [...ids];
        return ids.length;
      },
    });

    reconcile(todosFile, worktreeDir, projectRoot, deps);
    // All merged IDs are passed, not just newly-marked-done ones
    expect(closedIds).toEqual(["M-CI-1", "H-CI-2"]);
  });

  it("includes workspace count in summary output", () => {
    const { todosFile, worktreeDir, projectRoot } = setupTodos(SAMPLE_TODOS);

    const deps = makeDeps({
      getMergedTodoIds: () => ["M-CI-1"],
      closeStaleWorkspaces: () => 1,
      commitAndPush: () => true,
    });

    const output = captureOutput(() => reconcile(todosFile, worktreeDir, projectRoot, deps));
    expect(output).toContain("1 workspace(s)");
  });
});

// --- closeWorkspacesForIds tests ---

function mockMux(overrides: Partial<Multiplexer> = {}): Multiplexer {
  return {
    isAvailable: () => true,
    launchWorkspace: () => null,
    sendMessage: () => false,
    readScreen: () => "",
    listWorkspaces: () => "",
    closeWorkspace: () => true,
    ...overrides,
  };
}

describe("closeWorkspacesForIds", () => {
  it("closes workspaces matching done TODO IDs", () => {
    const closedRefs: string[] = [];
    const mux = mockMux({
      listWorkspaces: () => [
        "workspace:1  TODO H-CI-2  (running)",
        "workspace:2  TODO M-CI-1  (running)",
        "workspace:3  TODO C-UO-1  (running)",
      ].join("\n"),
      closeWorkspace: (ref) => {
        closedRefs.push(ref);
        return true;
      },
    });

    const count = closeWorkspacesForIds(new Set(["H-CI-2", "M-CI-1"]), mux);
    expect(count).toBe(2);
    expect(closedRefs).toContain("workspace:1");
    expect(closedRefs).toContain("workspace:2");
    // Should not close workspace:3 (C-UO-1 is not in done set)
    expect(closedRefs).not.toContain("workspace:3");
  });

  it("correctly extracts TODO ID from workspace name", () => {
    const closedRefs: string[] = [];
    const mux = mockMux({
      listWorkspaces: () => [
        "workspace:5  TODO H-DF-2  ninthwave worker session",
        "workspace:6  some-other-workspace without TODO pattern",
        "workspace:7  TODO M-ABC-123  another worker",
      ].join("\n"),
      closeWorkspace: (ref) => {
        closedRefs.push(ref);
        return true;
      },
    });

    const count = closeWorkspacesForIds(new Set(["H-DF-2", "M-ABC-123"]), mux);
    expect(count).toBe(2);
    expect(closedRefs).toEqual(["workspace:5", "workspace:7"]);
  });

  it("skips when no workspaces match done IDs", () => {
    let closeCalled = false;
    const mux = mockMux({
      listWorkspaces: () => [
        "workspace:1  TODO X-OTHER-1  (running)",
        "workspace:2  TODO Y-OTHER-2  (running)",
      ].join("\n"),
      closeWorkspace: () => {
        closeCalled = true;
        return true;
      },
    });

    const count = closeWorkspacesForIds(new Set(["H-CI-2"]), mux);
    expect(count).toBe(0);
    expect(closeCalled).toBe(false);
  });

  it("handles empty workspace list", () => {
    let closeCalled = false;
    const mux = mockMux({
      listWorkspaces: () => "",
      closeWorkspace: () => {
        closeCalled = true;
        return true;
      },
    });

    const count = closeWorkspacesForIds(new Set(["H-CI-2"]), mux);
    expect(count).toBe(0);
    expect(closeCalled).toBe(false);
  });

  it("returns 0 when mux is not available", () => {
    const mux = mockMux({
      isAvailable: () => false,
    });

    const count = closeWorkspacesForIds(new Set(["H-CI-2"]), mux);
    expect(count).toBe(0);
  });

  it("handles null workspace list", () => {
    const mux = mockMux({
      listWorkspaces: () => null as unknown as string,
    });

    const count = closeWorkspacesForIds(new Set(["H-CI-2"]), mux);
    expect(count).toBe(0);
  });
});

// --- Three-way merge tests ---

describe("parseTodosForMerge", () => {
  it("parses preamble, sections, and items", () => {
    const parsed = parseTodosForMerge(SAMPLE_TODOS);
    expect(parsed.preamble).toEqual(["# TODOS", ""]);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]!.header).toBe("## Cloud Infrastructure");
    expect(parsed.sections[0]!.items).toHaveLength(2);
    expect(parsed.sections[0]!.items[0]!.id).toBe("M-CI-1");
    expect(parsed.sections[0]!.items[1]!.id).toBe("H-CI-2");
    expect(parsed.sections[1]!.header).toBe("## User Onboarding");
    expect(parsed.sections[1]!.items).toHaveLength(2);
    expect(parsed.sections[1]!.items[0]!.id).toBe("C-UO-1");
    expect(parsed.sections[1]!.items[1]!.id).toBe("H-UO-2");
  });

  it("preserves item lines including content and blank lines", () => {
    const parsed = parseTodosForMerge(SAMPLE_TODOS);
    const item = parsed.sections[0]!.items[0]!;
    expect(item.lines[0]).toBe("### Upgrade CI runners (M-CI-1)");
    expect(item.lines).toContain("**Priority:** Medium");
  });

  it("handles empty content", () => {
    const parsed = parseTodosForMerge("");
    expect(parsed.preamble).toEqual([""]);
    expect(parsed.sections).toHaveLength(0);
  });

  it("handles items without IDs", () => {
    const content = `# TODOS\n\n## Section\n\n### Item without ID\n\nSome text\n`;
    const parsed = parseTodosForMerge(content);
    expect(parsed.sections[0]!.items[0]!.id).toBe("");
    expect(parsed.sections[0]!.items[0]!.lines[0]).toBe("### Item without ID");
  });
});

describe("mergeTodosThreeWay", () => {
  // Helper to extract IDs from merged output
  function extractItemIds(content: string): string[] {
    const ids: string[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("### ")) continue;
      const match = line.match(/\(([A-Z]-[A-Za-z0-9]+-[0-9]+)/);
      if (match) ids.push(match[1]!);
    }
    return ids;
  }

  it("preserves removals from ours (upstream) and additions from theirs (local)", () => {
    // Base: A, B, C, D
    // Ours (upstream): A, C, D (B removed — marked done upstream)
    // Theirs (local): A, B, C, D, E (E added locally)
    // Expected: A, C, D, E (B removed by upstream, E added by local)
    const base = SAMPLE_TODOS; // M-CI-1, H-CI-2, C-UO-1, H-UO-2

    // Ours: remove M-CI-1
    const ours = `# TODOS

## Cloud Infrastructure

### Flaky connection pool (H-CI-2)

**Priority:** High

## User Onboarding

### Onboarding wizard (C-UO-1)

**Priority:** Critical

### Welcome email (H-UO-2)

**Priority:** High
`;

    // Theirs: add L-NEW-1 to User Onboarding
    const theirs = `# TODOS

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

### New monitoring dashboard (L-NEW-1)

**Priority:** Low
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    // M-CI-1 removed by ours, L-NEW-1 added by theirs
    expect(ids).toContain("H-CI-2");
    expect(ids).toContain("C-UO-1");
    expect(ids).toContain("H-UO-2");
    expect(ids).toContain("L-NEW-1");
    expect(ids).not.toContain("M-CI-1");
  });

  it("preserves removals from theirs (local) and additions from ours (upstream)", () => {
    // Base: A, B, C, D
    // Ours (upstream): A, B, C, D, E (E added upstream)
    // Theirs (local): A, C, D (B removed locally)
    // Expected: A, C, D, E (B removed by local, E added by upstream)
    const base = SAMPLE_TODOS;

    // Ours: add E-NEW-1 to Cloud Infrastructure
    const ours = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

### Flaky connection pool (H-CI-2)

**Priority:** High

### New infra item (E-NEW-1)

**Priority:** Medium

## User Onboarding

### Onboarding wizard (C-UO-1)

**Priority:** Critical

### Welcome email (H-UO-2)

**Priority:** High
`;

    // Theirs: remove M-CI-1 (marked done locally)
    const theirs = `# TODOS

## Cloud Infrastructure

### Flaky connection pool (H-CI-2)

**Priority:** High

## User Onboarding

### Onboarding wizard (C-UO-1)

**Priority:** Critical

### Welcome email (H-UO-2)

**Priority:** High
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    // M-CI-1 removed by theirs, E-NEW-1 added by ours (kept)
    expect(ids).toContain("H-CI-2");
    expect(ids).toContain("E-NEW-1");
    expect(ids).toContain("C-UO-1");
    expect(ids).toContain("H-UO-2");
    expect(ids).not.toContain("M-CI-1");
  });

  it("preserves removals from both sides", () => {
    // Base: A, B, C, D
    // Ours: A, C, D (B removed)
    // Theirs: A, B, D (C removed)
    // Expected: A, D (both B and C removed)
    const base = SAMPLE_TODOS;

    const ours = `# TODOS

## Cloud Infrastructure

### Flaky connection pool (H-CI-2)

**Priority:** High

## User Onboarding

### Onboarding wizard (C-UO-1)

**Priority:** Critical

### Welcome email (H-UO-2)

**Priority:** High
`;

    const theirs = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

### Flaky connection pool (H-CI-2)

**Priority:** High

## User Onboarding

### Welcome email (H-UO-2)

**Priority:** High
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    expect(ids).toContain("H-CI-2");
    expect(ids).toContain("H-UO-2");
    expect(ids).not.toContain("M-CI-1"); // removed by ours
    expect(ids).not.toContain("C-UO-1"); // removed by theirs
  });

  it("preserves additions from both sides", () => {
    // Base: A, B
    // Ours: A, B, C (C added by upstream)
    // Theirs: A, B, D (D added by local)
    // Expected: A, B, C, D (both additions preserved)
    const base = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

### Flaky connection pool (H-CI-2)

**Priority:** High
`;

    const ours = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

### Flaky connection pool (H-CI-2)

**Priority:** High

### Ours added item (M-ADD-1)

**Priority:** Medium
`;

    const theirs = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

### Flaky connection pool (H-CI-2)

**Priority:** High

### Theirs added item (L-ADD-1)

**Priority:** Low
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    expect(ids).toContain("M-CI-1");
    expect(ids).toContain("H-CI-2");
    expect(ids).toContain("M-ADD-1"); // added by ours
    expect(ids).toContain("L-ADD-1"); // added by theirs
  });

  it("handles identical content (no-op)", () => {
    const merged = mergeTodosThreeWay(SAMPLE_TODOS, SAMPLE_TODOS, SAMPLE_TODOS);
    const ids = extractItemIds(merged);

    expect(ids).toEqual(["M-CI-1", "H-CI-2", "C-UO-1", "H-UO-2"]);
  });

  it("preserves new sections from theirs", () => {
    // Theirs adds a whole new section
    const base = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium
`;

    const ours = base; // upstream unchanged

    const theirs = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

## New Domain

### Brand new item (L-NEW-1)

**Priority:** Low
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    expect(ids).toContain("M-CI-1");
    expect(ids).toContain("L-NEW-1");
    expect(merged).toContain("## New Domain");
  });

  it("drops sections that become empty after removals", () => {
    // Theirs removes the only item in a section
    const base = `# TODOS

## Cloud Infrastructure

### Upgrade CI runners (M-CI-1)

**Priority:** Medium

## User Onboarding

### Welcome email (H-UO-2)

**Priority:** High
`;

    const ours = base; // unchanged

    const theirs = `# TODOS

## User Onboarding

### Welcome email (H-UO-2)

**Priority:** High
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    expect(ids).not.toContain("M-CI-1");
    expect(ids).toContain("H-UO-2");
    // Cloud Infrastructure section should be dropped since it's empty
    expect(merged).not.toContain("## Cloud Infrastructure");
  });

  it("handles empty base (both sides adding new content)", () => {
    const base = "# TODOS\n";

    const ours = `# TODOS

## Section A

### Item A (M-A-1)

**Priority:** Medium
`;

    const theirs = `# TODOS

## Section B

### Item B (M-B-1)

**Priority:** Medium
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    expect(ids).toContain("M-A-1");
    expect(ids).toContain("M-B-1");
  });

  it("preserves item content faithfully", () => {
    const base = `# TODOS

## Section

### Multi-line item (M-ML-1)

**Priority:** High
**Depends on:** None

This item has a detailed description
with multiple lines of text.

Key files: \`core/foo.ts\`, \`core/bar.ts\`
`;

    const ours = base;
    const theirs = base;

    const merged = mergeTodosThreeWay(base, ours, theirs);

    expect(merged).toContain("This item has a detailed description");
    expect(merged).toContain("with multiple lines of text.");
    expect(merged).toContain("Key files:");
  });

  it("simulates realistic reconcile conflict: concurrent mark-done and new items", () => {
    // This is the core scenario from the TODO:
    // Worker A merges a PR, reconcile on machine A marks items done and pushes
    // Worker B adds new items locally, tries to reconcile, gets a conflict
    // The three-way merge should preserve both changes

    const base = `# TODOS

## CLI Commands

### Fix reconcile command (H-REC-1)

**Priority:** High

### Add watch mode (M-WAT-1)

**Priority:** Medium

## Visual Design

### Dark mode support (L-VIS-1)

**Priority:** Low

### Icon redesign (L-VIS-2)

**Priority:** Low
`;

    // Ours (remote after machine A reconciled): H-REC-1 marked done (removed)
    const ours = `# TODOS

## CLI Commands

### Add watch mode (M-WAT-1)

**Priority:** Medium

## Visual Design

### Dark mode support (L-VIS-1)

**Priority:** Low

### Icon redesign (L-VIS-2)

**Priority:** Low
`;

    // Theirs (local with new items from decompose): Added M-FIX-1 and L-VIS-3
    const theirs = `# TODOS

## CLI Commands

### Fix reconcile command (H-REC-1)

**Priority:** High

### Add watch mode (M-WAT-1)

**Priority:** Medium

### Fix memory leak (M-FIX-1)

**Priority:** Medium

## Visual Design

### Dark mode support (L-VIS-1)

**Priority:** Low

### Icon redesign (L-VIS-2)

**Priority:** Low

### Animate transitions (L-VIS-3)

**Priority:** Low
`;

    const merged = mergeTodosThreeWay(base, ours, theirs);
    const ids = extractItemIds(merged);

    // H-REC-1 was removed by ours (marked done) — should stay removed
    expect(ids).not.toContain("H-REC-1");

    // Original items still present
    expect(ids).toContain("M-WAT-1");
    expect(ids).toContain("L-VIS-1");
    expect(ids).toContain("L-VIS-2");

    // New items from theirs preserved
    expect(ids).toContain("M-FIX-1");
    expect(ids).toContain("L-VIS-3");

    // Verify sections are intact
    expect(merged).toContain("## CLI Commands");
    expect(merged).toContain("## Visual Design");
  });
});
