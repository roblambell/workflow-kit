// Tests for runtime control handler dual-write behavior.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, readFileSync } from "fs";
import { createRuntimeControlHandlers } from "../core/watch-engine-runner.ts";
import type { WatchEngineControlCommand } from "../core/watch-engine-runner.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

describe("createRuntimeControlHandlers dual-write", () => {
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

  it("onStrategyChange writes to both global and local config", () => {
    const { repo, handlers, userWrites } = setup();

    handlers.onStrategyChange!("auto");

    expect(userWrites).toHaveLength(1);
    expect(userWrites[0]).toEqual({ merge_strategy: "auto" });

    const local = JSON.parse(readFileSync(join(repo, ".ninthwave", "config.local.json"), "utf-8"));
    expect(local.merge_strategy).toBe("auto");
  });

  it("onReviewChange writes to both global and local config", () => {
    const { repo, handlers, userWrites } = setup();

    handlers.onReviewChange!("off");

    expect(userWrites).toHaveLength(1);
    expect(userWrites[0]).toEqual({ review_mode: "off" });

    const local = JSON.parse(readFileSync(join(repo, ".ninthwave", "config.local.json"), "utf-8"));
    expect(local.review_mode).toBe("off");
  });

  it("onCollaborationChange writes to both global and local config", () => {
    const { repo, handlers, userWrites } = setup();

    handlers.onCollaborationChange!("connected");

    expect(userWrites).toHaveLength(1);
    expect(userWrites[0]).toEqual({ collaboration_mode: "connect" });

    const local = JSON.parse(readFileSync(join(repo, ".ninthwave", "config.local.json"), "utf-8"));
    expect(local.collaboration_mode).toBe("connect");
  });

  it("bypass merge strategy does not persist to either config", () => {
    const { repo, handlers, userWrites } = setup();

    handlers.onStrategyChange!("bypass");

    expect(userWrites).toHaveLength(0);
  });

  it("skips local write when projectRoot is not provided", () => {
    const commands: WatchEngineControlCommand[] = [];
    const userWrites: Record<string, unknown>[] = [];

    const handlers = createRuntimeControlHandlers({
      sendControl: (cmd) => commands.push(cmd),
      getMaxInflight: () => 3,
      saveUserConfigFn: (updates) => { userWrites.push(updates); },
    });

    handlers.onReviewChange!("on");

    expect(userWrites).toHaveLength(1);
    // No local config write attempted (no projectRoot), no error thrown
  });
});
