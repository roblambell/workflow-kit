// Tests for the committed-vs-local override of `broker_secret`.
//
// The broker_secret lives in committed `.ninthwave/config.json` by default so
// all clones of a project share the same identity, but a fork or single
// developer can point at a different broker by dropping a secret into the
// gitignored `.ninthwave/config.local.json` overlay. This file documents
// and enforces that override precedence.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import {
  loadConfig,
  loadLocalConfig,
  loadMergedProjectConfig,
} from "../core/config.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

afterEach(() => {
  cleanupTempRepos();
});

const ZERO_SECRET_A = "A".repeat(43) + "=";
// Base64 for 32 bytes of 0xFF: `/`.repeat(42) + `/w==` doesn't fit our
// format, so we use another canonical round-trip value: 32 bytes of 0x10
// encodes to "EBAQ..." -- computing a canonical 44-char value here keeps
// the test independent of any generator.
// 32 bytes of 0xFF → base64 "/////////////////////////////////////////w==" (44 chars with "==" pad)
// That has "==" padding, which doesn't match our {43}=$ regex, so we
// instead use 32 bytes of 0x08, which yields 43 non-pad chars + single "=".
// Easier: pick a value produced by Node's Buffer on a fixed 32-byte input.
const THIRTY_TWO_EIGHTS_SECRET = Buffer.from(new Uint8Array(32).fill(0x08)).toString("base64");

describe("broker_secret override via config.local.json", () => {
  it("the secret in config.local.json wins over the committed value", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        project_id: "00000000-0000-4000-8000-000000000001",
        broker_secret: ZERO_SECRET_A,
      }),
    );
    writeFileSync(
      join(configDir, "config.local.json"),
      JSON.stringify({
        broker_secret: THIRTY_TWO_EIGHTS_SECRET,
      }),
    );

    // The committed file is untouched by the overlay.
    const shared = loadConfig(repo);
    expect(shared.broker_secret).toBe(ZERO_SECRET_A);

    // The local overlay is parsed independently.
    const local = loadLocalConfig(repo);
    expect(local.broker_secret).toBe(THIRTY_TWO_EIGHTS_SECRET);
    // `project_id` was not overridden locally, so it must not appear in the
    // local overlay's parsed result.
    expect(local.project_id).toBeUndefined();

    // The merged view prefers the local overlay for broker_secret and keeps
    // the committed project_id.
    const merged = loadMergedProjectConfig(repo);
    expect(merged.broker_secret).toBe(THIRTY_TWO_EIGHTS_SECRET);
    expect(merged.project_id).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("a malformed broker_secret in config.local.json is ignored and the committed value is used", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        broker_secret: ZERO_SECRET_A,
      }),
    );
    writeFileSync(
      join(configDir, "config.local.json"),
      JSON.stringify({
        broker_secret: "too-short",
      }),
    );

    const merged = loadMergedProjectConfig(repo);
    expect(merged.broker_secret).toBe(ZERO_SECRET_A);
  });

  it("a broker_secret in config.local.json with no committed counterpart still takes effect", () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.local.json"),
      JSON.stringify({
        broker_secret: THIRTY_TWO_EIGHTS_SECRET,
      }),
    );

    const merged = loadMergedProjectConfig(repo);
    expect(merged.broker_secret).toBe(THIRTY_TWO_EIGHTS_SECRET);
  });
});
