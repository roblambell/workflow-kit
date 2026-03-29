# Refactor: Wire consumers to profile-derived data (H-TA-2)

**Priority:** High
**Source:** Plan: consolidate AI tool abstraction
**Depends on:** H-TA-1
**Domain:** refactor

Replace hardcoded tool arrays, if-chains, and duplicate data across 7 source files with derivations from `AI_TOOL_PROFILES` in `core/ai-tools.ts`.

Changes by file:
- `core/agent-files.ts`: Replace 30-line hardcoded `AGENT_FILES` array with `agentFileTargets(AGENT_SOURCES)` call
- `core/commands/setup.ts`: Replace `AGENT_TARGET_DIRS` literal with `agentTargetDirs()`. Replace `detectProjectTools` if-chain with loop over profiles using `projectIndicators`. Tighten Copilot detection from `.github/` to `.github/copilot-instructions.md` or `.github/agents`
- `core/commands/onboard.ts`: Delete `AITool` interface and `AI_TOOLS` array. Import `AI_TOOL_PROFILES` and read `.displayName`, `.command`, `.description`, `.installCmd` directly
- `core/commands/run-items.ts`: Refactor `detectAiTool()` to return `AiToolId | string`. Drive env detection from `profile.envDetection`, process tree from `profile.processNames`, binary check from `profile.command`. Validate `NINTHWAVE_AI_TOOL` with `isAiToolId()` and warn on unknown values
- `core/preflight.ts`: Replace hardcoded `["claude", "opencode", "copilot"]` with `AI_TOOL_PROFILES.map(p => p.command)`
- `core/worker-health.ts`: Build `PROMPT_INDICATORS` from defaults + `AI_TOOL_PROFILES.flatMap(p => p.promptIndicators ?? [])`
- `core/commands/init.ts`: Derive tool names in config template from profiles

**Test plan:**
- All existing tests in `test/setup.test.ts`, `test/launch.test.ts`, `test/init.test.ts`, `test/onboard.test.ts`, `test/doctor.test.ts`, `test/preflight.test.ts` pass after import updates
- Update `test/setup.test.ts` Copilot detection test: create `.github/copilot-instructions.md` or `.github/agents/` instead of bare `.github/`
- Verify `detectAiTool()` returns same values for same env var inputs (backwards-compatible)
- Verify `NINTHWAVE_AI_TOOL=custom-tool` still passes through (not rejected)
- `bun test test/` green end-to-end

Acceptance: No hardcoded `"claude"`, `"opencode"`, `"copilot"` string literals remain in the 7 consumer files (only in `core/ai-tools.ts` profiles and test assertions). `AITool` interface and `AI_TOOLS` array deleted from `onboard.ts`. Copilot project detection no longer triggers on bare `.github/` directory. All tests pass.

Key files: `core/agent-files.ts`, `core/commands/setup.ts`, `core/commands/onboard.ts`, `core/commands/run-items.ts`, `core/preflight.ts`, `core/worker-health.ts`, `core/commands/init.ts`
