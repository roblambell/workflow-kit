# Refactor: Create ai-tools.ts profile module (H-TA-1)

**Priority:** High
**Source:** Plan: consolidate AI tool abstraction
**Depends on:** None
**Domain:** refactor

Create `core/ai-tools.ts` as the single source of truth for AI tool profiles (Claude Code, OpenCode, Copilot). Define the `AiToolId` union type, `AiToolProfile` interface with `buildLaunchCmd` callback, `LaunchDeps` and `LaunchOpts` interfaces, and the `AI_TOOL_PROFILES` array with all three tool profiles. Include lookup helpers: `getToolProfile(id)`, `allToolIds()`, `isAiToolId(s)`, `agentTargetDirs()`, `agentFileTargets(sources)`.

The `buildLaunchCmd` callback receives injected deps (`readFileSync`, `writeFileSync`, `run`) so Copilot's temp-file creation is testable. Claude returns embedded command (no post-launch send), OpenCode returns post-launch send, Copilot writes launcher script via deps.

**Test plan:**
- Unit test `getToolProfile("claude")` returns correct profile, `getToolProfile("unknown")` throws
- Unit test `allToolIds()` returns `["claude", "opencode", "copilot"]`
- Unit test `isAiToolId("claude")` returns true, `isAiToolId("cursor")` returns false
- Unit test `agentTargetDirs()` returns array matching current `AGENT_TARGET_DIRS` structure
- Unit test `agentFileTargets(["implementer.md"])` returns correct targets for all 3 tools
- Unit test each profile's `buildLaunchCmd` with stub deps produces expected command strings

Acceptance: `core/ai-tools.ts` exports all types and helpers. `test/ai-tools.test.ts` passes with full coverage of all helpers and all 3 profile buildLaunchCmd callbacks. No existing tests broken (this item adds code only, modifies nothing).

Key files: `core/ai-tools.ts`, `test/ai-tools.test.ts`
