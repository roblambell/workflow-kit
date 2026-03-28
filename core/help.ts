// Command registry — single source of truth for all CLI commands.

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
import { cmdSetup } from "./commands/setup.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdOrchestrate } from "./commands/orchestrate.ts";
import { cmdReconcile } from "./commands/reconcile.ts";
import { cmdAnalytics } from "./commands/analytics.ts";
import { cmdStop } from "./commands/stop.ts";
import { cmdRetry } from "./commands/retry.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdHeartbeat } from "./commands/heartbeat.ts";

// ── Types ───────────────────────────────────────────────────────────

export type CommandGroup = "workflow" | "diagnostic" | "advanced";

export interface CommandContext {
  args: string[];
  projectRoot: string;
  todosDir: string;
  worktreeDir: string;
  partitionDir: string;
}

export interface CommandEntry {
  name: string;
  usage: string;
  description: string;
  group: CommandGroup;
  needsRoot: boolean;
  needsTodos: boolean;
  handler: (ctx: CommandContext) => void | Promise<void>;
  flags: string[];
  examples: string[];
}

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
 * Order determines help output order.
 */
export const COMMAND_REGISTRY: ReadonlyArray<CommandEntry> = [
  {
    name: "doctor",
    usage: "doctor",
    description: "Check prerequisites and configuration health",
    group: "workflow",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdDoctor(ctx.projectRoot),
    flags: [],
    examples: ["nw doctor"],
  },
  {
    name: "init",
    usage: "init",
    description: "Auto-detect and initialize ninthwave (zero input)",
    group: "workflow",
    needsRoot: false,
    needsTodos: false,
    handler: () => cmdInit(),
    flags: [],
    examples: ["nw init"],
  },
  {
    name: "setup",
    usage: "setup [--global]",
    description: "Set up ninthwave in a project or globally",
    group: "workflow",
    needsRoot: false,
    needsTodos: false,
    handler: async (ctx) => { await cmdSetup(ctx.args); },
    flags: ["--global"],
    examples: ["nw setup", "nw setup --global"],
  },
  {
    name: "version",
    usage: "version",
    description: "Print ninthwave version",
    group: "workflow",
    needsRoot: false,
    needsTodos: false,
    handler: () => cmdVersion(),
    flags: [],
    examples: ["nw version", "nw --version", "nw -v"],
  },
  {
    name: "list",
    usage: "list [--priority P] [--domain D] [--feature F] [--ready]",
    description: "List TODO items",
    group: "workflow",
    needsRoot: true,
    needsTodos: true,
    handler: (ctx) => cmdList(ctx.args, ctx.todosDir, ctx.worktreeDir),
    flags: ["--priority", "--domain", "--feature", "--ready"],
    examples: ["nw list", "nw list --ready", "nw list --domain core"],
  },
  {
    name: "deps",
    usage: "deps <ID>",
    description: "Show dependency chain",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: true,
    handler: (ctx) => cmdDeps(ctx.args, ctx.todosDir, ctx.worktreeDir),
    flags: [],
    examples: ["nw deps H-FOO-1"],
  },
  {
    name: "conflicts",
    usage: "conflicts <ID1> <ID2>...",
    description: "Check file conflicts",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: true,
    handler: (ctx) => cmdConflicts(ctx.args, ctx.todosDir, ctx.worktreeDir),
    flags: [],
    examples: ["nw conflicts H-FOO-1 H-FOO-2"],
  },
  {
    name: "batch-order",
    usage: "batch-order <ID1> [ID2]...",
    description: "Group items into dependency batches",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: true,
    handler: (ctx) => cmdBatchOrder(ctx.args, ctx.todosDir, ctx.worktreeDir),
    flags: [],
    examples: ["nw batch-order H-FOO-1 H-FOO-2 H-FOO-3"],
  },
  {
    name: "start",
    usage: "start <ID1> [ID2]...",
    description: "Launch parallel sessions",
    group: "workflow",
    needsRoot: true,
    needsTodos: true,
    handler: async (ctx) => { await cmdStart(ctx.args, ctx.todosDir, ctx.worktreeDir, ctx.projectRoot); },
    flags: [],
    examples: ["nw start H-FOO-1 H-FOO-2"],
  },
  {
    name: "status",
    usage: "status [--watch] [--flat]",
    description: "Show active worktrees (--watch: refresh, --flat: no tree)",
    group: "workflow",
    needsRoot: true,
    needsTodos: false,
    handler: async (ctx) => {
      const flatFlag = ctx.args.includes("--flat");
      if (ctx.args.includes("--watch")) {
        await cmdStatusWatch(ctx.worktreeDir, ctx.projectRoot, 5_000, undefined, flatFlag);
      } else {
        cmdStatus(ctx.worktreeDir, ctx.projectRoot, flatFlag);
      }
    },
    flags: ["--watch", "--flat"],
    examples: ["nw status", "nw status --watch", "nw status --flat"],
  },
  {
    name: "close-workspaces",
    usage: "close-workspaces",
    description: "Close all cmux todo workspaces",
    group: "advanced",
    needsRoot: true,
    needsTodos: false,
    handler: () => cmdCloseWorkspaces(),
    flags: [],
    examples: ["nw close-workspaces"],
  },
  {
    name: "close-workspace",
    usage: "close-workspace <ID>",
    description: "Close cmux workspace for a single item",
    group: "advanced",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdCloseWorkspace(ctx.args[0] ?? ""),
    flags: [],
    examples: ["nw close-workspace H-FOO-1"],
  },
  {
    name: "clean",
    usage: "clean [ID]",
    description: "Clean up worktrees + close all workspaces",
    group: "workflow",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdClean(ctx.args, ctx.worktreeDir, ctx.projectRoot),
    flags: [],
    examples: ["nw clean", "nw clean H-FOO-1"],
  },
  {
    name: "clean-single",
    usage: "clean-single <ID>",
    description: "Clean single worktree (no side effects)",
    group: "advanced",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdCleanSingle(ctx.args, ctx.worktreeDir, ctx.projectRoot),
    flags: [],
    examples: ["nw clean-single H-FOO-1"],
  },
  {
    name: "mark-done",
    usage: "mark-done <ID1> [ID2]...",
    description: "Remove completed todo files",
    group: "advanced",
    needsRoot: true,
    needsTodos: true,
    handler: (ctx) => cmdMarkDone(ctx.args, ctx.todosDir),
    flags: [],
    examples: ["nw mark-done H-FOO-1 H-FOO-2"],
  },
  {
    name: "merged-ids",
    usage: "merged-ids",
    description: "List IDs of already-merged worktree items",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdMergedIds(ctx.worktreeDir, ctx.projectRoot),
    flags: [],
    examples: ["nw merged-ids"],
  },
  {
    name: "partitions",
    usage: "partitions",
    description: "Show partition allocation",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdPartitions(ctx.partitionDir),
    flags: [],
    examples: ["nw partitions"],
  },
  {
    name: "watch-ready",
    usage: "watch-ready",
    description: "Check which PRs are merge-ready",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdWatchReady(ctx.worktreeDir, ctx.projectRoot),
    flags: [],
    examples: ["nw watch-ready"],
  },
  {
    name: "autopilot-watch",
    usage: "autopilot-watch [--interval N] [--state-file F]",
    description: "Block until item status changes",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: async (ctx) => { await cmdAutopilotWatch(ctx.args, ctx.worktreeDir, ctx.projectRoot); },
    flags: ["--interval", "--state-file"],
    examples: ["nw autopilot-watch", "nw autopilot-watch --interval 30"],
  },
  {
    name: "pr-watch",
    usage: "pr-watch --pr N [--interval N] [--since T]",
    description: "Block until PR has new activity",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: async (ctx) => { await cmdPrWatch(ctx.args, ctx.projectRoot); },
    flags: ["--pr", "--interval", "--since"],
    examples: ["nw pr-watch --pr 42"],
  },
  {
    name: "ci-failures",
    usage: "ci-failures <PR>",
    description: "Show failing CI check details",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdCiFailures(ctx.args, ctx.projectRoot),
    flags: [],
    examples: ["nw ci-failures 42"],
  },
  {
    name: "pr-activity",
    usage: "pr-activity <PR1> [PR2]... [--since T]",
    description: "Check for new comments/reviews",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdPrActivity(ctx.args, ctx.projectRoot),
    flags: ["--since"],
    examples: ["nw pr-activity 42", "nw pr-activity 42 43 --since 2024-01-01"],
  },
  {
    name: "version-bump",
    usage: "version-bump",
    description: "Bump version + changelog",
    group: "advanced",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdVersionBump(ctx.projectRoot),
    flags: [],
    examples: ["nw version-bump"],
  },
  {
    name: "orchestrate",
    usage: "orchestrate [--items ID1 ID2 ...] [--daemon] [--watch]",
    description: "Orchestrate parallel processing (interactive if no --items)",
    group: "workflow",
    needsRoot: true,
    needsTodos: true,
    handler: async (ctx) => { await cmdOrchestrate(ctx.args, ctx.todosDir, ctx.worktreeDir, ctx.projectRoot); },
    flags: ["--items", "--daemon", "--watch"],
    examples: ["nw orchestrate", "nw orchestrate --items H-FOO-1 H-FOO-2"],
  },
  {
    name: "stop",
    usage: "stop",
    description: "Stop the orchestrator daemon",
    group: "workflow",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdStop(ctx.projectRoot),
    flags: [],
    examples: ["nw stop"],
  },
  {
    name: "retry",
    usage: "retry <ID> [ID2...]",
    description: "Retry stuck/done items (reset to queued)",
    group: "workflow",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdRetry(ctx.args, ctx.worktreeDir, ctx.projectRoot),
    flags: [],
    examples: ["nw retry H-FOO-1"],
  },
  {
    name: "repos",
    usage: "repos",
    description: "List discovered repos",
    group: "diagnostic",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdRepos(ctx.projectRoot),
    flags: [],
    examples: ["nw repos"],
  },
  {
    name: "reconcile",
    usage: "reconcile",
    description: "Sync todo files with merged PRs",
    group: "workflow",
    needsRoot: true,
    needsTodos: true,
    handler: (ctx) => cmdReconcile(ctx.todosDir, ctx.worktreeDir, ctx.projectRoot),
    flags: [],
    examples: ["nw reconcile"],
  },
  {
    name: "analytics",
    usage: "analytics [--all]",
    description: "Show orchestration performance trends",
    group: "workflow",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdAnalytics(ctx.args, ctx.projectRoot),
    flags: ["--all"],
    examples: ["nw analytics", "nw analytics --all"],
  },
  {
    name: "heartbeat",
    usage: "heartbeat --progress <0-1> --label <text>",
    description: "Report worker progress (auto-detects TODO ID from branch)",
    group: "advanced",
    needsRoot: true,
    needsTodos: false,
    handler: (ctx) => cmdHeartbeat(ctx.args, ctx.projectRoot),
    flags: ["--progress", "--label", "--tokens-in", "--tokens-out", "--model"],
    examples: ['nw heartbeat --progress 0.5 --label "Writing tests"'],
  },
];

// ── Registry lookup ─────────────────────────────────────────────────

/** Look up a command by name. Returns undefined if not found. */
export function lookupCommand(name: string): CommandEntry | undefined {
  return COMMAND_REGISTRY.find((c) => c.name === name);
}

// ── Help output ─────────────────────────────────────────────────────

const HELP_PAD = 48;

/** Print full usage help. */
export function printHelp(): void {
  console.log("Usage: nw <command> [options]");
  console.log("       ninthwave <command> [options]");
  console.log();
  console.log("Commands:");
  for (const { usage, description } of COMMAND_REGISTRY) {
    const prefix = `  ${usage}`;
    if (prefix.length >= HELP_PAD) {
      console.log(prefix);
      console.log(`${" ".repeat(HELP_PAD)}${description}`);
    } else {
      console.log(`${prefix.padEnd(HELP_PAD)}${description}`);
    }
  }
}

/** Print help for a single command. */
export function printCommandHelp(cmd: string): void {
  const entry = COMMAND_REGISTRY.find((c) => c.name === cmd);
  if (entry) {
    console.log(`Usage: ninthwave ${entry.usage}`);
    console.log();
    console.log(entry.description);
  } else {
    die(`Unknown command: ${cmd}`);
  }
}
