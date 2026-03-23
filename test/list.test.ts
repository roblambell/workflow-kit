import { describe, it, expect, afterEach } from "vitest";
import { setupTempRepo, useFixture, cleanupTempRepos } from "./helpers.ts";
import { join } from "path";
import { cmdList } from "../core/commands/list.ts";

describe("list", () => {
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

  it("lists all items with no filters", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() => cmdList([], todosFile, worktreeDir));

    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-UO-2");
    expect(output).toContain("4 items");
  });

  it("filters by priority", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--priority", "high"], todosFile, worktreeDir),
    );

    expect(output).toContain("H-CI-2");
    expect(output).toContain("H-UO-2");
    // M-CI-1 may appear in DEPENDS ON column, but should not appear as a row ID
    const lines = output.split("\n").filter((l) => l.startsWith("M-CI-1"));
    expect(lines).toHaveLength(0);
    const cLines = output.split("\n").filter((l) => l.startsWith("C-UO-1"));
    expect(cLines).toHaveLength(0);
    expect(output).toContain("2 items");
  });

  it("filters by domain", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--domain", "cloud-infrastructure"], todosFile, worktreeDir),
    );

    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).not.toContain("C-UO-1");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("filters by feature code", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--feature", "UO"], todosFile, worktreeDir),
    );

    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-UO-2");
    // M-CI-1 may appear in DEPENDS ON column, but should not appear as a row ID
    const mLines = output.split("\n").filter((l) => l.startsWith("M-CI-1"));
    expect(mLines).toHaveLength(0);
    const hLines = output.split("\n").filter((l) => l.startsWith("H-CI-2"));
    expect(hLines).toHaveLength(0);
    expect(output).toContain("2 items");
  });

  it("filters by ready (deps all satisfied)", () => {
    const repo = setupTempRepo();
    useFixture(repo, "valid.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--ready"], todosFile, worktreeDir),
    );

    // M-CI-1 has no deps -> ready
    // C-UO-1 has no deps -> ready
    // H-CI-2 depends on M-CI-1 (still in TODOS.md) -> not ready
    // H-UO-2 depends on C-UO-1 and M-CI-1 (both in TODOS.md) -> not ready
    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).not.toContain("H-CI-2");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("shows repo label for cross-repo items", () => {
    const repo = setupTempRepo();
    useFixture(repo, "cross_repo.md");
    const todosFile = join(repo, "TODOS.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() => cmdList([], todosFile, worktreeDir));

    expect(output).toContain("target-repo-a");
    expect(output).toContain("H-API-1");
  });
});
