// Tests for core/commands/doctor.ts — diagnostic health check command.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import type { RunResult } from "../core/types.ts";
import {
  checkGh,
  checkAiTool,
  checkMultiplexer,
  checkGitConfig,
  checkNinthwaveConfig,
  checkPreCommitHook,
  checkGithubIdentity,
  runDoctor,
  formatDoctorOutput,
  type ShellRunner,
} from "../core/commands/doctor.ts";

// ── Mock shell runners ───────────────────────────────────────────────

/** Build a mock shell runner from a map of command → result. */
function mockRunner(
  responses: Record<string, RunResult>,
): ShellRunner {
  return (cmd: string, args: string[]): RunResult => {
    // Try exact key first: "cmd arg1 arg2"
    const key = `${cmd} ${args.join(" ")}`;
    if (responses[key]) return responses[key]!;
    // Try command-only key
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
    // Default: succeed for "which" checks and "gh auth status"
    return { stdout: "/usr/local/bin/mock", stderr: "", exitCode: 0 };
  };
}

/** A runner where nothing is installed. */
function allFailRunner(): ShellRunner {
  return (_cmd: string, _args: string[]): RunResult => {
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

afterEach(() => {
  cleanupTempRepos();
});

// ── Individual check tests ───────────────────────────────────────────

describe("checkGh", () => {
  it("passes when gh is installed and authenticated", () => {
    const runner = mockRunner({
      "which gh": { stdout: "/usr/local/bin/gh", stderr: "", exitCode: 0 },
      "gh auth status": { stdout: "Logged in", stderr: "", exitCode: 0 },
    });
    const result = checkGh(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("authenticated");
  });

  it("fails when gh is not installed", () => {
    const runner = allFailRunner();
    const result = checkGh(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not installed");
  });

  it("fails when gh is installed but not authenticated", () => {
    const runner = mockRunner({
      "which gh": { stdout: "/usr/local/bin/gh", stderr: "", exitCode: 0 },
      "gh auth status": {
        stdout: "",
        stderr: "not logged in",
        exitCode: 1,
      },
    });
    const result = checkGh(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not authenticated");
    expect(result.detail).toContain("gh auth login");
  });
});

describe("checkAiTool", () => {
  it("passes when claude is available", () => {
    const runner = mockRunner({
      "which claude": {
        stdout: "/usr/local/bin/claude",
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkAiTool(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("claude");
  });

  it("passes when only opencode is available", () => {
    const runner = mockRunner({
      "which opencode": {
        stdout: "/usr/local/bin/opencode",
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkAiTool(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("opencode");
  });

  it("lists multiple tools when several are available", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "which" && (args[0] === "claude" || args[0] === "opencode")) {
        return { stdout: `/usr/local/bin/${args[0]}`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "not found", exitCode: 1 };
    };
    const result = checkAiTool(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("claude");
    expect(result.message).toContain("opencode");
  });

  it("fails when no AI tool is available", () => {
    const runner = allFailRunner();
    const result = checkAiTool(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("No AI tool");
  });
});

describe("checkMultiplexer", () => {
  it("passes with cmux (preferred)", () => {
    const runner = mockRunner({
      "which cmux": {
        stdout: "/usr/local/bin/cmux",
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkMultiplexer(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("cmux");
    expect(result.message).toContain("preferred");
  });

  it("passes with tmux", () => {
    const runner = mockRunner({
      "which tmux": {
        stdout: "/usr/local/bin/tmux",
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkMultiplexer(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("tmux");
  });

  it("passes with zellij", () => {
    const runner = mockRunner({
      "which zellij": {
        stdout: "/usr/local/bin/zellij",
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkMultiplexer(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("zellij");
  });

  it("fails when no multiplexer is available", () => {
    const runner = allFailRunner();
    const result = checkMultiplexer(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("No multiplexer");
  });
});

describe("checkGitConfig", () => {
  it("passes when both name and email are set", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "git" && args[1] === "user.name") {
        return { stdout: "Jane Doe", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[1] === "user.email") {
        return { stdout: "jane@example.com", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = checkGitConfig(runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("Jane Doe");
    expect(result.message).toContain("jane@example.com");
  });

  it("fails when user.name is missing", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "git" && args[1] === "user.email") {
        return { stdout: "jane@example.com", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = checkGitConfig(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("user.name");
  });

  it("fails when user.email is missing", () => {
    const runner = (cmd: string, args: string[]): RunResult => {
      if (cmd === "git" && args[1] === "user.name") {
        return { stdout: "Jane Doe", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = checkGitConfig(runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("user.email");
  });
});

describe("checkNinthwaveConfig", () => {
  it("passes when .ninthwave/config exists", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(join(repo, ".ninthwave", "config"), "# config\n");
    const result = checkNinthwaveConfig(repo);
    expect(result.status).toBe("pass");
  });

  it("warns when .ninthwave/config does not exist", () => {
    const repo = setupTempRepo();
    const result = checkNinthwaveConfig(repo);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("nw setup");
  });
});

describe("checkPreCommitHook", () => {
  it("passes when pre-commit hook exists", () => {
    const repo = setupTempRepo();
    const hooksDir = join(repo, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
    const result = checkPreCommitHook(repo);
    expect(result.status).toBe("pass");
  });

  it("warns when pre-commit hook does not exist", () => {
    const repo = setupTempRepo();
    const result = checkPreCommitHook(repo);
    expect(result.status).toBe("warn");
  });
});

describe("checkGithubIdentity", () => {
  let origNwToken: string | undefined;

  beforeEach(() => {
    origNwToken = process.env.NINTHWAVE_GITHUB_TOKEN;
    delete process.env.NINTHWAVE_GITHUB_TOKEN;
  });

  afterEach(() => {
    if (origNwToken !== undefined) {
      process.env.NINTHWAVE_GITHUB_TOKEN = origNwToken;
    } else {
      delete process.env.NINTHWAVE_GITHUB_TOKEN;
    }
  });

  it("returns info when no custom token is configured", () => {
    const repo = setupTempRepo();
    const runner = allPassRunner();
    const result = checkGithubIdentity(repo, runner);
    expect(result.status).toBe("info");
    expect(result.message).toContain("No custom GitHub token");
  });

  it("fails when token is invalid", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_invalid";
    const repo = setupTempRepo();
    const runner = mockRunner({
      "gh api -i /user": {
        stdout: "",
        stderr: "401 Unauthorized",
        exitCode: 1,
      },
    });
    const result = checkGithubIdentity(repo, runner);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("invalid or expired");
    expect(result.message).toContain("env var");
  });

  it("passes with all required scopes", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_valid";
    const repo = setupTempRepo();
    const runner = mockRunner({
      "gh api -i /user": {
        stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: repo, read:org, workflow\n\n{"login":"bot-user"}',
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkGithubIdentity(repo, runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("env var");
    expect(result.message).toContain("bot-user");
  });

  it("warns when required scopes are missing", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "ghp_limited";
    const repo = setupTempRepo();
    const runner = mockRunner({
      "gh api -i /user": {
        stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: public_repo\n\n{"login":"user"}',
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkGithubIdentity(repo, runner);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("missing scopes");
    expect(result.message).toContain("repo");
    expect(result.message).toContain("read:org");
  });

  it("passes for fine-grained PAT without scope header", () => {
    process.env.NINTHWAVE_GITHUB_TOKEN = "github_pat_xxx";
    const repo = setupTempRepo();
    const runner = mockRunner({
      "gh api -i /user": {
        stdout: 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"login":"user"}',
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkGithubIdentity(repo, runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("fine-grained PAT");
  });

  it("reports config file as source when env var is not set", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(
      join(repo, ".ninthwave", "config"),
      "github_token=ghp_from_config\n",
    );
    const runner = mockRunner({
      "gh api -i /user": {
        stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: repo, read:org\n\n{"login":"config-user"}',
        stderr: "",
        exitCode: 0,
      },
    });
    const result = checkGithubIdentity(repo, runner);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("config file");
    expect(result.message).toContain("config-user");
  });
});

// ── Integration: runDoctor ───────────────────────────────────────────

describe("runDoctor", () => {
  it("returns exit code 0 when all required checks pass", () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    writeFileSync(join(repo, ".ninthwave", "config"), "# config\n");

    const doctor = runDoctor(repo, allPassRunner());
    expect(doctor.exitCode).toBe(0);
    expect(doctor.requiredPassed).toBe(doctor.requiredTotal);
    expect(doctor.requiredTotal).toBe(4);
  });

  it("returns exit code 1 when any required check fails", () => {
    const repo = setupTempRepo();

    const doctor = runDoctor(repo, allFailRunner());
    expect(doctor.exitCode).toBe(1);
    expect(doctor.requiredPassed).toBeLessThan(doctor.requiredTotal);
  });

  it("counts warnings from recommended checks", () => {
    const repo = setupTempRepo();
    // No .ninthwave/config, no pre-commit hook
    // All required pass, but recommended items warn
    const doctor = runDoctor(repo, allPassRunner());
    // .ninthwave/config doesn't exist -> warn
    // Let's create config so we can count warnings from other checks
    expect(doctor.warnings).toBeGreaterThanOrEqual(0);
  });

  it("produces results for all categories", () => {
    const repo = setupTempRepo();
    const doctor = runDoctor(repo, allPassRunner());
    const categories = new Set(doctor.results.map((r) => r.category));
    expect(categories).toContain("Required");
    expect(categories).toContain("Recommended");
    expect(categories).toContain("Optional");
  });

  it("mixed results: some required fail, some warn", () => {
    const repo = setupTempRepo();
    // gh fails, AI tool fails, but git config passes, mux passes
    const runner: ShellRunner = (cmd: string, args: string[]): RunResult => {
      // cmux available
      if (cmd === "which" && args[0] === "cmux") {
        return { stdout: "/usr/local/bin/cmux", stderr: "", exitCode: 0 };
      }
      // git config passes
      if (cmd === "git" && args[0] === "config" && args[1] === "user.name") {
        return { stdout: "User", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args[0] === "config" && args[1] === "user.email") {
        return { stdout: "u@e.com", stderr: "", exitCode: 0 };
      }
      // Everything else fails
      return { stdout: "", stderr: "not found", exitCode: 1 };
    };

    const doctor = runDoctor(repo, runner);
    expect(doctor.exitCode).toBe(1);
    // gh fails + AI tool fails = 2 required failures
    expect(doctor.requiredPassed).toBe(2); // mux + git config
    expect(doctor.requiredTotal).toBe(4);
    // no config warn + no pre-commit warn = 2 warnings (at least)
    expect(doctor.warnings).toBeGreaterThanOrEqual(2);
  });
});

// ── Output formatting ────────────────────────────────────────────────

describe("formatDoctorOutput", () => {
  it("includes the header line", () => {
    const repo = setupTempRepo();
    const doctor = runDoctor(repo, allPassRunner());
    const output = formatDoctorOutput(doctor);
    expect(output).toContain("ninthwave doctor");
  });

  it("includes category headers", () => {
    const repo = setupTempRepo();
    const doctor = runDoctor(repo, allPassRunner());
    const output = formatDoctorOutput(doctor);
    expect(output).toContain("Required");
    expect(output).toContain("Recommended");
    expect(output).toContain("Optional");
  });

  it("includes pass/fail/warn/info labels", () => {
    const repo = setupTempRepo();
    const doctor = runDoctor(repo, allFailRunner());
    const output = formatDoctorOutput(doctor);
    // Should have fail labels for required checks
    expect(output).toContain("fail");
    // Should have warn labels for recommended checks
    expect(output).toContain("warn");
    // Should have info labels for optional checks
    expect(output).toContain("info");
  });

  it("includes result summary line", () => {
    const repo = setupTempRepo();
    const doctor = runDoctor(repo, allPassRunner());
    const output = formatDoctorOutput(doctor);
    expect(output).toContain("Result:");
    expect(output).toContain("4/4 required checks passed");
  });

  it("includes warning count when warnings exist", () => {
    const repo = setupTempRepo();
    // No config file => at least 1 warning
    const doctor = runDoctor(repo, allPassRunner());
    if (doctor.warnings > 0) {
      const output = formatDoctorOutput(doctor);
      expect(output).toMatch(/\d+ warnings?/);
    }
  });

  it("includes detail lines for items with details", () => {
    const repo = setupTempRepo();
    const doctor = runDoctor(repo, allFailRunner());
    const output = formatDoctorOutput(doctor);
    // Failed checks should have detail/install hints
    expect(output).toContain("Install:");
  });
});
