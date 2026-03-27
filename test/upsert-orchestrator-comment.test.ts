// Tests for upsertOrchestratorComment — living PR comment upsert pattern.
// Uses dependency injection (PrCommentClient) for testability without real GitHub API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  upsertOrchestratorComment,
  ORCHESTRATOR_COMMENT_MARKER,
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
    expect(body).toContain("**[Orchestrator]** Status for H-FOO-1");
    expect(body).toContain("| Time | Event |");
    expect(body).toContain("|------|-------|");
    expect(body).toContain("CI failure detected. Worker notified.");
  });

  it("finds existing marker comment and appends row", () => {
    const existingBody = [
      ORCHESTRATOR_COMMENT_MARKER,
      "**[Orchestrator]** Status for H-FOO-1",
      "",
      "| Time | Event |",
      "|------|-------|",
      "| 14:02 | CI failure detected. Worker notified. |",
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
    // Should have the new row appended
    expect(updatedBody).toContain("Rebase succeeded. CI re-running.");
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
