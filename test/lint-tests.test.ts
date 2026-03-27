// Static analysis for dangerous test patterns.
// Scans all test/*.test.ts files and fails if dangerous patterns are found.
// This runs as part of the regular test suite — auto-enforced in pre-commit and CI.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = import.meta.dirname;

// ── Helpers ──────────────────────────────────────────────────────────

/** Read all test files in the test directory (excluding this file). */
function getTestFiles(): { name: string; content: string; path: string }[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts") && f !== "lint-tests.test.ts")
    .map((f) => ({
      name: f,
      content: readFileSync(join(TEST_DIR, f), "utf-8"),
      path: join(TEST_DIR, f),
    }));
}

/** Check if a line is inside a string literal (heuristic). */
function isInsideString(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex);
  // Count unescaped quotes before the match
  const singleQuotes = (before.match(/(?<!\\)'/g) || []).length;
  const doubleQuotes = (before.match(/(?<!\\)"/g) || []).length;
  const backticks = (before.match(/(?<!\\)`/g) || []).length;
  // If any quote type has an odd count, we're inside a string
  return singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backticks % 2 === 1;
}

/** Check if a line or the previous line has a lint-ignore comment for the given rule. */
function isIgnored(lines: string[], lineIndex: number, ruleId: string): boolean {
  const ignorePattern = `lint-ignore: ${ruleId}`;
  if (lines[lineIndex]?.includes(ignorePattern)) return true;
  if (lineIndex > 0 && lines[lineIndex - 1]?.includes(ignorePattern)) return true;
  return false;
}

// ── Rule definitions ─────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

function checkNoLeakedServer(
  file: { name: string; content: string },
): Violation[] {
  const violations: Violation[] = [];
  const lines = file.content.split("\n");

  // Find lines with Bun.serve( calls
  const serverPatterns = [/Bun\.serve\s*\(/];
  let hasServerCall = false;
  const serverCallLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of serverPatterns) {
      const match = pattern.exec(lines[i]!);
      if (match && !isInsideString(lines[i]!, match.index) && !isIgnored(lines, i, "no-leaked-server")) {
        hasServerCall = true;
        serverCallLines.push(i + 1);
      }
    }
  }

  if (!hasServerCall) return violations;

  // Check for .stop() in afterEach or afterAll
  const hasCleanup = /(?:afterEach|afterAll)\s*\([\s\S]*?\.stop\s*\(/m.test(file.content);

  if (!hasCleanup) {
    for (const line of serverCallLines) {
      violations.push({
        file: file.name,
        line,
        rule: "no-leaked-server",
        message: "Server created without .stop() in afterEach/afterAll — will leak and hang the process",
      });
    }
  }

  return violations;
}

function checkNoUnclearedInterval(
  file: { name: string; content: string },
): Violation[] {
  const violations: Violation[] = [];
  const lines = file.content.split("\n");
  const pattern = /setInterval\s*\(/;
  let hasInterval = false;
  const intervalLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!);
    if (match && !isInsideString(lines[i]!, match.index) && !isIgnored(lines, i, "no-uncleared-interval")) {
      hasInterval = true;
      intervalLines.push(i + 1);
    }
  }

  if (!hasInterval) return violations;

  // Check for clearInterval in afterEach/afterAll or in the same file scope
  const hasClear = /clearInterval\s*\(/.test(file.content);

  if (!hasClear) {
    for (const line of intervalLines) {
      violations.push({
        file: file.name,
        line,
        rule: "no-uncleared-interval",
        message: "setInterval() without clearInterval() — will keep the process alive forever",
      });
    }
  }

  return violations;
}

function checkNoLongTimeout(
  file: { name: string; content: string },
): Violation[] {
  const violations: Violation[] = [];
  const lines = file.content.split("\n");
  const pattern = /setTimeout\s*\([^,]+,\s*(\d+)\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!);
    if (match && !isInsideString(lines[i]!, match.index) && !isIgnored(lines, i, "no-long-timeout")) {
      const delay = parseInt(match[1]!, 10);
      if (delay > 30_000) {
        violations.push({
          file: file.name,
          line: i + 1,
          rule: "no-long-timeout",
          message: `setTimeout with ${delay}ms delay (max 30000) — will hang the test process`,
        });
      }
    }
  }

  return violations;
}

function checkNoUnresetGlobals(
  file: { name: string; content: string },
): Violation[] {
  const violations: Violation[] = [];
  const lines = file.content.split("\n");
  const pattern = /globalThis\.(setTimeout|setInterval|fetch)\s*=/;
  let hasOverride = false;
  const overrideLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!);
    if (match && !isInsideString(lines[i]!, match.index) && !isIgnored(lines, i, "no-unreset-globals")) {
      hasOverride = true;
      overrideLines.push(i + 1);
    }
  }

  if (!hasOverride) return violations;

  // Check for restore in finally or afterEach
  const hasRestore =
    /finally\s*\{[\s\S]*?globalThis\.(setTimeout|setInterval|fetch)\s*=/m.test(file.content) ||
    /(?:afterEach|afterAll)\s*\([\s\S]*?globalThis\.(setTimeout|setInterval|fetch)\s*=/m.test(file.content);

  if (!hasRestore) {
    for (const line of overrideLines) {
      violations.push({
        file: file.name,
        line,
        rule: "no-unreset-globals",
        message: "globalThis override without restore in finally/afterEach — will leak to other tests",
      });
    }
  }

  return violations;
}

function checkNoUnrestoredProcessExit(
  file: { name: string; content: string },
): Violation[] {
  const violations: Violation[] = [];
  const lines = file.content.split("\n");
  const pattern = /process\.exit\s*=/;
  let hasOverride = false;
  const overrideLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!);
    if (match && !isInsideString(lines[i]!, match.index) && !isIgnored(lines, i, "no-unrestored-process-exit")) {
      hasOverride = true;
      overrideLines.push(i + 1);
    }
  }

  if (!hasOverride) return violations;

  // Check for restore in finally, afterEach, or afterAll
  const hasRestore =
    /finally\s*\{[\s\S]*?process\.exit\s*=/m.test(file.content) ||
    /(?:afterEach|afterAll)\s*\([\s\S]*?process\.exit\s*=/m.test(file.content);

  if (!hasRestore) {
    for (const line of overrideLines) {
      violations.push({
        file: file.name,
        line,
        rule: "no-unrestored-process-exit",
        message: "process.exit override without restore in finally/afterEach/afterAll — disables test safety guards for all subsequent test files",
      });
    }
  }

  return violations;
}

function checkNoUnboundedOrchestrateLoop(
  file: { name: string; content: string },
): Violation[] {
  const violations: Violation[] = [];
  if (!file.content.includes("orchestrateLoop")) return violations;

  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/orchestrateLoop\s*\(/.test(lines[i]!) && !isIgnored(lines, i, "no-unbounded-orchestrate-loop")) {
      // Check surrounding context (10 lines before, 5 lines after) for maxIterations
      const context = lines.slice(Math.max(0, i - 10), Math.min(lines.length, i + 6)).join("\n");
      if (!context.includes("maxIterations")) {
        violations.push({
          file: file.name,
          line: i + 1,
          rule: "no-unbounded-orchestrate-loop",
          message:
            "orchestrateLoop() without maxIterations — a stuck loop starves macrotask timers " +
            "(setTimeout/setInterval) so even SIGKILL guards never fire",
        });
      }
    }
  }

  return violations;
}

// ── Run all rules ────────────────────────────────────────────────────

function runAllRules(files: { name: string; content: string }[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    violations.push(
      ...checkNoLeakedServer(file),
      ...checkNoUnclearedInterval(file),
      ...checkNoLongTimeout(file),
      ...checkNoUnresetGlobals(file),
      ...checkNoUnrestoredProcessExit(file),
      ...checkNoUnboundedOrchestrateLoop(file),
    );
  }
  return violations;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("test lint rules", () => {
  describe("scan real test files", () => {
    it("all test files pass lint rules", () => {
      const files = getTestFiles();
      const violations = runAllRules(files);

      if (violations.length > 0) {
        const report = violations
          .map((v) => `  ${v.file}:${v.line} ${v.rule}: ${v.message}`)
          .join("\n");
        expect.unreachable(
          `Test lint violations found:\n${report}\n\n` +
            `Fix the violations above or add // lint-ignore: <rule-id> to suppress.`,
        );
      }
    });
  });

  describe("preload verification", () => {
    it("setup-global.ts preload is active", () => {
      expect((globalThis as any).__nw_test_safety_loaded).toBe(true);
    });
  });

  // ── Inline fixture tests ─────────────────────────────────────────

  describe("no-leaked-server", () => {
    it("detects Bun.serve without cleanup", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
import { describe, it } from "vitest";
describe("test", () => {
  it("starts a server", () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  });
});`,
      };
      const violations = checkNoLeakedServer(file);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("no-leaked-server");
    });

    it("passes when afterEach has .stop()", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
import { describe, it, afterEach } from "vitest";
const servers = [];
afterEach(() => { for (const s of servers) s.stop(); });
describe("test", () => {
  it("starts a server", () => {
    servers.push(Bun.serve({ port: 0, fetch: () => new Response("ok") }));
  });
});`,
      };
      const violations = checkNoLeakedServer(file);
      expect(violations.length).toBe(0);
    });

    it("ignores string literals", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("checks output", () => {
    expect(output).toContain("Bun.serve(");
  });
});`,
      };
      const violations = checkNoLeakedServer(file);
      expect(violations.length).toBe(0);
    });

    it("respects lint-ignore comment", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("starts a server", () => {
    // lint-ignore: no-leaked-server
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  });
});`,
      };
      const violations = checkNoLeakedServer(file);
      expect(violations.length).toBe(0);
    });
  });

  describe("no-uncleared-interval", () => {
    it("detects setInterval without clearInterval", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("polls forever", () => {
    setInterval(() => console.log("tick"), 1000);
  });
});`,
      };
      const violations = checkNoUnclearedInterval(file);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("no-uncleared-interval");
    });

    it("passes when clearInterval is present", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
let timer;
afterEach(() => { clearInterval(timer); });
describe("test", () => {
  it("polls", () => {
    timer = setInterval(() => console.log("tick"), 1000);
  });
});`,
      };
      const violations = checkNoUnclearedInterval(file);
      expect(violations.length).toBe(0);
    });

    it("ignores string literals", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("checks html", () => {
    expect(html).toContain("setInterval(");
  });
});`,
      };
      const violations = checkNoUnclearedInterval(file);
      expect(violations.length).toBe(0);
    });
  });

  describe("no-long-timeout", () => {
    it("detects setTimeout with delay > 30000", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("waits too long", () => {
    setTimeout(() => {}, 60000);
  });
});`,
      };
      const violations = checkNoLongTimeout(file);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("no-long-timeout");
    });

    it("passes for reasonable delays", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("waits briefly", () => {
    setTimeout(() => {}, 5000);
  });
});`,
      };
      const violations = checkNoLongTimeout(file);
      expect(violations.length).toBe(0);
    });
  });

  describe("no-unreset-globals", () => {
    it("detects globalThis override without restore", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("patches setTimeout", () => {
    globalThis.setTimeout = () => {};
  });
});`,
      };
      const violations = checkNoUnresetGlobals(file);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("no-unreset-globals");
    });

    it("passes when restore is in finally", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => {
  it("patches setTimeout", () => {
    const orig = globalThis.setTimeout;
    globalThis.setTimeout = () => {};
    try {
      doSomething();
    } finally {
      globalThis.setTimeout = orig;
    }
  });
});`,
      };
      const violations = checkNoUnresetGlobals(file);
      expect(violations.length).toBe(0);
    });

    it("passes when restore is in afterEach", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
let orig;
beforeEach(() => { orig = globalThis.fetch; globalThis.fetch = mockFetch; });
afterEach(() => { globalThis.fetch = orig; });
describe("test", () => {
  it("uses mock fetch", () => {});
});`,
      };
      const violations = checkNoUnresetGlobals(file);
      expect(violations.length).toBe(0);
    });
  });

  describe("no-unrestored-process-exit", () => {
    it("detects process.exit override without restore", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
const origExit = process.exit;
beforeAll(() => {
  process.exit = (() => { throw new Error("exit"); }) as any;
});
describe("test", () => {
  it("calls die()", () => {});
});`,
      };
      const violations = checkNoUnrestoredProcessExit(file);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("no-unrestored-process-exit");
    });

    it("passes when restore is in afterAll", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
const origExit = process.exit;
beforeAll(() => {
  process.exit = (() => { throw new Error("exit"); }) as any;
});
afterAll(() => {
  process.exit = origExit;
});`,
      };
      const violations = checkNoUnrestoredProcessExit(file);
      expect(violations.length).toBe(0);
    });

    it("passes when restore is in finally", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
const origExit = process.exit;
process.exit = (() => { throw new Error("exit"); }) as any;
try {
  doStuff();
} finally {
  process.exit = origExit;
}`,
      };
      const violations = checkNoUnrestoredProcessExit(file);
      expect(violations.length).toBe(0);
    });
  });

  describe("no-unbounded-orchestrate-loop", () => {
    it("detects orchestrateLoop without maxIterations", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
await orchestrateLoop(orch, ctx, deps);`,
      };
      const violations = checkNoUnboundedOrchestrateLoop(file);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("no-unbounded-orchestrate-loop");
    });

    it("passes when maxIterations is present", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
await orchestrateLoop(orch, ctx, deps, { maxIterations: 200 });`,
      };
      const violations = checkNoUnboundedOrchestrateLoop(file);
      expect(violations.length).toBe(0);
    });

    it("passes when maxIterations is in config spread", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
await orchestrateLoop(orch, ctx, deps, { ...config, maxIterations: 200 });`,
      };
      const violations = checkNoUnboundedOrchestrateLoop(file);
      expect(violations.length).toBe(0);
    });

    it("ignores files without orchestrateLoop", () => {
      const file = {
        name: "fixture.test.ts",
        content: `
describe("test", () => { it("works", () => {}); });`,
      };
      const violations = checkNoUnboundedOrchestrateLoop(file);
      expect(violations.length).toBe(0);
    });
  });
});
