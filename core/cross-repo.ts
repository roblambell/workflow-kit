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
import { info, BOLD, CYAN, GREEN, RED, RESET } from "./output.ts";
import { run, GIT_TIMEOUT, GH_TIMEOUT } from "./shell.ts";
import type { WorktreeInfo } from "./types.ts";

/** Regex for valid GitHub repo names (used for alias validation). */
export const VALID_ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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

  if (!VALID_ALIAS_RE.test(alias)) {
    throw new Error(
      `Invalid repo alias '${alias}': must match GitHub repo name restrictions (alphanumeric, dots, hyphens, underscores; must start with alphanumeric)`,
    );
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
        throw new Error(
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
  throw new Error(
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
  workItemId: string,
  targetRepo: string,
  worktreePath: string,
): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  const lockPath = `${indexPath}.lock`;
  acquireLock(lockPath);
  try {
    const newLine = `${workItemId}\t${targetRepo}\t${worktreePath}`;
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      const lines = content.split("\n");
      const idx = lines.findIndex((l) => l.startsWith(`${workItemId}\t`));
      if (idx >= 0) {
        // Update existing entry
        lines[idx] = newLine;
        writeFileSync(indexPath, lines.join("\n"));
      } else {
        appendFileSync(indexPath, `${newLine}\n`);
      }
    } else {
      writeFileSync(indexPath, `${newLine}\n`);
    }
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Remove an entry from the cross-repo index (lock-protected).
 */
export function removeCrossRepoIndex(
  indexPath: string,
  workItemId: string,
): void {
  if (!existsSync(indexPath)) return;
  const lockPath = `${indexPath}.lock`;
  acquireLock(lockPath);
  try {
    const content = readFileSync(indexPath, "utf-8");
    const filtered = content
      .split("\n")
      .filter((line) => !line.startsWith(`${workItemId}\t`))
      .join("\n");
    writeFileSync(indexPath, filtered);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Parse the cross-repo index file and return all entries.
 * Returns an empty array if the file doesn't exist or is malformed.
 */
export function listCrossRepoEntries(indexPath: string): WorktreeInfo[] {
  if (!existsSync(indexPath)) return [];
  try {
    const content = readFileSync(indexPath, "utf-8");
    const entries: WorktreeInfo[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const [id, repoRoot, worktreePath] = line.split("\t");
      if (id && repoRoot && worktreePath) {
        entries.push({ itemId: id, repoRoot, worktreePath });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Get worktree info for a work item ID.
 * Checks cross-repo index first, falls back to hub worktree dir.
 * Accepts optional pre-parsed entries to avoid repeated file I/O.
 */
export function getWorktreeInfo(
  workItemId: string,
  indexPath: string,
  worktreeDir: string,
  cachedEntries?: WorktreeInfo[],
): WorktreeInfo | null {
  // Check cross-repo index first (use cached entries if provided)
  const entries = cachedEntries ?? listCrossRepoEntries(indexPath);
  for (const entry of entries) {
    if (entry.itemId === workItemId) {
      return entry;
    }
  }

  // Fallback: hub repo worktree (backwards compat)
  const hubPath = join(worktreeDir, `ninthwave-${workItemId}`);
  if (existsSync(hubPath)) {
    // Derive project root from worktree dir (worktreeDir = <projectRoot>/.ninthwave/.worktrees)
    const projectRoot = dirname(dirname(worktreeDir));
    return { itemId: workItemId, repoRoot: projectRoot, worktreePath: hubPath };
  }

  return null;
}

/**
 * Ensure .ninthwave/.worktrees/ is excluded in a target repo via .git/info/exclude.
 */
export function ensureWorktreeExcluded(targetRepo: string): void {
  const excludeFile = join(targetRepo, ".git", "info", "exclude");
  const excludePattern = ".ninthwave/.worktrees/";
  if (existsSync(excludeFile)) {
    const content = readFileSync(excludeFile, "utf-8");
    if (!content.includes(excludePattern)) {
      appendFileSync(excludeFile, `\n${excludePattern}\n`);
    }
  } else {
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(excludeFile, `${excludePattern}\n`);
  }
}

export type BootstrapResult =
  | { status: "exists" }
  | { status: "cloned"; path: string }
  | { status: "created"; path: string }
  | { status: "failed"; reason: string };

/**
 * Bootstrap a target repo for a cross-repo work item.
 *
 * Resolution chain:
 * 1. If the repo already exists locally (sibling dir or repos.conf) → return exists.
 * 2. If a GitHub remote exists for the alias → clone it to the sibling directory.
 * 3. If neither exists → create the directory, git init, create the GitHub repo.
 *
 * @param alias - The repo alias from the work item's `Repo:` field.
 * @param projectRoot - The hub repo's root directory.
 * @param ghOrg - GitHub org/user for repo creation (derived from hub repo's remote).
 */
export function bootstrapRepo(
  alias: string,
  projectRoot: string,
  ghOrg?: string,
): BootstrapResult {
  // bootstrap: true without a Repo: field (or hub-local aliases) → no-op
  if (!alias || alias === "self" || alias === "hub") {
    return { status: "exists" };
  }

  if (!VALID_ALIAS_RE.test(alias)) {
    return {
      status: "failed",
      reason: `Invalid repo alias '${alias}': must match GitHub repo name restrictions`,
    };
  }

  // Check if the repo already exists locally
  try {
    resolveRepo(alias, projectRoot);
    return { status: "exists" };
  } catch {
    // Not found locally -- continue to bootstrap
  }

  const parentDir = dirname(projectRoot);
  const targetPath = join(parentDir, alias);

  // Detect the GitHub org from the hub repo's remote (for repo creation)
  const org = ghOrg ?? detectGhOrg(projectRoot);

  // Check if a remote repo exists on GitHub
  const remoteExists = checkRemoteExists(org, alias);

  if (remoteExists) {
    // Clone the remote repo to the sibling directory
    try {
      const cloneResult = run(
        "gh",
        ["repo", "clone", `${org}/${alias}`, targetPath],
        { timeout: GH_TIMEOUT },
      );
      if (cloneResult.exitCode !== 0) {
        return {
          status: "failed",
          reason: `clone-failed: gh repo clone ${org}/${alias} failed: ${cloneResult.stderr}`,
        };
      }
      return { status: "cloned", path: targetPath };
    } catch (e) {
      return {
        status: "failed",
        reason: `clone-failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // Neither local nor remote exists -- create from scratch
  try {
    mkdirSync(targetPath, { recursive: true });

    // git init
    const initResult = run("git", ["init", "--quiet"], {
      cwd: targetPath,
      timeout: GIT_TIMEOUT,
    });
    if (initResult.exitCode !== 0) {
      return {
        status: "failed",
        reason: `init-failed: git init failed: ${initResult.stderr}`,
      };
    }

    // Configure git user from hub repo
    const hubEmail = run("git", ["-C", projectRoot, "config", "user.email"]);
    const hubName = run("git", ["-C", projectRoot, "config", "user.name"]);
    if (hubEmail.exitCode === 0 && hubEmail.stdout) {
      run("git", ["-C", targetPath, "config", "user.email", hubEmail.stdout]);
    }
    if (hubName.exitCode === 0 && hubName.stdout) {
      run("git", ["-C", targetPath, "config", "user.name", hubName.stdout]);
    }

    // Create initial commit
    const readmePath = join(targetPath, "README.md");
    writeFileSync(readmePath, `# ${alias}\n`);
    run("git", ["-C", targetPath, "add", "."], { timeout: GIT_TIMEOUT });
    run("git", ["-C", targetPath, "commit", "-m", "Initial commit", "--quiet"], {
      timeout: GIT_TIMEOUT,
    });

    // Rename default branch to main
    run("git", ["-C", targetPath, "branch", "-M", "main"], {
      timeout: GIT_TIMEOUT,
    });

    // Create GitHub repo (private by default)
    if (org) {
      const createResult = run(
        "gh",
        [
          "repo",
          "create",
          `${org}/${alias}`,
          "--private",
          "--source",
          targetPath,
          "--push",
        ],
        { timeout: GH_TIMEOUT },
      );
      if (createResult.exitCode !== 0) {
        return {
          status: "failed",
          reason: `gh-create-failed: gh repo create ${org}/${alias} failed: ${createResult.stderr}`,
        };
      }
    }

    return { status: "created", path: targetPath };
  } catch (e) {
    return {
      status: "failed",
      reason: `create-failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Detect the GitHub org/user from the hub repo's remote origin URL.
 * Supports SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo).
 * Returns empty string if detection fails.
 */
export function detectGhOrg(projectRoot: string): string {
  const result = run("git", ["-C", projectRoot, "remote", "get-url", "origin"]);
  if (result.exitCode !== 0 || !result.stdout) return "";

  const url = result.stdout.trim();

  // SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+)\//);
  if (sshMatch) return sshMatch[1]!;

  // HTTPS: https://github.com/org/repo
  const httpsMatch = url.match(/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1]!;

  return "";
}

/**
 * Check if a remote repo exists on GitHub.
 * Uses `gh repo view` which returns exit code 0 if the repo exists.
 */
function checkRemoteExists(org: string, alias: string): boolean {
  if (!org) return false;
  const result = run("gh", ["repo", "view", `${org}/${alias}`, "--json", "name"], {
    timeout: GH_TIMEOUT,
  });
  return result.exitCode === 0;
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
