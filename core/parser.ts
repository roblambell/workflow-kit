// Directory-based TODO parser for the ninthwave CLI.
// Delegates to listWorkItems() from todo-files.ts for actual file reading.
// Re-exports utility functions from todo-utils.ts for backward compatibility.

import type { WorkItem } from "./types.ts";
import { listWorkItems } from "./work-item-files.ts";
import { getCleanRemoteWorkItemFiles } from "./git.ts";

// Re-export shared utilities so existing imports from parser.ts continue to work.
export {
  normalizeDomain,
  truncateSlug,
  extractTestPlan,
  extractFilePaths,
  expandWildcardDeps,
  extractBody,
} from "./work-item-utils.ts";

/**
 * Parse todo items from a directory of todo files (.ninthwave/work/).
 *
 * Delegates to listWorkItems() from todo-files.ts which reads each .md file,
 * parses metadata, expands wildcard dependencies, and detects in-progress status.
 *
 * When `projectRoot` is provided, only items whose files exist on origin/main
 * and match the remote content are returned. Items with local-only state
 * (uncommitted, committed but not pushed, or locally modified) are silently
 * ignored. This ensures execution commands only process pushed items.
 *
 * Informational commands (list, deps, etc.) omit projectRoot to show all items.
 */
export function parseWorkItems(
  workDir: string,
  worktreeDir: string,
  projectRoot?: string,
): WorkItem[] {
  const items = listWorkItems(workDir, worktreeDir);

  if (!projectRoot) return items;

  const cleanFiles = getCleanRemoteWorkItemFiles(projectRoot);
  if (!cleanFiles) return items; // fallback when origin/main doesn't exist

  return items.filter((item) => {
    const lastSlash = item.filePath.lastIndexOf("/");
    const basename = lastSlash >= 0 ? item.filePath.slice(lastSlash + 1) : item.filePath;
    return cleanFiles.has(basename);
  });
}
