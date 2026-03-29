# Review: Test Quality & Coverage Audit (H-ER-6)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** H-ER-5
**Domain:** eng-review

Audit the test suite for quality, coverage gaps, mock patterns, and infrastructure. Cross-reference all production code findings from Reviews 1-5. Write findings to `.ninthwave/reviews/06-test-quality.md`.

## Files to Review

- `test/lint-tests.test.ts` -- custom lint rules scanning test files
- `test/helpers.ts` -- shared test utilities and fixtures
- `test/setup-global.ts` -- global timeout and memory watchdog
- `test/orchestrator.test.ts` and `test/orchestrator-unit.test.ts` -- state machine tests
- `test/orchestrate.test.ts` -- event loop tests
- `test/daemon-integration.test.ts` -- full lifecycle tests
- `test/launch.test.ts` -- worker launch tests
- `test/crew.test.ts` and `test/crew-command.test.ts` -- crew mode tests
- `test/schedule-runner.test.ts`, `test/schedule-eval.test.ts`, `test/schedule-files.test.ts` -- schedule tests
- Scan ALL test files in `test/` to identify which use `vi.mock` vs dependency injection
- `.ninthwave/reviews/01-types-data-model.md` through `05-daemon-infrastructure.md` -- prior reviews

## Review Criteria

1. **vi.mock migration status:** Identify all test files that use `vi.mock`. For each, assess: is the mock necessary (module cannot be injected), or is it migration debt? Prioritize by risk of cross-file leak.
2. **State machine test completeness:** Does `orchestrator.test.ts` cover all 16+ states? All transition edges? All error paths (max retries, timeout hierarchy, stacked dep failure)?
3. **Integration test gaps:** Does `daemon-integration.test.ts` test crash recovery? State persistence round-trip? Multi-cycle transitions?
4. **Missing critical path coverage:** Cross-reference production code paths identified as risky in Reviews 1-5 against test files. What critical paths are untested?
5. **Test isolation:** Are there existing test flakes attributable to `vi.mock` leaking across files? Check if any test imports a module that another test mocks.
6. **Lint rule completeness:** `lint-tests.test.ts` has 6 rules. Are there other dangerous patterns not caught? (e.g., `describe.skip`/`it.skip` left in code, filesystem writes outside temp dirs, hardcoded timeouts vs constants)
7. **Fixture quality:** Are test fixtures realistic? Do they cover edge cases in work item parsing (items with dependencies, cross-repo items, stacked items)?

## Cross-Cutting Themes

### Theme A: Feature Necessity

- Are there test files for features flagged as STRIP in Reviews 1-5? If crew mode or scheduling are removed, their test files can go too. Estimate total test LOC that becomes removable.
- Are there tests for features that no longer exist (removed in 0.2.0 scope reduction)?
- Are any test helpers or fixtures unused?

### Theme B: Complexity Reduction

- Are tests over-specified (testing implementation details rather than behavior)?
- Are there test helpers/fixtures that add indirection without value?
- Can the 21 `vi.mock` files be simplified to use dependency injection instead?
- Is the test infrastructure (setup-global.ts, lint-tests.test.ts) appropriately complex or could it be simpler?

## Output Format

Write to `.ninthwave/reviews/06-test-quality.md` using the same structure. Include a table mapping production modules to test coverage (covered/partially/uncovered). Include total test LOC that could be removed if STRIP features from Review 5 are removed.

**Test plan:**
- Verify `.ninthwave/reviews/06-test-quality.md` exists with all required sections
- Verify coverage gap analysis references specific production code paths from Reviews 1-5
- Verify vi.mock inventory is complete

Acceptance: Review document exists at `.ninthwave/reviews/06-test-quality.md` with coverage mapping table, vi.mock inventory, and test LOC removal estimates tied to feature stripping recommendations from prior reviews.

Key files: `test/lint-tests.test.ts`, `test/helpers.ts`, `test/setup-global.ts`, `test/orchestrator.test.ts`, `test/orchestrator-unit.test.ts`, `test/orchestrate.test.ts`, `test/daemon-integration.test.ts`, `test/launch.test.ts`, `test/crew.test.ts`
