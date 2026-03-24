// Tests for getBundleDir error case.
// Uses the checkExists parameter to avoid module-level fs mocking.

import { describe, it, expect } from "vitest";
import { getBundleDir } from "../core/paths.ts";

describe("getBundleDir error case", () => {
  it("throws when no valid bundle directory is found", () => {
    expect(() => getBundleDir(() => false)).toThrow(
      "Could not find ninthwave bundle directory",
    );
  });
});
