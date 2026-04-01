// State reconstruction (crash recovery): reads disk state and recovers OrchestratorItem state.
// Extracted from core/commands/orchestrate.ts for modularity.

import { existsSync } from "fs";
import { join } from "path";
import type { Orchestrator, OrchestratorItem, OrchestratorItemState } from "./orchestrator.ts";
import type { DaemonState } from "./daemon.ts";
import { getWorktreeInfo } from "./cross-repo.ts";
import { checkPrStatus } from "./commands/pr-monitor.ts";
import { classifyPrMetadataMatch } from "./work-item-files.ts";
import type { Multiplexer } from "./mux.ts";

// ── State reconstruction (crash recovery) ──────────────────────────

function isRepairPrCandidate(itemId: string, candidateId: string): boolean {
  return candidateId === `fix-forward-${itemId}` || candidateId === `revert-${itemId}`;
}

function trackedPrStatusIds(item: OrchestratorItem): string[] {
  if (item.state === "fixing-forward" || (item.priorPrNumbers?.length ?? 0) > 0) {
    return [`fix-forward-${item.id}`, `revert-${item.id}`];
  }
  return [item.id];
}

function resolveTrackedPrStatus(
  item: OrchestratorItem,
  repoRoot: string,
  checkPr: (id: string, root: string) => string | null,
  options: { forceRepairCandidates?: boolean } = {},
): string | null {
  let fallback: string | null = null;
  const candidateIds = options.forceRepairCandidates
    ? [`fix-forward-${item.id}`, `revert-${item.id}`]
    : trackedPrStatusIds(item);
  for (const candidateId of candidateIds) {
    const statusLine = checkPr(candidateId, repoRoot);
    if (!statusLine) continue;
    const status = statusLine.split("\t")[2];
    if (status && status !== "no-pr") {
      return statusLine;
    }
    if (!fallback) {
      fallback = statusLine;
    }
  }
  return fallback;
}

function adoptTrackedPrNumber(item: OrchestratorItem, prNumber: number | undefined): void {
  if (prNumber == null) return;
  if (item.prNumber != null && item.prNumber !== prNumber) {
    const priorPrNumbers = [...(item.priorPrNumbers ?? [])];
    if (!priorPrNumbers.includes(item.prNumber)) {
      priorPrNumbers.push(item.prNumber);
    }
    item.priorPrNumbers = priorPrNumbers;
  }
  item.prNumber = prNumber;
}

function isRepairReentryState(state: string | undefined): state is OrchestratorItemState {
  return state === "ci-pending"
    || state === "ci-passed"
    || state === "ci-failed"
    || state === "review-pending"
    || state === "reviewing"
    || state === "merging"
    || state === "merged";
}

function restoreRepairPrTrackingState(
  orch: Orchestrator,
  item: OrchestratorItem,
  repoRoot: string,
  checkPr: (id: string, root: string) => string | null,
  savedState: OrchestratorItemState,
): boolean {
  const statusLine = resolveTrackedPrStatus(item, repoRoot, checkPr, {
    forceRepairCandidates: savedState === "fixing-forward",
  });
  if (!statusLine) {
    if (item.prNumber != null) {
      orch.hydrateState(item.id, savedState);
      return true;
    }
    return false;
  }

  const parts = statusLine.split("\t");
  const candidateId = parts[0] ?? item.id;
  const prNumStr = parts[1];
  const status = parts[2];
  const previousPrNumber = item.prNumber;

  if (prNumStr) {
    adoptTrackedPrNumber(item, parseInt(prNumStr, 10));
  }

  switch (status) {
    case "merged": {
      const mergedPrTitle = parts[5] ?? "";
      const mergedPrLineageToken = parts[6] ?? "";
      const mergedPrNum = prNumStr ? parseInt(prNumStr, 10) : undefined;
      const alreadyTracked = mergedPrNum != null && previousPrNumber === mergedPrNum;
      const prMatch = classifyPrMetadataMatch(
        { title: mergedPrTitle, lineageToken: mergedPrLineageToken },
        item.workItem,
      );
      if (
        isRepairPrCandidate(item.id, candidateId)
        || alreadyTracked
        || prMatch.matches
      ) {
        orch.hydrateState(item.id, "merged");
      } else {
        orch.hydrateState(item.id, savedState);
      }
      return true;
    }
    case "ready":
    case "ci-passed":
      orch.hydrateState(item.id, "ci-passed");
      return true;
    case "failing":
      orch.hydrateState(item.id, "ci-failed");
      return true;
    case "open":
    case "pending":
      orch.hydrateState(item.id, "ci-pending");
      return true;
    case "no-pr":
      if (item.prNumber != null) {
        orch.hydrateState(item.id, savedState);
        return true;
      }
      return false;
    default:
      return false;
  }
}

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
  const savedItems = new Map<string, {
    state: string;
    ciFailCount: number;
    retryCount: number;
    prNumber: number | null;
    priorPrNumbers?: number[];
    reviewWorkspaceRef?: string;
    reviewCompleted?: boolean;
    reviewRound?: number;
    lastCommentCheck?: string;
    rebaseRequested?: boolean;
    lastRebaseNudgeAt?: string;
    rebaseNudgeCount?: number;
    ciFailureNotified?: boolean;
    ciFailureNotifiedAt?: string | null;
    rebaserWorkspaceRef?: string;
    mergeCommitSha?: string;
    defaultBranch?: string;
    fixForwardFailCount?: number;
    fixForwardWorkspaceRef?: string;
    worktreePath?: string;
    resolvedRepoRoot?: string;
    aiTool?: string;
  }>();
  if (daemonState?.items) {
    for (const si of daemonState.items) {
      // Backward compat: map old field names to new names
      const raw = si as unknown as Record<string, unknown>;
      const rebaserRef = raw.rebaserWorkspaceRef as string | undefined ?? (raw.repairWorkspaceRef as string | undefined);
      const fixForwardFailCount = si.fixForwardFailCount ?? (raw.verifyFailCount as number | undefined);
      const fixForwardWorkspaceRef = si.fixForwardWorkspaceRef ?? (raw.verifyWorkspaceRef as string | undefined);
      savedItems.set(si.id, {
        state: si.state,
        ciFailCount: si.ciFailCount,
        retryCount: si.retryCount,
        prNumber: si.prNumber,
        priorPrNumbers: si.priorPrNumbers,
        reviewWorkspaceRef: si.reviewWorkspaceRef,
        reviewCompleted: si.reviewCompleted,
        reviewRound: si.reviewRound,
        lastCommentCheck: si.lastCommentCheck,
        rebaseRequested: si.rebaseRequested,
        lastRebaseNudgeAt: si.lastRebaseNudgeAt,
        rebaseNudgeCount: si.rebaseNudgeCount,
        ciFailureNotified: si.ciFailureNotified,
        ciFailureNotifiedAt: si.ciFailureNotifiedAt,
        rebaserWorkspaceRef: rebaserRef,
        mergeCommitSha: si.mergeCommitSha,
        defaultBranch: si.defaultBranch,
        fixForwardFailCount,
        fixForwardWorkspaceRef,
        worktreePath: si.worktreePath,
        resolvedRepoRoot: si.resolvedRepoRoot,
        aiTool: si.aiTool,
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
      if (saved.prNumber != null) item.prNumber = saved.prNumber;
      if (saved.priorPrNumbers?.length) item.priorPrNumbers = [...saved.priorPrNumbers];
      if (saved.reviewWorkspaceRef) item.reviewWorkspaceRef = saved.reviewWorkspaceRef;
      if (saved.reviewCompleted) item.reviewCompleted = saved.reviewCompleted;
      if (saved.reviewRound != null) item.reviewRound = saved.reviewRound;
      if (saved.lastCommentCheck) item.lastCommentCheck = saved.lastCommentCheck;
      if (saved.rebaseRequested) item.rebaseRequested = saved.rebaseRequested;
      if (saved.lastRebaseNudgeAt) item.lastRebaseNudgeAt = saved.lastRebaseNudgeAt;
      if (saved.rebaseNudgeCount != null) item.rebaseNudgeCount = saved.rebaseNudgeCount;
      if (saved.ciFailureNotified) item.ciFailureNotified = saved.ciFailureNotified;
      if (saved.ciFailureNotifiedAt) item.ciFailureNotifiedAt = saved.ciFailureNotifiedAt;
      if (saved.rebaserWorkspaceRef) item.rebaserWorkspaceRef = saved.rebaserWorkspaceRef;
      if (saved.mergeCommitSha) item.mergeCommitSha = saved.mergeCommitSha;
      if (saved.defaultBranch) item.defaultBranch = saved.defaultBranch;
      if (saved.fixForwardFailCount) item.fixForwardFailCount = saved.fixForwardFailCount;
      if (saved.fixForwardWorkspaceRef) item.fixForwardWorkspaceRef = saved.fixForwardWorkspaceRef;
      if (saved.worktreePath) item.worktreePath = saved.worktreePath;
      if (saved.resolvedRepoRoot) item.resolvedRepoRoot = saved.resolvedRepoRoot;
      if (saved.aiTool) item.aiTool = saved.aiTool;
    }

    // Preserve merged waiting state across restart even when the clean action
    // already removed the worktree and mergeCommitSha was not captured yet.
    if (saved?.state === "merged" && restoreMergedWaitingState(orch, item, item.resolvedRepoRoot ?? projectRoot, checkPr)) {
      continue;
    }

    // Restore post-merge fix-forward states from daemon state (these items have no worktree)
    if (saved && item.mergeCommitSha) {
      let savedState = saved.state;
      // Backward compat: map old state names to new names
      if (savedState === "verifying") savedState = "forward-fix-pending";
      if (savedState === "verify-failed") savedState = "fix-forward-failed";
      if (savedState === "repairing-main") savedState = "fixing-forward";
      if (savedState === "fixing-forward") {
        if (restoreRepairPrTrackingState(orch, item, item.resolvedRepoRoot ?? projectRoot, checkPr, "fixing-forward")) {
          continue;
        }
        orch.hydrateState(item.id, "fixing-forward");
        continue;
      }
      if (savedState === "forward-fix-pending" || savedState === "fix-forward-failed") {
        orch.hydrateState(item.id, savedState as OrchestratorItemState);
        continue;
      }
    }

    if (saved && saved.priorPrNumbers?.length && isRepairReentryState(saved.state)) {
      if (restoreRepairPrTrackingState(orch, item, item.resolvedRepoRoot ?? projectRoot, checkPr, saved.state)) {
        continue;
      }
    }

    // Check for worktree: cross-repo index first, then hub-local fallback
    const repoRoot = item.resolvedRepoRoot ?? projectRoot;
    const wtInfo = getWorktreeInfo(item.id, crossRepoIndex, worktreeDir);
    const fallbackWtPath = join(worktreeDir, `ninthwave-${item.id}`);
    let wtPath: string | undefined;
    for (const candidate of [wtInfo?.worktreePath, item.worktreePath, fallbackWtPath]) {
      if (candidate && existsSync(candidate)) {
        wtPath = candidate;
        break;
      }
    }
    if (!wtPath) continue;
    item.worktreePath = wtPath;

    // Item has a worktree -- check PR status in the correct repo
    const statusLine = resolveTrackedPrStatus(item, repoRoot, checkPr);
    if (!statusLine) {
      hydrateKnownPrTrackingOrImplementing(orch, item.id);
      recoverWorkspaceRef(orch, item.id, workspaceList);
      continue;
    }

    const parts = statusLine.split("\t");
    const candidateId = parts[0] ?? item.id;
    const prNumStr = parts[1];
    const status = parts[2];

    // Capture the pre-existing prNumber (from daemon state) BEFORE overwriting it.
    // Used by the merged-case alreadyTracked check below.
    const previousPrNumber = orch.getItem(item.id)?.prNumber;

    if (prNumStr) {
      const orchItem = orch.getItem(item.id)!;
      adoptTrackedPrNumber(orchItem, parseInt(prNumStr, 10));
    }

    switch (status) {
      case "merged": {
        // Collision detection: verify the merged PR's title matches this work item's title.
        // If titles don't match, the merged PR belongs to a previous item that reused the
        // same ID -- treat as no-pr to avoid falsely completing the new item (H-MID-1).
        // BUT: skip the metadata check if the orchestrator already tracked this PR number
        // (from daemon state) -- that means we assigned it during the previous run,
        // so it's definitely ours regardless of how the worker titled it.
        const mergedPrNum = prNumStr ? parseInt(prNumStr, 10) : undefined;
        const alreadyTracked = mergedPrNum != null && previousPrNumber === mergedPrNum;
        if (isRepairPrCandidate(item.id, candidateId) || alreadyTracked) {
          orch.hydrateState(item.id, "merged");
        } else {
          const mergedPrTitle = parts[5] ?? "";
          const mergedPrLineageToken = parts[6] ?? "";
          const workItem = orch.getItem(item.id)?.workItem;
          const prMatch = workItem
            ? classifyPrMetadataMatch(
                { title: mergedPrTitle, lineageToken: mergedPrLineageToken },
                workItem,
              )
            : { matches: true as const };
          if (workItem && !prMatch.matches) {
            orch.hydrateState(item.id, "implementing");
            recoverWorkspaceRef(orch, item.id, workspaceList);
          } else {
            orch.hydrateState(item.id, "merged");
          }
        }
        break;
      }
      case "ready":
      case "ci-passed":
        orch.hydrateState(item.id, "ci-passed");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "failing":
        orch.hydrateState(item.id, "ci-failed");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "open":
      case "pending":
        orch.hydrateState(item.id, "ci-pending");
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
      case "no-pr":
      default:
        hydrateKnownPrTrackingOrImplementing(orch, item.id);
        recoverWorkspaceRef(orch, item.id, workspaceList);
        break;
    }
  }
}

function restoreMergedWaitingState(
  orch: Orchestrator,
  item: OrchestratorItem,
  repoRoot: string,
  checkPr: (id: string, root: string) => string | null,
): boolean {
  const statusLine = resolveTrackedPrStatus(item, repoRoot, checkPr);
  if (!statusLine) {
    if (item.prNumber != null || item.mergeCommitSha) {
      orch.hydrateState(item.id, "merged");
      return true;
    }
    return false;
  }

  const parts = statusLine.split("\t");
  const candidateId = parts[0] ?? item.id;
  const prNumStr = parts[1];
  const status = parts[2];
  const previousPrNumber = item.prNumber;

  if (prNumStr) {
    adoptTrackedPrNumber(item, parseInt(prNumStr, 10));
  }

  if (status === "merged") {
    const mergedPrTitle = parts[5] ?? "";
    const mergedPrLineageToken = parts[6] ?? "";
    const trackedPrMatches = prNumStr ? previousPrNumber === parseInt(prNumStr, 10) : false;
    const prMatch = classifyPrMetadataMatch(
      { title: mergedPrTitle, lineageToken: mergedPrLineageToken },
      item.workItem,
    );
    if (
      isRepairPrCandidate(item.id, candidateId)
      || trackedPrMatches
      || prMatch.matches
    ) {
      orch.hydrateState(item.id, "merged");
      return true;
    }
  }

  if (status === "no-pr" && item.prNumber != null) {
    orch.hydrateState(item.id, "merged");
    return true;
  }

  return false;
}

function hydrateKnownPrTrackingOrImplementing(
  orch: Orchestrator,
  itemId: string,
): void {
  const item = orch.getItem(itemId);
  if (item?.prNumber != null) {
    // GitHub can briefly return empty/no-pr after we've already tracked a PR.
    // Preserve PR-tracking flow on restart instead of regressing to implementing.
    orch.hydrateState(itemId, "ci-pending");
    return;
  }
  orch.hydrateState(itemId, "implementing");
}

/**
 * Try to recover the workspaceRef for an implementing item by matching
 * its item ID in the live multiplexer workspace listing.
 *
 * cmux listings include refs like "workspace:N  ✳ <ID> <title>" while tmux
 * listings return one ref per line (for example, "session:nw:<ID>").
 */
function recoverWorkspaceRef(
  orch: Orchestrator,
  itemId: string,
  workspaceList: string,
): void {
  if (!workspaceList) return;

  for (const line of workspaceList.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(itemId)) continue;

    const match = trimmed.match(/workspace:\d+/);
    const workspaceRef = match?.[0] ?? trimmed;
    const orchItem = orch.getItem(itemId);
    if (orchItem) {
      orchItem.workspaceRef = workspaceRef;
    }
    return;
  }
}
