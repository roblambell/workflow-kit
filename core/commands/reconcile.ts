// reconcile command: synchronize TODOS.md with GitHub PR state and clean stale worktrees.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { info, warn, GREEN, RESET } from "../output.ts";
import { run } from "../shell.ts";
import { cmdMarkDone } from "./mark-done.ts";
import { cleanSingleWorktree, closeWorkspacesForIds } from "./clean.ts";
import { getMux } from "../mux.ts";
import { ID_IN_PARENS } from "../types.ts";

/**
 * Dependencies for reconcile, injectable for testing.
 */
export interface ReconcileDeps {
  /** Pull latest main with rebase. Returns { ok, conflict, error }. */
  pullRebase(projectRoot: string): { ok: boolean; conflict: boolean; error?: string };

  /** Get IDs of merged todo/* PRs from GitHub. */
  getMergedTodoIds(projectRoot: string): string[];

  /** Get IDs of items currently in TODOS.md. */
  getOpenTodoIds(todosFile: string): string[];

  /** Mark items as done in TODOS.md. */
  markDone(ids: string[], todosFile: string): void;

  /** List worktree IDs present in the worktree directory. */
  getWorktreeIds(worktreeDir: string): string[];

  /** Clean a single worktree. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;

  /** Close cmux workspaces for done/merged items. Returns count closed. */
  closeStaleWorkspaces(doneIds: string[]): number;

  /** Stage, commit, and push TODOS.md changes. Returns true if committed. */
  commitAndPush(projectRoot: string, todosFile: string): boolean;
}

// --- Three-way merge for TODOS.md ---

interface MergeItem {
  id: string;
  lines: string[];
}

interface MergeSection {
  header: string;
  preItems: string[];
  items: MergeItem[];
}

interface ParsedTodos {
  preamble: string[];
  sections: MergeSection[];
}

/**
 * Parse TODOS.md content into a structured format for three-way merge.
 * Splits into preamble (before first ##), sections (## headers),
 * and items (### headers with their content).
 */
export function parseTodosForMerge(content: string): ParsedTodos {
  const lines = content.split("\n");
  const result: ParsedTodos = { preamble: [], sections: [] };
  let currentSection: MergeSection | null = null;
  let currentItem: MergeItem | null = null;

  for (const line of lines) {
    // Section header (## but not ###)
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      if (currentItem && currentSection) {
        currentSection.items.push(currentItem);
        currentItem = null;
      }
      if (currentSection) {
        result.sections.push(currentSection);
      }
      currentSection = { header: line, preItems: [], items: [] };
      continue;
    }

    // Item header (###)
    if (line.startsWith("### ")) {
      if (currentItem && currentSection) {
        currentSection.items.push(currentItem);
      }
      const idMatch = line.match(ID_IN_PARENS);
      currentItem = { id: idMatch ? idMatch[1]! : "", lines: [line] };
      continue;
    }

    // Regular line — attach to current item, section preItems, or preamble
    if (currentItem) {
      currentItem.lines.push(line);
    } else if (currentSection) {
      currentSection.preItems.push(line);
    } else {
      result.preamble.push(line);
    }
  }

  // Flush remaining state
  if (currentItem && currentSection) {
    currentSection.items.push(currentItem);
  }
  if (currentSection) {
    result.sections.push(currentSection);
  }

  return result;
}

/** Extract all item IDs from a parsed TODOS.md. */
function extractIds(parsed: ParsedTodos): Set<string> {
  const ids = new Set<string>();
  for (const s of parsed.sections) {
    for (const item of s.items) {
      if (item.id) ids.add(item.id);
    }
  }
  return ids;
}

/**
 * Three-way merge of TODOS.md content.
 *
 * Uses standard three-way merge logic:
 * - Start with "ours" (upstream) as the base document structure
 * - Apply changes from "theirs" (local) relative to "base" (common ancestor)
 * - Removals from either side are preserved (mark-done)
 * - Additions from either side are preserved (new items)
 *
 * In a git rebase context:
 * - base = common ancestor (stage 1)
 * - ours = upstream/HEAD (stage 2) — the branch being rebased onto
 * - theirs = local commit being replayed (stage 3)
 */
export function mergeTodosThreeWay(base: string, ours: string, theirs: string): string {
  const baseParsed = parseTodosForMerge(base);
  const oursParsed = parseTodosForMerge(ours);
  const theirsParsed = parseTodosForMerge(theirs);

  const baseIds = extractIds(baseParsed);
  const theirsIds = extractIds(theirsParsed);

  // Compute changes from theirs relative to base
  const removedByTheirs = new Set([...baseIds].filter(id => !theirsIds.has(id)));
  const addedByTheirs = new Set([...theirsIds].filter(id => !baseIds.has(id)));

  // Build item map from theirs for items we need to add
  const theirsItemMap = new Map<string, { item: MergeItem; sectionHeader: string }>();
  for (const s of theirsParsed.sections) {
    for (const item of s.items) {
      if (item.id) theirsItemMap.set(item.id, { item, sectionHeader: s.header });
    }
  }

  // Build output using ours as primary structure, applying theirs' changes
  const outputLines: string[] = [...oursParsed.preamble];
  const oursSectionHeaders = new Set(oursParsed.sections.map(s => s.header));
  const placedAdditions = new Set<string>();

  for (const section of oursParsed.sections) {
    // Filter out items removed by theirs
    const keptItems = section.items.filter(item => {
      if (!item.id) return true; // preserve items without IDs
      return !removedByTheirs.has(item.id);
    });

    // Add items from theirs that belong to this section (by matching section header)
    const additionsForSection: MergeItem[] = [];
    for (const id of addedByTheirs) {
      if (placedAdditions.has(id)) continue;
      const entry = theirsItemMap.get(id);
      if (entry && entry.sectionHeader === section.header) {
        additionsForSection.push(entry.item);
        placedAdditions.add(id);
      }
    }

    const allItems = [...keptItems, ...additionsForSection];
    if (allItems.length === 0) continue; // drop empty sections

    outputLines.push(section.header);
    outputLines.push(...section.preItems);
    for (const item of allItems) {
      outputLines.push(...item.lines);
    }
  }

  // Add new sections from theirs (sections not present in ours)
  for (const section of theirsParsed.sections) {
    if (oursSectionHeaders.has(section.header)) continue;

    const keptItems = section.items.filter(item => {
      if (!item.id) return true;
      return addedByTheirs.has(item.id);
    });

    if (keptItems.length === 0) continue;

    outputLines.push(section.header);
    outputLines.push(...section.preItems);
    for (const item of keptItems) {
      outputLines.push(...item.lines);
    }
  }

  // Place any remaining theirs-only items that didn't match a section header
  for (const id of addedByTheirs) {
    if (placedAdditions.has(id)) continue;
    const entry = theirsItemMap.get(id);
    if (!entry) continue;

    // Create a new section for orphaned items
    outputLines.push("");
    outputLines.push(entry.sectionHeader);
    outputLines.push("");
    outputLines.push(...entry.item.lines);
    placedAdditions.add(id);
  }

  return outputLines.join("\n");
}

// --- Default implementations ---

function defaultPullRebase(projectRoot: string): { ok: boolean; conflict: boolean; error?: string } {
  const result = run("git", ["-C", projectRoot, "pull", "--rebase", "--quiet"]);
  if (result.exitCode === 0) {
    return { ok: true, conflict: false };
  }

  // Check if it's a merge conflict
  const isConflict = result.stderr.includes("CONFLICT") ||
    result.stderr.includes("could not apply") ||
    result.stderr.includes("Merge conflict");

  if (!isConflict) {
    return { ok: false, conflict: false, error: result.stderr };
  }

  // Try to auto-resolve TODOS.md conflicts via three-way merge
  const MAX_RESOLVE_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt++) {
    // Check which files are conflicted
    const conflictCheck = run("git", ["-C", projectRoot, "diff", "--name-only", "--diff-filter=U"]);
    const conflictedFiles = conflictCheck.stdout.split("\n").map(f => f.trim()).filter(Boolean);

    if (conflictedFiles.length === 0) break;

    // Can only auto-resolve if TODOS.md is the only conflicted file
    const nonTodosConflicts = conflictedFiles.filter(f => f !== "TODOS.md");
    if (nonTodosConflicts.length > 0 || !conflictedFiles.includes("TODOS.md")) {
      run("git", ["-C", projectRoot, "rebase", "--abort"]);
      return { ok: false, conflict: true, error: `Conflicts in non-TODOS.md files: ${nonTodosConflicts.join(", ")}` };
    }

    // Read the three versions from git index stages
    const baseResult = run("git", ["-C", projectRoot, "show", ":1:TODOS.md"]);
    const oursResult = run("git", ["-C", projectRoot, "show", ":2:TODOS.md"]);
    const theirsResult = run("git", ["-C", projectRoot, "show", ":3:TODOS.md"]);

    // Treat missing stages as empty (e.g., file newly created on one side)
    const baseContent = baseResult.exitCode === 0 ? baseResult.stdout : "";
    const oursContent = oursResult.exitCode === 0 ? oursResult.stdout : "";
    const theirsContent = theirsResult.exitCode === 0 ? theirsResult.stdout : "";

    if (!oursContent && !theirsContent) {
      run("git", ["-C", projectRoot, "rebase", "--abort"]);
      return { ok: false, conflict: true, error: "Both sides of TODOS.md conflict are empty" };
    }

    info(`Auto-resolving TODOS.md conflict (attempt ${attempt + 1})...`);
    const merged = mergeTodosThreeWay(baseContent, oursContent, theirsContent);

    // Write merged result (ensure trailing newline)
    const finalContent = merged.endsWith("\n") ? merged : merged + "\n";
    writeFileSync(join(projectRoot, "TODOS.md"), finalContent);

    // Stage the resolved file
    run("git", ["-C", projectRoot, "add", "TODOS.md"]);

    // Continue the rebase
    const continueResult = run("git", ["-C", projectRoot, "-c", "core.editor=true", "rebase", "--continue"]);
    if (continueResult.exitCode === 0) {
      info("TODOS.md conflict resolved automatically.");
      return { ok: true, conflict: false };
    }

    // Check if we hit another conflict (multiple commits may conflict)
    const isNewConflict = continueResult.stderr.includes("CONFLICT") ||
      continueResult.stderr.includes("could not apply") ||
      continueResult.stderr.includes("Merge conflict");

    if (!isNewConflict) {
      run("git", ["-C", projectRoot, "rebase", "--abort"]);
      return { ok: false, conflict: true, error: `Rebase continue failed: ${continueResult.stderr}` };
    }
    // Loop to resolve the next conflict
  }

  // Exhausted attempts
  run("git", ["-C", projectRoot, "rebase", "--abort"]);
  return { ok: false, conflict: true, error: "Too many TODOS.md conflicts during rebase" };
}

function defaultGetMergedTodoIds(projectRoot: string): string[] {
  // List all merged PRs with todo/* head branches
  const result = run("gh", [
    "pr", "list",
    "--state", "merged",
    "--json", "headRefName",
    "--limit", "200",
  ], { cwd: projectRoot });

  if (result.exitCode !== 0 || !result.stdout) return [];

  try {
    const prs = JSON.parse(result.stdout) as Array<{ headRefName: string }>;
    const ids: string[] = [];
    for (const pr of prs) {
      if (pr.headRefName.startsWith("todo/")) {
        ids.push(pr.headRefName.slice(5)); // strip "todo/"
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function defaultGetOpenTodoIds(todosFile: string): string[] {
  if (!existsSync(todosFile)) return [];
  const content = readFileSync(todosFile, "utf-8");
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("### ")) continue;
    const match = line.match(ID_IN_PARENS);
    if (match) {
      ids.push(match[1]!);
    }
  }
  return ids;
}

function defaultMarkDone(ids: string[], todosFile: string): void {
  cmdMarkDone(ids, todosFile);
}

function defaultGetWorktreeIds(worktreeDir: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  try {
    return readdirSync(worktreeDir)
      .filter((e) => e.startsWith("todo-"))
      .map((e) => e.slice(5));
  } catch {
    return [];
  }
}

function defaultCleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean {
  return cleanSingleWorktree(id, worktreeDir, projectRoot);
}

function defaultCommitAndPush(projectRoot: string, todosFile: string): boolean {
  // Check if TODOS.md has changes
  const diffResult = run("git", ["-C", projectRoot, "diff", "--name-only", "TODOS.md"]);
  if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
    return false;
  }

  const addResult = run("git", ["-C", projectRoot, "add", "TODOS.md"]);
  if (addResult.exitCode !== 0) return false;

  const commitResult = run("git", ["-C", projectRoot, "commit", "-m", "chore: reconcile TODOS.md with merged PRs"]);
  if (commitResult.exitCode !== 0) return false;

  const pushResult = run("git", ["-C", projectRoot, "push", "--quiet"]);
  if (pushResult.exitCode !== 0) {
    warn(`Push failed: ${pushResult.stderr}`);
    return false;
  }

  return true;
}

function defaultCloseStaleWorkspaces(doneIds: string[]): number {
  return closeWorkspacesForIds(new Set(doneIds), getMux());
}

/** Build default dependencies from real implementations. */
export function defaultDeps(): ReconcileDeps {
  return {
    pullRebase: defaultPullRebase,
    getMergedTodoIds: defaultGetMergedTodoIds,
    getOpenTodoIds: defaultGetOpenTodoIds,
    markDone: defaultMarkDone,
    getWorktreeIds: defaultGetWorktreeIds,
    cleanWorktree: defaultCleanWorktree,
    closeStaleWorkspaces: defaultCloseStaleWorkspaces,
    commitAndPush: defaultCommitAndPush,
  };
}

/**
 * Reconcile TODOS.md with GitHub PR state and clean stale worktrees.
 *
 * Steps:
 * 1. git pull --rebase to get latest main
 * 2. Query gh for merged todo/* PRs
 * 3. Mark merged items as done in TODOS.md
 * 4. Clean worktrees for done items
 * 5. Commit and push TODOS.md if changed
 */
export function reconcile(
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
  deps: ReconcileDeps = defaultDeps(),
): void {
  // Step 1: Pull latest
  info("Pulling latest main...");
  const pullResult = deps.pullRebase(projectRoot);
  if (!pullResult.ok) {
    if (pullResult.conflict) {
      warn(`Merge conflict during rebase: ${pullResult.error ?? "unknown"}`);
      warn("Resolve conflicts manually and re-run reconcile.");
    } else {
      warn(`Pull failed: ${pullResult.error ?? "unknown"}`);
    }
    return;
  }

  // Step 2: Get merged todo IDs from GitHub
  info("Querying GitHub for merged todo/* PRs...");
  const mergedIds = deps.getMergedTodoIds(projectRoot);
  if (mergedIds.length === 0) {
    info("No merged todo/* PRs found.");
  }

  // Step 3: Find items that are merged but still open in TODOS.md
  const openIds = new Set(deps.getOpenTodoIds(todosFile));
  const toMarkDone = mergedIds.filter((id) => openIds.has(id));

  if (toMarkDone.length > 0) {
    info(`Marking ${toMarkDone.length} merged item(s) as done: ${toMarkDone.join(", ")}`);
    deps.markDone(toMarkDone, todosFile);
  } else {
    info("All merged items already marked done.");
  }

  // Step 4: Clean worktrees for done items
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  // Done items = those we just marked done + those already not in TODOS.md
  const doneIds = new Set(mergedIds);
  let cleanedCount = 0;

  for (const wtId of worktreeIds) {
    if (doneIds.has(wtId)) {
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        cleanedCount++;
      }
    }
  }

  if (cleanedCount > 0) {
    info(`Cleaned ${cleanedCount} stale worktree(s).`);
  }

  // Step 4.5: Close cmux workspaces for done/merged items
  const closedWorkspaces = deps.closeStaleWorkspaces(mergedIds);
  if (closedWorkspaces > 0) {
    info(`Closed ${closedWorkspaces} stale workspace(s).`);
  }

  // Step 5: Commit and push TODOS.md if changed
  if (toMarkDone.length > 0) {
    info("Committing and pushing TODOS.md...");
    if (deps.commitAndPush(projectRoot, todosFile)) {
      console.log(`${GREEN}Reconciled: marked ${toMarkDone.length} item(s) done, cleaned ${cleanedCount} worktree(s), closed ${closedWorkspaces} workspace(s).${RESET}`);
    } else {
      info("No TODOS.md changes to commit.");
    }
  } else {
    console.log(`${GREEN}Everything in sync — no changes needed.${RESET}`);
  }
}

/** CLI entry point for `ninthwave reconcile`. */
export function cmdReconcile(
  todosFile: string,
  worktreeDir: string,
  projectRoot: string,
): void {
  reconcile(todosFile, worktreeDir, projectRoot);
}
