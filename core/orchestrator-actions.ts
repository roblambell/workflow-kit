// Action execution functions for the orchestrator.
// Standalone functions extracted from the Orchestrator class.
// Imports only from orchestrator-types.ts (no circular deps with orchestrator.ts).

import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { heartbeatFilePath, writeHeartbeat } from "./daemon.ts";
import { cleanInbox } from "./commands/inbox.ts";
import { validatePickupCandidate } from "./commands/launch.ts";
import { NINTHWAVE_FOOTER, ORCHESTRATOR_LINK } from "./gh.ts";
import {
  type OrchestratorHandle,
  type OrchestratorItem,
  type Action,
  type ActionResult,
  type ExecutionContext,
  type OrchestratorDeps,
  ACTIVE_SESSION_STATES,
  getNextTool,
} from "./orchestrator-types.ts";

type InboxTargetSource = "hub-worktree" | "item-worktree";
type InboxTargetReason = "no-worktree-path" | "item-worktree-missing";
type InboxDeliveryOutcome = "delivered" | "missing-target" | "no-live-worker" | "relaunch-requested";

interface InboxTargetResolution {
  projectRoot: string | null;
  source?: InboxTargetSource;
  reason?: InboxTargetReason;
  candidateProjectRoot?: string;
}

function resolveImplementerInboxTarget(
  item: OrchestratorItem,
  ctx: ExecutionContext,
): InboxTargetResolution {
  const hubWorktreePath = join(ctx.worktreeDir, `ninthwave-${item.id}`);
  if (existsSync(hubWorktreePath)) {
    return {
      projectRoot: hubWorktreePath,
      source: "hub-worktree",
    };
  }
  if (item.worktreePath && existsSync(item.worktreePath)) {
    return {
      projectRoot: item.worktreePath,
      source: "item-worktree",
    };
  }
  if (item.worktreePath) {
    return {
      projectRoot: null,
      reason: "item-worktree-missing",
      candidateProjectRoot: item.worktreePath,
    };
  }
  return {
    projectRoot: null,
    reason: "no-worktree-path",
  };
}

function previewInboxMessage(message: string): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  return flattened.length <= 120 ? flattened : `${flattened.slice(0, 119)}…`;
}

function logInboxDelivery(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  actionType: Action["type"],
  message: string,
  resolution: InboxTargetResolution,
  outcome: InboxDeliveryOutcome,
): void {
  orch.config.onEvent?.(item.id, "inbox-delivery", {
    actionType,
    outcome,
    messagePreview: previewInboxMessage(message),
    ...(resolution.projectRoot ? { targetProjectRoot: resolution.projectRoot } : {}),
    ...(resolution.source ? { targetSource: resolution.source } : {}),
    ...(resolution.reason ? { reason: resolution.reason } : {}),
    ...(resolution.candidateProjectRoot ? { candidateProjectRoot: resolution.candidateProjectRoot } : {}),
  });
}

function deliverToImplementerInbox(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  actionType: Action["type"],
  message: string,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): InboxTargetResolution {
  const resolution = resolveImplementerInboxTarget(item, ctx);
  if (!resolution.projectRoot) {
    logInboxDelivery(orch, item, actionType, message, resolution, "missing-target");
    return resolution;
  }

  deps.io.writeInbox(resolution.projectRoot, item.id, message);
  logInboxDelivery(orch, item, actionType, message, resolution, "delivered");
  return resolution;
}

function resolveDefaultBranch(
  item: OrchestratorItem,
  repoRoot: string,
  deps: OrchestratorDeps,
  fallback: string = "main",
): string {
  if (item.defaultBranch) return item.defaultBranch;
  try {
    const branch = deps.gh.getDefaultBranch?.(repoRoot) ?? fallback;
    if (branch) {
      item.defaultBranch = branch;
      return branch;
    }
  } catch {
    // Non-fatal -- fall back to the historical default.
  }
  return fallback;
}

const DEP_DONE_STATES: ReadonlySet<string> = new Set([
  "done",
  "merged",
  "forward-fix-pending",
  "fix-forward-failed",
]);

function resolveExpectedPrBase(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  defaultBranch: string,
): string {
  if (!item.baseBranch) return defaultBranch;

  const depId = item.baseBranch.replace(/^ninthwave\//, "");
  const dep = orch.getItem(depId);
  if (!dep || DEP_DONE_STATES.has(dep.state)) {
    return defaultBranch;
  }

  return item.baseBranch;
}

/**
 * Detect the "dep merged, GitHub retargeted" pattern and rebase instead of blocking.
 *
 * When a stacked item's dep is squash-merged, GitHub auto-retargets the PR to main
 * and deletes the dep branch. The orchestrator sees a base mismatch (expected dep branch,
 * actual main) and the retarget back to the deleted branch fails. Instead of blocking,
 * clear the stacking state and rebase onto main.
 *
 * Returns an ActionResult if handled, null to fall through to existing behavior.
 */
function handleDepMergedRetarget(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  prNum: number,
  actualBase: string,
  expectedBase: string,
  defaultBranch: string,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult | null {
  if (!expectedBase.startsWith("ninthwave/") || actualBase !== defaultBranch) {
    return null;
  }

  // Dep was merged and GitHub retargeted the PR to main. Clear stacking state.
  item.baseBranch = undefined;

  // Rebase to clean up duplicate commits from squash merge.
  if (deps.git.daemonRebase) {
    const worktreePath = item.worktreePath ?? join(ctx.worktreeDir, `ninthwave-${item.id}`);
    const branch = `ninthwave/${item.id}`;
    try {
      if (deps.git.daemonRebase(worktreePath, branch)) {
        deps.io.warn?.(`PR #${prNum} for ${item.id}: dep branch ${expectedBase} was merged; rebased onto ${defaultBranch}`);
        orch.transition(item, "ci-pending");
        return { success: false, error: `Dep ${expectedBase} merged; rebased PR #${prNum} onto ${defaultBranch}, waiting for CI` };
      }
    } catch { /* fall through to worker rebase */ }
  }

  // Daemon rebase unavailable or failed -- worker fallback
  const msg = `[ORCHESTRATOR] Rebase Required: dependency branch ${expectedBase} was squash-merged to ${defaultBranch}. Please rebase onto latest ${defaultBranch}.`;
  deliverToImplementerInbox(orch, item, "rebase", msg, ctx, deps);
  deps.io.warn?.(`PR #${prNum} for ${item.id}: dep branch ${expectedBase} was merged; daemon rebase failed, sent worker rebase request`);
  orch.transition(item, "ci-pending");
  return { success: false, error: `Dep ${expectedBase} merged; daemon rebase failed for PR #${prNum}, rebase requested` };
}

/**
 * Check if an item was recently unstacked (has a dependency in a done/merged state).
 * Used to detect post-squash-merge duplicate-commit scenarios where bases match
 * but the branch needs rebasing.
 */
function wasRecentlyUnstacked(orch: OrchestratorHandle, item: OrchestratorItem): boolean {
  for (const depId of item.workItem.dependencies) {
    const dep = orch.getItem(depId);
    if (dep && DEP_DONE_STATES.has(dep.state)) return true;
  }
  return false;
}

/** Launch a worker for an item. Stores workspaceRef on success, marks stuck or schedules retry on failure. */
export function executeLaunch(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const validation = (deps.workers.validatePickupCandidate ?? validatePickupCandidate)(item.workItem, ctx.projectRoot);
  if (validation.status === "blocked") {
    orch.transition(item, "blocked");
    item.failureReason = validation.failureReason;
    return { success: false, error: validation.failureReason };
  }

  const hasCiFix = item.needsCiFix === true;
  const hasFeedback = item.needsFeedbackResponse === true;
  const feedbackMessage = item.pendingFeedbackMessage;

  // Skip the "existing PR detected" shortcut only when no relaunch reason is set.
  // CI fixes and parked-review feedback both need a live worker even when a PR exists.
  if (validation.status === "skip-with-pr" && !hasCiFix && !hasFeedback) {
    item.prNumber = validation.existingPrNumber;
    orch.transition(item, "ci-pending");
    return { success: true };
  }

  // Clean stale branches before launching (H-ORC-4).
  // When a work item ID is reused with different work, the old branch may have
  // merged PRs that cause workers to falsely exit as "done".
  if (deps.cleanup.cleanStaleBranch) {
    try {
      deps.cleanup.cleanStaleBranch(item.workItem, ctx.projectRoot);
    } catch (e) {
      // Non-fatal -- log and attempt launch anyway
      const msg = e instanceof Error ? e.message : String(e);
      deps.io.warn?.(`cleanStaleBranch failed for ${item.id}: ${msg}`);
    }
  }

  // Reset heartbeat to 0% before launch to prevent stale 1.0 from a prior run
  // showing 100% during the startup gap (~30-60s until worker's first heartbeat).
  try {
    writeHeartbeat(ctx.projectRoot, item.id, 0, "Starting");
  } catch { /* best-effort -- heartbeat reset failure doesn't block launch */ }

  // Guard: if dep has completed (merged/done) since the action was created,
  // clear baseBranch so the item launches from main instead of a stale
  // dependency branch that no longer exists on origin (H-SL-1).
  if (action.baseBranch) {
    const depId = action.baseBranch.replace(/^ninthwave\//, "");
    const dep = orch.getItem(depId);
    if (!dep || DEP_DONE_STATES.has(dep.state)) {
      deps.io.warn?.(`Dependency ${depId} is now ${dep?.state ?? "unknown"} -- clearing baseBranch for ${item.id} to launch from main`);
      action.baseBranch = undefined;
      item.baseBranch = undefined;
    }
  }

  // When needsCiFix is set, force worker launch even if an existing PR is
  // found. This ensures CI failures on restart are addressed by a live worker
  // rather than silently tracked in ci-pending with no one to fix them (H-WR-1).
  const forceWorker = hasCiFix || hasFeedback;
  item.needsCiFix = false;

  const selectedTool = getNextTool(ctx);
  try {
    const result = deps.workers.launchSingleItem(
      item.workItem,
      ctx.workDir,
      ctx.worktreeDir,
      ctx.projectRoot,
      selectedTool,
      action.baseBranch,
      forceWorker,
    );
    if (!result) {
      if (item.retryCount < orch.config.maxRetries) {
        item.retryCount++;
        orch.transition(item, "ready");
        return { success: false, error: `Launch failed for ${item.id}, scheduled retry ${item.retryCount}/${orch.config.maxRetries}` };
      }
      orch.transition(item, "stuck");
      item.failureReason = `launch-failed: worker launch returned no result for ${item.id}`;
      return { success: false, error: `Launch failed for ${item.id}` };
    }

    // Existing PR detected -- skip worker launch, transition to ci-pending.
    // The daemon will handle rebase and CI tracking from here.
    if (result.existingPrNumber) {
      item.prNumber = result.existingPrNumber;
      orch.transition(item, "ci-pending");
      return { success: true };
    }

    item.workspaceRef = result.workspaceRef;
    item.worktreePath = result.worktreePath;
    item.aiTool = selectedTool;

    // Deliver CI fix instruction AFTER launch (after cleanInbox runs inside launch).
    // Writing before launch would be wiped by cleanInbox which clears stale
    // messages from prior sessions. Route through the standard delivery helper so
    // the CI-fix message lands in the same namespace as every other notification
    // (review feedback, rebase, etc.) and matches where the worker's read path
    // resolves via `resolveActiveWorkerNamespace`.
    if (hasCiFix) {
      deliverToImplementerInbox(
        orch,
        item,
        "launch",
        "[ORCHESTRATOR] CI Fix Request: CI failed on your PR -- please investigate the failure, fix the issue, and push a candidate fix.",
        ctx,
        deps,
      );
    }

    if (hasFeedback && feedbackMessage) {
      deliverToImplementerInbox(
        orch,
        item,
        "launch",
        `[ORCHESTRATOR] Review Feedback:\n\n${feedbackMessage}`,
        ctx,
        deps,
      );
    }

    if (hasFeedback) {
      item.needsFeedbackResponse = false;
      item.pendingFeedbackMessage = undefined;
    }

    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (item.retryCount < orch.config.maxRetries) {
      item.retryCount++;
      orch.transition(item, "ready");
      return { success: false, error: `${msg}, scheduled retry ${item.retryCount}/${orch.config.maxRetries}` };
    }
    orch.transition(item, "stuck");
    item.failureReason = `launch-failed: ${msg}`;
    return { success: false, error: msg };
  }
}

/** Merge a PR, pull main, send rebase requests to dependent workers, and check sibling PRs for conflicts. */
export function executeMerge(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const prNum = action.prNumber ?? item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for ${item.id}` };
  }

  const repoRoot = ctx.projectRoot;
  const defaultBranch = resolveDefaultBranch(item, repoRoot, deps);
  const expectedBase = resolveExpectedPrBase(orch, item, defaultBranch);

  // Verify PR base branch before merge. Prefer getPrBaseAndState (single call
  // that also returns PR state for merged-PR detection) over getPrBaseBranch.
  if (deps.gh.getPrBaseAndState) {
    const info = deps.gh.getPrBaseAndState(repoRoot, prNum);
    if (!info) {
      // Total API failure (rate-limited or network error). Stay in "merging"
      // instead of regressing to "ci-passed" to prevent a tight retry loop.
      // handleMerging will retry when the next successful poll arrives.
      deps.io.warn?.(`Could not reach GitHub API for PR #${prNum} (${item.id}); holding in merging state`);
      return { success: false, error: `GitHub API unavailable for PR #${prNum}; holding in merging` };
    }

    if (info.prState === "MERGED") {
      // PR was already merged externally. Transition directly to merged.
      orch.transition(item, "merged");
      if (item.workspaceRef) {
        deps.mux.closeWorkspace(item.workspaceRef);
        item.workspaceRef = undefined;
      }
      try {
        deps.git.fetchOrigin(repoRoot, defaultBranch);
        deps.git.ffMerge(repoRoot, defaultBranch);
      } catch { /* non-fatal */ }
      return { success: true, error: undefined };
    }

    const actualBase = info.baseBranch;
    if (!actualBase) {
      // Got state but not base branch -- unusual. Hold in merging.
      deps.io.warn?.(`PR #${prNum} base branch unknown for ${item.id}; holding in merging state`);
      return { success: false, error: `PR #${prNum} base branch unknown; holding in merging` };
    }

    if (actualBase !== expectedBase) {
      if (deps.gh.retargetPrBase?.(repoRoot, prNum, expectedBase)) {
        item.baseBranch = expectedBase === defaultBranch ? undefined : expectedBase;
        deps.io.warn?.(
          `Retargeted PR #${prNum} for ${item.id} from ${actualBase} to ${expectedBase}; waiting for CI before merge`,
        );
        orch.transition(item, "ci-pending");
        return {
          success: false,
          error: `Retargeted PR #${prNum} from ${actualBase} to ${expectedBase}; waiting for CI`,
        };
      }

      // Check if this is a "dep merged, GitHub retargeted" pattern before blocking.
      const depMergedResult = handleDepMergedRetarget(orch, item, prNum, actualBase, expectedBase, defaultBranch, ctx, deps);
      if (depMergedResult) return depMergedResult;

      deps.io.warn?.(
        `PR #${prNum} for ${item.id} targets ${actualBase} but expected ${expectedBase}; blocking auto-merge`,
      );
      orch.transition(item, "ci-passed");
      return {
        success: false,
        error: `PR #${prNum} targets ${actualBase} but expected ${expectedBase}; merge blocked`,
      };
    }

    item.baseBranch = expectedBase === defaultBranch ? undefined : expectedBase;
  } else if (deps.gh.getPrBaseBranch) {
    const actualBase = deps.gh.getPrBaseBranch(repoRoot, prNum);
    if (!actualBase) {
      // API failure. Stay in "merging" to prevent ci-passed → merging loop.
      deps.io.warn?.(`Could not verify PR #${prNum} base branch for ${item.id}; holding in merging state`);
      return { success: false, error: `Could not verify base branch for PR #${prNum}; holding in merging` };
    }

    if (actualBase !== expectedBase) {
      if (deps.gh.retargetPrBase?.(repoRoot, prNum, expectedBase)) {
        item.baseBranch = expectedBase === defaultBranch ? undefined : expectedBase;
        deps.io.warn?.(
          `Retargeted PR #${prNum} for ${item.id} from ${actualBase} to ${expectedBase}; waiting for CI before merge`,
        );
        orch.transition(item, "ci-pending");
        return {
          success: false,
          error: `Retargeted PR #${prNum} from ${actualBase} to ${expectedBase}; waiting for CI`,
        };
      }

      // Check if this is a "dep merged, GitHub retargeted" pattern before blocking.
      const depMergedResult2 = handleDepMergedRetarget(orch, item, prNum, actualBase, expectedBase, defaultBranch, ctx, deps);
      if (depMergedResult2) return depMergedResult2;

      deps.io.warn?.(
        `PR #${prNum} for ${item.id} targets ${actualBase} but expected ${expectedBase}; blocking auto-merge`,
      );
      orch.transition(item, "ci-passed");
      return {
        success: false,
        error: `PR #${prNum} targets ${actualBase} but expected ${expectedBase}; merge blocked`,
      };
    }

    item.baseBranch = expectedBase === defaultBranch ? undefined : expectedBase;
  }

  // Resolve the dependency branch SHA before merge. After merge, GitHub may
  // auto-delete the branch, making the ref unresolvable. The SHA is used as
  // oldBase in rebaseOnto for stacked dependents.
  const depBranch = `ninthwave/${item.id}`;
  let depBranchRef: string = depBranch;
  if (deps.git.resolveRef) {
    try {
      const sha = deps.git.resolveRef(repoRoot, depBranch);
      if (sha) depBranchRef = sha;
    } catch {
      // Fall back to branch name
    }
  }

  const merged = deps.gh.prMerge(repoRoot, prNum, { admin: action.admin });
  if (!merged) {
    // Check if the failure is due to merge conflicts (another PR merged to the default branch while CI ran).
    // If conflicting, rebase and re-enter CI instead of blindly retrying the same failing merge.
    const isMergeable = deps.gh.checkPrMergeable?.(repoRoot, prNum) ?? true;
    if (!isMergeable) {
      // Conflict-caused failure -- rebase instead of retrying.
      // Do NOT increment mergeFailCount since this isn't a genuine merge failure.
      item.rebaseRequested = false; // Reset so the rebase path works correctly
      if (deps.git.daemonRebase) {
        const worktreePath = item.worktreePath ?? join(ctx.worktreeDir, `ninthwave-${item.id}`);
        const branch = `ninthwave/${item.id}`;
        try {
          const rebaseSuccess = deps.git.daemonRebase(worktreePath, branch);
          if (rebaseSuccess) {
            orch.transition(item, "ci-pending");
            return { success: false, error: `Merge failed for PR #${prNum} due to conflicts, rebased and waiting for CI` };
          }
        } catch {
          // Daemon rebase failed -- fall through to worker rebase
        }
      }
      // Daemon rebase unavailable or failed -- send worker a rebase message
      const rebaseMsg = `[ORCHESTRATOR] Rebase Required: merge failed due to conflicts with ${defaultBranch}. Please rebase onto latest ${defaultBranch} and push.`;
      const delivery = deliverToImplementerInbox(
        orch,
        item,
        "rebase",
        rebaseMsg,
        ctx,
        deps,
      );
      orch.transition(item, "ci-pending");
      return {
        success: false,
        error: delivery.projectRoot
          ? `Merge failed for PR #${prNum} due to conflicts, rebase requested`
          : `Merge failed for PR #${prNum} due to conflicts, but no safe worker inbox target was available`,
      };
    }

    // Post-squash-merge duplicate commits: bases matched but merge fails because
    // the branch has stale commits from a squash-merged dependency. Rebase instead
    // of retrying blindly.
    if (wasRecentlyUnstacked(orch, item)) {
      if (deps.git.daemonRebase) {
        const worktreePath = item.worktreePath ?? join(ctx.worktreeDir, `ninthwave-${item.id}`);
        const branch = `ninthwave/${item.id}`;
        try {
          if (deps.git.daemonRebase(worktreePath, branch)) {
            deps.io.warn?.(`Merge of PR #${prNum} for ${item.id} failed (likely duplicate commits from squash merge); rebased onto ${defaultBranch}`);
            orch.transition(item, "ci-pending");
            return { success: false, error: `Merge failed for PR #${prNum} (post-squash duplicate commits), rebased and waiting for CI` };
          }
        } catch { /* fall through to worker rebase */ }
      }
      const rebaseMsg = `[ORCHESTRATOR] Rebase Required: merge failed (likely duplicate commits from squash merge of dependency). Please rebase onto latest ${defaultBranch}.`;
      deliverToImplementerInbox(orch, item, "rebase", rebaseMsg, ctx, deps);
      deps.io.warn?.(`Merge of PR #${prNum} for ${item.id} failed (likely duplicate commits); daemon rebase failed, sent worker rebase request`);
      orch.transition(item, "ci-pending");
      return { success: false, error: `Merge failed for PR #${prNum} (post-squash duplicate commits), rebase requested` };
    }

    // Branch protection blocked: required checks not passing, required reviews missing, etc.
    // The branch may be out-of-date (e.g., after a stacked dep was squash-merged and GitHub
    // retargeted the PR). Rebase to bring it up to date so CI can run, then wait.
    if (deps.gh.isPrBlocked?.(repoRoot, prNum)) {
      // The branch is likely out-of-date (e.g., after a stacked dep squash-merged).
      // Rebase to bring it up to date so CI can run. Escalate to rebaser worker if
      // daemon rebase fails (e.g., merge conflicts).
      if (deps.git.daemonRebase) {
        const worktreePath = item.worktreePath ?? join(ctx.worktreeDir, `ninthwave-${item.id}`);
        const branch = `ninthwave/${item.id}`;
        try {
          if (deps.git.daemonRebase(worktreePath, branch)) {
            deps.io.warn?.(`PR #${prNum} for ${item.id} is blocked by branch protection; rebased onto ${defaultBranch} and waiting for CI`);
            orch.transition(item, "ci-pending");
            return { success: false, error: `PR #${prNum} blocked by branch protection; rebased and waiting for CI` };
          }
        } catch { /* fall through to worker rebase */ }
      }
      // Daemon rebase unavailable or failed -- escalate to worker rebase
      const rebaseMsg = `[ORCHESTRATOR] Rebase Required: PR is blocked by branch protection (branch may be out-of-date). Please rebase onto latest ${defaultBranch} and push.`;
      deliverToImplementerInbox(orch, item, "rebase", rebaseMsg, ctx, deps);
      deps.io.warn?.(`PR #${prNum} for ${item.id} is blocked by branch protection; daemon rebase failed, sent worker rebase request`);
      orch.transition(item, "ci-pending");
      return { success: false, error: `PR #${prNum} blocked by branch protection; daemon rebase failed, rebase requested` };
    }

    // Non-conflict merge failure -- normal retry behavior
    item.mergeFailCount = (item.mergeFailCount ?? 0) + 1;
    if (item.mergeFailCount >= orch.config.maxMergeRetries) {
      orch.transition(item, "stuck");
      item.failureReason = `merge-failed: exceeded max merge retries (${orch.config.maxMergeRetries}) for PR #${prNum}`;
      return { success: false, error: `Merge failed ${item.mergeFailCount} times for PR #${prNum}, marking stuck` };
    }
    orch.transition(item, "ci-passed");
    return { success: false, error: `Merge failed for PR #${prNum} (attempt ${item.mergeFailCount}/${orch.config.maxMergeRetries})` };
  }

  // Reset merge failure counter on success
  item.mergeFailCount = 0;

  // Transition to merged immediately after successful merge.
  // This ensures the item reflects reality even if subsequent steps
  // (getMergeCommitSha, audit trail) throw.
  orch.transition(item, "merged");
  // Close the workspace and free the session slot immediately after merge.
  // activeSessionCount is workspace-based, so clearing workspaceRef is
  // required to let queued items launch in the same cycle.
  if (item.workspaceRef) {
    deps.mux.closeWorkspace(item.workspaceRef);
    item.workspaceRef = undefined;
  }

  // Capture merge commit SHA for post-merge CI verification
  if (orch.config.fixForward && deps.gh.getMergeCommitSha) {
    try {
      const sha = deps.gh.getMergeCommitSha(repoRoot, prNum);
      if (sha) {
        item.mergeCommitSha = sha;
      }
    } catch {
      // Non-fatal -- metadata recovery is retried on later polls.
    }
  }

  // Audit trail
  if (deps.gh.upsertOrchestratorComment) {
    deps.gh.upsertOrchestratorComment(repoRoot, prNum, item.id, `Auto-merged PR #${prNum}.`);
  } else {
    deps.gh.prComment(repoRoot, prNum, `**[Orchestrator](${ORCHESTRATOR_LINK})** Auto-merged PR #${prNum} for ${item.id}.`);
  }

  // Pull latest default branch in the target repo (where the PR was merged)
  try {
    deps.git.fetchOrigin(repoRoot, defaultBranch);
    deps.git.ffMerge(repoRoot, defaultBranch);
  } catch {
    // Non-fatal -- default branch will be pulled on next cycle
  }

  if (deps.cleanup.completeMergedWorkItem) {
    try {
      const cleanupResult = deps.cleanup.completeMergedWorkItem(item.workItem, ctx.workDir, ctx.projectRoot);
      if (cleanupResult.status === "skipped" || cleanupResult.status === "failed") {
        const detail = cleanupResult.reason ?? `cleanup status=${cleanupResult.status}`;
        const matchMode = cleanupResult.matchMode ? ` (match mode: ${cleanupResult.matchMode})` : "";
        deps.io.warn?.(`Merged work item cleanup for ${item.id} ${cleanupResult.status}: ${detail}${matchMode}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.io.warn?.(`Merged work item cleanup for ${item.id} threw: ${msg}`);
    }
  }

  // Restack stacked dependents using rebaseOnto (squash-merge safe).
  // These items had baseBranch set to the merged dep's branch -- replay only
  // their unique commits onto the default branch, avoiding duplicate commits from squash merge.
  // Use depBranchRef (SHA resolved before merge) as oldBase so restacking
  // survives GitHub auto-deleting the merged branch.
  const restackedIds = new Set<string>();
  const successfulRestacks = new Set<string>();

  for (const other of orch.getAllItems()) {
    if (other.id === item.id) continue;
    if (!other.workItem.dependencies.includes(item.id)) continue;
    if (!ACTIVE_SESSION_STATES.has(other.state)) continue;
    if (!other.baseBranch) continue; // not stacked -- handled below

    restackedIds.add(other.id);

    const otherWorktreePath = other.worktreePath
      ?? join(ctx.worktreeDir, `ninthwave-${other.id}`);
    const otherBranch = `ninthwave/${other.id}`;

    if (!deps.git.rebaseOnto || !deps.git.forcePush) {
      // rebaseOnto or forcePush not available -- send worker manual rebase instructions
      const restackMsg = `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto ${defaultBranch} ${depBranch} ${otherBranch} && git push --force-with-lease`;
      deliverToImplementerInbox(orch, other, "rebase", restackMsg, ctx, deps);
      continue;
    }

    try {
      const success = deps.git.rebaseOnto(otherWorktreePath, defaultBranch, depBranchRef, otherBranch);
      if (success) {
        deps.git.forcePush(otherWorktreePath);
        other.baseBranch = undefined; // no longer stacked
        successfulRestacks.add(other.id);
      } else {
        // Conflict -- send worker manual rebase instructions
        const conflictMsg = `[ORCHESTRATOR] Restack Conflict: dependency ${item.id} was squash-merged but rebase --onto had conflicts. Run manually: git rebase --onto ${defaultBranch} ${depBranch} ${otherBranch}`;
        deliverToImplementerInbox(orch, other, "rebase", conflictMsg, ctx, deps);
      }
    } catch {
      // Unexpected error -- fall back to worker message
      const restackMsg2 = `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto ${defaultBranch} ${depBranch} ${otherBranch} && git push --force-with-lease`;
      deliverToImplementerInbox(orch, other, "rebase", restackMsg2, ctx, deps);
    }
  }

  // Send rebase requests to non-stacked dependent items in session states.
  // Stacked items were handled above via rebaseOnto -- skip them.
  for (const other of orch.getAllItems()) {
    if (other.id === item.id) continue;
    if (!other.workItem.dependencies.includes(item.id)) continue;
    if (!ACTIVE_SESSION_STATES.has(other.state)) continue;
    if (restackedIds.has(other.id)) continue;
    const rebaseMsg2 = `Dependency ${item.id} merged. Please rebase onto latest ${defaultBranch}.`;
    deliverToImplementerInbox(orch, other, "rebase", rebaseMsg2, ctx, deps);
  }

  // Post-merge daemon-rebase: proactively rebase in-flight sibling PRs.
  // This eliminates most conflicts before workers notice, reducing CI churn.
  // Skip restacked items -- they were already rebased with --onto above.
  for (const other of orch.getAllItems()) {
    if (other.id === item.id) continue;
    if (!ACTIVE_SESSION_STATES.has(other.state)) continue;
    if (!other.prNumber) continue;
    if (restackedIds.has(other.id)) continue;

    const otherBranch = `ninthwave/${other.id}`;
    const otherWorktreePath = other.worktreePath
      ?? join(ctx.worktreeDir, `ninthwave-${other.id}`);

    // Try daemon-rebase first for all siblings
    let daemonSuccess = false;
    if (deps.git.daemonRebase) {
      try {
        daemonSuccess = deps.git.daemonRebase(otherWorktreePath, otherBranch);
      } catch {
        // Fall through to conflict check
      }
    }

    if (daemonSuccess) continue; // CI re-runs automatically on force-push

    // Daemon rebase failed or unavailable -- check if actually conflicting
    if (deps.gh.checkPrMergeable) {
      const mergeable = deps.gh.checkPrMergeable(repoRoot, other.prNumber);
      if (!mergeable) {
        // Actually conflicting -- send worker rebase message as fallback
        const siblingMsg = `Sibling PR #${other.prNumber} has merge conflicts after ${item.id} was merged. Please rebase onto latest ${defaultBranch}.`;
        const delivery = deliverToImplementerInbox(
          orch,
          other,
          "rebase",
          siblingMsg,
          ctx,
          deps,
        );
        if (!delivery.projectRoot) {
          deps.io.warn?.(
            `[Orchestrator] PR #${other.prNumber} (${other.id}) has merge conflicts but daemon rebase failed and worker has no workspace reference. Manual rebase needed.`,
          );
        }
      }
      // Not conflicting -- skip, no action needed
    }
  }

  // Update stack navigation comments on remaining stacked PRs.
  // After restacking, the merged item is gone and the chain has changed.
  if (deps.io.syncStackComments && successfulRestacks.size > 0) {
    const synced = new Set<string>();
    for (const id of successfulRestacks) {
      const chain = orch.buildStackChain(id);
      if (chain.length < 2) continue; // single item -- no stack to show
      const rootKey = chain[0]!.id;
      if (synced.has(rootKey)) continue; // already synced this chain
      synced.add(rootKey);
      deps.io.syncStackComments(defaultBranch, chain);
    }
  }

  return { success: true };
}

/** Notify worker of CI failure and post audit trail on PR. */
export function executeNotifyCiFailure(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "CI failed -- please investigate and fix.";
  const delivery = resolveImplementerInboxTarget(item, ctx);

  if (!delivery.projectRoot) {
    // No safe worker inbox target (e.g., reconstructed state only had stale
    // workspace metadata). Re-launch with a fresh worker to fix CI.
    logInboxDelivery(orch, item, "notify-ci-failure", message, delivery, "relaunch-requested");
    item.needsCiFix = true;
    item.workspaceRef = undefined;
    orch.transition(item, "ready");
    return { success: false, error: `No inbox target for ${item.id} -- relaunching worker for CI fix` };
  }

  deps.io.writeInbox(delivery.projectRoot, item.id, message);
  logInboxDelivery(orch, item, "notify-ci-failure", message, delivery, "delivered");

  if (item.prNumber) {
    const repoRoot = ctx.projectRoot;
    if (deps.gh.upsertOrchestratorComment) {
      deps.gh.upsertOrchestratorComment(repoRoot, item.prNumber, item.id, "CI failure detected. Worker notified.");
    } else {
      deps.gh.prComment(repoRoot, item.prNumber, `**[Orchestrator](${ORCHESTRATOR_LINK})** CI failure detected for ${item.id}. Worker notified.`);
    }
  }

  return { success: true };
}

/** Notify worker of review feedback. */
export function executeNotifyReview(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "Review feedback received -- please address.";
  const delivery = deliverToImplementerInbox(orch, item, "notify-review", message, ctx, deps);
  if (!delivery.projectRoot) {
    return { success: false, error: `No safe worker inbox target available for ${item.id}` };
  }

  return { success: true };
}

/** Close workspace and clean worktree for an item. */
export function executeClean(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  // Read screen before closing -- capture error output for stuck diagnostics
  if (item.workspaceRef && deps.mux.readScreen && item.state === "stuck") {
    try {
      const screen = deps.mux.readScreen(item.workspaceRef, 50);
      if (screen) {
        item.lastScreenOutput = screen;
        deps.io.warn?.(`[${item.id}] Permanently stuck. Screen output:\n${screen}`);
      }
    } catch { /* best-effort */ }
  }

  const workspaceClosed = item.workspaceRef
    ? deps.mux.closeWorkspace(item.workspaceRef)
    : null; // null = not attempted (no workspace to close)
  // Clear workspace ref after closing so the session slot is freed
  // (activeSessionCount is workspace-based). Also clears the ref for
  // items that bypassed executeMerge (e.g., interceptExternalMerge path).
  if (item.workspaceRef) item.workspaceRef = undefined;

  const worktreeCleaned = deps.cleanup.cleanSingleWorktree(item.id, ctx.worktreeDir, ctx.projectRoot);

  // Clean up heartbeat file (best-effort)
  try {
    const hbPath = heartbeatFilePath(ctx.projectRoot, item.id);
    if (existsSync(hbPath)) {
      unlinkSync(hbPath);
    }
  } catch { /* best-effort -- heartbeat cleanup failure doesn't block clean */ }

  // Clean up inbox files in the active and legacy namespaces (best-effort)
  for (const inboxRoot of new Set([item.worktreePath, ctx.projectRoot])) {
    if (!inboxRoot) continue;
    try {
      cleanInbox(inboxRoot, item.id);
    } catch { /* best-effort */ }
  }

  // Partial cleanup (one of two succeeds) is still OK.
  // Fail only when every attempted operation failed.
  const anySucceeded = workspaceClosed === true || worktreeCleaned;
  if (!anySucceeded) {
    const failures: string[] = [];
    if (workspaceClosed === false) failures.push("workspace close");
    if (!worktreeCleaned) failures.push("worktree cleanup");
    return { success: false, error: `Clean failed for ${item.id}: ${failures.join(" and ")} failed` };
  }

  return { success: true };
}

/**
 * Close the workspace for a stuck item without removing the worktree.
 * Captures screen output for diagnostics, then kills the session.
 * The worktree is preserved so the user can inspect partial work.
 */
export function executeWorkspaceClose(
  item: OrchestratorItem,
  deps: OrchestratorDeps,
): ActionResult {
  // Read screen before closing -- capture error output for stuck diagnostics
  if (item.workspaceRef && deps.mux.readScreen) {
    try {
      const screen = deps.mux.readScreen(item.workspaceRef, 50);
      if (screen) {
        item.lastScreenOutput = screen;
        deps.io.warn?.(`[${item.id}] Permanently stuck. Screen output:\n${screen}`);
      }
    } catch { /* best-effort */ }
  }

  // Close workspace but do NOT remove worktree -- preserve for manual inspection
  if (item.workspaceRef) {
    const closed = deps.mux.closeWorkspace(item.workspaceRef);
    if (!closed) {
      return { success: false, error: `Failed to close workspace for ${item.id}` };
    }
    item.workspaceRef = undefined;
  }

  return { success: true };
}

/** Send a nudge/message to a worker (for stall recovery, etc.). */
export function executeSendMessage(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "Are you still making progress?";
  const delivery = deliverToImplementerInbox(orch, item, "send-message", message, ctx, deps);
  if (!delivery.projectRoot) {
    return { success: false, error: `No safe worker inbox target available for ${item.id}` };
  }

  return { success: true };
}

/** Add an acknowledgement reaction to a human PR comment. */
export function executeReactToComment(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.gh.addCommentReaction) {
    return { success: true };
  }

  const commentId = action.commentId;
  const commentType = action.commentType;
  if (commentId == null || !commentType) {
    return { success: false, error: `Missing comment metadata for reaction on ${item.id}` };
  }

  try {
    deps.gh.addCommentReaction(ctx.projectRoot, commentId, commentType, "eyes");
    return { success: true };
  } catch {
    return { success: true };
  }
}

/** Set a commit status on the PR's head SHA. */
export function executeSetCommitStatus(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.gh.setCommitStatus) {
    return { success: true }; // no-op when not wired
  }

  const prNum = action.prNumber ?? item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for commit status of ${item.id}` };
  }

  const state = action.statusState ?? "pending";
  const description = action.statusDescription ?? "";
  const repoRoot = ctx.projectRoot;

  const ok = deps.gh.setCommitStatus(repoRoot, prNum, state, "Ninthwave / Review", description);
  return ok
    ? { success: true }
    : { success: false, error: `Failed to set commit status for ${item.id}` };
}

/** Send rebase request to a worker. */
export function executeRebase(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "Please rebase onto latest main.";
  const delivery = deliverToImplementerInbox(orch, item, "rebase", message, ctx, deps);
  if (!delivery.projectRoot) {
    return { success: false, error: `No safe worker inbox target available for ${item.id}` };
  }

  return { success: true };
}

/**
 * Daemon-side rebase: attempt to rebase the branch onto main without worker involvement.
 * Falls back to worker rebase message on failure.
 */
export function executeDaemonRebase(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const branch = `ninthwave/${item.id}`;
  const escalateToRebaser = action.escalateToRebaser === true;
  const inboxTarget = resolveImplementerInboxTarget(item, ctx);

  // Try daemon-side rebase if the dep is available
  if (deps.git.daemonRebase) {
    const worktreePath = item.worktreePath ?? join(ctx.worktreeDir, `ninthwave-${item.id}`);
    try {
      const success = deps.git.daemonRebase(worktreePath, branch);
      if (success) {
        // Rebase succeeded -- transition back to ci-pending so CI re-runs
        orch.transition(item, "ci-pending");
        return { success: true };
      }
    } catch {
      // Fall through to worker rebase
    }
  }

  const message = action.message || "Please rebase onto latest main.";
  if (!escalateToRebaser) {
    // Daemon rebase failed -- prefer sending message to the live worker first.
    // The original worker knows the code best and can resolve conflicts properly.
    // Guard on workspaceRef: after a fresh restart, worktrees persist on disk but
    // the worker process is gone. Without this check, the inbox message goes to
    // an empty worktree and the 15-minute cooldown blocks the rebaser launch.
    if (inboxTarget.projectRoot && item.workspaceRef) {
      deliverToImplementerInbox(orch, item, "daemon-rebase", message, ctx, deps);
      return { success: true };
    }
    const outcome: InboxDeliveryOutcome = inboxTarget.projectRoot ? "no-live-worker" : "missing-target";
    logInboxDelivery(orch, item, "daemon-rebase", message, inboxTarget, outcome);
  }

  // Circuit breaker: stop launching rebasers after maxRebaseAttempts
  const attemptCount = item.rebaseAttemptCount ?? 0;
  if (attemptCount >= orch.config.maxRebaseAttempts) {
    orch.transition(item, "stuck");
    item.failureReason = `rebase-loop: exceeded max rebase attempts (${orch.config.maxRebaseAttempts}) -- rebase conflicts could not be resolved`;
    deps.io.warn?.(
      `[Orchestrator] ${item.id} stuck after ${attemptCount} rebase attempts. Manual intervention needed.`,
    );
    return { success: false, error: `Rebase loop circuit breaker triggered for ${item.id} after ${attemptCount} attempts` };
  }

  // Launch rebaser worker if available (focused rebase-only prompt)
  if (deps.workers.launchRebaser && item.prNumber) {
    const repoRoot = ctx.projectRoot;
    try {
      const result = deps.workers.launchRebaser(item.id, item.prNumber, repoRoot, item.aiTool ?? ctx.aiTool);
      if (result) {
        item.rebaserWorkspaceRef = result.workspaceRef;
        item.rebaseAttemptCount = attemptCount + 1;
        orch.transition(item, "rebasing");
        return { success: true };
      }
    } catch (e: unknown) {
      deps.io.warn?.(`[Orchestrator] Rebaser worker launch failed for ${item.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (escalateToRebaser && inboxTarget.projectRoot) {
    deliverToImplementerInbox(orch, item, "daemon-rebase", message, ctx, deps);
    return { success: true };
  }

  // No live worker, no rebaser -- log warning
  deps.io.warn?.(
    `[Orchestrator] PR for ${item.id} (branch ${branch}) has merge conflicts but daemon rebase failed and no worker/rebaser available. Manual rebase needed.`,
  );
  return { success: false, error: `Daemon rebase failed and no worker available for ${item.id}` };
}

/** Clean up a failed worker's worktree and workspace to prepare for retry. */
export function executeRetry(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  // stuckOrRetry stashes the workspace ref in pendingRetryWorkspaceRef and
  // clears workspaceRef to free the session slot immediately. Use the stashed
  // ref (falling back to workspaceRef for callers that set it directly).
  const wsRef = item.pendingRetryWorkspaceRef ?? item.workspaceRef;

  // Read screen before closing -- capture error output for diagnostics
  if (wsRef && deps.mux.readScreen) {
    try {
      const screen = deps.mux.readScreen(wsRef, 50);
      if (screen) {
        item.lastScreenOutput = screen;
        deps.io.warn?.(`[${item.id}] Worker died. Screen output:\n${screen}`);
      }
    } catch { /* best-effort */ }
  }

  // Auto-save uncommitted changes before closing -- the new session inherits
  // only committed state, so any in-flight edits would be lost otherwise.
  const worktreePath = item.worktreePath ?? join(ctx.worktreeDir, `ninthwave-${item.id}`);
  if (existsSync(worktreePath) && deps.git.autoSaveWorktree) {
    try {
      const saved = deps.git.autoSaveWorktree(worktreePath);
      if (saved) {
        deps.io.warn?.(`[${item.id}] Auto-saved uncommitted changes before respawn`);
      }
    } catch { /* best-effort -- git failure must not block retry */ }
  }

  // Close the old workspace if it exists -- must complete before relaunch to
  // guarantee no two workers operate on the same branch simultaneously.
  if (wsRef) {
    const closed = deps.mux.closeWorkspace(wsRef);
    if (!closed) {
      deps.io.warn?.(`[${item.id}] WARNING: failed to close workspace ${wsRef} before retry`);
    }
    item.workspaceRef = undefined;
    item.pendingRetryWorkspaceRef = undefined;
  }

  // Preserve the worktree and branch -- the retried worker will launch
  // into the existing worktree and pick up committed state from the
  // previous attempt (including any auto-saved WIP).
  return { success: true };
}

/** Sync stack navigation comments on all PRs in the item's stack chain. */
export function executeSyncStackComments(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.io.syncStackComments) {
    return { success: true }; // no-op when not wired
  }

  const chain = orch.buildStackChain(item.id);
  if (chain.length < 2) {
    return { success: true }; // single item -- no stack to show
  }

  // Base branch: the root item's baseBranch (if still stacked) or "main"
  const rootItem = orch.getItem(chain[0]!.id);
  const baseBranch = rootItem?.baseBranch ?? "main";

  try {
    deps.io.syncStackComments(baseBranch, chain);
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Stack comment sync failed: ${msg}` };
  }
}

/** Launch a review worker for a PR. Stores reviewWorkspaceRef on success. */
/** Launch a rebaser worker for rebase-only conflict resolution. */
export function executeLaunchRebaser(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.workers.launchRebaser) {
    return { success: false, error: `Rebaser worker not available for ${item.id}` };
  }

  const prNum = item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for rebaser launch of ${item.id}` };
  }

  const repoRoot = ctx.projectRoot;
  try {
    const result = deps.workers.launchRebaser(item.id, prNum, repoRoot, item.aiTool ?? ctx.aiTool);
    if (result) {
      item.rebaserWorkspaceRef = result.workspaceRef;
    }
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Rebaser launch failed for ${item.id}: ${msg}` };
  }
}

/**
 * Shared cleanup for worker sessions (rebaser, review, forward-fixer).
 * Closes the workspace via the provided clean function and clears the ref.
 */
export function cleanWorkerWorkspace(
  label: string,
  itemId: string,
  workspaceRef: string | undefined,
  cleanFn: ((id: string, ref: string) => boolean) | undefined,
  clearRef: () => void,
): ActionResult {
  if (!cleanFn || !workspaceRef) {
    clearRef();
    return { success: true };
  }

  try {
    cleanFn(itemId, workspaceRef);
    clearRef();
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    clearRef();
    return { success: false, error: `${label} cleanup failed for ${itemId}: ${msg}` };
  }
}

/** Clean up a rebaser worker session. */
export function executeCleanRebaser(
  item: OrchestratorItem,
  deps: OrchestratorDeps,
): ActionResult {
  return cleanWorkerWorkspace(
    "Rebaser", item.id, item.rebaserWorkspaceRef, deps.cleanup.cleanRebaser,
    () => { item.rebaserWorkspaceRef = undefined; },
  );
}

export function executeLaunchReview(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.workers.launchReview) {
    return { success: true }; // no-op when not wired (stub for H-RVW-3)
  }

  const prNum = action.prNumber ?? item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for review launch of ${item.id}` };
  }

  const repoRoot = ctx.projectRoot;
  try {
    const result = deps.workers.launchReview(item.id, prNum, repoRoot, item.worktreePath, item.aiTool ?? ctx.aiTool);
    if (result) {
      item.reviewWorkspaceRef = result.workspaceRef;
      item.reviewVerdictPath = result.verdictPath;
    }
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Review launch failed for ${item.id}: ${msg}` };
  }
}

/** Clean up a review worker session and verdict file. */
export function executeCleanReview(
  item: OrchestratorItem,
  deps: OrchestratorDeps,
): ActionResult {
  // Clean up verdict file (review-specific, before shared workspace cleanup)
  if (item.reviewVerdictPath) {
    try { unlinkSync(item.reviewVerdictPath); } catch { /* best-effort */ }
    item.reviewVerdictPath = undefined;
  }

  return cleanWorkerWorkspace(
    "Review", item.id, item.reviewWorkspaceRef, deps.cleanup.cleanReview,
    () => { item.reviewWorkspaceRef = undefined; },
  );
}

/** Post a formatted review comment on the PR from a reviewer verdict. */
export function executePostReview(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const prNum = action.prNumber ?? item.prNumber;
  if (!prNum || !action.verdict) {
    return { success: false, error: `Missing PR number or verdict for post-review of ${item.id}` };
  }

  const v = action.verdict;
  const verdictLabel = v.verdict === "approve" ? "Approved" : "Changes Requested";
  const reviewerUrl = ctx.hubRepoNwo
    ? `https://github.com/${ctx.hubRepoNwo}/blob/main/agents/reviewer.md`
    : "agents/reviewer.md";

  const body = [
    `**[Reviewer](${reviewerUrl})** Verdict: ${verdictLabel}`,
    "",
    "| Metric | Score |",
    "| --- | --- |",
    `| Architecture | ${v.architectureScore}/10 |`,
    `| Code Quality | ${v.codeQualityScore}/10 |`,
    `| Performance | ${v.performanceScore}/10 |`,
    `| Test Coverage | ${v.testCoverageScore}/10 |`,
    `| Blocking | ${v.blockingCount} |`,
    `| Non-blocking | ${v.nonBlockingCount} |`,
    `| Unresolved Decisions | ${v.unresolvedDecisions} |`,
    `| Critical Gaps | ${v.criticalGaps} |`,
    `| Confidence | ${v.confidence}/10 |`,
    "",
    "<details><summary>Review details</summary>",
    "",
    v.summary,
    "",
    "</details>",
    "",
    "---",
    NINTHWAVE_FOOTER,
  ].join("\n");

  const repoRoot = ctx.projectRoot;
  try {
    deps.gh.prComment(repoRoot, prNum, body);
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Post-review comment failed for ${item.id}: ${msg}` };
  }
}

/** Launch a forward-fixer worker for post-merge CI failure diagnosis. */
export function executeLaunchForwardFixer(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.workers.launchForwardFixer) {
    return { success: false, error: `Forward-fixer worker not available for ${item.id}` };
  }

  if (!item.mergeCommitSha) {
    return { success: false, error: `No merge commit SHA for forward-fixer launch of ${item.id}` };
  }

  const repoRoot = ctx.projectRoot;
  const defaultBranch = resolveDefaultBranch(item, repoRoot, deps);
  try {
    const result = deps.workers.launchForwardFixer(
      item.id,
      item.mergeCommitSha,
      repoRoot,
      item.aiTool ?? ctx.aiTool,
      defaultBranch,
    );
    if (result) {
      item.fixForwardWorkspaceRef = result.workspaceRef;
    }
    return { success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Forward-fixer launch failed for ${item.id}: ${msg}` };
  }
}

/** Clean up a forward-fixer worker session and worktree. */
export function executeCleanForwardFixer(
  item: OrchestratorItem,
  deps: OrchestratorDeps,
): ActionResult {
  return cleanWorkerWorkspace(
    "Forward-Fixer", item.id, item.fixForwardWorkspaceRef, deps.cleanup.cleanForwardFixer,
    () => { item.fixForwardWorkspaceRef = undefined; },
  );
}
