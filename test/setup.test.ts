// Tests for setup utilities (core/commands/setup.ts).
//
// Tests for the unified `ninthwave init` command (which uses these utilities)
// live in test/init.test.ts.

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
import {
  setupGlobal,
  copySkillFiles,
  checkPrerequisites,
  createNwSymlink,
  isSelfHosting,
  discoverCanonicalBundleSources,
  discoverSkillSources,
  detectProjectTools,
  discoverAgentSources,
  buildCopyPlan,
  executeCopyPlan,
  interactiveAgentSelection,
  AGENT_SOURCES,
  AGENT_TARGET_DIRS,
  AGENT_DESCRIPTIONS,
} from "../core/commands/setup.ts";
import type {
  CommandChecker,
  AuthChecker,
  CommandPathResolver,
  CmuxResolver,
  AgentSelection,
} from "../core/commands/setup.ts";
import type { CheckboxPromptFn, ConfirmPromptFn } from "../core/prompt.ts";

// Store original env
const originalEnv = { ...process.env };

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
    "# Implementer Agent\n",
  );
  writeFileSync(
    join(bundleDir, "agents", "reviewer.md"),
    "# Reviewer Agent\n",
  );
  writeFileSync(
    join(bundleDir, "agents", "forward-fixer.md"),
    "# Forward Fixer Agent\n",
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
    const commandExists: CommandChecker = (cmd) => cmd === "gh";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });
    const cmuxResolver: CmuxResolver = () => "cmux";

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    expect(result.allPresent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.detectedMux).toBe("cmux");
  });

  it("reports missing multiplexer when neither cmux nor tmux is available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = (cmd) => cmd === "gh";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });
    const cmuxResolver: CmuxResolver = () => null;

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    console.log = origLog;

    expect(result.allPresent).toBe(false);
    expect(result.missing).toContain("mux");
    expect(result.detectedMux).toBeNull();

    // Should suggest cmux install
    const output = logs.join("\n");
    expect(output).toContain("brew install --cask manaflow-ai/cmux/cmux");
  });

  it("detects missing gh and prints install instructions", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = (cmd) => cmd === "tmux";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });
    const cmuxResolver: CmuxResolver = () => null;

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

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
    const cmuxResolver: CmuxResolver = () => null;

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    expect(result.allPresent).toBe(false);
    expect(result.missing).toContain("mux");
    expect(result.missing).toContain("gh");
    expect(result.detectedMux).toBeNull();
  });

  it("warns when gh is installed but not authenticated", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = (cmd) => cmd === "gh";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: false,
      stderr: "not logged in",
    });
    const cmuxResolver: CmuxResolver = () => "cmux";

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    console.log = origLog;

    // Prerequisites are still "present" (installed) -- auth is a warning
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

describe("checkPrerequisites -- gh auth warning", () => {
  it("does not check gh auth when gh is missing", () => {
    let authCheckCalled = false;
    // cmux available (via resolver) so multiplexer check passes, but gh missing
    const commandExists: CommandChecker = () => false;
    const cmuxResolver: CmuxResolver = () => "cmux";
    const ghAuthCheck: AuthChecker = () => {
      authCheckCalled = true;
      return { authenticated: false, stderr: "" };
    };

    checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    expect(authCheckCalled).toBe(false);
  });

  it("returns cmux when available via resolver", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "gh";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });
    const cmuxResolver: CmuxResolver = () => "cmux";

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    expect(result.detectedMux).toBe("cmux");
  });

  it("returns tmux when only tmux is available", () => {
    const commandExists: CommandChecker = (cmd) => cmd === "gh" || cmd === "tmux";
    const ghAuthCheck: AuthChecker = () => ({ authenticated: true, stderr: "" });
    const cmuxResolver: CmuxResolver = () => null;

    const result = checkPrerequisites(commandExists, ghAuthCheck, cmuxResolver);

    expect(result.detectedMux).toBe("tmux");
    expect(result.missing).not.toContain("mux");
    expect(result.allPresent).toBe(true);
  });
});

// --- AGENT_SOURCES / AGENT_DESCRIPTIONS ---

describe("agent configuration", () => {
  it("includes all agent source files", () => {
    expect(AGENT_SOURCES).toContain("implementer.md");
    expect(AGENT_SOURCES).toContain("reviewer.md");
    expect(AGENT_SOURCES).toContain("rebaser.md");
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

  it("detects .github/copilot-instructions.md", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".github"), { recursive: true });
    writeFileSync(join(projectDir, ".github", "copilot-instructions.md"), "# Copilot instructions\n");

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("GitHub Copilot");
  });

  it("detects .github/agents/ directory", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".github", "agents"), { recursive: true });

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("GitHub Copilot");
  });

  it("does NOT detect bare .github/ directory as GitHub Copilot", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".github"), { recursive: true });

    const tools = detectProjectTools(projectDir);

    expect(tools).toHaveLength(0);
  });

  it("detects multiple tools", () => {
    const projectDir = setupTempRepo();
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".github"), { recursive: true });
    writeFileSync(join(projectDir, ".github", "copilot-instructions.md"), "# Copilot\n");

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

describe("discoverCanonicalBundleSources", () => {
  it("reads CLAUDE.md, skills, and agents from the bundle", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const sources = discoverCanonicalBundleSources(bundleDir);

    expect(sources.instructionFile).toBe("CLAUDE.md");
    expect(sources.skills).toEqual(["decompose", "work"]);
    expect(sources.agents).toContain("implementer.md");
    expect(sources.agents).toContain("reviewer.md");
    expect(sources.agents).toContain("forward-fixer.md");
    expect(sources.agents).toContain("rebaser.md");
  });
});

describe("discoverSkillSources", () => {
  it("discovers newly added skills from SKILL.md files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const extraSkillDir = join(bundleDir, "skills", "brainstorm");
    mkdirSync(extraSkillDir, { recursive: true });
    writeFileSync(join(extraSkillDir, "SKILL.md"), "# brainstorm\n");

    expect(discoverSkillSources(bundleDir)).toContain("brainstorm");
  });
});

describe("discoverAgentSources", () => {
  it("discovers all agent files in bundle", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const agents = discoverAgentSources(bundleDir);

    expect(agents).toContain("implementer.md");
    expect(agents).toContain("reviewer.md");
    expect(agents).toContain("forward-fixer.md");
    expect(agents).toContain("rebaser.md");
  });

  it("only returns agents that exist on disk", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");
    // Remove one agent
    const { unlinkSync: rmFile } = require("fs");
    rmFile(join(bundleDir, "agents", "reviewer.md"));

    const agents = discoverAgentSources(bundleDir);

    expect(agents).toContain("implementer.md");
    expect(agents).not.toContain("reviewer.md");
  });

  it("discovers newly added agent files without updating a static list", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    writeFileSync(join(bundleDir, "agents", "custom-agent.md"), "# Custom Agent\n");

    expect(discoverAgentSources(bundleDir)).toContain("custom-agent.md");
  });
});

describe("copySkillFiles", () => {
  it("copies newly discovered skills from the bundle", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const extraSkillDir = join(bundleDir, "skills", "brainstorm");
    mkdirSync(extraSkillDir, { recursive: true });
    writeFileSync(join(extraSkillDir, "SKILL.md"), "# brainstorm\n");

    copySkillFiles(join(projectDir, ".claude/skills"), bundleDir);

    expect(existsSync(join(projectDir, ".claude/skills", "brainstorm", "SKILL.md"))).toBe(true);
  });
});

// --- buildCopyPlan ---

describe("buildCopyPlan", () => {
  it("plans copies for selected agents and tools", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!], // .claude/agents only
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.displayPath).toBe(".claude/agents/implementer.md");
    expect(plan[0]!.status).toBe("create");
  });

  it("detects up-to-date managed files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create a matching managed copy
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "implementer.md"), "# Implementer Agent\n");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.status).toBe("up-to-date");
  });

  it("detects stale managed files as 'refresh'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "implementer.md"), "# Stale content\n");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.status).toBe("refresh");
  });

  it("detects legacy symlinks as 'replace'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create a symlink (legacy setup)
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    const { relative: rel } = require("path");
    const relTarget = rel(targetDir, join(bundleDir, "agents", "implementer.md"));
    const { symlinkSync: symlink } = require("fs");
    symlink(relTarget, join(targetDir, "implementer.md"));

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.status).toBe("replace");
  });

  it("uses ninthwave- prefixed .agent.md suffix for GitHub Copilot target", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[2]!], // .github/agents
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(1);
    expect(plan[0]!.displayPath).toBe(".github/agents/ninthwave-implementer.agent.md");
  });

  it("creates cross-product of agents × tools", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["implementer.md", "reviewer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!, AGENT_TARGET_DIRS[2]!], // .claude + .github
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);

    expect(plan).toHaveLength(4);
    const paths = plan.map((p) => p.displayPath);
    expect(paths).toContain(".claude/agents/implementer.md");
    expect(paths).toContain(".claude/agents/reviewer.md");
    expect(paths).toContain(".github/agents/ninthwave-implementer.agent.md");
    expect(paths).toContain(".github/agents/ninthwave-reviewer.agent.md");
  });
});

// --- executeCopyPlan ---

describe("executeCopyPlan", () => {
  it("copies agent files from plan", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);
    executeCopyPlan(plan);

    const destPath = join(projectDir, ".claude/agents/implementer.md");
    expect(existsSync(destPath)).toBe(true);
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(destPath).isFile()).toBe(true);
    const content = readFileSync(destPath, "utf-8");
    expect(content).toBe("# Implementer Agent\n");
  });

  it("replaces legacy symlinks with real files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create a legacy symlink
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    const { relative: rel } = require("path");
    const relTarget = rel(targetDir, join(bundleDir, "agents", "implementer.md"));
    const { symlinkSync: symlink } = require("fs");
    symlink(relTarget, join(targetDir, "implementer.md"));

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);
    expect(plan[0]!.status).toBe("replace");

    executeCopyPlan(plan);

    const destPath = join(projectDir, ".claude/agents/implementer.md");
    expect(lstatSync(destPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(destPath).isFile()).toBe(true);
    const content = readFileSync(destPath, "utf-8");
    expect(content).toBe("# Implementer Agent\n");
  });

  it("skips entries with status 'up-to-date'", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create a matching managed copy
    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "implementer.md"), "# Implementer Agent\n");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);
    expect(plan[0]!.status).toBe("up-to-date");

    // Should not throw or modify
    executeCopyPlan(plan);

    // File should remain unchanged
    const content = readFileSync(join(targetDir, "implementer.md"), "utf-8");
    expect(content).toBe("# Implementer Agent\n");
  });

  it("refreshes stale managed files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const targetDir = join(projectDir, ".claude/agents");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "implementer.md"), "# Stale content\n");

    const selection: AgentSelection = {
      agents: ["implementer.md"],
      toolDirs: [AGENT_TARGET_DIRS[0]!],
    };

    const plan = buildCopyPlan(projectDir, bundleDir, selection);
    expect(plan[0]!.status).toBe("refresh");

    executeCopyPlan(plan);

    const content = readFileSync(join(targetDir, "implementer.md"), "utf-8");
    expect(content).toBe("# Implementer Agent\n");
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
    expect(selection!.agents).toContain("implementer.md");
    expect(selection!.agents).toContain("reviewer.md");
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

    // First call: tool dir selection (accept all pre-checked); second call: only implementer
    let callCount = 0;
    const stubCheckbox: CheckboxPromptFn = async (_msg, choices) => {
      callCount++;
      if (callCount === 1) {
        return choices.filter((c) => c.checked).map((c) => c.value);
      }
      return ["implementer.md"];
    };
    const stubConfirm: ConfirmPromptFn = async () => true;

    const selection = await interactiveAgentSelection(projectDir, bundleDir, {
      checkboxPrompt: stubCheckbox,
      confirmPrompt: stubConfirm,
    });

    expect(selection).not.toBeNull();
    expect(selection!.agents).toEqual(["implementer.md"]);
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

  it("skips confirmation when all agent files already exist", async () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create all agent files for all tools with canonical content
    for (const agent of AGENT_SOURCES) {
      const baseName = agent.replace(/\.md$/, "");
      const canonicalContent = readFileSync(join(bundleDir, "agents", agent), "utf-8");
      for (const target of AGENT_TARGET_DIRS) {
        const targetDir = join(projectDir, target.dir);
        mkdirSync(targetDir, { recursive: true });
        const filename = target.suffix === ".agent.md" ? `ninthwave-${baseName}.agent.md` : agent;
        writeFileSync(join(targetDir, filename), canonicalContent);
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
    // Should NOT call confirm since everything is already up to date
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

describe("setupGlobal", () => {
  it("creates managed skill copies in ~/.claude/skills/", () => {
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

  it("does not create .ninthwave/, work directory, or agent files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Use a temp directory as HOME
    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);

    // No project-level artifacts
    expect(existsSync(join(fakeHome, ".ninthwave"))).toBe(false);
    expect(existsSync(join(fakeHome, ".ninthwave/work"))).toBe(false);
    expect(existsSync(join(fakeHome, ".claude/agents"))).toBe(false);
  });

  it("rerunning setupGlobal refreshes stale managed skills", () => {
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



// --- setupProject with agentSelection ---
