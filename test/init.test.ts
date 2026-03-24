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
import {
  detectCI,
  detectMux,
  detectAITools,
  detectRepoType,
  detectAll,
  generateConfig,
  initProject,
  type InitDeps,
  type DetectionResult,
} from "../core/commands/init.ts";
import type { CommandChecker } from "../core/commands/setup.ts";

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
      getEnv: () => undefined,
    };

    const result = detectMux(deps);

    expect(result).toBe("cmux");
  });

  it("detects tmux when binary exists on PATH", () => {
    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "tmux") as CommandChecker,
      getEnv: () => undefined,
    };

    const result = detectMux(deps);

    expect(result).toBe("tmux");
  });

  it("detects tmux when TMUX env var is set", () => {
    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: (key: string) => (key === "TMUX" ? "/tmp/tmux-501/default,12345,0" : undefined),
    };

    const result = detectMux(deps);

    expect(result).toBe("tmux");
  });

  it("prefers cmux over tmux when both are available", () => {
    const deps: InitDeps = {
      commandExists: (() => true) as CommandChecker,
      getEnv: () => "/tmp/tmux",
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

// --- generateConfig ---

describe("generateConfig", () => {
  it("writes detected CI value", () => {
    const detection: DetectionResult = {
      ci: "github-actions",
      mux: "cmux",
      aiTools: ["claude"],
      repoType: "single",
    };

    const config = generateConfig(detection);

    expect(config).toContain("CI=github-actions");
  });

  it("comments out CI when not detected", () => {
    const detection: DetectionResult = {
      ci: null,
      mux: "cmux",
      aiTools: [],
      repoType: "single",
    };

    const config = generateConfig(detection);

    expect(config).toContain("# CI=github-actions");
    expect(config).not.toMatch(/^CI=/m);
  });

  it("writes detected MUX value", () => {
    const detection: DetectionResult = {
      ci: null,
      mux: "tmux",
      aiTools: [],
      repoType: "single",
    };

    const config = generateConfig(detection);

    expect(config).toContain("MUX=tmux");
  });

  it("comments out MUX when not detected", () => {
    const detection: DetectionResult = {
      ci: null,
      mux: null,
      aiTools: [],
      repoType: "single",
    };

    const config = generateConfig(detection);

    expect(config).toContain("# MUX=cmux");
    expect(config).not.toMatch(/^MUX=/m);
  });

  it("writes REPO_TYPE", () => {
    const detection: DetectionResult = {
      ci: null,
      mux: null,
      aiTools: [],
      repoType: "monorepo",
    };

    const config = generateConfig(detection);

    expect(config).toContain("REPO_TYPE=monorepo");
  });

  it("writes AI_TOOLS as comma-separated list", () => {
    const detection: DetectionResult = {
      ci: null,
      mux: null,
      aiTools: ["claude", "opencode"],
      repoType: "single",
    };

    const config = generateConfig(detection);

    expect(config).toContain("AI_TOOLS=claude,opencode");
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
    expect(config).toContain("CI=github-actions");
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
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/domains.conf"))).toBe(true);
    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/version"))).toBe(true);

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
    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(true);
  });

  it("preserves existing TODOS.md", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create TODOS.md
    writeFileSync(join(projectDir, "TODOS.md"), "# My Project\n\n- Task 1\n");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(join(projectDir, "TODOS.md"), "utf-8");
    expect(content).toContain("My Project");
    expect(content).toContain("Task 1");
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
      "CI=circleci\nMUX=tmux\n",
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
    expect(config).toContain("CI=github-actions");
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
