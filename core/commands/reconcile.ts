// reconcile command: synchronize todo files with GitHub PR state and clean stale worktrees.

import { existsSync, readdirSync } from "fs";
import { info, warn, GREEN, RESET } from "../output.ts";
import { run } from "../shell.ts";
import { cmdMarkDone } from "./mark-done.ts";
import { cleanSingleWorktree, closeWorkspacesForIds } from "./clean.ts";
import { getMux } from "../mux.ts";

/**
 * Dependencies for reconcile, injectable for testing.
 */
export interface ReconcileDeps {
  /** Pull latest main with rebase. Returns { ok, conflict, error }. */
  pullRebase(projectRoot: string): { ok: boolean; conflict: boolean; error?: string };

  /** Get IDs of merged todo/* PRs from GitHub. */
  getMergedTodoIds(projectRoot: string): string[];

  /** Get IDs of open todo items from the todos directory. */
  getOpenTodoIds(todosDir: string): string[];

  /** Mark items as done (delete their todo files). */
  markDone(ids: string[], todosDir: string): void;

  /** List worktree IDs present in the worktree directory. */
  getWorktreeIds(worktreeDir: string): string[];

  /** Clean a single worktree. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;

  /** Close cmux workspaces for done/merged items. Returns count closed. */
  closeStaleWorkspaces(doneIds: string[]): number;

  /** Stage, commit, and push todo file changes. Returns true if committed. */
  commitAndPush(projectRoot: string, todosDir: string): boolean;
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
    return { ok: false, conflict: true, error: result.stderr };
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

function defaultGetOpenTodoIds(todosDir: string): string[] {
  if (!existsSync(todosDir)) return [];
  try {
    const entries = readdirSync(todosDir).filter(f => f.endsWith(".md"));
    const ids: string[] = [];
    for (const entry of entries) {
      // Filename format: "{priority_num}-{domain}--{ID}.md"
      const match = entry.match(/--([A-Z]-[A-Za-z0-9]+-[0-9]+)\.md$/);
      if (match) {
        ids.push(match[1]!);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function defaultMarkDone(ids: string[], todosDir: string): void {
  cmdMarkDone(ids, todosDir);
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

function defaultCommitAndPush(projectRoot: string, todosDir: string): boolean {
  // Check if todos directory has changes
  const diffResult = run("git", ["-C", projectRoot, "diff", "--name-only", todosDir]);
  // Also check for deleted (unstaged) files
  const untrackedResult = run("git", ["-C", projectRoot, "status", "--porcelain", todosDir]);
  if ((diffResult.exitCode !== 0 || !diffResult.stdout.trim()) &&
      (untrackedResult.exitCode !== 0 || !untrackedResult.stdout.trim())) {
    return false;
  }

  const addResult = run("git", ["-C", projectRoot, "add", todosDir]);
  if (addResult.exitCode !== 0) return false;

  const commitResult = run("git", ["-C", projectRoot, "commit", "-m", "chore: reconcile todo files with merged PRs"]);
  if (commitResult.exitCode !== 0) return false;

  const pushResult = run("git", ["-C", projectRoot, "push", "--quiet"]);
  if (pushResult.exitCode !== 0) {
    warn(`Push failed: ${pushResult.stderr}`);
    return false;
  }

  return true;
}

function defaultCloseStaleWorkspaces(doneIds: string[]): number {
  return closeWorkspacesForIds(new Set(doneIds), getMux());
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
    closeStaleWorkspaces: defaultCloseStaleWorkspaces,
    commitAndPush: defaultCommitAndPush,
  };
}

/**
 * Reconcile todo files with GitHub PR state and clean stale worktrees.
 *
 * Steps:
 * 1. git pull --rebase to get latest main
 * 2. Query gh for merged todo/* PRs
 * 3. Mark merged items as done (delete their todo files)
 * 4. Clean worktrees for done items
 * 5. Commit and push todo file changes if any
 */
export function reconcile(
  todosDir: string,
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

  // Step 3: Find items that are merged but still have todo files
  const openIds = new Set(deps.getOpenTodoIds(todosDir));
  const toMarkDone = mergedIds.filter((id) => openIds.has(id));

  if (toMarkDone.length > 0) {
    info(`Marking ${toMarkDone.length} merged item(s) as done: ${toMarkDone.join(", ")}`);
    deps.markDone(toMarkDone, todosDir);
  } else {
    info("All merged items already marked done.");
  }

  // Step 4: Clean worktrees for done items
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  // Done items = those we just marked done + those already not in todos dir
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

  // Step 4.5: Close cmux workspaces for done/merged items
  const closedWorkspaces = deps.closeStaleWorkspaces(mergedIds);
  if (closedWorkspaces > 0) {
    info(`Closed ${closedWorkspaces} stale workspace(s).`);
  }

  // Step 4.6: Clean orphaned worktrees — worktrees with no matching todo file.
  // Skip IDs already handled by step 4 (merged items) to avoid double-cleaning.
  const refreshedOpenIds = new Set(deps.getOpenTodoIds(todosDir));
  const refreshedWorktreeIds = deps.getWorktreeIds(worktreeDir);
  let orphanCount = 0;
  for (const wtId of refreshedWorktreeIds) {
    if (!doneIds.has(wtId) && !refreshedOpenIds.has(wtId)) {
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        orphanCount++;
      }
    }
  }
  if (orphanCount > 0) {
    info(`Cleaned ${orphanCount} orphaned worktree(s).`);
  }

  // Step 5: Commit and push todo file changes if any
  if (toMarkDone.length > 0) {
    info("Committing and pushing todo file changes...");
    if (deps.commitAndPush(projectRoot, todosDir)) {
      console.log(`${GREEN}Reconciled: marked ${toMarkDone.length} item(s) done, cleaned ${cleanedCount} worktree(s), closed ${closedWorkspaces} workspace(s).${RESET}`);
    } else {
      info("No todo file changes to commit.");
    }
  } else {
    console.log(`${GREEN}Everything in sync — no changes needed.${RESET}`);
  }
}

/** CLI entry point for `ninthwave reconcile`. */
export function cmdReconcile(
  todosDir: string,
  worktreeDir: string,
  projectRoot: string,
): void {
  reconcile(todosDir, worktreeDir, projectRoot);
}
