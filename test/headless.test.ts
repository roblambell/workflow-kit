import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HeadlessAdapter,
  headlessLogDir,
  headlessLogFilePath,
  headlessPidDir,
  headlessPidFilePath,
  headlessPhaseFilePath,
  writeHeadlessPhase,
  readHeadlessPhase,
  cleanHeadlessPhase,
} from "../core/headless.ts";

describe("HeadlessAdapter", () => {
  const originalHome = process.env.HOME;
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProjectRoot(): string {
    const homeDir = mkdtempSync(join(tmpdir(), "nw-headless-home-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "nw-headless-project-"));
    tempDirs.push(homeDir, projectRoot);
    process.env.HOME = homeDir;
    return projectRoot;
  }

  it("launchWorkspace spawns detached worker, writes pid file, and returns workItemId ref", () => {
    const projectRoot = makeProjectRoot();
    const child = { pid: 4242, unref: vi.fn() } as any;
    const spawn = vi.fn(() => child) as any;
    const adapter = new HeadlessAdapter(projectRoot, { spawn });

    const ref = adapter.launchWorkspace("/tmp/worktree", "bun run worker", "H-RSH-4");

    expect(ref).toBe("headless:H-RSH-4");
    expect(child.unref).toHaveBeenCalled();
    expect(readFileSync(headlessPidFilePath(projectRoot, ref!), "utf-8")).toBe("4242");
    expect(existsSync(headlessLogDir(projectRoot))).toBe(true);
    expect(existsSync(headlessPidDir(projectRoot))).toBe(true);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("sh", ["-c", "bun run worker"], expect.objectContaining({
      cwd: "/tmp/worktree",
      detached: true,
      stdio: ["ignore", expect.any(Number), expect.any(Number)],
    }));
  });

  it("launchWorkspace returns null when spawn throws", () => {
    const projectRoot = makeProjectRoot();
    const spawn = vi.fn(() => {
      throw new Error("spawn failed");
    }) as any;
    const adapter = new HeadlessAdapter(projectRoot, { spawn });

    const ref = adapter.launchWorkspace("/tmp/worktree", "bun run worker", "H-RSH-4");

    expect(ref).toBeNull();
    expect(existsSync(headlessPidFilePath(projectRoot, "H-RSH-4"))).toBe(false);
  });

  it("readScreen reads the last N log lines and returns empty string for missing logs", () => {
    const projectRoot = makeProjectRoot();
    const adapter = new HeadlessAdapter(projectRoot);
    mkdirSync(headlessLogDir(projectRoot), { recursive: true });
    writeFileSync(headlessLogFilePath(projectRoot, "H-RSH-4"), "one\ntwo\nthree\nfour\n");

    expect(adapter.readScreen("headless:H-RSH-4", 2)).toBe("three\nfour");
    expect(adapter.readScreen("missing", 2)).toBe("");
  });

  it("listWorkspaces returns live refs and cleans stale pid files", () => {
    const projectRoot = makeProjectRoot();
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 202) {
        const err = new Error("missing") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    }) as unknown as typeof process.kill;
    const adapter = new HeadlessAdapter(projectRoot, { kill });

    mkdirSync(headlessPidDir(projectRoot), { recursive: true });
    writeFileSync(headlessPidFilePath(projectRoot, "H-ALIVE-1"), "101");
    writeFileSync(headlessPidFilePath(projectRoot, "H-DEAD-1"), "202");

    expect(adapter.listWorkspaces()).toBe("headless:H-ALIVE-1");
    expect(existsSync(headlessPidFilePath(projectRoot, "H-ALIVE-1"))).toBe(true);
    expect(existsSync(headlessPidFilePath(projectRoot, "H-DEAD-1"))).toBe(false);
  });

  it("closeWorkspace sends SIGTERM and removes pid file", () => {
    const projectRoot = makeProjectRoot();
    let alive = true;
    const kill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        expect(pid).toBe(101);
        if (!alive) {
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return;
      }
      if (signal === "SIGTERM") {
        expect(pid).toBe(-101);
        alive = false;
      }
    }) as unknown as typeof process.kill;
    const sleep = vi.fn();
    const adapter = new HeadlessAdapter(projectRoot, { kill, sleep });

    mkdirSync(headlessPidDir(projectRoot), { recursive: true });
    writeFileSync(headlessPidFilePath(projectRoot, "H-RSH-4"), "101");

    expect(adapter.closeWorkspace("headless:H-RSH-4")).toBe(true);
    expect(kill).toHaveBeenCalledWith(-101, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-101, "SIGKILL");
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(existsSync(headlessPidFilePath(projectRoot, "H-RSH-4"))).toBe(false);
  });

  it("closeWorkspace cleans pid file and returns true when process already exited", () => {
    const projectRoot = makeProjectRoot();
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        const err = new Error("missing") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    }) as unknown as typeof process.kill;
    const adapter = new HeadlessAdapter(projectRoot, { kill });

    mkdirSync(headlessPidDir(projectRoot), { recursive: true });
    writeFileSync(headlessPidFilePath(projectRoot, "H-RSH-4"), "101");

    expect(adapter.closeWorkspace("headless:H-RSH-4")).toBe(true);
    expect(kill).not.toHaveBeenCalledWith(-101, "SIGTERM");
    expect(existsSync(headlessPidFilePath(projectRoot, "H-RSH-4"))).toBe(false);
  });

  it("no-op methods return false", () => {
    const projectRoot = makeProjectRoot();
    const adapter = new HeadlessAdapter(projectRoot);

    expect(adapter.splitPane("pwd")).toBeNull();
    expect(adapter.setStatus("H-RSH-4", "build", "Building", "hammer", "#fff")).toBe(false);
    expect(adapter.setProgress("H-RSH-4", 0.5, "Halfway")).toBe(false);
  });

  // ── Phase file tests ────────────────────────────────────────────────

  it("writeHeadlessPhase creates phase file and readHeadlessPhase reads it back", () => {
    const projectRoot = makeProjectRoot();

    writeHeadlessPhase(projectRoot, "H-PH-1", "starting");
    expect(readHeadlessPhase(projectRoot, "H-PH-1")).toBe("starting");

    writeHeadlessPhase(projectRoot, "H-PH-1", "implementing");
    expect(readHeadlessPhase(projectRoot, "H-PH-1")).toBe("implementing");

    writeHeadlessPhase(projectRoot, "H-PH-1", "waiting");
    expect(readHeadlessPhase(projectRoot, "H-PH-1")).toBe("waiting");
  });

  it("readHeadlessPhase returns null when no phase file exists", () => {
    const projectRoot = makeProjectRoot();
    expect(readHeadlessPhase(projectRoot, "H-NOPE-1")).toBeNull();
  });

  it("readHeadlessPhase returns null for invalid phase content", () => {
    const projectRoot = makeProjectRoot();
    const phasePath = headlessPhaseFilePath(projectRoot, "H-BAD-1");
    mkdirSync(join(phasePath, ".."), { recursive: true });
    writeFileSync(phasePath, "bogus-phase");
    expect(readHeadlessPhase(projectRoot, "H-BAD-1")).toBeNull();
  });

  it("cleanHeadlessPhase removes the phase file", () => {
    const projectRoot = makeProjectRoot();
    writeHeadlessPhase(projectRoot, "H-CL-1", "implementing");
    expect(existsSync(headlessPhaseFilePath(projectRoot, "H-CL-1"))).toBe(true);

    cleanHeadlessPhase(projectRoot, "H-CL-1");
    expect(existsSync(headlessPhaseFilePath(projectRoot, "H-CL-1"))).toBe(false);
    expect(readHeadlessPhase(projectRoot, "H-CL-1")).toBeNull();
  });

  it("cleanHeadlessPhase is a no-op when phase file does not exist", () => {
    const projectRoot = makeProjectRoot();
    expect(() => cleanHeadlessPhase(projectRoot, "H-NOPE-1")).not.toThrow();
  });

  it("closeWorkspace cleans pid file but preserves phase file for recovery", () => {
    const projectRoot = makeProjectRoot();
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        const err = new Error("missing") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    }) as unknown as typeof process.kill;
    const adapter = new HeadlessAdapter(projectRoot, { kill });

    mkdirSync(headlessPidDir(projectRoot), { recursive: true });
    writeFileSync(headlessPidFilePath(projectRoot, "H-PH-2"), "303");
    writeHeadlessPhase(projectRoot, "H-PH-2", "waiting");

    expect(adapter.closeWorkspace("headless:H-PH-2")).toBe(true);
    expect(existsSync(headlessPidFilePath(projectRoot, "H-PH-2"))).toBe(false);
    // Phase file survives closeWorkspace so the orchestrator can read it for recovery
    expect(readHeadlessPhase(projectRoot, "H-PH-2")).toBe("waiting");
  });
});
