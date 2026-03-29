# Refactor: Refactor launch to use profile callbacks (H-TA-3)

**Priority:** High
**Source:** Plan: consolidate AI tool abstraction
**Depends on:** H-TA-1
**Domain:** refactor

Replace the switch statement in `launchAiSession()` with a call to `profile.buildLaunchCmd(opts, deps)`. For known tools (where `isAiToolId(tool)` is true), look up the profile and call its callback with real deps (`readFileSync`, `writeFileSync`, `run`). For unknown/custom tools (from `NINTHWAVE_AI_TOOL` override), fall back to launching the raw tool string as a command with post-launch send.

Also update `core/schedule-runner.ts:120` to use `getToolProfile(aiTool).command` when the tool is a known `AiToolId`, and raw `aiTool` string otherwise (currently `id === command` for all tools, but this makes the derivation explicit).

The `LaunchDeps` object is constructed from real imports in production and can be stubbed in tests for the Copilot temp-file path.

**Test plan:**
- Verify `launchAiSession("claude", ...)` generates identical command string as before (contains `--permission-mode bypassPermissions`, `--append-system-prompt`, `-- Start`)
- Verify `launchAiSession("opencode", ...)` still uses `sendMessage` for post-launch delivery
- Verify `launchAiSession("copilot", ...)` creates launcher script via deps (contains `--allow-all`, `-i`)
- Verify `launchAiSession("custom-tool", ...)` falls back to raw command launch
- Verify custom agentName propagation still works for all 3 tools
- All existing launch tests in `test/launch.test.ts` pass after refactor
- `bun test test/` green end-to-end

Acceptance: `launchAiSession` no longer has a switch statement on tool name. Known tools dispatch through `profile.buildLaunchCmd()`. Unknown tools fall back gracefully. `schedule-runner.ts` derives command name from profile. All launch tests pass with identical behavior.

Key files: `core/commands/launch.ts`, `core/schedule-runner.ts`, `test/launch.test.ts`
