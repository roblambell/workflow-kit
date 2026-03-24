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
  generateShimContent,
  checkPrerequisites,
  createNwSymlink,
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

  it("detects tmux as multiplexer when cmux is not available", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    // gh and tmux available, cmux not available
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

  it("reports missing multiplexer when neither cmux nor tmux is available", () => {
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
    expect(result.missing).toContain("multiplexer (cmux or tmux)");
    expect(result.detectedMux).toBeNull();

    // Should suggest both install options
    const output = logs.join("\n");
    expect(output).toContain("brew install --cask manaflow-ai/cmux/cmux");
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
    expect(result.missing).toContain("multiplexer (cmux or tmux)");
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
  it("creates .ninthwave/ directory with work shim, config, and domains.conf", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    // .ninthwave/dir should NOT exist (no longer created)
    expect(existsSync(join(projectDir, ".ninthwave/dir"))).toBe(false);

    // .ninthwave/work is executable shim with auto-resolution
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    const shimContent = readFileSync(
      join(projectDir, ".ninthwave/work"),
      "utf-8",
    );
    expect(shimContent).toContain("#!/usr/bin/env bash");
    expect(shimContent).toContain("command -v ninthwave");
    expect(shimContent).toContain('exec ninthwave "$@"');
    expect(shimContent).toContain("core/cli.ts");

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

  it("creates TODOS.md", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir, allPresentDeps);

    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(true);
    const content = readFileSync(join(projectDir, "TODOS.md"), "utf-8");
    expect(content).toContain("# TODOS");
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
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(false);
  });

  it("completes successfully when all prerequisites are met", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Should not throw
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Verify setup completed
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(true);
  });
});

describe("setupProject — idempotency", () => {
  it("running setup twice produces the same result", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // First run
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Capture state after first run
    const firstShim = readFileSync(
      join(projectDir, ".ninthwave/work"),
      "utf-8",
    );
    const firstConfig = readFileSync(
      join(projectDir, ".ninthwave/config"),
      "utf-8",
    );
    const firstDomains = readFileSync(
      join(projectDir, ".ninthwave/domains.conf"),
      "utf-8",
    );
    const firstTodos = readFileSync(join(projectDir, "TODOS.md"), "utf-8");
    const firstGitignore = readFileSync(
      join(projectDir, ".gitignore"),
      "utf-8",
    );

    // Second run
    setupProject(projectDir, bundleDir, allPresentDeps);

    // Verify state is identical
    expect(readFileSync(join(projectDir, ".ninthwave/work"), "utf-8")).toBe(
      firstShim,
    );
    expect(readFileSync(join(projectDir, ".ninthwave/config"), "utf-8")).toBe(
      firstConfig,
    );
    expect(
      readFileSync(join(projectDir, ".ninthwave/domains.conf"), "utf-8"),
    ).toBe(firstDomains);
    expect(readFileSync(join(projectDir, "TODOS.md"), "utf-8")).toBe(
      firstTodos,
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

  it("does not overwrite existing TODOS.md", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create TODOS.md with content
    writeFileSync(
      join(projectDir, "TODOS.md"),
      "# My Project TODOs\n\n- [ ] Task 1\n",
    );

    setupProject(projectDir, bundleDir, allPresentDeps);

    const todos = readFileSync(join(projectDir, "TODOS.md"), "utf-8");
    expect(todos).toContain("My Project TODOs");
    expect(todos).toContain("Task 1");
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

  it("does not create .ninthwave/, TODOS.md, or agent files", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Use a temp directory as HOME
    const fakeHome = join(projectDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    setupGlobal(bundleDir);

    // No project-level artifacts
    expect(existsSync(join(fakeHome, ".ninthwave"))).toBe(false);
    expect(existsSync(join(fakeHome, "TODOS.md"))).toBe(false);
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

describe("generateShimContent", () => {
  it("produces a valid bash script with shebang", () => {
    const content = generateShimContent();
    expect(content.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  it("checks for nw before ninthwave in PATH", () => {
    const content = generateShimContent();
    const nwCheck = content.indexOf("command -v nw");
    const ninthwaveCheck = content.indexOf("command -v ninthwave");
    expect(nwCheck).toBeGreaterThan(-1);
    expect(ninthwaveCheck).toBeGreaterThan(-1);
    // nw check must come before ninthwave check
    expect(nwCheck).toBeLessThan(ninthwaveCheck);
  });

  it("checks for ninthwave in PATH before dev-mode walk-up", () => {
    const content = generateShimContent();
    const pathCheck = content.indexOf("command -v ninthwave");
    const walkUp = content.indexOf('if [ -f "$dir/core/cli.ts" ]');
    expect(pathCheck).toBeGreaterThan(-1);
    expect(walkUp).toBeGreaterThan(-1);
    // PATH check must come before walk-up
    expect(pathCheck).toBeLessThan(walkUp);
  });

  it("uses exec nw for preferred short alias", () => {
    const content = generateShimContent();
    expect(content).toContain('exec nw "$@"');
  });

  it("uses exec ninthwave for PATH-based resolution", () => {
    const content = generateShimContent();
    expect(content).toContain('exec ninthwave "$@"');
  });

  it("walks up to find core/cli.ts for dev-mode fallback", () => {
    const content = generateShimContent();
    expect(content).toContain('if [ -f "$dir/core/cli.ts" ]');
    expect(content).toContain('exec bun run "$dir/core/cli.ts" "$@"');
  });

  it("exits with error if ninthwave is not found", () => {
    const content = generateShimContent();
    expect(content).toContain("exit 1");
    expect(content).toContain("ninthwave not found");
  });

  it("does not reference .ninthwave/dir", () => {
    const content = generateShimContent();
    expect(content).not.toContain(".ninthwave/dir");
  });
});

describe("setupProject — legacy cleanup", () => {
  it("removes legacy .ninthwave/dir if present", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create legacy .ninthwave/dir
    mkdirSync(join(projectDir, ".ninthwave"), { recursive: true });
    writeFileSync(join(projectDir, ".ninthwave/dir"), "/old/path\n");
    expect(existsSync(join(projectDir, ".ninthwave/dir"))).toBe(true);

    setupProject(projectDir, bundleDir, allPresentDeps);

    // Legacy file should be cleaned up
    expect(existsSync(join(projectDir, ".ninthwave/dir"))).toBe(false);
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
