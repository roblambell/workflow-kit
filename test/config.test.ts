// Tests for project config loading.

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { loadConfig, loadDomainMappings, KNOWN_CONFIG_KEYS } from "../core/config.ts";
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

  it("loads key=value pairs from config file", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      'FOO=bar\nBAZ="quoted value"\n',
    );

    const config = loadConfig(repo);
    expect(config["FOO"]).toBe("bar");
    expect(config["BAZ"]).toBe("quoted value");
  });

  it("skips comments and blank lines", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "# this is a comment\n\nKEY=value\n",
    );

    const config = loadConfig(repo);
    expect(config["KEY"]).toBe("value");
    expect(Object.keys(config)).not.toContain("#");
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
      "A='single'\nB=\"double\"\nC=none\n",
    );

    const config = loadConfig(repo);
    expect(config["A"]).toBe("single");
    expect(config["B"]).toBe("double");
    expect(config["C"]).toBe("none");
  });

  it("does not warn for known config keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "LOC_EXTENSIONS=*.ts\nwebhook_url=https://example.com\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(repo);
      expect(config["LOC_EXTENSIONS"]).toBe("*.ts");
      expect(config["webhook_url"]).toBe("https://example.com");
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
  it("includes LOC_EXTENSIONS and webhook_url", () => {
    expect(KNOWN_CONFIG_KEYS.has("LOC_EXTENSIONS")).toBe(true);
    expect(KNOWN_CONFIG_KEYS.has("webhook_url")).toBe(true);
  });

  it("includes review config keys", () => {
    expect(KNOWN_CONFIG_KEYS.has("review_enabled")).toBe(true);
    expect(KNOWN_CONFIG_KEYS.has("review_wip_limit")).toBe(true);
    expect(KNOWN_CONFIG_KEYS.has("review_auto_fix")).toBe(true);
    expect(KNOWN_CONFIG_KEYS.has("review_can_approve")).toBe(true);
  });

  it("does not warn on review config keys", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config"),
      "review_enabled=true\nreview_wip_limit=3\nreview_auto_fix=direct\nreview_can_approve=true\n",
    );

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(repo);
      expect(config["review_enabled"]).toBe("true");
      expect(config["review_auto_fix"]).toBe("direct");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("loadDomainMappings", () => {
  it("returns empty map when domains.conf is missing", () => {
    const repo = setupTempRepo();
    const mappings = loadDomainMappings(repo);
    expect(mappings.size).toBe(0);
  });

  it("loads pattern=domain_key mappings", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "domains.conf"),
      "auth=auth\ninfrastructure=infra\n",
    );

    const mappings = loadDomainMappings(repo);
    expect(mappings.get("auth")).toBe("auth");
    expect(mappings.get("infrastructure")).toBe("infra");
  });

  it("skips comments and blank lines", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "domains.conf"),
      "# comment\n\nfoo=bar\n",
    );

    const mappings = loadDomainMappings(repo);
    expect(mappings.size).toBe(1);
    expect(mappings.get("foo")).toBe("bar");
  });
});

describe("normalizeDomain with custom mappings", () => {
  it("uses domain mapping when pattern matches", () => {
    const { normalizeDomain } = require("../core/parser.ts");
    const mappings = new Map([["infrastructure", "infra"]]);
    expect(normalizeDomain("Cloud Infrastructure", mappings)).toBe("infra");
  });

  it("falls back to auto-slugify when no mapping matches", () => {
    const { normalizeDomain } = require("../core/parser.ts");
    const mappings = new Map([["auth", "auth"]]);
    expect(normalizeDomain("User Onboarding", mappings)).toBe(
      "user-onboarding",
    );
  });
});
