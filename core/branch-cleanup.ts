// Stale branch cleanup for reused work item IDs.

import {
  branchExists as defaultBranchExists,
  deleteBranch as defaultDeleteBranch,
  deleteRemoteBranch as defaultDeleteRemoteBranch,
} from "./git.ts";
import { prList as defaultPrList } from "./gh.ts";
import { prTitleMatchesWorkItem } from "./work-item-files.ts";
import { warn as defaultWarn, info as defaultInfo } from "./output.ts";

/** Dependencies for stale branch cleanup, injectable for testing. */
export interface StaleBranchCleanupDeps {
  prList: (repoRoot: string, branch: string, state: string) => import("./gh.ts").GhResult<Array<{ number: number; title: string }>>;
  branchExists: (repoRoot: string, branch: string) => boolean;
  deleteBranch: (repoRoot: string, branch: string) => void;
  deleteRemoteBranch: (repoRoot: string, branch: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
}

const defaultStaleBranchDeps: StaleBranchCleanupDeps = {
  prList: defaultPrList,
  branchExists: defaultBranchExists,
  deleteBranch: defaultDeleteBranch,
  deleteRemoteBranch: defaultDeleteRemoteBranch,
  warn: defaultWarn,
  info: defaultInfo,
};

/**
 * Clean up stale branches when a work item ID is reused with different work.
 *
 * When a work item ID is reused (same ID, different title), the old `ninthwave/*` branch
 * may still exist with a merged PR. Workers launched on this branch detect the
 * existing merged PR and immediately exit, falsely marking the item as "done".
 *
 * This function checks if merged PRs exist for the branch with titles that
 * don't match the current work item title. If so, it deletes both local and remote
 * branches so the worker starts fresh with a new branch and PR.
 *
 * @returns true if stale branches were cleaned, false if no cleanup needed
 */
export function cleanStaleBranchForReuse(
  itemId: string,
  itemTitle: string,
  targetRepo: string,
  deps: StaleBranchCleanupDeps = defaultStaleBranchDeps,
): boolean {
  const branchName = `ninthwave/${itemId}`;

  // Check for merged PRs on this branch
  const mergedResult = deps.prList(targetRepo, branchName, "merged");
  if (!mergedResult.ok || mergedResult.data.length === 0) {
    return false; // No merged PRs or API error -- nothing to clean
  }
  const mergedPrs = mergedResult.data;

  // Check if any merged PR title matches the current work item title
  const hasMatchingTitle = mergedPrs.some((pr) =>
    prTitleMatchesWorkItem(pr.title, itemTitle),
  );
  if (hasMatchingTitle) {
    return false; // Title matches -- same work, normal flow
  }

  // Title mismatch -- stale branch from a previous cycle with different work
  deps.warn(
    `Stale branch detected: ${branchName} has ${mergedPrs.length} merged PR(s) from a previous cycle. ` +
    `Old PR: "${mergedPrs[0]!.title}", new item: "${itemTitle}". Deleting stale branches.`,
  );

  // Delete local branch if it exists
  if (deps.branchExists(targetRepo, branchName)) {
    try {
      deps.deleteBranch(targetRepo, branchName);
      deps.info(`Deleted local branch ${branchName}`);
    } catch (e) {
      deps.warn(
        `Failed to delete local branch ${branchName}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Delete remote branch (deleteRemoteBranch treats "already gone" as success)
  try {
    deps.deleteRemoteBranch(targetRepo, branchName);
    deps.info(`Deleted remote branch ${branchName}`);
  } catch (e) {
    deps.warn(
      `Failed to delete remote branch ${branchName}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return true;
}
