// AI tool selection: explicit, user-driven tool choice with config persistence.
// Replaces the old auto-detection cascade (detectAiTool) with an intentional
// prompt-based flow that remembers the last used tool.

import { createInterface } from "readline";
import { AI_TOOL_PROFILES, isAiToolId, getToolProfile, hasAgentFiles } from "./ai-tools.ts";
import type { AiToolProfile } from "./ai-tools.ts";
import { loadUserConfig, saveUserConfig } from "./config.ts";
import type { UserConfig } from "./config.ts";
import { run } from "./shell.ts";
import { die, warn, info, BOLD, DIM, RESET } from "./output.ts";

// ── Types ────────────────────────────────────────────────────────────

export type CommandChecker = (cmd: string) => boolean;
export type PromptFn = (question: string) => Promise<string>;

export interface SelectAiToolOptions {
  /** Explicit tool override from --tool CLI arg. Bypasses prompt. */
  toolOverride?: string;
  /** Project root for caller compatibility. */
  projectRoot: string;
  /** Whether to prompt interactively (TTY, not daemon). */
  isInteractive: boolean;
}

export interface SelectAiToolDeps {
  commandExists?: CommandChecker;
  prompt?: PromptFn;
  loadUserConfig?: () => UserConfig;
  saveUserConfig?: (updates: Partial<UserConfig>) => void;
}

// ── Default implementations ──────────────────────────────────────────

const defaultCommandExists: CommandChecker = (cmd: string): boolean => {
  return run("which", [cmd]).exitCode === 0;
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

// ── Detection ────────────────────────────────────────────────────────

/**
 * Detect all installed AI coding tools.
 * Returns matching AiToolProfile entries in preference order
 * (claude > opencode > codex > copilot).
 */
export function detectInstalledAITools(
  commandExists: CommandChecker = defaultCommandExists,
): AiToolProfile[] {
  return AI_TOOL_PROFILES.filter((p) => commandExists(p.command));
}

// ── Selection ────────────────────────────────────────────────────────

/**
 * Select which AI tool(s) to use for worker sessions.
 *
 * Priority chain:
 * 1. --tool CLI override (comma-separated): save, return
 * 2. User config (~/.ninthwave/config.json ai_tools/ai_tool): return
 * 3. Detect installed tools
 * 4. None found: error with install instructions
 * 5. Single tool: auto-select, save, return
 * 6. Multiple + non-interactive: use first installed
 * 7. Multiple + interactive: multi-select prompt
 */
export async function selectAiTools(
  options: SelectAiToolOptions,
  deps: SelectAiToolDeps = {},
): Promise<string[]> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const promptFn = deps.prompt ?? defaultPrompt;
  const doLoadUserConfig = deps.loadUserConfig ?? loadUserConfig;
  const doSaveUserConfig = deps.saveUserConfig ?? saveUserConfig;
  const knownIds = AI_TOOL_PROFILES.map(p => p.id).join(", ");

  // 1. Explicit --tool override (comma-separated)
  if (options.toolOverride) {
    const tools = options.toolOverride.split(",").map(s => s.trim()).filter(Boolean);
    for (const t of tools) {
      if (!isAiToolId(t)) {
        warn(`Unknown AI tool: "${t}". Known tools: ${knownIds}. Proceeding anyway.`);
      }
    }
    doSaveUserConfig({ ai_tools: tools });
    return tools;
  }

  // 2. User-level config (~/.ninthwave/config.json)
  const userConfig = doLoadUserConfig();
  if (userConfig.ai_tools && userConfig.ai_tools.length > 0) {
    for (const t of userConfig.ai_tools) {
      if (!isAiToolId(t)) {
        warn(`Unknown AI tool in ~/.ninthwave/config.json: "${t}". Known tools: ${knownIds}. Proceeding anyway.`);
      }
    }
    return userConfig.ai_tools;
  }

  // 3. Detect installed tools
  const installed = detectInstalledAITools(commandExists);

  // 4. None found
  if (installed.length === 0) {
    die(
      "No AI coding tool found. Install one:\n" +
      AI_TOOL_PROFILES.map(p => `  ${BOLD}${p.installCmd}${RESET} ${DIM}(${p.description})${RESET}`).join("\n"),
    );
  }

  // 5. Single tool --auto-select
  if (installed.length === 1) {
    const tool = installed[0]!;
    doSaveUserConfig({ ai_tools: [tool.id] });
    return [tool.id];
  }

  // 6. Multiple tools, non-interactive --use first installed
  const savedTools = userConfig.ai_tools;

  if (!options.isInteractive) {
    return [installed[0]!.id];
  }

  // 7. Multiple tools, interactive --multi-select with toggles
  const selected = new Set<number>();
  // Pre-check saved tools
  if (savedTools && savedTools.length > 0) {
    for (const st of savedTools) {
      const idx = installed.findIndex(t => t.id === st);
      if (idx >= 0) selected.add(idx);
    }
  }
  // If nothing pre-checked, check the first one
  if (selected.size === 0) selected.add(0);

  const renderList = () => {
    console.log(`${DIM}AI coding tool(s) -- toggle with number, Enter to confirm:${RESET}`);
    for (let i = 0; i < installed.length; i++) {
      const t = installed[i]!;
      const check = selected.has(i) ? `[x]` : `[ ]`;
      console.log(`  ${BOLD}${i + 1}${RESET}. ${check} ${t.displayName} ${DIM}(${t.description})${RESET}`);
    }
  };

  renderList();

  while (true) {
    const answer = await promptFn(`Toggle [1-${installed.length}] or Enter to confirm: `);

    if (answer === "") {
      if (selected.size === 0) {
        console.log(`  Select at least one tool.`);
        continue;
      }
      break;
    }

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < installed.length) {
      if (selected.has(idx)) {
        selected.delete(idx);
      } else {
        selected.add(idx);
      }
      renderList();
    } else {
      console.log(`  Please enter a number between 1 and ${installed.length}.`);
    }
  }

  const result = [...selected].sort().map(i => installed[i]!.id);
  doSaveUserConfig({ ai_tools: result });
  const names = result.map(id => AI_TOOL_PROFILES.find(p => p.id === id)?.displayName ?? id);
  info(`Using ${names.join(", ")}${result.length > 1 ? " (round-robin)" : ""}`);
  return result;
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Warn when selected tools are missing agent files in the project.
 * Non-fatal: workers still attempt to launch (native --agent discovery
 * may still work), but the user knows to run `nw init` if needed.
 */
export function validateAgentFiles(toolIds: string[], projectRoot: string): void {
  for (const toolId of toolIds) {
    if (!isAiToolId(toolId)) continue;
    if (!hasAgentFiles(toolId, projectRoot)) {
      const profile = getToolProfile(toolId);
      warn(
        `No agent files found for ${profile.displayName} at ${profile.targetDir}/. ` +
        `Run "nw init" to generate agent artifacts.`,
      );
    }
  }
}

/**
 * Select a single AI tool. Thin wrapper around selectAiTools for callers
 * that only need one tool (e.g., `nw start`).
 */
export async function selectAiTool(
  options: SelectAiToolOptions,
  deps: SelectAiToolDeps = {},
): Promise<string> {
  const tools = await selectAiTools(options, deps);
  return tools[0]!;
}
