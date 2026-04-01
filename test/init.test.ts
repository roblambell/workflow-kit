// Tests for `ninthwave init` command (core/commands/init.ts).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
} from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import { userStateDir } from "../core/daemon.ts";
import {
  detectCI,
  detectTestCommand,
  detectMux,
  detectAITools,
  detectRepoType,
  detectObservabilityBackends,
  detectWorkspace,
  parsePnpmWorkspaceYaml,
  pickTestScript,
  formatTestCommand,
  resolveWorkspaceGlobs,
  detectAll,
  generateConfig,
  initProject,
  type InitDeps,
  type InitProjectOpts,
  type DetectionResult,
} from "../core/commands/init.ts";
import type {
  CommandChecker,
  AuthChecker,
  CommandPathResolver,
  AgentSelection,
} from "../core/commands/setup.ts";
import {
  AGENT_SOURCES,
  AGENT_TARGET_DIRS,
  AGENT_DESCRIPTIONS,
  discoverAgentSources,
  buildCopyPlan,
  setupGlobal,
} from "../core/commands/setup.ts";
import { lookupCommand } from "../core/help.ts";

// Store original env
const originalEnv = { ...process.env };

afterEach(() => {
  cleanupTempRepos();
  process.env = { ...originalEnv };
});

/**
 * Create a minimal fake bundle directory with the expected structure.
 */
function createFakeBundle(dir: string): string {
  const bundleDir = join(dir, "bundle");
  mkdirSync(bundleDir, { recursive: true });

  // Create skills directories
  for (const skill of [
    "work",
    "decompose",

  ]) {
    const skillDir = join(bundleDir, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
  }

  // Create agents directory
  mkdirSync(join(bundleDir, "agents"), { recursive: true });
  writeFileSync(
    join(bundleDir, "agents", "implementer.md"),
    [
      "# Implementer Agent",
      "nw inbox --wait YOUR_TODO_ID",
      "set the timeout to the longest practical value available",
      "immediately run the same wait command again",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(bundleDir, "agents", "reviewer.md"),
    "# Reviewer Agent\n",
  );
  writeFileSync(
    join(bundleDir, "agents", "forward-fixer.md"),
    "# Verifier Agent\n",
  );
  writeFileSync(
    join(bundleDir, "agents", "rebaser.md"),
    "# Rebaser Agent\n",
  );

  writeFileSync(join(bundleDir, "CLAUDE.md"), "# Bundle instructions\n");

  // Create VERSION file
  writeFileSync(join(bundleDir, "VERSION"), "0.1.0\n");

  // Initialize as git repo so git describe works
  const { spawnSync } = require("child_process");
  spawnSync("git", ["-C", bundleDir, "init", "--quiet"]);
  spawnSync("git", [
    "-C",
    bundleDir,
    "config",
    "user.email",
    "test@test.com",
  ]);
  spawnSync("git", ["-C", bundleDir, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", bundleDir, "add", "."]);
  spawnSync("git", ["-C", bundleDir, "commit", "-m", "init", "--quiet"]);

  return bundleDir;
}

// --- detectCI ---

describe("detectCI", () => {
  it("detects GitHub Actions from .github/workflows/*.yml", () => {
    const projectDir = setupTempRepo();
    const workflowsDir = join(projectDir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "ci.yml"), "name: CI\n");

    const result = detectCI(projectDir);

    expect(result).toBe("github-actions");
  });

  it("detects GitHub Actions from .github/workflows/*.yaml", () => {
    const projectDir = setupTempRepo();
    const workflowsDir = join(projectDir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "deploy.yaml"), "name: Deploy\n");

    const result = detectCI(projectDir);

    expect(result).toBe("github-actions");
  });

  it("returns null when no .github/workflows/ exists", () => {
    const projectDir = setupTempRepo();

    const result = detectCI(projectDir);

    expect(result).toBeNull();
  });

  it("returns null when .github/workflows/ has no yml files", () => {
    const projectDir = setupTempRepo();
    const workflowsDir = join(projectDir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "README.md"), "# Workflows\n");

    const result = detectCI(projectDir);

    expect(result).toBeNull();
  });

  it("works with injected deps", () => {
    const deps: InitDeps = {
      fileExists: (path: string) => path.includes(".github/workflows"),
      readDir: () => ["ci.yml", "deploy.yaml"],
    };

    const result = detectCI("/fake/project", deps);

    expect(result).toBe("github-actions");
  });
});

// --- detectMux ---

describe("detectMux", () => {
  it("detects cmux when binary exists on PATH", () => {
    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "cmux") as CommandChecker,
    };

    const result = detectMux(deps);

    expect(result).toBe("cmux");
  });

  it("returns null when no multiplexer is available", () => {
    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const result = detectMux(deps);

    expect(result).toBeNull();
  });
});

// --- detectAITools ---

describe("detectAITools", () => {
  it("detects Claude Code from .claude/ directory", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".claude"), { recursive: true });

    const result = detectAITools(projectDir);

    expect(result).toContain("claude");
  });

  it("detects OpenCode from .opencode/ directory", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".opencode"), { recursive: true });

    const result = detectAITools(projectDir);

    expect(result).toContain("opencode");
  });

  it("detects Copilot from .github/copilot-instructions.md", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".github"), { recursive: true });
    writeFileSync(
      join(projectDir, ".github", "copilot-instructions.md"),
      "# Copilot Instructions\n",
    );

    const result = detectAITools(projectDir);

    expect(result).toContain("copilot");
  });

  it("detects multiple AI tools", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".opencode"), { recursive: true });
    mkdirSync(join(projectDir, ".github"), { recursive: true });
    writeFileSync(
      join(projectDir, ".github", "copilot-instructions.md"),
      "# Copilot\n",
    );

    const result = detectAITools(projectDir);

    expect(result).toEqual(["claude", "opencode", "copilot"]);
  });

  it("returns empty array when no AI tools are configured", () => {
    const projectDir = setupTempRepo();

    const result = detectAITools(projectDir);

    expect(result).toEqual([]);
  });
});

// --- detectRepoType ---

describe("detectRepoType", () => {
  it("detects monorepo from package.json workspaces", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );

    const result = detectRepoType(projectDir);

    expect(result).toBe("monorepo");
  });

  it("detects monorepo from pnpm-workspace.yaml", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );

    const result = detectRepoType(projectDir);

    expect(result).toBe("monorepo");
  });

  it("detects monorepo from multiple sub-package.json files", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "app-a"), { recursive: true });
    mkdirSync(join(projectDir, "app-b"), { recursive: true });
    writeFileSync(
      join(projectDir, "app-a", "package.json"),
      JSON.stringify({ name: "app-a" }),
    );
    writeFileSync(
      join(projectDir, "app-b", "package.json"),
      JSON.stringify({ name: "app-b" }),
    );

    const result = detectRepoType(projectDir);

    expect(result).toBe("monorepo");
  });

  it("detects single repo when no monorepo indicators", () => {
    const projectDir = setupTempRepo();

    const result = detectRepoType(projectDir);

    expect(result).toBe("single");
  });

  it("detects single repo with one package.json (no workspaces)", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "my-app" }),
    );

    const result = detectRepoType(projectDir);

    expect(result).toBe("single");
  });
});

// --- detectTestCommand ---

describe("detectTestCommand", () => {
  it("detects 'bun test' from package.json scripts", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );

    const result = detectTestCommand(projectDir);

    expect(result).toBe("bun test");
  });

  it("detects 'npm test' as fallback", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { test: "npm test" } }),
    );

    const result = detectTestCommand(projectDir);

    expect(result).toBe("npm test");
  });

  it("detects 'check' script when no 'test' script exists", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { check: "tsc --noEmit" } }),
    );

    const result = detectTestCommand(projectDir);

    expect(result).toBe("tsc --noEmit");
  });

  it("detects 'lint' script when no 'test' or 'check' exists", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );

    const result = detectTestCommand(projectDir);

    expect(result).toBe("eslint .");
  });

  it("prefers 'test' over 'check' and 'lint'", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        scripts: { lint: "eslint .", check: "tsc", test: "vitest" },
      }),
    );

    const result = detectTestCommand(projectDir);

    expect(result).toBe("vitest");
  });

  it("returns null when package.json has no scripts", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "my-app" }),
    );

    const result = detectTestCommand(projectDir);

    expect(result).toBeNull();
  });

  it("returns null when package.json does not exist", () => {
    const projectDir = setupTempRepo();

    const result = detectTestCommand(projectDir);

    expect(result).toBeNull();
  });

  it("returns null when package.json is invalid JSON", () => {
    const projectDir = setupTempRepo();
    writeFileSync(join(projectDir, "package.json"), "not valid json{{{");

    const result = detectTestCommand(projectDir);

    expect(result).toBeNull();
  });

  it("works with injected readFile dep", () => {
    const deps: InitDeps = {
      readFile: () => JSON.stringify({ scripts: { test: "jest" } }),
    };

    const result = detectTestCommand("/fake/project", deps);

    expect(result).toBe("jest");
  });
});

// --- generateConfig ---

describe("generateConfig", () => {
  it("outputs valid JSON with both config keys", () => {
    const detection: DetectionResult = {
      ci: "github-actions",
      testCommand: "bun test",
      mux: "cmux",
      aiTools: ["claude"],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);
    const parsed = JSON.parse(config);

    expect(parsed.review_external).toBe(false);
    expect(parsed.schedule_enabled).toBe(false);
  });

  it("does not include dead config keys", () => {
    const detection: DetectionResult = {
      ci: "github-actions",
      testCommand: "bun test",
      mux: "cmux",
      aiTools: ["claude", "opencode"],
      repoType: "monorepo",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);
    const parsed = JSON.parse(config);

    // Dead keys should not appear
    expect(parsed).not.toHaveProperty("ci_provider");
    expect(parsed).not.toHaveProperty("test_command");
    expect(parsed).not.toHaveProperty("MUX");
    expect(parsed).not.toHaveProperty("REPO_TYPE");
    expect(parsed).not.toHaveProperty("AI_TOOLS");
    expect(parsed).not.toHaveProperty("LOC_EXTENSIONS");
    expect(parsed).not.toHaveProperty("github_token");

    // Only known keys
    expect(Object.keys(parsed)).toEqual(["review_external", "schedule_enabled"]);
  });

  it("produces pretty-printed JSON ending with newline", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: null,
      aiTools: [],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);

    // Pretty-printed with 2-space indent
    expect(config).toContain("  ");
    // Ends with newline
    expect(config.endsWith("\n")).toBe(true);
  });
});

// --- detectObservabilityBackends ---

describe("detectObservabilityBackends", () => {
  it("detects Sentry when SENTRY_AUTH_TOKEN is set", () => {
    const deps: InitDeps = {
      getEnv: (key: string) =>
        key === "SENTRY_AUTH_TOKEN" ? "test-token" : undefined,
    };

    const result = detectObservabilityBackends(deps);

    expect(result).toEqual(["sentry"]);
  });

  it("detects PagerDuty when PAGERDUTY_API_TOKEN is set", () => {
    const deps: InitDeps = {
      getEnv: (key: string) =>
        key === "PAGERDUTY_API_TOKEN" ? "test-token" : undefined,
    };

    const result = detectObservabilityBackends(deps);

    expect(result).toEqual(["pagerduty"]);
  });

  it("detects both Sentry and PagerDuty", () => {
    const deps: InitDeps = {
      getEnv: (key: string) => {
        if (key === "SENTRY_AUTH_TOKEN") return "sentry-token";
        if (key === "PAGERDUTY_API_TOKEN") return "pd-token";
        return undefined;
      },
    };

    const result = detectObservabilityBackends(deps);

    expect(result).toEqual(["sentry", "pagerduty"]);
  });

  it("returns empty array when no observability env vars are set", () => {
    const deps: InitDeps = {
      getEnv: () => undefined,
    };

    const result = detectObservabilityBackends(deps);

    expect(result).toEqual([]);
  });
});

// --- generateConfig with observability backends ---

describe("generateConfig observability", () => {
  it("omits observability config keys", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: null,
      aiTools: [],
      repoType: "single",
      observabilityBackends: ["sentry", "pagerduty"],
      workspace: null,
    };

    const config = generateConfig(detection);
    const parsed = JSON.parse(config);

    expect(parsed).not.toHaveProperty("sentry_org");
    expect(parsed).not.toHaveProperty("pagerduty_service_id");
  });
});

// --- detectAll ---

describe("detectAll", () => {
  it("includes observabilityBackends when env vars are set", () => {
    const projectDir = setupTempRepo();
    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: (key: string) => {
        if (key === "SENTRY_AUTH_TOKEN") return "token";
        if (key === "PAGERDUTY_API_TOKEN") return "token";
        return undefined;
      },
    };

    const result = detectAll(projectDir, deps);

    expect(result.observabilityBackends).toEqual(["sentry", "pagerduty"]);
  });

  it("returns empty observabilityBackends when no env vars set", () => {
    const projectDir = setupTempRepo();
    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const result = detectAll(projectDir, deps);

    expect(result.observabilityBackends).toEqual([]);
  });
});

// --- initProject (integration) ---

describe("initProject", () => {
  it("writes .ninthwave/config.json with JSON content", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Create GitHub Actions workflow so CI is detected
    const workflowsDir = join(projectDir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "ci.yml"), "name: CI\n");

    // Create package.json with test script
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );

    const deps: InitDeps = {
      commandExists: ((cmd: string) =>
        cmd === "cmux" || cmd === "gh") as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const config = readFileSync(
      join(projectDir, ".ninthwave/config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(config);
    expect(parsed.review_external).toBe(false);
    expect(parsed.schedule_enabled).toBe(false);
    expect(parsed).not.toHaveProperty("ai_tools");
    expect(Object.keys(parsed)).toEqual(["review_external", "schedule_enabled"]);
  });

  it("creates a full working setup on a fresh repo", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const detection = initProject(projectDir, bundleDir, deps);

    // Config written
    expect(existsSync(join(projectDir, ".ninthwave/config.json"))).toBe(true);

    // Scaffolding completed
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/.gitignore"))).toBe(true);
    expect(existsSync(join(userStateDir(projectDir), "version"))).toBe(true);

    // Init should NOT create TODOS.md
    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(false);

    // Skills copied (real directories, not symlinks)
    for (const skill of ["work", "decompose"]) {
      const skillPath = join(projectDir, ".claude/skills", skill);
      expect(existsSync(skillPath)).toBe(true);
      expect(lstatSync(skillPath).isSymbolicLink()).toBe(false);
      expect(lstatSync(skillPath).isDirectory()).toBe(true);
    }

    // Agents copied
    expect(
      existsSync(join(projectDir, ".claude/agents/implementer.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".opencode/agents/implementer.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".github/agents/ninthwave-implementer.agent.md")),
    ).toBe(true);
    expect(readFileSync(join(projectDir, ".claude/agents/implementer.md"), "utf-8")).toContain(
      "set the timeout to the longest practical value available",
    );
    expect(readFileSync(join(projectDir, ".claude/agents/implementer.md"), "utf-8")).toContain(
      "immediately run the same wait command again",
    );

    // Detection result returned
    expect(detection).toBeDefined();
    expect(detection.mux).toBeNull();
  });

  it("does not abort when no multiplexer is available", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // Should NOT throw -- init never aborts on missing tools
    const detection = initProject(projectDir, bundleDir, deps);

    expect(detection.mux).toBeNull();
    // Setup still completed
    expect(existsSync(join(projectDir, ".ninthwave/config.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);
  });

  it("creates .ninthwave/work/ and .ninthwave/friction/ with .gitkeep files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // Both directories exist
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction"))).toBe(true);

    // .gitkeep files exist in both
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);

    // .gitkeep files are empty
    expect(readFileSync(join(projectDir, ".ninthwave/work/.gitkeep"), "utf-8")).toBe("");
    expect(readFileSync(join(projectDir, ".ninthwave/friction/.gitkeep"), "utf-8")).toBe("");
  });

  it("overwrites .ninthwave/config.json with fresh detection (init is authoritative)", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create config.json with old values
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/config.json"),
      JSON.stringify({ review_external: true, schedule_enabled: true }),
    );

    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "cmux") as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const config = JSON.parse(readFileSync(
      join(projectDir, ".ninthwave/config.json"),
      "utf-8",
    ));
    // Should reflect fresh defaults (init always writes defaults)
    expect(config.review_external).toBe(false);
    expect(config.schedule_enabled).toBe(false);
  });

  it("prints detection summary to console", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");
    const workflowsDir = join(projectDir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "ci.yml"), "name: CI\n");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "cmux") as CommandChecker,
      getEnv: () => undefined,
    };

    try {
      initProject(projectDir, bundleDir, deps);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Detected:");
    expect(output).toContain("github-actions");
    expect(output).toContain("cmux");
    expect(output).toContain("Done!");
  });
});

// --- initProject symlink gitignore entries ---

describe("initProject -- .ninthwave/.gitignore", () => {
  it("creates deny-by-default .gitignore inside .ninthwave/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(join(projectDir, ".ninthwave", ".gitignore"), "utf-8");
    expect(content).toContain("*");
    expect(content).toContain("!config.json");
    expect(content).toContain("!work/");
    expect(content).toContain("!schedules/");
  });

  it("does NOT add symlink directories when projectDir equals bundleDir (self-hosting)", () => {
    const projectDir = setupTempRepo();

    // Set up bundle structure inside projectDir to simulate self-hosting
    for (const skill of ["work", "decompose"]) {
      const skillDir = join(projectDir, "skills", skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
    }
    mkdirSync(join(projectDir, "agents"), { recursive: true });
    writeFileSync(join(projectDir, "agents", "implementer.md"), "# Implementer\n");

    // Initialize the projectDir as a git repo for version tracking
    const { spawnSync } = require("child_process");
    spawnSync("git", ["-C", projectDir, "add", "."]);
    spawnSync("git", ["-C", projectDir, "commit", "-m", "init", "--quiet"]);

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, projectDir, deps);

    // Root .gitignore should NOT be created (ninthwave no longer modifies it)
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(false);
    // .ninthwave/.gitignore should exist with deny-by-default pattern
    const nwGitignore = readFileSync(join(projectDir, ".ninthwave", ".gitignore"), "utf-8");
    expect(nwGitignore).toContain("*");
    expect(nwGitignore).toContain("!config.json");
  });

  it("does not duplicate .ninthwave/.gitignore on re-run", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // Run init twice
    initProject(projectDir, bundleDir, deps);
    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(join(projectDir, ".ninthwave", ".gitignore"), "utf-8");
    // Should only have one deny-by-default block (not duplicated)
    const matches = content.match(/\*/g);
    expect(matches!.length).toBeGreaterThanOrEqual(1);
  });
});

// --- parsePnpmWorkspaceYaml ---

describe("parsePnpmWorkspaceYaml", () => {
  it("parses basic packages list", () => {
    const yaml = "packages:\n  - packages/*\n  - apps/*\n";
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(["packages/*", "apps/*"]);
  });

  it("handles quoted values", () => {
    const yaml = "packages:\n  - 'packages/*'\n  - \"apps/*\"\n";
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(["packages/*", "apps/*"]);
  });

  it("skips comments and blank lines", () => {
    const yaml = "packages:\n  # comment\n\n  - packages/*\n";
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(["packages/*"]);
  });

  it("stops at next top-level key", () => {
    const yaml = "packages:\n  - packages/*\ncatalog:\n  react: ^18\n";
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual(["packages/*"]);
  });

  it("returns empty array for no packages section", () => {
    const yaml = "something_else:\n  - foo\n";
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual([]);
  });
});

// --- pickTestScript ---

describe("pickTestScript", () => {
  it("prefers test:ci over test", () => {
    expect(pickTestScript({ test: "jest", "test:ci": "jest --ci" })).toBe("test:ci");
  });

  it("falls back to test when no test:ci", () => {
    expect(pickTestScript({ test: "vitest" })).toBe("test");
  });

  it("finds first script containing 'test' when no test or test:ci", () => {
    expect(pickTestScript({ build: "tsc", "test:unit": "vitest run" })).toBe("test:unit");
  });

  it("returns null when no scripts", () => {
    expect(pickTestScript(undefined)).toBeNull();
  });

  it("returns null when no test-related scripts", () => {
    expect(pickTestScript({ build: "tsc", lint: "eslint" })).toBeNull();
  });
});

// --- formatTestCommand ---

describe("formatTestCommand", () => {
  it("formats pnpm test command", () => {
    expect(formatTestCommand("pnpm", "api", "packages/api", "test")).toBe(
      "pnpm test --filter api",
    );
  });

  it("formats pnpm custom script command", () => {
    expect(formatTestCommand("pnpm", "api", "packages/api", "test:ci")).toBe(
      "pnpm run test:ci --filter api",
    );
  });

  it("formats yarn test command", () => {
    expect(formatTestCommand("yarn", "web", "packages/web", "test")).toBe(
      "yarn workspace web test",
    );
  });

  it("formats yarn custom script command", () => {
    expect(formatTestCommand("yarn", "web", "packages/web", "test:ci")).toBe(
      "yarn workspace web run test:ci",
    );
  });

  it("formats npm test command", () => {
    expect(formatTestCommand("npm", "lib", "packages/lib", "test")).toBe(
      "npm test -w packages/lib",
    );
  });

  it("formats npm custom script command", () => {
    expect(formatTestCommand("npm", "lib", "packages/lib", "test:ci")).toBe(
      "npm run test:ci -w packages/lib",
    );
  });
});

// --- resolveWorkspaceGlobs ---

describe("resolveWorkspaceGlobs", () => {
  it("resolves packages/* glob to directories with package.json", () => {
    const projectDir = setupTempRepo();
    const pkgsDir = join(projectDir, "packages");
    mkdirSync(join(pkgsDir, "api"), { recursive: true });
    mkdirSync(join(pkgsDir, "web"), { recursive: true });
    writeFileSync(
      join(pkgsDir, "api", "package.json"),
      JSON.stringify({ name: "@mono/api", scripts: { test: "jest" } }),
    );
    writeFileSync(
      join(pkgsDir, "web", "package.json"),
      JSON.stringify({ name: "@mono/web", scripts: { "test:ci": "vitest --ci" } }),
    );

    const result = resolveWorkspaceGlobs(projectDir, ["packages/*"], "pnpm");

    expect(result).toHaveLength(2);
    const api = result.find((p) => p.name === "@mono/api")!;
    expect(api.path).toBe("packages/api");
    expect(api.testCmd).toBe("pnpm test --filter @mono/api");
    const web = result.find((p) => p.name === "@mono/web")!;
    expect(web.path).toBe("packages/web");
    expect(web.testCmd).toBe("pnpm run test:ci --filter @mono/web");
  });

  it("skips negation patterns", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "api", "package.json"),
      JSON.stringify({ name: "api" }),
    );

    const result = resolveWorkspaceGlobs(
      projectDir,
      ["packages/*", "!packages/api"],
      "pnpm",
    );

    // api is still included because we skip negation rather than filtering
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no directories match", () => {
    const projectDir = setupTempRepo();
    const result = resolveWorkspaceGlobs(projectDir, ["packages/*"], "pnpm");
    expect(result).toEqual([]);
  });

  it("skips directories without package.json", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "packages", "no-pkg"), { recursive: true });
    writeFileSync(join(projectDir, "packages", "no-pkg", "README.md"), "");

    const result = resolveWorkspaceGlobs(projectDir, ["packages/*"], "pnpm");
    expect(result).toEqual([]);
  });

  it("handles multiple globs", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "packages", "lib"), { recursive: true });
    mkdirSync(join(projectDir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "lib", "package.json"),
      JSON.stringify({ name: "lib", scripts: { test: "jest" } }),
    );
    writeFileSync(
      join(projectDir, "apps", "web", "package.json"),
      JSON.stringify({ name: "web", scripts: { test: "vitest" } }),
    );

    const result = resolveWorkspaceGlobs(
      projectDir,
      ["packages/*", "apps/*"],
      "yarn",
    );

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.name)).toEqual(
      expect.arrayContaining(["lib", "web"]),
    );
  });

  it("deduplicates packages across overlapping globs", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "api", "package.json"),
      JSON.stringify({ name: "api" }),
    );

    const result = resolveWorkspaceGlobs(
      projectDir,
      ["packages/*", "packages/*"],
      "pnpm",
    );

    expect(result).toHaveLength(1);
  });

  it("uses directory name when package.json has no name field", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "packages", "unnamed"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "unnamed", "package.json"),
      JSON.stringify({ scripts: { test: "jest" } }),
    );

    const result = resolveWorkspaceGlobs(projectDir, ["packages/*"], "pnpm");

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("unnamed");
  });

  it("sets empty testCmd when package has no test scripts", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "packages", "no-test"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "no-test", "package.json"),
      JSON.stringify({ name: "no-test", scripts: { build: "tsc" } }),
    );

    const result = resolveWorkspaceGlobs(projectDir, ["packages/*"], "pnpm");

    expect(result).toHaveLength(1);
    expect(result[0]!.testCmd).toBe("");
  });

  it("handles literal path (no wildcard)", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, "special"), { recursive: true });
    writeFileSync(
      join(projectDir, "special", "package.json"),
      JSON.stringify({ name: "special", scripts: { test: "jest" } }),
    );

    const result = resolveWorkspaceGlobs(projectDir, ["special"], "npm");

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("special");
    expect(result[0]!.testCmd).toBe("npm test -w special");
  });
});

// --- detectWorkspace ---

describe("detectWorkspace", () => {
  it("returns null for single-package repo", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "my-app", scripts: { test: "jest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).toBeNull();
  });

  it("detects pnpm workspace from pnpm-workspace.yaml", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "api", "package.json"),
      JSON.stringify({ name: "@mono/api", scripts: { test: "vitest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("pnpm");
    expect(result!.root).toBe(".");
    expect(result!.packages).toHaveLength(1);
    expect(result!.packages[0]!.name).toBe("@mono/api");
    expect(result!.packages[0]!.path).toBe("packages/api");
    expect(result!.packages[0]!.testCmd).toBe("pnpm test --filter @mono/api");
  });

  it("detects yarn workspaces from package.json + yarn.lock", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(projectDir, "yarn.lock"), "");
    mkdirSync(join(projectDir, "packages", "ui"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "ui", "package.json"),
      JSON.stringify({ name: "@mono/ui", scripts: { test: "jest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("yarn");
    expect(result!.packages).toHaveLength(1);
    expect(result!.packages[0]!.testCmd).toBe("yarn workspace @mono/ui test");
  });

  it("detects npm workspaces when no yarn.lock", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    mkdirSync(join(projectDir, "packages", "core"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "core", "package.json"),
      JSON.stringify({ name: "core", scripts: { test: "jest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("npm");
    expect(result!.packages[0]!.testCmd).toBe("npm test -w packages/core");
  });

  it("detects turborepo via turbo.json", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writeFileSync(
      join(projectDir, "turbo.json"),
      JSON.stringify({ pipeline: { build: {} } }),
    );
    mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "api", "package.json"),
      JSON.stringify({ name: "api", scripts: { test: "vitest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("turborepo");
    expect(result!.packages[0]!.testCmd).toBe("pnpm test --filter api");
  });

  it("detects turborepo via package.json turbo field", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        workspaces: ["packages/*"],
        turbo: { pipeline: { build: {} } },
      }),
    );
    writeFileSync(join(projectDir, "yarn.lock"), "");
    mkdirSync(join(projectDir, "packages", "web"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "web", "package.json"),
      JSON.stringify({ name: "web", scripts: { test: "jest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("turborepo");
  });

  it("prefers test:ci over test for package test commands", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "api", "package.json"),
      JSON.stringify({
        name: "api",
        scripts: { test: "vitest", "test:ci": "vitest run --ci" },
      }),
    );

    const result = detectWorkspace(projectDir);

    expect(result!.packages[0]!.testCmd).toBe("pnpm run test:ci --filter api");
  });

  it("returns null when workspace globs match no packages", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );

    const result = detectWorkspace(projectDir);

    expect(result).toBeNull();
  });

  it("detects only first level (no nested workspace recursion)", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    mkdirSync(join(projectDir, "packages", "outer", "nested"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "outer", "package.json"),
      JSON.stringify({
        name: "outer",
        workspaces: ["nested/*"],
        scripts: { test: "jest" },
      }),
    );
    writeFileSync(
      join(projectDir, "packages", "outer", "nested", "package.json"),
      JSON.stringify({ name: "inner", scripts: { test: "jest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result!.packages).toHaveLength(1);
    expect(result!.packages[0]!.name).toBe("outer");
  });

  it("handles yarn workspaces object format", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        workspaces: { packages: ["packages/*"] },
      }),
    );
    writeFileSync(join(projectDir, "yarn.lock"), "");
    mkdirSync(join(projectDir, "packages", "lib"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "lib", "package.json"),
      JSON.stringify({ name: "lib", scripts: { test: "jest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("yarn");
    expect(result!.packages).toHaveLength(1);
  });

  it("detects pnpm from pnpm-lock.yaml when package.json has workspaces", () => {
    const projectDir = setupTempRepo();
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(projectDir, "pnpm-lock.yaml"), "");
    mkdirSync(join(projectDir, "packages", "core"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "core", "package.json"),
      JSON.stringify({ name: "core", scripts: { test: "vitest" } }),
    );

    const result = detectWorkspace(projectDir);

    expect(result).not.toBeNull();
    expect(result!.tool).toBe("pnpm");
  });
});

// --- initProject config.json ---

describe("initProject config.json", () => {
  it("writes .ninthwave/config.json with project settings", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJsonPath = join(projectDir, ".ninthwave/config.json");
    expect(existsSync(configJsonPath)).toBe(true);

    const configJson = JSON.parse(readFileSync(configJsonPath, "utf-8"));
    expect(configJson.review_external).toBe(false);
    expect(configJson.schedule_enabled).toBe(false);
    expect(configJson).not.toHaveProperty("ai_tools");
    // No workspace data in config.json
    expect(configJson).not.toHaveProperty("workspace");
  });

  it("config.json round-trips correctly", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJsonPath = join(projectDir, ".ninthwave/config.json");
    const written = readFileSync(configJsonPath, "utf-8");
    const parsed = JSON.parse(written);
    const rewritten = JSON.stringify(parsed, null, 2) + "\n";

    expect(rewritten).toBe(written);
  });

  it("config.json does not contain workspace data", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(projectDir, "yarn.lock"), "");
    writeFileSync(
      join(projectDir, "turbo.json"),
      JSON.stringify({ pipeline: {} }),
    );
    mkdirSync(join(projectDir, "packages", "app"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "app", "package.json"),
      JSON.stringify({ name: "app", scripts: { test: "jest" } }),
    );

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJson = JSON.parse(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    // Workspace data is no longer written to config.json
    expect(configJson).not.toHaveProperty("workspace");
    expect(Object.keys(configJson)).toEqual(["review_external", "schedule_enabled"]);
  });
});

// --- Merged setup functionality (migrated from setup.test.ts) ---

/**
 * Stub deps where all prerequisites are present and authenticated.
 * Used for initProject opts to avoid host-machine dependencies.
 */
const allPresentDeps: InitProjectOpts = {
  commandExists: (() => true) as CommandChecker,
  ghAuthCheck: (() => ({
    authenticated: true,
    stderr: "",
  })) as AuthChecker,
};

const defaultInitDeps: InitDeps = {
  commandExists: (() => true) as CommandChecker,
  getEnv: () => undefined,
};

// --- Prerequisite checks warn instead of die ---

describe("initProject -- prerequisite checking", () => {
  it("warns but does not abort when prerequisites are missing", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // Should NOT throw -- init warns but never aborts on missing tools
    const detection = initProject(projectDir, bundleDir, deps);

    // Setup still completed
    expect(existsSync(join(projectDir, ".ninthwave/config.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);
    expect(detection).toBeDefined();
  });

  it("prints prerequisite check output", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "gh") as CommandChecker,
      getEnv: () => undefined,
    };

    try {
      initProject(projectDir, bundleDir, deps);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Checking prerequisites");
    expect(output).toContain("gh");
  });

  it("uses opts.commandExists for prerequisite checks", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const opts: InitProjectOpts = {
      commandExists: (() => true) as CommandChecker,
      ghAuthCheck: (() => ({ authenticated: true, stderr: "" })) as AuthChecker,
    };

    // opts.commandExists overrides deps.commandExists for prerequisites
    const detection = initProject(projectDir, bundleDir, deps, opts);

    expect(detection).toBeDefined();
    expect(existsSync(join(projectDir, ".ninthwave/config.json"))).toBe(true);
  });
});

// --- Agent selection ---

describe("initProject -- agent selection", () => {
  it("installs all agents to all tool dirs by default", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // All agents should be in all tool dirs
    expect(existsSync(join(projectDir, ".claude/agents/implementer.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode/agents/implementer.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github/agents/ninthwave-implementer.agent.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude/agents/reviewer.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode/agents/reviewer.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github/agents/ninthwave-reviewer.agent.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude/agents/rebaser.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode/agents/rebaser.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github/agents/ninthwave-rebaser.agent.md"))).toBe(true);
  });

  it("installs newly discovered bundle agents by default", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(join(bundleDir, "agents", "custom-agent.md"), "# Custom Agent\n");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    expect(existsSync(join(projectDir, ".claude/agents/custom-agent.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode/agents/custom-agent.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github/agents/ninthwave-custom-agent.agent.md"))).toBe(true);
  });

  it("uses opts.agentSelection when provided", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const opts: InitProjectOpts = {
      agentSelection: {
        agents: ["implementer.md"],
        toolDirs: [AGENT_TARGET_DIRS[0]!], // .claude/agents only
      },
    };

    initProject(projectDir, bundleDir, deps, opts);

    // Should have implementer in .claude/agents
    expect(existsSync(join(projectDir, ".claude/agents/implementer.md"))).toBe(true);

    // Should NOT have agents in other tool dirs
    expect(existsSync(join(projectDir, ".opencode/agents/implementer.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github/agents/ninthwave-implementer.agent.md"))).toBe(false);

    // Should NOT have reviewer
    expect(existsSync(join(projectDir, ".claude/agents/reviewer.md"))).toBe(false);
  });

  it("installs no agents when selection is empty", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const opts: InitProjectOpts = {
      agentSelection: { agents: [], toolDirs: [] },
    };

    initProject(projectDir, bundleDir, deps, opts);

    // No agent directories should be created
    expect(existsSync(join(projectDir, ".claude/agents"))).toBe(false);
    expect(existsSync(join(projectDir, ".opencode/agents"))).toBe(false);
    expect(existsSync(join(projectDir, ".github/agents"))).toBe(false);

    // But skills should still be set up
    expect(existsSync(join(projectDir, ".claude/skills/work"))).toBe(true);
  });

  it("creates agent files as copies, not symlinks", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // All agent files should be regular files (copies), not symlinks
    for (const agent of AGENT_SOURCES) {
      const baseName = agent.replace(/\.md$/, "");
      for (const target of AGENT_TARGET_DIRS) {
        const filename = target.suffix === ".agent.md" ? `ninthwave-${baseName}.agent.md` : agent;
        const filePath = join(projectDir, target.dir, filename);
        expect(lstatSync(filePath).isFile()).toBe(true);
        expect(lstatSync(filePath).isSymbolicLink()).toBe(false);
      }
    }
  });
});

// --- nw symlink ---

describe("initProject -- nw symlink", () => {
  it("creates nw symlink via opts.resolveCommandPath", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Create a fake bin directory with a ninthwave binary
    const fakeBin = join(projectDir, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "ninthwave"), "#!/bin/sh\n");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const opts: InitProjectOpts = {
      commandExists: ((cmd: string) =>
        cmd === "nw" ? false : true) as CommandChecker,
      resolveCommandPath: ((cmd: string) =>
        cmd === "ninthwave"
          ? join(fakeBin, "ninthwave")
          : null) as CommandPathResolver,
    };

    initProject(projectDir, bundleDir, deps, opts);

    // Verify nw symlink was created
    expect(existsSync(join(fakeBin, "nw"))).toBe(true);
    expect(lstatSync(join(fakeBin, "nw")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fakeBin, "nw"))).toBe("ninthwave");
  });

  it("prints CLI alias section in output", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    try {
      initProject(projectDir, bundleDir, deps);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("CLI alias");
    expect(output).toContain("Tip:");
    expect(output).toContain("nw");
  });
});

// --- --global mode ---

describe("initProject -- global mode", () => {
  it("setupGlobal creates managed skill copies in ~/.claude/skills/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Use a temp directory as HOME
    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);

    const skillsDir = join(fakeHome, ".claude/skills");
    for (const skill of [
      "work",
      "decompose",
  
    ]) {
      const linkPath = join(skillsDir, skill);
      expect(existsSync(linkPath)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
      expect(lstatSync(linkPath).isDirectory()).toBe(true);
      expect(existsSync(join(linkPath, "SKILL.md"))).toBe(true);
    }
  });

  it("setupGlobal does not create project-level artifacts", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);

    // No project-level artifacts
    expect(existsSync(join(fakeHome, ".ninthwave"))).toBe(false);
    expect(existsSync(join(fakeHome, ".ninthwave/work"))).toBe(false);
    expect(existsSync(join(fakeHome, ".claude/agents"))).toBe(false);
  });

  it("setupGlobal refreshes stale managed skill files on rerun", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);
    writeFileSync(join(fakeHome, ".claude/skills", "work", "SKILL.md"), "# stale\n");

    setupGlobal(bundleDir);

    expect(readFileSync(join(fakeHome, ".claude/skills", "work", "SKILL.md"), "utf-8")).toBe(
      "# work\n",
    );
  });
});

// --- nw setup is no longer a valid command ---

describe("setup command removal", () => {
  it("'setup' is not in the command registry", () => {
    const entry = lookupCommand("setup");
    expect(entry).toBeUndefined();
  });

  it("'init' is in the command registry with --global flag", () => {
    const entry = lookupCommand("init");
    expect(entry).toBeDefined();
    expect("--global" in entry!.flags).toBe(true);
    expect("--yes" in entry!.flags).toBe(true);
  });
});

// --- Merged flow: idempotency ---

describe("initProject -- idempotency", () => {
  it("running init twice produces consistent result (steady state)", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // First run creates directories that are detected on second run (expected)
    initProject(projectDir, bundleDir, deps);

    // Second run reaches steady state (agent dirs already exist → detected as AI tools)
    initProject(projectDir, bundleDir, deps);

    // Capture steady state
    const steadyConfig = readFileSync(
      join(projectDir, ".ninthwave/config.json"),
      "utf-8",
    );
    const steadyGitignore = readFileSync(
      join(projectDir, ".ninthwave", ".gitignore"),
      "utf-8",
    );

    // Third run should match steady state
    initProject(projectDir, bundleDir, deps);

    // Verify state is identical to second run
    expect(readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8")).toBe(
      steadyConfig,
    );
    expect(readFileSync(join(projectDir, ".ninthwave", ".gitignore"), "utf-8")).toBe(
      steadyGitignore,
    );

    // Skills still present as real directories
    for (const skill of [
      "work",
      "decompose",
  
    ]) {
      const skillPath = join(projectDir, ".claude/skills", skill);
      expect(lstatSync(skillPath).isDirectory()).toBe(true);
      expect(lstatSync(skillPath).isSymbolicLink()).toBe(false);
    }

    // Agent files still present as real files
    for (const agent of AGENT_SOURCES) {
      const filePath = join(projectDir, ".claude/agents", agent);
      expect(lstatSync(filePath).isFile()).toBe(true);
      expect(lstatSync(filePath).isSymbolicLink()).toBe(false);
    }
  });

  it("does not duplicate .ninthwave/.gitignore on re-run", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // Run init twice
    initProject(projectDir, bundleDir, deps);
    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(join(projectDir, ".ninthwave", ".gitignore"), "utf-8");
    // Should only have one deny-by-default block (not duplicated)
    const matches = content.match(/\*/g);
    expect(matches!.length).toBeGreaterThanOrEqual(1);
  });

  it("refreshes stale managed skill and agent outputs on rerun", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    writeFileSync(join(projectDir, ".claude/skills", "work", "SKILL.md"), "# stale skill\n");
    writeFileSync(join(projectDir, ".claude/agents", "implementer.md"), "# stale agent\n");

    initProject(projectDir, bundleDir, deps);

    expect(readFileSync(join(projectDir, ".claude/skills", "work", "SKILL.md"), "utf-8")).toBe(
      "# work\n",
    );
    expect(readFileSync(join(projectDir, ".claude/agents", "implementer.md"), "utf-8")).toContain(
      "set the timeout to the longest practical value available",
    );
  });
});

// --- Merged flow: preserves existing files ---

describe("initProject -- preserves existing files", () => {
  it("creates .ninthwave/ directory with config", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // .ninthwave/config.json exists
    expect(existsSync(join(projectDir, ".ninthwave/config.json"))).toBe(true);
  });

  it("creates .ninthwave/work/ directory", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
  });

  it("migrates .ninthwave/todos/ to .ninthwave/work/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Create legacy .ninthwave/todos/ directory with a test file
    const legacyDir = join(projectDir, ".ninthwave", "todos");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, ".gitkeep"), "");
    writeFileSync(join(legacyDir, "1-test--H-MIG-1.md"), "# Test migration (H-MIG-1)\n");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // Legacy directory should be removed
    expect(existsSync(join(projectDir, ".ninthwave/todos"))).toBe(false);

    // New directory should exist with migrated contents
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/work/1-test--H-MIG-1.md"))).toBe(true);
    expect(readFileSync(join(projectDir, ".ninthwave/work/1-test--H-MIG-1.md"), "utf-8")).toBe(
      "# Test migration (H-MIG-1)\n",
    );
  });

  it("copies skill directories into .claude/skills/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    for (const skill of [
      "work",
      "decompose",
  
    ]) {
      const skillPath = join(projectDir, ".claude/skills", skill);
      expect(existsSync(skillPath)).toBe(true);
      expect(lstatSync(skillPath).isSymbolicLink()).toBe(false);
      expect(lstatSync(skillPath).isDirectory()).toBe(true);
      // SKILL.md should be present inside the copied directory
      expect(existsSync(join(skillPath, "SKILL.md"))).toBe(true);
    }
  });

  it("creates .ninthwave/.gitignore with deny-by-default pattern", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const nwGitignore = join(projectDir, ".ninthwave", ".gitignore");
    expect(existsSync(nwGitignore)).toBe(true);
    const content = readFileSync(nwGitignore, "utf-8");
    expect(content).toContain("*");
    expect(content).toContain("!.gitignore");
    expect(content).toContain("!config.json");
    expect(content).toContain("!work/");
    expect(content).toContain("!schedules/");
    expect(content).toContain("!friction/");
  });

  it("does not modify root .gitignore", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create .gitignore with some content
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // Root .gitignore should be untouched
    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n");
  });

  it("creates .ninthwave/schedules/ with example file on fresh init", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // Directory exists
    expect(existsSync(join(projectDir, ".ninthwave/schedules"))).toBe(true);

    // Example file exists with correct format
    const examplePath = join(projectDir, ".ninthwave/schedules/ci--example-daily-audit.md");
    expect(existsSync(examplePath)).toBe(true);

    const content = readFileSync(examplePath, "utf-8");
    expect(content).toContain("# Daily CI Audit");
    expect(content).toContain("**Schedule:**");
    expect(content).toContain("**Priority:**");
    expect(content).toContain("**Domain:**");
    expect(content).toContain("**Timeout:**");
    expect(content).toContain("**Enabled:** false");
  });

  it("does not overwrite existing schedule files on re-init", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // First init -- creates the schedules dir and example
    initProject(projectDir, bundleDir, deps);

    // User creates their own schedule file
    const userSchedule = join(projectDir, ".ninthwave/schedules/deploy--nightly-deploy.md");
    writeFileSync(userSchedule, "# Nightly Deploy\n**Enabled:** true\n");

    // Overwrite the example with custom content
    const examplePath = join(projectDir, ".ninthwave/schedules/ci--example-daily-audit.md");
    writeFileSync(examplePath, "# Custom content\n");

    // Re-init
    initProject(projectDir, bundleDir, deps);

    // User's schedule file is preserved
    expect(existsSync(userSchedule)).toBe(true);
    expect(readFileSync(userSchedule, "utf-8")).toBe("# Nightly Deploy\n**Enabled:** true\n");

    // Example file is NOT overwritten (directory already existed)
    expect(readFileSync(examplePath, "utf-8")).toBe("# Custom content\n");
  });

  it("records version in user state directory", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const stateDir = userStateDir(projectDir);
    expect(existsSync(join(stateDir, "version"))).toBe(true);
    const version = readFileSync(
      join(stateDir, "version"),
      "utf-8",
    );
    // Should have some version string (git describe output)
    expect(version.trim()).toBeTruthy();
    // Version should NOT be in the project's .ninthwave/ directory
    expect(existsSync(join(projectDir, ".ninthwave/version"))).toBe(false);
  });
});
