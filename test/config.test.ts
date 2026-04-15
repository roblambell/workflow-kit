// Tests for project config and user config loading (JSON format).

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import {
  generateProjectIdentity,
  loadConfig,
  loadMergedProjectConfig,
  loadOrGenerateProjectIdentity,
  saveConfig,
  loadUserConfig,
  saveUserConfig,
} from "../core/config.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BROKER_SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const ZERO_SECRET = "A".repeat(43) + "=";
const SAMPLE_UUID_A = "00000000-0000-4000-8000-000000000001";
const SAMPLE_UUID_B = "11111111-1111-4111-a111-111111111111";

afterEach(() => {
  cleanupTempRepos();
});

describe("loadConfig", () => {
  it("returns defaults when config file is missing", () => {
    const repo = setupTempRepo();
    const config = loadConfig(repo);
    expect(config).toEqual({});
    expect(config.crew_url).toBeUndefined();
  });

  it("parses valid JSON with crew_url", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        crew_url: "wss://crew.example/ws",
      }),
    );

    const config = loadConfig(repo);
    expect(config.crew_url).toBe("wss://crew.example/ws");
  });

  it("ignores legacy review_external field", () => {
    // review_external was removed in H-SUX-3. Loading an old config that
    // still contains the key should not activate any behavior, and the
    // returned ProjectConfig should not expose the field.
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ review_external: true }),
    );

    const config = loadConfig(repo);
    expect(config).toEqual({});
  });

  it("returns defaults for malformed JSON", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not valid json {{{");

    const config = loadConfig(repo);
    expect(config).toEqual({});
  });

  it("returns defaults when JSON is an array", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "[1, 2, 3]");

    const config = loadConfig(repo);
    expect(config).toEqual({});
  });

  it("returns defaults when JSON is null", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "null");

    const config = loadConfig(repo);
    expect(config).toEqual({});
  });

  it("ignores unknown keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        crew_url: "wss://crew.example/ws",
        unknown_key: "ignored",
        another_unknown: 42,
      }),
    );

    const config = loadConfig(repo);
    expect(config.crew_url).toBe("wss://crew.example/ws");
    // Only known keys in the result
    expect(Object.keys(config)).toEqual(["crew_url"]);
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

  it("ignores ai_tools in project config", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ ai_tools: ["opencode", "claude"] }),
    );

    const config = loadConfig(repo);
    expect(config).toEqual({});
  });

  it("parses a valid project_id and broker_secret from config.json", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        project_id: SAMPLE_UUID_A,
        broker_secret: ZERO_SECRET,
      }),
    );

    const config = loadConfig(repo);
    expect(config.project_id).toBe(SAMPLE_UUID_A);
    expect(config.broker_secret).toBe(ZERO_SECRET);
  });

  it("rejects a malformed project_id", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    for (const bad of [
      "not-a-uuid",
      "00000000-0000-1000-8000-000000000001", // wrong version
      "00000000-0000-4000-c000-000000000001", // wrong variant
      42,
      null,
    ]) {
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ project_id: bad }),
      );
      expect(loadConfig(repo).project_id).toBeUndefined();
    }
  });

  it("rejects a malformed broker_secret", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    for (const bad of [
      "short",
      "A".repeat(44), // wrong length / missing pad
      "A".repeat(42) + "==", // decodes to 31 bytes
      "!!!".repeat(14) + "A=", // illegal chars
      42,
    ]) {
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ broker_secret: bad }),
      );
      expect(loadConfig(repo).broker_secret).toBeUndefined();
    }
  });
});

describe("loadMergedProjectConfig", () => {
  it("layers config.local.json over config.json for project_id and broker_secret", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        project_id: SAMPLE_UUID_A,
        broker_secret: ZERO_SECRET,
      }),
    );
    writeFileSync(
      join(configDir, "config.local.json"),
      JSON.stringify({
        project_id: SAMPLE_UUID_B,
      }),
    );

    const merged = loadMergedProjectConfig(repo);
    // Local override wins for project_id; broker_secret falls through to shared.
    expect(merged.project_id).toBe(SAMPLE_UUID_B);
    expect(merged.broker_secret).toBe(ZERO_SECRET);
  });

  it("uses committed values when no local overlay is present", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        project_id: SAMPLE_UUID_A,
        broker_secret: ZERO_SECRET,
      }),
    );

    const merged = loadMergedProjectConfig(repo);
    expect(merged.project_id).toBe(SAMPLE_UUID_A);
    expect(merged.broker_secret).toBe(ZERO_SECRET);
  });
});

describe("generateProjectIdentity", () => {
  it("produces a UUID v4 and a base64-encoded 32-byte secret", () => {
    const { project_id, broker_secret } = generateProjectIdentity();
    expect(project_id).toMatch(UUID_V4_PATTERN);
    expect(broker_secret).toMatch(BROKER_SECRET_PATTERN);
    expect(Buffer.from(broker_secret, "base64")).toHaveLength(32);
  });

  it("returns distinct values on successive calls", () => {
    const first = generateProjectIdentity();
    const second = generateProjectIdentity();
    expect(first.project_id).not.toBe(second.project_id);
    expect(first.broker_secret).not.toBe(second.broker_secret);
  });
});

describe("loadOrGenerateProjectIdentity", () => {
  it("writes both fields when config.json is absent", () => {
    const repo = setupTempRepo();
    const identity = loadOrGenerateProjectIdentity(repo);
    expect(identity.project_id).toMatch(UUID_V4_PATTERN);
    expect(identity.broker_secret).toMatch(BROKER_SECRET_PATTERN);

    const configPath = join(repo, ".ninthwave", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(onDisk.project_id).toBe(identity.project_id);
    expect(onDisk.broker_secret).toBe(identity.broker_secret);
  });

  it("is idempotent when both fields are already present", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    const committed = {
      project_id: SAMPLE_UUID_A,
      broker_secret: ZERO_SECRET,
      custom_key: "hello",
    };
    writeFileSync(join(configDir, "config.json"), JSON.stringify(committed));

    const identity = loadOrGenerateProjectIdentity(repo);
    expect(identity).toEqual({
      project_id: SAMPLE_UUID_A,
      broker_secret: ZERO_SECRET,
    });

    // File contents unchanged except for pretty-printing by saveConfig -- but
    // we expect no write at all, so the raw bytes should still match the
    // original compact JSON.
    const rawAfter = readFileSync(join(configDir, "config.json"), "utf-8");
    expect(rawAfter).toBe(JSON.stringify(committed));
  });

  it("generates only the missing field when one is already present", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ project_id: SAMPLE_UUID_A }),
    );

    const identity = loadOrGenerateProjectIdentity(repo);
    expect(identity.project_id).toBe(SAMPLE_UUID_A);
    expect(identity.broker_secret).toMatch(BROKER_SECRET_PATTERN);

    const onDisk = JSON.parse(
      readFileSync(join(configDir, "config.json"), "utf-8"),
    );
    expect(onDisk.project_id).toBe(SAMPLE_UUID_A);
    expect(onDisk.broker_secret).toBe(identity.broker_secret);
  });

  it("preserves unrelated keys when merging generated fields", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        crew_url: "wss://crew.example/ws",
        custom_key: "hello",
      }),
    );

    loadOrGenerateProjectIdentity(repo);

    const onDisk = JSON.parse(
      readFileSync(join(configDir, "config.json"), "utf-8"),
    );
    expect(onDisk.crew_url).toBe("wss://crew.example/ws");
    expect(onDisk.custom_key).toBe("hello");
    expect(onDisk.project_id).toMatch(UUID_V4_PATTERN);
    expect(onDisk.broker_secret).toMatch(BROKER_SECRET_PATTERN);
  });

  it("does not persist identity into config.json when already supplied via config.local.json", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.local.json"),
      JSON.stringify({
        project_id: SAMPLE_UUID_A,
        broker_secret: ZERO_SECRET,
      }),
    );

    const identity = loadOrGenerateProjectIdentity(repo);
    expect(identity).toEqual({
      project_id: SAMPLE_UUID_A,
      broker_secret: ZERO_SECRET,
    });
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });
});

describe("saveConfig", () => {
  it("creates config file when missing", () => {
    const repo = setupTempRepo();
    saveConfig(repo, { crew_url: "wss://crew.example/ws" });

    const configPath = join(repo, ".ninthwave", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.crew_url).toBe("wss://crew.example/ws");
  });

  it("merges crew_url into existing config without clobbering", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello" }),
    );

    saveConfig(repo, { crew_url: "wss://crew.example/ws" });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.crew_url).toBe("wss://crew.example/ws");
  });

  it("preserves unknown keys in config file", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello" }),
    );

    saveConfig(repo, { crew_url: "ws://crew.example/socket" });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.crew_url).toBe("ws://crew.example/socket");
  });

  it("preserves legacy keys that are no longer part of ProjectConfig", () => {
    // A user upgrading from a version with `review_external` should see the
    // key stay on disk (unknown-key passthrough) so manual cleanup is
    // optional, but loadConfig will not expose it to callers.
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

  it("overwrites existing crew_url value", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ crew_url: "ws://old.example/ws" }),
    );

    saveConfig(repo, { crew_url: "ws://new.example/ws" });

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.crew_url).toBe("ws://new.example/ws");
  });

  it("round-trips with loadConfig", () => {
    const repo = setupTempRepo();
    saveConfig(repo, {
      crew_url: "wss://crew.example/ws",
    });

    const config = loadConfig(repo);
    expect(config).toEqual({
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

  it("returns ai_tool_overrides from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        ai_tool_overrides: {
          opencode: {
            command: "/custom/opencode",
            args: ["--shared"],
            env: {
              SHARED_ONLY: "base",
            },
            launch: {
              args: ["--interactive"],
            },
            headless: {
              command: "/custom/opencode-headless",
              env: {
                HEADLESS_ONLY: "1",
              },
            },
          },
        },
      }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.ai_tool_overrides).toEqual({
      opencode: {
        command: "/custom/opencode",
        args: ["--shared"],
        env: {
          SHARED_ONLY: "base",
        },
        launch: {
          args: ["--interactive"],
        },
        headless: {
          command: "/custom/opencode-headless",
          env: {
            HEADLESS_ONLY: "1",
          },
        },
      },
    });
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

  it("safely ignores malformed ai_tool_overrides entries", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        ai_tool_overrides: {
          opencode: {
            command: "/custom/opencode",
            args: ["--shared", 1],
            env: {
              SHARED_ONLY: "base",
              INVALID: 1,
            },
            launch: {
              args: ["--interactive"],
              env: {
                MODE_ONLY: "1",
                INVALID: false,
              },
            },
          },
          codex: {
            args: "--invalid",
          },
          custom: {
            command: "/ignored/custom",
          },
        },
      }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.ai_tool_overrides).toEqual({
      opencode: {
        command: "/custom/opencode",
        env: {
          SHARED_ONLY: "base",
        },
        launch: {
          args: ["--interactive"],
          env: {
            MODE_ONLY: "1",
          },
        },
      },
    });
  });

  it("reads persisted TUI defaults from valid JSON", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        merge_strategy: "auto",
        review_mode: "on",
        collaboration_mode: "share",
      }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.merge_strategy).toBe("auto");
    expect(config.review_mode).toBe("on");
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

  it("normalizes legacy review_mode 'mine' to 'on'", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ review_mode: "mine" }));

    const config = loadUserConfig(tmpHome);
    expect(config.review_mode).toBe("on");
  });

  it("normalizes legacy review_mode 'all' to 'on'", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ review_mode: "all" }));

    const config = loadUserConfig(tmpHome);
    expect(config.review_mode).toBe("on");
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

  it("saves ai_tool_overrides without clobbering unrelated keys", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello", ai_tools: ["claude"] }),
    );

    saveUserConfig({
      ai_tool_overrides: {
        claude: {
          command: "/custom/claude",
          args: ["--shared"],
          launch: {
            env: {
              CLAUDE_ONLY: "1",
            },
          },
        },
      },
    }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.ai_tools).toEqual(["claude"]);
    expect(content.ai_tool_overrides).toEqual({
      claude: {
        command: "/custom/claude",
        args: ["--shared"],
        launch: {
          env: {
            CLAUDE_ONLY: "1",
          },
        },
      },
    });
  });

  it("ignores malformed ai_tool_overrides updates safely", () => {
    const tmpHome = setupTempRepo();
    const configDir = join(tmpHome, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ custom_key: "hello" }),
    );

    saveUserConfig({
      ai_tool_overrides: {
        opencode: {
          args: ["--valid"],
          headless: {
            env: {
              HEADLESS_ONLY: "1",
            },
          },
        },
        codex: {
          // @ts-expect-error intentionally malformed for parser coverage
          command: 123,
        },
        // @ts-expect-error intentionally malformed for parser coverage
        custom: {
          command: "/ignored/custom",
        },
      },
    }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.ai_tool_overrides).toEqual({
      opencode: {
        args: ["--valid"],
        headless: {
          env: {
            HEADLESS_ONLY: "1",
          },
        },
      },
    });
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
      review_mode: "on",
      collaboration_mode: "join",
      session_limit: 4,
    }, tmpHome);

    const content = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(content.custom_key).toBe("hello");
    expect(content.tmux_layout).toBe("windows");
    expect(content.merge_strategy).toBe("auto");
    expect(content.review_mode).toBe("on");
    expect(content.collaboration_mode).toBe("join");
    expect(content.session_limit).toBe(4);

    const config = loadUserConfig(tmpHome);
    expect(config).toMatchObject({
      tmux_layout: "windows",
      merge_strategy: "auto",
      review_mode: "on",
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

  it("round-trips ai_tool_overrides through saveUserConfig and loadUserConfig", () => {
    const tmpHome = setupTempRepo();
    saveUserConfig({
      ai_tool_overrides: {
        codex: {
          command: "/custom/codex",
          args: ["--shared"],
          env: {
            SHARED_ONLY: "base",
          },
          headless: {
            command: "/custom/codex-headless",
            args: ["--headless"],
            env: {
              HEADLESS_ONLY: "1",
            },
          },
        },
      },
    }, tmpHome);

    const config = loadUserConfig(tmpHome);
    expect(config.ai_tool_overrides).toEqual({
      codex: {
        command: "/custom/codex",
        args: ["--shared"],
        env: {
          SHARED_ONLY: "base",
        },
        headless: {
          command: "/custom/codex-headless",
          args: ["--headless"],
          env: {
            HEADLESS_ONLY: "1",
          },
        },
      },
    });
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
