// reconcile command: synchronize TODOS.md with GitHub PR state and clean stale worktrees.

import { existsSync, readFileSync, readdirSync } from "fs";
import { info, warn, GREEN, RESET } from "../output.ts";
import { run } from "../shell.ts";
import { cmdMarkDone } from "./mark-done.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { ID_IN_PARENS } from "../types.ts";

/**
 * Dependencies for reconcile, injectable for testing.
 */
export interface ReconcileDeps {
  /** Pull latest main with rebase. Returns { ok, conflict, error }. */
  pullRebase(projectRoot: string): { ok: boolean; conflict: boolean; error?: string };

  /** Get IDs of merged todo/* PRs from GitHub. */
  getMergedTodoIds(projectRoot: string): string[];

  /** Get IDs of items currently in TODOS.md. */
  getOpenTodoIds(todosFile: string): string[];

  /** Mark items as done in TODOS.md. */
  markDone(ids: string[], todosFile: string): void;

  /** List worktree IDs present in the worktree directory. */
  getWorktreeIds(worktreeDir: string): string[];

  /** Clean a single worktree. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;

  /** Stage, commit, and push TODOS.md changes. Returns true if committed. */
  commitAndPush(projectRoot: string, todosFile: string): boolean;
}

// --- Default implementations ---

function defaultPullRebase(projectRoot: string): { ok: boolean; conflict: boolean; error?: string } {
  const result = run("git", ["-C", projectRoot, "pull", "--rebase", "--quiet"]);
  if (result.exitCode === 0) {
    return { ok: true, conflict: false };
  }

  // Check if it's a merge conflict
  const isConflict = result.stderr.includes("CONFLICT") ||
    result.stderr.includes("could not apply") ||
    result.stderr.includes("Merge conflict");

  if (isConflict) {
    // Abort the failed rebase
    run("git", ["-C", projectRoot, "rebase", "--abort"]);

    // Try stash, pull, pop approach
    const stashResult = run("git", ["-C", projectRoot, "stash"]);
    if (stashResult.exitCode !== 0) {
      return { ok: false, conflict: true, error: "Failed to stash local changes" };
    }

    const retryResult = run("git", ["-C", projectRoot, "pull", "--rebase", "--quiet"]);
    if (retryResult.exitCode !== 0) {
      // Pop stash back to restore state
      run("git", ["-C", projectRoot, "stash", "pop"]);
      return { ok: false, conflict: true, error: `Pull failed after stash: ${retryResult.stderr}` };
    }

    const popResult = run("git", ["-C", projectRoot, "stash", "pop"]);
    if (popResult.exitCode !== 0) {
      return { ok: false, conflict: true, error: `Stash pop conflict: ${popResult.stderr}` };
    }

    return { ok: true, conflict: false };
  }

  return { ok: false, conflict: false, error: result.stderr };
}

function defaultGetMergedTodoIds(projectRoot: string): string[] {
  // List all merged PRs with todo/* head branches
  const result = run("gh", [
    "pr", "list",
    "--state", "merged",
    "--json", "headRefName",
    "--limit", "200",
  ], { cwd: projectRoot });

  if (result.exitCode !== 0 || !result.stdout) return [];

  try {
    const prs = JSON.parse(result.stdout) as Array<{ headRefName: string }>;
    const ids: string[] = [];
    for (const pr of prs) {
      if (pr.headRefName.startsWith("todo/")) {
        ids.push(pr.headRefName.slice(5)); // strip "todo/"
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function defaultGetOpenTodoIds(todosFile: string): string[] {
  if (!existsSync(todosFile)) return [];
  const content = readFileSync(todosFile, "utf-8");
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("### ")) continue;
    const match = line.match(ID_IN_PARENS);
    if (match) {
      ids.push(match[1]!);
    }
  }
  return ids;
}

function defaultMarkDone(ids: string[], todosFile: string): void {
  cmdMarkDone(ids, todosFile);
}

function defaultGetWorktreeIds(worktreeDir: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  try {
    return readdirSync(worktreeDir)
      .filter((e) => e.startsWith("todo-"))
      .map((e) => e.slice(5));
  } catch {
    return [];
  }
}

function defaultCleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean {
  return cleanSingleWorktree(id, worktreeDir, projectRoot);
}

function defaultCommitAndPush(projectRoot: string, todosFile: string): boolean {
  // Check if TODOS.md has changes
  const diffResult = run("git", ["-C", projectRoot, "diff", "--name-only", "TODOS.md"]);
  if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
    return false;
  }

  const addResult = run("git", ["-C", projectRoot, "add", "TODOS.md"]);
  if (addResult.exitCode !== 0) return false;

  const commitResult = run("git", ["-C", projectRoot, "commit", "-m", "chore: reconcile TODOS.md with merged PRs"]);
  if (commitResult.exitCode !== 0) return false;

  const pushResult = run("git", ["-C", projectRoot, "push", "--quiet"]);
  if (pushResult.exitCode !== 0) {
    warn(`Push failed: ${pushResult.stderr}`);
    return false;
  }

  return true;
}

/** Build default dependencies from real implementations. */
export function defaultDeps(): ReconcileDeps {
  return {
    pullRebase: defaultPullRebase,
    getMergedTodoIds: defaultGetMergedTodoIds,
    getOpenTodoIds: defaultGetOpenTodoIds,
    markDone: defaultMarkDone,
    getWorktreeIds: defaultGetWorktreeIds,
    cleanWorktree: defaultCleanWorktree,
    commitAndPush: defaultCommitAndPush,
  };
}

/**
 * Reconcile TODOS.md with GitHub PR state and clean stale worktrees.
 *
 * Steps:
 * 1. git pull --rebase to get latest main
 * 2. Query gh for merged todo/* PRs
 * 3. Mark merged items as done in TODOS.md
 * 4. Clean worktrees for done items
 * 5. Commit and push TODOS.md if changed
 */
export function reconcile(
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
  deps: ReconcileDeps = defaultDeps(),
): void {
  // Step 1: Pull latest
  info("Pulling latest main...");
  const pullResult = deps.pullRebase(projectRoot);
  if (!pullResult.ok) {
    if (pullResult.conflict) {
      warn(`Merge conflict during rebase: ${pullResult.error ?? "unknown"}`);
      warn("Resolve conflicts manually and re-run reconcile.");
    } else {
      warn(`Pull failed: ${pullResult.error ?? "unknown"}`);
    }
    return;
  }

  // Step 2: Get merged todo IDs from GitHub
  info("Querying GitHub for merged todo/* PRs...");
  const mergedIds = deps.getMergedTodoIds(projectRoot);
  if (mergedIds.length === 0) {
    info("No merged todo/* PRs found.");
  }

  // Step 3: Find items that are merged but still open in TODOS.md
  const openIds = new Set(deps.getOpenTodoIds(todosFile));
  const toMarkDone = mergedIds.filter((id) => openIds.has(id));

  if (toMarkDone.length > 0) {
    info(`Marking ${toMarkDone.length} merged item(s) as done: ${toMarkDone.join(", ")}`);
    deps.markDone(toMarkDone, todosFile);
  } else {
    info("All merged items already marked done.");
  }

  // Step 4: Clean worktrees for done items
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  // Done items = those we just marked done + those already not in TODOS.md
  const doneIds = new Set(mergedIds);
  let cleanedCount = 0;

  for (const wtId of worktreeIds) {
    if (doneIds.has(wtId)) {
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        cleanedCount++;
      }
    }
  }

  if (cleanedCount > 0) {
    info(`Cleaned ${cleanedCount} stale worktree(s).`);
  }

  // Step 5: Commit and push TODOS.md if changed
  if (toMarkDone.length > 0) {
    info("Committing and pushing TODOS.md...");
    if (deps.commitAndPush(projectRoot, todosFile)) {
      console.log(`${GREEN}Reconciled: marked ${toMarkDone.length} item(s) done, cleaned ${cleanedCount} worktree(s).${RESET}`);
    } else {
      info("No TODOS.md changes to commit.");
    }
  } else {
    console.log(`${GREEN}Everything in sync — no changes needed.${RESET}`);
  }
}

/** CLI entry point for `ninthwave reconcile`. */
export function cmdReconcile(
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
): void {
  reconcile(todosFile, worktreeDir, projectRoot);
}
