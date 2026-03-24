// Tests for core/commands/migrate-todos.ts — migration and generation commands.

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  cmdMigrateTodos,
  cmdGenerateTodos,
} from "../core/commands/migrate-todos.ts";

// Track temp dirs for cleanup
const tempDirs: string[] = [];

function makeTempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-migrate-"));
  tempDirs.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

/**
 * Create a minimal project root with TODOS.md for testing migration.
 */
function setupProject(todosMd: string, frictionLog?: string): string {
  const root = makeTempDir();
  writeFileSync(join(root, "TODOS.md"), todosMd);
  mkdirSync(join(root, ".ninthwave"), { recursive: true });
  mkdirSync(join(root, ".worktrees"), { recursive: true });

  if (frictionLog) {
    writeFileSync(join(root, ".ninthwave", "friction.log"), frictionLog);
  }

  return root;
}

// ---------------------------------------------------------------------------
// cmdMigrateTodos
// ---------------------------------------------------------------------------

describe("cmdMigrateTodos", () => {
  it("migrates a TODOS.md with multiple items into individual files", () => {
    const todosMd = `# TODOS

## Bugs (eng-review, 2026-03-24)

### Fix: Crash on startup (H-BUG-1)

**Priority:** High
**Source:** Eng review
**Depends on:** None

Fix the crash that happens on startup.

Key files: \`core/main.ts\`

---

### Fix: Memory leak (M-BUG-2)

**Priority:** Medium
**Source:** Eng review
**Depends on:** H-BUG-1

Fix the memory leak in the worker pool.

---

## Features (roadmap, 2026-03-24)

### Feat: Add analytics (L-FT-1)

**Priority:** Low
**Source:** Roadmap
**Depends on:** None

Add analytics dashboard.

**Test plan:**
- Unit test analytics module
- Integration test with mock data

Acceptance: Analytics dashboard renders correctly

Key files: \`core/analytics.ts\`, \`core/dashboard.ts\`

---
`;

    const root = setupProject(todosMd);
    cmdMigrateTodos(root);

    // TODOS.md should be deleted
    expect(existsSync(join(root, "TODOS.md"))).toBe(false);

    // Individual files should exist
    const todosDir = join(root, ".ninthwave", "todos");
    const files = readdirSync(todosDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(3);

    // Check specific filenames
    expect(files).toContain("1-bugs--H-BUG-1.md");
    expect(files).toContain("2-bugs--M-BUG-2.md");
    expect(files).toContain("3-features--L-FT-1.md");

    // Verify content of one file
    const bugContent = readFileSync(
      join(todosDir, "1-bugs--H-BUG-1.md"),
      "utf-8",
    );
    expect(bugContent).toContain("# ");
    expect(bugContent).toContain("(H-BUG-1)");
    expect(bugContent).toContain("**Priority:** High");
    expect(bugContent).toContain("**Domain:** bugs");
  });

  it("migrates friction log and skips severity: none entries", () => {
    const todosMd = `# TODOS

## Section (source, date)

### Fix: Something (M-FIX-1)

**Priority:** Medium
**Depends on:** None

Fix it.

---
`;

    const frictionLog = `---
todo: M-FIX-1
date: 2026-03-24T17:09:51Z
severity: medium
description: Had some friction with the build system.
---
todo: H-ENG-1
date: 2026-03-24T18:24:31Z
severity: low
description: File reads were slow.
---
todo: H-ENG-2
date: 2026-03-24T18:24:44Z
severity: none
description: No friction observed.
---
todo: L-DP-13
date: 2026-03-24T20:00:38Z
severity: none
description: No friction observed
`;

    const root = setupProject(todosMd, frictionLog);
    cmdMigrateTodos(root);

    // Friction log should be deleted
    expect(existsSync(join(root, ".ninthwave", "friction.log"))).toBe(false);

    // Friction files should exist (2 non-none entries)
    const frictionDir = join(root, ".ninthwave", "friction");
    const frictionFiles = readdirSync(frictionDir).filter((f) =>
      f.endsWith(".md"),
    );
    expect(frictionFiles.length).toBe(2);

    // Check naming: colons in timestamp should be converted to hyphens
    expect(frictionFiles).toContain(
      "2026-03-24T17-09-51Z--M-FIX-1.md",
    );
    expect(frictionFiles).toContain(
      "2026-03-24T18-24-31Z--H-ENG-1.md",
    );

    // Verify content
    const frictionContent = readFileSync(
      join(frictionDir, "2026-03-24T17-09-51Z--M-FIX-1.md"),
      "utf-8",
    );
    expect(frictionContent).toContain("**Severity:** medium");
    expect(frictionContent).toContain("Had some friction");
  });

  it("handles TODOS.md with no items gracefully", () => {
    const todosMd = `# TODOS

## Empty Section (source, date)

`;

    const root = setupProject(todosMd);
    cmdMigrateTodos(root);

    // TODOS.md should still be deleted
    expect(existsSync(join(root, "TODOS.md"))).toBe(false);

    // Todos dir should be empty (no .md files)
    const todosDir = join(root, ".ninthwave", "todos");
    const files = readdirSync(todosDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(0);
  });

  it("skips duplicate IDs", () => {
    const todosMd = `# TODOS

## Section (source, date)

### Fix: First (M-DUP-1)

**Priority:** Medium
**Depends on:** None

First occurrence.

---

### Fix: Second (M-DUP-1)

**Priority:** Medium
**Depends on:** None

Duplicate.

---
`;

    const root = setupProject(todosMd);
    cmdMigrateTodos(root);

    const todosDir = join(root, ".ninthwave", "todos");
    const files = readdirSync(todosDir).filter((f) => f.endsWith(".md"));
    // Only the first occurrence should be written
    expect(files.length).toBe(1);
  });

  it("handles items with dependencies and bundle-with", () => {
    const todosMd = `# TODOS

## Section (source, date)

### Fix: Depends on others (H-DEP-1)

**Priority:** High
**Depends on:** M-FIX-1, L-FT-1
**Bundle with:** H-DEP-2

Fix with dependencies.

---
`;

    const root = setupProject(todosMd);
    cmdMigrateTodos(root);

    const todosDir = join(root, ".ninthwave", "todos");
    const content = readFileSync(
      join(todosDir, "1-section--H-DEP-1.md"),
      "utf-8",
    );
    expect(content).toContain("**Depends on:** M-FIX-1, L-FT-1");
    expect(content).toContain("**Bundle with:** H-DEP-2");
  });

  it("handles items with repo alias", () => {
    const todosMd = `# TODOS

## Cross Repo (source, date)

### Fix: Remote fix (H-CR-1)

**Priority:** High
**Depends on:** None
**Repo:** target-repo

Fix in another repo.

---
`;

    const root = setupProject(todosMd);
    cmdMigrateTodos(root);

    const todosDir = join(root, ".ninthwave", "todos");
    const content = readFileSync(
      join(todosDir, "1-cross-repo--H-CR-1.md"),
      "utf-8",
    );
    expect(content).toContain("**Repo:** target-repo");
  });
});

// ---------------------------------------------------------------------------
// cmdGenerateTodos
// ---------------------------------------------------------------------------

describe("cmdGenerateTodos", () => {
  it("generates TODOS.md from individual files grouped by domain", () => {
    const root = makeTempDir();
    const todosDir = join(root, ".ninthwave", "todos");
    const worktreeDir = join(root, ".worktrees");
    mkdirSync(todosDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    // Write three items in two domains
    writeFileSync(
      join(todosDir, "1-bugs--H-BUG-1.md"),
      `# Fix crash (H-BUG-1)

**Priority:** High
**Source:** local
**Depends on:** None
**Domain:** bugs

Fix the crash.
`,
    );

    writeFileSync(
      join(todosDir, "2-bugs--M-BUG-2.md"),
      `# Fix leak (M-BUG-2)

**Priority:** Medium
**Source:** local
**Depends on:** H-BUG-1
**Domain:** bugs

Fix the leak.
`,
    );

    writeFileSync(
      join(todosDir, "3-features--L-FT-1.md"),
      `# Add feature (L-FT-1)

**Priority:** Low
**Source:** local
**Depends on:** None
**Domain:** features

Add the feature.
`,
    );

    const outputPath = join(root, "TODOS.md");
    cmdGenerateTodos(todosDir, outputPath);

    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, "utf-8");

    // Check header
    expect(content).toContain("<!-- Auto-generated from .ninthwave/todos/");
    expect(content).toContain("# TODOS");

    // Check domain sections exist and are sorted
    const bugIdx = content.indexOf("## Bugs");
    const ftIdx = content.indexOf("## Features");
    expect(bugIdx).toBeGreaterThan(-1);
    expect(ftIdx).toBeGreaterThan(-1);
    expect(bugIdx).toBeLessThan(ftIdx); // alphabetical: Bugs < Features

    // Check items
    expect(content).toContain("(H-BUG-1)");
    expect(content).toContain("(M-BUG-2)");
    expect(content).toContain("(L-FT-1)");

    // Check priority ordering within domain (High before Medium)
    const hBugIdx = content.indexOf("(H-BUG-1)");
    const mBugIdx = content.indexOf("(M-BUG-2)");
    expect(hBugIdx).toBeLessThan(mBugIdx);

    // Check metadata
    expect(content).toContain("**Priority:** High");
    expect(content).toContain("**Depends on:** H-BUG-1");
    expect(content).toContain("**Depends on:** None");

    // Check separators
    expect(content).toContain("---");
  });

  it("handles empty todos directory", () => {
    const root = makeTempDir();
    const todosDir = join(root, ".ninthwave", "todos");
    const worktreeDir = join(root, ".worktrees");
    mkdirSync(todosDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    const outputPath = join(root, "TODOS.md");
    cmdGenerateTodos(todosDir, outputPath);

    // Should not create a file when there are no items
    expect(existsSync(outputPath)).toBe(false);
  });

  it("includes test plan and key files in output", () => {
    const root = makeTempDir();
    const todosDir = join(root, ".ninthwave", "todos");
    const worktreeDir = join(root, ".worktrees");
    mkdirSync(todosDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(
      join(todosDir, "2-testing--M-TST-1.md"),
      `# Add tests (M-TST-1)

**Priority:** Medium
**Source:** local
**Depends on:** None
**Domain:** testing

Add comprehensive tests.

**Test plan:**
- Unit test all methods
- Integration test with fixtures

Key files: \`core/test.ts\`, \`test/test.test.ts\`
`,
    );

    const outputPath = join(root, "TODOS.md");
    cmdGenerateTodos(todosDir, outputPath);

    const content = readFileSync(outputPath, "utf-8");
    expect(content).toContain("**Test plan:**");
    expect(content).toContain("Unit test all methods");
    expect(content).toContain("Key files:");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: migrate then generate
// ---------------------------------------------------------------------------

describe("migrate-todos + generate-todos round-trip", () => {
  it("produces a consistent result after migration and regeneration", () => {
    const todosMd = `# TODOS

## Worker Reliability (eng-review, 2026-03-24)

### Fix: Worker crash (H-WRK-1)

**Priority:** High
**Source:** Eng review
**Depends on:** None

Fix the worker crash.

Key files: \`core/worker.ts\`

---

### Refactor: Retry logic (M-WRK-2)

**Priority:** Medium
**Source:** Eng review
**Depends on:** H-WRK-1

Improve the retry logic.

**Test plan:**
- Test retry with exponential backoff
- Test max retries

---
`;

    const root = setupProject(todosMd);
    cmdMigrateTodos(root);

    // Now regenerate
    const todosDir = join(root, ".ninthwave", "todos");
    const outputPath = join(root, "TODOS.md");
    cmdGenerateTodos(todosDir, outputPath);

    const regenerated = readFileSync(outputPath, "utf-8");

    // Key items should be present
    expect(regenerated).toContain("(H-WRK-1)");
    expect(regenerated).toContain("(M-WRK-2)");
    expect(regenerated).toContain("**Priority:** High");
    expect(regenerated).toContain("**Priority:** Medium");
    expect(regenerated).toContain("**Depends on:** H-WRK-1");

    // Domain section should exist
    expect(regenerated).toContain("## Worker Reliability");
  });
});
