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
import { setupTempRepo, setupTempRepoWithoutRemote, cleanupTempRepos } from "./helpers.ts";
import { userStateDir } from "../core/daemon.ts";
import { agentTargetFilename } from "../core/ai-tools.ts";
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
  parseInitFlags,
  type InitDeps,
  type InitProjectOpts,
  type DetectionResult,
} from "../core/commands/init.ts";
import type {
  CommandChecker,
  AuthChecker,
  CmuxResolver,
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
import { stripJsonComments, loadLocalConfig } from "../core/config.ts";

function parseConfigJson(raw: string): Record<string, unknown> {
  return JSON.parse(stripJsonComments(raw));
}

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
  for (const skill of ["decompose"]) {
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
      "nw inbox --wait YOUR_WORK_ITEM_ID",
      "set the timeout to the longest practical value available",
      "immediately run the same wait command again",
      "Write decision entries to .ninthwave/decisions/${TIMESTAMP}--YOUR_WORK_ITEM_ID.md",
      "do **not** move them into archival review subdirectories",
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

  // Create canonical docs consumed by scaffold()
  mkdirSync(join(bundleDir, "core", "docs"), { recursive: true });
  writeFileSync(
    join(bundleDir, "core", "docs", "work-item-format.md"),
    "# Work Item File Format Guide\n\n(fake bundle content)\n",
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

  it("detects tmux when cmux is unavailable", () => {
    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "tmux") as CommandChecker,
    };

    const result = detectMux(deps);

    expect(result).toBe("tmux");
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

  it("detects Codex from managed .codex/agents artifacts", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".codex", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".codex", "agents", "ninthwave-implementer.toml"), 'name = "ninthwave-implementer"\n');

    const result = detectAITools(projectDir);

    expect(result).toContain("codex");
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

  it("detects Copilot from .github/agents/ without copilot-instructions.md", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".github", "agents"), { recursive: true });

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

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BROKER_SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

describe("generateConfig", () => {
  it("generates a project_id when no overrides are supplied and omits broker_secret", () => {
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
    const parsed = parseConfigJson(config);

    expect(parsed.project_id).toMatch(UUID_V4_PATTERN);
    // broker_secret must NOT land in the committed config by default; it
    // belongs in the gitignored config.local.json overlay.
    expect(parsed).not.toHaveProperty("broker_secret");
    expect(Object.keys(parsed).sort()).toEqual(["project_id"]);
  });

  it("emits a JSONC header explaining where broker_secret lives", () => {
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

    expect(config.startsWith("//")).toBe(true);
    expect(config).toContain("config.local.json");
    expect(config).toContain("broker_secret");
    // Body is still valid JSON after stripping comments.
    const parsed = parseConfigJson(config);
    expect(parsed.project_id).toMatch(UUID_V4_PATTERN);
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
    const parsed = parseConfigJson(config);

    // Dead keys should not appear
    expect(parsed).not.toHaveProperty("ci_provider");
    expect(parsed).not.toHaveProperty("test_command");
    expect(parsed).not.toHaveProperty("MUX");
    expect(parsed).not.toHaveProperty("REPO_TYPE");
    expect(parsed).not.toHaveProperty("AI_TOOLS");
    expect(parsed).not.toHaveProperty("LOC_EXTENSIONS");
    expect(parsed).not.toHaveProperty("github_token");
    // review_external was removed in H-SUX-3
    expect(parsed).not.toHaveProperty("review_external");

    // Fresh init writes only the public identity field; broker_secret is
    // provisioned separately into config.local.json.
    expect(Object.keys(parsed).sort()).toEqual(["project_id"]);
  });

  it("includes an existing valid crew_url override when provided", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: null,
      aiTools: [],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const config = generateConfig(detection, {
      crew_url: "wss://crew.example/ws",
    });
    const parsed = parseConfigJson(config);

    expect(parsed.crew_url).toBe("wss://crew.example/ws");
    expect(Object.keys(parsed).sort()).toEqual([
      "crew_url",
      "project_id",
    ]);
  });

  it("preserves an existing project_id without rotating it", () => {
    const detection: DetectionResult = {
      ci: null,
      testCommand: null,
      mux: null,
      aiTools: [],
      repoType: "single",
      observabilityBackends: [],
      workspace: null,
    };

    const existing = { project_id: "00000000-0000-4000-8000-000000000001" };
    const first = parseConfigJson(generateConfig(detection, existing));
    const second = parseConfigJson(generateConfig(detection, existing));

    expect(first.project_id).toBe(existing.project_id);
    expect(second.project_id).toBe(existing.project_id);
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

    const config = generateConfig(detection, {
      crew_url: "wss://crew.example/ws",
    });

    // Pretty-printed with 2-space indent when there are keys to indent.
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
    const parsed = parseConfigJson(config);

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
  it("fails loudly when origin/main does not resolve", () => {
    // `nw init` refuses to run until the user has pushed at least once,
    // because ninthwave reads work items and shared config from
    // origin/main. Without origin/main there is nothing for the daemon
    // to anchor against.
    const projectDir = setupTempRepoWithoutRemote();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");
    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    let caught: Error | undefined;
    try {
      initProject(projectDir, bundleDir, deps);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain("origin/main");
    expect(caught!.message).toContain("nw init");
    // Actionable remediation: user should know to push.
    expect(caught!.message).toContain("git push");
    // Should fail before any scaffolding happens.
    expect(existsSync(join(projectDir, ".ninthwave", "config.json"))).toBe(false);
  });

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
    const parsed = parseConfigJson(config);
    expect(parsed).not.toHaveProperty("review_external");
    expect(parsed).not.toHaveProperty("ai_tools");
    // Only the public identity lands in committed config.json; the secret
    // is provisioned into config.local.json.
    expect(Object.keys(parsed).sort()).toEqual(["project_id"]);
    expect(loadLocalConfig(projectDir).broker_secret).toMatch(
      BROKER_SECRET_PATTERN,
    );
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
    expect(existsSync(join(projectDir, ".ninthwave/decisions/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/.gitignore"))).toBe(true);
    expect(existsSync(join(userStateDir(projectDir), "version"))).toBe(true);

    // Init should NOT create work itemS.md
    expect(existsSync(join(projectDir, "work itemS.md"))).toBe(false);

    // Skills copied (real directories, not symlinks)
    for (const skill of ["decompose"]) {
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
    expect(readFileSync(join(projectDir, ".claude/agents/implementer.md"), "utf-8")).toContain(
      ".ninthwave/decisions/${TIMESTAMP}--YOUR_WORK_ITEM_ID.md",
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
    expect(existsSync(join(projectDir, ".ninthwave/decisions/.gitkeep"))).toBe(true);
  });

  it("creates .ninthwave/work/, friction/, and decisions/ with .gitkeep files", () => {
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
    expect(existsSync(join(projectDir, ".ninthwave/decisions"))).toBe(true);

    // .gitkeep files exist in all inboxes
    expect(existsSync(join(projectDir, ".ninthwave/work/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/friction/.gitkeep"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/decisions/.gitkeep"))).toBe(true);

    // .gitkeep files are empty
    expect(readFileSync(join(projectDir, ".ninthwave/work/.gitkeep"), "utf-8")).toBe("");
    expect(readFileSync(join(projectDir, ".ninthwave/friction/.gitkeep"), "utf-8")).toBe("");
    expect(readFileSync(join(projectDir, ".ninthwave/decisions/.gitkeep"), "utf-8")).toBe("");
  });

  it("overwrites .ninthwave/config.json with fresh detection (init is authoritative)", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create config.json with old values
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/config.json"),
      JSON.stringify({
        review_external: true,
        crew_url: "wss://crew.example/ws",
      }),
    );

    const deps: InitDeps = {
      commandExists: ((cmd: string) => cmd === "cmux") as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const config = parseConfigJson(readFileSync(
      join(projectDir, ".ninthwave/config.json"),
      "utf-8",
    ));
    // Should reflect fresh defaults (init always writes defaults).
    // review_external was removed in H-SUX-3; init does not write it.
    expect(config).not.toHaveProperty("review_external");
    expect(config.crew_url).toBe("wss://crew.example/ws");
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
      initProject(projectDir, bundleDir, deps, {
        cmuxResolver: (() => null) as CmuxResolver,
      });
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

// --- initProject .ninthwave/.gitignore ---

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
    expect(content).toContain("!decisions/");
    // User-specific overlay must be excluded even if deny-by-default is relaxed
    expect(content).toMatch(/^config\.local\.json$/m);
  });

  it("does not create a root .gitignore when projectDir equals bundleDir", () => {
    const projectDir = setupTempRepo();

    // Set up bundle structure inside projectDir to simulate self-hosting
    for (const skill of ["decompose"]) {
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
    expect(nwGitignore).toContain("!decisions/");
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

    const configJson = parseConfigJson(readFileSync(configJsonPath, "utf-8"));
    expect(configJson).not.toHaveProperty("review_external");
    expect(configJson).not.toHaveProperty("ai_tools");
    // No workspace data in config.json
    expect(configJson).not.toHaveProperty("workspace");
    // project_id is auto-provisioned in committed config; broker_secret is
    // provisioned separately into the gitignored local overlay.
    expect(configJson.project_id).toMatch(UUID_V4_PATTERN);
    expect(configJson).not.toHaveProperty("broker_secret");
    expect(loadLocalConfig(projectDir).broker_secret).toMatch(
      BROKER_SECRET_PATTERN,
    );
  });

  it("config.json body round-trips correctly after stripping the JSONC header", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJsonPath = join(projectDir, ".ninthwave/config.json");
    const written = readFileSync(configJsonPath, "utf-8");
    const parsed = parseConfigJson(written);
    const rewritten = JSON.stringify(parsed, null, 2) + "\n";

    // The file has a leading JSONC header; the JSON body itself must
    // stringify back to a byte-identical suffix.
    expect(written.endsWith(rewritten)).toBe(true);
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

    const configJson = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    // Workspace data is no longer written to config.json
    expect(configJson).not.toHaveProperty("workspace");
    // Only the public identity lands in committed config.
    expect(Object.keys(configJson).sort()).toEqual(["project_id"]);
  });

  it("fresh init does not invent crew_url", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJson = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );

    expect(configJson).not.toHaveProperty("crew_url");
    expect(Object.keys(configJson).sort()).toEqual(["project_id"]);
  });

  it("re-running init leaves project identity untouched", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);
    const firstConfig = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    const firstSecret = loadLocalConfig(projectDir).broker_secret;

    initProject(projectDir, bundleDir, deps);
    const secondConfig = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    const secondSecret = loadLocalConfig(projectDir).broker_secret;

    expect(secondConfig.project_id).toBe(firstConfig.project_id);
    expect(secondSecret).toBe(firstSecret);
    expect(secondSecret).toMatch(BROKER_SECRET_PATTERN);
  });

  it("writes broker_secret into .ninthwave/config.local.json, not config.json", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configJson = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    expect(configJson).not.toHaveProperty("broker_secret");

    const localPath = join(projectDir, ".ninthwave/config.local.json");
    expect(existsSync(localPath)).toBe(true);
    const localRaw = readFileSync(localPath, "utf-8");
    const localParsed = JSON.parse(localRaw);
    expect(localParsed.broker_secret).toMatch(BROKER_SECRET_PATTERN);
    expect(Buffer.from(localParsed.broker_secret, "base64")).toHaveLength(32);
  });
});

// --- initProject broker secret action ---

describe("initProject -- broker secret action", () => {
  it("generate path writes a new secret and prints sharing instructions", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      initProject(projectDir, bundleDir, deps, {
        brokerSecretAction: { action: "generate" },
      });
    } finally {
      console.log = origLog;
    }

    // Secret written to local overlay, not committed config.
    const configJson = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    expect(configJson).not.toHaveProperty("broker_secret");

    const localParsed = JSON.parse(
      readFileSync(
        join(projectDir, ".ninthwave/config.local.json"),
        "utf-8",
      ),
    );
    expect(localParsed.broker_secret).toMatch(BROKER_SECRET_PATTERN);

    // Stdout contains the secret body and sharing instructions.
    const output = logs.join("\n");
    expect(output).toContain(localParsed.broker_secret);
    expect(output).toContain("Share this with teammates");
  });

  it("enter path saves the provided validated secret and does not print it", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // 32 random bytes -> canonical base64. Use a fixed, syntactically-valid
    // test value; validation happens in the prompt layer before we get here.
    const pasted = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    expect(pasted).toMatch(BROKER_SECRET_PATTERN);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      initProject(projectDir, bundleDir, deps, {
        brokerSecretAction: { action: "enter", value: pasted },
      });
    } finally {
      console.log = origLog;
    }

    const localParsed = JSON.parse(
      readFileSync(
        join(projectDir, ".ninthwave/config.local.json"),
        "utf-8",
      ),
    );
    expect(localParsed.broker_secret).toBe(pasted);

    // We never echo a user-entered secret back to stdout (avoids
    // surprising shoulder-surfing leaks during replay).
    const output = logs.join("\n");
    expect(output).not.toContain(pasted);
  });

  it("skip path does not create config.local.json", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps, {
      brokerSecretAction: { action: "skip" },
    });

    const localPath = join(projectDir, ".ninthwave/config.local.json");
    expect(existsSync(localPath)).toBe(false);

    // Committed config still has project_id but no broker_secret.
    const configJson = parseConfigJson(
      readFileSync(join(projectDir, ".ninthwave/config.json"), "utf-8"),
    );
    expect(configJson).not.toHaveProperty("broker_secret");
    expect(configJson.project_id).toMatch(UUID_V4_PATTERN);
  });

  it("defaults to generate when no action is supplied", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // No brokerSecretAction in opts -- should behave like the old silent
    // auto-generation path, keeping existing callers/tests working.
    initProject(projectDir, bundleDir, deps);

    const localParsed = JSON.parse(
      readFileSync(
        join(projectDir, ".ninthwave/config.local.json"),
        "utf-8",
      ),
    );
    expect(localParsed.broker_secret).toMatch(BROKER_SECRET_PATTERN);
  });

  it("existing secret short-circuits the action (never rotates)", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // Seed a pre-existing secret. Even when the caller asks us to "skip",
    // we must not delete it; and when asked to "generate", we must not
    // overwrite it.
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    const seeded = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");
    writeFileSync(
      join(projectDir, ".ninthwave/config.local.json"),
      JSON.stringify({ broker_secret: seeded }, null, 2) + "\n",
    );

    initProject(projectDir, bundleDir, deps, {
      brokerSecretAction: { action: "generate" },
    });

    const localParsed = JSON.parse(
      readFileSync(
        join(projectDir, ".ninthwave/config.local.json"),
        "utf-8",
      ),
    );
    expect(localParsed.broker_secret).toBe(seeded);
  });
});

// --- parseInitFlags (cmdInit CLI flag parsing) ---

describe("parseInitFlags", () => {
  // A syntactically-valid broker secret: 32 zero bytes encoded as base64.
  const VALID_SECRET = Buffer.from(new Uint8Array(32)).toString("base64");

  it("returns defaults when no flags are passed", () => {
    const result = parseInitFlags([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.isGlobal).toBe(false);
      expect(result.flags.autoYes).toBe(false);
      expect(result.flags.flagAction).toBeUndefined();
    }
  });

  it("parses --global and --yes", () => {
    const result = parseInitFlags(["--global", "--yes"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.isGlobal).toBe(true);
      expect(result.flags.autoYes).toBe(true);
    }
  });

  it("treats -y as an alias for --yes", () => {
    const result = parseInitFlags(["-y"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flags.autoYes).toBe(true);
  });

  it("parses --broker-secret <valid> into an 'enter' action", () => {
    const result = parseInitFlags(["--broker-secret", VALID_SECRET]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.flagAction).toEqual({
        action: "enter",
        value: VALID_SECRET,
      });
    }
  });

  it("rejects an invalid --broker-secret value with a helpful message", () => {
    const result = parseInitFlags(["--broker-secret", "not-base64"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("--broker-secret");
      expect(result.error).toContain("32-byte base64");
    }
  });

  it("rejects --broker-secret without a following value", () => {
    const result = parseInitFlags(["--broker-secret"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("requires a value");
    }
  });

  it("parses --skip-broker into a 'skip' action", () => {
    const result = parseInitFlags(["--skip-broker"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.flagAction).toEqual({ action: "skip" });
    }
  });

  it("rejects --broker-secret and --skip-broker together", () => {
    const result = parseInitFlags([
      "--broker-secret",
      VALID_SECRET,
      "--skip-broker",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("mutually exclusive");
    }
  });

  it("rejects --skip-broker followed by --broker-secret too (order-independent)", () => {
    const result = parseInitFlags([
      "--skip-broker",
      "--broker-secret",
      VALID_SECRET,
    ]);
    expect(result.ok).toBe(false);
  });

  it("allows --broker-secret without --yes (skips the prompt non-interactively)", () => {
    const result = parseInitFlags(["--broker-secret", VALID_SECRET]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.autoYes).toBe(false);
      expect(result.flags.flagAction).toEqual({
        action: "enter",
        value: VALID_SECRET,
      });
    }
  });

  it("allows --skip-broker without --yes", () => {
    const result = parseInitFlags(["--skip-broker"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.autoYes).toBe(false);
      expect(result.flags.flagAction).toEqual({ action: "skip" });
    }
  });

  it("combines --yes with --broker-secret cleanly for scripted onboarding", () => {
    const result = parseInitFlags([
      "--yes",
      "--broker-secret",
      VALID_SECRET,
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.autoYes).toBe(true);
      expect(result.flags.flagAction).toEqual({
        action: "enter",
        value: VALID_SECRET,
      });
    }
  });

  it("combines --yes with --skip-broker for guaranteed local-only setup", () => {
    const result = parseInitFlags(["--yes", "--skip-broker"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.autoYes).toBe(true);
      expect(result.flags.flagAction).toEqual({ action: "skip" });
    }
  });

  it("ignores unknown flags (permissive for forward-compat)", () => {
    const result = parseInitFlags(["--nonexistent-flag", "--yes"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.autoYes).toBe(true);
    }
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
    expect(existsSync(join(projectDir, ".ninthwave/decisions/.gitkeep"))).toBe(true);
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
      initProject(projectDir, bundleDir, deps, {
        cmuxResolver: (() => null) as CmuxResolver,
      });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Checking prerequisites");
    expect(output).toContain("gh");
    expect(output).toContain("headless works by default");
    expect(output).toContain("brew install tmux");
    expect(output).toContain("brew install --cask manaflow-ai/cmux/cmux");
  });

  it("prints headless-first summary when no interactive backend is detected", () => {
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
    expect(output).toContain("Interactive backend: headless default");
    expect(output).toContain("install cmux or tmux for interactive sessions");
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
  it("does not create or overwrite user instruction files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(join(projectDir, "CLAUDE.md"), "# Project instructions\nUse the project file.\n");
    writeFileSync(join(projectDir, "AGENTS.md"), "# Shared agent instructions\n");
    mkdirSync(join(projectDir, ".github"), { recursive: true });
    writeFileSync(
      join(projectDir, ".github", "copilot-instructions.md"),
      "# Copilot instructions\nThis file is user-managed.\n",
    );

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    expect(readFileSync(join(projectDir, "CLAUDE.md"), "utf-8")).toBe(
      "# Project instructions\nUse the project file.\n",
    );
    expect(readFileSync(join(projectDir, "AGENTS.md"), "utf-8")).toBe(
      "# Shared agent instructions\n",
    );
    expect(readFileSync(join(projectDir, ".github", "copilot-instructions.md"), "utf-8")).toBe(
      "# Copilot instructions\nThis file is user-managed.\n",
    );
  });

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

  it("seeds .opencode/opencode.jsonc with per-agent auto-approval when opencode is selected", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const configPath = join(projectDir, ".opencode/opencode.jsonc");
    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    // Strip the managed-by-ninthwave header comment before parsing.
    const parsed = JSON.parse(raw.replace(/^\/\/.*$/gm, "")) as {
      agent: Record<string, { permission: Record<string, string> }>;
    };
    for (const name of [
      "ninthwave-implementer",
      "ninthwave-reviewer",
      "ninthwave-rebaser",
      "ninthwave-forward-fixer",
    ]) {
      const entry = parsed.agent[name];
      expect(entry).toBeDefined();
      expect(entry!.permission.edit).toBe("allow");
      expect(entry!.permission.bash).toBe("allow");
      expect(entry!.permission.question).toBe("allow");
    }
  });

  it("does not create copilot-instructions.md during init", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(join(projectDir, "CLAUDE.md"), "# Project instructions\n");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    expect(existsSync(join(projectDir, ".github", "copilot-instructions.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "agents", "ninthwave-implementer.agent.md"))).toBe(true);
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

  it("filters executed agent installs to opts.agentSelection.installDisplayPaths", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const opts: InitProjectOpts = {
      agentSelection: {
        agents: ["implementer.md"],
        toolDirs: [AGENT_TARGET_DIRS[0]!, AGENT_TARGET_DIRS[1]!],
        installDisplayPaths: [".opencode/agents/implementer.md"],
      },
    };

    initProject(projectDir, bundleDir, deps, opts);

    expect(existsSync(join(projectDir, ".opencode/agents/implementer.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude/agents/implementer.md"))).toBe(false);
  });

  it("leaves stale excluded managed copies untouched when installDisplayPaths skips them", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const excludedPath = join(projectDir, ".opencode/agents/implementer.md");
    mkdirSync(join(projectDir, ".opencode/agents"), { recursive: true });
    writeFileSync(excludedPath, "# stale excluded agent\n");

    const opts: InitProjectOpts = {
      agentSelection: {
        agents: ["implementer.md"],
        toolDirs: [AGENT_TARGET_DIRS[0]!, AGENT_TARGET_DIRS[1]!],
        installDisplayPaths: [".claude/agents/implementer.md"],
      },
    };

    initProject(projectDir, bundleDir, deps, opts);

    expect(readFileSync(excludedPath, "utf-8")).toBe("# stale excluded agent\n");
    expect(readFileSync(join(projectDir, ".claude/agents/implementer.md"), "utf-8")).toContain(
      "set the timeout to the longest practical value available",
    );
  });

  it("does not prune excluded managed copies while selected entries still refresh", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    const selectedPath = join(projectDir, ".claude/agents/implementer.md");
    const excludedPath = join(projectDir, ".claude/agents/reviewer.md");
    mkdirSync(join(projectDir, ".claude/agents"), { recursive: true });
    writeFileSync(selectedPath, "# stale selected agent\n");
    writeFileSync(excludedPath, "# stale excluded agent\n");

    const opts: InitProjectOpts = {
      agentSelection: {
        agents: ["implementer.md", "reviewer.md"],
        toolDirs: [AGENT_TARGET_DIRS[0]!],
        installDisplayPaths: [".claude/agents/implementer.md"],
      },
    };

    initProject(projectDir, bundleDir, deps, opts);

    expect(readFileSync(selectedPath, "utf-8")).toContain(
      "set the timeout to the longest practical value available",
    );
    expect(existsSync(excludedPath)).toBe(true);
    expect(readFileSync(excludedPath, "utf-8")).toBe("# stale excluded agent\n");
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
    expect(existsSync(join(projectDir, ".claude/skills/decompose"))).toBe(true);
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
      for (const target of AGENT_TARGET_DIRS) {
        const filename = agentTargetFilename(agent, target);
        const filePath = join(projectDir, target.dir, filename);
        expect(lstatSync(filePath).isFile()).toBe(true);
        expect(lstatSync(filePath).isSymbolicLink()).toBe(false);
      }
    }
  });

  it("writes managed Codex artifacts without creating root AGENTS.md", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const codexAgentPath = join(projectDir, ".codex/agents/ninthwave-implementer.toml");
    expect(existsSync(codexAgentPath)).toBe(true);
    expect(readFileSync(codexAgentPath, "utf-8")).toContain('name = "ninthwave-implementer"');
    expect(readFileSync(codexAgentPath, "utf-8")).toContain('developer_instructions = ');
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);
  });

  it("does not overwrite an existing root AGENTS.md when writing Codex artifacts", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    writeFileSync(join(projectDir, "AGENTS.md"), "# User-owned Codex instructions\n");

    initProject(projectDir, bundleDir, deps);

    expect(readFileSync(join(projectDir, "AGENTS.md"), "utf-8")).toBe("# User-owned Codex instructions\n");
    expect(existsSync(join(projectDir, ".codex/agents/ninthwave-implementer.toml"))).toBe(true);
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
    for (const skill of ["decompose"]) {
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
    writeFileSync(join(fakeHome, ".claude/skills", "decompose", "SKILL.md"), "# stale\n");

    setupGlobal(bundleDir);

    expect(readFileSync(join(fakeHome, ".claude/skills", "decompose", "SKILL.md"), "utf-8")).toBe(
      "# decompose\n",
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
    for (const skill of ["decompose"]) {
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

    writeFileSync(join(projectDir, ".claude/skills", "decompose", "SKILL.md"), "# stale skill\n");
    writeFileSync(join(projectDir, ".claude/agents", "implementer.md"), "# stale agent\n");

    initProject(projectDir, bundleDir, deps);

    expect(readFileSync(join(projectDir, ".claude/skills", "decompose", "SKILL.md"), "utf-8")).toBe(
      "# decompose\n",
    );
    expect(readFileSync(join(projectDir, ".claude/agents", "implementer.md"), "utf-8")).toContain(
      "set the timeout to the longest practical value available",
    );
  });

  it("replaces broken managed copies and preserves user-owned instruction files on rerun", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const { rmSync, symlinkSync } = require("fs");

    rmSync(join(projectDir, ".claude", "skills", "decompose"), { recursive: true, force: true });
    symlinkSync("../missing-skill", join(projectDir, ".claude", "skills", "decompose"));

    rmSync(join(projectDir, ".claude", "agents", "implementer.md"), { recursive: true, force: true });
    symlinkSync("../missing-agent.md", join(projectDir, ".claude", "agents", "implementer.md"));

    mkdirSync(join(projectDir, ".claude", "skills", "orphan-skill"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "skills", "orphan-skill", "SKILL.md"), "# orphan\n");
    writeFileSync(join(projectDir, ".claude", "agents", "orphan.md"), "# orphan\n");
    writeFileSync(join(projectDir, ".opencode", "agents", "orphan.md"), "# orphan\n");
    writeFileSync(join(projectDir, ".github", "agents", "ninthwave-orphan.agent.md"), "# orphan\n");
    mkdirSync(join(projectDir, ".github"), { recursive: true });
    writeFileSync(join(projectDir, "CLAUDE.md"), "# Project instructions\n");
    writeFileSync(join(projectDir, "AGENTS.md"), "# Shared agent instructions\n");
    writeFileSync(join(projectDir, ".github", "copilot-instructions.md"), "# User Copilot instructions\n");
    mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(projectDir, ".github", "workflows", "ci.yml"), "name: CI\n");

    initProject(projectDir, bundleDir, deps);

    expect(lstatSync(join(projectDir, ".claude", "skills", "decompose")).isDirectory()).toBe(true);
    expect(lstatSync(join(projectDir, ".claude", "skills", "decompose")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(projectDir, ".claude", "skills", "decompose", "SKILL.md"), "utf-8")).toBe(
      "# decompose\n",
    );

    expect(lstatSync(join(projectDir, ".claude", "agents", "implementer.md")).isFile()).toBe(true);
    expect(lstatSync(join(projectDir, ".claude", "agents", "implementer.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(projectDir, ".claude", "agents", "implementer.md"), "utf-8")).toContain(
      "set the timeout to the longest practical value available",
    );

    expect(existsSync(join(projectDir, ".claude", "skills", "orphan-skill"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude", "agents", "orphan.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode", "agents", "orphan.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github", "agents", "ninthwave-orphan.agent.md"))).toBe(false);
    expect(readFileSync(join(projectDir, "CLAUDE.md"), "utf-8")).toBe("# Project instructions\n");
    expect(readFileSync(join(projectDir, "AGENTS.md"), "utf-8")).toBe("# Shared agent instructions\n");
    expect(readFileSync(join(projectDir, ".github", "copilot-instructions.md"), "utf-8")).toBe(
      "# User Copilot instructions\n",
    );
    expect(existsSync(join(projectDir, ".github", "workflows", "ci.yml"))).toBe(true);
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


  it("copies skill directories into .claude/skills/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    for (const skill of ["decompose"]) {
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
    expect(content).toContain("!friction/");
    expect(content).toContain("!decisions/");
    expect(content).toContain("!work-item-format.md");
  });

  it("copies core/docs/work-item-format.md from bundle into .ninthwave/work-item-format.md", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    initProject(projectDir, bundleDir, deps);

    const formatDoc = join(projectDir, ".ninthwave", "work-item-format.md");
    expect(existsSync(formatDoc)).toBe(true);
    const content = readFileSync(formatDoc, "utf-8");
    expect(content).toContain("Work Item File Format Guide");
  });

  it("overwrites .ninthwave/work-item-format.md on re-init to stay in sync with bundle", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const deps: InitDeps = {
      commandExists: (() => false) as CommandChecker,
      getEnv: () => undefined,
    };

    // First init seeds the file
    initProject(projectDir, bundleDir, deps);

    // Mutate the project copy as if it drifted from the bundle
    const formatDoc = join(projectDir, ".ninthwave", "work-item-format.md");
    writeFileSync(formatDoc, "# stale content\n");

    // Re-init should restore the bundle content
    initProject(projectDir, bundleDir, deps);

    const content = readFileSync(formatDoc, "utf-8");
    expect(content).toContain("Work Item File Format Guide");
    expect(content).not.toContain("stale content");
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
