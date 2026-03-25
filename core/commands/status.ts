// status and partitions commands: show active worktree status and partition allocation.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import {
  BOLD,
  BLUE,
  GREEN,
  YELLOW,
  RED,
  CYAN,
  DIM,
  RESET,
} from "../output.ts";
import { run } from "../shell.ts";
import {
  isDaemonRunning,
  readStateFile,
  type DaemonState,
  type DaemonStateItem,
} from "../daemon.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ItemState =
  | "merged"
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

  return `  ${color}${icon}${RESET} ${id}${color}${label}${RESET} ${pr} ${age} ${title}${repo}${reason}`;
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
  }));
}

// ─── Data gathering ──────────────────────────────────────────────────────────

interface TodoMetadata {
  title: string;
  dependencies: string[];
}

/** Try to read TODO metadata from .ninthwave/todos/ directory. Returns a map of ID → metadata. */
function loadTodoMetadata(projectRoot: string): Map<string, TodoMetadata> {
  const metadata = new Map<string, TodoMetadata>();
  const todosDir = join(projectRoot, ".ninthwave", "todos");
  if (!existsSync(todosDir)) return metadata;

  try {
    const entries = readdirSync(todosDir).filter((e) => e.endsWith(".md"));
    for (const entry of entries) {
      const filePath = join(todosDir, entry);
      try {
        const content = readFileSync(filePath, "utf-8");
        // Extract title from the first # heading
        const titleMatch = content.match(/^# (.+)$/m);
        if (titleMatch) {
          const id = entry.replace(/\.md$/, "");
          // Extract dependencies from **Depends on:** line
          const deps: string[] = [];
          const depsMatch = content.match(/^\*\*Depends on:\*\*\s+(.+)$/m);
          if (depsMatch) {
            const depsStr = depsMatch[1]!;
            if (depsStr.toLowerCase() !== "none" && depsStr !== "-") {
              const idMatches = depsStr.match(/[A-Z]-[A-Za-z0-9]+-[0-9]+/g);
              if (idMatches) deps.push(...idMatches);
            }
          }
          metadata.set(id, {
            title: titleMatch[1]!.trim(),
            dependencies: deps,
          });
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // ignore
  }

  return metadata;
}

/** Determine item state from git/gh data. */
function determineItemState(
  id: string,
  repoRoot: string,
): { state: ItemState; prNumber: number | null } {
  const branch = `todo/${id}`;

  // Check remote branch exists
  const hasRemote =
    run("git", ["-C", repoRoot, "rev-parse", "--verify", `origin/${branch}`])
      .exitCode === 0;

  // If no remote, it's still in progress
  if (!hasRemote) {
    return { state: "implementing", prNumber: null };
  }

  // Try gh for PR status
  const ghCheck = run("which", ["gh"]);
  if (ghCheck.exitCode !== 0) {
    return { state: "pr-open", prNumber: null };
  }

  // Check merged PRs
  const merged = run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number",
      "--jq",
      ".[0].number",
      "--limit",
      "1",
    ],
    { cwd: repoRoot },
  );
  if (merged.exitCode === 0 && merged.stdout) {
    return { state: "merged", prNumber: parseInt(merged.stdout, 10) };
  }

  // Check open PRs
  const open = run(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,reviewDecision",
      "--jq",
      ".[0] | [.number, .reviewDecision] | @tsv",
      "--limit",
      "1",
    ],
    { cwd: repoRoot },
  );
  if (open.exitCode === 0 && open.stdout) {
    const parts = open.stdout.split("\t");
    const prNum = parseInt(parts[0] ?? "", 10);
    const reviewDecision = parts[1] ?? "";

    // Check CI status
    const checks = run(
      "gh",
      [
        "pr",
        "checks",
        String(prNum),
        "--json",
        "state",
        "--jq",
        "[.[].state] | join(\",\")",
      ],
      { cwd: repoRoot },
    );

    if (checks.exitCode === 0 && checks.stdout) {
      const states = checks.stdout.split(",");
      const nonSkipped = states.filter((s) => s !== "SKIPPED");
      if (nonSkipped.some((s) => s === "FAILURE")) {
        return { state: "ci-failed", prNumber: prNum };
      }
      if (nonSkipped.some((s) => s === "PENDING")) {
        return { state: "ci-pending", prNumber: prNum };
      }
      if (nonSkipped.every((s) => s === "SUCCESS")) {
        if (reviewDecision === "APPROVED") {
          return { state: "review", prNumber: prNum };
        }
        return { state: "pr-open", prNumber: prNum };
      }
    }

    return { state: "pr-open", prNumber: prNum };
  }

  // Has remote but no PR
  return { state: "in-progress", prNumber: null };
}

/** Get the age of a worktree directory in milliseconds. */
function getWorktreeAge(wtDir: string): number {
  try {
    const stat = statSync(wtDir);
    return Date.now() - stat.birthtimeMs;
  } catch {
    return 0;
  }
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

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Run `ninthwave status` in watch mode: refresh in-place every intervalMs.
 * Uses cursor-home + clear-trailing to avoid visible flicker.
 * Exits when the abort signal fires (or Ctrl-C).
 */
export async function cmdStatusWatch(
  worktreeDir: string,
  projectRoot: string,
  intervalMs: number = 5_000,
  signal?: AbortSignal,
  flat: boolean = false,
): Promise<void> {
  while (!signal?.aborted) {
    // Move cursor to top-left (no full-screen clear — avoids flicker)
    process.stdout.write("\x1B[H");
    // Write status content with clear-to-end-of-line (\x1B[K) after each line
    // to prevent stale characters from previous renders bleeding through
    // when lines become shorter between refreshes
    const content = renderStatus(worktreeDir, projectRoot, flat);
    process.stdout.write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    // Clear from cursor to end of screen (removes stale trailing lines)
    process.stdout.write("\x1B[J");
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/**
 * Render the full status output as a string (no side effects).
 * Used by both cmdStatus (prints it) and cmdStatusWatch (writes it flicker-free).
 */
export function renderStatus(worktreeDir: string, projectRoot: string, flat: boolean = false): string {
  const lines: string[] = [];

  // Fast path: read state file (written by orchestrator in both daemon and interactive mode)
  const daemonState = readStateFile(projectRoot);
  const daemonPid = isDaemonRunning(projectRoot);

  if (daemonState) {
    const updatedMs = new Date(daemonState.updatedAt).getTime();
    const stateAgeMs = Date.now() - updatedMs;
    const isFresh = stateAgeMs < 60_000; // Consider fresh if updated within 60 seconds

    if (isFresh || daemonPid !== null) {
      const items = daemonStateToStatusItems(daemonState);
      const termWidth = getTerminalWidth();
      lines.push(formatStatusTable(items, termWidth, daemonState.wipLimit, flat));

      // Show dashboard URL when active
      if (daemonState.dashboardUrl) {
        lines.push(`\n  ${CYAN}Dashboard: ${daemonState.dashboardUrl}${RESET}`);
      }

      const agoStr = formatAge(stateAgeMs) + " ago";
      if (daemonPid !== null) {
        lines.push(`\n  ${DIM}Daemon running (PID ${daemonPid}), updated ${agoStr}${RESET}`);
      } else {
        lines.push(`\n  ${DIM}Orchestrating, updated ${agoStr}${RESET}`);
      }
      return lines.join("\n") + "\n";
    }
  }

  if (!existsSync(worktreeDir)) {
    const termWidth = getTerminalWidth();
    lines.push(formatStatusTable([], termWidth));
    lines.push(`\n  ${DIM}Worktree directory: ${worktreeDir} (not found)${RESET}`);
    return lines.join("\n") + "\n";
  }

  const todoMeta = loadTodoMetadata(projectRoot);
  const items: StatusItem[] = [];

  // Hub-local worktrees
  try {
    const entries = readdirSync(worktreeDir);
    for (const entry of entries) {
      if (!entry.startsWith("todo-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(5); // strip "todo-"
      const { state, prNumber } = determineItemState(id, projectRoot);
      const meta = todoMeta.get(id);
      items.push({
        id,
        title: meta?.title ?? "",
        state,
        prNumber,
        ageMs: getWorktreeAge(wtDir),
        repoLabel: "",
        dependencies: meta?.dependencies ?? [],
      });
    }
  } catch {
    // worktreeDir might not be readable
  }

  // Cross-repo worktrees
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  if (existsSync(crossRepoIndex)) {
    const content = readFileSync(crossRepoIndex, "utf-8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      const idxId = parts[0];
      const idxRepo = parts[1];
      const idxPath = parts[2];
      if (!idxId || !idxRepo || !idxPath) continue;
      if (!existsSync(idxPath)) continue;
      const { state, prNumber } = determineItemState(idxId, idxRepo);
      const meta = todoMeta.get(idxId);
      items.push({
        id: idxId,
        title: meta?.title ?? "",
        state,
        prNumber,
        ageMs: getWorktreeAge(idxPath),
        repoLabel: basename(idxRepo),
        dependencies: meta?.dependencies ?? [],
      });
    }
  }

  return formatStatusTable(items, getTerminalWidth(), undefined, flat) + "\n";
}

export function cmdStatus(worktreeDir: string, projectRoot: string, flat: boolean = false): void {
  process.stdout.write(renderStatus(worktreeDir, projectRoot, flat));
}

export function cmdPartitions(partitionDir: string): void {
  console.log(`${BOLD}Partition allocation:${RESET}`);
  console.log();

  if (!existsSync(partitionDir)) {
    console.log("  No partitions allocated");
    return;
  }

  try {
    const entries = readdirSync(partitionDir);
    for (const entry of entries) {
      const filePath = join(partitionDir, entry);
      try {
        const todoId = readFileSync(filePath, "utf-8").trim();
        console.log(`  Partition ${entry}: ${todoId}`);
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    console.log("  No partitions allocated");
  }
}
