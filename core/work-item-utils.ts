// Shared utility functions for todo parsing.
// Extracted to break the bidirectional dependency between parser.ts and todo-files.ts.

import type { WorkItem } from "./types.ts";
import { WILDCARD_DEP_PATTERN, CODE_EXTENSIONS, ID_PATTERN_SOURCE } from "./types.ts";

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
 * Normalize a section header into a domain slug.
 * Checks project-specific domain mappings first, then auto-slugifies.
 */
export function normalizeDomain(
  section: string,
  domainMappings?: Map<string, string>,
): string {
  // Strip all parenthetical annotations before normalizing
  // e.g. "CLI Migration (TypeScript migration completion, 2026-03-23)" → "CLI Migration"
  const stripped = section.replace(/\s*\([^)]*\)/g, "").trim();
  const lower = stripped.toLowerCase();

  // Check domain mappings if provided
  if (domainMappings) {
    for (const [pattern, domainKey] of domainMappings) {
      if (lower.includes(pattern)) {
        return domainKey;
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
 * Check if a PR title matches a TODO title.
 *
 * Returns true only if the normalized titles are an exact match.
 * Substring matches are intentionally rejected — a PR titled "old work"
 * should not match a TODO titled "old work extended".
 */
export function prTitleMatchesWorkItem(prTitle: string, todoTitle: string): boolean {
  if (!prTitle || !todoTitle) return false;
  const normPr = normalizeTitleForComparison(prTitle);
  const normTodo = normalizeTitleForComparison(todoTitle);
  if (!normPr || !normTodo) return false;
  return normPr === normTodo;
}
