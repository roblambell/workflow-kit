// Tests for bundle directory resolution (core/paths.ts).

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import { getBundleDir } from "../core/paths.ts";

// Store original env and argv
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];

afterEach(() => {
  cleanupTempRepos();
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
});

/**
 * Create the bundle marker structure in a directory.
 */
function createBundleMarker(dir: string): void {
  const skillDir = join(dir, "skills", "decompose");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Decompose Skill\n");
}

describe("getBundleDir", () => {
  describe("NINTHWAVE_HOME env var (priority 1)", () => {
    it("returns NINTHWAVE_HOME when set and valid", () => {
      const tmp = setupTempRepo();
      createBundleMarker(tmp);
      process.env.NINTHWAVE_HOME = tmp;

      expect(getBundleDir()).toBe(tmp);
    });

    it("skips NINTHWAVE_HOME when set but invalid (no marker)", () => {
      const tmp = setupTempRepo();
      // Don't create bundle marker -- directory exists but is not valid
      process.env.NINTHWAVE_HOME = tmp;
      // Ensure binary prefix won't match
      process.argv[0] = "/usr/local/not-a-real-binary";

      // Should fall through to dev resolution (which finds the real repo root)
      const result = getBundleDir();
      expect(result).toBeTruthy();
      expect(existsSync(join(result, "skills", "decompose", "SKILL.md"))).toBe(true);
    });

    it("takes priority over binary prefix resolution", () => {
      const envDir = setupTempRepo();
      const prefixDir = setupTempRepo();
      createBundleMarker(envDir);

      const binDir = join(prefixDir, "bin");
      const shareDir = join(prefixDir, "share", "ninthwave");
      mkdirSync(binDir, { recursive: true });
      createBundleMarker(shareDir);

      process.env.NINTHWAVE_HOME = envDir;
      process.argv[0] = join(binDir, "ninthwave");

      expect(getBundleDir()).toBe(envDir);
    });
  });

  describe("binary install prefix (priority 2)", () => {
    it("resolves from <prefix>/share/ninthwave when binary is at <prefix>/bin/ninthwave", () => {
      const tmp = setupTempRepo();
      const binDir = join(tmp, "bin");
      const shareDir = join(tmp, "share", "ninthwave");
      mkdirSync(binDir, { recursive: true });
      createBundleMarker(shareDir);

      delete process.env.NINTHWAVE_HOME;
      process.argv[0] = join(binDir, "ninthwave");

      expect(getBundleDir()).toBe(shareDir);
    });

    it("skips binary prefix when argv[0] is not in a bin/ directory", () => {
      delete process.env.NINTHWAVE_HOME;
      // argv[0] not in a /bin/ directory -- falls through to dev resolution
      process.argv[0] = "/tmp/ninthwave";

      const result = getBundleDir();
      // Dev fallback should find the real repo root
      expect(result).toBeTruthy();
      expect(existsSync(join(result, "skills", "decompose", "SKILL.md"))).toBe(true);
    });

    it("skips binary prefix when share/ninthwave has no marker", () => {
      const tmp = setupTempRepo();
      const binDir = join(tmp, "bin");
      const shareDir = join(tmp, "share", "ninthwave");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(shareDir, { recursive: true });
      // No bundle marker created in shareDir

      delete process.env.NINTHWAVE_HOME;
      process.argv[0] = join(binDir, "ninthwave");

      // Should fall through to dev resolution
      const result = getBundleDir();
      expect(result).toBeTruthy();
      expect(existsSync(join(result, "skills", "decompose", "SKILL.md"))).toBe(true);
    });
  });

  describe("development fallback (priority 3)", () => {
    it("resolves by walking up from source file to find repo root", () => {
      delete process.env.NINTHWAVE_HOME;
      // Ensure binary prefix won't match
      process.argv[0] = "/usr/local/not-a-real-binary";

      const result = getBundleDir();

      // The repo root should contain the bundle marker
      expect(result).toBeTruthy();
      expect(existsSync(join(result, "skills", "decompose", "SKILL.md"))).toBe(true);
    });
  });
});
