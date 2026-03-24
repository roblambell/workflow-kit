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

// ─── Types ───────────────────────────────────────────────────────────────────

export type ItemState =
  | "merged"
  | "implementing"
  | "ci-failed"
  | "ci-pending"
  | "review"
  | "pr-open"
  | "in-progress";

export interface StatusItem {
  id: string;
  title: string;
  state: ItemState;
  prNumber: number | null;
  ageMs: number; // milliseconds since worktree created
  repoLabel: string;
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
    default:
      return DIM;
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
  const id = pad(item.id, 12);
  const color = stateColor(item.state);
  const label = pad(stateLabel(item.state), 14);
  const pr = item.prNumber ? pad(`#${item.prNumber}`, 7) : pad("-", 7);
  const age = pad(formatAge(item.ageMs), 8);
  const title = truncateTitle(item.title || item.id, titleWidth);
  const repo = item.repoLabel ? ` ${DIM}[${item.repoLabel}]${RESET}` : "";

  return `  ${id}${color}${label}${RESET} ${pr} ${age} ${title}${repo}`;
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

  // Order states for display: merged first (good news), then active, then bad
  const order: ItemState[] = [
    "merged",
    "review",
    "pr-open",
    "ci-pending",
    "implementing",
    "in-progress",
    "ci-failed",
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
 * Format the complete status table from a list of StatusItems.
 * Returns a multi-line string ready for console output.
 */
export function formatStatusTable(
  items: StatusItem[],
  termWidth: number = 80,
): string {
  const lines: string[] = [];

  lines.push(`${BOLD}ninthwave status${RESET}`);
  lines.push("");

  if (items.length === 0) {
    lines.push(`  ${DIM}No active items${RESET}`);
    return lines.join("\n");
  }

  // Column widths: 2 indent + 12 ID + 14 state + 1 + 7 PR + 1 + 8 age + 1 + title
  // = 46 fixed + title
  const fixedWidth = 46;
  const titleWidth = Math.max(10, termWidth - fixedWidth);

  // Header
  const header = `  ${DIM}${pad("ID", 12)}${pad("STATE", 14)} ${pad("PR", 7)} ${pad("AGE", 8)} TITLE${RESET}`;
  lines.push(header);

  // Separator
  const sep = `  ${DIM}${"─".repeat(Math.min(termWidth - 2, 78))}${RESET}`;
  lines.push(sep);

  // Item rows
  for (const item of items) {
    lines.push(formatItemRow(item, titleWidth));
  }

  // Footer
  lines.push(sep);
  lines.push(formatBatchProgress(items));
  lines.push(formatSummary(items));

  return lines.join("\n");
}

// ─── Data gathering ──────────────────────────────────────────────────────────

/** Try to read TODO titles from TODOS.md. Returns a map of ID → title. */
function loadTodoTitles(projectRoot: string): Map<string, string> {
  const titles = new Map<string, string>();
  const todosFile = join(projectRoot, "TODOS.md");
  if (!existsSync(todosFile)) return titles;

  try {
    const content = readFileSync(todosFile, "utf-8");
    // Match ### lines with IDs in parens
    const regex = /^### (.+?) \(([A-Z]-[A-Za-z0-9]+-[0-9]+)/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      titles.set(match[2]!, match[1]!.trim());
    }
  } catch {
    // ignore
  }

  return titles;
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

// ─── Commands ────────────────────────────────────────────────────────────────

export function cmdStatus(worktreeDir: string, projectRoot: string): void {
  if (!existsSync(worktreeDir)) {
    console.log(formatStatusTable([]));
    return;
  }

  const titles = loadTodoTitles(projectRoot);
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
      items.push({
        id,
        title: titles.get(id) ?? "",
        state,
        prNumber,
        ageMs: getWorktreeAge(wtDir),
        repoLabel: "",
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
      items.push({
        id: idxId,
        title: titles.get(idxId) ?? "",
        state,
        prNumber,
        ageMs: getWorktreeAge(idxPath),
        repoLabel: basename(idxRepo),
      });
    }
  }

  // Determine terminal width
  let termWidth = 80;
  try {
    const cols = process.stdout.columns;
    if (cols && cols > 0) termWidth = cols;
  } catch {
    // default to 80
  }

  console.log(formatStatusTable(items, termWidth));
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
