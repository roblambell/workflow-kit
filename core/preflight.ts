// Pre-flight environment validation for ninthwave orchestration.
//
// Extracts the four required checks from doctor.ts into a shared module.
// Used by both `ninthwave orchestrate` (as a gate before forking) and
// `ninthwave doctor` (to avoid duplication).

import type { RunResult } from "./types.ts";
import { run as defaultRun } from "./shell.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Shell runner signature — injectable for testing. */
export type ShellRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => RunResult;

/** Result of a single pre-flight check. */
export interface CheckResult {
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail?: string;
}

/** Aggregate result of running all pre-flight checks. */
export interface PreflightResult {
  checks: CheckResult[];
  passed: boolean;
  errors: string[];
}

// ── Default shell runner ─────────────────────────────────────────────

const defaultShellRunner: ShellRunner = (cmd, args, opts) =>
  defaultRun(cmd, args, opts);

// ── Individual checks ────────────────────────────────────────────────

/** Check: gh CLI installed and authenticated. */
export function checkGh(runner: ShellRunner): CheckResult {
  const which = runner("which", ["gh"]);
  if (which.exitCode !== 0) {
    return {
      status: "fail",
      message: "gh CLI not installed",
      detail: "Install: brew install gh",
    };
  }

  const auth = runner("gh", ["auth", "status"]);
  if (auth.exitCode !== 0) {
    return {
      status: "fail",
      message: "gh CLI installed but not authenticated",
      detail: "Run: gh auth login",
    };
  }

  return { status: "pass", message: "gh CLI installed and authenticated" };
}

/** Check: at least one AI tool available (claude, opencode, copilot). */
export function checkAiTool(runner: ShellRunner): CheckResult {
  const tools = ["claude", "opencode", "copilot"];
  const found: string[] = [];

  for (const tool of tools) {
    const result = runner("which", [tool]);
    if (result.exitCode === 0) {
      found.push(tool);
    }
  }

  if (found.length === 0) {
    return {
      status: "fail",
      message: "No AI tool available (need claude, opencode, or copilot)",
      detail: "Install: curl -fsSL https://claude.ai/install.sh | bash",
    };
  }

  return {
    status: "pass",
    message: `${found.join(", ")} available`,
  };
}

/** Check: at least one multiplexer available (cmux, tmux, zellij). */
export function checkMultiplexer(runner: ShellRunner): CheckResult {
  if (runner("which", ["cmux"]).exitCode === 0) {
    return { status: "pass", message: "cmux available (preferred)" };
  }
  if (runner("which", ["tmux"]).exitCode === 0) {
    return { status: "pass", message: "tmux available" };
  }
  if (runner("which", ["zellij"]).exitCode === 0) {
    return { status: "pass", message: "zellij available" };
  }

  return {
    status: "fail",
    message: "No multiplexer available (need cmux, tmux, or zellij)",
    detail: "Install: brew install --cask manaflow-ai/cmux/cmux",
  };
}

/** Check: git user.name and user.email configured. */
export function checkGitConfig(runner: ShellRunner): CheckResult {
  const name = runner("git", ["config", "user.name"]);
  const email = runner("git", ["config", "user.email"]);

  if (name.exitCode !== 0 || !name.stdout.trim()) {
    return {
      status: "fail",
      message: "git user.name not configured",
      detail: 'Run: git config --global user.name "Your Name"',
    };
  }

  if (email.exitCode !== 0 || !email.stdout.trim()) {
    return {
      status: "fail",
      message: "git user.email not configured",
      detail: 'Run: git config --global user.email "you@example.com"',
    };
  }

  return {
    status: "pass",
    message: `git configured (user: ${name.stdout.trim()} <${email.stdout.trim()}>)`,
  };
}

// ── Pre-flight runner ────────────────────────────────────────────────

/**
 * Run all required pre-flight checks.
 * Returns a result with pass/fail per check, overall pass/fail, and
 * human-readable error messages for any failures.
 */
export function preflight(
  runner: ShellRunner = defaultShellRunner,
): PreflightResult {
  const checks = [
    checkGh(runner),
    checkAiTool(runner),
    checkMultiplexer(runner),
    checkGitConfig(runner),
  ];

  const errors: string[] = [];
  for (const check of checks) {
    if (check.status === "fail") {
      const line = check.detail
        ? `${check.message} — ${check.detail}`
        : check.message;
      errors.push(line);
    }
  }

  return {
    checks,
    passed: errors.length === 0,
    errors,
  };
}
