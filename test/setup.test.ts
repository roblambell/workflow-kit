// Tests for `ninthwave setup` command (core/commands/setup.ts).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  renameSync,
} from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import {
  setupProject,
  setupGlobal,
  createSkillSymlinks,
  checkPrerequisites,
  createNwSymlink,
  isSelfHosting,
  detectProjectTools,
  discoverAgentSources,
  buildSymlinkPlan,
  executeSymlinkPlan,
  interactiveAgentSelection,
  SYMLINK_GITIGNORE_DIRS,
  AGENT_SOURCES,
  AGENT_TARGET_DIRS,
  AGENT_DESCRIPTIONS,
} from "../core/commands/setup.ts";
import type {
  CommandChecker,
  AuthChecker,
  CommandPathResolver,
  AgentSelection,
} from "../core/commands/setup.ts";
import type { CheckboxPromptFn, ConfirmPromptFn } from "../core/prompt.ts";
import { userStateDir } from "../core/daemon.ts";

// Store original env
const originalEnv = { ...process.env };

/**
 * Stub deps where all prerequisites are present and authenticated.
 * Passed to setupProject so tests don't depend on host machine state.
 */
const allPresentDeps = {
  commandExists: (() => true) as CommandChecker,
  ghAuthCheck: (() => ({
    authenticated: true,
    stderr: "",
  })) as AuthChecker,
};

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
  writeFileSync(
    join(bundleDir, "agents", "review-worker.md"),
    "# Review Worker Agent\n",
  );
  writeFileSync(
    join(bundleDir, "agents", "supervisor.md"),
    "# Supervisor Agent\n",
  );

  // Create VERSION file
  writeFileSync(join(bundleDir, "VERSION"), "0.1.0\n");

  // Initialize as git repo so git describe works
  const { spawnSync } = require("child_process");
  spawnSync("git", ["-C", bundleDir, "init", "--quiet"]);
  spawnSync("git", ["-C", bundleDir, "config", "user.email", "test@test.com"]);
  spawnSync("git", ["-C", bundleDir, "config", "user.name", "Test"]);
  spawnSync("git", ["-C", bundleDir, "add", "."]);
  spawnSync("git", [
    "-C",
    bundleDir,
    "commit",
    "-m",
    "init",
    "--quiet",
  ]);

  return bundleDir;
}

afterEach(() => {
  cleanupTempRepos();
  process.env = { ...originalEnv };
});

// --- checkPrerequisites ---

describe("checkPrerequisites", () => {
  it("returns allPresent=true when cmux and gh are available", () => {
    const commandExists: CommandChecker = () => true;
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    expect(result.allPresent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.detectedMux).toBe("cmux");
  });

  it("reports missing multiplexer when cmux is not available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = (cmd) => cmd === "gh";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    expect(result.allPresent).toBe(false);
    expect(result.missing).toContain("cmux");
    expect(result.detectedMux).toBeNull();

    // Should suggest cmux install
    const output = logs.join("\n");
    expect(output).toContain("brew install --cask manaflow-ai/cmux/cmux");
  });

  it("detects missing gh and prints install instructions", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = (cmd) => cmd !== "gh";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    expect(result.allPresent).toBe(false);
    expect(result.missing).toContain("gh");

    // Should print install instructions
    const output = logs.join("\n");
    expect(output).toContain("gh");
    expect(output).toContain("brew install gh");
  });

  it("detects both multiplexer and gh missing", () => {
    const commandExists: CommandChecker = () => false;
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: false,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    expect(result.allPresent).toBe(false);
    expect(result.missing).toContain("cmux");
    expect(result.missing).toContain("gh");
    expect(result.detectedMux).toBeNull();
  });

  it("warns when gh is installed but not authenticated", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = () => true;
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: false,
      stderr: "not logged in",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    // Prerequisites are still "present" (installed) — auth is a warning
    expect(result.allPresent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not authenticated");
    expect(result.warnings[0]).toContain("gh auth login");

    // Should print actionable auth instructions
    const output = logs.join("\n");
    expect(output).toContain("gh auth login");
  });

});

describe("checkPrerequisites — gh auth warning", () => {
  it("does not check gh auth when gh is missing", () => {
    let authCheckCalled = false;
    // cmux available so multiplexer check passes, but gh missing
    const commandExists: CommandChecker = (cmd) => cmd === "cmux";
    const ghAuthCheck: AuthChecker = () => {
      authCheckCalled = true;
      return { authenticated: false, stderr: "" };
    };

    checkPrerequisites(commandExists, ghAuthCheck);

    expect(authCheckCalled).toBe(false);
  });

  it("returns cmux when available", () => {
    const commandExists: CommandChecker = () => true;
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    expect(result.detectedMux).toBe("cmux");
  });
});

// --- AGENT_SOURCES / AGENT_DESCRIPTIONS ---

describe("agent configuration", () => {
  it("includes all three agent source files", () => {
    expect(AGENT_SOURCES).toContain("todo-worker.md");
    expect(AGENT_SOURCES).toContain("review-worker.md");
    expect(AGENT_SOURCES).toContain("supervisor.md");
  });

  it("has descriptions for all agent sources", () => {
    for (const agent of AGENT_SOURCES) {
      expect(AGENT_DESCRIPTIONS[agent]).toBeTruthy();
    }
  });

  it("AGENT_TARGET_DIRS includes tool names", () => {
    for (const target of AGENT_TARGET_DIRS) {
      expect(target.tool).toBeTruthy();
    }
  });
});

// --- detectProjectTools ---

describe("detectProjectTools", () => {
  it("detects .claude/ directory", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".claude"), { recursive: true });

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("Claude Code");
  });

  it("detects .opencode/ directory", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".opencode"), { recursive: true });

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("OpenCode");
  });

  it("detects .opencode.json config file", () => {
    const projectDir = setupTempRepo();
    writeFileSync(join(projectDir, ".opencode.json"), "{}");

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("OpenCode");
  });

  it("detects .github/ directory", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".github"), { recursive: true });

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("GitHub Copilot");
  });

  it("detects multiple tools", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".github"), { recursive: true });

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.tool);
    expect(names).toContain("Claude Code");
    expect(names).toContain("GitHub Copilot");
  });

  it("returns empty array when no tools detected", () => {
    const projectDir = setupTempRepo();

    const tools = detectProjectTools(projectDir);

    expect(tools).toEqual([]);
  });
});

// --- discoverAgentSources ---

describe("discoverAgentSources", () => {
  it("discovers all agent files in bundle", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const agents = discoverAgentSources(bundleDir);

    expect(agents).toContain("todo-worker.md");
    expect(agents).toContain("review-worker.md");
    expect(agents).toContain("supervisor.md");
  });

  it("only returns agents that exist on disk", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");
    // Remove one agent
    const { unlinkSync: rmFile } = require("fs");
    rmFile(join(bundleDir, "agents", "supervisor.md"));

    const agents = discoverAgentSources(bundleDir);

    expect(agents).toContain("todo-worker.md");
    expect(agents).toContain("review-worker.md");
    expect(agents).not.toContain("supervisor.md");
  });
});

// --- buildSymlinkPlan ---

describe("buildSymlinkPlan", () => {
  it("plans symlinks for selected agents and tools", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!], // .claude/agents only
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.displayPath).toBe(".claude/agents/todo-worker.md");
    expect(plan[0]!.status).toBe("create");
  });

  it("detects existing correct symlinks as 'exists'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create the correct symlink
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    const { relative: rel } = require("path");
    const relTarget = rel(targetDir, join(bundleDir, "agents", "todo-worker.md"));
    const { symlinkSync: symlink } = require("fs");
    symlink(relTarget, join(targetDir, "todo-worker.md"));

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.status).toBe("exists");
  });

  it("detects regular files as 'replace'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create a regular file where symlink should be
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "todo-worker.md"), "# Custom content\n");

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.status).toBe("replace");
  });

  it("uses .agent.md suffix for GitHub Copilot target", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[2]!], // .github/agents
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.displayPath).toBe(".github/agents/todo-worker.agent.md");
  });

  it("creates cross-product of agents × tools", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["todo-worker.md", "supervisor.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!, AGENT_TARGET_DIRS[2]!], // .claude + .github
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(4);
    const paths = plan.map((p) => p.displayPath);
    expect(paths).toContain(".claude/agents/todo-worker.md");
    expect(paths).toContain(".claude/agents/supervisor.md");
    expect(paths).toContain(".github/agents/todo-worker.agent.md");
    expect(paths).toContain(".github/agents/supervisor.agent.md");
  });
});

// --- executeSymlinkPlan ---

describe("executeSymlinkPlan", () => {
  it("creates symlinks from a plan", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);
    executeSymlinkPlan(plan);

    const linkPath = join(projectDir, ".claude/agents/todo-worker.md");
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const content = readFileSync(linkPath, "utf-8");
    expect(content).toBe("# Todo Worker Agent\n");
  });

  it("replaces regular files with symlinks", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create a regular file
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "todo-worker.md"), "# Custom content\n");

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);
    expect(plan[0]!.status).toBe("replace");

    executeSymlinkPlan(plan);

    const linkPath = join(projectDir, ".claude/agents/todo-worker.md");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const content = readFileSync(linkPath, "utf-8");
    expect(content).toBe("# Todo Worker Agent\n");
  });

  it("skips entries with status 'exists'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create the correct symlink
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    const { relative: rel } = require("path");
    const relTarget = rel(targetDir, join(bundleDir, "agents", "todo-worker.md"));
    const { symlinkSync: symlink } = require("fs");
    symlink(relTarget, join(targetDir, "todo-worker.md"));

    const selection: AgentSelection = {
      agents: ["todo-worker.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);
    expect(plan[0]!.status).toBe("exists");

    // Should not throw or modify
    executeSymlinkPlan(plan);

    // Symlink should still be there and correct
    expect(lstatSync(join(targetDir, "todo-worker.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(targetDir, "todo-worker.md"))).toBe(relTarget);
  });
});

// --- interactiveAgentSelection ---

describe("interactiveAgentSelection", () => {
  it("returns selection with all agents when user confirms defaults", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Stub prompts to accept defaults
    const stubCheckbox: CheckboxPromptFn = async (_msg, choices) =>
      choices.filter((c) => c.checked).map((c) => c.value);
    const stubConfirm: ConfirmPromptFn = async () => true;

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).not.toBeNull();
    expect(selection!.agents).toContain("todo-worker.md");
    expect(selection!.agents).toContain("review-worker.md");
    expect(selection!.agents).toContain("supervisor.md");
    // No tools detected → falls back to all tools
    expect(selection!.toolDirs).toHaveLength(AGENT_TARGET_DIRS.length);
  });

  it("returns null when user declines confirmation", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const stubCheckbox: CheckboxPromptFn = async (_msg, choices) =>
      choices.filter((c) => c.checked).map((c) => c.value);
    const stubConfirm: ConfirmPromptFn = async () => false;

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).toBeNull();
  });

  it("returns only selected agents", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Only select todo-worker
    const stubCheckbox: CheckboxPromptFn = async () => ["todo-worker.md"];
    const stubConfirm: ConfirmPromptFn = async () => true;

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).not.toBeNull();
    expect(selection!.agents).toEqual(["todo-worker.md"]);
  });

  it("uses detected tools when present", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Create only .claude/ directory
    mkdirSync(join(projectDir, ".claude"), { recursive: true });

    const stubCheckbox: CheckboxPromptFn = async (_msg, choices) =>
      choices.filter((c) => c.checked).map((c) => c.value);
    const stubConfirm: ConfirmPromptFn = async () => true;

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).not.toBeNull();
    expect(selection!.toolDirs).toHaveLength(1);
    expect(selection!.toolDirs[0]!.tool).toBe("Claude Code");
  });

  it("skips confirmation when all symlinks already exist", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create all correct symlinks for all tools
    for (const agent of AGENT_SOURCES) {
      const baseName = agent.replace(/\.md$/, "");
      for (const target of AGENT_TARGET_DIRS) {
        const targetDir = join(projectDir, target.dir);
        mkdirSync(targetDir, { recursive: true });
        const { relative: rel } = require("path");
        const relTarget = rel(targetDir, join(bundleDir, "agents", agent));
        const filename = target.suffix === ".agent.md" ? `${baseName}.agent.md` : agent;
        const { symlinkSync: symlink } = require("fs");
        symlink(relTarget, join(targetDir, filename));
      }
    }

    let confirmCalled = false;
    const stubCheckbox: CheckboxPromptFn = async (_msg, choices) =>
      choices.filter((c) => c.checked).map((c) => c.value);
    const stubConfirm: ConfirmPromptFn = async () => {
      confirmCalled = true;
      return true;
    };

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).not.toBeNull();
    // Should NOT call confirm since everything is already set up
    expect(confirmCalled).toBe(false);
  });

  it("returns empty agents when user deselects all", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const stubCheckbox: CheckboxPromptFn = async () => [];
    const stubConfirm: ConfirmPromptFn = async () => true;

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).not.toBeNull();
    expect(selection!.agents).toEqual([]);
  });
});

// --- setupProject ---

describe("setupProject", () => {
  it("creates .ninthwave/ directory with config and domains.conf", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    // .ninthwave/dir should NOT exist (no longer created)
    expect(existsSync(join(projectDir, ".ninthwave/dir"))).toBe(false);

    // .ninthwave/work should NOT exist (shim removed)
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(false);

    // .ninthwave/config exists
    expect(existsSync(join(projectDir, ".ninthwave/config"))).toBe(true);
    const configContent = readFileSync(
      join(projectDir, ".ninthwave/config"),
      "utf-8",
    );
    expect(configContent).toContain("ninthwave project configuration");

    // .ninthwave/domains.conf exists
    expect(existsSync(join(projectDir, ".ninthwave/domains.conf"))).toBe(true);
    const domainsContent = readFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "utf-8",
    );
    expect(domainsContent).toContain("Domain mappings");
  });

  it("creates .ninthwave/todos/ directory", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(existsSync(join(projectDir, ".ninthwave/todos"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/todos/.gitkeep"))).toBe(true);
  });

  it("creates relative skill symlinks in .claude/skills/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    for (const skill of [
      "work",
      "decompose",
      "todo-preview",
      "ninthwave-upgrade",
    ]) {
      const linkPath = join(projectDir, ".claude/skills", skill);
      expect(existsSync(linkPath)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

      // Symlink target must be relative (not starting with /)
      const target = readlinkSync(linkPath);
      expect(target.startsWith("/")).toBe(false);
    }
  });

  it("copies agent files to .claude, .opencode, and .github directories", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(
      existsSync(join(projectDir, ".claude/agents/todo-worker.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".opencode/agents/todo-worker.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".github/agents/todo-worker.agent.md")),
    ).toBe(true);

    // Verify content is accessible through symlink
    const content = readFileSync(
      join(projectDir, ".claude/agents/todo-worker.md"),
      "utf-8",
    );
    expect(content).toBe("# Todo Worker Agent\n");
  });

  it("deploys review-worker.md alongside todo-worker.md in all agent directories", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    // review-worker.md symlinks
    expect(
      existsSync(join(projectDir, ".claude/agents/review-worker.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".opencode/agents/review-worker.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".github/agents/review-worker.agent.md")),
    ).toBe(true);

    // Verify content is accessible through symlink
    const content = readFileSync(
      join(projectDir, ".claude/agents/review-worker.md"),
      "utf-8",
    );
    expect(content).toBe("# Review Worker Agent\n");
  });

  it("deploys supervisor.md in all agent directories", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(
      existsSync(join(projectDir, ".claude/agents/supervisor.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".opencode/agents/supervisor.md")),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, ".github/agents/supervisor.agent.md")),
    ).toBe(true);

    const content = readFileSync(
      join(projectDir, ".claude/agents/supervisor.md"),
      "utf-8",
    );
    expect(content).toBe("# Supervisor Agent\n");
  });

  it("creates agent files as symlinks, not copies", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    // All agent files should be symlinks
    for (const agent of AGENT_SOURCES) {
      const baseName = agent.replace(/\.md$/, "");
      for (const target of AGENT_TARGET_DIRS) {
        const filename = target.suffix === ".agent.md" ? `${baseName}.agent.md` : agent;
        const linkPath = join(projectDir, target.dir, filename);
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

        // Verify symlink target is relative
        const symlinkTarget = readlinkSync(linkPath);
        expect(symlinkTarget.startsWith("/")).toBe(false);
      }
    }
  });

  it("uses agentSelection from deps when provided", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Only install todo-worker to .claude/agents
    setupProject(projectDir, bundleDir, {
      ...allPresentDeps,
      agentSelection: {
        agents: ["todo-worker.md"],
        toolDirs: [AGENT_TARGET_DIRS[0]!],
      },
    });

    // Should have todo-worker in .claude/agents
    expect(existsSync(join(projectDir, ".claude/agents/todo-worker.md"))).toBe(true);

    // Should NOT have agents in other tool dirs
    expect(existsSync(join(projectDir, ".opencode/agents/todo-worker.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github/agents/todo-worker.agent.md"))).toBe(false);

    // Should NOT have other agents
    expect(existsSync(join(projectDir, ".claude/agents/review-worker.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".claude/agents/supervisor.md"))).toBe(false);
  });

  it("creates .gitignore with .worktrees/ entry", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".worktrees/");
  });

  it("appends to existing .gitignore without duplicating", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create .gitignore with some content
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n");

    setupProject(projectDir, bundleDir, allPresentDeps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".worktrees/");

    // Run again — should not duplicate
    setupProject(projectDir, bundleDir, allPresentDeps);

    const content2 = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    const matches = content2.match(/\.worktrees\//g);
    expect(matches).toHaveLength(1);
  });

  it("records version in user state directory", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

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

  it("aborts when prerequisites are missing", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const missingDeps = {
      commandExists: (() => false) as CommandChecker,
      ghAuthCheck: (() => ({
        authenticated: false,
        stderr: "",
      })) as AuthChecker,
    };

    // setupProject calls die() which calls process.exit(1)
    // We catch the exit to verify it aborts
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as never;

    try {
      setupProject(projectDir, bundleDir, missingDeps);
    } catch (e: unknown) {
      // Expected — die() calls process.exit
    } finally {
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    // Should NOT have created project files since prerequisites failed
    expect(existsSync(join(projectDir, ".ninthwave/config"))).toBe(false);
  });

  it("completes successfully when all prerequisites are met", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Should not throw
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Verify setup completed
    expect(existsSync(join(projectDir, ".ninthwave/config"))).toBe(true);
    expect(existsSync(join(projectDir, ".ninthwave/todos"))).toBe(true);
  });
});

describe("setupProject — idempotency", () => {
  it("running setup twice produces the same result", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // First run
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Capture state after first run
    const firstConfig = readFileSync(
      join(projectDir, ".ninthwave/config"),
      "utf-8",
    );
    const firstDomains = readFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "utf-8",
    );
    const firstTodosExists = existsSync(join(projectDir, ".ninthwave/todos"));
    const firstGitignore = readFileSync(
      join(projectDir, ".gitignore"),
      "utf-8",
    );

    // Second run
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Verify state is identical
    expect(readFileSync(join(projectDir, ".ninthwave/config"), "utf-8")).toBe(
      firstConfig,
    );
    expect(
      readFileSync(join(projectDir, ".ninthwave/domains.conf"), "utf-8"),
    ).toBe(firstDomains);
    expect(existsSync(join(projectDir, ".ninthwave/todos"))).toBe(
      firstTodosExists,
    );
    expect(readFileSync(join(projectDir, ".gitignore"), "utf-8")).toBe(
      firstGitignore,
    );

    // Symlinks still valid
    for (const skill of [
      "work",
      "decompose",
      "todo-preview",
      "ninthwave-upgrade",
    ]) {
      const linkPath = join(projectDir, ".claude/skills", skill);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }

    // Agent symlinks still valid
    for (const agent of AGENT_SOURCES) {
      const linkPath = join(projectDir, ".claude/agents", agent);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }
  });

  it("idempotent agent symlinks — second run reports 'already set up'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // First run creates all symlinks
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Second run — build plan to verify status
    const selection: AgentSelection = {
      agents: discoverAgentSources(bundleDir),
      toolDirs: [...AGENT_TARGET_DIRS],
    };
    const plan = buildSymlinkPlan(projectDir, bundleDir, selection);

    // All entries should be "exists" on second run
    for (const entry of plan) {
      expect(entry.status).toBe("exists");
    }
  });
});

describe("setupProject — relative symlinks survive directory moves", () => {
  it("skill symlinks resolve after renaming the parent directory", () => {
    // Create a container directory that holds both project and bundle as siblings
    const { mkdtempSync } = require("fs");
    const { tmpdir } = require("os");
    const container = mkdtempSync(join(tmpdir(), "nw-move-test-"));
    const projectDir = join(container, "my-project");
    mkdirSync(projectDir, { recursive: true });

    // Init git in the project dir
    const { spawnSync } = require("child_process");
    spawnSync("git", ["-C", projectDir, "init", "--quiet"]);
    spawnSync("git", ["-C", projectDir, "config", "user.email", "test@test.com"]);
    spawnSync("git", ["-C", projectDir, "config", "user.name", "Test"]);

    const bundleDir = createFakeBundle(join(container, "bundle-parent"));

    setupProject(projectDir, bundleDir, allPresentDeps);

    // Verify symlinks work before the move
    expect(existsSync(join(projectDir, ".claude/skills/work"))).toBe(true);

    // Rename the container directory
    const renamedContainer = container + "-renamed";
    renameSync(container, renamedContainer);

    // Compute new paths after rename
    const renamedProject = join(renamedContainer, "my-project");

    // Symlinks should still resolve because they're relative
    for (const skill of [
      "work",
      "decompose",
      "todo-preview",
      "ninthwave-upgrade",
    ]) {
      const linkPath = join(renamedProject, ".claude/skills", skill);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(existsSync(linkPath)).toBe(true);

      // Verify the symlink target file is actually reachable
      const content = readFileSync(join(linkPath, "SKILL.md"), "utf-8");
      expect(content).toContain(`# ${skill}`);
    }

    // Clean up the renamed directory
    const { rmSync } = require("fs");
    rmSync(renamedContainer, { recursive: true, force: true });
  });
});

describe("setupProject — preserves existing config", () => {
  it("does not overwrite existing .ninthwave/config", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create custom config
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/config"),
      "CUSTOM_SETTING=true\n",
    );

    setupProject(projectDir, bundleDir, allPresentDeps);

    const config = readFileSync(
      join(projectDir, ".ninthwave/config"),
      "utf-8",
    );
    expect(config).toBe("CUSTOM_SETTING=true\n");
  });

  it("does not overwrite existing .ninthwave/domains.conf", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create custom domains
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "auth=auth\n",
    );

    setupProject(projectDir, bundleDir, allPresentDeps);

    const domains = readFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "utf-8",
    );
    expect(domains).toBe("auth=auth\n");
  });

  it("does not overwrite existing todos directory", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create todos directory with content
    mkdirSync(join(projectDir, ".ninthwave/todos"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ninthwave/todos/1-test--H-FOO-1.md"),
      "# Test item (H-FOO-1)\n",
    );

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(existsSync(join(projectDir, ".ninthwave/todos/1-test--H-FOO-1.md"))).toBe(true);
    const content = readFileSync(join(projectDir, ".ninthwave/todos/1-test--H-FOO-1.md"), "utf-8");
    expect(content).toContain("H-FOO-1");
  });
});

describe("setupGlobal", () => {
  it("creates relative skill symlinks in ~/.claude/skills/", () => {
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
      "todo-preview",
      "ninthwave-upgrade",
    ]) {
      const linkPath = join(skillsDir, skill);
      expect(existsSync(linkPath)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

      // Symlink target must be relative
      const target = readlinkSync(linkPath);
      expect(target.startsWith("/")).toBe(false);
    }
  });

  it("does not create .ninthwave/, todos directory, or agent files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Use a temp directory as HOME
    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);

    // No project-level artifacts
    expect(existsSync(join(fakeHome, ".ninthwave"))).toBe(false);
    expect(existsSync(join(fakeHome, ".ninthwave/todos"))).toBe(false);
    expect(existsSync(join(fakeHome, ".claude/agents"))).toBe(false);
  });

  it("is idempotent — running twice produces the same result", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);
    setupGlobal(bundleDir);

    const skillsDir = join(fakeHome, ".claude/skills");
    for (const skill of [
      "work",
      "decompose",
      "todo-preview",
      "ninthwave-upgrade",
    ]) {
      const linkPath = join(skillsDir, skill);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }
  });
});

// --- createNwSymlink ---

describe("createNwSymlink", () => {
  it("creates nw symlink next to ninthwave binary", () => {
    // Create a fake bin directory with a ninthwave binary
    const { mkdtempSync, rmSync: rmSyncFn } = require("fs");
    const { tmpdir } = require("os");
    const fakeBin = mkdtempSync(join(tmpdir(), "nw-symlink-test-"));

    writeFileSync(join(fakeBin, "ninthwave"), "#!/bin/sh\n");

    const commandExists: CommandChecker = (cmd) => cmd !== "nw";
    const resolveCommandPath: CommandPathResolver = (cmd) =>
      cmd === "ninthwave" ? join(fakeBin, "ninthwave") : null;

    const result = createNwSymlink(commandExists, resolveCommandPath);

    expect(result).toBe(true);
    expect(existsSync(join(fakeBin, "nw"))).toBe(true);
    expect(lstatSync(join(fakeBin, "nw")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fakeBin, "nw"))).toBe("ninthwave");

    rmSyncFn(fakeBin, { recursive: true, force: true });
  });

  it("skips when nw already exists in PATH", () => {
    const commandExists: CommandChecker = () => true; // nw exists
    const resolveCommandPath: CommandPathResolver = () => null;

    const result = createNwSymlink(commandExists, resolveCommandPath);

    expect(result).toBe(false);
  });

  it("skips when ninthwave is not in PATH", () => {
    const commandExists: CommandChecker = () => false;
    const resolveCommandPath: CommandPathResolver = () => null;

    const result = createNwSymlink(commandExists, resolveCommandPath);

    expect(result).toBe(false);
  });

  it("handles permission errors gracefully", () => {
    const commandExists: CommandChecker = (cmd) => cmd !== "nw";
    // Return a non-writable path to trigger permission error
    const resolveCommandPath: CommandPathResolver = (cmd) =>
      cmd === "ninthwave" ? "/nonexistent-dir-12345/ninthwave" : null;

    const result = createNwSymlink(commandExists, resolveCommandPath);

    expect(result).toBe(false);
  });
});

// --- isSelfHosting ---

describe("isSelfHosting", () => {
  it("returns true when projectDir equals bundleDir", () => {
    expect(isSelfHosting("/foo/bar", "/foo/bar")).toBe(true);
  });

  it("returns true when paths resolve to the same directory", () => {
    expect(isSelfHosting("/foo/bar/../bar", "/foo/bar")).toBe(true);
  });

  it("returns false when projectDir differs from bundleDir", () => {
    expect(isSelfHosting("/my/project", "/usr/share/ninthwave")).toBe(false);
  });
});

// --- Symlink gitignore entries ---

describe("setupProject — symlink gitignore entries", () => {
  it("adds symlink directories to .gitignore for non-ninthwave projects", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".claude/agents/");
    expect(content).toContain(".claude/skills/");
    expect(content).toContain(".opencode/agents/");
    expect(content).toContain(".github/agents/");
    expect(content).toContain("ninthwave symlinks");
  });

  it("does NOT add symlink directories when projectDir equals bundleDir (self-hosting)", () => {
    // In self-hosting mode, bundleDir IS the projectDir (the ninthwave repo)
    const projectDir = setupTempRepo();
    // Use projectDir as bundleDir to simulate self-hosting
    // We need the bundle structure inside projectDir
    for (const skill of ["work", "decompose", "todo-preview", "ninthwave-upgrade"]) {
      const skillDir = join(projectDir, "skills", skill);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n`);
    }
    mkdirSync(join(projectDir, "agents"), { recursive: true });
    writeFileSync(join(projectDir, "agents", "todo-worker.md"), "# Todo Worker\n");
    writeFileSync(join(projectDir, "agents", "review-worker.md"), "# Review Worker\n");
    writeFileSync(join(projectDir, "agents", "supervisor.md"), "# Supervisor\n");

    setupProject(projectDir, projectDir, allPresentDeps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    // .worktrees/ should still be present
    expect(content).toContain(".worktrees/");
    // But symlink directories should NOT be gitignored
    expect(content).not.toContain(".claude/agents/");
    expect(content).not.toContain(".claude/skills/");
    expect(content).not.toContain(".opencode/agents/");
    expect(content).not.toContain(".github/agents/");
    expect(content).not.toContain("ninthwave symlinks");
  });

  it("does not duplicate symlink gitignore entries on re-run", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Run setup twice
    setupProject(projectDir, bundleDir, allPresentDeps);
    setupProject(projectDir, bundleDir, allPresentDeps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    // Each symlink directory should appear exactly once
    for (const dir of SYMLINK_GITIGNORE_DIRS) {
      const matches = content.match(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
      expect(matches).toHaveLength(1);
    }
  });

  it("preserves existing .gitignore content when adding symlink entries", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create .gitignore with custom content
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\ndist/\n");

    setupProject(projectDir, bundleDir, allPresentDeps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain(".worktrees/");
    expect(content).toContain(".claude/agents/");
  });

  it("creates .gitignore with symlink entries when file does not exist", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Ensure no .gitignore exists
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(false);

    setupProject(projectDir, bundleDir, allPresentDeps);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".worktrees/");
    expect(content).toContain(".claude/agents/");
    expect(content).toContain(".claude/skills/");
    expect(content).toContain(".opencode/agents/");
    expect(content).toContain(".github/agents/");
  });

  it("symlinks are still created correctly alongside gitignore entries", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    // Skill symlinks exist and work
    for (const skill of ["work", "decompose", "todo-preview", "ninthwave-upgrade"]) {
      const linkPath = join(projectDir, ".claude/skills", skill);
      expect(existsSync(linkPath)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }

    // Agent symlinks exist and work
    expect(existsSync(join(projectDir, ".claude/agents/todo-worker.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".opencode/agents/todo-worker.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github/agents/todo-worker.agent.md"))).toBe(true);
  });
});

describe("setupProject — nw symlink via deps", () => {
  it("calls createNwSymlink during setup with injected deps", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Create a fake bin directory for the ninthwave binary
    const fakeBin = join(projectDir, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "ninthwave"), "#!/bin/sh\n");

    const depsWithPath = {
      ...allPresentDeps,
      // nw does not exist yet, ninthwave is in fake bin
      commandExists: ((cmd: string) =>
        cmd === "nw" ? false : true) as CommandChecker,
      resolveCommandPath: ((cmd: string) =>
        cmd === "ninthwave"
          ? join(fakeBin, "ninthwave")
          : null) as CommandPathResolver,
    };

    setupProject(projectDir, bundleDir, depsWithPath);

    // Verify nw symlink was created in the fake bin directory
    expect(existsSync(join(fakeBin, "nw"))).toBe(true);
    expect(lstatSync(join(fakeBin, "nw")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fakeBin, "nw"))).toBe("ninthwave");
  });
});

// --- setupProject with agentSelection ---

describe("setupProject — agent selection", () => {
  it("installs no agents when selection is empty", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, {
      ...allPresentDeps,
      agentSelection: { agents: [], toolDirs: [] },
    });

    // No agent directories should be created
    expect(existsSync(join(projectDir, ".claude/agents"))).toBe(false);
    expect(existsSync(join(projectDir, ".opencode/agents"))).toBe(false);
    expect(existsSync(join(projectDir, ".github/agents"))).toBe(false);

    // But skills should still be set up
    expect(existsSync(join(projectDir, ".claude/skills/work"))).toBe(true);
  });

  it("installs only selected agents to selected tools", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, {
      ...allPresentDeps,
      agentSelection: {
        agents: ["supervisor.md"],
        toolDirs: [AGENT_TARGET_DIRS[0]!, AGENT_TARGET_DIRS[2]!], // .claude + .github
      },
    });

    // supervisor in .claude and .github
    expect(existsSync(join(projectDir, ".claude/agents/supervisor.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".github/agents/supervisor.agent.md"))).toBe(true);

    // No supervisor in .opencode
    expect(existsSync(join(projectDir, ".opencode/agents/supervisor.md"))).toBe(false);

    // No other agents anywhere
    expect(existsSync(join(projectDir, ".claude/agents/todo-worker.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".claude/agents/review-worker.md"))).toBe(false);
  });
});
