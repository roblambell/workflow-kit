import { describe, it, expect } from "vitest";
import { splitIds } from "../core/work-item-utils.ts";

describe("splitIds", () => {
  it("passes through space-separated IDs unchanged", () => {
    expect(splitIds(["H-PRX-4", "H-PRX-5", "H-PRX-6"])).toEqual([
      "H-PRX-4",
      "H-PRX-5",
      "H-PRX-6",
    ]);
  });

  it("splits comma-separated IDs", () => {
    expect(splitIds(["H-PRX-4,H-PRX-5,H-PRX-6"])).toEqual([
      "H-PRX-4",
      "H-PRX-5",
      "H-PRX-6",
    ]);
  });

  it("handles mixed comma and space-separated IDs", () => {
    expect(splitIds(["H-PRX-4,H-PRX-5", "H-PRX-6"])).toEqual([
      "H-PRX-4",
      "H-PRX-5",
      "H-PRX-6",
    ]);
  });

  it("filters empty strings from trailing commas", () => {
    expect(splitIds(["H-PRX-4,"])).toEqual(["H-PRX-4"]);
  });

  it("filters empty strings from leading commas", () => {
    expect(splitIds([",H-PRX-4"])).toEqual(["H-PRX-4"]);
  });

  it("filters empty strings from double commas", () => {
    expect(splitIds(["H-PRX-4,,H-PRX-5"])).toEqual([
      "H-PRX-4",
      "H-PRX-5",
    ]);
  });

  it("trims whitespace around IDs", () => {
    expect(splitIds(["H-PRX-4 , H-PRX-5"])).toEqual([
      "H-PRX-4",
      "H-PRX-5",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(splitIds([])).toEqual([]);
  });

  it("returns empty array for only-whitespace/comma args", () => {
    expect(splitIds([",", " , ", ""])).toEqual([]);
  });

  it("handles single ID", () => {
    expect(splitIds(["H-PRX-4"])).toEqual(["H-PRX-4"]);
  });
});
