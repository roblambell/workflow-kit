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
  /** Agent files target directory for this tool (relative to project root). */
  targetDir: string;
  /** Filename suffix for agent files (e.g. ".md", ".agent.md"). */
  suffix: string;
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
    targetDir: ".claude/agents",
    suffix: ".md",
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
    targetDir: ".opencode/agents",
    suffix: ".md",
    buildLaunchCmd(opts, deps): LaunchCmdResult {
      const cmd = `opencode --agent ${opts.agentName} --title '${opts.wsName}'`;
      const promptContent = deps.readFileSync(opts.promptFile, "utf-8");
      const initialPrompt = `${promptContent}\n\nStart implementing this work item now.`;
      return { cmd, initialPrompt };
    },
  },
  {
    id: "copilot",
    targetDir: ".github/agents",
    suffix: ".agent.md",
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
