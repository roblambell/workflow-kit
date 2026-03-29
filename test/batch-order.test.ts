import { describe, it, expect, afterEach, vi } from "vitest";
import { setupTempRepo, useFixtureDir, writeWorkItemFiles, cleanupTempRepos, captureOutputWithExit } from "./helpers.ts";
import { join } from "path";
import { parseWorkItems } from "../core/parser.ts";
import {
  cmdBatchOrder,
  computeBatches,
  CircularDependencyError,
} from "../core/commands/batch-order.ts";

describe("batch-order", () => {
  afterEach(() => cleanupTempRepos());

  // Alias for backward compatibility with existing test call sites
  const captureOutput = captureOutputWithExit;

  it("items with no mutual deps are all in batch 1", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1", "C-UO-1"], workDir, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).not.toContain("Batch 2");
    expect(stdout).toContain("M-CI-1");
    expect(stdout).toContain("C-UO-1");
  });

  it("linear dependency: dep in batch 1, dependent in batch 2", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1", "H-CI-2"], workDir, worktreeDir),
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
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(
        ["M-CI-1", "C-UO-1", "H-CI-2", "H-UO-2"],
        workDir,
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
    const workDir = useFixtureDir(repo, "circular_deps.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout, exitCode } = captureOutput(() =>
      cmdBatchOrder(["H-CC-1", "H-CC-2", "H-CC-3"], workDir, worktreeDir),
    );

    expect(stdout).toContain("Circular dependency");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("H-CC-1");
    expect(stdout).toContain("H-CC-2");
    expect(stdout).toContain("H-CC-3");
  });

  it("partial circular: free item batched, then circular error", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const workDir = writeWorkItemFiles(repo, `## Mixed

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
`);

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["H-MX-1", "H-MX-2", "H-MX-3"], workDir, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).toContain("H-MX-1");
    expect(stdout).toContain("Circular dependency");
  });

  it("single item with no deps goes to batch 1", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1"], workDir, worktreeDir),
    );

    expect(stdout).toContain("Batch 1");
    expect(stdout).toContain("M-CI-1");
    expect(stdout).toContain("1 items");
  });

  it("unknown item is warned and skipped", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const { stdout } = captureOutput(() =>
      cmdBatchOrder(["M-CI-1", "FAKE-ID-99"], workDir, worktreeDir),
    );

    expect(stdout).toContain("Warning");
    expect(stdout).toContain("FAKE-ID-99");
    expect(stdout).toContain("M-CI-1");
  });
});

describe("computeBatches", () => {
  afterEach(() => cleanupTempRepos());

  it("all independent items land in batch 1", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    const result = computeBatches(items, ["M-CI-1", "C-UO-1"]);

    expect(result.batchCount).toBe(1);
    expect(result.assignments.get("M-CI-1")).toBe(1);
    expect(result.assignments.get("C-UO-1")).toBe(1);
    expect(result.assignments.size).toBe(2);
  });

  it("linear dependency produces two batches", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    const result = computeBatches(items, ["M-CI-1", "H-CI-2"]);

    expect(result.batchCount).toBe(2);
    expect(result.assignments.get("M-CI-1")).toBe(1);
    expect(result.assignments.get("H-CI-2")).toBe(2);
  });

  it("single item returns batch 1", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    const result = computeBatches(items, ["C-UO-1"]);

    expect(result.batchCount).toBe(1);
    expect(result.assignments.get("C-UO-1")).toBe(1);
    expect(result.assignments.size).toBe(1);
  });

  it("unknown IDs are silently skipped", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    const result = computeBatches(items, ["M-CI-1", "FAKE-99"]);

    expect(result.batchCount).toBe(1);
    expect(result.assignments.get("M-CI-1")).toBe(1);
    expect(result.assignments.has("FAKE-99")).toBe(false);
    expect(result.assignments.size).toBe(1);
  });

  it("circular dependency throws CircularDependencyError", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "circular_deps.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    expect(() =>
      computeBatches(items, ["H-CC-1", "H-CC-2", "H-CC-3"]),
    ).toThrow(CircularDependencyError);
  });

  it("circular dependency error contains all circular item IDs", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "circular_deps.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    try {
      computeBatches(items, ["H-CC-1", "H-CC-2", "H-CC-3"]);
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CircularDependencyError);
      const err = e as CircularDependencyError;
      expect(err.circularItems).toContain("H-CC-1");
      expect(err.circularItems).toContain("H-CC-2");
      expect(err.circularItems).toContain("H-CC-3");
      expect(err.batchCount).toBe(0);
      expect(err.assignments.size).toBe(0);
    }
  });

  it("partial circular: assigns free items then throws for cycle", () => {
    const repo = setupTempRepo();

    const workDir = writeWorkItemFiles(repo, `## Mixed

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
`);

    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    try {
      computeBatches(items, ["H-MX-1", "H-MX-2", "H-MX-3"]);
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CircularDependencyError);
      const err = e as CircularDependencyError;
      // Free item was assigned to batch 1
      expect(err.assignments.get("H-MX-1")).toBe(1);
      expect(err.batchCount).toBe(1);
      // Circular items identified
      expect(err.circularItems).toContain("H-MX-2");
      expect(err.circularItems).toContain("H-MX-3");
      expect(err.circularItems).not.toContain("H-MX-1");
    }
  });

  it("multi-level deps: diamond dependency resolves correctly", () => {
    const repo = setupTempRepo();

    // Diamond: A has no deps, B depends on A, C depends on A, D depends on B+C
    const workDir = writeWorkItemFiles(repo, `## Diamond

### Feat: Root (H-DI-1)

**Priority:** High
**Source:** Test
**Depends on:** None

Root of diamond.

Acceptance: Test fixture only.

---

### Feat: Left (H-DI-2)

**Priority:** High
**Source:** Test
**Depends on:** H-DI-1

Left branch.

Acceptance: Test fixture only.

---

### Feat: Right (H-DI-3)

**Priority:** High
**Source:** Test
**Depends on:** H-DI-1

Right branch.

Acceptance: Test fixture only.

---

### Feat: Join (H-DI-4)

**Priority:** High
**Source:** Test
**Depends on:** H-DI-2, H-DI-3

Joins left and right.

Acceptance: Test fixture only.

---
`);

    const items = parseWorkItems(workDir, join(repo, ".worktrees"));
    const result = computeBatches(items, [
      "H-DI-1",
      "H-DI-2",
      "H-DI-3",
      "H-DI-4",
    ]);

    expect(result.batchCount).toBe(3);
    expect(result.assignments.get("H-DI-1")).toBe(1);
    expect(result.assignments.get("H-DI-2")).toBe(2);
    expect(result.assignments.get("H-DI-3")).toBe(2);
    expect(result.assignments.get("H-DI-4")).toBe(3);
  });

  it("empty selectedIds returns empty result", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    const result = computeBatches(items, []);

    expect(result.batchCount).toBe(0);
    expect(result.assignments.size).toBe(0);
  });

  it("wildcard-expanded deps are respected in batch ordering", () => {
    const repo = setupTempRepo();

    // Three domain items + one item depending on the whole domain via wildcard
    const workDir = writeWorkItemFiles(repo, `## Alpha

### Feat: A1 (H-AL-1)

**Priority:** High
**Source:** Test
**Depends on:** None

First alpha item.

Acceptance: Test fixture only.

---

### Feat: A2 (M-AL-2)

**Priority:** Medium
**Source:** Test
**Depends on:** None

Second alpha item.

Acceptance: Test fixture only.

---

## Beta

### Feat: After all alpha (H-BE-1)

**Priority:** High
**Source:** Test
**Depends on:** AL-*

Depends on all alpha items via wildcard.

Acceptance: Test fixture only.

---
`);

    const items = parseWorkItems(workDir, join(repo, ".worktrees"));
    const result = computeBatches(items, ["H-AL-1", "M-AL-2", "H-BE-1"]);

    // Alpha items in batch 1, wildcard-dependent item in batch 2
    expect(result.batchCount).toBe(2);
    expect(result.assignments.get("H-AL-1")).toBe(1);
    expect(result.assignments.get("M-AL-2")).toBe(1);
    expect(result.assignments.get("H-BE-1")).toBe(2);
  });

  it("external deps are ignored (only selected set matters)", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const items = parseWorkItems(workDir, join(repo, ".worktrees"));

    // H-CI-2 depends on M-CI-1, but M-CI-1 is not in the selected set
    // So H-CI-2 should be batch 1 (its dep is external)
    const result = computeBatches(items, ["H-CI-2"]);

    expect(result.batchCount).toBe(1);
    expect(result.assignments.get("H-CI-2")).toBe(1);
  });
});
