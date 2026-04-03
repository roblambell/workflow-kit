# Docs: Document self-hosted broker setup and architecture (M-SHB-6)

**Priority:** Medium
**Source:** Spec `.opencode/plans/1775207598126-tidy-cactus.md`
**Depends on:** H-SHB-5
**Domain:** broker-docs
**Lineage:** 15e31a20-69f0-445f-8a3e-50c092aeddc0

Document the self-hosted broker as an explicit opt-in alternative to the hosted default, including quickstart steps, architecture boundaries, and contributor test guidance. Update the docs so they describe the shared broker-core plus runtime split, repo-reference verification, the `crew_url` configuration model, and the intentional v1 non-goals without implying the mock broker is the only protocol surface.

**Test plan:**
- Manual review of `README.md`, `ARCHITECTURE.md`, `docs/faq.md`, `ARCHITECTURE.md`, and `CONTRIBUTING.md` for consistency with the shipped command and runtime behavior.
- Verify command examples and config guidance match the implemented `nw broker` flags and `crew_url` persistence flow.
- Confirm the architecture docs no longer describe `core/mock-broker.ts` as the sole broker implementation surface.

Acceptance: User-facing and contributor docs explain how to run a self-hosted broker, how it differs from the hosted default, what repo verification and persistence do, and what v1 intentionally omits. The updated docs are internally consistent with the implemented runtime and command surface.

Key files: `README.md`, `ARCHITECTURE.md`, `docs/faq.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`
