// TODOS.md parser for the ninthwave CLI.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { TodoItem, Priority } from "./types.ts";
import {
  ID_IN_PARENS,
  ID_PATTERN_GLOBAL,
  WILDCARD_DEP_PATTERN,
  CODE_EXTENSIONS,
  CODE_EXTENSIONS_FOR_LINE,
} from "./types.ts";
import { loadDomainMappings } from "./config.ts";

/**
 * Normalize a section header into a domain slug.
 * Checks project-specific domain mappings first, then auto-slugifies.
 */
export function normalizeDomain(
  section: string,
  domainsFile?: string,
): string {
  // Strip all parenthetical annotations before normalizing
  // e.g. "CLI Migration (TypeScript migration completion, 2026-03-23)" → "CLI Migration"
  const stripped = section.replace(/\s*\([^)]*\)/g, "").trim();
  const lower = stripped.toLowerCase();

  // Check domain mappings if provided
  if (domainsFile) {
    // Load raw from file
    if (existsSync(domainsFile)) {
      const content = readFileSync(domainsFile, "utf-8");
      for (const rawLine of content.split("\n")) {
        const eqIdx = rawLine.indexOf("=");
        if (eqIdx === -1) continue;
        const pattern = rawLine.slice(0, eqIdx).trim();
        if (!pattern || pattern.startsWith("#")) continue;
        const domainKey = rawLine.slice(eqIdx + 1).trim();
        if (lower.includes(pattern)) {
          return domainKey;
        }
      }
    }
  }

  // Default auto-slugify: lowercase, strip non-alphanum (keep spaces and hyphens),
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
 * Extract test plan from a TodoItem's rawText.
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
 * Extract file paths from a TodoItem's rawText.
 * Only scans lines starting with "Key files:" to avoid false positives
 * from paths mentioned incidentally in description or acceptance text.
 * Matches:
 * 1. Backtick-quoted paths with code extensions (e.g., `path/to/file.ex`)
 * 2. file:line patterns (e.g., file.ex:123)
 * 3. Backtick-quoted directory-like paths without extensions
 */
export function extractFilePaths(item: TodoItem): string[] {
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

/**
 * Parse TODOS.md into a structured list of TodoItem objects.
 *
 * Options:
 *   warn — called when an item is skipped (e.g. missing ID) with a
 *          descriptive message and the 1-based line number of the item header.
 */
export function parseTodos(
  todosFile: string,
  worktreeDir: string,
  opts?: { warn?: (message: string, lineNumber: number) => void },
): TodoItem[] {
  if (!existsSync(todosFile)) return [];

  const content = readFileSync(todosFile, "utf-8");
  const lines = content.split("\n");

  // Derive in-progress IDs from worktree directories
  const inProgressIds = new Set<string>();
  if (existsSync(worktreeDir)) {
    try {
      for (const entry of readdirSync(worktreeDir)) {
        if (entry.startsWith("todo-")) {
          const id = entry.slice(5); // strip "todo-"
          inProgressIds.add(id);
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

  // Derive domainsFile path from todosFile location
  const projectRoot = join(todosFile, "..", "..");
  const domainsFile = join(
    todosFile,
    "..",
    ".ninthwave",
    "domains.conf",
  );

  const items: TodoItem[] = [];
  let currentDomain = "";

  // Current item state
  let id = "";
  let priority: Priority | "" = "";
  let title = "";
  let depends = "";
  let bundle = "";
  let repoAlias = "";
  let inItem = false;
  let itemStartLine = 0;
  let rawLines: string[] = [];

  function emitItem(endLine: number) {
    if (!id) {
      if (inItem && opts?.warn) {
        opts.warn(
          `Skipping item with no ID at line ${itemStartLine}: "${title}"`,
          itemStartLine,
        );
      }
      return;
    }

    const status = inProgressIds.has(id) ? "in-progress" : "open";

    // Parse dependencies: extract IDs from the depends string
    const dependencies: string[] = [];
    if (depends && depends.toLowerCase() !== "none") {
      const depMatches = depends.match(ID_PATTERN_GLOBAL);
      if (depMatches) {
        dependencies.push(...depMatches);
      }
    }

    // Parse bundle-with: extract IDs
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
      domain: currentDomain,
      dependencies,
      bundleWith,
      status,
      lineNumber: itemStartLine,
      lineEndNumber: endLine,
      repoAlias,
      rawText,
      filePaths: [],
      testPlan: extractTestPlan(rawText),
    };

    // Extract file paths from the raw text
    item.filePaths = extractFilePaths(item);
    items.push(item);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1; // 1-based

    // Section headers (## level) — but not ### or deeper
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      // Emit previous item if any
      emitItem(lineNum - 1);
      id = "";
      priority = "";
      title = "";
      depends = "";
      bundle = "";
      repoAlias = "";
      inItem = false;
      rawLines = [];

      const sectionName = line.slice(3); // strip "## "
      // Parenthetical stripping is handled inside normalizeDomain

      if (line.includes("In Progress")) {
        currentDomain = "in-progress-section";
      } else {
        currentDomain = normalizeDomain(sectionName, domainsFile);
      }
      continue;
    }

    // Item headers (### level)
    if (line.startsWith("### ")) {
      // Emit previous item if any
      emitItem(lineNum - 1);

      // Extract ID
      const idMatch = line.match(ID_IN_PARENS);
      id = idMatch ? idMatch[1]! : "";

      // Extract title: strip "### ", strip ID parens and suffixes
      title = line.slice(4);
      title = title
        .replace(/ \([A-Z]*-[A-Za-z0-9]*-[0-9]*.*/, "")
        .replace(/ \(bundled\)/, "")
        .replace(/ \([0-9]*A\)/, "");

      priority = "";
      depends = "";
      bundle = "";
      repoAlias = "";
      inItem = true;
      itemStartLine = lineNum;
      rawLines = [line];
      continue;
    }

    // Parse metadata lines within an item
    if (inItem) {
      rawLines.push(line);

      const priorityMatch = line.match(/^\*\*Priority:\*\*\s+(.+)/);
      if (priorityMatch) {
        let p = priorityMatch[1]!.toLowerCase();
        // Strip parenthetical suffixes like " (escalated)"
        p = p.replace(/ \(.*/, "");
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
  emitItem(lines.length);

  // Second pass: expand wildcard dependencies now that all IDs are known
  const allIds = items.map((item) => item.id);
  for (const item of items) {
    // Re-read the raw depends text from the item's rawText
    const dependsLine = item.rawText
      .split("\n")
      .find((l) => l.match(/^\*\*Depends on:\*\*\s+/));
    if (!dependsLine) continue;

    const rawDeps = dependsLine.replace(/^\*\*Depends on:\*\*\s+/, "");
    const wildcardExpanded = expandWildcardDeps(rawDeps, allIds, item.id);

    // Merge expanded IDs with existing literal deps, deduplicating
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
