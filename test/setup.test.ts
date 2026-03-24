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
} from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import {
  setupProject,
  setupGlobal,
  createSkillSymlinks,
} from "../core/commands/setup.ts";

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

describe("setupProject", () => {
  it("creates .ninthwave/ directory with dir, work shim, config, and domains.conf", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir);

    // .ninthwave/dir records bundle location
    expect(existsSync(join(projectDir, ".ninthwave/dir"))).toBe(true);
    const dirContent = readFileSync(
      join(projectDir, ".ninthwave/dir"),
      "utf-8",
    );
    expect(dirContent.trim()).toBe(bundleDir);

    // .ninthwave/work is executable shim
    expect(existsSync(join(projectDir, ".ninthwave/work"))).toBe(true);
    const shimContent = readFileSync(
      join(projectDir, ".ninthwave/work"),
      "utf-8",
    );
    expect(shimContent).toContain("#!/usr/bin/env bash");
    expect(shimContent).toContain("exec bun run");

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

    setupProject(projectDir, bundleDir);

    expect(existsSync(join(projectDir, "TODOS.md"))).toBe(true);
    const content = readFileSync(join(projectDir, "TODOS.md"), "utf-8");
    expect(content).toContain("# TODOS");
  });

  it("creates skill symlinks in .claude/skills/", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir);

    for (const skill of [
      "work",
      "decompose",
      "todo-preview",
      "ninthwave-upgrade",
    ]) {
      const linkPath = join(projectDir, ".claude/skills", skill);
      expect(existsSync(linkPath)).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }
  });

  it("copies agent files to .claude, .opencode, and .github directories", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir);

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

    setupProject(projectDir, bundleDir);

    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".worktrees/");
  });

  it("appends to existing .gitignore without duplicating", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // Pre-create .gitignore with some content
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n");

    setupProject(projectDir, bundleDir);

    const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".worktrees/");

    // Run again — should not duplicate
    setupProject(projectDir, bundleDir);

    const content2 = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    const matches = content2.match(/\.worktrees\//g);
    expect(matches).toHaveLength(1);
  });

  it("records version in .ninthwave/version", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    setupProject(projectDir, bundleDir);

    expect(existsSync(join(projectDir, ".ninthwave/version"))).toBe(true);
    const version = readFileSync(
      join(projectDir, ".ninthwave/version"),
      "utf-8",
    );
    // Should have some version string (git describe output)
    expect(version.trim()).toBeTruthy();
  });
});

describe("setupProject — idempotency", () => {
  it("running setup twice produces the same result", () => {
    const projectDir = setupTempRepo();
    const bundleDir = createFakeBundle(projectDir + "-bundle-parent");

    // First run
    setupProject(projectDir, bundleDir);

    // Capture state after first run
    const firstDir = readFileSync(
      join(projectDir, ".ninthwave/dir"),
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
    setupProject(projectDir, bundleDir);

    // Verify state is identical
    expect(readFileSync(join(projectDir, ".ninthwave/dir"), "utf-8")).toBe(
      firstDir,
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

    setupProject(projectDir, bundleDir);

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

    setupProject(projectDir, bundleDir);

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

    setupProject(projectDir, bundleDir);

    const todos = readFileSync(join(projectDir, "TODOS.md"), "utf-8");
    expect(todos).toContain("My Project TODOs");
    expect(todos).toContain("Task 1");
  });
});

describe("setupGlobal", () => {
  it("creates skill symlinks in ~/.claude/skills/", () => {
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
