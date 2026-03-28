// Directory-based TODO parser for the ninthwave CLI.
// Delegates to listWorkItems() from todo-files.ts for actual file reading.
// Re-exports utility functions from todo-utils.ts for backward compatibility.

import type { WorkItem } from "./types.ts";
import { listWorkItems } from "./work-item-files.ts";

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
 */
export function parseWorkItems(
  workDir: string,
  worktreeDir: string,
): WorkItem[] {
  return listWorkItems(workDir, worktreeDir);
}
