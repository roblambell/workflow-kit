// File-per-todo operations: read, write, list, delete individual todo files.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import type { TodoItem, Priority } from "./types.ts";
import {
  PRIORITY_NUM,
  ID_IN_PARENS,
  ID_PATTERN_GLOBAL,
  ID_PATTERN_SOURCE,
  WILDCARD_DEP_PATTERN,
} from "./types.ts";
import { extractTestPlan, extractFilePaths, expandWildcardDeps, extractBody } from "./todo-utils.ts";

/** Map a priority to its sort-order number. */
export function priorityNum(p: Priority): number {
  return PRIORITY_NUM[p];
}

/**
 * Generate the canonical filename for a todo item.
 * Format: "{priority_num}-{domain_slug}--{ID}.md"
 * Example: "2-worker-reliability--M-WRK-8.md"
 */
export function todoFilename(
  item: Pick<TodoItem, "id" | "priority" | "domain">,
): string {
  return `${PRIORITY_NUM[item.priority]}-${item.domain}--${item.id}.md`;
}

/**
 * Parse a single todo file into a TodoItem.
 * Returns null if the file is malformed (missing ID or priority).
 */
export function parseTodoFile(filePath: string): TodoItem | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Extract ID from the first heading line: "# Type: Title (ID)"
  let id = "";
  let title = "";
  for (const line of lines) {
    if (line.startsWith("# ")) {
      const idMatch = line.match(ID_IN_PARENS);
      if (idMatch) {
        id = idMatch[1]!;
      }
      // Title: everything after "# " up to the ID parens
      title = line
        .slice(2)
        .replace(new RegExp(`\\s*\\(${ID_PATTERN_SOURCE}\\)`), "")
        .trim();
      // Strip "Type: " prefix if present (e.g., "Fix: foo" -> "foo")
      const colonIdx = title.indexOf(": ");
      if (colonIdx >= 0 && colonIdx < 20) {
        title = title.slice(colonIdx + 2);
      }
      break;
    }
  }

  if (!id) return null;

  // Extract priority
  let priority: Priority | "" = "";
  let depends = "";
  let bundle = "";
  let domain = "";
  let repoAlias = "";
  let bootstrap = false;

  for (const line of lines) {
    const priorityMatch = line.match(/^\*\*Priority:\*\*\s+(.+)/);
    if (priorityMatch) {
      let p = priorityMatch[1]!.toLowerCase().trim();
      p = p.replace(/ \(.*/, ""); // strip parenthetical suffixes
      priority = p as Priority;
    }

    const dependsMatch = line.match(/^\*\*Depends on:\*\*\s+(.+)/);
    if (dependsMatch) {
      depends = dependsMatch[1]!;
    }

    const bundleMatch = line.match(/^\*\*Bundle with:\*\*\s+(.+)/);
    if (bundleMatch) {
      bundle = bundleMatch[1]!;
    }

    const domainMatch = line.match(/^\*\*Domain:\*\*\s+(.+)/);
    if (domainMatch) {
      domain = domainMatch[1]!.trim();
    }

    const repoMatch = line.match(/^\*\*Repo:\*\*\s+(.+)/);
    if (repoMatch) {
      repoAlias = repoMatch[1]!.trim();
    }

    const bootstrapMatch = line.match(/^\*\*Bootstrap:\*\*\s+(.+)/i);
    if (bootstrapMatch) {
      bootstrap = bootstrapMatch[1]!.trim().toLowerCase() === "true";
    }
  }

  if (!priority) return null;

  // Validate priority is a known value
  const validPriorities: Set<string> = new Set(Object.keys(PRIORITY_NUM));
  if (!validPriorities.has(priority)) return null;

  // Parse dependencies
  const dependencies: string[] = [];
  if (depends && depends.toLowerCase() !== "none") {
    const depMatches = depends.match(ID_PATTERN_GLOBAL);
    if (depMatches) {
      dependencies.push(...depMatches);
    }
  }

  // Parse bundle-with
  const bundleWith: string[] = [];
  if (bundle) {
    const bundleMatches = bundle.match(ID_PATTERN_GLOBAL);
    if (bundleMatches) {
      bundleWith.push(...bundleMatches);
    }
  }

  const rawText = content;

  const item: TodoItem = {
    id,
    priority: priority as Priority,
    title,
    domain: domain || "uncategorized",
    dependencies,
    bundleWith,
    status: "open",
    filePath,
    repoAlias,
    rawText,
    filePaths: [],
    testPlan: extractTestPlan(rawText),
    bootstrap,
  };

  item.filePaths = extractFilePaths(item);

  return item;
}

/**
 * List all todo files in a directory, parse them, and return TodoItem[].
 * Expands wildcard dependencies in a second pass.
 * Sets status to "in-progress" if a worktree `todo-{id}` exists.
 */
export function listTodos(todosDir: string, worktreeDir: string): TodoItem[] {
  if (!existsSync(todosDir)) return [];

  // Derive in-progress IDs from worktree directories
  const inProgressIds = new Set<string>();
  if (existsSync(worktreeDir)) {
    try {
      for (const entry of readdirSync(worktreeDir)) {
        if (entry.startsWith("todo-")) {
          inProgressIds.add(entry.slice(5));
        }
      }
    } catch {
      // worktreeDir might not be a directory
    }
  }

  // Check cross-repo index for in-progress items in other repos
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  if (existsSync(crossRepoIndex)) {
    const indexContent = readFileSync(crossRepoIndex, "utf-8");
    for (const line of indexContent.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      const idxId = parts[0];
      const idxPath = parts[2];
      if (idxId && idxPath && existsSync(idxPath)) {
        inProgressIds.add(idxId);
      }
    }
  }

  const entries = readdirSync(todosDir).filter((f) => f.endsWith(".md"));
  const items: TodoItem[] = [];

  for (const entry of entries) {
    const fp = join(todosDir, entry);
    const item = parseTodoFile(fp);
    if (!item) continue;

    if (inProgressIds.has(item.id)) {
      item.status = "in-progress";
    }

    items.push(item);
  }

  // Second pass: expand wildcard dependencies
  const allIds = items.map((item) => item.id);
  for (const item of items) {
    const dependsLine = item.rawText
      .split("\n")
      .find((l) => l.match(/^\*\*Depends on:\*\*\s+/));
    if (!dependsLine) continue;

    const rawDeps = dependsLine.replace(/^\*\*Depends on:\*\*\s+/, "");
    const wildcardExpanded = expandWildcardDeps(rawDeps, allIds, item.id);

    const existing = new Set(item.dependencies);
    for (const dep of wildcardExpanded) {
      if (!existing.has(dep)) {
        item.dependencies.push(dep);
        existing.add(dep);
      }
    }
  }

  return items;
}

/**
 * Read a single todo by ID.
 * Globs for `*--{id}.md` in the todos directory.
 */
export function readTodo(
  todosDir: string,
  id: string,
): TodoItem | undefined {
  if (!existsSync(todosDir)) return undefined;

  const entries = readdirSync(todosDir);
  const suffix = `--${id}.md`;
  const match = entries.find((f) => f.endsWith(suffix));

  if (!match) return undefined;

  return parseTodoFile(join(todosDir, match)) ?? undefined;
}

/**
 * Write a TodoItem to its canonical file in the todos directory.
 * Generates the markdown content and sets item.filePath.
 */
export function writeTodoFile(todosDir: string, item: TodoItem): void {
  const filename = todoFilename(item);
  const fp = join(todosDir, filename);

  const lines: string[] = [];

  // Header
  lines.push(`# ${item.title} (${item.id})`);
  lines.push("");

  // Metadata
  // Capitalize first letter of priority
  const priorityDisplay =
    item.priority.charAt(0).toUpperCase() + item.priority.slice(1);
  lines.push(`**Priority:** ${priorityDisplay}`);
  lines.push(`**Source:** ${item.repoAlias || "local"}`);

  // Dependencies
  if (item.dependencies.length > 0) {
    lines.push(`**Depends on:** ${item.dependencies.join(", ")}`);
  } else {
    lines.push(`**Depends on:** None`);
  }

  // Domain
  lines.push(`**Domain:** ${item.domain}`);

  // Bundle
  if (item.bundleWith.length > 0) {
    lines.push(`**Bundle with:** ${item.bundleWith.join(", ")}`);
  }

  // Repo
  if (item.repoAlias) {
    lines.push(`**Repo:** ${item.repoAlias}`);
  }

  // Bootstrap
  if (item.bootstrap) {
    lines.push(`**Bootstrap:** true`);
  }

  lines.push("");

  // Description (rawText body minus any metadata we already wrote)
  const bodyLines = extractBody(item.rawText);

  if (bodyLines.length > 0) {
    lines.push(...bodyLines);
  }

  // Key files
  if (item.filePaths.length > 0) {
    // Only add if not already in bodyLines
    const hasKeyFiles = bodyLines.some((l) => l.startsWith("Key files:"));
    if (!hasKeyFiles) {
      lines.push("");
      lines.push(
        `Key files: ${item.filePaths.map((p) => "`" + p + "`").join(", ")}`,
      );
    }
  }

  const content = lines.join("\n") + "\n";
  writeFileSync(fp, content);
  item.filePath = fp;
}

/**
 * Delete a todo file by ID.
 * Globs for `*--{id}.md` in the todos directory.
 * Returns true if a file was deleted, false otherwise.
 */
export function deleteTodoFile(todosDir: string, id: string): boolean {
  if (!existsSync(todosDir)) return false;

  const entries = readdirSync(todosDir);
  const suffix = `--${id}.md`;
  const matches = entries.filter((f) => f.endsWith(suffix));

  if (matches.length === 0) return false;

  for (const match of matches) {
    unlinkSync(join(todosDir, match));
  }

  return true;
}
