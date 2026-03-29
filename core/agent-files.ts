// Agent file seeding into worktrees.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { run, GIT_TIMEOUT } from "./shell.ts";
import { info as defaultInfo } from "./output.ts";
import { agentFileTargets } from "./ai-tools.ts";
import { AGENT_SOURCES } from "./commands/setup.ts";

/** Agent files to seed into worktrees -- derived from AI_TOOL_PROFILES. */
const AGENT_FILES = agentFileTargets(AGENT_SOURCES);

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
  const gitResult = deps.run("git", ["show", `origin/main:agents/${filename}`], {
    cwd: hubRoot,
    timeout: GIT_TIMEOUT,
  });
  if (gitResult.exitCode === 0 && gitResult.stdout.length > 0) {
    return gitResult.stdout;
  }

  // Fallback to local filesystem
  const localPath = join(hubRoot, "agents", filename);
  if (deps.existsSync(localPath)) {
    return deps.readFileSync(localPath, "utf-8");
  }

  return null;
}

/**
 * Seed agent files into a worktree if they don't already exist.
 * Reads agent content from origin/main for consistency with remote state,
 * falling back to the hub repo's local agents/ directory. Returns the list
 * of relative paths that were seeded (so the worker can commit them).
 */
export function seedAgentFiles(
  worktreePath: string,
  hubRoot: string,
  deps: SeedAgentFilesDeps = defaultSeedDeps,
): string[] {
  const seeded: string[] = [];

  for (const agent of AGENT_FILES) {
    const sourceContent = readAgentFileContent(hubRoot, agent.source, deps);
    if (!sourceContent) continue;
    const baseName = agent.source.replace(/\.md$/, "");

    for (const target of agent.targets) {
      const filename = target.suffix === ".agent.md" ? `ninthwave-${baseName}.agent.md` : agent.source;
      const destPath = join(worktreePath, target.dir, filename);

      if (deps.existsSync(destPath)) continue;

      deps.mkdirSync(dirname(destPath), { recursive: true });
      deps.writeFileSync(destPath, sourceContent);
      seeded.push(join(target.dir, filename));
    }
  }

  if (seeded.length > 0) {
    deps.info(`Seeded agent files into worktree: ${seeded.join(", ")}`);
  }

  return seeded;
}
