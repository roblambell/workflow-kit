// Tests for `ninthwave init` command (core/commands/init.ts).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
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
  type DetectionResult,
} from "../core/commands/init.ts";
import type { CommandChecker } from "../core/commands/setup.ts";
import { SYMLINK_GITIGNORE_DIRS } from "../core/commands/setup.ts";

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
    "todo-preview",
    "ninthwave-upgrade",
  ]) {
    const skillDir = join(bundleDir, "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
  }

  // Create agents directory
  mkdirSync(join(bundleDir, "agents"), { recursive: true });
  writeFileSync(
    join(bundleDir, "agents", "todo-worker.md"),
    "# Todo Worker Agent\n",
  );

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
  it("writes detected CI value", () => {
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

    expect(config).toContain("ci_provider=github-actions");
  });

  it("comments out ci_provider when not detected", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: "cmux",
      aiTools: [],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);

    expect(config).toContain("# ci_provider=github-actions");
    expect(config).not.toMatch(/^ci_provider=/m);
  });

  it("writes detected MUX value", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: "cmux",
      aiTools: [],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);

    expect(config).toContain("MUX=cmux");
  });

  it("comments out MUX when not detected", () => {
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

    expect(config).toContain("# MUX=cmux");
    expect(config).not.toMatch(/^MUX=/m);
  });

  it("writes REPO_TYPE", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: null,
      aiTools: [],
      repoType: "monorepo",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);

    expect(config).toContain("REPO_TYPE=monorepo");
  });

  it("writes AI_TOOLS as comma-separated list", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: null,
      aiTools: ["claude", "opencode"],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);

    expect(config).toContain("AI_TOOLS=claude,opencode");
  });

  it("writes test_command when detected", () => {
    const detection: DetectionResult = {
      ci: "github-actions",
      testCommand: "bun test",
      mux: null,
      aiTools: [],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection);

    expect(config).toContain("test_command=bun test");
  });

  it("comments out test_command when not detected", () => {
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

    expect(config).toContain("# test_command=bun test");
    expect(config).not.toMatch(/^test_command=/m);
  });

  it("writes both ci_provider and test_command together", () => {
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

    expect(config).toContain("ci_provider=github-actions");
    expect(config).toContain("test_command=bun test");
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
  it("omits observability config keys (removed in 0.2.0)", () => {
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

    expect(config).not.toContain("sentry_org");
    expect(config).not.toContain("sentry_project");
    expect(config).not.toContain("pagerduty_service_id");
    expect(config).not.toContain("pagerduty_from_email");
    expect(config).not.toContain("Observability backends");
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
  it("writes .ninthwave/config with detected values", () => {
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
      join(projectDir, ".ninthwave/config"),
      "utf-8",
    );
    expect(config).toContain("ci_provider=github-actions");
    expect(config).toContain("test_command=bun test");
    expect(config).toContain("MUX=cmux");
    expect(config).toContain("REPO_TYPE=single");
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
    expect(existsSync(join(projectDir, ".ninthwave/config"))).toBe(true);

    // Scaffolding completed
    expect(existsSync(join(projectDir, ".ninthwave/domains.conf"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/todos/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(userStateDir(projectDir), "version"))).toBe(true);

    // Init should NOT create TODOS.md
    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(false);

    // Skills symlinked
    for (const skill of ["work", "decompose", "todo-preview", "ninthwave-upgrade"]) {
      const linkPath = join(projectDir, ".claude/skills", skill);
      expect(existsSync(linkPath)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }

    // Agents copied
    expect(
      existsSync(join(projectDir, ".claude/agents/todo-worker.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".opencode/agents/todo-worker.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".github/agents/todo-worker.agent.md")),
    ).toBe(true);

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

    // Should NOT throw — init never aborts on missing tools
    const detection = initProject(projectDir, bundleDir, deps);

    expect(detection.mux).toBeNull();
    // Setup still completed
    expect(existsSync(join(projectDir, ".ninthwave/config"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/todos/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);
  });

  it("creates .ninthwave/todos/ and .ninthwave/friction/ with .gitkeep files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    // Both directories exist
    expect(existsSync(join(projectDir, ".ninthwave/todos"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction"))).toBe(true);

    // .gitkeep files exist in both
    expect(existsSync(join(projectDir, ".ninthwave/todos/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);

    // .gitkeep files are empty
    expect(readFileSync(join(projectDir, ".ninthwave/todos/.gitkeep"), "utf-8")).toBe("");
    expect(readFileSync(join(projectDir, ".ninthwave/friction/.gitkeep"), "utf-8")).toBe("");
  });

  it("preserves existing .ninthwave/domains.conf", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create domains config
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "auth=auth\n",
    );

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "utf-8",
    );
    expect(content).toBe("auth=auth\n");
  });

  it("overwrites .ninthwave/config with fresh detection (init is authoritative)", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create config with old values
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/config"),
      "CI=circleci\nMUX=old-value\n",
    );

    // Create GitHub Actions so CI detection finds something
    const workflowsDir = join(projectDir, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "ci.yml"), "name: CI\n");

    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "cmux") as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const config = readFileSync(
      join(projectDir, ".ninthwave/config"),
      "utf-8",
    );
    // Should reflect new detection, not old values
    expect(config).toContain("ci_provider=github-actions");
    expect(config).toContain("MUX=cmux");
    expect(config).not.toContain("circleci");
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

describe("initProject — symlink gitignore entries", () => {
  it("adds symlink directories to .gitignore for non-ninthwave projects", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".claude/agents/");
    expect(content).toContain(".claude/skills/");
    expect(content).toContain(".opencode/agents/");
    expect(content).toContain(".github/agents/");
    expect(content).toContain("ninthwave symlinks");
  });

  it("does NOT add symlink directories when projectDir equals bundleDir (self-hosting)", () => {
    const projectDir = setupTempRepo();

    // Set up bundle structure inside projectDir to simulate self-hosting
    for (const skill of ["work", "decompose", "todo-preview", "ninthwave-upgrade"]) {
      const skillDir = join(projectDir, "skills", skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
    }
    mkdirSync(join(projectDir, "agents"), { recursive: true });
    writeFileSync(join(projectDir, "agents", "todo-worker.md"), "# Todo Worker\n");

    // Initialize the projectDir as a git repo for version tracking
    const { spawnSync } = require("child_process");
    spawnSync("git", ["-C", projectDir, "add", "."]);
    spawnSync("git", ["-C", projectDir, "commit", "-m", "init", "--quiet"]);

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, projectDir, deps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".worktrees/");
    expect(content).not.toContain(".claude/agents/");
    expect(content).not.toContain(".claude/skills/");
    expect(content).not.toContain(".opencode/agents/");
    expect(content).not.toContain(".github/agents/");
  });

  it("does not duplicate symlink gitignore entries on re-run", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // Run init twice
    initProject(projectDir, bundleDir, deps);
    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    for (const dir of SYMLINK_GITIGNORE_DIRS) {
      const matches = content.match(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
      expect(matches).toHaveLength(1);
    }
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

// --- initProject workspace config.json ---

describe("initProject workspace config.json", () => {
  it("writes .ninthwave/config.json for pnpm monorepo", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(
      join(projectDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
    mkdirSync(join(projectDir, "packages", "web"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "api", "package.json"),
      JSON.stringify({ name: "api", scripts: { test: "vitest" } }),
    );
    writeFileSync(
      join(projectDir, "packages", "web", "package.json"),
      JSON.stringify({ name: "web", scripts: { "test:ci": "vitest --ci" } }),
    );

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJsonPath = join(projectDir, ".ninthwave/config.json");
    expect(existsSync(configJsonPath)).toBe(true);

    const configJson = JSON.parse(readFileSync(configJsonPath, "utf-8"));
    expect(configJson.workspace).toBeDefined();
    expect(configJson.workspace.tool).toBe("pnpm");
    expect(configJson.workspace.root).toBe(".");
    expect(configJson.workspace.packages).toHaveLength(2);

    const api = configJson.workspace.packages.find(
      (p: { name: string }) => p.name === "api",
    );
    expect(api.path).toBe("packages/api");
    expect(api.testCmd).toBe("pnpm test --filter api");

    const web = configJson.workspace.packages.find(
      (p: { name: string }) => p.name === "web",
    );
    expect(web.testCmd).toBe("pnpm run test:ci --filter web");
  });

  it("does not write .ninthwave/config.json for single-package repo", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "my-app", scripts: { test: "jest" } }),
    );

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    expect(existsSync(join(projectDir, ".ninthwave/config.json"))).toBe(false);
  });

  it("config.json round-trips correctly", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeFileSync(join(projectDir, "yarn.lock"), "");
    mkdirSync(join(projectDir, "packages", "ui"), { recursive: true });
    writeFileSync(
      join(projectDir, "packages", "ui", "package.json"),
      JSON.stringify({ name: "ui", scripts: { test: "jest" } }),
    );

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

  it("writes config.json for yarn workspaces with turborepo", () => {
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
    expect(configJson.workspace.tool).toBe("turborepo");
    expect(configJson.workspace.packages[0].testCmd).toBe(
      "yarn workspace app test",
    );
  });
});
