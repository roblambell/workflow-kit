// status and partitions commands: show active worktree status and partition allocation.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { BOLD, CYAN, DIM, RESET } from "../output.ts";
import { run } from "../shell.ts";
import {
  isDaemonRunning,
  readStateFile,
  type DaemonState,
} from "../daemon.ts";

// Import shared rendering module for local use and re-export for backward compatibility.
import {
  type ItemState,
  type StatusItem,
  type TreeNode,
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  pad,
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
} from "../status-render.ts";

export type { ItemState, StatusItem, TreeNode };
export {
  stateColor,
  stateIcon,
  stateLabel,
  truncateTitle,
  formatAge,
  pad,
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
};

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
