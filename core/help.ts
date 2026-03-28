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
import { cmdRepos } from "./commands/repos.ts";
import { cmdStatus, cmdStatusWatch, cmdPartitions } from "./commands/status.ts";
import { cmdStart } from "./commands/launch.ts";
import {
  cmdCloseWorkspaces,
  cmdCloseWorkspace,
  cmdClean,
  cmdCleanSingle,
} from "./commands/clean.ts";
import { cmdMarkDone, cmdMergedIds } from "./commands/mark-done.ts";
import {
  cmdWatchReady,
  cmdAutopilotWatch,
  cmdPrWatch,
  cmdPrActivity,
} from "./commands/pr-monitor.ts";
import { cmdCiFailures } from "./commands/ci.ts";
import { cmdVersionBump } from "./commands/version-bump.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdWatch } from "./commands/orchestrate.ts";
import { cmdCrew } from "./commands/crew.ts";
import { cmdReconcile } from "./commands/reconcile.ts";
import { cmdAnalytics } from "./commands/analytics.ts";
import { cmdHistory } from "./commands/history.ts";
import { cmdStop } from "./commands/stop.ts";
import { cmdRetry } from "./commands/retry.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdHeartbeat } from "./commands/heartbeat.ts";
import { cmdLogs } from "./commands/logs.ts";
import { cmdSchedule } from "./commands/schedule.ts";

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
    usage: "init [--global] [--yes]",
    description: "Auto-detect and initialize ninthwave",
    group: "workflow",
    needsRoot: false,
    needsWork: false,
    handler: async (ctx) => { await cmdInit(ctx.args); },
    flags: {
      "--global": "Install global shell alias and config",
      "--yes": "Skip confirmation prompts",
      "-y": "Skip confirmation prompts",
    },
    examples: ["nw init", "nw init --global", "nw init --yes"],
  },
  {
    name: "watch",
    usage: "watch [--items ID1 ID2 ...] [--daemon] [--no-watch]",
    description: "Run the full pipeline (TUI, daemon, or JSON modes)",
    group: "workflow",
    needsRoot: true,
    needsWork: true,
    handler: async (ctx) => { await cmdWatch(ctx.args, ctx.workDir, ctx.worktreeDir, ctx.projectRoot); },
    flags: {
      "--items": "Work item IDs to process",
      "--daemon": "Run in daemon mode (background)",
      "--no-watch": "Disable TUI watch mode",
      "--watch": "Enable TUI watch mode",
      "--no-review": "Disable review workers (on by default)",
      "--review": "Enable review workers (default)",
      "--no-verify-main": "Skip post-merge CI verification on main",
      "--verify-main": "Enable post-merge CI verification (default)",
    },
    examples: [
      "nw watch",
      "nw watch --items H-FOO-1 H-FOO-2",
      "nw watch --daemon",
    ],
  },
  {
    name: "crew",
    usage: "crew [<crew-code>|create|join <crew-code>]",
    description: "Join or create a crew for collaborative orchestration",
    group: "workflow",
    needsRoot: true,
    needsWork: true,
    handler: async (ctx) => { await cmdCrew(ctx.args, ctx.workDir, ctx.worktreeDir, ctx.projectRoot); },
    flags: {},
    examples: [
      "nw crew",
      "nw crew abc-xyz",
      "nw crew create",
      "nw crew join abc-xyz",
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
    handler: (ctx) => cmdStop(ctx.projectRoot),
    flags: {},
    examples: ["nw stop"],
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
      "--ready": "Show only items with no unmet dependencies",
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
    description: "Group items into dependency-ordered batches",
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
    description: "Show state transition timeline for an item",
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
      "--item": "Filter entries to those containing the specified item ID",
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

  {
    name: "schedule",
    usage: "schedule [list|show <id>|validate|run <id>]",
    description: "List, inspect, validate, or trigger scheduled tasks",
    group: "diagnostic",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdSchedule(ctx.args, ctx.projectRoot),
    flags: {},
    examples: [
      "nw schedule",
      "nw schedule list",
      "nw schedule show daily-tests",
      "nw schedule validate",
      "nw schedule run daily-tests",
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
    description: "Close cmux workspace for a single item",
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
    description: "Retry stuck or done items (reset to queued)",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdRetry(ctx.args, ctx.worktreeDir, ctx.projectRoot),
    flags: {},
    examples: ["nw retry H-FOO-1"],
  },
  {
    name: "repos",
    usage: "repos",
    description: "List discovered sibling repositories",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdRepos(ctx.projectRoot),
    flags: {},
    examples: ["nw repos"],
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
    name: "version-bump",
    usage: "version-bump",
    description: "Bump version and update changelog",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdVersionBump(ctx.projectRoot),
    flags: {},
    examples: ["nw version-bump"],
  },
  {
    name: "heartbeat",
    usage: "heartbeat --progress <0-1> --label <text>",
    description: "Report worker progress (auto-detects item ID from branch)",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: (ctx) => cmdHeartbeat(ctx.args, ctx.projectRoot),
    flags: {
      "--progress": "Progress value from 0.0 to 1.0",
      "--label": "Status label text",
      "--tokens-in": "Input tokens consumed (for analytics)",
      "--tokens-out": "Output tokens consumed (for analytics)",
      "--model": "Model identifier (for analytics)",
    },
    examples: [
      'nw heartbeat --progress 0.5 --label "Writing tests"',
      'nw heartbeat --progress 1.0 --label "Done" --tokens-in 45000',
    ],
  },
  {
    name: "merged-ids",
    usage: "merged-ids",
    description: "List IDs of already-merged worktree items",
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
    handler: (ctx) => cmdWatchReady(ctx.worktreeDir, ctx.projectRoot),
    flags: {},
    examples: ["nw watch-ready"],
  },
  {
    name: "autopilot-watch",
    usage: "autopilot-watch [--interval N] [--state-file F]",
    description: "Block until item status changes",
    group: "advanced",
    needsRoot: true,
    needsWork: false,
    handler: async (ctx) => { await cmdAutopilotWatch(ctx.args, ctx.worktreeDir, ctx.projectRoot); },
    flags: {
      "--interval": "Polling interval in seconds",
      "--state-file": "Path to state file for persistence",
    },
    examples: ["nw autopilot-watch", "nw autopilot-watch --interval 30"],
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
  console.log("Usage: nw <command> [options]");
  console.log("       nw <ID> [ID2...]          Launch work items by ID");
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
  console.log("Usage: nw <command> [options]");
  console.log("       nw <ID> [ID2...]          Launch work items by ID");
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
