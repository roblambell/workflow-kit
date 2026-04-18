import { run } from "./shell.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature -- injectable for testing. */
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

/** Hard-reset a worktree's HEAD to a git ref (e.g. `origin/<branch>`). */
export function resetHard(worktreePath: string, ref: string): void {
  const result = run("git", [
    "-C",
    worktreePath,
    "reset",
    "--hard",
    ref,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `reset --hard ${ref} in ${worktreePath} failed: ${result.stderr}`,
    );
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

  // Fetch the branch itself so local tracking ref is current (a worker may
  // have pushed since the last fetch, and without this the rebase would
  // operate on stale local state).
  const fetchBranch = run("git", ["-C", repoRoot, "fetch", "origin", branch, "--quiet"]);
  if (fetchBranch.exitCode !== 0) return false;

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
 * Force-push the current branch in a worktree using --force-with-lease.
 * Returns true on success, false on failure.
 */
export function forcePush(worktreePath: string): boolean {
  const result = run("git", ["-C", worktreePath, "push", "--force-with-lease"]);
  return result.exitCode === 0;
}

/**
 * Resolve a git ref to its SHA. Returns null if the ref doesn't exist.
 */
export function resolveRef(repoRoot: string, ref: string): string | null {
  const result = run("git", ["-C", repoRoot, "rev-parse", ref]);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Check whether `repoRoot` is inside a git repository. Returns `false`
 * when the path is outside any git working tree or git-dir, which is the
 * predicate the origin-main-only readers use to decide whether to
 * fail-loud (inside a git repo but origin/main is missing -- a real
 * configuration error worth surfacing) or to fall back to the filesystem
 * (not a git repo at all -- almost always a unit test set up via
 * `mkdtempSync`, where enforcing git plumbing adds friction without
 * value).
 */
export function isInsideGitRepo(
  repoRoot: string,
  shellRun: ShellRunner = (cmd, args) => run(cmd, args),
): boolean {
  const result = shellRun("git", [
    "-C", repoRoot,
    "rev-parse", "--is-inside-work-tree",
  ]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/**
 * Check whether `origin/main` resolves to a SHA. Used as the precondition
 * probe for the origin-main-only readers below.
 */
export function originMainResolves(
  repoRoot: string,
  shellRun: ShellRunner = (cmd, args) => run(cmd, args),
): boolean {
  const result = shellRun("git", [
    "-C", repoRoot,
    "rev-parse", "--verify", "--quiet", "origin/main^{commit}",
  ]);
  return result.exitCode === 0;
}

/**
 * Build the actionable error message shown when `origin/main` does not
 * resolve. The message names the missing ref and spells out remediation so
 * the user can fix the precondition without digging into the code.
 */
export function originMainMissingMessage(context: string): string {
  return (
    `${context} requires origin/main to resolve, but it does not. ` +
    `Configure a remote named \`origin\` (e.g. \`git remote add origin <url>\`) ` +
    `and push your main branch at least once (\`git push -u origin main\`) so ` +
    `ninthwave can read work items and config from origin/main.`
  );
}

/**
 * Assert that `origin/main` resolves. Throws with an actionable error that
 * names the missing ref and the remediation when it does not. Callers pass
 * a short `context` label (e.g. "listWorkItems", "loadConfig", "nw init")
 * which is prepended to the message for debuggability.
 */
export function assertOriginMain(
  repoRoot: string,
  context: string,
  shellRun: ShellRunner = (cmd, args) => run(cmd, args),
): void {
  if (!originMainResolves(repoRoot, shellRun)) {
    throw new Error(originMainMissingMessage(context));
  }
}

/**
 * List files under a repo-relative prefix on `origin/main` via
 * `git ls-tree`. Returns the repo-relative paths (e.g.
 * `.ninthwave/work/1-foo--H-1-1.md`). Throws when `origin/main` does not
 * resolve. Returns an empty array when the prefix has no files on
 * origin/main.
 */
export function listOriginMainFiles(
  repoRoot: string,
  prefix: string,
  context: string = "listOriginMainFiles",
  shellRun: ShellRunner = (cmd, args) => run(cmd, args),
): string[] {
  assertOriginMain(repoRoot, context, shellRun);

  const result = shellRun("git", [
    "-C", repoRoot,
    "ls-tree", "-r", "--name-only", "origin/main", "--", prefix,
  ]);
  if (result.exitCode !== 0) {
    // origin/main resolves but ls-tree failed for some other reason (e.g.
    // bogus prefix). Treat as "no files" rather than throwing; empty set
    // is the natural reading of "no files match this path on origin/main".
    return [];
  }
  const paths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    paths.push(trimmed);
  }
  return paths;
}

/**
 * Read a single file's contents from `origin/main` via `git show`. Returns
 * the file's content as a string, or `null` if the file does not exist on
 * origin/main. Throws when `origin/main` itself does not resolve.
 */
export function readOriginMainFile(
  repoRoot: string,
  relPath: string,
  context: string = "readOriginMainFile",
  shellRun: ShellRunner = (cmd, args) => run(cmd, args),
): string | null {
  assertOriginMain(repoRoot, context, shellRun);

  const result = shellRun("git", [
    "-C", repoRoot,
    "show", `origin/main:${relPath}`,
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Auto-save uncommitted changes in a worktree before session respawn.
 *
 * Checks `git status --porcelain` -- if the working tree is dirty, stages all
 * changes, commits with a WIP message, and pushes. Clean worktrees are skipped
 * (no empty commits). All git failures return false so the caller can treat
 * this as best-effort.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param shellRun - Injectable shell runner for testing (defaults to run)
 * @returns true if changes were saved (or worktree was clean), false on git error
 */
export function autoSaveWorktree(
  worktreePath: string,
  shellRun: ShellRunner = run,
): boolean {
  // Check for uncommitted changes (staged, unstaged, untracked)
  const status = shellRun("git", ["-C", worktreePath, "status", "--porcelain"]);
  if (status.exitCode !== 0) return false;
  if (!status.stdout) return true; // Clean worktree -- nothing to save

  // Stage all changes
  const add = shellRun("git", ["-C", worktreePath, "add", "-A"]);
  if (add.exitCode !== 0) return false;

  // Commit with descriptive message
  const commit = shellRun("git", ["-C", worktreePath, "commit", "-m", "wip: ninthwave auto-save before respawn"]);
  if (commit.exitCode !== 0) return false;

  // Push to remote
  const push = shellRun("git", ["-C", worktreePath, "push", "--quiet"]);
  if (push.exitCode !== 0) return false;

  return true;
}
