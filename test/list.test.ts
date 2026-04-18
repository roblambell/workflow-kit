import { describe, it, expect, afterEach } from "vitest";
import { setupTempRepo, setupTempRepoWithRemote, useFixtureDir, cleanupTempRepos, captureOutput } from "./helpers.ts";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { cmdList } from "../core/commands/list.ts";

describe("list", () => {
  afterEach(() => cleanupTempRepos());

  it("lists all items with no filters", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--ready"], workDir, worktreeDir),
    );

    // M-CI-1 has no deps -> ready
    // C-UO-1 has no deps -> ready
    // H-CI-2 depends on M-CI-1 (still in work item files) -> not ready
    // H-UO-2 depends on C-UO-1 and M-CI-1 (both in work item files) -> not ready
    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).not.toContain("H-CI-2");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("--depth 1 is equivalent to --ready", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

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
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    // --depth without --ready should still filter
    const output = captureOutput(() =>
      cmdList(["--depth", "1"], workDir, worktreeDir),
    );

    expect(output).toContain("2 items");
  });

  it("--depth with invalid value exits with error", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "0"], workDir, worktreeDir),
    );

    expect(output).toContain("--depth requires a positive integer");
  });

  // --remote was removed in H-WTI-1: the diff-based "remote vs local"
  // filter is gone now that the daemon sources every work item from
  // origin/main via git plumbing. The flag no longer has a meaning --
  // every listed item is by definition what origin/main sees.
  it("rejects the removed --remote flag", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".ninthwave", ".worktrees");

    const output = captureOutput(() => cmdList(["--remote"], workDir, worktreeDir));

    expect(output).toContain("Unknown option: --remote");
  });
});

/** Helper to run git commands in tests. */
function gitCmd(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0 && result.stderr && !result.stderr.includes("warning:")) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return (result.stdout || "").trim();
}
