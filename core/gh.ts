import { run } from "./shell.ts";
import type { RunResult } from "./types.ts";

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

/** Get CI check status for a PR. */
export function prChecks(
  repoRoot: string,
  prNumber: number,
): { state: string; name: string; url: string }[] {
  const result = ghInRepo(repoRoot, [
    "pr",
    "checks",
    String(prNumber),
    "--json",
    "state,name,detailsUrl",
  ]);
  if (result.exitCode !== 0 || !result.stdout) return [];
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      state: string;
      name: string;
      detailsUrl: string;
    }>;
    return raw.map((c) => ({
      state: c.state,
      name: c.name,
      url: c.detailsUrl,
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
