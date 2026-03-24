// orchestrate command: event loop for parallel TODO processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT shutdown.

import { existsSync } from "fs";
import { join } from "path";
import {
  Orchestrator,
  type MergeStrategy,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
  type OrchestratorItem,
  type OrchestratorItemState,
} from "../orchestrator.ts";
import { parseTodos } from "../parser.ts";
import { checkPrStatus } from "./watch.ts";
import { launchSingleItem, detectAiTool } from "./start.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { cmdMarkDone } from "./mark-done.ts";
import { prMerge, prComment } from "../gh.ts";
import { fetchOrigin, ffMerge } from "../git.ts";
import * as cmux from "../cmux.ts";
import { die } from "../output.ts";
import type { TodoItem } from "../types.ts";

// ── Structured logging ─────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  [key: string]: unknown;
}

export function structuredLog(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

// ── Snapshot building ──────────────────────────────────────────────

/**
 * Build a PollSnapshot by querying GitHub PR status and cmux workspace state
 * for all tracked items. Computes readyIds based on dependency satisfaction.
 */
export function buildSnapshot(
  orch: Orchestrator,
  projectRoot: string,
  _worktreeDir: string,
): PollSnapshot {
  const items: ItemSnapshot[] = [];
  const readyIds: string[] = [];

  for (const orchItem of orch.getAllItems()) {
    // Compute readyIds for queued items
    if (orchItem.state === "queued") {
      const allDepsMet = orchItem.todo.dependencies.every((depId) => {
        const depItem = orch.getItem(depId);
        // Dep is met if: not tracked, or in done/merged state
        return !depItem || depItem.state === "done" || depItem.state === "merged";
      });
      if (allDepsMet) {
        readyIds.push(orchItem.id);
      }
      continue;
    }

    // Skip terminal states — nothing to poll
    if (orchItem.state === "done" || orchItem.state === "stuck") continue;

    const snap: ItemSnapshot = { id: orchItem.id };

    // Check PR status via gh for items past the implementing phase
    const statusLine = checkPrStatus(orchItem.id, projectRoot);
    if (statusLine) {
      const parts = statusLine.split("\t");
      const prNumStr = parts[1];
      const status = parts[2];

      if (prNumStr) {
        snap.prNumber = parseInt(prNumStr, 10);
      }

      switch (status) {
        case "merged":
          snap.prState = "merged";
          break;
        case "ready":
          snap.ciStatus = "pass";
          snap.prState = "open";
          snap.reviewDecision = "APPROVED";
          snap.isMergeable = true;
          break;
        case "ci-passed":
          snap.ciStatus = "pass";
          snap.prState = "open";
          break;
        case "failing":
          snap.ciStatus = "fail";
          snap.prState = "open";
          break;
        case "pending":
          snap.ciStatus = "pending";
          snap.prState = "open";
          break;
        // "no-pr" — leave snap fields unset
      }
    }

    // Check worker alive for early-stage items
    if (orchItem.state === "launching" || orchItem.state === "implementing") {
      snap.workerAlive = isWorkerAlive(orchItem);
    }

    items.push(snap);
  }

  return { items, readyIds };
}

/** Check if a worker's cmux workspace is still running. */
function isWorkerAlive(item: OrchestratorItem): boolean {
  if (!item.workspaceRef) return false;
  const workspaces = cmux.listWorkspaces();
  if (!workspaces) return false;
  return workspaces.includes(item.workspaceRef) || workspaces.includes(item.id);
}

// ── Adaptive poll interval ─────────────────────────────────────────

/** Compute poll interval based on current item states. */
export function adaptivePollInterval(orch: Orchestrator): number {
  const items = orch.getAllItems();

  // 10s between batches: items are ready and about to launch
  if (items.some((i) => i.state === "ready")) {
    return 10_000;
  }

  // 30s when workers active: launching or implementing
  if (items.some((i) => i.state === "launching" || i.state === "implementing")) {
    return 30_000;
  }

  // 120s when waiting for reviews or CI
  return 120_000;
}

// ── State reconstruction (crash recovery) ──────────────────────────

/**
 * Reconstruct orchestrator state from existing worktrees and GitHub PRs.
 * Called on startup to resume after a crash or restart.
 */
export function reconstructState(
  orch: Orchestrator,
  projectRoot: string,
  worktreeDir: string,
): void {
  for (const item of orch.getAllItems()) {
    const wtPath = join(worktreeDir, `todo-${item.id}`);
    if (!existsSync(wtPath)) continue;

    // Item has a worktree — check PR status
    const statusLine = checkPrStatus(item.id, projectRoot);
    if (!statusLine) {
      orch.setState(item.id, "implementing");
      continue;
    }

    const parts = statusLine.split("\t");
    const prNumStr = parts[1];
    const status = parts[2];

    if (prNumStr) {
      const orchItem = orch.getItem(item.id)!;
      orchItem.prNumber = parseInt(prNumStr, 10);
    }

    switch (status) {
      case "merged":
        orch.setState(item.id, "merged");
        break;
      case "ready":
      case "ci-passed":
        orch.setState(item.id, "ci-passed");
        break;
      case "failing":
        orch.setState(item.id, "ci-failed");
        break;
      case "pending":
        orch.setState(item.id, "ci-pending");
        break;
      case "no-pr":
      default:
        orch.setState(item.id, "implementing");
        break;
    }
  }
}

// ── Interruptible sleep ────────────────────────────────────────────

/** Sleep that resolves immediately if the abort signal fires. */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
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

// ── Event loop ─────────────────────────────────────────────────────

/** Dependencies injected into orchestrateLoop for testability. */
export interface OrchestrateLoopDeps {
  buildSnapshot: (orch: Orchestrator, projectRoot: string, worktreeDir: string) => PollSnapshot;
  sleep: (ms: number) => Promise<void>;
  log: (entry: LogEntry) => void;
  actionDeps: OrchestratorDeps;
}

export interface OrchestrateLoopConfig {
  /** Override adaptive poll interval (milliseconds). */
  pollIntervalMs?: number;
}

/**
 * Main event loop. Polls, detects transitions, executes actions, sleeps.
 * Exits when all items reach terminal state or signal is aborted.
 */
export async function orchestrateLoop(
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  config: OrchestrateLoopConfig = {},
  signal?: AbortSignal,
): Promise<void> {
  const { log } = deps;

  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "orchestrate_start",
    items: orch.getAllItems().map((i) => i.id),
    wipLimit: orch.config.wipLimit,
    mergeStrategy: orch.config.mergeStrategy,
  });

  while (true) {
    if (signal?.aborted) {
      log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "SIGINT" });
      break;
    }

    // Check if all items are in terminal state
    const allItems = orch.getAllItems();
    const allTerminal = allItems.every((i) => i.state === "done" || i.state === "stuck");
    if (allTerminal) {
      const doneCount = allItems.filter((i) => i.state === "done").length;
      const stuckCount = allItems.filter((i) => i.state === "stuck").length;
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "orchestrate_complete",
        done: doneCount,
        stuck: stuckCount,
        total: allItems.length,
      });
      break;
    }

    // Capture pre-transition states for logging
    const prevStates = new Map<string, OrchestratorItemState>();
    for (const item of allItems) {
      prevStates.set(item.id, item.state);
    }

    // Build snapshot from external state
    const snapshot = deps.buildSnapshot(orch, ctx.projectRoot, ctx.worktreeDir);

    // Process transitions (pure state machine)
    const actions = orch.processTransitions(snapshot);

    // Log state transitions
    for (const item of orch.getAllItems()) {
      const prev = prevStates.get(item.id);
      if (prev && prev !== item.state) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "transition",
          itemId: item.id,
          from: prev,
          to: item.state,
        });
      }
    }

    // Execute actions
    for (const action of actions) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "action_execute",
        action: action.type,
        itemId: action.itemId,
        prNumber: action.prNumber,
      });

      const result = orch.executeAction(action, ctx, deps.actionDeps);

      log({
        ts: new Date().toISOString(),
        level: result.success ? "info" : "warn",
        event: "action_result",
        action: action.type,
        itemId: action.itemId,
        success: result.success,
        error: result.error,
      });
    }

    // Log state summary
    const states: Record<string, string[]> = {};
    for (const item of orch.getAllItems()) {
      if (!states[item.state]) states[item.state] = [];
      states[item.state]!.push(item.id);
    }
    log({ ts: new Date().toISOString(), level: "debug", event: "state_summary", states });

    // Sleep — adaptive or fixed override
    const interval = config.pollIntervalMs ?? adaptivePollInterval(orch);
    await deps.sleep(interval);
  }
}

// ── CLI command ─────────────────────────────────────────────────────

export async function cmdOrchestrate(
  args: string[],
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
): Promise<void> {
  let itemIds: string[] = [];
  let mergeStrategy: MergeStrategy = "asap";
  let wipLimit = 4;
  let pollIntervalOverride: number | undefined;

  // Parse args
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--items":
        itemIds = (args[i + 1] ?? "").split(",").filter(Boolean);
        i += 2;
        break;
      case "--merge-strategy":
        mergeStrategy = (args[i + 1] ?? "asap") as MergeStrategy;
        i += 2;
        break;
      case "--wip-limit":
        wipLimit = parseInt(args[i + 1] ?? "4", 10);
        i += 2;
        break;
      case "--poll-interval":
        pollIntervalOverride = parseInt(args[i + 1] ?? "30", 10) * 1000;
        i += 2;
        break;
      case "--orchestrator-ws":
        // Reserved for future use — workspace ref for the orchestrator itself
        i += 2;
        break;
      default:
        die(`Unknown option: ${args[i]}`);
    }
  }

  if (itemIds.length === 0) {
    die(
      "Usage: ninthwave orchestrate --items ID1,ID2 [--merge-strategy asap|approved|ask] [--wip-limit N] [--poll-interval SECS]",
    );
  }

  // Parse TODO items
  const allTodos = parseTodos(todosFile, worktreeDir);
  const todoMap = new Map<string, TodoItem>();
  for (const todo of allTodos) {
    todoMap.set(todo.id, todo);
  }

  // Validate all items exist
  for (const id of itemIds) {
    if (!todoMap.has(id)) {
      die(`Item ${id} not found in TODOS.md`);
    }
  }

  // Create orchestrator
  const orch = new Orchestrator({ wipLimit, mergeStrategy });
  for (const id of itemIds) {
    orch.addItem(todoMap.get(id)!);
  }

  // Reconstruct state from disk + GitHub (crash recovery)
  reconstructState(orch, projectRoot, worktreeDir);

  // Detect AI tool
  const aiTool = detectAiTool();

  const ctx: ExecutionContext = { projectRoot, worktreeDir, todosFile, aiTool };

  // Real action dependencies
  const actionDeps: OrchestratorDeps = {
    launchSingleItem,
    cleanSingleWorktree,
    cmdMarkDone,
    prMerge: (repoRoot, prNumber) => prMerge(repoRoot, prNumber),
    prComment: (repoRoot, prNumber, body) => prComment(repoRoot, prNumber, body),
    sendMessage: cmux.sendMessage,
    closeWorkspace: cmux.closeWorkspace,
    fetchOrigin,
    ffMerge,
  };

  // Graceful SIGINT handling
  const abortController = new AbortController();
  const sigintHandler = () => {
    structuredLog({ ts: new Date().toISOString(), level: "info", event: "sigint_received" });
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  const loopDeps: OrchestrateLoopDeps = {
    buildSnapshot,
    sleep: (ms) => interruptibleSleep(ms, abortController.signal),
    log: structuredLog,
    actionDeps,
  };

  try {
    await orchestrateLoop(
      orch,
      ctx,
      loopDeps,
      pollIntervalOverride ? { pollIntervalMs: pollIntervalOverride } : {},
      abortController.signal,
    );
  } finally {
    process.removeListener("SIGINT", sigintHandler);
  }
}
