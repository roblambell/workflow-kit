// Directory-based TODO parser for the ninthwave CLI.
// Delegates to listTodos() from todo-files.ts for actual file reading.
// Re-exports utility functions from todo-utils.ts for backward compatibility.

import type { TodoItem } from "./types.ts";
import { listTodos } from "./todo-files.ts";

// Re-export shared utilities so existing imports from parser.ts continue to work.
export {
  normalizeDomain,
  truncateSlug,
  extractTestPlan,
  extractFilePaths,
  expandWildcardDeps,
  extractBody,
} from "./todo-utils.ts";

/**
 * Parse todo items from a directory of todo files (.ninthwave/work/).
 *
 * Delegates to listTodos() from todo-files.ts which reads each .md file,
 * parses metadata, expands wildcard dependencies, and detects in-progress status.
 */
export function parseTodos(
  workDir: string,
  worktreeDir: string,
): TodoItem[] {
  return listTodos(workDir, worktreeDir);
}
