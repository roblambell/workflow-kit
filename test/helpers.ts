// Test helper functions for ninthwave TypeScript tests.
// Provides temp git repo setup/teardown and fixture utilities.

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { afterEach } from "vitest";
import { normalizeDomain } from "../core/parser.ts";

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
 * Convert a fixture file into directory-based work item files.
 * Reads the fixture, splits it into individual items, and writes them
 * as separate .md files in repo/.ninthwave/work/.
 * Returns the path to the work items directory.
 */
export function useFixtureDir(repo: string, fixtureName: string): string {
  const src = join(TEST_DIR, "fixtures", fixtureName);
  const content = readFileSync(src, "utf-8");
  const workDir = join(repo, ".ninthwave", "work");
  mkdirSync(workDir, { recursive: true });

  // Parse the fixture to extract items with their section context
  const lines = content.split("\n");
  let currentSection = "";
  let currentItemLines: string[] = [];
  let currentItemId = "";
  let currentItemPriority = "";

  const flush = () => {
    if (!currentItemId || !currentItemPriority) return;

    const domain = normalizeDomain(currentSection);
    const priorityNum = { critical: 0, high: 1, medium: 2, low: 3 }[currentItemPriority] ?? 2;

    // Check if the item already has a **Domain:** line
    const hasDomain = currentItemLines.some((l) => l.startsWith("**Domain:**"));
    const insertLines = [...currentItemLines];
    if (!hasDomain) {
      // Insert **Domain:** after **Depends on:** (or after **Priority:** if no deps)
      let insertIdx = insertLines.findIndex((l) => l.startsWith("**Depends on:**"));
      if (insertIdx === -1) insertIdx = insertLines.findIndex((l) => l.startsWith("**Priority:**"));
      if (insertIdx >= 0) {
        insertLines.splice(insertIdx + 1, 0, `**Domain:** ${domain}`);
      }
    }

    const filename = `${priorityNum}-${domain}--${currentItemId}.md`;
    writeFileSync(join(workDir, filename), insertLines.join("\n") + "\n");

    currentItemLines = [];
    currentItemId = "";
    currentItemPriority = "";
  };

  for (const line of lines) {
    // Track section headers (## headings)
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      flush();
      currentSection = line.slice(3).trim();
      continue;
    }

    // Detect item header (### headings with an ID in parens)
    if (line.startsWith("### ")) {
      flush();
      const idMatch = line.match(/\(([A-Z]-[A-Za-z0-9]+-[0-9]+)\)/);
      if (idMatch) {
        currentItemId = idMatch[1]!;
        // Convert ### to # for the individual file format
        currentItemLines.push(`# ${line.slice(4).trim()}`);
      }
      continue;
    }

    // Skip separators between items
    if (line.trim() === "---") {
      continue;
    }

    // Skip top-level heading
    if (line.startsWith("# ") && !line.startsWith("## ") && !line.startsWith("### ")) {
      continue;
    }

    // Accumulate lines for the current item
    if (currentItemId) {
      // Extract priority from the item
      const pMatch = line.match(/^\*\*Priority:\*\*\s+(.+)/);
      if (pMatch) {
        currentItemPriority = pMatch[1]!.toLowerCase().replace(/ \(.*/, "").trim();
      }
      currentItemLines.push(line);
    }
  }

  flush();

  // Stage and commit
  git(repo, "add", ".ninthwave");
  spawnSync("git", ["-C", repo, "commit", "-m", "Add work item files", "--quiet"], {
    stdio: "pipe",
  });

  return workDir;
}

/**
 * Write inline work item content as individual directory-based work item files.
 * Parses content and writes to repo/.ninthwave/work/.
 * Returns the path to the work items directory.
 *
 * Usage:
 *   const workDir = writeWorkItemFiles(repo, `## Section\n### Feat: Item (H-FOO-1)\n...`);
 */
export function writeWorkItemFiles(repo: string, itemsContent: string): string {
  const workDir = join(repo, ".ninthwave", "work");
  mkdirSync(workDir, { recursive: true });

  const lines = itemsContent.split("\n");
  let currentSection = "";
  let currentItemLines: string[] = [];
  let currentItemId = "";
  let currentItemPriority = "";

  const flush = () => {
    if (!currentItemId || !currentItemPriority) return;

    const domain = normalizeDomain(currentSection);
    const priorityNum = { critical: 0, high: 1, medium: 2, low: 3 }[currentItemPriority] ?? 2;

    const hasDomain = currentItemLines.some((l) => l.startsWith("**Domain:**"));
    const insertLines = [...currentItemLines];
    if (!hasDomain) {
      let insertIdx = insertLines.findIndex((l) => l.startsWith("**Depends on:**"));
      if (insertIdx === -1) insertIdx = insertLines.findIndex((l) => l.startsWith("**Priority:**"));
      if (insertIdx >= 0) {
        insertLines.splice(insertIdx + 1, 0, `**Domain:** ${domain}`);
      }
    }

    const filename = `${priorityNum}-${domain}--${currentItemId}.md`;
    writeFileSync(join(workDir, filename), insertLines.join("\n") + "\n");

    currentItemLines = [];
    currentItemId = "";
    currentItemPriority = "";
  };

  for (const line of lines) {
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      flush();
      currentSection = line.slice(3).trim();
      continue;
    }

    if (line.startsWith("### ")) {
      flush();
      const idMatch = line.match(/\(([A-Z]-[A-Za-z0-9]+-[0-9]+)\)/);
      if (idMatch) {
        currentItemId = idMatch[1]!;
        currentItemLines.push(`# ${line.slice(4).trim()}`);
      }
      continue;
    }

    if (line.trim() === "---") continue;

    if (line.startsWith("# ") && !line.startsWith("## ") && !line.startsWith("### ")) {
      continue;
    }

    if (currentItemId) {
      const pMatch = line.match(/^\*\*Priority:\*\*\s+(.+)/);
      if (pMatch) {
        currentItemPriority = pMatch[1]!.toLowerCase().replace(/ \(.*/, "").trim();
      }
      currentItemLines.push(line);
    }
  }

  flush();

  return workDir;
}

/**
 * Create a temp repo with a bare remote configured as `origin` and an
 * initial commit pushed to origin/main. Returns the local repo path.
 *
 * Structure:
 *   <tmpdir>/local  — working repo with `origin` pointing to the bare remote
 *   <tmpdir>/bare   — bare remote
 */
export function setupTempRepoWithRemote(): string {
  const parent = mkdtempSync(join(tmpdir(), "nw-test-remote-"));
  tempDirs.push(parent);

  const bare = join(parent, "bare");
  const local = join(parent, "local");

  // Create bare remote with explicit main branch
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "--quiet", "--initial-branch=main");

  // Create local repo with explicit main branch
  mkdirSync(local, { recursive: true });
  git(local, "init", "--quiet", "--initial-branch=main");
  git(local, "config", "user.email", "test@test.com");
  git(local, "config", "user.name", "Test");
  git(local, "remote", "add", "origin", bare);

  // Initial commit and push to establish origin/main
  writeFileSync(join(local, ".gitkeep"), "");
  git(local, "add", ".gitkeep");
  git(local, "commit", "-m", "Initial commit", "--quiet");
  git(local, "push", "-u", "origin", "main", "--quiet");

  return local;
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
