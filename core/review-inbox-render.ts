import type {
  ReviewInboxDomain,
  ReviewInboxEntry,
} from "./review-inbox.ts";

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function renderEntry(entry: ReviewInboxEntry, index: number): string {
  const lines: string[] = [];

  lines.push(`### ${index}. ${entry.title}`);
  lines.push(`- Source: \`${entry.relativePath}\``);
  if (entry.itemId) {
    lines.push(`- Related item: \`${entry.itemId}\``);
  }
  if (entry.recordedAt) {
    lines.push(`- Recorded: \`${entry.recordedAt}\``);
  }
  lines.push(`- Summary: ${entry.summary}`);
  lines.push(`- Recommendation: ${entry.recommendation}`);
  lines.push(`- Hard question: ${entry.hardQuestion}`);
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Copy-pasteable work-item prompt</summary>");
  lines.push("");
  lines.push("```text");
  lines.push(entry.prompt);
  lines.push("```");
  lines.push("</details>");

  return lines.join("\n");
}

export function renderReviewInboxPullRequest(
  domain: ReviewInboxDomain,
  entries: ReviewInboxEntry[],
): string {
  const heading = pluralize(entries.length, "entry", "entries");
  const lines: string[] = [
    "## Summary",
    `Review of ${entries.length} ${domain} inbox ${heading}.`,
    "",
    "Manual review required. Review the recommendations and prompts below before merging.",
    "Do not enable auto-merge on this PR.",
    "",
    "## Recommendations",
    ...entries.flatMap((entry, index) => [renderEntry(entry, index + 1), ""]),
    "## Reviewed Inbox Files",
    ...entries.map((entry) => `- \`${entry.relativePath}\``),
  ];

  return lines.join("\n").trim();
}
