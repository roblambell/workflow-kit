// Command registry -- single source of truth for all CLI commands.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { die } from "./output.ts";
import { run } from "./shell.ts";
import { getBundleDir } from "./paths.ts";
import { cmdList } from "./commands/list.ts";
import { cmdDeps } from "./commands/deps.ts";
import { cmdConflicts } from "./commands/conflicts.ts";
import { cmdBatchOrder } from "./commands/batch-order.ts";
import { cmdStatus, cmdStatusWatch, cmdPartitions } from "./commands/status.ts";
import { cmdStart } from "./commands/run-items.ts";
import {
  cmdCloseWorkspaces,
  cmdCloseWorkspace,
  cmdClean,
  cmdCleanSingle,
} from "./commands/clean.ts";
import { cmdMarkDone, cmdMergedIds } from "./commands/mark-done.ts";
import {
  cmdWatchReady,
  cmdPrWatch,
  cmdPrActivity,
} from "./commands/pr-monitor.ts";
import { cmdCiFailures } from "./commands/ci.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdBroker } from "./commands/broker.ts";
import { cmdCrew } from "./commands/crew.ts";
import { cmdReconcile } from "./commands/reconcile.ts";
import { cmdAnalytics } from "./commands/analytics.ts";
import { cmdHistory } from "./commands/history.ts";
import { cmdStop } from "./commands/stop.ts";
import { cmdRetry } from "./commands/retry.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdHeartbeat } from "./commands/heartbeat.ts";
import { cmdFeedbackDone } from "./commands/feedback-done.ts";
import { cmdInbox } from "./commands/inbox.ts";
import { cmdLogs } from "./commands/logs.ts";
import { cmdLineageToken } from "./commands/lineage-token.ts";
import { cmdReviewInbox } from "./commands/review-inbox.ts";
import { cmdUpdate } from "./commands/update.ts";

// ── Types ───────────────────────────────────────────────────────────

export type CommandGroup = "workflow" | "diagnostic" | "advanced";

export interface CommandContext {
  args: string[];
  projectRoot: string;
  workDir: string;
  worktreeDir: string;
  partitionDir: string;
}

export interface CommandEntry {
  name: string;
  usage: string;
  description: string;
  group: CommandGroup;
  needsRoot: boolean;
  needsWork: boolean;
  handler: (ctx: CommandContext) => void | Promise<void>;
  flags: Record<string, string>;
  examples: string[];
}

// ── Group display configuration ─────────────────────────────────────

const GROUP_ORDER: CommandGroup[] = ["workflow", "diagnostic", "advanced"];
const GROUP_LABELS: Record<CommandGroup, string> = {
  workflow: "Workflow",
  diagnostic: "Diagnostics",
  advanced: "Advanced",
};

// ── Version handler (extracted from inline logic) ───────────────────

function cmdVersion(): void {
  try {
    const bundleDir = getBundleDir();
    const versionFile = join(bundleDir, "VERSION");
    if (existsSync(versionFile)) {
      console.log(readFileSync(versionFile, "utf-8").trim());
    } else {
      const result = run("git", ["-C", bundleDir, "describe", "--tags", "--always"]);
      console.log(result.exitCode === 0 ? result.stdout : "unknown");
    }
  } catch {
    console.log("unknown");
  }
}

// ── Command registry ────────────────────────────────────────────────

/**
 * Single source of truth for all CLI commands.
 * Commands are ordered by group: workflow, diagnostic, advanced.
 * Within each group, order determines help output order.
 */
export const COMMAND_REGISTRY: ReadonlyArray<CommandEntry> = [
  // ── Workflow ────────────────────────────────────────────────────────
  {
    name: "init",
    usage:
      "init [--global] [--yes] [--broker-secret <value>] [--skip-broker]",
    description: "Auto-detect and initialize ninthwave (prompts for broker secret)",
    group: "workflow",
    needsRoot: false,
    needsWork: false,
    handler: async (ctx) => { await cmdInit(ctx.args); },
    flags: {
      "--global": "Install global shell alias and config",
      "--yes": "Skip confirmation prompts (auto-generates a broker secret)",
      "-y": "Skip confirmation prompts (auto-generates a broker secret)",
      "--broker-secret":
        "Save the given 32-byte base64 secret as this project's broker_secret (team onboarding). Mutually exclusive with --skip-broker.",
      "--skip-broker":
        "Skip broker secret provisioning and stay local-only. Mutually exclusive with --broker-secret.",
    },
    examples: [
      "nw init",
      "nw init --global",
      "nw init --yes",
      'nw init --yes --broker-secret "$SECRET"',
      "nw init --yes --skip-broker",
    ],
  },
  {
    name: "broker",
    usage: "broker [--host H] [--port N] [--data-dir D] [--event-log F] [--save-crew-url]",
    description: "Start the self-hosted broker runtime in the foreground",
    group: "workflow",
    needsRoot: true,
    needsWork: false,
    handler: async (ctx) => { await cmdBroker(ctx.args, ctx.projectRoot); },
    flags: {
      "--host": "Hostname/IP to bind to (default: 0.0.0.0)",
      "--port": "Port to listen on (default: 4444)",
      "--data-dir": "Directory for crew state persistence",
      "--event-log": "Path to JSONL event log file",
      "--save-crew-url": "Save the broker WebSocket URL to .ninthwave/config.json as crew_url",
    },
    examples: [
      "nw broker",
      "nw broker --port 8080",
      "nw broker --host 127.0.0.1 --port 9000",
      "nw broker --save-crew-url",
    ],
  },
  {
    name: "status",
    usage: "status [--once] [--flat]",
    description: "Live status dashboard (--once: single snapshot, --flat: no tree)",
    group: "workflow",
    needsRoot: true,
    needsWork: false,
    handler: async (ctx) => {
      const flatFlag = ctx.args.includes("--flat");
      if (ctx.args.includes("--once")) {
        cmdStatus(ctx.worktreeDir, ctx.projectRoot, flatFlag);
      } else {
        // Default is live refresh. --watch accepted silently for backwards compat.
        await cmdStatusWatch(ctx.worktreeDir, ctx.projectRoot, 5_000, undefined, flatFlag);
      }
    },
    flags: {
      "--once": "Show status once without live refresh",
      "--watch": "Live refresh display (default, accepted for backwards compat)",
      "--flat": "Flat output without tree formatting",
    },
    examples: ["nw status", "nw status --once", "nw status --flat"],
  },
  {
    name: "stop",
    usage: "stop",
    description: "Stop the orchestrator daemon",
    group: "workflow",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => {
      cmdStop(ctx.projectRoot);
    },
    flags: {},
    examples: ["nw stop"],
  },
  {
    name: "update",
    usage: "update",
    description: "Update ninthwave to the latest published version",
    group: "workflow",
    needsRoot: false,
    needsWork: false,
    handler: (ctx) => {
      cmdUpdate(ctx.args);
    },
    flags: {},
    examples: ["nw update"],
  },

  // ── Diagnostics ─────────────────────────────────────────────────────
  {
    name: "doctor",
    usage: "doctor",
    description: "Check prerequisites and configuration health",
    group: "diagnostic",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdDoctor(ctx.projectRoot),
    flags: {},
    examples: ["nw doctor"],
  },
  {
    name: "list",
    usage: "list [--priority P] [--domain D] [--feature F] [--ready]",
    description: "List work items",
    group: "diagnostic",
    needsRoot: true,
    needsWork: true,
    handler: (ctx) => cmdList(ctx.args, ctx.workDir, ctx.worktreeDir),
    flags: {
      "--priority": "Filter by priority level (e.g. High, Medium)",
      "--domain": "Filter by domain (e.g. core, tui-status)",
      "--feature": "Filter by feature name",
      "--ready": "Show only work items with no unmet dependencies",
    },
    examples: [
      "nw list",
      "nw list --ready",
      "nw list --domain core",
      "nw list --priority High",
    ],
  },
  {
    name: "deps",
    usage: "deps <ID>",
    description: "Show dependency chain for a work item",
    group: "diagnostic",
    needsRoot: true,
    needsWork: true,
    handler: (ctx) => cmdDeps(ctx.args, ctx.workDir, ctx.worktreeDir),
    flags: {},
    examples: ["nw deps H-FOO-1"],
  },
  {
    name: "conflicts",
    usage: "conflicts <ID1> <ID2>...",
    description: "Check file conflicts between work items",
    group: "diagnostic",
    needsRoot: true,
    needsWork: true,
    handler: (ctx) => cmdConflicts(ctx.args, ctx.workDir, ctx.worktreeDir),
    flags: {},
    examples: ["nw conflicts H-FOO-1 H-FOO-2"],
  },
  {
    name: "batch-order",
    usage: "batch-order <ID1> [ID2]...",
    description: "Group work items into dependency-ordered batches",
    group: "diagnostic",
    needsRoot: true,
    needsWork: true,
    handler: (ctx) => cmdBatchOrder(ctx.args, ctx.workDir, ctx.worktreeDir),
    flags: {},
    examples: ["nw batch-order H-FOO-1 H-FOO-2 H-FOO-3"],
  },
  {
    name: "analytics",
    usage: "analytics [--all]",
    description: "Show orchestration performance trends",
    group: "diagnostic",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdAnalytics(ctx.args, ctx.projectRoot),
    flags: {
      "--all": "Show all-time analytics instead of recent",
    },
    examples: ["nw analytics", "nw analytics --all"],
  },
  {
    name: "history",
    usage: "history <ID>",
    description: "Show state transition timeline for a work item",
    group: "diagnostic",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdHistory(ctx.args, ctx.projectRoot),
    flags: {},
    examples: ["nw history H-CR-1", "nw history H-OBS-2"],
  },
  {
    name: "logs",
    usage: "logs [--follow] [--item ID] [--level warn|error] [--lines N]",
    description: "View orchestration log entries",
    group: "diagnostic",
    needsRoot: true,
    needsWork: false,
    handler: async (ctx) => { await cmdLogs(ctx.args, ctx.projectRoot); },
    flags: {
      "--follow, -f": "Tail the log file, printing new entries as they appear",
      "--item": "Filter entries to those containing the specified work item ID",
      "--level": "Filter by minimum severity level (warn or error)",
      "--lines, -n": "Show last N entries (default: 50)",
    },
    examples: [
      "nw logs",
      "nw logs -f",
      "nw logs --item H-FOO-1",
      "nw logs --level warn",
      "nw logs -n 100",
      "nw logs -f --item H-FOO-1 --level error",
    ],
  },

  // ── Advanced ────────────────────────────────────────────────────────
  {
    name: "start",
    usage: "start <ID1> [ID2]...",
    description: "Launch parallel coding sessions for work items",
    group: "advanced",
    needsRoot: true,
    needsWork: true,
    handler: async (ctx) => { await cmdStart(ctx.args, ctx.workDir, ctx.worktreeDir, ctx.projectRoot); },
    flags: {},
    examples: ["nw start H-FOO-1 H-FOO-2"],
  },
  {
    name: "clean",
    usage: "clean [ID]",
    description: "Clean up worktrees and close all workspaces",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdClean(ctx.args, ctx.worktreeDir, ctx.projectRoot),
    flags: {},
    examples: ["nw clean", "nw clean H-FOO-1"],
  },
  {
    name: "clean-single",
    usage: "clean-single <ID>",
    description: "Clean a single worktree without side effects",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdCleanSingle(ctx.args, ctx.worktreeDir, ctx.projectRoot),
    flags: {},
    examples: ["nw clean-single H-FOO-1"],
  },
  {
    name: "close-workspaces",
    usage: "close-workspaces",
    description: "Close all cmux workspaces",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: () => cmdCloseWorkspaces(),
    flags: {},
    examples: ["nw close-workspaces"],
  },
  {
    name: "close-workspace",
    usage: "close-workspace <ID>",
    description: "Close cmux workspace for a single work item",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdCloseWorkspace(ctx.args[0] ?? ""),
    flags: {},
    examples: ["nw close-workspace H-FOO-1"],
  },
  {
    name: "mark-done",
    usage: "mark-done <ID1> [ID2]...",
    description: "Remove completed work item files from disk",
    group: "advanced",
    needsRoot: true,
    needsWork: true,
    handler: (ctx) => cmdMarkDone(ctx.args, ctx.workDir),
    flags: {},
    examples: ["nw mark-done H-FOO-1 H-FOO-2"],
  },
  {
    name: "reconcile",
    usage: "reconcile",
    description: "Sync work items with merged PRs",
    group: "advanced",
    needsRoot: true,
    needsWork: true,
    handler: (ctx) => cmdReconcile(ctx.workDir, ctx.worktreeDir, ctx.projectRoot),
    flags: {},
    examples: ["nw reconcile"],
  },
  {
    name: "retry",
    usage: "retry <ID> [ID2...]",
    description: "Retry stuck or done work items (reset to queued)",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => {
      cmdRetry(ctx.args, ctx.worktreeDir, ctx.projectRoot);
    },
    flags: {},
    examples: ["nw retry H-FOO-1"],
  },
  {
    name: "crew",
    usage: "crew [status|create|join <secret>|disconnect]",
    description: "Manage the project's crew connection (broker_secret and crew_url)",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: async (ctx) => { await cmdCrew(ctx.args, ctx.projectRoot); },
    flags: {},
    examples: [
      "nw crew",
      "nw crew status",
      "nw crew create",
      "nw crew join <secret>",
      "nw crew disconnect",
    ],
  },
  {
    name: "review-inbox",
    usage: "review-inbox <friction|decisions>",
    description: "Create or update the long-lived review PR for an inbox domain",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdReviewInbox(ctx.args, ctx.projectRoot),
    flags: {},
    examples: ["nw review-inbox friction", "nw review-inbox decisions"],
  },
  {
    name: "version",
    usage: "version",
    description: "Print ninthwave version",
    group: "advanced",
    needsRoot: false,
    needsWork: false,
    handler: () => cmdVersion(),
    flags: {},
    examples: ["nw version", "nw --version", "nw -v"],
  },
  {
    name: "heartbeat",
    usage: "heartbeat --progress <0-1> --label <text> [--pr <number>]",
    description: "Report worker progress (auto-detects work item ID from branch)",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => {
      cmdHeartbeat(ctx.args, ctx.projectRoot);
    },
    flags: {
      "--progress": "Progress value from 0.0 to 1.0",
      "--label": "Status label text",
      "--pr": "PR number (enables fast PR detection by the orchestrator)",
    },
    examples: [
      'nw heartbeat --progress 0.5 --label "Writing tests"',
      'nw heartbeat --progress 1.0 --label "PR created" --pr 42',
    ],
  },
  {
    name: "feedback-done",
    usage: "feedback-done",
    description: "Signal that review feedback was addressed without code changes",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => {
      cmdFeedbackDone(ctx.args, ctx.projectRoot);
    },
    flags: {},
    examples: [
      "nw feedback-done",
    ],
  },
  {
    name: "lineage-token",
    usage: "lineage-token",
    description: "Generate a durable work-item lineage token",
    group: "advanced",
    needsRoot: false,
    needsWork: false,
    handler: (ctx) => {
      cmdLineageToken(ctx.args);
    },
    flags: {},
    examples: ["nw lineage-token"],
  },
  {
    name: "inbox",
    usage: "inbox --wait <id> | --check <id> | --status <id> | --peek <id> | --write <id> -m <text>",
    description: "File-based message inbox for orchestrator↔agent communication",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => {
      cmdInbox(ctx.args, ctx.projectRoot);
    },
    flags: {
      "--wait": "Block until a message arrives; long-lived, but parent tools may still interrupt it",
      "--check": "Non-blocking check that drains all pending messages during active work",
      "--status": "Inspect pending count, queue location, wait state, and recent history without consuming messages",
      "--peek": "Preview queued messages without consuming them",
      "--write": "Write a message to the inbox",
      "-m, --message": "Message text (used with --write)",
    },
    examples: [
      "nw inbox --wait H-FOO-1",
      "# If interrupted before output, rerun the same wait with a very long timeout",
      "nw inbox --check H-FOO-1",
      "nw inbox --status H-FOO-1",
      "nw inbox --peek H-FOO-1",
      'nw inbox --write H-FOO-1 -m "Fix CI"',
    ],
  },
  {
    name: "merged-ids",
    usage: "merged-ids",
    description: "List IDs of already-merged work items",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdMergedIds(ctx.worktreeDir, ctx.projectRoot),
    flags: {},
    examples: ["nw merged-ids"],
  },
  {
    name: "partitions",
    usage: "partitions",
    description: "Show partition allocation table",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdPartitions(ctx.partitionDir),
    flags: {},
    examples: ["nw partitions"],
  },
  {
    name: "watch-ready",
    usage: "watch-ready",
    description: "Check which PRs are merge-ready",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => {
      cmdWatchReady(ctx.worktreeDir, ctx.projectRoot);
    },
    flags: {},
    examples: ["nw watch-ready"],
  },
  {
    name: "pr-watch",
    usage: "pr-watch --pr N [--interval N] [--since T]",
    description: "Block until a PR has new activity",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: async (ctx) => { await cmdPrWatch(ctx.args, ctx.projectRoot); },
    flags: {
      "--pr": "PR number to watch",
      "--interval": "Polling interval in seconds",
      "--since": "Only detect activity after this timestamp",
    },
    examples: ["nw pr-watch --pr 42"],
  },
  {
    name: "ci-failures",
    usage: "ci-failures <PR>",
    description: "Show failing CI check details for a PR",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdCiFailures(ctx.args, ctx.projectRoot),
    flags: {},
    examples: ["nw ci-failures 42"],
  },
  {
    name: "pr-activity",
    usage: "pr-activity <PR1> [PR2]... [--since T]",
    description: "Check for new comments and reviews on PRs",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdPrActivity(ctx.args, ctx.projectRoot),
    flags: {
      "--since": "Only show activity after this timestamp",
    },
    examples: [
      "nw pr-activity 42",
      "nw pr-activity 42 43 --since 2024-01-01",
    ],
  },
];

// ── Registry lookup ─────────────────────────────────────────────────

/** Look up a command by name. Returns undefined if not found. */
export function lookupCommand(name: string): CommandEntry | undefined {
  return COMMAND_REGISTRY.find((c) => c.name === name);
}

// ── Help output ─────────────────────────────────────────────────────

const HELP_PAD = 48;

/** Get commands filtered by groups. */
function commandsByGroup(groups: CommandGroup[]): Map<CommandGroup, CommandEntry[]> {
  const map = new Map<CommandGroup, CommandEntry[]>();
  for (const group of groups) {
    map.set(group, []);
  }
  for (const cmd of COMMAND_REGISTRY) {
    const list = map.get(cmd.group);
    if (list) list.push(cmd);
  }
  return map;
}

/** Print a group of commands with a header. */
function printGroup(label: string, commands: CommandEntry[]): void {
  if (commands.length === 0) return;
  console.log(`${label}:`);
  for (const { usage, description } of commands) {
    const prefix = `  ${usage}`;
    if (prefix.length >= HELP_PAD) {
      console.log(prefix);
      console.log(`${" ".repeat(HELP_PAD)}${description}`);
    } else {
      console.log(`${prefix.padEnd(HELP_PAD)}${description}`);
    }
  }
}

/** Print grouped usage help (Workflow + Diagnostics only). */
export function printHelp(): void {
  console.log("Usage: nw [options]             Run orchestration (waits for queued work items if none exist)");
  console.log("       nw <ID> [ID2...]          Launch work items by ID");
  console.log("       nw <command> [options]    Run a specific command");
  console.log();

  const groups = commandsByGroup(["workflow", "diagnostic"]);
  for (const group of ["workflow", "diagnostic"] as CommandGroup[]) {
    printGroup(GROUP_LABELS[group], groups.get(group) ?? []);
    console.log();
  }

  console.log("Run nw --help-all for all commands, or nw <command> --help for details.");
}

/** Print full usage help with all groups including Advanced. */
export function printHelpAll(): void {
  console.log("Usage: nw [options]             Run orchestration (waits for queued work items if none exist)");
  console.log("       nw <ID> [ID2...]          Launch work items by ID");
  console.log("       nw <command> [options]    Run a specific command");
  console.log();

  const groups = commandsByGroup(GROUP_ORDER);
  for (const group of GROUP_ORDER) {
    printGroup(GROUP_LABELS[group], groups.get(group) ?? []);
    console.log();
  }

  console.log("Run nw <command> --help for detailed help on any command.");
}

/** Print rich help for a single command. */
export function printCommandHelp(cmd: string): void {
  const entry = COMMAND_REGISTRY.find((c) => c.name === cmd);
  if (!entry) {
    die(`Unknown command: ${cmd}`);
    return; // unreachable but helps TS
  }

  // Header
  console.log(`nw ${entry.name} -- ${entry.description}`);
  console.log();

  // Usage
  console.log("Usage:");
  console.log(`  nw ${entry.usage}`);

  // Flags
  const flagEntries = Object.entries(entry.flags);
  if (flagEntries.length > 0) {
    console.log();
    console.log("Flags:");
    // Find the longest flag name for alignment
    const maxLen = Math.max(...flagEntries.map(([name]) => name.length));
    const pad = Math.max(maxLen + 4, 16); // at least 16 chars
    for (const [name, desc] of flagEntries) {
      console.log(`  ${name.padEnd(pad)}${desc}`);
    }
  }

  // Examples
  if (entry.examples.length > 0) {
    console.log();
    console.log("Examples:");
    for (const example of entry.examples) {
      console.log(`  ${example}`);
    }
  }
}
