// Orchestrator state machine for parallel TODO processing.
// processTransitions is pure — takes a snapshot and returns actions, no side effects.
// executeAction bridges the pure state machine to external dependencies via injected deps.

import { join } from "path";
import type { TodoItem, Priority, WorktreeInfo } from "./types.ts";
import { getWorktreeInfo, listCrossRepoEntries } from "./cross-repo.ts";
import type { ScreenHealthStatus } from "./worker-health.ts";

// ── Priority rank for merge queue ordering (lower = higher priority) ─

const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── State types ──────────────────────────────────────────────────────

export type OrchestratorItemState =
  | "queued"
  | "ready"
  | "bootstrapping"
  | "launching"
  | "implementing"
  | "pr-open"
  | "ci-pending"
  | "ci-passed"
  | "ci-failed"
  | "review-pending"
  | "reviewing"
  | "merging"
  | "merged"
  | "done"
  | "stuck";

export type MergeStrategy = "asap" | "approved" | "ask" | "reviewed";

// ── Interfaces ───────────────────────────────────────────────────────

export interface OrchestratorItem {
  id: string;
  todo: TodoItem;
  state: OrchestratorItemState;
  prNumber?: number;
  partition?: number;
  /** cmux workspace reference (e.g., "workspace:1"). */
  workspaceRef?: string;
  /** Timestamp of last state change (ISO string). */
  lastTransition: string;
  /** Number of times CI has failed for this item. */
  ciFailCount: number;
  /** Number of times this item has been retried after worker crash/OOM. */
  retryCount: number;
  /** ISO timestamp of the most recent commit on the worktree branch, or null if none. */
  lastCommitTime?: string | null;
  /** Whether a rebase request has been sent and is awaiting resolution. */
  rebaseRequested?: boolean;
  /** Timestamp from the external system when the triggering event occurred (ISO string). */
  eventTime?: string;
  /** Timestamp when the orchestrator detected the state change (ISO string). */
  detectedTime?: string;
  /** Detection latency in milliseconds (detectedTime - eventTime). */
  detectionLatencyMs?: number;
  /** Last screen output captured when worker died (for diagnostics). */
  lastScreenOutput?: string;
  /** Base branch for stacked launches (e.g., "todo/H-1-1"). When set, the worker creates its branch from this instead of main. */
  baseBranch?: string;
  /** Absolute path to the repo where the PR lives. For hub-local items, equals projectRoot. For cross-repo items, points to the target repo. */
  resolvedRepoRoot?: string;
  /** cmux workspace reference for the review worker session. */
  reviewWorkspaceRef?: string;
  /** Whether this item's review has been completed (approved). Resets on CI regression. */
  reviewCompleted?: boolean;
  /** ISO timestamp of when a stall was first detected. Used to deduplicate nudge messages — only one nudge per stall detection. */
  stallDetectedAt?: string;
  /** Hash of the last screen content, for detecting unchanged screens across polls. */
  lastScreenHash?: string;
  /** Number of consecutive polls where screen content was unchanged. */
  unchangedCount?: number;
  /** Number of consecutive polls where a permission prompt was detected without active processing. */
  permissionCount?: number;
  /** Descriptive reason for why this item failed (e.g., "launch-failed: repo not found", "ci-failed: test timeout"). Set on ci-failed/stuck states, cleared on recovery. */
  failureReason?: string;
  /** ISO timestamp of when the worker was launched (set on transition to implementing). */
  startedAt?: string;
  /** ISO timestamp of when the worker completed (set on transition to done or stuck). */
  endedAt?: string;
  /** Exit code from the worker process (parsed from screen output on completion/failure). */
  exitCode?: number | null;
  /** Last N lines of stderr captured from the worker on failure (for diagnostics). */
  stderrTail?: string;
  /** Number of consecutive polls where isWorkerAlive returned false. Used to debounce stuck detection — a single flaky listing shouldn't kill a healthy worker. */
  notAliveCount?: number;
  /** Number of consecutive merge failures for this item. Resets on successful merge. */
  mergeFailCount?: number;
}

export interface OrchestratorConfig {
  /** Max concurrent items in launching/implementing/pr-open/ci-pending/ci-passed/ci-failed/review-pending states. */
  wipLimit: number;
  /** When to auto-merge: asap (CI pass), approved (CI + review), ask (never auto). */
  mergeStrategy: MergeStrategy;
  /** Max CI failures before marking stuck. */
  maxCiRetries: number;
  /** Max worker crash retries before marking permanently stuck. */
  maxRetries: number;
  /** Timeout (ms) for workers with no commits since entering implementing state. Default: 30 minutes. */
  launchTimeoutMs: number;
  /** Timeout (ms) for workers with stale commits (no new commits). Default: 60 minutes. */
  activityTimeoutMs: number;
  /** Enable stacked branch launches. When true, items with a single in-flight dep in a stackable state can launch early. Default: true. */
  enableStacking: boolean;
  /** Enable review worker after CI passes. When true, items go through a reviewing state before merge. Default: false. */
  reviewEnabled: boolean;
  /** Max concurrent review workers. Tracked independently from main wipLimit. Default: 2. */
  reviewWipLimit: number;
  /** How the review worker handles requested fixes: off (report only), direct (push fixes), pr (open fix PR). Default: "off". */
  reviewAutoFix: "off" | "direct" | "pr";
  /** Whether the review worker can approve PRs on behalf of the orchestrator. Default: false. */
  reviewCanApprove: boolean;
  /** Max merge failures before marking stuck. Default: 3. */
  maxMergeRetries: number;
}

// Re-export ScreenHealthStatus from worker-health (canonical definition lives there)
export type { ScreenHealthStatus } from "./worker-health.ts";

// ── Poll snapshot ────────────────────────────────────────────────────

/** External state for a single item, gathered from gh/cmux polling. */
export interface ItemSnapshot {
  id: string;
  prNumber?: number;
  /** CI status from GitHub checks. */
  ciStatus?: "pass" | "fail" | "pending" | "unknown";
  /** Review decision from GitHub. */
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  /** PR state from GitHub. */
  prState?: "open" | "closed" | "merged";
  /** Whether the PR is mergeable. */
  isMergeable?: boolean;
  /** Whether the worker session is alive. */
  workerAlive?: boolean;
  /** Worker health status from screen inspection (loading, prompt, processing, stalled, error). */
  workerHealth?: "loading" | "prompt" | "processing" | "stalled" | "error";
  /** Stall-detection health status from screen content analysis. */
  screenHealth?: ScreenHealthStatus;
  /** ISO timestamp of the most recent commit on the worktree branch, or null if none beyond base. */
  lastCommitTime?: string | null;
  /** Timestamp from the external system for the current state (ISO string).
   *  e.g., GitHub's completedAt for CI checks, mergedAt for merges, updatedAt for PR changes. */
  eventTime?: string;
}

export interface PollSnapshot {
  items: ItemSnapshot[];
  /** IDs of items whose dependencies are all in 'done' state. */
  readyIds: string[];
}

// ── Actions ──────────────────────────────────────────────────────────

export type ActionType =
  | "bootstrap"
  | "launch"
  | "merge"
  | "notify-ci-failure"
  | "notify-review"
  | "clean"
  | "rebase"
  | "daemon-rebase"
  | "retry"
  | "sync-stack-comments"
  | "launch-review"
  | "clean-review"
  | "send-message";

export interface Action {
  type: ActionType;
  itemId: string;
  /** For merge actions, the PR number. */
  prNumber?: number;
  /** For notify actions, the message to send. */
  message?: string;
  /** For launch actions, the base branch to stack on (e.g., "todo/H-1-1"). */
  baseBranch?: string;
}

// ── Execution context and dependencies ──────────────────────────────

/** Configuration for executing actions against external systems. */
export interface ExecutionContext {
  projectRoot: string;
  worktreeDir: string;
  todosDir: string;
  aiTool: string;
}

/** External dependencies injected into executeAction. */
export interface OrchestratorDeps {
  launchSingleItem: (
    item: TodoItem,
    todosDir: string,
    worktreeDir: string,
    projectRoot: string,
    aiTool: string,
    baseBranch?: string,
  ) => { worktreePath: string; workspaceRef: string } | null;
  cleanSingleWorktree: (
    id: string,
    worktreeDir: string,
    projectRoot: string,
  ) => boolean;
  prMerge: (repoRoot: string, prNumber: number) => boolean;
  prComment: (repoRoot: string, prNumber: number, body: string) => boolean;
  sendMessage: (workspaceRef: string, message: string) => boolean;
  closeWorkspace: (workspaceRef: string) => boolean;
  fetchOrigin: (repoRoot: string, branch: string) => void;
  ffMerge: (repoRoot: string, branch: string) => void;
  /** Check if a PR is mergeable (no conflicts). Returns true if mergeable, false if conflicting. */
  checkPrMergeable?: (repoRoot: string, prNumber: number) => boolean;
  /**
   * Daemon-side rebase: fetch origin/main, rebase the branch, and force-push.
   * The worktreePath is the path to the worktree where the branch is checked out.
   * Returns true on success, false on failure (caller should fall back to worker rebase).
   */
  daemonRebase?: (worktreePath: string, branch: string) => boolean;
  /** Read the last N lines of a worker's terminal screen for diagnostics. */
  readScreen?: (workspaceRef: string, lines?: number) => string;
  /** Log a warning message (for situations that need human attention). */
  warn?: (message: string) => void;
  /**
   * Squash-merge-safe rebase using `git rebase --onto`.
   * Replays only the commits from `oldBase..branch` onto `newBase`.
   * Returns true on success, false on conflict (with clean abort).
   */
  rebaseOnto?: (worktreePath: string, newBase: string, oldBase: string, branch: string) => boolean;
  /** Force-push the current branch in a worktree. Returns true on success. */
  forcePush?: (worktreePath: string) => boolean;
  /**
   * Sync stack navigation comments on all PRs in a stack.
   * Injected (not imported) for test isolation. Production binds this to
   * syncStackComments from core/stack-comments.ts with a real GhCommentClient.
   */
  syncStackComments?: (baseBranch: string, stack: Array<{ prNumber: number; title: string }>) => void;
  /**
   * Bootstrap a target repo (clone from remote or create new).
   * Called before launch when a cross-repo TODO has bootstrap: true and the repo doesn't exist locally.
   * Returns the resolved repo path on success, or an error string on failure.
   */
  bootstrapRepo?: (alias: string, projectRoot: string) => { status: "exists" | "cloned" | "created"; path?: string } | { status: "failed"; reason: string };
  /**
   * Launch a review worker for a PR. Returns a workspace reference on success.
   * Actual logic lives in H-RVW-3; stub for now.
   */
  launchReview?: (itemId: string, prNumber: number, repoRoot: string) => { workspaceRef: string } | null;
  /**
   * Clean up a review worker session and workspace.
   * Actual logic lives in H-RVW-3; stub for now.
   */
  cleanReview?: (itemId: string, reviewWorkspaceRef: string) => boolean;
}

/** Result of executing a single action. */
export interface ActionResult {
  success: boolean;
  error?: string;
}

// ── Default config ───────────────────────────────────────────────────

export const DEFAULT_CONFIG: OrchestratorConfig = {
  wipLimit: 4,
  mergeStrategy: "asap",
  maxCiRetries: 2,
  maxRetries: 1,
  launchTimeoutMs: 30 * 60 * 1000,   // 30 minutes
  activityTimeoutMs: 60 * 60 * 1000, // 60 minutes
  enableStacking: true,
  reviewEnabled: false,
  reviewWipLimit: 2,
  reviewAutoFix: "off",
  reviewCanApprove: false,
  maxMergeRetries: 3,
};

// ── Memory-aware WIP limit ──────────────────────────────────────────

/** Estimated memory consumption per worker (Claude Code + language server + worktree). */
export const BYTES_PER_WORKER = 1 * 1024 * 1024 * 1024; // 1 GB

/**
 * Calculate the memory-aware WIP limit based on available free memory.
 * Returns floor(freeMemBytes / memPerWorkerBytes), clamped to [1, configuredLimit].
 * Returns 0 only when configuredLimit is 0 (used in tests to prevent auto-launch).
 *
 * @param configuredLimit - The user-configured or default WIP limit (upper bound)
 * @param freeMemBytes - Available free memory in bytes (e.g., from os.freemem())
 * @param memPerWorkerBytes - Memory per worker in bytes (default: 2.5 GB)
 */
export function calculateMemoryWipLimit(
  configuredLimit: number,
  freeMemBytes: number,
  memPerWorkerBytes: number = BYTES_PER_WORKER,
): number {
  if (configuredLimit <= 0) return 0;
  const memorySlots = Math.floor(freeMemBytes / memPerWorkerBytes);
  return Math.max(1, Math.min(memorySlots, configuredLimit));
}

// ── WIP states: states that count toward the WIP limit ───────────────

const WIP_STATES: Set<OrchestratorItemState> = new Set([
  "bootstrapping",
  "launching",
  "implementing",
  "pr-open",
  "ci-pending",
  "ci-passed",
  "ci-failed",
  "review-pending",
  "merging",
]);

// ── Stackable states: dep states that allow a dependent item to launch stacked ──

export const STACKABLE_STATES: Set<OrchestratorItemState> = new Set([
  "ci-passed",
  "review-pending",
  "merging",
]);

// ── Orchestrator class ───────────────────────────────────────────────

export class Orchestrator {
  readonly config: OrchestratorConfig;
  private items: Map<string, OrchestratorItem> = new Map();
  /** Memory-adjusted WIP limit. When set, takes precedence over config.wipLimit for slot calculation. */
  private _effectiveWipLimit?: number;

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

  /** Add a TODO item to orchestration. Starts in 'queued' state. */
  addItem(todo: TodoItem, partition?: number): void {
    this.items.set(todo.id, {
      id: todo.id,
      todo,
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

  /** Directly set an item's state (for external updates like launch confirmation). */
  setState(id: string, state: OrchestratorItemState): void {
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

  /** Count of items currently in the reviewing state (tracked independently from main WIP). */
  get reviewWipCount(): number {
    return this.getItemsByState("reviewing").length;
  }

  /** How many more review workers can be launched without exceeding reviewWipLimit. */
  get reviewWipSlots(): number {
    return Math.max(0, this.config.reviewWipLimit - this.reviewWipCount);
  }

  /**
   * Pure state machine transition function.
   * Takes a poll snapshot (external state) and returns actions to execute.
   * Does NOT execute the actions — the caller is responsible for that.
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
    // Clear rebase flag on any state change — the worker pushed or CI restarted
    item.rebaseRequested = false;
    // Reset reviewCompleted on CI regression — requires fresh review after fixes
    if (state === "ci-pending" || state === "ci-failed") {
      item.reviewCompleted = false;
    }
    // Clear failureReason when recovering from a failure state
    if (state !== "ci-failed" && state !== "stuck") {
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
  }

  /** Transition a single item based on its snapshot. Returns actions. */
  private transitionItem(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
    now: Date,
  ): Action[] {
    const prevState = item.state;
    let actions: Action[];

    switch (item.state) {
      case "queued":
      case "ready":
        // Handled in bulk in processTransitions
        actions = [];
        break;

      case "bootstrapping":
        // Bootstrap is synchronous — it transitions to launching or stuck
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
          if (item.notAliveCount >= 3) {
            actions = this.stuckOrRetry(item, "worker-crashed: session died during launch");
          } else {
            actions = [];
          }
        } else {
          actions = [];
        }
        break;

      case "implementing":
        actions = this.handleImplementing(item, snap, now);
        break;

      case "pr-open":
      case "ci-pending":
      case "ci-passed":
      case "ci-failed":
        actions = this.handlePrLifecycle(item, snap);
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
        this.transition(item, "done");
        actions = [];
        break;

      case "done":
      case "stuck":
        actions = [];
        break;
    }

    // Stuck dep pause: notify stacked dependents when this item goes stuck
    if (this.config.enableStacking && item.state === "stuck" && prevState !== "stuck") {
      for (const other of this.getAllItems()) {
        if (other.baseBranch !== `todo/${item.id}`) continue;
        if (!other.workspaceRef) continue;
        actions.push({
          type: "rebase",
          itemId: other.id,
          message: `[ORCHESTRATOR] Pause: dependency ${item.id} is stuck. Your stacked branch cannot proceed until it is resolved. Please wait.`,
        });
      }
    }

    // Dep recovery: notify stacked dependents when this item recovers from ci-failed to ci-pending
    if (this.config.enableStacking && prevState === "ci-failed" && item.state === "ci-pending") {
      for (const other of this.getAllItems()) {
        if (other.baseBranch !== `todo/${item.id}`) continue;
        if (!other.workspaceRef) continue;
        actions.push({
          type: "rebase",
          itemId: other.id,
          message: `[ORCHESTRATOR] Resume: dependency ${item.id} CI is back to pending. Please rebase onto todo/${item.id} and continue.`,
        });
      }
    }

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
    // If a PR appeared, move to pr-open
    if (snap?.prNumber && snap.prState === "open") {
      item.prNumber = snap.prNumber;
      this.transition(item, "pr-open", snap?.eventTime);
      const actions: Action[] = [];
      // Stacked PR just opened — sync stack navigation comments on all PRs in the chain
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
      if (item.notAliveCount >= 3) {
        return this.stuckOrRetry(item, "worker-crashed: session died without creating PR");
      }
    } else if (snap && snap.workerAlive === true) {
      item.notAliveCount = 0;
    }

    // Time-based heartbeat: detect workers that are alive but not making progress
    const nowMs = now.getTime();
    const commitTime = snap?.lastCommitTime ?? item.lastCommitTime;
    if (!commitTime) {
      // No commits yet — check against launch timeout
      const sinceTransition = nowMs - new Date(item.lastTransition).getTime();
      if (sinceTransition > this.config.launchTimeoutMs) {
        return this.stuckOrRetry(item, "worker-stalled: no commits after launch timeout");
      }
    } else {
      // Has commits — check against activity timeout
      const sinceCommit = nowMs - new Date(commitTime).getTime();
      if (sinceCommit > this.config.activityTimeoutMs) {
        return this.stuckOrRetry(item, "worker-stalled: no new commits after activity timeout");
      }
    }

    // Screen-based stall detection: nudge workers that are alive but stalled
    const actions = this.handleScreenHealthNudge(item, snap, now);
    if (actions.length > 0) return actions;

    return [];
  }

  /**
   * Screen-based stall detection: when screenHealth indicates a stalled worker,
   * emit a send-message nudge. Uses stallDetectedAt for deduplication — only one
   * nudge is sent per stall detection. Clears stallDetectedAt when worker recovers.
   */
  private handleScreenHealthNudge(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
    _now: Date,
  ): Action[] {
    const health = snap?.screenHealth;
    if (!health) return [];

    // Worker recovered — clear stall tracking
    if (health === "healthy" || health === "unknown") {
      item.stallDetectedAt = undefined;
      return [];
    }

    // Stall detected — but only nudge once per stall episode
    if (item.stallDetectedAt) {
      // Already sent a nudge for this stall — wait for recovery
      return [];
    }

    // First detection of this stall — record timestamp and send nudge
    item.stallDetectedAt = new Date().toISOString();

    let message: string;
    switch (health) {
      case "stalled-empty":
        message = "Start";
        break;
      case "stalled-permission":
        message = "[ORCHESTRATOR] Permission prompt detected — worker is waiting for approval. Please respond to the permission dialog.";
        break;
      case "stalled-error":
        message = "[ORCHESTRATOR] Error detected on worker screen. Please investigate and recover.";
        break;
      case "stalled-unchanged":
        message = "[ORCHESTRATOR] Worker screen has not changed across multiple polls. Are you still making progress?";
        break;
      default:
        return [];
    }

    return [{ type: "send-message", itemId: item.id, message }];
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
      this.transition(item, "ready");
      return [{ type: "retry", itemId: item.id }];
    }
    this.transition(item, "stuck");
    item.failureReason = reason;
    return [{ type: "clean", itemId: item.id }];
  }

  /**
   * Unified handler for pr-open / ci-pending / ci-passed / ci-failed.
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

    // Resolve the effective CI status from the snapshot
    const ciStatus = snap?.ciStatus;

    // Handle ci-failed special cases first
    if (item.state === "ci-failed") {
      if (item.ciFailCount > this.config.maxCiRetries) {
        this.transition(item, "stuck");
        item.failureReason = `ci-failed: exceeded max CI retries (${this.config.maxCiRetries})`;
        return [{ type: "clean", itemId: item.id }];
      }
      // If CI recovered, transition and continue processing
      if (ciStatus === "pass") {
        this.transition(item, "ci-passed", snap?.eventTime);
      } else if (ciStatus === "pending") {
        this.transition(item, "ci-pending", snap?.eventTime);
        return [];
      } else {
        // Still failing — retry CI notification in case it wasn't delivered
        actions.push({
          type: "notify-ci-failure",
          itemId: item.id,
          prNumber: item.prNumber,
          message: "[ORCHESTRATOR] CI Fix Request: CI is still failing — please investigate and fix.",
        });
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
        actions.push({
          type: "notify-ci-failure",
          itemId: item.id,
          prNumber: item.prNumber,
          message: "[ORCHESTRATOR] CI Fix Request: CI failed — please investigate and fix.",
        });
      }
      return actions;
    }

    if (ciStatus === "pending" && item.state !== "ci-pending") {
      this.transition(item, "ci-pending", snap?.eventTime);
      return [];
    }

    // Detect merge conflicts on PRs stuck in ci-pending — a CONFLICTING
    // PR will never get CI results, so waiting is pointless. Send a rebase
    // request (once) so the worker can resolve and re-push.
    if (item.state === "ci-pending" && snap?.isMergeable === false && !item.rebaseRequested) {
      item.rebaseRequested = true;
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
      // CI passed — evaluate merge strategy (pass eventTime for chained transitions)
      actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
      return actions;
    }

    // No CI status change or unknown — stay in current state
    // But if we're already in ci-passed, re-evaluate merge
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
    }

    return actions;
  }

  /**
   * Handle reviewing state.
   * Review worker is active — check for review outcome, CI regression, external merge, or worker death.
   */
  private handleReviewing(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

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
        message: "[ORCHESTRATOR] CI Fix Request: CI failed during review — please investigate and fix.",
      });
      return actions;
    }

    // Review APPROVED → set reviewCompleted, transition back to ci-passed (evaluateMerge handles merge)
    if (snap?.reviewDecision === "APPROVED") {
      item.reviewCompleted = true;
      this.transition(item, "ci-passed", snap?.eventTime);
      // Chain through evaluateMerge to handle merge in the same cycle
      actions.push(...this.evaluateMerge(item, snap, snap?.eventTime));
      return actions;
    }

    // Review CHANGES_REQUESTED → transition to review-pending, notify worker
    if (snap?.reviewDecision === "CHANGES_REQUESTED") {
      this.transition(item, "review-pending", snap?.eventTime);
      actions.push({
        type: "notify-review",
        itemId: item.id,
        message: "[ORCHESTRATOR] Review Feedback: Review worker requested changes — please address.",
      });
      return actions;
    }

    return actions;
  }

  /** Handle merging state. */
  private handleMerging(
    item: OrchestratorItem,
    snap: ItemSnapshot | undefined,
  ): Action[] {
    const actions: Action[] = [];

    if (snap?.prState === "merged") {
      this.transition(item, "merged", snap?.eventTime);
      actions.push({ type: "clean", itemId: item.id });
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

    // Review gate: when review is enabled and item hasn't been reviewed yet,
    // transition to reviewing state and launch a review worker instead of merging.
    if (this.config.reviewEnabled && !item.reviewCompleted) {
      if (item.state !== "reviewing") {
        if (this.reviewWipSlots > 0) {
          this.transition(item, "reviewing", eventTime);
          actions.push({
            type: "launch-review",
            itemId: item.id,
            prNumber: item.prNumber,
          });
        }
        // else: no review slots available, stay in ci-passed until a slot opens
      }
      return actions;
    }

    switch (this.config.mergeStrategy) {
      case "asap":
        // Guard: never auto-merge when a reviewer has explicitly requested changes
        if (snap?.reviewDecision === "CHANGES_REQUESTED") {
          if (item.state !== "review-pending") {
            this.transition(item, "review-pending", eventTime);
          }
          break;
        }
        // Merge as soon as CI passes
        this.transition(item, "merging", eventTime);
        actions.push({
          type: "merge",
          itemId: item.id,
          prNumber: item.prNumber,
        });
        break;

      case "approved":
        // Need review approval before merging
        if (snap?.reviewDecision === "APPROVED") {
          this.transition(item, "merging", eventTime);
          actions.push({
            type: "merge",
            itemId: item.id,
            prNumber: item.prNumber,
          });
        } else if (item.state !== "review-pending") {
          // Move to review-pending to wait for approval
          this.transition(item, "review-pending", eventTime);
        }
        break;

      case "ask":
        // Never auto-merge — just move to review-pending
        if (item.state !== "review-pending") {
          this.transition(item, "review-pending", eventTime);
        }
        break;

      case "reviewed":
        // Merge after AI review completes (review gate in evaluateMerge handles reviewing state).
        // Once reviewCompleted is true, merge like asap.
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

    switch (action.type) {
      case "bootstrap":
        return this.executeBootstrap(item, ctx, deps);
      case "launch":
        return this.executeLaunch(item, action, ctx, deps);
      case "merge":
        return this.executeMerge(item, action, ctx, deps);
      case "notify-ci-failure":
        return this.executeNotifyCiFailure(item, action, ctx, deps);
      case "notify-review":
        return this.executeNotifyReview(item, action, deps);
      case "clean":
        return this.executeClean(item, ctx, deps);
      case "rebase":
        return this.executeRebase(item, action, deps);
      case "daemon-rebase":
        return this.executeDaemonRebase(item, action, ctx, deps);
      case "retry":
        return this.executeRetry(item, ctx, deps);
      case "sync-stack-comments":
        return this.executeSyncStackComments(item, deps);
      case "launch-review":
        return this.executeLaunchReview(item, action, ctx, deps);
      case "clean-review":
        return this.executeCleanReview(item, deps);
      case "send-message":
        return this.executeSendMessage(item, action, deps);
    }
  }

  /**
   * Bootstrap a target repo for a cross-repo item.
   * On success, sets resolvedRepoRoot and transitions to launching.
   * On failure, marks the item stuck with a descriptive reason.
   */
  private executeBootstrap(
    item: OrchestratorItem,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    if (!deps.bootstrapRepo) {
      this.transition(item, "stuck");
      item.failureReason = "bootstrap-failed: bootstrapRepo dependency not provided";
      return { success: false, error: `Bootstrap not available for ${item.id}` };
    }

    const alias = item.todo.repoAlias;
    const result = deps.bootstrapRepo(alias, ctx.projectRoot);

    if (result.status === "failed") {
      this.transition(item, "stuck");
      item.failureReason = `bootstrap-failed: ${result.reason}`;
      return { success: false, error: `Bootstrap failed for ${item.id}: ${result.reason}` };
    }

    // Resolve the repo root now that bootstrap succeeded
    if (result.status === "cloned" || result.status === "created") {
      item.resolvedRepoRoot = result.path;
    }
    // status === "exists" should not normally happen (needsBootstrap checks resolvedRepoRoot),
    // but is harmless — resolvedRepoRoot remains unset and launch will resolve normally.

    // Transition to launching — the next processTransitions cycle will not
    // re-emit a launch action (launching is handled by transitionItem).
    // Instead, we return success so the execution layer can emit a follow-up launch.
    this.transition(item, "launching");
    return { success: true };
  }

  /** Launch a worker for an item. Stores workspaceRef on success, marks stuck or schedules retry on failure. */
  private executeLaunch(
    item: OrchestratorItem,
    action: Action,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    try {
      const result = deps.launchSingleItem(
        item.todo,
        ctx.todosDir,
        ctx.worktreeDir,
        ctx.projectRoot,
        ctx.aiTool,
        action.baseBranch,
      );
      if (!result) {
        if (item.retryCount < this.config.maxRetries) {
          item.retryCount++;
          this.transition(item, "ready");
          return { success: false, error: `Launch failed for ${item.id}, scheduled retry ${item.retryCount}/${this.config.maxRetries}` };
        }
        this.transition(item, "stuck");
        item.failureReason = `launch-failed: worker launch returned no result for ${item.id}`;
        return { success: false, error: `Launch failed for ${item.id}` };
      }
      item.workspaceRef = result.workspaceRef;
      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (item.retryCount < this.config.maxRetries) {
        item.retryCount++;
        this.transition(item, "ready");
        return { success: false, error: `${msg}, scheduled retry ${item.retryCount}/${this.config.maxRetries}` };
      }
      this.transition(item, "stuck");
      item.failureReason = `launch-failed: ${msg}`;
      return { success: false, error: msg };
    }
  }

  /** Merge a PR, pull main, send rebase requests to dependent workers, and check sibling PRs for conflicts. */
  private executeMerge(
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
    const merged = deps.prMerge(repoRoot, prNum);
    if (!merged) {
      item.mergeFailCount = (item.mergeFailCount ?? 0) + 1;
      if (item.mergeFailCount >= this.config.maxMergeRetries) {
        this.transition(item, "stuck");
        item.failureReason = `merge-failed: exceeded max merge retries (${this.config.maxMergeRetries}) for PR #${prNum}`;
        return { success: false, error: `Merge failed ${item.mergeFailCount} times for PR #${prNum}, marking stuck` };
      }
      this.transition(item, "ci-passed");
      return { success: false, error: `Merge failed for PR #${prNum} (attempt ${item.mergeFailCount}/${this.config.maxMergeRetries})` };
    }

    // Reset merge failure counter on success
    item.mergeFailCount = 0;

    // Audit trail
    deps.prComment(
      repoRoot,
      prNum,
      `**[Orchestrator]** Auto-merged PR #${prNum} for ${item.id}.`,
    );

    // Merge was initiated by us, so eventTime is now
    this.transition(item, "merged");

    // Pull latest main in the target repo (where the PR was merged)
    try {
      deps.fetchOrigin(repoRoot, "main");
      deps.ffMerge(repoRoot, "main");
    } catch {
      // Non-fatal — main will be pulled on next cycle
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
    // These items had baseBranch set to the merged dep's branch — replay only
    // their unique commits onto main, avoiding duplicate commits from squash merge.
    const restackedIds = new Set<string>();
    const successfulRestacks = new Set<string>();
    const depBranch = `todo/${item.id}`;

    // Cache cross-repo index for worktree lookups in sibling loops
    const crossRepoIndex = join(ctx.worktreeDir, ".cross-repo-index");
    const cachedEntries = listCrossRepoEntries(crossRepoIndex);

    for (const other of this.getAllItems()) {
      if (other.id === item.id) continue;
      if (!other.todo.dependencies.includes(item.id)) continue;
      if (!WIP_STATES.has(other.state)) continue;
      if (!other.baseBranch) continue; // not stacked — handled below

      restackedIds.add(other.id);

      const otherWtInfo = getWorktreeInfo(other.id, crossRepoIndex, ctx.worktreeDir, cachedEntries);
      const otherRepoRoot = otherWtInfo?.repoRoot ?? other.resolvedRepoRoot ?? ctx.projectRoot;
      const otherWorktreePath = otherWtInfo?.worktreePath ?? join(otherRepoRoot, ".worktrees", `todo-${other.id}`);
      const otherBranch = `todo/${other.id}`;

      if (!deps.rebaseOnto || !deps.forcePush) {
        // rebaseOnto or forcePush not available — send worker manual rebase instructions
        if (other.workspaceRef) {
          deps.sendMessage(
            other.workspaceRef,
            `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto main ${depBranch} ${otherBranch} && git push --force-with-lease`,
          );
        }
        continue;
      }

      try {
        const success = deps.rebaseOnto(otherWorktreePath, "main", depBranch, otherBranch);
        if (success) {
          deps.forcePush(otherWorktreePath);
          other.baseBranch = undefined; // no longer stacked
          successfulRestacks.add(other.id);
        } else {
          // Conflict — send worker manual rebase instructions
          if (other.workspaceRef) {
            deps.sendMessage(
              other.workspaceRef,
              `[ORCHESTRATOR] Restack Conflict: dependency ${item.id} was squash-merged but rebase --onto had conflicts. Run manually: git rebase --onto main ${depBranch} ${otherBranch}`,
            );
          }
        }
      } catch {
        // Unexpected error — fall back to worker message
        if (other.workspaceRef) {
          deps.sendMessage(
            other.workspaceRef,
            `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto main ${depBranch} ${otherBranch} && git push --force-with-lease`,
          );
        }
      }
    }

    // Send rebase requests to non-stacked dependent items in WIP states.
    // Stacked items were handled above via rebaseOnto — skip them.
    for (const other of this.getAllItems()) {
      if (other.id === item.id) continue;
      if (!other.todo.dependencies.includes(item.id)) continue;
      if (!WIP_STATES.has(other.state)) continue;
      if (restackedIds.has(other.id)) continue;
      if (other.workspaceRef) {
        deps.sendMessage(
          other.workspaceRef,
          `Dependency ${item.id} merged. Please rebase onto latest main.`,
        );
      }
    }

    // Post-merge daemon-rebase: proactively rebase in-flight sibling PRs in the same repo.
    // This eliminates most conflicts before workers notice, reducing CI churn.
    // Skip restacked items — they were already rebased with --onto above.
    // Skip items in different repos — their main didn't change from this merge.
    for (const other of this.getAllItems()) {
      if (other.id === item.id) continue;
      if (!WIP_STATES.has(other.state)) continue;
      if (!other.prNumber) continue;
      if (restackedIds.has(other.id)) continue;

      // Only rebase siblings in the same target repo — a merge in repo-B
      // doesn't affect main in repo-A
      const otherRepoRoot2 = other.resolvedRepoRoot ?? ctx.projectRoot;
      if (otherRepoRoot2 !== repoRoot) continue;

      const otherBranch = `todo/${other.id}`;
      const otherWtInfo2 = getWorktreeInfo(other.id, crossRepoIndex, ctx.worktreeDir, cachedEntries);
      const otherWorktreePath = otherWtInfo2?.worktreePath ?? join(otherRepoRoot2, ".worktrees", `todo-${other.id}`);

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

      // Daemon rebase failed or unavailable — check if actually conflicting
      if (deps.checkPrMergeable) {
        const mergeable = deps.checkPrMergeable(otherRepoRoot2, other.prNumber);
        if (!mergeable) {
          // Actually conflicting — send worker rebase message as fallback
          if (other.workspaceRef) {
            deps.sendMessage(
              other.workspaceRef,
              `Sibling PR #${other.prNumber} has merge conflicts after ${item.id} was merged. Please rebase onto latest main.`,
            );
          } else {
            deps.warn?.(
              `[Orchestrator] PR #${other.prNumber} (${other.id}) has merge conflicts but daemon rebase failed and worker has no workspace reference. Manual rebase needed.`,
            );
          }
        }
        // Not conflicting — skip, no action needed
      }
    }

    // Update stack navigation comments on remaining stacked PRs.
    // After restacking, the merged item is gone and the chain has changed.
    if (deps.syncStackComments && successfulRestacks.size > 0) {
      const synced = new Set<string>();
      for (const id of successfulRestacks) {
        const chain = this.buildStackChain(id);
        if (chain.length < 2) continue; // single item — no stack to show
        const rootKey = chain[0]!.id;
        if (synced.has(rootKey)) continue; // already synced this chain
        synced.add(rootKey);
        deps.syncStackComments("main", chain);
      }
    }

    return { success: true };
  }

  /** Notify worker of CI failure and post audit trail on PR. */
  private executeNotifyCiFailure(
    item: OrchestratorItem,
    action: Action,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    const message = action.message || "CI failed — please investigate and fix.";

    if (!item.workspaceRef) {
      return { success: false, error: `No workspace reference for ${item.id} — cannot notify worker of CI failure` };
    }

    const sent = deps.sendMessage(item.workspaceRef, message);
    if (!sent) {
      return { success: false, error: `Failed to send CI failure message to ${item.id}` };
    }

    if (item.prNumber) {
      deps.prComment(
        item.resolvedRepoRoot ?? ctx.projectRoot,
        item.prNumber,
        `**[Orchestrator]** CI failure detected for ${item.id}. Worker notified.`,
      );
    }

    return { success: true };
  }

  /** Notify worker of review feedback. */
  private executeNotifyReview(
    item: OrchestratorItem,
    action: Action,
    deps: OrchestratorDeps,
  ): ActionResult {
    const message = action.message || "Review feedback received — please address.";

    if (!item.workspaceRef) {
      return { success: false, error: `No workspace reference for ${item.id} — cannot notify worker of review feedback` };
    }

    const sent = deps.sendMessage(item.workspaceRef, message);
    if (!sent) {
      return { success: false, error: `Failed to send review feedback to ${item.id}` };
    }

    return { success: true };
  }

  /** Close workspace and clean worktree for an item. */
  private executeClean(
    item: OrchestratorItem,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    // Read screen before closing — capture error output for stuck diagnostics
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
    const worktreeDir = repoRoot !== ctx.projectRoot ? join(repoRoot, ".worktrees") : ctx.worktreeDir;
    const worktreeCleaned = deps.cleanSingleWorktree(item.id, worktreeDir, repoRoot);

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

  /** Send a nudge/message to a worker (for stall recovery, etc.). */
  private executeSendMessage(
    item: OrchestratorItem,
    action: Action,
    deps: OrchestratorDeps,
  ): ActionResult {
    const message = action.message || "Are you still making progress?";

    if (!item.workspaceRef) {
      return { success: false, error: `No workspace reference for ${item.id} — cannot send message` };
    }

    const sent = deps.sendMessage(item.workspaceRef, message);
    if (!sent) {
      return { success: false, error: `Failed to send message to ${item.id}` };
    }

    return { success: true };
  }

  /** Send rebase request to a worker. */
  private executeRebase(
    item: OrchestratorItem,
    action: Action,
    deps: OrchestratorDeps,
  ): ActionResult {
    const message = action.message || "Please rebase onto latest main.";

    if (!item.workspaceRef) {
      return { success: false, error: `No workspace reference for ${item.id}` };
    }

    const sent = deps.sendMessage(item.workspaceRef, message);
    if (!sent) {
      return { success: false, error: `Failed to send rebase message to ${item.id}` };
    }

    return { success: true };
  }

  /**
   * Daemon-side rebase: attempt to rebase the branch onto main without worker involvement.
   * Falls back to worker rebase message on failure.
   */
  private executeDaemonRebase(
    item: OrchestratorItem,
    action: Action,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    const branch = `todo/${item.id}`;

    // Try daemon-side rebase if the dep is available
    if (deps.daemonRebase) {
      const indexPath = join(ctx.worktreeDir, ".cross-repo-index");
      const wtInfo = getWorktreeInfo(item.id, indexPath, ctx.worktreeDir);
      const repoRoot = wtInfo?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot;
      const worktreePath = wtInfo?.worktreePath ?? join(repoRoot, ".worktrees", `todo-${item.id}`);
      try {
        const success = deps.daemonRebase(worktreePath, branch);
        if (success) {
          // Rebase succeeded — transition back to ci-pending so CI re-runs
          this.transition(item, "ci-pending");
          return { success: true };
        }
      } catch {
        // Fall through to worker rebase
      }
    }

    // Daemon rebase not available or failed — fall back to worker rebase message
    const message = action.message || "Please rebase onto latest main.";
    if (item.workspaceRef) {
      const sent = deps.sendMessage(item.workspaceRef, message);
      if (!sent) {
        return { success: false, error: `Daemon rebase failed and could not send worker message for ${item.id}` };
      }
      return { success: true };
    }

    // No daemon rebase and no worker — log warning
    deps.warn?.(
      `[Orchestrator] PR for ${item.id} (branch ${branch}) has merge conflicts but daemon rebase failed and worker has no workspace. Manual rebase needed.`,
    );
    return { success: false, error: `Daemon rebase failed and no worker available for ${item.id}` };
  }

  /** Clean up a failed worker's worktree and workspace to prepare for retry. */
  private executeRetry(
    item: OrchestratorItem,
    ctx: ExecutionContext,
    deps: OrchestratorDeps,
  ): ActionResult {
    // Read screen before closing — capture error output for diagnostics
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

    // Clean the old worktree to prepare for a fresh launch
    const indexPath = join(ctx.worktreeDir, ".cross-repo-index");
    const wtInfo = getWorktreeInfo(item.id, indexPath, ctx.worktreeDir);
    const repoRoot = wtInfo?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot;
    const worktreeDir = repoRoot !== ctx.projectRoot ? join(repoRoot, ".worktrees") : ctx.worktreeDir;
    deps.cleanSingleWorktree(item.id, worktreeDir, repoRoot);

    return { success: true };
  }

  /** Sync stack navigation comments on all PRs in the item's stack chain. */
  private executeSyncStackComments(
    item: OrchestratorItem,
    deps: OrchestratorDeps,
  ): ActionResult {
    if (!deps.syncStackComments) {
      return { success: true }; // no-op when not wired
    }

    const chain = this.buildStackChain(item.id);
    if (chain.length < 2) {
      return { success: true }; // single item — no stack to show
    }

    // Base branch: the root item's baseBranch (if still stacked) or "main"
    const rootItem = this.items.get(chain[0]!.id);
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
  private executeLaunchReview(
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
      const result = deps.launchReview(item.id, prNum, repoRoot);
      if (result) {
        item.reviewWorkspaceRef = result.workspaceRef;
      }
      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Review launch failed for ${item.id}: ${msg}` };
    }
  }

  /** Clean up a review worker session. */
  private executeCleanReview(
    item: OrchestratorItem,
    deps: OrchestratorDeps,
  ): ActionResult {
    if (!deps.cleanReview || !item.reviewWorkspaceRef) {
      item.reviewWorkspaceRef = undefined;
      return { success: true }; // no-op when not wired or no review workspace
    }

    try {
      deps.cleanReview(item.id, item.reviewWorkspaceRef);
      item.reviewWorkspaceRef = undefined;
      return { success: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      item.reviewWorkspaceRef = undefined;
      return { success: false, error: `Review cleanup failed for ${item.id}: ${msg}` };
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
        const aRank = PRIORITY_RANK[a.item.todo.priority as Priority] ?? 999;
        const bRank = PRIORITY_RANK[b.item.todo.priority as Priority] ?? 999;
        if (aRank !== bRank) return aRank - bRank;
        return a.item.id.localeCompare(b.item.id);
      });

    const keepId = sorted[0]!.action.itemId;

    // Revert deferred items back to ci-passed — they'll be merged next cycle
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

    const deps = item.todo.dependencies;
    if (deps.length === 0) return { canStack: false };

    let stackableDep: OrchestratorItem | undefined;

    for (const depId of deps) {
      const dep = this.items.get(depId);
      if (!dep) return { canStack: false }; // unknown dep — can't stack

      if (dep.state === "done" || dep.state === "merged") {
        continue; // this dep is finished
      }

      if (STACKABLE_STATES.has(dep.state)) {
        if (stackableDep) {
          // More than one in-flight dep in stackable state — can't stack
          return { canStack: false };
        }
        stackableDep = dep;
      } else {
        // Dep is in a non-stackable, non-done state (e.g., implementing, queued)
        return { canStack: false };
      }
    }

    if (!stackableDep) {
      // All deps are done/merged — this should be in readyIds, not stacked
      return { canStack: false };
    }

    return { canStack: true, baseBranch: `todo/${stackableDep.id}` };
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
      const depId = root.baseBranch.replace(/^todo\//, "");
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
      const parentBranch = `todo/${current.id}`;
      const child = this.getAllItems().find(
        (i) => i.baseBranch === parentBranch && !downVisited.has(i.id),
      );
      if (!child) break;
      downVisited.add(child.id);
      chain.push(child);
      current = child;
    }

    // Filter to active items with PRs (exclude merged/done — their PRs are closed)
    return chain
      .filter((i) => i.prNumber != null && i.state !== "done" && i.state !== "merged")
      .map((i) => ({ id: i.id, prNumber: i.prNumber!, title: i.todo.title }));
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
   * True when the TODO has bootstrap: true, has a cross-repo alias, and the repo isn't resolved yet.
   */
  private needsBootstrap(item: OrchestratorItem): boolean {
    if (!item.todo.bootstrap) return false;
    const alias = item.todo.repoAlias;
    if (!alias || alias === "self" || alias === "hub") return false;
    // If already resolved, no bootstrap needed
    if (item.resolvedRepoRoot) return false;
    return true;
  }
}
