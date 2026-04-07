// Type definitions, interfaces, and constants for the orchestrator state machine.
// Self-contained: no imports from orchestrator.ts or orchestrator-actions.ts.

import type { WorkItem, Priority } from "./types.ts";
import type { PickupCandidateValidation } from "./commands/launch.ts";

/** Recursive partial -- makes all nested interface fields optional. Used by test mock factories. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ── State types ──────────────────────────────────────────────────────

export type OrchestratorItemState =
  | "queued"
  | "ready"
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
  | "blocked"
  | "stuck";

export type MergeStrategy = "auto" | "manual" | "bypass";

// ── Interfaces ───────────────────────────────────────────────────────

export interface OrchestratorItem {
  id: string;
  workItem: WorkItem;
  state: OrchestratorItemState;
  /** Active PR currently driving this item's lifecycle. Can switch to a repair PR after post-merge CI failure. */
  prNumber?: number;
  /** Prior active PR numbers for this item, oldest first. Preserved when repair PRs replace the canonical PR. */
  priorPrNumbers?: number[];
  partition?: number;
  /** Multiplexer workspace reference (e.g., "workspace:1" or "session:nw:H-1-1"). */
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
  /** Multiplexer workspace reference for the review worker session. */
  reviewWorkspaceRef?: string;
  /** Absolute path to the verdict file written by the review worker. */
  reviewVerdictPath?: string;
  /** Multiplexer workspace reference for the rebaser worker session (rebase-only). */
  rebaserWorkspaceRef?: string;
  /** Whether this item's review has been completed (approved). Resets on CI regression. */
  reviewCompleted?: boolean;
/** Descriptive reason for why this item failed (e.g., "launch-failed: repo not found", "ci-failed: test timeout"). Set on ci-failed/stuck states, cleared on recovery. */
  failureReason?: string;
  /** ISO timestamp of when the worker was launched (set on transition to implementing). */
  startedAt?: string;
  /** ISO timestamp of when the worker completed for the current run (set on transition to done, blocked, or stuck). */
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
  /** ISO wall-clock timestamp when CI failure notification was delivered. Used for ack-based timeout detection. */
  ciNotifyWallAt?: string;
  /** ISO timestamp of the last comment check for this item's PR. Used to avoid duplicate comment relay. */
  lastCommentCheck?: string;
  /** Number of consecutive rebaser worker launches for rebase conflict resolution. Resets when conflicts resolve (isMergeable !== false). */
  rebaseAttemptCount?: number;
  /** ISO timestamp of the last orchestrator-issued rebase nudge to the worker. */
  lastRebaseNudgeAt?: string;
  /** Number of rebase nudges sent for the current conflict episode. */
  rebaseNudgeCount?: number;
  /** Set when a CI failure notification failed because no worker was running. Signals executeLaunch to force-launch a worker even when an existing PR is found. Cleared after launch. */
  needsCiFix?: boolean;
  /** Absolute path to the worktree directory. Preserved for stuck items so users can inspect partial work. */
  worktreePath?: string;
  /** SHA of the merge commit on the repo default branch after PR is merged. */
  mergeCommitSha?: string;
  /** Repository default branch where the PR merged (usually "main"). */
  defaultBranch?: string;
  /** Number of times CI fix-forward on main has failed for this item. */
  fixForwardFailCount?: number;
  /** Multiplexer workspace reference for the forward-fixer worker session. */
  fixForwardWorkspaceRef?: string;
  /** AI tool used for this item's implementation worker. Review/rebaser/forward-fixer inherit this. */
  aiTool?: string;
  /** LLM model parsed from agents/implementer.md frontmatter for telemetry. */
  implementerModel?: string;
  /** LLM model parsed from agents/reviewer.md frontmatter for telemetry. */
  reviewerModel?: string;
  /** LLM model parsed from agents/rebaser.md frontmatter for telemetry. */
  rebaserModel?: string;
  /** LLM model parsed from agents/forward-fixer.md frontmatter for telemetry. */
  forwardFixerModel?: string;
  /** Whether this item's worker session is parked (suspended but preservable). Consumers added in H-SP-2. */
  sessionParked?: boolean;
  /** ISO timestamp after which timeout kill proceeds. Set on first timeout detection, cleared on state transitions. */
  timeoutDeadline?: string;
  /** Number of user-initiated timeout extensions via extendTimeout(). */
  timeoutExtensionCount?: number;
  /** ISO timestamp when the item entered ci-pending via transition(). Used for stale-CI grace period. Not set by hydrateState. */
  ciPendingSince?: string;
}

// ── State-specific data interfaces ───────────────────────────────────
// Typed lenses over the flat OrchestratorItem for the highest-bug-density
// states. Handlers opt-in via getStateData(item, "ci-failed") to get
// compile-time guarantees on field types.

export interface ImplementingStateData {
  workspaceRef: string;
  worktreePath: string;
  startedAt: string;
  lastAliveAt?: string;
  notAliveCount: number;
}

export interface CiPendingStateData {
  ciPendingSince?: string;
  workspaceRef?: string;
  worktreePath?: string;
}

export interface CiFailedStateData {
  ciFailureNotified: boolean;
  ciFailureNotifiedAt: string | null;
  ciNotifyWallAt?: string;
  failureReason: string;
  needsCiFix?: boolean;
}

export interface RebasingStateData {
  rebaserWorkspaceRef?: string;
  rebaseAttemptCount: number;
  rebaseRequested: boolean;
}

export interface StateDataMap {
  "implementing": ImplementingStateData;
  "ci-pending": CiPendingStateData;
  "ci-failed": CiFailedStateData;
  "rebasing": RebasingStateData;
}

/**
 * Typed accessor that projects state-specific fields from a flat OrchestratorItem.
 * Returns undefined when `item.state !== state` (runtime guard).
 * Non-optional fields are coerced to safe defaults (0, false, "") when the
 * underlying OrchestratorItem field is undefined.
 */
export function getStateData<S extends keyof StateDataMap>(
  item: OrchestratorItem,
  state: S,
): StateDataMap[S] | undefined {
  if (item.state !== state) return undefined;
  const s = state as keyof StateDataMap;
  switch (s) {
    case "implementing":
      return {
        workspaceRef: item.workspaceRef!,
        worktreePath: item.worktreePath!,
        startedAt: item.startedAt!,
        lastAliveAt: item.lastAliveAt,
        notAliveCount: item.notAliveCount ?? 0,
      } as StateDataMap[S];
    case "ci-pending":
      return {
        ciPendingSince: item.ciPendingSince,
        workspaceRef: item.workspaceRef,
        worktreePath: item.worktreePath,
      } as StateDataMap[S];
    case "ci-failed":
      return {
        ciFailureNotified: item.ciFailureNotified ?? false,
        ciFailureNotifiedAt: item.ciFailureNotifiedAt ?? null,
        ciNotifyWallAt: item.ciNotifyWallAt,
        failureReason: item.failureReason ?? "",
        needsCiFix: item.needsCiFix,
      } as StateDataMap[S];
    case "rebasing":
      return {
        rebaserWorkspaceRef: item.rebaserWorkspaceRef,
        rebaseAttemptCount: item.rebaseAttemptCount ?? 0,
        rebaseRequested: item.rebaseRequested ?? false,
      } as StateDataMap[S];
    default:
      return undefined;
  }
}

export interface OrchestratorConfig {
  /** Max concurrent items in all WIP states (launching/implementing/ci-pending/ci-passed/ci-failed/rebasing/reviewing/review-pending/merging). */
  sessionLimit: number;
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
  /** How long merge conflicts can stay unchanged before the orchestrator retries or escalates rebase handling. See `TIMEOUTS` for related constants. Default: 15 minutes. */
  rebaseRetryStaleMs: number;
  /** Max review rounds before marking stuck. Default: 3. */
  maxReviewRounds: number;
  /** Whether to check CI on main after merge and fix-forward if broken. Default: true. */
  fixForward: boolean;
  /** Max CI fix-forward failures on main before marking stuck. Default: 2. */
  maxFixForwardRetries: number;
  /** Grace period (ms) after entering ci-pending from implementing/launching before trusting a CI "fail".
   *  Prevents stale CI from a previous commit from killing workers. See `TIMEOUTS.ciFixAck` for the related ack timeout. Default: 60000 (60s). */
  ciPendingFailGraceMs: number;
  /** When true, the AI review gate is bypassed -- ci-passed chains straight to merge evaluation. Default: false. */
  skipReview: boolean;
  /** Grace period (ms) before timeout kills proceed. On first timeout detection, a deadline is set this far in the future. 0 = immediate kill (no grace period). See `TIMEOUTS.heartbeat` and `TIMEOUTS.launching` for the detection thresholds. Default: 5 minutes. */
  gracePeriodMs: number;
  /** Max number of times extendTimeout() can push the deadline forward. Default: 3. */
  maxTimeoutExtensions: number;
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
  /** Prior active PR numbers for this item, oldest first. */
  priorPrNumbers?: number[];
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
  /** Best-effort merge commit SHA for merged PRs, backfilled by polling. */
  mergeCommitSha?: string;
  /** Repository default branch for merged PRs, backfilled by polling. */
  defaultBranch?: string;
  /** CI status of the merge commit on main (for post-merge verification). */
  mergeCommitCIStatus?: "pass" | "fail" | "pending";
  /** Whether the item's repo has push-triggered GitHub Actions workflows. */
  hasPushWorkflows?: boolean;
  /** Structured verdict from the review worker (read from verdict file). */
  reviewVerdict?: import("./daemon.ts").ReviewVerdict;
  /** Inbox metadata snapshot for daemon state serialization. */
  inboxSnapshot?: import("./commands/inbox.ts").InboxSnapshot;
}

export interface PollSnapshot {
  items: ItemSnapshot[];
  /** IDs of items whose dependencies are all in 'done' state. */
  readyIds: string[];
  /** Count of items where GitHub API returned errors (hold-state applied). */
  apiErrorCount?: number;
  /** Compact summary of PR polling failures shown in logs/TUI. */
  apiErrorSummary?: {
    total: number;
    byKind: Partial<Record<GhFailureKind, number>>;
    primaryKind: GhFailureKind;
    /** First raw stderr from the primary error kind (for diagnostics). */
    representativeError?: string;
  };
  /** Human-readable rate-limit backoff description for TUI display (e.g., "Rate limited -- resuming in 2m 15s"). */
  rateLimitBackoffDescription?: string;
}

// ── Actions ──────────────────────────────────────────────────────────

export type ActionType =
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
  /** When true, skip the normal worker-nudge fallback and escalate directly to the rebaser path. */
  escalateToRebaser?: boolean;
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
  /** Full pool of AI tools for round-robin assignment. Falls back to [aiTool] when not set. */
  aiTools?: string[];
  /** Mutable round-robin counter. Incremented on each launch. */
  nextToolIndex?: number;
  /** GitHub name-with-owner (e.g. "org/repo") for constructing absolute URLs in PR comments. */
  hubRepoNwo?: string;
}

/**
 * Get the next AI tool from the round-robin pool.
 * When only one tool is configured, always returns that tool.
 */
export function getNextTool(ctx: ExecutionContext): string {
  const tools = ctx.aiTools ?? [ctx.aiTool];
  if (tools.length <= 1) return tools[0] ?? ctx.aiTool;
  const idx = ctx.nextToolIndex ?? 0;
  const tool = tools[idx % tools.length]!;
  ctx.nextToolIndex = idx + 1;
  return tool;
}

// ── Functional sub-interfaces for OrchestratorDeps ──────────────────
// Grouped by concern so action functions declare only the capabilities they use.

/** Git operations (fetch, merge, rebase, push). */
export interface GitDeps {
  fetchOrigin: (repoRoot: string, branch: string) => void;
  ffMerge: (repoRoot: string, branch: string) => void;
  /**
   * Resolve a git ref (branch name, tag, SHA prefix) to its full commit SHA.
   * Used to pin branch SHAs before merge so restacking survives branch deletion.
   */
  resolveRef?: (repoRoot: string, ref: string) => string | null;
  /**
   * Squash-merge-safe rebase using `git rebase --onto`.
   * Replays only the commits from `oldBase..branch` onto `newBase`.
   * Returns true on success, false on conflict (with clean abort).
   */
  rebaseOnto?: (worktreePath: string, newBase: string, oldBase: string, branch: string) => boolean;
  /** Force-push the current branch in a worktree. Returns true on success. */
  forcePush?: (worktreePath: string) => boolean;
  /**
   * Daemon-side rebase: fetch origin/main, rebase the branch, and force-push.
   * The worktreePath is the path to the worktree where the branch is checked out.
   * Returns true on success, false on failure (caller should fall back to worker rebase).
   */
  daemonRebase?: (worktreePath: string, branch: string) => boolean;
}

/** GitHub API operations (PRs, CI, commit statuses). */
export interface GhDeps {
  prMerge: (repoRoot: string, prNumber: number, options?: { admin?: boolean }) => boolean;
  prComment: (repoRoot: string, prNumber: number, body: string) => boolean;
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
  /** Get the current GitHub base branch for a PR. Returns null when unavailable. */
  getPrBaseBranch?: (repoRoot: string, prNumber: number) => string | null;
  /** Get PR base branch and state in a single API call. Returns null on total API failure. */
  getPrBaseAndState?: (repoRoot: string, prNumber: number) =>
    { baseBranch: string | null; prState: "MERGED" | "OPEN" | "CLOSED" | null } | null;
  /** Retarget a PR to a new GitHub base branch. */
  retargetPrBase?: (repoRoot: string, prNumber: number, baseBranch: string) => boolean;
  /** Check if a PR is mergeable (no conflicts). Returns true if mergeable, false if conflicting. */
  checkPrMergeable?: (repoRoot: string, prNumber: number) => boolean;
  /** Check if a PR is blocked by branch protection. Returns true if blocked. */
  isPrBlocked?: (repoRoot: string, prNumber: number) => boolean;
  /**
   * Get the merge commit SHA for a merged PR.
   * Returns the SHA string, or null if it can't be determined.
   */
  getMergeCommitSha?: (repoRoot: string, prNumber: number) => string | null;
  /**
   * Check CI status on a specific commit (e.g., merge commit on the default branch).
   * Returns "pass", "fail", or "pending".
   */
  checkCommitCI?: (repoRoot: string, sha: string) => "pass" | "fail" | "pending";
  /** Get the repository default branch name (e.g. "main" or "develop"). */
  getDefaultBranch?: (repoRoot: string) => string | null;
  /**
   * Upsert a living orchestrator status comment on a PR.
   * Appends an event row to a single persistent comment identified by a marker.
   * When not provided, falls back to deps.gh.prComment for backward compatibility.
   */
  upsertOrchestratorComment?: (
    repoRoot: string,
    prNumber: number,
    itemId: string,
    eventLine: string,
  ) => boolean;
}

/** Multiplexer operations (workspace management, screen reading). */
export interface MuxDeps {
  /** Legacy direct-message hook retained for older tests/backward compatibility. */
  sendMessage?: (workspaceRef: string, message: string) => boolean;
  closeWorkspace: (workspaceRef: string) => boolean;
  /** Read the last N lines of a worker's terminal screen for diagnostics. */
  readScreen?: (workspaceRef: string, lines?: number) => string;
}

/** Worker lifecycle operations (launch implementations, reviews, rebases). */
export interface WorkerDeps {
  validatePickupCandidate?: (
    item: WorkItem,
    projectRoot: string,
  ) => PickupCandidateValidation;
  launchSingleItem: (
    item: WorkItem,
    workDir: string,
    worktreeDir: string,
    projectRoot: string,
    aiTool: string,
    baseBranch?: string,
    forceWorkerLaunch?: boolean,
  ) => { worktreePath: string; workspaceRef: string; existingPrNumber?: number } | null;
  /**
   * Launch a review worker for a PR. Returns a workspace reference on success.
   */
  launchReview?: (itemId: string, prNumber: number, repoRoot: string, implementerWorktreePath?: string, aiTool?: string) => { workspaceRef: string; verdictPath: string } | null;
  /**
   * Launch a rebaser worker for rebase-only conflict resolution.
   * Called when daemon-rebase fails (conflicts). The rebaser worker gets
   * a focused prompt to resolve conflicts and push, not re-implement.
   * Returns a workspace reference on success.
   */
  launchRebaser?: (itemId: string, prNumber: number, repoRoot: string, aiTool?: string) => { workspaceRef: string } | null;
  /**
   * Launch a forward-fixer worker for post-merge CI failure diagnosis and fix-forward.
   * Creates a worktree from the repo default branch and launches the forward-fixer agent.
   * Returns a workspace reference and worktree path on success.
   */
  launchForwardFixer?: (itemId: string, mergeCommitSha: string, repoRoot: string, aiTool?: string, defaultBranch?: string) => { worktreePath: string; workspaceRef: string } | null;
}

/** Cleanup operations (worktrees, reviews, rebases, stale branches). */
export interface CleanupDeps {
  cleanSingleWorktree: (
    id: string,
    worktreeDir: string,
    projectRoot: string,
  ) => boolean;
  /**
   * Clean up a review worker session and workspace.
   */
  cleanReview?: (itemId: string, reviewWorkspaceRef: string) => boolean;
  /**
   * Clean up a rebaser worker session and workspace.
   */
  cleanRebaser?: (itemId: string, rebaserWorkspaceRef: string) => boolean;
  /**
   * Clean up a forward-fixer worker session and worktree.
   */
  cleanForwardFixer?: (itemId: string, fixForwardWorkspaceRef: string) => boolean;
  /**
   * Clean up stale branches when a work item ID is reused with different work.
   * Called before launching a worker. Checks for merged PRs with title mismatches
   * and deletes both local and remote branches so the worker starts fresh.
   * Non-fatal -- launch proceeds even if cleanup fails.
   */
  cleanStaleBranch?: (workItem: WorkItem, projectRoot: string) => void;
  /**
   * Remove/persist the merged work item file from the hub work directory.
   * Uses lineage-aware identity checks so reused IDs do not delete the wrong file.
   */
  completeMergedWorkItem?: (
    item: WorkItem,
    workDir: string,
    projectRoot: string,
  ) => {
    status: "already-removed" | "removed" | "skipped" | "failed";
    matchMode?: string;
    reason?: string;
    committed?: boolean;
  };
}

/** I/O operations (inbox, warnings, stack comments). */
export interface IoDeps {
  /** Write a message to the file-based inbox for a worker worktree. */
  writeInbox: (projectRoot: string, itemId: string, message: string) => void;
  /** Log a warning message (for situations that need human attention). */
  warn?: (message: string) => void;
  /**
   * Sync stack navigation comments on all PRs in a stack.
   * Injected (not imported) for test isolation. Production binds this to
   * syncStackComments from core/stack-comments.ts with a real GhCommentClient.
   */
  syncStackComments?: (baseBranch: string, stack: Array<{ prNumber: number; title: string }>) => void;
}

/** External dependencies injected into executeAction, grouped by concern. */
export interface OrchestratorDeps {
  git: GitDeps;
  gh: GhDeps;
  mux: MuxDeps;
  workers: WorkerDeps;
  cleanup: CleanupDeps;
  io: IoDeps;
}

/** Result of executing a single action. */
export interface ActionResult {
  success: boolean;
  error?: string;
}

// ── Default config ───────────────────────────────────────────────────

export const DEFAULT_CONFIG: OrchestratorConfig = {
  sessionLimit: 1,
  mergeStrategy: "auto",
  bypassEnabled: false,
  maxCiRetries: 5,
  maxRetries: 1,
  launchTimeoutMs: 30 * 60 * 1000,   // 30 minutes
  activityTimeoutMs: 60 * 60 * 1000, // 60 minutes
  enableStacking: true,
  reviewAutoFix: "off",
  maxMergeRetries: 3,
  maxRebaseAttempts: 3,
  rebaseRetryStaleMs: 15 * 60 * 1000,
  maxReviewRounds: 3,
  fixForward: true,
  maxFixForwardRetries: 2,
  skipReview: false,
  ciPendingFailGraceMs: 60_000,
  gracePeriodMs: 5 * 60 * 1000,  // 5 minutes
  maxTimeoutExtensions: 3,
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
export function calculateMemorySessionLimit(
  configuredLimit: number,
  freeMemBytes: number,
  memPerWorkerBytes: number = BYTES_PER_WORKER,
): number {
  if (configuredLimit <= 0) return 0;
  const memorySlots = Math.floor(freeMemBytes / memPerWorkerBytes);
  return Math.max(1, Math.min(memorySlots, configuredLimit));
}

// ── Orchestrator timeouts ────────────────────────────────────────────
// All timeout and grace period constants grouped by concern.
// Each value has JSDoc explaining its rationale and which guards consume it.

/**
 * Consolidated timeout and grace period constants for the orchestrator state machine.
 * Grouped by concern so the values are easy to find, audit, and tune together.
 *
 * **Worker liveness** -- detecting healthy vs. stuck/crashed workers.
 * **CI verification** -- waiting for CI results to become trustworthy.
 * **Merge pipeline** -- grace windows after merge for CI on the merge commit.
 * **Rebase** -- cooldowns for rebase retry nudges.
 */
export const TIMEOUTS = {
  // ── Worker liveness ──────────────────────────────────────────────
  /**
   * Heartbeat recency threshold (ms). A heartbeat younger than this means the
   * worker is healthy; a stale one triggers commit-based timeout checks.
   * Consumed by `isHeartbeatActive` in orchestrator-guards.ts.
   * 5 minutes -- generous enough for long builds, tight enough to detect crashes.
   */
  heartbeat: 5 * 60 * 1000, // 5 min

  /**
   * Launch window (ms). If an item sits in `launching` state longer than this
   * with no workerAlive signal, it is timed out (stuck-or-retry).
   * Consumed by `isLaunchTimedOut` in orchestrator-guards.ts.
   * 5 minutes -- covers slow tool startup and worktree creation.
   */
  launching: 5 * 60 * 1000, // 5 min

  // ── CI verification ──────────────────────────────────────────────
  /**
   * CI fix acknowledgement timeout (ms). After the orchestrator notifies a
   * worker about a CI failure, the worker must heartbeat within this window
   * to prove it received and is acting on the failure.
   * Consumed by `isCiFixAckTimedOut` in orchestrator-guards.ts.
   * 2 minutes -- long enough for the message to be read, short enough to
   * detect an unresponsive worker promptly.
   */
  ciFixAck: 2 * 60 * 1000, // 2 min

  // ── Merge pipeline ───────────────────────────────────────────────
  /**
   * Post-merge CI grace period (ms) when the repo has push workflows.
   * After merge, the orchestrator waits this long for check runs to appear
   * on the merge commit before treating "no checks" as "no CI configured".
   * Consumed by `isMergeCiGracePeriodExpired` in orchestrator-guards.ts.
   * 60 seconds -- push-triggered workflows typically queue within seconds.
   */
  mergeCi: 60_000, // 60 s

  /**
   * Post-merge CI grace period (ms) when no push workflows are detected.
   * Shorter than `mergeCi` because only third-party status checks
   * (which usually fire almost instantly) are expected.
   * Consumed by `isMergeCiGracePeriodExpired` in orchestrator-guards.ts.
   * 15 seconds -- if nothing appears by now, CI is not configured.
   */
  mergeCiNoPush: 15_000, // 15 s
} as const;

// Backward-compatible aliases so existing imports continue to work.
// TODO: migrate consumers to TIMEOUTS.* and remove these aliases.
/** @deprecated Use `TIMEOUTS.heartbeat` */
export const HEARTBEAT_TIMEOUT_MS = TIMEOUTS.heartbeat;
/** @deprecated Use `TIMEOUTS.ciFixAck` */
export const CI_FIX_ACK_TIMEOUT_MS = TIMEOUTS.ciFixAck;
/** @deprecated Use `TIMEOUTS.launching` */
export const LAUNCHING_TIMEOUT_MS = TIMEOUTS.launching;

/** Number of consecutive workerAlive=false polls required before declaring a worker dead. */
export const NOT_ALIVE_THRESHOLD = 5;

/** Failure reason set when a restarted worker has no live workspace and is held for operator relaunch. */
export const RESTART_RECOVERY_HOLD_REASON =
  "restart-hold: restarted worker has no live workspace; waiting for operator relaunch";

// ── WIP states: states that count toward the WIP limit ───────────────

export const ACTIVE_SESSION_STATES: Set<OrchestratorItemState> = new Set([
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

/** States that are terminal for the current run and should not be polled or launched. */
export const TERMINAL_STATES: Set<OrchestratorItemState> = new Set([
  "done",
  "blocked",
  "stuck",
]);

// ── Stackable states: dep states that allow a dependent item to launch stacked ──

export const STACKABLE_STATES: Set<OrchestratorItemState> = new Set([
  "ci-passed",
  "reviewing",
  "review-pending",
  "merging",
]);

// ── Declarative transition table ────────────────────────────────────
// Documents every legal state transition. Enforced at runtime by
// transition() -- illegal transitions throw immediately. Handlers
// remain the source of truth for transition logic; this table is the
// safety net that catches programming errors.

export const STATE_TRANSITIONS: Record<OrchestratorItemState, readonly OrchestratorItemState[]> = {
  "queued":               ["ready"],
  "ready":                ["launching", "queued"],
  "launching":            ["implementing", "stuck", "ready", "queued", "blocked", "ci-pending"],
  "implementing":         ["ci-pending", "merged", "stuck", "ready"],
  "ci-pending":           ["ci-passed", "ci-failed", "merged", "stuck", "rebasing"],
  "ci-passed":            ["reviewing", "review-pending", "merging", "ci-pending", "ci-failed", "stuck", "merged"],
  "ci-failed":            ["ci-pending", "ci-passed", "stuck", "ready", "merged", "rebasing"],
  "rebasing":             ["ci-pending", "stuck"],
  "reviewing":            ["ci-passed", "ci-failed", "ci-pending", "review-pending", "merged"],
  "review-pending":       ["ci-pending", "ci-passed", "ci-failed", "merging", "merged", "stuck", "reviewing", "rebasing", "ready"],
  "merging":              ["merged", "ci-passed", "ci-pending", "stuck"],
  "merged":               ["forward-fix-pending", "fix-forward-failed", "done"],
  "forward-fix-pending":  ["done", "fix-forward-failed"],
  "fix-forward-failed":   ["fixing-forward", "stuck", "done"],
  "fixing-forward":       ["done", "ci-pending", "merged", "stuck"],
  "done":                 [],
  "blocked":              [],
  "stuck":                [],
};

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
 */
export function statusDisplayForState(state: OrchestratorItemState, flags?: { rebaseRequested?: boolean; reviewRound?: number }): StatusDisplay {
  switch (state) {
    case "implementing":
    case "launching":
      return { text: "Implementing", icon: "hammer.fill", color: "#b45309" };
    case "rebasing":
      return { text: "Rebasing", icon: "arrow.triangle.branch", color: "#f59e0b" };
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
      return { text: "Verifying", icon: "clock.fill", color: "#06b6d4" };
    case "fix-forward-failed":
      return { text: "Fix Failed", icon: "xmark.circle", color: "#ef4444" };
    case "fixing-forward":
      return { text: "Fixing Forward", icon: "wrench.and.screwdriver.fill", color: "#ef4444" };
    case "merged":
      return { text: "Verifying", icon: "clock.fill", color: "#06b6d4" };
    case "done":
      return { text: "Done", icon: "checkmark.seal.fill", color: "#22c55e" };
    case "blocked":
      return { text: "Blocked", icon: "minus.circle", color: "#f59e0b" };
    case "stuck":
      return { text: "Stuck", icon: "exclamationmark.triangle", color: "#ef4444" };
    default:
      return { text: "Working", icon: "hammer.fill", color: "#b45309" };
  }
}

// ── Orchestrator handle for action functions ────────────────────────

/** Minimal interface for action functions to interact with orchestrator state. */
export interface OrchestratorHandle {
  readonly config: OrchestratorConfig;
  transition(item: OrchestratorItem, state: OrchestratorItemState, eventTime?: string): void;
  getItem(id: string): OrchestratorItem | undefined;
  getAllItems(): OrchestratorItem[];
  buildStackChain(itemId: string): Array<{ id: string; prNumber: number; title: string }>;
}
import type { GhFailureKind } from "./gh.ts";
