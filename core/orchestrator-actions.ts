// Action execution functions for the orchestrator.
// Standalone functions extracted from the Orchestrator class.
// Imports only from orchestrator-types.ts (no circular deps with orchestrator.ts).

import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { getWorktreeInfo, listCrossRepoEntries } from "./cross-repo.ts";
import { heartbeatFilePath, writeHeartbeat } from "./daemon.ts";
import { cleanInbox } from "./commands/inbox.ts";
import { NINTHWAVE_FOOTER, ORCHESTRATOR_LINK } from "./gh.ts";
import {
  type OrchestratorHandle,
  type OrchestratorItem,
  type OrchestratorItemState,
  type OrchestratorConfig,
  type Action,
  type ActionResult,
  type ExecutionContext,
  type OrchestratorDeps,
  WIP_STATES,
  getNextTool,
} from "./orchestrator-types.ts";

function inboxProjectRoot(item: OrchestratorItem, ctx: ExecutionContext): string {
  return item.worktreePath ?? item.resolvedRepoRoot ?? ctx.projectRoot;
}

/**
 * Bootstrap a target repo for a cross-repo item.
 * On success, sets resolvedRepoRoot and transitions to launching.
 * On failure, marks the item stuck with a descriptive reason.
 */
export function executeBootstrap(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.bootstrapRepo) {
    orch.transition(item, "stuck");
    item.failureReason = "bootstrap-failed: bootstrapRepo dependency not provided";
    return { success: false, error: `Bootstrap not available for ${item.id}` };
  }

  const alias = item.workItem.repoAlias;
  const result = deps.bootstrapRepo(alias, ctx.projectRoot);

  if (result.status === "failed") {
    orch.transition(item, "stuck");
    item.failureReason = `bootstrap-failed: ${result.reason}`;
    return { success: false, error: `Bootstrap failed for ${item.id}: ${result.reason}` };
  }

  // Resolve the repo root now that bootstrap succeeded
  if (result.status === "cloned" || result.status === "created") {
    item.resolvedRepoRoot = result.path;
  }
  // status === "exists" should not normally happen (needsBootstrap checks resolvedRepoRoot),
  // but is harmless -- resolvedRepoRoot remains unset and launch will resolve normally.

  // Transition to launching -- the next processTransitions cycle will not
  // re-emit a launch action (launching is handled by transitionItem).
  // Instead, we return success so the execution layer can emit a follow-up launch.
  orch.transition(item, "launching");
  return { success: true };
}

/** Launch a worker for an item. Stores workspaceRef on success, marks stuck or schedules retry on failure. */
export function executeLaunch(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  // Clean stale branches before launching (H-ORC-4).
  // When a TODO ID is reused with different work, the old branch may have
  // merged PRs that cause workers to falsely exit as "done".
  if (deps.cleanStaleBranch) {
    try {
      deps.cleanStaleBranch(item.workItem, ctx.projectRoot);
    } catch (e) {
      // Non-fatal -- log and attempt launch anyway
      const msg = e instanceof Error ? e.message : String(e);
      deps.warn?.(`cleanStaleBranch failed for ${item.id}: ${msg}`);
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
    const DEP_DONE_STATES: ReadonlySet<string> = new Set(["done", "merged", "forward-fix-pending", "fix-forward-failed"]);
    if (!dep || DEP_DONE_STATES.has(dep.state)) {
      deps.warn?.(`Dependency ${depId} is now ${dep?.state ?? "unknown"} -- clearing baseBranch for ${item.id} to launch from main`);
      action.baseBranch = undefined;
      item.baseBranch = undefined;
    }
  }

  // When needsCiFix is set, force worker launch even if an existing PR is
  // found. This ensures CI failures on restart are addressed by a live worker
  // rather than silently tracked in ci-pending with no one to fix them (H-WR-1).
  const forceWorker = item.needsCiFix === true;
  item.needsCiFix = false;

  const selectedTool = getNextTool(ctx);
  try {
    const result = deps.launchSingleItem(
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

  const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;

  // Resolve the dependency branch SHA before merge. After merge, GitHub may
  // auto-delete the branch, making the ref unresolvable. The SHA is used as
  // oldBase in rebaseOnto for stacked dependents.
  const depBranch = `ninthwave/${item.id}`;
  let depBranchRef: string = depBranch;
  if (deps.resolveRef) {
    try {
      const sha = deps.resolveRef(repoRoot, depBranch);
      if (sha) depBranchRef = sha;
    } catch {
      // Fall back to branch name
    }
  }

  const merged = deps.prMerge(repoRoot, prNum, { admin: action.admin });
  if (!merged) {
    // Check if the failure is due to merge conflicts (another PR merged to main while CI ran).
    // If conflicting, rebase and re-enter CI instead of blindly retrying the same failing merge.
    const isMergeable = deps.checkPrMergeable?.(repoRoot, prNum) ?? true;
    if (!isMergeable) {
      // Conflict-caused failure -- rebase instead of retrying.
      // Do NOT increment mergeFailCount since this isn't a genuine merge failure.
      item.rebaseRequested = false; // Reset so the rebase path works correctly
      if (deps.daemonRebase) {
        const indexPath = join(ctx.worktreeDir, ".cross-repo-index");
        const wtInfo = getWorktreeInfo(item.id, indexPath, ctx.worktreeDir);
        const wtRepoRoot = wtInfo?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot;
        const worktreePath = wtInfo?.worktreePath ?? join(wtRepoRoot, ".ninthwave", ".worktrees", `ninthwave-${item.id}`);
        const branch = `ninthwave/${item.id}`;
        try {
          const rebaseSuccess = deps.daemonRebase(worktreePath, branch);
          if (rebaseSuccess) {
            orch.transition(item, "ci-pending");
            return { success: false, error: `Merge failed for PR #${prNum} due to conflicts, rebased and waiting for CI` };
          }
        } catch {
          // Daemon rebase failed -- fall through to worker rebase
        }
      }
      // Daemon rebase unavailable or failed -- send worker a rebase message
      if (item.workspaceRef) {
        const rebaseMsg = `[ORCHESTRATOR] Rebase Required: merge failed due to conflicts with main. Please rebase onto latest main and push.`;
        deps.writeInbox(inboxProjectRoot(item, ctx), item.id, rebaseMsg);
      }
      orch.transition(item, "ci-pending");
      return { success: false, error: `Merge failed for PR #${prNum} due to conflicts, rebase requested` };
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

  // Capture merge commit SHA for post-merge CI verification
  if (orch.config.fixForward && deps.getMergeCommitSha) {
    try {
      const sha = deps.getMergeCommitSha(repoRoot, prNum);
      if (sha) {
        item.mergeCommitSha = sha;
      }
    } catch {
      // Non-fatal -- fall back to done (skip verification)
    }
  }

  // Audit trail
  if (deps.upsertOrchestratorComment) {
    deps.upsertOrchestratorComment(repoRoot, prNum, item.id, `Auto-merged PR #${prNum}.`);
  } else {
    deps.prComment(repoRoot, prNum, `**[Orchestrator](${ORCHESTRATOR_LINK})** Auto-merged PR #${prNum} for ${item.id}.`);
  }

  // Pull latest main in the target repo (where the PR was merged)
  try {
    deps.fetchOrigin(repoRoot, "main");
    deps.ffMerge(repoRoot, "main");
  } catch {
    // Non-fatal -- main will be pulled on next cycle
  }

  // Also pull latest main in the hub repo if this was cross-repo
  if (repoRoot !== ctx.projectRoot) {
    try {
      deps.fetchOrigin(ctx.projectRoot, "main");
      deps.ffMerge(ctx.projectRoot, "main");
    } catch {
      // Non-fatal
    }
  }

  // Restack stacked dependents using rebaseOnto (squash-merge safe).
  // These items had baseBranch set to the merged dep's branch -- replay only
  // their unique commits onto main, avoiding duplicate commits from squash merge.
  // Use depBranchRef (SHA resolved before merge) as oldBase so restacking
  // survives GitHub auto-deleting the merged branch.
  const restackedIds = new Set<string>();
  const successfulRestacks = new Set<string>();

  // Cache cross-repo index for worktree lookups in sibling loops
  const crossRepoIndex = join(ctx.worktreeDir, ".cross-repo-index");
  const cachedEntries = listCrossRepoEntries(crossRepoIndex);

  for (const other of orch.getAllItems()) {
    if (other.id === item.id) continue;
    if (!other.workItem.dependencies.includes(item.id)) continue;
    if (!WIP_STATES.has(other.state)) continue;
    if (!other.baseBranch) continue; // not stacked -- handled below

    restackedIds.add(other.id);

    const otherWtInfo = getWorktreeInfo(other.id, crossRepoIndex, ctx.worktreeDir, cachedEntries);
    const otherRepoRoot = otherWtInfo?.repoRoot ?? other.resolvedRepoRoot ?? ctx.projectRoot;
    const otherWorktreePath = other.worktreePath
      ?? otherWtInfo?.worktreePath
      ?? join(otherRepoRoot, ".ninthwave", ".worktrees", `ninthwave-${other.id}`);
    const otherBranch = `ninthwave/${other.id}`;

    if (!deps.rebaseOnto || !deps.forcePush) {
      // rebaseOnto or forcePush not available -- send worker manual rebase instructions
      if (other.workspaceRef) {
        const restackMsg = `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto main ${depBranch} ${otherBranch} && git push --force-with-lease`;
        deps.writeInbox(otherWorktreePath, other.id, restackMsg);
      }
      continue;
    }

    try {
      const success = deps.rebaseOnto(otherWorktreePath, "main", depBranchRef, otherBranch);
      if (success) {
        deps.forcePush(otherWorktreePath);
        other.baseBranch = undefined; // no longer stacked
        successfulRestacks.add(other.id);
      } else {
        // Conflict -- send worker manual rebase instructions
        if (other.workspaceRef) {
          const conflictMsg = `[ORCHESTRATOR] Restack Conflict: dependency ${item.id} was squash-merged but rebase --onto had conflicts. Run manually: git rebase --onto main ${depBranch} ${otherBranch}`;
          deps.writeInbox(otherWorktreePath, other.id, conflictMsg);
        }
      }
    } catch {
      // Unexpected error -- fall back to worker message
      if (other.workspaceRef) {
        const restackMsg2 = `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto main ${depBranch} ${otherBranch} && git push --force-with-lease`;
        deps.writeInbox(otherWorktreePath, other.id, restackMsg2);
      }
    }
  }

  // Send rebase requests to non-stacked dependent items in WIP states.
  // Stacked items were handled above via rebaseOnto -- skip them.
  for (const other of orch.getAllItems()) {
    if (other.id === item.id) continue;
    if (!other.workItem.dependencies.includes(item.id)) continue;
    if (!WIP_STATES.has(other.state)) continue;
    if (restackedIds.has(other.id)) continue;
    if (other.workspaceRef) {
      const otherWorktreePath = other.worktreePath
        ?? join(other.resolvedRepoRoot ?? ctx.projectRoot, ".ninthwave", ".worktrees", `ninthwave-${other.id}`);
      const rebaseMsg2 = `Dependency ${item.id} merged. Please rebase onto latest main.`;
      deps.writeInbox(otherWorktreePath, other.id, rebaseMsg2);
    }
  }

  // Post-merge daemon-rebase: proactively rebase in-flight sibling PRs in the same repo.
  // This eliminates most conflicts before workers notice, reducing CI churn.
  // Skip restacked items -- they were already rebased with --onto above.
  // Skip items in different repos -- their main didn't change from this merge.
  for (const other of orch.getAllItems()) {
    if (other.id === item.id) continue;
    if (!WIP_STATES.has(other.state)) continue;
    if (!other.prNumber) continue;
    if (restackedIds.has(other.id)) continue;

    // Only rebase siblings in the same target repo -- a merge in repo-B
    // doesn't affect main in repo-A
    const otherRepoRoot2 = other.resolvedRepoRoot ?? ctx.projectRoot;
    if (otherRepoRoot2 !== repoRoot) continue;

    const otherBranch = `ninthwave/${other.id}`;
    const otherWtInfo2 = getWorktreeInfo(other.id, crossRepoIndex, ctx.worktreeDir, cachedEntries);
    const otherWorktreePath = other.worktreePath
      ?? otherWtInfo2?.worktreePath
      ?? join(otherRepoRoot2, ".ninthwave", ".worktrees", `ninthwave-${other.id}`);

    // Try daemon-rebase first for all siblings
    let daemonSuccess = false;
    if (deps.daemonRebase) {
      try {
        daemonSuccess = deps.daemonRebase(otherWorktreePath, otherBranch);
      } catch {
        // Fall through to conflict check
      }
    }

    if (daemonSuccess) continue; // CI re-runs automatically on force-push

    // Daemon rebase failed or unavailable -- check if actually conflicting
    if (deps.checkPrMergeable) {
      const mergeable = deps.checkPrMergeable(otherRepoRoot2, other.prNumber);
      if (!mergeable) {
        // Actually conflicting -- send worker rebase message as fallback
        if (other.workspaceRef) {
          const siblingMsg = `Sibling PR #${other.prNumber} has merge conflicts after ${item.id} was merged. Please rebase onto latest main.`;
          deps.writeInbox(otherWorktreePath, other.id, siblingMsg);
        } else {
          deps.warn?.(
            `[Orchestrator] PR #${other.prNumber} (${other.id}) has merge conflicts but daemon rebase failed and worker has no workspace reference. Manual rebase needed.`,
          );
        }
      }
      // Not conflicting -- skip, no action needed
    }
  }

  // Update stack navigation comments on remaining stacked PRs.
  // After restacking, the merged item is gone and the chain has changed.
  if (deps.syncStackComments && successfulRestacks.size > 0) {
    const synced = new Set<string>();
    for (const id of successfulRestacks) {
      const chain = orch.buildStackChain(id);
      if (chain.length < 2) continue; // single item -- no stack to show
      const rootKey = chain[0]!.id;
      if (synced.has(rootKey)) continue; // already synced this chain
      synced.add(rootKey);
      deps.syncStackComments("main", chain);
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

  if (!item.workspaceRef) {
    // No live worker (e.g., daemon restarted). Re-launch with a fresh worker
    // to fix CI. The needsCiFix flag tells executeLaunch to force-launch a
    // worker even when an existing PR is found (H-WR-1).
    item.needsCiFix = true;
    orch.transition(item, "ready");
    return { success: true };
  }

  deps.writeInbox(inboxProjectRoot(item, ctx), item.id, message);

  if (item.prNumber) {
    const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;
    if (deps.upsertOrchestratorComment) {
      deps.upsertOrchestratorComment(repoRoot, item.prNumber, item.id, "CI failure detected. Worker notified.");
    } else {
      deps.prComment(repoRoot, item.prNumber, `**[Orchestrator](${ORCHESTRATOR_LINK})** CI failure detected for ${item.id}. Worker notified.`);
    }
  }

  return { success: true };
}

/** Notify worker of review feedback. */
export function executeNotifyReview(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "Review feedback received -- please address.";

  deps.writeInbox(inboxProjectRoot(item, ctx), item.id, message);

  return { success: true };
}

/** Close workspace and clean worktree for an item. */
export function executeClean(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  // Read screen before closing -- capture error output for stuck diagnostics
  if (item.workspaceRef && deps.readScreen && item.state === "stuck") {
    try {
      const screen = deps.readScreen(item.workspaceRef, 50);
      if (screen) {
        item.lastScreenOutput = screen;
        deps.warn?.(`[${item.id}] Permanently stuck. Screen output:\n${screen}`);
      }
    } catch { /* best-effort */ }
  }

  const workspaceClosed = item.workspaceRef
    ? deps.closeWorkspace(item.workspaceRef)
    : null; // null = not attempted (no workspace to close)

  const indexPath = join(ctx.worktreeDir, ".cross-repo-index");
  const wtInfo = getWorktreeInfo(item.id, indexPath, ctx.worktreeDir);
  const repoRoot = wtInfo?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot;
  const worktreeDir = repoRoot !== ctx.projectRoot ? join(repoRoot, ".ninthwave", ".worktrees") : ctx.worktreeDir;
  const worktreeCleaned = deps.cleanSingleWorktree(item.id, worktreeDir, repoRoot);

  // Clean up heartbeat file (best-effort)
  try {
    const hbPath = heartbeatFilePath(ctx.projectRoot, item.id);
    if (existsSync(hbPath)) {
      unlinkSync(hbPath);
    }
  } catch { /* best-effort -- heartbeat cleanup failure doesn't block clean */ }

  // Clean up inbox file (best-effort)
  try {
    cleanInbox(item.worktreePath ?? repoRoot, item.id);
  } catch { /* best-effort */ }

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
  if (item.workspaceRef && deps.readScreen) {
    try {
      const screen = deps.readScreen(item.workspaceRef, 50);
      if (screen) {
        item.lastScreenOutput = screen;
        deps.warn?.(`[${item.id}] Permanently stuck. Screen output:\n${screen}`);
      }
    } catch { /* best-effort */ }
  }

  // Close workspace but do NOT remove worktree -- preserve for manual inspection
  if (item.workspaceRef) {
    const closed = deps.closeWorkspace(item.workspaceRef);
    if (!closed) {
      return { success: false, error: `Failed to close workspace for ${item.id}` };
    }
  }

  return { success: true };
}

/** Send a nudge/message to a worker (for stall recovery, etc.). */
export function executeSendMessage(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "Are you still making progress?";

  deps.writeInbox(inboxProjectRoot(item, ctx), item.id, message);

  return { success: true };
}

/** Set a commit status on the PR's head SHA. */
export function executeSetCommitStatus(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.setCommitStatus) {
    return { success: true }; // no-op when not wired
  }

  const prNum = action.prNumber ?? item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for commit status of ${item.id}` };
  }

  const state = action.statusState ?? "pending";
  const description = action.statusDescription ?? "";
  const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;

  const ok = deps.setCommitStatus(repoRoot, prNum, state, "Ninthwave / Review", description);
  return ok
    ? { success: true }
    : { success: false, error: `Failed to set commit status for ${item.id}` };
}

/** Send rebase request to a worker. */
export function executeRebase(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  const message = action.message || "Please rebase onto latest main.";

  deps.writeInbox(inboxProjectRoot(item, ctx), item.id, message);

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

  // Try daemon-side rebase if the dep is available
  if (deps.daemonRebase) {
    const indexPath = join(ctx.worktreeDir, ".cross-repo-index");
    const wtInfo = getWorktreeInfo(item.id, indexPath, ctx.worktreeDir);
    const repoRoot = wtInfo?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot;
    const worktreePath = wtInfo?.worktreePath ?? join(repoRoot, ".ninthwave", ".worktrees", `ninthwave-${item.id}`);
    try {
      const success = deps.daemonRebase(worktreePath, branch);
      if (success) {
        // Rebase succeeded -- transition back to ci-pending so CI re-runs
        orch.transition(item, "ci-pending");
        return { success: true };
      }
    } catch {
      // Fall through to worker rebase
    }
  }

  // Daemon rebase failed -- prefer sending message to live worker over launching rebaser.
  // The original worker knows the code best and can resolve conflicts properly.
  const message = action.message || "Please rebase onto latest main.";
  deps.writeInbox(inboxProjectRoot(item, ctx), item.id, message);
  if (item.workspaceRef) {
    return { success: true };
  }

  // Circuit breaker: stop launching rebasers after maxRebaseAttempts
  const attemptCount = item.rebaseAttemptCount ?? 0;
  if (attemptCount >= orch.config.maxRebaseAttempts) {
    orch.transition(item, "stuck");
    item.failureReason = `rebase-loop: exceeded max rebase attempts (${orch.config.maxRebaseAttempts}) -- rebase conflicts could not be resolved`;
    deps.warn?.(
      `[Orchestrator] ${item.id} stuck after ${attemptCount} rebase attempts. Manual intervention needed.`,
    );
    return { success: false, error: `Rebase loop circuit breaker triggered for ${item.id} after ${attemptCount} attempts` };
  }

  // Launch rebaser worker if available (focused rebase-only prompt)
  if (deps.launchRebaser && item.prNumber) {
    const repoRoot = deps.daemonRebase
      ? (getWorktreeInfo(item.id, join(ctx.worktreeDir, ".cross-repo-index"), ctx.worktreeDir)?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot)
      : (item.resolvedRepoRoot ?? ctx.projectRoot);
    try {
      const result = deps.launchRebaser(item.id, item.prNumber, repoRoot, item.aiTool ?? ctx.aiTool);
      if (result) {
        item.rebaserWorkspaceRef = result.workspaceRef;
        item.rebaseAttemptCount = attemptCount + 1;
        orch.transition(item, "rebasing");
        return { success: true };
      }
    } catch (e: unknown) {
      deps.warn?.(`[Orchestrator] Rebaser worker launch failed for ${item.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // No live worker, no rebaser -- log warning
  deps.warn?.(
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
  // Read screen before closing -- capture error output for diagnostics
  if (item.workspaceRef && deps.readScreen) {
    try {
      const screen = deps.readScreen(item.workspaceRef, 50);
      if (screen) {
        item.lastScreenOutput = screen;
        deps.warn?.(`[${item.id}] Worker died. Screen output:\n${screen}`);
      }
    } catch { /* best-effort */ }
  }

  // Close the old workspace if it exists
  if (item.workspaceRef) {
    deps.closeWorkspace(item.workspaceRef);
    item.workspaceRef = undefined;
  }

  // Preserve the worktree and branch -- the retried worker will launch
  // into the existing worktree and pick up uncommitted edits + pushed
  // commits from the previous attempt.
  return { success: true };
}

/** Sync stack navigation comments on all PRs in the item's stack chain. */
export function executeSyncStackComments(
  orch: OrchestratorHandle,
  item: OrchestratorItem,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.syncStackComments) {
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
    deps.syncStackComments(baseBranch, chain);
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
  if (!deps.launchRebaser) {
    return { success: false, error: `Rebaser worker not available for ${item.id}` };
  }

  const prNum = item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for rebaser launch of ${item.id}` };
  }

  const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;
  try {
    const result = deps.launchRebaser(item.id, prNum, repoRoot, item.aiTool ?? ctx.aiTool);
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
    "Rebaser", item.id, item.rebaserWorkspaceRef, deps.cleanRebaser,
    () => { item.rebaserWorkspaceRef = undefined; },
  );
}

export function executeLaunchReview(
  item: OrchestratorItem,
  action: Action,
  ctx: ExecutionContext,
  deps: OrchestratorDeps,
): ActionResult {
  if (!deps.launchReview) {
    return { success: true }; // no-op when not wired (stub for H-RVW-3)
  }

  const prNum = action.prNumber ?? item.prNumber;
  if (!prNum) {
    return { success: false, error: `No PR number for review launch of ${item.id}` };
  }

  const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;
  try {
    const result = deps.launchReview(item.id, prNum, repoRoot, item.worktreePath, item.aiTool ?? ctx.aiTool);
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
    "Review", item.id, item.reviewWorkspaceRef, deps.cleanReview,
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

  const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;
  try {
    deps.prComment(repoRoot, prNum, body);
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
  if (!deps.launchForwardFixer) {
    return { success: false, error: `Forward-fixer worker not available for ${item.id}` };
  }

  if (!item.mergeCommitSha) {
    return { success: false, error: `No merge commit SHA for forward-fixer launch of ${item.id}` };
  }

  const repoRoot = item.resolvedRepoRoot ?? ctx.projectRoot;
  try {
    const result = deps.launchForwardFixer(item.id, item.mergeCommitSha, repoRoot, item.aiTool ?? ctx.aiTool);
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
    "Forward-Fixer", item.id, item.fixForwardWorkspaceRef, deps.cleanForwardFixer,
    () => { item.fixForwardWorkspaceRef = undefined; },
  );
}
