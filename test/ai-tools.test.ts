// Unit tests for core/ai-tools.ts -- AI tool profile module.

import { describe, it, expect, vi } from "vitest";
import {
  AI_TOOL_PROFILES,
  getToolProfile,
  allToolIds,
  isAiToolId,
  agentTargetDirs,
  agentFileTargets,
  agentTargetFilename,
  runtimeAgentIdFromFilename,
  runtimeAgentNameForTool,
  type LaunchDeps,
  type LaunchOpts,
} from "../core/ai-tools.ts";

// ── Stub helpers ──────────────────────────────────────────────────────────────

function stubDeps(promptContent = "PROMPT_CONTENT"): LaunchDeps & {
  writeFileSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  return {
    readFileSync: vi.fn((_path: string, _enc: BufferEncoding) => promptContent) as any,
    writeFileSync: vi.fn() as any,
    mkdirSync: vi.fn() as any,
    run: vi.fn() as any,
  };
}

function stubOpts(overrides: Partial<LaunchOpts> = {}): LaunchOpts {
  return {
    wsName: "test-ws",
    agentName: "ninthwave-implementer",
    promptFile: "/fake/.ninthwave/.prompt",
    id: "H-TEST-1",
    stateDir: "/fake/state",
    ...overrides,
  };
}

// ── getToolProfile ────────────────────────────────────────────────────────────

describe("getToolProfile", () => {
  it("returns the claude profile for 'claude'", () => {
    const profile = getToolProfile("claude");
    expect(profile.id).toBe("claude");
    expect(profile.targetDir).toBe(".claude/agents");
    expect(profile.suffix).toBe(".md");
  });

  it("returns the opencode profile for 'opencode'", () => {
    const profile = getToolProfile("opencode");
    expect(profile.id).toBe("opencode");
    expect(profile.targetDir).toBe(".opencode/agents");
    expect(profile.suffix).toBe(".md");
  });

  it("returns the copilot profile for 'copilot'", () => {
    const profile = getToolProfile("copilot");
    expect(profile.id).toBe("copilot");
    expect(profile.targetDir).toBe(".github/agents");
    expect(profile.suffix).toBe(".agent.md");
  });

  it("throws for an unknown tool ID", () => {
    expect(() => getToolProfile("unknown")).toThrow("Unknown AI tool: unknown");
  });

  it("throws for an empty string", () => {
    expect(() => getToolProfile("")).toThrow("Unknown AI tool:");
  });
});

// ── allToolIds ────────────────────────────────────────────────────────────────

describe("allToolIds", () => {
  it("returns exactly [claude, opencode, copilot] in profile order", () => {
    expect(allToolIds()).toEqual(["claude", "opencode", "copilot"]);
  });
});

// ── isAiToolId ────────────────────────────────────────────────────────────────

describe("isAiToolId", () => {
  it("returns true for 'claude'", () => {
    expect(isAiToolId("claude")).toBe(true);
  });

  it("returns true for 'opencode'", () => {
    expect(isAiToolId("opencode")).toBe(true);
  });

  it("returns true for 'copilot'", () => {
    expect(isAiToolId("copilot")).toBe(true);
  });

  it("returns false for 'cursor'", () => {
    expect(isAiToolId("cursor")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isAiToolId("")).toBe(false);
  });

  it("returns false for 'CLAUDE' (case-sensitive)", () => {
    expect(isAiToolId("CLAUDE")).toBe(false);
  });
});

// ── agentTargetDirs ───────────────────────────────────────────────────────────

describe("agentTargetDirs", () => {
  it("returns one target dir entry per tool, in profile order", () => {
    const dirs = agentTargetDirs();
    expect(dirs).toHaveLength(3);
  });

  it("has the claude entry first with correct dir and suffix", () => {
    const dirs = agentTargetDirs();
    expect(dirs[0]).toEqual({ dir: ".claude/agents", suffix: ".md" });
  });

  it("has the opencode entry second with correct dir and suffix", () => {
    const dirs = agentTargetDirs();
    expect(dirs[1]).toEqual({ dir: ".opencode/agents", suffix: ".md" });
  });

  it("has the copilot entry third with correct dir and suffix", () => {
    const dirs = agentTargetDirs();
    expect(dirs[2]).toEqual({ dir: ".github/agents", suffix: ".agent.md" });
  });

  it("matches the full expected structure", () => {
    expect(agentTargetDirs()).toEqual([
      { dir: ".claude/agents", suffix: ".md" },
      { dir: ".opencode/agents", suffix: ".md" },
      { dir: ".github/agents", suffix: ".agent.md" },
    ]);
  });
});

// ── agentFileTargets ──────────────────────────────────────────────────────────

describe("agentFileTargets", () => {
  it("returns one entry for a single source", () => {
    const entries = agentFileTargets(["implementer.md"]);
    expect(entries).toHaveLength(1);
  });

  it("maps implementer.md to correct source and 3 targets", () => {
    const entries = agentFileTargets(["implementer.md"]);
    expect(entries[0]!.source).toBe("implementer.md");
    expect(entries[0]!.targets).toHaveLength(3);
  });

  it("maps implementer.md targets correctly for all 3 tools", () => {
    const entries = agentFileTargets(["implementer.md"]);
    expect(entries[0]!.targets).toEqual([
      { dir: ".claude/agents", suffix: ".md" },
      { dir: ".opencode/agents", suffix: ".md" },
      { dir: ".github/agents", suffix: ".agent.md" },
    ]);
  });

  it("returns entries for multiple sources", () => {
    const entries = agentFileTargets(["implementer.md", "reviewer.md", "forward-fixer.md"]);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.source)).toEqual(["implementer.md", "reviewer.md", "forward-fixer.md"]);
  });

  it("all sources share the same targets array structure", () => {
    const entries = agentFileTargets(["implementer.md", "reviewer.md"]);
    expect(entries[0]!.targets).toEqual(entries[1]!.targets);
  });

  it("returns empty array for empty sources", () => {
    expect(agentFileTargets([])).toEqual([]);
  });
});

// ── agentTargetFilename / runtime agent IDs ──────────────────────────────────

describe("Copilot agent artifact alignment helpers", () => {
  it("builds ninthwave-prefixed Copilot filenames from source files", () => {
    expect(agentTargetFilename("implementer.md", { suffix: ".agent.md" })).toBe(
      "ninthwave-implementer.agent.md",
    );
  });

  it("keeps Claude/OpenCode filenames equal to the source filename", () => {
    expect(agentTargetFilename("implementer.md", { suffix: ".md" })).toBe("implementer.md");
  });

  it("derives the runtime Copilot agent id from the generated filename", () => {
    expect(runtimeAgentIdFromFilename("ninthwave-reviewer.agent.md", ".agent.md")).toBe(
      "ninthwave-reviewer",
    );
  });

  it("resolves the Copilot runtime id from the generated rebaser artifact", () => {
    expect(runtimeAgentNameForTool("copilot", "ninthwave-rebaser")).toBe("ninthwave-rebaser");
  });

  it("leaves non-Copilot launch agent names unchanged", () => {
    expect(runtimeAgentNameForTool("claude", "ninthwave-reviewer")).toBe("ninthwave-reviewer");
    expect(runtimeAgentNameForTool("opencode", "ninthwave-reviewer")).toBe("ninthwave-reviewer");
  });
});

// ── buildLaunchCmd: claude ────────────────────────────────────────────────────

describe("claude profile buildLaunchCmd", () => {
  it("returns a cmd containing the workspace name", () => {
    const profile = getToolProfile("claude");
    const deps = stubDeps();
    const opts = stubOpts({ wsName: "H-TEST-1 my item" });
    const result = profile.buildLaunchCmd(opts, deps);
    expect(result.cmd).toContain("H-TEST-1 my item");
  });

  it("returns a cmd containing the agent name", () => {
    const profile = getToolProfile("claude");
    const deps = stubDeps();
    const opts = stubOpts({ agentName: "ninthwave-implementer" });
    const result = profile.buildLaunchCmd(opts, deps);
    expect(result.cmd).toContain("ninthwave-implementer");
  });

  it("returns a cmd with --permission-mode bypassPermissions", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildLaunchCmd(stubOpts(), stubDeps());
    expect(result.cmd).toContain("--permission-mode bypassPermissions");
  });

  it("returns a cmd with --append-system-prompt referencing .ninthwave/.prompt", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildLaunchCmd(stubOpts(), stubDeps());
    expect(result.cmd).toContain(".ninthwave/.prompt");
  });

  it("returns empty initialPrompt (prompt is embedded in cmd)", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildLaunchCmd(stubOpts(), stubDeps());
    expect(result.initialPrompt).toBe("");
  });

  it("does not call readFileSync (prompt is not read at build time)", () => {
    const profile = getToolProfile("claude");
    const deps = stubDeps();
    profile.buildLaunchCmd(stubOpts(), deps);
    expect(deps.readFileSync).not.toHaveBeenCalled();
  });
});

// ── buildHeadlessCmd: claude ──────────────────────────────────────────────────

describe("claude profile buildHeadlessCmd", () => {
  it("returns a cmd with --print and a positional Start prompt", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.cmd).toContain("claude --print");
    expect(result.cmd).toContain('"Start"');
  });

  it("returns a cmd with --permission-mode bypassPermissions", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.cmd).toContain("--permission-mode bypassPermissions");
  });

  it("returns a cmd containing the agent name", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildHeadlessCmd(stubOpts({ agentName: "ninthwave-implementer" }), stubDeps());
    expect(result.cmd).toContain("--agent ninthwave-implementer");
  });

  it("returns a cmd with --append-system-prompt referencing .ninthwave/.prompt", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.cmd).toContain("--append-system-prompt");
    expect(result.cmd).toContain(".ninthwave/.prompt");
  });

  it("does not include --name in headless mode", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.cmd).not.toContain("--name");
  });

  it("returns empty initialPrompt", () => {
    const profile = getToolProfile("claude");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.initialPrompt).toBe("");
  });
});

// ── buildLaunchCmd: opencode ──────────────────────────────────────────────────

describe("opencode profile buildLaunchCmd", () => {
  it("returns an inline shell command (no .sh script file)", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildLaunchCmd(stubOpts({ id: "H-X-1" }), stubDeps());
    expect(result.cmd).not.toMatch(/\.sh$/);
    expect(result.cmd).toContain("exec opencode");
  });

  it("returns empty initialPrompt (prompt is embedded via --prompt)", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildLaunchCmd(stubOpts(), stubDeps());
    expect(result.initialPrompt).toBe("");
  });

  it("reads the promptFile to embed in the inline command", () => {
    const profile = getToolProfile("opencode");
    const deps = stubDeps("OPENCODE PROMPT");
    const opts = stubOpts({ promptFile: "/some/.ninthwave/.prompt" });
    profile.buildLaunchCmd(opts, deps);
    expect(deps.readFileSync).toHaveBeenCalledWith("/some/.ninthwave/.prompt", "utf-8");
  });

  it("writes the prompt data file with start instruction appended", () => {
    const profile = getToolProfile("opencode");
    const deps = stubDeps("MY PROMPT");
    profile.buildLaunchCmd(stubOpts({ id: "H-X-2" }), deps);

    const calls = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatch(/^\/fake\/state\/tmp\/nw-prompt-H-X-2-\d+$/);
    expect(calls[0]![1]).toContain("MY PROMPT");
    expect(calls[0]![1]).toContain("Start implementing this work item now.");
  });

  it("inline cmd contains correct opencode command and args", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildLaunchCmd(stubOpts({ id: "H-X-3", agentName: "ninthwave-implementer", wsName: "H-X-3 My Title" }), stubDeps());
    expect(result.cmd).toContain("opencode --agent ninthwave-implementer --prompt");
    expect(result.cmd).toContain("OPENCODE_PERMISSION");
  });

  it("sets OPENCODE_PERMISSION for auto-approval in inline cmd", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildLaunchCmd(stubOpts({ id: "H-X-5" }), stubDeps());
    expect(result.cmd).toContain('"permission":"allow"');
  });

  it("does not call chmod (no executable scripts created)", () => {
    const profile = getToolProfile("opencode");
    const deps = stubDeps();
    profile.buildLaunchCmd(stubOpts({ id: "H-X-4" }), deps);

    expect(deps.run).not.toHaveBeenCalled();
  });

  it("inline cmd references the work item id via prompt data file", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildLaunchCmd(stubOpts({ id: "UNIQUE-ID" }), stubDeps());
    expect(result.cmd).toContain("UNIQUE-ID");
  });

  it("writes exactly 1 file (prompt data only, no launcher script)", () => {
    const profile = getToolProfile("opencode");
    const deps = stubDeps();
    profile.buildLaunchCmd(stubOpts(), deps);
    expect((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ── buildHeadlessCmd: opencode ────────────────────────────────────────────────

describe("opencode profile buildHeadlessCmd", () => {
  it("returns empty initialPrompt", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.initialPrompt).toBe("");
  });

  it("writes and references a temp prompt file", () => {
    const profile = getToolProfile("opencode");
    const deps = stubDeps("OPENCODE PROMPT");
    profile.buildHeadlessCmd(stubOpts({ id: "H-X-HEADLESS" }), deps);

    const calls = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatch(/^\/fake\/state\/tmp\/nw-prompt-H-X-HEADLESS-\d+$/);
    expect(calls[0]![1]).toContain("OPENCODE PROMPT");
    expect(calls[0]![1]).toContain("Start implementing this work item now.");
  });

  it("uses the run subcommand with the prompt and agent", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildHeadlessCmd(stubOpts({ id: "H-X-HEADLESS", agentName: "ninthwave-implementer" }), stubDeps());
    expect(result.cmd).toContain("exec opencode run \"$PROMPT\" --agent ninthwave-implementer");
  });

  it("sets OPENCODE_PERMISSION for non-interactive auto-approval", () => {
    const profile = getToolProfile("opencode");
    const result = profile.buildHeadlessCmd(stubOpts({ id: "H-X-HEADLESS" }), stubDeps());
    expect(result.cmd).toContain("OPENCODE_PERMISSION");
    expect(result.cmd).toContain('"permission":"allow"');
  });
});

// ── buildLaunchCmd: copilot ───────────────────────────────────────────────────

describe("copilot profile buildLaunchCmd", () => {
  it("returns an inline shell command (no .sh script file)", () => {
    const profile = getToolProfile("copilot");
    const result = profile.buildLaunchCmd(stubOpts({ id: "H-X-1" }), stubDeps());
    expect(result.cmd).not.toMatch(/\.sh$/);
    expect(result.cmd).toContain("exec copilot");
  });

  it("returns empty initialPrompt (prompt is embedded via -i in inline cmd)", () => {
    const profile = getToolProfile("copilot");
    const result = profile.buildLaunchCmd(stubOpts(), stubDeps());
    expect(result.initialPrompt).toBe("");
  });

  it("reads the promptFile to embed in the inline command", () => {
    const profile = getToolProfile("copilot");
    const deps = stubDeps("COPILOT PROMPT");
    const opts = stubOpts({ promptFile: "/some/.ninthwave/.prompt" });
    profile.buildLaunchCmd(opts, deps);
    expect(deps.readFileSync).toHaveBeenCalledWith("/some/.ninthwave/.prompt", "utf-8");
  });

  it("writes the prompt data file with start instruction appended", () => {
    const profile = getToolProfile("copilot");
    const deps = stubDeps("MY PROMPT");
    profile.buildLaunchCmd(stubOpts({ id: "H-X-2" }), deps);

    // First writeFileSync call is the prompt data file
    const calls = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatch(/^\/fake\/state\/tmp\/nw-prompt-H-X-2-\d+$/);
    expect(calls[0]![1]).toContain("MY PROMPT");
    expect(calls[0]![1]).toContain("Start implementing this work item now.");
  });

  it("inline cmd contains correct copilot command and args", () => {
    const profile = getToolProfile("copilot");
    const result = profile.buildLaunchCmd(stubOpts({ id: "H-X-3", agentName: "ninthwave-implementer" }), stubDeps());
    expect(result.cmd).toContain("copilot --agent=ninthwave-implementer --allow-all");
  });

  it("does not call chmod (no executable scripts created)", () => {
    const profile = getToolProfile("copilot");
    const deps = stubDeps();
    profile.buildLaunchCmd(stubOpts({ id: "H-X-4" }), deps);

    expect(deps.run).not.toHaveBeenCalled();
  });

  it("inline cmd references the work item id via prompt data file", () => {
    const profile = getToolProfile("copilot");
    const result = profile.buildLaunchCmd(stubOpts({ id: "UNIQUE-ID" }), stubDeps());
    expect(result.cmd).toContain("UNIQUE-ID");
  });

  it("writes exactly 1 file (prompt data only, no launcher script)", () => {
    const profile = getToolProfile("copilot");
    const deps = stubDeps();
    profile.buildLaunchCmd(stubOpts(), deps);
    expect((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ── buildHeadlessCmd: copilot ─────────────────────────────────────────────────

describe("copilot profile buildHeadlessCmd", () => {
  it("returns empty initialPrompt", () => {
    const profile = getToolProfile("copilot");
    const result = profile.buildHeadlessCmd(stubOpts(), stubDeps());
    expect(result.initialPrompt).toBe("");
  });

  it("writes and references a temp prompt file", () => {
    const profile = getToolProfile("copilot");
    const deps = stubDeps("COPILOT PROMPT");
    profile.buildHeadlessCmd(stubOpts({ id: "H-X-HEADLESS" }), deps);

    const calls = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatch(/^\/fake\/state\/tmp\/nw-prompt-H-X-HEADLESS-\d+$/);
    expect(calls[0]![1]).toContain("COPILOT PROMPT");
    expect(calls[0]![1]).toContain("Start implementing this work item now.");
  });

  it("uses -p plus the current non-interactive approval flags", () => {
    const profile = getToolProfile("copilot");
    const result = profile.buildHeadlessCmd(stubOpts({ id: "H-X-HEADLESS", agentName: "ninthwave-implementer" }), stubDeps());
    expect(result.cmd).toContain('exec copilot -p "$PROMPT"');
    expect(result.cmd).toContain("--agent=ninthwave-implementer");
    expect(result.cmd).toContain("--allow-all-tools");
    expect(result.cmd).toContain("--allow-all-paths");
    expect(result.cmd).toContain("--allow-all-urls");
    expect(result.cmd).toContain("--no-ask-user");
    expect(result.cmd).not.toContain("--allow-all ");
  });
});

// ── AI_TOOL_PROFILES integrity ────────────────────────────────────────────────

describe("AI_TOOL_PROFILES", () => {
  it("has exactly 3 profiles", () => {
    expect(AI_TOOL_PROFILES).toHaveLength(3);
  });

  it("has unique IDs", () => {
    const ids = AI_TOOL_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all profiles have non-empty targetDir and suffix", () => {
    for (const profile of AI_TOOL_PROFILES) {
      expect(profile.targetDir).toBeTruthy();
      expect(profile.suffix).toBeTruthy();
    }
  });

  it("all profiles have a buildLaunchCmd function", () => {
    for (const profile of AI_TOOL_PROFILES) {
      expect(typeof profile.buildLaunchCmd).toBe("function");
    }
  });

  it("all profiles have a buildHeadlessCmd function", () => {
    for (const profile of AI_TOOL_PROFILES) {
      expect(typeof profile.buildHeadlessCmd).toBe("function");
    }
  });
});
