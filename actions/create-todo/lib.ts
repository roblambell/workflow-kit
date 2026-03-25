// Pure functions for CI failure TODO generation.
// No external dependencies — testable with bun test.

export interface GenerateTodoOpts {
  id: string;
  workflowName: string;
  runId: number;
  runUrl: string;
  errorLogs: string;
  priority: string;
  repo: string;
}

const PRIORITY_NUM: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_PREFIX: Record<string, string> = {
  critical: "C",
  high: "H",
  medium: "M",
  low: "L",
};

/**
 * Scan existing filenames and return the next CI todo ID number.
 * Matches any priority prefix (H-CI-1, M-CI-2, etc.) to keep numbers globally unique.
 */
export function getNextCiId(existingFiles: string[]): number {
  let max = 0;
  for (const file of existingFiles) {
    const match = file.match(/[A-Z]-CI-(\d+)/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

/**
 * Generate a TODO ID from priority and sequence number.
 * E.g., ("high", 3) => "H-CI-3"
 */
export function generateTodoId(priority: string, num: number): string {
  const prefix = PRIORITY_PREFIX[priority.toLowerCase()] ?? "H";
  return `${prefix}-CI-${num}`;
}

/**
 * Generate the canonical filename for a CI todo.
 * E.g., ("H-CI-1", "high", "ci") => "1-ci--H-CI-1.md"
 */
export function generateTodoFilename(
  id: string,
  priority: string,
  domain: string,
): string {
  const num = PRIORITY_NUM[priority.toLowerCase()] ?? 1;
  return `${num}-${domain}--${id}.md`;
}

/** Max length for error logs embedded in the todo file. */
const MAX_LOG_LENGTH = 2000;

/**
 * Generate the markdown content for a CI failure todo file.
 * Follows the standard ninthwave todo format so it's parseable by `ninthwave list`.
 */
export function generateTodoContent(opts: GenerateTodoOpts): string {
  const priorityDisplay =
    opts.priority.charAt(0).toUpperCase() + opts.priority.slice(1);

  const truncatedLogs =
    opts.errorLogs.length > MAX_LOG_LENGTH
      ? opts.errorLogs.slice(0, MAX_LOG_LENGTH) + "\n... (truncated)"
      : opts.errorLogs;

  const lines: string[] = [
    `# Fix: CI failure in ${opts.workflowName} (${opts.id})`,
    "",
    `**Priority:** ${priorityDisplay}`,
    `**Source:** GitHub Action (create-todo)`,
    `**Depends on:** -`,
    `**Domain:** ci`,
    "",
    `CI workflow "${opts.workflowName}" failed in ${opts.repo}.`,
    "",
    `- **Run ID:** ${opts.runId}`,
    `- **Run URL:** ${opts.runUrl}`,
    "",
    `Acceptance: The CI failure is investigated and resolved. The failing workflow passes.`,
  ];

  if (truncatedLogs) {
    lines.push(
      "",
      `## Error Logs`,
      "",
      "```",
      truncatedLogs,
      "```",
    );
  }

  return lines.join("\n") + "\n";
}
