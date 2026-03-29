// AI tool profiles: single source of truth for Claude Code, OpenCode, and Copilot.
//
// Defines AiToolId, AiToolProfile, LaunchDeps, LaunchOpts, and AI_TOOL_PROFILES.
// All other modules should derive tool-specific behaviour from this module rather
// than maintaining their own per-tool switch statements.

import { readFileSync as defaultReadFileSync, writeFileSync as defaultWriteFileSync } from "fs";
import { run as defaultRun } from "./shell.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Supported AI tool identifiers. */
export type AiToolId = "claude" | "opencode" | "copilot";

/**
 * Injectable dependencies for buildLaunchCmd.
 * Keeping these injectable enables unit tests without touching the real filesystem
 * or spawning processes (especially important for Copilot's temp-file creation).
 */
export interface LaunchDeps {
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, content: string) => void;
  run: (cmd: string, args: string[]) => unknown;
}

/** Options passed to buildLaunchCmd. */
export interface LaunchOpts {
  /** Workspace name shown in the multiplexer tab title. */
  wsName: string;
  /** Agent persona to load (e.g. "ninthwave-implementer"). */
  agentName: string;
  /** Absolute path to the .nw-prompt file containing the system prompt. */
  promptFile: string;
  /** Work item ID -- used for unique temp-file names (Copilot). */
  id: string;
}

/** Result of buildLaunchCmd. */
export interface LaunchCmdResult {
  /** Shell command to execute via the multiplexer. */
  cmd: string;
  /**
   * Initial prompt to send after the workspace launches.
   * An empty string means the prompt is already embedded in cmd -- skip the
   * post-launch send step entirely.
   */
  initialPrompt: string;
}

/** An agent file target: the directory and filename suffix for one tool. */
export interface AgentTarget {
  dir: string;
  suffix: string;
}

/** Maps one agent source file to its targets across all tools. */
export interface AgentFileTargetEntry {
  source: string;
  targets: AgentTarget[];
}

/** Full profile for a single AI tool. */
export interface AiToolProfile {
  id: AiToolId;
  /** Human-readable display name (e.g., "Claude Code", "OpenCode"). */
  displayName: string;
  /** Binary command name (e.g., "claude", "opencode", "copilot"). */
  command: string;
  /** Short description for onboarding UI. */
  description: string;
  /** Install command to suggest in onboarding UI. */
  installCmd: string;
  /** Agent files target directory for this tool (relative to project root). */
  targetDir: string;
  /** Filename suffix for agent files (e.g. ".md", ".agent.md"). */
  suffix: string;
  /**
   * Filesystem paths (relative to project root) that indicate this tool is
   * configured in the project. ANY matching path triggers detection.
   * Used by detectProjectTools in setup.ts.
   */
  projectIndicators: string[];
  /**
   * Environment variable checks for detecting the running tool session.
   * Each entry: { varName, value? } -- value means the env var must equal
   * that value; no value means the env var must be set (truthy).
   * Used by detectAiTool in run-items.ts.
   */
  envDetection?: Array<{ varName: string; value?: string }>;
  /**
   * Process name(s) to look for when walking the parent process tree.
   * Used by detectAiTool in run-items.ts as a fallback.
   */
  processNames: string[];
  /**
   * Screen text indicators that this tool's input prompt is visible and ready.
   * Combined with tool-agnostic defaults in worker-health.ts.
   */
  promptIndicators?: string[];
  /**
   * Build the multiplexer launch command and initial prompt for this tool.
   * Receives injectable deps so Copilot's temp-file creation is testable.
   */
  buildLaunchCmd: (opts: LaunchOpts, deps: LaunchDeps) => LaunchCmdResult;
}

// ── Profiles ──────────────────────────────────────────────────────────────────

/** The canonical list of AI tool profiles -- one entry per supported tool. */
export const AI_TOOL_PROFILES: AiToolProfile[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    command: "claude",
    description: "Anthropic's AI coding assistant",
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
    targetDir: ".claude/agents",
    suffix: ".md",
    projectIndicators: [".claude"],
    envDetection: [
      { varName: "CLAUDE_CODE_SESSION" },
      { varName: "CLAUDE_SESSION_ID" },
    ],
    processNames: ["claude"],
    promptIndicators: [
      "❯",                  // Claude Code prompt character
      "Enter a prompt",     // Claude Code initial prompt state
      "bypass permissions", // Claude Code permission mode indicator
      "What can I help",    // Claude Code greeting
      "How can I help",     // Claude Code greeting variant
    ],
    buildLaunchCmd(opts, _deps): LaunchCmdResult {
      // Prompt is embedded as a positional arg via --append-system-prompt; no post-launch send.
      const cmd =
        `claude --name '${opts.wsName}' --permission-mode bypassPermissions` +
        ` --agent ${opts.agentName}` +
        ` --append-system-prompt "$(cat '.nw-prompt')" -- Start`;
      return { cmd, initialPrompt: "" };
    },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    description: "Open-source AI coding tool",
    installCmd: "curl -fsSL https://opencode.ai/install | bash",
    targetDir: ".opencode/agents",
    suffix: ".md",
    projectIndicators: [".opencode", ".opencode.json"],
    envDetection: [{ varName: "OPENCODE", value: "1" }],
    processNames: ["opencode"],
    buildLaunchCmd(opts, deps): LaunchCmdResult {
      const cmd = `opencode --agent ${opts.agentName} --title '${opts.wsName}'`;
      const promptContent = deps.readFileSync(opts.promptFile, "utf-8");
      const initialPrompt = `${promptContent}\n\nStart implementing this work item now.`;
      return { cmd, initialPrompt };
    },
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    command: "copilot",
    description: "GitHub's AI pair programmer",
    installCmd: "npm install -g @github/copilot",
    targetDir: ".github/agents",
    suffix: ".agent.md",
    projectIndicators: [".github/copilot-instructions.md", ".github/agents"],
    processNames: ["copilot"],
    buildLaunchCmd(opts, deps): LaunchCmdResult {
      // Write a launcher script so the full prompt reaches copilot via -i without
      // any shell quoting issues from multiplexer pipelines.
      const ts = Date.now();
      const launcherScript = `/tmp/nw-launch-${opts.id}-${ts}.sh`;
      const promptDataFile = `/tmp/nw-prompt-${opts.id}-${ts}`;
      const promptContent = deps.readFileSync(opts.promptFile, "utf-8");
      deps.writeFileSync(promptDataFile, `${promptContent}\n\nStart implementing this work item now.`);
      deps.writeFileSync(
        launcherScript,
        `#!/bin/bash\n` +
          `PROMPT=$(cat '${promptDataFile}')\n` +
          `rm -f '${promptDataFile}' '${launcherScript}'\n` +
          `exec copilot --agent=${opts.agentName} --allow-all -i "$PROMPT"\n`,
      );
      deps.run("chmod", ["+x", launcherScript]);
      // Prompt is embedded in the launcher script via -i; no post-launch send.
      return { cmd: launcherScript, initialPrompt: "" };
    },
  },
];

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Look up a tool profile by ID.
 * Throws if the ID is not registered.
 */
export function getToolProfile(id: string): AiToolProfile {
  const profile = AI_TOOL_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown AI tool: ${id}. Supported tools: ${allToolIds().join(", ")}`);
  return profile;
}

/** Return all registered tool IDs in profile order. */
export function allToolIds(): AiToolId[] {
  return AI_TOOL_PROFILES.map((p) => p.id);
}

/** Type guard: returns true if s is a valid AiToolId. */
export function isAiToolId(s: string): s is AiToolId {
  return AI_TOOL_PROFILES.some((p) => p.id === s);
}

/**
 * Return the agent file target dirs for all tools, in profile order.
 * Equivalent to the static targets array in agent-files.ts AGENT_FILES entries.
 */
export function agentTargetDirs(): AgentTarget[] {
  return AI_TOOL_PROFILES.map((p) => ({ dir: p.targetDir, suffix: p.suffix }));
}

/**
 * Given a list of agent source filenames, return the full target mapping for all tools.
 * This is the canonical replacement for the hardcoded AGENT_FILES array in agent-files.ts.
 *
 * Example:
 *   agentFileTargets(["implementer.md"])
 *   // → [{ source: "implementer.md", targets: [{ dir: ".claude/agents", suffix: ".md" }, ...] }]
 */
export function agentFileTargets(sources: string[]): AgentFileTargetEntry[] {
  const targets = agentTargetDirs();
  return sources.map((source) => ({ source, targets }));
}

// ── Default deps (re-exported for callers that want real fs/process) ──────────

export const defaultLaunchDeps: LaunchDeps = {
  readFileSync: (path, enc) => defaultReadFileSync(path, enc),
  writeFileSync: defaultWriteFileSync,
  run: (cmd, args) => defaultRun(cmd, args),
};
