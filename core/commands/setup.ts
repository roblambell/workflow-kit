// Setup utilities -- shared functions for project initialization.
//
// Provides: prerequisite checking, skill/agent symlink management,
// interactive agent selection, nw symlink creation, and global setup.
//
// Used by `core/commands/init.ts` for the unified `ninthwave init` command.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  lstatSync,
  readlinkSync,
} from "fs";
import { join, relative, dirname, resolve } from "path";
import { getBundleDir } from "../paths.ts";
import { info, die, warn, RED, YELLOW, GREEN, RESET, BOLD, DIM } from "../output.ts";
import { run } from "../shell.ts";
import {
  checkboxPrompt as defaultCheckboxPrompt,
  confirmPrompt as defaultConfirmPrompt,
} from "../prompt.ts";
import type { CheckboxChoice, CheckboxPromptFn, ConfirmPromptFn } from "../prompt.ts";
import { AI_TOOL_PROFILES } from "../ai-tools.ts";

/**
 * Resolve the absolute path to a command on PATH.
 * Default implementation uses `which`; tests can inject a stub.
 */
export type CommandPathResolver = (cmd: string) => string | null;

const defaultResolveCommandPath: CommandPathResolver = (
  cmd: string,
): string | null => {
  const result = run("which", [cmd]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

/**
 * Prerequisite descriptor for a required external tool.
 */
interface Prerequisite {
  name: string;
  installCmd: string;
  purpose: string;
}

const PREREQUISITES: Prerequisite[] = [
  {
    name: "gh",
    installCmd: "brew install gh",
    purpose: "GitHub PR operations",
  },
];

/**
 * Check whether a command is available on PATH.
 * Default implementation uses `which`; tests can inject a stub.
 */
export type CommandChecker = (cmd: string) => boolean;

const defaultCommandExists: CommandChecker = (cmd: string): boolean => {
  const result = run("which", [cmd]);
  return result.exitCode === 0;
};

/**
 * Check whether `gh` is authenticated.
 * Default implementation runs `gh auth status`; tests can inject a stub.
 */
export type AuthChecker = () => { authenticated: boolean; stderr: string };

const defaultGhAuthCheck: AuthChecker = (): {
  authenticated: boolean;
  stderr: string;
} => {
  const result = run("gh", ["auth", "status"]);
  return {
    authenticated: result.exitCode === 0,
    stderr: result.stderr,
  };
};

export interface PrerequisiteResult {
  /** true if all required prerequisites are present */
  allPresent: boolean;
  /** names of missing prerequisites */
  missing: string[];
  /** warnings (e.g. gh not authenticated) */
  warnings: string[];
  /** detected multiplexer: "cmux" or null if not found */
  detectedMux: "cmux" | null;
}

/**
 * Check for required prerequisites and print actionable messages.
 *
 * Returns a result object describing what's missing/warning.
 * Callers decide whether to abort.
 */
export function checkPrerequisites(
  commandExists: CommandChecker = defaultCommandExists,
  ghAuthCheck: AuthChecker = defaultGhAuthCheck,
): PrerequisiteResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  console.log("Checking prerequisites...");

  // Check required prerequisites
  for (const prereq of PREREQUISITES) {
    if (commandExists(prereq.name)) {
      console.log(`  ${GREEN}✓${RESET} ${prereq.name} ${DIM}(${prereq.purpose})${RESET}`);
    } else {
      console.log(`  ${RED}✗${RESET} ${prereq.name} ${DIM}(${prereq.purpose})${RESET}`);
      console.log(`    Install: ${BOLD}${prereq.installCmd}${RESET}`);
      missing.push(prereq.name);
    }
  }

  // Detect multiplexer
  let detectedMux: "cmux" | null = null;
  if (commandExists("cmux")) {
    detectedMux = "cmux";
    console.log(`  ${GREEN}✓${RESET} cmux ${DIM}(multiplexer -- visual sidebar)${RESET}`);
  } else {
    console.log(`  ${RED}✗${RESET} cmux ${DIM}(terminal multiplexer for parallel sessions)${RESET}`);
    console.log(`    Install: ${BOLD}brew install --cask manaflow-ai/cmux/cmux${RESET}`);
    missing.push("cmux");
  }

  // If gh is present, check authentication
  if (!missing.includes("gh") && commandExists("gh")) {
    const auth = ghAuthCheck();
    if (!auth.authenticated) {
      console.log(`  ${YELLOW}⚠${RESET} gh is not authenticated`);
      console.log(`    Run: ${BOLD}gh auth login${RESET}`);
      warnings.push("gh is installed but not authenticated -- run: gh auth login");
    }
  }

  console.log();

  if (missing.length > 0) {
    console.log(
      `${RED}Missing prerequisites:${RESET} ${missing.join(", ")}. Install them and re-run ${BOLD}ninthwave init${RESET}.`,
    );
    console.log();
  }

  return {
    allPresent: missing.length === 0,
    missing,
    warnings,
    detectedMux,
  };
}

/**
 * Create an `nw` symlink next to the `ninthwave` binary in PATH.
 *
 * This provides the short alias for daily-driver use. The symlink is
 * relative (`nw` → `ninthwave`) so it survives Homebrew prefix changes.
 *
 * Returns true if symlink was created, false if skipped or failed.
 */
export function createNwSymlink(
  commandExists: CommandChecker = defaultCommandExists,
  resolveCommandPath: CommandPathResolver = defaultResolveCommandPath,
): boolean {
  // If nw already exists in PATH, nothing to do
  if (commandExists("nw")) {
    console.log("  nw alias: already in PATH");
    return false;
  }

  // Find where ninthwave is installed
  const ninthwavePath = resolveCommandPath("ninthwave");
  if (!ninthwavePath) {
    console.log(
      `  nw alias: skipped (ninthwave not in PATH -- install via ${BOLD}brew install ninthwave-sh/tap/ninthwave${RESET})`,
    );
    return false;
  }

  const nwPath = join(dirname(ninthwavePath), "nw");

  try {
    symlinkSync("ninthwave", nwPath);
    console.log(`  ${GREEN}✓${RESET} nw → ninthwave ${DIM}(${dirname(ninthwavePath)})${RESET}`);
    return true;
  } catch {
    console.log(
      `  ${YELLOW}⚠${RESET} nw alias: could not create symlink at ${nwPath} (permission denied?)`,
    );
    return false;
  }
}

/**
 * Symlink directories that should be gitignored in non-self-hosting projects.
 * These are created by `ninthwave init` and point to the local ninthwave installation.
 */
export const SYMLINK_GITIGNORE_DIRS = [
  ".claude/agents/",
  ".claude/skills/",
  ".opencode/agents/",
  ".github/agents/",
];

/**
 * Check if the project is the ninthwave repo itself (self-hosting mode).
 * In self-hosting mode, agent/skill directories contain source files, not symlinks.
 */
export function isSelfHosting(projectDir: string, bundleDir: string): boolean {
  return resolve(projectDir) === resolve(bundleDir);
}

const SKILLS = ["work", "decompose", "ninthwave-upgrade"];

// ── Agent configuration ──────────────────────────────────────────────

/** Agent source files available in the bundle's agents/ directory. */
export const AGENT_SOURCES = [
  "implementer.md",
  "reviewer.md",
  "verifier.md",
];

/** Human-readable descriptions for each agent file. */
export const AGENT_DESCRIPTIONS: Record<string, string> = {
  "implementer.md": "implementation agent for batch TODO processing",
  "reviewer.md": "PR code review agent",
  "verifier.md": "post-merge CI failure diagnosis and fix-forward agent",
};

/** AI tool target directories where agent symlinks are created -- derived from AI_TOOL_PROFILES. */
export const AGENT_TARGET_DIRS = AI_TOOL_PROFILES.map((p) => ({
  dir: p.targetDir,
  suffix: p.suffix,
  tool: p.displayName,
}));

/** Agent selection result: which agents to install and which tool directories to target. */
export interface AgentSelection {
  /** Agent source filenames to install (e.g., ["implementer.md", "reviewer.md"]) */
  agents: string[];
  /** Tool target directory indices into AGENT_TARGET_DIRS */
  toolDirs: { dir: string; suffix: string; tool: string }[];
}

// ── Tool detection ───────────────────────────────────────────────────

/**
 * Detect which AI tools are installed in the project directory.
 *
 * Checks each tool's projectIndicators (from AI_TOOL_PROFILES) against the
 * project directory. Any matching path triggers detection for that tool.
 *
 * Returns the matching AGENT_TARGET_DIRS entries.
 */
export function detectProjectTools(
  projectDir: string,
): { dir: string; suffix: string; tool: string }[] {
  const detected: { dir: string; suffix: string; tool: string }[] = [];

  for (const profile of AI_TOOL_PROFILES) {
    const matched = profile.projectIndicators.some((indicator) =>
      existsSync(join(projectDir, indicator)),
    );
    if (matched) {
      detected.push({ dir: profile.targetDir, suffix: profile.suffix, tool: profile.displayName });
    }
  }

  return detected;
}

/**
 * Discover available agent source files in the bundle's agents/ directory.
 * Only returns agents that actually exist on disk.
 */
export function discoverAgentSources(bundleDir: string): string[] {
  return AGENT_SOURCES.filter((f) =>
    existsSync(join(bundleDir, "agents", f)),
  );
}

// ── Symlink plan ─────────────────────────────────────────────────────

/** A single planned symlink operation. */
export interface SymlinkPlan {
  /** Relative path from project root (e.g., ".claude/agents/ninthwave-implementer.md") */
  displayPath: string;
  /** Absolute path where the symlink will be created */
  linkPath: string;
  /** Relative target the symlink will point to */
  relTarget: string;
  /** Status: "create", "exists" (already correct), "replace" (regular file exists) */
  status: "create" | "exists" | "replace";
}

/**
 * Build a plan of symlink operations for the given agent selection.
 *
 * Does not create any files -- just computes what would happen.
 */
export function buildSymlinkPlan(
  projectDir: string,
  bundleDir: string,
  selection: AgentSelection,
): SymlinkPlan[] {
  const plan: SymlinkPlan[] = [];

  for (const agentFile of selection.agents) {
    const agentSource = join(bundleDir, "agents", agentFile);
    if (!existsSync(agentSource)) continue;
    const baseName = agentFile.replace(/\.md$/, "");

    for (const target of selection.toolDirs) {
      const targetDir = join(projectDir, target.dir);
      const filename =
        target.suffix === ".agent.md"
          ? `ninthwave-${baseName}.agent.md`
          : agentFile;
      const linkPath = join(targetDir, filename);
      const relTarget = relative(targetDir, agentSource);
      const displayPath = `${target.dir}/${filename}`;

      let status: SymlinkPlan["status"] = "create";

      if (existsSync(linkPath)) {
        try {
          const stat = lstatSync(linkPath);
          if (stat.isSymbolicLink()) {
            const currentTarget = readlinkSync(linkPath);
            status = currentTarget === relTarget ? "exists" : "create";
          } else {
            // Regular file where a symlink should be
            status = "replace";
          }
        } catch {
          status = "create";
        }
      }

      plan.push({ displayPath, linkPath, relTarget, status });
    }
  }

  return plan;
}

/**
 * Execute a symlink plan -- create the actual symlinks.
 */
export function executeSymlinkPlan(plan: SymlinkPlan[]): void {
  for (const entry of plan) {
    if (entry.status === "exists") {
      console.log(`  ${DIM}${entry.displayPath} (already set up)${RESET}`);
      continue;
    }

    // Ensure parent directory exists
    const parentDir = dirname(entry.linkPath);
    mkdirSync(parentDir, { recursive: true });

    // Remove existing file/symlink if present
    if (existsSync(entry.linkPath) || lstatExists(entry.linkPath)) {
      unlinkSync(entry.linkPath);
    }

    symlinkSync(entry.relTarget, entry.linkPath);

    if (entry.status === "replace") {
      console.log(
        `  ${YELLOW}↻${RESET} ${entry.displayPath} -> ${entry.relTarget} ${DIM}(replaced regular file)${RESET}`,
      );
    } else {
      console.log(`  ${GREEN}✓${RESET} ${entry.displayPath} -> ${entry.relTarget}`);
    }
  }
}

/** Check if a path exists as a symlink (including broken symlinks). */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create skill symlinks in the given skills directory, pointing to bundleDir/skills/<name>.
 */
export function createSkillSymlinks(
  skillsDir: string,
  bundleDir: string,
): void {
  mkdirSync(skillsDir, { recursive: true });

  // Always compute relative paths so symlinks survive directory moves/renames
  const linkTarget = (skill: string): string => {
    const absTarget = join(bundleDir, "skills", skill);
    return relative(skillsDir, absTarget);
  };

  for (const skill of SKILLS) {
    const skillSource = join(bundleDir, "skills", skill);
    if (!existsSync(skillSource)) continue;

    const linkPath = join(skillsDir, skill);
    // Remove existing symlink if present
    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
    }
    symlinkSync(linkTarget(skill), linkPath);
    console.log(`  ${skill} -> ${linkTarget(skill)}`);
  }
}

/**
 * Global setup: seed ~/.claude/skills/ symlinks only.
 */
export function setupGlobal(bundleDir: string): void {
  const home = process.env.HOME;
  if (!home) die("HOME environment variable not set");

  const skillsDir = join(home!, "/.claude/skills");
  console.log("Setting up global skill symlinks...");
  console.log(`Bundle: ${bundleDir}`);
  console.log();

  console.log("Skills (~/.claude/skills/)...");
  createSkillSymlinks(skillsDir, bundleDir);

  console.log();
  console.log("Done! Global skills are available in all projects.");
}


// ── Interactive agent selection ──────────────────────────────────────

/**
 * Run the interactive agent selection flow:
 * 1. Detect installed AI tools
 * 2. Present checkbox for agent selection
 * 3. Show preview of symlinks to create
 * 4. Ask for confirmation
 *
 * Returns the agent selection, or null if the user cancels.
 */
export async function interactiveAgentSelection(
  projectDir: string,
  bundleDir: string,
  deps?: {
    checkboxPrompt?: CheckboxPromptFn;
    confirmPrompt?: ConfirmPromptFn;
  },
): Promise<AgentSelection | null> {
  const checkbox = deps?.checkboxPrompt ?? defaultCheckboxPrompt;
  const confirm = deps?.confirmPrompt ?? defaultConfirmPrompt;

  // Step 1: Detect AI tools
  const detectedTools = detectProjectTools(projectDir);
  // Fall back to all tools if none detected (fresh project)
  const toolDirs =
    detectedTools.length > 0 ? detectedTools : [...AGENT_TARGET_DIRS];

  const toolNames = toolDirs.map((t) => t.tool);
  if (detectedTools.length > 0) {
    console.log(
      `Detected AI tools: ${BOLD}${toolNames.join(", ")}${RESET}`,
    );
  } else {
    console.log(
      `${DIM}No AI tool directories detected -- will install to all tool directories.${RESET}`,
    );
  }
  console.log();

  // Step 2: Agent selection checkbox
  const availableAgents = discoverAgentSources(bundleDir);
  if (availableAgents.length === 0) {
    console.log(`${YELLOW}No agent files found in bundle.${RESET}`);
    return null;
  }

  const choices: CheckboxChoice[] = availableAgents.map((agent) => ({
    value: agent,
    label: agent.replace(/\.md$/, ""),
    description: AGENT_DESCRIPTIONS[agent] ?? "",
    checked: true, // All pre-selected by default
  }));

  const selectedAgents = await checkbox(
    "Which agent files should be set up?",
    choices,
  );

  if (selectedAgents.length === 0) {
    console.log(`${DIM}No agents selected -- skipping agent setup.${RESET}`);
    return { agents: [], toolDirs };
  }

  console.log();

  // Step 3: Show preview
  const selection: AgentSelection = { agents: selectedAgents, toolDirs };
  const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

  const toCreate = plan.filter((p) => p.status === "create");
  const toReplace = plan.filter((p) => p.status === "replace");
  const existing = plan.filter((p) => p.status === "exists");

  if (toCreate.length > 0 || toReplace.length > 0) {
    console.log("Will create:");
    for (const entry of toCreate) {
      console.log(`  ${GREEN}+${RESET} ${entry.displayPath} -> ${entry.relTarget}`);
    }
    for (const entry of toReplace) {
      console.log(
        `  ${YELLOW}↻${RESET} ${entry.displayPath} -> ${entry.relTarget} ${DIM}(replaces regular file)${RESET}`,
      );
    }
  }

  if (existing.length > 0) {
    console.log(`${DIM}Already set up: ${existing.map((e) => e.displayPath).join(", ")}${RESET}`);
  }

  if (toCreate.length === 0 && toReplace.length === 0) {
    console.log(`${GREEN}All selected agents are already set up.${RESET}`);
    return selection;
  }

  console.log();

  // Step 4: Confirm
  const proceed = await confirm("Proceed?", true);
  if (!proceed) {
    console.log(`${DIM}Cancelled -- no agent files created.${RESET}`);
    return null;
  }

  return selection;
}

