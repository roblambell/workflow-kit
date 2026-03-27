// `ninthwave` first-run onboarding — interactive flow for uninitialized projects.
//
// When `ninthwave` is run with no arguments in a directory that isn't set up yet
// (no .ninthwave/ directory), this replaces the default help behavior with an
// interactive flow that detects tools, runs setup, and launches the AI tool
// inside the chosen multiplexer.

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
import type { RunResult } from "../types.ts";
import { initProject } from "./init.ts";
import { getBundleDir } from "../paths.ts";

// ── AI tool descriptors ─────────────────────────────────────────────

export interface AITool {
  name: string;
  command: string;
  description: string;
  installCmd: string;
}

export const AI_TOOLS: AITool[] = [
  {
    name: "Claude Code",
    command: "claude",
    description: "Anthropic's AI coding assistant",
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  {
    name: "OpenCode",
    command: "opencode",
    description: "Open-source AI coding tool",
    installCmd: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    name: "GitHub Copilot",
    command: "copilot",
    description: "GitHub's AI pair programmer",
    installCmd: "npm install -g @github/copilot",
  },
];

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
 * Returns matching AITool entries in preference order (claude > opencode > copilot).
 */
export function detectInstalledAITools(
  commandExists: CommandChecker = defaultCommandExists,
): AITool[] {
  return AI_TOOLS.filter((t) => commandExists(t.command));
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
  "You're set up with ninthwave. Try /decompose to break down a feature, or /work to process existing TODOs.";

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
    `${BOLD}Welcome to ninthwave${RESET} — from spec to merged PRs, automatically.`,
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
  let chosenTool: AITool;

  if (installedTools.length === 0) {
    console.log(`  ${YELLOW}No AI coding tool found.${RESET}`);
    console.log();
    console.log("  ninthwave works with AI coding assistants. Install one:");
    for (const t of AI_TOOLS) {
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
      `  ${GREEN}✓${RESET} Found ${BOLD}${chosenTool.name}${RESET} ${DIM}(${chosenTool.description})${RESET}`,
    );
    const confirm = await prompt(`  Use ${chosenTool.name}? [Y/n]: `);
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
      (t) => `${t.name} ${DIM}(${t.description})${RESET}`,
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
      console.log(`  ${pkg.name} ${DIM}(${pkg.path})${RESET} — ${cmd}`);
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
    `${DIM}Launching ${chosenTool.name} in ${chosenMux.name}...${RESET}`,
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
    `${chosenTool.name} is running in ${chosenMux.name}.`,
  );
  console.log();

  // cmux: GUI app, workspace is already visible — no attach needed
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
 * CLI entry point — resolves project root and runs onboarding.
 */
export async function cmdOnboard(projectDir: string): Promise<void> {
  await onboard(projectDir);
}
