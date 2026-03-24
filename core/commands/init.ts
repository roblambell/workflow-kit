// `ninthwave init` — zero-input project initialization with auto-detection.
//
// Detects: (1) repo structure (monorepo vs single), (2) CI system (GitHub Actions),
// (3) multiplexer (cmux, tmux), (4) AI tool config (.claude/, .opencode/, copilot).
// Writes .ninthwave/config with detected settings, runs setup scaffolding,
// and prints a summary.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { getBundleDir } from "../paths.ts";
import { info, GREEN, BOLD, DIM, RESET, YELLOW, RED } from "../output.ts";
import { run } from "../shell.ts";
import {
  createSkillSymlinks,
  generateShimContent,
  type CommandChecker,
} from "./setup.ts";

// --- Detection types ---

export interface DetectionResult {
  /** Detected CI system, e.g. "github-actions" */
  ci: string | null;
  /** Detected test command, e.g. "bun test" */
  testCommand: string | null;
  /** Detected multiplexer */
  mux: "cmux" | "tmux" | null;
  /** Detected AI tool configurations */
  aiTools: string[];
  /** Repo structure type */
  repoType: "monorepo" | "single";
}

/**
 * Dependency injection for init — all external I/O is injectable for testing.
 */
export interface InitDeps {
  commandExists?: CommandChecker;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
  readDir?: (dir: string) => string[];
  getEnv?: (key: string) => string | undefined;
}

const defaultFileExists = (path: string): boolean => existsSync(path);

const defaultReadDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const defaultCommandExists: CommandChecker = (cmd: string): boolean => {
  const result = run("which", [cmd]);
  return result.exitCode === 0;
};

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};

const defaultGetEnv = (key: string): string | undefined => process.env[key];

// --- Detection functions ---

/**
 * Detect CI system by looking for workflow files.
 */
export function detectCI(
  projectDir: string,
  deps: InitDeps = {},
): string | null {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const readDir = deps.readDir ?? defaultReadDir;

  const workflowsDir = join(projectDir, ".github", "workflows");
  if (!fileExists(workflowsDir)) return null;

  const files = readDir(workflowsDir);
  const hasWorkflows = files.some(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  return hasWorkflows ? "github-actions" : null;
}

/**
 * Detect the project's test command from package.json scripts.
 * Checks scripts in priority order: test, check, lint.
 * Returns the script value (e.g., "bun test", "vitest") or null.
 */
export function detectTestCommand(
  projectDir: string,
  deps: InitDeps = {},
): string | null {
  const rf = deps.readFile ?? defaultReadFile;

  const content = rf(join(projectDir, "package.json"));
  if (!content) return null;

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(content);
  } catch {
    return null;
  }

  if (!pkg.scripts) return null;

  // Priority order: test > check > lint
  for (const key of ["test", "check", "lint"]) {
    const script = pkg.scripts[key];
    if (script) return script;
  }

  return null;
}

/**
 * Detect available terminal multiplexer.
 * Priority: cmux binary > tmux binary > TMUX env var (indicates tmux session).
 */
export function detectMux(deps: InitDeps = {}): "cmux" | "tmux" | null {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const getEnv = deps.getEnv ?? defaultGetEnv;

  if (commandExists("cmux")) return "cmux";
  if (commandExists("tmux")) return "tmux";
  if (getEnv("TMUX")) return "tmux";

  return null;
}

/**
 * Detect existing AI tool configurations in the project.
 */
export function detectAITools(
  projectDir: string,
  deps: InitDeps = {},
): string[] {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const tools: string[] = [];

  if (fileExists(join(projectDir, ".claude"))) {
    tools.push("claude");
  }
  if (fileExists(join(projectDir, ".opencode"))) {
    tools.push("opencode");
  }
  if (fileExists(join(projectDir, ".github", "copilot-instructions.md"))) {
    tools.push("copilot");
  }

  return tools;
}

/**
 * Detect repo structure — monorepo if package.json has workspaces,
 * or if there are multiple package.json files in top-level directories.
 */
export function detectRepoType(
  projectDir: string,
  deps: InitDeps = {},
): "monorepo" | "single" {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const readDir = deps.readDir ?? defaultReadDir;

  // Check for workspaces in root package.json
  const pkgPath = join(projectDir, "package.json");
  if (fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.workspaces) return "monorepo";
    } catch {
      // Invalid JSON — ignore
    }
  }

  // Check for pnpm-workspace.yaml
  if (fileExists(join(projectDir, "pnpm-workspace.yaml"))) return "monorepo";

  // Check for multiple package.json in subdirectories
  const entries = readDir(projectDir);
  let subPackageCount = 0;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (fileExists(join(projectDir, entry, "package.json"))) {
      subPackageCount++;
      if (subPackageCount >= 2) return "monorepo";
    }
  }

  return "single";
}

/**
 * Run all detections and return the combined result.
 */
export function detectAll(
  projectDir: string,
  deps: InitDeps = {},
): DetectionResult {
  return {
    ci: detectCI(projectDir, deps),
    testCommand: detectTestCommand(projectDir, deps),
    mux: detectMux(deps),
    aiTools: detectAITools(projectDir, deps),
    repoType: detectRepoType(projectDir, deps),
  };
}

// --- Config generation ---

/**
 * Generate .ninthwave/config content with detected settings.
 */
export function generateConfig(detection: DetectionResult): string {
  const lines: string[] = [
    "# ninthwave project configuration",
    "# Auto-detected by `ninthwave init`",
    "",
  ];

  // CI provider
  if (detection.ci) {
    lines.push(`ci_provider=${detection.ci}`);
  } else {
    lines.push("# ci_provider=github-actions");
  }

  // Test command
  if (detection.testCommand) {
    lines.push(`test_command=${detection.testCommand}`);
  } else {
    lines.push("# test_command=bun test");
  }

  // Mux
  if (detection.mux) {
    lines.push(`MUX=${detection.mux}`);
  } else {
    lines.push("# MUX=cmux");
  }

  // Repo type
  lines.push(`REPO_TYPE=${detection.repoType}`);

  // AI tools
  if (detection.aiTools.length > 0) {
    lines.push(`AI_TOOLS=${detection.aiTools.join(",")}`);
  } else {
    lines.push("# AI_TOOLS=claude,opencode,copilot");
  }

  lines.push("");
  lines.push(
    "# File extensions for LOC counting in version-bump (space-separated glob patterns)",
  );
  lines.push('# LOC_EXTENSIONS="*.ts *.tsx *.js *.jsx *.py *.go"');
  lines.push("");

  return lines.join("\n") + "\n";
}

// --- Summary printing ---

/**
 * Print a human-readable summary of what was detected and configured.
 */
export function printSummary(detection: DetectionResult): void {
  console.log(`${BOLD}Detected:${RESET}`);

  // CI
  if (detection.ci) {
    console.log(
      `  ${GREEN}✓${RESET} CI: ${detection.ci}`,
    );
  } else {
    console.log(
      `  ${DIM}–${RESET} CI: ${DIM}none detected${RESET}`,
    );
  }

  // Test command
  if (detection.testCommand) {
    console.log(
      `  ${GREEN}✓${RESET} Test command: ${detection.testCommand}`,
    );
  } else {
    console.log(
      `  ${DIM}–${RESET} Test command: ${DIM}none detected${RESET}`,
    );
  }

  // Multiplexer
  if (detection.mux) {
    console.log(
      `  ${GREEN}✓${RESET} Multiplexer: ${detection.mux}`,
    );
  } else {
    console.log(
      `  ${YELLOW}!${RESET} Multiplexer: none detected ${DIM}(install cmux or tmux for parallel sessions)${RESET}`,
    );
  }

  // Repo type
  console.log(
    `  ${GREEN}✓${RESET} Repo type: ${detection.repoType}`,
  );

  // AI tools
  if (detection.aiTools.length > 0) {
    console.log(
      `  ${GREEN}✓${RESET} AI tools: ${detection.aiTools.join(", ")}`,
    );
  } else {
    console.log(
      `  ${DIM}–${RESET} AI tools: ${DIM}none detected${RESET}`,
    );
  }

  console.log();
}

// --- Scaffolding (reuses setup logic) ---

const AGENT_TARGETS = [
  { dir: ".claude/agents", filename: "todo-worker.md" },
  { dir: ".opencode/agents", filename: "todo-worker.md" },
  { dir: ".github/agents", filename: "todo-worker.agent.md" },
];

/**
 * Run the scaffolding portion of setup — creates all project files.
 * Unlike setupProject, this never aborts on missing prerequisites.
 */
function scaffold(projectDir: string, bundleDir: string): void {
  // --- .ninthwave/ directory ---
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

  // Clean up legacy files
  const oldShim = join(projectDir, ".ninthwave/nw");
  if (existsSync(oldShim)) unlinkSync(oldShim);
  const legacyDir = join(projectDir, ".ninthwave/dir");
  if (existsSync(legacyDir)) unlinkSync(legacyDir);

  // Create CLI shim
  const shimPath = join(projectDir, ".ninthwave/work");
  writeFileSync(shimPath, generateShimContent());
  chmodSync(shimPath, 0o755);

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
  }

  // --- TODOS.md ---
  const todosPath = join(projectDir, "TODOS.md");
  if (!existsSync(todosPath)) {
    writeFileSync(
      todosPath,
      `# TODOS

<!-- Format guide: https://github.com/ninthwave-sh/ninthwave/blob/main/core/docs/todos-format.md -->
`,
    );
  }

  // --- Skill symlinks ---
  const skillsDir = join(projectDir, ".claude/skills");
  createSkillSymlinks(skillsDir, bundleDir);

  // --- Agent files ---
  const agentSource = join(bundleDir, "agents", "todo-worker.md");
  if (existsSync(agentSource)) {
    for (const target of AGENT_TARGETS) {
      const targetDir = join(projectDir, target.dir);
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(agentSource, join(targetDir, target.filename));
    }
  }

  // --- .gitignore ---
  const gitignorePath = join(projectDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".worktrees/")) {
      writeFileSync(
        gitignorePath,
        content + "\n# ninthwave worktrees\n.worktrees/\n",
      );
    }
  } else {
    writeFileSync(gitignorePath, "# ninthwave worktrees\n.worktrees/\n");
  }

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
}

// --- Main init command ---

/**
 * Run `ninthwave init` — auto-detect project environment and set up ninthwave.
 *
 * Pure auto-detection: never prompts, never aborts on missing tools.
 * Writes .ninthwave/config with detected settings, runs scaffolding, prints summary.
 */
export function initProject(
  projectDir: string,
  bundleDir: string,
  deps?: InitDeps,
): DetectionResult {
  console.log(`Initializing ninthwave in: ${projectDir}`);
  console.log();

  // 1. Auto-detect environment
  console.log("Detecting project environment...");
  const detection = detectAll(projectDir, deps);
  console.log();

  // 2. Print detection summary
  printSummary(detection);

  // 3. Write config with detected values (always overwrite — init is authoritative)
  const configPath = join(projectDir, ".ninthwave/config");
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
  writeFileSync(configPath, generateConfig(detection));
  console.log("Configured:");
  console.log(`  .ninthwave/config ${DIM}(auto-detected settings)${RESET}`);

  // 4. Run scaffolding
  scaffold(projectDir, bundleDir);
  console.log(`  .ninthwave/work ${DIM}(CLI shim)${RESET}`);
  console.log(`  .ninthwave/domains.conf`);
  console.log(`  TODOS.md`);
  console.log(`  .claude/skills/ ${DIM}(symlinks)${RESET}`);
  console.log(`  Agent files ${DIM}(.claude, .opencode, .github)${RESET}`);
  console.log(`  .gitignore`);
  console.log();

  // 5. Done
  console.log(`${GREEN}Done!${RESET} ninthwave is ready.`);
  console.log();
  console.log("Next steps:");
  console.log("  1. git add -A && git commit -m 'chore: init ninthwave'");
  console.log("  2. Add work items to TODOS.md");
  console.log("  3. Run: ninthwave list");
  console.log();

  return detection;
}

/**
 * CLI entry point for `ninthwave init`.
 */
export function cmdInit(): void {
  // Resolve project root via git
  const result = run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) {
    console.error(`${RED}Error:${RESET} Not inside a git repository`);
    process.exit(1);
  }
  const projectDir = result.stdout.replace(/\/.git$/, "");
  const bundleDir = getBundleDir();

  initProject(projectDir, bundleDir);
}
