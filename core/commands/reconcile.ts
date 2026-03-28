// reconcile command: synchronize todo files with GitHub PR state and clean stale worktrees.

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { info, warn, GREEN, RESET } from "../output.ts";
import { run } from "../shell.ts";
import { commitCount } from "../git.ts";
import { prList } from "../gh.ts";
import { listCrossRepoEntries } from "../cross-repo.ts";
import { cmdMarkDone } from "./mark-done.ts";
import { cleanSingleWorktree, closeWorkspacesForIds } from "./clean.ts";
import { getMux } from "../mux.ts";
import { readWorkItem } from "../work-item-files.ts";
import { prTitleMatchesWorkItem } from "../work-item-utils.ts";
import { ID_IN_FILENAME } from "../types.ts";

/**
 * Dependencies for reconcile, injectable for testing.
 */
export interface ReconcileDeps {
  /** Pull latest main with rebase. Returns { ok, conflict, error }. */
  pullRebase(projectRoot: string): { ok: boolean; conflict: boolean; error?: string };

  /** Get IDs and PR titles of merged ninthwave/* PRs from GitHub. Queries hub repo and any cross-repo targets. */
  getMergedTodoIds(projectRoot: string, worktreeDir: string): Array<{ id: string; prTitle: string }>;

  /** Get IDs of open todo items from the todos directory. */
  getOpenTodoIds(workDir: string): string[];

  /** Mark items as done (delete their todo files). */
  markDone(ids: string[], workDir: string): void;

  /** List worktree IDs present in the worktree directory. */
  getWorktreeIds(worktreeDir: string): string[];

  /** Clean a single worktree. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;

  /** Close cmux workspaces for done/merged items. Returns count closed. */
  closeStaleWorkspaces(doneIds: string[]): number;

  /** Stage, commit, and push todo file changes. Returns true if committed. */
  commitAndPush(projectRoot: string, workDir: string): boolean;

  /** Check if a worktree has any commits beyond main. */
  worktreeHasCommits(id: string, worktreeDir: string, projectRoot: string): boolean;

  /** Check if a branch has an open PR on GitHub. */
  branchHasOpenPR(id: string, projectRoot: string): boolean;
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

function getMergedTodoIdsFromRepo(repoRoot: string): Array<{ id: string; prTitle: string }> {
  const result = run("gh", [
    "pr", "list",
    "--state", "merged",
    "--json", "headRefName,title",
    "--limit", "200",
  ], { cwd: repoRoot });

  if (result.exitCode !== 0 || !result.stdout) return [];

  try {
    const prs = JSON.parse(result.stdout) as Array<{ headRefName: string; title: string }>;
    const items: Array<{ id: string; prTitle: string }> = [];
    for (const pr of prs) {
      if (pr.headRefName.startsWith("ninthwave/")) {
        items.push({ id: pr.headRefName.slice(10), prTitle: pr.title ?? "" }); // strip "ninthwave/"
      }
    }
    return items;
  } catch {
    return [];
  }
}

function defaultGetMergedTodoIds(projectRoot: string, worktreeDir: string): Array<{ id: string; prTitle: string }> {
  // Query hub repo for merged ninthwave/* PRs
  const byId = new Map<string, { id: string; prTitle: string }>();
  for (const item of getMergedTodoIdsFromRepo(projectRoot)) {
    byId.set(item.id, item);
  }

  // Also query cross-repo targets discovered from the cross-repo index
  const indexPath = join(worktreeDir, ".cross-repo-index");
  const entries = listCrossRepoEntries(indexPath);
  const targetRepos = new Set<string>();
  for (const entry of entries) {
    if (entry.repoRoot !== projectRoot) {
      targetRepos.add(entry.repoRoot);
    }
  }
  for (const repo of targetRepos) {
    try {
      for (const item of getMergedTodoIdsFromRepo(repo)) {
        if (!byId.has(item.id)) {
          byId.set(item.id, item);
        }
      }
    } catch (e) {
      warn(`Failed to query merged PRs in ${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return Array.from(byId.values());
}

function defaultGetOpenTodoIds(workDir: string): string[] {
  if (!existsSync(workDir)) return [];
  try {
    const entries = readdirSync(workDir).filter(f => f.endsWith(".md"));
    const ids: string[] = [];
    for (const entry of entries) {
      // Filename format: "{priority_num}-{domain}--{ID}.md"
      const match = entry.match(ID_IN_FILENAME);
      if (match) {
        ids.push(match[1]!);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function defaultMarkDone(ids: string[], workDir: string): void {
  cmdMarkDone(ids, workDir);
}

function defaultGetWorktreeIds(worktreeDir: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  try {
    return readdirSync(worktreeDir)
      .filter((e) => e.startsWith("ninthwave-"))
      .map((e) => e.slice(10));
  } catch {
    return [];
  }
}

function defaultCleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean {
  return cleanSingleWorktree(id, worktreeDir, projectRoot);
}

function defaultCommitAndPush(projectRoot: string, workDir: string): boolean {
  // Check if todos directory has changes
  const diffResult = run("git", ["-C", projectRoot, "diff", "--name-only", workDir]);
  // Also check for deleted (unstaged) files
  const untrackedResult = run("git", ["-C", projectRoot, "status", "--porcelain", workDir]);
  if ((diffResult.exitCode !== 0 || !diffResult.stdout.trim()) &&
      (untrackedResult.exitCode !== 0 || !untrackedResult.stdout.trim())) {
    return false;
  }

  const addResult = run("git", ["-C", projectRoot, "add", workDir]);
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

function defaultWorktreeHasCommits(id: string, worktreeDir: string, _projectRoot: string): boolean {
  const worktreePath = join(worktreeDir, `ninthwave-${id}`);
  if (!existsSync(worktreePath)) return false;
  // Count commits on the todo branch beyond main
  return commitCount(worktreePath, "main", "HEAD") > 0;
}

function defaultBranchHasOpenPR(id: string, projectRoot: string): boolean {
  const branch = `ninthwave/${id}`;
  return prList(projectRoot, branch, "open").length > 0;
}

/** Build default dependencies from real implementations. */
export function defaultDeps(): ReconcileDeps {
  return {
    pullRebase: defaultPullRebase,
    getMergedTodoIds: (projectRoot, worktreeDir) => defaultGetMergedTodoIds(projectRoot, worktreeDir),
    getOpenTodoIds: defaultGetOpenTodoIds,
    markDone: defaultMarkDone,
    getWorktreeIds: defaultGetWorktreeIds,
    cleanWorktree: defaultCleanWorktree,
    closeStaleWorkspaces: defaultCloseStaleWorkspaces,
    commitAndPush: defaultCommitAndPush,
    worktreeHasCommits: defaultWorktreeHasCommits,
    branchHasOpenPR: defaultBranchHasOpenPR,
  };
}

/**
 * Reconcile todo files with GitHub PR state and clean stale worktrees.
 *
 * Steps:
 * 1. git pull --rebase to get latest main
 * 2. Query gh for merged ninthwave/* PRs
 * 3. Mark merged items as done (delete their todo files)
 * 4. Clean worktrees for done items
 * 5. Commit and push todo file changes if any
 */
export function reconcile(
  workDir: string,
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

  // Step 2: Get merged todo IDs from GitHub (hub + cross-repo targets)
  info("Querying GitHub for merged ninthwave/* PRs...");
  const mergedItems = deps.getMergedTodoIds(projectRoot, worktreeDir);
  if (mergedItems.length === 0) {
    info("No merged ninthwave/* PRs found.");
  }

  // Step 3: Find items that are merged but still have todo files.
  // Collision safety (H-MID-1): compare the merged PR's title with the TODO file's
  // title. If they don't match, the merged PR belongs to a previous cycle that reused
  // the same ID — skip it to avoid falsely deleting the new TODO.
  const openIds = new Set(deps.getOpenTodoIds(workDir));
  const mergedPrTitleById = new Map(mergedItems.map((m) => [m.id, m.prTitle]));
  const toMarkDone: string[] = [];
  const skippedCollisions: string[] = [];

  for (const merged of mergedItems) {
    if (!openIds.has(merged.id)) continue;

    // Title-match check: read the TODO file's title and compare with the merged PR's title
    if (merged.prTitle) {
      const todoItem = readWorkItem(workDir, merged.id);
      if (todoItem?.title && !prTitleMatchesWorkItem(merged.prTitle, todoItem.title)) {
        skippedCollisions.push(merged.id);
        continue;
      }
    }

    toMarkDone.push(merged.id);
  }

  if (skippedCollisions.length > 0) {
    warn(
      `Skipped ${skippedCollisions.length} item(s) with ID collision (merged PR title doesn't match TODO title): ${skippedCollisions.join(", ")}`,
    );
  }

  if (toMarkDone.length > 0) {
    info(`Marking ${toMarkDone.length} merged item(s) as done: ${toMarkDone.join(", ")}`);
    deps.markDone(toMarkDone, workDir);
  } else {
    info("All merged items already marked done.");
  }

  // Step 4: Clean worktrees for done items
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  // Done items = those we just marked done + those already not in todos dir
  // (only IDs that passed title check or have no open TODO file)
  const mergedIds = new Set(mergedItems.map((m) => m.id));
  const doneIds = new Set<string>();
  for (const id of mergedIds) {
    // Include if: not a collision (either in toMarkDone, or no open TODO file)
    if (!skippedCollisions.includes(id)) {
      doneIds.add(id);
    }
  }
  let cleanedCount = 0;

  for (const wtId of worktreeIds) {
    if (doneIds.has(wtId)) {
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        cleanedCount++;
      }
    }
  }

  // Also clean cross-repo worktrees for done items
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  const crossRepoEntries = listCrossRepoEntries(crossRepoIndex);
  const crossRepoMap = new Map(crossRepoEntries.map((e) => [e.todoId, e]));
  const crossRepoCleaned = new Set<string>();

  for (const entry of crossRepoEntries) {
    if (doneIds.has(entry.itemId) && !crossRepoCleaned.has(entry.itemId)) {
      const targetWtDir = join(entry.repoRoot, ".worktrees");
      if (deps.cleanWorktree(entry.itemId, targetWtDir, entry.repoRoot)) {
        cleanedCount++;
        crossRepoCleaned.add(entry.itemId);
      }
    }
  }

  if (cleanedCount > 0) {
    info(`Cleaned ${cleanedCount} stale worktree(s).`);
  }

  // Step 4.5: Close cmux workspaces for done/merged items
  const closedWorkspaces = deps.closeStaleWorkspaces(Array.from(doneIds));
  if (closedWorkspaces > 0) {
    info(`Closed ${closedWorkspaces} stale workspace(s).`);
  }

  // Step 4.6: Clean orphaned worktrees — worktrees with no matching todo file.
  // Skip IDs already handled by step 4 (merged items) to avoid double-cleaning.
  const refreshedOpenIds = new Set(deps.getOpenTodoIds(workDir));
  const refreshedWorktreeIds = deps.getWorktreeIds(worktreeDir);
  let orphanCount = 0;
  for (const wtId of refreshedWorktreeIds) {
    if (!doneIds.has(wtId) && !refreshedOpenIds.has(wtId)) {
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        orphanCount++;
      }
    }
  }
  // Also clean orphaned cross-repo worktrees
  for (const entry of crossRepoEntries) {
    if (crossRepoCleaned.has(entry.itemId)) continue;
    if (!doneIds.has(entry.itemId) && !refreshedOpenIds.has(entry.itemId)) {
      const targetWtDir = join(entry.repoRoot, ".worktrees");
      if (deps.cleanWorktree(entry.itemId, targetWtDir, entry.repoRoot)) {
        orphanCount++;
        crossRepoCleaned.add(entry.itemId);
      }
    }
  }
  if (orphanCount > 0) {
    info(`Cleaned ${orphanCount} orphaned worktree(s).`);
  }

  // Step 4.7: Clean stale worktrees — worktrees with zero commits beyond main and no open PR.
  // These are left behind by aborted orchestration runs and incorrectly mark items as in-progress.
  const postCleanWorktreeIds = deps.getWorktreeIds(worktreeDir);
  let staleCount = 0;
  for (const wtId of postCleanWorktreeIds) {
    // Skip items already cleaned by merged-item step
    if (doneIds.has(wtId)) continue;
    // Only check items with matching todo files (orphans already cleaned above)
    if (!refreshedOpenIds.has(wtId)) continue;
    // Skip if the worktree has actual commits
    if (deps.worktreeHasCommits(wtId, worktreeDir, projectRoot)) continue;
    // Skip if there's an open PR (someone might be working on it)
    if (deps.branchHasOpenPR(wtId, projectRoot)) continue;

    info(`Cleaning stale worktree for ${wtId} (zero commits, no open PR)`);
    if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
      staleCount++;
    }
  }
  // Also check cross-repo worktrees for staleness
  for (const entry of crossRepoEntries) {
    if (crossRepoCleaned.has(entry.itemId)) continue;
    if (doneIds.has(entry.itemId)) continue;
    if (!refreshedOpenIds.has(entry.itemId)) continue;
    const targetWtDir = join(entry.repoRoot, ".worktrees");
    if (deps.worktreeHasCommits(entry.itemId, targetWtDir, entry.repoRoot)) continue;
    if (deps.branchHasOpenPR(entry.itemId, entry.repoRoot)) continue;

    info(`Cleaning stale cross-repo worktree for ${entry.itemId} (zero commits, no open PR)`);
    if (deps.cleanWorktree(entry.itemId, targetWtDir, entry.repoRoot)) {
      staleCount++;
      crossRepoCleaned.add(entry.itemId);
    }
  }
  if (staleCount > 0) {
    info(`Cleaned ${staleCount} stale worktree(s) with zero commits.`);
  }

  // Step 5: Commit and push todo file changes if any
  if (toMarkDone.length > 0) {
    info("Committing and pushing todo file changes...");
    if (deps.commitAndPush(projectRoot, workDir)) {
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
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
): void {
  reconcile(workDir, worktreeDir, projectRoot);
}
