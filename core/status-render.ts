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

export interface ViewOptions {
  showBlockerDetail?: boolean;
  sessionStartedAt?: string;
  /** Base repository URL for PR hyperlinks (e.g., "https://github.com/org/repo"). */
  repoUrl?: string;
  /** Crew mode status info. When present, renders crew status panel and DAEMON column. */
  crewStatus?: CrewStatusInfo;
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
  | "pr-open"
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
  /** Daemon name that owns this item in crew mode. "local" when not in crew mode. */
  daemonName?: string;
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
    case "pr-open":
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
    case "pr-open":
      return "○";
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
    case "pr-open":
      return "PR Open";
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

  return parts.length > 0 ? ` ${DIM}(${parts.join(", ")})${RESET}` : "";
}

/**
 * Format a single item row for the status table.
 * Returns a string with ANSI color codes.
 * When depsStr is provided, it's displayed as the DEPS column.
 * stateColWidth controls the state+PR column width (default 14).
 * repoUrl enables OSC 8 hyperlinks on PR numbers.
 * daemonCol is the optional DAEMON column string (8 chars wide, pre-padded).
 */
export function formatItemRow(
  item: StatusItem,
  titleWidth: number,
  depsStr?: string,
  stateColWidth: number = 14,
  repoUrl?: string,
  daemonCol?: string,
): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth, repoUrl);
  const duration = pad(formatDuration(item), 8);
  const daemon = daemonCol ?? "";
  const depsCol = depsStr ?? "";
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";
  const reason = item.failureReason ? ` ${DIM}(${item.failureReason})${RESET}` : "";
  const telemetry = formatTelemetrySuffix(item);

  return `  ${color}${icon}${RESET} ${id}${color}${stateCell}${RESET} ${duration} ${daemon}${depsCol}${title}${repo}${reason}${telemetry}`;
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
    "pr-open",
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
 * stateColWidth controls the state column width (default 14).
 * daemonCol is the optional DAEMON column string (8 chars wide, pre-padded).
 */
export function formatQueuedItemRow(
  item: StatusItem,
  titleWidth: number,
  depsStr?: string,
  stateColWidth: number = 14,
  daemonCol?: string,
): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const stateCell = formatStateLabelWithPr(item.state, item.prNumber, stateColWidth);
  const duration = pad(formatDuration(item), 8);
  const daemon = daemonCol ?? "";
  const depsCol = depsStr ?? "";
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` [${item.repoLabel}]` : "";

  return `  ${DIM}${icon} ${id}${stateCell} ${duration} ${daemon}${depsCol}${title}${repo}${RESET}`;
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

/**
 * Format crew status panel line for display above the item table.
 * Shows crew code, daemon count, available/claimed/done counts.
 * When disconnected, shows OFFLINE indicator.
 */
export function formatCrewStatusPanel(status: CrewStatusInfo): string {
  if (!status.connected) {
    return `  ${BOLD}Crew: ${status.crewCode}${RESET} ${RED}| OFFLINE — reconnecting...${RESET}`;
  }
  return `  ${BOLD}Crew: ${status.crewCode}${RESET} | Daemons: ${status.daemonCount} | Avail: ${status.availableCount} | Claimed: ${status.claimedCount} | Done: ${status.completedCount}`;
}

/**
 * Format the complete status table from a list of StatusItems.
 * Returns a multi-line string ready for console output.
 * When wipLimit is provided, shows WIP slot usage in the queue header.
 *
 * When items have dependencies, renders a flat list sorted by blocked-by count
 * (ascending) then ID alphanumeric, with a BLOCKED BY column showing unresolved deps.
 *
 * viewOptions controls optional panels:
 * - showBlockerDetail: expand DEPS column to show full blocker IDs instead of counts.
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

  lines.push(`${BOLD}ninthwave status${RESET}`);
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

  // Crew status panel (above item table)
  if (opts.crewStatus) {
    lines.push(formatCrewStatusPanel(opts.crewStatus));
    lines.push("");
  }

  // Check if any items have dependency relationships
  const hasDeps = !flat && items.some((i) => (i.dependencies ?? []).length > 0);

  // Precompute blocked-by map (needed for DEPS column and blocker detail)
  const blockedBy = hasDeps ? computeBlockedBy(items) : undefined;

  // DEPS column width: dynamic when showBlockerDetail is true, fixed 5 otherwise
  let depsColWidth = 0;
  if (hasDeps) {
    if (opts.showBlockerDetail && blockedBy) {
      // Compute max width needed for full blocker ID lists
      let maxLen = 4; // minimum "DEPS" header width
      for (const [, blockers] of blockedBy) {
        const str = blockers.length > 0 ? blockers.join(",") : "-";
        if (str.length > maxLen) maxLen = str.length;
      }
      depsColWidth = maxLen + 1; // +1 for padding
    } else {
      depsColWidth = 5;
    }
  }

  // DAEMON column: 9 chars wide (8 + space), only in crew mode
  const daemonColWidth = crewActive ? 9 : 0;

  // Dynamic state column width: 14ch when no items have PRs, up to ~24ch with PRs
  const stateColWidth = computeStateColWidth(items);

  // Column widths
  // Base: 2 indent + 2 icon+space + 12 ID + stateColWidth state + 1 space + 8 duration + 1 space = 26 + stateColWidth
  const fixedWidth = 26 + stateColWidth + daemonColWidth + depsColWidth;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  /** Format daemon column for an item. */
  function daemonStr(item: StatusItem): string {
    if (!crewActive) return "";
    const name = item.daemonName ?? "--";
    return pad(name, daemonColWidth);
  }

  // Header
  const daemonHeader = crewActive ? pad("DAEMON", daemonColWidth) : "";
  const depsHeader = hasDeps ? `${pad("DEPS", depsColWidth)}` : "";
  const header = `  ${DIM}  ${pad("ID", 12)}${pad("STATE", stateColWidth)} ${pad("DURATION", 8)} ${daemonHeader}${depsHeader}TITLE${RESET}`;
  lines.push(header);

  // Separator
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, fixedWidth + titleWidth))}${RESET}`;
  lines.push(sep);

  /** Format the DEPS column string for an item. */
  function depsStr(itemId: string): string {
    if (!blockedBy) return "-";
    const blockers = blockedBy.get(itemId) ?? [];
    if (opts.showBlockerDetail) {
      return blockers.length > 0 ? blockers.join(",") : "-";
    }
    return blockers.length > 0 ? String(blockers.length) : "-";
  }

  if (hasDeps) {
    // Flat blocked-by mode: sort by blocked count asc, then ID alpha
    const sorted = sortByBlockedThenId(items, blockedBy!);

    const activeItems = sorted.filter((i) => i.state !== "queued" && i.state !== "merged");
    const mergedItems = sorted.filter((i) => i.state === "merged");
    const queuedItems = sorted.filter((i) => i.state === "queued");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth), stateColWidth, repoUrl, daemonStr(item)));
    }
    for (const item of mergedItems) {
      lines.push(formatItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth), stateColWidth, repoUrl, daemonStr(item)));
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
        lines.push(formatQueuedItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth), stateColWidth, daemonStr(item)));
      }
    }
  } else {
    // Flat mode (no dependencies): split into active, merged, and queued groups
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "merged");
    const queuedItems = items.filter((i) => i.state === "queued");
    const mergedItems = items.filter((i) => i.state === "merged");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl, daemonStr(item)));
    }
    for (const item of mergedItems) {
      lines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl, daemonStr(item)));
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
        lines.push(formatQueuedItemRow(item, titleWidth, undefined, stateColWidth, daemonStr(item)));
      }
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
    case "repairing":
    case "repairing-main":
      return "rebasing";
    case "ci-failed":
    case "stuck":
    case "verify-failed":
      return "ci-failed";
    case "ci-pending":
    case "merging":
    case "verifying":
      return "ci-pending";
    case "review-pending":
    case "ci-passed":
      return "review";
    case "pr-open":
      return "pr-open";
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
    "pr-open",
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
    const gap = termWidth - 2 - leftPlain.length - totalText.length;
    return `  ${leftSide}${" ".repeat(gap)}${totalText}`;
  }
  // Narrow terminal: just put total after left with 2-space gap
  return `  ${leftSide}  ${totalText}`;
}

/**
 * Format the title line with right-aligned Lead/Thru/Session metrics (dimmed).
 * Falls back to plain title when no metrics available or terminal is too narrow (< 60 chars).
 * E.g., "ninthwave status                    Lead: 7m  Thru: 20.9/hr  Session: 12m"
 */
export function formatTitleMetrics(
  items: StatusItem[],
  termWidth: number = 80,
  sessionStartedAt?: string,
): string {
  const title = `${BOLD}ninthwave status${RESET}`;
  const titlePlain = "ninthwave status";

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

  // No metrics or terminal too narrow — plain title
  if (metricParts.length === 0 || termWidth < 60) {
    return title;
  }

  const metricsStr = metricParts.join("  ");
  // Need: titlePlain.length + at least 4 spaces gap + metricsStr.length
  const minWidth = titlePlain.length + 4 + metricsStr.length;

  if (termWidth >= minWidth) {
    const gap = termWidth - titlePlain.length - metricsStr.length;
    return `${title}${" ".repeat(gap)}${DIM}${metricsStr}${RESET}`;
  }
  // Not enough room — plain title
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
    headerLines.push(`${BOLD}ninthwave status${RESET}`);
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

  let depsColWidth = 0;
  if (hasDeps) {
    if (opts.showBlockerDetail && blockedBy) {
      let maxLen = 4;
      for (const [, blockers] of blockedBy) {
        const str = blockers.length > 0 ? blockers.join(",") : "-";
        if (str.length > maxLen) maxLen = str.length;
      }
      depsColWidth = maxLen + 1;
    } else {
      depsColWidth = 5;
    }
  }

  const daemonColWidth = crewActive ? 9 : 0;
  const stateColWidth = computeStateColWidth(items);
  const fixedWidth = 26 + stateColWidth + daemonColWidth + depsColWidth;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  /** Format daemon column for an item. */
  function daemonStr(item: StatusItem): string {
    if (!crewActive) return "";
    const name = item.daemonName ?? "--";
    return pad(name, daemonColWidth);
  }

  // Header: title (with right-aligned metrics when available) + column headers + separator
  headerLines.push(formatTitleMetrics(items, termWidth, opts.sessionStartedAt));
  headerLines.push("");
  // Crew status panel (above item table)
  if (opts.crewStatus) {
    headerLines.push(formatCrewStatusPanel(opts.crewStatus));
    headerLines.push("");
  }
  const daemonHeader = crewActive ? pad("DAEMON", daemonColWidth) : "";
  const depsHeader = hasDeps ? `${pad("DEPS", depsColWidth)}` : "";
  headerLines.push(`  ${DIM}  ${pad("ID", 12)}${pad("STATE", stateColWidth)} ${pad("DURATION", 8)} ${daemonHeader}${depsHeader}TITLE${RESET}`);
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, fixedWidth + titleWidth))}${RESET}`;
  headerLines.push(sep);

  // Build item lines
  const itemLines: string[] = [];

  function depsStr(itemId: string): string {
    if (!blockedBy) return "-";
    const blockers = blockedBy.get(itemId) ?? [];
    if (opts.showBlockerDetail) {
      return blockers.length > 0 ? blockers.join(",") : "-";
    }
    return blockers.length > 0 ? String(blockers.length) : "-";
  }

  if (hasDeps) {
    const sorted = sortByBlockedThenId(items, blockedBy!);
    const activeItems = sorted.filter((i) => i.state !== "queued" && i.state !== "merged");
    const mergedItems = sorted.filter((i) => i.state === "merged");
    const queuedItems = sorted.filter((i) => i.state === "queued");

    for (const item of activeItems) {
      itemLines.push(formatItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth), stateColWidth, repoUrl, daemonStr(item)));
    }
    for (const item of mergedItems) {
      itemLines.push(formatItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth), stateColWidth, repoUrl, daemonStr(item)));
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
        itemLines.push(formatQueuedItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth), stateColWidth, daemonStr(item)));
      }
    }
  } else {
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "merged");
    const queuedItems = items.filter((i) => i.state === "queued");
    const mergedItems = items.filter((i) => i.state === "merged");

    for (const item of activeItems) {
      itemLines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl, daemonStr(item)));
    }
    for (const item of mergedItems) {
      itemLines.push(formatItemRow(item, titleWidth, undefined, stateColWidth, repoUrl, daemonStr(item)));
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
        itemLines.push(formatQueuedItemRow(item, titleWidth, undefined, stateColWidth, daemonStr(item)));
      }
    }
  }

  // Footer: separator, unified progress line, shortcuts
  footerLines.push(sep);
  footerLines.push(formatUnifiedProgress(items, termWidth));

  // Always show keyboard shortcuts in full-screen mode
  const shortcuts = `q quit  d deps  ↑/↓ scroll`;
  footerLines.push(`  ${DIM}${shortcuts}${RESET}`);

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
