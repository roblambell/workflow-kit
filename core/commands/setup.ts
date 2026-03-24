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
import { info, die } from "../output.ts";
import { run } from "../shell.ts";

const SKILLS = ["work", "decompose", "todo-preview", "ninthwave-upgrade"];

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

  // Determine if we can use relative paths
  const linkTarget = (skill: string): string => {
    const absTarget = join(bundleDir, "skills", skill);
    // Try to make a relative link
    const rel = relative(skillsDir, absTarget);
    // If relative path doesn't go too far up, use it
    return rel.startsWith("../../../") ? absTarget : rel;
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
 * Project setup: seed .ninthwave/, TODOS.md, skill symlinks, agent copies, .gitignore.
 */
export function setupProject(projectDir: string, bundleDir: string): void {
  console.log(`Setting up ninthwave in: ${projectDir}`);
  console.log(`Bundle location: ${bundleDir}`);
  console.log();

  // --- .ninthwave/ config ---
  console.log("Config (.ninthwave/)...");
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

  // Record the bundle location
  writeFileSync(join(projectDir, ".ninthwave/dir"), bundleDir + "\n");
  console.log("  .ninthwave/dir");

  // Create the CLI shim
  // Clean up old shim name
  const oldShim = join(projectDir, ".ninthwave/nw");
  if (existsSync(oldShim)) unlinkSync(oldShim);

  const shimPath = join(projectDir, ".ninthwave/work");
  writeFileSync(
    shimPath,
    '#!/usr/bin/env bash\nexec bun run "$(cat "$(dirname "$0")/dir")/core/cli.ts" "$@"\n',
  );
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

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->
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
