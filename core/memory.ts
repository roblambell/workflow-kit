// Shared memory utilities for consistent WIP limit calculation across CLI and daemon.

import { freemem, platform } from "os";
import { execSync } from "node:child_process";

/**
 * Get available memory in bytes, accounting for reclaimable file cache.
 *
 * On macOS, os.freemem() only reports truly "free" pages -- not inactive
 * pages that the OS can reclaim on demand. This causes the memory-aware
 * WIP limiter to throttle to 1 worker even when the system has plenty of
 * headroom. We parse vm_stat to sum free + inactive pages instead.
 *
 * On other platforms, falls back to os.freemem().
 */
export function getAvailableMemory(): number {
  if (platform() === "darwin") {
    try {
      const vmstat = execSync("vm_stat", { encoding: "utf-8" });
      // vm_stat reports in pages; first line has page size
      const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
      const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

      const free = vmstat.match(/Pages free:\s+(\d+)/);
      const inactive = vmstat.match(/Pages inactive:\s+(\d+)/);

      const freePages = free ? parseInt(free[1], 10) : 0;
      const inactivePages = inactive ? parseInt(inactive[1], 10) : 0;

      return (freePages + inactivePages) * pageSize;
    } catch {
      return freemem();
    }
  }
  return freemem();
}
