# Fix Copilot generated artifacts and launch-name alignment (H-COP-1)

**Priority:** High
**Source:** /decompose 2026-04-01
**Depends on:** H-SG-2
**Domain:** copilot-integration

Fix the current Copilot worker failure by making generation and launch agree on the Copilot-visible agent identifiers.

Ensure ninthwave generates `.github/copilot-instructions.md` from `CLAUDE.md`, generates the expected `.github/agents/*.agent.md` files, and launches Copilot with the agent identifier that Copilot actually resolves in practice. Do not assume the internal `ninthwave-*` label is automatically the runtime `--agent=` value. Include `rebaser` if any launch path references it.

**Test plan:**
- Add or update tests for Copilot artifact generation and launch command construction
- Verify Copilot launch no longer references an identifier that generated artifacts do not expose
- Run `bun test test/`

Acceptance: After init has run, Copilot no longer reports missing instructions or missing custom agents, and the runtime `--agent=` value is consistent with generated Copilot agent files.

Key files: `core/ai-tools.ts`, `core/commands/launch.ts`, `core/commands/init.ts`, `core/agent-files.ts`, `test/ai-tools.test.ts`, `test/launch.test.ts`
