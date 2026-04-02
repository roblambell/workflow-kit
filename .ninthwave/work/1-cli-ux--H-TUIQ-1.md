# Fix: Unify `q` quit confirmation with existing TUI shutdown flow (H-TUIQ-1)

**Priority:** High
**Source:** Approved decompose plan `1775161322862-cosmic-wizard`
**Depends on:** None
**Domain:** cli-ux
**Lineage:** d548c585-f663-439f-9229-eeac73d9560f

Update the TUI quit path so `q` no longer exits immediately and instead reuses the same two-press confirmation flow that already exists for `Ctrl+C`. Keep `Ctrl+C` behavior unchanged while updating footer and help copy so the rendered prompts match the new `q` behavior. Land the keyboard, renderer, and regression test updates together so the UX and coverage stay consistent in one PR.

**Test plan:**
- Add or update `test/tui-keyboard.test.ts` to cover first `q`, second `q`, timeout reset after a single `q`, and `q` confirmation while help or paused overlays are visible.
- Add or update `test/status-render.test.ts` to assert the footer still shows `q quit`, pending `q` shows `Press q again to quit`, pending `Ctrl+C` still shows `Press Ctrl-C again to exit`, and `Closing...` still takes precedence.
- Add or update `test/orchestrate.test.ts` to verify the integration-level `q` path follows the same pending and shutdown flow as the existing `Ctrl+C` handler.
- Run `bun test test/tui-keyboard.test.ts`, `bun test test/status-render.test.ts`, `bun test test/orchestrate.test.ts`, and `bun run test`.

Acceptance: Pressing `q` once in the TUI does not quit immediately and shows `Press q again to quit`. Pressing `q` again within the existing confirmation window starts shutdown and shows `Closing...`. The main footer advertises quit as `q quit`, help text documents the new `q` behavior, `Ctrl+C` still behaves exactly as before, and the targeted plus full test suites pass.

Key files: `core/tui-keyboard.ts`, `core/status-render.ts`, `test/tui-keyboard.test.ts`, `test/status-render.test.ts`, `test/orchestrate.test.ts`
