import { run } from "./shell.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature — injectable for testing. */
type ShellRunner = (cmd: string, args: string[]) => RunResult;

function git(repoRoot: string, args: string[]): string {
  const result = run("git", ["-C", repoRoot, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Get the project root by resolving git-common-dir. */
export function getProjectRoot(): string {
  const result = run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) {
    throw new Error("Not inside a git repository");
  }
  // .git-common-dir returns the .git dir; strip trailing /.git
  return result.stdout.replace(/\/.git$/, "");
}

/** Create a git worktree at worktreePath on a new branch. */
export function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  startPoint: string = "HEAD",
): void {
  git(repoRoot, ["worktree", "add", worktreePath, "-b", branchName, startPoint]);
}

/** Attach a worktree to an existing branch (no -b flag). */
export function attachWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): void {
  git(repoRoot, ["worktree", "add", worktreePath, branchName]);
}

/** Remove a git worktree. */
export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false,
): void {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  git(repoRoot, args);
}

/** Fetch a branch from origin. */
export function fetchOrigin(repoRoot: string, branch: string): void {
  const result = run("git", [
    "-C",
    repoRoot,
    "fetch",
    "origin",
    branch,
    "--quiet",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`fetch origin ${branch} failed: ${result.stderr}`);
  }
}

/** Fast-forward merge a branch. */
export function ffMerge(repoRoot: string, branch: string): void {
  const result = run("git", [
    "-C",
    repoRoot,
    "merge",
    "--ff-only",
    `origin/${branch}`,
    "--quiet",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`ff-merge ${branch} failed: ${result.stderr}`);
  }
}

/** Check if a local branch exists. */
export function branchExists(repoRoot: string, branch: string): boolean {
  const result = run("git", [
    "-C",
    repoRoot,
    "rev-parse",
    "--verify",
    branch,
  ]);
  return result.exitCode === 0;
}

/** Delete a local branch (force). */
export function deleteBranch(repoRoot: string, branch: string): void {
  git(repoRoot, ["branch", "-D", branch]);
}

/**
 * Find the worktree path that has a given branch checked out.
 * Returns the worktree path, or null if no worktree has this branch.
 *
 * Uses `git worktree list --porcelain` to discover all worktrees,
 * including those created by external tools (e.g., `.claude/worktrees/`).
 */
export function findWorktreeForBranch(repoRoot: string, branch: string): string | null {
  const result = run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) return null;

  // Porcelain output groups entries separated by blank lines.
  // Each group has: worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>
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

/** Patterns that indicate the remote branch was already deleted.
 *  Covers known git stderr formats across versions and transports. */
export const REMOTE_REF_GONE_RE =
  /remote ref does not exist|remote ref .*not found|unable to delete '.*': remote ref/i;

/** Delete a remote branch. Treats "remote ref does not exist" as success
 *  (the branch was already deleted, e.g. by GitHub's auto-delete setting). */
export function deleteRemoteBranch(repoRoot: string, branch: string): void {
  const result = run("git", ["-C", repoRoot, "push", "origin", "--delete", branch]);
  if (result.exitCode === 0) return;

  // GitHub auto-delete head branches: branch is already gone.
  // Check both stderr and stdout -- some git versions or SSH transports
  // may split output across streams.
  const output = `${result.stderr}\n${result.stdout}`;
  if (REMOTE_REF_GONE_RE.test(output)) return;

  throw new Error(
    `git push failed (exit ${result.exitCode}): ${result.stderr}`,
  );
}

/** Check if a branch has been merged into another branch. */
export function isBranchMerged(
  repoRoot: string,
  branch: string,
  into: string,
): boolean {
  const result = run("git", [
    "-C",
    repoRoot,
    "branch",
    "--merged",
    into,
  ]);
  if (result.exitCode !== 0) return false;
  return result.stdout.split("\n").some((line) => line.trim() === branch);
}

/** Count commits between two refs. */
export function commitCount(
  repoRoot: string,
  from: string,
  to: string,
): number {
  const result = run("git", [
    "-C",
    repoRoot,
    "rev-list",
    "--count",
    `${from}..${to}`,
  ]);
  if (result.exitCode !== 0) return 0;
  return parseInt(result.stdout, 10) || 0;
}

/** Stage files in the index. */
export function gitAdd(repoRoot: string, files: string[]): void {
  git(repoRoot, ["add", ...files]);
}

/** Unstage files from the index (git reset -- <files>). */
export function gitReset(repoRoot: string, files: string[]): void {
  git(repoRoot, ["reset", "--", ...files]);
}

/** Create a commit with the given message. */
export function gitCommit(repoRoot: string, message: string): void {
  git(repoRoot, ["commit", "-m", message]);
}

/** Push to origin. */
export function gitPush(repoRoot: string): void {
  git(repoRoot, ["push", "--quiet"]);
}

/** Get the current branch name. */
export function getCurrentBranch(repoRoot: string): string {
  return git(repoRoot, ["branch", "--show-current"]);
}

/** Get one-line log for a range. */
export function logOneline(repoRoot: string, range: string): string {
  return git(repoRoot, ["log", "--oneline", range]);
}

/** Check if a pathspec has uncommitted changes (staged, unstaged, or untracked). */
export function hasChanges(repoRoot: string, pathspec: string): boolean {
  const result = run("git", ["-C", repoRoot, "status", "--porcelain", "--", pathspec]);
  return result.exitCode === 0 && !!result.stdout;
}

/** Get the list of staged file paths (relative to repo root). */
export function getStagedFiles(repoRoot: string): string[] {
  const result = run("git", ["-C", repoRoot, "diff", "--cached", "--name-only"]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").filter(Boolean);
}

/** Get insertions/deletions for a range, filtered by file extensions. */
export function diffStat(
  repoRoot: string,
  range: string,
  extensions: string[],
): { insertions: number; deletions: number } {
  const args = ["-C", repoRoot, "diff", "--stat", range];
  if (extensions.length > 0) {
    args.push("--");
    args.push(...extensions);
  }
  const result = run("git", args);
  if (result.exitCode !== 0 || !result.stdout) {
    return { insertions: 0, deletions: 0 };
  }

  // The last line of --stat output has the summary
  const lines = result.stdout.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";

  let insertions = 0;
  let deletions = 0;
  const insMatch = lastLine.match(/(\d+) insertion/);
  if (insMatch) insertions = parseInt(insMatch[1]!, 10);
  const delMatch = lastLine.match(/(\d+) deletion/);
  if (delMatch) deletions = parseInt(delMatch[1]!, 10);

  return { insertions, deletions };
}

/**
 * Daemon-side rebase: fetch latest main, rebase the branch onto origin/main,
 * and force-push with --force-with-lease.
 *
 * Operates via `git -C repoRoot` using the branch that's already checked out
 * in a worktree. The caller should pass the worktree path as repoRoot so the
 * rebase runs in the correct working tree without disrupting the main checkout.
 *
 * If the rebase encounters conflicts, aborts and returns false so the caller
 * can fall back to a worker rebase.
 *
 * Returns true on success, false on failure.
 */
export function daemonRebase(repoRoot: string, branch: string): boolean {
  // Fetch latest main
  const fetchMain = run("git", ["-C", repoRoot, "fetch", "origin", "main", "--quiet"]);
  if (fetchMain.exitCode !== 0) return false;

  // Attempt the rebase
  const rebaseResult = run("git", ["-C", repoRoot, "rebase", "origin/main"]);

  if (rebaseResult.exitCode !== 0) {
    // Rebase failed -- abort and fall back to worker
    run("git", ["-C", repoRoot, "rebase", "--abort"]);
    return false;
  }

  // Force-push with lease for safety
  const pushResult = run("git", ["-C", repoRoot, "push", "--force-with-lease", "origin", branch]);
  if (pushResult.exitCode !== 0) return false;

  return true;
}

/**
 * Squash-merge-safe rebase using `git rebase --onto`.
 *
 * Replays only the commits from `oldBase..branch` onto `newBase`.
 * This avoids duplicate commits when `oldBase` was squash-merged into `newBase`.
 *
 * Example: branch B stacked on branch A, A gets squash-merged to main.
 *   rebaseOnto(worktreePath, "main", "ninthwave/A", "ninthwave/B")
 * replays only B's unique commits onto main, skipping A's commits entirely.
 *
 * Returns true on success, false on conflict (with clean abort).
 */
export function rebaseOnto(
  worktreePath: string,
  newBase: string,
  oldBase: string,
  branch: string,
): boolean {
  const result = run("git", [
    "-C", worktreePath,
    "rebase", "--onto", newBase, oldBase, branch,
  ]);

  if (result.exitCode !== 0) {
    // Rebase failed (likely conflicts) -- abort cleanly
    run("git", ["-C", worktreePath, "rebase", "--abort"]);
    return false;
  }

  return true;
}

/**
 * Get the set of work item file basenames that exist on origin/main
 * and have no local modifications (uncommitted, committed-but-not-pushed,
 * or locally modified).
 *
 * Returns null when origin/main doesn't exist (graceful degradation for
 * repos without a remote or on initial setup).
 *
 * Uses `git ls-tree` for the inclusion set and `git diff origin/main`
 * for the exclusion set. If the diff command fails, returns the full
 * remote set without exclusions (safe fallback).
 */
export function getCleanRemoteWorkItemFiles(
  repoRoot: string,
  shellRun: ShellRunner = (cmd, args) => run(cmd, args),
): Set<string> | null {
  // Inclusion set: files that exist on origin/main
  const lsTree = shellRun("git", [
    "-C", repoRoot,
    "ls-tree", "--name-only", "origin/main", ".ninthwave/work/",
  ]);

  if (lsTree.exitCode !== 0) {
    // origin/main doesn't exist — graceful degradation
    return null;
  }

  const remoteFiles = new Set<string>();
  for (const line of lsTree.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Extract basename from path like ".ninthwave/work/filename.md"
    const lastSlash = trimmed.lastIndexOf("/");
    remoteFiles.add(lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed);
  }

  if (remoteFiles.size === 0) return new Set();

  // Exclusion set: files that differ between origin/main and working tree
  const diff = shellRun("git", [
    "-C", repoRoot,
    "diff", "origin/main", "--name-only", "--", ".ninthwave/work/",
  ]);

  if (diff.exitCode !== 0) {
    // Diff failed — return remote set without exclusions (safe fallback)
    return remoteFiles;
  }

  for (const line of diff.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lastSlash = trimmed.lastIndexOf("/");
    const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
    remoteFiles.delete(basename);
  }

  return remoteFiles;
}
