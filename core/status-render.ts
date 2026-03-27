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

export interface ViewOptions {
  showMetrics?: boolean;
  showBlockerDetail?: boolean;
  showHelp?: boolean;
  sessionStartedAt?: string;
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
  if (item.startedAt) {
    const elapsed = formatElapsed(item);
    if (elapsed) return elapsed;
  }
  return formatAge(item.ageMs);
}

/**
 * Format telemetry suffix for an item row.
 * Active workers: show elapsed duration.
 * Failed workers: show exit code and stderr tail.
 */
export function formatTelemetrySuffix(item: StatusItem): string {
  const parts: string[] = [];

  // Show elapsed duration for active workers
  const isActive = item.state === "implementing" || item.state === "bootstrapping" || item.state === "in-progress";
  if (isActive && item.startedAt) {
    const elapsed = formatElapsed(item);
    if (elapsed) {
      parts.push(`elapsed: ${elapsed}`);
    }
  }

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
 */
export function formatItemRow(item: StatusItem, titleWidth: number, depsStr?: string): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const label = pad(stateLabel(item.state), 14);
  const pr = item.prNumber ? pad(`#${item.prNumber}`, 7) : pad("-", 7);
  const duration = pad(formatDuration(item), 8);
  const depsCol = depsStr ?? "";
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";
  const reason = item.failureReason ? ` ${DIM}(${item.failureReason})${RESET}` : "";
  const telemetry = formatTelemetrySuffix(item);

  return `  ${color}${icon}${RESET} ${id}${color}${label}${RESET} ${pr} ${duration} ${depsCol}${title}${repo}${reason}${telemetry}`;
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
 */
export function formatQueuedItemRow(item: StatusItem, titleWidth: number, depsStr?: string): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const label = pad(stateLabel(item.state), 14);
  const pr = item.prNumber ? pad(`#${item.prNumber}`, 7) : pad("-", 7);
  const duration = pad(formatDuration(item), 8);
  const depsCol = depsStr ?? "";
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` [${item.repoLabel}]` : "";

  return `  ${DIM}${icon} ${id}${label} ${pr} ${duration} ${depsCol}${title}${repo}${RESET}`;
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
 */
export function formatTreeItemRow(
  item: StatusItem,
  depth: number,
  ancestorIsLast: boolean[],
  isLast: boolean,
  termWidth: number,
): string {
  const fixedWidth = 48;
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
  const label = pad(stateLabel(item.state), 14);
  const pr = item.prNumber ? pad(`#${item.prNumber}`, 7) : pad("-", 7);
  const duration = pad(formatDuration(item), 8);
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";

  if (item.state === "queued") {
    return `  ${DIM}${prefix}${icon} ${id}${label} ${pr} ${duration} ${title}${repo}${RESET}`;
  }
  return `  ${prefix ? `${DIM}${prefix}${RESET}` : ""}${color}${icon}${RESET} ${id}${color}${label}${RESET} ${pr} ${duration} ${title}${repo}`;
}

/**
 * Render dependency trees as formatted rows with tree-drawing characters.
 * Uses ├──, └──, │ for visual structure.
 */
export function formatTreeRows(
  trees: TreeNode[],
  termWidth: number,
): string[] {
  const lines: string[] = [];

  function renderNode(
    node: TreeNode,
    depth: number,
    ancestorIsLast: boolean[],
    isLast: boolean,
  ): void {
    lines.push(formatTreeItemRow(node.item, depth, ancestorIsLast, isLast, termWidth));

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
 * Format a DORA-style metrics panel for display below the status table.
 * Returns a multi-line string.
 */
export function formatMetricsPanel(metrics: SessionMetrics): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${BOLD}Session Metrics${RESET}`);
  lines.push(`  ${DIM}${"─".repeat(40)}${RESET}`);

  const lt = metrics.leadTimeMedianMs !== null ? formatAge(metrics.leadTimeMedianMs) : "-";
  lines.push(`  Lead Time (median):  ${lt}`);

  const p95 = metrics.leadTimeP95Ms !== null ? formatAge(metrics.leadTimeP95Ms) : "-";
  lines.push(`  Lead Time (P95):     ${p95}`);

  const tp =
    metrics.throughputPerHour !== null
      ? `${metrics.throughputPerHour.toFixed(1)}/hr`
      : "-";
  lines.push(`  Throughput:          ${tp}`);

  const sr =
    metrics.successRate !== null
      ? `${(metrics.successRate * 100).toFixed(0)}%`
      : "-";
  lines.push(`  Success Rate:        ${sr}`);

  const dur = metrics.sessionDurationMs !== null ? formatAge(metrics.sessionDurationMs) : "-";
  lines.push(`  Session Duration:    ${dur}`);

  return lines.join("\n");
}

/**
 * Format a help footer line showing available key bindings.
 */
export function formatHelpFooter(): string {
  return `  ${DIM}q: quit  m: metrics  b: blocker detail  h: help${RESET}`;
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
 * - showMetrics: render DORA-style metrics panel below the table.
 * - showBlockerDetail: expand DEPS column to show full blocker IDs instead of counts.
 * - showHelp: render a key-bindings footer line.
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

  // Column widths
  // Base: 2 indent + 2 icon+space + 12 ID + 14 state + 1 + 7 PR + 1 + 8 duration + 1 = 48
  const fixedWidth = 48 + depsColWidth;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  // Header
  const depsHeader = hasDeps ? `${pad("DEPS", depsColWidth)}` : "";
  const header = `  ${DIM}  ${pad("ID", 12)}${pad("STATE", 14)} ${pad("PR", 7)} ${pad("DURATION", 8)} ${depsHeader}TITLE${RESET}`;
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
      lines.push(formatItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth)));
    }
    for (const item of mergedItems) {
      lines.push(formatItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth)));
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
        lines.push(formatQueuedItemRow(item, titleWidth, pad(depsStr(item.id), depsColWidth)));
      }
    }
  } else {
    // Flat mode (no dependencies): split into active, merged, and queued groups
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "merged");
    const queuedItems = items.filter((i) => i.state === "queued");
    const mergedItems = items.filter((i) => i.state === "merged");

    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth));
    }
    for (const item of mergedItems) {
      lines.push(formatItemRow(item, titleWidth));
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
        lines.push(formatQueuedItemRow(item, titleWidth));
      }
    }
  }

  // Footer
  lines.push(sep);
  lines.push(formatBatchProgress(items));
  lines.push(formatSummary(items));

  // Metrics panel (DORA-style)
  if (opts.showMetrics) {
    const metrics = computeSessionMetrics(items, opts.sessionStartedAt);
    lines.push(formatMetricsPanel(metrics));
  }

  // Help footer
  if (opts.showHelp) {
    lines.push("");
    lines.push(formatHelpFooter());
  }

  return lines.join("\n");
}

// ─── Daemon state mapping ────────────────────────────────────────────────────

/**
 * Map orchestrator item state strings to status display ItemState.
 * Orchestrator uses finer-grained states; status display groups them.
 */
export function mapDaemonItemState(orchState: string): ItemState {
  switch (orchState) {
    case "merged":
    case "done":
      return "merged";
    case "bootstrapping":
      return "bootstrapping";
    case "implementing":
    case "launching":
      return "implementing";
    case "ci-failed":
    case "stuck":
      return "ci-failed";
    case "ci-pending":
    case "merging":
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
    state: mapDaemonItemState(item.state),
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
