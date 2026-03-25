// Tests for core/git.ts — direct tests of error handling paths.
//
// Uses real temp git repos to trigger failures naturally.
//
// Mock leakage note: clean.test.ts and start.test.ts vi.mock("../core/git.ts"),
// which leaks into other files in bun's test runner. Functions that are mocked
// elsewhere (branchExists, fetchOrigin, ffMerge, deleteBranch, isBranchMerged,
// etc.) are tested via run() from shell.ts to exercise the same error handling
// logic without import-level interference. Functions NOT mocked elsewhere
// (commitCount, diffStat, getStagedFiles, gitCommit, hasChanges) are imported
// and tested directly.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { setupTempRepo, registerCleanup } from "./helpers.ts";
import { run } from "../core/shell.ts";
import {
  commitCount,
  diffStat,
  getStagedFiles,
  getProjectRoot,
  gitCommit,
  hasChanges,
  rebaseOnto,
} from "../core/git.ts";

/** Helper: run a git command in a temp repo via child_process (for setup). */
function gitSetup(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return (result.stdout || "").trim();
}

/** Helper: create an initial commit in a temp repo. */
function initWithCommit(repo: string): void {
  writeFileSync(`${repo}/init.txt`, "init");
  gitSetup(repo, "add", ".");
  gitSetup(repo, "commit", "-m", "init", "--quiet");
}

describe("git.ts error handling", () => {
  registerCleanup();

  // ── Internal git() helper throws with descriptive message ──────────
  // Tested via gitCommit which delegates to git() and is NOT mocked elsewhere.

  describe("git() helper throws on failure", () => {
    it("throws Error with command name and stderr when git command fails", () => {
      const repo = setupTempRepo();
      // gitCommit with nothing staged triggers a non-zero exit and exercises
      // the internal git() throw path.
      expect(() => gitCommit(repo, "empty commit")).toThrow(
        /git commit failed/,
      );
    });

    it("error message includes exit code", () => {
      const repo = setupTempRepo();
      try {
        gitCommit(repo, "empty commit");
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/exit \d+/);
      }
    });

    it("error message includes stderr (may be empty if git writes to stdout)", () => {
      const repo = setupTempRepo();
      try {
        gitCommit(repo, "empty commit");
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const msg = (e as Error).message;
        // The message always includes 'git <cmd> failed (exit N): <stderr>'
        // stderr may be empty for some git errors (commit writes to stdout)
        expect(msg).toContain("git commit failed");
        expect(msg).toContain("exit");
      }
    });

    it("error message format matches 'git <subcommand> failed (exit N): ...'", () => {
      const repo = setupTempRepo();
      try {
        gitCommit(repo, "empty commit");
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/^git commit failed \(exit \d+\): /);
      }
    });
  });

  // ── branchExists() — mocked elsewhere, tested via run() ───────────
  // branchExists does: run("git", ["-C", repoRoot, "rev-parse", "--verify", branch])
  // and returns result.exitCode === 0.

  describe("branchExists() error handling (via run)", () => {
    it("returns false (non-zero exit) for a nonexistent branch", () => {
      const repo = setupTempRepo();
      const result = run("git", ["-C", repo, "rev-parse", "--verify", "nonexistent-branch"]);
      expect(result.exitCode).not.toBe(0);
      // branchExists would return: result.exitCode === 0 → false
    });

    it("returns false (non-zero exit) for an invalid ref", () => {
      const repo = setupTempRepo();
      const result = run("git", ["-C", repo, "rev-parse", "--verify", "refs/heads/no-such-ref"]);
      expect(result.exitCode).not.toBe(0);
    });

    it("returns true (exit 0) for an existing branch", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const branch = gitSetup(repo, "branch", "--show-current");
      const result = run("git", ["-C", repo, "rev-parse", "--verify", branch]);
      expect(result.exitCode).toBe(0);
    });
  });

  // ── commitCount() — NOT mocked, tested directly ───────────────────

  describe("commitCount()", () => {
    it("returns 0 when rev-list fails (invalid refs)", () => {
      const repo = setupTempRepo();
      expect(commitCount(repo, "nonexistent-a", "nonexistent-b")).toBe(0);
    });

    it("returns 0 for an empty range", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      expect(commitCount(repo, "HEAD", "HEAD")).toBe(0);
    });

    it("returns correct count for valid range", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const first = gitSetup(repo, "rev-parse", "HEAD");
      writeFileSync(`${repo}/b.txt`, "b");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "second", "--quiet");
      expect(commitCount(repo, first, "HEAD")).toBe(1);
    });
  });

  // ── diffStat() — NOT mocked, tested directly ─────────────────────

  describe("diffStat()", () => {
    it("returns {insertions: 0, deletions: 0} on failure (invalid range)", () => {
      const repo = setupTempRepo();
      const result = diffStat(repo, "nonexistent..also-nonexistent", []);
      expect(result).toEqual({ insertions: 0, deletions: 0 });
    });

    it("returns {insertions: 0, deletions: 0} when diff has no output", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const result = diffStat(repo, "HEAD..HEAD", []);
      expect(result).toEqual({ insertions: 0, deletions: 0 });
    });

    it("returns correct counts for a valid diff", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const first = gitSetup(repo, "rev-parse", "HEAD");
      writeFileSync(`${repo}/file.txt`, "line1\nline2\nline3\n");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "add lines", "--quiet");
      const result = diffStat(repo, `${first}..HEAD`, []);
      expect(result.insertions).toBe(3);
      expect(result.deletions).toBe(0);
    });

    it("filters by file extension", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const first = gitSetup(repo, "rev-parse", "HEAD");
      writeFileSync(`${repo}/code.ts`, "const x = 1;\n");
      writeFileSync(`${repo}/readme.md`, "# Hello\n");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "add files", "--quiet");
      // Only count .ts files
      const result = diffStat(repo, `${first}..HEAD`, ["*.ts"]);
      expect(result.insertions).toBe(1);
      expect(result.deletions).toBe(0);
    });
  });

  // ── getStagedFiles() — NOT mocked, tested directly ────────────────

  describe("getStagedFiles()", () => {
    it("returns empty array when diff --cached fails (invalid repo path)", () => {
      const result = getStagedFiles("/nonexistent/path/that/cannot/exist");
      expect(result).toEqual([]);
    });

    it("returns empty array when nothing is staged", () => {
      const repo = setupTempRepo();
      expect(getStagedFiles(repo)).toEqual([]);
    });

    it("returns staged file paths", () => {
      const repo = setupTempRepo();
      writeFileSync(`${repo}/staged.txt`, "data");
      gitSetup(repo, "add", "staged.txt");
      const files = getStagedFiles(repo);
      expect(files).toContain("staged.txt");
    });
  });

  // ── isBranchMerged() — mocked elsewhere, tested via run() ────────
  // isBranchMerged does: run("git", ["-C", repoRoot, "branch", "--merged", into])
  // returns false if exitCode !== 0, else checks if branch is in stdout.

  describe("isBranchMerged() error handling (via run)", () => {
    it("returns non-zero exit for invalid target ref", () => {
      const repo = setupTempRepo();
      const result = run("git", ["-C", repo, "branch", "--merged", "nonexistent-target"]);
      expect(result.exitCode).not.toBe(0);
      // isBranchMerged would return false on non-zero exit
    });
  });

  // ── fetchOrigin() — mocked elsewhere, tested via run() ────────────
  // fetchOrigin does: run("git", ["-C", repoRoot, "fetch", "origin", branch, "--quiet"])
  // throws if exitCode !== 0.

  describe("fetchOrigin() error handling (via run)", () => {
    it("returns non-zero exit when no remote configured", () => {
      const repo = setupTempRepo();
      const result = run("git", ["-C", repo, "fetch", "origin", "main", "--quiet"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      // fetchOrigin would throw: `fetch origin main failed: ${result.stderr}`
    });
  });

  // ── ffMerge() — mocked elsewhere, tested via run() ────────────────
  // ffMerge does: run("git", ["-C", repoRoot, "merge", "--ff-only", `origin/${branch}`, "--quiet"])
  // throws if exitCode !== 0.

  describe("ffMerge() error handling (via run)", () => {
    it("returns non-zero exit when remote ref does not exist", () => {
      const repo = setupTempRepo();
      const result = run("git", ["-C", repo, "merge", "--ff-only", "origin/main", "--quiet"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      // ffMerge would throw: `ff-merge main failed: ${result.stderr}`
    });
  });

  // ── getProjectRoot() — NOT mocked, tested directly ────────────────

  describe("getProjectRoot()", () => {
    it("returns a valid path from inside a git repository", () => {
      const root = getProjectRoot();
      expect(typeof root).toBe("string");
      expect(root.length).toBeGreaterThan(0);
    });

    it("throws when run outside a git repo (via run pattern)", () => {
      // getProjectRoot calls run("git", ["rev-parse", ...]) and throws
      // "Not inside a git repository" on non-zero exit. Verify the git
      // command fails outside a repo.
      const result = run("git", [
        "-C",
        "/tmp",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ── hasChanges() — NOT mocked, tested directly ────────────────────

  describe("hasChanges()", () => {
    it("returns false in a clean repo", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      expect(hasChanges(repo, ".")).toBe(false);
    });

    it("returns true when there are uncommitted changes", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      writeFileSync(`${repo}/init.txt`, "changed");
      expect(hasChanges(repo, ".")).toBe(true);
    });
  });

  // ── rebaseOnto() — NOT mocked, tested directly ──────────────────

  describe("rebaseOnto()", () => {
    it("replays only dependent commits after a squash merge (no duplicate commits)", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);

      // Create branch A with a commit
      gitSetup(repo, "checkout", "-b", "todo/A");
      writeFileSync(`${repo}/a.txt`, "feature A");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "A: add feature", "--quiet");
      const tipA = gitSetup(repo, "rev-parse", "HEAD");

      // Create branch B stacked on A with its own commit
      gitSetup(repo, "checkout", "-b", "todo/B");
      writeFileSync(`${repo}/b.txt`, "feature B");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "B: add feature", "--quiet");

      // Simulate squash-merge of A into main
      gitSetup(repo, "checkout", "main");
      gitSetup(repo, "merge", "--squash", "todo/A");
      gitSetup(repo, "commit", "-m", "squash: A", "--quiet");

      // Now rebase B onto main, skipping A's commits
      const success = rebaseOnto(repo, "main", tipA, "todo/B");
      expect(success).toBe(true);

      // Verify B is now on main and has only its own commit (not A's)
      gitSetup(repo, "checkout", "todo/B");
      const log = gitSetup(repo, "log", "--oneline", "main..todo/B");
      const commits = log.split("\n").filter(Boolean);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toContain("B: add feature");
    });

    it("returns true on a clean rebase with no conflicts", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);

      // Create a branch with a non-conflicting change
      gitSetup(repo, "checkout", "-b", "feature");
      writeFileSync(`${repo}/feature.txt`, "new feature");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "add feature", "--quiet");

      // Add a commit to main that doesn't conflict
      gitSetup(repo, "checkout", "main");
      writeFileSync(`${repo}/other.txt`, "other change");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "other change", "--quiet");
      const oldBase = gitSetup(repo, "rev-parse", "main~1");

      const success = rebaseOnto(repo, "main", oldBase, "feature");
      expect(success).toBe(true);
    });

    it("returns false on conflict and aborts cleanly", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);

      const base = gitSetup(repo, "rev-parse", "HEAD");

      // Create branch with a change to init.txt
      gitSetup(repo, "checkout", "-b", "conflicting");
      writeFileSync(`${repo}/init.txt`, "branch version");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "branch change", "--quiet");

      // Make a conflicting change on main
      gitSetup(repo, "checkout", "main");
      writeFileSync(`${repo}/init.txt`, "main version");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "main change", "--quiet");

      const success = rebaseOnto(repo, "main", base, "conflicting");
      expect(success).toBe(false);

      // Verify rebase was aborted cleanly — no rebase-apply or rebase-merge dirs
      const rebaseApply = run("git", ["-C", repo, "rev-parse", "--git-path", "rebase-apply"]);
      const rebaseMerge = run("git", ["-C", repo, "rev-parse", "--git-path", "rebase-merge"]);

      // The paths are returned but shouldn't exist as directories
      const { existsSync } = require("fs");
      expect(existsSync(rebaseApply.stdout)).toBe(false);
      expect(existsSync(rebaseMerge.stdout)).toBe(false);
    });
  });

  // ── createWorktree() startPoint — mocked elsewhere, tested via run() ──

  describe("createWorktree() startPoint (via run)", () => {
    it("creates a worktree from a specified start point (not HEAD)", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);

      // Make a second commit so HEAD differs from the first commit
      const firstCommit = gitSetup(repo, "rev-parse", "HEAD");
      writeFileSync(`${repo}/second.txt`, "second");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "second commit", "--quiet");

      // Create worktree from the first commit (not HEAD)
      const worktreePath = `${repo}-worktree`;
      const result = run("git", [
        "-C", repo,
        "worktree", "add", worktreePath, "-b", "test-branch", firstCommit,
      ]);
      expect(result.exitCode).toBe(0);

      // Verify the worktree's HEAD matches the first commit, not the second
      const wtHead = run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
      expect(wtHead.stdout).toBe(firstCommit);

      // Cleanup worktree
      run("git", ["-C", repo, "worktree", "remove", worktreePath, "--force"]);
    });

    it("defaults to HEAD when no startPoint is provided (backward-compatible)", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);

      const headCommit = gitSetup(repo, "rev-parse", "HEAD");

      // Create worktree using default startPoint (HEAD)
      const worktreePath = `${repo}-worktree-default`;
      const result = run("git", [
        "-C", repo,
        "worktree", "add", worktreePath, "-b", "default-branch", "HEAD",
      ]);
      expect(result.exitCode).toBe(0);

      // Verify it starts from HEAD
      const wtHead = run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
      expect(wtHead.stdout).toBe(headCommit);

      // Cleanup worktree
      run("git", ["-C", repo, "worktree", "remove", worktreePath, "--force"]);
    });
  });
});
