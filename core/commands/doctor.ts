// `ninthwave doctor` — diagnostic command that verifies prerequisites and configuration.
//
// Runs a series of checks categorized as Required, Recommended, or Optional.
// Exit code 0 if all required checks pass, 1 if any required check fails.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { GREEN, YELLOW, RED, DIM, BOLD, RESET } from "../output.ts";
import type { RunResult } from "../types.ts";
import { resolveGithubToken, applyGithubToken } from "../gh.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Shell runner signature — injectable for testing. */
export type ShellRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => RunResult;

/** Result of a single diagnostic check. */
export interface CheckResult {
  status: "pass" | "fail" | "warn" | "info";
  message: string;
  detail?: string;
}

/** Category of a check. */
export type CheckCategory = "Required" | "Recommended" | "Optional";

/** A categorized check entry. */
export interface CheckEntry {
  category: CheckCategory;
  run: () => CheckResult;
}

/** Aggregate result of the doctor command. */
export interface DoctorResult {
  results: Array<{ category: CheckCategory; result: CheckResult }>;
  requiredTotal: number;
  requiredPassed: number;
  warnings: number;
  exitCode: number;
}

// ── Default shell runner ─────────────────────────────────────────────

import { run as defaultRun } from "../shell.ts";

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
      detail: "Run: git config --global user.name \"Your Name\"",
    };
  }

  if (email.exitCode !== 0 || !email.stdout.trim()) {
    return {
      status: "fail",
      message: "git user.email not configured",
      detail: "Run: git config --global user.email \"you@example.com\"",
    };
  }

  return {
    status: "pass",
    message: `git configured (user: ${name.stdout.trim()} <${email.stdout.trim()}>)`,
  };
}

/** Check: .ninthwave/config exists in the project. */
export function checkNinthwaveConfig(projectRoot: string): CheckResult {
  if (existsSync(join(projectRoot, ".ninthwave", "config"))) {
    return { status: "pass", message: ".ninthwave/config found" };
  }
  return {
    status: "warn",
    message: ".ninthwave/config not found",
    detail: "Run: nw setup",
  };
}

/** Check: nono installed for sandbox support. */
export function checkNono(runner: ShellRunner): CheckResult {
  const result = runner("which", ["nono"]);
  if (result.exitCode === 0) {
    return { status: "pass", message: "nono installed" };
  }
  return {
    status: "warn",
    message: "nono not installed \u2014 workers will run unsandboxed",
    detail: "Install: brew install ninthwave-sh/tap/nono",
  };
}

/** Check: sandbox profile exists and is valid. */
export function checkSandboxProfile(projectRoot: string): CheckResult {
  const projectProfile = join(
    projectRoot,
    ".nono",
    "profiles",
    "claude-worker.json",
  );
  if (existsSync(projectProfile)) {
    return { status: "pass", message: "Sandbox profile found (project-level)" };
  }

  const home = process.env.HOME;
  if (home) {
    const userProfile = join(home, ".nono", "profiles", "claude-worker.json");
    if (existsSync(userProfile)) {
      return { status: "pass", message: "Sandbox profile found (user-level)" };
    }
  }

  return {
    status: "warn",
    message: "No sandbox profile \u2014 run `nw setup` to create one",
  };
}

/** Check: pre-commit hook installed. */
export function checkPreCommitHook(projectRoot: string): CheckResult {
  if (existsSync(join(projectRoot, ".git", "hooks", "pre-commit"))) {
    return { status: "pass", message: "Pre-commit hook installed" };
  }
  return {
    status: "warn",
    message: "No pre-commit hook installed",
  };
}

/** Check: cloudflared installed for remote session access. */
export function checkCloudflared(runner: ShellRunner): CheckResult {
  const result = runner("which", ["cloudflared"]);
  if (result.exitCode === 0) {
    return { status: "pass", message: "cloudflared installed" };
  }
  return {
    status: "info",
    message:
      "cloudflared not installed \u2014 remote session access unavailable",
    detail: "Install: brew install cloudflared",
  };
}

/** Check: webhook URL configured for notifications. */
export function checkWebhookUrl(projectRoot: string): CheckResult {
  const configPath = join(projectRoot, ".ninthwave", "config");
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      if (content.match(/^webhook_url\s*=/m)) {
        return { status: "pass", message: "Webhook URL configured" };
      }
    } catch {
      // Fall through to info
    }
  }
  return {
    status: "info",
    message: "Webhook URL not configured \u2014 no notifications",
  };
}

/**
 * Check: custom GitHub identity configured and scopes validated.
 * When NINTHWAVE_GITHUB_TOKEN or github_token config is set, verifies the
 * token is valid and has required scopes (repo, read:org).
 */
export function checkGithubIdentity(
  projectRoot: string,
  runner: ShellRunner,
): CheckResult {
  const token = resolveGithubToken(projectRoot);
  if (!token) {
    return {
      status: "info",
      message: "No custom GitHub token configured \u2014 using default gh auth",
    };
  }

  const source = process.env.NINTHWAVE_GITHUB_TOKEN ? "env var" : "config file";

  // Validate the token by calling the /user endpoint with response headers
  const result = runner("gh", ["api", "-i", "/user"]);
  if (result.exitCode !== 0) {
    return {
      status: "fail",
      message: `Custom GitHub token (${source}) is invalid or expired`,
      detail: result.stderr || "Token authentication failed",
    };
  }

  // Parse X-OAuth-Scopes header from the response (classic PATs include this)
  const scopeMatch = result.stdout.match(/X-OAuth-Scopes:\s*(.+)/i);
  if (!scopeMatch) {
    // Fine-grained PATs don't include X-OAuth-Scopes header
    return {
      status: "pass",
      message: `Custom GitHub token configured (${source}) \u2014 fine-grained PAT (scopes not inspectable)`,
    };
  }

  const scopes = scopeMatch[1]!.split(",").map((s) => s.trim());
  const requiredScopes = ["repo", "read:org"];
  const missing = requiredScopes.filter((s) => !scopes.includes(s));

  if (missing.length > 0) {
    return {
      status: "warn",
      message: `Custom GitHub token (${source}) missing scopes: ${missing.join(", ")}`,
      detail: `Current scopes: ${scopes.join(", ")}. Required: ${requiredScopes.join(", ")}`,
    };
  }

  // Extract username from the JSON body
  let username = "";
  try {
    const bodyStart = result.stdout.indexOf("{");
    if (bodyStart !== -1) {
      const body = JSON.parse(result.stdout.slice(bodyStart));
      username = body.login || "";
    }
  } catch {
    // ignore parse errors
  }

  return {
    status: "pass",
    message: `Custom GitHub token configured (${source}${username ? `, user: ${username}` : ""})`,
  };
}

// ── Build check list ─────────────────────────────────────────────────

/** Build the full list of checks with categories. */
export function buildChecks(
  projectRoot: string,
  runner: ShellRunner,
): CheckEntry[] {
  return [
    // Required
    { category: "Required", run: () => checkGh(runner) },
    { category: "Required", run: () => checkAiTool(runner) },
    { category: "Required", run: () => checkMultiplexer(runner) },
    { category: "Required", run: () => checkGitConfig(runner) },

    // Recommended
    { category: "Recommended", run: () => checkNinthwaveConfig(projectRoot) },
    { category: "Recommended", run: () => checkNono(runner) },
    { category: "Recommended", run: () => checkSandboxProfile(projectRoot) },
    { category: "Recommended", run: () => checkPreCommitHook(projectRoot) },

    // Optional
    { category: "Optional", run: () => checkCloudflared(runner) },
    { category: "Optional", run: () => checkWebhookUrl(projectRoot) },
    { category: "Optional", run: () => checkGithubIdentity(projectRoot, runner) },
  ];
}

// ── Run doctor ───────────────────────────────────────────────────────

/** Status label for output formatting. */
function statusLabel(status: CheckResult["status"]): string {
  switch (status) {
    case "pass":
      return `${GREEN}pass${RESET}`;
    case "fail":
      return `${RED}fail${RESET}`;
    case "warn":
      return `${YELLOW}warn${RESET}`;
    case "info":
      return `${DIM}info${RESET}`;
  }
}

/**
 * Run all doctor checks and return aggregate results.
 * Does not print anything — callers handle output.
 */
export function runDoctor(
  projectRoot: string,
  runner: ShellRunner = defaultShellRunner,
): DoctorResult {
  const checks = buildChecks(projectRoot, runner);
  const results: DoctorResult["results"] = [];

  let requiredTotal = 0;
  let requiredPassed = 0;
  let warnings = 0;

  for (const check of checks) {
    const result = check.run();
    results.push({ category: check.category, result });

    if (check.category === "Required") {
      requiredTotal++;
      if (result.status === "pass") requiredPassed++;
    }
    if (result.status === "warn") warnings++;
  }

  const exitCode = requiredPassed === requiredTotal ? 0 : 1;

  return { results, requiredTotal, requiredPassed, warnings, exitCode };
}

/**
 * Format doctor results as a human-readable string.
 */
export function formatDoctorOutput(doctor: DoctorResult): string {
  const lines: string[] = [];
  lines.push("ninthwave doctor");
  lines.push("");

  let currentCategory = "";

  for (const { category, result } of doctor.results) {
    if (category !== currentCategory) {
      currentCategory = category;
      lines.push(`  ${BOLD}${category}${RESET}`);
    }

    lines.push(`  [${statusLabel(result.status)}] ${result.message}`);
    if (result.detail) {
      lines.push(`${DIM}         ${result.detail}${RESET}`);
    }
  }

  lines.push("");
  lines.push(
    `  Result: ${doctor.requiredPassed}/${doctor.requiredTotal} required checks passed.` +
      (doctor.warnings > 0
        ? ` ${doctor.warnings} warning${doctor.warnings !== 1 ? "s" : ""}.`
        : ""),
  );

  return lines.join("\n");
}

// ── CLI entry point ──────────────────────────────────────────────────

/**
 * CLI handler for `ninthwave doctor`.
 */
export function cmdDoctor(projectRoot: string): void {
  // Apply custom GitHub token so doctor checks can validate it
  applyGithubToken(projectRoot);
  const doctor = runDoctor(projectRoot);
  console.log(formatDoctorOutput(doctor));
  process.exit(doctor.exitCode);
}
