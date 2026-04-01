// Tests for seedAgentFiles and readAgentFileContent -- verifying
// remote-first agent file seeding with local fallback.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { SeedAgentFilesDeps } from "../core/agent-files.ts";
import { readAgentFileContent, seedAgentFiles } from "../core/agent-files.ts";
import type { RunResult } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nw-seed-test-"));
}

function writeAgentFile(hubRoot: string, filename: string, content = "# Agent\n"): void {
  mkdirSync(join(hubRoot, "agents"), { recursive: true });
  writeFileSync(join(hubRoot, "agents", filename), content);
}

/** Create a mock run function that simulates git show results. */
function mockRun(
  results: Record<string, RunResult>,
): (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => RunResult {
  return (_cmd: string, args: string[], _opts?: { cwd?: string; timeout?: number }) => {
    // Build a key from the git show ref arg (e.g., "origin/main:agents/implementer.md")
    const showArg = args.find((a) => a.startsWith("origin/main:"));
    const key = showArg ?? args.join(" ");
    return results[key] ?? { stdout: "", stderr: "fatal: not found", exitCode: 128 };
  };
}

function createDeps(overrides: Partial<SeedAgentFilesDeps> = {}): SeedAgentFilesDeps {
  return {
    run: vi.fn(() => ({ stdout: "", stderr: "", exitCode: 128 })) as any,
    readFileSync: readFileSync as any,
    existsSync: existsSync as any,
    mkdirSync: mkdirSync as any,
    writeFileSync: writeFileSync as any,
    info: vi.fn(),
    ...overrides,
  };
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
  it("seeds agent files from origin/main into worktree", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const remoteContent = "# Implementer agent\nFrom remote";

    writeAgentFile(hubRoot, "implementer.md");

    const deps = createDeps({
      run: vi.fn((_cmd: string, args: string[]) => {
        const showArg = args.find((a: string) => a.startsWith("origin/main:"));
        if (showArg) {
          return { stdout: remoteContent, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 128 };
      }) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    // Should seed all target directories for each agent file
    expect(seeded.length).toBeGreaterThan(0);

    // Verify content was written from remote
    const claudeAgent = join(worktree, ".claude/agents/implementer.md");
    expect(existsSync(claudeAgent)).toBe(true);
    expect(readFileSync(claudeAgent, "utf-8")).toBe(remoteContent);

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("falls back to local files when git show fails", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const localContent = "# Implementer agent\nFrom local";

    // Create all three agent files locally
    writeAgentFile(hubRoot, "implementer.md", localContent);
    writeAgentFile(hubRoot, "reviewer.md", localContent);
    writeAgentFile(hubRoot, "forward-fixer.md", localContent);
    writeAgentFile(hubRoot, "rebaser.md", localContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: not found",
        exitCode: 128,
      })) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    expect(seeded.length).toBeGreaterThan(0);

    // Verify content came from local
    const claudeAgent = join(worktree, ".claude/agents/implementer.md");
    expect(existsSync(claudeAgent)).toBe(true);
    expect(readFileSync(claudeAgent, "utf-8")).toBe(localContent);

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("seeds explicit inbox and rebase instructions in implementer artifacts", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const localContent = readFileSync(join(import.meta.dirname, "..", "agents", "implementer.md"), "utf-8");

    mkdirSync(join(hubRoot, "agents"), { recursive: true });
    writeFileSync(join(hubRoot, "agents", "implementer.md"), localContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: not found",
        exitCode: 128,
      })) as any,
    });

    seedAgentFiles(worktree, hubRoot, deps);

    const claudeAgent = join(worktree, ".claude/agents/implementer.md");
    const githubAgent = join(worktree, ".github/agents/ninthwave-implementer.agent.md");
    const claudePrompt = readFileSync(claudeAgent, "utf-8");
    const githubPrompt = readFileSync(githubAgent, "utf-8");

    expect(claudePrompt).toContain("nw inbox --check YOUR_TODO_ID");
    expect(claudePrompt).toContain("nw inbox --wait YOUR_TODO_ID");
    expect(claudePrompt).toContain("set the timeout to the longest practical value available");
    expect(claudePrompt).toContain("immediately run the same wait command again");
    expect(claudePrompt).toContain("The daemon owns that lifecycle automation");
    expect(claudePrompt).toContain("Do not assume the daemon will perform the rebase for you.");
    expect(claudePrompt).toContain("Some daemon nudges may be plain-language inbox messages");
    expect(claudePrompt).toContain("if you receive one in either structured or plain-language form, you are required to act on it.");
    expect(claudePrompt).toContain("If `BASE_BRANCH` is set in your prompt: `git fetch origin $BASE_BRANCH --quiet && git rebase origin/$BASE_BRANCH`");
    expect(claudePrompt).toContain("If `BASE_BRANCH` is not set: `git fetch origin main --quiet && git rebase origin/main`");
    expect(claudePrompt).toContain("Do **not** `git rebase --abort` just because conflicts appeared");
    expect(claudePrompt).toContain("Required outcome: do not go back to idle until the branch is either successfully rebased and force-pushed, or you have posted the blocker comment for a genuinely non-trivial conflict");
    expect(githubPrompt).toContain("Do not assume the daemon will perform the rebase for you.");
    expect(githubPrompt).toContain("Some daemon nudges may be plain-language inbox messages");

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("skips files that are already up to date in worktree", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const existingContent = "# Remote agent file";
    const remoteContent = "# Remote agent file";

    writeAgentFile(hubRoot, "implementer.md");

    // Pre-create the file in the worktree
    mkdirSync(join(worktree, ".claude/agents"), { recursive: true });
    writeFileSync(join(worktree, ".claude/agents/implementer.md"), existingContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: remoteContent,
        stderr: "",
        exitCode: 0,
      })) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    // .claude/agents/implementer.md should NOT be in the seeded list
    expect(seeded).not.toContain(".claude/agents/implementer.md");

    // Existing file should NOT be overwritten
    expect(readFileSync(join(worktree, ".claude/agents/implementer.md"), "utf-8")).toBe(existingContent);

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("refreshes stale managed files that already exist in worktree", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const remoteContent = "# Remote agent file";

    writeAgentFile(hubRoot, "implementer.md");

    mkdirSync(join(worktree, ".claude/agents"), { recursive: true });
    writeFileSync(join(worktree, ".claude/agents/implementer.md"), "# Stale agent file");

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: remoteContent,
        stderr: "",
        exitCode: 0,
      })) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    expect(seeded).toContain(".claude/agents/implementer.md");
    expect(readFileSync(join(worktree, ".claude/agents/implementer.md"), "utf-8")).toBe(
      remoteContent,
    );

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("uses local version when file exists locally but not on remote", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const localContent = "# Local-only agent";

    writeAgentFile(hubRoot, "implementer.md", localContent);
    // reviewer and forward-fixer don't exist anywhere

    // Git show fails for everything
    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: not found",
        exitCode: 128,
      })) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    // implementer should be seeded from local
    const claudeAgent = join(worktree, ".claude/agents/implementer.md");
    expect(existsSync(claudeAgent)).toBe(true);
    expect(readFileSync(claudeAgent, "utf-8")).toBe(localContent);

    // reviewer and forward-fixer should not be seeded (not available from either source)
    expect(seeded.some((s) => s.includes("reviewer"))).toBe(false);
    expect(seeded.some((s) => s.includes("forward-fixer"))).toBe(false);

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("seeds .github/agents/ with ninthwave- prefix", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const remoteContent = "# Implementer from remote";

    writeAgentFile(hubRoot, "implementer.md");

    const deps = createDeps({
      run: vi.fn((_cmd: string, args: string[]) => {
        const showArg = args.find((a: string) => a.startsWith("origin/main:"));
        if (showArg) {
          return { stdout: remoteContent, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 128 };
      }) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    // .github/agents/ files should have ninthwave- prefix and .agent.md suffix
    expect(seeded).toContain(join(".github/agents", "ninthwave-implementer.agent.md"));
    const ghAgent = join(worktree, ".github/agents/ninthwave-implementer.agent.md");
    expect(existsSync(ghAgent)).toBe(true);
    expect(readFileSync(ghAgent, "utf-8")).toBe(remoteContent);

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("does not create or overwrite user instruction files while seeding agents", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();

    writeAgentFile(hubRoot, "implementer.md");
    writeFileSync(join(worktree, "CLAUDE.md"), "# Worktree instructions\n");
    writeFileSync(join(worktree, "AGENTS.md"), "# Agent instructions\n");
    mkdirSync(join(worktree, ".github"), { recursive: true });
    writeFileSync(
      join(worktree, ".github", "copilot-instructions.md"),
      "# Copilot instructions\nKeep this user-managed file.\n",
    );

    const deps = createDeps({
      run: mockRun({
        "origin/main:agents/implementer.md": { stdout: "# Remote implementer\n", stderr: "", exitCode: 0 },
      }) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    expect(seeded).not.toContain(join(".github", "copilot-instructions.md"));
    expect(seeded).not.toContain("CLAUDE.md");
    expect(seeded).not.toContain("AGENTS.md");
    expect(readFileSync(join(worktree, "CLAUDE.md"), "utf-8")).toBe("# Worktree instructions\n");
    expect(readFileSync(join(worktree, "AGENTS.md"), "utf-8")).toBe("# Agent instructions\n");
    expect(readFileSync(join(worktree, ".github", "copilot-instructions.md"), "utf-8")).toBe(
      "# Copilot instructions\nKeep this user-managed file.\n",
    );

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it("seeds newly discovered agent files from the hub bundle", () => {
    const hubRoot = makeTmpDir();
    const worktree = makeTmpDir();
    const customContent = "# Custom agent\nFrom local";

    writeAgentFile(hubRoot, "custom-agent.md", customContent);

    const deps = createDeps({
      run: vi.fn(() => ({
        stdout: "",
        stderr: "fatal: not found",
        exitCode: 128,
      })) as any,
    });

    const seeded = seedAgentFiles(worktree, hubRoot, deps);

    expect(seeded).toContain(join(".claude/agents", "custom-agent.md"));
    expect(seeded).toContain(join(".github/agents", "ninthwave-custom-agent.agent.md"));
    expect(readFileSync(join(worktree, ".claude/agents/custom-agent.md"), "utf-8")).toBe(customContent);

    rmSync(hubRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });
});
