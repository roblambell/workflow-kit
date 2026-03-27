# Refactor: Remove dashboard server and webhooks (H-NW-3)

**Priority:** High
**Source:** Plan: Focus ninthwave to narrowest wedge (0.2.0)
**Depends on:** None
**Domain:** scope-reduction

Remove the HTTP dashboard server (Bun.serve-based session viewer) and webhook notification system. The `--remote` flag and dashboard URL display are removed. Daemon mode is kept but without the web server component.

**Delete files:**
- `core/session-server.ts` (337 lines)
- `core/webhooks.ts` (277 lines)
- `test/session-server.test.ts`, `test/webhooks.test.ts`, `test/orchestrate-remote.test.ts`

**Modify:**
- `core/commands/orchestrate.ts` -- Remove: session-server imports (lines 58-62), webhook imports (lines 53-57), `--remote` flag parsing (lines 1856-1859), webhook notifier creation (~lines 2150-2163), dashboard start/stop blocks (~lines 2170-2193, 2413-2415), dashboard URL in state serialization, PR comment posting with dashboard URL
- `core/commands/doctor.ts` -- Remove: `checkCloudflared()` function (lines 212-224), `checkWebhookUrl()` function (lines 226-243)
- `core/commands/status.ts` -- Remove: dashboard URL display (~lines 294-296)
- `core/daemon.ts` -- Remove `dashboardUrl` field from `DaemonState` interface (line 49) and serialization extras (line 324)
- `core/config.ts` -- Remove keys: `webhook_url`, `remote_sessions`
- `test/orchestrate.test.ts`, `test/doctor.test.ts` -- Remove remote/webhook-related test cases

**Test plan:**
- Run `bun test test/` -- all surviving tests must pass
- Verify `grep -r "session-server\|webhooks\|dashboardUrl\|--remote" core/` returns nothing
- Verify `ninthwave status` still works without dashboard URL display

Acceptance: Dashboard server and webhook files deleted, no references to remote/webhook/dashboard remain in core/, `bun test test/` passes, `--remote` flag removed from CLI.

Key files: `core/session-server.ts`, `core/webhooks.ts`, `core/commands/orchestrate.ts`, `core/commands/doctor.ts`, `core/daemon.ts`, `core/config.ts`
