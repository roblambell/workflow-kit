// Tests for core/preflight.ts — pre-flight environment validation.

import { describe, it, expect } from "vitest";
import type { RunResult } from "../core/types.ts";
import {
  checkGh,
  checkAiTool,
  checkMultiplexer,
  checkGitConfig,
  preflight,
  type ShellRunner,
} from "../core/preflight.ts";

// ── Mock shell runners ───────────────────────────────────────────────

/** Build a mock shell runner from a map of command → result. */
function mockRunner(
  responses: Record<string, RunResult>,
): ShellRunner {
  return (cmd: string, args: string[]): RunResult => {
    const key = `${cmd} ${args.join(" ")}`;
    if (responses[key]) return responses[key]!;
    if (responses[cmd]) return responses[cmd]!;
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

/** A runner where everything succeeds. */
function allPassRunner(): ShellRunner {
  return (cmd: string, args: string[]): RunResult => {
    if (cmd === "git" && args[0] === "config" && args[1] === "user.name") {
      return { stdout: "Test User", stderr: "", exitCode: 0 };
    }
    if (cmd === "git" && args[0] === "config" && args[1] === "user.email") {
      return { stdout: "test@example.com", stderr: "", exitCode: 0 };
    }
    return { stdout: "/usr/local/bin/mock", stderr: "", exitCode: 0 };
  };
}

/** A runner where nothing is installed. */
function allFailRunner(): ShellRunner {
  return (): RunResult => {
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

// ── Individual check tests ───────────────────────────────────────────

describe("checkGh (preflight)", () => {
  it("passes when gh is installed and authenticated", () => {
    const runner = mockRunner({
      "which gh": { stdout: "/usr/local/bin/gh", stderr: "", exitCode: 0 },
      "gh auth status": { stdout: "Logged in", stderr: "", exitCode: 0 },
    });
    expect(checkGh(runner).status).toBe("pass");
  });

  it("fails when gh is not authenticated", () => {
    const runner = mockRunner({
      "which gh": { stdout: "/usr/local/bin/gh", stderr: "", exitCode: 0 },
      "gh auth status": { stdout: "", stderr: "not logged in", exitCode: 1 },
    });
    const result = checkGh(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not authenticated");
  });
});

describe("checkAiTool (preflight)", () => {
  it("fails when no AI tool is found", () => {
    const result = checkAiTool(allFailRunner());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("No AI tool");
  });

  it("passes when at least one tool is found", () => {
    const runner = mockRunner({
      "which claude": { stdout: "/usr/local/bin/claude", stderr: "", exitCode: 0 },
    });
    const result = checkAiTool(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("claude");
  });
});

describe("checkMultiplexer (preflight)", () => {
  it("fails when no multiplexer is detected", () => {
    const result = checkMultiplexer(allFailRunner());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("No multiplexer");
  });

  it("passes with cmux", () => {
    const runner = mockRunner({
      "which cmux": { stdout: "/usr/local/bin/cmux", stderr: "", exitCode: 0 },
    });
    expect(checkMultiplexer(runner).status).toBe("pass");
  });
});

describe("checkGitConfig (preflight)", () => {
  it("fails when user.name is missing", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "git" && args[1] === "user.email") {
        return { stdout: "a@b.com", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = checkGitConfig(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("user.name");
  });
});

// ── preflight() integration ──────────────────────────────────────────

describe("preflight", () => {
  it("returns passed=true when all checks pass", () => {
    const result = preflight(allPassRunner());
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checks).toHaveLength(4);
    for (const check of result.checks) {
      expect(check.status).toBe("pass");
    }
  });

  it("returns passed=false when gh is not authenticated", () => {
    const runner = mockRunner({
      "which gh": { stdout: "/usr/local/bin/gh", stderr: "", exitCode: 0 },
      "gh auth status": { stdout: "", stderr: "not logged in", exitCode: 1 },
      "which claude": { stdout: "/usr/local/bin/claude", stderr: "", exitCode: 0 },
      "which cmux": { stdout: "/usr/local/bin/cmux", stderr: "", exitCode: 0 },
      "git config user.name": { stdout: "User", stderr: "", exitCode: 0 },
      "git config user.email": { stdout: "u@e.com", stderr: "", exitCode: 0 },
    });
    const result = preflight(runner);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("not authenticated");
  });

  it("returns passed=false when no AI tool is found", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "which" && args[0] === "gh") return { stdout: "/bin/gh", stderr: "", exitCode: 0 };
      if (cmd === "gh") return { stdout: "ok", stderr: "", exitCode: 0 };
      if (cmd === "which" && args[0] === "cmux") return { stdout: "/bin/cmux", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[1] === "user.name") return { stdout: "U", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[1] === "user.email") return { stdout: "u@e", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "not found", exitCode: 1 };
    };
    const result = preflight(runner);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("No AI tool");
  });

  it("returns passed=false when no multiplexer is detected", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "which" && args[0] === "gh") return { stdout: "/bin/gh", stderr: "", exitCode: 0 };
      if (cmd === "gh") return { stdout: "ok", stderr: "", exitCode: 0 };
      if (cmd === "which" && args[0] === "claude") return { stdout: "/bin/claude", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[1] === "user.name") return { stdout: "U", stderr: "", exitCode: 0 };
      if (cmd === "git" && args[1] === "user.email") return { stdout: "u@e", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "not found", exitCode: 1 };
    };
    const result = preflight(runner);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("No multiplexer");
  });

  it("reports ALL failures, not just the first", () => {
    const result = preflight(allFailRunner());
    expect(result.passed).toBe(false);
    // gh fails, AI tool fails, mux fails, git config fails = 4 errors
    expect(result.errors.length).toBe(4);
    expect(result.errors.some((e) => e.includes("gh CLI"))).toBe(true);
    expect(result.errors.some((e) => e.includes("No AI tool"))).toBe(true);
    expect(result.errors.some((e) => e.includes("No multiplexer"))).toBe(true);
    expect(result.errors.some((e) => e.includes("git"))).toBe(true);
  });

  it("includes remediation detail in error messages", () => {
    const result = preflight(allFailRunner());
    // gh check detail: "Install: brew install gh"
    expect(result.errors.some((e) => e.includes("brew install gh"))).toBe(true);
  });
});

// ── doctor.ts reuses preflight checks (no duplication) ──────────────

describe("doctor reuses preflight", () => {
  it("doctor.ts re-exports checkGh from preflight.ts", async () => {
    const doctorModule = await import("../core/commands/doctor.ts");
    const preflightModule = await import("../core/preflight.ts");
    // The functions should be the exact same reference
    expect(doctorModule.checkGh).toBe(preflightModule.checkGh);
    expect(doctorModule.checkAiTool).toBe(preflightModule.checkAiTool);
    expect(doctorModule.checkMultiplexer).toBe(preflightModule.checkMultiplexer);
    expect(doctorModule.checkGitConfig).toBe(preflightModule.checkGitConfig);
  });
});
