# Orchestrator should read worker screen on stuck detection

**Observed:** 2026-03-25, grind cycle 1 batch 2

## What happened

Both workers (H-ONB-1, M-ORC-1) crashed instantly because the nono CLI syntax was wrong (`--rw` instead of `--allow`). The orchestrator detected them as "stuck" but had no idea WHY — it just saw the process exit. The actual error was visible in the multiplexer terminal output:

```
error: unexpected argument '--rw' found
```

A human looking at the screen would diagnose this in 2 seconds. The orchestrator has `readScreen()` available via the multiplexer adapter but doesn't use it when diagnosing stuck workers.

## Expected behavior

When a worker transitions to "stuck" or crashes within the first 30 seconds (fast failure), the orchestrator should:
1. Call `readScreen()` on the worker's multiplexer pane
2. Parse the output for common error patterns (command not found, unexpected argument, permission denied, etc.)
3. Include the relevant error context in the stuck event log
4. Optionally: if the error is clearly a ninthwave bug (wrong CLI flags), auto-file a friction entry

## Impact

Without screen reading, stuck workers are opaque. The supervisor can flag anomalies but can't diagnose root causes. This forces human intervention for issues that are trivially diagnosable from the terminal output.
