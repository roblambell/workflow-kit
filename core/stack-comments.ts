// Stack navigation comments module.
// Generates git-spice-style markdown showing the dependency stack tree
// and syncs these comments to all PRs in a stack via the GitHub API.

/** Represents a PR in a dependency stack. */
export interface StackEntry {
  prNumber: number;
  title: string; // e.g., "feat: implement parser (H-PAR-1)"
}

/** Interface for GitHub comment operations (dependency injection for testability). */
export interface GhCommentClient {
  listComments(prNumber: number): Array<{ id: number; body: string }>;
  createComment(prNumber: number, body: string): boolean;
  updateComment(commentId: number, body: string): boolean;
}

/** Hidden HTML comment marker to identify ninthwave stack comments. */
export const STACK_COMMENT_MARKER = "<!-- ninthwave-stack-comment -->";
const STACK_COMMENT_HEADING = "This change is part of the following stack:";
const STACK_COMMENT_FOOTER =
  "<sub>Change orchestrated by [Ninthwave](https://ninthwave.sh).</sub>";

/**
 * Build a git-spice-style markdown comment showing the dependency stack.
 *
 * @param baseBranch - The root branch name (e.g., "main")
 * @param stack - Ordered list of PRs from bottom (closest to base) to top
 * @param currentPrNumber - The PR number to highlight as "this PR"
 * @returns Markdown string for the stack comment
 */
export function buildStackComment(
  _baseBranch: string,
  stack: StackEntry[],
  currentPrNumber: number,
): string {
  const lines: string[] = [
    STACK_COMMENT_MARKER,
    STACK_COMMENT_HEADING,
    "",
  ];

  for (let i = 0; i < stack.length; i++) {
    const entry = stack[i];
    const indent = "    ".repeat(i);
    const marker = entry.prNumber === currentPrNumber ? " ◀" : "";
    lines.push(`${indent}- #${entry.prNumber}${marker}`);
  }

  lines.push("", STACK_COMMENT_FOOTER);
  return lines.join("\n");
}

/**
 * Post or update stack navigation comments on all PRs in a stack.
 * Creates a comment on first call; finds and updates the existing comment
 * on subsequent calls (identified by the hidden marker).
 *
 * @param baseBranch - The root branch name (e.g., "main")
 * @param stack - Ordered list of PRs from bottom (closest to base) to top
 * @param client - GitHub comment client (injected for testability)
 */
export function syncStackComments(
  baseBranch: string,
  stack: StackEntry[],
  client: GhCommentClient,
): void {
  for (const entry of stack) {
    const body = buildStackComment(baseBranch, stack, entry.prNumber);
    const comments = client.listComments(entry.prNumber);

    // Find existing stack comment by marker
    const existing = comments.find((c) =>
      c.body.includes(STACK_COMMENT_MARKER),
    );

    if (existing) {
      client.updateComment(existing.id, body);
    } else {
      client.createComment(entry.prNumber, body);
    }
  }
}
