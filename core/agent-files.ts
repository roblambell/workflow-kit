// Agent file seeding into worktrees.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { run, GIT_TIMEOUT } from "./shell.ts";
import { info as defaultInfo } from "./output.ts";
import { agentTargetDirs } from "./ai-tools.ts";

/** Parse the configured LLM model from YAML frontmatter. */
export function parseAgentModel(content: string): string | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) return null;

  const modelMatch = frontmatterMatch[1]?.match(/^[ \t]*model[ \t]*:[ \t]*(.+?)[ \t]*$/m);
  if (!modelMatch) return null;

  let model = modelMatch[1]?.trim() ?? "";
  if (!model) return null;

  if (
    (model.startsWith('"') && model.endsWith('"')) ||
    (model.startsWith("'") && model.endsWith("'"))
  ) {
    model = model.slice(1, -1).trim();
  }

  return model.length > 0 ? model : null;
}

/** Dependencies for seedAgentFiles, injectable for testing. */
export interface SeedAgentFilesDeps {
  run: typeof run;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  info: typeof defaultInfo;
}

export interface SeededAgentFile {
  path: string;
  commitRecommended: boolean;
}

const defaultSeedDeps: SeedAgentFilesDeps = {
  run,
  readFileSync,
  readdirSync: readdirSync as (path: string) => string[],
  existsSync,
  mkdirSync,
  writeFileSync,
  info: defaultInfo,
};

/**
 * Read an agent file's content, preferring origin/main over local filesystem.
 * Returns the file content or null if unavailable from both sources.
 */
export function readAgentFileContent(
  hubRoot: string,
  filename: string,
  deps: Pick<SeedAgentFilesDeps, "run" | "readFileSync" | "existsSync"> = defaultSeedDeps,
): string | null {
  // Try reading from origin/main first for consistency with remote state
  try {
    const gitResult = deps.run("git", ["show", `origin/main:agents/${filename}`], {
      cwd: hubRoot,
      timeout: GIT_TIMEOUT,
    });
    if (gitResult.exitCode === 0 && gitResult.stdout.length > 0) {
      return gitResult.stdout;
    }
  } catch {
    // Fall back to the local filesystem if git is unavailable.
  }

  // Fallback to local filesystem
  const localPath = join(hubRoot, "agents", filename);
  if (deps.existsSync(localPath)) {
    return deps.readFileSync(localPath, "utf-8");
  }

  return null;
}

/**
 * Mirror agent files from the main checkout into a worktree.
 *
 * For committed agent files, git already includes them in the worktree.
 * For gitignored agent files (created by `nw init`), they exist in the main
 * checkout but not in worktrees. This function copies any missing files from
 * the main checkout's tool directories (.github/agents/, .claude/agents/, etc.)
 * into the worktree, preserving user customizations and avoiding surprise additions.
 */
function isIgnoredByGit(
  worktreePath: string,
  relativePath: string,
  deps: Pick<SeedAgentFilesDeps, "run" | "existsSync">,
): boolean {
  const hasGitMetadata = deps.existsSync(join(worktreePath, ".git"));
  const hasRootGitignore = deps.existsSync(join(worktreePath, ".gitignore"));
  if (!hasGitMetadata && !hasRootGitignore) {
    return false;
  }

  try {
    const result = deps.run("git", ["check-ignore", "--no-index", relativePath], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function seedAgentFiles(
  worktreePath: string,
  projectRoot: string,
  deps: SeedAgentFilesDeps = defaultSeedDeps,
): SeededAgentFile[] {
  const seeded: SeededAgentFile[] = [];
  const toolDirs = agentTargetDirs();

  for (const target of toolDirs) {
    const sourceDir = join(projectRoot, target.dir);
    if (!deps.existsSync(sourceDir)) continue;

    let files: string[];
    try {
      files = deps.readdirSync(sourceDir).filter((f: string) =>
        f.endsWith(".md") || f.endsWith(".toml"),
      );
    } catch { continue; }

    for (const filename of files) {
      const relativePath = join(target.dir, filename);
      const destPath = join(worktreePath, target.dir, filename);

      // Already in worktree (committed via git or previously seeded)
      if (deps.existsSync(destPath)) continue;

      // Copy from main checkout
      const content = deps.readFileSync(join(sourceDir, filename), "utf-8");
      const destDir = join(worktreePath, target.dir);
      if (!deps.existsSync(destDir)) deps.mkdirSync(destDir, { recursive: true });
      deps.writeFileSync(destPath, content);

      seeded.push({
        path: relativePath,
        commitRecommended: !isIgnoredByGit(worktreePath, relativePath, deps),
      });
    }
  }

  if (seeded.length > 0) {
    deps.info(`Seeded agent files into worktree: ${seeded.map((entry) => entry.path).join(", ")}`);
  }

  return seeded;
}
