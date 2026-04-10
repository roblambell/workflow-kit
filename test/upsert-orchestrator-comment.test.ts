// Tests for upsertOrchestratorComment -- living PR comment upsert pattern.
// Uses dependency injection (PrCommentClient) for testability without real GitHub API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  upsertOrchestratorComment,
  ORCHESTRATOR_COMMENT_MARKER,
  ORCHESTRATOR_LINK,
  type PrCommentClient,
} from "../core/gh.ts";

describe("upsertOrchestratorComment", () => {
  let client: PrCommentClient;

  beforeEach(() => {
    client = {
      listComments: vi.fn().mockReturnValue([]),
      createComment: vi.fn().mockReturnValue(true),
      updateComment: vi.fn().mockReturnValue(true),
    };
  });

  it("creates a new comment when none exists", () => {
    const result = upsertOrchestratorComment(
      "/repo",
      42,
      "H-FOO-1",
      "CI failure detected. Worker notified.",
      client,
    );

    expect(result).toBe(true);
    expect(client.listComments).toHaveBeenCalledWith("/repo", 42);
    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.updateComment).not.toHaveBeenCalled();

    const body = (client.createComment as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(body).toContain(ORCHESTRATOR_COMMENT_MARKER);
    expect(body).toContain(`**[Orchestrator](${ORCHESTRATOR_LINK})** Status for H-FOO-1`);
    expect(body).toContain("| Time | Event |");
    expect(body).toContain("|------|-------|");
    expect(body).toContain("CI failure detected. Worker notified.");
    expect(body).toContain("<sub>[Ninthwave](https://ninthwave.sh)</sub>");
  });

  it("finds existing marker comment and inserts row before footer", () => {
    const existingBody = [
      ORCHESTRATOR_COMMENT_MARKER,
      `**[Orchestrator](${ORCHESTRATOR_LINK})** Status for H-FOO-1`,
      "",
      "| Time | Event |",
      "|------|-------|",
      "| 14:02 | CI failure detected. Worker notified. |",
      "",
      "---",
      "<sub>[Ninthwave](https://ninthwave.sh)</sub>",
    ].join("\n");

    (client.listComments as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 100, body: "unrelated comment" },
      { id: 200, body: existingBody },
    ]);

    const result = upsertOrchestratorComment(
      "/repo",
      42,
      "H-FOO-1",
      "Rebase succeeded. CI re-running.",
      client,
    );

    expect(result).toBe(true);
    expect(client.updateComment).toHaveBeenCalledTimes(1);
    expect(client.createComment).not.toHaveBeenCalled();

    const updatedBody = (client.updateComment as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    // Should still contain original content
    expect(updatedBody).toContain(ORCHESTRATOR_COMMENT_MARKER);
    expect(updatedBody).toContain("| 14:02 | CI failure detected. Worker notified. |");
    // Should have the new row inserted before footer
    expect(updatedBody).toContain("Rebase succeeded. CI re-running.");
    // Footer should still be at the end
    expect(updatedBody).toContain("<sub>[Ninthwave](https://ninthwave.sh)</sub>");
    // New row should appear before the footer
    const newRowIdx = updatedBody.indexOf("Rebase succeeded");
    const footerIdx = updatedBody.indexOf("<sub>[Ninthwave]");
    expect(newRowIdx).toBeLessThan(footerIdx);

    // Table rows must be contiguous (no blank line between them which breaks markdown tables)
    const firstRowIdx = updatedBody.indexOf("| 14:02 |");
    const betweenRows = updatedBody.slice(firstRowIdx, newRowIdx);
    expect(betweenRows).not.toContain("\n\n");
  });

  it("handles deleted marker comment by creating new one", () => {
    // listComments returns no marker comment (simulates deletion)
    (client.listComments as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 300, body: "some other comment" },
    ]);

    const result = upsertOrchestratorComment(
      "/repo",
      42,
      "H-FOO-1",
      "CI passed. Auto-merged.",
      client,
    );

    expect(result).toBe(true);
    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.updateComment).not.toHaveBeenCalled();

    const body = (client.createComment as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(body).toContain(ORCHESTRATOR_COMMENT_MARKER);
    expect(body).toContain("CI passed. Auto-merged.");
  });

  it("multiple upserts produce a single comment with multiple rows", () => {
    // Track the current body state for simulation
    let currentBody = "";

    (client.createComment as ReturnType<typeof vi.fn>).mockImplementation(
      (_repoRoot: string, _prNumber: number, body: string) => {
        currentBody = body;
        return true;
      },
    );
    (client.updateComment as ReturnType<typeof vi.fn>).mockImplementation(
      (_repoRoot: string, _commentId: number, body: string) => {
        currentBody = body;
        return true;
      },
    );

    // First call: creates new comment
    upsertOrchestratorComment("/repo", 42, "H-FOO-1", "CI failure detected. Worker notified.", client);
    expect(client.createComment).toHaveBeenCalledTimes(1);

    // Simulate existing comment for subsequent calls
    (client.listComments as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 500, body: currentBody },
    ]);

    // Second call: updates existing
    upsertOrchestratorComment("/repo", 42, "H-FOO-1", "Rebase triggered.", client);
    expect(client.updateComment).toHaveBeenCalledTimes(1);

    // Update mock to reflect latest body
    (client.listComments as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 500, body: currentBody },
    ]);

    // Third call: updates again
    upsertOrchestratorComment("/repo", 42, "H-FOO-1", "CI passed. Auto-merged.", client);
    expect(client.updateComment).toHaveBeenCalledTimes(2);

    // Final body should have all three events
    expect(currentBody).toContain("CI failure detected. Worker notified.");
    expect(currentBody).toContain("Rebase triggered.");
    expect(currentBody).toContain("CI passed. Auto-merged.");

    // Only one create call total (no duplicates)
    expect(client.createComment).toHaveBeenCalledTimes(1);

    // Footer should still be present at the end
    expect(currentBody).toContain("<sub>[Ninthwave](https://ninthwave.sh)</sub>");
    // All event rows should appear before the footer
    const lastEventIdx = currentBody.indexOf("CI passed. Auto-merged.");
    const footerIdx = currentBody.indexOf("<sub>[Ninthwave]");
    expect(lastEventIdx).toBeLessThan(footerIdx);
  });

  it("returns false when createComment fails", () => {
    (client.createComment as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = upsertOrchestratorComment(
      "/repo",
      42,
      "H-FOO-1",
      "Some event.",
      client,
    );

    expect(result).toBe(false);
  });

  it("returns false when updateComment fails", () => {
    (client.listComments as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 100, body: `${ORCHESTRATOR_COMMENT_MARKER}\nexisting` },
    ]);
    (client.updateComment as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = upsertOrchestratorComment(
      "/repo",
      42,
      "H-FOO-1",
      "Some event.",
      client,
    );

    expect(result).toBe(false);
  });
});
