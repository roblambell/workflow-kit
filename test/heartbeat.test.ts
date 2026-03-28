// Tests for core/commands/heartbeat.ts and heartbeat I/O in core/daemon.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cmdHeartbeat,
  extractTodoId,
  parseHeartbeatArgs,
  type HeartbeatArgs,
  type HeartbeatDeps,
} from "../core/commands/heartbeat.ts";
import {
  writeHeartbeat,
  readHeartbeat,
  heartbeatDir,
  heartbeatFilePath,
  userStateDir,
  type DaemonIO,
  type WorkerProgress,
} from "../core/daemon.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockIO(): DaemonIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    writeFileSync: vi.fn((path: string, content: string) => {
      files.set(path, content);
    }),
    readFileSync: vi.fn((path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    unlinkSync: vi.fn((path: string) => {
      files.delete(path);
    }),
    existsSync: vi.fn((path: string) => files.has(path)),
    mkdirSync: vi.fn(),
  };
}

function createDeps(
  io: DaemonIO & { files: Map<string, string> },
  branch: string | null = "todo/H-FOO-1",
): HeartbeatDeps {
  return {
    io,
    getBranch: () => branch,
  };
}

// ── extractTodoId ───────────────────────────────────────────────────

describe("extractTodoId", () => {
  it("extracts ID from todo branch", () => {
    expect(extractTodoId("todo/H-FOO-1")).toBe("H-FOO-1");
  });

  it("extracts complex IDs", () => {
    expect(extractTodoId("todo/M-ORC-3")).toBe("M-ORC-3");
    expect(extractTodoId("todo/L-VIS-12")).toBe("L-VIS-12");
  });

  it("returns null for non-todo branches", () => {
    expect(extractTodoId("main")).toBeNull();
    expect(extractTodoId("feature/something")).toBeNull();
    expect(extractTodoId("todo-H-FOO-1")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractTodoId("")).toBeNull();
  });
});

// ── parseHeartbeatArgs ──────────────────────────────────────────────

describe("parseHeartbeatArgs", () => {
  it("parses --progress and --label", () => {
    const result = parseHeartbeatArgs([
      "--progress",
      "0.5",
      "--label",
      "Writing tests",
    ]);
    expect(result).toEqual({ progress: 0.5, label: "Writing tests" });
  });

  it("accepts 0.0 as progress", () => {
    const result = parseHeartbeatArgs([
      "--progress",
      "0",
      "--label",
      "Starting",
    ]);
    expect(result).toEqual({ progress: 0, label: "Starting" });
  });

  it("accepts 1.0 as progress", () => {
    const result = parseHeartbeatArgs([
      "--progress",
      "1.0",
      "--label",
      "Done",
    ]);
    expect(result).toEqual({ progress: 1.0, label: "Done" });
  });

  it("exits on missing --progress", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--label", "test"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits on missing --label", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--progress", "0.5"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits on progress < 0", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--progress", "-0.1", "--label", "test"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits on progress > 1", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--progress", "1.1", "--label", "test"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits on NaN progress", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--progress", "abc", "--label", "test"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ── writeHeartbeat / readHeartbeat ──────────────────────────────────

describe("writeHeartbeat", () => {
  it("creates file with correct JSON structure", () => {
    const io = createMockIO();
    writeHeartbeat("/project", "H-FOO-1", 0.5, "Writing tests", io);

    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    expect(io.files.has(filePath)).toBe(true);

    const data = JSON.parse(io.files.get(filePath)!) as WorkerProgress;
    expect(data.id).toBe("H-FOO-1");
    expect(data.progress).toBe(0.5);
    expect(data.label).toBe("Writing tests");
    expect(data.ts).toBeDefined();
    // ts should be a valid ISO string
    expect(new Date(data.ts).toISOString()).toBe(data.ts);
  });

  it("creates directory if it does not exist", () => {
    const io = createMockIO();
    writeHeartbeat("/project", "H-FOO-1", 0.3, "test", io);
    expect(io.mkdirSync).toHaveBeenCalledWith(
      heartbeatDir("/project"),
      { recursive: true },
    );
  });
});

describe("readHeartbeat", () => {
  it("returns parsed data from existing file", () => {
    const io = createMockIO();
    writeHeartbeat("/project", "H-FOO-1", 0.7, "Almost done", io);

    const result = readHeartbeat("/project", "H-FOO-1", io);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("H-FOO-1");
    expect(result!.progress).toBe(0.7);
    expect(result!.label).toBe("Almost done");
  });

  it("returns null for missing file", () => {
    const io = createMockIO();
    const result = readHeartbeat("/project", "NONEXISTENT", io);
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const io = createMockIO();
    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    io.files.set(filePath, "not-json");
    const result = readHeartbeat("/project", "H-FOO-1", io);
    expect(result).toBeNull();
  });
});

// ── Path helpers ────────────────────────────────────────────────────

describe("heartbeat path helpers", () => {
  it("heartbeatDir returns correct path", () => {
    const dir = heartbeatDir("/project");
    expect(dir).toBe(`${userStateDir("/project")}/heartbeats`);
  });

  it("heartbeatFilePath returns correct path", () => {
    const path = heartbeatFilePath("/project", "H-FOO-1");
    expect(path).toBe(`${userStateDir("/project")}/heartbeats/H-FOO-1.json`);
  });
});

// ── cmdHeartbeat ────────────────────────────────────────────────────

describe("cmdHeartbeat", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("writes heartbeat file and returns success message", () => {
    const io = createMockIO();
    const deps = createDeps(io, "todo/H-FOO-1");
    const msg = cmdHeartbeat(
      ["--progress", "0.5", "--label", "test"],
      "/project",
      deps,
    );
    expect(msg).toContain("H-FOO-1");
    expect(msg).toContain("50%");
    expect(msg).toContain("test");

    // File should exist
    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    expect(io.files.has(filePath)).toBe(true);
  });

  it("exits on non-todo branch", () => {
    const io = createMockIO();
    const deps = createDeps(io, "main");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    cmdHeartbeat(
      ["--progress", "0.5", "--label", "test"],
      "/project",
      deps,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits when branch detection fails", () => {
    const io = createMockIO();
    const deps = createDeps(io, null);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    cmdHeartbeat(
      ["--progress", "0.5", "--label", "test"],
      "/project",
      deps,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("parses --progress and --label flags correctly", () => {
    const io = createMockIO();
    const deps = createDeps(io, "todo/M-ORC-3");
    cmdHeartbeat(
      ["--progress", "0.3", "--label", "Writing tests"],
      "/project",
      deps,
    );

    const filePath = heartbeatFilePath("/project", "M-ORC-3");
    const data = JSON.parse(io.files.get(filePath)!) as WorkerProgress;
    expect(data.progress).toBe(0.3);
    expect(data.label).toBe("Writing tests");
  });

  it("includes cost fields when --tokens-in, --tokens-out, --model provided", () => {
    const io = createMockIO();
    const deps = createDeps(io, "todo/H-FOO-1");
    cmdHeartbeat(
      ["--progress", "1.0", "--label", "PR created", "--tokens-in", "45000", "--tokens-out", "12000", "--model", "claude-sonnet-4-20250514"],
      "/project",
      deps,
    );

    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    const data = JSON.parse(io.files.get(filePath)!) as WorkerProgress;
    expect(data.model).toBe("claude-sonnet-4-20250514");
    expect(data.inputTokens).toBe(45000);
    expect(data.outputTokens).toBe(12000);
  });

  it("omits cost fields when not provided", () => {
    const io = createMockIO();
    const deps = createDeps(io, "todo/H-FOO-1");
    cmdHeartbeat(
      ["--progress", "0.5", "--label", "test"],
      "/project",
      deps,
    );

    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    const data = JSON.parse(io.files.get(filePath)!) as WorkerProgress;
    expect(data.model).toBeUndefined();
    expect(data.inputTokens).toBeUndefined();
    expect(data.outputTokens).toBeUndefined();
  });
});

// ── parseHeartbeatArgs with cost flags ────────────────────────────

describe("parseHeartbeatArgs with cost flags", () => {
  it("parses --model flag", () => {
    const result = parseHeartbeatArgs([
      "--progress", "1.0",
      "--label", "Done",
      "--model", "claude-sonnet-4-20250514",
    ]);
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("parses --tokens-in flag", () => {
    const result = parseHeartbeatArgs([
      "--progress", "1.0",
      "--label", "Done",
      "--tokens-in", "45000",
    ]);
    expect(result.tokensIn).toBe(45000);
  });

  it("parses --tokens-out flag", () => {
    const result = parseHeartbeatArgs([
      "--progress", "1.0",
      "--label", "Done",
      "--tokens-out", "12000",
    ]);
    expect(result.tokensOut).toBe(12000);
  });

  it("parses all cost flags together", () => {
    const result = parseHeartbeatArgs([
      "--progress", "1.0",
      "--label", "PR created",
      "--tokens-in", "50000",
      "--tokens-out", "15000",
      "--model", "gpt-4o",
    ]);
    expect(result.tokensIn).toBe(50000);
    expect(result.tokensOut).toBe(15000);
    expect(result.model).toBe("gpt-4o");
  });

  it("omits cost fields when not provided", () => {
    const result = parseHeartbeatArgs([
      "--progress", "0.5",
      "--label", "test",
    ]);
    expect(result.model).toBeUndefined();
    expect(result.tokensIn).toBeUndefined();
    expect(result.tokensOut).toBeUndefined();
  });

  it("exits on negative --tokens-in", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--progress", "1.0", "--label", "test", "--tokens-in", "-5"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits on non-numeric --tokens-out", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    parseHeartbeatArgs(["--progress", "1.0", "--label", "test", "--tokens-out", "abc"]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ── writeHeartbeat with cost fields ─────────────────────────────────

describe("writeHeartbeat with cost fields", () => {
  it("includes cost fields in JSON when provided", () => {
    const io = createMockIO();
    const { writeHeartbeat: wh } = require("../core/daemon.ts");
    wh("/project", "H-FOO-1", 1.0, "Done", io, {
      model: "claude-sonnet-4-20250514",
      inputTokens: 45000,
      outputTokens: 12000,
    });

    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    const data = JSON.parse(io.files.get(filePath)!) as WorkerProgress;
    expect(data.model).toBe("claude-sonnet-4-20250514");
    expect(data.inputTokens).toBe(45000);
    expect(data.outputTokens).toBe(12000);
  });

  it("omits cost fields when costFields is undefined", () => {
    const io = createMockIO();
    const { writeHeartbeat: wh } = require("../core/daemon.ts");
    wh("/project", "H-FOO-1", 0.5, "Working", io, undefined);

    const filePath = heartbeatFilePath("/project", "H-FOO-1");
    const data = JSON.parse(io.files.get(filePath)!) as WorkerProgress;
    expect(data.model).toBeUndefined();
    expect(data.inputTokens).toBeUndefined();
    expect(data.outputTokens).toBeUndefined();
  });
});
