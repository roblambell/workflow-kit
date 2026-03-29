import { describe, it, expect } from "vitest";
import { getAvailableMemory } from "../core/memory.ts";

describe("getAvailableMemory", () => {
  it("returns a positive number", () => {
    const mem = getAvailableMemory();
    expect(mem).toBeGreaterThan(0);
    expect(typeof mem).toBe("number");
  });

  it("returns a value >= os.freemem()", () => {
    // On macOS, getAvailableMemory includes inactive pages so it should be
    // >= os.freemem(). On other platforms they should be equal.
    const { freemem } = require("os");
    const available = getAvailableMemory();
    const free = freemem();
    expect(available).toBeGreaterThanOrEqual(free);
  });

  it("is re-exported from orchestrate.ts for backward compatibility", async () => {
    const orchestrate = await import("../core/commands/orchestrate.ts");
    expect(typeof orchestrate.getAvailableMemory).toBe("function");
    // Verify it's the same function
    expect(orchestrate.getAvailableMemory).toBe(getAvailableMemory);
  });
});
