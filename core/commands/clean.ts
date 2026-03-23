// clean commands: worktree cleanup and workspace management.

import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join, basename } from "path";
import { die, warn, info, GREEN, RESET } from "../output.ts";
import { isBranchMerged, removeWorktree, deleteBranch, deleteRemoteBranch } from "../git.ts";
import { prList } from "../gh.ts";
import * as cmux from "../cmux.ts";
import { releasePartition } from "../partitions.ts";
import {
  getWorktreeInfo,
  removeCrossRepoIndex,
} from "../cross-repo.ts";

/** Close all cmux workspaces that belong to todo items. */
export function cmdCloseWorkspaces(): void {
  if (!cmux.isAvailable()) {
    warn("cmux not available, skipping workspace close");
    return;
  }

  const workspaces = cmux.listWorkspaces();
  if (!workspaces) {
    console.log("No cmux workspaces found");
    return;
  }

  let closed = 0;
  for (const line of workspaces.split("\n")) {
    const wsMatch = line.match(/workspace:\d+/);
    const todoMatch = line.match(/TODO\s+([A-Z]+-[A-Za-z0-9]+-[0-9]+)/);

    if (wsMatch && todoMatch) {
      const wsRef = wsMatch[0];
      const todoId = todoMatch[1];
      info(`Closing workspace ${wsRef} (${todoId})`);
      if (!cmux.closeWorkspace(wsRef)) {
        warn(`Failed to close ${wsRef}`);
      }
      closed++;
    }
  }

  console.log(`${GREEN}Closed ${closed} todo workspace(s)${RESET}`);
}

/** Close cmux workspace for a specific TODO ID. */
export function cmdCloseWorkspace(targetId: string): void {
  if (!targetId) die("Usage: ninthwave close-workspace <ID>");

  if (!cmux.isAvailable()) {
    warn(`cmux not available, skipping workspace close for ${targetId}`);
    return;
  }

  const workspaces = cmux.listWorkspaces();
  if (!workspaces) return;

  for (const line of workspaces.split("\n")) {
    const wsMatch = line.match(/workspace:\d+/);
    if (wsMatch && line.includes(targetId)) {
      const wsRef = wsMatch[0];
      info(`Closing workspace ${wsRef} for ${targetId}`);
      if (!cmux.closeWorkspace(wsRef)) {
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
): boolean {
  // Check git merge status
  if (isBranchMerged(repoRoot, branch, "main")) {
    return true;
  }

  // Check via gh PR status
  const merged = prList(repoRoot, branch, "merged");
  return merged.length > 0;
}

/**
 * Clean up worktrees. Closes workspaces first, then removes merged worktrees.
 * If targetId is provided, removes only that specific worktree (merged or not).
 */
export function cmdClean(
  args: string[],
  worktreeDir: string,
  projectRoot: string,
): void {
  const targetId = args[0] ?? "";

  // Close workspaces first
  cmdCloseWorkspaces();

  if (!existsSync(worktreeDir)) {
    console.log("No worktrees to clean");
    return;
  }

  const partitionDir = join(worktreeDir, ".partitions");
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  let cleaned = 0;

  // Helper to clean a single worktree item
  function cleanItem(id: string, repoRoot: string, wtDir: string): boolean {
    if (targetId && id !== targetId) return false;

    const branch = `todo/${id}`;
    const merged = isMerged(repoRoot, branch);

    if (merged || targetId) {
      info(`Removing worktree for ${id} from ${basename(repoRoot)}`);
      try {
        removeWorktree(repoRoot, wtDir, true);
      } catch {
        try {
          rmSync(wtDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      try {
        deleteBranch(repoRoot, branch);
      } catch {
        // ignore
      }
      try {
        deleteRemoteBranch(repoRoot, branch);
      } catch {
        // ignore
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
      if (!entry.startsWith("todo-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(5); // strip "todo-"
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

  console.log(`${GREEN}Cleaned ${cleaned} worktree(s)${RESET}`);
}

/**
 * Remove a single worktree without side effects (no workspace close).
 */
export function cmdCleanSingle(
  args: string[],
  worktreeDir: string,
  projectRoot: string,
): void {
  const targetId = args[0] ?? "";
  if (!targetId) die("Usage: ninthwave clean-single <ID>");

  const branch = `todo/${targetId}`;
  const partitionDir = join(worktreeDir, ".partitions");
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");

  // Check cross-repo index first, then fall back to hub worktree
  const wtInfo = getWorktreeInfo(targetId, crossRepoIndex, worktreeDir);
  let targetRepo: string;
  let worktreePath: string;

  if (wtInfo) {
    targetRepo = wtInfo.repoRoot;
    worktreePath = wtInfo.worktreePath;
  } else {
    worktreePath = join(worktreeDir, `todo-${targetId}`);
    targetRepo = projectRoot;
  }

  if (existsSync(worktreePath)) {
    info(`Removing worktree for ${targetId} from ${basename(targetRepo)}`);
    try {
      removeWorktree(targetRepo, worktreePath, true);
    } catch {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    try {
      deleteBranch(targetRepo, branch);
    } catch {
      // ignore
    }
    try {
      deleteRemoteBranch(targetRepo, branch);
    } catch {
      // ignore
    }
    releasePartition(partitionDir, targetId);
    removeCrossRepoIndex(crossRepoIndex, targetId);
    console.log(`${GREEN}Cleaned worktree for ${targetId}${RESET}`);
  } else {
    console.log(`No worktree found for ${targetId}`);
  }
}
