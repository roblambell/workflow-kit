// Tests for remote-only work item filtering.
// Verifies getCleanRemoteWorkItemFiles() and parseWorkItems() with projectRoot.

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { setupTempRepoWithRemote, setupTempRepo, registerCleanup } from "./helpers.ts";
import { getCleanRemoteWorkItemFiles } from "../core/git.ts";
import { parseWorkItems } from "../core/parser.ts";

describe("getCleanRemoteWorkItemFiles", () => {
  registerCleanup();

  it("returns correct Set when origin/main has files", () => {
    const repo = setupTempRepoWithRemote();

    // Add work item files and push
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "1-core--H-1-1.md"), "# Test (H-1-1)\n**Priority:** High\n");
    writeFileSync(join(workDir, "2-tui--M-2-1.md"), "# Test (M-2-1)\n**Priority:** Medium\n");
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    const result = getCleanRemoteWorkItemFiles(repo);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
    expect(result!.has("1-core--H-1-1.md")).toBe(true);
    expect(result!.has("2-tui--M-2-1.md")).toBe(true);
  });

  it("returns null when origin/main doesn't exist", () => {
    // Use a repo without a remote
    const repo = setupTempRepo();

    const result = getCleanRemoteWorkItemFiles(repo);
    expect(result).toBeNull();
  });

  it("returns empty Set for empty remote dir", () => {
    const repo = setupTempRepoWithRemote();

    // origin/main exists but has no .ninthwave/work/ directory
    const result = getCleanRemoteWorkItemFiles(repo);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  it("excludes locally modified files", () => {
    const repo = setupTempRepoWithRemote();

    // Add work items and push
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "1-core--H-1-1.md"), "# Test (H-1-1)\n**Priority:** High\n");
    writeFileSync(join(workDir, "2-tui--M-2-1.md"), "# Test (M-2-1)\n**Priority:** Medium\n");
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    // Modify one file locally (uncommitted)
    writeFileSync(join(workDir, "1-core--H-1-1.md"), "# Modified (H-1-1)\n**Priority:** High\n");

    const result = getCleanRemoteWorkItemFiles(repo);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(1);
    expect(result!.has("1-core--H-1-1.md")).toBe(false);
    expect(result!.has("2-tui--M-2-1.md")).toBe(true);
  });

  it("excludes local-only files", () => {
    const repo = setupTempRepoWithRemote();

    // Push one file to origin
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "1-core--H-1-1.md"), "# Test (H-1-1)\n**Priority:** High\n");
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    // Add a local-only file (not pushed)
    writeFileSync(join(workDir, "2-local--L-9-1.md"), "# Local (L-9-1)\n**Priority:** Low\n");
    gitCmd(repo, "add", ".ninthwave/work/2-local--L-9-1.md");
    gitCmd(repo, "commit", "-m", "Add local item", "--quiet");

    const result = getCleanRemoteWorkItemFiles(repo);
    expect(result).not.toBeNull();
    // Only the pushed file should be included; local-only is excluded
    // because it appears in `git diff origin/main` as an addition
    expect(result!.has("1-core--H-1-1.md")).toBe(true);
    expect(result!.has("2-local--L-9-1.md")).toBe(false);
  });

  it("gracefully degrades on diff failure", () => {
    const repo = setupTempRepoWithRemote();

    // Push work items
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "1-core--H-1-1.md"), "# Test (H-1-1)\n**Priority:** High\n");
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    // Inject a runner where ls-tree succeeds but diff fails
    const fakeRunner = (cmd: string, args: string[]) => {
      if (args.includes("ls-tree")) {
        // Return real ls-tree data
        return {
          stdout: ".ninthwave/work/1-core--H-1-1.md",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args.includes("diff")) {
        // Simulate diff failure
        return {
          stdout: "",
          stderr: "fatal: bad revision",
          exitCode: 128,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = getCleanRemoteWorkItemFiles(repo, fakeRunner);
    expect(result).not.toBeNull();
    // Should return all remote files without exclusions (safe fallback)
    expect(result!.size).toBe(1);
    expect(result!.has("1-core--H-1-1.md")).toBe(true);
  });
});

describe("parseWorkItems with projectRoot", () => {
  registerCleanup();

  it("filters when projectRoot is provided", () => {
    const repo = setupTempRepoWithRemote();

    // Create work items, push, then add a local-only item
    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-core--H-1-1.md"),
      "# Feat: Pushed item (H-1-1)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** core\n",
    );
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");
    gitCmd(repo, "push", "--quiet");

    // Add local-only item (committed but not pushed)
    writeFileSync(
      join(workDir, "2-local--M-9-1.md"),
      "# Feat: Local item (M-9-1)\n\n**Priority:** Medium\n**Depends on:** None\n**Domain:** local\n",
    );
    gitCmd(repo, "add", ".ninthwave/work/2-local--M-9-1.md");
    gitCmd(repo, "commit", "-m", "Add local item", "--quiet");

    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // With projectRoot: only pushed items
    const filtered = parseWorkItems(workDir, worktreeDir, repo);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.id).toBe("H-1-1");

    // Without projectRoot: all items
    const all = parseWorkItems(workDir, worktreeDir);
    expect(all.length).toBe(2);
  });

  it("falls back to all items when origin/main doesn't exist", () => {
    // Use a repo without remote
    const repo = setupTempRepo();

    const workDir = join(repo, ".ninthwave", "work");
    mkdirSync(workDir, { recursive: true });

    writeFileSync(
      join(workDir, "1-core--H-1-1.md"),
      "# Feat: Item one (H-1-1)\n\n**Priority:** High\n**Depends on:** None\n**Domain:** core\n",
    );
    writeFileSync(
      join(workDir, "2-tui--M-2-1.md"),
      "# Feat: Item two (M-2-1)\n\n**Priority:** Medium\n**Depends on:** None\n**Domain:** tui\n",
    );
    gitCmd(repo, "add", ".ninthwave/work/");
    gitCmd(repo, "commit", "-m", "Add work items", "--quiet");

    const worktreeDir = join(repo, ".worktrees");
    mkdirSync(worktreeDir, { recursive: true });

    // Even with projectRoot, returns all items since origin/main doesn't exist
    const items = parseWorkItems(workDir, worktreeDir, repo);
    expect(items.length).toBe(2);
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
