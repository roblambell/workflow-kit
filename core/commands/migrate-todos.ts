// `ninthwave migrate-todos` — one-shot migration from TODOS.md to file-per-todo.
// `ninthwave generate-todos` — regenerate TODOS.md from individual todo files.
//
// The migrate command has its own inline TODOS.md parser because the main parser
// (core/parser.ts) has already been rewritten to read directories.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join } from "path";
import type { TodoItem, Priority } from "../types.ts";
import {
  ID_IN_PARENS,
  ID_PATTERN_GLOBAL,
  PRIORITY_NUM,
} from "../types.ts";
import {
  normalizeDomain,
  extractTestPlan,
  extractFilePaths,
  extractBody,
} from "../todo-utils.ts";
import { loadDomainMappings } from "../config.ts";
import { writeTodoFile, listTodos } from "../todo-files.ts";
import { info, warn, die, GREEN, RESET, BOLD } from "../output.ts";

// ---------------------------------------------------------------------------
// Inline TODOS.md parser (legacy format)
// ---------------------------------------------------------------------------

/**
 * Parse a legacy TODOS.md file into TodoItem objects.
 * This is a self-contained parser that does not depend on the directory-based
 * parser in core/parser.ts.
 */
function parseLegacyTodos(
  todosFile: string,
  domainMappings: Map<string, string>,
): TodoItem[] {
  const raw = readFileSync(todosFile, "utf-8");
  // Strip UTF-8 BOM if present
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = content.split("\n");

  const items: TodoItem[] = [];
  const seenIds = new Set<string>();
  let currentDomain = "";

  // Current item state
  let id = "";
  let priority: Priority | "" = "";
  let title = "";
  let depends = "";
  let bundle = "";
  let repoAlias = "";
  let inItem = false;
  let rawLines: string[] = [];

  function emitItem() {
    if (!id || !inItem) return;

    if (seenIds.has(id)) {
      warn(`Skipping duplicate ID "${id}": "${title}"`);
      return;
    }
    seenIds.add(id);

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

    const rawText = rawLines.join("\n");

    const item: TodoItem = {
      id,
      priority: (priority || "medium") as Priority,
      title,
      domain: currentDomain || "uncategorized",
      dependencies,
      bundleWith,
      status: "open",
      filePath: "",
      repoAlias,
      rawText,
      filePaths: [],
      testPlan: extractTestPlan(rawText),
    };

    item.filePaths = extractFilePaths(item);
    items.push(item);
  }

  for (const line of lines) {
    // Section headers (## level) — but not ### or deeper
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      emitItem();
      id = "";
      priority = "";
      title = "";
      depends = "";
      bundle = "";
      repoAlias = "";
      inItem = false;
      rawLines = [];

      const sectionName = line.slice(3);

      if (line.includes("In Progress")) {
        currentDomain = "in-progress-section";
      } else {
        currentDomain = normalizeDomain(sectionName, domainMappings);
      }
      continue;
    }

    // Item headers (### level)
    if (line.startsWith("### ")) {
      emitItem();

      const idMatch = line.match(ID_IN_PARENS);
      id = idMatch ? idMatch[1]! : "";

      // Extract title: strip "### ", strip ID parens and suffixes
      title = line.slice(4);
      title = title
        .replace(/ \([A-Z]+-[A-Za-z0-9]+-[0-9]+\)/, "")
        .replace(/ \(bundled\)/, "")
        .replace(/ \([0-9]*A\)/, "");

      priority = "";
      depends = "";
      bundle = "";
      repoAlias = "";
      inItem = true;
      rawLines = [line];
      continue;
    }

    // Parse metadata lines within an item
    if (inItem) {
      rawLines.push(line);

      const priorityMatch = line.match(/^\*\*Priority:\*\*\s+(.+)/);
      if (priorityMatch) {
        let p = priorityMatch[1]!.toLowerCase();
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

      const repoMatch = line.match(/^\*\*Repo:\*\*\s+(.+)/);
      if (repoMatch) {
        repoAlias = repoMatch[1]!.trim();
      }
    }
  }

  // Emit last item
  emitItem();

  return items;
}

// ---------------------------------------------------------------------------
// Friction log parser
// ---------------------------------------------------------------------------

interface FrictionEntry {
  todo: string;
  date: string;
  severity: string;
  description: string;
}

/**
 * Parse the legacy .ninthwave/friction.log file into individual entries.
 * Each entry is delimited by `---` and has YAML-ish key: value lines.
 */
function parseFrictionLog(logPath: string): FrictionEntry[] {
  const content = readFileSync(logPath, "utf-8");
  const entries: FrictionEntry[] = [];

  // Split on `---` separators
  const blocks = content.split(/^---$/m);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    let todo = "";
    let date = "";
    let severity = "";
    let description = "";

    for (const line of trimmed.split("\n")) {
      const todoMatch = line.match(/^todo:\s*(.+)/);
      if (todoMatch) {
        todo = todoMatch[1]!.trim();
        continue;
      }

      const dateMatch = line.match(/^date:\s*(.+)/);
      if (dateMatch) {
        date = dateMatch[1]!.trim();
        continue;
      }

      const sevMatch = line.match(/^severity:\s*(.+)/);
      if (sevMatch) {
        severity = sevMatch[1]!.trim();
        continue;
      }

      const descMatch = line.match(/^description:\s*(.+)/);
      if (descMatch) {
        description = descMatch[1]!.trim();
        continue;
      }
    }

    if (todo && date) {
      entries.push({ todo, date, severity, description });
    }
  }

  return entries;
}

/**
 * Convert a friction entry to a markdown file.
 * Filename: {timestamp}--{todo_id}.md (colons in timestamp → hyphens)
 */
function writeFrictionFile(frictionDir: string, entry: FrictionEntry): string {
  // Convert colons to hyphens for filesystem safety
  const safeTimestamp = entry.date.replace(/:/g, "-");
  const filename = `${safeTimestamp}--${entry.todo}.md`;
  const fp = join(frictionDir, filename);

  const content = `# Friction: ${entry.todo}

**Date:** ${entry.date}
**Severity:** ${entry.severity}
**TODO:** ${entry.todo}

${entry.description}
`;

  writeFileSync(fp, content);
  return filename;
}

// ---------------------------------------------------------------------------
// migrate-todos command
// ---------------------------------------------------------------------------

/**
 * Migrate TODOS.md and friction.log to file-per-todo and file-per-friction format.
 */
export function cmdMigrateTodos(projectRoot: string): void {
  const todosFile = join(projectRoot, "TODOS.md");
  const todosDir = join(projectRoot, ".ninthwave", "todos");
  const frictionLog = join(projectRoot, ".ninthwave", "friction.log");
  const frictionDir = join(projectRoot, ".ninthwave", "friction");
  const worktreeDir = join(projectRoot, ".worktrees");

  // --- Validate TODOS.md exists ---
  if (!existsSync(todosFile)) {
    die(`TODOS.md not found at ${todosFile}`);
  }

  // --- Ensure output directories ---
  mkdirSync(todosDir, { recursive: true });
  mkdirSync(frictionDir, { recursive: true });

  // --- Parse legacy TODOS.md ---
  info("Parsing TODOS.md...");
  const domainMappings = loadDomainMappings(projectRoot);
  const items = parseLegacyTodos(todosFile, domainMappings);

  if (items.length === 0) {
    warn("No items found in TODOS.md");
  }

  // --- Write individual todo files ---
  info(`Writing ${items.length} items to ${todosDir}/`);
  for (const item of items) {
    writeTodoFile(todosDir, item);
  }

  // --- Migrate friction log ---
  let frictionCount = 0;
  if (existsSync(frictionLog)) {
    info("Migrating friction.log...");
    const entries = parseFrictionLog(frictionLog);

    for (const entry of entries) {
      // Skip severity: none entries
      if (entry.severity === "none") continue;

      writeFrictionFile(frictionDir, entry);
      frictionCount++;
    }
  }

  // --- Delete originals ---
  info("Removing TODOS.md...");
  unlinkSync(todosFile);

  if (existsSync(frictionLog)) {
    info("Removing friction.log...");
    unlinkSync(frictionLog);
  }

  // --- Validate by re-reading ---
  info("Validating migration...");
  const reread = listTodos(todosDir, worktreeDir);
  const originalIds = new Set(items.map((i) => i.id));
  const rereadIds = new Set(reread.map((i) => i.id));

  if (reread.length !== items.length) {
    warn(
      `Item count mismatch: wrote ${items.length}, re-read ${reread.length}`,
    );
    // Show which IDs are missing
    for (const id of originalIds) {
      if (!rereadIds.has(id)) {
        warn(`  Missing after migration: ${id}`);
      }
    }
  } else {
    // Verify all IDs match
    let allMatch = true;
    for (const id of originalIds) {
      if (!rereadIds.has(id)) {
        warn(`  Missing after migration: ${id}`);
        allMatch = false;
      }
    }
    if (allMatch) {
      info("Validation passed: all item IDs match.");
    }
  }

  // Count friction files (excluding .gitkeep)
  const frictionFiles = existsSync(frictionDir)
    ? readdirSync(frictionDir).filter((f) => f.endsWith(".md"))
    : [];

  console.log();
  console.log(
    `${GREEN}${BOLD}Migration complete.${RESET}`,
  );
  console.log(
    `  Migrated ${items.length} items to .ninthwave/todos/`,
  );
  console.log(
    `  Migrated ${frictionCount} friction entries to .ninthwave/friction/`,
  );
  if (frictionFiles.length !== frictionCount) {
    warn(
      `  Friction file count mismatch: wrote ${frictionCount}, found ${frictionFiles.length} files`,
    );
  }
}

// ---------------------------------------------------------------------------
// generate-todos command
// ---------------------------------------------------------------------------

/**
 * Generate a TODOS.md file from individual todo files in .ninthwave/todos/.
 * Groups items by domain, sorted alphabetically. Within each group, sorts
 * by priority (critical first) then by ID.
 */
export function cmdGenerateTodos(todosDir: string, outputPath: string): void {
  const worktreeDir = join(todosDir, "..", "..", ".worktrees");
  const items = listTodos(todosDir, worktreeDir);

  if (items.length === 0) {
    warn("No items found in todos directory");
    return;
  }

  // Group by domain
  const byDomain = new Map<string, TodoItem[]>();
  for (const item of items) {
    const domain = item.domain || "uncategorized";
    if (!byDomain.has(domain)) {
      byDomain.set(domain, []);
    }
    byDomain.get(domain)!.push(item);
  }

  // Sort domains alphabetically
  const sortedDomains = [...byDomain.keys()].sort();

  // Sort items within each domain: by priority (critical first), then by ID
  for (const domain of sortedDomains) {
    byDomain.get(domain)!.sort((a, b) => {
      const pa = PRIORITY_NUM[a.priority] ?? 2;
      const pb = PRIORITY_NUM[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.id.localeCompare(b.id);
    });
  }

  // Build output
  const lines: string[] = [];
  lines.push(
    "<!-- Auto-generated from .ninthwave/todos/. Do not edit. Run: ninthwave generate-todos -->",
  );
  lines.push("");
  lines.push("# TODOS");
  lines.push("");

  for (const domain of sortedDomains) {
    const domainItems = byDomain.get(domain)!;

    // Section header: capitalize domain for display
    const displayDomain = domain
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    lines.push(`## ${displayDomain}`);
    lines.push("");

    for (let i = 0; i < domainItems.length; i++) {
      const item = domainItems[i]!;

      // Reconstruct the ### header with type prefix inferred from title
      lines.push(`### ${item.title} (${item.id})`);
      lines.push("");

      // Metadata
      const priorityDisplay =
        item.priority.charAt(0).toUpperCase() + item.priority.slice(1);
      lines.push(`**Priority:** ${priorityDisplay}`);

      if (item.dependencies.length > 0) {
        lines.push(`**Depends on:** ${item.dependencies.join(", ")}`);
      } else {
        lines.push(`**Depends on:** None`);
      }

      if (item.bundleWith.length > 0) {
        lines.push(`**Bundle with:** ${item.bundleWith.join(", ")}`);
      }

      if (item.repoAlias) {
        lines.push(`**Repo:** ${item.repoAlias}`);
      }

      lines.push("");

      // Body: extract description from rawText (skip header and metadata lines)
      const bodyLines = extractBody(item.rawText);
      if (bodyLines.length > 0) {
        lines.push(...bodyLines);
      }

      // Key files
      if (item.filePaths.length > 0) {
        const hasKeyFiles = bodyLines.some((l) => l.startsWith("Key files:"));
        if (!hasKeyFiles) {
          lines.push("");
          lines.push(
            `Key files: ${item.filePaths.map((p) => "`" + p + "`").join(", ")}`,
          );
        }
      }

      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  writeFileSync(outputPath, lines.join("\n"));

  info(`Generated ${outputPath} with ${items.length} items across ${sortedDomains.length} domains.`);
}
