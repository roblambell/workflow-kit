// Global test safety net. Loaded via bunfig.toml preload.
// Kills the test process if it exceeds time or memory limits.
// This catches runaway servers, infinite loops, leaked resources,
// and memory bloat that individual test timeouts cannot catch.
//
// Uses process.kill(process.pid, "SIGKILL") instead of process.exit()
// because tests that mock process.exit (e.g., version-bump.test.ts)
// would neuter the guard. SIGKILL cannot be intercepted or mocked.

const GLOBAL_TIMEOUT_MS = 180_000;
const MEMORY_LIMIT_MB = 1_024; // 1 GB RSS ceiling
const MEMORY_CHECK_INTERVAL_MS = 5_000;

/** Kill the process in a way that can't be mocked away by tests. */
function forceKill(code: number): never {
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    // Fallback -- process.kill might fail in sandboxed environments
    process.exit(code);
  }
  // Unreachable, but satisfies TypeScript's `never` return type
  throw new Error("unreachable");
}

const timer = setTimeout(() => {
  console.error(
    `\n[FATAL] Test suite exceeded ${GLOBAL_TIMEOUT_MS / 1000}s wall-clock limit. ` +
      `Likely a leaked server or infinite loop. Killing process.\n`,
  );
  forceKill(124); // 124 = same exit code as GNU timeout
}, GLOBAL_TIMEOUT_MS);

// .unref() so the timer doesn't keep the process alive if tests finish normally
timer.unref();

// Memory watchdog -- poll RSS and kill if it exceeds the ceiling.
// Catches mock leaks, unbounded allocations, and duplicate test processes.
const memoryWatch = setInterval(() => {
  const rssMB = process.memoryUsage.rss() / (1024 * 1024);
  if (rssMB > MEMORY_LIMIT_MB) {
    console.error(
      `\n[FATAL] Test suite RSS ${Math.round(rssMB)}MB exceeds ${MEMORY_LIMIT_MB}MB limit. ` +
        `Likely a memory leak or mock pollution. Killing process.\n`,
    );
    forceKill(137); // 137 = OOM-kill convention (128 + SIGKILL)
  }
}, MEMORY_CHECK_INTERVAL_MS);

memoryWatch.unref();

// Sentinel for lint-tests.test.ts to verify preload is active
(globalThis as any).__nw_test_safety_loaded = true;
