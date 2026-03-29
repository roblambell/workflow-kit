// Pre-flight environment validation for ninthwave orchestration.
//
// Extracts the four required checks from doctor.ts into a shared module.
// Used by both `ninthwave orchestrate` (as a gate before forking) and
// `ninthwave doctor` (to avoid duplication).

import { readFileSync } from "fs";
import type { RunResult } from "./types.ts";
import { run as defaultRun } from "./shell.ts";
import { AI_TOOL_PROFILES } from "./ai-tools.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Shell runner signature -- injectable for testing. */
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
  const tools = AI_TOOL_PROFILES.map((p) => p.command);
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
      message: `No AI tool available (need ${tools.join(", ")})`,
      detail: "Install: curl -fsSL https://claude.ai/install.sh | bash",
    };
  }

  return {
    status: "pass",
    message: `${found.join(", ")} available`,
  };
}

/** Check: cmux multiplexer available. */
export function checkMultiplexer(runner: ShellRunner): CheckResult {
  if (runner("which", ["cmux"]).exitCode === 0) {
    return { status: "pass", message: "cmux available" };
  }

  return {
    status: "fail",
    message: "No multiplexer available (need cmux)",
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

/** Check: no uncommitted work item files in .ninthwave/work/. */
export function checkUncommittedWorkItems(
  projectRoot: string,
  runner: ShellRunner,
): CheckResult {
  const status = runner("git", ["-C", projectRoot, "status", "--porcelain", ".ninthwave/work/"]);
  if (status.exitCode !== 0) {
    return { status: "warn", message: "Could not check work item file status" };
  }
  const changes = status.stdout.trim();
  if (!changes) {
    return { status: "pass", message: "All work item files committed" };
  }
  const count = changes.split("\n").filter(Boolean).length;
  return {
    status: "fail",
    message: `${count} uncommitted work item file(s) in .ninthwave/work/`,
    detail: "Run: git add .ninthwave/work/ && git commit -m 'chore: add work item files' && git push",
  };
}

/** Check: Copilot trusts the project root (advisory only). */
export function checkCopilotTrust(
  projectRoot: string,
  runner: ShellRunner,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): CheckResult {
  // Only relevant if copilot is available -- derive the binary name from the profile
  const copilotProfile = AI_TOOL_PROFILES.find((p) => p.id === "copilot");
  if (!copilotProfile || runner("which", [copilotProfile.command]).exitCode !== 0) {
    return { status: "info", message: "Copilot not installed (skip trust check)" };
  }

  // Read ~/.copilot/config.json
  const home = process.env.HOME ?? "";
  const configPath = `${home}/.copilot/config.json`;
  try {
    const config = JSON.parse(readFile(configPath));
    const trusted: string[] = config.trusted_folders ?? [];
    // Check if project root or a parent is trusted
    const isTrusted = trusted.some(
      (folder: string) =>
        projectRoot.startsWith(folder) || folder.startsWith(projectRoot),
    );
    if (isTrusted) {
      return { status: "pass", message: "Copilot trusts project root" };
    }
    return {
      status: "warn",
      message: "Project root not in Copilot trusted_folders",
      detail: `Add "${projectRoot}" to ~/.copilot/config.json trusted_folders to prevent trust prompts in worktrees`,
    };
  } catch {
    // No config file -- copilot might not be configured yet
    return {
      status: "warn",
      message: "Could not read ~/.copilot/config.json",
      detail:
        "Run copilot once to generate config, then add project root to trusted_folders",
    };
  }
}

// ── Pre-flight runner ────────────────────────────────────────────────

/**
 * Run all required pre-flight checks.
 * Returns a result with pass/fail per check, overall pass/fail, and
 * human-readable error messages for any failures.
 *
 * When projectRoot is provided, includes project-specific checks
 * (e.g., uncommitted work item files). Without it, only environment checks run.
 */
export function preflight(
  runner: ShellRunner = defaultShellRunner,
  projectRoot?: string,
): PreflightResult {
  const checks = [
    checkGh(runner),
    checkAiTool(runner),
    checkMultiplexer(runner),
    checkGitConfig(runner),
    ...(projectRoot ? [checkUncommittedWorkItems(projectRoot, runner)] : []),
    ...(projectRoot ? [checkCopilotTrust(projectRoot, runner)] : []),
  ];

  const errors: string[] = [];
  for (const check of checks) {
    if (check.status === "fail") {
      const line = check.detail
        ? `${check.message} -- ${check.detail}`
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
