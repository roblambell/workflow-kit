// Tests for core/stack-comments.ts -- buildStackComment and syncStackComments.
// Uses dependency injection (GhCommentClient) for testability without real GitHub API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildStackComment,
  syncStackComments,
  STACK_COMMENT_MARKER,
  type StackEntry,
  type GhCommentClient,
} from "../core/stack-comments.ts";

function expectedComment(lines: string[]): string {
  return [
    STACK_COMMENT_MARKER,
    "This change is part of the following stack:",
    "",
    ...lines,
    "",
    "<sub>Change orchestrated by [Ninthwave](https://ninthwave.sh).</sub>",
  ].join("\n");
}

describe("buildStackComment", () => {
  const twoItemStack: StackEntry[] = [
    { prNumber: 42, title: "feat: implement parser (H-PAR-1)" },
    { prNumber: 43, title: "feat: implement transformer (H-TFM-1)" },
  ];

  it("renders exact markdown for a 1-item stack", () => {
    const singleStack: StackEntry[] = [
      { prNumber: 99, title: "fix: quick patch (L-FIX-1)" },
    ];

    expect(buildStackComment("main", singleStack, 99)).toBe(
      expectedComment(["- #99 ◀"]),
    );
  });

  it("renders exact markdown for a 2-item stack", () => {
    expect(buildStackComment("main", twoItemStack, 43)).toBe(
      expectedComment([
        "- #42",
        "    - #43 ◀",
      ]),
    );
  });

  it("renders exact markdown for a 3-item stack", () => {
    const threeItemStack: StackEntry[] = [
      { prNumber: 10, title: "feat: base layer (H-A-1)" },
      { prNumber: 11, title: "feat: middle layer (H-A-2)" },
      { prNumber: 12, title: "feat: top layer (H-A-3)" },
    ];

    expect(buildStackComment("develop", threeItemStack, 11)).toBe(
      expectedComment([
        "- #10",
        "    - #11 ◀",
        "        - #12",
      ]),
    );
  });

  it("places the current-PR arrow on the matching row only", () => {
    const result = buildStackComment("main", twoItemStack, 42);

    expect(result).toBe(
      expectedComment([
        "- #42 ◀",
        "    - #43",
      ]),
    );
    expect(result.match(/◀/g)?.length).toBe(1);
  });

  it("does not render the base branch name or PR titles", () => {
    const result = buildStackComment("release/v2", twoItemStack, 42);

    expect(result).not.toContain("release/v2");
    expect(result).not.toContain("implement parser");
    expect(result).not.toContain("implement transformer");
  });
});

describe("syncStackComments", () => {
  let client: GhCommentClient;

  beforeEach(() => {
    client = {
      listComments: vi.fn().mockReturnValue([]),
      createComment: vi.fn().mockReturnValue(true),
      updateComment: vi.fn().mockReturnValue(true),
    };
  });

  const stack: StackEntry[] = [
    { prNumber: 42, title: "feat: implement parser (H-PAR-1)" },
    { prNumber: 43, title: "feat: implement transformer (H-TFM-1)" },
  ];

  it("creates exact comment bodies on all PRs when none exist", () => {
    syncStackComments("main", stack, client);

    expect(client.listComments).toHaveBeenCalledTimes(2);
    expect(client.listComments).toHaveBeenCalledWith(42);
    expect(client.listComments).toHaveBeenCalledWith(43);
    expect(client.updateComment).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(2);
    expect(client.createComment).toHaveBeenNthCalledWith(
      1,
      42,
      expectedComment([
        "- #42 ◀",
        "    - #43",
      ]),
    );
    expect(client.createComment).toHaveBeenNthCalledWith(
      2,
      43,
      expectedComment([
        "- #42",
        "    - #43 ◀",
      ]),
    );
  });

  it("updates an existing managed comment by marker and preserves the marker", () => {
    const legacyBody = `${STACK_COMMENT_MARKER}\nlegacy stack comment`;

    (client.listComments as ReturnType<typeof vi.fn>).mockImplementation(
      (prNumber: number) => {
        if (prNumber === 42) {
          return [
            { id: 100, body: "unrelated comment" },
            { id: 200, body: legacyBody },
          ];
        }
        return [{ id: 300, body: "some other comment" }];
      },
    );

    syncStackComments("main", stack, client);

    expect(client.updateComment).toHaveBeenCalledTimes(1);
    expect(client.updateComment).toHaveBeenCalledWith(
      200,
      expectedComment([
        "- #42 ◀",
        "    - #43",
      ]),
    );
    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(client.createComment).toHaveBeenCalledWith(
      43,
      expectedComment([
        "- #42",
        "    - #43 ◀",
      ]),
    );
  });

  it("updates existing managed comments on repeated sync without creating duplicates", () => {
    const existingComments = new Map<number, Array<{ id: number; body: string }>>();
    let nextCommentId = 100;

    client = {
      listComments: vi.fn((prNumber: number) => existingComments.get(prNumber) ?? []),
      createComment: vi.fn((prNumber: number, body: string) => {
        existingComments.set(prNumber, [{ id: nextCommentId++, body }]);
        return true;
      }),
      updateComment: vi.fn((commentId: number, body: string) => {
        for (const comments of existingComments.values()) {
          const existing = comments.find((comment) => comment.id === commentId);
          if (existing) {
            existing.body = body;
            return true;
          }
        }
        return false;
      }),
    };

    syncStackComments("main", stack, client);
    expect(client.createComment).toHaveBeenCalledTimes(2);
    expect(client.updateComment).not.toHaveBeenCalled();

    (client.createComment as ReturnType<typeof vi.fn>).mockClear();
    (client.updateComment as ReturnType<typeof vi.fn>).mockClear();

    syncStackComments("main", stack, client);

    expect(client.createComment).not.toHaveBeenCalled();
    expect(client.updateComment).toHaveBeenCalledTimes(2);
    expect(client.updateComment).toHaveBeenNthCalledWith(
      1,
      100,
      expectedComment([
        "- #42 ◀",
        "    - #43",
      ]),
    );
    expect(client.updateComment).toHaveBeenNthCalledWith(
      2,
      101,
      expectedComment([
        "- #42",
        "    - #43 ◀",
      ]),
    );
    expect(existingComments.get(42)).toHaveLength(1);
    expect(existingComments.get(43)).toHaveLength(1);
  });

  it("updates earlier PR comments when the stack grows", () => {
    const existingComments = new Map<number, Array<{ id: number; body: string }>>();
    let nextCommentId = 100;

    client = {
      listComments: vi.fn((prNumber: number) => existingComments.get(prNumber) ?? []),
      createComment: vi.fn((prNumber: number, body: string) => {
        existingComments.set(prNumber, [{ id: nextCommentId++, body }]);
        return true;
      }),
      updateComment: vi.fn((commentId: number, body: string) => {
        for (const comments of existingComments.values()) {
          const existing = comments.find((comment) => comment.id === commentId);
          if (existing) {
            existing.body = body;
            return true;
          }
        }
        return false;
      }),
    };

    const twoItemStack: StackEntry[] = [
      { prNumber: 42, title: "feat: implement parser (H-PAR-1)" },
      { prNumber: 43, title: "feat: implement transformer (H-TFM-1)" },
    ];
    syncStackComments("main", twoItemStack, client);

    const threeItemStack: StackEntry[] = [
      ...twoItemStack,
      { prNumber: 44, title: "feat: implement renderer (H-RND-1)" },
    ];
    syncStackComments("main", threeItemStack, client);

    expect(client.createComment).toHaveBeenCalledTimes(3);
    expect(client.updateComment).toHaveBeenCalledTimes(2);
    expect(existingComments.get(42)?.[0]?.body).toBe(
      expectedComment([
        "- #42 ◀",
        "    - #43",
        "        - #44",
      ]),
    );
    expect(existingComments.get(43)?.[0]?.body).toBe(
      expectedComment([
        "- #42",
        "    - #43 ◀",
        "        - #44",
      ]),
    );
    expect(existingComments.get(44)?.[0]?.body).toBe(
      expectedComment([
        "- #42",
        "    - #43",
        "        - #44 ◀",
      ]),
    );
    expect(existingComments.get(42)).toHaveLength(1);
    expect(existingComments.get(43)).toHaveLength(1);
    expect(existingComments.get(44)).toHaveLength(1);
  });
});
