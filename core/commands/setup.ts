// Setup utilities -- shared functions for project initialization.
//
// Provides: prerequisite checking, managed skill/agent copy setup,
// interactive agent selection, nw symlink creation, and global setup.
//
// Used by `core/commands/init.ts` for the unified `ninthwave init` command.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  cpSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  lstatSync,
} from "fs";
import { join, relative, dirname, resolve } from "path";
import { getBundleDir } from "../paths.ts";
import { info, die, warn, RED, YELLOW, GREEN, RESET, BOLD, DIM } from "../output.ts";
import { run } from "../shell.ts";
import { resolveCmuxBinary } from "../cmux-resolve.ts";
import {
  checkboxPrompt as defaultCheckboxPrompt,
  confirmPrompt as defaultConfirmPrompt,
} from "../prompt.ts";
import type { CheckboxChoice, CheckboxPromptFn, ConfirmPromptFn } from "../prompt.ts";
import { AI_TOOL_PROFILES, agentTargetFilename, renderAgentArtifact } from "../ai-tools.ts";

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
  /** names of missing required prerequisites */
  missing: string[];
  /** warnings and optional upgrade suggestions */
  warnings: string[];
  /** detected multiplexer: "cmux", "tmux", or null if neither found */
  detectedMux: "cmux" | "tmux" | null;
}

/** Injectable cmux binary resolver (defaults to resolveCmuxBinary). */
export type CmuxResolver = () => string | null;

/**
 * Check for required prerequisites and print actionable messages.
 *
 * Returns a result object describing what's missing/warning.
 * Callers decide whether to abort.
 */
export function checkPrerequisites(
  commandExists: CommandChecker = defaultCommandExists,
  ghAuthCheck: AuthChecker = defaultGhAuthCheck,
  cmuxResolver: CmuxResolver = resolveCmuxBinary,
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

  // Detect optional interactive backend (headless always works)
  let detectedMux: "cmux" | "tmux" | null = null;
  const hasCmux = cmuxResolver() !== null;
  const hasTmux = commandExists("tmux");

  if (hasCmux) {
    detectedMux = "cmux";
    console.log(`  ${GREEN}✓${RESET} cmux ${DIM}(multiplexer -- visual macOS sidebar)${RESET}`);
  }
  if (hasTmux) {
    if (detectedMux === null) detectedMux = "tmux";
    console.log(`  ${GREEN}✓${RESET} tmux ${DIM}(multiplexer -- battle-hardened terminal sessions)${RESET}`);
  }
  if (!hasCmux && !hasTmux) {
    console.log(`  ${YELLOW}⚠${RESET} interactive backend ${DIM}(headless works by default; tmux/cmux are optional upgrades)${RESET}`);
    console.log(`    Optional install (cmux): ${BOLD}brew install --cask manaflow-ai/cmux/cmux${RESET}`);
    console.log(`    Optional install (tmux): ${BOLD}brew install tmux${RESET}`);
    warnings.push(
      "No interactive backend detected -- headless works by default; install tmux or cmux for interactive sessions",
    );
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
 * Check if the project is the ninthwave repo itself (self-hosting mode).
 * In self-hosting mode, agent/skill directories contain source files, not symlinks.
 */
export function isSelfHosting(projectDir: string, bundleDir: string): boolean {
  return resolve(projectDir) === resolve(bundleDir);
}

export interface CanonicalBundleSources {
  instructionFile: string | null;
  skills: string[];
  agents: string[];
}

function readSortedDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function discoverSkillSources(bundleDir: string): string[] {
  return readSortedDir(join(bundleDir, "skills")).filter((name) =>
    existsSync(join(bundleDir, "skills", name, "SKILL.md")),
  );
}

export function discoverAgentSources(bundleDir: string): string[] {
  return readSortedDir(join(bundleDir, "agents")).filter((name) =>
    name.endsWith(".md") && existsSync(join(bundleDir, "agents", name)),
  );
}

export function discoverCanonicalBundleSources(
  bundleDir: string,
): CanonicalBundleSources {
  return {
    instructionFile: existsSync(join(bundleDir, "CLAUDE.md")) ? "CLAUDE.md" : null,
    skills: discoverSkillSources(bundleDir),
    agents: discoverAgentSources(bundleDir),
  };
}

const DEFAULT_CANONICAL_BUNDLE_SOURCES: CanonicalBundleSources = (() => {
  try {
    return discoverCanonicalBundleSources(getBundleDir());
  } catch {
    return { instructionFile: null, skills: [], agents: [] };
  }
})();

export const INSTRUCTION_SOURCE = DEFAULT_CANONICAL_BUNDLE_SOURCES.instructionFile;
export const SKILL_SOURCES = DEFAULT_CANONICAL_BUNDLE_SOURCES.skills;

// ── Agent configuration ──────────────────────────────────────────────

/** Agent source files available in the bundle's agents/ directory. */
export const AGENT_SOURCES = DEFAULT_CANONICAL_BUNDLE_SOURCES.agents;

/** Human-readable descriptions for each agent file. */
export const AGENT_DESCRIPTIONS: Record<string, string> = {
  "implementer.md": "implementation agent for batch work item processing",
  "reviewer.md": "PR code review agent",
  "forward-fixer.md": "post-merge CI failure diagnosis and fix-forward agent",
  "rebaser.md": "branch rebase agent for stacked and drifted PRs",
};

/** AI tool target directories where managed agent files are written. */
export const AGENT_TARGET_DIRS = AI_TOOL_PROFILES.map((p) => ({
  dir: p.targetDir,
  suffix: p.suffix,
  tool: p.displayName,
}));

export const MANAGED_SKILLS_DIR = ".claude/skills";

/** Agent selection result: which agents to install and which tool directories to target. */
export interface AgentSelection {
  /** Agent source filenames to install (e.g., ["implementer.md", "reviewer.md"]) */
  agents: string[];
  /** Tool target directory indices into AGENT_TARGET_DIRS */
  toolDirs: { dir: string; suffix: string; tool: string }[];
  /** Actionable managed-copy preview entries selected during interactive init. */
  installDisplayPaths?: string[];
  /** Backwards-compatible alias for older callers; prefer installDisplayPaths. */
  selectedDisplayPaths?: string[];
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

// ── Copy plan ────────────────────────────────────────────────────────

/** A single planned agent file copy operation. */
export interface CopyPlan {
  /** Relative path from project root (e.g., ".claude/agents/implementer.md") */
  displayPath: string;
  /** Absolute destination path where the file will be written */
  linkPath: string;
  /** Fully rendered file content to write at the destination */
  content: string;
  /** Status of the managed copy destination. */
  status: ManagedCopyStatus;
}

export type ManagedCopyStatus = "create" | "refresh" | "replace" | "up-to-date";

export function detectManagedCopyStatus(
  destPath: string,
  sourceContent: string,
): ManagedCopyStatus {
  if (!lstatExists(destPath)) return "create";

  try {
    const stat = lstatSync(destPath);
    if (stat.isSymbolicLink()) return "replace";
    return readFileSync(destPath, "utf-8") === sourceContent ? "up-to-date" : "refresh";
  } catch {
    return "refresh";
  }
}

export function writeManagedCopy(destPath: string, sourceContent: string): ManagedCopyStatus {
  const status = detectManagedCopyStatus(destPath, sourceContent);
  if (status === "up-to-date") return status;

  mkdirSync(dirname(destPath), { recursive: true });
  if (lstatExists(destPath)) {
    rmSync(destPath, { recursive: true, force: true });
  }
  writeFileSync(destPath, sourceContent);
  return status;
}

/**
 * Build a plan of copy operations for the given agent selection.
 *
 * Does not create any files -- just computes what would happen.
 *
 * Status semantics:
 *   "create"     -- no file at destination, will create managed copy
 *   "refresh"    -- managed copy exists but content is stale, will overwrite
 *   "replace"    -- legacy symlink at destination, will replace with real file
 *   "up-to-date" -- managed copy already matches the canonical source
 */
export function buildCopyPlan(
  projectDir: string,
  bundleDir: string,
  selection: AgentSelection,
): CopyPlan[] {
  const plan: CopyPlan[] = [];

  for (const agentFile of selection.agents) {
    const agentSource = join(bundleDir, "agents", agentFile);
    if (!existsSync(agentSource)) continue;

    for (const target of selection.toolDirs) {
      const targetDir = join(projectDir, target.dir);
      const rendered = renderAgentArtifact(agentFile, readFileSync(agentSource, "utf-8"), target);
      const filename = rendered.filename;
      const linkPath = join(targetDir, filename);
      const displayPath = `${target.dir}/${filename}`;
      const status = detectManagedCopyStatus(linkPath, rendered.content);

      plan.push({ displayPath, linkPath, content: rendered.content, status });
    }
  }

  return plan;
}

/**
 * Filter a copy plan to the actionable entries selected during interactive init.
 *
 * Up-to-date entries are always preserved because they are informational and
 * execute as no-ops. Pruning still uses the coarse tool/agent selection.
 */
export function filterCopyPlan(
  plan: CopyPlan[],
  selection: AgentSelection,
): CopyPlan[] {
  const installDisplayPaths =
    selection.installDisplayPaths ?? selection.selectedDisplayPaths;
  if (!installDisplayPaths) return plan;

  const selectedDisplayPaths = new Set(installDisplayPaths);
  return plan.filter((entry) =>
    entry.status === "up-to-date" || selectedDisplayPaths.has(entry.displayPath)
  );
}

/**
 * Execute a copy plan -- write agent files into the project.
 */
export function executeCopyPlan(plan: CopyPlan[]): void {
  for (const entry of plan) {
    if (entry.status === "up-to-date") {
      console.log(`  ${DIM}${entry.displayPath} (up to date)${RESET}`);
      continue;
    }

    const status = writeManagedCopy(entry.linkPath, entry.content);

    if (status === "replace") {
      console.log(
        `  ${YELLOW}↻${RESET} ${entry.displayPath} ${DIM}(replaced symlink)${RESET}`,
      );
    } else if (status === "refresh") {
      console.log(
        `  ${YELLOW}↻${RESET} ${entry.displayPath} ${DIM}(refreshed managed copy)${RESET}`,
      );
    } else {
      console.log(`  ${GREEN}✓${RESET} ${entry.displayPath}`);
    }
  }
}

/** Check if a path exists as a symlink (including broken symlinks). */
export function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeManagedEntry(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function buildOwnedEntryPredicates(
  bundleDir: string,
  selection: AgentSelection,
): Map<string, (entry: string) => boolean> {
  const predicates = new Map<string, (entry: string) => boolean>();
  const skillNames = new Set(discoverSkillSources(bundleDir));
  if (skillNames.size > 0) {
    predicates.set(MANAGED_SKILLS_DIR, (entry) => skillNames.has(entry));
  }

  const canonicalAgents = discoverAgentSources(bundleDir);
  for (const toolDir of selection.toolDirs) {
    const ownedEntries = new Set(canonicalAgents.map((agent) => agentTargetFilename(agent, toolDir)));
    if (toolDir.suffix === ".toml" || toolDir.suffix === ".agent.md") {
      predicates.set(toolDir.dir, (entry) =>
        ownedEntries.has(entry) || (entry.startsWith("ninthwave-") && entry.endsWith(toolDir.suffix))
      );
      continue;
    }

    predicates.set(toolDir.dir, (entry) => ownedEntries.has(entry));
  }

  return predicates;
}

/**
 * Prune orphaned generated outputs within narrowly owned target paths.
 *
 * Cleanup only removes entries ninthwave can clearly identify as its own managed
 * outputs. User instruction files and unrelated user-created files are preserved.
 */
export function pruneManagedGeneratedEntries(
  projectDir: string,
  bundleDir: string,
  selection: AgentSelection,
): string[] {
  const expected = new Set<string>();
  for (const skill of discoverSkillSources(bundleDir)) {
    expected.add(`${MANAGED_SKILLS_DIR}/${skill}`);
  }
  for (const entry of buildCopyPlan(projectDir, bundleDir, selection)) {
    expected.add(entry.displayPath);
  }

  const removed: string[] = [];
  const ownedEntryPredicates = buildOwnedEntryPredicates(bundleDir, selection);

  for (const [root, ownsEntry] of ownedEntryPredicates) {
    const absRoot = join(projectDir, root);
    if (!lstatExists(absRoot)) continue;

    let stat;
    try {
      stat = lstatSync(absRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const entry of readSortedDir(absRoot)) {
      if (!ownsEntry(entry)) continue;

      const displayPath = `${root}/${entry}`;
      if (expected.has(displayPath)) continue;

      removeManagedEntry(join(absRoot, entry));
      removed.push(displayPath);
    }
  }

  return removed;
}

/**
 * Create skill symlinks in the given skills directory, pointing to bundleDir/skills/<name>.
 */
export function createSkillSymlinks(
  skillsDir: string,
  bundleDir: string,
): void {
  mkdirSync(skillsDir, { recursive: true });
  const skills = discoverSkillSources(bundleDir);

  // Always compute relative paths so symlinks survive directory moves/renames
  const linkTarget = (skill: string): string => {
    const absTarget = join(bundleDir, "skills", skill);
    return relative(skillsDir, absTarget);
  };

  for (const skill of skills) {
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
 * Copy skill directories into the project's skills directory.
 *
 * Used during `nw init` for project-level skill installation. Creates real
 * copies inside the repo so the files are portable across machines without
 * requiring ninthwave to be installed at the same path.
 *
 * Unlike createSkillSymlinks (used for global ~/.claude/skills/), this
 * function never creates symlinks pointing outside the project.
 */
export function copySkillFiles(
  skillsDir: string,
  bundleDir: string,
): void {
  mkdirSync(skillsDir, { recursive: true });
  const skills = discoverSkillSources(bundleDir);

  for (const skill of skills) {
    const skillSource = join(bundleDir, "skills", skill);
    if (!existsSync(skillSource)) continue;

    const destPath = join(skillsDir, skill);

    // Remove existing symlink or directory before copying
    if (lstatExists(destPath)) {
      const stat = lstatSync(destPath);
      if (stat.isSymbolicLink()) {
        unlinkSync(destPath);
      } else if (stat.isDirectory()) {
        rmSync(destPath, { recursive: true });
      }
    }

    cpSync(skillSource, destPath, { recursive: true });
    console.log(`  ${GREEN}✓${RESET} ${skill}`);
  }
}

/**
 * Global setup: seed ~/.claude/skills/ managed copies.
 */
export function setupGlobal(bundleDir: string): void {
  const home = process.env.HOME;
  if (!home) die("HOME environment variable not set");

  const skillsDir = join(home!, "/.claude/skills");
  console.log("Setting up global skill copies...");
  console.log(`Bundle: ${bundleDir}`);
  console.log();

  console.log("Skills (~/.claude/skills/)...");
  copySkillFiles(skillsDir, bundleDir);

  console.log();
  console.log("Done! Global skills are available in all projects.");
}


// ── Interactive agent selection ──────────────────────────────────────

/**
 * Run the interactive agent selection flow:
 * 1. Detect installed AI tools
 * 2. Present checkbox for agent selection
 * 3. Present actionable managed-file preview entries as a checkbox list
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

  // Step 1: Detect AI tools and ask which to install into
  const detectedTools = detectProjectTools(projectDir);
  const allToolDirs = [...AGENT_TARGET_DIRS];

  const toolDirChoices: CheckboxChoice[] = allToolDirs.map((t) => ({
    value: t.tool,
    label: t.tool,
    description: t.dir,
    // Pre-check detected tools; if none detected, check all (fall back to all)
    checked: detectedTools.length === 0 || detectedTools.some((d) => d.tool === t.tool),
  }));

  const selectedToolNames = await checkbox(
    "Which AI tools should agents be installed for?",
    toolDirChoices,
  );

  if (selectedToolNames.length === 0) {
    console.log(`${DIM}No AI tools selected -- skipping agent setup.${RESET}`);
    return { agents: [], toolDirs: [] };
  }

  const toolDirs = allToolDirs.filter((t) => selectedToolNames.includes(t.tool));
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
  const plan = buildCopyPlan(projectDir, bundleDir, selection);

  const toCreate = plan.filter((p) => p.status === "create");
  const toRefresh = plan.filter((p) => p.status === "refresh");
  const toReplace = plan.filter((p) => p.status === "replace");
  const upToDate = plan.filter((p) => p.status === "up-to-date");

  if (upToDate.length > 0) {
    console.log(`${DIM}Already up to date: ${upToDate.map((e) => e.displayPath).join(", ")}${RESET}`);
  }

  if (toCreate.length === 0 && toRefresh.length === 0 && toReplace.length === 0) {
    console.log(`${GREEN}All selected agents are already up to date.${RESET}`);
    return selection;
  }

  console.log();

  const actionableChoices: CheckboxChoice[] = [
    ...toCreate.map((entry) => ({
      value: entry.displayPath,
      label: entry.displayPath,
      description: "creates managed copy",
      checked: true,
    })),
    ...toRefresh.map((entry) => ({
      value: entry.displayPath,
      label: entry.displayPath,
      description: "refreshes managed copy",
      checked: true,
    })),
    ...toReplace.map((entry) => ({
      value: entry.displayPath,
      label: entry.displayPath,
      description: "replaces symlink",
      checked: true,
    })),
  ];

  const installDisplayPaths = await checkbox("Will install:", actionableChoices);
  if (installDisplayPaths.length === 0) {
    console.log(`${DIM}No install actions selected -- skipping agent writes.${RESET}`);
    return {
      ...selection,
      installDisplayPaths: [],
      selectedDisplayPaths: [],
    };
  }

  console.log();

  // Step 4: Confirm
  const proceed = await confirm("Proceed?", true);
  if (!proceed) {
    console.log(`${DIM}Cancelled -- no agent files created.${RESET}`);
    return null;
  }

  return {
    ...selection,
    installDisplayPaths,
    selectedDisplayPaths: installDisplayPaths,
  };
}
