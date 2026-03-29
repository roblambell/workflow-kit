// Tests for core/commands/crew.ts -- argument parsing, interactive prompt,
// direct join shorthand, non-TTY fallback, and invalid crew code handling.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isCrewCode,
  parseCrewArgs,
  promptCrewAction,
  printCrewUsage,
  cmdCrew,
  type CrewAction,
  type CrewDeps,
} from "../core/commands/crew.ts";

// ── Helpers ────────────────────────────────────────────────────────

/** Create a prompt function from a queue of answers. */
function mockPrompt(answers: string[]): (question: string) => Promise<string> {
  const queue = [...answers];
  return async (_question: string) => {
    const answer = queue.shift();
    if (answer === undefined) throw new Error("No more answers in mock prompt queue");
    return answer;
  };
}

/** Capture console.log output during a callback. */
async function captureLog(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

// ── isCrewCode ─────────────────────────────────────────────────────

describe("isCrewCode", () => {
  it("accepts valid codes: mixed case and digits", () => {
    expect(isCrewCode("xK2-9fB")).toBe(true);
    expect(isCrewCode("ABC-XYZ")).toBe(true);
    expect(isCrewCode("a1B-c2D")).toBe(true);
    expect(isCrewCode("abc-xyz")).toBe(true);
    expect(isCrewCode("foo-bar")).toBe(true);
    expect(isCrewCode("123-456")).toBe(true);
  });

  it("rejects codes with wrong segment length", () => {
    expect(isCrewCode("abcd-efgh")).toBe(false); // too long (4+4)
    expect(isCrewCode("ab-cd")).toBe(false);     // too short (2+2)
    expect(isCrewCode("ABC-XY1Z")).toBe(false);  // second segment has 4 chars
    expect(isCrewCode("a-b")).toBe(false);       // too short (1+1)
  });

  it("rejects codes without hyphen", () => {
    expect(isCrewCode("abcxyz")).toBe(false);
  });

  it("rejects codes with trailing or leading hyphen", () => {
    expect(isCrewCode("abc-")).toBe(false);
    expect(isCrewCode("-xyz")).toBe(false);
  });

  it("rejects codes with multiple hyphens", () => {
    expect(isCrewCode("abc-xyz-def")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isCrewCode("")).toBe(false);
  });
});

// ── parseCrewArgs ──────────────────────────────────────────────────

describe("parseCrewArgs", () => {
  it("returns null for no args (interactive mode)", () => {
    expect(parseCrewArgs([])).toBeNull();
  });

  it("parses direct join shorthand", () => {
    const result = parseCrewArgs(["abc-xyz"]);
    expect(result).toEqual({ type: "join", code: "abc-xyz" });
  });

  it("parses explicit create subcommand", () => {
    const result = parseCrewArgs(["create"]);
    expect(result).toEqual({ type: "create" });
  });

  it("parses explicit join subcommand", () => {
    const result = parseCrewArgs(["join", "abc-xyz"]);
    expect(result).toEqual({ type: "join", code: "abc-xyz" });
  });

  it("throws on unknown subcommand", () => {
    expect(() => parseCrewArgs(["unknown"])).toThrow("Unknown crew subcommand: unknown");
  });

  it("throws on join without code", () => {
    expect(() => parseCrewArgs(["join"])).toThrow("Usage: nw crew join <crew-code>");
  });

  it("throws on join with invalid crew code", () => {
    expect(() => parseCrewArgs(["join", "INVALID"])).toThrow("Invalid crew code: INVALID");
  });

  it("throws on join with wrong-length code", () => {
    expect(() => parseCrewArgs(["join", "abcd-efgh"])).toThrow("Invalid crew code: abcd-efgh");
  });

  it("direct join shorthand routes code-shaped arg to join (not treated as subcommand)", () => {
    // "foo-bar" looks like a crew code, so it should route to join
    const result = parseCrewArgs(["foo-bar"]);
    expect(result).toEqual({ type: "join", code: "foo-bar" });
  });
});

// ── promptCrewAction ───────────────────────────────────────────────

describe("promptCrewAction", () => {
  it("returns join action for valid crew code input", async () => {
    const prompt = mockPrompt(["abc-xyz"]);
    const result = await promptCrewAction(prompt);
    expect(result).toEqual({ type: "join", code: "abc-xyz" });
  });

  it("returns create action for 'create' input", async () => {
    const prompt = mockPrompt(["create"]);
    const result = await promptCrewAction(prompt);
    expect(result).toEqual({ type: "create" });
  });

  it("returns create action for 'Create' input (case-insensitive)", async () => {
    const prompt = mockPrompt(["Create"]);
    const result = await promptCrewAction(prompt);
    expect(result).toEqual({ type: "create" });
  });

  it("returns null on empty input (cancel)", async () => {
    const prompt = mockPrompt([""]);
    const result = await promptCrewAction(prompt);
    expect(result).toBeNull();
  });

  it("returns null on 'q' input (quit)", async () => {
    const prompt = mockPrompt(["q"]);
    const result = await promptCrewAction(prompt);
    expect(result).toBeNull();
  });

  it("returns null on 'quit' input", async () => {
    const prompt = mockPrompt(["quit"]);
    const result = await promptCrewAction(prompt);
    expect(result).toBeNull();
  });

  it("retries on invalid input then accepts valid code", async () => {
    const prompt = mockPrompt(["INVALID", "abc-xyz"]);
    const lines = await captureLog(async () => {
      const result = await promptCrewAction(prompt);
      expect(result).toEqual({ type: "join", code: "abc-xyz" });
    });
    const invalidLine = lines.find((l) => l.includes("Invalid crew code"));
    expect(invalidLine).toBeDefined();
  });
});

// ── printCrewUsage ─────────────────────────────────────────────────

describe("printCrewUsage", () => {
  it("prints usage information", async () => {
    const lines = await captureLog(() => printCrewUsage());
    const text = lines.join("\n");
    expect(text).toContain("nw crew");
    expect(text).toContain("nw crew <crew-code>");
    expect(text).toContain("nw crew create");
    expect(text).toContain("nw crew join <crew-code>");
    expect(text).toContain("Examples:");
  });
});

// ── cmdCrew ────────────────────────────────────────────────────────

describe("cmdCrew", () => {
  const workDir = "/tmp/test-work";
  const worktreeDir = "/tmp/test-worktrees";
  const projectRoot = "/tmp/test-project";

  it("direct join shorthand delegates to watch with --crew flag", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew(["abc-xyz"], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew", "abc-xyz"]]);
  });

  it("create subcommand delegates to watch with --crew-create flag", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew(["create"], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew-create"]]);
  });

  it("explicit join subcommand delegates to watch with --crew flag", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew(["join", "foo-bar"], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew", "foo-bar"]]);
  });

  it("non-TTY with no args prints usage help instead of hanging", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      isTTY: false,
      runWatch: async (args) => { watchArgs.push(args); },
    };

    const lines = await captureLog(async () => {
      await cmdCrew([], workDir, worktreeDir, projectRoot, deps);
    });

    // Should print usage, not launch watch
    expect(watchArgs).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("nw crew");
    expect(text).toContain("Interactive mode");
  });

  it("interactive mode with TTY prompts and joins on crew code input", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      isTTY: true,
      prompt: mockPrompt(["xK2-9fB"]),
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew([], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew", "xK2-9fB"]]);
  });

  it("interactive mode with TTY prompts and creates on 'create' input", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      isTTY: true,
      prompt: mockPrompt(["create"]),
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew([], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew-create"]]);
  });

  it("interactive mode with cancel does nothing", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      isTTY: true,
      prompt: mockPrompt(["q"]),
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew([], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([]);
  });
});
