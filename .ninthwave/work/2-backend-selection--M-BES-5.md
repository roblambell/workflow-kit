# Fix: Validate tool-specific headless command paths (M-BES-5)

**Priority:** Medium
**Source:** Approved plan `.opencode/plans/1775068226707-stellar-island.md`
**Depends on:** H-BES-3
**Domain:** backend-selection

Do a targeted compatibility pass on the headless command shapes for Claude Code, Copilot CLI, and OpenCode so the backend-selection rollout is backed by current tool behavior rather than only existing local assumptions. Adjust command flags, launch tests, and narrow tool docs where needed so headless mode is a real supported path and not just an adapter branch that happens to exist.

**Test plan:**
- Verify Claude headless command generation still includes prompt, agent selection, and appended system prompt in the supported non-interactive form.
- Verify Copilot uses currently accepted non-interactive approval flags and does not regress trust-related launch behavior in tests.
- Verify OpenCode headless command generation covers agent selection and any required permission env/settings for non-interactive runs.
- Update `test/ai-tools.test.ts` and `test/launch.test.ts` to lock the final command shapes.

Acceptance: Tool-specific headless command generation reflects the supported CLI contract for Claude, Copilot, and OpenCode. The focused ai-tool and launch tests pass against the final command shapes, and any tool-specific doc notes needed for Copilot or OpenCode are updated.

Key files: `core/ai-tools.ts`, `docs/copilot-cli.md`, `test/ai-tools.test.ts`, `test/launch.test.ts`
