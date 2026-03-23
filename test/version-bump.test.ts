import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

// Polyfill Bun.spawnSync for vitest (runs in Node)
if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    spawnSync(cmd: string[], opts?: { cwd?: string; stdin?: any }) {
      const result = spawnSync(cmd[0]!, cmd.slice(1), {
        cwd: opts?.cwd,
        input: opts?.stdin,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        stdout: Buffer.from(result.stdout ?? ""),
        stderr: Buffer.from(result.stderr ?? ""),
        exitCode: result.status ?? 1,
      };
    },
    sleepSync(_ms: number) {
      // no-op in tests
    },
  };
}

// Import after polyfill
const { cmdVersionBump } = await import(
  "../core/commands/version-bump.ts"
);

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `nw-test-vbump-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
}

/** Set up a git repo on "main" with VERSION and CHANGELOG.md. */
function setupVersionRepo(): string {
  const dir = makeTmpDir();

  git(["-C", dir, "init", "--quiet", "-b", "main"]);
  git(["-C", dir, "config", "user.email", "test@test.com"]);
  git(["-C", dir, "config", "user.name", "Test"]);

  writeFileSync(join(dir, "TODOS.md"), "# TODOS\n");
  writeFileSync(join(dir, "VERSION"), "1.2.3.0\n");
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    `# Changelog

## [1.2.3.0] - 2026-03-01

### Added
- Initial release
`,
  );

  git(["-C", dir, "add", "-A"]);
  git(["-C", dir, "commit", "-m", "chore: initial setup", "--quiet"]);

  return dir;
}

/** Add a source file with N lines to simulate LOC changes. */
function addLocChanges(
  repo: string,
  numLines: number,
  prefix = "feat",
): void {
  mkdirSync(join(repo, "lib"), { recursive: true });
  const filename = `change_${Date.now()}_${Math.random().toString(36).slice(2)}.ex`;
  const file = join(repo, "lib", filename);
  const lines = Array.from(
    { length: numLines },
    (_, i) => `defmodule Line${i + 1} do end`,
  ).join("\n");
  writeFileSync(file, lines + "\n");
  git(["-C", repo, "add", file]);
  git([
    "-C",
    repo,
    "commit",
    "-m",
    `${prefix}: add ${numLines} lines of code`,
    "--quiet",
  ]);
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

// Intercept process.exit so `die()` throws instead of killing the test runner
const origExit = process.exit;
beforeAll(() => {
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as any;
});
afterEach(() => {
  // Restore in case a test needs it
});

describe("cmdVersionBump", { timeout: 30_000 }, () => {
  it("< 50 LOC triggers MICRO bump", () => {
    const repo = setupVersionRepo();
    addLocChanges(repo, 20);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("MICRO");
    expect(output).toContain("1.2.3.1");

    const version = readFileSync(join(repo, "VERSION"), "utf-8").trim();
    expect(version).toBe("1.2.3.1");

    const changelog = readFileSync(join(repo, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("[1.2.3.1]");
  });

  it("50-200 LOC triggers PATCH bump", () => {
    const repo = setupVersionRepo();
    addLocChanges(repo, 100);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("PATCH");
    expect(output).toContain("1.2.4.0");

    const version = readFileSync(join(repo, "VERSION"), "utf-8").trim();
    expect(version).toBe("1.2.4.0");
  });

  it("exactly 50 LOC triggers PATCH bump (boundary)", () => {
    const repo = setupVersionRepo();
    addLocChanges(repo, 50);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("PATCH");
    expect(output).toContain("1.2.4.0");
  });

  it("no commits since last bump reports nothing to do", () => {
    const repo = setupVersionRepo();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No commits since");
  });

  it("changelog categorizes feat as Added, fix as Fixed, refactor as Changed", () => {
    const repo = setupVersionRepo();
    mkdirSync(join(repo, "lib"), { recursive: true });

    writeFileSync(join(repo, "lib", "feat.ex"), "def new_feature, do: :ok\n");
    git(["-C", repo, "add", join(repo, "lib", "feat.ex")]);
    git(["-C", repo, "commit", "-m", "feat: add new feature", "--quiet"]);

    writeFileSync(join(repo, "lib", "fix.ex"), "def fix_bug, do: :ok\n");
    git(["-C", repo, "add", join(repo, "lib", "fix.ex")]);
    git(["-C", repo, "commit", "-m", "fix: resolve timeout bug", "--quiet"]);

    writeFileSync(
      join(repo, "lib", "refactor.ex"),
      "def refactored, do: :better\n",
    );
    git(["-C", repo, "add", join(repo, "lib", "refactor.ex")]);
    git([
      "-C",
      repo,
      "commit",
      "-m",
      "refactor: simplify auth module",
      "--quiet",
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Added");
    expect(output).toContain("new feature");
    expect(output).toContain("Fixed");
    expect(output).toContain("timeout bug");
    expect(output).toContain("Changed");
    expect(output).toContain("auth module");
  });

  it("fails when not on main branch", () => {
    const repo = setupVersionRepo();
    addLocChanges(repo, 10);
    git(["-C", repo, "checkout", "-b", "feature-branch", "--quiet"]);

    // die() calls process.exit which we've patched to throw
    expect(() => cmdVersionBump(repo)).toThrow();
  });

  it("sequential MICRO bumps increment correctly", () => {
    const repo = setupVersionRepo();

    // First bump: 1.2.3.0 -> 1.2.3.1
    addLocChanges(repo, 10);
    const origLog = console.log;
    console.log = () => {};
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const v1 = readFileSync(join(repo, "VERSION"), "utf-8").trim();
    expect(v1).toBe("1.2.3.1");

    // Second bump: 1.2.3.1 -> 1.2.3.2
    addLocChanges(repo, 15);
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(String(msg));
    try {
      cmdVersionBump(repo);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("1.2.3.2");

    const v2 = readFileSync(join(repo, "VERSION"), "utf-8").trim();
    expect(v2).toBe("1.2.3.2");
  });
});
