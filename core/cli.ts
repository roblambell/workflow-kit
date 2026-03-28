#!/usr/bin/env bun
// CLI entry point for the ninthwave tool.

import { existsSync } from "fs";
import { join } from "path";
import { die } from "./output.ts";
import { run } from "./shell.ts";
import { lookupCommand, printHelp, printHelpAll, printCommandHelp } from "./help.ts";
import { cmdNoArgs } from "./commands/onboard.ts";
import { TODO_ID_CLI_PATTERN, cmdRunItems } from "./commands/launch.ts";

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

// ── Handle --help / -h / no args (before project root — works outside git repos)

if (command === "--help-all") {
  printHelpAll();
  process.exit(0);
}

if (command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

// No args: detect project state and route to the appropriate flow
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

  await cmdNoArgs(projectRoot);
  process.exit(0);
}

// ── TODO ID detection ────────────────────────────────────────────────
// If all positional args match the TODO ID pattern, route to cmdRunItems.

const allPositional = [command, ...args].filter(
  (a) => !a.startsWith("-"),
);
const allAreIds = allPositional.length > 0 && allPositional.every(
  (a) => TODO_ID_CLI_PATTERN.test(a),
);

if (allAreIds) {
  const projectRoot = getProjectRoot();
  const workDir = join(projectRoot, ".ninthwave", "work");
  const worktreeDir = join(projectRoot, ".worktrees");

  if (!existsSync(workDir)) {
    die(`Todos directory not found at ${workDir}`);
  }

  await cmdRunItems(allPositional, workDir, worktreeDir, projectRoot);
  process.exit(0);
}

// ── Registry lookup ──────────────────────────────────────────────────

const entry = lookupCommand(command);
if (!entry) {
  // Check if the command looks like a lowercase TODO ID — offer a hint
  const lowercaseIdPattern = /^[a-z]+-[a-z0-9]+-\d+[a-z]*$/;
  if (lowercaseIdPattern.test(command)) {
    const suggestion = command.toUpperCase();
    die(`Unknown command: ${command}. Did you mean ${suggestion}? TODO IDs are uppercase.`);
  }
  die(`Unknown command: ${command}`);
}

// Handle <command> --help / -h
if (args.includes("--help") || args.includes("-h")) {
  printCommandHelp(command);
  process.exit(0);
}

// ── Dispatch ─────────────────────────────────────────────────────────

if (!entry.needsRoot) {
  // Commands that don't need a project root (init, setup, version)
  await entry.handler({ args, projectRoot: "", workDir: "", worktreeDir: "", partitionDir: "" });
  process.exit(0);
}

// Commands that need a project root
const projectRoot = getProjectRoot();
const workDir = join(projectRoot, ".ninthwave", "work");
const worktreeDir = join(projectRoot, ".worktrees");
const partitionDir = join(worktreeDir, ".partitions");

if (entry.needsWork && !existsSync(workDir)) {
  die(`Todos directory not found at ${workDir}`);
}

await entry.handler({ args, projectRoot, workDir, worktreeDir, partitionDir });
