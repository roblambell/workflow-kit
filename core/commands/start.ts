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
import { type Multiplexer, getMux, waitForReady } from "../mux.ts";
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
import { readTodo } from "../todo-files.ts";
import type { TodoItem } from "../types.ts";

/**
 * Sanitize a title for safe shell interpolation.
 * Uses an allowlist: only [a-zA-Z0-9 _-] are kept; everything else becomes _.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[^a-zA-Z0-9 _-]/g, "_");
}

/** Result of launching a single TODO item. */
export interface LaunchResult {
  worktreePath: string;
  workspaceRef: string;
}

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
  mux: Multiplexer,
): string | null {
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

  const wsRef = mux.launchWorkspace(worktreePath, cmd, id);
  if (!wsRef) {
    warn(`cmux launch failed for ${id} -- is cmux running?`);
    return null;
  }

  // Wait for the AI tool to finish loading before sending the prompt.
  // Claude Code / OpenCode can take 5-15s to initialize; a fixed sleep races.
  if (!waitForReady(mux, wsRef)) {
    warn(`Workspace ${wsRef} did not become ready within timeout for ${id} -- sending prompt anyway`);
  }
  if (!mux.sendMessage(wsRef, initialPrompt + "\n")) {
    warn(`Failed to send initial prompt to ${wsRef} for ${id}`);
  }

  return wsRef;
}

/**
 * Extract full TODO text for an item from its individual todo file.
 * Looks for a file matching `*--{targetId}.md` in todosDir.
 */
export function extractTodoText(todosDir: string, targetId: string): string {
  const item = readTodo(todosDir, targetId);
  if (!item) return "";
  return item.rawText;
}

/**
 * Launch a single TODO item: create worktree, allocate partition, start AI session.
 * Used by the orchestrator to launch items one at a time as WIP slots open.
 */
export function launchSingleItem(
  item: TodoItem,
  todosDir: string,
  worktreeDir: string,
  projectRoot: string,
  aiTool: string,
  mux: Multiplexer = getMux(),
): LaunchResult | null {
  let targetRepo: string;
  try {
    targetRepo = resolveRepo(item.repoAlias, projectRoot);
  } catch (err) {
    warn(`Skipping ${item.id}: ${(err as Error).message}`);
    return null;
  }
  const branchName = `todo/${item.id}`;

  // Ensure worktree directory exists
  mkdirSync(worktreeDir, { recursive: true });

  // Determine worktree path based on target repo
  let worktreePath: string;
  if (targetRepo === projectRoot) {
    worktreePath = join(worktreeDir, `todo-${item.id}`);
  } else {
    worktreePath = join(targetRepo, ".worktrees", `todo-${item.id}`);
  }

  // Create worktree
  if (existsSync(worktreePath)) {
    warn(`Worktree already exists for ${item.id} at ${worktreePath}, reusing`);
  } else {
    // Ensure target worktree dir exists for cross-repo items
    if (targetRepo !== projectRoot) {
      mkdirSync(join(targetRepo, ".worktrees"), { recursive: true });
      ensureWorktreeExcluded(targetRepo);
    }

    info(
      `Fetching latest main in ${basename(targetRepo)} before creating worktree for ${item.id}`,
    );
    try {
      fetchOrigin(targetRepo, "main");
    } catch (e) {
      warn(
        `Failed to fetch origin/main in ${basename(targetRepo)} for ${item.id}: ${e instanceof Error ? e.message : e}. Worktree will be based on local main (may be outdated).`,
      );
    }
    try {
      ffMerge(targetRepo, "main");
    } catch (e) {
      warn(
        `Failed to fast-forward main in ${basename(targetRepo)} for ${item.id}: ${e instanceof Error ? e.message : e}. Worktree may be based on outdated code.`,
      );
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
      `Creating worktree for ${item.id} on branch ${branchName} in ${basename(targetRepo)}`,
    );
    createWorktree(targetRepo, worktreePath, branchName);
  }

  // Track cross-repo items in the index
  if (targetRepo !== projectRoot) {
    const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
    writeCrossRepoIndex(crossRepoIndex, item.id, targetRepo, worktreePath);
  }

  // Allocate partition
  const partitionDir = join(worktreeDir, ".partitions");
  let partition = getPartitionFor(partitionDir, item.id);
  if (partition === null) {
    partition = allocatePartition(partitionDir, item.id);
  }

  // Sanitize title for shell safety (allowlist: only keep safe characters)
  const safeTitle = sanitizeTitle(item.title);
  info(
    `Launching ${aiTool} session for ${item.id}: ${safeTitle} (partition ${partition})`,
  );

  // Build system prompt
  const todoText = extractTodoText(todosDir, item.id);
  const systemPrompt = `YOUR_TODO_ID: ${item.id}
YOUR_PARTITION: ${partition}
PROJECT_ROOT: ${targetRepo}
HUB_ROOT: ${projectRoot}

${todoText}`;

  // Write system prompt to a temp file
  const promptFile = join(tmpdir(), `nw-prompt-${item.id}-${Date.now()}`);
  writeFileSync(promptFile, systemPrompt);

  try {
    const workspaceRef = launchAiSession(
      aiTool,
      worktreePath,
      item.id,
      safeTitle,
      promptFile,
      mux,
    );
    if (!workspaceRef) return null;
    return { worktreePath, workspaceRef };
  } finally {
    // Clean up temp prompt file
    try {
      unlinkSync(promptFile);
    } catch {
      // ignore
    }
  }
}

export function cmdStart(
  args: string[],
  todosDir: string,
  worktreeDir: string,
  projectRoot: string,
  muxOverride?: Multiplexer,
): void {
  // Parse --mux flag before treating remaining args as IDs
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mux") {
      const value = args[i + 1];
      if (value !== "cmux" && value !== "tmux") {
        die(`Invalid --mux value: "${value ?? ""}". Must be "cmux" or "tmux".`);
      }
      process.env.NINTHWAVE_MUX = value;
      i++; // skip value
    } else {
      ids.push(args[i]!);
    }
  }

  if (ids.length < 1) die("Usage: ninthwave start <ID1> [ID2...] [--mux cmux|tmux]");
  const items = parseTodos(todosDir, worktreeDir);
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
    try {
      const targetRepo = resolveRepo(item.repoAlias, projectRoot);
      resolvedRepos.set(id, targetRepo);
    } catch (err) {
      die(`Failed to resolve repo for ${id}: ${(err as Error).message}`);
    }
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
      cmdConflicts(ids, todosDir, worktreeDir);
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

  const mux = muxOverride ?? getMux();
  const launched: string[] = [];

  for (const id of ids) {
    const item = itemMap.get(id)!;
    launchSingleItem(item, todosDir, worktreeDir, projectRoot, aiTool, mux);
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
}

function normalizeRepoAlias(alias: string): string {
  if (!alias || alias === "self" || alias === "hub") return "hub";
  return alias;
}
