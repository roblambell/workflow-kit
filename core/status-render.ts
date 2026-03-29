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
import type { MergeStrategy } from "./orchestrator.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

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

export interface ViewOptions {
  showBlockerDetail?: boolean;
  sessionStartedAt?: string;
  /** Base repository URL for PR hyperlinks (e.g., "https://github.com/org/repo"). */
  repoUrl?: string;
  /** Crew mode status info. When present, renders crew bar above title. */
  crewStatus?: CrewStatusInfo;
  /** Current merge strategy -- used for footer indicator in TUI mode. */
  mergeStrategy?: MergeStrategy;
  /** When true, footer shows "Press Ctrl-C again to exit" instead of strategy indicator. */
  ctrlCPending?: boolean;
  /** When true, render the help overlay instead of the normal frame. */
  showHelp?: boolean;
  /** Active schedule workers to display in the TUI. */
  scheduleWorkers?: ScheduleWorkerInfo[];
}

/**
 * Return the styled icon badge for a merge strategy.
 * Reused by the TUI footer and the help overlay (M-TUI-5).
 *
 * | Strategy | Icon | Color   |
 * |----------|------|---------|
 * | auto     | ›    | DIM     |
 * | manual   | ‖    | YELLOW  |
 * | bypass   | »    | RED     |
 */
export function strategyIndicator(strategy: MergeStrategy): string {
  switch (strategy) {
    case "auto":
      return `${DIM}›${RESET} ${DIM}auto${RESET}`;
    case "manual":
      return `${YELLOW}‖${RESET} ${YELLOW}manual${RESET}`;
    case "bypass":
      return `${RED}»${RESET} ${RED}bypass${RESET}`;
  }
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
  | "bootstrapping"
  | "implementing"
  | "rebasing"
  | "ci-failed"
  | "ci-pending"
  | "review"
  | "in-progress"
  | "queued";

export interface StatusItem {
  id: string;
  title: string;
  state: ItemState;
  prNumber: number | null;
  ageMs: number; // milliseconds since worktree created
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
}

// ─── Dependency tree types ────────────────────────────────────────────────────

export interface TreeNode {
  item: StatusItem;
  children: TreeNode[];
}

// ─── Blocked-by computation ──────────────────────────────────────────────────

/**
 * Compute unresolved (non-merged) dependencies for each item.
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
      return depState !== undefined && depState !== "merged";
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
      return GREEN;
    case "bootstrapping":
    case "implementing":
    case "rebasing":
    case "in-progress":
      return YELLOW;
    case "ci-failed":
      return RED;
    case "ci-pending":
      return CYAN;
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
      return "✓";
    case "bootstrapping":
    case "implementing":
    case "in-progress":
      return "▸";
    case "rebasing":
      return "⟲";
    case "ci-failed":
      return "✗";
    case "ci-pending":
      return "◌";
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
    case "bootstrapping":
      return "Bootstrapping";
    case "implementing":
      return "Implementing";
    case "rebasing":
      return "Rebasing";
    case "ci-failed":
      return "CI Failed";
    case "ci-pending":
      return "CI Pending";
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
 * Return a color-coded blocker icon based on unresolved blocker count.
 * RED ⧗ for 2+ blockers, YELLOW ⧗ for 1 blocker, plain space for 0.
 * Always 1 visible character wide to preserve column alignment.
 */
export function blockerIcon(blockerCount: number): string {
  if (blockerCount >= 2) return `${RED}⧗${RESET}`;
  if (blockerCount === 1) return `${YELLOW}⧗${RESET}`;
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
 * Returns 14 when no items have PRs (enough for "Bootstrapping").
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

  // Show preserved worktree path for stuck items so users know where to find partial work
  if (item.state === "stuck" && item.worktreePath) {
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
): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth, repoUrl);
  const remoteDot = item.remote ? ` ${CREW_REMOTE_DOT}` : "";
  const duration = pad(formatDuration(item), 8);
  const depCol = depIndicator ?? "";
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";
  const reason = item.failureReason ? ` ${DIM}(${item.failureReason})${RESET}` : "";
  const telemetry = formatTelemetrySuffix(item);

  return `  ${color}${icon}${RESET} ${id}${color}${stateCell}${RESET}${remoteDot} ${duration} ${depCol}${title}${repo}${reason}${telemetry}`;
}

/**
 * Format the batch progress line summarizing item states.
 * E.g., "Progress: 2 merged, 1 implementing, 1 ci-pending"
 */
export function formatBatchProgress(items: StatusItem[]): string {
  if (items.length === 0) return "";

  const counts = new Map<ItemState, number>();
  for (const item of items) {
    counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  }

  // Order states for display: merged first (good news), then active, then bad, then queued
  const order: ItemState[] = [
    "merged",
    "review",
    "ci-pending",
    "rebasing",
    "bootstrapping",
    "implementing",
    "in-progress",
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
  const merged = items.filter((i) => i.state === "merged").length;
  const active = total - merged;

  if (total === 0) return `  ${DIM}No active items${RESET}`;

  const parts = [`${total} item${total !== 1 ? "s" : ""}`];
  if (merged > 0 && active > 0) {
    parts.push(`${GREEN}${merged} merged${RESET}`, `${active} active`);
  }

  return `  ${DIM}Total: ${parts.join(", ")}${RESET}`;
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
): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth);
  const duration = pad(formatDuration(item), 8);
  const depCol = depIndicator ?? "";
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` [${item.repoLabel}]` : "";

  return `  ${DIM}${icon} ${id}${stateCell} ${duration} ${depCol}${title}${repo}${RESET}`;
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
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";

  if (item.state === "queued") {
    return `  ${DIM}${prefix}${icon} ${id}${stateCell} ${duration} ${title}${repo}${RESET}`;
  }
  return `  ${prefix ? `${DIM}${prefix}${RESET}` : ""}${color}${icon}${RESET} ${id}${color}${stateCell}${RESET} ${duration} ${title}${repo}`;
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
 * - Lead time (median/P95): endedAt − startedAt for merged items.
 * - Throughput: merged items per hour (requires sessionStartedAt).
 * - Success rate: merged / (merged + failed).
 * - Session duration: now − sessionStartedAt.
 */
export function computeSessionMetrics(
  items: StatusItem[],
  sessionStartedAt?: string,
): SessionMetrics {
  const mergedItems = items.filter((i) => i.state === "merged");
  const failedItems = items.filter((i) => i.state === "ci-failed");

  // Collect lead times from merged items with valid timestamps
  const leadTimes: number[] = [];
  for (const item of mergedItems) {
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

  // Throughput: merged / session-hours
  const throughputPerHour =
    sessionDurationMs !== null && sessionDurationMs > 0
      ? (mergedItems.length / sessionDurationMs) * 3_600_000
      : null;

  // Success rate
  const total = mergedItems.length + failedItems.length;
  const successRate = total > 0 ? mergedItems.length / total : null;

  return {
    leadTimeMedianMs,
    leadTimeP95Ms,
    throughputPerHour,
    successRate,
    sessionDurationMs,
  };
}

/** Cyan background + black text for crew bar and remote indicators. */
const CREW_BG = "\x1b[46m\x1b[30m"; // cyan bg, black text
/** Cyan dot used as remote indicator on items worked on by other crew members. */
export const CREW_REMOTE_DOT = `${CYAN}\u25CF${RESET}`; // ● in cyan

/**
 * Format crew status bar for display above the title line.
 * Uses cyan background spanning the full terminal width.
 * When disconnected, shows OFFLINE indicator.
 */
export function formatCrewStatusPanel(status: CrewStatusInfo, termWidth: number = 80): string {
  if (!status.connected) {
    const text = ` Crew ${status.crewCode} | OFFLINE -- reconnecting...`;
    return `${CREW_BG}${text}${" ".repeat(Math.max(0, termWidth - text.length))}${RESET}`;
  }
  const text = ` Crew ${status.crewCode}  |  ${status.daemonCount} daemons  |  ${status.availableCount} avail  |  ${status.claimedCount} claimed  |  ${status.completedCount} done`;
  return `${CREW_BG}${text}${" ".repeat(Math.max(0, termWidth - text.length))}${RESET}`;
}

/**
 * Format the complete status table from a list of StatusItems.
 * Returns a multi-line string ready for console output.
 * When wipLimit is provided, shows WIP slot usage in the queue header.
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
  wipLimit?: number,
  flat: boolean = false,
  viewOptions?: ViewOptions,
): string {
  const lines: string[] = [];

  lines.push(`${BOLD}ninthwave${RESET}`);
  lines.push("");

  if (items.length === 0) {
    lines.push(`  ${DIM}No active items${RESET}`);
    lines.push("");
    lines.push(`  ${DIM}To get started:${RESET}`);
    lines.push(`    ${DIM}ninthwave list --ready${RESET}     ${DIM}Show available TODOs${RESET}`);
    lines.push(`    ${DIM}ninthwave start <ID>${RESET}       ${DIM}Start working on an item${RESET}`);
    return lines.join("\n");
  }

  const opts = viewOptions ?? {};
  const repoUrl = opts.repoUrl;
  const crewActive = opts.crewStatus != null;

  // Crew status bar (above title line)
  if (opts.crewStatus) {
    lines.push(formatCrewStatusPanel(opts.crewStatus, termWidth));
  }

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
    return blockerIcon(blockers.length) + " ";
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

    const activeItems = sorted.filter((i) => i.state !== "queued" && i.state !== "merged");
    const mergedItems = sorted.filter((i) => i.state === "merged");
    const queuedItems = sorted.filter((i) => i.state === "queued");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth, depIndicator(item.id), stateColWidth, repoUrl));
      const blockers = blockedBy!.get(item.id) ?? [];
      if (opts.showBlockerDetail && blockers.length > 0) {
        lines.push(formatBlockerSubline(blockers, titleWidth, false, blockerColOffset));
      }
    }
    for (const item of mergedItems) {
      lines.push(formatItemRow(item, titleWidth, depIndicator(item.id), stateColWidth, repoUrl));
      const blockers = blockedBy!.get(item.id) ?? [];
      if (opts.showBlockerDetail && blockers.length > 0) {
        lines.push(formatBlockerSubline(blockers, titleWidth, false, blockerColOffset));
      }
    }

    // Queue section
    if (queuedItems.length > 0) {
      const activeCount = items.filter(
        (i) => i.state !== "queued" && i.state !== "merged",
      ).length;
      let queueHeader = `Queue (${queuedItems.length} waiting`;
      if (wipLimit !== undefined) {
        queueHeader += `, ${activeCount}/${wipLimit} WIP slots active`;
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
    // Flat mode (no dependencies): split into active, merged, and queued groups
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "merged");
    const queuedItems = items.filter((i) => i.state === "queued");
    const mergedItems = items.filter((i) => i.state === "merged");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl));
    }
    for (const item of mergedItems) {
      lines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl));
    }

    // Queue section with header
    if (queuedItems.length > 0) {
      const activeCount = activeItems.length;
      let queueHeader = `Queue (${queuedItems.length} waiting`;
      if (wipLimit !== undefined) {
        queueHeader += `, ${activeCount}/${wipLimit} WIP slots active`;
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
  // Composite display state: rebase is a transient operation overlaid on ci-pending/ci-failed
  if (flags?.rebaseRequested && (orchState === "ci-pending" || orchState === "ci-failed")) {
    return "rebasing";
  }
  switch (orchState) {
    case "merged":
    case "done":
      return "merged";
    case "bootstrapping":
      return "bootstrapping";
    case "implementing":
    case "launching":
      return "implementing";
    case "rebasing":
    case "fixing-forward":
      return "rebasing";
    case "ci-failed":
    case "stuck":
    case "fix-forward-failed":
      return "ci-failed";
    case "ci-pending":
    case "merging":
    case "forward-fix-pending":
      return "ci-pending";
    case "review-pending":
    case "reviewing":
    case "ci-passed":
      return "review";
    case "queued":
    case "ready":
      return "queued";
    default:
      return "in-progress";
  }
}

/**
 * Convert daemon state items to StatusItems for display.
 * Uses the state file data (fast, no GitHub API calls).
 */
export function daemonStateToStatusItems(state: DaemonState): StatusItem[] {
  return state.items.map((item) => ({
    id: item.id,
    title: item.title,
    state: mapDaemonItemState(item.state, { rebaseRequested: item.rebaseRequested }),
    prNumber: item.prNumber,
    ageMs: Date.now() - new Date(item.lastTransition).getTime(),
    repoLabel: "",
    failureReason: item.failureReason,
    dependencies: item.dependencies ?? [],
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    exitCode: item.exitCode,
    stderrTail: item.stderrTail,
    worktreePath: item.worktreePath,
  }));
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
}

/**
 * Format compact single-line metrics for the footer.
 * E.g., "✓ 2 merged  ▸ 2 active  · 3 queued    Lead: 5m  Thru: 4.2/hr"
 */
export function formatCompactMetrics(
  items: StatusItem[],
  sessionStartedAt?: string,
): string {
  const merged = items.filter((i) => i.state === "merged").length;
  const active = items.filter(
    (i) => i.state !== "merged" && i.state !== "queued",
  ).length;
  const queued = items.filter((i) => i.state === "queued").length;

  const parts: string[] = [];
  if (merged > 0) parts.push(`${GREEN}✓ ${merged} merged${RESET}`);
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
 * E.g., "✓ 5 merged  ▸ 2 implementing  ◌ 1 ci-pending                    8 items"
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

  // Order states for display: merged first, then active states, then bad, then queued
  const order: ItemState[] = [
    "merged",
    "review",
    "ci-pending",
    "rebasing",
    "bootstrapping",
    "implementing",
    "in-progress",
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

/**
 * Format the title line with right-aligned Lead/Thru/Session metrics (dimmed).
 * Falls back to plain title when no metrics available or terminal is too narrow (< 60 chars).
 * E.g., "ninthwave                    Lead: 7m  Thru: 20.9/hr  Session: 12m"
 */
export function formatTitleMetrics(
  items: StatusItem[],
  termWidth: number = 80,
  sessionStartedAt?: string,
): string {
  const title = `${BOLD}ninthwave${RESET}`;
  const titlePlain = "ninthwave";

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

  // No metrics or terminal too narrow -- plain title
  if (metricParts.length === 0 || termWidth < 60) {
    return title;
  }

  const metricsStr = metricParts.join("  ");
  // Need: titlePlain.length + at least 4 spaces gap + metricsStr.length
  const minWidth = titlePlain.length + 4 + metricsStr.length;

  if (termWidth >= minWidth) {
    // Subtract 1 to leave a safety margin -- some terminals clip the last
    // character when the line fills exactly termWidth (deferred-wrap behaviour).
    const gap = termWidth - titlePlain.length - metricsStr.length - 1;
    return `${title}${" ".repeat(gap)}${DIM}${metricsStr}${RESET}`;
  }
  // Not enough room -- plain title
  return title;
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
  wipLimit?: number,
  flat: boolean = false,
  viewOptions?: ViewOptions,
): FrameLayout {
  const headerLines: string[] = [];
  const footerLines: string[] = [];

  if (items.length === 0) {
    headerLines.push(`${BOLD}ninthwave${RESET}`);
    headerLines.push("");
    headerLines.push(`  ${DIM}No active items${RESET}`);
    headerLines.push("");
    headerLines.push(`  ${DIM}To get started:${RESET}`);
    headerLines.push(`    ${DIM}ninthwave list --ready${RESET}     ${DIM}Show available TODOs${RESET}`);
    headerLines.push(`    ${DIM}ninthwave start <ID>${RESET}       ${DIM}Start working on an item${RESET}`);
    return { headerLines, itemLines: [], footerLines };
  }

  const opts = viewOptions ?? {};
  const repoUrl = opts.repoUrl;
  const crewActive = opts.crewStatus != null;
  const hasDeps = !flat && items.some((i) => (i.dependencies ?? []).length > 0);
  const blockedBy = hasDeps ? computeBlockedBy(items) : undefined;

  // Inline dep indicator: 2-char slot (icon + space) before title when deps exist
  const depIndicatorWidth = hasDeps ? 2 : 0;

  const stateColWidth = computeStateColWidth(items);
  const fixedWidth = 26 + stateColWidth + depIndicatorWidth;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  // Column offset where the blocker icon sits (for aligning sub-lines)
  const blockerColOffset = 26 + stateColWidth;

  /** Build the 2-char dep indicator for an item. */
  function depIndicator(itemId: string): string {
    if (!blockedBy) return "  ";
    const blockers = blockedBy.get(itemId) ?? [];
    return blockerIcon(blockers.length) + " ";
  }

  // Header: crew bar (above title), then title (with right-aligned metrics)
  if (opts.crewStatus) {
    headerLines.push(formatCrewStatusPanel(opts.crewStatus, termWidth));
  }
  headerLines.push(formatTitleMetrics(items, termWidth, opts.sessionStartedAt));
  headerLines.push("");
  const depPad = hasDeps ? "  " : "";
  headerLines.push(`  ${DIM}  ${pad("ID", 12)}${pad("STATE", stateColWidth)} ${pad("DURATION", 8)} ${depPad}TITLE${RESET}`);
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, fixedWidth + titleWidth))}${RESET}`;
  headerLines.push(sep);

  // Build item lines
  const itemLines: string[] = [];

  if (hasDeps) {
    const sorted = sortByBlockedThenId(items, blockedBy!);
    const activeItems = sorted.filter((i) => i.state !== "queued" && i.state !== "merged");
    const mergedItems = sorted.filter((i) => i.state === "merged");
    const queuedItems = sorted.filter((i) => i.state === "queued");

    for (const item of activeItems) {
      itemLines.push(formatItemRow(item, titleWidth, depIndicator(item.id), stateColWidth, repoUrl));
      const blockers = blockedBy!.get(item.id) ?? [];
      if (opts.showBlockerDetail && blockers.length > 0) {
        itemLines.push(formatBlockerSubline(blockers, titleWidth, false, blockerColOffset));
      }
    }
    for (const item of mergedItems) {
      itemLines.push(formatItemRow(item, titleWidth, depIndicator(item.id), stateColWidth, repoUrl));
      const blockers = blockedBy!.get(item.id) ?? [];
      if (opts.showBlockerDetail && blockers.length > 0) {
        itemLines.push(formatBlockerSubline(blockers, titleWidth, false, blockerColOffset));
      }
    }
    if (queuedItems.length > 0) {
      const activeCount = items.filter((i) => i.state !== "queued" && i.state !== "merged").length;
      let queueHeader = `Queue (${queuedItems.length} waiting`;
      if (wipLimit !== undefined) queueHeader += `, ${activeCount}/${wipLimit} WIP slots active`;
      queueHeader += ")";
      itemLines.push("");
      itemLines.push(`  ${DIM}${queueHeader}${RESET}`);
      itemLines.push(sep);
      for (const item of queuedItems) {
        itemLines.push(formatQueuedItemRow(item, titleWidth, depIndicator(item.id), stateColWidth));
        const blockers = blockedBy!.get(item.id) ?? [];
        if (opts.showBlockerDetail && blockers.length > 0) {
          itemLines.push(formatBlockerSubline(blockers, titleWidth, true, blockerColOffset));
        }
      }
    }
  } else {
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "merged");
    const queuedItems = items.filter((i) => i.state === "queued");
    const mergedItems = items.filter((i) => i.state === "merged");

    for (const item of activeItems) {
      itemLines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl));
    }
    for (const item of mergedItems) {
      itemLines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl));
    }
    if (queuedItems.length > 0) {
      const activeCount = activeItems.length;
      let queueHeader = `Queue (${queuedItems.length} waiting`;
      if (wipLimit !== undefined) queueHeader += `, ${activeCount}/${wipLimit} WIP slots active`;
      queueHeader += ")";
      itemLines.push("");
      itemLines.push(`  ${DIM}${queueHeader}${RESET}`);
      itemLines.push(sep);
      for (const item of queuedItems) {
        itemLines.push(formatQueuedItemRow(item, titleWidth, undefined, stateColWidth));
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
  if (viewOptions?.ctrlCPending) {
    footerLines.push(`  ${YELLOW}Press Ctrl-C again to exit${RESET}`);
  } else if (viewOptions?.mergeStrategy) {
    const badge = strategyIndicator(viewOptions.mergeStrategy);
    footerLines.push(`  ${badge} ${DIM}(shift+tab to cycle) · ? for help${RESET}`);
  } else {
    // Fallback for non-TUI callers (e.g., `nw status`)
    const shortcuts = `q quit  d deps  ↑/↓ scroll`;
    footerLines.push(`  ${DIM}${shortcuts}${RESET}`);
  }

  return { headerLines, itemLines, footerLines };
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
  const { headerLines, itemLines, footerLines } = layout;

  // Reserve space for scroll indicators (1 line each when needed)
  const hasScrollUp = scrollOffset > 0;
  const maxOffset = Math.max(0, itemLines.length - Math.max(1, termRows - headerLines.length - footerLines.length));
  const hasScrollDown = scrollOffset < maxOffset && itemLines.length > (termRows - headerLines.length - footerLines.length);

  const scrollIndicatorLines = (hasScrollUp ? 1 : 0) + (hasScrollDown ? 1 : 0);
  const viewportHeight = Math.max(1, termRows - headerLines.length - footerLines.length - scrollIndicatorLines);

  // Clamp scroll offset
  const clampedOffset = clampScrollOffset(scrollOffset, itemLines.length, viewportHeight);

  // Slice visible items
  const visibleItems = itemLines.slice(clampedOffset, clampedOffset + viewportHeight);

  // Assemble output
  const output: string[] = [...headerLines];

  // Scroll-up indicator
  const hiddenAbove = clampedOffset;
  if (hiddenAbove > 0) {
    output.push(`  ${DIM}↑ ${hiddenAbove} more above${RESET}`);
  }

  output.push(...visibleItems);

  // Scroll-down indicator
  const hiddenBelow = Math.max(0, itemLines.length - clampedOffset - viewportHeight);
  if (hiddenBelow > 0) {
    output.push(`  ${DIM}↓ ${hiddenBelow} more below${RESET}`);
  }

  output.push(...footerLines);

  return output;
}

/** Minimum terminal rows for full-screen mode. Below this, use legacy non-fullscreen rendering. */
export const MIN_FULLSCREEN_ROWS = 10;

/** Minimum terminal rows for split panel mode. Below this, split degrades to full-screen cycling. */
export const MIN_SPLIT_ROWS = 35;

/** Fraction of available rows allocated to the status panel in split mode (0.6 = 60%). */
export const STATUS_SPLIT_RATIO = 0.6;

// ─── Panel layout types ─────────────────────────────────────────────────────

/** Panel display modes for the unified TUI. */
export type PanelMode = "status-only" | "split" | "logs-only";

/** Layout geometry for a single panel within the split view. */
export interface LogPanelLayout {
  /** Visible log lines (already sliced to fit). */
  lines: string[];
  /** Total number of log entries (for scroll indicators). */
  totalEntries: number;
  /** Current scroll offset into the log entries. */
  scrollOffset: number;
}

/** Full panel layout produced by buildPanelLayout(). */
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
 * - Below MIN_SPLIT_ROWS (35): "split" degrades to "status-only" (full-screen cycling).
 * - At MIN_SPLIT_ROWS+: split gives status top (60%) and logs bottom (40%).
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
    wipLimit?: number;
    flat?: boolean;
    viewOptions?: ViewOptions;
    logScrollOffset?: number;
    statusScrollOffset?: number;
    /** Pre-formatted detail lines to replace the log panel (item detail view). */
    detailLines?: string[];
    /** Selected item index for highlight (0-based, -1 for none). */
    selectedIndex?: number;
  },
): PanelLayout {
  const logScrollOffset = opts?.logScrollOffset ?? 0;

  // Below MIN_FULLSCREEN_ROWS: legacy flat rendering, no panels
  if (termRows < MIN_FULLSCREEN_ROWS) {
    const statusLayout = buildStatusLayout(
      items,
      termWidth,
      opts?.wipLimit,
      opts?.flat,
      opts?.viewOptions,
    );
    return {
      mode: "status-only",
      statusPanel: statusLayout,
      logPanel: null,
      footerLines: statusLayout.footerLines,
    };
  }

  // Split mode degrades to status-only below MIN_SPLIT_ROWS
  const effectiveMode = mode === "split" && termRows < MIN_SPLIT_ROWS
    ? "status-only"
    : mode;

  if (effectiveMode === "status-only") {
    const statusLayout = buildStatusLayout(
      items,
      termWidth,
      opts?.wipLimit,
      opts?.flat,
      opts?.viewOptions,
    );
    return {
      mode: "status-only",
      statusPanel: statusLayout,
      logPanel: null,
      footerLines: statusLayout.footerLines,
    };
  }

  if (effectiveMode === "logs-only") {
    // Full screen of logs with footer
    const footerLines = buildPanelFooter(items, logEntries.length, termWidth, opts?.viewOptions);
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

  // Split mode: status top (60%), logs/detail bottom (40%)
  const detailLines = opts?.detailLines;
  const isDetailMode = detailLines != null && detailLines.length > 0;
  const footerLines = buildPanelFooter(items, logEntries.length, termWidth, opts?.viewOptions);
  const separatorLine = isDetailMode
    ? buildDetailSeparator(termWidth)
    : buildPanelSeparator(logEntries.length, termWidth);

  // Available rows = total - footer - separator (1 line)
  const availableRows = Math.max(2, termRows - footerLines.length - 1);
  const statusRows = Math.max(1, Math.floor(availableRows * STATUS_SPLIT_RATIO));
  const logRows = Math.max(1, availableRows - statusRows);

  // Build status panel (header + items fit within statusRows)
  const statusLayout = buildStatusLayout(
    items,
    termWidth,
    opts?.wipLimit,
    opts?.flat,
    opts?.viewOptions,
  );
  // Strip footer from the status layout -- we use our own panel footer
  const statusPanel: FrameLayout = {
    headerLines: statusLayout.headerLines,
    itemLines: statusLayout.itemLines,
    footerLines: [], // managed by panel footer
  };

  if (isDetailMode) {
    // Detail view replaces the log panel
    const visibleDetail = detailLines.slice(0, logRows);
    return {
      mode: "split",
      statusPanel,
      logPanel: {
        lines: visibleDetail,
        totalEntries: detailLines.length,
        scrollOffset: 0,
      },
      footerLines: [separatorLine, ...footerLines],
    };
  }

  // Build log panel
  const clampedLogOffset = clampScrollOffset(logScrollOffset, logEntries.length, logRows);
  const visibleLogs = logEntries
    .slice(clampedLogOffset, clampedLogOffset + logRows)
    .map((e) => formatLogLine(e, termWidth));

  return {
    mode: "split",
    statusPanel,
    logPanel: {
      lines: visibleLogs,
      totalEntries: logEntries.length,
      scrollOffset: clampedLogOffset,
    },
    footerLines: [separatorLine, ...footerLines],
  };
}

/**
 * Build the separator line between status and log panels.
 * Shows log count and shortcut hints.
 * Format: "──── Logs (42) ──── tab: switch  ↑↓: scroll ────"
 */
function buildPanelSeparator(logCount: number, termWidth: number): string {
  const label = ` Logs (${logCount}) `;
  const hints = ` tab: switch  ${DIM}↑↓: scroll${RESET} `;
  const hintsPlain = ` tab: switch  ↑↓: scroll `;
  const usedWidth = label.length + hintsPlain.length + 4; // 4 for dash segments
  const remainingDashes = Math.max(0, termWidth - usedWidth);
  const leftDashes = Math.max(2, Math.floor(remainingDashes / 2));
  const rightDashes = Math.max(2, remainingDashes - leftDashes);
  return `${DIM}${"─".repeat(leftDashes)}${RESET}${BOLD}${label}${RESET}${DIM}${"─".repeat(2)}${RESET} ${hints}${DIM}${"─".repeat(rightDashes)}${RESET}`;
}

/**
 * Build the separator line between status and detail panels.
 * Format: "──── Detail ──── esc: back ────"
 */
function buildDetailSeparator(termWidth: number): string {
  const label = ` Detail `;
  const hints = ` esc: back `;
  const usedWidth = label.length + hints.length + 4;
  const remainingDashes = Math.max(0, termWidth - usedWidth);
  const leftDashes = Math.max(2, Math.floor(remainingDashes / 2));
  const rightDashes = Math.max(2, remainingDashes - leftDashes);
  return `${DIM}${"─".repeat(leftDashes)}${RESET}${BOLD}${label}${RESET}${DIM}${"─".repeat(2)}${RESET} ${hints}${DIM}${"─".repeat(rightDashes)}${RESET}`;
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
): string[] {
  const footerLines: string[] = [];
  const sep = `  ${DIM}${"─".repeat(Math.max(1, termWidth - 4))}${RESET}`;
  footerLines.push(sep);
  footerLines.push(formatUnifiedProgress(items, termWidth));

  if (viewOptions?.ctrlCPending) {
    footerLines.push(`  ${YELLOW}Press Ctrl-C again to exit${RESET}`);
  } else if (viewOptions?.mergeStrategy) {
    const badge = strategyIndicator(viewOptions.mergeStrategy);
    footerLines.push(`  ${badge} ${DIM}(shift+tab to cycle) · ? for help${RESET}`);
  } else {
    const shortcuts = `q quit  d deps  ↑/↓ scroll`;
    footerLines.push(`  ${DIM}${shortcuts}${RESET}`);
  }

  return footerLines;
}

/**
 * Render a complete panel frame as an array of terminal lines.
 *
 * Composites the status panel (with scroll indicators), separator, log panel
 * (with scroll indicators), and footer -- producing exactly termRows lines.
 *
 * For status-only and logs-only modes, delegates to simpler rendering.
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

  // Split mode
  if (!statusPanel || !logPanel) {
    // Defensive: shouldn't happen in split mode
    return padToHeight([...footerLines], termRows);
  }

  // The footerLines for split include separator + actual footer
  // Extract the separator (first line of footerLines) and the rest
  const separatorLine = footerLines[0] ?? "";
  const actualFooter = footerLines.slice(1);

  // Calculate available space
  const footerHeight = actualFooter.length;
  const separatorHeight = 1;
  const availableRows = Math.max(2, termRows - footerHeight - separatorHeight);
  const statusRows = Math.max(1, Math.floor(availableRows * STATUS_SPLIT_RATIO));
  const logRows = Math.max(1, availableRows - statusRows);

  const output: string[] = [];

  // Status panel with scroll indicators
  const statusHeader = statusPanel.headerLines;
  const statusItemViewport = Math.max(1, statusRows - statusHeader.length);
  const clampedStatusOffset = clampScrollOffset(statusScrollOffset, statusPanel.itemLines.length, statusItemViewport);

  const hasStatusScrollUp = clampedStatusOffset > 0;
  const hasStatusScrollDown = statusPanel.itemLines.length > clampedStatusOffset + statusItemViewport;
  const statusScrollLines = (hasStatusScrollUp ? 1 : 0) + (hasStatusScrollDown ? 1 : 0);
  const adjustedStatusViewport = Math.max(1, statusItemViewport - statusScrollLines);

  output.push(...statusHeader);

  if (hasStatusScrollUp) {
    const hidden = clampedStatusOffset;
    output.push(`  ${DIM}↑ ${hidden} more above${RESET}`);
  }

  const visibleStatusItems = statusPanel.itemLines.slice(
    clampedStatusOffset,
    clampedStatusOffset + adjustedStatusViewport,
  );
  output.push(...visibleStatusItems);

  if (hasStatusScrollDown) {
    const hidden = Math.max(0, statusPanel.itemLines.length - clampedStatusOffset - adjustedStatusViewport);
    output.push(`  ${DIM}↓ ${hidden} more below${RESET}`);
  }

  // Pad status section to fill its allocation
  while (output.length < statusRows) {
    output.push("");
  }

  // Separator
  output.push(separatorLine);

  // Log panel with scroll indicators
  const hasLogScrollUp = logPanel.scrollOffset > 0;
  const hasLogScrollDown = logPanel.totalEntries > logPanel.scrollOffset + logRows;
  const logScrollLines = (hasLogScrollUp ? 1 : 0) + (hasLogScrollDown ? 1 : 0);
  const adjustedLogViewport = Math.max(1, logRows - logScrollLines);

  if (hasLogScrollUp) {
    const hidden = logPanel.scrollOffset;
    output.push(`  ${DIM}↑ ${hidden} more above${RESET}`);
  }

  // Re-slice log lines to account for scroll indicators
  const visibleLogLines = logPanel.lines.slice(0, adjustedLogViewport);
  output.push(...visibleLogLines);

  if (hasLogScrollDown) {
    const hidden = Math.max(0, logPanel.totalEntries - logPanel.scrollOffset - adjustedLogViewport);
    output.push(`  ${DIM}↓ ${hidden} more below${RESET}`);
  }

  // Footer
  output.push(...actualFooter);

  return padToHeight(output, termRows);
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

  // CI status / failure reason
  if (item.failureReason) {
    lines.push(`  ${DIM}CI:${RESET}        ${RED}${item.failureReason}${RESET}`);
  } else if (item.state === "ci-failed") {
    lines.push(`  ${DIM}CI:${RESET}        ${RED}Failed${RESET}`);
  } else if (item.state === "ci-pending") {
    lines.push(`  ${DIM}CI:${RESET}        ${CYAN}Pending${RESET}`);
  } else if (item.state === "merged" || item.state === "review") {
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
  if (opts?.progressLabel) {
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

  return lines;
}

// ─── Help overlay ────────────────────────────────────────────────────────────

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
): string[] {
  // ── Build content lines (plain text, no padding yet) ──────────────

  const sections: string[][] = [];

  // Metrics section
  sections.push([
    `${BOLD}Metrics${RESET}`,
    `  Lead time    Median start-to-merge duration`,
    `  Throughput   Merged items per hour`,
    `  Session      Time since orchestrator start`,
  ]);

  // Merge strategies section -- reuse strategyIndicator() for icons/colors
  sections.push([
    `${BOLD}Merge Strategies${RESET}`,
    `  ${strategyIndicator("auto")}     AI review + CI -> auto-merge`,
    `  ${strategyIndicator("manual")}  AI review + CI, human merges`,
    `  ${strategyIndicator("bypass")}  AI review + CI -> admin merge`,
  ]);

  // Keyboard shortcuts section
  sections.push([
    `${BOLD}Keyboard Shortcuts${RESET}`,
    `  Shift+Tab   Cycle merge strategy`,
    `  ?           Toggle this help overlay`,
    `  Enter/i     Item detail panel`,
    `  Escape      Close overlay/detail`,
    `  q           Quit`,
    `  Ctrl+C x2   Quit (double-tap)`,
    `  d           Toggle blocker sub-lines`,
    `  Up/Down     Scroll item list`,
  ]);

  // Credits section
  sections.push([
    `${DIM}ninthwave -- parallel AI coding orchestration${RESET}`,
    `${DIM}Apache-2.0 -- ninthwave.sh${RESET}`,
  ]);

  // ── Flatten sections with blank separators ─────────────────────────

  const contentLines: string[] = [];
  for (let s = 0; s < sections.length; s++) {
    if (s > 0) contentLines.push(""); // blank line between sections
    contentLines.push(...sections[s]!);
  }

  // ── Compute box dimensions ─────────────────────────────────────────

  const maxContentWidth = Math.max(
    ...contentLines.map((l) => stripAnsiForWidth(l).length),
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
  for (const line of contentLines) {
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
  const hint = "Press ? or Escape to close";
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

  return output;
}
