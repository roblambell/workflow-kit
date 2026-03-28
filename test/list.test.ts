import { describe, it, expect, afterEach } from "vitest";
import { setupTempRepo, useFixtureDir, cleanupTempRepos } from "./helpers.ts";
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
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() => cmdList([], workDir, worktreeDir));

    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-UO-2");
    expect(output).toContain("4 items");
  });

  it("filters by priority", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--priority", "high"], workDir, worktreeDir),
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
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--domain", "cloud-infrastructure"], workDir, worktreeDir),
    );

    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).not.toContain("C-UO-1");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("filters by feature code", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--feature", "UO"], workDir, worktreeDir),
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
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--ready"], workDir, worktreeDir),
    );

    // M-CI-1 has no deps -> ready
    // C-UO-1 has no deps -> ready
    // H-CI-2 depends on M-CI-1 (still in todo files) -> not ready
    // H-UO-2 depends on C-UO-1 and M-CI-1 (both in todo files) -> not ready
    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).not.toContain("H-CI-2");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("--depth 1 is equivalent to --ready", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "1"], workDir, worktreeDir),
    );

    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).not.toContain("H-CI-2");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("--depth 2 includes items one hop from ready roots", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "2"], workDir, worktreeDir),
    );

    // Depth 1: M-CI-1, C-UO-1 (no deps)
    // Depth 2: H-CI-2 (dep: M-CI-1), H-UO-2 (deps: C-UO-1, M-CI-1)
    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("H-UO-2");
    expect(output).toContain("4 items");
  });

  it("--depth implies --ready", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // --depth without --ready should still filter
    const output = captureOutput(() =>
      cmdList(["--depth", "1"], workDir, worktreeDir),
    );

    expect(output).toContain("2 items");
  });

  it("--depth with invalid value exits with error", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "0"], workDir, worktreeDir),
    );

    expect(output).toContain("--depth requires a positive integer");
  });

  it("shows repo label for cross-repo items", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "cross_repo.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() => cmdList([], workDir, worktreeDir));

    expect(output).toContain("target-repo-a");
    expect(output).toContain("H-API-1");
  });
});
