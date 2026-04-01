// Tests for selectAiTool/selectAiTools -- explicit, user-driven AI tool selection.

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanupTempRepos } from "./helpers.ts";
import { selectAiTool, selectAiTools, detectInstalledAITools } from "../core/tool-select.ts";
import type { SelectAiToolDeps } from "../core/tool-select.ts";

afterEach(() => {
  cleanupTempRepos();
});

function stubDeps(overrides: Partial<SelectAiToolDeps> = {}): SelectAiToolDeps {
  return {
    commandExists: overrides.commandExists ?? (() => false),
    prompt: overrides.prompt ?? (async () => ""),
    loadUserConfig: overrides.loadUserConfig ?? (() => ({})),
    saveUserConfig: overrides.saveUserConfig ?? (() => {}),
  };
}

describe("selectAiTool", () => {
  it("returns --tool override directly", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { toolOverride: "opencode", projectRoot: "/fake", isInteractive: true },
      stubDeps({ saveUserConfig: save }),
    );
    expect(result).toBe("opencode");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["opencode"] });
  });

  it("accepts unknown tool override with warning", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    const result = await selectAiTool(
      { toolOverride: "my-custom-ai", projectRoot: "/fake", isInteractive: true },
      stubDeps({ saveUserConfig: save }),
    );
    expect(result).toBe("my-custom-ai");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["my-custom-ai"] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown AI tool: \"my-custom-ai\""));
    warnSpy.mockRestore();
  });

  it("auto-selects single installed tool", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "opencode",
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("opencode");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["opencode"] });
  });

  it("uses user config preference when non-interactive with multiple tools", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: false },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({ ai_tools: ["opencode"] }),
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("opencode");
    expect(save).not.toHaveBeenCalled();
  });

  it("falls back to first installed when non-interactive with no user preference", async () => {
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: false },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
      }),
    );
    expect(result).toBe("claude");
  });

  it("returns user config preference even when it is not installed", async () => {
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: false },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "copilot",
        loadUserConfig: () => ({ ai_tools: ["opencode"] }),
      }),
    );
    expect(result).toBe("opencode");
  });

  it("prompts interactively with multiple tools and empty input confirms defaults", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
        prompt: async () => "",
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("claude");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude"] });
  });

  it("prompts interactively and numeric input toggles selection", async () => {
    const save = vi.fn();
    let callCount = 0;
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
        prompt: async () => {
          callCount++;
          if (callCount === 1) return "2";
          return "";
        },
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("claude");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude", "opencode"] });
  });

  it("pre-selects first tool when no user preference exists", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
        prompt: async () => "",
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("claude");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude"] });
  });

  it("uses user config ai_tools when no --tool override", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        loadUserConfig: () => ({ ai_tools: ["opencode"] }),
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("opencode");
    expect(save).not.toHaveBeenCalled();
  });

  it("--tool override takes precedence over user config", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { toolOverride: "claude", projectRoot: "/fake", isInteractive: true },
      stubDeps({
        loadUserConfig: () => ({ ai_tools: ["opencode"] }),
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("claude");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude"] });
  });

  it("user config takes precedence over installed tool detection", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: false },
      stubDeps({
        loadUserConfig: () => ({ ai_tools: ["copilot"] }),
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("copilot");
    expect(save).not.toHaveBeenCalled();
  });

  it("warns for unknown tool in user config", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        loadUserConfig: () => ({ ai_tools: ["my-custom-ai"] }),
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("my-custom-ai");
    expect(save).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown AI tool in ~/.ninthwave/config.json: \"my-custom-ai\""));
    warnSpy.mockRestore();
  });

  it("skips user config when ai_tools is not set", async () => {
    const save = vi.fn();
    const result = await selectAiTool(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        loadUserConfig: () => ({}),
        commandExists: (cmd) => cmd === "claude",
        saveUserConfig: save,
      }),
    );
    expect(result).toBe("claude");
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude"] });
  });
});

describe("selectAiTools", () => {
  it("splits comma-separated --tool override into array", async () => {
    const save = vi.fn();
    const result = await selectAiTools(
      { toolOverride: "claude,opencode", projectRoot: "/fake", isInteractive: true },
      stubDeps({ saveUserConfig: save }),
    );
    expect(result).toEqual(["claude", "opencode"]);
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude", "opencode"] });
  });

  it("handles single --tool override as single-element array", async () => {
    const save = vi.fn();
    const result = await selectAiTools(
      { toolOverride: "claude", projectRoot: "/fake", isInteractive: true },
      stubDeps({ saveUserConfig: save }),
    );
    expect(result).toEqual(["claude"]);
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude"] });
  });

  it("returns multi-tool from user config ai_tools", async () => {
    const save = vi.fn();
    const result = await selectAiTools(
      { projectRoot: "/fake", isInteractive: false },
      stubDeps({
        loadUserConfig: () => ({ ai_tools: ["claude", "opencode"] }),
        saveUserConfig: save,
      }),
    );
    expect(result).toEqual(["claude", "opencode"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("falls back to first installed when no user preference exists (non-interactive)", async () => {
    const result = await selectAiTools(
      { projectRoot: "/fake", isInteractive: false },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
      }),
    );
    expect(result).toEqual(["claude"]);
  });

  it("interactive multi-select: toggle and confirm", async () => {
    const save = vi.fn();
    let callCount = 0;
    const result = await selectAiTools(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
        prompt: async () => {
          callCount++;
          if (callCount === 1) return "2";
          return "";
        },
        saveUserConfig: save,
      }),
    );
    expect(result).toEqual(["claude", "opencode"]);
    expect(save).toHaveBeenCalledWith({ ai_tools: ["claude", "opencode"] });
  });

  it("interactive: can deselect default and select another", async () => {
    const save = vi.fn();
    let callCount = 0;
    const result = await selectAiTools(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
        prompt: async () => {
          callCount++;
          if (callCount === 1) return "1";
          if (callCount === 2) return "2";
          return "";
        },
        saveUserConfig: save,
      }),
    );
    expect(result).toEqual(["opencode"]);
    expect(save).toHaveBeenCalledWith({ ai_tools: ["opencode"] });
  });

  it("interactive: rejects empty selection", async () => {
    const save = vi.fn();
    let callCount = 0;
    const result = await selectAiTools(
      { projectRoot: "/fake", isInteractive: true },
      stubDeps({
        commandExists: (cmd) => cmd === "claude" || cmd === "opencode",
        loadUserConfig: () => ({}),
        prompt: async () => {
          callCount++;
          if (callCount === 1) return "1";
          if (callCount === 2) return "";
          if (callCount === 3) return "2";
          return "";
        },
        saveUserConfig: save,
      }),
    );
    expect(result).toEqual(["opencode"]);
    expect(save).toHaveBeenCalledWith({ ai_tools: ["opencode"] });
  });
});

describe("detectInstalledAITools", () => {
  it("returns empty when no tools installed", () => {
    const result = detectInstalledAITools(() => false);
    expect(result).toHaveLength(0);
  });

  it("returns matching tools in profile order", () => {
    const result = detectInstalledAITools((cmd) => cmd === "opencode" || cmd === "claude");
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("claude");
    expect(result[1]!.id).toBe("opencode");
  });

  it("returns all tools when all installed", () => {
    const result = detectInstalledAITools(() => true);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});
