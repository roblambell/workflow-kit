import { run } from "./shell.ts";
import type { RunResult } from "./types.ts";
import { loadConfig } from "./config.ts";

/** Run a gh command in the context of a specific repo directory. */
export function ghInRepo(repoRoot: string, args: string[]): RunResult {
  return run("gh", args, { cwd: repoRoot });
}

/** Check if the gh CLI is available. */
export function isAvailable(): boolean {
  const result = run("gh", ["--version"]);
  return result.exitCode === 0;
}

/** List PRs for a branch with a given state. Returns array of {number}. */
export function prList(
  repoRoot: string,
  branch: string,
  state: string,
): Array<{ number: number }> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    state,
    "--json",
    "number",
    "--limit",
    "100",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    return JSON.parse(result.stdout) as Array<{ number: number }>;
  } catch {
    return [];
  }
}

/** View a PR by number, returning requested fields. */
export function prView(
  repoRoot: string,
  prNumber: number,
  fields: string[],
): Record<string, unknown> {
  const result = ghInRepo(repoRoot, [
    "pr",
    "view",
    String(prNumber),
    "--json",
    fields.join(","),
  ]);
  if (result.exitCode !== 0 || !result.stdout) return {};
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Get CI check status for a PR. Includes completedAt for detection latency measurement. */
export function prChecks(
  repoRoot: string,
  prNumber: number,
): { state: string; name: string; url: string; completedAt?: string }[] {
  const result = ghInRepo(repoRoot, [
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "state,name,link,completedAt",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      state: string;
      name: string;
      link: string;
      completedAt?: string;
    }>;
    return raw.map((c) => ({
      state: c.state,
      name: c.name,
      url: c.link,
      completedAt: c.completedAt || undefined,
    }));
  } catch {
    return [];
  }
}

/** Get the owner/repo string (e.g., "ninthwave-sh/ninthwave"). */
export function getRepoOwner(repoRoot: string): string {
  const result = ghInRepo(repoRoot, [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error("Could not determine repository owner");
  }
  return result.stdout;
}

/** Merge a PR by number. Returns true on success, false on failure. */
export function prMerge(
  repoRoot: string,
  prNumber: number,
  method: "squash" | "merge" | "rebase" = "squash",
): boolean {
  const result = ghInRepo(repoRoot, [
    "pr",
    "merge",
    String(prNumber),
    `--${method}`,
    "--delete-branch",
  ]);
  return result.exitCode === 0;
}

/** Post a comment on a PR. Returns true on success, false on failure. */
export function prComment(
  repoRoot: string,
  prNumber: number,
  body: string,
): boolean {
  const result = ghInRepo(repoRoot, [
    "pr",
    "comment",
    String(prNumber),
    "--body",
    body,
  ]);
  return result.exitCode === 0;
}

/**
 * Check if a PR is mergeable (no conflicts with base branch).
 * Returns true if mergeable or status is unknown, false only if definitely conflicting.
 * Conservative: treats unknown as mergeable to avoid spurious rebase requests.
 */
export function checkPrMergeable(repoRoot: string, prNumber: number): boolean {
  const data = prView(repoRoot, prNumber, ["mergeable"]);
  const mergeable = data.mergeable as string | undefined;
  // GitHub returns "MERGEABLE", "CONFLICTING", or "UNKNOWN"
  return mergeable !== "CONFLICTING";
}

/** Lock a PR/issue conversation to restrict comments to collaborators. Returns true on success. */
export function prLock(repoRoot: string, prNumber: number): boolean {
  let ownerRepo: string;
  try {
    ownerRepo = getRepoOwner(repoRoot);
  } catch {
    return false;
  }
  const result = ghInRepo(repoRoot, [
    "api",
    "--method",
    "PUT",
    `repos/${ownerRepo}/issues/${prNumber}/lock`,
    "-f",
    "lock_reason=resolved",
  ]);
  return result.exitCode === 0;
}

/** Make a gh api GET request, optionally with a jq filter. */
export function apiGet(
  repoRoot: string,
  path: string,
  jqFilter?: string,
): string {
  const args = ["api", path];
  if (jqFilter) {
    args.push("--jq", jqFilter);
  }
  const result = ghInRepo(repoRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Resolve the GitHub token to use for gh CLI commands.
 * Priority: NINTHWAVE_GITHUB_TOKEN env var > github_token config key > undefined (use default gh auth).
 */
export function resolveGithubToken(projectRoot: string): string | undefined {
  const envToken = process.env.NINTHWAVE_GITHUB_TOKEN;
  if (envToken) return envToken;

  const config = loadConfig(projectRoot);
  const configToken = config["github_token"];
  if (configToken) return configToken;

  return undefined;
}

/**
 * Apply the resolved GitHub token to process.env.GH_TOKEN.
 * This makes all gh CLI invocations (daemon + workers) use the custom identity.
 * Workers inherit GH_TOKEN via environment when launched.
 * No-op if no custom token is configured — preserves default gh auth behavior.
 */
export function applyGithubToken(projectRoot: string): void {
  const token = resolveGithubToken(projectRoot);
  if (token) {
    process.env.GH_TOKEN = token;
  }
}
