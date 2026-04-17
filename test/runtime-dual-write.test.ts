// Tests that runtime control toggles for mode / review / collaboration are
// strictly ephemeral and never reach the filesystem.
//
// Historically these handlers dual-wrote merge_strategy / review_mode /
// collaboration_mode to both `~/.ninthwave/config.json` and
// `.ninthwave/config.local.json`. That persistence was removed so every
// session boots from the same safe defaults; runtime toggles affect only
// the current session.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { createRuntimeControlHandlers } from "../core/watch-engine-runner.ts";
import type { WatchEngineControlCommand } from "../core/watch-engine-runner.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

describe("createRuntimeControlHandlers mode/review/collab are ephemeral", () => {
  function setup() {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });
    const commands: WatchEngineControlCommand[] = [];
    const userWrites: Record<string, unknown>[] = [];

    const handlers = createRuntimeControlHandlers({
      sendControl: (cmd) => commands.push(cmd),
      getMaxInflight: () => 3,
      projectRoot: repo,
      saveUserConfigFn: (updates) => { userWrites.push(updates); },
    });

    return { repo, commands, userWrites, handlers };
  }

  it("onStrategyChange dispatches a control command and writes nothing", () => {
    const { repo, commands, handlers, userWrites } = setup();

    handlers.onStrategyChange!("auto");

    expect(commands).toEqual([
      { type: "set-merge-strategy", strategy: "auto", source: "keyboard" },
    ]);
    expect(userWrites).toHaveLength(0);
    expect(existsSync(join(repo, ".ninthwave", "config.local.json"))).toBe(false);
  });

  it("onReviewChange dispatches a control command and writes nothing", () => {
    const { repo, commands, handlers, userWrites } = setup();

    handlers.onReviewChange!("on");

    expect(commands).toEqual([
      { type: "set-review-mode", mode: "on", source: "keyboard" },
    ]);
    expect(userWrites).toHaveLength(0);
    expect(existsSync(join(repo, ".ninthwave", "config.local.json"))).toBe(false);
  });

  it("onCollaborationChange dispatches a control command and writes nothing", () => {
    const { repo, commands, handlers, userWrites } = setup();

    handlers.onCollaborationChange!("connected");

    expect(commands).toEqual([
      { type: "set-collaboration-mode", mode: "connected", source: "keyboard" },
    ]);
    expect(userWrites).toHaveLength(0);
    expect(existsSync(join(repo, ".ninthwave", "config.local.json"))).toBe(false);
  });

  it("onMaxInflightChange still persists the new session limit (durable preference)", () => {
    const { handlers, userWrites } = setup();

    handlers.onMaxInflightChange!(2);

    expect(userWrites).toEqual([{ max_inflight: 5 }]);
  });
});
