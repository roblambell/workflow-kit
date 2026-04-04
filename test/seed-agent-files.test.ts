// Tests for seedAgentFiles (mirror-based worktree seeding) and readAgentFileContent.

import { describe, it, expect, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { SeedAgentFilesDeps, SeededAgentFile } from "../core/agent-files.ts";
import { readAgentFileContent, seedAgentFiles } from "../core/agent-files.ts";
import type { RunResult } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nw-seed-test-"));
}

/** Write a file into a tool directory inside the given root. */
function writeToolFile(root: string, toolDir: string, filename: string, content: string): void {
  mkdirSync(join(root, toolDir), { recursive: true });
  writeFileSync(join(root, toolDir, filename), content);
}

function createDeps(overrides: Partial<SeedAgentFilesDeps> = {}): SeedAgentFilesDeps {
  return {
    run: vi.fn(() => ({ stdout: "", stderr: "", exitCode: 128 })) as any,
    readFileSync: readFileSync as any,
    readdirSync: readdirSync as any,
    existsSync: existsSync as any,
    mkdirSync: mkdirSync as any,
    writeFileSync: writeFileSync as any,
    info: vi.fn(),
    ...overrides,
  };
}

function seededPaths(seeded: SeededAgentFile[]): string[] {
  return seeded.map((entry) => entry.path);
}

// ── readAgentFileContent ─────────────────────────────────────────────

describe("readAgentFileContent", () => {
  it("reads from origin/main when available", () => {
    const hubRoot = makeTmpDir();
    const remoteContent = "# Agent prompt from remote\nRemote version";

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: remoteContent,
        stderr: "",
        exitCode: 0,
      })) as any,
    });

    const result = readAgentFileContent(hubRoot, "implementer.md", deps);

    expect(result).toBe(remoteContent);
    expect(deps.run).toHaveBeenCalledWith(
      "git",
      ["show", "origin/main:agents/implementer.md"],
      { cwd: hubRoot, timeout: expect.any(Number) },
    );

    rmSync(hubRoot, { recursive: true, force: true });
  });

  it("falls back to local filesystem when git show fails", () => {
    const hubRoot = makeTmpDir();
    const localContent = "# Agent prompt from local\nLocal version";

    // Create local agent file
    mkdirSync(join(hubRoot, "agents"), { recursive: true });
    writeFileSync(join(hubRoot, "agents", "implementer.md"), localContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: path 'agents/implementer.md' does not exist",
        exitCode: 128,
      })) as any,
    });

    const result = readAgentFileContent(hubRoot, "implementer.md", deps);

    expect(result).toBe(localContent);
    // Verify git was attempted first
    expect(deps.run).toHaveBeenCalled();

    rmSync(hubRoot, { recursive: true, force: true });
  });

  it("falls back to local when agents/ directory does not exist on remote", () => {
    const hubRoot = makeTmpDir();
    const localContent = "# Local agent\nFallback content";

    mkdirSync(join(hubRoot, "agents"), { recursive: true });
    writeFileSync(join(hubRoot, "agents", "reviewer.md"), localContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: Invalid object name 'origin/main'",
        exitCode: 128,
      })) as any,
    });

    const result = readAgentFileContent(hubRoot, "reviewer.md", deps);

    expect(result).toBe(localContent);

    rmSync(hubRoot, { recursive: true, force: true });
  });

  it("returns null when file is not available from either source", () => {
    const hubRoot = makeTmpDir();

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: not found",
        exitCode: 128,
      })) as any,
    });

    const result = readAgentFileContent(hubRoot, "nonexistent.md", deps);

    expect(result).toBeNull();

    rmSync(hubRoot, { recursive: true, force: true });
  });

  it("prefers remote over local when both exist", () => {
    const hubRoot = makeTmpDir();
    const remoteContent = "# Remote version\nUpdated content";
    const localContent = "# Local version\nOutdated content";

    mkdirSync(join(hubRoot, "agents"), { recursive: true });
    writeFileSync(join(hubRoot, "agents", "implementer.md"), localContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: remoteContent,
        stderr: "",
        exitCode: 0,
      })) as any,
    });

    const result = readAgentFileContent(hubRoot, "implementer.md", deps);

    expect(result).toBe(remoteContent);

    rmSync(hubRoot, { recursive: true, force: true });
  });
});

// ── seedAgentFiles ───────────────────────────────────────────────────

describe("seedAgentFiles", () => {
  it("copies missing agent files from main checkout to worktree", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const agentContent = "# Implementer agent\nCustom content";

    // Simulate main checkout with agent files in tool directories
    writeToolFile(projectRoot, ".claude/agents", "implementer.md", agentContent);
    writeToolFile(projectRoot, ".github/agents", "ninthwave-implementer.agent.md", agentContent);

    const deps = createDeps();
    const seeded = seedAgentFiles(worktree, projectRoot, deps);

    expect(seeded.length).toBe(2);
    expect(seededPaths(seeded)).toContain(join(".claude/agents", "implementer.md"));
    expect(seededPaths(seeded)).toContain(join(".github/agents", "ninthwave-implementer.agent.md"));

    // Verify content was copied exactly
    expect(readFileSync(join(worktree, ".claude/agents/implementer.md"), "utf-8")).toBe(agentContent);
    expect(readFileSync(join(worktree, ".github/agents/ninthwave-implementer.agent.md"), "utf-8")).toBe(agentContent);

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("skips files that already exist in worktree", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".claude/agents", "implementer.md", "# From main checkout");

    // Pre-create the file in the worktree (as if committed via git)
    writeToolFile(worktree, ".claude/agents", "implementer.md", "# Already in worktree");

    const deps = createDeps();
    const seeded = seedAgentFiles(worktree, projectRoot, deps);

    // Should not be in the seeded list
    expect(seededPaths(seeded)).not.toContain(join(".claude/agents", "implementer.md"));

    // Original worktree content should be preserved
    expect(readFileSync(join(worktree, ".claude/agents/implementer.md"), "utf-8")).toBe("# Already in worktree");

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("returns empty array when project root has no tool directories", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    const deps = createDeps();
    const seeded = seedAgentFiles(worktree, projectRoot, deps);

    expect(seeded).toEqual([]);

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("preserves user-owned non-agent files in existing directories", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".codex/agents", "ninthwave-implementer.toml", "# Agent");

    // Pre-create a user file in the worktree
    writeToolFile(worktree, ".codex/agents", "custom.toml", 'name = "custom"\n');

    const deps = createDeps();
    seedAgentFiles(worktree, projectRoot, deps);

    // User file preserved
    expect(readFileSync(join(worktree, ".codex/agents/custom.toml"), "utf-8")).toBe('name = "custom"\n');
    // Agent file seeded
    expect(existsSync(join(worktree, ".codex/agents/ninthwave-implementer.toml"))).toBe(true);

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("only seeds files with .md or .toml extensions", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".claude/agents", "implementer.md", "# Agent");
    writeToolFile(projectRoot, ".claude/agents", "notes.txt", "not an agent");
    writeToolFile(projectRoot, ".claude/agents", "config.json", '{}');

    const deps = createDeps();
    const seeded = seedAgentFiles(worktree, projectRoot, deps);

    expect(seededPaths(seeded)).toEqual([join(".claude/agents", "implementer.md")]);

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("does not create or overwrite user instruction files while seeding agents", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".github/agents", "ninthwave-implementer.agent.md", "# Agent");

    // Pre-create user-managed files in worktree
    writeFileSync(join(worktree, "CLAUDE.md"), "# Worktree instructions\n");
    writeFileSync(join(worktree, "AGENTS.md"), "# Agent instructions\n");
    mkdirSync(join(worktree, ".github"), { recursive: true });
    writeFileSync(
      join(worktree, ".github", "copilot-instructions.md"),
      "# Copilot instructions\nKeep this user-managed file.\n",
    );

    const deps = createDeps();
    seedAgentFiles(worktree, projectRoot, deps);

    // User files should be untouched
    expect(readFileSync(join(worktree, "CLAUDE.md"), "utf-8")).toBe("# Worktree instructions\n");
    expect(readFileSync(join(worktree, "AGENTS.md"), "utf-8")).toBe("# Agent instructions\n");
    expect(readFileSync(join(worktree, ".github", "copilot-instructions.md"), "utf-8")).toBe(
      "# Copilot instructions\nKeep this user-managed file.\n",
    );

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("seeds files across multiple tool directories", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".claude/agents", "implementer.md", "# Claude agent");
    writeToolFile(projectRoot, ".opencode/agents", "implementer.md", "# OpenCode agent");
    writeToolFile(projectRoot, ".codex/agents", "ninthwave-implementer.toml", "# Codex agent");
    writeToolFile(projectRoot, ".github/agents", "ninthwave-implementer.agent.md", "# GitHub agent");

    const deps = createDeps();
    const seeded = seedAgentFiles(worktree, projectRoot, deps);

    expect(seeded.length).toBe(4);
    expect(existsSync(join(worktree, ".claude/agents/implementer.md"))).toBe(true);
    expect(existsSync(join(worktree, ".opencode/agents/implementer.md"))).toBe(true);
    expect(existsSync(join(worktree, ".codex/agents/ninthwave-implementer.toml"))).toBe(true);
    expect(existsSync(join(worktree, ".github/agents/ninthwave-implementer.agent.md"))).toBe(true);

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("marks gitignored seeded files as not commit recommended", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".claude/agents", "implementer.md", "# Agent");
    writeToolFile(projectRoot, ".github/agents", "ninthwave-implementer.agent.md", "# Agent");
    writeFileSync(join(worktree, ".gitignore"), "/.claude/agents/\n");

    const deps = createDeps({
      run: vi.fn((_cmd: string, args: string[]) => {
        if (args[0] === "check-ignore" && args[2] === ".claude/agents/implementer.md") {
          return { stdout: ".claude/agents/implementer.md", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      }) as any,
    });

    const seeded = seedAgentFiles(worktree, projectRoot, deps);
    const claudeEntry = seeded.find((entry) => entry.path === join(".claude/agents", "implementer.md"));
    const githubEntry = seeded.find((entry) => entry.path === join(".github/agents", "ninthwave-implementer.agent.md"));

    expect(claudeEntry).toEqual({
      path: join(".claude/agents", "implementer.md"),
      commitRecommended: false,
    });
    expect(githubEntry).toEqual({
      path: join(".github/agents", "ninthwave-implementer.agent.md"),
      commitRecommended: true,
    });

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("copies customized agent content exactly as-is", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const customContent = "---\nname: custom-implementer\nmodel: sonnet\n---\n# My customized agent\nSpecial instructions here";

    writeToolFile(projectRoot, ".claude/agents", "implementer.md", customContent);

    const deps = createDeps();
    seedAgentFiles(worktree, projectRoot, deps);

    // Content should be an exact copy, not re-rendered from a canonical source
    expect(readFileSync(join(worktree, ".claude/agents/implementer.md"), "utf-8")).toBe(customContent);

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("logs seeded files when any are created", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeToolFile(projectRoot, ".claude/agents", "implementer.md", "# Agent");

    const deps = createDeps();
    seedAgentFiles(worktree, projectRoot, deps);

    expect(deps.info).toHaveBeenCalledWith(
      expect.stringContaining("Seeded agent files into worktree:"),
    );

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("does not log when no files are seeded", () => {
    const projectRoot = makeTmpDir();
    const worktree = makeTmpDir();

    const deps = createDeps();
    seedAgentFiles(worktree, projectRoot, deps);

    expect(deps.info).not.toHaveBeenCalled();

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });
});
