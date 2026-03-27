# Refactor: Remove sandboxing -- nono wrapper and proxy launcher (H-NW-2)

**Priority:** High
**Source:** Plan: Focus ninthwave to narrowest wedge (0.2.0)
**Depends on:** None
**Domain:** scope-reduction

Remove the nono kernel-level sandbox wrapper, the MITM policy proxy launcher, and all sandbox-related flags and detection. Workers will run unsandboxed. The proxy is being extracted to a standalone project separately.

**Delete files:**
- `core/sandbox.ts` (422 lines)
- `core/proxy-launcher.ts` (288 lines)
- `.nono/profiles/claude-worker.json` and `.nono/` directory
- `test/sandbox.test.ts`, `test/proxy-launcher.test.ts`, `test/proxy-e2e.test.ts`

**Modify:**
- `core/commands/start.ts` -- Remove: `wrapWithSandbox` import, proxy-launcher imports, `buildCaCertEnv()` function (~27 lines), `--no-sandbox` flag parsing, proxy setup block (~40 lines). Simplify `launchAiSession()` and `launchSingleItem()` signatures to remove sandbox/proxy params
- `core/commands/orchestrate.ts` -- Remove: `--no-sandbox` flag parsing (lines 1840-1843), `noSandbox` variable declarations and pass-through to launch functions
- `core/commands/onboard.ts` -- Remove: `isNonoAvailable` import, sandbox status in onboarding flow
- `core/commands/init.ts` -- Remove: `detectSandbox()` function (lines 180-183), `.nono` profile symlink creation (lines 477-484), sandbox detection output (lines 291-292)
- `core/commands/setup.ts` -- Remove: nono availability check (lines 137-140), `~/.nono/profiles/claude-worker.json` symlink creation (lines 284-294)
- `core/commands/doctor.ts` -- Remove: `checkNono()` function (lines 162-173), `checkSandboxProfile()` function (lines 175-199)
- `core/config.ts` -- Remove keys: `sandbox_extra_rw_paths`, `sandbox_extra_ro_paths`, `sandbox_extra_hosts`, `proxy_policy`, `proxy_credentials`
- `test/start.test.ts`, `test/setup.test.ts`, `test/onboard.test.ts`, `test/doctor.test.ts`, `test/init.test.ts` -- Remove sandbox-related test cases

**Test plan:**
- Run `bun test test/` -- all surviving tests must pass
- Verify `grep -r "sandbox\|nono\|proxy-launcher\|wrapWithSandbox" core/` returns nothing
- Verify `ninthwave start` still launches workers without sandbox params

Acceptance: All sandbox/proxy files deleted, `.nono/` directory removed, no references to sandbox/nono/proxy remain in core/, `bun test test/` passes, `--no-sandbox` flag removed from CLI.

Key files: `core/sandbox.ts`, `core/proxy-launcher.ts`, `core/commands/start.ts`, `core/commands/orchestrate.ts`, `core/commands/doctor.ts`, `core/config.ts`
