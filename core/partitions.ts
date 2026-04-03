import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join, basename } from "path";
import type { WorktreeInfo } from "./types.ts";

/**
 * Allocate the lowest available partition number for a work item ID.
 * Creates a file at partitionDir/<N> containing the work item ID.
 */
export function allocatePartition(
  partitionDir: string,
  workItemId: string,
): number {
  mkdirSync(partitionDir, { recursive: true });
  let n = 1;
  while (true) {
    const path = join(partitionDir, String(n));
    try {
      // Atomic create: O_CREAT | O_EXCL fails with EEXIST if the file
      // already exists, preventing a TOCTOU race between concurrent workers.
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeSync(fd, workItemId);
      closeSync(fd);
      return n;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        n++;
        continue;
      }
      throw e;
    }
  }
}

/**
 * Release the partition lock file for a given work item ID.
 */
export function releasePartition(
  partitionDir: string,
  workItemId: string,
): void {
  if (!existsSync(partitionDir)) return;
  for (const entry of readdirSync(partitionDir)) {
    const path = join(partitionDir, entry);
    try {
      if (readFileSync(path, "utf-8").trim() === workItemId) {
        unlinkSync(path);
        return;
      }
    } catch {
      // skip unreadable files
    }
  }
}

/**
 * Get the partition number assigned to a work item ID, or null if none.
 */
export function getPartitionFor(
  partitionDir: string,
  workItemId: string,
): number | null {
  if (!existsSync(partitionDir)) return null;
  for (const entry of readdirSync(partitionDir)) {
    const path = join(partitionDir, entry);
    try {
      if (readFileSync(path, "utf-8").trim() === workItemId) {
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
  getWorktreeInfo: (workItemId: string) => WorktreeInfo | null,
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

    // Worktree not found anywhere -- stale lock
    try {
      unlinkSync(path);
    } catch {
      // ignore cleanup errors
    }
  }
}
