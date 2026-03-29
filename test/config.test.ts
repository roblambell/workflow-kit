// Tests for project config loading.

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { loadConfig, KNOWN_CONFIG_KEYS } from "../core/config.ts";
import { DEFAULT_LOC_EXTENSIONS } from "../core/types.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

describe("loadConfig", () => {
  it("returns defaults when config file is missing", () => {
    const repo = setupTempRepo();
    const config = loadConfig(repo);
    expect(config.locExtensions).toBe(DEFAULT_LOC_EXTENSIONS);
  });

  it("loads key=value pairs into typed fields", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      'review_external=true\ngithub_token="ghp_abc"\n',
    );

    const config = loadConfig(repo);
    expect(config.reviewExternal).toBe("true");
    expect(config.githubToken).toBe("ghp_abc");
  });

  it("skips comments and blank lines", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "# this is a comment\n\nreview_external=true\n",
    );

    const config = loadConfig(repo);
    expect(config.reviewExternal).toBe("true");
  });

  it("applies LOC_EXTENSIONS from config", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "LOC_EXTENSIONS=*.ts *.tsx\n",
    );

    const config = loadConfig(repo);
    expect(config.locExtensions).toBe("*.ts *.tsx");
  });

  it("strips surrounding quotes from values", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "review_external='true'\ngithub_token=\"ghp_tok\"\nschedule_enabled=false\n",
    );

    const config = loadConfig(repo);
    expect(config.reviewExternal).toBe("true");
    expect(config.githubToken).toBe("ghp_tok");
    expect(config.scheduleEnabled).toBe("false");
  });

  it("does not warn for known config keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "LOC_EXTENSIONS=*.ts\nreview_external=true\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(repo);
      expect(config.locExtensions).toBe("*.ts");
      expect(config.reviewExternal).toBe("true");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not store unknown keys on config object", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "TYPO_KEY=oops\nLOC_EXTENSIONS=*.ts\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(repo);
      expect(Object.keys(config)).not.toContain("TYPO_KEY");
      expect(config.locExtensions).toBe("*.ts");
    } finally {
      spy.mockRestore();
    }
  });

  it("loads all four typed fields correctly", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "LOC_EXTENSIONS=*.rs\nreview_external=true\ngithub_token=ghp_abc\nschedule_enabled=true\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(repo);
      expect(config.locExtensions).toBe("*.rs");
      expect(config.reviewExternal).toBe("true");
      expect(config.githubToken).toBe("ghp_abc");
      expect(config.scheduleEnabled).toBe("true");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("warns on unknown config keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "LOC_EXTENSIONS=*.ts\nTYPO_KEY=oops\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadConfig(repo);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toContain("TYPO_KEY");
    } finally {
      spy.mockRestore();
    }
  });

  it("warns on each unknown key individually", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "UNKNOWN_A=1\nUNKNOWN_B=2\nLOC_EXTENSIONS=*.ts\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadConfig(repo);
      expect(spy).toHaveBeenCalledTimes(2);
      const messages = spy.mock.calls.map((c) => c[0]);
      expect(messages.some((m: string) => m.includes("UNKNOWN_A"))).toBe(true);
      expect(messages.some((m: string) => m.includes("UNKNOWN_B"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("KNOWN_CONFIG_KEYS", () => {
  it("includes LOC_EXTENSIONS and review_external", () => {
    expect(KNOWN_CONFIG_KEYS.has("LOC_EXTENSIONS")).toBe(true);
    expect(KNOWN_CONFIG_KEYS.has("review_external")).toBe(true);
  });

  it("includes github_token config key", () => {
    expect(KNOWN_CONFIG_KEYS.has("github_token")).toBe(true);
  });

  it("does not include removed config keys", () => {
    expect(KNOWN_CONFIG_KEYS.has("webhook_url")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("CLICKUP_LIST_ID")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("sentry_org")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("remote_sessions")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("review_enabled")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("review_wip_limit")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("review_auto_fix")).toBe(false);
    expect(KNOWN_CONFIG_KEYS.has("review_can_approve")).toBe(false);
  });

  it("does not warn on review_external config key", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "review_external=true\ngithub_token=ghp_test\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(repo);
      expect(config.reviewExternal).toBe("true");
      expect(config.githubToken).toBe("ghp_test");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

