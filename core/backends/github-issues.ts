// GitHub Issues backend: reads issues from a GitHub repo via `gh` CLI
// and maps them to TodoItem shape. Read-only — markDone is a no-op stub.

import type { RunResult, TodoItem, Priority, TaskBackend } from "../types.ts";

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
    lineNumber: 0,
    lineEndNumber: 0,
    repoAlias: "",
    rawText: issue.body ?? "",
    filePaths: [],
    testPlan: "",
  };
}

const ISSUE_FIELDS = "number,title,body,labels,milestone,state";

export class GitHubIssuesBackend implements TaskBackend {
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

  /** Stub — write operations come in GHI-2. */
  markDone(_id: string): boolean {
    return false;
  }
}
