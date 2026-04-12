// Tests for project config and user config loading (JSON format).

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import {
  loadConfig,
  saveConfig,
  loadUserConfig,
  saveUserConfig,
} from "../core/config.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

describe("loadConfig", () => {
  it("returns defaults when config file is missing", () => {
    const repo = setupTempRepo();
    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
    expect(config.crew_url).toBeUndefined();
  });

  it("parses valid JSON with known keys and crew_url", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        review_external: true,
        crew_url: "wss://crew.example/ws",
      }),
    );

    const config = loadConfig(repo);
    expect(config.review_external).toBe(true);
    expect(config.crew_url).toBe("wss://crew.example/ws");
  });

  it("parses review_external when only that setting is set", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: true }),
    );

    const config = loadConfig(repo);
    expect(config.review_external).toBe(true);
    expect(config.crew_url).toBeUndefined();
  });

  it("returns defaults for malformed JSON", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not valid json {{{");

    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
  });

  it("returns defaults when JSON is an array", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "[1, 2, 3]");

    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
  });

  it("returns defaults when JSON is null", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "null");

    const config = loadConfig(repo);
    expect(config.review_external).toBe(false);
  });

  it("ignores unknown keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        review_external: true,
        unknown_key: "ignored",
        another_unknown: 42,
      }),
    );

    const config = loadConfig(repo);
    expect(config.review_external).toBe(true);
    // Only known keys in the result
    expect(Object.keys(config)).toEqual(["review_external"]);
  });

  it("returns undefined for invalid or absent crew_url values", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });

    const cases = [
      {},
      { crew_url: "https://crew.example/ws" },
      { crew_url: "/relative" },
      { crew_url: "not a url" },
      { crew_url: 123 },
      { crew_url: null },
    ];

    for (const value of cases) {
      writeFileSync(join(configDir, "config.json"), JSON.stringify(value));
      const config = loadConfig(repo);
      expect(config.crew_url).toBeUndefined();
    }
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

    saveConfig(repo, { crew_url: "wss://crew.example/ws" });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.review_external).toBe(true);
    expect(content.crew_url).toBe("wss://crew.example/ws");
  });

  it("preserves unknown keys in config file", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello", review_external: false }),
    );

    saveConfig(repo, { review_external: true });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.review_external).toBe(true);
  });

  it("merges crew_url into existing config without clobbering unrelated keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: true, custom_key: "hello" }),
    );

    saveConfig(repo, { crew_url: "ws://crew.example/socket" });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.review_external).toBe(true);
    expect(content.custom_key).toBe("hello");
    expect(content.crew_url).toBe("ws://crew.example/socket");
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
      crew_url: "wss://crew.example/ws",
    });

    const config = loadConfig(repo);
    expect(config).toEqual({
      review_external: true,
      crew_url: "wss://crew.example/ws",
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

  it("reads tmux_layout from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ tmux_layout: "windows" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.tmux_layout).toBe("windows");
  });

  it("reads update_checks_enabled from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ update_checks_enabled: false }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.update_checks_enabled).toBe(false);
  });

  it("reads skipped_update_version from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ skipped_update_version: "v0.5.0" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.skipped_update_version).toBe("0.5.0");
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

  it("ignores invalid tmux_layout safely", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ tmux_layout: "grid" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.tmux_layout).toBeUndefined();
  });

  it("reads session_limit from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: 3 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBe(3);
  });

  it("ignores non-number session_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: "five" }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBeUndefined();
  });

  it("ignores session_limit less than 1", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: 0 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBeUndefined();
  });

  it("ignores negative session_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: -2 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBeUndefined();
  });

  it("floors fractional session_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: 3.7 }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBe(3);
  });

  it("ignores NaN session_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: null }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBeUndefined();
  });

  it("ignores Infinity session_limit", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    // JSON.stringify turns Infinity into null, so write raw
    writeFileSync(
      join(configDir, "config.json"),
      '{"session_limit": 1e999}',
    );

    // JSON.parse turns 1e999 into Infinity
    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBeUndefined();
  });
});

describe("saveUserConfig", () => {
  it("creates config file when missing", () => {
    const tmpHome = setupTempRepo();
    saveUserConfig({ session_limit: 5 }, tmpHome);

    const configPath = join(tmpHome, ".ninthwave", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.session_limit).toBe(5);
  });

  it("merges session_limit into existing config without clobbering", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tools: ["claude"] }),
    );

    saveUserConfig({ session_limit: 3 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.ai_tools).toEqual(["claude"]);
    expect(content.session_limit).toBe(3);
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
      tmux_layout: "windows",
      merge_strategy: "auto",
      review_mode: "mine",
      collaboration_mode: "join",
      session_limit: 4,
    }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.tmux_layout).toBe("windows");
    expect(content.merge_strategy).toBe("auto");
    expect(content.review_mode).toBe("mine");
    expect(content.collaboration_mode).toBe("join");
    expect(content.session_limit).toBe(4);

    const config = loadUserConfig(tmpHome);
    expect(config).toMatchObject({
      tmux_layout: "windows",
      merge_strategy: "auto",
      review_mode: "mine",
      collaboration_mode: "join",
      session_limit: 4,
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

    saveUserConfig({ session_limit: 4 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.session_limit).toBe(4);
  });

  it("saves update_checks_enabled without clobbering unrelated keys", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello", ai_tools: ["claude"] }),
    );

    saveUserConfig({ update_checks_enabled: false }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.ai_tools).toEqual(["claude"]);
    expect(content.update_checks_enabled).toBe(false);

    const config = loadUserConfig(tmpHome);
    expect(config).toMatchObject({
      ai_tools: ["claude"],
      update_checks_enabled: false,
    });
  });

  it("saves skipped_update_version without clobbering unrelated keys", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello", ai_tools: ["claude"] }),
    );

    saveUserConfig({ skipped_update_version: "v0.5.0" }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.ai_tools).toEqual(["claude"]);
    expect(content.skipped_update_version).toBe("0.5.0");

    const config = loadUserConfig(tmpHome);
    expect(config).toMatchObject({
      ai_tools: ["claude"],
      skipped_update_version: "0.5.0",
    });
  });

  it("overwrites existing session_limit value", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ session_limit: 2 }),
    );

    saveUserConfig({ session_limit: 6 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.session_limit).toBe(6);
  });

  it("round-trips with loadUserConfig", () => {
    const tmpHome = setupTempRepo();
    saveUserConfig({ session_limit: 7 }, tmpHome);

    const config = loadUserConfig(tmpHome);
    expect(config.session_limit).toBe(7);
  });

  it("handles malformed existing file gracefully", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not valid json {{{");

    saveUserConfig({ session_limit: 3 }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.session_limit).toBe(3);
  });
});
