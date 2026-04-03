#!/usr/bin/env bun
// CLI entry point for the ninthwave tool.

import { existsSync } from "fs";
import { join } from "path";
import { die } from "./output.ts";
import { run } from "./shell.ts";
import { lookupCommand, printHelp, printHelpAll, printCommandHelp } from "./help.ts";
import { cmdNoArgs } from "./commands/onboard.ts";
import { WORK_ITEM_ID_CLI_PATTERN, cmdRunItems } from "./commands/run-items.ts";
import { ensureMuxInteractiveOrDie } from "./mux.ts";

/** Commands that use the interactive startup flow when available. */
const COMMANDS_USING_INTERACTIVE_STARTUP = new Set(["start"]);

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

// ── Handle --help / -h / no args (before project root -- works outside git repos)

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

// ── Flag-style invocations → cmdOrchestrate ──────────────────────────
// `nw --daemon`, `nw --items H-1`, `nw --dangerously-bypass`, etc.
// Route the full arg list directly to the orchestrator.

if (command.startsWith("-")) {
  const gitResult = run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (gitResult.exitCode !== 0) {
    die("Not inside a git repository");
  }
  const projectRoot = gitResult.stdout.replace(/\/.git$/, "");
  const isInitialized = existsSync(join(projectRoot, ".ninthwave"));
  if (process.stdin.isTTY && isInitialized) {
    await ensureMuxInteractiveOrDie(process.argv.slice(2));
  }
  const workDir = join(projectRoot, ".ninthwave", "work");
  const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");
  const { cmdOrchestrate } = await import("./commands/orchestrate.ts");
  await cmdOrchestrate(process.argv.slice(2), workDir, worktreeDir, projectRoot);
  process.exit(0);
}

// ── Work item ID detection ──────────────────────────────────────────
// If all positional args match the work item ID pattern, route to cmdRunItems.

const allPositional = [command, ...args].filter(
  (a) => !a.startsWith("-"),
);
const allAreIds = allPositional.length > 0 && allPositional.every(
  (a) => WORK_ITEM_ID_CLI_PATTERN.test(a),
);

if (allAreIds) {
  await ensureMuxInteractiveOrDie(process.argv.slice(2));

  const projectRoot = getProjectRoot();
  const workDir = join(projectRoot, ".ninthwave", "work");
  const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");

  if (!existsSync(workDir)) {
    die(`Work item queue not found at ${workDir}`);
  }

  // Parse --session-limit flag from args
  let sessionLimit: number | undefined;
  const sessionIdx = args.indexOf("--session-limit");
  const sessionArg = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;
  if (sessionArg) {
    sessionLimit = parseInt(sessionArg, 10);
    if (isNaN(sessionLimit) || sessionLimit < 1) sessionLimit = undefined;
  }

  // Parse --tool flag from args
  let toolOverride: string | undefined;
  const toolIdx = args.indexOf("--tool");
  if (toolIdx !== -1 && args[toolIdx + 1]) {
    toolOverride = args[toolIdx + 1];
  }

  await cmdRunItems(allPositional, workDir, worktreeDir, projectRoot, undefined, sessionLimit, toolOverride);
  process.exit(0);
}

// ── Registry lookup ──────────────────────────────────────────────────

const entry = lookupCommand(command);
if (!entry) {
  // Check if the command looks like a lowercase work item ID -- offer a hint
  const lowercaseIdPattern = /^[a-z]+-[a-z0-9]+-\d+[a-z]*$/;
  if (lowercaseIdPattern.test(command)) {
    const suggestion = command.toUpperCase();
    die(`Unknown command: ${command}. Did you mean ${suggestion}? Work item IDs are uppercase.`);
  }
  die(`Unknown command: ${command}`);
}

// Handle <command> --help / -h
if (args.includes("--help") || args.includes("-h")) {
  printCommandHelp(command);
  process.exit(0);
}

// ── Dispatch ─────────────────────────────────────────────────────────

// Set up the interactive startup path when available; headless still works.
if (COMMANDS_USING_INTERACTIVE_STARTUP.has(command)) {
  await ensureMuxInteractiveOrDie(process.argv.slice(2));
}

if (!entry.needsRoot) {
  // Commands that don't need a project root (init, setup, version)
  await entry.handler({ args, projectRoot: "", workDir: "", worktreeDir: "", partitionDir: "" });
  process.exit(0);
}

// Commands that need a project root
const projectRoot = getProjectRoot();
const workDir = join(projectRoot, ".ninthwave", "work");
const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");
const partitionDir = join(worktreeDir, ".partitions");

if (entry.needsWork && !existsSync(workDir)) {
  die(`Work item queue not found at ${workDir}`);
}

await entry.handler({ args, projectRoot, workDir, worktreeDir, partitionDir });
