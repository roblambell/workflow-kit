// State reconstruction (crash recovery): reads disk state and recovers OrchestratorItem state.
// Extracted from core/commands/orchestrate.ts for modularity.

import { existsSync } from "fs";
import { join } from "path";
import type { Orchestrator, OrchestratorItem, OrchestratorItemState, PendingFeedbackBatch } from "./orchestrator.ts";
import type { DaemonState } from "./daemon.ts";
import { checkPrStatus } from "./commands/pr-monitor.ts";
import { classifyPrMetadataMatch } from "./work-item-files.ts";
import type { Multiplexer } from "./mux.ts";
import { RESTART_RECOVERY_HOLD_REASON } from "./orchestrator-types.ts";

// ── State reconstruction (crash recovery) ──────────────────────────

export interface UnresolvedImplementationReattachment {
  itemId: string;
  worktreePath: string;
  savedWorkspaceRef?: string;
}

export interface ReconstructionResult {
  unresolvedImplementations: UnresolvedImplementationReattachment[];
}

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
): ReconstructionResult {
  const result: ReconstructionResult = { unresolvedImplementations: [] };
  // Build a lookup map from saved daemon state for restoring persisted counters and review fields
  const savedItems = new Map<string, {
    state: string;
    ciFailCount: number;
    ciFailCountTotal: number;
    retryCount: number;
    timeoutDeadline?: string;
    timeoutExtensionCount?: number;
    prNumber: number | null;
    priorPrNumbers?: number[];
    reviewWorkspaceRef?: string;
    reviewCompleted?: boolean;
    reviewRound?: number;
    lastReviewedCommitSha?: string | null;
    lastCommentCheck?: string;
    pendingFeedbackBatch?: PendingFeedbackBatch;
    needsFeedbackResponse?: boolean;
    pendingFeedbackMessage?: string;
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
    workspaceRef?: string;
    aiTool?: string;
    failureReason?: string;
    sessionParked?: boolean;
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
        ciFailCountTotal: si.ciFailCountTotal ?? si.ciFailCount,
        retryCount: si.retryCount,
        timeoutDeadline: si.timeoutDeadline,
        timeoutExtensionCount: si.timeoutExtensionCount,
        prNumber: si.prNumber,
        priorPrNumbers: si.priorPrNumbers,
        reviewWorkspaceRef: si.reviewWorkspaceRef,
        reviewCompleted: si.reviewCompleted,
        reviewRound: si.reviewRound,
        lastReviewedCommitSha: si.lastReviewedCommitSha,
        lastCommentCheck: si.lastCommentCheck,
        pendingFeedbackBatch: si.pendingFeedbackBatch,
        needsFeedbackResponse: si.needsFeedbackResponse,
        pendingFeedbackMessage: si.pendingFeedbackMessage,
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
        workspaceRef: si.workspaceRef,
        aiTool: si.aiTool,
        failureReason: si.failureReason,
        sessionParked: si.sessionParked,
      });
    }
  }

  // Pre-fetch workspace list once (avoid per-item shell calls)
  const workspaceList = mux ? mux.listWorkspaces() : "";

  for (const item of orch.getAllItems()) {
    // Restore persisted counters and review fields from daemon state (before any state transitions)
    const saved = savedItems.get(item.id);
    if (saved) {
      item.ciFailCountTotal = saved.ciFailCountTotal;
      item.retryCount = saved.retryCount;
      if (saved.timeoutDeadline) item.timeoutDeadline = saved.timeoutDeadline;
      if (saved.timeoutExtensionCount != null) item.timeoutExtensionCount = saved.timeoutExtensionCount;
      if (saved.prNumber != null) item.prNumber = saved.prNumber;
      if (saved.priorPrNumbers?.length) item.priorPrNumbers = [...saved.priorPrNumbers];
      if (saved.reviewWorkspaceRef) item.reviewWorkspaceRef = saved.reviewWorkspaceRef;
      if (saved.reviewCompleted) item.reviewCompleted = saved.reviewCompleted;
      if (saved.reviewRound != null) item.reviewRound = saved.reviewRound;
      if (saved.lastReviewedCommitSha != null) item.lastReviewedCommitSha = saved.lastReviewedCommitSha;
      if (saved.lastCommentCheck) item.lastCommentCheck = saved.lastCommentCheck;
      if (saved.pendingFeedbackBatch) item.pendingFeedbackBatch = saved.pendingFeedbackBatch;
      if (saved.needsFeedbackResponse) item.needsFeedbackResponse = saved.needsFeedbackResponse;
      if (saved.pendingFeedbackMessage) item.pendingFeedbackMessage = saved.pendingFeedbackMessage;
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
      if (saved.aiTool) item.aiTool = saved.aiTool;
      if (saved.failureReason) item.failureReason = saved.failureReason;
      if (saved.sessionParked) item.sessionParked = saved.sessionParked;
    }
    const savedWorkspaceRef = saved?.workspaceRef;

    // Preserve merged waiting state across restart even when the clean action
    // already removed the worktree and mergeCommitSha was not captured yet.
    if (saved?.state === "merged" && restoreMergedWaitingState(orch, item, projectRoot, checkPr)) {
      continue;
    }

    if (saved?.state === "blocked") {
      // Restart-hold items with an existing worktree can be re-evaluated instead of staying stuck.
      if (saved.failureReason === RESTART_RECOVERY_HOLD_REASON && saved.worktreePath && existsSync(saved.worktreePath)) {
        result.unresolvedImplementations.push({
          itemId: item.id,
          worktreePath: saved.worktreePath,
          ...(saved.workspaceRef ? { savedWorkspaceRef: saved.workspaceRef } : {}),
        });
        orch.hydrateState(item.id, "implementing");
        continue;
      }
      orch.hydrateState(item.id, "blocked");
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
        if (restoreRepairPrTrackingState(orch, item, projectRoot, checkPr, "fixing-forward")) {
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
      if (restoreRepairPrTrackingState(orch, item, projectRoot, checkPr, saved.state)) {
        continue;
      }
    }

    // Check for worktree
    const hubWtPath = join(worktreeDir, `ninthwave-${item.id}`);
    let wtPath: string | undefined;
    for (const candidate of [item.worktreePath, hubWtPath]) {
      if (candidate && existsSync(candidate)) {
        wtPath = candidate;
        break;
      }
    }
    if (!wtPath) {
      item.worktreePath = undefined;
      item.workspaceRef = undefined;
      continue;
    }
    item.worktreePath = wtPath;

    // Item has a worktree -- check PR status
    const statusLine = resolveTrackedPrStatus(item, projectRoot, checkPr);
    if (!statusLine) {
      hydrateKnownPrTrackingOrImplementing(orch, item.id);
      const workspaceRecovery = recoverWorkspaceRef(orch, item.id, workspaceList, savedWorkspaceRef);
      if (orch.getItem(item.id)?.state === "implementing" && workspaceRecovery.status === "unresolved") {
        result.unresolvedImplementations.push({
          itemId: item.id,
          worktreePath: wtPath,
          ...(savedWorkspaceRef ? { savedWorkspaceRef } : {}),
        });
      }
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
            recoverWorkspaceRef(orch, item.id, workspaceList, savedWorkspaceRef);
          } else {
            orch.hydrateState(item.id, "merged");
          }
        }
        break;
      }
      case "ready":
      case "ci-passed":
        orch.hydrateState(item.id, "ci-passed");
        recoverWorkspaceRef(orch, item.id, workspaceList, savedWorkspaceRef);
        break;
      case "failing":
        orch.hydrateState(item.id, "ci-failed");
        recoverWorkspaceRef(orch, item.id, workspaceList, savedWorkspaceRef);
        break;
      case "open":
      case "pending":
        orch.hydrateState(item.id, "ci-pending");
        recoverWorkspaceRef(orch, item.id, workspaceList, savedWorkspaceRef);
        break;
      case "no-pr":
      default:
        hydrateKnownPrTrackingOrImplementing(orch, item.id);
        const workspaceRecovery = recoverWorkspaceRef(orch, item.id, workspaceList, savedWorkspaceRef);
        if (orch.getItem(item.id)?.state === "implementing" && workspaceRecovery.status === "unresolved") {
          result.unresolvedImplementations.push({
            itemId: item.id,
            worktreePath: wtPath,
            ...(savedWorkspaceRef ? { savedWorkspaceRef } : {}),
          });
        }
        break;
    }
  }

  return result;
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
 * Try to recover the workspaceRef for a live implementation worker during
 * restart recovery.
 *
 * cmux listings include refs like "workspace:N  ✳ <ID> <title>" while tmux
 * listings return one ref per line (for example, "session:nw:<ID>").
 */
type WorkspaceRecoveryResult =
  | { status: "saved-ref" | "item-id"; workspaceRef: string }
  | { status: "unresolved" };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractWorkspaceRef(line: string): string {
  return line.trim().split(/\s+/, 1)[0] ?? line;
}

function lineIncludesWorkspaceRef(line: string, workspaceRef: string): boolean {
  if (line === workspaceRef) return true;
  const escaped = escapeRegExp(workspaceRef);
  return new RegExp(`(^|\\s)${escaped}($|\\s)`).test(line);
}

function recoverWorkspaceRef(
  orch: Orchestrator,
  itemId: string,
  workspaceList: string,
  savedWorkspaceRef?: string,
): WorkspaceRecoveryResult {
  const orchItem = orch.getItem(itemId);
  if (!orchItem) {
    return { status: "unresolved" };
  }

  orchItem.workspaceRef = undefined;

  if (!workspaceList) {
    return { status: "unresolved" };
  }

  for (const line of workspaceList.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !savedWorkspaceRef) continue;
    if (!lineIncludesWorkspaceRef(trimmed, savedWorkspaceRef)) continue;

    const workspaceRef = extractWorkspaceRef(trimmed);
    orchItem.workspaceRef = workspaceRef;
    return { status: "saved-ref", workspaceRef };
  }

  for (const line of workspaceList.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(itemId)) continue;

    const workspaceRef = extractWorkspaceRef(trimmed);
    orchItem.workspaceRef = workspaceRef;
    return { status: "item-id", workspaceRef };
  }

  return { status: "unresolved" };
}
