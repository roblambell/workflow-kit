// `ninthwave` no-args handling -- adapts to project state.
//
// When `ninthwave` is run with no arguments, detects the project state and
// routes to the appropriate flow:
// 1. No git repo → help text
// 2. No .ninthwave/ → first-run onboarding (init flow)
// 3. .ninthwave/ exists, no work items → guidance message
// 4. Daemon running → live status view
// 5. Work items exist, no daemon → TUI selection → cmdWatch

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
import { resolveCmuxBinary } from "../cmux-resolve.ts";
import type { WorkItem } from "../types.ts";
import type { ProjectConfig, UserConfig } from "../config.ts";
import { initProject } from "./init.ts";
import { getBundleDir } from "../paths.ts";
import { isDaemonRunning } from "../daemon.ts";
import { parseWorkItems } from "../parser.ts";
import { runInteractiveFlow } from "../interactive.ts";
import type { InteractiveResult, InteractiveDeps } from "../interactive.ts";
import { loadConfig, loadUserConfig, saveUserConfig } from "../config.ts";
import { printHelp } from "../help.ts";
import { AI_TOOL_PROFILES } from "../ai-tools.ts";
import type { AiToolProfile } from "../ai-tools.ts";
import { detectInstalledAITools } from "../tool-select.ts";
import { ensureMuxInteractiveOrDie } from "../mux.ts";
import { requireCrewCode } from "./crew.ts";
import {
  runCheckboxList,
  createProcessIO,
  CLEAR_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "../tui-widgets.ts";
import type { WidgetIO, CheckboxItem } from "../tui-widgets.ts";

// ── Multiplexer descriptors ─────────────────────────────────────────

export interface MuxOption {
  type: "cmux" | "tmux";
  name: string;
  description: string;
  installCmd: string;
}

export const MUX_OPTIONS: MuxOption[] = [
  {
    type: "tmux",
    name: "tmux",
    description: "battle-hardened, runs in your existing terminal",
    installCmd: "brew install tmux",
  },
  {
    type: "cmux",
    name: "cmux",
    description: "visual macOS sidebar",
    installCmd: "brew install --cask manaflow-ai/cmux/cmux",
  },
];

// ── Dependency injection ────────────────────────────────────────────

export type CommandChecker = (cmd: string) => boolean;
export type PromptFn = (question: string) => Promise<string>;

export interface OnboardDeps {
  commandExists?: CommandChecker;
  prompt?: PromptFn;
  getBundleDir?: () => string;
  widgetIO?: WidgetIO;
  saveUserConfig?: (updates: Partial<UserConfig>) => void;
}

// ── No-args dependency injection ───────────────────────────────────

export interface NoArgsDeps extends OnboardDeps {
  isTTY?: boolean;
  existsSync?: typeof existsSync;
  parseWorkItems?: (workDir: string, worktreeDir: string) => WorkItem[];
  isDaemonRunning?: (projectRoot: string) => number | null;
  ensureMux?: (args: string[]) => Promise<void>;
  runInteractiveFlow?: (todos: WorkItem[], defaultWipLimit: number, deps?: InteractiveDeps) => Promise<InteractiveResult | null>;
  runWatch?: (args: string[], workDir: string, worktreeDir: string, projectRoot: string) => Promise<void>;
  runStatusWatch?: (worktreeDir: string, projectRoot: string) => Promise<void>;
  printHelp?: () => void;
  loadConfig?: (projectRoot: string) => ProjectConfig;
  loadUserConfig?: () => UserConfig;
  sleep?: (ms: number) => Promise<void>;
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

// ── Detection functions ─────────────────────────────────────────────

/**
 * Detect all installed multiplexers.
 * Returns matching MuxOption entries.
 */
export function detectInstalledMuxes(
  commandExists: CommandChecker = defaultCommandExists,
  cmuxResolver: () => string | null = resolveCmuxBinary,
): MuxOption[] {
  return MUX_OPTIONS.filter((m) => {
    if (m.type === "cmux") return cmuxResolver() !== null;
    return commandExists(m.type);
  });
}

// detectInstalledAITools re-exported from tool-select.ts for backward compatibility.
export { detectInstalledAITools } from "../tool-select.ts";

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

// ── Main onboarding flow ────────────────────────────────────────────

/**
 * Interactive first-run onboarding flow.
 *
 * Detects AI coding tools, runs project setup, and shows next-step guidance.
 * All external I/O is injectable for testing.
 */
export async function onboard(
  projectDir: string,
  deps: OnboardDeps = {},
): Promise<void> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const prompt = deps.prompt ?? defaultPrompt;
  const doSaveUserConfig = deps.saveUserConfig ?? saveUserConfig;
  let bundleDir: string;
  try {
    bundleDir = (deps.getBundleDir ?? getBundleDir)();
  } catch {
    console.error();
    console.error(`${RED}ninthwave installation not found.${RESET}`);
    console.error();
    console.error("Set NINTHWAVE_HOME to your ninthwave installation directory:");
    console.error(`  ${BOLD}export NINTHWAVE_HOME=/path/to/ninthwave${RESET}`);
    console.error();
    console.error("Or install via Homebrew:");
    console.error(`  ${BOLD}brew install ninthwave-sh/tap/ninthwave${RESET}`);
    console.error();
    return;
  }

  // ── Step 1: Welcome ─────────────────────────────────────────────
  console.log();
  console.log(
    `${BOLD}Welcome to ninthwave${RESET} -- local-first parallel AI coding orchestration.`,
  );
  console.log();

  // ── Step 2: Detect AI tool ──────────────────────────────────────
  console.log(`${DIM}Detecting AI coding tools...${RESET}`);
  const installedTools = detectInstalledAITools(commandExists);
  if (installedTools.length === 0) {
    console.log(`  ${YELLOW}No AI coding tool found.${RESET}`);
    console.log();
    console.log("  ninthwave works with AI coding assistants. Install one:");
    for (const t of AI_TOOL_PROFILES) {
      console.log(`    ${BOLD}${t.installCmd}${RESET}`);
    }
    console.log();
    console.log(`  ${DIM}Claude Code is recommended.${RESET}`);
    console.log();
    console.log(`Install an AI tool and re-run ${BOLD}ninthwave${RESET}.`);
    return;
  }

  let chosenTool: AiToolProfile;
  if (installedTools.length === 1) {
    chosenTool = installedTools[0]!;
    console.log(`  ${GREEN}✓${RESET} Found ${BOLD}${chosenTool.displayName}${RESET}`);
    doSaveUserConfig({ ai_tools: [chosenTool.id] });
  } else {
    const stdin = process.stdin;
    const needsRawMode = !deps.widgetIO && stdin.isTTY && !!stdin.setRawMode;
    if (needsRawMode) {
      stdin.setRawMode!(true);
      stdin.resume();
      stdin.setEncoding("utf8");
    }
    const io = deps.widgetIO ?? createProcessIO();
    const toolItems: CheckboxItem[] = installedTools.map((t, i) => ({
      id: t.id,
      label: t.displayName,
      checked: i === 0,
    }));
    io.write(CLEAR_SCREEN + HIDE_CURSOR);
    let toolResult;
    try {
      toolResult = await runCheckboxList(io, toolItems, {
        title: "Ninthwave \u00b7 AI coding tool",
        validate: (ids) => ids.length > 0 ? null : "Select at least one tool",
      });
    } finally {
      if (needsRawMode) {
        stdin.setRawMode!(false);
        stdin.pause();
      }
      io.write(SHOW_CURSOR);
    }
    if (toolResult.cancelled) return;
    const selectedIds = toolResult.selectedIds;
    chosenTool = installedTools.find((t) => t.id === selectedIds[0]) ?? installedTools[0]!;
    doSaveUserConfig({ ai_tools: selectedIds });
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

  console.log(`${GREEN}You're all set!${RESET}`);
  console.log(
    `Add work items to ${BOLD}.ninthwave/work/${RESET} or use ${BOLD}/decompose${RESET} in ${chosenTool.displayName} to break down a feature.`,
  );
  console.log();
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
 * 4. Daemon running → live status view
 * 5. No daemon → interactive startup flow (including zero-item startup)
 */
export async function cmdNoArgs(
  projectRoot: string | null,
  deps: NoArgsDeps = {},
): Promise<void> {
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);
  const checkExists = deps.existsSync ?? existsSync;
  const doParseT = deps.parseWorkItems ?? parseWorkItems;
  const checkDaemon = deps.isDaemonRunning ?? isDaemonRunning;
  const doEnsureMux = deps.ensureMux ?? ensureMuxInteractiveOrDie;
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
  const ninthwaveDir = join(projectRoot, ".ninthwave");
  if (!checkExists(ninthwaveDir)) {
    await onboard(projectRoot, deps);
    // If onboarding was aborted (user cancelled, no AI tool, etc.), .ninthwave/ won't exist.
    if (!checkExists(ninthwaveDir)) return;
    // Fall through -- .ninthwave/ now exists; show no-work-items guidance below.
  }

  const workDir = join(projectRoot, ".ninthwave", "work");
  const worktreeDir = join(projectRoot, ".ninthwave", ".worktrees");

  // State 3: Daemon running → live status view
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

  // State 4: No daemon → interactive startup flow.
  // Zero-item repos continue into the same startup path instead of blocking in a pre-watch wait loop.
  let todos: WorkItem[] = [];
  if (checkExists(workDir)) {
    todos = doParseT(workDir, worktreeDir);
  }

  await doEnsureMux([]);

  // Load project config for repo-level defaults and user config for saved tools.
  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doLoadUserConfig = deps.loadUserConfig ?? loadUserConfig;
  const projectConfig = doLoadConfig(projectRoot);
  const userConfig = doLoadUserConfig();
  const defaultReviewMode = projectConfig.review_external ? "all" as const : "mine" as const;
  const installedTools = detectInstalledAITools();
  const doInteractive = deps.runInteractiveFlow ?? runInteractiveFlow;
  const result = await doInteractive(todos, 4, {
    defaultReviewMode,
    installedTools,
    savedToolIds: userConfig.ai_tools,
  });
  if (!result) return; // User cancelled

  // Build watch args from interactive result
  const watchArgs = [
    "--merge-strategy", result.mergeStrategy,
    "--wip-limit", String(result.wipLimit),
  ];

  if (result.itemIds.length > 0) {
    watchArgs.unshift(...result.itemIds);
    watchArgs.unshift("--items");
  }

  // Dynamic re-scanning when all items selected
  if (result.allSelected || result.futureOnly) {
    watchArgs.push("--watch");
  }

  if (result.futureOnly) {
    watchArgs.push("--future-only-startup");
  }

  // Review mode → CLI flags
  if (result.reviewMode === "all") {
    watchArgs.push("--review-external");
  } else if (result.reviewMode === "off") {
    watchArgs.push("--review-wip-limit", "0");
  }
  // "mine" → default behavior, no extra flag

  // Connection action → CLI flags
  if (result.connectionAction) {
    if (result.connectionAction.type === "join") {
      watchArgs.push("--crew", requireCrewCode(result.connectionAction.code));
    } else if (result.connectionAction.type === "connect") {
      watchArgs.push("--connect");
    }
  }

  // AI tool(s) → --tool flag (comma-separated for multi-select)
  if (result.aiTools && result.aiTools.length > 0) {
    watchArgs.push("--tool", result.aiTools.join(","));
  } else if (result.aiTool) {
    watchArgs.push("--tool", result.aiTool);
  }

  if (deps.runWatch) {
    await deps.runWatch(watchArgs, workDir, worktreeDir, projectRoot);
  } else {
    const { cmdWatch } = await import("./orchestrate.ts");
    await cmdWatch(watchArgs, workDir, worktreeDir, projectRoot);
  }
}
