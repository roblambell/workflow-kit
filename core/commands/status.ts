// status and partitions commands: show active worktree status and partition allocation.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { BOLD, DIM, RESET } from "../output.ts";
import { run } from "../shell.ts";
import { ID_PATTERN_GLOBAL, ID_IN_FILENAME } from "../types.ts";
import { findMatchingPrForWorkItem } from "../work-item-files.ts";
import {
  isDaemonRunning,
  readStateFile,
  logFilePath,
  type DaemonState,
} from "../daemon.ts";

// Import shared rendering module for local use and re-export for backward compatibility.
import {
  type ItemState,
  type StatusItem,
  type TreeNode,
  type ViewOptions,
  type FrameLayout,
  type LogEntry,
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  pad,
  osc8Link,
  stripAnsiForWidth,
  computeStateColWidth,
  formatStateLabelWithPr,
  formatElapsed,
  formatTelemetrySuffix,
  formatItemRow,
  formatBatchProgress,
  formatSummary,
  formatQueuedItemRow,
  buildDependencyTree,
  formatTreeItemRow,
  formatTreeRows,
  formatStatusTable,
  mapDaemonItemState,
  daemonStateToStatusItems,
  getTerminalWidth,
  getTerminalHeight,
  buildStatusLayout,
  renderFullScreenFrame,
  clampScrollOffset,
  MIN_FULLSCREEN_ROWS,
} from "../status-render.ts";

export type { ItemState, StatusItem, TreeNode, ViewOptions, FrameLayout };
export {
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  pad,
  osc8Link,
  stripAnsiForWidth,
  computeStateColWidth,
  formatStateLabelWithPr,
  formatElapsed,
  formatTelemetrySuffix,
  formatItemRow,
  formatBatchProgress,
  formatSummary,
  formatQueuedItemRow,
  buildDependencyTree,
  formatTreeItemRow,
  formatTreeRows,
  formatStatusTable,
  mapDaemonItemState,
  daemonStateToStatusItems,
  getTerminalWidth,
  getTerminalHeight,
  buildStatusLayout,
  renderFullScreenFrame,
  clampScrollOffset,
  MIN_FULLSCREEN_ROWS,
};

// ─── Data gathering ──────────────────────────────────────────────────────────

interface WorkItemMetadata {
  title: string;
  dependencies: string[];
  lineageToken?: string;
}

interface StatusDeps {
  runCommand: typeof run;
}

const defaultStatusDeps: StatusDeps = {
  runCommand: run,
};

/** Try to read work item metadata from .ninthwave/work/ directory. Returns a map of ID → metadata. */
function loadWorkItemMetadata(projectRoot: string): Map<string, WorkItemMetadata> {
  const metadata = new Map<string, WorkItemMetadata>();
  const workDir = join(projectRoot, ".ninthwave", "work");
  if (!existsSync(workDir)) return metadata;

  try {
    const entries = readdirSync(workDir).filter((e) => e.endsWith(".md"));
    for (const entry of entries) {
      const filePath = join(workDir, entry);
      try {
        const content = readFileSync(filePath, "utf-8");
        // Extract title from the first # heading
        const titleMatch = content.match(/^# (.+)$/m);
        if (titleMatch) {
          const idMatch = entry.match(ID_IN_FILENAME);
          const id = idMatch ? idMatch[1]! : entry.replace(/\.md$/, "");
          // Extract dependencies from **Depends on:** line
          const deps: string[] = [];
          const depsMatch = content.match(/^\*\*Depends on:\*\*\s+(.+)$/m);
          const lineageMatch = content.match(/^\*\*Lineage:\*\*\s+(.+)$/m);
          if (depsMatch) {
            const depsStr = depsMatch[1]!;
            if (depsStr.toLowerCase() !== "none" && depsStr !== "-") {
              const idMatches = depsStr.match(ID_PATTERN_GLOBAL);
              if (idMatches) deps.push(...idMatches);
            }
          }
          metadata.set(id, {
            title: titleMatch[1]!.trim(),
            dependencies: deps,
            lineageToken: lineageMatch?.[1]?.trim().toLowerCase(),
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
  item?: { id: string; title: string; lineageToken?: string },
  deps: StatusDeps = defaultStatusDeps,
): { state: ItemState; prNumber: number | null } {
  const branch = `ninthwave/${id}`;

  // Check remote branch exists
  const hasRemote =
    deps.runCommand("git", ["-C", repoRoot, "rev-parse", "--verify", `origin/${branch}`])
      .exitCode === 0;

  // If no remote, it's still in progress
  if (!hasRemote) {
    return { state: "implementing", prNumber: null };
  }

  // Try gh for PR status
  const ghCheck = deps.runCommand("which", ["gh"]);
  if (ghCheck.exitCode !== 0) {
    return { state: "ci-pending", prNumber: null };
  }

  // Check merged PRs
  const merged = deps.runCommand(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number,title,body",
      "--limit",
      "100",
    ],
    { cwd: repoRoot },
  );
  if (merged.exitCode === 0 && merged.stdout) {
    try {
      const mergedPrs = JSON.parse(merged.stdout) as Array<{
        number: number;
        title: string;
        body?: string;
      }>;
      const matchingMergedPr = findMatchingPrForWorkItem(mergedPrs, item);
      if (matchingMergedPr) {
        return { state: "merged", prNumber: matchingMergedPr.number };
      }
    } catch {
      // ignore parse failures and continue to open PR lookup
    }
  }

  // Check open PRs
  const open = deps.runCommand(
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
    const checks = deps.runCommand(
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
        return { state: "ci-pending", prNumber: prNum };
      }
    }

    return { state: "ci-pending", prNumber: prNum };
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

// ─── Log file tailing ────────────────────────────────────────────────────────

/** Maximum number of log lines to read from the log file tail. */
const LOG_TAIL_LINES = 200;

/**
 * Parse a JSON-line log file (as written by orchestrate.ts in TUI mode) into
 * PanelLogEntry entries. Reads the last LOG_TAIL_LINES lines from the file.
 * Returns an empty array if the file is missing or unreadable.
 */
export function tailLogFile(projectRoot: string): LogEntry[] {
  const path = logFilePath(projectRoot);
  try {
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-LOG_TAIL_LINES);
    const entries: LogEntry[] = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line);
        const levelTag = parsed.level && parsed.level !== "info" ? `[${parsed.level}] ` : "";
        entries.push({
          timestamp: parsed.ts ?? new Date().toISOString(),
          itemId: parsed.itemId ?? parsed.id ?? "",
          message: `${levelTag}${parsed.event ?? ""}${parsed.message ? ": " + parsed.message : ""}`,
        });
      } catch {
        // skip unparseable lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Run `ninthwave status` in watch mode using the shared panel TUI from orchestrate.ts.
 *
 * Delegates to `runTUI()` in read-only mode, giving status the same two-page layout,
 * keyboard shortcuts, and rendering as `nw watch`. When a daemon is running, log
 * entries are tailed from the daemon's log file.
 */
export async function cmdStatusWatch(
  worktreeDir: string,
  projectRoot: string,
  intervalMs: number = 2_000,
  signal?: AbortSignal,
  _flat: boolean = false,
): Promise<void> {
  const daemonPid = isDaemonRunning(projectRoot);
  const { runTUI } = await import("./orchestrate.ts");

  await runTUI({
    getItems: () => gatherStatusItems(worktreeDir, projectRoot),
    getLogEntries: daemonPid !== null ? () => tailLogFile(projectRoot) : undefined,
    intervalMs,
    signal,
    panelMode: "status-only",
  });
}

/**
 * Gather status items and metadata for full-screen layout rendering.
 * Returns items, wipLimit, and sessionStartedAt (from daemon state if available).
 */
function gatherStatusItems(
  worktreeDir: string,
  projectRoot: string,
  deps: StatusDeps = defaultStatusDeps,
): { items: StatusItem[]; wipLimit: number | undefined; sessionStartedAt?: string; viewOptions?: ViewOptions } {
  // Fast path: read state file (written by orchestrator in both daemon and interactive mode)
  const daemonState = readStateFile(projectRoot);
  const daemonPid = isDaemonRunning(projectRoot);

  if (daemonState) {
    const updatedMs = new Date(daemonState.updatedAt).getTime();
    const stateAgeMs = Date.now() - updatedMs;
    const isFresh = stateAgeMs < 60_000;

    if (isFresh || daemonPid !== null) {
      const items = daemonStateToStatusItems(daemonState);
      return {
        items: items.map((i) => ({ ...i })), // copy to avoid mutation
        wipLimit: daemonState.wipLimit,
        sessionStartedAt: daemonState.startedAt,
        ...((daemonState.emptyState || daemonState.crewStatus)
          ? {
              viewOptions: {
                ...(daemonState.emptyState ? { emptyState: daemonState.emptyState } : {}),
                ...(daemonState.crewStatus ? { crewStatus: daemonState.crewStatus } : {}),
              },
            }
          : {}),
      };
    }
  }

  if (!existsSync(worktreeDir)) {
    return { items: [], wipLimit: undefined };
  }

  const workItemMeta = loadWorkItemMetadata(projectRoot);
  const items: StatusItem[] = [];

  // Hub-local worktrees
  try {
    const entries = readdirSync(worktreeDir);
    for (const entry of entries) {
      if (!entry.startsWith("ninthwave-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(10);
      const meta = workItemMeta.get(id);
      const { state, prNumber } = determineItemState(
        id,
        projectRoot,
        meta ? { id, title: meta.title, lineageToken: meta.lineageToken } : undefined,
        deps,
      );
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
      const meta = workItemMeta.get(idxId);
      const { state, prNumber } = determineItemState(
        idxId,
        idxRepo,
        meta ? { id: idxId, title: meta.title, lineageToken: meta.lineageToken } : undefined,
        deps,
      );
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

  return { items, wipLimit: undefined };
}

/**
 * Render the full status output as a string (no side effects).
 * Used by both cmdStatus (prints it) and cmdStatusWatch (writes it flicker-free).
 * Optional viewOptions controls metrics panel, deps detail, and help footer.
 */
export function renderStatus(
  worktreeDir: string,
  projectRoot: string,
  flat: boolean = false,
  viewOptions?: ViewOptions,
  deps: StatusDeps = defaultStatusDeps,
): string {
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
      // Merge sessionStartedAt from daemon state into viewOptions so metrics
      // (session duration, throughput) display actual values instead of "-".
      const mergedOpts = {
        ...viewOptions,
        sessionStartedAt: daemonState.startedAt,
        ...(daemonState.emptyState ? { emptyState: daemonState.emptyState } : {}),
        ...(daemonState.crewStatus ? { crewStatus: daemonState.crewStatus } : {}),
      };
      lines.push(formatStatusTable(items, termWidth, daemonState.wipLimit, flat, mergedOpts));

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
    lines.push(formatStatusTable([], termWidth, undefined, false, viewOptions));
    lines.push(`\n  ${DIM}Worktree directory: ${worktreeDir} (not found)${RESET}`);
    return lines.join("\n") + "\n";
  }

  const workItemMeta = loadWorkItemMetadata(projectRoot);
  const items: StatusItem[] = [];

  // Hub-local worktrees
  try {
    const entries = readdirSync(worktreeDir);
    for (const entry of entries) {
      if (!entry.startsWith("ninthwave-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(10); // strip "ninthwave-"
      const meta = workItemMeta.get(id);
      const { state, prNumber } = determineItemState(
        id,
        projectRoot,
        meta ? { id, title: meta.title, lineageToken: meta.lineageToken } : undefined,
        deps,
      );
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
      const meta = workItemMeta.get(idxId);
      const { state, prNumber } = determineItemState(
        idxId,
        idxRepo,
        meta ? { id: idxId, title: meta.title, lineageToken: meta.lineageToken } : undefined,
        deps,
      );
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

  return formatStatusTable(items, getTerminalWidth(), undefined, flat, viewOptions) + "\n";
}

export function cmdStatus(
  worktreeDir: string,
  projectRoot: string,
  flat: boolean = false,
  deps: StatusDeps = defaultStatusDeps,
): void {
  process.stdout.write(renderStatus(worktreeDir, projectRoot, flat, undefined, deps));
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
