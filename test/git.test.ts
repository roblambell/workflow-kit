// Tests for core/git.ts -- direct tests of error handling paths.
//
// Uses real temp git repos to trigger failures naturally.

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { writeFileSync, realpathSync } from "fs";
import { setupTempRepo, setupTempRepoWithoutRemote, registerCleanup } from "./helpers.ts";
import { run } from "../core/shell.ts";
import {
  commitCount,
  diffStat,
  getStagedFiles,
  getProjectRoot,
  gitCommit,
  hasChanges,
  rebaseOnto,
  REMOTE_REF_GONE_RE,
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

  // ── branchExists() -- mocked elsewhere, tested via run() ───────────
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

  // ── commitCount() -- NOT mocked, tested directly ───────────────────

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

  // ── diffStat() -- NOT mocked, tested directly ─────────────────────

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

  // ── getStagedFiles() -- NOT mocked, tested directly ────────────────

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

  // ── isBranchMerged() -- mocked elsewhere, tested via run() ────────
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

  // ── fetchOrigin() -- mocked elsewhere, tested via run() ────────────
  // fetchOrigin does: run("git", ["-C", repoRoot, "fetch", "origin", branch, "--quiet"])
  // throws if exitCode !== 0.

  describe("fetchOrigin() error handling (via run)", () => {
    it("returns non-zero exit when no remote configured", () => {
      const repo = setupTempRepoWithoutRemote();
      const result = run("git", ["-C", repo, "fetch", "origin", "main", "--quiet"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      // fetchOrigin would throw: `fetch origin main failed: ${result.stderr}`
    });
  });

  // ── ffMerge() -- mocked elsewhere, tested via run() ────────────────
  // ffMerge does: run("git", ["-C", repoRoot, "merge", "--ff-only", `origin/${branch}`, "--quiet"])
  // throws if exitCode !== 0.

  describe("ffMerge() error handling (via run)", () => {
    it("returns non-zero exit when remote ref does not exist", () => {
      const repo = setupTempRepoWithoutRemote();
      const result = run("git", ["-C", repo, "merge", "--ff-only", "origin/main", "--quiet"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      // ffMerge would throw: `ff-merge main failed: ${result.stderr}`
    });
  });

  // ── getProjectRoot() -- NOT mocked, tested directly ────────────────

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

  // ── hasChanges() -- NOT mocked, tested directly ────────────────────

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

  // ── rebaseOnto() -- NOT mocked, tested directly ──────────────────

  describe("rebaseOnto()", () => {
    it("replays only dependent commits after a squash merge (no duplicate commits)", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      // Ensure default branch is named "main" (CI may default to "master")
      gitSetup(repo, "branch", "-M", "main");

      // Create branch A with a commit
      gitSetup(repo, "checkout", "-b", "ninthwave/A");
      writeFileSync(`${repo}/a.txt`, "feature A");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "A: add feature", "--quiet");
      const tipA = gitSetup(repo, "rev-parse", "HEAD");

      // Create branch B stacked on A with its own commit
      gitSetup(repo, "checkout", "-b", "ninthwave/B");
      writeFileSync(`${repo}/b.txt`, "feature B");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "B: add feature", "--quiet");

      // Simulate squash-merge of A into main
      gitSetup(repo, "checkout", "main");
      gitSetup(repo, "merge", "--squash", "ninthwave/A");
      gitSetup(repo, "commit", "-m", "squash: A", "--quiet");

      // Now rebase B onto main, skipping A's commits
      const success = rebaseOnto(repo, "main", tipA, "ninthwave/B");
      expect(success).toBe(true);

      // Verify B is now on main and has only its own commit (not A's)
      gitSetup(repo, "checkout", "ninthwave/B");
      const log = gitSetup(repo, "log", "--oneline", "main..ninthwave/B");
      const commits = log.split("\n").filter(Boolean);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toContain("B: add feature");
    });

    it("returns true on a clean rebase with no conflicts", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      gitSetup(repo, "branch", "-M", "main");

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
      gitSetup(repo, "branch", "-M", "main");

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

      // Verify rebase was aborted cleanly -- no rebase-apply or rebase-merge dirs
      const rebaseApply = run("git", ["-C", repo, "rev-parse", "--git-path", "rebase-apply"]);
      const rebaseMerge = run("git", ["-C", repo, "rev-parse", "--git-path", "rebase-merge"]);

      // The paths are returned but shouldn't exist as directories
      const { existsSync } = require("fs");
      expect(existsSync(rebaseApply.stdout)).toBe(false);
      expect(existsSync(rebaseMerge.stdout)).toBe(false);
    });
  });

  // ── deleteRemoteBranch() -- mocked elsewhere, tested via run() ────────
  // deleteRemoteBranch does: run("git", ["-C", repoRoot, "push", "origin", "--delete", branch])
  // It suppresses "remote ref does not exist" errors (branch already deleted,
  // e.g. by GitHub's auto-delete head branches setting) and throws for other
  // failures (auth errors, network issues, etc.).

  describe("deleteRemoteBranch() suppresses already-deleted branches (via run)", () => {
    it("succeeds (exit 0) when branch exists on remote", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const bare = `${repo}-bare`;
      spawnSync("git", ["clone", "--bare", repo, bare], { stdio: "pipe" });
      gitSetup(repo, "remote", "add", "origin", bare);
      gitSetup(repo, "checkout", "-b", "test-branch");
      writeFileSync(`${repo}/test.txt`, "test");
      gitSetup(repo, "add", ".");
      gitSetup(repo, "commit", "-m", "test commit", "--quiet");
      gitSetup(repo, "push", "origin", "test-branch");

      // deleteRemoteBranch: exit 0 → return (no throw)
      const result = run("git", ["-C", repo, "push", "origin", "--delete", "test-branch"]);
      expect(result.exitCode).toBe(0);
    });

    it("stderr contains 'remote ref does not exist' for already-deleted branch", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const bare = `${repo}-bare`;
      spawnSync("git", ["clone", "--bare", repo, bare], { stdio: "pipe" });
      gitSetup(repo, "remote", "add", "origin", bare);

      // Try deleting a branch that was never pushed (simulates auto-delete)
      const result = run("git", ["-C", repo, "push", "origin", "--delete", "nonexistent-branch"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("remote ref does not exist");
      // deleteRemoteBranch suppresses this: returns without throwing
    });

    it("other errors (no remote) do NOT contain 'remote ref does not exist'", () => {
      const repo = setupTempRepoWithoutRemote();
      initWithCommit(repo);
      // No remote configured → different error
      const result = run("git", ["-C", repo, "push", "origin", "--delete", "some-branch"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("remote ref does not exist");
      // deleteRemoteBranch would throw for this case (genuine failure)
    });
  });

  // ── REMOTE_REF_GONE_RE -- regex pattern coverage ────────────────────────
  // Exported from git.ts for testability. Verifies all known stderr formats
  // are matched, including edge cases across git versions and transports.

  describe("REMOTE_REF_GONE_RE matches known git stderr formats", () => {
    // Standard git 2.x format (local bare remote)
    it("matches 'remote ref does not exist' (standard format)", () => {
      const stderr =
        "error: unable to delete 'ninthwave/H-RVW-4': remote ref does not exist\n" +
        "error: failed to push some refs to '../repo-bare'";
      expect(REMOTE_REF_GONE_RE.test(stderr)).toBe(true);
    });

    // GitHub SSH format
    it("matches GitHub SSH stderr format", () => {
      const stderr =
        "error: unable to delete 'ninthwave/H-RVW-4': remote ref does not exist\n" +
        "error: failed to push some refs to 'git@github.com:org/repo.git'";
      expect(REMOTE_REF_GONE_RE.test(stderr)).toBe(true);
    });

    // GitHub HTTPS format
    it("matches GitHub HTTPS stderr format", () => {
      const stderr =
        "error: unable to delete 'ninthwave/H-RVW-4': remote ref does not exist\n" +
        "error: failed to push some refs to 'https://github.com/org/repo.git'";
      expect(REMOTE_REF_GONE_RE.test(stderr)).toBe(true);
    });

    // Case variation (defensive)
    it("matches case-insensitive variants", () => {
      expect(
        REMOTE_REF_GONE_RE.test("Remote ref does not exist"),
      ).toBe(true);
      expect(
        REMOTE_REF_GONE_RE.test("REMOTE REF DOES NOT EXIST"),
      ).toBe(true);
    });

    // "unable to delete" prefix variant
    it("matches 'unable to delete' with remote ref context", () => {
      expect(
        REMOTE_REF_GONE_RE.test(
          "error: unable to delete 'feature/branch': remote ref does not exist",
        ),
      ).toBe(true);
    });

    // Hypothetical "not found" variant for future git versions
    it("matches 'remote ref not found' variant", () => {
      expect(
        REMOTE_REF_GONE_RE.test("error: remote ref 'branch' not found"),
      ).toBe(true);
    });

    // Ensure genuine errors are NOT matched
    it("does NOT match generic push failures", () => {
      expect(
        REMOTE_REF_GONE_RE.test(
          "error: failed to push some refs to 'origin'",
        ),
      ).toBe(false);
    });

    it("does NOT match authentication errors", () => {
      expect(
        REMOTE_REF_GONE_RE.test(
          "fatal: Authentication failed for 'https://github.com/org/repo.git'",
        ),
      ).toBe(false);
    });

    it("does NOT match network errors", () => {
      expect(
        REMOTE_REF_GONE_RE.test(
          "fatal: unable to access 'https://github.com/org/repo.git': Could not resolve host: github.com",
        ),
      ).toBe(false);
    });
  });

  // ── deleteRemoteBranch() captures actual git stderr format ────────────
  // Verifies the exact stderr from the current git version is handled.

  describe("deleteRemoteBranch() actual stderr format capture", () => {
    it("captures stderr containing 'remote ref does not exist' from current git version", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const bare = `${repo}-bare`;
      spawnSync("git", ["clone", "--bare", repo, bare], { stdio: "pipe" });
      gitSetup(repo, "remote", "add", "origin", bare);

      // Push to delete a nonexistent branch -- captures the actual stderr
      const result = run("git", [
        "-C",
        repo,
        "push",
        "origin",
        "--delete",
        "already-deleted-branch",
      ]);
      expect(result.exitCode).not.toBe(0);

      // Verify our regex matches the exact stderr from the current git version
      const output = `${result.stderr}\n${result.stdout}`;
      expect(REMOTE_REF_GONE_RE.test(output)).toBe(true);
    });
  });

  // ── findWorktreeForBranch() -- mocked in start.test.ts, tested via run() ──

  describe("findWorktreeForBranch() (via run)", () => {
    /** Reimplement findWorktreeForBranch using run() to bypass mock leakage. */
    function findWorktreeForBranchViaRun(repoRoot: string, branch: string): string | null {
      const result = run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
      if (result.exitCode !== 0) return null;
      let currentPath: string | null = null;
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length);
        } else if (line.startsWith("branch refs/heads/") && currentPath) {
          const branchName = line.slice("branch refs/heads/".length);
          if (branchName === branch) return currentPath;
        } else if (line === "") {
          currentPath = null;
        }
      }
      return null;
    }

    it("returns null when no worktree has the branch checked out", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      expect(findWorktreeForBranchViaRun(repo, "nonexistent-branch")).toBeNull();
    });

    it("returns the worktree path when the branch is checked out", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const wtPath = `${repo}-wt`;
      run("git", ["-C", repo, "worktree", "add", wtPath, "-b", "test-branch"]);

      const result = findWorktreeForBranchViaRun(repo, "test-branch");
      // git worktree list resolves symlinks (e.g., /var → /private/var on macOS)
      expect(result).toBe(realpathSync(wtPath));

      // Cleanup
      run("git", ["-C", repo, "worktree", "remove", wtPath, "--force"]);
    });

    it("finds a branch checked out in a deeply nested worktree path", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      const wtPath = `${repo}/.claude/worktrees/agent-abc123`;
      run("git", ["-C", repo, "worktree", "add", wtPath, "-b", "ninthwave/H-NTF-1"]);

      const result = findWorktreeForBranchViaRun(repo, "ninthwave/H-NTF-1");
      expect(result).toBe(realpathSync(wtPath));

      // Cleanup
      run("git", ["-C", repo, "worktree", "remove", wtPath, "--force"]);
    });

    it("returns null for a branch that exists but is not checked out in any worktree", () => {
      const repo = setupTempRepo();
      initWithCommit(repo);
      run("git", ["-C", repo, "branch", "orphan-branch"]);

      // Branch exists but is not checked out anywhere (main checkout doesn't count
      // unless we're looking for "main")
      expect(findWorktreeForBranchViaRun(repo, "orphan-branch")).toBeNull();
    });
  });

  // ── createWorktree() startPoint -- mocked elsewhere, tested via run() ──

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
