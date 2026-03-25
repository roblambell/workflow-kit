// retry command: reset stuck/done items to queued for re-processing.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { die, info, warn, GREEN, RESET } from "../output.ts";
import {
  readStateFile,
  writeStateFile,
  isDaemonRunning,
  type DaemonIO,
  type DaemonState,
  type DaemonStateItem,
  type ProcessExistsCheck,
  processExists,
} from "../daemon.ts";
import { cleanSingleWorktree } from "./clean.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface RetryDeps {
  io: DaemonIO;
  check: ProcessExistsCheck;
  cleanWorktree: (id: string, worktreeDir: string, projectRoot: string) => boolean;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

const defaultDeps: RetryDeps = {
  io: { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync },
  check: processExists,
  cleanWorktree: cleanSingleWorktree,
  log: (msg) => console.log(msg),
  logError: (msg) => console.error(msg),
};

// ── Retryable state check ────────────────────────────────────────────

/** States that can be retried (terminal states). */
const RETRYABLE_STATES = new Set(["stuck", "done"]);

/** States that are actively being processed and cannot be retried. */
const ACTIVE_STATES = new Set([
  "queued",
  "ready",
  "launching",
  "implementing",
  "pr-open",
  "ci-pending",
  "ci-passed",
  "ci-failed",
  "review-pending",
  "reviewing",
  "merging",
  "merged",
]);

// ── Command implementation ───────────────────────────────────────────

/**
 * Retry one or more stuck/done items by resetting them to queued.
 * Returns a summary message.
 */
export function cmdRetry(
  args: string[],
  worktreeDir: string,
  projectRoot: string,
  deps: RetryDeps = defaultDeps,
): string {
  const ids = args.filter((a) => !a.startsWith("-"));
  if (ids.length === 0) {
    die("Usage: ninthwave retry <ID> [ID2...]");
  }

  // Read current state file
  const state = readStateFile(projectRoot, deps.io);
  if (!state) {
    die("No orchestrator state file found. Has the orchestrator been run?");
  }

  const results: string[] = [];
  let resetCount = 0;

  for (const id of ids) {
    const item = state.items.find((i) => i.id === id);

    if (!item) {
      deps.logError(`${id}: not found in orchestrator state`);
      results.push(`${id}: not found`);
      continue;
    }

    if (ACTIVE_STATES.has(item.state)) {
      deps.logError(
        `${id}: cannot retry — currently in "${item.state}" state. Only stuck or done items can be retried.`,
      );
      results.push(`${id}: skipped (active: ${item.state})`);
      continue;
    }

    if (!RETRYABLE_STATES.has(item.state)) {
      deps.logError(
        `${id}: cannot retry — unexpected state "${item.state}"`,
      );
      results.push(`${id}: skipped (${item.state})`);
      continue;
    }

    // Clean up existing worktree and branch
    const cleaned = deps.cleanWorktree(id, worktreeDir, projectRoot);
    if (cleaned) {
      info(`Cleaned worktree for ${id}`);
    }

    // Reset the item state
    item.state = "queued";
    item.retryCount = 0;
    item.ciFailCount = 0;
    item.prNumber = null;
    item.lastTransition = new Date().toISOString();

    resetCount++;
    info(`Reset ${id} to queued`);
    results.push(`${id}: reset to queued`);
  }

  // Write updated state atomically (write to temp, then rename)
  if (resetCount > 0) {
    state.updatedAt = new Date().toISOString();
    writeStateFile(projectRoot, state, deps.io);

    // Check if daemon is running and notify
    const daemonPid = isDaemonRunning(projectRoot, deps.io, deps.check);
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGUSR1");
        info(`Notified running daemon (PID ${daemonPid}) to re-process`);
      } catch {
        warn(`Could not notify daemon (PID ${daemonPid})`);
      }
    } else {
      deps.log(
        `\nDaemon is not running. Start the orchestrator to process retried items:\n  ninthwave orchestrate --items ${ids.join(" ")} --daemon`,
      );
    }
  }

  const summary = `${GREEN}Reset ${resetCount}/${ids.length} item(s) to queued${RESET}`;
  deps.log(summary);
  return results.join("\n");
}
