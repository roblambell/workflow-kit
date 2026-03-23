// start command: launch parallel AI coding sessions for TODO items.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { parseTodos } from "../parser.ts";
import { die, warn, info, GREEN, RESET } from "../output.ts";
import { run } from "../shell.ts";
import {
  fetchOrigin,
  ffMerge,
  branchExists,
  deleteBranch,
  createWorktree,
} from "../git.ts";
import * as cmux from "../cmux.ts";
import {
  allocatePartition,
  getPartitionFor,
  cleanupStalePartitions,
} from "../partitions.ts";
import {
  resolveRepo,
  getWorktreeInfo,
  writeCrossRepoIndex,
  ensureWorktreeExcluded,
} from "../cross-repo.ts";
import { cmdConflicts } from "./conflicts.ts";
import type { TodoItem } from "../types.ts";

/**
 * Detect which AI coding tool is running the orchestrator session.
 * The same tool is used to launch worker sessions.
 */
export function detectAiTool(): string {
  // 1. Explicit override via environment variable
  if (process.env.NINTHWAVE_AI_TOOL) {
    return process.env.NINTHWAVE_AI_TOOL;
  }

  // 2. OpenCode: sets OPENCODE=1
  if (process.env.OPENCODE === "1") {
    return "opencode";
  }

  // 3. Claude Code: session env vars
  if (process.env.CLAUDE_CODE_SESSION || process.env.CLAUDE_SESSION_ID) {
    return "claude";
  }

  // 4. Walk up the process tree
  let pid = process.pid;
  let depth = 0;
  while (pid > 1 && depth < 10) {
    const result = run("ps", ["-o", "comm=", "-p", String(pid)]);
    if (result.exitCode === 0 && result.stdout) {
      const cmdBase = basename(result.stdout.trim());
      if (cmdBase === "opencode") return "opencode";
      if (cmdBase === "claude") return "claude";
      if (cmdBase === "copilot") return "copilot";
    }
    const ppidResult = run("ps", ["-o", "ppid=", "-p", String(pid)]);
    if (ppidResult.exitCode !== 0) break;
    pid = parseInt(ppidResult.stdout.trim(), 10) || 1;
    depth++;
  }

  // 5. Fallback: check if any tool binary is available
  if (run("which", ["claude"]).exitCode === 0) return "claude";
  if (run("which", ["opencode"]).exitCode === 0) return "opencode";
  if (run("which", ["copilot"]).exitCode === 0) return "copilot";

  return "unknown";
}

/**
 * Launch an AI coding session for a single TODO item.
 */
function launchAiSession(
  tool: string,
  worktreePath: string,
  id: string,
  safeTitle: string,
  promptFile: string,
): void {
  let cmd = "";
  let initialPrompt = "Start";

  switch (tool) {
    case "claude":
      cmd = `claude --name 'TODO ${id}: ${safeTitle}' --permission-mode bypassPermissions --agent todo-worker --append-system-prompt "$(cat '${promptFile}')"`;
      break;
    case "opencode":
      cmd = `opencode --agent todo-worker --title 'TODO ${id}: ${safeTitle}'`;
      initialPrompt = `${readFileSync(promptFile, "utf-8")}\n\nStart implementing this TODO now.`;
      break;
    case "copilot":
      cmd = `copilot --agent=todo-worker --allow-all-tools --allow-all-paths`;
      initialPrompt = `${readFileSync(promptFile, "utf-8")}\n\nStart implementing this TODO now.`;
      break;
    default:
      die(
        `Unknown AI tool: ${tool}. Ensure claude, opencode, or copilot is in your PATH.`,
      );
  }

  const wsRef = cmux.launchWorkspace(worktreePath, cmd);
  if (!wsRef) {
    warn(`cmux launch failed for ${id} -- is cmux running?`);
    return;
  }

  // Give the workspace a moment to initialize, then send initial prompt
  Bun.sleepSync(2000);
  if (!cmux.sendMessage(wsRef, initialPrompt + "\n")) {
    warn(`Failed to send initial prompt to ${wsRef} for ${id}`);
  }
}

/**
 * Extract full TODO text for an item from TODOS.md.
 */
function extractTodoText(todosFile: string, targetId: string): string {
  const content = readFileSync(todosFile, "utf-8");
  const lines = content.split("\n");
  let inItem = false;
  let found = false;
  const textLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (found) break;
      if (line.includes(`(${targetId}`)) {
        inItem = true;
        found = true;
      } else {
        inItem = false;
      }
    }
    if (inItem) {
      textLines.push(line);
    }
  }

  return textLines.join("\n");
}

export function cmdStart(
  args: string[],
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
): void {
  if (args.length < 1) die("Usage: ninthwave start <ID1> [ID2...]");

  const ids = args;
  const items = parseTodos(todosFile, worktreeDir);
  const itemMap = new Map<string, TodoItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }
  const allIds = new Set(items.map((it) => it.id));

  // Detect AI tool
  const aiTool = detectAiTool();
  if (aiTool === "unknown") {
    die(
      "Could not detect AI tool. Ensure claude, opencode, or copilot is in your PATH.",
    );
  }
  info(`Detected AI tool: ${aiTool}`);

  // Validate all items exist and check dependencies
  for (const id of ids) {
    const item = itemMap.get(id);
    if (!item) die(`Item ${id} not found`);

    for (const depId of item.dependencies) {
      if (allIds.has(depId)) {
        die(`Item ${id} depends on ${depId} which is not completed`);
      }
    }
  }

  // Resolve ALL repos before launching any workers
  const resolvedRepos = new Map<string, string>();
  for (const id of ids) {
    const item = itemMap.get(id)!;
    const targetRepo = resolveRepo(item.repoAlias, projectRoot);
    resolvedRepos.set(id, targetRepo);
  }

  // Check for file-level conflicts between selected items (warn only)
  if (ids.length > 1) {
    info("Checking for file-level conflicts...");
    // Reuse the conflicts command logic inline — just check, don't die
    const conflictItems = ids.map((id) => itemMap.get(id)!);
    let hasConflicts = false;
    for (let i = 0; i < conflictItems.length; i++) {
      for (let j = i + 1; j < conflictItems.length; j++) {
        const a = conflictItems[i]!;
        const b = conflictItems[j]!;
        const normA = normalizeRepoAlias(a.repoAlias);
        const normB = normalizeRepoAlias(b.repoAlias);
        if (normA !== normB) continue;

        const filesA = new Set(a.filePaths);
        const common = b.filePaths.filter((f) => filesA.has(f));
        if (common.length > 0 || a.domain === b.domain) {
          hasConflicts = true;
        }
      }
    }
    if (hasConflicts) {
      cmdConflicts(ids, todosFile, worktreeDir);
      console.log();
      warn("Conflicts detected between selected items. Proceeding anyway.");
      console.log();
    }
  }

  // Ensure worktree directory exists
  mkdirSync(worktreeDir, { recursive: true });

  // Clean stale partition locks before allocating
  const partitionDir = join(worktreeDir, ".partitions");
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  cleanupStalePartitions(partitionDir, worktreeDir, (todoId) =>
    getWorktreeInfo(todoId, crossRepoIndex, worktreeDir),
  );

  const promptFiles: string[] = [];
  const launched: string[] = [];

  try {
    for (const id of ids) {
      const item = itemMap.get(id)!;
      const targetRepo = resolvedRepos.get(id)!;

      // Determine worktree path based on target repo
      const branchName = `todo/${id}`;
      let worktreePath: string;
      if (targetRepo === projectRoot) {
        worktreePath = join(worktreeDir, `todo-${id}`);
      } else {
        worktreePath = join(targetRepo, ".worktrees", `todo-${id}`);
      }

      // Create worktree
      if (existsSync(worktreePath)) {
        warn(`Worktree already exists for ${id} at ${worktreePath}, reusing`);
      } else {
        // Ensure target worktree dir exists for cross-repo items
        if (targetRepo !== projectRoot) {
          mkdirSync(join(targetRepo, ".worktrees"), { recursive: true });
          ensureWorktreeExcluded(targetRepo);
        }

        info(
          `Fetching latest main in ${basename(targetRepo)} before creating worktree for ${id}`,
        );
        try {
          fetchOrigin(targetRepo, "main");
        } catch {
          // fetch may fail if no remote
        }
        try {
          ffMerge(targetRepo, "main");
        } catch {
          // ff-merge may fail
        }

        // Handle branch collision
        if (branchExists(targetRepo, branchName)) {
          warn(
            `Branch ${branchName} already exists in ${basename(targetRepo)}. Deleting stale branch.`,
          );
          try {
            deleteBranch(targetRepo, branchName);
          } catch {
            // ignore
          }
        }

        info(
          `Creating worktree for ${id} on branch ${branchName} in ${basename(targetRepo)}`,
        );
        createWorktree(targetRepo, worktreePath, branchName);
      }

      // Track cross-repo items in the index
      if (targetRepo !== projectRoot) {
        writeCrossRepoIndex(crossRepoIndex, id, targetRepo, worktreePath);
      }

      // Allocate partition
      let partition = getPartitionFor(partitionDir, id);
      if (partition === null) {
        partition = allocatePartition(partitionDir, id);
      }

      // Sanitize title for shell safety
      const safeTitle = item.title.replace(/[`$']/g, "_");
      info(
        `Launching ${aiTool} session for ${id}: ${safeTitle} (partition ${partition})`,
      );

      // Build system prompt
      const todoText = extractTodoText(todosFile, id);
      const systemPrompt = `YOUR_TODO_ID: ${id}
YOUR_PARTITION: ${partition}
PROJECT_ROOT: ${targetRepo}
HUB_ROOT: ${projectRoot}

${todoText}`;

      // Write system prompt to a temp file
      const promptFile = join(
        tmpdir(),
        `nw-prompt-${id}-${Date.now()}`,
      );
      promptFiles.push(promptFile);
      writeFileSync(promptFile, systemPrompt);

      // Launch
      launchAiSession(aiTool, worktreePath, id, safeTitle, promptFile);
      launched.push(id);
    }

    console.log();
    console.log(
      `${GREEN}Launched ${launched.length} session(s) via ${aiTool}:${RESET}`,
    );
    for (const id of launched) {
      const item = itemMap.get(id)!;
      const targetRepo = resolvedRepos.get(id)!;
      if (targetRepo === projectRoot) {
        console.log(`  - ${id}: ${item.title}`);
      } else {
        console.log(`  - ${id}: ${item.title} [${basename(targetRepo)}]`);
      }
    }
  } finally {
    // Clean up temp prompt files
    for (const f of promptFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }
}

function normalizeRepoAlias(alias: string): string {
  if (!alias || alias === "self" || alias === "hub") return "hub";
  return alias;
}
