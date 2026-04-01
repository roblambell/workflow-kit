// Tests for project config and user config loading (JSON format).

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { loadConfig, saveConfig, loadUserConfig, saveUserConfig } from "../core/config.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

describe("loadConfig", () => {
  it("returns defaults when config file is missing", () => {
    const repo = setupTempRepo();
    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
    expect(config.schedule_enabled).toBe(false);
  });

  it("parses valid JSON with both keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: true, schedule_enabled: true }),
    );

    const config = loadConfig(repo);
    expect(config.review_external).toBe(true);
    expect(config.schedule_enabled).toBe(true);
  });

  it("defaults schedule_enabled when only review_external is set", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: true }),
    );

    const config = loadConfig(repo);
    expect(config.review_external).toBe(true);
    expect(config.schedule_enabled).toBe(false);
  });

  it("returns defaults for malformed JSON", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not valid json {{{");

    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
    expect(config.schedule_enabled).toBe(false);
  });

  it("returns defaults when JSON is an array", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "[1, 2, 3]");

    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
    expect(config.schedule_enabled).toBe(false);
  });

  it("returns defaults when JSON is null", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "null");

    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
    expect(config.schedule_enabled).toBe(false);
  });

  it("ignores unknown keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        review_external: true,
        schedule_enabled: false,
        unknown_key: "ignored",
        another_unknown: 42,
      }),
    );

    const config = loadConfig(repo);
    expect(config.review_external).toBe(true);
    expect(config.schedule_enabled).toBe(false);
    // Only known keys in the result
    expect(Object.keys(config)).toEqual(["review_external", "schedule_enabled"]);
  });

  it("treats non-boolean review_external as false", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: "true" }),
    );

    const config = loadConfig(repo);
    // String "true" is not boolean true
    expect(config.review_external).toBe(false);
  });

  it("treats non-boolean schedule_enabled as false", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ schedule_enabled: 1 }),
    );

    const config = loadConfig(repo);
    expect(config.schedule_enabled).toBe(false);
  });

  it("ignores ai_tools in project config", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tools: ["opencode", "claude"] }),
    );

    const config = loadConfig(repo);
    expect(config).toEqual({
      review_external: false,
      schedule_enabled: false,
    });
  });
});

describe("saveConfig", () => {
  it("creates config file when missing", () => {
    const repo = setupTempRepo();
    saveConfig(repo, { review_external: true });

    const configPath = join(repo, ".ninthwave", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.review_external).toBe(true);
  });

  it("merges stable settings into existing config without clobbering", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: true }),
    );

    saveConfig(repo, { schedule_enabled: true });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.review_external).toBe(true);
    expect(content.schedule_enabled).toBe(true);
  });

  it("preserves unknown keys in config file", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello", review_external: false }),
    );

    saveConfig(repo, { schedule_enabled: true });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.schedule_enabled).toBe(true);
  });

  it("overwrites existing stable setting values", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: false }),
    );

    saveConfig(repo, { review_external: true });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.review_external).toBe(true);
  });

  it("round-trips with loadConfig", () => {
    const repo = setupTempRepo();
    saveConfig(repo, {
      review_external: true,
      schedule_enabled: true,
    });

    const config = loadConfig(repo);
    expect(config).toEqual({
      review_external: true,
      schedule_enabled: true,
    });
  });
});

describe("loadUserConfig", () => {
  it("returns {} when config file is missing", () => {
    const tmpHome = setupTempRepo(); // use temp dir as fake home
    const config = loadUserConfig(tmpHome);
    expect(config).toEqual({});
  });

  it("returns ai_tools from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tools: ["opencode"] }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.ai_tools).toEqual(["opencode"]);
  });

  it("returns {} for malformed JSON and warns", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not valid json {{{");

    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadUserConfig(tmpHome);
    expect(config).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("malformed JSON"),
    );
    warnSpy.mockRestore();
  });

  it("returns {} when JSON is an array and warns", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "[1, 2, 3]");

    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadUserConfig(tmpHome);
    expect(config).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a JSON object"),
    );
    warnSpy.mockRestore();
  });

  it("ignores legacy ai_tool field", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tool: "opencode" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.ai_tools).toBeUndefined();
  });

  it("ignores unknown keys", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tools: ["claude"], some_other_key: "ignored" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.ai_tools).toEqual(["claude"]);
    expect(Object.keys(config)).toEqual(["ai_tools"]);
  });

  it("reads persisted TUI defaults from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        merge_strategy: "auto",
        review_mode: "all",
        collaboration_mode: "share",
      }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.merge_strategy).toBe("auto");
    expect(config.review_mode).toBe("all");
    expect(config.collaboration_mode).toBe("share");
  });

  it("reads backend_mode from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ backend_mode: "cmux" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.backend_mode).toBe("cmux");
  });

  it("ignores invalid persisted TUI enum values safely", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        merge_strategy: "bypass",
        review_mode: "sometimes",
        collaboration_mode: "remote",
      }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.merge_strategy).toBeUndefined();
    expect(config.review_mode).toBeUndefined();
    expect(config.collaboration_mode).toBeUndefined();
  });

  it("ignores invalid backend_mode safely", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ backend_mode: "screen" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.backend_mode).toBeUndefined();
  });

  it("reads wip_limit from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: 3 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBe(3);
  });

  it("ignores non-number wip_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: "five" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBeUndefined();
  });

  it("ignores wip_limit less than 1", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: 0 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBeUndefined();
  });

  it("ignores negative wip_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: -2 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBeUndefined();
  });

  it("floors fractional wip_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: 3.7 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBe(3);
  });

  it("ignores NaN wip_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: null }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBeUndefined();
  });

  it("ignores Infinity wip_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    // JSON.stringify turns Infinity into null, so write raw
    writeFileSync(
      join(configDir, "config.json"),
      '{"wip_limit": 1e999}',
    );

    // JSON.parse turns 1e999 into Infinity
    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBeUndefined();
  });
});

describe("saveUserConfig", () => {
  it("creates config file when missing", () => {
    const tmpHome = setupTempRepo();
    saveUserConfig({ wip_limit: 5 }, tmpHome);

    const configPath = join(tmpHome, ".ninthwave", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.wip_limit).toBe(5);
  });

  it("merges wip_limit into existing config without clobbering", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tools: ["claude"] }),
    );

    saveUserConfig({ wip_limit: 3 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.ai_tools).toEqual(["claude"]);
    expect(content.wip_limit).toBe(3);
  });

  it("round-trips persisted TUI defaults without dropping unknown keys", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello" }),
    );

    saveUserConfig({
      backend_mode: "cmux",
      merge_strategy: "auto",
      review_mode: "mine",
      collaboration_mode: "join",
      wip_limit: 4,
    }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.backend_mode).toBe("cmux");
    expect(content.merge_strategy).toBe("auto");
    expect(content.review_mode).toBe("mine");
    expect(content.collaboration_mode).toBe("join");
    expect(content.wip_limit).toBe(4);

    const config = loadUserConfig(tmpHome);
    expect(config).toMatchObject({
      backend_mode: "cmux",
      merge_strategy: "auto",
      review_mode: "mine",
      collaboration_mode: "join",
      wip_limit: 4,
    });
  });

  it("preserves unknown keys in config file", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello" }),
    );

    saveUserConfig({ wip_limit: 4 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.wip_limit).toBe(4);
  });

  it("overwrites existing wip_limit value", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ wip_limit: 2 }),
    );

    saveUserConfig({ wip_limit: 6 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.wip_limit).toBe(6);
  });

  it("round-trips with loadUserConfig", () => {
    const tmpHome = setupTempRepo();
    saveUserConfig({ wip_limit: 7 }, tmpHome);

    const config = loadUserConfig(tmpHome);
    expect(config.wip_limit).toBe(7);
  });

  it("handles malformed existing file gracefully", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not valid json {{{");

    saveUserConfig({ wip_limit: 3 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.wip_limit).toBe(3);
  });
});
