// Directory-based work item parser for the ninthwave CLI.
// Delegates to listWorkItemsFromOriginMain() from work-item-files.ts so the
// daemon hot path sees the spec exactly as it lives on origin/main, regardless
// of the user's branch, dirty index, or locally modified work item files.

import type { WorkItem } from "./types.ts";
import { listWorkItemsFromOriginMain } from "./work-item-files.ts";

// Re-export shared utilities so existing imports from parser.ts continue to work.
export {
  normalizeDomain,
  truncateSlug,
  extractTestPlan,
  extractDescriptionSnippet,
  extractFilePaths,
  expandWildcardDeps,
  extractBody,
} from "./work-item-files.ts";

/**
 * Parse work items from `origin/main`.
 *
 * Delegates to {@link listWorkItemsFromOriginMain}, which reads filenames
 * via `git ls-tree origin/main` and contents via
 * `git show origin/main:<path>`. The daemon's view of work items is
 * therefore identical regardless of the user's current branch, dirty
 * index, or locally modified `.ninthwave/work/*.md` files.
 *
 * Throws with an actionable error when `origin/main` does not resolve.
 *
 * `workDir` stays in the signature because callers already compute it as
 * `<repoRoot>/.ninthwave/work`; we use it to derive the repo root (for git
 * plumbing) and to stamp a stable `item.filePath` for display.
 */
export function parseWorkItems(
  workDir: string,
  worktreeDir: string,
): WorkItem[] {
  return listWorkItemsFromOriginMain(workDir, worktreeDir);
}
