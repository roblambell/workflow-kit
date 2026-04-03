import { spawn as nodeSpawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { userStateDir } from "./daemon.ts";
import type { Multiplexer, MuxType } from "./mux.ts";

export const HEADLESS_WORKSPACE_PREFIX = "headless:";

export interface HeadlessIO {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
}

export interface HeadlessAdapterDeps {
  spawn: typeof nodeSpawn;
  io: HeadlessIO;
  kill: typeof process.kill;
  sleep: (ms: number) => void;
}

const defaultIO: HeadlessIO = {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
};

const defaultDeps: HeadlessAdapterDeps = {
  spawn: nodeSpawn,
  io: defaultIO,
  kill: process.kill.bind(process),
  sleep: process.env.NODE_ENV === "test" ? () => {} : (ms: number) => Bun.sleepSync(ms),
};

function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}

function decodeRef(value: string): string {
  return decodeURIComponent(value);
}

function trimTrailingBlankLine(lines: string[]): string[] {
  if (lines.at(-1) === "") return lines.slice(0, -1);
  return lines;
}

function parsePid(raw: string): number | null {
  const pid = parseInt(raw.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isPidAlive(killFn: typeof process.kill, pid: number): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatHeadlessWorkspaceRef(ref: string): string {
  return ref.startsWith(HEADLESS_WORKSPACE_PREFIX)
    ? ref
    : `${HEADLESS_WORKSPACE_PREFIX}${ref}`;
}

export function isHeadlessWorkspaceRef(ref: string): boolean {
  return ref.startsWith(HEADLESS_WORKSPACE_PREFIX);
}

export function stripHeadlessWorkspaceRef(ref: string): string {
  return isHeadlessWorkspaceRef(ref)
    ? ref.slice(HEADLESS_WORKSPACE_PREFIX.length)
    : ref;
}

export function headlessLogDir(projectRoot: string): string {
  return join(userStateDir(projectRoot), "logs");
}

export function headlessPidDir(projectRoot: string): string {
  return join(userStateDir(projectRoot), "workers");
}

export function headlessLogFilePath(projectRoot: string, ref: string): string {
  return join(headlessLogDir(projectRoot), `${encodeRef(stripHeadlessWorkspaceRef(ref))}.log`);
}

export function headlessPidFilePath(projectRoot: string, ref: string): string {
  return join(headlessPidDir(projectRoot), `${encodeRef(stripHeadlessWorkspaceRef(ref))}.pid`);
}

export class HeadlessAdapter implements Multiplexer {
  readonly type: MuxType = "headless";

  private readonly deps: HeadlessAdapterDeps;

  constructor(
    private readonly projectRoot: string,
    deps: Partial<HeadlessAdapterDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps, io: { ...defaultDeps.io, ...deps.io } };
  }

  isAvailable(): boolean {
    return true;
  }

  diagnoseUnavailable(): string {
    return "Headless adapter is always available.";
  }

  launchWorkspace(cwd: string, command: string, workItemId?: string): string | null {
    const ref = formatHeadlessWorkspaceRef(workItemId?.trim() || `headless-${Date.now()}`);
    const logDir = headlessLogDir(this.projectRoot);
    const pidDir = headlessPidDir(this.projectRoot);
    const logPath = headlessLogFilePath(this.projectRoot, ref);
    const pidPath = headlessPidFilePath(this.projectRoot, ref);

    try {
      if (!this.deps.io.existsSync(logDir)) this.deps.io.mkdirSync(logDir, { recursive: true });
      if (!this.deps.io.existsSync(pidDir)) this.deps.io.mkdirSync(pidDir, { recursive: true });

      const logFd = this.deps.io.openSync(logPath, "a");
      const child = this.deps.spawn("sh", ["-c", command], {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });

      if (!child.pid) return null;
      child.unref();
      this.deps.io.writeFileSync(pidPath, String(child.pid));
      return ref;
    } catch {
      return null;
    }
  }

  splitPane(_command: string): string | null {
    return null;
  }

  readScreen(ref: string, lines: number = 10): string {
    const logPath = headlessLogFilePath(this.projectRoot, ref);
    try {
      if (!this.deps.io.existsSync(logPath)) return "";
      const content = this.deps.io.readFileSync(logPath, "utf-8");
      const allLines = trimTrailingBlankLine(content.split("\n"));
      return allLines.slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  listWorkspaces(): string {
    const pidDir = headlessPidDir(this.projectRoot);
    try {
      if (!this.deps.io.existsSync(pidDir)) return "";

      const refs: string[] = [];
      for (const entry of this.deps.io.readdirSync(pidDir)) {
        if (!entry.endsWith(".pid")) continue;
        const pidPath = join(pidDir, entry);

        try {
          const pid = parsePid(this.deps.io.readFileSync(pidPath, "utf-8"));
          if (!pid || !isPidAlive(this.deps.kill, pid)) {
            this.deps.io.unlinkSync(pidPath);
            continue;
          }
          refs.push(formatHeadlessWorkspaceRef(decodeRef(entry.slice(0, -4))));
        } catch {
          try { this.deps.io.unlinkSync(pidPath); } catch { /* best-effort */ }
        }
      }

      return refs.join("\n");
    } catch {
      return "";
    }
  }

  closeWorkspace(ref: string): boolean {
    const pidPath = headlessPidFilePath(this.projectRoot, ref);
    try {
      if (!this.deps.io.existsSync(pidPath)) return false;
      const pid = parsePid(this.deps.io.readFileSync(pidPath, "utf-8"));
      if (!pid) {
        this.deps.io.unlinkSync(pidPath);
        return false;
      }

      if (!isPidAlive(this.deps.kill, pid)) {
        this.deps.io.unlinkSync(pidPath);
        return true;
      }

      try {
        this.deps.kill(pid, "SIGTERM");
      } catch {
        this.deps.io.unlinkSync(pidPath);
        return true;
      }

      this.deps.sleep(5_000);
      if (isPidAlive(this.deps.kill, pid)) {
        try {
          this.deps.kill(pid, "SIGKILL");
        } catch {
          // best-effort -- process may have exited during grace period
        }
      }

      this.deps.io.unlinkSync(pidPath);
      return true;
    } catch {
      return false;
    }
  }

  setStatus(
    _ref: string,
    _key: string,
    _text: string,
    _icon: string,
    _color: string,
  ): boolean {
    return false;
  }

  setProgress(_ref: string, _value: number, _label?: string): boolean {
    return false;
  }
}
