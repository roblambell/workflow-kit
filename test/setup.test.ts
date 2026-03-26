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
  SYMLINK_GITIGNORE_DIRS,
} from "../core/commands/setup.ts";
import type {
  CommandChecker,
  AuthChecker,
  CommandPathResolver,
} from "../core/commands/setup.ts";

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

  // Create nono profile
  mkdirSync(join(bundleDir, ".nono", "profiles"), { recursive: true });
  writeFileSync(
    join(bundleDir, ".nono", "profiles", "claude-worker.json"),
    '{"extends": "claude-code"}\n',
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

  it("detects zellij as multiplexer when cmux is not available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    // gh and zellij available, cmux not available
    const commandExists: CommandChecker = (cmd) => cmd === "gh" || cmd === "zellij";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    expect(result.allPresent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.detectedMux).toBe("zellij");

    // Should show zellij detected and suggest cmux upgrade
    const output = logs.join("\n");
    expect(output).toContain("zellij");
    expect(output).toContain("cmux");
  });

  it("detects tmux as multiplexer when cmux and zellij are not available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    // gh and tmux available, cmux and zellij not available
    const commandExists: CommandChecker = (cmd) => cmd === "gh" || cmd === "tmux";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    expect(result.allPresent).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.detectedMux).toBe("tmux");

    // Should show tmux detected and suggest cmux upgrade
    const output = logs.join("\n");
    expect(output).toContain("tmux");
    expect(output).toContain("cmux");
  });

  it("reports missing multiplexer when no multiplexer is available", () => {
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
    expect(result.missing).toContain("multiplexer (cmux, zellij, or tmux)");
    expect(result.detectedMux).toBeNull();

    // Should suggest all install options
    const output = logs.join("\n");
    expect(output).toContain("brew install --cask manaflow-ai/cmux/cmux");
    expect(output).toContain("brew install zellij");
    expect(output).toContain("brew install tmux");
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
    expect(result.missing).toContain("multiplexer (cmux, zellij, or tmux)");
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

  it("shows nono as detected when available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const commandExists: CommandChecker = () => true; // all commands available
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    const output = logs.join("\n");
    expect(output).toContain("nono");
    expect(output).toContain("kernel-level sandbox");
  });

  it("shows nono as optional when not available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    // gh and cmux available, nono not available
    const commandExists: CommandChecker = (cmd) => cmd === "gh" || cmd === "cmux";
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    console.log = origLog;

    // nono is informational, not blocking
    expect(result.allPresent).toBe(true);
    expect(result.missing).not.toContain("nono");

    const output = logs.join("\n");
    expect(output).toContain("nono");
    expect(output).toContain("optional");
  });

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

  it("prefers cmux over tmux when both are available", () => {
    const commandExists: CommandChecker = () => true;
    const ghAuthCheck: AuthChecker = () => ({
      authenticated: true,
      stderr: "",
    });

    const result = checkPrerequisites(commandExists, ghAuthCheck);

    expect(result.detectedMux).toBe("cmux");
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

    // Verify content is copied correctly
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

  it("records version in .ninthwave/version", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(existsSync(join(projectDir, ".ninthwave/version"))).toBe(true);
    const version = readFileSync(
      join(projectDir, ".ninthwave/version"),
      "utf-8",
    );
    // Should have some version string (git describe output)
    expect(version.trim()).toBeTruthy();
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

  it("symlinks nono profile to user-level ~/.nono/profiles/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);

    const profileLink = join(fakeHome, ".nono/profiles/claude-worker.json");
    expect(existsSync(profileLink)).toBe(true);
    expect(lstatSync(profileLink).isSymbolicLink()).toBe(true);

    // Content should be accessible via the symlink
    const content = readFileSync(profileLink, "utf-8");
    expect(content).toContain("claude-code");
  });

  it("skips nono profile symlink if target already exists", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    // Pre-create the profile
    mkdirSync(join(fakeHome, ".nono/profiles"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".nono/profiles/claude-worker.json"),
      '{"custom": true}\n',
    );

    setupGlobal(bundleDir);

    // Should NOT have overwritten
    const content = readFileSync(
      join(fakeHome, ".nono/profiles/claude-worker.json"),
      "utf-8",
    );
    expect(content).toBe('{"custom": true}\n');
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
