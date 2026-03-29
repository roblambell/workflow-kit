// `ninthwave` no-args handling -- adapts to project state.
//
// When `ninthwave` is run with no arguments, detects the project state and
// routes to the appropriate flow:
// 1. No git repo → help text
// 2. No .ninthwave/ → first-run onboarding (init flow)
// 3. .ninthwave/ exists, no work items → guidance message
// 4. Work items exist, no daemon → mode-first prompt (orchestrate/launch)
// 5. Daemon running → live status view

import { createInterface } from "readline";
import { existsSync } from "fs";
import { join } from "path";
import {
  BOLD,
  DIM,
  GREEN,
  YELLOW,
  RED,
  RESET,
} from "../output.ts";
import { run } from "../shell.ts";
import type { RunResult, WorkItem } from "../types.ts";
import { initProject } from "./init.ts";
import { getBundleDir } from "../paths.ts";
import { isDaemonRunning } from "../daemon.ts";
import { parseWorkItems } from "../parser.ts";
import { promptItems, displayItemsSummary, promptMode, promptMergeStrategy, promptWipLimit, runInteractiveFlow } from "../interactive.ts";
import type { Mode, InteractiveResult } from "../interactive.ts";
import type { MergeStrategy } from "../orchestrator.ts";
import { printHelp } from "../help.ts";
import { AI_TOOL_PROFILES } from "../ai-tools.ts";
import type { AiToolProfile } from "../ai-tools.ts";

// ── Multiplexer descriptors ─────────────────────────────────────────

export interface MuxOption {
  type: "cmux";
  name: string;
  description: string;
  installCmd: string;
}

export const MUX_OPTIONS: MuxOption[] = [
  {
    type: "cmux",
    name: "cmux",
    description: "Visual sidebar (recommended)",
    installCmd: "brew install --cask manaflow-ai/cmux/cmux",
  },
];

// ── Dependency injection ────────────────────────────────────────────

export type CommandChecker = (cmd: string) => boolean;
export type PromptFn = (question: string) => Promise<string>;
export type ShellRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => RunResult;
export type SleepFn = (ms: number) => void;

export interface OnboardDeps {
  commandExists?: CommandChecker;
  prompt?: PromptFn;
  runShell?: ShellRunner;
  sleep?: SleepFn;
  getBundleDir?: () => string;
}

// ── No-args dependency injection ───────────────────────────────────

export interface NoArgsDeps extends OnboardDeps {
  isTTY?: boolean;
  existsSync?: typeof existsSync;
  parseWorkItems?: (workDir: string, worktreeDir: string) => WorkItem[];
  isDaemonRunning?: (projectRoot: string) => number | null;
  displayItemsSummary?: (todos: WorkItem[]) => void;
  promptMode?: (prompt: PromptFn) => Promise<Mode>;
  promptMergeStrategy?: (prompt: PromptFn) => Promise<MergeStrategy>;
  promptWipLimit?: (defaultLimit: number, prompt: PromptFn) => Promise<number>;
  promptItems?: (todos: WorkItem[], prompt: PromptFn) => Promise<string[]>;
  runInteractiveFlow?: (todos: WorkItem[], defaultWipLimit: number) => Promise<InteractiveResult | null>;
  runSelected?: (ids: string[], workDir: string, worktreeDir: string, projectRoot: string) => Promise<void>;
  runWatch?: (args: string[], workDir: string, worktreeDir: string, projectRoot: string) => Promise<void>;
  runStatusWatch?: (worktreeDir: string, projectRoot: string) => Promise<void>;
  printHelp?: () => void;
}

const defaultCommandExists: CommandChecker = (cmd: string): boolean => {
  const result = run("which", [cmd]);
  return result.exitCode === 0;
};

const defaultPrompt: PromptFn = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const defaultSleep: SleepFn = (ms: number): void => {
  Bun.sleepSync(ms);
};

// ── Detection functions ─────────────────────────────────────────────

/**
 * Detect all installed multiplexers.
 * Returns matching MuxOption entries.
 */
export function detectInstalledMuxes(
  commandExists: CommandChecker = defaultCommandExists,
): MuxOption[] {
  return MUX_OPTIONS.filter((m) => commandExists(m.type));
}

/**
 * Detect all installed AI coding tools.
 * Returns matching AiToolProfile entries in preference order (claude > opencode > copilot).
 */
export function detectInstalledAITools(
  commandExists: CommandChecker = defaultCommandExists,
): AiToolProfile[] {
  return AI_TOOL_PROFILES.filter((p) => commandExists(p.command));
}

// ── Interactive choice ──────────────────────────────────────────────

/**
 * Present a numbered list and ask the user to pick one.
 * Returns the 0-based index of the chosen item.
 */
export async function promptChoice<T>(
  items: T[],
  label: (item: T) => string,
  promptFn: PromptFn,
): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${BOLD}${i + 1}${RESET}. ${label(items[i]!)}`);
  }
  while (true) {
    const answer = await promptFn(`Choose [1-${items.length}]: `);
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < items.length) return idx;
    console.log(`  Please enter a number between 1 and ${items.length}.`);
  }
}

// ── Session launch helpers ──────────────────────────────────────────

const WELCOME_MSG =
  "You're set up with ninthwave. Try /decompose to break down a feature, or /work to process existing work items.";

/**
 * Launch the AI tool inside the chosen multiplexer and pre-seed the welcome prompt.
 *
 * Returns a session reference string on success, or null on failure.
 */
export function launchSession(
  muxType: "cmux",
  aiCommand: string,
  cwd: string,
  runShell: ShellRunner = run,
  sleep: SleepFn = defaultSleep,
): string | null {
  const result = runShell("cmux", [
    "new-workspace",
    "--cwd",
    cwd,
    "--command",
    aiCommand,
  ]);
  if (result.exitCode !== 0) return null;
  const ref = result.stdout.match(/workspace:\d+/)?.[0] ?? null;
  if (ref) {
    // Best-effort: wait for tool to start, then send welcome message
    sleep(3000);
    runShell("cmux", [
      "send",
      "--workspace",
      ref,
      WELCOME_MSG + "\n",
    ]);
  }
  return ref;
}

// ── Main onboarding flow ────────────────────────────────────────────

/**
 * Interactive first-run onboarding flow.
 *
 * Guides the user through multiplexer detection, AI tool detection, project
 * setup, and session launch. All external I/O is injectable for testing.
 */
export async function onboard(
  projectDir: string,
  deps: OnboardDeps = {},
): Promise<void> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const prompt = deps.prompt ?? defaultPrompt;
  const runShell = deps.runShell ?? run;
  const sleep = deps.sleep ?? defaultSleep;
  const bundleDir = (deps.getBundleDir ?? getBundleDir)();

  // ── Step 1: Welcome ─────────────────────────────────────────────
  console.log();
  console.log(
    `${BOLD}Welcome to ninthwave${RESET} -- from spec to merged PRs, automatically.`,
  );
  console.log();

  // ── Step 2: Detect multiplexer ──────────────────────────────────
  console.log(`${DIM}Detecting multiplexer...${RESET}`);
  const installedMuxes = detectInstalledMuxes(commandExists);
  let chosenMux: MuxOption;

  if (installedMuxes.length === 0) {
    console.log(`  ${YELLOW}No multiplexer found.${RESET}`);
    console.log();
    console.log(
      "  ninthwave needs a terminal multiplexer for parallel sessions.",
    );
    console.log("  Install one of:");
    for (const m of MUX_OPTIONS) {
      console.log(
        `    ${BOLD}${m.installCmd}${RESET} ${DIM}(${m.description})${RESET}`,
      );
    }
    console.log();
    console.log(`  ${DIM}cmux is recommended for the best experience.${RESET}`);
    console.log();
    console.log(
      `Install a multiplexer and re-run ${BOLD}ninthwave${RESET}.`,
    );
    return;
  } else if (installedMuxes.length === 1) {
    chosenMux = installedMuxes[0]!;
    console.log(
      `  ${GREEN}✓${RESET} Found ${BOLD}${chosenMux.name}${RESET} ${DIM}(${chosenMux.description})${RESET}`,
    );
    const confirm = await prompt(`  Use ${chosenMux.name}? [Y/n]: `);
    if (confirm.toLowerCase() === "n") {
      console.log(
        `  Install a different multiplexer and re-run ${BOLD}ninthwave${RESET}.`,
      );
      return;
    }
  } else {
    console.log("  Found multiple multiplexers:");
    const idx = await promptChoice(
      installedMuxes,
      (m) => `${m.name} ${DIM}(${m.description})${RESET}`,
      prompt,
    );
    chosenMux = installedMuxes[idx]!;
  }
  console.log();

  // ── Step 3: Detect AI tool ──────────────────────────────────────
  console.log(`${DIM}Detecting AI coding tools...${RESET}`);
  const installedTools = detectInstalledAITools(commandExists);
  let chosenTool: AiToolProfile;

  if (installedTools.length === 0) {
    console.log(`  ${YELLOW}No AI coding tool found.${RESET}`);
    console.log();
    console.log("  ninthwave works with AI coding assistants. Install one:");
    for (const t of AI_TOOL_PROFILES) {
      console.log(
        `    ${BOLD}${t.installCmd}${RESET} ${DIM}(${t.description})${RESET}`,
      );
    }
    console.log();
    console.log(`  ${DIM}Claude Code is recommended.${RESET}`);
    console.log();
    console.log(`Install an AI tool and re-run ${BOLD}ninthwave${RESET}.`);
    return;
  } else if (installedTools.length === 1) {
    chosenTool = installedTools[0]!;
    console.log(
      `  ${GREEN}✓${RESET} Found ${BOLD}${chosenTool.displayName}${RESET} ${DIM}(${chosenTool.description})${RESET}`,
    );
    const confirm = await prompt(`  Use ${chosenTool.displayName}? [Y/n]: `);
    if (confirm.toLowerCase() === "n") {
      console.log(
        `  Install a different AI tool and re-run ${BOLD}ninthwave${RESET}.`,
      );
      return;
    }
  } else {
    console.log("  Found multiple AI tools:");
    const idx = await promptChoice(
      installedTools,
      (t) => `${t.displayName} ${DIM}(${t.description})${RESET}`,
      prompt,
    );
    chosenTool = installedTools[idx]!;
  }
  console.log();

  // ── Step 4: Run setup ───────────────────────────────────────────
  console.log(`${DIM}Setting up ninthwave...${RESET}`);
  const detection = initProject(projectDir, bundleDir, { commandExists });

  // ── Step 4b: Workspace confirmation ─────────────────────────────
  if (detection.workspace) {
    console.log(
      `${BOLD}Workspace detected:${RESET} ${detection.workspace.tool} (${detection.workspace.packages.length} packages)`,
    );
    for (const pkg of detection.workspace.packages) {
      const cmd = pkg.testCmd || "no test command";
      console.log(`  ${pkg.name} ${DIM}(${pkg.path})${RESET} -- ${cmd}`);
    }
    console.log();
    const confirm = await prompt(
      `  Does this look right? [Y/n]: `,
    );
    if (confirm.toLowerCase() === "n") {
      console.log(
        `  Edit workspace config in ${BOLD}.ninthwave/config.json${RESET}`,
      );
    }
  }
  console.log();

  // ── Step 5: Launch session ──────────────────────────────────────
  console.log(
    `${DIM}Launching ${chosenTool.displayName} in ${chosenMux.name}...${RESET}`,
  );
  const sessionRef = launchSession(
    chosenMux.type,
    chosenTool.command,
    projectDir,
    runShell,
    sleep,
  );

  if (!sessionRef) {
    console.log(`  ${RED}Failed to launch session.${RESET}`);
    console.log(
      `  Try manually: open ${chosenMux.name} and run ${BOLD}${chosenTool.command}${RESET}`,
    );
    return;
  }

  console.log(`  ${GREEN}✓${RESET} Session started`);
  console.log();

  // ── Step 6 & 7: Hand off ───────────────────────────────────────
  console.log(`${GREEN}You're all set!${RESET}`);
  console.log(
    `${chosenTool.displayName} is running in ${chosenMux.name}.`,
  );
  console.log();

  // cmux: GUI app, workspace is already visible -- no attach needed
}

// ── CLI entry point ─────────────────────────────────────────────────

/**
 * Check if onboarding should run and launch it if so.
 *
 * Returns true if onboarding was launched, false if the caller should
 * fall through to normal help behavior.
 */
export function shouldOnboard(projectDir: string | null): boolean {
  if (!projectDir) return false;
  return !existsSync(join(projectDir, ".ninthwave"));
}

/**
 * CLI entry point -- resolves project root and runs onboarding.
 */
export async function cmdOnboard(projectDir: string): Promise<void> {
  await onboard(projectDir);
}

// ── No-args handler ────────────────────────────────────────────────

/**
 * Handle `nw` with no arguments. Detects project state and routes to
 * the appropriate interactive flow:
 *
 * 1. Non-TTY → print help text
 * 2. No git repo → print help text
 * 3. No `.ninthwave/` → first-run onboarding (init flow)
 * 4. `.ninthwave/` exists, no work items → guidance message
 * 5. Work items exist, daemon running → live status view
 * 6. Work items exist, no daemon → mode-first prompt:
 *    a. Orchestrate (default) → merge strategy + WIP limit → cmdWatch
 *    b. Launch subset → item selection → cmdRunItems
 */
export async function cmdNoArgs(
  projectRoot: string | null,
  deps: NoArgsDeps = {},
): Promise<void> {
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);
  const checkExists = deps.existsSync ?? existsSync;
  const doParseT = deps.parseWorkItems ?? parseWorkItems;
  const checkDaemon = deps.isDaemonRunning ?? isDaemonRunning;
  const doDisplaySummary = deps.displayItemsSummary ?? displayItemsSummary;
  const doPromptMode = deps.promptMode ?? promptMode;
  const doPromptMergeStrategy = deps.promptMergeStrategy ?? promptMergeStrategy;
  const doPromptWipLimit = deps.promptWipLimit ?? promptWipLimit;
  const doPromptItems = deps.promptItems ?? promptItems;
  const prompt = deps.prompt ?? defaultPrompt;
  const helpFn = deps.printHelp ?? printHelp;

  // Non-TTY: always print grouped help text
  if (!isTTY) {
    helpFn();
    return;
  }

  // State 1: No git repo
  if (!projectRoot) {
    helpFn();
    return;
  }

  // State 2: No .ninthwave/ dir → first-run onboarding
  if (!checkExists(join(projectRoot, ".ninthwave"))) {
    await onboard(projectRoot, deps);
    return;
  }

  const workDir = join(projectRoot, ".ninthwave", "work");
  const worktreeDir = join(projectRoot, ".worktrees");

  // State 3: .ninthwave/ exists but no work item files
  let todos: WorkItem[] = [];
  if (checkExists(workDir)) {
    todos = doParseT(workDir, worktreeDir);
  }

  if (todos.length === 0) {
    console.log();
    console.log(`No work items found. Run ${BOLD}/decompose${RESET} to get started.`);
    console.log();
    return;
  }

  // State 4: Daemon running → live status view
  const daemonPid = checkDaemon(projectRoot);
  if (daemonPid !== null) {
    console.log(`${DIM}Orchestrator is running (PID ${daemonPid}). Showing live status...${RESET}`);
    console.log();
    if (deps.runStatusWatch) {
      await deps.runStatusWatch(worktreeDir, projectRoot);
    } else {
      // Dynamic import to avoid circular deps
      const { cmdStatusWatch } = await import("./status.ts");
      await cmdStatusWatch(worktreeDir, projectRoot);
    }
    return;
  }

  // State 5: Work items exist, no daemon → mode-first flow
  // Show read-only summary of all items
  doDisplaySummary(todos);

  // Ask: Orchestrate (default) or Launch subset?
  const mode = await doPromptMode(prompt);
  if (mode === "quit") return;

  if (mode === "orchestrate") {
    // TUI selection flow: items + merge strategy + WIP limit in-screen
    const doInteractive = deps.runInteractiveFlow ?? runInteractiveFlow;
    const result = await doInteractive(todos, 4);
    if (!result) return; // User cancelled

    const watchArgs = [
      "--items", ...result.itemIds,
      "--merge-strategy", result.mergeStrategy,
      "--wip-limit", String(result.wipLimit),
    ];

    if (deps.runWatch) {
      await deps.runWatch(watchArgs, workDir, worktreeDir, projectRoot);
    } else {
      const { cmdWatch } = await import("./orchestrate.ts");
      await cmdWatch(watchArgs, workDir, worktreeDir, projectRoot);
    }
  } else {
    // "launch" -- TUI selection for item subset
    const doInteractive = deps.runInteractiveFlow ?? runInteractiveFlow;
    const result = await doInteractive(todos, 4);
    if (!result) return; // User cancelled

    if (deps.runSelected) {
      await deps.runSelected(result.itemIds, workDir, worktreeDir, projectRoot);
    } else {
      const { cmdRunItems } = await import("./launch.ts");
      await cmdRunItems(result.itemIds, workDir, worktreeDir, projectRoot);
    }
  }
}
