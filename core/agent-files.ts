// Agent file seeding into worktrees.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { run, GIT_TIMEOUT } from "./shell.ts";
import { info as defaultInfo } from "./output.ts";
import { agentFileTargets, agentTargetFilename } from "./ai-tools.ts";
import { discoverAgentSources, detectManagedCopyStatus, writeManagedCopy } from "./commands/setup.ts";

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
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  info: typeof defaultInfo;
}

const defaultSeedDeps: SeedAgentFilesDeps = {
  run,
  readFileSync,
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
 * Seed agent files into a worktree as managed copies.
 * Reads agent content from origin/main for consistency with remote state,
 * falling back to the hub repo's local agents/ directory. Returns the list
 * of relative paths that were created or refreshed (so the worker can commit them).
 */
export function seedAgentFiles(
  worktreePath: string,
  hubRoot: string,
  deps: SeedAgentFilesDeps = defaultSeedDeps,
): string[] {
  const seeded: string[] = [];
  const agentFiles = agentFileTargets(discoverAgentSources(hubRoot));

  for (const agent of agentFiles) {
    const sourceContent = readAgentFileContent(hubRoot, agent.source, deps);
    if (!sourceContent) continue;

    for (const target of agent.targets) {
      const filename = agentTargetFilename(agent.source, target);
      const destPath = join(worktreePath, target.dir, filename);

      const status = detectManagedCopyStatus(destPath, sourceContent);
      if (status === "up-to-date") continue;

      writeManagedCopy(destPath, sourceContent);
      seeded.push(join(target.dir, filename));
    }
  }

  if (seeded.length > 0) {
    deps.info(`Seeded agent files into worktree: ${seeded.join(", ")}`);
  }

  return seeded;
}
