// Test helper functions for ninthwave TypeScript tests.
// Provides temp git repo setup/teardown and fixture utilities.

import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { afterEach } from "vitest";

const TEST_DIR = import.meta.dirname;

// Track temp dirs for cleanup
const tempDirs: string[] = [];

/**
 * Create a minimal temp git repo. Returns its path.
 */
export function setupTempRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-test-"));
  tempDirs.push(tmp);

  git(tmp, "init", "--quiet");
  git(tmp, "config", "user.email", "test@test.com");
  git(tmp, "config", "user.name", "Test");

  return tmp;
}

/**
 * Create a hub + target repo pair as sibling directories.
 * Returns the hub repo path. Targets are at ../target-repo-a and ../target-repo-b.
 */
export function setupTempRepoPair(): string {
  const parent = mkdtempSync(join(tmpdir(), "nw-test-pair-"));
  tempDirs.push(parent);

  const hub = join(parent, "hub");
  const targetA = join(parent, "target-repo-a");
  const targetB = join(parent, "target-repo-b");

  // Create hub repo
  mkdirSync(hub, { recursive: true });
  git(hub, "init", "--quiet");
  git(hub, "config", "user.email", "test@test.com");
  git(hub, "config", "user.name", "Test");

  // Create target repos with initial commits
  for (const target of [targetA, targetB]) {
    mkdirSync(target, { recursive: true });
    git(target, "init", "--quiet");
    git(target, "config", "user.email", "test@test.com");
    git(target, "config", "user.name", "Test");
    spawnSync("touch", [join(target, ".gitkeep")]);
    git(target, "add", ".gitkeep");
    git(target, "commit", "-m", "Initial commit", "--quiet");
  }

  // Hub also needs an initial commit
  spawnSync("touch", [join(hub, ".gitkeep")]);
  git(hub, "add", ".gitkeep");
  git(hub, "commit", "-m", "Initial commit", "--quiet");

  return hub;
}

/**
 * Copy a fixture file as TODOS.md into the given repo.
 */
export function useFixture(repo: string, fixtureName: string): void {
  const src = join(TEST_DIR, "fixtures", fixtureName);
  const dest = join(repo, "TODOS.md");
  cpSync(src, dest);

  // Stage and commit so git tracks it
  git(repo, "add", "TODOS.md");
  spawnSync("git", ["-C", repo, "commit", "-m", "Add TODOS.md", "--quiet"], {
    stdio: "pipe",
  });
}

/**
 * Clean up all temp repos created during the test.
 */
export function cleanupTempRepos(): void {
  for (const d of tempDirs) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
}

/**
 * Register automatic cleanup after each test.
 * Call this at the top level of your test file's describe block.
 */
export function registerCleanup(): void {
  afterEach(() => {
    cleanupTempRepos();
  });
}

// Internal helper to run git commands
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0 && result.stderr) {
    // Don't throw on warnings, only real errors
    if (!result.stderr.includes("warning:")) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }
  return (result.stdout || "").trim();
}
