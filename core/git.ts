import { run } from "./shell.ts";

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
): void {
  git(repoRoot, ["worktree", "add", worktreePath, "-b", branchName, "HEAD"]);
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

/** Delete a remote branch. */
export function deleteRemoteBranch(repoRoot: string, branch: string): void {
  git(repoRoot, ["push", "origin", "--delete", branch]);
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
