// Orchestrator state machine for parallel work item processing.
// processTransitions is pure -- takes a snapshot and returns actions, no side effects.
// executeAction bridges the pure state machine to external dependencies via injected deps.
//
// Types and constants live in orchestrator-types.ts.
// Action execution functions live in orchestrator-actions.ts.

import type { WorkItem, Priority } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";

// Re-export everything from orchestrator-types.ts so existing imports continue to work.
export * from "./orchestrator-types.ts";

import {
  type OrchestratorItemState,
  type OrchestratorItem,
  type OrchestratorConfig,
  type MergeStrategy,
  type ItemSnapshot,
  type PollSnapshot,
  type Action,
  type ActionType,
  type ActionResult,
  type ExecutionContext,
  type OrchestratorDeps,
  type OrchestratorHandle,
  DEFAULT_CONFIG,
  HEARTBEAT_TIMEOUT_MS,
  NOT_ALIVE_THRESHOLD,
  LAUNCHING_TIMEOUT_MS,
  WIP_STATES,
  STACKABLE_STATES,
  getNextTool,
} from "./orchestrator-types.ts";

import {
  executeBootstrap,
  executeLaunch,
  executeMerge,
  executeNotifyCiFailure,
  executeNotifyReview,
  executeClean,
  executeWorkspaceClose,
  executeSendMessage,
  executeSetCommitStatus,
  executeRebase,
  executeDaemonRebase,
  executeRetry,
  executeSyncStackComments,
  executeLaunchRebaser,
  executeCleanRebaser,
  executeLaunchReview,
  executeCleanReview,
  executePostReview,
  executeLaunchForwardFixer,
  executeCleanForwardFixer,
} from "./orchestrator-actions.ts";

// ── Orchestrator class ───────────────────────────────────────────────

export class Orchestrator {
  readonly config: OrchestratorConfig;
  private items: Map<string, OrchestratorItem> = new Map();
  /** Memory-adjusted WIP limit. When set, takes precedence over config.wipLimit for slot calculation. */
  private _effectiveWipLimit?: number;
  /** One-shot flag: re-run evaluateMerge for review-pending items on the next poll. */
  private forceReviewPendingReevaluation = false;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the effective WIP limit after memory adjustment.
   * Call this each poll cycle with the result of calculateMemoryWipLimit().
   */
  setEffectiveWipLimit(limit: number): void {
    this._effectiveWipLimit = limit;
  }

  /** Get the effective WIP limit (memory-adjusted when set, otherwise configured). */
  get effectiveWipLimit(): number {
    return this._effectiveWipLimit ?? this.config.wipLimit;
  }

  /**
   * Change the configured WIP limit at runtime.
   * Updates config.wipLimit so that slot calculations (including memory-adjusted
   * effective limit) use the new value immediately. Minimum 1.
   */
  setWipLimit(limit: number): void {
    const clamped = Math.max(1, Math.floor(limit));
    (this.config as { wipLimit: number }).wipLimit = clamped;
    // Clear memory-adjusted override so the new configured limit takes effect
    // immediately. The next poll cycle will re-evaluate memory pressure.
    this._effectiveWipLimit = undefined;
  }

  /**
   * Change the merge strategy at runtime.
   * "bypass" is only allowed when config.bypassEnabled is true (set via --dangerously-bypass).
   * Existing review-pending items are re-evaluated on the next poll cycle so strategy
   * changes take effect without waiting for another PR state transition.
   */
  setMergeStrategy(strategy: MergeStrategy): void {
    if (strategy === "bypass" && !this.config.bypassEnabled) {
      throw new Error('Cannot set merge strategy to "bypass" without --dangerously-bypass flag');
    }
    if (strategy === this.config.mergeStrategy) {
      return;
    }
    (this.config as { mergeStrategy: MergeStrategy }).mergeStrategy = strategy;
    this.forceReviewPendingReevaluation = true;
  }

  /**
   * Enable or disable the AI review gate at runtime.
   * When skipReview is toggled on, items already in "reviewing" state are drained:
   * reviewCompleted is set to true so the next processTransitions cycle will
   * clean up the review worker and chain to evaluateMerge.
   */
  setSkipReview(skip: boolean): void {
    (this.config as { skipReview: boolean }).skipReview = skip;
    if (skip) {
      // Drain in-flight review items: mark reviewCompleted so the next cycle
      // transitions them out of reviewing state naturally.
      for (const item of this.items.values()) {
        if (item.state === "reviewing") {
          item.reviewCompleted = true;
        }
      }
    }
  }

  /** Add a work item to orchestration. Starts in 'queued' state. */
  addItem(workItem: WorkItem, partition?: number): void {
    this.items.set(workItem.id, {
      id: workItem.id,
      workItem,
      state: "queued",
      partition,
      lastTransition: new Date().toISOString(),
      ciFailCount: 0,
      retryCount: 0,
    });
  }

  /** Get the current state of an item. */
  getItem(id: string): OrchestratorItem | undefined {
    return this.items.get(id);
  }

  /** Get all items. */
  getAllItems(): OrchestratorItem[] {
    return Array.from(this.items.values());
  }

  /** Get items in a specific state. */
  getItemsByState(state: OrchestratorItemState): OrchestratorItem[] {
    return this.getAllItems().filter((item) => item.state === state);
  }

  /** Hydrate an item's state from persisted data (disk restore, crash recovery).
   *  Bypasses transition()'s flag management and callbacks -- not for runtime state changes. */
  hydrateState(id: string, state: OrchestratorItemState): void {
    const item = this.items.get(id);
    if (!item) return;
    item.state = state;
    item.lastTransition = new Date().toISOString();
  }

  /** Count of items in WIP states (counts toward limit). */
  get wipCount(): number {
    return this.getAllItems().filter((item) => WIP_STATES.has(item.state))
      .length;
  }

  /** How many more items can be launched without exceeding the effective WIP limit. */
  get wipSlots(): number {
    return Math.max(0, this.effectiveWipLimit - this.wipCount);
  }

  /**
   * Pure state machine transition function.
   * Takes a poll snapshot (external state) and returns actions to execute.
   * Does NOT execute the actions -- the caller is responsible for that.
   * @param now - Current time for heartbeat calculations (injectable for testing).
   */
  processTransitions(snapshot: PollSnapshot, now: Date = new Date()): Action[] {
    const actions: Action[] = [];

    // Build lookup for snapshot items
    const snapshotMap = new Map<string, ItemSnapshot>();
    for (const s of snapshot.items) {
      snapshotMap.set(s.id, s);
    }

    // Process each tracked item against the snapshot
    for (const item of this.getAllItems()) {
      const snap = snapshotMap.get(item.id);
      const newActions = this.transitionItem(item, snap, now);
      actions.push(...newActions);
    }

    if (this.forceReviewPendingReevaluation) {
      this.forceReviewPendingReevaluation = false;
      for (const item of this.getItemsByState("review-pending")) {
        const snap = snapshotMap.get(item.id);
        if (snap?.ciStatus === "pass") {
          actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
        }
      }
    }

    // Promote queued → ready for items whose deps are met
    for (const item of this.getItemsByState("queued")) {
      if (snapshot.readyIds.includes(item.id)) {
        this.transition(item, "ready");
      }
    }

    // Stacked branch promotion: promote queued items that can stack on an in-flight dep
    if (this.config.enableStacking) {
      for (const item of this.getItemsByState("queued")) {
        const result = this.canStackLaunch(item);
        if (result.canStack) {
          item.baseBranch = result.baseBranch;
          this.transition(item, "ready");
        }
      }
    }

    // Launch ready items up to WIP limit
    const launchActions = this.launchReadyItems();
    actions.push(...launchActions);

    // Priority-ordered merge queue: when multiple items are ready to merge,
    // only merge the highest-priority one per cycle. The execution layer will
    // check remaining PRs for conflicts after the merge completes, preventing
    // cascade conflicts when all PRs try to merge simultaneously.
    return this.prioritizeMergeActions(actions);
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Set state and update timestamp. Records detection latency when eventTime is provided. */
  private transition(item: OrchestratorItem, state: OrchestratorItemState, eventTime?: string): void {
    if (item.state === state) return;
    const prevState = item.state;
    const detectedTime = new Date().toISOString();
    item.state = state;
    item.lastTransition = detectedTime;
    item.detectedTime = detectedTime;
    item.eventTime = eventTime ?? detectedTime;
    const detectedMs = new Date(detectedTime).getTime();
    const eventMs = new Date(item.eventTime).getTime();
    item.detectionLatencyMs = Number.isFinite(detectedMs) && Number.isFinite(eventMs)
      ? Math.max(0, detectedMs - eventMs)
      : 0;
    // Clear rebase flag on any state change -- the worker pushed or CI restarted
    item.rebaseRequested = false;
    // Clear timeout grace period on any state change -- worker recovered or was killed
    item.timeoutDeadline = undefined;
    item.timeoutExtensionCount = undefined;
    // Reset reviewCompleted on CI failure -- requires fresh review after fixes.
    // ci-pending is not included: the initial ci-pending has reviewCompleted=false by default,
    // and regressions always go through ci-failed first (which resets it).
    if (state === "ci-failed") {
      item.reviewCompleted = false;
    }
    // Clear CI failure notification flag on recovery so re-failures can be notified
    if (state === "ci-pending" || state === "ci-passed") {
      item.ciFailureNotified = false;
      item.ciFailureNotifiedAt = undefined;
    }
    // Clear failureReason when recovering from a failure state
    if (state !== "ci-failed" && state !== "stuck" && state !== "fix-forward-failed") {
      item.failureReason = undefined;
    }
    // Telemetry: record startedAt when worker begins implementing
    if (state === "implementing" && !item.startedAt) {
      item.startedAt = detectedTime;
    }
    // Telemetry: record endedAt when worker reaches a terminal state
    if (state === "done" || state === "stuck") {
      item.endedAt = detectedTime;
    }
    // Emit structured transition event
    this.config.onTransition?.(item.id, prevState, state, detectedTime, item.detectionLatencyMs);
  }

  /** Transition a single item based on its snapshot. Returns actions. */
  private transitionItem(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
    now: Date,
  ): Action[] {
    if (snap?.mergeCommitSha) {
      item.mergeCommitSha = snap.mergeCommitSha;
    }
    if (snap?.defaultBranch) {
      item.defaultBranch = snap.defaultBranch;
    }

    const prevState = item.state;
    let actions: Action[];

    switch (item.state) {
      case "queued":
      case "ready":
        // Handled in bulk in processTransitions
        actions = [];
        break;

      case "bootstrapping":
        // Bootstrap is synchronous -- it transitions to launching or stuck
        // in executeBootstrap. Nothing to do here in the snapshot-based loop.
        actions = [];
        break;

      case "launching":
        if (snap?.workerAlive) {
          item.notAliveCount = 0;
          this.transition(item, "implementing", snap?.eventTime);
          actions = [];
        } else if (snap?.workerAlive === false) {
          item.notAliveCount = (item.notAliveCount ?? 0) + 1;
          if (item.notAliveCount >= NOT_ALIVE_THRESHOLD) {
            actions = this.stuckOrRetry(item, "worker-crashed: session died during launch");
          } else {
            actions = [];
          }
        } else {
          // workerAlive is undefined -- session may not have registered yet.
          // Check for launching timeout to prevent indefinite stall.
          const sinceTransition = now.getTime() - new Date(item.lastTransition).getTime();
          if (sinceTransition > LAUNCHING_TIMEOUT_MS) {
            if (this.shouldDeferTimeout(item, now)) {
              actions = [];
            } else {
              actions = this.stuckOrRetry(item, "launch-timeout: worker never registered within timeout");
            }
          } else {
            actions = [];
          }
        }
        break;

      case "implementing":
        actions = this.handleImplementing(item, snap, now);
        break;

      case "ci-pending":
      case "ci-passed":
      case "ci-failed":
        actions = this.handlePrLifecycle(item, snap);
        break;

      case "rebasing":
        actions = this.handleRebasing(item, snap);
        break;

      case "reviewing":
        actions = this.handleReviewing(item, snap);
        break;

      case "review-pending":
        actions = this.handleReviewPending(item, snap);
        break;

      case "merging":
        actions = this.handleMerging(item, snap);
        break;

      case "merged":
        if (!this.config.fixForward) {
          this.transition(item, "done");
        } else if (item.mergeCommitSha) {
          this.transition(item, "forward-fix-pending");
        } else {
          // Hold in merged until later polls can discover the merge commit SHA.
        }
        actions = [];
        break;

      case "forward-fix-pending":
        actions = this.handleForwardFixPending(item, snap);
        break;

      case "fix-forward-failed":
        actions = this.handleFixForwardFailed(item, snap);
        break;

      case "fixing-forward":
        actions = this.handleFixingForward(item, snap);
        break;

      case "done":
      case "stuck":
        actions = [];
        break;
    }

    // Stuck dep handling: roll back or pause stacked dependents when this item goes stuck
    if (this.config.enableStacking && item.state === "stuck" && prevState !== "stuck") {
      const PRE_WIP_STATES = new Set(["ready", "bootstrapping", "launching"]);
      for (const other of this.getAllItems()) {
        if (other.baseBranch !== `ninthwave/${item.id}`) continue;
        if (PRE_WIP_STATES.has(other.state)) {
          // Pre-WIP: roll back to queued and clear baseBranch to prevent launch on stale base
          this.transition(other, "queued");
          other.baseBranch = undefined;
        } else if (other.workspaceRef) {
          // WIP with active worker: send pause message
          actions.push({
            type: "rebase",
            itemId: other.id,
            message: `[ORCHESTRATOR] Pause: dependency ${item.id} is stuck. Your stacked branch cannot proceed until it is resolved. Please wait.`,
          });
        }
      }
    }

    // Dep recovery: notify stacked dependents when this item recovers from ci-failed to ci-pending
    if (this.config.enableStacking && prevState === "ci-failed" && item.state === "ci-pending") {
      for (const other of this.getAllItems()) {
        if (other.baseBranch !== `ninthwave/${item.id}`) continue;
        if (!other.workspaceRef) continue;
        actions.push({
          type: "rebase",
          itemId: other.id,
          message: `[ORCHESTRATOR] Resume: dependency ${item.id} CI is back to pending. Please rebase onto ninthwave/${item.id} and continue.`,
        });
      }
    }

    // Relay trusted PR comments to workers
    actions.push(...this.processComments(item, snap, actions));

    return actions;
  }

  /** Handle implementing state. */
  private handleImplementing(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
    now: Date,
  ): Action[] {
    // If PR was auto-merged between polls, skip straight to merged
    if (snap?.prState === "merged") {
      if (snap.prNumber) item.prNumber = snap.prNumber;
      this.transition(item, "merged", snap?.eventTime);
      return [{ type: "clean", itemId: item.id }];
    }
    // If a PR appeared, transition directly to ci-pending and process CI status
    if (snap?.prNumber && snap.prState === "open") {
      item.prNumber = snap.prNumber;
      this.transition(item, "ci-pending", snap?.eventTime);
      const actions: Action[] = [];
      // Stacked PR just opened -- sync stack navigation comments on all PRs in the chain
      if (item.baseBranch) {
        actions.push({ type: "sync-stack-comments", itemId: item.id });
      }
      // Fall through to handle CI status in the same cycle
      actions.push(...this.handlePrLifecycle(item, snap));
      return actions;
    }
    // If worker died without a PR, retry or mark stuck.
    // Debounce: require 3 consecutive not-alive checks to avoid false positives
    // from transient cmux listing failures or slow workspace registration.
    if (snap && snap.workerAlive === false && !snap.prNumber) {
      item.notAliveCount = (item.notAliveCount ?? 0) + 1;
      if (item.notAliveCount >= NOT_ALIVE_THRESHOLD) {
        return this.stuckOrRetry(item, "worker-crashed: session died without creating PR");
      }
    } else if (snap && snap.workerAlive === true) {
      item.notAliveCount = 0;
      item.lastAliveAt = now.toISOString();
    }

    // ── Heartbeat-based health detection ──
    // Primary signal: a recent heartbeat means the worker is healthy.
    // If heartbeat exists and is fresh (< 5 min), skip commit-based timeout checks entirely.
    const nowMs = now.getTime();
    const heartbeat = snap?.lastHeartbeat;
    if (heartbeat?.ts) {
      const heartbeatAge = nowMs - new Date(heartbeat.ts).getTime();
      if (heartbeatAge < HEARTBEAT_TIMEOUT_MS) {
        // Worker is actively heartbeating -- healthy, skip timeout checks
        return [];
      }
      // Stale heartbeat -- fall through to process liveness / commit-based timeout
    }

    // ── Process liveness as activity signal ──
    // If the worker process is alive (workerAlive=true), it suppresses the launch timeout.
    // The timeout hierarchy becomes:
    // - Fresh heartbeat (< 5 min) → healthy (handled above)
    // - Process alive → suppress launch timeout, use activityTimeoutMs as hard cap
    // - Process dead → use launchTimeoutMs or crash detection
    const workerAlive = snap?.workerAlive === true;

    // Commit-based timeout: final backstop for workers with no/stale heartbeat
    //
    // Timeout baseline: use the most recent positive signal (lastAliveAt, commitTime,
    // or lastTransition). This prevents a single workerAlive blip from killing a
    // worker that was confirmed alive seconds earlier.
    const commitTime = snap?.lastCommitTime ?? item.lastCommitTime;
    const lastPositiveSignal = item.lastAliveAt
      ? new Date(item.lastAliveAt).getTime()
      : new Date(item.lastTransition).getTime();

    if (!commitTime) {
      // No commits yet -- check launch timeout or activity timeout based on liveness
      const sinceTransition = nowMs - new Date(item.lastTransition).getTime();
      const sinceLastAlive = nowMs - lastPositiveSignal;
      if (workerAlive) {
        // Process alive: suppress launch timeout, use activity timeout as hard cap
        if (sinceTransition > this.config.activityTimeoutMs) {
          if (this.shouldDeferTimeout(item, now)) return [];
          return this.stuckOrRetry(item, "worker-stalled: process alive but no commits after activity timeout");
        }
        // Suppressed launch timeout -- log it if we would have timed out
        if (sinceTransition > this.config.launchTimeoutMs) {
          this.config.onEvent?.(item.id, "timeout-suppressed-by-liveness", {
            sinceTransitionMs: sinceTransition,
            launchTimeoutMs: this.config.launchTimeoutMs,
            activityTimeoutMs: this.config.activityTimeoutMs,
          });
        }
      } else if (sinceLastAlive > this.config.launchTimeoutMs) {
        if (this.shouldDeferTimeout(item, now)) return [];
        return this.stuckOrRetry(item, "worker-stalled: no commits after launch timeout");
      }
    } else {
      // Has commits -- check against activity timeout (same for alive or dead)
      const sinceCommit = nowMs - new Date(commitTime).getTime();
      if (sinceCommit > this.config.activityTimeoutMs) {
        if (this.shouldDeferTimeout(item, now)) return [];
        return this.stuckOrRetry(item, "worker-stalled: no new commits after activity timeout");
      }
    }

    return [];
  }

  /**
   * Timeout grace period gate. On first timeout detection, sets a deadline
   * gracePeriodMs in the future and returns true (defer the kill). On subsequent
   * calls, returns true if the deadline hasn't passed yet.
   * Returns false when the deadline has passed or gracePeriodMs is 0 (immediate kill).
   */
  private shouldDeferTimeout(item: OrchestratorItem, now: Date): boolean {
    if (this.config.gracePeriodMs <= 0) return false;

    if (!item.timeoutDeadline) {
      // First detection: set deadline and defer
      item.timeoutDeadline = new Date(now.getTime() + this.config.gracePeriodMs).toISOString();
      item.timeoutExtensionCount = 0;
      this.config.onEvent?.(item.id, "timeout-grace-started", {
        deadline: item.timeoutDeadline,
        gracePeriodMs: this.config.gracePeriodMs,
      });
      return true;
    }

    // Deadline exists: check if it's still in the future
    return now.getTime() < new Date(item.timeoutDeadline).getTime();
  }

  /**
   * Push the timeout deadline forward by gracePeriodMs.
   * Returns true if the extension was applied, false if max extensions reached
   * or the item has no active timeout deadline.
   */
  extendTimeout(id: string): boolean {
    const item = this.items.get(id);
    if (!item || !item.timeoutDeadline) return false;
    if ((item.timeoutExtensionCount ?? 0) >= this.config.maxTimeoutExtensions) return false;

    const now = Date.now();
    const currentDeadline = new Date(item.timeoutDeadline).getTime();
    // Extend from whichever is later: current deadline or now
    const base = Math.max(now, currentDeadline);
    item.timeoutDeadline = new Date(base + this.config.gracePeriodMs).toISOString();
    item.timeoutExtensionCount = (item.timeoutExtensionCount ?? 0) + 1;
    this.config.onEvent?.(item.id, "timeout-extended", {
      deadline: item.timeoutDeadline,
      extensionCount: item.timeoutExtensionCount,
      maxExtensions: this.config.maxTimeoutExtensions,
    });
    return true;
  }

  /**
   * Check if an item should be retried or permanently stuck.
   * When retries remain, cleans the old worktree and transitions to ready for relaunch.
   * Returns retry action when retrying, empty array when permanently stuck.
   * @param reason - descriptive failure reason (e.g., "worker-crashed: session died during launch")
   */
  private stuckOrRetry(item: OrchestratorItem, reason?: string): Action[] {
    if (item.retryCount < this.config.maxRetries) {
      item.retryCount++;
      // Reset liveness tracking for the new attempt
      item.lastAliveAt = undefined;
      item.notAliveCount = 0;
      item.lastCommitTime = undefined;
      this.transition(item, "ready");
      return [{ type: "retry", itemId: item.id }];
    }
    this.transition(item, "stuck");
    item.failureReason = reason;
    return [{ type: "workspace-close", itemId: item.id }];
  }

  /**
   * Unified handler for ci-pending / ci-passed / ci-failed.
   * Chains transitions within a single cycle so CI pass → merge happens immediately.
   */
  private handlePrLifecycle(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    // Check for external merge first (takes priority)
    if (snap?.prState === "merged") {
      this.transition(item, "merged", snap?.eventTime);
      actions.push({ type: "clean", itemId: item.id });
      return actions;
    }

    // Reset rebase attempt counter when conflicts are resolved
    if (snap?.isMergeable !== false && (item.rebaseAttemptCount ?? 0) > 0) {
      item.rebaseAttemptCount = 0;
    }

    // Resolve the effective CI status from the snapshot
    const ciStatus = snap?.ciStatus;

    // Handle ci-failed special cases first
    if (item.state === "ci-failed") {
      if (item.ciFailCount > this.config.maxCiRetries) {
        this.transition(item, "stuck");
        item.failureReason = `ci-failed: exceeded max CI retries (${this.config.maxCiRetries})`;
        return [{ type: "workspace-close", itemId: item.id }];
      }
      // If CI recovered, transition and continue processing
      if (ciStatus === "pass") {
        this.transition(item, "ci-passed", snap?.eventTime);
      } else if (ciStatus === "pending") {
        this.transition(item, "ci-pending", snap?.eventTime);
        return [];
      } else {
        // Reset notification flag if the worker pushed a new commit (fix attempt)
        if (item.ciFailureNotified && item.lastCommitTime !== item.ciFailureNotifiedAt) {
          item.ciFailureNotified = false;
        }
        // Still failing -- only notify once per failure cycle to avoid comment spam
        if (!item.ciFailureNotified) {
          item.ciFailureNotified = true;
          item.ciFailureNotifiedAt = item.lastCommitTime ?? null;
          actions.push({
            type: "notify-ci-failure",
            itemId: item.id,
            prNumber: item.prNumber,
            message: "[ORCHESTRATOR] CI Fix Request: CI is still failing -- please investigate and fix.",
          });
        }
        return actions;
      }
    }

    // Determine the new CI-based state
    if (ciStatus === "fail") {
      this.transition(item, "ci-failed", snap?.eventTime);
      item.ciFailCount++;
      item.failureReason = snap?.isMergeable === false
        ? "ci-failed: merge conflicts with main"
        : "ci-failed: CI checks failed";

      // When CI fails due to merge conflicts with main, send a rebase
      // message instead of a generic CI failure. The worker should rebase
      // rather than investigate a code bug.
      const isMergeConflict = snap?.isMergeable === false;

      if (isMergeConflict) {
        actions.push({
          type: "daemon-rebase",
          itemId: item.id,
          message: "[ORCHESTRATOR] Rebase Request: CI failed due to merge conflicts with main. Please rebase onto latest main.",
        });
      } else {
        item.ciFailureNotified = true;
        item.ciFailureNotifiedAt = item.lastCommitTime ?? null;
        actions.push({
          type: "notify-ci-failure",
          itemId: item.id,
          prNumber: item.prNumber,
          message: "[ORCHESTRATOR] CI Fix Request: CI failed -- please investigate and fix.",
        });
      }
      return actions;
    }

    if (ciStatus === "pending" && item.state !== "ci-pending") {
      this.transition(item, "ci-pending", snap?.eventTime);
      return [];
    }

    // Detect merge conflicts regardless of CI status. Catches conflicts
    // from other PRs merging to main between polls, including cases where
    // stale CI results still show "pass". Regress ci-passed items to
    // ci-pending since the branch needs updating before review/merge.
    if (snap?.isMergeable === false && !item.rebaseRequested) {
      item.rebaseRequested = true;
      if (item.state === "ci-passed") {
        this.transition(item, "ci-pending", snap?.eventTime);
      }
      actions.push({
        type: "daemon-rebase",
        itemId: item.id,
        message: "[ORCHESTRATOR] Rebase Request: PR has merge conflicts with main. Please rebase onto latest main.",
      });
      return actions;
    }

    if (ciStatus === "pass") {
      if (item.state !== "ci-passed") {
        this.transition(item, "ci-passed", snap?.eventTime);
      }
      // CI passed -- evaluate merge strategy (pass eventTime for chained transitions)
      actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
      return actions;
    }

    // No CI status change or unknown -- stay in current state
    // But if we're already in ci-passed, re-evaluate merge (another PR may
    // have merged to main, changing the mergeable status)
    if (item.state === "ci-passed") {
      actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
    }

    return actions;
  }

  /** Handle review-pending state. */
  private handleReviewPending(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    // Check for external merge
    if (snap?.prState === "merged") {
      this.transition(item, "merged", snap?.eventTime);
      actions.push({ type: "clean", itemId: item.id });
      return actions;
    }

    // If review approved and CI still passes, evaluate merge
    if (snap?.reviewDecision === "APPROVED" && snap?.ciStatus === "pass") {
      actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
      return actions;
    }

    // CI status changes -- worker pushed fixes after review feedback.
    // CI fail is always actionable regardless of reviewCompleted.
    // CI pending/pass transitions only apply when reviewCompleted is false
    // (worker addressing AI review feedback). When reviewCompleted is true,
    // the item waits for human review or manual merge -- CI pass would loop
    // through evaluateMerge back to review-pending.
    const ciStatus = snap?.ciStatus;

    if (ciStatus === "fail") {
      this.transition(item, "ci-failed", snap?.eventTime);
      item.ciFailCount++;

      const isMergeConflict = snap?.isMergeable === false;
      item.failureReason = isMergeConflict
        ? "ci-failed: merge conflicts with main"
        : "ci-failed: CI checks failed";

      if (isMergeConflict) {
        actions.push({
          type: "daemon-rebase",
          itemId: item.id,
          message: "[ORCHESTRATOR] Rebase Request: CI failed due to merge conflicts with main. Please rebase onto latest main.",
        });
      } else {
        item.ciFailureNotified = true;
        item.ciFailureNotifiedAt = item.lastCommitTime ?? null;
        actions.push({
          type: "notify-ci-failure",
          itemId: item.id,
          prNumber: item.prNumber,
          message: "[ORCHESTRATOR] CI Fix Request: CI failed -- please investigate and fix.",
        });
      }
      return actions;
    }

    if (!item.reviewCompleted) {
      if (ciStatus === "pending") {
        this.transition(item, "ci-pending", snap?.eventTime);
        return actions;
      }

      if (ciStatus === "pass") {
        this.transition(item, "ci-passed", snap?.eventTime);
        actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
        return actions;
      }
    }

    // Merge conflict without CI failure -- send rebase request
    if (snap?.isMergeable === false && !item.rebaseRequested) {
      item.rebaseRequested = true;
      actions.push({
        type: "daemon-rebase",
        itemId: item.id,
        message: "[ORCHESTRATOR] Rebase Request: PR has merge conflicts with main. Please rebase onto latest main.",
      });
    }

    return actions;
  }

  /**
   * Handle reviewing state.
   * Review worker is active -- check for verdict file, CI regression, external merge, or worker death.
   */
  private handleReviewing(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    // Drain: skipReview toggled on while item was in reviewing state.
    // reviewCompleted was set by setSkipReview(); clean up the review worker
    // and chain to evaluateMerge.
    if (item.reviewCompleted && this.config.skipReview) {
      this.transition(item, "ci-passed", snap?.eventTime);
      actions.push({ type: "clean-review", itemId: item.id });
      actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
      return actions;
    }

    // External merge takes priority
    if (snap?.prState === "merged") {
      this.transition(item, "merged", snap?.eventTime);
      actions.push({ type: "clean", itemId: item.id });
      if (item.reviewWorkspaceRef) {
        actions.push({ type: "clean-review", itemId: item.id });
      }
      return actions;
    }

    // CI regression during review → transition to ci-failed, clean up review worker
    if (snap?.ciStatus === "fail") {
      this.transition(item, "ci-failed", snap?.eventTime);
      item.ciFailCount++;
      item.failureReason = "ci-failed: CI regression during review";
      actions.push({ type: "clean-review", itemId: item.id });
      actions.push({
        type: "notify-ci-failure",
        itemId: item.id,
        prNumber: item.prNumber,
        message: "[ORCHESTRATOR] CI Fix Request: CI failed during review -- please investigate and fix.",
      });
      return actions;
    }

    // Merge conflict during review → abort review and rebase.
    // Another PR may have merged to main while the review was in progress.
    if (snap?.isMergeable === false && !item.rebaseRequested) {
      item.rebaseRequested = true;
      this.transition(item, "ci-pending", snap?.eventTime);
      actions.push({ type: "clean-review", itemId: item.id });
      actions.push({
        type: "daemon-rebase",
        itemId: item.id,
        message: "[ORCHESTRATOR] Rebase Request: PR has merge conflicts with main. Please rebase onto latest main.",
      });
      return actions;
    }

    // Verdict file detected → process review outcome
    if (snap?.reviewVerdict) {
      const v = snap.reviewVerdict;

      if (v.verdict === "approve") {
        item.reviewCompleted = true;
        this.transition(item, "ci-passed", snap?.eventTime);
        actions.push({ type: "clean-review", itemId: item.id });
        actions.push({
          type: "post-review",
          itemId: item.id,
          prNumber: item.prNumber,
          verdict: v,
        });
        actions.push({
          type: "set-commit-status",
          itemId: item.id,
          prNumber: item.prNumber,
          statusState: "success",
          statusDescription: `Review passed: ${v.blockingCount} blocking, ${v.nonBlockingCount} non-blocking`,
        });
        actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
        return actions;
      }

      if (v.verdict === "request-changes") {
        this.transition(item, "review-pending", snap?.eventTime);
        actions.push({ type: "clean-review", itemId: item.id });
        actions.push({
          type: "post-review",
          itemId: item.id,
          prNumber: item.prNumber,
          verdict: v,
        });
        actions.push({
          type: "set-commit-status",
          itemId: item.id,
          prNumber: item.prNumber,
          statusState: "failure",
          statusDescription: `Changes requested: ${v.blockingCount} blocking, ${v.nonBlockingCount} non-blocking`,
        });
        const round = item.reviewRound ?? 1;
        actions.push({
          type: "notify-review",
          itemId: item.id,
          message: `[ORCHESTRATOR] Review Feedback (round ${round}): ${v.blockingCount} blocking, ${v.nonBlockingCount} non-blocking.\n\n${v.summary}`,
        });
        return actions;
      }
    }

    return actions;
  }

  /** Handle merging state. */
  /**
   * Handle "rebasing" state: a rebaser worker is resolving rebase conflicts.
   * When CI restarts (worker pushed), transition back to ci-pending.
   * If the rebaser worker dies or can't resolve conflicts, mark stuck.
   */
  private handleRebasing(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    // Rebaser worker pushed -- CI re-triggered
    if (snap?.ciStatus === "pending" || snap?.ciStatus === "pass" || snap?.ciStatus === "fail") {
      this.transition(item, "ci-pending");
      item.rebaseRequested = false;
      actions.push({ type: "clean-rebaser", itemId: item.id });
      return actions;
    }

    // Rebaser worker died without pushing
    if (snap?.workerAlive === false && item.rebaserWorkspaceRef) {
      item.notAliveCount = (item.notAliveCount ?? 0) + 1;
      if (item.notAliveCount >= NOT_ALIVE_THRESHOLD) {
        this.transition(item, "stuck");
        item.failureReason = "rebase-failed: rebaser worker could not resolve rebase conflicts";
        actions.push({ type: "clean-rebaser", itemId: item.id });
      }
    }

    return actions;
  }

  private handleMerging(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    if (snap?.prState === "merged") {
      this.transition(item, "merged", snap?.eventTime);
      actions.push({ type: "clean", itemId: item.id });
    } else if (snap?.prState === "closed") {
      this.transition(item, "stuck");
      item.failureReason = "merge-aborted: PR was closed without merging";
    }

    return actions;
  }

  /**
   * Handle "forward-fix-pending" state: polling CI on the merge commit on main.
   * Transitions to done when CI passes, fix-forward-failed when CI fails.
   */
  private handleForwardFixPending(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    if (!snap?.mergeCommitCIStatus) return [];

    switch (snap.mergeCommitCIStatus) {
      case "pass":
        this.transition(item, "done");
        return [];
      case "fail":
        item.fixForwardFailCount = (item.fixForwardFailCount ?? 0) + 1;
        this.transition(item, "fix-forward-failed");
        item.failureReason = `fix-forward-failed: CI failed on main for merge commit ${item.mergeCommitSha}`;
        return [];
      case "pending":
        // Still waiting -- no transition
        return [];
    }
  }

  /**
   * Replace the active PR for an item while preserving the prior active PR chain.
   * Used when a canonical item re-enters the normal pipeline on a repair PR.
   */
  private adoptTrackedPrNumber(item: OrchestratorItem, prNumber: number): void {
    if (item.prNumber != null && item.prNumber !== prNumber) {
      const priorPrNumbers = [...(item.priorPrNumbers ?? [])];
      if (!priorPrNumbers.includes(item.prNumber)) {
        priorPrNumbers.push(item.prNumber);
      }
      item.priorPrNumbers = priorPrNumbers;
    }
    item.prNumber = prNumber;
  }

  /**
   * Handle "fix-forward-failed" state: CI failed on main after merge.
   * If max retries exceeded, transition to stuck.
   * Otherwise, launch a forward-fixer worker to diagnose and fix-forward.
   */
  private handleFixForwardFailed(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    // Circuit breaker: exceeded max fix-forward retries → stuck
    if ((item.fixForwardFailCount ?? 0) >= this.config.maxFixForwardRetries) {
      this.transition(item, "stuck");
      item.failureReason = `fix-forward-failed: exceeded max fix-forward retries (${this.config.maxFixForwardRetries}) for merge commit ${item.mergeCommitSha}`;
      return [];
    }

    // If CI is now passing on the merge commit (e.g., flaky test recovered), go to done
    if (snap?.mergeCommitCIStatus === "pass") {
      this.transition(item, "done");
      return [];
    }

    // Launch forward-fixer worker to diagnose and fix-forward
    if (item.mergeCommitSha) {
      this.transition(item, "fixing-forward");
      return [{ type: "launch-forward-fixer", itemId: item.id }];
    }

    return [];
  }

  /**
   * Handle "fixing-forward" state: a forward-fixer worker is diagnosing and fixing
   * the post-merge CI failure.
   *
   * When the forward-fixer creates a fix PR that merges and CI passes on main,
   * the merge commit CI will turn green. Re-poll CI to detect recovery.
   * If the forward-fixer worker dies without fixing, mark stuck.
   */
  private handleFixingForward(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    // A repair PR now exists for the canonical item. Re-enter the normal PR
    // lifecycle using that PR as the active one instead of continuing to look
    // post-merge-complete.
    if (snap?.prNumber && (snap.prState === "open" || snap.prState === "merged")) {
      this.adoptTrackedPrNumber(item, snap.prNumber);
      item.reviewCompleted = false;
      item.reviewRound = undefined;
      item.lastCommentCheck = undefined;
      item.ciFailCount = 0;
      item.mergeFailCount = 0;
      item.ciFailureNotified = false;
      item.ciFailureNotifiedAt = undefined;
      item.rebaseRequested = false;
      item.notAliveCount = 0;

      if (snap.prState === "merged") {
        this.transition(item, "merged", snap?.eventTime);
        if (item.fixForwardWorkspaceRef) {
          actions.push({ type: "clean-forward-fixer", itemId: item.id });
        }
        return actions;
      }

      this.transition(item, "ci-pending", snap?.eventTime);
      actions.push(...this.handlePrLifecycle(item, snap));
      return actions;
    }

    // CI recovered on main (forward-fixer's fix merged, or flaky test resolved)
    if (snap?.mergeCommitCIStatus === "pass") {
      this.transition(item, "done");
      if (item.fixForwardWorkspaceRef) {
        actions.push({ type: "clean-forward-fixer", itemId: item.id });
      }
      return actions;
    }

    // Forward-fixer worker died without fixing
    if (snap?.workerAlive === false && item.fixForwardWorkspaceRef) {
      item.notAliveCount = (item.notAliveCount ?? 0) + 1;
      if (item.notAliveCount >= NOT_ALIVE_THRESHOLD) {
        this.transition(item, "stuck");
        item.failureReason = `fix-forward-failed: forward-fixer worker died without fixing CI for merge commit ${item.mergeCommitSha}`;
        actions.push({ type: "clean-forward-fixer", itemId: item.id });
      }
    }

    return actions;
  }

  // ── States where PR comment relay is active ────────────────────
  private static readonly COMMENT_RELAY_STATES: Set<OrchestratorItemState> = new Set([
    "ci-pending", "ci-passed", "ci-failed", "review-pending", "reviewing",
  ]);

  /**
   * Process new trusted PR comments and generate relay/action messages.
   * Comments with "rebase" keyword trigger daemon-rebase directly.
   * All other comments are relayed to the worker via send-message.
   * Updates lastCommentCheck to prevent duplicate relay.
   */
  private processComments(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
    existingActions: Action[],
  ): Action[] {
    if (!Orchestrator.COMMENT_RELAY_STATES.has(item.state)) return [];
    if (!snap?.newComments || snap.newComments.length === 0) return [];
    if (!item.prNumber) return [];
    if (!item.workspaceRef) return [];

    const actions: Action[] = [];

    // Update lastCommentCheck to the latest comment timestamp
    const latestCreatedAt = snap.newComments
      .map((c) => c.createdAt)
      .sort()
      .pop();
    if (latestCreatedAt) {
      item.lastCommentCheck = latestCreatedAt;
    }

    // Check if daemon-rebase already queued for this item (avoid duplicates)
    const hasDaemonRebase = existingActions.some(
      (a) => a.type === "daemon-rebase" && a.itemId === item.id,
    );

    for (const comment of snap.newComments) {
      // Skip comments from any ninthwave agent (Orchestrator, Implementer, Reviewer, Forward-Fixer, Rebaser)
      if (/\*\*\[(Orchestrator|Implementer|Reviewer|Forward-Fixer|Rebaser)\]/.test(comment.body)) continue;
      // Skip orchestrator HTML status markers
      if (comment.body.includes("<!-- ninthwave-orchestrator-status -->")) continue;

      if (/\brebase\b/i.test(comment.body)) {
        // "rebase" keyword → trigger daemon-rebase directly (only if not already queued)
        if (!hasDaemonRebase) {
          actions.push({
            type: "daemon-rebase",
            itemId: item.id,
            message: `[ORCHESTRATOR] Rebase Request: @${comment.author} requested rebase on PR #${item.prNumber}.`,
          });
        }
      } else {
        // Relay comment to worker
        actions.push({
          type: "send-message",
          itemId: item.id,
          message: `[ORCHESTRATOR] Review Feedback: @${comment.author} commented on PR #${item.prNumber}:\n\n${comment.body}`,
        });
      }
    }

    return actions;
  }

  /** Evaluate whether to merge based on merge strategy. Carries eventTime through chained transitions. */
  private evaluateMerge(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
    eventTime?: string,
  ): Action[] {
    const actions: Action[] = [];

    // Review gate: item must pass AI review before merge.
    // When skipReview is enabled, bypass the gate entirely -- treat as already reviewed.
    if (this.config.skipReview && !item.reviewCompleted) {
      item.reviewCompleted = true;
    }

    // Transition to reviewing state and launch a review worker.
    if (!item.reviewCompleted) {
      if (item.state !== "reviewing") {
        // Check max review rounds before launching another review
        const currentRound = (item.reviewRound ?? 0) + 1;
        if (currentRound > this.config.maxReviewRounds) {
          this.transition(item, "stuck", eventTime);
          item.failureReason = `review-stuck: exceeded max review rounds (${this.config.maxReviewRounds})`;
          return actions;
        }
        // reviewing is in WIP_STATES, so ci-passed→reviewing is an in-place transition
        // (same WIP slot, different state). Reviews for in-pipeline items are always
        // prioritized: transitionItem runs before launchReadyItems, so the review
        // occupies its WIP slot first, leaving fewer slots for new launches.
        item.reviewRound = currentRound;
        this.config.onEvent?.(item.id, "review-round", { reviewRound: currentRound });
        this.transition(item, "reviewing", eventTime);
        actions.push({
          type: "launch-review",
          itemId: item.id,
          prNumber: item.prNumber,
        });
        // Set pending commit status when entering review
        const description = currentRound > 1
          ? `Re-review in progress (round ${currentRound})`
          : "Review in progress";
        actions.push({
          type: "set-commit-status",
          itemId: item.id,
          prNumber: item.prNumber,
          statusState: "pending",
          statusDescription: description,
        });
      }
      return actions;
    }

    switch (this.config.mergeStrategy) {
      case "auto":
        // Guard: never auto-merge when a reviewer has explicitly requested changes
        if (snap?.reviewDecision === "CHANGES_REQUESTED") {
          if (item.state !== "review-pending") {
            this.transition(item, "review-pending", eventTime);
          }
          break;
        }
        // Merge as soon as CI passes and review completes
        this.transition(item, "merging", eventTime);
        actions.push({
          type: "merge",
          itemId: item.id,
          prNumber: item.prNumber,
        });
        break;

      case "manual":
        // Never auto-merge -- just move to review-pending
        if (item.state !== "review-pending") {
          this.transition(item, "review-pending", eventTime);
        }
        break;

      case "bypass":
        // Admin override merge -- skips branch protection human review requirement.
        // CI and AI review still run (we only get here after ci-passed + review gate).
        // Guard: never bypass when a reviewer has explicitly requested changes
        if (snap?.reviewDecision === "CHANGES_REQUESTED") {
          if (item.state !== "review-pending") {
            this.transition(item, "review-pending", eventTime);
          }
          break;
        }
        this.transition(item, "merging", eventTime);
        actions.push({
          type: "merge",
          itemId: item.id,
          prNumber: item.prNumber,
          admin: true,
        });
        break;
    }

    return actions;
  }

  // ── Action execution ─────────────────────────────────────────

  /**
   * Execute a single action against external systems (gh, cmux, git, etc.).
   * Dependencies are injected via the `deps` parameter to keep the class testable.
   * Updates internal state on success. Returns result indicating success/failure.
   */
  executeAction(
    action: Action,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    const item = this.items.get(action.itemId);
    if (!item) {
      return { success: false, error: `Item ${action.itemId} not found` };
    }

    const handle: OrchestratorHandle = {
      config: this.config,
      transition: (i, s, e) => this.transition(i, s, e),
      getItem: (id) => this.getItem(id),
      getAllItems: () => this.getAllItems(),
      buildStackChain: (id) => this.buildStackChain(id),
    };

    switch (action.type) {
      case "bootstrap":
        return executeBootstrap(handle, item, ctx, deps);
      case "launch":
        return executeLaunch(handle, item, action, ctx, deps);
      case "merge":
        return executeMerge(handle, item, action, ctx, deps);
      case "notify-ci-failure":
        return executeNotifyCiFailure(handle, item, action, ctx, deps);
      case "notify-review":
        return executeNotifyReview(item, action, ctx, deps);
      case "clean":
        return executeClean(item, ctx, deps);
      case "workspace-close":
        return executeWorkspaceClose(item, deps);
      case "rebase":
        return executeRebase(item, action, ctx, deps);
      case "daemon-rebase":
        return executeDaemonRebase(handle, item, action, ctx, deps);
      case "retry":
        return executeRetry(item, ctx, deps);
      case "sync-stack-comments":
        return executeSyncStackComments(handle, item, deps);
      case "launch-rebaser":
        return executeLaunchRebaser(item, ctx, deps);
      case "clean-rebaser":
        return executeCleanRebaser(item, deps);
      case "launch-review":
        return executeLaunchReview(item, action, ctx, deps);
      case "clean-review":
        return executeCleanReview(item, deps);
      case "launch-forward-fixer":
        return executeLaunchForwardFixer(item, ctx, deps);
      case "clean-forward-fixer":
        return executeCleanForwardFixer(item, deps);
      case "send-message":
        return executeSendMessage(item, action, ctx, deps);
      case "set-commit-status":
        return executeSetCommitStatus(item, action, ctx, deps);
      case "post-review":
        return executePostReview(item, action, ctx, deps);
    }
  }

  /**
   * Priority-ordered merge queue: if multiple merge actions are pending,
   * keep only the highest-priority one. Revert deferred items from "merging"
   * back to "ci-passed" so they'll be reconsidered next cycle (after the
   * merged PR's conflicts are checked against remaining PRs).
   * Priority order: critical > high > medium > low, with ID as tiebreaker.
   */
  private prioritizeMergeActions(actions: Action[]): Action[] {
    const mergeActions = actions.filter((a) => a.type === "merge");
    if (mergeActions.length <= 1) return actions;

    // Sort merge candidates by priority (lower rank = higher priority), then ID
    const sorted = mergeActions
      .map((a) => ({ action: a, item: this.items.get(a.itemId)! }))
      .filter((entry) => entry.item != null)
      .sort((a, b) => {
        const aRank = PRIORITY_NUM[a.item.workItem.priority as Priority] ?? 999;
        const bRank = PRIORITY_NUM[b.item.workItem.priority as Priority] ?? 999;
        if (aRank !== bRank) return aRank - bRank;
        return a.item.id.localeCompare(b.item.id);
      });

    const keepId = sorted[0]!.action.itemId;

    // Revert deferred items back to ci-passed -- they'll be merged next cycle
    for (const { item } of sorted.slice(1)) {
      this.transition(item, "ci-passed");
    }

    // Return non-merge actions plus the single prioritized merge action
    return actions.filter((a) => a.type !== "merge" || a.itemId === keepId);
  }

  /**
   * Check if a queued item can be launched stacked on an in-flight dependency.
   * Returns { canStack: true, baseBranch } when the item has exactly one in-flight
   * dep in a stackable state (ci-passed, review-pending, merging) and all other
   * deps are done or merged. Pure function of config + internal state.
   */
  canStackLaunch(item: OrchestratorItem): { canStack: true; baseBranch: string } | { canStack: false } {
    if (!this.config.enableStacking) return { canStack: false };

    const deps = item.workItem.dependencies;
    if (deps.length === 0) return { canStack: false };

    let stackableDep: OrchestratorItem | undefined;

    for (const depId of deps) {
      const dep = this.items.get(depId);
      if (!dep) return { canStack: false }; // unknown dep -- can't stack

      if (dep.state === "done" || (!this.config.fixForward && dep.state === "merged")) {
        continue; // this dep is finished (code is on main)
      }

      // Once a dependency has failed post-merge verification, downstream work
      // must stay blocked until the canonical item fully completes its repair
      // PR and final verification cycle.
      if ((dep.fixForwardFailCount ?? 0) > 0) {
        return { canStack: false };
      }

      if (STACKABLE_STATES.has(dep.state)) {
        if (stackableDep) {
          // More than one in-flight dep in stackable state -- can't stack
          return { canStack: false };
        }
        stackableDep = dep;
      } else {
        // Dep is in a non-stackable, non-done state (e.g., implementing, queued)
        return { canStack: false };
      }
    }

    if (!stackableDep) {
      // All deps are done/merged -- this should be in readyIds, not stacked
      return { canStack: false };
    }

    return { canStack: true, baseBranch: `ninthwave/${stackableDep.id}` };
  }

  /**
   * Build the ordered stack chain containing the given item.
   * Walks up via baseBranch to find the root, then walks down to find all
   * stacked descendants. Returns entries from bottom (closest to base) to top.
   * Only includes active items with a PR number (merged/done items are excluded).
   */
  buildStackChain(itemId: string): Array<{ id: string; prNumber: number; title: string }> {
    const item = this.items.get(itemId);
    if (!item) return [];

    // Walk up from item to root (root = item with no baseBranch or whose dep is unknown)
    const upVisited = new Set<string>();
    let root: OrchestratorItem = item;
    upVisited.add(root.id);

    while (root.baseBranch) {
      const depId = root.baseBranch.replace(/^ninthwave\//, "");
      const dep = this.items.get(depId);
      if (!dep || upVisited.has(dep.id)) break;
      upVisited.add(dep.id);
      root = dep;
    }

    // Walk down from root to build the full linear chain (separate visited set)
    const chain: OrchestratorItem[] = [root];
    const downVisited = new Set<string>([root.id]);
    let current = root;

    for (;;) {
      const parentBranch = `ninthwave/${current.id}`;
      const child = this.getAllItems().find(
        (i) => i.baseBranch === parentBranch && !downVisited.has(i.id),
      );
      if (!child) break;
      downVisited.add(child.id);
      chain.push(child);
      current = child;
    }

    // Filter to active items with PRs (exclude merged/done/verifying -- their PRs are closed)
    const POST_MERGE_STATES = new Set(["done", "merged", "forward-fix-pending", "fix-forward-failed", "fixing-forward"]);
    return chain
      .filter((i) => i.prNumber != null && !POST_MERGE_STATES.has(i.state))
      .map((i) => ({ id: i.id, prNumber: i.prNumber!, title: i.workItem.title }));
  }

  /** Launch ready items up to WIP limit. Returns launch actions. */
  private launchReadyItems(): Action[] {
    const actions: Action[] = [];
    const readyItems = this.getItemsByState("ready");
    const slotsAvailable = this.wipSlots;

    for (let i = 0; i < Math.min(readyItems.length, slotsAvailable); i++) {
      const item = readyItems[i]!;

      // Cross-repo items with bootstrap: true that have no resolvedRepoRoot
      // need bootstrap before launch
      if (this.needsBootstrap(item)) {
        this.transition(item, "bootstrapping");
        actions.push({ type: "bootstrap", itemId: item.id });
      } else {
        this.transition(item, "launching");
        const action: Action = { type: "launch", itemId: item.id };
        if (item.baseBranch) {
          action.baseBranch = item.baseBranch;
        }
        actions.push(action);
      }
    }

    return actions;
  }

  /**
   * Check if an item needs bootstrap before launch.
   * True when the work item has bootstrap: true, has a cross-repo alias, and the repo isn't resolved yet.
   */
  private needsBootstrap(item: OrchestratorItem): boolean {
    if (!item.workItem.bootstrap) return false;
    const alias = item.workItem.repoAlias;
    if (!alias || alias === "self" || alias === "hub") return false;
    // If already resolved, no bootstrap needed
    if (item.resolvedRepoRoot) return false;
    return true;
  }
}
