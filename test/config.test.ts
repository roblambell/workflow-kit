// Tests for project config loading.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { loadConfig, loadDomainMappings } from "../core/config.ts";
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
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "domains.conf"),
      "infrastructure=infra\n",
    );

    const domainsFile = join(configDir, "domains.conf");
    expect(normalizeDomain("Cloud Infrastructure", domainsFile)).toBe("infra");
  });

  it("falls back to auto-slugify when no mapping matches", () => {
    const { normalizeDomain } = require("../core/parser.ts");
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "domains.conf"),
      "auth=auth\n",
    );

    const domainsFile = join(configDir, "domains.conf");
    expect(normalizeDomain("User Onboarding", domainsFile)).toBe(
      "user-onboarding",
    );
  });
});
