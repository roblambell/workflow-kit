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
import { cmdStatus, cmdPartitions } from "./commands/status.ts";
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
import { cmdOrchestrate } from "./commands/orchestrate.ts";
import { cmdReconcile } from "./commands/reconcile.ts";

// Resolve project root via git
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

// Commands that don't need a project root
const NO_PROJECT_COMMANDS = ["setup", "version"];

const command = process.argv[2] ?? "";
const args = process.argv.slice(3);

// Handle commands that don't need a project root
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

// All other commands need a project root
const projectRoot = getProjectRoot();
const todosFile = join(projectRoot, "TODOS.md");
const worktreeDir = join(projectRoot, ".worktrees");
const partitionDir = join(worktreeDir, ".partitions");

if (!command) {
  console.log("Usage: ninthwave <command> [options]");
  console.log();
  console.log("Commands:");
  console.log(
    "  setup [--global]                              Set up ninthwave in a project or globally",
  );
  console.log(
    "  version                                       Print ninthwave version",
  );
  console.log(
    '  list [--priority P] [--domain D] [--feature F] [--ready]',
  );
  console.log(
    "                                                List TODO items",
  );
  console.log(
    "  deps <ID>                                     Show dependency chain",
  );
  console.log(
    "  conflicts <ID1> <ID2>...                      Check file conflicts",
  );
  console.log(
    "  batch-order <ID1> [ID2]...                    Group items into dependency batches",
  );
  console.log(
    "  start <ID1> [ID2]...                          Launch parallel sessions",
  );
  console.log(
    "  status                                        Show active worktrees",
  );
  console.log(
    "  close-workspaces                              Close all cmux todo workspaces",
  );
  console.log(
    "  close-workspace <ID>                          Close cmux workspace for a single item",
  );
  console.log(
    "  clean [ID]                                    Clean up worktrees + close all workspaces",
  );
  console.log(
    "  clean-single <ID>                             Clean single worktree (no side effects)",
  );
  console.log(
    "  mark-done <ID1> [ID2]...                      Remove completed items from TODOS.md",
  );
  console.log(
    "  merged-ids                                    List IDs of already-merged worktree items",
  );
  console.log(
    "  partitions                                    Show partition allocation",
  );
  console.log(
    "  watch-ready                                   Check which PRs are merge-ready",
  );
  console.log(
    "  autopilot-watch [--interval N] [--state-file F]  Block until item status changes",
  );
  console.log(
    "  pr-watch --pr N [--interval N] [--since T]    Block until PR has new activity",
  );
  console.log(
    "  ci-failures <PR>                              Show failing CI check details",
  );
  console.log(
    "  pr-activity <PR1> [PR2]... [--since T]        Check for new comments/reviews",
  );
  console.log(
    "  version-bump                                  Bump version + changelog",
  );
  console.log(
    "  orchestrate --items ID1,ID2 [options]         Orchestrate parallel processing",
  );
  console.log(
    "  repos                                         List discovered repos",
  );
  console.log(
    "  reconcile                                     Sync TODOS.md with merged PRs",
  );
  process.exit(0);
}

// Most commands require TODOS.md — check before dispatching
// (setup and version are handled above before project root resolution)
const needsTodos = ![
  "repos",
  "partitions",
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
].includes(command);

if (needsTodos && !existsSync(todosFile)) {
  die(`TODOS.md not found at ${todosFile}`);
}

switch (command) {
  case "list":
    cmdList(args, todosFile, worktreeDir);
    break;
  case "deps":
    cmdDeps(args, todosFile, worktreeDir);
    break;
  case "conflicts":
    cmdConflicts(args, todosFile, worktreeDir);
    break;
  case "batch-order":
    cmdBatchOrder(args, todosFile, worktreeDir);
    break;
  case "repos":
    cmdRepos(projectRoot);
    break;
  case "status":
    cmdStatus(worktreeDir, projectRoot);
    break;
  case "partitions":
    cmdPartitions(partitionDir);
    break;
  case "start":
    cmdStart(args, todosFile, worktreeDir, projectRoot);
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
    cmdMarkDone(args, todosFile);
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
    await cmdOrchestrate(args, todosFile, worktreeDir, projectRoot);
    break;
  case "reconcile":
    cmdReconcile(todosFile, worktreeDir, projectRoot);
    break;
  default:
    die(`Unknown command: ${command}`);
}
