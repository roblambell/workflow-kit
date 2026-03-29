// State reconstruction (crash recovery): reads disk state and recovers OrchestratorItem state.
// Extracted from core/commands/orchestrate.ts for modularity.

import { existsSync } from "fs";
import { join } from "path";
import type { Orchestrator, OrchestratorItem, OrchestratorItemState } from "./orchestrator.ts";
import type { DaemonState } from "./daemon.ts";
import { getWorktreeInfo } from "./cross-repo.ts";
import { checkPrStatus } from "./commands/pr-monitor.ts";
import { prTitleMatchesWorkItem } from "./work-item-files.ts";
import type { Multiplexer } from "./mux.ts";

// ── State reconstruction (crash recovery) ──────────────────────────

/**
 * Reconstruct orchestrator state from existing worktrees and GitHub PRs.
 * Called on startup to resume after a crash or restart.
 *
 * When an item is in "implementing" state (worktree exists, no PR yet),
 * also recovers the workspaceRef from live cmux workspaces. Without this,
 * the first poll cycle sees workerAlive=false and immediately marks the
 * item stuck -- even if the worker is actively running.
 */
export function reconstructState(
  orch: Orchestrator,
  projectRoot: string,
  worktreeDir: string,
  mux?: Multiplexer,
  checkPr: (id: string, root: string) => string | null = checkPrStatus,
  daemonState?: DaemonState | null,
): void {
  // Build a lookup map from saved daemon state for restoring persisted counters and review fields
  const savedItems = new Map<string, { ciFailCount: number; retryCount: number; reviewWorkspaceRef?: string; reviewCompleted?: boolean; reviewRound?: number; lastCommentCheck?: string; rebaseRequested?: boolean; ciFailureNotified?: boolean; ciFailureNotifiedAt?: string | null; rebaserWorkspaceRef?: string; mergeCommitSha?: string; fixForwardFailCount?: number; fixForwardWorkspaceRef?: string }>();
  if (daemonState?.items) {
    for (const si of daemonState.items) {
      // Backward compat: map old field names to new names
      const raw = si as Record<string, unknown>;
      const rebaserRef = (si as Record<string, unknown>).rebaserWorkspaceRef as string | undefined ?? (raw.repairWorkspaceRef as string | undefined);
      const fixForwardFailCount = si.fixForwardFailCount ?? (raw.verifyFailCount as number | undefined);
      const fixForwardWorkspaceRef = si.fixForwardWorkspaceRef ?? (raw.verifyWorkspaceRef as string | undefined);
      savedItems.set(si.id, {
        ciFailCount: si.ciFailCount,
        retryCount: si.retryCount,
        reviewWorkspaceRef: si.reviewWorkspaceRef,
        reviewCompleted: si.reviewCompleted,
        reviewRound: si.reviewRound,
        lastCommentCheck: si.lastCommentCheck,
        rebaseRequested: si.rebaseRequested,
        ciFailureNotified: si.ciFailureNotified,
        ciFailureNotifiedAt: si.ciFailureNotifiedAt,
        rebaserWorkspaceRef: rebaserRef,
        mergeCommitSha: si.mergeCommitSha,
        fixForwardFailCount,
        fixForwardWorkspaceRef,
      });
    }
  }

  // Pre-fetch workspace list once (avoid per-item shell calls)
  const workspaceList = mux ? mux.listWorkspaces() : "";

  // Build cross-repo index path for worktree lookup
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");

  for (const item of orch.getAllItems()) {
    // Restore persisted counters and review fields from daemon state (before any state transitions)
    const saved = savedItems.get(item.id);
    if (saved) {
      item.ciFailCount = saved.ciFailCount;
      item.retryCount = saved.retryCount;
      if (saved.reviewWorkspaceRef) item.reviewWorkspaceRef = saved.reviewWorkspaceRef;
      if (saved.reviewCompleted) item.reviewCompleted = saved.reviewCompleted;
      if (saved.reviewRound != null) item.reviewRound = saved.reviewRound;
      if (saved.lastCommentCheck) item.lastCommentCheck = saved.lastCommentCheck;
      if (saved.rebaseRequested) item.rebaseRequested = saved.rebaseRequested;
      if (saved.ciFailureNotified) item.ciFailureNotified = saved.ciFailureNotified;
      if (saved.ciFailureNotifiedAt) item.ciFailureNotifiedAt = saved.ciFailureNotifiedAt;
      if (saved.rebaserWorkspaceRef) item.rebaserWorkspaceRef = saved.rebaserWorkspaceRef;
      if (saved.mergeCommitSha) item.mergeCommitSha = saved.mergeCommitSha;
      if (saved.fixForwardFailCount) item.fixForwardFailCount = saved.fixForwardFailCount;
      if (saved.fixForwardWorkspaceRef) item.fixForwardWorkspaceRef = saved.fixForwardWorkspaceRef;
    }

    // Restore post-merge fix-forward states from daemon state (these items have no worktree)
    if (saved && item.mergeCommitSha) {
      let savedState = daemonState?.items.find((si) => si.id === item.id)?.state;
      // Backward compat: map old state names to new names
      if (savedState === "verifying") savedState = "forward-fix-pending";
      if (savedState === "verify-failed") savedState = "fix-forward-failed";
      if (savedState === "repairing-main") savedState = "fixing-forward";
      if (savedState === "forward-fix-pending" || savedState === "fix-forward-failed" || savedState === "fixing-forward") {
        orch.setState(item.id, savedState as OrchestratorItemState);
        continue;
      }
    }

    // Check for worktree: cross-repo index first, then hub-local fallback
    const repoRoot = item.resolvedRepoRoot ?? projectRoot;
    const wtInfo = getWorktreeInfo(item.id, crossRepoIndex, worktreeDir);
    const wtPath = wtInfo?.worktreePath ?? join(worktreeDir, `ninthwave-${item.id}`);
    if (!existsSync(wtPath)) continue;

    // Item has a worktree -- check PR status in the correct repo
    const statusLine = checkPr(item.id, repoRoot);
    if (!statusLine) {
      orch.setState(item.id, "implementing");
      recoverWorkspaceRef(orch, item.id, workspaceList);
      continue;
    }

    const parts = statusLine.split("\t");
    const prNumStr = parts[1];
    const status = parts[2];

    // Capture the pre-existing prNumber (from daemon state) BEFORE overwriting it.
    // Used by the merged-case alreadyTracked check below.
    const previousPrNumber = orch.getItem(item.id)?.prNumber;

    if (prNumStr) {
      const orchItem = orch.getItem(item.id)!;
      orchItem.prNumber = parseInt(prNumStr, 10);
    }

    switch (status) {
      case "merged": {
        // Collision detection: verify the merged PR's title matches this work item's title.
        // If titles don't match, the merged PR belongs to a previous item that reused the
        // same ID -- treat as no-pr to avoid falsely completing the new item (H-MID-1).
        // BUT: skip the title check if the orchestrator already tracked this PR number
        // (from daemon state) -- that means we assigned it during the previous run,
        // so it's definitely ours regardless of how the worker titled it.
        const mergedPrNum = prNumStr ? parseInt(prNumStr, 10) : undefined;
        const alreadyTracked = mergedPrNum != null && previousPrNumber === mergedPrNum;
        if (alreadyTracked) {
          orch.setState(item.id, "merged");
        } else {
          const mergedPrTitle = parts[5] ?? "";
          const itemTitle = orch.getItem(item.id)?.workItem.title ?? "";
          if (mergedPrTitle && itemTitle && !prTitleMatchesWorkItem(mergedPrTitle, itemTitle)) {
            orch.setState(item.id, "implementing");
            recoverWorkspaceRef(orch, item.id, workspaceList);
          } else {
            orch.setState(item.id, "merged");
          }
        }
        break;
      }
      case "ready":
      case "ci-passed":
        orch.setState(item.id, "ci-passed");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "failing":
        orch.setState(item.id, "ci-failed");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "pending":
        orch.setState(item.id, "ci-pending");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "no-pr":
      default:
        orch.setState(item.id, "implementing");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
    }
  }
}

/**
 * Try to recover the workspaceRef for an implementing item by matching
 * its item ID in the cmux workspace listing.
 *
 * Workspace names follow the pattern: "workspace:N  ✳ <ID> <title>"
 * so we scan for lines containing the item ID.
 */
function recoverWorkspaceRef(
  orch: Orchestrator,
  itemId: string,
  workspaceList: string,
): void {
  if (!workspaceList) return;

  for (const line of workspaceList.split("\n")) {
    if (!line.includes(itemId)) continue;
    const match = line.match(/workspace:\d+/);
    if (match) {
      const orchItem = orch.getItem(itemId);
      if (orchItem) {
        orchItem.workspaceRef = match[0];
      }
      return;
    }
  }
}
