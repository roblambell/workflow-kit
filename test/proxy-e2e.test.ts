// End-to-end integration test: nono kernel sandbox + policy proxy + real GitHub API.
//
// Exercises the full chain:
// 1. Start ninthwave-proxy with a test Cedar policy
// 2. Launch commands inside nono with --upstream-proxy
// 3. Make real GitHub API calls through the proxy
// 4. Verify: allowed calls succeed, denied calls get 403, audit log is correct
//
// Skipped when nono, ninthwave-proxy, or GITHUB_TOKEN is not available (CI-friendly).
// Lives in a separate file to avoid slowing down the fast unit test suite.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { createServer, createConnection } from "net";

// ── Binary & environment detection ──────────────────────────────────

function isBinaryAvailable(name: string): boolean {
  const result = spawnSync("which", [name], { encoding: "utf-8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

const HAS_NONO = isBinaryAvailable("nono");
const HAS_PROXY = isBinaryAvailable("ninthwave-proxy");
const HAS_TOKEN = !!process.env.GITHUB_TOKEN;
const CAN_RUN = HAS_NONO && HAS_PROXY && HAS_TOKEN;

const SKIP_REASON = !HAS_NONO
  ? "nono not installed — install via: brew install ninthwave"
  : !HAS_PROXY
    ? "ninthwave-proxy not installed"
    : !HAS_TOKEN
      ? "GITHUB_TOKEN not set — required for real GitHub API calls"
      : "";

// ── Helpers ─────────────────────────────────────────────────────────

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Port ${port} not available after ${timeoutMs}ms`);
}

/**
 * Run a command inside a nono sandbox.
 * Grants read access to system paths so binaries (curl, cat, ls) can function,
 * but does NOT grant access to user home directories (~/.aws, ~/.ssh, etc.).
 */
function nonoExec(
  args: string[],
  opts?: { proxyPort?: number; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
  const nonoArgs = ["run", "-s", "--allow-cwd"];

  // System read paths — needed for binaries to function, but excludes ~/
  for (const p of ["/etc", "/usr", "/opt", "/var/run", "/bin", "/sbin"]) {
    if (existsSync(p)) nonoArgs.push("--read", p);
  }

  if (opts?.proxyPort) {
    nonoArgs.push("--upstream-proxy", `127.0.0.1:${opts.proxyPort}`);
  }

  nonoArgs.push("--", ...args);

  const result = spawnSync("nono", nonoArgs, {
    encoding: "utf-8",
    timeout: opts?.timeout ?? 10_000,
    env: { ...process.env },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

// ── Test Cedar policy fixture ───────────────────────────────────────
// Allows GET requests, denies DELETE requests — simple and deterministic.

const TEST_POLICY = `\
permit(
  principal,
  action == Action::"http.request",
  resource
) when {
  resource.method == "GET"
};

forbid(
  principal,
  action == Action::"http.request",
  resource
) when {
  resource.method == "DELETE"
};
`;

const TEST_CREDENTIALS = {
  github: {
    host: "api.github.com",
    token_env: "GITHUB_TOKEN",
    header: "Authorization",
    prefix: "Bearer ",
  },
};

// ── Test suite ──────────────────────────────────────────────────────

if (!CAN_RUN) {
  // Show a clear skip reason in test output when dependencies are missing.
  describe("proxy E2E (skipped)", () => {
    it.skip(`SKIPPED: ${SKIP_REASON}`, () => {});
  });
} else {
  describe("proxy E2E: nono + proxy + GitHub API", () => {
    let tmpDir: string;
    let auditLogFile: string;
    let proxyPort: number;
    let proxyProc: { kill: () => void; readonly exitCode: number | null } | null =
      null;

    beforeAll(async () => {
      // Create temp fixtures
      tmpDir = mkdtempSync(join(tmpdir(), "nw-proxy-e2e-"));

      const policyFile = join(tmpDir, "policy.cedar");
      const credentialsFile = join(tmpDir, "credentials.json");
      auditLogFile = join(tmpDir, "audit.jsonl");

      writeFileSync(policyFile, TEST_POLICY);
      writeFileSync(
        credentialsFile,
        JSON.stringify(TEST_CREDENTIALS, null, 2),
      );

      proxyPort = await findAvailablePort();

      // Start the proxy binary as a managed subprocess
      const proc = Bun.spawn(
        [
          "ninthwave-proxy",
          "--policy",
          policyFile,
          "--credentials",
          credentialsFile,
          "--port",
          String(proxyPort),
          "--audit-log",
          auditLogFile,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      proxyProc = proc;

      // Wait for the proxy to accept connections
      await waitForPort(proxyPort, 5_000);
    });

    afterAll(() => {
      if (proxyProc?.exitCode === null) {
        proxyProc.kill();
      }
      if (tmpDir && existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // ── Allowed requests ────────────────────────────────────────────

    it("allowed: GET /zen succeeds through proxy", () => {
      const { stdout, exitCode } = nonoExec(
        [
          "curl",
          "-s",
          "-w",
          "\n%{http_code}",
          "https://api.github.com/zen",
        ],
        { proxyPort },
      );

      const lines = stdout.trim().split("\n");
      const statusCode = parseInt(lines[lines.length - 1]!, 10);
      expect(exitCode).toBe(0);
      expect([200, 304]).toContain(statusCode);
    });

    it("allowed: GET /rate_limit returns expected JSON", () => {
      const { stdout, exitCode } = nonoExec(
        ["curl", "-s", "https://api.github.com/rate_limit"],
        { proxyPort },
      );

      expect(exitCode).toBe(0);
      const body = JSON.parse(stdout);
      expect(body).toHaveProperty("resources");
      expect(body).toHaveProperty("rate");
    });

    // ── Denied requests ─────────────────────────────────────────────

    it("denied: DELETE returns 403 with policy info in body", () => {
      const { stdout } = nonoExec(
        [
          "curl",
          "-s",
          "-X",
          "DELETE",
          "-w",
          "\n%{http_code}",
          "https://api.github.com/repos/octocat/Hello-World/issues/1",
        ],
        { proxyPort },
      );

      const lines = stdout.trim().split("\n");
      const statusCode = parseInt(lines[lines.length - 1]!, 10);
      expect(statusCode).toBe(403);

      // Response body should indicate policy denial
      const body = lines.slice(0, -1).join("\n").toLowerCase();
      expect(body).toMatch(/deny|forbidden|policy/);
    });

    // ── Audit log verification ──────────────────────────────────────

    it("audit log contains structured JSON events for all requests", () => {
      expect(existsSync(auditLogFile)).toBe(true);

      const content = readFileSync(auditLogFile, "utf-8").trim();
      expect(content.length).toBeGreaterThan(0);

      const events = content.split("\n").map((line) => JSON.parse(line));

      // At least 3 events: GET /zen, GET /rate_limit, DELETE
      expect(events.length).toBeGreaterThanOrEqual(3);

      // Every event has the required fields
      for (const event of events) {
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("method");
        expect(event).toHaveProperty("decision");
      }

      // Verify allowed event exists with correct decision
      const allowedGet = events.find(
        (e: any) => e.method === "GET" && e.decision === "allow",
      );
      expect(allowedGet).toBeDefined();
      expect(allowedGet).toHaveProperty("host");

      // Verify denied event exists with policy name
      const deniedDelete = events.find(
        (e: any) => e.method === "DELETE" && e.decision === "deny",
      );
      expect(deniedDelete).toBeDefined();
      expect(deniedDelete).toHaveProperty("policy");
    });

    it("audit log shows credential injection on allowed requests", () => {
      const content = readFileSync(auditLogFile, "utf-8").trim();
      const events = content.split("\n").map((line) => JSON.parse(line));

      const injected = events.find(
        (e: any) =>
          e.decision === "allow" && e.credential_injected === true,
      );
      expect(injected).toBeDefined();
    });

    // ── Filesystem isolation (nono enforcement) ─────────────────────

    it("nono blocks access to ~/.aws/credentials", () => {
      const awsCreds = join(homedir(), ".aws", "credentials");
      const { exitCode } = nonoExec(["cat", awsCreds], { timeout: 5_000 });
      // Sandbox should deny — nonzero exit regardless of file existence
      expect(exitCode).not.toBe(0);
    });

    it("nono blocks access to ~/.ssh/", () => {
      const sshDir = join(homedir(), ".ssh");
      const { exitCode } = nonoExec(["ls", sshDir], { timeout: 5_000 });
      // Sandbox should deny — nonzero exit regardless of directory existence
      expect(exitCode).not.toBe(0);
    });
  });
}
