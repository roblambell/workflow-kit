#!/usr/bin/env bun
// CLI entry point for the ninthwave tool.

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
import { cmdStart } from "./commands/start.ts";
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
} from "./commands/watch.ts";
import { cmdCiFailures } from "./commands/ci.ts";
import { cmdVersionBump } from "./commands/version-bump.ts";
import { cmdSetup } from "./commands/setup.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdOrchestrate } from "./commands/orchestrate.ts";
import { cmdReconcile } from "./commands/reconcile.ts";
import { cmdAnalytics } from "./commands/analytics.ts";
import { cmdStop } from "./commands/stop.ts";
import { cmdRetry } from "./commands/retry.ts";
import { cmdMigrateTodos, cmdGenerateTodos } from "./commands/migrate-todos.ts";
import { shouldOnboard, cmdOnboard } from "./commands/onboard.ts";
import { cmdDoctor } from "./commands/doctor.ts";

// ── Help definitions ─────────────────────────────────────────────────

/** [usage, description] pairs for all commands. */
export const COMMANDS: ReadonlyArray<[string, string]> = [
  ["doctor", "Check prerequisites and configuration health"],
  ["init", "Auto-detect and initialize ninthwave (zero input)"],
  ["setup [--global]", "Set up ninthwave in a project or globally"],
  ["version", "Print ninthwave version"],
  [
    "list [--priority P] [--domain D] [--feature F] [--ready] [--backend B]",
    "List TODO items",
  ],
  ["deps <ID>", "Show dependency chain"],
  ["conflicts <ID1> <ID2>...", "Check file conflicts"],
  ["batch-order <ID1> [ID2]...", "Group items into dependency batches"],
  ["start <ID1> [ID2]... [--mux cmux|tmux]", "Launch parallel sessions"],
  [
    "status [--watch] [--flat]",
    "Show active worktrees (--watch: refresh, --flat: no tree)",
  ],
  ["close-workspaces", "Close all cmux todo workspaces"],
  ["close-workspace <ID>", "Close cmux workspace for a single item"],
  ["clean [ID]", "Clean up worktrees + close all workspaces"],
  ["clean-single <ID>", "Clean single worktree (no side effects)"],
  ["mark-done <ID1> [ID2]...", "Remove completed todo files"],
  ["merged-ids", "List IDs of already-merged worktree items"],
  ["partitions", "Show partition allocation"],
  ["watch-ready", "Check which PRs are merge-ready"],
  [
    "autopilot-watch [--interval N] [--state-file F]",
    "Block until item status changes",
  ],
  [
    "pr-watch --pr N [--interval N] [--since T]",
    "Block until PR has new activity",
  ],
  ["ci-failures <PR>", "Show failing CI check details"],
  [
    "pr-activity <PR1> [PR2]... [--since T]",
    "Check for new comments/reviews",
  ],
  ["version-bump", "Bump version + changelog"],
  [
    "orchestrate --items ID1 ID2 ... [--daemon] [--watch]",
    "Orchestrate parallel processing",
  ],
  ["stop", "Stop the orchestrator daemon"],
  ["retry <ID> [ID2...]", "Retry stuck/done items (reset to queued)"],
  ["repos", "List discovered repos"],
  ["reconcile", "Sync todo files with merged PRs"],
  ["analytics [--all]", "Show orchestration performance trends"],
  ["migrate-todos", "Migrate TODOS.md to file-per-todo format"],
  ["generate-todos", "Generate TODOS.md from individual todo files"],
];

const HELP_PAD = 48;

/** Print full usage help. */
export function printHelp(): void {
  console.log("Usage: nw <command> [options]");
  console.log("       ninthwave <command> [options]");
  console.log();
  console.log("Commands:");
  for (const [usage, desc] of COMMANDS) {
    const prefix = `  ${usage}`;
    if (prefix.length >= HELP_PAD) {
      console.log(prefix);
      console.log(`${" ".repeat(HELP_PAD)}${desc}`);
    } else {
      console.log(`${prefix.padEnd(HELP_PAD)}${desc}`);
    }
  }
}

/** Print help for a single command. */
export function printCommandHelp(cmd: string): void {
  const entry = COMMANDS.find(([usage]) => usage.split(" ")[0] === cmd);
  if (entry) {
    const [usage, desc] = entry;
    console.log(`Usage: ninthwave ${usage}`);
    console.log();
    console.log(desc);
  } else {
    die(`Unknown command: ${cmd}`);
  }
}

// ── Project root resolution ──────────────────────────────────────────

function getProjectRoot(): string {
  const result = run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) {
    die("Not inside a git repository");
  }
  // Strip trailing /.git
  return result.stdout.replace(/\/.git$/, "");
}

// ── Argument parsing ─────────────────────────────────────────────────

const rawCommand = process.argv[2] ?? "";
const args = process.argv.slice(3);

// Normalize flag-style invocations to subcommands
const command =
  rawCommand === "--version" || rawCommand === "-v" ? "version" : rawCommand;

// ── Commands that don't need a project root ──────────────────────────

if (command === "init") {
  cmdInit();
  process.exit(0);
}

if (command === "setup") {
  cmdSetup(args);
  process.exit(0);
}

if (command === "version") {
  try {
    const bundleDir = getBundleDir();
    const versionFile = join(bundleDir, "VERSION");
    if (existsSync(versionFile)) {
      console.log(readFileSync(versionFile, "utf-8").trim());
    } else {
      // Fall back to git describe
      const result = run("git", ["-C", bundleDir, "describe", "--tags", "--always"]);
      console.log(result.exitCode === 0 ? result.stdout : "unknown");
    }
  } catch {
    console.log("unknown");
  }
  process.exit(0);
}

// Handle --help / -h / no args (before project root — works outside git repos)
if (command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

// No args: check if this is an uninitialized project → launch onboarding
if (!command) {
  // Try to detect project root without dying on failure
  const gitResult = run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const projectRoot =
    gitResult.exitCode === 0
      ? gitResult.stdout.replace(/\/.git$/, "")
      : null;

  if (shouldOnboard(projectRoot)) {
    await cmdOnboard(projectRoot!);
    process.exit(0);
  }

  // Already set up or not in a git repo — show help
  printHelp();
  process.exit(0);
}

// Handle <command> --help / -h
if (args.includes("--help") || args.includes("-h")) {
  printCommandHelp(command);
  process.exit(0);
}

// ── Commands that need a project root ────────────────────────────────

const projectRoot = getProjectRoot();
const todosDir = join(projectRoot, ".ninthwave", "todos");
const worktreeDir = join(projectRoot, ".worktrees");
const partitionDir = join(worktreeDir, ".partitions");

// Most commands require the todos directory — check before dispatching
// (setup, version, init, and help are handled above before project root resolution)
const needsTodos = ![
  "doctor",
  "repos",
  "partitions",
  "status",
  "stop",
  "retry",
  "close-workspaces",
  "close-workspace",
  "clean",
  "clean-single",
  "merged-ids",
  "watch-ready",
  "autopilot-watch",
  "pr-watch",
  "ci-failures",
  "pr-activity",
  "version-bump",
  "analytics",
  "migrate-todos",
  "generate-todos",
].includes(command);

// list --backend <name> sources from an external backend, not the todos directory
const usesExternalBackend =
  command === "list" && args.includes("--backend");

if (needsTodos && !usesExternalBackend && !existsSync(todosDir)) {
  die(`Todos directory not found at ${todosDir}`);
}

switch (command) {
  case "doctor":
    cmdDoctor(projectRoot);
    break;
  case "list":
    cmdList(args, todosDir, worktreeDir, projectRoot);
    break;
  case "deps":
    cmdDeps(args, todosDir, worktreeDir);
    break;
  case "conflicts":
    cmdConflicts(args, todosDir, worktreeDir);
    break;
  case "batch-order":
    cmdBatchOrder(args, todosDir, worktreeDir);
    break;
  case "repos":
    cmdRepos(projectRoot);
    break;
  case "status": {
    const flatFlag = args.includes("--flat");
    if (args.includes("--watch")) {
      await cmdStatusWatch(worktreeDir, projectRoot, 5_000, undefined, flatFlag);
    } else {
      cmdStatus(worktreeDir, projectRoot, flatFlag);
    }
    break;
  }
  case "partitions":
    cmdPartitions(partitionDir);
    break;
  case "start":
    cmdStart(args, todosDir, worktreeDir, projectRoot);
    break;
  case "close-workspaces":
    cmdCloseWorkspaces();
    break;
  case "close-workspace":
    cmdCloseWorkspace(args[0] ?? "");
    break;
  case "clean":
    cmdClean(args, worktreeDir, projectRoot);
    break;
  case "clean-single":
    cmdCleanSingle(args, worktreeDir, projectRoot);
    break;
  case "mark-done":
    cmdMarkDone(args, todosDir);
    break;
  case "merged-ids":
    cmdMergedIds(worktreeDir, projectRoot);
    break;
  case "watch-ready":
    cmdWatchReady(worktreeDir, projectRoot);
    break;
  case "autopilot-watch":
    await cmdAutopilotWatch(args, worktreeDir, projectRoot);
    break;
  case "pr-watch":
    await cmdPrWatch(args, projectRoot);
    break;
  case "ci-failures":
    cmdCiFailures(args, projectRoot);
    break;
  case "pr-activity":
    cmdPrActivity(args, projectRoot);
    break;
  case "version-bump":
    cmdVersionBump(projectRoot);
    break;
  case "orchestrate":
    await cmdOrchestrate(args, todosDir, worktreeDir, projectRoot);
    break;
  case "stop":
    cmdStop(projectRoot);
    break;
  case "retry":
    cmdRetry(args, worktreeDir, projectRoot);
    break;
  case "reconcile":
    cmdReconcile(todosDir, worktreeDir, projectRoot);
    break;
  case "analytics":
    cmdAnalytics(args, projectRoot);
    break;
  case "migrate-todos":
    cmdMigrateTodos(projectRoot);
    break;
  case "generate-todos":
    cmdGenerateTodos(todosDir, join(projectRoot, "TODOS.md"));
    break;
  default:
    die(`Unknown command: ${command}`);
}
