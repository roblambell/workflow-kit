// mark-done and merged-ids commands.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { die, GREEN, RESET } from "../output.ts";
import { isBranchMerged, commitCount } from "../git.ts";
import { prList } from "../gh.ts";

/**
 * Remove completed items from TODOS.md by ID.
 * Handles section cleanup: removes section headers that become empty.
 */
export function cmdMarkDone(
  args: string[],
  todosFile: string,
): void {
  if (args.length < 1) die("Usage: ninthwave mark-done <ID1> [ID2...]");

  const ids = new Set(args);
  const content = readFileSync(todosFile, "utf-8");
  const lines = content.split("\n");
  const outputLines: string[] = [];

  let pendingSection = "";
  let pendingLines: string[] = [];
  let sectionHasItems = false;
  let skipItem = false;
  let inItem = false;

  function flushSection(): void {
    if (pendingSection) {
      outputLines.push(pendingSection);
      outputLines.push("");
      pendingSection = "";
    }
    if (pendingLines.length > 0) {
      outputLines.push(...pendingLines);
      pendingLines = [];
    }
  }

  for (const line of lines) {
    // Track section headers (## but not ###)
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      pendingSection = line;
      pendingLines = [];
      sectionHasItems = false;
      skipItem = false;
      inItem = false;
      continue;
    }

    // Check item headers
    if (line.startsWith("### ")) {
      skipItem = false;
      inItem = true;

      // Check if this item should be removed
      for (const id of ids) {
        if (line.includes(`(${id})`)) {
          skipItem = true;
          break;
        }
      }

      if (!skipItem) {
        sectionHasItems = true;
        flushSection();
      }
    }

    // Write line unless we're skipping this item
    if (!skipItem) {
      if (pendingSection) {
        // Buffer lines between section header and first kept item
        pendingLines.push(line);
      } else {
        outputLines.push(line);
      }
    }
  }

  writeFileSync(todosFile, outputLines.join("\n"));

  console.log(
    `${GREEN}Marked ${ids.size} item(s) as done: ${[...ids].join(" ")}${RESET}`,
  );
}

/**
 * Check each worktree's branch — if merged, print its ID.
 */
export function cmdMergedIds(
  worktreeDir: string,
  projectRoot: string,
): void {
  if (!existsSync(worktreeDir)) return;

  function checkMerged(id: string, repoRoot: string): void {
    const branch = `todo/${id}`;

    let merged = false;

    // Check git branch --merged
    const ahead = commitCount(repoRoot, "main", branch);
    if (ahead > 0 && isBranchMerged(repoRoot, branch, "main")) {
      merged = true;
    }

    // Check via gh PR status
    if (!merged) {
      const mergedPrs = prList(repoRoot, branch, "merged");
      if (mergedPrs.length > 0) merged = true;
    }

    if (merged) {
      console.log(id);
    }
  }

  // Hub-local worktrees
  try {
    for (const entry of readdirSync(worktreeDir)) {
      if (!entry.startsWith("todo-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      const id = entry.slice(5);
      checkMerged(id, projectRoot);
    }
  } catch {
    // ignore
  }

  // Cross-repo worktrees
  const indexPath = join(worktreeDir, ".cross-repo-index");
  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      const idxId = parts[0];
      const idxRepo = parts[1];
      const idxPath = parts[2];
      if (!idxId || !idxRepo || !idxPath) continue;
      if (!existsSync(idxPath)) continue;
      checkMerged(idxId, idxRepo);
    }
  }
}
