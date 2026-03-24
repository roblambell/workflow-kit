// mark-done and merged-ids commands.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { die, GREEN, YELLOW, RESET } from "../output.ts";
import { isBranchMerged, commitCount } from "../git.ts";
import { prList } from "../gh.ts";
import { deleteTodoFile } from "../todo-files.ts";

/**
 * Remove completed items by deleting their individual todo files.
 * Idempotent: nonexistent IDs are reported but do not cause errors.
 */
export function cmdMarkDone(
  args: string[],
  todosDir: string,
): void {
  if (args.length < 1) die("Usage: ninthwave mark-done <ID1> [ID2...]");

  const done: string[] = [];
  const notFound: string[] = [];

  for (const id of args) {
    if (deleteTodoFile(todosDir, id)) {
      done.push(id);
    } else {
      notFound.push(id);
    }
  }

  if (done.length > 0) {
    console.log(
      `${GREEN}Marked ${done.length} item(s) as done: ${done.join(" ")}${RESET}`,
    );
  }

  if (notFound.length > 0) {
    console.log(
      `${YELLOW}Not found (already done?): ${notFound.join(" ")}${RESET}`,
    );
  }
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
