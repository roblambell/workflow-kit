// Tests for core/commands/crew.ts -- argument parsing, interactive prompt,
// direct join shorthand, non-TTY fallback, and invalid crew code handling.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatInvalidCrewCodeMessage,
  isCrewCode,
  normalizeCrewCode,
  parseCrewCode,
  parseCrewArgs,
  promptCrewAction,
  printCrewUsage,
  cmdCrew,
  type ConnectionAction,
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
  it("accepts valid 4x4x4x4 codes with hyphens", () => {
    expect(isCrewCode("K2F9-AB3X-7YPL-QM4N")).toBe(true);
    expect(isCrewCode("ABCD-EFGH-IJKL-MNOP")).toBe(true);
    expect(isCrewCode("a1b2-c3d4-e5f6-g7h8")).toBe(true);
    expect(isCrewCode("abcd-efgh-ijkl-mnop")).toBe(true);
    expect(isCrewCode("1234-5678-9012-3456")).toBe(true);
  });

  it("rejects codes with wrong segment length", () => {
    expect(isCrewCode("ABC-XYZ")).toBe(false);       // old 3+3 format
    expect(isCrewCode("ab-cd")).toBe(false);          // too short
    expect(isCrewCode("ABCDE-FGHIJ-KLMNO-PQRST")).toBe(false); // 5+5+5+5
    expect(isCrewCode("ABC-DEFG-HIJK-LMNO")).toBe(false); // 3+4+4+4
  });

  it("accepts codes without hyphens (16 chars)", () => {
    expect(isCrewCode("K2F9AB3X7YPLQM4N")).toBe(true);
    expect(isCrewCode("ABCDEFGHIJKLMNOP")).toBe(true);
    expect(isCrewCode("abcdefghijklmnop")).toBe(true);
  });

  it("rejects codes with trailing or leading hyphen", () => {
    expect(isCrewCode("ABCD-")).toBe(false);
    expect(isCrewCode("-ABCD")).toBe(false);
  });

  it("rejects old 6-char format", () => {
    expect(isCrewCode("xK2-9fB")).toBe(false);
    expect(isCrewCode("abc-xyz")).toBe(false);
    expect(isCrewCode("abcxyz")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isCrewCode("")).toBe(false);
  });
});

// ── normalizeCrewCode ─────────────────────────────────────────────

describe("normalizeCrewCode", () => {
  it("normalizes lowercase 16-char code with hyphens", () => {
    expect(normalizeCrewCode("k2f9ab3x7yplqm4n")).toBe("K2F9-AB3X-7YPL-QM4N");
  });

  it("normalizes code with hyphens already present", () => {
    expect(normalizeCrewCode("k2f9-ab3x-7ypl-qm4n")).toBe("K2F9-AB3X-7YPL-QM4N");
  });

  it("normalizes mixed-case code", () => {
    expect(normalizeCrewCode("AbCd-EfGh-IjKl-MnOp")).toBe("ABCD-EFGH-IJKL-MNOP");
  });

  it("trims surrounding whitespace before formatting", () => {
    expect(normalizeCrewCode("  abcd-efgh-ijkl-mnop  ")).toBe("ABCD-EFGH-IJKL-MNOP");
  });
});

// ── parseCrewCode / shared validation path ────────────────────────

describe("parseCrewCode", () => {
  it("returns normalized uppercase code for valid input", () => {
    expect(parseCrewCode("k2f9ab3x7yplqm4n")).toBe("K2F9-AB3X-7YPL-QM4N");
  });

  it("returns null for malformed code", () => {
    expect(parseCrewCode("abc-xyz")).toBeNull();
  });

  it("formats the shared invalid-code message", () => {
    expect(formatInvalidCrewCodeMessage("abc-xyz")).toContain("Invalid session code: abc-xyz");
    expect(formatInvalidCrewCodeMessage("abc-xyz")).toContain("Expected format: XXXX-XXXX-XXXX-XXXX");
  });
});

// ── parseCrewArgs ──────────────────────────────────────────────────

describe("parseCrewArgs", () => {
  it("returns null for no args (interactive mode)", () => {
    expect(parseCrewArgs([])).toBeNull();
  });

  it("parses direct join shorthand", () => {
    const result = parseCrewArgs(["abcd-efgh-ijkl-mnop"]);
    expect(result).toEqual({ type: "join", code: "ABCD-EFGH-IJKL-MNOP" });
  });

  it("parses explicit create subcommand", () => {
    const result = parseCrewArgs(["create"]);
    expect(result).toEqual({ type: "connect" });
  });

  it("parses explicit join subcommand", () => {
    const result = parseCrewArgs(["join", "abcd-efgh-ijkl-mnop"]);
    expect(result).toEqual({ type: "join", code: "ABCD-EFGH-IJKL-MNOP" });
  });

  it("throws on unknown subcommand", () => {
    expect(() => parseCrewArgs(["unknown"])).toThrow("Unknown crew subcommand: unknown");
  });

  it("throws on join without code", () => {
    expect(() => parseCrewArgs(["join"])).toThrow("Usage: nw crew join <session-code>");
  });

  it("throws on join with invalid crew code", () => {
    expect(() => parseCrewArgs(["join", "INVALID"])).toThrow("Invalid session code: INVALID");
  });

  it("throws on join with old 6-char code", () => {
    expect(() => parseCrewArgs(["join", "abc-xyz"])).toThrow("Invalid session code: abc-xyz");
  });

  it("direct join shorthand routes code-shaped arg to join", () => {
    const result = parseCrewArgs(["K2F9-AB3X-7YPL-QM4N"]);
    expect(result).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
  });
});

// ── promptCrewAction ───────────────────────────────────────────────

describe("promptCrewAction", () => {
  it("returns join action for valid crew code input", async () => {
    const prompt = mockPrompt(["abcd-efgh-ijkl-mnop"]);
    const result = await promptCrewAction(prompt);
    expect(result).toEqual({ type: "join", code: "ABCD-EFGH-IJKL-MNOP" });
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
    const prompt = mockPrompt(["INVALID", "ABCD-EFGH-IJKL-MNOP"]);
    const lines = await captureLog(async () => {
      const result = await promptCrewAction(prompt);
      expect(result).toEqual({ type: "join", code: "ABCD-EFGH-IJKL-MNOP" });
    });
    const invalidLine = lines.find((l) => l.includes("Invalid session code"));
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

    await cmdCrew(["abcd-efgh-ijkl-mnop"], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew", "ABCD-EFGH-IJKL-MNOP"]]);
  });

  it("create subcommand delegates to watch with --connect flag", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew(["create"], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--connect"]]);
  });

  it("explicit join subcommand delegates to watch with --crew flag", async () => {
    const watchArgs: string[][] = [];
    const deps: CrewDeps = {
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew(["join", "k2f9ab3x7yplqm4n"], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew", "K2F9-AB3X-7YPL-QM4N"]]);
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
      prompt: mockPrompt(["K2F9-AB3X-7YPL-QM4N"]),
      runWatch: async (args) => { watchArgs.push(args); },
    };

    await cmdCrew([], workDir, worktreeDir, projectRoot, deps);
    expect(watchArgs).toEqual([["--crew", "K2F9-AB3X-7YPL-QM4N"]]);
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
