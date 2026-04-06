// status-render.ts: shared status table rendering logic.
// Used by both `ninthwave status --watch` and the daemon TUI (ninthwave orchestrate in TTY mode).

import {
  BOLD,
  BLUE,
  GREEN,
  YELLOW,
  RED,
  CYAN,
  DIM,
  RESET,
} from "./output.ts";
import type { DaemonState } from "./daemon.ts";
import { TIMEOUTS } from "./orchestrator-types.ts";
import type { MergeStrategy, PollSnapshot } from "./orchestrator.ts";
import { ghFailureKindLabel } from "./gh.ts";
import {
  TUI_SETTINGS_ROWS,
  collaborationLabel,
  collaborationIntentToMode,
  reviewModeLabel,
  runtimeOptionsForSettingsRow,
  scheduleEnabledToMode,
  type CollaborationIntent,
  type CollaborationMode,
  type ReviewMode,
} from "./tui-settings.ts";
import { muxTypeForWorkspaceRef } from "./mux.ts";
import type { PassiveUpdateState } from "./update-check.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { CollaborationMode, ReviewMode } from "./tui-settings.ts";

/** Crew status info for TUI display. */
export interface CrewStatusInfo {
  crewCode: string;
  daemonCount: number;
  availableCount: number;
  claimedCount: number;
  completedCount: number;
  connected: boolean;
}

/** Running schedule worker info for TUI display. */
export interface ScheduleWorkerInfo {
  taskId: string;
  startedAt: string;
}

export type EmptyStateMode = "watch-armed";

export type QuitConfirmKey = "q" | "ctrl-c";

export interface ViewOptions {
  showBlockerDetail?: boolean;
  sessionStartedAt?: string;
  /** Base repository URL for PR hyperlinks (e.g., "https://github.com/org/repo"). */
  repoUrl?: string;
  /** Crew mode status info. When present, renders crew bar above title. */
  crewStatus?: CrewStatusInfo;
  /** Current merge strategy -- used for footer indicator in TUI mode. */
  mergeStrategy?: MergeStrategy;
  /** Pending merge strategy selection waiting for the debounce window to settle. */
  pendingStrategy?: MergeStrategy;
  /** Live pending merge strategy countdown in seconds. */
  pendingStrategyCountdownSeconds?: number;
  /** When true, footer shows a pending quit confirmation instead of the strategy indicator. */
  ctrlCPending?: boolean;
  /** Which key started the pending quit confirmation. Defaults to Ctrl-C for legacy callers. */
  pendingQuitKey?: QuitConfirmKey;
  /** When true, footer shows a red shutdown-in-progress message. */
  shutdownInProgress?: boolean;
  /** When true, render the help overlay instead of the normal frame. */
  showHelp?: boolean;
  /** When true, render the controls overlay instead of the normal frame. */
  showControls?: boolean;
  /** Current collaboration mode for display. */
  collaborationMode?: CollaborationMode;
  /** Active collaboration intent in the controls overlay. */
  collaborationIntent?: CollaborationIntent;
  /** Whether the controls overlay is capturing join-session text input. */
  collaborationJoinInputActive?: boolean;
  /** Current join-session input value shown in the controls overlay. */
  collaborationJoinInputValue?: string;
  /** Whether a collaboration action is currently submitting. */
  collaborationBusy?: boolean;
  /** Inline collaboration error shown in the controls overlay. */
  collaborationError?: string;
  /** Current AI review mode for display. */
  reviewMode?: ReviewMode;
  /** Current schedule-execution preference for display. */
  scheduleEnabled?: boolean;
  /** Pending schedule-execution preference awaiting engine acknowledgement. */
  pendingScheduleEnabled?: boolean;
  /** Active schedule workers to display in the TUI. */
  scheduleWorkers?: ScheduleWorkerInfo[];
  /** Number of items where GitHub API returned errors. When > 0, a warning is shown in the footer. */
  apiErrorCount?: number;
  /** Optional summary of GitHub PR polling failure causes for footer copy. */
  apiErrorSummary?: PollSnapshot["apiErrorSummary"];
  /** Human-readable rate-limit backoff description for the footer (overrides generic API error text). */
  rateLimitBackoffDescription?: string;
  /** Passive startup update-check state for the TUI footer notice. */
  updateState?: PassiveUpdateState;
  /** Alternate empty-state copy for watch flows that are already armed. */
  emptyState?: EmptyStateMode;
  /** When true, render the mode indicator inline on the title line. */
  inlineModeIndicatorOnTitle?: boolean;
}

export interface StartupOverlayState {
  /** Optional override for the overlay title. */
  title?: string;
  /** Stable phase label shown during startup preparation. */
  phaseLabel: string;
  /** Optional supporting copy shown under the phase label. */
  detailLines?: string[];
  /** Optional footer hint. */
  hint?: string;
  /** Loading uses cyan, error uses red. */
  tone?: "loading" | "error";
}

/**
 * Return the styled icon badge for a merge strategy.
 * Reused by the TUI footer and the help overlay (M-TUI-5).
 *
 * | Strategy | Icon | Color   |
 * |----------|------|---------|
 * | auto     | ›    | GREEN   |
 * | manual   | ‖    | YELLOW  |
 * | bypass   | »    | RED     |
 */
export function strategyIndicator(strategy: MergeStrategy): string {
  switch (strategy) {
    case "auto":
      return `${GREEN}›${RESET} ${GREEN}auto${RESET}`;
    case "manual":
      return `${YELLOW}‖${RESET} ${YELLOW}manual${RESET}`;
    case "bypass":
      return `${RED}»${RESET} ${RED}bypass${RESET}`;
  }
}

function strategyFooterIndicator(
  strategy: MergeStrategy,
  pendingStrategy?: MergeStrategy,
  pendingStrategyCountdownSeconds?: number,
): string {
  if (!pendingStrategy || pendingStrategy === strategy) {
    return strategyIndicator(strategy);
  }
  if (pendingStrategyCountdownSeconds === undefined) {
    return `${strategyIndicator(pendingStrategy)} ${DIM}(pending)${RESET}`;
  }
  const countdownSeconds = Math.max(0, pendingStrategyCountdownSeconds);
  return `${strategyIndicator(pendingStrategy)} ${DIM}(${countdownSeconds}s)${RESET}`;
}

function formatStrategyFooterLine(
  strategy: MergeStrategy,
  pendingStrategy?: MergeStrategy,
  pendingStrategyCountdownSeconds?: number,
): string {
  const badge = strategyFooterIndicator(strategy, pendingStrategy, pendingStrategyCountdownSeconds);
  return `  ${badge} ${formatShortcutChord("shift+tab", "to toggle", { wrapInParens: true })}  ${formatShortcutHint("p", "pause")}  ${formatShortcutHint("q", "quit")}  ${formatShortcutHint("c", "controls")}  ${formatShortcutHint("?", "help")}`;
}

function formatShortcutHint(key: string, label: string): string {
  return `${RESET}${key}${DIM} ${label}${RESET}`;
}

function formatPendingQuitFooterLine(pendingQuitKey: QuitConfirmKey = "ctrl-c"): string {
  if (pendingQuitKey === "q") {
    return `  ${YELLOW}Press q again to quit${RESET}`;
  }
  return `  ${YELLOW}Press Ctrl-C again to exit${RESET}`;
}

function formatShortcutChord(
  key: string,
  label: string,
  options?: { wrapInParens?: boolean },
): string {
  const rendered = `${RESET}${key}${DIM} ${label}${RESET}`;
  if (!options?.wrapInParens) return rendered;
  return `${DIM}(${rendered}${DIM})${RESET}`;
}

function formatGitHubApiWarningText(
  apiErrorCount?: number,
  apiErrorSummary?: PollSnapshot["apiErrorSummary"],
  rateLimitBackoffDescription?: string,
): string {
  if (rateLimitBackoffDescription) return `⚠ ${rateLimitBackoffDescription}`;
  if ((apiErrorCount ?? 0) <= 0) return "";
  if (!apiErrorSummary) return "⚠ GitHub API unreachable";

  const entries = Object.entries(apiErrorSummary.byKind)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

  let base: string;
  if (entries.length <= 1) {
    base = `⚠ GitHub ${ghFailureKindLabel(apiErrorSummary.primaryKind)} error (${apiErrorSummary.total})`;
  } else {
    const parts = entries
      .slice(0, 2)
      .map(([kind, count]) => `${ghFailureKindLabel(kind as NonNullable<PollSnapshot["apiErrorSummary"]>["primaryKind"])} ${count}`);
    base = `⚠ GitHub errors: ${parts.join(", ")}`;
  }

  const hint = apiErrorSummary.representativeError;
  if (hint) {
    const maxHintLen = 60;
    const truncated = hint.length > maxHintLen ? hint.slice(0, maxHintLen - 3) + "..." : hint;
    return `${base} -- ${truncated}`;
  }
  return base;
}

function renderGitHubApiWarning(text: string): string {
  return text ? `${RED}${text}${RESET}` : "";
}

function formatUpdateNoticeText(updateState?: PassiveUpdateState): string {
  if (updateState?.status !== "update-available") return "";
  return `↑ update available: v${updateState.latestVersion}`;
}

function renderUpdateNotice(text: string): string {
  return text ? `${CYAN}${text}${RESET}` : "";
}

export interface SessionMetrics {
  leadTimeMedianMs: number | null;
  leadTimeP95Ms: number | null;
  throughputPerHour: number | null;
  successRate: number | null;
  sessionDurationMs: number | null;
}

export type ItemState =
  | "merged"
  | "verifying"
  | "fixing-forward"
  | "done"
  | "blocked"
  | "implementing"
  | "rebasing"
  | "ci-failed"
  | "ci-pending"
  | "ci-passed"
  | "review"
  | "in-progress"
  | "queued";

/**
 * Display states that correspond to ACTIVE_SESSION_STATES in the orchestrator.
 * Used for the "X/Y active sessions" count in the queue header.
 */
export const ACTIVE_DISPLAY_STATES: Set<ItemState> = new Set([
  "implementing",
  "ci-pending",
  "ci-failed",
  "rebasing",
  "ci-passed",
  "review",
  "in-progress",
]);

export interface StatusItem {
  id: string;
  title: string;
  /** Compact description snippet shown in the detail overlay when available. */
  descriptionSnippet?: string;
  /** Whether this item requires a human merge hold regardless of session merge strategy. */
  requiresManualReview?: boolean;
  state: ItemState;
  prNumber: number | null;
  /** Prior active PR numbers for this item, oldest first. */
  priorPrNumbers?: number[];
  ageMs: number; // milliseconds since worktree created
  /** Countdown remaining during timeout grace period. */
  timeoutRemainingMs?: number;
  /** Timeout extension counter as "N/M" during active grace period. */
  timeoutExtensions?: string;
  repoLabel: string;
  /** Descriptive reason for failure, displayed alongside ci-failed/stuck states. */
  failureReason?: string;
  dependencies?: string[];
  /** ISO timestamp of when the worker was launched. */
  startedAt?: string;
  /** ISO timestamp of when the worker completed or failed. */
  endedAt?: string;
  /** Exit code from the worker process (null when unknown). */
  exitCode?: number | null;
  /** Last lines of stderr captured from the worker on failure. */
  stderrTail?: string;
  /** True when this item is being worked on by another crew member. */
  remote?: boolean;
  /** Absolute path to preserved worktree directory (set for stuck items). */
  worktreePath?: string;
  /** Multiplexer workspace reference (e.g., "nw-myproject:nw_H-TM-1" for tmux). */
  workspaceRef?: string;
  /** Epoch ms deadline for worker respawn (ack timeout or dead-worker debounce). */
  respawnDeadlineMs?: number;
  /** Latest worker heartbeat progress from 0.0 to 1.0. */
  progress?: number;
  /** Latest worker heartbeat label. */
  progressLabel?: string;
  /** ISO timestamp of the latest worker heartbeat. */
  progressTs?: string;
  /** Number of pending inbox messages queued for this worker. */
  inboxPendingCount?: number;
  /** ISO timestamp of when the worker entered `nw inbox --wait`. */
  inboxWaitingSince?: string;
  /** Namespace project root the worker's inbox is attached to. */
  inboxNamespace?: string;
  /** ISO timestamp of the last inbox activity (write, deliver, drain). */
  inboxLastActivity?: string;
}

function headlessModeTag(item: StatusItem): string {
  return item.workspaceRef && muxTypeForWorkspaceRef(item.workspaceRef) === "headless"
    ? ` ${DIM}[headless]${RESET}`
    : "";
}

function manualReviewMarker(item: StatusItem): string {
  return item.requiresManualReview ? `${YELLOW}!${RESET} ` : "";
}

function manualReviewMarkerWidth(item: StatusItem): number {
  return item.requiresManualReview ? 2 : 0;
}

// ─── Dependency tree types ────────────────────────────────────────────────────

export interface TreeNode {
  item: StatusItem;
  children: TreeNode[];
}

// ─── Blocked-by computation ──────────────────────────────────────────────────

/**
 * Compute unresolved (not-done) dependencies for each item.
 * Returns a Map from item ID to an array of blocking dep IDs.
 */
export function computeBlockedBy(
  items: StatusItem[],
): Map<string, string[]> {
  const stateMap = new Map<string, ItemState>();
  for (const item of items) {
    stateMap.set(item.id, item.state);
  }

  const result = new Map<string, string[]>();
  for (const item of items) {
    const deps = item.dependencies ?? [];
    const blockers = deps.filter((depId) => {
      const depState = stateMap.get(depId);
      return depState !== undefined && depState !== "done";
    });
    result.set(item.id, blockers);
  }
  return result;
}

/**
 * Sort items: blocked-by count ascending, then ID alphanumeric.
 */
export function sortByBlockedThenId(
  items: StatusItem[],
  blockedBy: Map<string, string[]>,
): StatusItem[] {
  return [...items].sort((a, b) => {
    const aCount = (blockedBy.get(a.id) ?? []).length;
    const bCount = (blockedBy.get(b.id) ?? []).length;
    if (aCount !== bCount) return aCount - bCount;
    return a.id.localeCompare(b.id);
  });
}

// ─── Pure formatting functions (testable) ────────────────────────────────────

/** Map state to ANSI color code. */
export function stateColor(state: ItemState): string {
  switch (state) {
    case "merged":
    case "done":
      return GREEN;
    case "verifying":
      return CYAN;
    case "fixing-forward":
      return RED;
    case "blocked":
      return YELLOW;
    case "implementing":
    case "rebasing":
    case "in-progress":
      return YELLOW;
    case "ci-failed":
      return RED;
    case "ci-pending":
      return CYAN;
    case "ci-passed":
      return GREEN;
    case "review":
      return BLUE;
    case "queued":
      return DIM;
    default:
      return DIM;
  }
}

/** Map state to a single-character unicode indicator. */
export function stateIcon(state: ItemState): string {
  switch (state) {
    case "merged":
    case "done":
      return "✓";
    case "verifying":
      return "◌";
    case "fixing-forward":
      return "⚡";
    case "blocked":
      return "⧗";
    case "implementing":
    case "in-progress":
      return "▸";
    case "rebasing":
      return "⟲";
    case "ci-failed":
      return "✗";
    case "ci-pending":
      return "◌";
    case "ci-passed":
      return "✓";
    case "review":
      return "●";
    case "queued":
      return "·";
    default:
      return " ";
  }
}

/** Map state to human-readable label. */
export function stateLabel(state: ItemState): string {
  switch (state) {
    case "merged":
      return "Merged";
    case "verifying":
      return "Verifying";
    case "fixing-forward":
      return "Fixing Forward";
    case "done":
      return "Done";
    case "blocked":
      return "Blocked";
    case "implementing":
      return "Implementing";
    case "rebasing":
      return "Rebasing";
    case "ci-failed":
      return "CI Failed";
    case "ci-pending":
      return "CI Pending";
    case "ci-passed":
      return "CI Passed";
    case "review":
      return "In Review";
    case "in-progress":
      return "In Progress";
    case "queued":
      return "Queued";
    default:
      return "Unknown";
  }
}

/** Truncate a title to fit within maxWidth, adding "..." if truncated. */
export function truncateTitle(title: string, maxWidth: number): string {
  if (maxWidth < 4) return title.slice(0, maxWidth);
  if (title.length <= maxWidth) return title;
  return title.slice(0, maxWidth - 3) + "...";
}

/**
 * Truncate an ANSI-colored string to fit within maxWidth visible characters.
 * Preserves ANSI escape sequences (colors, etc.) and adds RESET + "..." at the cut point.
 */
export function truncateAnsi(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  // Reserve 3 chars for "..." when truncation is needed.
  // First pass: check if truncation is needed at all.
  const cutWidth = Math.max(0, maxWidth - 3);
  let visible = 0;
  let i = 0;
  let cutPoint = 0; // byte index where visible chars == cutWidth
  let cutReached = false;
  while (i < s.length) {
    // Skip ANSI CSI sequences
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i);
      if (end !== -1) { i = end + 1; continue; }
    }
    // Skip OSC 8 hyperlink sequences
    if (s[i] === "\x1b" && s[i + 1] === "]") {
      const end = s.indexOf("\x07", i);
      if (end !== -1) { i = end + 1; continue; }
    }
    visible++;
    if (!cutReached && visible > cutWidth) {
      cutPoint = i;
      cutReached = true;
    }
    if (visible > maxWidth) {
      // Truncation needed -- cut at cutWidth and append "..."
      return s.slice(0, cutPoint) + `${RESET}...`;
    }
    i++;
  }
  return s; // No truncation needed
}

/**
 * Return a color-coded blocking icon based on unresolved blocker count.
 * RED ⧗ for 2+ blockers, YELLOW ⧗ for 1 blocker, plain space for 0.
 * Always 1 visible character wide to preserve column alignment.
 */
export function blockingIcon(blockingCount: number): string {
  if (blockingCount >= 2) return `${RED}⧗${RESET}`;
  if (blockingCount === 1) return `${YELLOW}⧗${RESET}`;
  return " ";
}

/**
 * Render a dimmed sub-line showing blocker IDs, aligned under the blocker icon column.
 * Format: "          └ H-CA-1, H-CA-3" (padded to blockerColOffset) with truncation
 * and "..." when the list exceeds titleWidth.
 * The entire line is wrapped in DIM regardless of queued state.
 *
 * @param blockerColOffset - Column position of the ⧗ blocker icon in the parent row
 *   (typically 26 + stateColWidth). The └ indicator is padded to
 *   this position so it aligns directly under the ⧗ icon.
 */
export function formatBlockerSubline(
  blockerIds: string[],
  titleWidth: number,
  isQueued: boolean,
  blockerColOffset: number = 4,
): string {
  const prefix = " ".repeat(blockerColOffset) + "└ ";
  const idList = blockerIds.join(", ");
  const available = titleWidth;
  let content: string;
  if (available <= 0) {
    content = "";
  } else if (idList.length <= available) {
    content = idList;
  } else {
    content = idList.slice(0, available - 3) + "...";
  }
  return `${DIM}${prefix}${content}${RESET}`;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}

function progressPercentText(progress: number): string {
  return `${Math.round(clampProgress(progress) * 100)}%`;
}

function shouldShowItemProgress(item: StatusItem): boolean {
  return item.progress !== undefined
    && (item.state === "implementing" || item.state === "rebasing" || item.state === "ci-failed");
}

/**
 * Format a compact single-line progress string for row/detail rendering.
 * Falls back from bar+label to bar+percent to percent-only as space shrinks.
 */
export function formatInlineProgress(
  progress: number,
  label: string | undefined,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return "";

  const percentText = progressPercentText(progress);
  if (maxWidth <= percentText.length) return percentText;
  if (maxWidth < 8) return percentText;

  const barWidth = maxWidth >= 26 ? 10 : maxWidth >= 20 ? 8 : maxWidth >= 14 ? 6 : 4;
  const filled = Math.round(clampProgress(progress) * barWidth);
  const bar = `[${"#".repeat(filled)}${"-".repeat(barWidth - filled)}]`;
  let text = `${bar} ${percentText}`;

  if (label) {
    const remaining = maxWidth - text.length - 1;
    if (remaining >= 4) {
      const labelText = label.length <= remaining
        ? label
        : label.slice(0, remaining - 3) + "...";
      text += ` ${labelText}`;
    }
  }

  return text.length <= maxWidth ? text : text.slice(0, maxWidth);
}

/** Format milliseconds into a human-readable age string (e.g., "2h 15m", "3d 1h"). */
export function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remMinutes = minutes % 60;
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "<1m";
}

/** Format milliseconds into a countdown string (e.g. "4m 31s"). */
export function formatCountdown(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format a schedule worker status line for the TUI.
 * Returns a line like: "  [sched] daily-tests -- running (2m 14s)"
 */
export function formatScheduleWorkerLine(
  worker: ScheduleWorkerInfo,
  now: Date = new Date(),
): string {
  const elapsed = Math.max(0, now.getTime() - new Date(worker.startedAt).getTime());
  const duration = formatAge(elapsed);
  return `  ${CYAN}[sched]${RESET} ${worker.taskId} ${DIM}-- running (${duration})${RESET}`;
}

/** Right-pad a string to a given width. */
export function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

/**
 * Wrap text in an OSC 8 hyperlink escape sequence.
 * Terminals that support OSC 8 (iTerm2, Kitty, Windows Terminal, GNOME Terminal)
 * render the text as a clickable link. Unsupported terminals show plain text.
 */
export function osc8Link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/**
 * Strip ANSI CSI sequences and OSC 8 hyperlink sequences from a string.
 * Returns the plain display text. Useful for width calculations.
 */
export function stripAnsiForWidth(s: string): string {
  return s
    .replace(/\x1b\]8;[^\x07]*\x07/g, "")   // Strip OSC 8 hyperlink sequences
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");  // Strip CSI sequences (colors, etc.)
}

/**
 * Compute dynamic state column width based on current items.
 * Returns 14 when no items have PRs (enough for "Implementing").
 * Expands up to 24 when PR numbers are present.
 */
export function computeStateColWidth(items: StatusItem[]): number {
  const BASE_WIDTH = 14;
  const MAX_WIDTH = 24;
  let maxWidth = BASE_WIDTH;
  for (const item of items) {
    if (item.prNumber) {
      const displayLen = stateLabel(item.state).length + ` (#${item.prNumber})`.length;
      if (displayLen > maxWidth) maxWidth = displayLen;
    }
  }
  return Math.min(maxWidth, MAX_WIDTH);
}

/**
 * Format the state label with an optional inline PR suffix.
 * When repoUrl is provided, the PR number is wrapped in an OSC 8 hyperlink.
 * Returns a string padded to stateColWidth based on display width.
 */
export function formatStateLabelWithPr(
  state: ItemState,
  prNumber: number | null,
  stateColWidth: number,
  repoUrl?: string,
): string {
  const label = stateLabel(state);
  if (!prNumber) {
    return pad(label, stateColWidth);
  }

  const prText = `(#${prNumber})`;
  const displayLen = label.length + 1 + prText.length; // "Label (#NNN)"
  const paddingNeeded = Math.max(0, stateColWidth - displayLen);

  if (repoUrl) {
    const prUrl = `${repoUrl}/pull/${prNumber}`;
    return `${label} ${osc8Link(prUrl, prText)}${" ".repeat(paddingNeeded)}`;
  }
  return `${label} ${prText}${" ".repeat(paddingNeeded)}`;
}

/**
 * Format elapsed duration from startedAt to now (for active workers) or to endedAt (for completed workers).
 * Returns a human-readable string like "2h 15m" or empty string when no startedAt is available.
 */
export function formatElapsed(item: StatusItem): string {
  if (!item.startedAt) return "";
  const start = new Date(item.startedAt).getTime();
  if (isNaN(start)) return "";
  const end = item.endedAt ? new Date(item.endedAt).getTime() : Date.now();
  if (isNaN(end)) return "";
  return formatAge(Math.max(0, end - start));
}

/**
 * Format duration for the DURATION column.
 * Uses startedAt/endedAt when available (via formatElapsed), falls back to formatAge(item.ageMs)
 * for the worktree-scan path where startedAt is not set.
 */
export function formatDuration(item: StatusItem): string {
  if (item.timeoutRemainingMs !== undefined) {
    return formatCountdown(item.timeoutRemainingMs);
  }
  // Live respawn countdown (computed at render time, updates every 1s via timer)
  if (item.respawnDeadlineMs && item.state === "ci-failed") {
    const remaining = Math.max(0, item.respawnDeadlineMs - Date.now());
    if (remaining > 0) return `⟳ ${Math.ceil(remaining / 1000)}s`;
    return "⟳ ...";
  }
  if (item.state === "queued") return "-";
  if (item.startedAt) {
    const elapsed = formatElapsed(item);
    if (elapsed) return elapsed;
  }
  return formatAge(item.ageMs);
}

/**
 * Format telemetry suffix for an item row.
 * Failed workers: show exit code and stderr tail.
 */
export function formatTelemetrySuffix(item: StatusItem): string {
  const parts: string[] = [];

  // Show exit code for failed/stuck workers
  if (item.state === "ci-failed" && item.exitCode != null) {
    parts.push(`exit: ${item.exitCode}`);
  }

  // Show stderr tail for failed workers
  if (item.state === "ci-failed" && item.stderrTail) {
    // Show first line of stderr for compact display
    const firstLine = item.stderrTail.split("\n").filter(l => l.trim())[0];
    if (firstLine) {
      const trimmed = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
      parts.push(`stderr: ${trimmed}`);
    }
  }

  // Show preserved worktree path for stuck items so users know where to find partial work.
  // ci-failed items show the worktree path in the detail modal instead (press Enter/i).
  const rawState = item.state as string;
  if (rawState === "stuck" && item.worktreePath) {
    parts.push(`worktree: ${item.worktreePath}`);
  }

  return parts.length > 0 ? ` ${DIM}(${parts.join(", ")})${RESET}` : "";
}

/**
 * Format a single item row for the status table.
 * Returns a string with ANSI color codes.
 * When depIndicator is provided, it's displayed as a 2-char inline blocker
 * indicator before the title (e.g., color-coded ⧗ + space, or 2 spaces).
 * stateColWidth controls the state+PR column width (default 14).
 * repoUrl enables OSC 8 hyperlinks on PR numbers.
 * Remote items (worked on by other crew members) show a cyan dot after the state.
 */
export function formatItemRow(
  item: StatusItem,
  titleWidth: number,
  depIndicator?: string,
  stateColWidth: number = 14,
  repoUrl?: string,
  isSelected?: boolean,
  termWidth?: number,
): string {
  const gracePeriodActive = item.timeoutRemainingMs !== undefined;
  const icon = gracePeriodActive ? "⚠" : stateIcon(item.state);
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const iconColor = gracePeriodActive ? RED : color;
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth, repoUrl);
  const remoteDot = item.remote ? ` ${REMOTE_DOT}` : "";
  const duration = pad(formatDuration(item), 8);
  const durationCell = gracePeriodActive ? `${RED}${duration}${RESET}` : duration;
  const timeoutExtensions = gracePeriodActive && item.timeoutExtensions
    ? ` ${DIM}(${item.timeoutExtensions})${RESET}`
    : "";
  const depCol = depIndicator ?? "";
  const progressText = shouldShowItemProgress(item)
    ? formatInlineProgress(
        item.progress!,
        item.progressLabel,
        Math.min(32, Math.max(4, Math.floor(titleWidth * 0.45))),
      )
    : "";
  const progressWidth = progressText ? stripAnsiForWidth(progressText).length + 1 : 0;
  const marker = manualReviewMarker(item);
  const title = truncateTitle(
    item.title || item.id,
    Math.max(4, titleWidth - progressWidth - manualReviewMarkerWidth(item)),
  );
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";
  const reason = item.failureReason
    ? ` ${DIM}(${truncateTitle(item.failureReason, 72)})${RESET}`
    : "";
  const telemetry = formatTelemetrySuffix(item);

  // Selection highlight: replace leading 2-space indent with bold ">" prefix
  const prefix = isSelected ? `${BOLD}>${RESET} ` : "  ";

  const progressSuffix = progressText ? ` ${DIM}${progressText}${RESET}` : "";
  const modeTag = headlessModeTag(item);

  const row = `${prefix}${iconColor}${icon}${RESET} ${id}${color}${stateCell}${RESET}${remoteDot} ${durationCell}${timeoutExtensions} ${depCol}${marker}${title}${progressSuffix}${modeTag}${repo}${reason}${telemetry}`;
  return termWidth ? truncateAnsi(row, termWidth) : row;
}

function pushWrappedDetailField(
  lines: string[],
  label: string,
  value: string,
  color: string = "",
): void {
  const wrapped = wrapDetailText(value, 72);
  if (wrapped.length === 0) return;

  const prefix = `  ${DIM}${label}:${RESET}`;
  const paddedPrefix = `${prefix}${" ".repeat(Math.max(1, 10 - label.length))}`;
  lines.push(`${paddedPrefix}${color}${wrapped[0]}${RESET}`);
  for (const line of wrapped.slice(1)) {
    lines.push(`             ${color}${line}${RESET}`);
  }
}

/**
 * Format the batch progress line summarizing item states.
 * E.g., "Progress: 2 done, 1 verifying, 1 ci-pending"
 */
export function formatBatchProgress(items: StatusItem[]): string {
  if (items.length === 0) return "";

  const counts = new Map<ItemState, number>();
  for (const item of items) {
    counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  }

  // Order states for display: completed first, then active, then bad, then queued
  const order: ItemState[] = [
    "done",
    "merged",
    "verifying",
    "fixing-forward",
    "review",
    "ci-pending",
    "rebasing",
    "implementing",
    "in-progress",
    "blocked",
    "ci-failed",
    "queued",
  ];

  const parts: string[] = [];
  for (const state of order) {
    const count = counts.get(state);
    if (count && count > 0) {
      const color = stateColor(state);
      parts.push(`${color}${count} ${stateLabel(state).toLowerCase()}${RESET}`);
    }
  }

  return `  ${BOLD}Progress:${RESET} ${parts.join(", ")}`;
}

/**
 * Format a summary line with total counts.
 */
export function formatSummary(items: StatusItem[]): string {
  const total = items.length;
  const done = items.filter((i) => i.state === "done").length;
  const active = total - done;

  if (total === 0) return `  ${DIM}No active items${RESET}`;

  const parts = [`${total} item${total !== 1 ? "s" : ""}`];
  if (done > 0 && active > 0) {
    parts.push(`${GREEN}${done} done${RESET}`, `${active} active`);
  }

  return `  ${DIM}Total: ${parts.join(", ")}${RESET}`;
}

function buildEmptyStateLines(viewOptions?: ViewOptions): string[] {
  if (viewOptions?.emptyState === "watch-armed") {
    return [
      `  ${DIM}No active items yet -- local watch is armed${RESET}`,
      "",
      `  ${DIM}Waiting for new work items...${RESET}`,
      `  ${DIM}The first ready item will start automatically.${RESET}`,
    ];
  }

  return [
    `  ${DIM}No active items${RESET}`,
    "",
    `  ${DIM}To get started:${RESET}`,
    `    ${DIM}ninthwave list --ready${RESET}     ${DIM}Show available work items${RESET}`,
    `    ${DIM}ninthwave start <ID>${RESET}       ${DIM}Start a work item${RESET}`,
  ];
}

/**
 * Format a fully dimmed item row for the queue section.
 * Returns a string with DIM applied to the entire row.
 * depIndicator is the optional 2-char inline blocker indicator before the title.
 * stateColWidth controls the state column width (default 14).
 */
export function formatQueuedItemRow(
  item: StatusItem,
  titleWidth: number,
  depIndicator?: string,
  stateColWidth: number = 14,
  isSelected?: boolean,
): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth);
  const duration = pad(formatDuration(item), 8);
  const depCol = depIndicator ?? "";
  const marker = manualReviewMarker(item);
  const title = truncateTitle(
    item.title || item.id,
    Math.max(4, titleWidth - manualReviewMarkerWidth(item)),
  );
  const repo = item.repoLabel ? ` [${item.repoLabel}]` : "";
  const prefix = isSelected ? `${BOLD}>${RESET} ` : "  ";

  return `${prefix}${DIM}${icon} ${id}${stateCell} ${duration} ${depCol}${marker}${title}${repo}${RESET}`;
}

// ─── Dependency tree building ─────────────────────────────────────────────────

/**
 * Build dependency trees from StatusItems.
 * Items linked by dependencies form parent→child trees.
 * An item's parent is the first dependency ID that exists in the current item set.
 * Items with no dependency relationships are returned as flat.
 */
export function buildDependencyTree(items: StatusItem[]): {
  trees: TreeNode[];
  flat: StatusItem[];
} {
  const itemMap = new Map<string, StatusItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  // Create tree nodes for all items
  const nodeMap = new Map<string, TreeNode>();
  for (const item of items) {
    nodeMap.set(item.id, { item, children: [] });
  }

  // Link children to parents: an item's parent is its first in-set dependency
  const hasParent = new Set<string>();
  for (const item of items) {
    const deps = item.dependencies ?? [];
    const parentId = deps.find((d) => itemMap.has(d));
    if (parentId) {
      hasParent.add(item.id);
      nodeMap.get(parentId)!.children.push(nodeMap.get(item.id)!);
    }
  }

  // Separate roots (have dependents) from flat items (no dep relationships)
  const trees: TreeNode[] = [];
  const flat: StatusItem[] = [];

  for (const item of items) {
    if (hasParent.has(item.id)) continue; // already linked as child
    const node = nodeMap.get(item.id)!;
    if (node.children.length > 0) {
      trees.push(node);
    } else {
      flat.push(item);
    }
  }

  return { trees, flat };
}

/**
 * Format a single tree item row with tree-drawing prefix.
 * depth=0 items have no prefix (roots). depth>0 items get connector characters.
 * stateColWidth controls the state+PR column width (default 14).
 * repoUrl enables OSC 8 hyperlinks on PR numbers.
 */
export function formatTreeItemRow(
  item: StatusItem,
  depth: number,
  ancestorIsLast: boolean[],
  isLast: boolean,
  termWidth: number,
  stateColWidth: number = 14,
  repoUrl?: string,
): string {
  const fixedWidth = 26 + stateColWidth;
  const prefixWidth = depth > 0 ? depth * 4 : 0;
  const titleWidth = Math.max(6, termWidth - fixedWidth - prefixWidth);

  // Build tree prefix
  let prefix = "";
  if (depth > 0) {
    for (const parentIsLast of ancestorIsLast) {
      prefix += parentIsLast ? "    " : "│   ";
    }
    prefix += isLast ? "└── " : "├── ";
  }

  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth, repoUrl);
  const duration = pad(formatDuration(item), 8);
  const marker = manualReviewMarker(item);
  const title = truncateTitle(
    item.title || item.id,
    Math.max(4, titleWidth - manualReviewMarkerWidth(item)),
  );
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";

  if (item.state === "queued") {
    return `  ${DIM}${prefix}${icon} ${id}${stateCell} ${duration} ${marker}${title}${repo}${RESET}`;
  }
  return `  ${prefix ? `${DIM}${prefix}${RESET}` : ""}${color}${icon}${RESET} ${id}${color}${stateCell}${RESET} ${duration} ${marker}${title}${repo}`;
}

/**
 * Render dependency trees as formatted rows with tree-drawing characters.
 * Uses ├──, └──, │ for visual structure.
 * stateColWidth and repoUrl are passed through to formatTreeItemRow.
 */
export function formatTreeRows(
  trees: TreeNode[],
  termWidth: number,
  stateColWidth: number = 14,
  repoUrl?: string,
): string[] {
  const lines: string[] = [];

  function renderNode(
    node: TreeNode,
    depth: number,
    ancestorIsLast: boolean[],
    isLast: boolean,
  ): void {
    lines.push(formatTreeItemRow(node.item, depth, ancestorIsLast, isLast, termWidth, stateColWidth, repoUrl));

    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      // At depth 0 (root), don't propagate to ancestorIsLast since root has no prefix
      const nextAncestors = depth > 0 ? [...ancestorIsLast, isLast] : [];
      renderNode(node.children[i]!, depth + 1, nextAncestors, childIsLast);
    }
  }

  for (let i = 0; i < trees.length; i++) {
    if (i > 0) lines.push(""); // blank line between separate trees
    renderNode(trees[i]!, 0, [], true);
  }

  return lines;
}

// ─── Session metrics (DORA-style) ─────────────────────────────────────────────

/** Compute the median of a sorted numeric array. Returns null for empty arrays. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/** Compute the P-th percentile of a sorted numeric array using nearest-rank. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    Math.ceil((p / 100) * sorted.length) - 1,
    sorted.length - 1,
  );
  return sorted[Math.max(0, idx)]!;
}

/**
 * Compute DORA-style session metrics from StatusItems.
 *
 * - Lead time (median/P95): endedAt − startedAt for done items.
 * - Throughput: done items per hour (requires sessionStartedAt).
 * - Success rate: done / (done + failed).
 * - Session duration: now − sessionStartedAt.
 */
export function computeSessionMetrics(
  items: StatusItem[],
  sessionStartedAt?: string,
): SessionMetrics {
  const doneItems = items.filter((i) => i.state === "done");
  const failedItems = items.filter((i) => i.state === "ci-failed");

  // Collect lead times from done items with valid timestamps
  const leadTimes: number[] = [];
  for (const item of doneItems) {
    if (item.startedAt && item.endedAt) {
      const start = new Date(item.startedAt).getTime();
      const end = new Date(item.endedAt).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        leadTimes.push(end - start);
      }
    }
  }
  leadTimes.sort((a, b) => a - b);

  const leadTimeMedianMs = median(leadTimes);
  const leadTimeP95Ms = percentile(leadTimes, 95);

  // Session duration
  let sessionDurationMs: number | null = null;
  if (sessionStartedAt) {
    const start = new Date(sessionStartedAt).getTime();
    if (!isNaN(start)) {
      sessionDurationMs = Math.max(0, Date.now() - start);
    }
  }

  // Throughput: done / session-hours
  const throughputPerHour =
    sessionDurationMs !== null && sessionDurationMs > 0
      ? (doneItems.length / sessionDurationMs) * 3_600_000
      : null;

  // Success rate
  const total = doneItems.length + failedItems.length;
  const successRate = total > 0 ? doneItems.length / total : null;

  return {
    leadTimeMedianMs,
    leadTimeP95Ms,
    throughputPerHour,
    successRate,
    sessionDurationMs,
  };
}

/** Brand amber -- truecolor (#D4A030). */
const BRAND = "\x1b[38;2;212;160;48m";
/** Brand amber background + black text for collaboration status bar. */
const CONNECTED_BG = "\x1b[48;2;212;160;48m\x1b[30m";
/** Brand-colored dot for items worked on by other session members. */
export const REMOTE_DOT = `${BRAND}\u25CF${RESET}`; // ● in brand amber

/**
 * Format collaboration status bar for display above the title line.
 * Uses brand amber background spanning the full terminal width.
 * Shows "Sharing" for solo sessions, daemon count for multi-daemon crews.
 */
export function formatConnectionPanel(status: CrewStatusInfo, termWidth: number = 80): string {
  let content: string;
  if (!status.connected) {
    content = `ninthwave.sh  |  OFFLINE -- reconnecting...`;
  } else if (status.daemonCount <= 1) {
    content = `Sharing via ninthwave.sh  |  ${status.availableCount} avail  |  ${status.claimedCount} claimed  |  ${status.completedCount} done`;
  } else {
    content = `${status.daemonCount} online  |  ${status.availableCount} avail  |  ${status.claimedCount} claimed  |  ${status.completedCount} done`;
  }
  const totalPad = Math.max(0, termWidth - content.length);
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  return `${CONNECTED_BG}${" ".repeat(leftPad)}${content}${" ".repeat(rightPad)}${RESET}`;
}

/**
 * Format the complete status table from a list of StatusItems.
 * Returns a multi-line string ready for console output.
 * When sessionLimit is provided, shows WIP slot usage in the queue header.
 *
 * When items have dependencies, renders a flat list sorted by blocked-by count
 * (ascending) then ID alphanumeric, with inline blocker icons before titles
 * and optional sub-lines showing blocker IDs.
 *
 * viewOptions controls optional panels:
 * - showBlockerDetail: show blocker sub-lines below blocked items (default: true).
 * - sessionStartedAt: ISO timestamp for throughput/session duration calculations.
 */
export function formatStatusTable(
  items: StatusItem[],
  termWidth: number = 80,
  sessionLimit?: number,
  flat: boolean = false,
  viewOptions?: ViewOptions,
): string {
  const lines: string[] = [];

  const opts = viewOptions ?? {};

  // Title line with optional inline crew info
  let titleLine = `${BOLD}Ninthwave${RESET}`;
  if (opts.crewStatus) {
    titleLine += `  ${BRAND}${formatConnectionInline(opts.crewStatus)}${RESET}`;
  }
  lines.push(titleLine);
  lines.push("");

  if (items.length === 0) {
    lines.push(...buildEmptyStateLines(opts));
    return lines.join("\n");
  }

  const repoUrl = opts.repoUrl;
  const crewActive = opts.crewStatus != null;

  // Check if any items have dependency relationships
  const hasDeps = !flat && items.some((i) => (i.dependencies ?? []).length > 0);

  // Precompute blocked-by map (needed for inline blocker indicator + sub-lines)
  const blockedBy = hasDeps ? computeBlockedBy(items) : undefined;

  // Inline dep indicator: 2-char slot (icon + space) before title when deps exist
  const depIndicatorWidth = hasDeps ? 2 : 0;

  // Dynamic state column width: 14ch when no items have PRs, up to ~24ch with PRs
  const stateColWidth = computeStateColWidth(items);

  // Column widths
  const fixedWidth = 26 + stateColWidth + depIndicatorWidth;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  // Column offset where the blocker icon sits (for aligning sub-lines)
  const blockerColOffset = 26 + stateColWidth;

  /** Build the 2-char dep indicator for an item. */
  function depIndicator(itemId: string): string {
    if (!blockedBy) return "  ";
    const blockers = blockedBy.get(itemId) ?? [];
    return blockingIcon(blockers.length) + " ";
  }

  // Header
  const depPad = hasDeps ? "  " : "";
  const header = `  ${DIM}  ${pad("ID", 12)}${pad("STATE", stateColWidth)} ${pad("DURATION", 8)} ${depPad}TITLE${RESET}`;
  lines.push(header);

  // Separator
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, fixedWidth + titleWidth))}${RESET}`;
  lines.push(sep);

  if (hasDeps) {
    // Flat blocked-by mode: sort by blocked count asc, then ID alpha
    const sorted = sortByBlockedThenId(items, blockedBy!);

    const activeItems = sorted.filter((i) => i.state !== "queued" && i.state !== "done");
    const doneItems = sorted.filter((i) => i.state === "done");
    const queuedItems = sorted.filter((i) => i.state === "queued");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth, depIndicator(item.id), stateColWidth, repoUrl));
      const blockers = blockedBy!.get(item.id) ?? [];
      if (opts.showBlockerDetail && blockers.length > 0) {
        lines.push(formatBlockerSubline(blockers, titleWidth, false, blockerColOffset));
      }
    }
    for (const item of doneItems) {
      lines.push(formatItemRow(item, titleWidth, depIndicator(item.id), stateColWidth, repoUrl));
      const blockers = blockedBy!.get(item.id) ?? [];
      if (opts.showBlockerDetail && blockers.length > 0) {
        lines.push(formatBlockerSubline(blockers, titleWidth, false, blockerColOffset));
      }
    }

    // Queue section
    if (queuedItems.length > 0) {
      const activeCount = items.filter((i) => ACTIVE_DISPLAY_STATES.has(i.state)).length;
      const fixForwardCount = items.filter((i) => i.state === "fixing-forward").length;
      let queueHeader = `Queue (${queuedItems.length} waiting`;
      if (sessionLimit !== undefined) {
        queueHeader += `, ${activeCount}/${sessionLimit} active sessions`;
      }
      if (fixForwardCount > 0) {
        queueHeader += `, ${fixForwardCount} fixing forward`;
      }
      queueHeader += ")";

      lines.push("");
      lines.push(`  ${DIM}${queueHeader}${RESET}`);
      lines.push(sep);

      for (const item of queuedItems) {
        lines.push(formatQueuedItemRow(item, titleWidth, depIndicator(item.id), stateColWidth));
        const blockers = blockedBy!.get(item.id) ?? [];
        if (opts.showBlockerDetail && blockers.length > 0) {
          lines.push(formatBlockerSubline(blockers, titleWidth, true, blockerColOffset));
        }
      }
    }
  } else {
    // Flat mode (no dependencies): split into active, done, and queued groups
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "done");
    const queuedItems = items.filter((i) => i.state === "queued");
    const doneItems = items.filter((i) => i.state === "done");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl));
    }
    for (const item of doneItems) {
      lines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl));
    }

    // Queue section with header
    if (queuedItems.length > 0) {
      const activeCount = items.filter((i) => ACTIVE_DISPLAY_STATES.has(i.state)).length;
      const fixForwardCount = items.filter((i) => i.state === "fixing-forward").length;
      let queueHeader = `Queue (${queuedItems.length} waiting`;
      if (sessionLimit !== undefined) {
        queueHeader += `, ${activeCount}/${sessionLimit} active sessions`;
      }
      if (fixForwardCount > 0) {
        queueHeader += `, ${fixForwardCount} fixing forward`;
      }
      queueHeader += ")";

      lines.push("");
      lines.push(`  ${DIM}${queueHeader}${RESET}`);
      lines.push(sep);

      for (const item of queuedItems) {
        lines.push(formatQueuedItemRow(item, titleWidth, undefined, stateColWidth));
      }
    }
  }

  // Schedule worker status lines
  const schedWorkers = opts.scheduleWorkers ?? [];
  if (schedWorkers.length > 0) {
    lines.push("");
    for (const sw of schedWorkers) {
      lines.push(formatScheduleWorkerLine(sw));
    }
  }

  // Footer: unified progress line
  lines.push(sep);
  lines.push(formatUnifiedProgress(items, termWidth));

  return lines.join("\n");
}

// ─── Daemon state mapping ────────────────────────────────────────────────────

/**
 * Map orchestrator item state strings to status display ItemState.
 * Orchestrator uses finer-grained states; status display groups them.
 */
export function mapDaemonItemState(orchState: string, flags?: { rebaseRequested?: boolean }): ItemState {
  switch (orchState) {
    case "merged":
    case "forward-fix-pending":
      return "verifying";
    case "fixing-forward":
      return "fixing-forward";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "implementing":
    case "launching":
      return "implementing";
    case "rebasing":
      return "rebasing";
    case "ci-failed":
    case "stuck":
    case "fix-forward-failed":
      return "ci-failed";
    case "ci-pending":
    case "merging":
      return "ci-pending";
    case "ci-passed":
      return "ci-passed";
    case "review-pending":
    case "reviewing":
      return "review";
    case "queued":
    case "ready":
      return "queued";
    default:
      return "in-progress";
  }
}

export function normalizeRemoteItemState(state: ItemState): ItemState {
  return state === "merged" ? "verifying" : state;
}

export function buildDisplayPrContext(
  localPrNumber: number | null | undefined,
  localPriorPrNumbers?: number[],
  remotePrNumber?: number | null,
  remotePriorPrNumbers?: number[],
): { prNumber: number | null; priorPrNumbers?: number[] } {
  const prNumber = remotePrNumber !== undefined ? remotePrNumber : (localPrNumber ?? null);
  const priorPrNumbers = [...(remotePriorPrNumbers ?? localPriorPrNumbers ?? [])];

  if (
    remotePrNumber !== undefined
    && remotePrNumber !== null
    && localPrNumber != null
    && localPrNumber !== remotePrNumber
    && !priorPrNumbers.includes(localPrNumber)
  ) {
    priorPrNumbers.push(localPrNumber);
  }

  return {
    prNumber,
    ...(priorPrNumbers.length > 0 ? { priorPrNumbers } : {}),
  };
}

/**
 * Convert daemon state items to StatusItems for display.
 * Uses the state file data (fast, no GitHub API calls).
 */
export function daemonStateToStatusItems(state: DaemonState): StatusItem[] {
  return state.items.map((item) => {
    const prContext = buildDisplayPrContext(
      item.prNumber,
      item.priorPrNumbers,
      item.remoteSnapshot ? (item.remoteSnapshot.prNumber ?? null) : undefined,
      item.remoteSnapshot?.priorPrNumbers,
    );

    return {
      id: item.id,
      title: item.remoteSnapshot?.title ?? item.title,
      ...(item.descriptionSnippet ? { descriptionSnippet: item.descriptionSnippet } : {}),
      ...(item.requiresManualReview ? { requiresManualReview: true } : {}),
      state: item.remoteSnapshot
        ? normalizeRemoteItemState(item.remoteSnapshot.state)
        : mapDaemonItemState(item.state, { rebaseRequested: item.rebaseRequested }),
      prNumber: prContext.prNumber,
      ...(prContext.priorPrNumbers ? { priorPrNumbers: prContext.priorPrNumbers } : {}),
      ageMs: Date.now() - new Date(item.lastTransition).getTime(),
      repoLabel: "",
      failureReason: item.failureReason,
      dependencies: item.dependencies ?? [],
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      exitCode: item.exitCode,
      stderrTail: item.stderrTail,
      worktreePath: item.worktreePath,
      workspaceRef: item.workspaceRef,
      respawnDeadlineMs: item.ciNotifyWallAt
        ? new Date(item.ciNotifyWallAt).getTime() + TIMEOUTS.ciFixAck
        : undefined,
      progress: item.progress,
      progressLabel: item.progressLabel,
      progressTs: item.progressTs,
      remote: item.remoteSnapshot ? item.remoteSnapshot.ownerDaemonId !== null : false,
      ...(item.inboxPendingCount != null && item.inboxPendingCount > 0
        ? { inboxPendingCount: item.inboxPendingCount }
        : {}),
      ...(item.inboxWaitingSince ? { inboxWaitingSince: item.inboxWaitingSince } : {}),
      ...(item.inboxNamespace ? { inboxNamespace: item.inboxNamespace } : {}),
      ...(item.inboxLastActivity ? { inboxLastActivity: item.inboxLastActivity } : {}),
    };
  });
}

export function wrapDetailText(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }

    if ((current + " " + word).length <= maxWidth) {
      current += " " + word;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

function isMarkdownHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

function isPriorityFieldLine(line: string): boolean {
  return line.trim().replace(/\*/g, "").startsWith("Priority:");
}

function formatDescriptionBodyLines(text: string, maxWidth: number): string[] {
  const rawLines = text.split(/\r?\n/);
  const lines = isMarkdownHeadingLine(rawLines[0] ?? "")
    ? rawLines.slice(1)
    : rawLines;

  if ((lines[0] ?? "").trim() === "" && isPriorityFieldLine(lines[1] ?? "")) {
    lines.shift();
  }

  const wrappedLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      wrappedLines.push("");
      continue;
    }
    wrappedLines.push(...wrapDetailText(line, maxWidth));
  }

  while (wrappedLines[wrappedLines.length - 1] === "") {
    wrappedLines.pop();
  }

  return wrappedLines;
}

// ─── Terminal width detection ─────────────────────────────────────────────────

/**
 * Get terminal width, defaulting to 80 for non-TTY contexts.
 * Gracefully handles environments where process.stdout.columns is undefined.
 */
export function getTerminalWidth(): number {
  try {
    const cols = process.stdout.columns;
    if (typeof cols === "number" && cols > 0) return cols;
  } catch {
    // non-TTY or error accessing columns
  }
  return 80;
}

/**
 * Get terminal height (rows), defaulting to 24 for non-TTY contexts.
 * Gracefully handles environments where process.stdout.rows is undefined.
 */
export function getTerminalHeight(): number {
  try {
    const rows = process.stdout.rows;
    if (typeof rows === "number" && rows > 0) return rows;
  } catch {
    // non-TTY or error accessing rows
  }
  return 24;
}

// ─── Full-screen scrollable layout ──────────────────────────────────────────

/**
 * A structured layout with pinned header, scrollable items, and pinned footer.
 * Produced by buildStatusLayout() and consumed by renderFullScreenFrame().
 */
export interface FrameLayout {
  headerLines: string[];
  itemLines: string[];
  footerLines: string[];
  /**
   * Index into itemLines where the queue section begins (the blank line before
   * "Queue (N waiting...)"). undefined when there are no queued items.
   * Used by render functions to pin a queue affordance when the queue is scrolled off.
   */
  queueStartIndex?: number;
  /** Visible-order metadata for rendered/selectable status rows. */
  visibleLayout?: VisibleStatusLayoutMetadata;
}

export interface RenderedLineSpan {
  startLineIndex: number;
  endLineIndex: number;
  lineCount: number;
}

export interface VisibleStatusItemRow {
  type: "item";
  item: StatusItem;
  blockers: string[];
  queued: boolean;
}

export interface VisibleStatusQueueSpacerRow {
  type: "queue-spacer";
}

export interface VisibleStatusQueueHeaderRow {
  type: "queue-header";
  queuedCount: number;
  activeCount: number;
  fixForwardCount?: number;
}

export interface VisibleStatusQueueSeparatorRow {
  type: "queue-separator";
}

export type VisibleStatusLayoutRow =
  | VisibleStatusItemRow
  | VisibleStatusQueueSpacerRow
  | VisibleStatusQueueHeaderRow
  | VisibleStatusQueueSeparatorRow;

export interface VisibleStatusLayoutMetadata {
  rows: VisibleStatusLayoutRow[];
  selectableItemIds: string[];
  renderedLineSpans: Record<string, RenderedLineSpan>;
  hasDependencies: boolean;
  queueStartIndex?: number;
  queueItemCount: number;
}

export function buildVisibleStatusLayoutMetadata(
  items: StatusItem[],
  options?: {
    flat?: boolean;
    showBlockerDetail?: boolean;
  },
): VisibleStatusLayoutMetadata {
  const flat = options?.flat ?? false;
  const showBlockerDetail = options?.showBlockerDetail ?? false;
  const hasDependencies = !flat && items.some((item) => (item.dependencies ?? []).length > 0);
  const blockedBy = hasDependencies ? computeBlockedBy(items) : undefined;
  const orderedItems = hasDependencies ? sortByBlockedThenId(items, blockedBy!) : items;
  const activeItems = orderedItems.filter((item) => item.state !== "queued" && item.state !== "done");
  const doneItems = orderedItems.filter((item) => item.state === "done");
  const queuedItems = orderedItems.filter((item) => item.state === "queued");

  const rows: VisibleStatusLayoutRow[] = [];
  const selectableItemIds: string[] = [];
  const renderedLineSpans: Record<string, RenderedLineSpan> = {};
  let renderedLineIndex = 0;

  const pushItem = (item: StatusItem, queued: boolean): void => {
    const blockers = blockedBy?.get(item.id) ?? [];
    const lineCount = 1 + (showBlockerDetail && blockers.length > 0 ? 1 : 0);
    rows.push({ type: "item", item, blockers, queued });
    selectableItemIds.push(item.id);
    renderedLineSpans[item.id] = {
      startLineIndex: renderedLineIndex,
      endLineIndex: renderedLineIndex + lineCount - 1,
      lineCount,
    };
    renderedLineIndex += lineCount;
  };

  for (const item of activeItems) pushItem(item, false);
  for (const item of doneItems) pushItem(item, false);

  let queueStartIndex: number | undefined;
  if (queuedItems.length > 0) {
    queueStartIndex = renderedLineIndex;
    rows.push({ type: "queue-spacer" });
    renderedLineIndex += 1;
    rows.push({
      type: "queue-header",
      queuedCount: queuedItems.length,
      activeCount: items.filter((i) => ACTIVE_DISPLAY_STATES.has(i.state)).length,
      fixForwardCount: items.filter((i) => i.state === "fixing-forward").length,
    });
    renderedLineIndex += 1;
    rows.push({ type: "queue-separator" });
    renderedLineIndex += 1;
    for (const item of queuedItems) pushItem(item, true);
  }

  return {
    rows,
    selectableItemIds,
    renderedLineSpans,
    hasDependencies,
    queueStartIndex,
    queueItemCount: queuedItems.length,
  };
}

/**
 * Format compact single-line metrics for the footer.
 * E.g., "✓ 2 done  ▸ 2 active  · 3 queued    Lead: 5m  Thru: 4.2/hr"
 */
export function formatCompactMetrics(
  items: StatusItem[],
  sessionStartedAt?: string,
): string {
  const done = items.filter((i) => i.state === "done").length;
  const active = items.filter(
    (i) => i.state !== "done" && i.state !== "queued",
  ).length;
  const queued = items.filter((i) => i.state === "queued").length;

  const parts: string[] = [];
  if (done > 0) parts.push(`${GREEN}✓ ${done} done${RESET}`);
  if (active > 0) parts.push(`${YELLOW}▸ ${active} active${RESET}`);
  if (queued > 0) parts.push(`${DIM}· ${queued} queued${RESET}`);

  const metrics = computeSessionMetrics(items, sessionStartedAt);
  if (metrics.leadTimeMedianMs !== null) {
    parts.push(`Lead: ${formatAge(metrics.leadTimeMedianMs)}`);
  }
  if (metrics.throughputPerHour !== null) {
    parts.push(`Thru: ${metrics.throughputPerHour.toFixed(1)}/hr`);
  }

  return `  ${parts.join("  ")}`;
}

/**
 * Format a unified single-line progress summary for the footer.
 * Shows icon-prefixed state counts left-aligned and total count right-aligned.
 * E.g., "✓ 5 done  ◌ 1 verifying  ▸ 2 implementing                    8 items"
 *
 * Uses state ordering and colors from formatBatchProgress, icon style from formatCompactMetrics.
 */
export function formatUnifiedProgress(
  items: StatusItem[],
  termWidth: number = 80,
): string {
  if (items.length === 0) return "";

  const counts = new Map<ItemState, number>();
  for (const item of items) {
    counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  }

  // Order states for display: completed first, then active states, then bad, then queued
  const order: ItemState[] = [
    "done",
    "merged",
    "verifying",
    "fixing-forward",
    "review",
    "ci-pending",
    "rebasing",
    "implementing",
    "in-progress",
    "blocked",
    "ci-failed",
    "queued",
  ];

  const parts: string[] = [];
  for (const state of order) {
    const count = counts.get(state);
    if (count && count > 0) {
      const color = stateColor(state);
      const icon = stateIcon(state);
      parts.push(`${color}${icon} ${count} ${stateLabel(state).toLowerCase()}${RESET}`);
    }
  }

  const leftSide = parts.join("  ");
  const totalText = `${items.length} item${items.length !== 1 ? "s" : ""}`;

  // Compute display width of left side (strip ANSI)
  const leftPlain = stripAnsiForWidth(leftSide);
  // 2 indent + left + at least 2 spaces gap + total
  const minWidth = 2 + leftPlain.length + 2 + totalText.length;

  if (termWidth >= minWidth) {
    const gap = termWidth - 2 - leftPlain.length - totalText.length - 1;
    return `  ${leftSide}${" ".repeat(gap)}${totalText}`;
  }
  // Narrow terminal: just put total after left with 2-space gap
  return `  ${leftSide}  ${totalText}`;
}

/** Format inline collaboration status string (plain text, no ANSI). */
export function formatConnectionInline(status: CrewStatusInfo): string {
  if (!status.connected) return "Offline";
  if (status.daemonCount <= 1) return "Sharing";
  return `${status.daemonCount} online`;
}

function modeIndicatorText(viewOptions?: ViewOptions): string {
  if (!viewOptions) return "";
  const collab = viewOptions.collaborationMode;
  const review = viewOptions.reviewMode;
  if (!collab && !review) return "";

  const parts: string[] = [];
  if (collab) parts.push(collab);
  if (review) {
    const label = review === "off" ? "reviews off"
      : review === "ninthwave-prs" ? "reviews: ninthwave PRs"
      : "reviews: all PRs";
    parts.push(label);
  }
  return parts.join(" · ");
}

/**
 * Format a dim mode indicator line for the status header.
 * Shows collaboration mode and review mode inline on the main page.
 * E.g., "  local · reviews off" or "  shared · reviews: ninthwave PRs"
 * Returns empty string when no mode info is available in viewOptions.
 */
export function formatModeIndicator(viewOptions?: ViewOptions): string {
  const text = modeIndicatorText(viewOptions);
  return text ? `  ${DIM}${text}${RESET}` : "";
}

/**
 * Format a pinned queue summary line shown when queued items are scrolled off.
 * E.g., "  ↓ Queue: 5 waiting"
 */
export function formatQueueSummary(queuedCount: number): string {
  return `  ${DIM}↓ Queue: ${queuedCount} waiting${RESET}`;
}

/**
 * Format the title line with optional inline crew status and right-aligned metrics (dimmed).
 * Falls back to plain title when no metrics available or terminal is too narrow (< 60 chars).
 * E.g., "Ninthwave  M1X-87C: 2d 3a 0c 0done              Thru: 0.0/hr  Session: 12m"
 */
export function formatTitleMetrics(
  items: StatusItem[],
  termWidth: number = 80,
  sessionStartedAt?: string,
  crewStatus?: CrewStatusInfo,
  modeIndicator?: string,
): string {
  const title = `${BOLD}Ninthwave${RESET}`;
  const titlePlain = "Ninthwave";

  // Build inline connection info (brand amber)
  let crewStr = "";
  let crewPlain = "";
  if (crewStatus) {
    crewPlain = `  ${formatConnectionInline(crewStatus)}`;
    crewStr = `  ${BRAND}${formatConnectionInline(crewStatus)}${RESET}`;
  }

  const modePlain = modeIndicator ? `  ${modeIndicator}` : "";
  const modeStr = modeIndicator ? `  ${DIM}${modeIndicator}${RESET}` : "";

  const leftPlain = titlePlain + crewPlain + modePlain;

  // Compute metrics
  const metrics = computeSessionMetrics(items, sessionStartedAt);
  const metricParts: string[] = [];
  if (metrics.leadTimeMedianMs !== null) {
    metricParts.push(`Lead: ${formatAge(metrics.leadTimeMedianMs)}`);
  }
  if (metrics.throughputPerHour !== null) {
    metricParts.push(`Thru: ${metrics.throughputPerHour.toFixed(1)}/hr`);
  }
  if (metrics.sessionDurationMs !== null) {
    metricParts.push(`Session: ${formatAge(metrics.sessionDurationMs)}`);
  }

  // No metrics or terminal too narrow -- title + crew only
  if (metricParts.length === 0 || termWidth < 60) {
    return `${title}${crewStr}${modeStr}`;
  }

  const metricsStr = metricParts.join("  ");
  // Need: leftPlain.length + at least 4 spaces gap + metricsStr.length
  const minWidth = leftPlain.length + 4 + metricsStr.length;

  if (termWidth >= minWidth) {
    // Subtract 1 to leave a safety margin -- some terminals clip the last
    // character when the line fills exactly termWidth (deferred-wrap behaviour).
    const gap = termWidth - leftPlain.length - metricsStr.length - 1;
    return `${title}${crewStr}${modeStr}${" ".repeat(gap)}${DIM}${metricsStr}${RESET}`;
  }
  // Not enough room for metrics -- title + crew only
  return `${title}${crewStr}${modeStr}`;
}

/**
 * Build a FrameLayout from StatusItems, splitting the table into
 * header (column headers + summary), item rows, and footer (metrics + shortcuts).
 *
 * This is a pure function suitable for unit testing.
 */
export function buildStatusLayout(
  items: StatusItem[],
  termWidth: number = 80,
  sessionLimit?: number,
  flat: boolean = false,
  viewOptions?: ViewOptions,
  selectedItemId?: string,
): FrameLayout {
  const headerLines: string[] = [];
  const footerLines: string[] = [];

  if (items.length === 0) {
    headerLines.push(`${BOLD}Ninthwave${RESET}`);
    headerLines.push("");
    headerLines.push(...buildEmptyStateLines(viewOptions));
    return { headerLines, itemLines: [], footerLines };
  }

  const opts = viewOptions ?? {};
  const repoUrl = opts.repoUrl;
  const crewActive = opts.crewStatus != null;
  const visibleLayout = buildVisibleStatusLayoutMetadata(items, {
    flat,
    showBlockerDetail: opts.showBlockerDetail,
  });
  const hasDeps = visibleLayout.hasDependencies;

  // Inline dep indicator: 2-char slot (icon + space) before title when deps exist
  const depIndicatorWidth = hasDeps ? 2 : 0;

  const stateColWidth = computeStateColWidth(items);
  const fixedWidth = 26 + stateColWidth + depIndicatorWidth;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  // Column offset where the blocker icon sits (for aligning sub-lines)
  const blockerColOffset = 26 + stateColWidth;

  // Header: title with inline crew status + right-aligned metrics
  const inlineModeIndicator = opts.inlineModeIndicatorOnTitle
    ? modeIndicatorText(opts)
    : "";
  headerLines.push(formatTitleMetrics(
    items,
    termWidth,
    opts.sessionStartedAt,
    opts.crewStatus,
    inlineModeIndicator,
  ));

  // Mode indicator: collaboration + review state (always visible on main page)
  const modeIndicator = formatModeIndicator(viewOptions);
  if (modeIndicator && !opts.inlineModeIndicatorOnTitle) {
    headerLines.push(modeIndicator);
  }

  headerLines.push("");
  const depPad = hasDeps ? "  " : "";
  headerLines.push(`  ${DIM}  ${pad("ID", 12)}${pad("STATE", stateColWidth)} ${pad("DURATION", 8)} ${depPad}TITLE${RESET}`);
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, fixedWidth + titleWidth))}${RESET}`;
  headerLines.push(sep);

  // Build item lines
  const itemLines: string[] = [];
  for (const row of visibleLayout.rows) {
    switch (row.type) {
      case "queue-spacer":
        itemLines.push("");
        break;
      case "queue-header": {
        let queueHeader = `Queue (${row.queuedCount} waiting`;
        if (sessionLimit !== undefined) queueHeader += `, ${row.activeCount}/${sessionLimit} active sessions`;
        if (row.fixForwardCount && row.fixForwardCount > 0) queueHeader += `, ${row.fixForwardCount} fixing forward`;
        queueHeader += ")";
        itemLines.push(`  ${DIM}${queueHeader}${RESET}`);
        break;
      }
      case "queue-separator":
        itemLines.push(sep);
        break;
      case "item": {
        const depIndicator = hasDeps ? `${blockingIcon(row.blockers.length)} ` : undefined;
        if (row.queued) {
          itemLines.push(
            formatQueuedItemRow(
              row.item,
              titleWidth,
              depIndicator,
              stateColWidth,
              row.item.id === selectedItemId,
            ),
          );
        } else {
          itemLines.push(
            formatItemRow(
              row.item,
              titleWidth,
              depIndicator,
              stateColWidth,
              repoUrl,
              row.item.id === selectedItemId,
              termWidth,
            ),
          );
        }
        if (opts.showBlockerDetail && row.blockers.length > 0) {
          itemLines.push(formatBlockerSubline(row.blockers, titleWidth, row.queued, blockerColOffset));
        }
        break;
      }
    }
  }

  // Schedule worker status lines (shown after work items, before footer)
  const schedWorkers = opts.scheduleWorkers ?? [];
  if (schedWorkers.length > 0) {
    itemLines.push("");
    for (const sw of schedWorkers) {
      itemLines.push(formatScheduleWorkerLine(sw));
    }
  }

  // Footer: separator, unified progress line, strategy indicator
  footerLines.push(sep);
  footerLines.push(formatUnifiedProgress(items, termWidth));

  // Strategy indicator footer (or Ctrl+C confirmation)
  const apiWarningText = formatGitHubApiWarningText(viewOptions?.apiErrorCount, viewOptions?.apiErrorSummary, viewOptions?.rateLimitBackoffDescription);
  const apiWarning = renderGitHubApiWarning(apiWarningText);
  const updateNoticeText = formatUpdateNoticeText(viewOptions?.updateState);
  const updateNotice = renderUpdateNotice(updateNoticeText);
  const safeWidth = Math.max(0, termWidth - 1);
  if (viewOptions?.shutdownInProgress) {
    footerLines.push(`  ${RED}Closing...${RESET}`);
  } else if (viewOptions?.ctrlCPending) {
    footerLines.push(formatPendingQuitFooterLine(viewOptions.pendingQuitKey));
  } else if (viewOptions?.mergeStrategy) {
    const left = formatStrategyFooterLine(
      viewOptions.mergeStrategy,
      viewOptions.pendingStrategy,
      viewOptions.pendingStrategyCountdownSeconds,
    );
    if (apiWarning) {
      const leftLen = stripAnsiForWidth(left).length;
      const warnLen = stripAnsiForWidth(apiWarning).length;
      if (leftLen + 2 + warnLen <= safeWidth) {
        const pad = Math.max(2, safeWidth - leftLen - warnLen);
        footerLines.push(`${left}${" ".repeat(pad)}${apiWarning}`);
      } else {
        footerLines.push(left);
        const maxWarningWidth = Math.max(0, safeWidth - 2);
        const warningLine = truncateTitle(apiWarningText, maxWarningWidth);
        footerLines.push(`  ${renderGitHubApiWarning(warningLine)}`);
      }
    } else if (updateNotice) {
      const leftLen = stripAnsiForWidth(left).length;
      const noticeLen = stripAnsiForWidth(updateNotice).length;
      if (leftLen + 2 + noticeLen <= safeWidth) {
        const pad = Math.max(2, safeWidth - leftLen - noticeLen);
        footerLines.push(`${left}${" ".repeat(pad)}${updateNotice}`);
      } else {
        footerLines.push(left);
        const maxNoticeWidth = Math.max(0, safeWidth - 2);
        const noticeLine = truncateTitle(updateNoticeText, maxNoticeWidth);
        footerLines.push(`  ${renderUpdateNotice(noticeLine)}`);
      }
    } else {
      footerLines.push(left);
    }
  } else {
    // Fallback for non-TUI callers (e.g., `nw status`)
    const shortcuts = `q quit  d deps  ↑/↓ scroll`;
    footerLines.push(`  ${DIM}${shortcuts}${RESET}`);
  }

  return {
    headerLines,
    itemLines,
    footerLines,
    queueStartIndex: visibleLayout.queueStartIndex,
    visibleLayout,
  };
}

/**
 * Clamp a scroll offset to valid bounds given item count and viewport height.
 * Returns the clamped offset (0 when items fit in viewport).
 */
export function clampScrollOffset(
  scrollOffset: number,
  itemCount: number,
  viewportHeight: number,
): number {
  if (itemCount <= viewportHeight) return 0;
  const maxOffset = itemCount - viewportHeight;
  return Math.max(0, Math.min(scrollOffset, maxOffset));
}

export interface StatusVisibleLineRange {
  clampedOffset: number;
  visibleStartLineIndex: number;
  visibleEndLineIndex: number;
  viewportHeight: number;
  effectiveViewportHeight: number;
  queuePinned: boolean;
}

export function getStatusVisibleLineRange(
  layout: FrameLayout,
  termRows: number,
  scrollOffset: number,
): StatusVisibleLineRange {
  const { headerLines, itemLines, footerLines, queueStartIndex, visibleLayout } = layout;
  const baseViewport = Math.max(1, termRows - headerLines.length - footerLines.length);
  const maxOffset = Math.max(0, itemLines.length - baseViewport);
  const hasScrollUp = scrollOffset > 0;
  const hasScrollDown = scrollOffset < maxOffset && itemLines.length > baseViewport;
  const scrollIndicatorLines = (hasScrollUp ? 1 : 0) + (hasScrollDown ? 1 : 0);
  const viewportHeight = Math.max(1, termRows - headerLines.length - footerLines.length - scrollIndicatorLines);
  const clampedOffset = clampScrollOffset(scrollOffset, itemLines.length, viewportHeight);

  const queuedCount = visibleLayout?.queueItemCount
    ?? (queueStartIndex != null ? itemLines.length - queueStartIndex : 0);
  const needsQueuePin = queueStartIndex != null && queuedCount > 0;
  const queuePinned = needsQueuePin && queueStartIndex! >= clampedOffset + viewportHeight;
  const effectiveViewportHeight = queuePinned
    ? Math.max(1, viewportHeight - 1)
    : viewportHeight;

  return {
    clampedOffset,
    visibleStartLineIndex: clampedOffset,
    visibleEndLineIndex: clampedOffset + effectiveViewportHeight - 1,
    viewportHeight,
    effectiveViewportHeight,
    queuePinned,
  };
}

export function scrollStatusItemIntoView(
  layout: FrameLayout,
  termRows: number,
  scrollOffset: number,
  itemId: string,
  direction: -1 | 1,
): number {
  const span = layout.visibleLayout?.renderedLineSpans[itemId];
  if (!span) return scrollOffset;

  const currentRange = getStatusVisibleLineRange(layout, termRows, scrollOffset);
  if (span.startLineIndex >= currentRange.visibleStartLineIndex
    && span.endLineIndex <= currentRange.visibleEndLineIndex) {
    return currentRange.clampedOffset;
  }

  const visibleOffsets = new Set<number>();
  const maxCandidate = Math.max(0, layout.itemLines.length - 1);
  for (let candidate = 0; candidate <= maxCandidate; candidate++) {
    const candidateRange = getStatusVisibleLineRange(layout, termRows, candidate);
    if (span.startLineIndex >= candidateRange.visibleStartLineIndex
      && span.endLineIndex <= candidateRange.visibleEndLineIndex) {
      visibleOffsets.add(candidateRange.clampedOffset);
    }
  }

  const orderedOffsets = [...visibleOffsets].sort((a, b) => a - b);
  if (orderedOffsets.length === 0) return currentRange.clampedOffset;
  if (direction > 0) {
    return orderedOffsets.find((offset) => offset >= currentRange.clampedOffset) ?? orderedOffsets[0]!;
  }
  return [...orderedOffsets].reverse().find((offset) => offset <= currentRange.clampedOffset)
    ?? orderedOffsets[orderedOffsets.length - 1]!;
}

/**
 * Render a full-screen frame from a FrameLayout, slicing item lines to fit
 * the viewport between pinned header and footer. Adds scroll indicators
 * ("↑ N more" / "↓ N more") when items overflow.
 *
 * Returns the final lines to display (one string per terminal row).
 */
export function renderFullScreenFrame(
  layout: FrameLayout,
  termRows: number,
  termCols: number,
  scrollOffset: number,
): string[] {
  const { headerLines, itemLines, footerLines, queueStartIndex, visibleLayout } = layout;

  // Check if we need a pinned queue summary (queue exists but is entirely below the fold)
  const queuedCount = visibleLayout?.queueItemCount
    ?? (queueStartIndex != null ? itemLines.length - queueStartIndex : 0);

  // Clamp scroll offset
  const visibleRange = getStatusVisibleLineRange(layout, termRows, scrollOffset);
  const clampedOffset = visibleRange.clampedOffset;

  // If queue is scrolled off, reserve 1 line for the pinned queue summary
  const effectiveViewport = visibleRange.effectiveViewportHeight;

  // Re-slice with effective viewport
  const visibleItems = itemLines.slice(clampedOffset, clampedOffset + effectiveViewport);

  // Assemble output
  const output: string[] = [...headerLines];

  // Scroll-up indicator
  const hiddenAbove = clampedOffset;
  if (hiddenAbove > 0) {
    output.push(`  ${DIM}↑ ${hiddenAbove} more above${RESET}`);
  }

  output.push(...visibleItems);

  // Pinned queue summary when queue is below the fold
  if (visibleRange.queuePinned) {
    output.push(formatQueueSummary(queuedCount));
  }

  // Scroll-down indicator
  const hiddenBelow = Math.max(0, itemLines.length - clampedOffset - effectiveViewport);
  if (hiddenBelow > 0 && !visibleRange.queuePinned) {
    output.push(`  ${DIM}↓ ${hiddenBelow} more below${RESET}`);
  }

  output.push(...footerLines);

  return output;
}

/** Minimum terminal rows for full-screen mode. Below this, use legacy non-fullscreen rendering. */
export const MIN_FULLSCREEN_ROWS = 10;

// ─── Panel layout types ─────────────────────────────────────────────────────

/** Panel display modes for the unified TUI. */
export type PanelMode = "status-only" | "logs-only";

/** Layout geometry for the full-screen log page. */
export interface LogPanelLayout {
  /** Visible log lines (already sliced to fit). */
  lines: string[];
  /** Total number of log entries (for scroll indicators). */
  totalEntries: number;
  /** Current scroll offset into the log entries. */
  scrollOffset: number;
}

/** Full-screen page layout produced by buildPanelLayout(). */
export interface PanelLayout {
  /** The mode that was actually used (may differ from requested if terminal too small). */
  mode: PanelMode;
  /** Status panel lines (header + items, from buildStatusLayout). null in logs-only mode. */
  statusPanel: FrameLayout | null;
  /** Log panel data. null in status-only mode. */
  logPanel: LogPanelLayout | null;
  /** Footer lines pinned at the bottom (separator, progress, shortcuts). */
  footerLines: string[];
}

/** A single log entry for the log panel. */
export interface LogEntry {
  /** ISO timestamp. */
  timestamp: string;
  /** The item ID this log relates to (e.g., "H-UT-2"). */
  itemId: string;
  /** Log message text. */
  message: string;
}

// ─── Panel layout building ──────────────────────────────────────────────────

/**
 * Format a log entry as a single line for the log panel.
 * Format: "HH:MM:SS  ITEM-ID  message"
 */
function formatLogLine(entry: LogEntry, termWidth: number): string {
  let timeStr: string;
  try {
    const d = new Date(entry.timestamp);
    if (isNaN(d.getTime())) {
      timeStr = "--:--:--";
    } else {
      timeStr = d.toTimeString().slice(0, 8);
    }
  } catch {
    timeStr = "--:--:--";
  }
  const idPad = pad(entry.itemId, 12);
  const prefix = `  ${DIM}${timeStr}${RESET}  ${idPad}`;
  const prefixPlain = `  ${timeStr}  ${stripAnsiForWidth(idPad)}`;
  const available = Math.max(10, termWidth - prefixPlain.length);
  const msg = entry.message.length > available
    ? entry.message.slice(0, available - 3) + "..."
    : entry.message;
  return `${prefix}${DIM}${msg}${RESET}`;
}

/**
 * Build a PanelLayout from the given inputs.
 *
 * Layout rules:
 * - Below MIN_FULLSCREEN_ROWS (10): returns status-only with no footer (legacy flat).
 * - "logs-only": full screen of logs.
 * - "status-only": delegates entirely to buildStatusLayout().
 */
export function buildPanelLayout(
  mode: PanelMode,
  items: StatusItem[],
  logEntries: LogEntry[],
  termWidth: number,
  termRows: number,
  opts?: {
    sessionLimit?: number;
    flat?: boolean;
    viewOptions?: ViewOptions;
    logScrollOffset?: number;
    statusScrollOffset?: number;
    /** Selected item id for highlight. */
    selectedItemId?: string;
    /** Whether the log panel is in follow (auto-scroll) mode. */
    logFollowMode?: boolean;
  },
): PanelLayout {
  const logScrollOffset = opts?.logScrollOffset ?? 0;
  const selectedItemId = opts?.selectedItemId;

  // Below MIN_FULLSCREEN_ROWS: legacy flat rendering, no panels
  if (termRows < MIN_FULLSCREEN_ROWS) {
    const statusLayout = buildStatusLayout(
      items,
      termWidth,
      opts?.sessionLimit,
      opts?.flat,
      opts?.viewOptions,
      selectedItemId,
    );
    return {
      mode: "status-only",
      statusPanel: statusLayout,
      logPanel: null,
      footerLines: statusLayout.footerLines,
    };
  }

  if (mode === "status-only") {
    const statusLayout = buildStatusLayout(
      items,
      termWidth,
      opts?.sessionLimit,
      opts?.flat,
      opts?.viewOptions,
      selectedItemId,
    );
    return {
      mode: "status-only",
      statusPanel: statusLayout,
      logPanel: null,
      footerLines: statusLayout.footerLines,
    };
  }

  const footerLines = buildPanelFooter(items, logEntries.length, termWidth, opts?.viewOptions, mode, opts?.logFollowMode);
  const logViewHeight = Math.max(1, termRows - footerLines.length);
  const clampedLogOffset = clampScrollOffset(logScrollOffset, logEntries.length, logViewHeight);
  const visibleLogs = logEntries
    .slice(clampedLogOffset, clampedLogOffset + logViewHeight)
    .map((e) => formatLogLine(e, termWidth));

  return {
    mode: "logs-only",
    statusPanel: null,
    logPanel: {
      lines: visibleLogs,
      totalEntries: logEntries.length,
      scrollOffset: clampedLogOffset,
    },
    footerLines,
  };
}


/**
 * Build footer lines for panel modes.
 * Reuses the unified progress line and strategy indicator from buildStatusLayout.
 */
function buildPanelFooter(
  items: StatusItem[],
  logCount: number,
  termWidth: number,
  viewOptions?: ViewOptions,
  panelMode?: PanelMode,
  logFollowMode?: boolean,
): string[] {
  const footerLines: string[] = [];
  const sep = `  ${DIM}${"─".repeat(Math.max(1, termWidth - 4))}${RESET}`;
  footerLines.push(sep);
  footerLines.push(formatUnifiedProgress(items, termWidth));

  if (viewOptions?.shutdownInProgress) {
    footerLines.push(`  ${RED}Closing...${RESET}`);
  } else if (viewOptions?.ctrlCPending) {
    footerLines.push(formatPendingQuitFooterLine(viewOptions.pendingQuitKey));
  } else if (viewOptions?.mergeStrategy) {
    footerLines.push(
      formatStrategyFooterLine(
        viewOptions.mergeStrategy,
        viewOptions.pendingStrategy,
        viewOptions.pendingStrategyCountdownSeconds,
      ),
    );
  } else if (panelMode === "logs-only") {
    const followHint = logFollowMode === false ? "  G follow" : "";
    const shortcuts = `q quit  tab status  ↑/↓ scroll  l filter${followHint}`;
    footerLines.push(`  ${DIM}${shortcuts}${RESET}`);
  } else {
    const shortcuts = `q quit  tab logs  ↑/↓ select  enter detail`;
    footerLines.push(`  ${DIM}${shortcuts}${RESET}`);
  }

  return footerLines;
}

/**
 * Render a complete panel frame as an array of terminal lines.
 *
 * Composites the active full-screen page and footer, producing exactly termRows lines.
 */
export function renderPanelFrame(
  panelLayout: PanelLayout,
  termRows: number,
  termCols: number,
  statusScrollOffset: number = 0,
): string[] {
  const { mode, statusPanel, logPanel, footerLines } = panelLayout;

  if (mode === "status-only" && statusPanel) {
    // Use existing renderFullScreenFrame for status-only
    const fullLayout: FrameLayout = {
      headerLines: statusPanel.headerLines,
      itemLines: statusPanel.itemLines,
      footerLines,
      queueStartIndex: statusPanel.queueStartIndex,
      visibleLayout: statusPanel.visibleLayout,
    };
    const frame = renderFullScreenFrame(fullLayout, termRows, termCols, statusScrollOffset);
    return padToHeight(frame, termRows);
  }

  if (mode === "logs-only" && logPanel) {
    const output: string[] = [];

    // Calculate scroll indicators first to adjust viewport
    const hiddenAbove = logPanel.scrollOffset;
    const rawLogViewHeight = Math.max(1, termRows - footerLines.length);
    const hasLogScrollUp = hiddenAbove > 0;
    const hasLogScrollDown = logPanel.totalEntries > logPanel.scrollOffset + rawLogViewHeight;
    const logScrollLines = (hasLogScrollUp ? 1 : 0) + (hasLogScrollDown ? 1 : 0);
    const adjustedLogViewport = Math.max(1, rawLogViewHeight - logScrollLines);

    if (hasLogScrollUp) {
      output.push(`  ${DIM}↑ ${hiddenAbove} more above${RESET}`);
    }

    // Re-slice log lines to account for scroll indicators
    const visibleLogLines = logPanel.lines.slice(0, adjustedLogViewport);
    output.push(...visibleLogLines);

    const hiddenBelow = Math.max(0, logPanel.totalEntries - logPanel.scrollOffset - adjustedLogViewport);
    if (hiddenBelow > 0) {
      output.push(`  ${DIM}↓ ${hiddenBelow} more below${RESET}`);
    }

    output.push(...footerLines);
    return padToHeight(output, termRows);
  }

  return padToHeight([...footerLines], termRows);
}

/**
 * Pad an array of lines to exactly the given height.
 * Truncates if too many, appends empty lines if too few.
 */
function padToHeight(lines: string[], height: number): string[] {
  if (lines.length > height) {
    return lines.slice(0, height);
  }
  const result = [...lines];
  while (result.length < height) {
    result.push("");
  }
  return result;
}

// ─── Item detail view ───────────────────────────────────────────────────────

/**
 * Format an item detail view for the selected item.
 *
 * Shows:
 * - Item ID and title
 * - PR link (clickable via OSC 8 when repoUrl is provided)
 * - CI status with failure reason
 * - Last error / stderr tail
 * - Progress (worker heartbeat label)
 * - Cost (tokens in/out if available)
 * - Time in current state
 */
export function formatItemDetail(
  item: StatusItem,
  opts?: {
    repoUrl?: string;
    /** Worker heartbeat label (e.g., "Writing tests"). */
    progressLabel?: string;
    /** Token cost info. */
    tokensIn?: number;
    tokensOut?: number;
  },
): string[] {
  const lines: string[] = [];
  const color = stateColor(item.state);

  // Title line
  lines.push(`  ${BOLD}${item.id}${RESET}  ${item.title || item.id}`);
  lines.push("");

  // State
  lines.push(`  ${DIM}State:${RESET}     ${color}${stateIcon(item.state)} ${stateLabel(item.state)}${RESET}`);

  // PR link
  if (item.prNumber) {
    const prText = `#${item.prNumber}`;
    if (opts?.repoUrl) {
      const prUrl = `${opts.repoUrl}/pull/${item.prNumber}`;
      lines.push(`  ${DIM}PR:${RESET}        ${osc8Link(prUrl, prText)}`);
    } else {
      lines.push(`  ${DIM}PR:${RESET}        ${prText}`);
    }
  } else {
    lines.push(`  ${DIM}PR:${RESET}        ${DIM}--${RESET}`);
  }

  if (item.prNumber && item.priorPrNumbers && item.priorPrNumbers.length > 0) {
    const prChain = [...item.priorPrNumbers, item.prNumber].map((pr) => `#${pr}`).join(" → ");
    lines.push(`  ${DIM}PRs:${RESET}       ${prChain}`);
  }

  // Failure / CI status
  if (item.state === "blocked" && item.failureReason) {
    pushWrappedDetailField(lines, "Blocked", item.failureReason, YELLOW);
  } else if (item.failureReason) {
    pushWrappedDetailField(lines, "CI", item.failureReason, RED);
  } else if (item.state === "ci-failed") {
    lines.push(`  ${DIM}CI:${RESET}        ${RED}Failed${RESET}`);
  } else if (item.state === "blocked") {
    lines.push(`  ${DIM}Blocked:${RESET}   ${YELLOW}Waiting for intervention${RESET}`);
  } else if (item.state === "ci-pending") {
    lines.push(`  ${DIM}CI:${RESET}        ${CYAN}Pending${RESET}`);
  } else if (item.state === "verifying") {
    lines.push(`  ${DIM}CI:${RESET}        ${CYAN}Verifying${RESET}`);
  } else if (item.state === "fixing-forward") {
    lines.push(`  ${DIM}CI:${RESET}        ${RED}Fixing Forward${RESET}`);
  } else if (item.state === "done" || item.state === "merged" || item.state === "review") {
    lines.push(`  ${DIM}CI:${RESET}        ${GREEN}Passed${RESET}`);
  }

  // Last error (stderr tail)
  if (item.stderrTail) {
    const firstLine = item.stderrTail.split("\n").filter((l) => l.trim())[0];
    if (firstLine) {
      const trimmed = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
      lines.push(`  ${DIM}Error:${RESET}     ${RED}${trimmed}${RESET}`);
    }
  }

  // Progress label
  const progressText = shouldShowItemProgress(item)
    ? formatInlineProgress(item.progress!, item.progressLabel ?? opts?.progressLabel, 48)
    : undefined;
  if (progressText) {
    lines.push(`  ${DIM}Progress:${RESET}  ${progressText}`);
  } else if (opts?.progressLabel) {
    lines.push(`  ${DIM}Progress:${RESET}  ${opts.progressLabel}`);
  }

  // Cost
  if (opts?.tokensIn != null || opts?.tokensOut != null) {
    const parts: string[] = [];
    if (opts?.tokensIn != null) parts.push(`${opts.tokensIn.toLocaleString()} in`);
    if (opts?.tokensOut != null) parts.push(`${opts.tokensOut.toLocaleString()} out`);
    lines.push(`  ${DIM}Cost:${RESET}      ${parts.join(", ")} tokens`);
  }

  // Time in state
  const duration = formatDuration(item);
  if (duration && duration !== "-") {
    lines.push(`  ${DIM}Duration:${RESET}  ${duration}`);
  }

  if (item.workspaceRef && muxTypeForWorkspaceRef(item.workspaceRef) === "headless") {
    lines.push(`  ${DIM}Runtime:${RESET}   detached headless worker`);
  }

  // Inbox state
  if (item.inboxWaitingSince || (item.inboxPendingCount != null && item.inboxPendingCount > 0)) {
    const parts: string[] = [];
    if (item.inboxWaitingSince) {
      const waitMs = Date.now() - new Date(item.inboxWaitingSince).getTime();
      parts.push(`${CYAN}waiting${RESET} ${formatAge(waitMs)}`);
    }
    if (item.inboxPendingCount != null && item.inboxPendingCount > 0) {
      parts.push(`${YELLOW}${item.inboxPendingCount} pending${RESET}`);
    }
    lines.push(`  ${DIM}Inbox:${RESET}     ${parts.join(", ")}`);
  }

  if (item.inboxNamespace) {
    lines.push(`  ${DIM}Namespace:${RESET} ${item.inboxNamespace}`);
  }

  if (item.inboxLastActivity) {
    const actMs = Date.now() - new Date(item.inboxLastActivity).getTime();
    lines.push(`  ${DIM}Last msg:${RESET}  ${formatAge(actMs)} ago`);
  }

  return lines;
}

// ─── Help overlay ────────────────────────────────────────────────────────────

export function renderCenteredOverlay(
  termWidth: number,
  termRows: number,
  opts: {
    title: string;
    contentLines: string[];
    hint: string;
    titleColor?: string;
  },
): string[] {
  const {
    title,
    contentLines,
    hint,
    titleColor = RESET,
  } = opts;
  const maxContentWidth = Math.max(
    title.length,
    hint.length,
    ...contentLines.map((line) => stripAnsiForWidth(line).length),
  );
  const innerWidth = Math.min(maxContentWidth + 4, termWidth - 4);
  const boxWidth = innerWidth + 2;
  const leftMargin = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  const marginPad = " ".repeat(leftMargin);
  const boxLines: string[] = [];

  boxLines.push(`${marginPad}┌${"─".repeat(innerWidth)}┐`);

  const titlePad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(titlePad)}${BOLD}${titleColor}${title}${RESET}${" ".repeat(Math.max(0, innerWidth - titlePad - title.length))}│`);
  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);

  const maxContentDisplay = innerWidth - 2;
  for (const line of contentLines) {
    const displayLen = stripAnsiForWidth(line).length;
    let rendered = line;
    if (displayLen > maxContentDisplay) {
      let visible = 0;
      let cutIdx = 0;
      const plain = stripAnsiForWidth(line);
      for (let i = 0; i < plain.length && visible < maxContentDisplay - 3; i++) {
        visible++;
        cutIdx = i + 1;
      }
      rendered = plain.slice(0, cutIdx) + "...";
    }
    const renderedLen = stripAnsiForWidth(rendered).length;
    const rightPad = Math.max(0, innerWidth - 2 - renderedLen);
    boxLines.push(`${marginPad}│  ${rendered}${" ".repeat(rightPad)}│`);
  }

  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);
  const hintPad = Math.max(0, Math.floor((innerWidth - hint.length) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(hintPad)}${DIM}${hint}${RESET}${" ".repeat(Math.max(0, innerWidth - hintPad - hint.length))}│`);
  boxLines.push(`${marginPad}└${"─".repeat(innerWidth)}┘`);

  const totalBoxHeight = boxLines.length;
  const topPad = Math.max(0, Math.floor((termRows - totalBoxHeight) / 2));
  const output: string[] = [];
  for (let i = 0; i < topPad; i++) output.push("");
  output.push(...boxLines);
  while (output.length < termRows) output.push("");
  return output.slice(0, termRows);
}

export function renderStartupOverlay(
  termWidth: number,
  termRows: number,
  overlay: StartupOverlayState,
): string[] {
  const title = overlay.title ?? (overlay.tone === "error" ? "Startup failed" : "Loading");
  const titleColor = overlay.tone === "error" ? RED : CYAN;
  const contentLines = [
    `${BOLD}${titleColor}${overlay.phaseLabel}${RESET}`,
    ...(overlay.detailLines?.map((line) => `${DIM}${line}${RESET}`) ?? []),
  ];
  return renderCenteredOverlay(termWidth, termRows, {
    title,
    contentLines,
    hint: overlay.hint ?? "Actions stay blocked until startup completes",
    titleColor,
  });
}

/**
 * Render the full-screen help overlay as an array of lines.
 * This is a pure function -- no side effects, no terminal writes.
 *
 * Content:
 * - Metrics explanations (Lead time, Throughput, Session)
 * - Merge strategies with icons/colors from strategyIndicator()
 * - Keyboard shortcuts
 * - Credits
 *
 * The overlay uses box-drawing characters for the border.
 * Content is horizontally centered within the terminal width.
 */
export function renderHelpOverlay(
  termWidth: number,
  termRows: number,
  sessionCode?: string,
  tmuxSessionName?: string,
  version?: string,
): string[] {
  // ── Build content lines (plain text, no padding yet) ──────────────

  // Pad key to a fixed visible width so all descriptions align at the same column.
  // Widest key is "Throughput" (10 chars); pad to 12 for a 2-char minimum gap.
  const KEY_WIDTH = 12;
  const helpLine = (key: string, desc: string): string => {
    const visible = stripAnsiForWidth(key).length;
    const gap = " ".repeat(Math.max(2, KEY_WIDTH - visible));
    return `  ${key}${gap}${desc}`;
  };

  const sections: string[][] = [];

  // Session section (if sharing via ninthwave.sh)
  if (sessionCode) {
    sections.push([
      `${BOLD}Session${RESET}`,
      `  ${BRAND}${sessionCode}${RESET}`,
      `  ${DIM}Dashboard: ${BRAND}ninthwave.sh${RESET}${DIM}/stats/${sessionCode}${RESET}`,
      `  ${DIM}Join:      nw watch --crew ${sessionCode}${RESET}`,
    ]);
  }

  // Tmux section (when running outside tmux)
  if (tmuxSessionName) {
    sections.push([
      `${BOLD}Tmux${RESET}`,
      `  Attach with: ${CYAN}tmux attach -t ${tmuxSessionName}${RESET}`,
    ]);
  }

  // Metrics section
  sections.push([
    `${BOLD}Metrics${RESET}`,
    helpLine("Lead time", "Median start-to-merge duration"),
    helpLine("Throughput", "Merged items per hour"),
    helpLine("Session", "Time since orchestrator start"),
  ]);

  // Merge strategies section -- reuse strategyIndicator() for icons/colors
  sections.push([
    `${BOLD}Merge Strategies${RESET}`,
    helpLine(strategyIndicator("auto"), "CI must pass -> ninthwave auto-merges"),
    helpLine(strategyIndicator("manual"), "CI must pass -> human merges the PR"),
    helpLine(strategyIndicator("bypass"), "CI must pass -> admin merge skips human approval requirements"),
  ]);

  // Keyboard shortcuts section
  sections.push([
    `${BOLD}Keyboard Shortcuts${RESET}`,
    helpLine("Tab", "Toggle status/log pages"),
    helpLine("c", "Open runtime controls"),
    helpLine("Shift+Tab", "Cycle merge strategy"),
    helpLine("+/-", "Adjust session limit"),
    helpLine("?", "Toggle this help overlay"),
    helpLine("Enter/i", "Item detail panel"),
    helpLine("Escape", "Close overlay / pause or resume dashboard"),
    helpLine("p", "Pause or resume dashboard"),
    helpLine("q x2", "Quit (double-tap) from any TUI state"),
    helpLine("Ctrl+C x2", "Quit (double-tap)"),
    helpLine("d", "Toggle blocker sub-lines"),
    helpLine("x", "Extend worker timeout"),
    helpLine("Up/Down", "Navigate items / scroll logs"),
    helpLine("j/k", "Scroll logs (logs page)"),
  ]);

  // Version footer is rendered as a centered line below the content (like the old hint).

  // ── Flatten sections with blank separators ─────────────────────────

  const contentLines: string[] = [];
  for (let s = 0; s < sections.length; s++) {
    if (s > 0) contentLines.push(""); // blank line between sections
    contentLines.push(...sections[s]!);
  }

  const ver = version || "unknown";
  const hint = `Ninthwave v${ver}`;
  const fixedBoxLines = 6;
  const maxContentLines = Math.max(0, termRows - fixedBoxLines);
  const visibleContentLines = contentLines.length <= maxContentLines
    ? contentLines
    : maxContentLines <= 0
      ? []
      : [
          ...contentLines.slice(0, Math.max(0, maxContentLines - 1)),
          `${DIM}...${RESET}`,
        ];

  // ── Compute box dimensions ─────────────────────────────────────────

  const maxContentWidth = Math.max(
    hint.length,
    ...visibleContentLines.map((l) => stripAnsiForWidth(l).length),
  );
  // Box inner width: at least content width + 2 padding chars each side
  const innerWidth = Math.min(maxContentWidth + 4, termWidth - 4);
  const boxWidth = innerWidth + 2; // +2 for left/right border chars

  // ── Draw box ───────────────────────────────────────────────────────

  const boxLines: string[] = [];
  const leftMargin = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  const pad = " ".repeat(leftMargin);

  // Top border
  boxLines.push(`${pad}┌${"─".repeat(innerWidth)}┐`);

  // Title
  const title = "Help";
  const titlePad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
  boxLines.push(`${pad}│${" ".repeat(titlePad)}${BOLD}${title}${RESET}${" ".repeat(Math.max(0, innerWidth - titlePad - title.length))}│`);
  boxLines.push(`${pad}│${" ".repeat(innerWidth)}│`);

  // Content lines (truncate if wider than available space)
  const maxContentDisplay = innerWidth - 2; // 2 chars left padding
  for (const line of visibleContentLines) {
    const displayLen = stripAnsiForWidth(line).length;
    let rendered = line;
    if (displayLen > maxContentDisplay) {
      // Truncate plain text to fit -- find the cut point accounting for ANSI codes
      let visible = 0;
      let cutIdx = 0;
      const plain = stripAnsiForWidth(line);
      // Walk the plain text to find where to cut
      for (let i = 0; i < plain.length && visible < maxContentDisplay - 3; i++) {
        visible++;
        cutIdx = i + 1;
      }
      // Rebuild: take the truncated plain text + "..."
      // Since ANSI escapes make slicing hard, use the plain text directly for overflow cases
      rendered = plain.slice(0, cutIdx) + "...";
    }
    const renderedLen = stripAnsiForWidth(rendered).length;
    const rightPad = Math.max(0, innerWidth - 2 - renderedLen);
    boxLines.push(`${pad}│  ${rendered}${" ".repeat(rightPad)}│`);
  }

  // Empty line before footer hint
  boxLines.push(`${pad}│${" ".repeat(innerWidth)}│`);

  // Footer hint
  const hintPad = Math.max(0, Math.floor((innerWidth - hint.length) / 2));
  boxLines.push(`${pad}│${" ".repeat(hintPad)}${DIM}${hint}${RESET}${" ".repeat(Math.max(0, innerWidth - hintPad - hint.length))}│`);

  // Bottom border
  boxLines.push(`${pad}└${"─".repeat(innerWidth)}┘`);

  // ── Vertically center the box ──────────────────────────────────────

  const totalBoxHeight = boxLines.length;
  const topPad = Math.max(0, Math.floor((termRows - totalBoxHeight) / 2));

  const output: string[] = [];
  for (let i = 0; i < topPad; i++) {
    output.push("");
  }
  output.push(...boxLines);
  // Fill remaining rows so the overlay covers the full screen
  while (output.length < termRows) {
    output.push("");
  }

  return output.slice(0, termRows);
}

// ─── Controls overlay ───────────────────────────────────────────────────────

/**
 * Render the paused overlay using the same boxed modal style as other TUI overlays.
 */
export function renderPausedOverlay(
  termWidth: number,
  termRows: number,
  opts?: {
    ctrlCPending?: boolean;
    pendingQuitKey?: QuitConfirmKey;
    shutdownInProgress?: boolean;
  },
): string[] {
  const overlayTitle = "Paused";
  const contentLines = [
    `${BOLD}${YELLOW}Watch controls are paused.${RESET}`,
  ];
  const overlayHint = opts?.shutdownInProgress
    ? `${RED}Closing...${RESET}`
    : opts?.ctrlCPending
      ? formatPendingQuitFooterLine(opts.pendingQuitKey).trimStart()
    : `${formatShortcutHint("p", "resume")}  ${formatShortcutHint("q", "quit")}`;
  const overlayHintWidth = stripAnsiForWidth(overlayHint).length;

  const maxContentWidth = Math.max(
    overlayTitle.length,
    overlayHintWidth,
    ...contentLines.map((line) => stripAnsiForWidth(line).length),
  );
  const innerWidth = Math.min(maxContentWidth + 4, termWidth - 4);
  const boxWidth = innerWidth + 2;
  const leftMargin = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  const marginPad = " ".repeat(leftMargin);
  const boxLines: string[] = [];

  boxLines.push(`${marginPad}┌${"─".repeat(innerWidth)}┐`);

  const titlePad = Math.max(0, Math.floor((innerWidth - overlayTitle.length) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(titlePad)}${BOLD}${overlayTitle}${RESET}${" ".repeat(Math.max(0, innerWidth - titlePad - overlayTitle.length))}│`);
  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);

  for (const line of contentLines) {
    const plain = stripAnsiForWidth(line);
    const renderedPlain = truncateTitle(plain, Math.max(0, innerWidth - 2));
    const rendered = renderedPlain === plain ? line : renderedPlain;
    const renderedLen = stripAnsiForWidth(rendered).length;
    const linePad = Math.max(0, Math.floor((innerWidth - renderedLen) / 2));
    boxLines.push(`${marginPad}│${" ".repeat(linePad)}${rendered}${" ".repeat(Math.max(0, innerWidth - linePad - renderedLen))}│`);
  }

  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);
  const hintPad = Math.max(0, Math.floor((innerWidth - overlayHintWidth) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(hintPad)}${DIM}${overlayHint}${RESET}${" ".repeat(Math.max(0, innerWidth - hintPad - overlayHintWidth))}│`);
  boxLines.push(`${marginPad}└${"─".repeat(innerWidth)}┘`);

  const totalBoxHeight = boxLines.length;
  const topPad = Math.max(0, Math.floor((termRows - totalBoxHeight) / 2));
  const output: string[] = [];
  for (let i = 0; i < topPad; i++) {
    output.push("");
  }
  output.push(...boxLines);
  while (output.length < termRows) {
    output.push("");
  }
  return output.slice(0, termRows);
}

export { collaborationLabel, reviewModeLabel } from "./tui-settings.ts";

/**
 * Render a full-screen controls overlay for runtime settings.
 * Styled identically to renderHelpOverlay() -- box-drawing border, centered.
 * Rows are navigated with arrows; the active row and active value are highlighted separately.
 */
export function renderControlsOverlay(
  termWidth: number,
  termRows: number,
  opts: {
    collaborationMode: CollaborationMode;
    pendingCollaborationMode?: CollaborationMode;
    collaborationIntent?: CollaborationIntent;
    sessionCode?: string;
    collaborationJoinInputActive?: boolean;
    collaborationJoinInputValue?: string;
    collaborationBusy?: boolean;
    collaborationError?: string;
    reviewMode: ReviewMode;
    pendingReviewMode?: ReviewMode;
    scheduleEnabled?: boolean;
    pendingScheduleEnabled?: boolean;
    mergeStrategy: MergeStrategy;
    pendingMergeStrategy?: MergeStrategy;
    bypassEnabled: boolean;
    sessionLimit?: number;
    pendingSessionLimit?: number;
    activeRowIndex?: number;
  },
): string[] {
  const {
    collaborationMode,
    pendingCollaborationMode,
    collaborationIntent,
    sessionCode,
    collaborationJoinInputActive: _collaborationJoinInputActive = false,
    collaborationJoinInputValue: _collaborationJoinInputValue = "",
    collaborationBusy: _collaborationBusy = false,
    collaborationError: _collaborationError,
    reviewMode,
    pendingReviewMode,
    scheduleEnabled = false,
    pendingScheduleEnabled,
    mergeStrategy,
    pendingMergeStrategy,
    bypassEnabled,
    sessionLimit,
    pendingSessionLimit,
    activeRowIndex = 0,
  } = opts;

  const labelWidth = Math.max(...TUI_SETTINGS_ROWS.map((row) => row.title.length));
  const clampedActiveRowIndex = Math.max(0, Math.min(activeRowIndex, TUI_SETTINGS_ROWS.length - 1));

  const renderChoiceValue = (
    rowId: string,
    option: { runtimeValue: string; runtimeLabel: string },
    selected: boolean,
    pending: boolean,
  ): string => {
    const baseLabel = rowId === "merge_strategy"
      ? `${stripAnsiForWidth(strategyIndicator(option.runtimeValue as MergeStrategy)).split(" ")[0]} ${option.runtimeLabel}`
      : option.runtimeLabel;
    const displayLabel = pending ? `${baseLabel} pending` : baseLabel;
    return selected
      ? `${BOLD}[${displayLabel}]${RESET}`
      : `${DIM}${baseLabel}${RESET}`;
  };

  const introLines: string[] = [
    `${DIM}↑/↓ choose row  ←/→ change value  Enter/Esc close${RESET}`,
    "",
  ];

  const selectedCollaborationMode = pendingCollaborationMode
    ?? (collaborationIntent ? collaborationIntentToMode(collaborationIntent) : collaborationMode);
  const joinInputActive = _collaborationJoinInputActive || collaborationIntent === "join";
  const collaborationDetailLines: string[] = [];
  const joinCommand = sessionCode ? `nw watch --crew ${sessionCode}` : undefined;

  if (sessionCode) {
    collaborationDetailLines.push(
      `  ${DIM}Code:${RESET}    ${BRAND}${sessionCode}${RESET}`,
      `  ${DIM}Command:${RESET}`,
      `    ${joinCommand}`,
    );
  }

  if (joinInputActive) {
    const joinInputDisplay = _collaborationJoinInputValue.trim() || "enter code";
    collaborationDetailLines.push(`  ${DIM}Join code:${RESET} ${BOLD}[${joinInputDisplay}]${RESET}`);
  }

  if (_collaborationBusy) {
    const busyLabel = selectedCollaborationMode === "shared"
      ? "Starting shared session..."
      : selectedCollaborationMode === "joined"
        ? "Joining session..."
        : "Returning to local mode...";
    collaborationDetailLines.push(`  ${DIM}Status:${RESET}  ${CYAN}${busyLabel}${RESET}`);
  }

  if (pendingCollaborationMode && pendingCollaborationMode !== collaborationMode) {
    collaborationDetailLines.push(`  ${DIM}Pending:${RESET} ${CYAN}${collaborationLabel(pendingCollaborationMode)}${RESET} until engine confirms`);
  }

  if (_collaborationError) {
    collaborationDetailLines.push(`  ${DIM}Error:${RESET}   ${RED}${_collaborationError}${RESET}`);
  }

  if (collaborationDetailLines.length === 0) {
    collaborationDetailLines.push(
      `  ${DIM}Share creates a live session code and invite command.${RESET}`,
      `  ${DIM}Join opens a session-code prompt in this overlay.${RESET}`,
    );
  }

  const settingsLines: string[] = [];
  let collaborationInsertIndex = 0;

  for (const [rowIndex, row] of TUI_SETTINGS_ROWS.entries()) {
    const active = rowIndex === clampedActiveRowIndex;
    const rowPrefix = active ? `${CYAN}>${RESET}` : " ";
    const title = active
      ? `${BOLD}${CYAN}${row.title}${RESET}`
      : `${BOLD}${row.title}${RESET}`;
    const titleCell = `${title}${" ".repeat(Math.max(0, labelWidth - row.title.length))}`;

    if (row.kind === "choice") {
      const selectedValue = row.id === "collaboration_mode"
        ? selectedCollaborationMode
        : row.id === "schedule_enabled"
          ? scheduleEnabledToMode(pendingScheduleEnabled ?? scheduleEnabled)
        : row.id === "review_mode"
          ? (pendingReviewMode ?? reviewMode)
          : (pendingMergeStrategy ?? mergeStrategy);
      const choiceLine = runtimeOptionsForSettingsRow(row, bypassEnabled)
        .map((option) => {
          const pending = row.id === "collaboration_mode"
            ? option.runtimeValue === pendingCollaborationMode && pendingCollaborationMode !== collaborationMode
            : row.id === "schedule_enabled"
              ? option.runtimeValue === scheduleEnabledToMode(pendingScheduleEnabled ?? scheduleEnabled)
                && pendingScheduleEnabled !== undefined
                && pendingScheduleEnabled !== scheduleEnabled
            : row.id === "review_mode"
              ? option.runtimeValue === pendingReviewMode && pendingReviewMode !== reviewMode
              : option.runtimeValue === pendingMergeStrategy && pendingMergeStrategy !== mergeStrategy;
          return renderChoiceValue(row.id, option, option.runtimeValue === selectedValue, pending);
        })
        .join("  ");
      settingsLines.push(`${rowPrefix} ${titleCell}  ${choiceLine}`);
      if (row.id === "collaboration_mode") {
        collaborationInsertIndex = settingsLines.length;
      }
      continue;
    }

    const displayedSessionLimit = pendingSessionLimit ?? sessionLimit;
    const sessionDisplay = displayedSessionLimit !== undefined ? `${displayedSessionLimit}` : "auto";
    const pendingSuffix = pendingSessionLimit !== undefined && pendingSessionLimit !== sessionLimit ? " pending" : "";
    const value = `${BOLD}[${sessionDisplay}${pendingSuffix}]${RESET}`;
    settingsLines.push(`${rowPrefix} ${titleCell}  ${value}`);
  }

  const fixedBoxLines = 6;
  const maxDetailLines = Math.max(0, termRows - fixedBoxLines - introLines.length - settingsLines.length);
  const visibleCollaborationDetailLines = collaborationDetailLines.length <= maxDetailLines
    ? collaborationDetailLines
    : maxDetailLines <= 0
      ? []
      : [
          ...collaborationDetailLines.slice(0, Math.max(0, maxDetailLines - 1)),
          `  ${DIM}...${RESET}`,
        ];

  const contentLines: string[] = [
    ...introLines,
    ...settingsLines.slice(0, collaborationInsertIndex),
    ...visibleCollaborationDetailLines,
    ...settingsLines.slice(collaborationInsertIndex),
  ];

  const overlayTitle = "Controls";
  const overlayHint = "Press Enter or Escape to close";

  // Compute box dimensions
  const maxContentWidth = Math.max(
    overlayTitle.length,
    overlayHint.length,
    ...contentLines.map((l) => stripAnsiForWidth(l).length),
  );
  const innerWidth = Math.min(maxContentWidth + 4, termWidth - 4);
  const boxWidth = innerWidth + 2;

  // Draw box
  const boxLines: string[] = [];
  const leftMargin = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  const marginPad = " ".repeat(leftMargin);

  boxLines.push(`${marginPad}┌${"─".repeat(innerWidth)}┐`);

  const titlePad = Math.max(0, Math.floor((innerWidth - overlayTitle.length) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(titlePad)}${BOLD}${overlayTitle}${RESET}${" ".repeat(Math.max(0, innerWidth - titlePad - overlayTitle.length))}│`);
  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);

  const maxContentDisplay = innerWidth - 2;
  for (const line of contentLines) {
    const displayLen = stripAnsiForWidth(line).length;
    let rendered = line;
    if (displayLen > maxContentDisplay) {
      let visible = 0;
      let cutIdx = 0;
      const plain = stripAnsiForWidth(line);
      for (let i = 0; i < plain.length && visible < maxContentDisplay - 3; i++) {
        visible++;
        cutIdx = i + 1;
      }
      rendered = plain.slice(0, cutIdx) + "...";
    }
    const renderedLen = stripAnsiForWidth(rendered).length;
    const rightPad = Math.max(0, innerWidth - 2 - renderedLen);
    boxLines.push(`${marginPad}│  ${rendered}${" ".repeat(rightPad)}│`);
  }

  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);
  const hintPad = Math.max(0, Math.floor((innerWidth - overlayHint.length) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(hintPad)}${DIM}${overlayHint}${RESET}${" ".repeat(Math.max(0, innerWidth - hintPad - overlayHint.length))}│`);
  boxLines.push(`${marginPad}└${"─".repeat(innerWidth)}┘`);

  // Vertically center
  const totalBoxHeight = boxLines.length;
  const topPad = Math.max(0, Math.floor((termRows - totalBoxHeight) / 2));

  const output: string[] = [];
  for (let i = 0; i < topPad; i++) {
    output.push("");
  }
  output.push(...boxLines);
  while (output.length < termRows) {
    output.push("");
  }
  return output.slice(0, termRows);
}

// ─── Detail overlay ─────────────────────────────────────────────────────────

/**
 * Render a full-screen detail overlay for a single work item.
 * Styled identically to renderHelpOverlay() -- box-drawing border, centered.
 */
export function renderDetailOverlay(
  item: StatusItem,
  termWidth: number,
  termRows: number,
  opts?: {
    repoUrl?: string;
    progressLabel?: string;
    tokensIn?: number;
    tokensOut?: number;
    priority?: string;
    dependencies?: string[];
    ciFailCount?: number;
    retryCount?: number;
    /** Scroll offset within the detail content region (0 = top). */
    scrollOffset?: number;
    /** Full description body to render in a scrollable region (overrides descriptionSnippet). */
    descriptionBody?: string;
  },
): { lines: string[]; totalContentLines: number } {
  // ── Build content lines from formatItemDetail + extras ────────────

  const contentLines: string[] = [];

  // Core detail lines
  const coreLines = formatItemDetail(item, {
    repoUrl: opts?.repoUrl,
    progressLabel: opts?.progressLabel,
    tokensIn: opts?.tokensIn,
    tokensOut: opts?.tokensOut,
  });
  contentLines.push(...coreLines);

  // Extra fields from orchestrator data
  if (opts?.priority) {
    contentLines.push(`  ${DIM}Priority:${RESET}  ${opts.priority}`);
  }

  if (opts?.dependencies && opts.dependencies.length > 0) {
    contentLines.push(`  ${DIM}Depends:${RESET}   ${opts.dependencies.join(", ")}`);
  }

  if (opts?.ciFailCount != null && opts.ciFailCount > 0) {
    contentLines.push(`  ${DIM}CI fails:${RESET}  ${opts.ciFailCount}`);
  }

  if (opts?.retryCount != null && opts.retryCount > 0) {
    contentLines.push(`  ${DIM}Retries:${RESET}   ${opts.retryCount}`);
  }

  if (item.requiresManualReview) {
    contentLines.push(`  ${DIM}Merge hold:${RESET} manual review required`);
  }

  if (item.worktreePath) {
    contentLines.push(`  ${DIM}Worktree:${RESET}  ${item.worktreePath}`);
  }

  if (item.workspaceRef) {
    contentLines.push(`  ${DIM}Workspace:${RESET} ${item.workspaceRef}`);
    const workspaceBackend = muxTypeForWorkspaceRef(item.workspaceRef);
    if (workspaceBackend === "headless") {
      contentLines.push(`  ${DIM}Mode:${RESET}      detached headless worker`);
    } else if (workspaceBackend === "tmux") {
      // Show tmux attach hint for tmux-style refs (session:window)
      const colonIdx = item.workspaceRef.indexOf(":");
      if (colonIdx > 0) {
        const session = item.workspaceRef.slice(0, colonIdx);
        contentLines.push(`  ${DIM}Attach:${RESET}    tmux attach -t ${session}`);
      }
    }
  }

  // Full description body: wrap and append as a scrollable region
  if (opts?.descriptionBody) {
    const wrapWidth = Math.min(72, termWidth - 12);
    const wrappedBody = formatDescriptionBodyLines(opts.descriptionBody, wrapWidth);
    if (wrappedBody.length > 0) {
      contentLines.push("");
      contentLines.push(`  ${DIM}${"─".repeat(40)}${RESET}`);
      contentLines.push(`  ${BOLD}Description${RESET}`);
      contentLines.push("");
      for (const line of wrappedBody) {
        contentLines.push(`  ${line}`);
      }
    }
  }

  // ── Compute box dimensions ─────────────────────────────────────────

  const maxContentWidth = Math.max(
    ...contentLines.map((l) => stripAnsiForWidth(l).length),
  );
  const innerWidth = Math.min(maxContentWidth + 4, termWidth - 4);
  const boxWidth = innerWidth + 2;

  // ── Determine scrollable viewport ──────────────────────────────────
  // Reserve: top border (1), title (1), blank (1), blank before footer (1),
  // footer hint (1), bottom border (1) = 6 chrome lines.
  // Also reserve 1 line each for scroll indicators when content overflows.

  const chromeLines = 6;
  const maxViewportHeight = termRows - chromeLines - 2; // 2 for vertical centering margin
  const totalContentLines = contentLines.length;
  const needsScroll = totalContentLines > maxViewportHeight && maxViewportHeight > 0;
  const viewportHeight = needsScroll ? maxViewportHeight : totalContentLines;

  const scrollOffset = Math.max(0, Math.min(
    opts?.scrollOffset ?? 0,
    Math.max(0, totalContentLines - viewportHeight),
  ));

  const visibleContent = contentLines.slice(scrollOffset, scrollOffset + viewportHeight);

  // ── Draw box ───────────────────────────────────────────────────────

  const boxLines: string[] = [];
  const leftMargin = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  const margin = " ".repeat(leftMargin);

  // Top border
  boxLines.push(`${margin}┌${"─".repeat(innerWidth)}┐`);

  // Title
  const title = item.id;
  const titlePad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
  boxLines.push(`${margin}│${" ".repeat(titlePad)}${BOLD}${title}${RESET}${" ".repeat(Math.max(0, innerWidth - titlePad - title.length))}│`);
  boxLines.push(`${margin}│${" ".repeat(innerWidth)}│`);

  // Scroll-up indicator
  if (needsScroll && scrollOffset > 0) {
    const upHint = "▲ scroll up";
    const upPad = Math.max(0, Math.floor((innerWidth - upHint.length) / 2));
    boxLines.push(`${margin}│${" ".repeat(upPad)}${DIM}${upHint}${RESET}${" ".repeat(Math.max(0, innerWidth - upPad - upHint.length))}│`);
  }

  // Content lines (scrolled viewport)
  const maxContentDisplay = innerWidth - 2;
  for (const line of visibleContent) {
    const displayLen = stripAnsiForWidth(line).length;
    let rendered = line;
    if (displayLen > maxContentDisplay) {
      let visible = 0;
      let cutIdx = 0;
      const plain = stripAnsiForWidth(line);
      for (let i = 0; i < plain.length && visible < maxContentDisplay - 3; i++) {
        visible++;
        cutIdx = i + 1;
      }
      rendered = plain.slice(0, cutIdx) + "...";
    }
    const renderedLen = stripAnsiForWidth(rendered).length;
    const rightPad = Math.max(0, innerWidth - 2 - renderedLen);
    boxLines.push(`${margin}│  ${rendered}${" ".repeat(rightPad)}│`);
  }

  // Scroll-down indicator
  if (needsScroll && scrollOffset + viewportHeight < totalContentLines) {
    const downHint = "▼ scroll down";
    const downPad = Math.max(0, Math.floor((innerWidth - downHint.length) / 2));
    boxLines.push(`${margin}│${" ".repeat(downPad)}${DIM}${downHint}${RESET}${" ".repeat(Math.max(0, innerWidth - downPad - downHint.length))}│`);
  }

  // Empty line before footer hint
  boxLines.push(`${margin}│${" ".repeat(innerWidth)}│`);

  // Footer hint
  const hint = needsScroll ? "↑/↓ scroll · Escape to close" : "Press Escape to close";
  const hintPad = Math.max(0, Math.floor((innerWidth - hint.length) / 2));
  boxLines.push(`${margin}│${" ".repeat(hintPad)}${DIM}${hint}${RESET}${" ".repeat(Math.max(0, innerWidth - hintPad - hint.length))}│`);

  // Bottom border
  boxLines.push(`${margin}└${"─".repeat(innerWidth)}┘`);

  // ── Vertically center the box ──────────────────────────────────────

  const totalBoxHeight = boxLines.length;
  const topPadding = Math.max(0, Math.floor((termRows - totalBoxHeight) / 2));

  const result: string[] = [];
  for (let i = 0; i < topPadding; i++) {
    result.push("");
  }
  result.push(...boxLines);
  while (result.length < termRows) {
    result.push("");
  }

  return { lines: result, totalContentLines };
}

/**
 * Compute the maximum scroll offset for the detail overlay content.
 * Returns the number of lines that overflow the viewport (0 if no scrolling needed).
 */
export function detailOverlayMaxScroll(
  totalContentLines: number,
  termRows: number,
): number {
  const chromeLines = 6;
  const maxViewportHeight = termRows - chromeLines - 2;
  if (totalContentLines <= maxViewportHeight || maxViewportHeight <= 0) return 0;
  return totalContentLines - maxViewportHeight;
}
