import type { RunResult } from "./types.ts";

export function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
): RunResult {
  const result = Bun.spawnSync([cmd, ...args], {
    cwd: opts?.cwd,
    stdin: opts?.input ? new TextEncoder().encode(opts.input) : undefined,
  });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}
