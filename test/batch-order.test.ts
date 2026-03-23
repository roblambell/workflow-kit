import { describe, it, expect, afterEach, vi } from "vitest";
import { setupTempRepo, useFixture, cleanupTempRepos } from "./helpers.ts";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { parseTodos } from "../core/parser.ts";
import { cmdBatchOrder } from "../core/commands/batch-order.ts";

describe("batch-order", () => {
  afterEach(() => cleanupTempRepos());

  function captureOutput(
    fn: () => void,
  ): { stdout: string; exitCode: number } {
    const lines: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    let exitCode = 0;

    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.error = (...args: unknown[]) => lines.push(args.join(" "));

    // Mock process.exit to capture exit code
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
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

    return { stdout: lines.join("\n"), exitCode };
  }

  it("items with no mutual deps are all in batch 1", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1", "C-UO-1"], todosFile, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).not.toContain("Batch 2");
    expect(stdout).toContain("M-CI-1");
    expect(stdout).toContain("C-UO-1");
  });

  it("linear dependency: dep in batch 1, dependent in batch 2", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1", "H-CI-2"], todosFile, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).toContain("Batch 2");

    // M-CI-1 should be in batch 1, H-CI-2 in batch 2
    const batch1 = stdout.split("Batch 2")[0]!;
    const batch2 = stdout.split("Batch 2")[1]!;
    expect(batch1).toContain("M-CI-1");
    expect(batch2).toContain("H-CI-2");
  });

  it("multi-level deps: independent items in batch 1, dependents in batch 2", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(
        ["M-CI-1", "C-UO-1", "H-CI-2", "H-UO-2"],
        todosFile,
        worktreeDir,
      ),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).toContain("Batch 2");

    const batch1 = stdout.split("Batch 2")[0]!;
    expect(batch1).toContain("M-CI-1");
    expect(batch1).toContain("C-UO-1");
  });

  it("circular dependency is detected and returns error", () => {
    const repo = setupTempRepo();
    useFixture(repo, "circular_deps.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout, exitCode } = captureOutput(() =>
      cmdBatchOrder(["H-CC-1", "H-CC-2", "H-CC-3"], todosFile, worktreeDir),
    );

    expect(stdout).toContain("Circular dependency");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("H-CC-1");
    expect(stdout).toContain("H-CC-2");
    expect(stdout).toContain("H-CC-3");
  });

  it("partial circular: free item batched, then circular error", () => {
    const repo = setupTempRepo();
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    writeFileSync(
      todosFile,
      `# TODOS

## Mixed

### Feat: Free item (H-MX-1)

**Priority:** High
**Source:** Test
**Depends on:** None

No dependencies.

Acceptance: Test fixture only.

---

### Feat: Cycle A (H-MX-2)

**Priority:** High
**Source:** Test
**Depends on:** H-MX-3

Depends on H-MX-3.

Acceptance: Test fixture only.

---

### Feat: Cycle B (H-MX-3)

**Priority:** High
**Source:** Test
**Depends on:** H-MX-2

Depends on H-MX-2.

Acceptance: Test fixture only.

---
`,
    );

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["H-MX-1", "H-MX-2", "H-MX-3"], todosFile, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).toContain("H-MX-1");
    expect(stdout).toContain("Circular dependency");
  });

  it("single item with no deps goes to batch 1", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1"], todosFile, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).toContain("M-CI-1");
    expect(stdout).toContain("1 items");
  });

  it("unknown item is warned and skipped", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1", "FAKE-ID-99"], todosFile, worktreeDir),
    );

    expect(stdout).toContain("Warning");
    expect(stdout).toContain("FAKE-ID-99");
    expect(stdout).toContain("M-CI-1");
  });
});
