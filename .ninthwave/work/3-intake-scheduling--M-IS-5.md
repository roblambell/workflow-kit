# Docs: Update runtime controls documentation for intake scheduling (M-IS-5)

**Priority:** Medium
**Source:** docs/intake-scheduling-design.md
**Depends on:** H-IS-4
**Domain:** intake-scheduling
**Lineage:** fc8ce967-00a3-43cb-9103-945cdca954ac

Update `docs/local-first-runtime-controls-spec.md` and any other documentation that references the old "session limit" terminology to use the new naming: `maxInflight` / `--max-inflight` for the concurrency cap, and `acceptingWork` / `p` hotkey for the drain toggle. Also document the new drain mode behavior (toggle accepting work, in-flight items continue, limit preserved).

Documentation changes:
- Replace "session limit" with "max inflight" in runtime controls spec
- Replace `--session-limit` references with `--max-inflight` (note `--session-limit` is accepted as a deprecated alias)
- Add documentation for the `p` hotkey drain toggle
- Add documentation for the `acceptingWork` concept and drain mode behavior
- Update any TUI screenshots or text examples that show "active sessions" to show "in flight"
- Check `docs/faq.md` and `docs/onboarding.md` for session limit references

**Test plan:**
- Manual review

Acceptance: No documentation references "session limit" as the current/primary terminology (deprecated alias mentions are OK). Drain mode (`acceptingWork` / `p` hotkey) is documented. `docs/local-first-runtime-controls-spec.md` reflects the new naming. `docs/faq.md` and `docs/onboarding.md` are updated if they reference session limits.

Key files: `docs/local-first-runtime-controls-spec.md`, `docs/faq.md`, `docs/onboarding.md`
