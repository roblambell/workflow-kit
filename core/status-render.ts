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
 */
export function formatItemRow(item: StatusItem, titleWidth: number): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const label = pad(stateLabel(item.state), 14);
  const pr = item.prNumber ? pad(`#${item.prNumber}`, 7) : pad("-", 7);
  const age = pad(formatAge(item.ageMs), 8);
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";
  const reason = item.failureReason ? ` ${DIM}(${item.failureReason})${RESET}` : "";
  const telemetry = formatTelemetrySuffix(item);

  return `  ${color}${icon}${RESET} ${id}${color}${label}${RESET} ${pr} ${age} ${title}${repo}${reason}${telemetry}`;
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
export function formatQueuedItemRow(item: StatusItem, titleWidth: number): string {
  const icon = stateIcon(item.state);
  const id = pad(item.id, 12);
  const label = pad(stateLabel(item.state), 14);
  const pr = item.prNumber ? pad(`#${item.prNumber}`, 7) : pad("-", 7);
  const age = pad(formatAge(item.ageMs), 8);
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` [${item.repoLabel}]` : "";

  return `  ${DIM}${icon} ${id}${label} ${pr} ${age} ${title}${repo}${RESET}`;
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
  const age = pad(formatAge(item.ageMs), 8);
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";

  if (item.state === "queued") {
    return `  ${DIM}${prefix}${icon} ${id}${label} ${pr} ${age} ${title}${repo}${RESET}`;
  }
  return `  ${prefix ? `${DIM}${prefix}${RESET}` : ""}${color}${icon}${RESET} ${id}${color}${label}${RESET} ${pr} ${age} ${title}${repo}`;
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

/**
 * Format the complete status table from a list of StatusItems.
 * Returns a multi-line string ready for console output.
 * When wipLimit is provided, shows WIP slot usage in the queue header.
 */
export function formatStatusTable(
  items: StatusItem[],
  termWidth: number = 80,
  wipLimit?: number,
  flat: boolean = false,
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

  // Column widths: 2 indent + 2 icon+space + 12 ID + 14 state + 1 + 7 PR + 1 + 8 age + 1 + title
  // = 48 fixed + title
  const fixedWidth = 48;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  // Header (2-space placeholder for icon column)
  const header = `  ${DIM}  ${pad("ID", 12)}${pad("STATE", 14)} ${pad("PR", 7)} ${pad("AGE", 8)} TITLE${RESET}`;
  lines.push(header);

  // Separator
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, 78))}${RESET}`;
  lines.push(sep);

  // Check if any items have dependency relationships
  const hasDeps = !flat && items.some((i) => (i.dependencies ?? []).length > 0);

  if (hasDeps) {
    // Tree mode: render items with dependency relationships as trees,
    // and items without dependencies as a flat list
    const { trees, flat: flatItems } = buildDependencyTree(items);

    // Render dependency trees
    if (trees.length > 0) {
      lines.push(...formatTreeRows(trees, termWidth));
    }

    // Render flat items (no dependency relationships) in grouped format
    const flatActive = flatItems.filter((i) => i.state !== "queued" && i.state !== "merged");
    const flatMerged = flatItems.filter((i) => i.state === "merged");
    const flatQueued = flatItems.filter((i) => i.state === "queued");

    for (const item of flatActive) {
      lines.push(formatItemRow(item, titleWidth));
    }
    for (const item of flatMerged) {
      lines.push(formatItemRow(item, titleWidth));
    }

    // Queue section for flat queued items only (tree queued items are in trees)
    if (flatQueued.length > 0) {
      const activeCount = items.filter(
        (i) => i.state !== "queued" && i.state !== "merged",
      ).length;
      let queueHeader = `Queue (${flatQueued.length} waiting`;
      if (wipLimit !== undefined) {
        queueHeader += `, ${activeCount}/${wipLimit} WIP slots active`;
      }
      queueHeader += ")";

      lines.push("");
      lines.push(`  ${DIM}${queueHeader}${RESET}`);
      lines.push(sep);

      for (const item of flatQueued) {
        lines.push(formatQueuedItemRow(item, titleWidth));
      }
    }
  } else {
    // Flat mode (original behavior): split into active, merged, and queued groups
    const activeItems = items.filter((i) => i.state !== "queued" && i.state !== "merged");
    const queuedItems = items.filter((i) => i.state === "queued");
    const mergedItems = items.filter((i) => i.state === "merged");

    // Active items at top (not merged, not queued)
    for (const item of activeItems) {
      lines.push(formatItemRow(item, titleWidth));
    }

    // Merged items
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
