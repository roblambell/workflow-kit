// `ninthwave setup` — project and global setup command.
//
// Project mode (default): seeds .ninthwave/, TODOS.md, skill symlinks, agent copies, .gitignore
// Global mode (--global): seeds ~/.claude/skills/ symlinks only

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  copyFileSync,
  chmodSync,
} from "fs";
import { join, relative, dirname } from "path";
import { getBundleDir } from "../paths.ts";
import { info, die, warn, RED, YELLOW, GREEN, RESET, BOLD, DIM } from "../output.ts";
import { run } from "../shell.ts";

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
  /** detected multiplexer: "cmux", "tmux", or null if none found */
  detectedMux: "cmux" | "tmux" | null;
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

  // Detect multiplexer (cmux preferred, tmux as alternative)
  let detectedMux: "cmux" | "tmux" | null = null;
  if (commandExists("cmux")) {
    detectedMux = "cmux";
    console.log(`  ${GREEN}✓${RESET} cmux ${DIM}(multiplexer — visual sidebar, recommended)${RESET}`);
  } else if (commandExists("tmux")) {
    detectedMux = "tmux";
    console.log(`  ${GREEN}✓${RESET} tmux ${DIM}(multiplexer — headless sessions)${RESET}`);
    console.log(`    ${DIM}Tip: Install cmux for a visual sidebar: ${BOLD}brew install --cask manaflow-ai/cmux/cmux${RESET}`);
  } else {
    console.log(`  ${RED}✗${RESET} cmux or tmux ${DIM}(terminal multiplexer for parallel sessions)${RESET}`);
    console.log(`    Install cmux (recommended): ${BOLD}brew install --cask manaflow-ai/cmux/cmux${RESET}`);
    console.log(`    Or install tmux: ${BOLD}brew install tmux${RESET}`);
    missing.push("multiplexer (cmux or tmux)");
  }

  // If gh is present, check authentication
  if (!missing.includes("gh") && commandExists("gh")) {
    const auth = ghAuthCheck();
    if (!auth.authenticated) {
      console.log(`  ${YELLOW}⚠${RESET} gh is not authenticated`);
      console.log(`    Run: ${BOLD}gh auth login${RESET}`);
      warnings.push("gh is installed but not authenticated — run: gh auth login");
    }
  }

  console.log();

  if (missing.length > 0) {
    console.log(
      `${RED}Missing prerequisites:${RESET} ${missing.join(", ")}. Install them and re-run ${BOLD}ninthwave setup${RESET}.`,
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

const SKILLS = ["work", "decompose", "grind", "todo-preview", "ninthwave-upgrade"];

const AGENT_TARGETS = [
  { dir: ".claude/agents", filename: "todo-worker.md" },
  { dir: ".opencode/agents", filename: "todo-worker.md" },
  { dir: ".github/agents", filename: "todo-worker.agent.md" },
];

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

/**
 * Generate the content for the .ninthwave/work shim script.
 *
 * The shim auto-resolves the ninthwave binary without depending on .ninthwave/dir:
 * 1. If `ninthwave` is in PATH (e.g. brew install), use it directly.
 * 2. Dev-mode fallback: walk up from the shim's directory to find core/cli.ts.
 */
export function generateShimContent(): string {
  return `#!/usr/bin/env bash
# ninthwave CLI shim — auto-resolves the ninthwave binary.
# Priority: (1) ninthwave in PATH, (2) dev-mode walk-up to find core/cli.ts

# 1. If ninthwave is in PATH, use it directly
if command -v ninthwave &>/dev/null; then
  exec ninthwave "$@"
fi

# 2. Dev mode: walk up from this script to find a ninthwave checkout
dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
while [ "$dir" != "/" ]; do
  if [ -f "$dir/core/cli.ts" ]; then
    exec bun run "$dir/core/cli.ts" "$@"
  fi
  dir="$(dirname "$dir")"
done

echo "Error: ninthwave not found in PATH and no checkout found in parent directories." >&2
exit 1
`;
}

/**
 * Project setup: seed .ninthwave/, TODOS.md, skill symlinks, agent copies, .gitignore.
 *
 * Optional `deps` parameter allows injecting stubs for testing.
 */
export function setupProject(
  projectDir: string,
  bundleDir: string,
  deps?: {
    commandExists?: CommandChecker;
    ghAuthCheck?: AuthChecker;
  },
): void {
  console.log(`Setting up ninthwave in: ${projectDir}`);
  console.log(`Bundle location: ${bundleDir}`);
  console.log();

  // Check prerequisites before proceeding
  const prereqs = checkPrerequisites(deps?.commandExists, deps?.ghAuthCheck);
  if (!prereqs.allPresent) {
    die(`Missing required tools: ${prereqs.missing.join(", ")}`);
  }

  // --- .ninthwave/ config ---
  console.log("Config (.ninthwave/)...");
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

  // Create the CLI shim (auto-resolves ninthwave binary — no .ninthwave/dir needed)
  // Clean up old shim name
  const oldShim = join(projectDir, ".ninthwave/nw");
  if (existsSync(oldShim)) unlinkSync(oldShim);

  // Clean up legacy .ninthwave/dir if present
  const legacyDir = join(projectDir, ".ninthwave/dir");
  if (existsSync(legacyDir)) unlinkSync(legacyDir);

  const shimPath = join(projectDir, ".ninthwave/work");
  writeFileSync(shimPath, generateShimContent());
  chmodSync(shimPath, 0o755);
  console.log("  .ninthwave/work");

  // Config file (preserve existing)
  const configPath = join(projectDir, ".ninthwave/config");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `# ninthwave project configuration
# All settings are optional -- sensible defaults are used.

# File extensions for LOC counting in version-bump (space-separated glob patterns)
# LOC_EXTENSIONS="*.ts *.tsx *.js *.jsx *.py *.go"

# Path to domain mapping file (optional)
# DOMAINS_FILE=.ninthwave/domains.conf
`,
    );
    console.log("  .ninthwave/config (created)");
  } else {
    console.log("  .ninthwave/config (exists, skipped)");
  }

  // Domains config (preserve existing)
  const domainsPath = join(projectDir, ".ninthwave/domains.conf");
  if (!existsSync(domainsPath)) {
    writeFileSync(
      domainsPath,
      `# Domain mappings for ninthwave
# Format: pattern=domain_key
# Patterns are matched case-insensitively against section headers in TODOS.md.
# Lines starting with # are comments.
#
# Examples:
# auth=auth
# infrastructure=infra
# frontend=frontend
# database=db
`,
    );
    console.log("  .ninthwave/domains.conf (created)");
  } else {
    console.log("  .ninthwave/domains.conf (exists, skipped)");
  }

  console.log();

  // --- TODOS.md ---
  const todosPath = join(projectDir, "TODOS.md");
  if (!existsSync(todosPath)) {
    writeFileSync(
      todosPath,
      `# TODOS

<!-- Format guide: https://github.com/ninthwave-sh/ninthwave/blob/main/core/docs/todos-format.md -->
`,
    );
    console.log("TODOS.md (created)");
  } else {
    console.log("TODOS.md (exists, skipped)");
  }

  console.log();

  // --- Skill discovery symlinks ---
  console.log("Skills...");
  const skillsDir = join(projectDir, ".claude/skills");
  createSkillSymlinks(skillsDir, bundleDir);

  console.log();

  // --- Agent files (copied, not symlinked — must be in tool-specific dirs) ---
  console.log("Agents...");
  const agentSource = join(bundleDir, "agents", "todo-worker.md");

  for (const target of AGENT_TARGETS) {
    const targetDir = join(projectDir, target.dir);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(agentSource, join(targetDir, target.filename));
    console.log(`  ${target.dir}/${target.filename}`);
  }

  console.log();

  // --- .gitignore ---
  const gitignorePath = join(projectDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".worktrees/")) {
      writeFileSync(
        gitignorePath,
        content + "\n# ninthwave worktrees\n.worktrees/\n",
      );
      console.log(".gitignore (added .worktrees/)");
    }
  } else {
    writeFileSync(gitignorePath, "# ninthwave worktrees\n.worktrees/\n");
    console.log(".gitignore (created)");
  }

  console.log();

  // --- Version tracking ---
  const versionResult = run("git", [
    "-C",
    bundleDir,
    "describe",
    "--tags",
    "--always",
  ]);
  const version =
    versionResult.exitCode === 0 ? versionResult.stdout : "unknown";
  writeFileSync(join(projectDir, ".ninthwave/version"), version + "\n");

  // --- Summary ---
  console.log("Done! All files are project-level (commit to git).");
  console.log();
  console.log(`Multiplexer: ${BOLD}${prereqs.detectedMux}${RESET}${prereqs.detectedMux === "tmux" ? ` ${DIM}(install cmux for visual sidebar)${RESET}` : ""}`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Review: git diff");
  console.log("  2. Commit: git add -A && git commit -m 'chore: set up ninthwave'");
  console.log("  3. Add work items to TODOS.md and run /work");
}

/**
 * CLI entry point for `ninthwave setup`.
 */
export function cmdSetup(args: string[]): void {
  const isGlobal = args.includes("--global");
  const bundleDir = getBundleDir();

  if (isGlobal) {
    setupGlobal(bundleDir);
    return;
  }

  // Resolve project root via git
  const result = run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) {
    die("Not inside a git repository");
  }
  const projectDir = result.stdout.replace(/\/.git$/, "");

  setupProject(projectDir, bundleDir);
}
