// `ninthwave init` -- unified project initialization with auto-detection.
//
// Detects: (1) repo structure (monorepo vs single), (2) CI system (GitHub Actions),
// (3) multiplexer (cmux), (4) AI tool config (.claude/, .opencode/, copilot).
// Writes .ninthwave/config with detected settings, runs setup scaffolding,
// creates agent symlinks, nw alias, and prints a summary.
//
// Merged from setup.ts: also handles prerequisite checking (warn mode),
// interactive agent selection, nw symlink creation, and --global mode.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { getBundleDir } from "../paths.ts";
import { userStateDir, migrateRuntimeState } from "../daemon.ts";
import { info, GREEN, BOLD, DIM, RESET, YELLOW, RED } from "../output.ts";
import { run } from "../shell.ts";
import type { WorkspaceConfig, WorkspacePackage } from "../types.ts";
import {
  createSkillSymlinks,
  isSelfHosting,
  SYMLINK_GITIGNORE_DIRS,
  type CommandChecker,
  type AuthChecker,
  type CommandPathResolver,
  type AgentSelection,
  checkPrerequisites,
  createNwSymlink,
  setupGlobal,
  interactiveAgentSelection,
  detectProjectTools,
  discoverAgentSources,
  buildSymlinkPlan,
  executeSymlinkPlan,
  AGENT_TARGET_DIRS,
} from "./setup.ts";
import { AI_TOOL_PROFILES } from "../ai-tools.ts";

// --- Detection types ---

export interface DetectionResult {
  /** Detected CI system, e.g. "github-actions" */
  ci: string | null;
  /** Detected test command, e.g. "bun test" */
  testCommand: string | null;
  /** Detected multiplexer */
  mux: "cmux" | null;
  /** Detected AI tool configurations */
  aiTools: string[];
  /** Repo structure type */
  repoType: "monorepo" | "single";
  /** Detected observability backends (from env vars) */
  observabilityBackends: string[];
  /** Detected workspace configuration (monorepo packages) */
  workspace: WorkspaceConfig | null;
}

/**
 * Dependency injection for init -- all external I/O is injectable for testing.
 */
export interface InitDeps {
  commandExists?: CommandChecker;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
  readDir?: (dir: string) => string[];
  getEnv?: (key: string) => string | undefined;
}

/**
 * Options for initProject -- setup-specific dependencies.
 */
export interface InitProjectOpts {
  /** Agent selection -- bypasses prompts. Defaults to all agents + all detected tools. */
  agentSelection?: AgentSelection;
  /** Command checker for prerequisite checks. Falls back to InitDeps.commandExists. */
  commandExists?: CommandChecker;
  /** GitHub auth checker for prerequisite checks. */
  ghAuthCheck?: AuthChecker;
  /** Command path resolver for nw symlink creation. */
  resolveCommandPath?: CommandPathResolver;
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
 */
export function detectMux(deps: InitDeps = {}): "cmux" | null {
  const commandExists = deps.commandExists ?? defaultCommandExists;

  if (commandExists("cmux")) return "cmux";

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

  for (const profile of AI_TOOL_PROFILES) {
    if (profile.projectIndicators.some((indicator) => fileExists(join(projectDir, indicator)))) {
      tools.push(profile.id);
    }
  }

  return tools;
}

/**
 * Detect repo structure -- monorepo if package.json has workspaces,
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
      // Invalid JSON -- ignore
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
 * Detect observability backend env vars (Sentry, PagerDuty).
 * Returns an array of backend names whose auth tokens are present.
 */
export function detectObservabilityBackends(deps: InitDeps = {}): string[] {
  const getEnv = deps.getEnv ?? defaultGetEnv;
  const backends: string[] = [];

  if (getEnv("SENTRY_AUTH_TOKEN")) backends.push("sentry");
  if (getEnv("PAGERDUTY_API_TOKEN")) backends.push("pagerduty");
  if (getEnv("LINEAR_API_KEY")) backends.push("linear");

  return backends;
}

// --- Workspace detection ---

/**
 * Parse package globs from pnpm-workspace.yaml content.
 * Handles the simple YAML structure: `packages:` followed by `- glob` items.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const globs: string[] = [];
  let inPackages = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }

    // New top-level key ends the packages section
    if (inPackages && /^\S/.test(line)) {
      break;
    }

    if (inPackages && trimmed.startsWith("- ")) {
      const glob = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (glob) globs.push(glob);
    }
  }

  return globs;
}

/**
 * Pick the best test script from a package.json scripts object.
 * Priority: test:ci > test > first script key containing "test".
 */
export function pickTestScript(
  scripts?: Record<string, string>,
): string | null {
  if (!scripts) return null;
  if (scripts["test:ci"]) return "test:ci";
  if (scripts["test"]) return "test";
  for (const key of Object.keys(scripts)) {
    if (key.includes("test")) return key;
  }
  return null;
}

/**
 * Format a workspace-scoped test command for a given tool and package.
 */
export function formatTestCommand(
  tool: "pnpm" | "yarn" | "npm",
  name: string,
  path: string,
  script: string,
): string {
  switch (tool) {
    case "pnpm":
      return script === "test"
        ? `pnpm test --filter ${name}`
        : `pnpm run ${script} --filter ${name}`;
    case "yarn":
      return script === "test"
        ? `yarn workspace ${name} test`
        : `yarn workspace ${name} run ${script}`;
    case "npm":
      return script === "test"
        ? `npm test -w ${path}`
        : `npm run ${script} -w ${path}`;
  }
}

/**
 * Resolve workspace glob patterns to directories containing package.json.
 * Handles common patterns like `packages/*` and `apps/*`.
 * Only detects first-level matches (no recursion into nested workspaces).
 */
export function resolveWorkspaceGlobs(
  projectDir: string,
  globs: string[],
  tool: "pnpm" | "yarn" | "npm",
  deps: InitDeps = {},
): WorkspacePackage[] {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const readDir = deps.readDir ?? defaultReadDir;
  const rf = deps.readFile ?? defaultReadFile;

  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();

  for (const glob of globs) {
    // Skip negation patterns
    if (glob.startsWith("!")) continue;

    // Strip quotes
    const cleaned = glob.replace(/^['"]|['"]$/g, "");

    // Split into prefix and wildcard
    const parts = cleaned.split("/");
    const wildcardIdx = parts.findIndex((p) => p.includes("*"));

    let dirs: string[];
    if (wildcardIdx === -1) {
      // Literal path -- check if it has a package.json
      if (fileExists(join(projectDir, cleaned, "package.json"))) {
        dirs = [cleaned];
      } else {
        dirs = [];
      }
    } else {
      // Resolve: list entries under the prefix directory
      const prefix = parts.slice(0, wildcardIdx).join("/");
      const baseDir = prefix ? join(projectDir, prefix) : projectDir;

      const entries = readDir(baseDir);
      dirs = entries
        .filter((e) => !e.startsWith("."))
        .filter((e) =>
          fileExists(join(baseDir, e, "package.json")),
        )
        .map((e) => (prefix ? `${prefix}/${e}` : e));
    }

    for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);

      const content = rf(join(projectDir, dir, "package.json"));
      if (!content) continue;

      let pkg: { name?: string; scripts?: Record<string, string> };
      try {
        pkg = JSON.parse(content);
      } catch {
        continue;
      }

      const name = pkg.name ?? dir.split("/").pop()!;
      const testScript = pickTestScript(pkg.scripts);
      const testCmd = testScript
        ? formatTestCommand(tool, name, dir, testScript)
        : "";

      packages.push({ name, path: dir, testCmd });
    }
  }

  return packages;
}

/**
 * Detect workspace configuration for monorepo projects.
 *
 * Detection order:
 * 1. pnpm-workspace.yaml → pnpm
 * 2. package.json workspaces → yarn (if yarn.lock) / npm (otherwise)
 * 3. turbo.json or package.json turbo field → override tool to "turborepo"
 *
 * Returns null for single-package repos or when globs match no packages.
 */
export function detectWorkspace(
  projectDir: string,
  deps: InitDeps = {},
): WorkspaceConfig | null {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const rf = deps.readFile ?? defaultReadFile;

  let baseTool: "pnpm" | "yarn" | "npm" | null = null;
  let globs: string[] = [];

  // 1. Check pnpm-workspace.yaml
  const pnpmYaml = rf(join(projectDir, "pnpm-workspace.yaml"));
  if (pnpmYaml) {
    baseTool = "pnpm";
    globs = parsePnpmWorkspaceYaml(pnpmYaml);
  }

  // 2. Check package.json workspaces
  if (!baseTool) {
    const pkgContent = rf(join(projectDir, "package.json"));
    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent) as {
          workspaces?: string[] | { packages?: string[] };
        };
        if (pkg.workspaces) {
          const ws = Array.isArray(pkg.workspaces)
            ? pkg.workspaces
            : (pkg.workspaces.packages ?? []);
          if (ws.length > 0) {
            globs = ws;
            // Determine tool from lockfile
            if (fileExists(join(projectDir, "pnpm-lock.yaml"))) {
              baseTool = "pnpm";
            } else if (fileExists(join(projectDir, "yarn.lock"))) {
              baseTool = "yarn";
            } else {
              baseTool = "npm";
            }
          }
        }
      } catch {
        // Invalid JSON -- skip
      }
    }
  }

  if (!baseTool || globs.length === 0) return null;

  // Resolve globs to actual packages
  const packages = resolveWorkspaceGlobs(projectDir, globs, baseTool, deps);

  if (packages.length === 0) {
    console.warn(
      `  ${YELLOW}!${RESET} Workspace globs matched no packages`,
    );
    return null;
  }

  // 3. Check for turborepo overlay
  let tool: WorkspaceConfig["tool"] = baseTool;
  const hasTurboJson = fileExists(join(projectDir, "turbo.json"));
  if (hasTurboJson) {
    tool = "turborepo";
  } else {
    const pkgContent = rf(join(projectDir, "package.json"));
    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent) as { turbo?: unknown };
        if (pkg.turbo) tool = "turborepo";
      } catch {
        // Already parsed above -- skip
      }
    }
  }

  return {
    tool,
    root: ".",
    packages,
  };
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
    observabilityBackends: detectObservabilityBackends(deps),
    workspace: detectWorkspace(projectDir, deps),
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
    lines.push(`# AI_TOOLS=${AI_TOOL_PROFILES.map((p) => p.command).join(",")}`);
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
      `  ${YELLOW}!${RESET} Multiplexer: none detected ${DIM}(install cmux for parallel sessions)${RESET}`,
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

  // Observability backends
  if (detection.observabilityBackends.length > 0) {
    console.log(
      `  ${GREEN}✓${RESET} Observability: ${detection.observabilityBackends.join(", ")}`,
    );
  } else {
    console.log(
      `  ${DIM}–${RESET} Observability: ${DIM}no backends detected (set SENTRY_AUTH_TOKEN, PAGERDUTY_API_TOKEN, or LINEAR_API_KEY)${RESET}`,
    );
  }

  // Workspace
  if (detection.workspace) {
    console.log(
      `  ${GREEN}✓${RESET} Workspace: ${detection.workspace.tool} (${detection.workspace.packages.length} packages)`,
    );
    for (const pkg of detection.workspace.packages) {
      const cmd = pkg.testCmd || `${DIM}no test command${RESET}`;
      console.log(
        `    ${DIM}·${RESET} ${pkg.name} ${DIM}(${pkg.path})${RESET} -- ${cmd}`,
      );
    }
  }

  console.log();
}

// --- Scaffolding ---

/**
 * Run the scaffolding portion of init -- creates all project files.
 * Never aborts on missing prerequisites.
 *
 * Uses AgentSelection for agent installation. Defaults to all agents
 * in all tool directories if no selection is provided.
 */
function scaffold(
  projectDir: string,
  bundleDir: string,
  agentSelection?: AgentSelection,
): void {
  // --- .ninthwave/ directory ---
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

  // Domains config (preserve existing)
  const domainsPath = join(projectDir, ".ninthwave/domains.conf");
  if (!existsSync(domainsPath)) {
    writeFileSync(
      domainsPath,
      `# Domain mappings for ninthwave
# Format: pattern=domain_key
# Patterns are matched case-insensitively against todo file domain fields.
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

  // --- Migrate .ninthwave/todos/ → .ninthwave/work/ (if legacy directory exists) ---
  const legacyTodosDir = join(projectDir, ".ninthwave", "todos");
  const workDir = join(projectDir, ".ninthwave", "work");
  if (existsSync(legacyTodosDir) && !existsSync(workDir)) {
    const entries = readdirSync(legacyTodosDir);
    mkdirSync(workDir, { recursive: true });
    for (const entry of entries) {
      const src = join(legacyTodosDir, entry);
      const dst = join(workDir, entry);
      writeFileSync(dst, readFileSync(src, "utf-8"));
    }
    // Remove legacy directory contents (keep parent .ninthwave/ intact)
    for (const entry of entries) {
      const src = join(legacyTodosDir, entry);
      require("fs").unlinkSync(src);
    }
    require("fs").rmdirSync(legacyTodosDir);
    console.log("  Migrated .ninthwave/todos/ → .ninthwave/work/");
  }

  // --- .ninthwave/schedules/ directory with example ---
  const schedulesDir = join(projectDir, ".ninthwave", "schedules");
  const schedulesIsNew = !existsSync(schedulesDir);
  mkdirSync(schedulesDir, { recursive: true });

  if (schedulesIsNew) {
    const examplePath = join(schedulesDir, "ci--example-daily-audit.md");
    writeFileSync(
      examplePath,
      `# Daily CI Audit (ci--example-daily-audit)

**Schedule:** Every day at 8am UTC
**Priority:** Low
**Domain:** ci
**Timeout:** 10m
**Enabled:** false

Review the last 24 hours of CI runs. Summarise any flaky tests,
unusual failure patterns, or builds that took significantly longer
than average. Open a work item for anything that needs attention.
`,
    );
  }

  // --- .ninthwave/work/ and .ninthwave/friction/ directories ---
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, ".gitkeep"), "");

  const frictionDir = join(projectDir, ".ninthwave", "friction");
  mkdirSync(frictionDir, { recursive: true });
  writeFileSync(join(frictionDir, ".gitkeep"), "");

  // --- Skill symlinks ---
  const skillsDir = join(projectDir, ".claude/skills");
  createSkillSymlinks(skillsDir, bundleDir);

  // --- Agent files (symlinked to stay in sync with source) ---
  const selection = agentSelection ?? {
    agents: discoverAgentSources(bundleDir),
    toolDirs: [...AGENT_TARGET_DIRS],
  };
  const plan = buildSymlinkPlan(projectDir, bundleDir, selection);
  executeSymlinkPlan(plan);

  // --- .gitignore ---
  const gitignorePath = join(projectDir, ".gitignore");
  const selfHosting = isSelfHosting(projectDir, bundleDir);

  if (existsSync(gitignorePath)) {
    let content = readFileSync(gitignorePath, "utf-8");
    let modified = false;

    if (!content.includes(".worktrees/")) {
      content += "\n# ninthwave worktrees\n.worktrees/\n";
      modified = true;
    }

    // Add symlink directories for non-self-hosting projects
    if (!selfHosting) {
      const missing = SYMLINK_GITIGNORE_DIRS.filter(
        (d) => !content.includes(d),
      );
      if (missing.length > 0) {
        content +=
          "\n# ninthwave symlinks (developer-local, re-created by ninthwave init)\n";
        for (const entry of missing) {
          content += entry + "\n";
        }
        modified = true;
      }
    }

    if (modified) {
      writeFileSync(gitignorePath, content);
    }
  } else {
    let content = "# ninthwave worktrees\n.worktrees/\n";
    if (!selfHosting) {
      content +=
        "\n# ninthwave symlinks (developer-local, re-created by ninthwave init)\n";
      for (const entry of SYMLINK_GITIGNORE_DIRS) {
        content += entry + "\n";
      }
    }
    writeFileSync(gitignorePath, content);
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
  const stateDir = userStateDir(projectDir);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "version"), version + "\n");
}

// --- Main init command ---

/**
 * Run `ninthwave init` -- auto-detect project environment and set up ninthwave.
 *
 * Unified flow: auto-detect -> print summary -> check prerequisites (warn) ->
 * write config -> scaffold with agent selection -> nw symlink -> print next steps.
 *
 * Never aborts on missing prerequisites -- warnings only.
 */
export function initProject(
  projectDir: string,
  bundleDir: string,
  deps?: InitDeps,
  opts?: InitProjectOpts,
): DetectionResult {
  console.log(`Initializing ninthwave in: ${projectDir}`);
  console.log();

  // 1. Auto-detect environment
  console.log("Detecting project environment...");
  const detection = detectAll(projectDir, deps);
  console.log();

  // 2. Print detection summary
  printSummary(detection);

  // 3. Check prerequisites (warn, don't abort)
  const cmdExists = opts?.commandExists ?? deps?.commandExists;
  checkPrerequisites(
    cmdExists ?? undefined,
    opts?.ghAuthCheck ?? undefined,
  );

  // 4. Write config with detected values (always overwrite -- init is authoritative)
  const configPath = join(projectDir, ".ninthwave/config");
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
  writeFileSync(configPath, generateConfig(detection));
  console.log("Configured:");
  console.log(`  .ninthwave/config ${DIM}(auto-detected settings)${RESET}`);

  // 4b. Write workspace config as JSON (structured data)
  if (detection.workspace) {
    const configJsonPath = join(projectDir, ".ninthwave/config.json");
    const configJson = { workspace: detection.workspace };
    writeFileSync(configJsonPath, JSON.stringify(configJson, null, 2) + "\n");
    console.log(`  .ninthwave/config.json ${DIM}(workspace packages)${RESET}`);
  }

  // 5. Run scaffolding (with agent selection)
  scaffold(projectDir, bundleDir, opts?.agentSelection);
  console.log(`  .ninthwave/domains.conf`);
  console.log(`  .ninthwave/work/ ${DIM}(work items)${RESET}`);
  console.log(`  .ninthwave/friction/ ${DIM}(friction log)${RESET}`);
  console.log(`  .ninthwave/schedules/ ${DIM}(scheduled tasks)${RESET}`);
  console.log(`  .claude/skills/ ${DIM}(symlinks)${RESET}`);
  console.log(`  .gitignore`);
  console.log();

  // 6. Create nw symlink
  console.log("CLI alias...");
  createNwSymlink(cmdExists ?? undefined, opts?.resolveCommandPath);
  console.log();

  // 7. Migrate runtime state
  migrateRuntimeState(projectDir);

  // 8. Done
  console.log(`${GREEN}Done!${RESET} ninthwave is ready.`);
  console.log();
  console.log("Next steps:");
  console.log("  1. git add -A && git commit -m 'chore: init ninthwave'");
  console.log("  2. Add work items to .ninthwave/work/");
  console.log("  3. Run: ninthwave list");
  console.log();
  console.log(`${DIM}Tip: Use ${BOLD}nw${RESET}${DIM} as a short alias for ${BOLD}ninthwave${RESET}${DIM} in daily use.${RESET}`);

  return detection;
}

/**
 * CLI entry point for `ninthwave init`.
 *
 * Flags:
 *   --global  Set up global skills only
 *   --yes     Skip interactive prompts, accept defaults
 */
export async function cmdInit(args: string[] = []): Promise<void> {
  const isGlobal = args.includes("--global");
  const autoYes = args.includes("--yes") || args.includes("-y");
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
    console.error(`${RED}Error:${RESET} Not inside a git repository`);
    process.exit(1);
  }
  const projectDir = result.stdout.replace(/\/.git$/, "");

  // Determine agent selection
  const isTTY = process.stdin.isTTY ?? false;
  let agentSelection: AgentSelection | undefined;

  if (autoYes || !isTTY) {
    // Non-interactive: all agents to all detected tools (or all tools if none detected)
    const detectedTools = detectProjectTools(projectDir);
    const toolDirs =
      detectedTools.length > 0 ? detectedTools : [...AGENT_TARGET_DIRS];
    agentSelection = {
      agents: discoverAgentSources(bundleDir),
      toolDirs,
    };
  } else {
    // Interactive: prompt for agent selection
    const selection = await interactiveAgentSelection(projectDir, bundleDir);
    agentSelection = selection ?? { agents: [], toolDirs: [] };
  }

  initProject(projectDir, bundleDir, undefined, { agentSelection });
}
