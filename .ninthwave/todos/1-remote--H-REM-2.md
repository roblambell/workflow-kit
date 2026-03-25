# Feat: Wire dashboard into orchestrator lifecycle (H-REM-2)

**Priority:** High
**Source:** Vision L-VIS-7 — remote session access foundation (revised per CEO review 2026-03-25, consolidated from original H-REM-2 + M-REM-3)
**Depends on:** H-REM-1
**Domain:** remote

Integrate the orchestrator dashboard server (H-REM-1) into the orchestrator's lifecycle. When `--remote` is enabled, start the dashboard on orchestrator boot and wire it into the item state machine.

**Changes to orchestrator:**

1. **`--remote` flag (off by default):**
   - Add `--remote` CLI flag to `ninthwave orchestrate`.
   - Also configurable via `remote_sessions=true` in `.ninthwave/config`.
   - When not enabled, no server starts. Zero overhead.

2. **On orchestrator start:**
   - Start the dashboard server.
   - Print the local URL and token to console.
   - If a `SessionUrlProvider` is configured (cloud), call `getPublicUrl()` and print that URL too.

3. **On PR creation** (when `prNumber` is first detected):
   - If a public URL is available (from provider), post a PR comment: `**[Orchestrator]** Live dashboard: {url}`.
   - Only one comment per orchestration run (not per item — single dashboard URL).

4. **On orchestrator shutdown:**
   - Stop the dashboard server.
   - Call provider's `cleanup()` if present.

5. **Status display:**
   - `ninthwave status` shows the dashboard URL when active.
   - Format: `Dashboard: http://localhost:19042 (token: abc...def)`

**Graceful degradation:**
- `--remote` flag not set → no server, no change to existing behavior.
- Server fails to start → log warning, continue without dashboard. Everything else works.
- Provider fails → fallback to local-only (no public URL posted on PRs).

Acceptance: When `--remote` is set, dashboard starts with orchestrator and shuts down with it. Dashboard URL shown in status. PR comment posted with public URL when provider is configured. Without `--remote`, no server starts. Tests cover: lifecycle (start with orchestrator → stop with orchestrator), PR comment posting, graceful degradation, status display.

**Test plan:**
- Unit test orchestrator starts dashboard when `--remote` is set
- Unit test orchestrator does NOT start dashboard when `--remote` is not set
- Unit test PR comment is posted once per run (not per item) when provider returns URL
- Unit test no PR comment when provider returns null
- Unit test graceful degradation when server fails to start
- Unit test status display includes dashboard URL
- Unit test cleanup on shutdown

Key files: `core/commands/orchestrate.ts`, `core/commands/status.ts`, `test/orchestrate-remote.test.ts`
