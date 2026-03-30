import { describe, it, expect } from "vitest";

import { parseAgentModel } from "../core/agent-files.ts";

describe("parseAgentModel", () => {
  it("returns the model from YAML frontmatter", () => {
    expect(parseAgentModel("---\nmodel: opus\n---\n..."))
      .toBe("opus");
  });

  it("returns null when frontmatter has no model", () => {
    expect(parseAgentModel("---\nname: ninthwave-implementer\n---\n..."))
      .toBeNull();
  });

  it("returns null when the file has no frontmatter", () => {
    expect(parseAgentModel("# Agent\nmodel: opus\n"))
      .toBeNull();
  });
});
