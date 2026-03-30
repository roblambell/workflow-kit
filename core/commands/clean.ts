// clean commands: worktree cleanup and workspace management.

import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join, basename } from "path";
import { die, warn, info, GREEN, RESET } from "../output.ts";
import {
  isBranchMerged as defaultIsBranchMerged,
  removeWorktree as defaultRemoveWorktree,
  deleteBranch as defaultDeleteBranch,
  deleteRemoteBranch as defaultDeleteRemoteBranch,
} from "../git.ts";
import { prList as defaultPrList } from "../gh.ts";
import { type Multiplexer, getMux } from "../mux.ts";

/** Injectable dependencies for clean commands, for testing. */
export interface CleanDeps {
  isBranchMerged: typeof defaultIsBranchMerged;
  removeWorktree: typeof defaultRemoveWorktree;
  deleteBranch: typeof defaultDeleteBranch;
  deleteRemoteBranch: typeof defaultDeleteRemoteBranch;
  prList: typeof defaultPrList;
}

const defaultCleanDeps: CleanDeps = {
  isBranchMerged: defaultIsBranchMerged,
  removeWorktree: defaultRemoveWorktree,
  deleteBranch: defaultDeleteBranch,
  deleteRemoteBranch: defaultDeleteRemoteBranch,
  prList: defaultPrList,
};
import { releasePartition } from "../partitions.ts";
import {
  getWorktreeInfo,
  removeCrossRepoIndex,
} from "../cross-repo.ts";

/**
 * Close multiplexer workspaces whose item ID is in the given set.
 * Shared helper used by both reconcile (targeted) and clean (broad).
 * Returns the number of workspaces successfully closed.
 */
export function closeWorkspacesForIds(
  ids: Set<string>,
  mux: Multiplexer,
): number {
  if (!mux.isAvailable()) return 0;

  const workspaces = mux.listWorkspaces();
  if (!workspaces) return 0;

  let closed = 0;
  for (const line of workspaces.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // cmux format: "workspace:N <ID> <title>"
    const wsMatch = trimmed.match(/workspace:\d+/);
    const idMatch = trimmed.match(/TODO\s+([A-Z]+-[A-Za-z0-9]+-[0-9]+)/);

    if (wsMatch && idMatch && ids.has(idMatch[1]!)) {
      const wsRef = wsMatch[0]!;
      const itemId = idMatch[1]!;
      info(`Closing workspace ${wsRef} (${itemId})`);
      if (mux.closeWorkspace(wsRef)) {
        closed++;
      } else {
        warn(`Failed to close ${wsRef}`);
      }
      continue;
    }

    // Multiplexer format where the ref itself contains the item ID.
    for (const id of ids) {
      if (trimmed.includes(id)) {
        info(`Closing workspace ${trimmed} (${id})`);
        if (mux.closeWorkspace(trimmed)) {
          closed++;
        } else {
          warn(`Failed to close ${trimmed}`);
        }
        break;
      }
    }
  }
  return closed;
}

/** Close all multiplexer workspaces that belong to work items. */
export function cmdCloseWorkspaces(mux: Multiplexer = getMux()): void {
  if (!mux.isAvailable()) {
    warn("cmux not available, skipping workspace close");
    return;
  }

  const workspaces = mux.listWorkspaces();
  if (!workspaces) {
    console.log("No cmux workspaces found");
    return;
  }

  let closed = 0;
  for (const line of workspaces.split("\n")) {
    const wsMatch = line.match(/workspace:\d+/);
    const idMatch = line.match(/TODO\s+([A-Z]+-[A-Za-z0-9]+-[0-9]+)/);

    if (wsMatch && idMatch) {
      const wsRef = wsMatch[0];
      const itemId = idMatch[1];
      info(`Closing workspace ${wsRef} (${itemId})`);
      if (!mux.closeWorkspace(wsRef)) {
        warn(`Failed to close ${wsRef}`);
      }
      closed++;
    }
  }

  console.log(`${GREEN}Closed ${closed} workspace(s)${RESET}`);
}

/** Close a multiplexer workspace for a specific item ID. */
export function cmdCloseWorkspace(targetId: string, mux: Multiplexer = getMux()): void {
  if (!targetId) die("Usage: ninthwave close-workspace <ID>");

  if (!mux.isAvailable()) {
    warn(`cmux not available, skipping workspace close for ${targetId}`);
    return;
  }

  const workspaces = mux.listWorkspaces();
  if (!workspaces) return;

  for (const line of workspaces.split("\n")) {
    const wsMatch = line.match(/workspace:\d+/);
    if (wsMatch && line.includes(targetId)) {
      const wsRef = wsMatch[0];
      info(`Closing workspace ${wsRef} for ${targetId}`);
      if (!mux.closeWorkspace(wsRef)) {
        warn(`Failed to close ${wsRef}`);
      }
      return;
    }
  }
}

/** Check if a branch is merged (via git or gh). */
function isMerged(
  repoRoot: string,
  branch: string,
  deps: CleanDeps,
): boolean {
  // Check git merge status
  if (deps.isBranchMerged(repoRoot, branch, "main")) {
    return true;
  }

  // Check via gh PR status
  const result = deps.prList(repoRoot, branch, "merged");
  return result.ok && result.data.length > 0;
}

/**
 * Clean up worktrees and their associated workspaces.
 * - Without targetId: removes merged worktrees and closes only their workspaces.
 *   Active workers for non-merged items are preserved.
 * - With targetId: closes the specific workspace and removes the worktree
 *   regardless of merge status.
 */
export function cmdClean(
  args: string[],
  worktreeDir: string,
  projectRoot: string,
  mux: Multiplexer = getMux(),
  deps: CleanDeps = defaultCleanDeps,
): void {
  const targetId = args[0] ?? "";

  // Close workspaces -- scoped to target when cleaning a specific item.
  // For broad cleanup (no targetId), workspace closing is deferred until
  // we know which items are merged, to preserve active workers.
  if (targetId) {
    cmdCloseWorkspace(targetId, mux);
  }

  if (!existsSync(worktreeDir)) {
    console.log("No worktrees to clean");
    return;
  }

  const partitionDir = join(worktreeDir, ".partitions");
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  let cleaned = 0;
  const mergedIds = new Set<string>();

  // Helper to clean a single worktree item
  function cleanItem(id: string, repoRoot: string, wtDir: string): boolean {
    if (targetId && id !== targetId) return false;

    const branch = `ninthwave/${id}`;
    const merged = isMerged(repoRoot, branch, deps);

    if (merged || targetId) {
      if (merged && !targetId) mergedIds.add(id);
      info(`Removing worktree for ${id} from ${basename(repoRoot)}`);
      try {
        deps.removeWorktree(repoRoot, wtDir, true);
      } catch (e) {
        warn(`Failed to remove worktree for ${id}: ${e instanceof Error ? e.message : e}`);
        try {
          rmSync(wtDir, { recursive: true, force: true });
        } catch (e2) {
          warn(`Failed to force-remove worktree directory for ${id}: ${e2 instanceof Error ? e2.message : e2}`);
        }
      }
      try {
        deps.deleteBranch(repoRoot, branch);
      } catch (e) {
        warn(`Failed to delete local branch ${branch}: ${e instanceof Error ? e.message : e}`);
      }
      try {
        deps.deleteRemoteBranch(repoRoot, branch);
      } catch (e) {
        warn(`Failed to delete remote branch ${branch}: ${e instanceof Error ? e.message : e}`);
      }
      releasePartition(partitionDir, id);
      removeCrossRepoIndex(crossRepoIndex, id);
      return true;
    }
    return false;
  }

  // Clean hub-local worktrees
  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (!entry.startsWith("ninthwave-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(10); // strip "ninthwave-"
      if (cleanItem(id, projectRoot, wtDir)) {
        cleaned++;
      }
    }
  } catch {
    // worktreeDir might not be iterable
  }

  // Clean cross-repo worktrees
  const indexPath = join(worktreeDir, ".cross-repo-index");
  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      const idxId = parts[0];
      const idxRepo = parts[1];
      const idxPath = parts[2];
      if (!idxId || !idxRepo || !idxPath) continue;
      if (!existsSync(idxPath)) continue;
      if (cleanItem(idxId, idxRepo, idxPath)) {
        cleaned++;
      }
    }
  }

  // For broad cleanup, close workspaces only for confirmed-merged items.
  // Active workers for non-merged items are preserved.
  if (!targetId) {
    closeWorkspacesForIds(mergedIds, mux);
  }

  console.log(`${GREEN}Cleaned ${cleaned} worktree(s)${RESET}`);
}

/**
 * Remove a single worktree and all associated resources (branches, partition, index entry).
 * Returns true if the worktree was found and cleaned, false otherwise.
 */
export function cleanSingleWorktree(
  id: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CleanDeps = defaultCleanDeps,
): boolean {
  const branch = `ninthwave/${id}`;
  const partitionDir = join(worktreeDir, ".partitions");
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");

  // Check cross-repo index first, then fall back to hub worktree
  const wtInfo = getWorktreeInfo(id, crossRepoIndex, worktreeDir);
  let targetRepo: string;
  let worktreePath: string;

  if (wtInfo) {
    targetRepo = wtInfo.repoRoot;
    worktreePath = wtInfo.worktreePath;
  } else {
    worktreePath = join(worktreeDir, `ninthwave-${id}`);
    targetRepo = projectRoot;
  }

  if (!existsSync(worktreePath)) {
    return false;
  }

  info(`Removing worktree for ${id} from ${basename(targetRepo)}`);
  try {
    deps.removeWorktree(targetRepo, worktreePath, true);
  } catch (e) {
    warn(`Failed to remove worktree for ${id}: ${e instanceof Error ? e.message : e}`);
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (e2) {
      warn(`Failed to force-remove worktree directory for ${id}: ${e2 instanceof Error ? e2.message : e2}`);
    }
  }
  try {
    deps.deleteBranch(targetRepo, branch);
  } catch (e) {
    warn(`Failed to delete local branch ${branch}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    deps.deleteRemoteBranch(targetRepo, branch);
  } catch (e) {
    warn(`Failed to delete remote branch ${branch}: ${e instanceof Error ? e.message : e}`);
  }
  releasePartition(partitionDir, id);
  removeCrossRepoIndex(crossRepoIndex, id);
  return true;
}

/**
 * Remove a single worktree without side effects (no workspace close).
 */
export function cmdCleanSingle(
  args: string[],
  worktreeDir: string,
  projectRoot: string,
  deps: CleanDeps = defaultCleanDeps,
): void {
  const targetId = args[0] ?? "";
  if (!targetId) die("Usage: ninthwave clean-single <ID>");

  if (cleanSingleWorktree(targetId, worktreeDir, projectRoot, deps)) {
    console.log(`${GREEN}Cleaned worktree for ${targetId}${RESET}`);
  } else {
    console.log(`No worktree found for ${targetId}`);
  }
}
