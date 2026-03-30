// File-per-todo operations: read, write, list, delete individual todo files.
// Also includes shared utility functions for todo parsing (splitIds, normalizeDomain, etc.).

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import type { WorkItem, Priority } from "./types.ts";
import {
  PRIORITY_NUM,
  ID_IN_PARENS,
  ID_PATTERN_GLOBAL,
  ID_PATTERN_SOURCE,
  WILDCARD_DEP_PATTERN,
  CODE_EXTENSIONS,
} from "./types.ts";

/** Type guard: checks whether a string is a valid Priority. */
export function isPriority(s: string): s is Priority {
  return s in PRIORITY_NUM;
}

// ---------------------------------------------------------------------------
// Shared utility functions (formerly in work-item-utils.ts)
// ---------------------------------------------------------------------------

/**
 * Normalize an array of ID arguments by splitting on commas, trimming whitespace,
 * and filtering empty strings. This allows CLI commands to accept both
 * comma-separated (A,B,C) and space-separated (A B C) ID arguments, as well
 * as mixed formats (A,B C).
 */
export function splitIds(args: string[]): string[] {
  return args
    .flatMap((arg) => arg.split(","))
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Normalize a section header into a domain slug via auto-slugification.
 */
export function normalizeDomain(section: string): string {
  // Strip all parenthetical annotations before normalizing
  // e.g. "CLI Migration (TypeScript migration completion, 2026-03-23)" → "CLI Migration"
  const stripped = section.replace(/\s*\([^)]*\)/g, "").trim();
  const lower = stripped.toLowerCase();

  // Auto-slugify: lowercase, strip non-alphanum (keep spaces and hyphens),
  // collapse spaces, spaces to hyphens, strip leading/trailing hyphens
  const slug = lower
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ +/g, " ")
    .replace(/ /g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  // Cap at 40 characters, truncating at the last complete hyphen-separated word
  return truncateSlug(slug, 40);
}

/**
 * Truncate a slug to maxLen characters at hyphen boundaries (no mid-word cuts).
 * If the slug is already within the limit, return it unchanged.
 */
export function truncateSlug(slug: string, maxLen: number): string {
  if (slug.length <= maxLen) return slug;

  // Find the last hyphen at or before maxLen
  const truncated = slug.slice(0, maxLen);
  const lastHyphen = truncated.lastIndexOf("-");

  // If no hyphen found, return the full truncated string (single long word)
  if (lastHyphen === -1) return truncated;

  return truncated.slice(0, lastHyphen);
}

/**
 * Extract test plan from a WorkItem's rawText.
 * The test plan starts with **Test plan:** and includes subsequent bullet lines.
 */
export function extractTestPlan(rawText: string): string {
  const lines = rawText.split("\n");
  let collecting = false;
  const planLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("**Test plan:**")) {
      collecting = true;
      // Check if there's inline content after the header
      const inline = line.replace("**Test plan:**", "").trim();
      if (inline) planLines.push(inline);
      continue;
    }

    if (collecting) {
      // Stop collecting at next metadata field, "Acceptance:", "Key files:", or section boundary
      if (
        line.startsWith("**") ||
        line.startsWith("Acceptance:") ||
        line.startsWith("Key files:") ||
        line.startsWith("### ") ||
        line.startsWith("## ")
      ) {
        break;
      }
      // Include bullet lines and non-empty continuation lines
      const trimmed = line.trim();
      if (trimmed) {
        planLines.push(trimmed);
      }
    }
  }

  return planLines.join("\n");
}

/**
 * Extract file paths from a WorkItem's rawText.
 * Only scans lines starting with "Key files:" to avoid false positives
 * from paths mentioned incidentally in description or acceptance text.
 * Matches:
 * 1. Backtick-quoted paths with code extensions (e.g., `path/to/file.ex`)
 * 2. file:line patterns (e.g., file.ex:123)
 * 3. Backtick-quoted directory-like paths without extensions
 */
export function extractFilePaths(item: WorkItem): string[] {
  const paths = new Set<string>();
  const text = item.rawText;

  for (const line of text.split("\n")) {
    // Only extract paths from Key files: lines
    if (!line.startsWith("Key files:")) continue;

    // 1. Backtick-quoted paths with known extensions
    const backtickExtRegex = /`([a-zA-Z_.][a-zA-Z0-9_/.-]*\.(ex|exs|ts|tsx|js|jsx|md|yml|yaml|json|conf|sh|py|go|rs|rb|java|kt|swift))`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickExtRegex.exec(line)) !== null) {
      paths.add(match[1]!);
    }

    // 2. file:line patterns (e.g., file.ex:123, file.ex:123-456)
    const fileLineRegex = /([a-zA-Z_.][a-zA-Z0-9_/.-]*\.(ex|exs|ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift)):([0-9]+)/g;
    while ((match = fileLineRegex.exec(line)) !== null) {
      paths.add(match[1]!);
    }

    // 3. Backtick-quoted directory/file paths without extensions
    const dirPathRegex = /`([a-zA-Z_.][a-zA-Z0-9_]*(\/[a-zA-Z0-9_.+-]+)+)`/g;
    while ((match = dirPathRegex.exec(line)) !== null) {
      // Only add if not already captured by the extension regex
      const p = match[1]!;
      if (!CODE_EXTENSIONS.test(p)) {
        paths.add(p);
      }
    }
  }

  return [...paths].sort();
}

/**
 * Expand wildcard dependency patterns against a list of item IDs.
 * Supports patterns like:
 *   - "MUX-*"   → matches all items containing "-MUX-" (any priority, any number)
 *   - "H-MUX-*" → matches all items starting with "H-MUX-"
 *   - "DF-*"    → matches all items containing "-DF-"
 *
 * Priority-prefixed patterns (single letter + hyphen + domain + hyphen + *)
 * match items starting with that exact prefix. Domain-only patterns match
 * any item containing "-{domain}-" regardless of priority.
 */
export function expandWildcardDeps(
  rawDepText: string,
  allIds: string[],
  selfId: string,
): string[] {
  const wildcards = rawDepText.match(WILDCARD_DEP_PATTERN);
  if (!wildcards) return [];

  const expanded = new Set<string>();

  for (const pattern of wildcards) {
    const prefix = pattern.slice(0, -1); // strip trailing "*"

    // Priority-prefixed if it looks like "X-DOMAIN-" (single letter, hyphen, domain, hyphen)
    const priorityPrefixMatch = prefix.match(/^([A-Z])-([A-Za-z0-9]+)-$/);

    for (const id of allIds) {
      if (id === selfId) continue;

      if (priorityPrefixMatch) {
        // Exact prefix match: "H-MUX-" matches "H-MUX-1", "H-MUX-2"
        if (id.startsWith(prefix)) {
          expanded.add(id);
        }
      } else {
        // Domain match: strip trailing "-" from prefix, match "-{domain}-" in ID
        const domain = prefix.replace(/-$/, "");
        if (id.includes(`-${domain}-`)) {
          expanded.add(id);
        }
      }
    }
  }

  return [...expanded];
}

/** Metadata line prefixes used in todo file format. */
const METADATA_PREFIXES = [
  "**Priority:**",
  "**Source:**",
  "**Depends on:**",
  "**Domain:**",
  "**Bundle with:**",
  "**Repo:**",
  "**Bootstrap:**",
];

/**
 * Extract the body text from a todo file's rawText, stripping the # header
 * and metadata lines (Priority, Source, Depends on, Domain, Bundle with, Repo).
 * Trims trailing empty lines.
 */
export function extractBody(rawText: string): string[] {
  const rawLines = rawText.split("\n");
  const bodyLines: string[] = [];
  let pastHeader = false;
  let pastMeta = false;

  for (const line of rawLines) {
    if (!pastHeader) {
      if (line.startsWith("# ")) {
        pastHeader = true;
        continue;
      }
      continue;
    }

    if (!pastMeta) {
      if (
        METADATA_PREFIXES.some((prefix) => line.startsWith(prefix)) ||
        line.trim() === ""
      ) {
        continue;
      }
      pastMeta = true;
    }

    bodyLines.push(line);
  }

  // Trim trailing empty lines
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === "") {
    bodyLines.pop();
  }

  return bodyLines;
}

/**
 * Normalize a title for comparison by lowercasing, stripping TODO ID
 * references (e.g., "(H-MUX-1)", "TODO H-MUX-1"), conventional commit
 * prefixes (e.g., "fix:", "feat:"), and collapsing whitespace.
 *
 * Used to detect TODO ID collisions: when a new TODO reuses an old merged
 * PR's branch name, we compare the PR title against the TODO title.
 * Titles must be an exact match after normalization.
 */
export function normalizeTitleForComparison(title: string): string {
  return title
    .toLowerCase()
    // Strip TODO ID references: "(H-MUX-1)", "TODO H-MUX-1", "(TODO H-MUX-1)"
    .replace(new RegExp(`\\(?TODO\\s+${ID_PATTERN_SOURCE}\\)?`, "gi"), "")
    .replace(new RegExp(`\\(${ID_PATTERN_SOURCE}\\)`, "gi"), "")
    // Strip conventional commit prefixes: "fix:", "feat:", "refactor:", etc.
    .replace(/^(fix|feat|refactor|test|docs|chore|perf|ci|build|style|revert)\s*(\([^)]*\))?\s*:\s*/i, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if a PR matches a work item.
 *
 * When `branchName` is provided and follows the `ninthwave/<id>` pattern,
 * the branch is used as the primary discriminator -- it's a stronger signal
 * than the title because workers always create branches with the `ninthwave/`
 * prefix. Falls back to normalized title comparison when no branch is provided,
 * which also serves as the collision-detection path for reused IDs.
 */
export function prTitleMatchesWorkItem(
  prTitle: string,
  todoTitle: string,
  branchName?: string,
): boolean {
  // Primary: branch name match (strongest signal).
  // Workers always create branches named ninthwave/<todoId>.
  if (branchName?.startsWith("ninthwave/")) {
    return true;
  }

  // Fallback: normalized title comparison (collision detection for ID reuse)
  if (!prTitle || !todoTitle) return false;
  const normPr = normalizeTitleForComparison(prTitle);
  const normTodo = normalizeTitleForComparison(todoTitle);
  if (!normPr || !normTodo) return false;
  return normPr === normTodo;
}

// ---------------------------------------------------------------------------
// File-per-todo operations
// ---------------------------------------------------------------------------

/** Map a priority to its sort-order number. */
export function priorityNum(p: Priority): number {
  return PRIORITY_NUM[p];
}

/**
 * Generate the canonical filename for a todo item.
 * Format: "{priority_num}-{domain_slug}--{ID}.md"
 * Example: "2-worker-reliability--M-WRK-8.md"
 */
export function workItemFilename(
  item: Pick<WorkItem, "id" | "priority" | "domain">,
): string {
  return `${PRIORITY_NUM[item.priority]}-${item.domain}--${item.id}.md`;
}

/**
 * Parse a single todo file into a WorkItem.
 * Returns null if the file is malformed (missing ID or priority).
 */
export function parseWorkItemFile(filePath: string): WorkItem | null {
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
      if (isPriority(p)) {
        priority = p;
      }
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

  const item: WorkItem = {
    id,
    priority,
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
 * List all todo files in a directory, parse them, and return WorkItem[].
 * Expands wildcard dependencies in a second pass.
 * Sets status to "in-progress" if a worktree `todo-{id}` exists.
 */
export function listWorkItems(workDir: string, worktreeDir: string): WorkItem[] {
  if (!existsSync(workDir)) return [];

  // Derive in-progress IDs from worktree directories
  const inProgressIds = new Set<string>();
  if (existsSync(worktreeDir)) {
    try {
      for (const entry of readdirSync(worktreeDir)) {
        if (entry.startsWith("ninthwave-")) {
          inProgressIds.add(entry.slice(10));
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

  const entries = readdirSync(workDir).filter((f) => f.endsWith(".md"));
  const items: WorkItem[] = [];

  for (const entry of entries) {
    const fp = join(workDir, entry);
    const item = parseWorkItemFile(fp);
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
export function readWorkItem(
  workDir: string,
  id: string,
): WorkItem | undefined {
  if (!existsSync(workDir)) return undefined;

  const entries = readdirSync(workDir);
  const suffix = `--${id}.md`;
  const match = entries.find((f) => f.endsWith(suffix));

  if (!match) return undefined;

  return parseWorkItemFile(join(workDir, match)) ?? undefined;
}

/**
 * Write a WorkItem to its canonical file in the todos directory.
 * Generates the markdown content and sets item.filePath.
 */
export function writeWorkItemFile(workDir: string, item: WorkItem): void {
  const filename = workItemFilename(item);
  const fp = join(workDir, filename);

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
export function deleteWorkItemFile(workDir: string, id: string): boolean {
  if (!existsSync(workDir)) return false;

  const entries = readdirSync(workDir);
  const suffix = `--${id}.md`;
  const matches = entries.filter((f) => f.endsWith(suffix));

  if (matches.length === 0) return false;

  for (const match of matches) {
    unlinkSync(join(workDir, match));
  }

  return true;
}
