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

  it("--remote flag is parsed without error", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // Should not throw -- no remote configured, so all items show as "local"
    const output = captureOutput(() => cmdList(["--remote"], workDir, worktreeDir, repo));

    expect(output).toContain("REMOTE");
    expect(output).toContain("4 items");
  });

  it("--remote shows remote/local indicator per item", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Create two items and push both
    writeFileSync(
      join(workDir, "1-core--H-1-1.md"),
      "# Feat: Pushed item (H-1-1)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** core\n",
    );
    writeFileSync(
      join(workDir, "2-tui--M-2-1.md"),
      "# Feat: Another item (M-2-1)\n\n**Priority:** Medium\n**Depends on:** None\n**Domain:** tui\n",
    );
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    // Add a local-only item (committed but not pushed)
    writeFileSync(
      join(workDir, "3-local--L-9-1.md"),
      "# Feat: Local only (L-9-1)\n\n**Priority:** Low\n**Depends on:** None\n**Domain:** local\n",
    );
    gitCmd(repo, "add", ".ninthwave/work/3-local--L-9-1.md");
    gitCmd(repo, "commit", "-m", "Add local item", "--quiet");

    const output = captureOutput(() => cmdList(["--remote"], workDir, worktreeDir, repo));

    // Header should include REMOTE column
    expect(output).toContain("REMOTE");

    // Parse per-item rows
    const lines = output.split("\n");
    const h11Line = lines.find((l) => l.startsWith("H-1-1"));
    const m21Line = lines.find((l) => l.startsWith("M-2-1"));
    const l91Line = lines.find((l) => l.startsWith("L-9-1"));

    expect(h11Line).toContain("remote");
    expect(m21Line).toContain("remote");
    expect(l91Line).toContain("local");
  });

  it("output unchanged when --remote flag is omitted", () => {
    const repo = setupTempRepoWithRemote();
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-core--H-1-1.md"),
      "# Feat: Item one (H-1-1)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** core\n",
    );
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    const output = captureOutput(() => cmdList([], workDir, worktreeDir, repo));

    // No REMOTE column header
    expect(output).not.toContain("REMOTE");
    // No remote/local indicators in data rows
    const dataLines = output.split("\n").filter((l) => l.startsWith("H-1-1"));
    for (const line of dataLines) {
      expect(line).not.toContain("remote");
      expect(line).not.toContain("local");
    }
  });

  it("--remote graceful fallback when no remote configured", () => {
    const repo = setupTempRepo();
    const workDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // No remote configured -- should show all items as "local"
    const output = captureOutput(() => cmdList(["--remote"], workDir, worktreeDir, repo));

    expect(output).toContain("REMOTE");
    // All items should show as "local"
    const dataLines = output.split("\n").filter((l) => /^[A-Z]-/.test(l));
    for (const line of dataLines) {
      expect(line).toContain("local");
    }
    expect(output).toContain("4 items");
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
