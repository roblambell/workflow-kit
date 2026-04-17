// Tests for TUI settings default resolution.
//
// Startup defaults are deliberately hardcoded so every session begins in the
// safest, lossless state. Previously `resolveTuiSettingsDefaults` consulted
// user and per-repo config overlays for merge strategy, review mode, and
// collaboration mode; those knobs have since been removed.

import { describe, it, expect } from "vitest";
import {
  resolveTuiSettingsDefaults,
  TUI_SETTINGS_DEFAULTS,
} from "../core/tui-settings.ts";

describe("resolveTuiSettingsDefaults", () => {
  it("returns the hardcoded defaults", () => {
    const result = resolveTuiSettingsDefaults();
    expect(result).toEqual(TUI_SETTINGS_DEFAULTS);
  });

  it("hardcoded defaults are manual merge, reviews off, local collaboration", () => {
    expect(TUI_SETTINGS_DEFAULTS).toEqual({
      mergeStrategy: "manual",
      reviewMode: "off",
      collaborationMode: "local",
    });
  });

  it("returns a fresh copy each call so callers cannot mutate the constant", () => {
    const a = resolveTuiSettingsDefaults();
    const b = resolveTuiSettingsDefaults();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
