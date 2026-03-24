// GitHub Issues backend: reads issues from a GitHub repo via `gh` CLI
// and maps them to TodoItem shape. Supports closing issues and syncing status labels.

import type { RunResult, TodoItem, Priority, TaskBackend, StatusSync } from "../types.ts";

/** Function signature for running gh commands in a repo context. */
export type GhRunner = (repoRoot: string, args: string[]) => RunResult;

/** Raw shape returned by `gh issue list --json ...` */
export interface GhIssueJson {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  milestone: { title: string } | null;
  state: string;
}

/** Map a `priority:<level>` label to a Priority. Falls back to "medium". */
export function parsePriorityLabel(
  labels: Array<{ name: string }>,
): Priority {
  for (const label of labels) {
    const match = label.name.match(/^priority:(critical|high|medium|low)$/);
    if (match) return match[1] as Priority;
  }
  return "medium";
}

/** Convert a raw GitHub issue JSON object to a TodoItem. */
export function issueToTodoItem(issue: GhIssueJson): TodoItem {
  return {
    id: `GHI-${issue.number}`,
    priority: parsePriorityLabel(issue.labels ?? []),
    title: issue.title ?? "",
    domain: issue.milestone?.title ?? "uncategorized",
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: issue.body ?? "",
    filePaths: [],
    testPlan: "",
  };
}

const ISSUE_FIELDS = "number,title,body,labels,milestone,state";

/** Known status labels managed by the orchestrator. */
export const STATUS_LABELS = ["status:in-progress", "status:pr-open"] as const;

export class GitHubIssuesBackend implements TaskBackend, StatusSync {
  constructor(
    private repoRoot: string,
    private label: string = "ninthwave",
    private runner: GhRunner = () => ({ stdout: "", stderr: "", exitCode: 1 }),
  ) {}

  /** List open issues matching the configured label. */
  list(): TodoItem[] {
    const args = [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      this.label,
      "--json",
      ISSUE_FIELDS,
      "--limit",
      "100",
    ];
    const result = this.runner(this.repoRoot, args);
    if (result.exitCode !== 0 || !result.stdout) return [];
    try {
      const issues = JSON.parse(result.stdout) as GhIssueJson[];
      return issues.map(issueToTodoItem);
    } catch {
      return [];
    }
  }

  /** Read a single issue by number (ID format: "GHI-<number>" or plain number string). */
  read(id: string): TodoItem | undefined {
    const num = id.replace(/^GHI-/, "");
    const args = [
      "issue",
      "view",
      num,
      "--json",
      ISSUE_FIELDS,
    ];
    const result = this.runner(this.repoRoot, args);
    if (result.exitCode !== 0 || !result.stdout) return undefined;
    try {
      const issue = JSON.parse(result.stdout) as GhIssueJson;
      return issueToTodoItem(issue);
    } catch {
      return undefined;
    }
  }

  /** Close the issue via `gh issue close`. Idempotent — already-closed issues return true. */
  markDone(id: string): boolean {
    const num = id.replace(/^GHI-/, "");
    const result = this.runner(this.repoRoot, ["issue", "close", num]);
    // gh issue close returns 0 for both open→closed and already-closed issues
    return result.exitCode === 0;
  }

  /** Add a status label to an issue. Returns true on success. */
  addStatusLabel(id: string, label: string): boolean {
    const num = id.replace(/^GHI-/, "");
    const result = this.runner(this.repoRoot, [
      "issue", "edit", num, "--add-label", label,
    ]);
    return result.exitCode === 0;
  }

  /**
   * Remove a status label from an issue.
   * Idempotent — returns true even if the label doesn't exist on the issue or repo.
   */
  removeStatusLabel(id: string, label: string): boolean {
    const num = id.replace(/^GHI-/, "");
    this.runner(this.repoRoot, [
      "issue", "edit", num, "--remove-label", label,
    ]);
    // Always return true — missing label is not an error condition
    return true;
  }

  /** Remove all known status labels from an issue. */
  removeAllStatusLabels(id: string): void {
    for (const label of STATUS_LABELS) {
      this.removeStatusLabel(id, label);
    }
  }
}
