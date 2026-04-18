// `ninthwave init` -- unified project initialization with auto-detection.
//
// Detects: (1) repo structure (monorepo vs single), (2) CI system (GitHub Actions),
// (3) optional interactive backend (cmux or tmux), (4) AI tool config (.claude/, .opencode/, copilot).
// Writes .ninthwave/config.json with detected settings, runs setup scaffolding,
// creates managed skill/agent copies, nw alias, and prints a summary.
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
import { assertOriginMain } from "../git.ts";
import {
  copySkillFiles,
  type CommandChecker,
  type AuthChecker,
  type CmuxResolver,
  type CommandPathResolver,
  type AgentSelection,
  checkPrerequisites,
  createNwSymlink,
  setupGlobal,
  interactiveAgentSelection,
  detectProjectTools,
  discoverCanonicalBundleSources,
  buildCopyPlan,
  filterCopyPlan,
  executeCopyPlan,
  AGENT_TARGET_DIRS,
  pruneManagedGeneratedEntries,
} from "./setup.ts";
import { AI_TOOL_PROFILES } from "../ai-tools.ts";
import {
  generateProjectIdentity,
  loadWorkingTreeConfig,
  loadLocalConfig,
  parseBrokerSecret,
  saveLocalConfig,
} from "../config.ts";
import {
  brokerSecretPrompt as defaultBrokerSecretPrompt,
  type BrokerSecretAction,
  type BrokerSecretPromptFn,
} from "../prompt.ts";
import { seedOpencodeConfig } from "../opencode-config.ts";

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
  /**
   * Pre-resolved broker secret decision. When omitted, `initProject` defaults
   * to `{ action: "generate" }` so non-interactive callers and tests continue
   * to get a fresh secret written into `.ninthwave/config.local.json`. When
   * an existing secret is already present in either config file this option
   * is ignored (we never rotate a committed team identity silently).
   */
  brokerSecretAction?: BrokerSecretAction;
  /** Command checker for prerequisite checks. Falls back to InitDeps.commandExists. */
  commandExists?: CommandChecker;
  /** GitHub auth checker for prerequisite checks. */
  ghAuthCheck?: AuthChecker;
  /** cmux resolver for prerequisite checks. */
  cmuxResolver?: CmuxResolver;
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
 * Detect available optional interactive backend.
 */
export function detectMux(deps: InitDeps = {}): "cmux" | "tmux" | null {
  const commandExists = deps.commandExists ?? defaultCommandExists;

  if (commandExists("cmux")) return "cmux";
  if (commandExists("tmux")) return "tmux";

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
 * Leading JSONC header written to `.ninthwave/config.json`. Tells readers
 * (humans and our own loader) that the file is JSONC and points at
 * `config.local.json` for the `broker_secret`. The filename stays `.json`
 * to match tsconfig/VSCode precedent and avoid churn in docs and external
 * references; our loader uses `stripJsonComments` before `JSON.parse`.
 */
const CONFIG_JSON_HEADER = `// Ninthwave project config (JSONC).
// broker_secret lives in .ninthwave/config.local.json (gitignored). Share
// the secret with teammates out of band (password manager, secure chat);
// they can save it via \`nw crew join <secret>\` or
// \`nw init --broker-secret <secret>\`. Run \`nw crew\` to inspect or
// rotate the project's crew connection.
`;

/**
 * Generate `.ninthwave/config.json` content. Emits a JSONC header followed
 * by a JSON body with the public identity and (optionally) `crew_url`.
 *
 * `broker_secret` is intentionally omitted -- it is provisioned into
 * `.ninthwave/config.local.json` by `loadOrGenerateProjectIdentity` after
 * this file is written, so the committed config never carries a secret by
 * default.
 *
 * If `existingConfig` supplies a `project_id`, it is preserved verbatim so
 * re-running `nw init` never rotates the project's public identity.
 */
export function generateConfig(
  _detection: DetectionResult,
  existingConfig?: {
    crew_url?: string;
    project_id?: string;
  },
): string {
  const config: {
    crew_url?: string;
    project_id?: string;
  } = {};
  if (existingConfig?.crew_url) {
    config.crew_url = existingConfig.crew_url;
  }
  config.project_id =
    existingConfig?.project_id ?? generateProjectIdentity().project_id;
  return CONFIG_JSON_HEADER + JSON.stringify(config, null, 2) + "\n";
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

  // Interactive backend
  if (detection.mux) {
    console.log(
      `  ${GREEN}✓${RESET} Interactive backend: ${detection.mux}`,
    );
  } else {
    console.log(
      `  ${YELLOW}!${RESET} Interactive backend: headless default ${DIM}(install cmux or tmux for interactive sessions)${RESET}`,
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
  const canonicalSources = discoverCanonicalBundleSources(bundleDir);

  // --- .ninthwave/ directory ---
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });

  const workDir = join(projectDir, ".ninthwave", "work");

  // --- .ninthwave/work/, .ninthwave/friction/, and .ninthwave/decisions/ ---
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, ".gitkeep"), "");

  const frictionDir = join(projectDir, ".ninthwave", "friction");
  mkdirSync(frictionDir, { recursive: true });
  writeFileSync(join(frictionDir, ".gitkeep"), "");

  const decisionsDir = join(projectDir, ".ninthwave", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(join(decisionsDir, ".gitkeep"), "");

  // --- .ninthwave/hooks/ (convention-based bootstrap hooks) ---
  const hooksDir = join(projectDir, ".ninthwave", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, ".gitkeep"), "");

  // --- .ninthwave/work-item-format.md (managed copy of the canonical format guide) ---
  //
  // The /decompose skill reads this file during Phase 6 to ground its output against
  // the canonical schema. Always overwrite so the copy stays in sync with the
  // running ninthwave version.
  const workItemFormatSource = join(bundleDir, "core", "docs", "work-item-format.md");
  const workItemFormatDest = join(projectDir, ".ninthwave", "work-item-format.md");
  if (existsSync(workItemFormatSource)) {
    writeFileSync(workItemFormatDest, readFileSync(workItemFormatSource));
  }

  // --- Skill files ---
  const skillsDir = join(projectDir, ".claude/skills");

  // --- Agent files (copied into project for portability) ---
  const selection = agentSelection ?? {
    agents: canonicalSources.agents,
    toolDirs: [...AGENT_TARGET_DIRS],
  };
  const pruned = pruneManagedGeneratedEntries(projectDir, bundleDir, selection);
  for (const path of pruned) {
    console.log(`  ${YELLOW}−${RESET} ${path} ${DIM}(pruned orphaned managed output)${RESET}`);
  }

  copySkillFiles(skillsDir, bundleDir);
  const plan = buildCopyPlan(projectDir, bundleDir, selection);
  executeCopyPlan(filterCopyPlan(plan, selection));

  // --- .opencode/opencode.jsonc (managed auto-approval for ninthwave agents) ---
  //
  // When opencode is in the selected tool dirs, seed a project-level
  // opencode.jsonc that grants full tool permissions to our orchestrated
  // agents. Upstream opencode's config-dir layer takes precedence over the
  // user's global config and over project-root `opencode.json`, so this
  // fixes the "opencode worker keeps asking for permission" regression
  // without touching any file the user may have committed.
  const opencodeSelected = selection.toolDirs.some(
    (t) => t.dir === ".opencode/agents",
  );
  if (opencodeSelected) {
    seedOpencodeConfig(projectDir);
  }

  // --- .ninthwave/.gitignore (deny-by-default: only explicitly allowed files are committed) ---
  const nwGitignorePath = join(projectDir, ".ninthwave", ".gitignore");
  if (!existsSync(nwGitignorePath)) {
    writeFileSync(
      nwGitignorePath,
      `# Deny by default -- only explicitly allowed files are committed
*

# Committed project files
!.gitignore
!config.json
!work-item-format.md
!work/
!work/**
!friction/
!friction/**
!decisions/
!decisions/**
!hooks/
!hooks/**

# User-specific config overlay -- explicitly excluded even if the
# deny-by-default pattern above is ever relaxed.
config.local.json
`,
    );
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
  // Precondition: `origin/main` must resolve. Ninthwave reads work items
  // and shared config from origin/main so the daemon can ignore the user's
  // working tree; without an origin/main ref there is nothing to read and
  // no scaffolding to anchor the project identity against. Fail loudly
  // with an actionable message instead of writing config that would
  // immediately be orphaned.
  assertOriginMain(projectDir, "nw init");

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
    opts?.cmuxResolver ?? undefined,
  );

  // 4. Write config with detected values (always overwrite -- init is authoritative)
  const configPath = join(projectDir, ".ninthwave/config.json");
  const existingConfig = loadWorkingTreeConfig(projectDir);
  mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
  writeFileSync(configPath, generateConfig(detection, existingConfig));
  // Apply the caller's broker secret decision. An existing secret in either
  // file counts as already-provisioned and short-circuits the action, so
  // re-running `nw init` never rotates a committed team identity. The old
  // silent auto-generation via `loadOrGenerateProjectIdentity` is gone --
  // `cmdInit` resolves the action (prompt, --yes default, or pre-set opts)
  // before we get here.
  const existingBrokerSecret =
    loadLocalConfig(projectDir).broker_secret ?? existingConfig.broker_secret;
  let wroteLocalSecret = false;
  let generatedSecretToShow: string | undefined;
  if (existingBrokerSecret === undefined) {
    const action: BrokerSecretAction =
      opts?.brokerSecretAction ?? { action: "generate" };
    if (action.action === "generate") {
      const identity = generateProjectIdentity();
      saveLocalConfig(projectDir, { broker_secret: identity.broker_secret });
      wroteLocalSecret = true;
      generatedSecretToShow = identity.broker_secret;
    } else if (action.action === "enter") {
      saveLocalConfig(projectDir, { broker_secret: action.value });
      wroteLocalSecret = true;
    }
    // action === "skip" -- do not touch config.local.json.
  }
  console.log("Configured:");
  console.log(`  .ninthwave/config.json ${DIM}(project settings)${RESET}`);
  if (wroteLocalSecret) {
    console.log(
      `  .ninthwave/config.local.json ${DIM}(local-only; contains broker_secret)${RESET}`,
    );
  }
  if (generatedSecretToShow !== undefined) {
    console.log();
    console.log(`${BOLD}Broker secret:${RESET} ${generatedSecretToShow}`);
    console.log(
      `  ${DIM}Share this with teammates via password manager or secure chat.${RESET}`,
    );
  }

  // 5. Run scaffolding (with agent selection)
  scaffold(projectDir, bundleDir, opts?.agentSelection);
  console.log(`  .ninthwave/work/ ${DIM}(work items)${RESET}`);
  console.log(`  .ninthwave/friction/ ${DIM}(friction log)${RESET}`);
  console.log(`  .ninthwave/decisions/ ${DIM}(decision inbox)${RESET}`);
  console.log(`  .ninthwave/hooks/ ${DIM}(bootstrap hooks)${RESET}`);
  console.log(`  .claude/skills/ ${DIM}(managed copies)${RESET}`);
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
 * Parsed result of `ninthwave init` CLI flags.
 *
 * `flagAction` captures a pre-resolved broker-secret decision derived from
 * `--broker-secret`/`--skip-broker`. When it is `undefined`, `cmdInit` falls
 * back to the normal TTY prompt (interactive) or silent generation
 * (`--yes`/non-TTY), preserving the previous behavior for callers that pass
 * neither flag.
 */
export interface InitFlags {
  isGlobal: boolean;
  autoYes: boolean;
  flagAction: BrokerSecretAction | undefined;
}

export type ParseInitFlagsResult =
  | { ok: true; flags: InitFlags }
  | { ok: false; error: string };

/**
 * Parse the `ninthwave init` argv slice.
 *
 * Extracted as a pure function so the flag contract (mutual exclusion,
 * value validation, boolean toggles) can be unit-tested without a real
 * git repo or TTY. Any error is surfaced as a string so `cmdInit` can
 * print/exit and tests can assert on the message.
 */
export function parseInitFlags(args: string[]): ParseInitFlagsResult {
  let isGlobal = false;
  let autoYes = false;
  let skipBroker = false;
  let brokerSecretValue: string | undefined;
  let brokerSecretFlagSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--global") {
      isGlobal = true;
    } else if (arg === "--yes" || arg === "-y") {
      autoYes = true;
    } else if (arg === "--skip-broker") {
      skipBroker = true;
    } else if (arg === "--broker-secret") {
      brokerSecretFlagSeen = true;
      const next = args[i + 1];
      if (next === undefined) {
        return {
          ok: false,
          error: "--broker-secret requires a value",
        };
      }
      brokerSecretValue = next;
      i++;
    }
    // Unknown flags are ignored to preserve the previous permissive
    // behavior (e.g., future flags or harness-specific args).
  }

  if (brokerSecretFlagSeen && skipBroker) {
    return {
      ok: false,
      error:
        "--broker-secret and --skip-broker are mutually exclusive; pick one",
    };
  }

  let flagAction: BrokerSecretAction | undefined;
  if (skipBroker) {
    flagAction = { action: "skip" };
  } else if (brokerSecretFlagSeen) {
    const validated = parseBrokerSecret(brokerSecretValue);
    if (validated === undefined) {
      return {
        ok: false,
        error:
          "--broker-secret value is not a valid 32-byte base64 secret (expected 44 chars ending in '=')",
      };
    }
    flagAction = { action: "enter", value: validated };
  }

  return {
    ok: true,
    flags: { isGlobal, autoYes, flagAction },
  };
}

/**
 * CLI entry point for `ninthwave init`.
 *
 * Flags:
 *   --global                  Set up global skills only
 *   --yes, -y                 Skip interactive prompts, accept defaults
 *   --broker-secret <value>   Use the given 32-byte base64 secret (team onboarding)
 *   --skip-broker             Skip broker secret provisioning (local-only setup)
 */
export async function cmdInit(
  args: string[] = [],
  deps?: { brokerSecretPrompt?: BrokerSecretPromptFn },
): Promise<void> {
  const parsed = parseInitFlags(args);
  if (!parsed.ok) {
    console.error(`${RED}Error:${RESET} ${parsed.error}`);
    process.exit(1);
  }
  const { isGlobal, autoYes, flagAction } = parsed.flags;
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
    const canonicalSources = discoverCanonicalBundleSources(bundleDir);
    const toolDirs =
      detectedTools.length > 0 ? detectedTools : [...AGENT_TARGET_DIRS];
    agentSelection = {
      agents: canonicalSources.agents,
      toolDirs,
    };
  } else {
    // Interactive: prompt for agent selection
    const selection = await interactiveAgentSelection(projectDir, bundleDir);
    agentSelection = selection ?? { agents: [], toolDirs: [] };
  }

  // Resolve the broker secret decision. Precedence:
  //   1. Existing secret in config (never rotated; flag values ignored).
  //   2. Explicit CLI flag (`--broker-secret` / `--skip-broker`) -- works
  //      regardless of `--yes`, so scripted onboarding can skip the prompt
  //      even without `--yes`.
  //   3. `--yes` or non-TTY: silent generate (preserves old default).
  //   4. Interactive prompt.
  const existingSecret =
    loadLocalConfig(projectDir).broker_secret ??
    loadWorkingTreeConfig(projectDir).broker_secret;
  let brokerSecretAction: BrokerSecretAction | undefined;
  if (existingSecret === undefined) {
    if (flagAction !== undefined) {
      brokerSecretAction = flagAction;
    } else if (autoYes || !isTTY) {
      brokerSecretAction = { action: "generate" };
    } else {
      const prompt = deps?.brokerSecretPrompt ?? defaultBrokerSecretPrompt;
      brokerSecretAction = await prompt(
        (value) => parseBrokerSecret(value) !== undefined,
      );
    }
  }

  initProject(projectDir, bundleDir, undefined, {
    agentSelection,
    brokerSecretAction,
  });
}
