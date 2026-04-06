# Fix: Remove stale cross-repo and command refs from agent and skill prompts (H-CLN-1)

**Priority:** High
**Source:** Post-ARC cleanup -- cross-repo removed in v0.4.0
**Depends on:** None
**Domain:** cleanup
**Lineage:** c901d239-35ac-4150-aef7-5ee74be9e1ce

Cross-repo hub orchestration was removed in v0.4.0 (commit 3bc3ca84) but stale references remain in agent prompts and skill docs. Additionally, agent description frontmatter references "nw watch" which should be "nw" (bare command).

Changes:

1. `agents/implementer.md`:
   - Remove `IS_HUB_LOCAL` from the variable list (~line 51, 56)
   - Remove the "Cross-repo items" section (~lines 283-297), keep "Hub-local items" content as the default behavior
   - Update frontmatter description from "during `nw watch` sessions" to "during `nw` sessions" (~line 3)
   - Update body reference from "`nw watch`" to "`nw`" (~line 10)

2. `agents/reviewer.md`, `agents/forward-fixer.md`, `agents/rebaser.md`:
   - Update frontmatter description from "during `nw watch` sessions" to "during `nw` sessions" (~line 3)
   - Update body reference from "`nw watch`" to "`nw`" (~line 10)

3. `skills/decompose/SKILL.md`:
   - Remove line ~61 about hub repo context, `.ninthwave/repos.conf`, and cross-repo targeting
   - Remove line ~136 about `**Repo:** <alias>` metadata field for non-hub repos
   - Remove any "Target repo" section guidance

4. Delete `docs/tui-responsiveness-plan.md` entirely -- completed planning doc with stale cross-repo sync references.

5. After editing canonical sources, regenerate mirror copies by running `nw init` (which copies agents/ to .claude/, .opencode/, .github/).

**Test plan:**
- Grep for `IS_HUB_LOCAL`, `repos.conf`, `cross-repo` across agents/ and skills/ -- should find zero matches
- Grep for `nw watch` across agents/ -- should find zero matches
- Verify `docs/tui-responsiveness-plan.md` no longer exists
- Run `nw init` and verify mirror copies updated
- Run `bun run test` to verify no test references these removed sections

Acceptance: All cross-repo references removed from agent prompts and skill docs. "nw watch" replaced with "nw" in agent descriptions. Plan doc deleted. Mirror copies regenerated. Tests pass.

Key files: `agents/implementer.md`, `agents/reviewer.md`, `agents/forward-fixer.md`, `agents/rebaser.md`, `skills/decompose/SKILL.md`, `docs/tui-responsiveness-plan.md`
