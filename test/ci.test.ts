// Tests for ci-failures command.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";

// Mock gh module (no dedicated test file)
vi.mock("../core/gh.ts", () => ({
  prChecks: vi.fn(() => []),
}));

// Import mocked module for assertions
import * as gh from "../core/gh.ts";

// Import after mocks
import { cmdCiFailures } from "../core/commands/ci.ts";

function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never;

  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof Error && !e.message.startsWith("EXIT:")) throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return lines.join("\n");
}

describe("cmdCiFailures", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanupTempRepos());

  it("dies without PR number argument", () => {
    const repo = setupTempRepo();

    const output = captureOutput(() =>
      cmdCiFailures([], repo),
    );

    expect(output).toContain("Usage");
  });

  it("reports no failing checks when all pass", () => {
    const repo = setupTempRepo();

    (gh.prChecks as Mock).mockReturnValue([
      { state: "SUCCESS", name: "build", url: "https://example.com/1" },
      { state: "SUCCESS", name: "lint", url: "https://example.com/2" },
    ]);

    const output = captureOutput(() =>
      cmdCiFailures(["42"], repo),
    );

    expect(output).toContain("No failing checks");
  });

  it("lists failing checks with name and URL", () => {
    const repo = setupTempRepo();

    (gh.prChecks as Mock).mockReturnValue([
      { state: "FAILURE", name: "test-suite", url: "https://ci.example.com/run/1" },
      { state: "SUCCESS", name: "lint", url: "https://ci.example.com/run/2" },
      { state: "FAILURE", name: "type-check", url: "https://ci.example.com/run/3" },
    ]);

    const output = captureOutput(() =>
      cmdCiFailures(["99"], repo),
    );

    expect(output).toContain("test-suite");
    expect(output).toContain("https://ci.example.com/run/1");
    expect(output).toContain("type-check");
    expect(output).toContain("https://ci.example.com/run/3");
    // Should not contain passing checks
    expect(output).not.toContain("lint");
  });

  it("handles empty checks list", () => {
    const repo = setupTempRepo();

    (gh.prChecks as Mock).mockReturnValue([]);

    const output = captureOutput(() =>
      cmdCiFailures(["10"], repo),
    );

    expect(output).toContain("No failing checks");
  });
});
