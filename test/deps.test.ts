import { describe, it, expect, afterEach } from "vitest";
import { setupTempRepo, useFixtureDir, cleanupTempRepos } from "./helpers.ts";
import { join } from "path";
import { cmdDeps } from "../core/commands/deps.ts";

describe("deps", () => {
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

  it("shows upstream dependencies", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdDeps(["H-CI-2"], todosDir, worktreeDir),
    );

    expect(output).toContain("Dependency chain for H-CI-2");
    expect(output).toContain("Must complete before H-CI-2");
    expect(output).toContain("M-CI-1");
    // M-CI-1 is still in todos so it should show as pending
    expect(output).toContain("[ ]");
  });

  it("shows downstream dependents", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdDeps(["M-CI-1"], todosDir, worktreeDir),
    );

    expect(output).toContain("Items that depend on M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("H-UO-2");
  });

  it("shows bundle relationships", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // H-UO-2 bundles with H-CI-2
    const output = captureOutput(() =>
      cmdDeps(["H-UO-2"], todosDir, worktreeDir),
    );

    expect(output).toContain("Bundle with");
    expect(output).toContain("H-CI-2");
  });

  it("shows (none) when item has no deps", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdDeps(["C-UO-1"], todosDir, worktreeDir),
    );

    expect(output).toContain("Must complete before C-UO-1");
    expect(output).toContain("(none)");
  });

  it("errors on unknown ID", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdDeps(["FAKE-99"], todosDir, worktreeDir),
    );

    expect(output).toContain("not found");
  });

  it("shows reverse bundle (item referenced by another's bundle-with)", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // H-CI-2 is referenced in H-UO-2's bundle-with field
    const output = captureOutput(() =>
      cmdDeps(["H-CI-2"], todosDir, worktreeDir),
    );

    expect(output).toContain("Bundle with");
    // H-UO-2 bundles with H-CI-2, so H-CI-2 should show H-UO-2 in reverse lookup
    expect(output).toContain("H-UO-2");
  });
});
