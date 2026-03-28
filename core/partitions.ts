import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, basename } from "path";
import type { WorktreeInfo } from "./types.ts";

/**
 * Allocate the lowest available partition number for a TODO ID.
 * Creates a file at partitionDir/<N> containing the TODO ID.
 */
export function allocatePartition(
  partitionDir: string,
  todoId: string,
): number {
  mkdirSync(partitionDir, { recursive: true });
  let n = 1;
  while (true) {
    const path = join(partitionDir, String(n));
    if (!existsSync(path)) {
      writeFileSync(path, todoId);
      return n;
    }
    n++;
  }
}

/**
 * Release the partition lock file for a given TODO ID.
 */
export function releasePartition(
  partitionDir: string,
  todoId: string,
): void {
  if (!existsSync(partitionDir)) return;
  for (const entry of readdirSync(partitionDir)) {
    const path = join(partitionDir, entry);
    try {
      if (readFileSync(path, "utf-8").trim() === todoId) {
        unlinkSync(path);
        return;
      }
    } catch {
      // skip unreadable files
    }
  }
}

/**
 * Get the partition number assigned to a TODO ID, or null if none.
 */
export function getPartitionFor(
  partitionDir: string,
  todoId: string,
): number | null {
  if (!existsSync(partitionDir)) return null;
  for (const entry of readdirSync(partitionDir)) {
    const path = join(partitionDir, entry);
    try {
      if (readFileSync(path, "utf-8").trim() === todoId) {
        return parseInt(basename(path), 10);
      }
    } catch {
      // skip unreadable files
    }
  }
  return null;
}

/**
 * Remove stale partition locks (worktree gone but lock remains).
 * Uses getWorktreeInfo to check cross-repo index + disk verification.
 */
export function cleanupStalePartitions(
  partitionDir: string,
  worktreeDir: string,
  getWorktreeInfo: (todoId: string) => WorktreeInfo | null,
): void {
  if (!existsSync(partitionDir)) return;
  for (const entry of readdirSync(partitionDir)) {
    const path = join(partitionDir, entry);
    let lockId: string;
    try {
      lockId = readFileSync(path, "utf-8").trim();
    } catch {
      continue;
    }

    // Check hub worktree first (backwards compat)
    if (existsSync(join(worktreeDir, `ninthwave-${lockId}`))) {
      continue;
    }

    // Check cross-repo index + verify on disk
    const wtInfo = getWorktreeInfo(lockId);
    if (wtInfo && existsSync(wtInfo.worktreePath)) {
      continue;
    }

    // Worktree not found anywhere — stale lock
    try {
      unlinkSync(path);
    } catch {
      // ignore cleanup errors
    }
  }
}
