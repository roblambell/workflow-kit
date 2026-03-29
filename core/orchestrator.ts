// Orchestrator state machine for parallel TODO processing.
// processTransitions is pure -- takes a snapshot and returns actions, no side effects.
// executeAction bridges the pure state machine to external dependencies via injected deps.

import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import type { WorkItem, Priority, WorktreeInfo } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import { getWorktreeInfo, listCrossRepoEntries } from "./cross-repo.ts";
import { heartbeatFilePath, writeHeartbeat } from "./daemon.ts";
import { NINTHWAVE_FOOTER, ORCHESTRATOR_LINK } from "./gh.ts";

// ── State types ──────────────────────────────────────────────────────

export type OrchestratorItemState =
  | "queued"
  | "ready"
  | "bootstrapping"
  | "launching"
  | "implementing"
  | "ci-pending"
  | "ci-passed"
  | "ci-failed"
  | "rebasing"
  | "review-pending"
  | "reviewing"
  | "merging"
  | "merged"
  | "forward-fix-pending"
  | "fix-forward-failed"
  | "fixing-forward"
  | "done"
  | "stuck";

export type MergeStrategy = "auto" | "manual" | "bypass";

// ── Interfaces ───────────────────────────────────────────────────────

export interface OrchestratorItem {
  id: string;
  workItem: WorkItem;
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
  /** Base branch for stacked launches (e.g., "ninthwave/H-1-1"). When set, the worker creates its branch from this instead of main. */
  baseBranch?: string;
  /** Absolute path to the repo where the PR lives. For hub-local items, equals projectRoot. For cross-repo items, points to the target repo. */
  resolvedRepoRoot?: string;
  /** cmux workspace reference for the review worker session. */
  reviewWorkspaceRef?: string;
  /** Absolute path to the verdict file written by the review worker. */
  reviewVerdictPath?: string;
  /** cmux workspace reference for the rebaser worker session (rebase-only). */
  rebaserWorkspaceRef?: string;
  /** Whether this item's review has been completed (approved). Resets on CI regression. */
  reviewCompleted?: boolean;
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
  /** Number of consecutive polls where isWorkerAlive returned false. Used to debounce stuck detection -- a single flaky listing shouldn't kill a healthy worker. */
  notAliveCount?: number;
  /** ISO timestamp of the last poll cycle where workerAlive was true. Used as timeout baseline -- timeouts measure from last-known-alive, not from state transition. */
  lastAliveAt?: string;
  /** Number of review rounds completed (incremented each time a review worker is launched). */
  reviewRound?: number;
  /** Number of consecutive merge failures for this item. Resets on successful merge. */
  mergeFailCount?: number;
  /** Whether a CI failure notification has already been sent for the current failure. Cleared on recovery (ci-pending/ci-passed) or when a new commit is pushed. */
  ciFailureNotified?: boolean;
  /** The lastCommitTime when ciFailureNotified was set. Used to reset the flag when the worker pushes a fix. */
  ciFailureNotifiedAt?: string | null;
  /** ISO timestamp of the last comment check for this item's PR. Used to avoid duplicate comment relay. */
  lastCommentCheck?: string;
  /** Number of consecutive rebaser worker launches for rebase conflict resolution. Resets when conflicts resolve (isMergeable !== false). */
  rebaseAttemptCount?: number;
  /** Set when a CI failure notification failed because no worker was running. Signals executeLaunch to force-launch a worker even when an existing PR is found. Cleared after launch. */
  needsCiFix?: boolean;
  /** Absolute path to the worktree directory. Preserved for stuck items so users can inspect partial work. */
  worktreePath?: string;
  /** SHA of the merge commit on main after PR is merged. Used to poll CI on main. */
  mergeCommitSha?: string;
  /** Number of times CI fix-forward on main has failed for this item. */
  fixForwardFailCount?: number;
  /** cmux workspace reference for the forward-fixer worker session. */
  fixForwardWorkspaceRef?: string;
}

export interface OrchestratorConfig {
  /** Max concurrent items in all WIP states (bootstrapping/launching/implementing/ci-pending/ci-passed/ci-failed/rebasing/reviewing/review-pending/merging). */
  wipLimit: number;
  /** When to auto-merge: auto (CI pass, respects review gate + CHANGES_REQUESTED), manual (never auto-merge), bypass (admin override, skips branch protection human review). */
  mergeStrategy: MergeStrategy;
  /** Whether the bypass merge strategy is available. Must be enabled via --dangerously-bypass CLI flag. */
  bypassEnabled: boolean;
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
  /** How the review worker handles requested fixes: off (report only), direct (push fixes), pr (open fix PR). Default: "off". */
  reviewAutoFix: "off" | "direct" | "pr";
  /** Max merge failures before marking stuck. Default: 3. */
  maxMergeRetries: number;
  /** Max consecutive rebaser worker launches before marking stuck. Default: 3. */
  maxRebaseAttempts: number;
  /** Max review rounds before marking stuck. Default: 3. */
  maxReviewRounds: number;
  /** Whether to check CI on main after merge and fix-forward if broken. Default: true. */
  fixForward: boolean;
  /** Max CI fix-forward failures on main before marking stuck. Default: 2. */
  maxFixForwardRetries: number;
  /** Optional callback invoked on every state transition. Receives item ID, previous state, new state, detected timestamp, and detection latency in ms. */
  onTransition?: (itemId: string, from: string, to: string, timestamp: string, latencyMs: number) => void;
  /** Optional callback for structured events that don't result in state transitions (e.g., timeout suppression). */
  onEvent?: (itemId: string, event: string, data?: Record<string, unknown>) => void;
}

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
/** ISO timestamp of the most recent commit on the worktree branch, or null if none beyond base. */
  lastCommitTime?: string | null;
  /** Timestamp from the external system for the current state (ISO string).
   *  e.g., GitHub's completedAt for CI checks, mergedAt for merges, updatedAt for PR changes. */
  eventTime?: string;
  /** New trusted PR comments since last check. */
  newComments?: Array<{ body: string; author: string; createdAt: string }>;
  /** Worker heartbeat data read from the heartbeat file. Null if no heartbeat file exists. */
  lastHeartbeat?: import("./daemon.ts").WorkerProgress | null;
  /** CI status of the merge commit on main (for post-merge verification). */
  mergeCommitCIStatus?: "pass" | "fail" | "pending";
  /** Structured verdict from the review worker (read from verdict file). */
  reviewVerdict?: import("./daemon.ts").ReviewVerdict;
}

export interface PollSnapshot {
  items: ItemSnapshot[];
  /** IDs of items whose dependencies are all in 'done' state. */
  readyIds: string[];
  /** Count of items where GitHub API returned errors (hold-state applied). */
  apiErrorCount?: number;
}

// ── Actions ──────────────────────────────────────────────────────────

export type ActionType =
  | "bootstrap"
  | "launch"
  | "merge"
  | "notify-ci-failure"
  | "notify-review"
  | "clean"
  | "workspace-close"
  | "rebase"
  | "daemon-rebase"
  | "launch-rebaser"
  | "clean-rebaser"
  | "retry"
  | "sync-stack-comments"
  | "launch-review"
  | "clean-review"
  | "launch-forward-fixer"
  | "clean-forward-fixer"
  | "send-message"
  | "set-commit-status"
  | "post-review";

export interface Action {
  type: ActionType;
  itemId: string;
  /** For merge actions, the PR number. */
  prNumber?: number;
  /** For notify actions, the message to send. */
  message?: string;
  /** For launch actions, the base branch to stack on (e.g., "ninthwave/H-1-1"). */
  baseBranch?: string;
  /** For set-commit-status actions, the status state. */
  statusState?: "pending" | "success" | "failure";
  /** For set-commit-status actions, the description text. */
  statusDescription?: string;
  /** For post-review actions, the verdict data to format and post as a PR comment. */
  verdict?: import("./daemon.ts").ReviewVerdict;
  /** For merge actions, whether to use admin override (gh pr merge --admin). */
  admin?: boolean;
}

// ── Execution context and dependencies ──────────────────────────────

/** Configuration for executing actions against external systems. */
export interface ExecutionContext {
  projectRoot: string;
  worktreeDir: string;
  workDir: string;
  aiTool: string;
  /** GitHub name-with-owner (e.g. "org/repo") for constructing absolute URLs in PR comments. */
  hubRepoNwo?: string;
}

/** External dependencies injected into executeAction. */
export interface OrchestratorDeps {
  launchSingleItem: (
    item: WorkItem,
    workDir: string,
    worktreeDir: string,
    projectRoot: string,
    aiTool: string,
    baseBranch?: string,
    forceWorkerLaunch?: boolean,
  ) => { worktreePath: string; workspaceRef: string; existingPrNumber?: number } | null;
  cleanSingleWorktree: (
    id: string,
    worktreeDir: string,
    projectRoot: string,
  ) => boolean;
  prMerge: (repoRoot: string, prNumber: number, options?: { admin?: boolean }) => boolean;
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
   * Clean up stale branches when a TODO ID is reused with different work.
   * Called before launching a worker. Checks for merged PRs with title mismatches
   * and deletes both local and remote branches so the worker starts fresh.
   * Non-fatal -- launch proceeds even if cleanup fails.
   */
  cleanStaleBranch?: (todo: WorkItem, projectRoot: string) => void;
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
  launchReview?: (itemId: string, prNumber: number, repoRoot: string, implementerWorktreePath?: string) => { workspaceRef: string; verdictPath: string } | null;
  /**
   * Clean up a review worker session and workspace.
   * Actual logic lives in H-RVW-3; stub for now.
   */
  cleanReview?: (itemId: string, reviewWorkspaceRef: string) => boolean;
  /**
   * Upsert a living orchestrator status comment on a PR.
   * Appends an event row to a single persistent comment identified by a marker.
   * When not provided, falls back to deps.prComment for backward compatibility.
   */
  upsertOrchestratorComment?: (
    repoRoot: string,
    prNumber: number,
    itemId: string,
    eventLine: string,
  ) => boolean;
  /**
   * Launch a rebaser worker for rebase-only conflict resolution.
   * Called when daemon-rebase fails (conflicts). The rebaser worker gets
   * a focused prompt to resolve conflicts and push, not re-implement.
   * Returns a workspace reference on success.
   */
  launchRebaser?: (itemId: string, prNumber: number, repoRoot: string) => { workspaceRef: string } | null;
  /**
   * Clean up a rebaser worker session and workspace.
   */
  cleanRebaser?: (itemId: string, rebaserWorkspaceRef: string) => boolean;
  /**
   * Set a commit status on a PR's head SHA.
   * Used to post review results as GitHub commit statuses for branch protection integration.
   */
  setCommitStatus?: (
    repoRoot: string,
    prNumber: number,
    state: "pending" | "success" | "failure",
    context: string,
    description: string,
  ) => boolean;
  /**
   * Get the merge commit SHA for a merged PR.
   * Returns the SHA string, or null if it can't be determined.
   */
  getMergeCommitSha?: (repoRoot: string, prNumber: number) => string | null;
  /**
   * Check CI status on a specific commit (e.g., merge commit on main).
   * Returns "pass", "fail", or "pending".
   */
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending";
  /**
   * Launch a forward-fixer worker for post-merge CI failure diagnosis and fix-forward.
   * Creates a worktree from main and launches the forward-fixer agent.
   * Returns a workspace reference and worktree path on success.
   */
  launchForwardFixer?: (itemId: string, mergeCommitSha: string, repoRoot: string) => { worktreePath: string; workspaceRef: string } | null;
  /**
   * Clean up a forward-fixer worker session and worktree.
   */
  cleanForwardFixer?: (itemId: string, fixForwardWorkspaceRef: string) => boolean;
  /**
   * Resolve a git ref (branch name, tag, SHA prefix) to its full commit SHA.
   * Used to pin branch SHAs before merge so restacking survives branch deletion.
   */
  resolveRef?: (repoRoot: string, ref: string) => string | null;
}

/** Result of executing a single action. */
export interface ActionResult {
  success: boolean;
  error?: string;
}

// ── Default config ───────────────────────────────────────────────────

export const DEFAULT_CONFIG: OrchestratorConfig = {
  wipLimit: 4,
  mergeStrategy: "auto",
  bypassEnabled: false,
  maxCiRetries: 2,
  maxRetries: 1,
  launchTimeoutMs: 30 * 60 * 1000,   // 30 minutes
  activityTimeoutMs: 60 * 60 * 1000, // 60 minutes
  enableStacking: true,
  reviewAutoFix: "off",
  maxMergeRetries: 3,
  maxRebaseAttempts: 3,
  maxReviewRounds: 3,
  fixForward: true,
  maxFixForwardRetries: 2,
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

/** Heartbeat recency threshold: a heartbeat within this window means the worker is healthy. */
export const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Number of consecutive workerAlive=false polls required before declaring a worker dead. */
export const NOT_ALIVE_THRESHOLD = 5;

/** Timeout (ms) for items in launching state with no workerAlive signal. Default: 5 minutes. */
export const LAUNCHING_TIMEOUT_MS = 5 * 60 * 1000;

// ── WIP states: states that count toward the WIP limit ───────────────

const WIP_STATES: Set<OrchestratorItemState> = new Set([
  "bootstrapping",
  "launching",
  "implementing",
  "ci-pending",
  "ci-passed",
  "ci-failed",
  "rebasing",
  "reviewing",
  "review-pending",
  "merging",
]);

// ── Stackable states: dep states that allow a dependent item to launch stacked ──

export const STACKABLE_STATES: Set<OrchestratorItemState> = new Set([
  "ci-passed",
  "reviewing",
  "review-pending",
  "merging",
]);

// ── Status display mapping ──────────────────────────────────────────

/** Cmux status pill properties for a given orchestrator state. */
export interface StatusDisplay {
  text: string;
  icon: string;
  color: string;
}

/**
 * Map an orchestrator item state to cmux status pill properties (text, icon, color).
 * Matches the status table rendering in core/status-render.ts.
 *
 * When flags.rebaseRequested is true and state is ci-pending or ci-failed,
 * returns a "Rebasing" display instead of the normal state display.
 */
export function statusDisplayForState(state: OrchestratorItemState, flags?: { rebaseRequested?: boolean; reviewRound?: number }): StatusDisplay {
  // Composite display state: rebase is a transient operation overlaid on ci-pending/ci-failed
  if (flags?.rebaseRequested && (state === "ci-pending" || state === "ci-failed")) {
    return { text: "Rebasing", icon: "arrow.triangle.branch", color: "#f59e0b" };
  }
  switch (state) {
    case "implementing":
    case "launching":
      return { text: "Implementing", icon: "hammer.fill", color: "#b45309" };
    case "ci-pending":
      return { text: "CI Pending", icon: "clock.fill", color: "#06b6d4" };
    case "ci-failed":
      return { text: "CI Failed", icon: "xmark.circle", color: "#ef4444" };
    case "ci-passed":
      return { text: "CI Passed", icon: "checkmark.circle", color: "#22c55e" };
    case "reviewing": {
      const round = flags?.reviewRound ?? 0;
      const text = round > 1 ? `Reviewing (round ${round})` : "Reviewing";
      return { text, icon: "eye.fill", color: "#7c3aed" };
    }
    case "review-pending":
      return { text: "In Review", icon: "eye.fill", color: "#7c3aed" };
    case "merging":
      return { text: "Merging", icon: "arrow.triangle.merge", color: "#22c55e" };
    case "forward-fix-pending":
      return { text: "Fix Pending", icon: "clock.fill", color: "#06b6d4" };
    case "fix-forward-failed":
      return { text: "Fix Failed", icon: "xmark.circle", color: "#ef4444" };
    case "fixing-forward":
      return { text: "Fixing Forward", icon: "wrench.fill", color: "#f59e0b" };
    case "done":
    case "merged":
      return { text: "Done", icon: "checkmark.seal.fill", color: "#22c55e" };
    case "stuck":
      return { text: "Stuck", icon: "exclamationmark.triangle", color: "#ef4444" };
    default:
      return { text: "Working", icon: "hammer.fill", color: "#b45309" };
  }
}

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

  /**
   * Change the merge strategy at runtime.
   * "bypass" is only allowed when config.bypassEnabled is true (set via --dangerously-bypass).
   * Forward-only: existing items keep their current state; only subsequent evaluateMerge calls
   * are affected by the new strategy.
   */
  setMergeStrategy(strategy: MergeStrategy): void {
    if (strategy === "bypass" && !this.config.bypassEnabled) {
      throw new Error('Cannot set merge strategy to "bypass" without --dangerously-bypass flag');
    }
    (this.config as { mergeStrategy: MergeStrategy }).mergeStrategy = strategy;
  }

  /** Add a TODO item to orchestration. Starts in 'queued' state. */
  addItem(todo: WorkItem, partition?: number): void {
    this.items.set(todo.id, {
      id: todo.id,
      workItem: todo,
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
            actions = this.stuckOrRetry(item, "launch-timeout: worker never registered within timeout");
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
        if (this.config.fixForward && item.mergeCommitSha) {
          this.transition(item, "forward-fix-pending");
        } else {
          this.transition(item, "done");
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
        return this.stuckOrRetry(item, "worker-stalled: no commits after launch timeout");
      }
    } else {
      // Has commits -- check against activity timeout (same for alive or dead)
      const sinceCommit = nowMs - new Date(commitTime).getTime();
      if (sinceCommit > this.config.activityTimeoutMs) {
        return this.stuckOrRetry(item, "worker-stalled: no new commits after activity timeout");
      }
    }

    return [];
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
          statusDescription: `Review passed: ${v.blockerCount} blockers, ${v.nitCount} nits`,
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
          statusDescription: `Changes requested: ${v.blockerCount} blockers found`,
        });
        const round = item.reviewRound ?? 1;
        actions.push({
          type: "notify-review",
          itemId: item.id,
          message: `[ORCHESTRATOR] Review Feedback (round ${round}): ${v.blockerCount} blockers, ${v.nitCount} nits.\n\n${v.summary}`,
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
      case "workspace-close":
        return this.executeWorkspaceClose(item, deps);
      case "rebase":
        return this.executeRebase(item, action, deps);
      case "daemon-rebase":
        return this.executeDaemonRebase(item, action, ctx, deps);
      case "retry":
        return this.executeRetry(item, ctx, deps);
      case "sync-stack-comments":
        return this.executeSyncStackComments(item, deps);
      case "launch-rebaser":
        return this.executeLaunchRebaser(item, ctx, deps);
      case "clean-rebaser":
        return this.executeCleanRebaser(item, deps);
      case "launch-review":
        return this.executeLaunchReview(item, action, ctx, deps);
      case "clean-review":
        return this.executeCleanReview(item, deps);
      case "launch-forward-fixer":
        return this.executeLaunchForwardFixer(item, ctx, deps);
      case "clean-forward-fixer":
        return this.executeCleanForwardFixer(item, deps);
      case "send-message":
        return this.executeSendMessage(item, action, deps);
      case "set-commit-status":
        return this.executeSetCommitStatus(item, action, ctx, deps);
      case "post-review":
        return this.executePostReview(item, action, ctx, deps);
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

    const alias = item.workItem.repoAlias;
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
    // but is harmless -- resolvedRepoRoot remains unset and launch will resolve normally.

    // Transition to launching -- the next processTransitions cycle will not
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
      const dep = this.items.get(depId);
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

    try {
      const result = deps.launchSingleItem(
        item.workItem,
        ctx.workDir,
        ctx.worktreeDir,
        ctx.projectRoot,
        ctx.aiTool,
        action.baseBranch,
        forceWorker,
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

      // Existing PR detected -- skip worker launch, transition to ci-pending.
      // The daemon will handle rebase and CI tracking from here.
      if (result.existingPrNumber) {
        item.prNumber = result.existingPrNumber;
        this.transition(item, "ci-pending");
        return { success: true };
      }

      item.workspaceRef = result.workspaceRef;
      item.worktreePath = result.worktreePath;
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
          const worktreePath = wtInfo?.worktreePath ?? join(wtRepoRoot, ".worktrees", `ninthwave-${item.id}`);
          const branch = `ninthwave/${item.id}`;
          try {
            const rebaseSuccess = deps.daemonRebase(worktreePath, branch);
            if (rebaseSuccess) {
              this.transition(item, "ci-pending");
              return { success: false, error: `Merge failed for PR #${prNum} due to conflicts, rebased and waiting for CI` };
            }
          } catch {
            // Daemon rebase failed -- fall through to worker rebase
          }
        }
        // Daemon rebase unavailable or failed -- send worker a rebase message
        if (item.workspaceRef) {
          deps.sendMessage(
            item.workspaceRef,
            `[ORCHESTRATOR] Rebase Required: merge failed due to conflicts with main. Please rebase onto latest main and push.`,
          );
        }
        this.transition(item, "ci-pending");
        return { success: false, error: `Merge failed for PR #${prNum} due to conflicts, rebase requested` };
      }

      // Non-conflict merge failure -- normal retry behavior
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

    // Transition to merged immediately after successful merge.
    // This ensures the item reflects reality even if subsequent steps
    // (getMergeCommitSha, audit trail) throw.
    this.transition(item, "merged");

    // Capture merge commit SHA for post-merge CI verification
    if (this.config.fixForward && deps.getMergeCommitSha) {
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

    for (const other of this.getAllItems()) {
      if (other.id === item.id) continue;
      if (!other.workItem.dependencies.includes(item.id)) continue;
      if (!WIP_STATES.has(other.state)) continue;
      if (!other.baseBranch) continue; // not stacked -- handled below

      restackedIds.add(other.id);

      const otherWtInfo = getWorktreeInfo(other.id, crossRepoIndex, ctx.worktreeDir, cachedEntries);
      const otherRepoRoot = otherWtInfo?.repoRoot ?? other.resolvedRepoRoot ?? ctx.projectRoot;
      const otherWorktreePath = otherWtInfo?.worktreePath ?? join(otherRepoRoot, ".worktrees", `ninthwave-${other.id}`);
      const otherBranch = `ninthwave/${other.id}`;

      if (!deps.rebaseOnto || !deps.forcePush) {
        // rebaseOnto or forcePush not available -- send worker manual rebase instructions
        if (other.workspaceRef) {
          deps.sendMessage(
            other.workspaceRef,
            `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto main ${depBranch} ${otherBranch} && git push --force-with-lease`,
          );
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
            deps.sendMessage(
              other.workspaceRef,
              `[ORCHESTRATOR] Restack Conflict: dependency ${item.id} was squash-merged but rebase --onto had conflicts. Run manually: git rebase --onto main ${depBranch} ${otherBranch}`,
            );
          }
        }
      } catch {
        // Unexpected error -- fall back to worker message
        if (other.workspaceRef) {
          deps.sendMessage(
            other.workspaceRef,
            `[ORCHESTRATOR] Restack Required: dependency ${item.id} was squash-merged. Run: git rebase --onto main ${depBranch} ${otherBranch} && git push --force-with-lease`,
          );
        }
      }
    }

    // Send rebase requests to non-stacked dependent items in WIP states.
    // Stacked items were handled above via rebaseOnto -- skip them.
    for (const other of this.getAllItems()) {
      if (other.id === item.id) continue;
      if (!other.workItem.dependencies.includes(item.id)) continue;
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
    // Skip restacked items -- they were already rebased with --onto above.
    // Skip items in different repos -- their main didn't change from this merge.
    for (const other of this.getAllItems()) {
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
      const otherWorktreePath = otherWtInfo2?.worktreePath ?? join(otherRepoRoot2, ".worktrees", `ninthwave-${other.id}`);

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
        // Not conflicting -- skip, no action needed
      }
    }

    // Update stack navigation comments on remaining stacked PRs.
    // After restacking, the merged item is gone and the chain has changed.
    if (deps.syncStackComments && successfulRestacks.size > 0) {
      const synced = new Set<string>();
      for (const id of successfulRestacks) {
        const chain = this.buildStackChain(id);
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
  private executeNotifyCiFailure(
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
      this.transition(item, "ready");
      return { success: true };
    }

    const sent = deps.sendMessage(item.workspaceRef, message);
    if (!sent) {
      return { success: false, error: `Failed to send CI failure message to ${item.id}` };
    }

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
  private executeNotifyReview(
    item: OrchestratorItem,
    action: Action,
    deps: OrchestratorDeps,
  ): ActionResult {
    const message = action.message || "Review feedback received -- please address.";

    if (!item.workspaceRef) {
      return { success: false, error: `No workspace reference for ${item.id} -- cannot notify worker of review feedback` };
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
    const worktreeDir = repoRoot !== ctx.projectRoot ? join(repoRoot, ".worktrees") : ctx.worktreeDir;
    const worktreeCleaned = deps.cleanSingleWorktree(item.id, worktreeDir, repoRoot);

    // Clean up heartbeat file (best-effort)
    try {
      const hbPath = heartbeatFilePath(ctx.projectRoot, item.id);
      if (existsSync(hbPath)) {
        unlinkSync(hbPath);
      }
    } catch { /* best-effort -- heartbeat cleanup failure doesn't block clean */ }

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
  private executeWorkspaceClose(
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
  private executeSendMessage(
    item: OrchestratorItem,
    action: Action,
    deps: OrchestratorDeps,
  ): ActionResult {
    const message = action.message || "Are you still making progress?";

    if (!item.workspaceRef) {
      return { success: false, error: `No workspace reference for ${item.id} -- cannot send message` };
    }

    const sent = deps.sendMessage(item.workspaceRef, message);
    if (!sent) {
      return { success: false, error: `Failed to send message to ${item.id}` };
    }

    return { success: true };
  }

  /** Set a commit status on the PR's head SHA. */
  private executeSetCommitStatus(
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
    const branch = `ninthwave/${item.id}`;

    // Try daemon-side rebase if the dep is available
    if (deps.daemonRebase) {
      const indexPath = join(ctx.worktreeDir, ".cross-repo-index");
      const wtInfo = getWorktreeInfo(item.id, indexPath, ctx.worktreeDir);
      const repoRoot = wtInfo?.repoRoot ?? item.resolvedRepoRoot ?? ctx.projectRoot;
      const worktreePath = wtInfo?.worktreePath ?? join(repoRoot, ".worktrees", `ninthwave-${item.id}`);
      try {
        const success = deps.daemonRebase(worktreePath, branch);
        if (success) {
          // Rebase succeeded -- transition back to ci-pending so CI re-runs
          this.transition(item, "ci-pending");
          return { success: true };
        }
      } catch {
        // Fall through to worker rebase
      }
    }

    // Daemon rebase failed -- prefer sending message to live worker over launching rebaser.
    // The original worker knows the code best and can resolve conflicts properly.
    const message = action.message || "Please rebase onto latest main.";
    if (item.workspaceRef) {
      const sent = deps.sendMessage(item.workspaceRef, message);
      if (sent) {
        return { success: true };
      }
      // sendMessage failed -- worker may be unresponsive, fall through to rebaser
    }

    // Circuit breaker: stop launching rebasers after maxRebaseAttempts
    const attemptCount = item.rebaseAttemptCount ?? 0;
    if (attemptCount >= this.config.maxRebaseAttempts) {
      this.transition(item, "stuck");
      item.failureReason = `rebase-loop: exceeded max rebase attempts (${this.config.maxRebaseAttempts}) -- rebase conflicts could not be resolved`;
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
        const result = deps.launchRebaser(item.id, item.prNumber, repoRoot);
        if (result) {
          item.rebaserWorkspaceRef = result.workspaceRef;
          item.rebaseAttemptCount = attemptCount + 1;
          this.transition(item, "rebasing");
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
  private executeRetry(
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
  private executeSyncStackComments(
    item: OrchestratorItem,
    deps: OrchestratorDeps,
  ): ActionResult {
    if (!deps.syncStackComments) {
      return { success: true }; // no-op when not wired
    }

    const chain = this.buildStackChain(item.id);
    if (chain.length < 2) {
      return { success: true }; // single item -- no stack to show
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
  /** Launch a rebaser worker for rebase-only conflict resolution. */
  private executeLaunchRebaser(
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
      const result = deps.launchRebaser(item.id, prNum, repoRoot);
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
  private cleanWorkerWorkspace(
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
  private executeCleanRebaser(
    item: OrchestratorItem,
    deps: OrchestratorDeps,
  ): ActionResult {
    return this.cleanWorkerWorkspace(
      "Rebaser", item.id, item.rebaserWorkspaceRef, deps.cleanRebaser,
      () => { item.rebaserWorkspaceRef = undefined; },
    );
  }

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
      const result = deps.launchReview(item.id, prNum, repoRoot, item.worktreePath);
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
  private executeCleanReview(
    item: OrchestratorItem,
    deps: OrchestratorDeps,
  ): ActionResult {
    // Clean up verdict file (review-specific, before shared workspace cleanup)
    if (item.reviewVerdictPath) {
      try { unlinkSync(item.reviewVerdictPath); } catch { /* best-effort */ }
      item.reviewVerdictPath = undefined;
    }

    return this.cleanWorkerWorkspace(
      "Review", item.id, item.reviewWorkspaceRef, deps.cleanReview,
      () => { item.reviewWorkspaceRef = undefined; },
    );
  }

  /** Post a formatted review comment on the PR from a reviewer verdict. */
  private executePostReview(
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
  private executeLaunchForwardFixer(
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
      const result = deps.launchForwardFixer(item.id, item.mergeCommitSha, repoRoot);
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
  private executeCleanForwardFixer(
    item: OrchestratorItem,
    deps: OrchestratorDeps,
  ): ActionResult {
    return this.cleanWorkerWorkspace(
      "Forward-Fixer", item.id, item.fixForwardWorkspaceRef, deps.cleanForwardFixer,
      () => { item.fixForwardWorkspaceRef = undefined; },
    );
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

      if (dep.state === "done" || dep.state === "merged" || dep.state === "forward-fix-pending" || dep.state === "fix-forward-failed") {
        continue; // this dep is finished (code is on main)
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
   * True when the TODO has bootstrap: true, has a cross-repo alias, and the repo isn't resolved yet.
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
