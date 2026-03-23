#!/usr/bin/env bun
// CLI entry point for the ninthwave tool.

import { existsSync } from "fs";
import { join } from "path";
import { die } from "./output.ts";
import { run } from "./shell.ts";
import { cmdList } from "./commands/list.ts";
import { cmdDeps } from "./commands/deps.ts";
import { cmdConflicts } from "./commands/conflicts.ts";
import { cmdBatchOrder } from "./commands/batch-order.ts";
import { cmdRepos } from "./commands/repos.ts";
import { cmdStatus, cmdPartitions } from "./commands/status.ts";

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

const projectRoot = getProjectRoot();
const todosFile = join(projectRoot, "TODOS.md");
const worktreeDir = join(projectRoot, ".worktrees");
const partitionDir = join(worktreeDir, ".partitions");

const command = process.argv[2] ?? "";
const args = process.argv.slice(3);

if (!command) {
  console.log("Usage: ninthwave <command> [options]");
  console.log();
  console.log("Commands:");
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
    "  repos                                         List discovered repos",
  );
  process.exit(0);
}

// Most commands require TODOS.md — check before dispatching
const needsTodos = ![
  "repos",
  "partitions",
  "close-workspaces",
  "close-workspace",
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
  // Write commands handled by other agents — placeholder imports
  case "start":
  case "close-workspaces":
  case "close-workspace":
  case "clean":
  case "clean-single":
  case "mark-done":
  case "merged-ids":
  case "watch-ready":
  case "autopilot-watch":
  case "pr-watch":
  case "ci-failures":
  case "pr-activity":
  case "version-bump":
    die(`Command '${command}' is not yet implemented`);
    break;
  default:
    die(`Unknown command: ${command}`);
}
