import { describe, it, expect, afterEach } from "vitest";
import { setupTempRepo, useFixtureDir, writeTodoFiles, cleanupTempRepos } from "./helpers.ts";
import { join } from "path";
import { cmdConflicts } from "../core/commands/conflicts.ts";

describe("conflicts", () => {
  afterEach(() => cleanupTempRepos());

  function captureOutput(fn: () => void): string {
    const lines: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.error = (...args: unknown[]) => lines.push(args.join(" "));

    const origExit = process.exit;
    process.exit = ((code?: number) => {
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

    return lines.join("\n");
  }

  it("detects file overlap between items", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    const todosDir = writeTodoFiles(repo, `## Shared

### Feat: Item A (H-SH-1)

**Priority:** High
**Depends on:** None

Key files: \`lib/shared.ex\`, \`lib/unique_a.ex\`

---

### Feat: Item B (H-SH-2)

**Priority:** High
**Depends on:** None

Key files: \`lib/shared.ex\`, \`lib/unique_b.ex\`

---
`);

    const output = captureOutput(() =>
      cmdConflicts(["H-SH-1", "H-SH-2"], todosDir, worktreeDir),
    );

    expect(output).toContain("CONFLICT");
    expect(output).toContain("lib/shared.ex");
  });

  it("detects domain overlap between items", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // M-CI-1 and H-CI-2 are both in cloud-infrastructure domain
    const output = captureOutput(() =>
      cmdConflicts(["M-CI-1", "H-CI-2"], todosDir, worktreeDir),
    );

    expect(output).toContain("POTENTIAL");
    expect(output).toContain("cloud-infrastructure");
  });

  it("cross-repo items don't conflict", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "cross_repo.md");
    const worktreeDir = join(repo, ".worktrees");

    // H-API-1 (target-repo-a) and H-WA-1 (target-repo-b) target different repos
    const output = captureOutput(() =>
      cmdConflicts(["H-API-1", "H-WA-1"], todosDir, worktreeDir),
    );

    expect(output).not.toContain("CONFLICT");
    expect(output).toContain("CLEAR");
  });

  it("same-repo items are still compared", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "cross_repo.md");
    const worktreeDir = join(repo, ".worktrees");

    // H-API-1 and M-API-2 both target target-repo-a
    const output = captureOutput(() =>
      cmdConflicts(["H-API-1", "M-API-2"], todosDir, worktreeDir),
    );

    // They share the same domain (api-service), so should show POTENTIAL
    expect(output).toContain("POTENTIAL");
    expect(output).toContain("api-service");
  });

  it("reports CLEAR when no conflicts found", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // M-CI-1 (cloud-infrastructure) and C-UO-1 (user-onboarding) - different domains, no file overlap
    const output = captureOutput(() =>
      cmdConflicts(["M-CI-1", "C-UO-1"], todosDir, worktreeDir),
    );

    expect(output).toContain("CLEAR");
  });

  it("errors with fewer than 2 IDs", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdConflicts(["M-CI-1"], todosDir, worktreeDir),
    );

    expect(output).toContain("Usage");
  });

  it("does not flag false positives from description-mentioned paths", () => {
    const repo = setupTempRepo();
    const worktreeDir = join(repo, ".worktrees");

    // Two items that mention the same file in description but NOT in Key files
    const todosDir = writeTodoFiles(repo, `## Features

### Feat: Item A (H-FE-1)

**Priority:** High
**Depends on:** None

This invokes \`lib/shared.ex\` internally.

Key files: \`lib/unique_a.ex\`

---

### Feat: Item B (H-FE-2)

**Priority:** High
**Depends on:** None

Also references \`lib/shared.ex\` in description.

Key files: \`lib/unique_b.ex\`

---
`);

    const output = captureOutput(() =>
      cmdConflicts(["H-FE-1", "H-FE-2"], todosDir, worktreeDir),
    );

    // Should NOT flag a CONFLICT for lib/shared.ex since it's only in descriptions
    expect(output).not.toContain("CONFLICT");
    expect(output).not.toContain("lib/shared.ex");
  });
});
