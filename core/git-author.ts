// Git author resolution utilities.
// Resolves the git author email of a work item file via `git log --format='%ae' -1 -- <path>`.
// Includes a per-sync-cycle cache to avoid repeated git calls.

import { execSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────

export interface GitAuthorDeps {
  /** Execute a shell command and return stdout. Defaults to execSync. */
  exec: (cmd: string, opts: { cwd: string }) => string;
}

const defaultDeps: GitAuthorDeps = {
  exec: (cmd, opts) => execSync(cmd, { ...opts, encoding: "utf-8", timeout: 5_000 }).trim(),
};

// ── Author resolution ────────────────────────────────────────────────

/**
 * Resolve the git author email for the commit that last touched a file.
 *
 * Uses `git log --format='%ae' -1 -- <path>` to find the author of the
 * most recent commit that modified the given file path.
 *
 * Returns empty string if:
 * - The file has no git history (e.g., untracked)
 * - The git command fails
 */
export function resolveGitAuthor(
  filePath: string,
  projectRoot: string,
  deps: GitAuthorDeps = defaultDeps,
): string {
  try {
    const email = deps.exec(
      `git log --format='%ae' -1 -- ${JSON.stringify(filePath)}`,
      { cwd: projectRoot },
    );
    return email || "";
  } catch {
    return "";
  }
}

// ── Author cache ─────────────────────────────────────────────────────

/**
 * Per-sync-cycle cache for git author resolution.
 *
 * Create a new instance (or call `clear()`) at the start of each sync
 * cycle to avoid repeated git calls for the same file paths.
 */
export class AuthorCache {
  private cache = new Map<string, string>();
  private deps: GitAuthorDeps;

  constructor(deps: GitAuthorDeps = defaultDeps) {
    this.deps = deps;
  }

  /**
   * Resolve the git author email for a file path, returning a cached
   * result if available.
   */
  resolve(filePath: string, projectRoot: string): string {
    const cached = this.cache.get(filePath);
    if (cached !== undefined) return cached;

    const author = resolveGitAuthor(filePath, projectRoot, this.deps);
    this.cache.set(filePath, author);
    return author;
  }

  /** Clear the cache (call at the start of each sync cycle). */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached entries (for testing). */
  get size(): number {
    return this.cache.size;
  }
}
