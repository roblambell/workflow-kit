# Docs: Refresh backend selection and programmatic access docs (L-BES-6)

**Priority:** Low
**Source:** Approved plan `.opencode/plans/1775068226707-stellar-island.md`
**Depends on:** H-BES-2, M-BES-4, M-BES-5
**Domain:** backend-selection

Refresh the user-facing docs so they describe the final backend-selection behavior instead of the old mux-required story. Document `Auto | tmux | cmux | headless`, saved backend preference, optional mux installation, the `NINTHWAVE_MUX` override, and the difference between attachable interactive backends and programmatic headless operation.

**Test plan:**
- Manual review that README, FAQ, onboarding, and tool docs all describe the same backend-selection behavior.
- Verify docs explain `NINTHWAVE_MUX` precedence and the saved `backend_mode` startup default.
- Verify examples and setup instructions no longer imply tmux or cmux are mandatory prerequisites.

Acceptance: Repo docs consistently describe backend selection, optional mux installs, and programmatic/headless support. A new user reading README plus onboarding can understand when to choose `Auto`, `tmux`, `cmux`, or `headless` without contradictory setup guidance.

Key files: `README.md`, `docs/faq.md`, `docs/onboarding.md`, `docs/copilot-cli.md`
