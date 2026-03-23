import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join, dirname, basename } from "path";
import { acquireLock, releaseLock } from "./lock.ts";
import { die, info, BOLD, CYAN, GREEN, RED, RESET } from "./output.ts";
import { run } from "./shell.ts";
import type { WorktreeInfo } from "./types.ts";

/**
 * Resolve a repo alias to an absolute path.
 * Resolution chain: repos.conf -> sibling convention (../<alias>) -> error.
 * Returns projectRoot if alias is empty, "self", or "hub".
 */
export function resolveRepo(
  alias: string,
  projectRoot: string,
  reposConf?: string,
): string {
  if (!alias || alias === "self" || alias === "hub") {
    return projectRoot;
  }

  const confPath = reposConf ?? join(projectRoot, ".ninthwave", "repos.conf");

  // 1. Check repos.conf (explicit override wins)
  if (existsSync(confPath)) {
    const content = readFileSync(confPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === alias) {
        if (isGitRepo(value)) {
          return value;
        }
        die(
          `repos.conf maps '${alias}' to '${value}' but it is not a git repository`,
        );
      }
    }
  }

  // 2. Sibling convention: ../<alias>
  const parentDir = dirname(projectRoot);
  const siblingPath = join(parentDir, alias);
  if (isGitRepo(siblingPath)) {
    return siblingPath;
  }

  // 3. Not found
  die(
    `Repo '${alias}' not found. Checked repos.conf and sibling directory '${siblingPath}'. Add it to .ninthwave/repos.conf or clone it alongside this repo.`,
  );
}

function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Write an entry to the cross-repo index (lock-protected).
 */
export function writeCrossRepoIndex(
  indexPath: string,
  todoId: string,
  targetRepo: string,
  worktreePath: string,
): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const lockPath = `${indexPath}.lock`;
  acquireLock(lockPath);
  try {
    appendFileSync(indexPath, `${todoId}\t${targetRepo}\t${worktreePath}\n`);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Remove an entry from the cross-repo index (lock-protected).
 */
export function removeCrossRepoIndex(
  indexPath: string,
  todoId: string,
): void {
  if (!existsSync(indexPath)) return;
  const lockPath = `${indexPath}.lock`;
  acquireLock(lockPath);
  try {
    const content = readFileSync(indexPath, "utf-8");
    const filtered = content
      .split("\n")
      .filter((line) => !line.startsWith(`${todoId}\t`))
      .join("\n");
    writeFileSync(indexPath, filtered);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Get worktree info for a TODO ID.
 * Checks cross-repo index first, falls back to hub worktree dir.
 */
export function getWorktreeInfo(
  todoId: string,
  indexPath: string,
  worktreeDir: string,
): WorktreeInfo | null {
  // Check cross-repo index first
  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const [id, repoRoot, worktreePath] = line.split("\t");
      if (id === todoId && repoRoot && worktreePath) {
        return { todoId: id, repoRoot, worktreePath };
      }
    }
  }

  // Fallback: hub repo worktree (backwards compat)
  const hubPath = join(worktreeDir, `todo-${todoId}`);
  if (existsSync(hubPath)) {
    // Derive project root from worktree dir (worktreeDir = <projectRoot>/.worktrees)
    const projectRoot = dirname(worktreeDir);
    return { todoId, repoRoot: projectRoot, worktreePath: hubPath };
  }

  return null;
}

/**
 * Ensure .worktrees/ is excluded in a target repo via .git/info/exclude.
 */
export function ensureWorktreeExcluded(targetRepo: string): void {
  const excludeFile = join(targetRepo, ".git", "info", "exclude");
  if (existsSync(excludeFile)) {
    const content = readFileSync(excludeFile, "utf-8");
    if (!content.includes(".worktrees/")) {
      appendFileSync(excludeFile, "\n.worktrees/\n");
    }
  } else {
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(excludeFile, ".worktrees/\n");
  }
}

/**
 * List discovered repos: sibling directories that are git repos + repos.conf.
 */
export function listRepos(
  projectRoot: string,
  reposConf?: string,
): void {
  console.log(`${BOLD}Discovered repos:${RESET}`);
  console.log();

  const parentDir = dirname(projectRoot);
  let found = 0;
  const confPath = reposConf ?? join(projectRoot, ".ninthwave", "repos.conf");

  // Repos.conf overrides
  if (existsSync(confPath)) {
    console.log(`${CYAN}From repos.conf:${RESET}`);
    const content = readFileSync(confPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      const status = isGitRepo(value)
        ? `${GREEN}OK${RESET}`
        : `${RED}NOT FOUND${RESET}`;
      console.log(`  ${key.padEnd(20)} ${value}  [${status}]`);
      found++;
    }
    console.log();
  }

  // Sibling directories
  console.log(`${CYAN}Sibling directories (${basename(parentDir)}/):${RESET}`);
  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(parentDir, entry.name);
      // Skip self
      if (dirPath === projectRoot) continue;
      if (isGitRepo(dirPath)) {
        const remoteResult = run("git", [
          "-C",
          dirPath,
          "remote",
          "get-url",
          "origin",
        ]);
        const remoteUrl =
          remoteResult.exitCode === 0 ? remoteResult.stdout : "no remote";
        console.log(`  ${entry.name.padEnd(20)} ${remoteUrl}`);
        found++;
      }
    }
  } catch {
    // can't read parent dir
  }

  if (found === 0) {
    console.log("  No repos found");
  }
}
