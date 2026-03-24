> **Note:** This review was written before the file-per-todo migration. TODOS.md references are historical.

# Engineering Review: Data Pipeline

**Date:** 2026-03-24
**Reviewer:** AI engineering review (M-ENG-3)
**Modules:** `core/parser.ts`, `core/analytics.ts`, `core/commands/analytics.ts`, `core/webhooks.ts`, `core/templates.ts`, `core/cross-repo.ts`, `core/config.ts`

## Summary

The data pipeline modules are well-structured with good test coverage, consistent use of dependency injection (per project conventions), and clean separation of concerns. The main areas for improvement are: parser robustness with edge-case inputs, missing validation at module boundaries, and some defensive-programming gaps in cross-repo and webhook code.

**Overall assessment:** Solid foundation. Most findings are hardening items (medium/low priority) rather than correctness bugs. The DI patterns make the codebase highly testable.

---

## 1. Parser Robustness (`core/parser.ts`)

### 1.1 Silent skip of malformed items — no diagnostic output

**Severity:** Low
**Type:** Observability gap

When an item has no ID (e.g., `### Feat: Item with no ID`), `emitItem()` returns early because `id` is empty. This is correct behavior, but there is no warning or log. Users with formatting mistakes in TODOS.md will see items silently vanish with no indication of why.

**Current test coverage:** The `malformed.md` fixture tests that items without IDs are skipped, but doesn't verify any warning.

**Recommendation:** Add an optional `warn` callback parameter to `parseTodos` (consistent with the DI pattern) that logs when items are skipped due to missing ID. Actionable — see TODO M-DP-1.

### 1.2 No duplicate ID detection

**Severity:** Medium
**Type:** Data integrity

If two items share the same ID, both are added to the `items` array. Downstream consumers (orchestrator, dependency resolution) use `Map(items.map(i => [i.id, i]))` which silently picks the last one. The wildcard expansion second pass operates on `allIds` which would contain the duplicate.

**Recommendation:** Detect duplicates during parsing and either warn or skip the duplicate. Actionable — see TODO M-DP-2.

### 1.3 Dead code: unused `projectRoot` variable

**Severity:** Low
**Type:** Code quality

Line 251: `const projectRoot = join(todosFile, "..", "..");` computes a project root that is never referenced. This is dead code from a refactor.

**Recommendation:** Remove the dead variable. Actionable — see TODO L-DP-3.

### 1.4 Title regex stripping is greedy

**Severity:** Low
**Type:** Edge case

The title-cleaning regex `title.replace(/ \([A-Z]*-[A-Za-z0-9]*-[0-9]*.*/, "")` uses `.*` after the ID pattern, which strips everything after the first ID-like parenthetical, including legitimate parenthetical annotations. For example:

```
### Feat: Database migration (M-DB-1) (phase 2)
```

Would produce title `Feat: Database migration` instead of `Feat: Database migration (phase 2)`.

**Recommendation:** Make the regex more precise — match only the ID parenthetical and optional suffixes like `(bundled)`. Actionable — see TODO L-DP-4.

### 1.5 UTF-8 BOM handling

**Severity:** Low
**Type:** Edge case

If TODOS.md starts with a UTF-8 BOM (`\uFEFF`), the first `## ` header check would fail because the BOM character precedes it. Files saved by some Windows editors include a BOM by default.

**Recommendation:** Strip BOM from content before parsing. Actionable — see TODO L-DP-5.

### 1.6 `normalizeDomain` re-reads domain file on every call

**Severity:** Low
**Type:** Performance

`normalizeDomain` accepts a `domainsFile` path and reads it from disk on every call. During parsing, this is called once per `## ` section header, so the impact is minimal (typically 3-10 calls). However, `loadDomainMappings()` in `config.ts` already provides a cached Map interface — the parser should use it.

**Observation only.** The redundancy between `normalizeDomain`'s inline file reading and `loadDomainMappings()` is noted in section 7.3. Fixing one addresses both.

---

## 2. Analytics Data Integrity (`core/analytics.ts`)

### 2.1 `parseCostSummary` regex false positives

**Severity:** Low
**Type:** Data accuracy

The token-matching regex `tokens?\s*[:=]\s*([\d,]+)` matches any occurrence of "token" followed by a number. This could produce false positives on text like "CSRF token: 12345" or "refresh token: 67890" from worker output.

**Recommendation:** Anchor the match more tightly — require "total tokens" or start-of-line position. Actionable — see TODO L-DP-6.

### 2.2 `commitAnalyticsFiles` doesn't unstage on dirty_index

**Severity:** Low
**Type:** Side effect

When `commitAnalyticsFiles` detects non-analytics files in the staging area and returns `dirty_index`, it has already staged the analytics files (via `deps.gitAdd`). Those files remain staged, which could surprise a subsequent manual commit.

**Recommendation:** Unstage the analytics files before returning `dirty_index`, or document that the caller should handle this. Actionable — see TODO L-DP-7.

### 2.3 No schema validation on analytics file read

**Severity:** Low
**Type:** Robustness

`loadRuns` in `commands/analytics.ts` parses JSON and checks only `runTimestamp` (string) and `wallClockMs` (number). A partially corrupt file could have valid timestamp/duration but missing or wrong `items` array, producing misleading aggregate statistics.

**Recommendation:** Add basic structural validation (items array exists, each item has id and state). Actionable — see TODO L-DP-8.

### 2.4 Filename collision on same-second runs

**Severity:** Low
**Type:** Edge case

The analytics filename is derived from `runTimestamp` with colons and dots replaced. If two runs start in the same millisecond (unlikely but possible with automated triggers), the second write would overwrite the first.

**Observation only.** Very unlikely in practice. No TODO needed.

---

## 3. Analytics Command (`core/commands/analytics.ts`)

### 3.1 `itemsPerDay` is misleading for single-run data

**Severity:** Low
**Type:** UX

When only one run exists, `spanDays = 0` and the code falls back to `totalItemsShipped`. This means "items per day" could show "7.0" after a single run that shipped 7 items, which is misleading — that's items per run, not per day.

**Observation only.** Minor display issue, not worth a dedicated TODO.

### 3.2 `loadRuns` silently skips malformed JSON

**Severity:** Low
**Type:** Observability

The `catch {}` block on line 59 silently skips corrupt analytics files with no warning. This could make data loss invisible.

**Recommendation:** This is the same class of issue as 1.1 — add a warn callback or log. Could be bundled with a broader "observability for silent failures" effort. Actionable — see TODO L-DP-8 (combined with schema validation).

---

## 4. Webhook Failure Handling (`core/webhooks.ts`)

### 4.1 No timeout on fetch

**Severity:** Medium
**Type:** Resource leak

`fireWebhook` calls `fetchFn(url, ...)` without a timeout. If the webhook endpoint hangs (TCP connection established but no response), the promise stays pending indefinitely. While fire-and-forget means orchestration isn't blocked, each pending promise holds a reference to the payload, connection, and closure — accumulating over many events.

**Recommendation:** Add `AbortController` with a timeout (e.g., 10 seconds) to the fetch call. Actionable — see TODO M-DP-9.

### 4.2 No rate limiting or batching

**Severity:** Low
**Type:** Resilience

Rapid orchestration events (e.g., 5 items merging in quick succession) could fire 5+ webhooks in under a second. Slack's incoming webhook rate limit is 1 per second; Discord is 5 per 2 seconds. Exceeding these limits produces 429 errors that are logged but not retried.

**Recommendation:** Add a simple debounce/batch window (e.g., 2 seconds) that coalesces rapid events into a single webhook payload. Actionable — see TODO L-DP-10.

### 4.3 No URL validation

**Severity:** Low
**Type:** Fail-fast

`resolveWebhookUrl` returns the raw string from env or config without checking if it's a valid URL. Invalid URLs fail at fetch time with a less clear error message.

**Recommendation:** Validate URL format on resolve and warn early. Actionable — see TODO L-DP-11.

### 4.4 `formatWebhookText` switch has no default case

**Severity:** Low
**Type:** Defensive programming

The `switch (event)` on webhook event types doesn't have a `default` case. TypeScript's exhaustive checking covers this at compile time, but if a new event type is added and the switch isn't updated, the function returns `undefined` at runtime.

**Observation only.** TypeScript's type system handles this. Not worth a dedicated TODO.

---

## 5. Template Extensibility (`core/templates.ts`)

### 5.1 RegExp constructed per keyword per match

**Severity:** Low
**Type:** Performance

In `matchTemplates`, a new `RegExp` is constructed for each single-word keyword on each call. For N templates with K keywords matched against M descriptions, this is O(N * K * M) regex compilations. Pre-compiling regexes at template load time would improve performance.

**Recommendation:** Pre-compile keyword regexes in `parseTemplate` or `loadTemplates` and store them on the `DecompositionTemplate` object. Actionable — see TODO L-DP-12.

### 5.2 Template body includes Keywords metadata

**Severity:** Low
**Type:** UX

The `body` field stores the full markdown content, including the `## Keywords` section. When templates are rendered to the user (e.g., in `/decompose`), the keywords metadata section would be visible and confusing.

**Recommendation:** Strip the `## Keywords` section from `body` during parsing. Actionable — see TODO L-DP-13.

### 5.3 Multi-word keyword matching can have false positives

**Severity:** Low
**Type:** Accuracy

Multi-word keywords use `descLower.includes(keyword)` which matches substrings. For example, keyword `"create table"` would match `"recreate tables"`. This is unlikely to cause real issues given the nature of decomposition descriptions, but it's not perfectly precise.

**Observation only.** The current approach works well in practice. Word-boundary matching for multi-word phrases is complex and not worth the added complexity.

---

## 6. Cross-repo Edge Cases (`core/cross-repo.ts`)

### 6.1 `resolveRepo` calls `die()` instead of throwing

**Severity:** Medium
**Type:** Error handling

`resolveRepo` calls `die()` (which calls `process.exit(1)`) when a repo alias cannot be resolved. This makes it impossible for callers to catch and handle the error (e.g., to skip a cross-repo item and continue with others). It also makes the function difficult to test without process-level hooks.

**Recommendation:** Replace `die()` with `throw new Error(...)` and let callers decide how to handle the failure. Actionable — see TODO M-DP-14.

### 6.2 Cross-repo index append without deduplication

**Severity:** Low
**Type:** Data integrity

`writeCrossRepoIndex` appends entries without checking if the ID already exists. If a worker is retried, the index accumulates duplicate entries. `getWorktreeInfo` returns the first match, so functionally this works, but it wastes space and could cause confusion during debugging.

**Recommendation:** Check for existing entry before appending. Actionable — see TODO L-DP-15.

### 6.3 `removeCrossRepoIndex` read-filter-write race

**Severity:** Low
**Type:** Concurrency

The read → filter → write pattern in `removeCrossRepoIndex` is protected by a file lock. However, between `readFileSync` and `writeFileSync`, the lock is held, so no concurrent writes can happen. This is correct. **No issue found** — the lock protects the operation.

**Observation only.** The locking is correct for the current usage pattern.

### 6.4 `isGitRepo` doesn't detect git worktrees

**Severity:** Low
**Type:** Edge case

`isGitRepo` checks `existsSync(join(path, ".git"))`. Git worktrees have a `.git` file (not directory) containing `gitdir: /path/to/main/.git/worktrees/name`. The `existsSync` check works for both files and directories, so this actually handles worktrees correctly.

**Observation only.** No issue — `existsSync` returns true for both files and directories.

### 6.5 `listRepos` uses synchronous git commands

**Severity:** Low
**Type:** Performance

`listRepos` calls `run("git", [...])` synchronously for each sibling directory to get the remote URL. With many siblings (10+), this could take several seconds as each `git remote get-url` spawns a child process.

**Observation only.** `listRepos` is a CLI display command, not a hot path. Acceptable for current scale.

---

## 7. Configuration (`core/config.ts`)

### 7.1 No inline comment support

**Severity:** Low
**Type:** Edge case

Config lines like `KEY=value # this is a comment` would set the value to `"value # this is a comment"`. There's no inline comment stripping.

**Observation only.** The current format is simple and unambiguous. Adding inline comments would require defining an escape mechanism for values containing `#`. Not worth the complexity.

### 7.2 No config key validation

**Severity:** Low
**Type:** Fail-fast

Unknown config keys (e.g., typos like `webhook_URL` instead of `webhook_url`) are silently accepted and stored but never read. Users get no feedback that their config is misconfigured.

**Recommendation:** Validate known keys and warn on unrecognized ones. Actionable — see TODO L-DP-16.

### 7.3 Redundant domain file reading

**Severity:** Low
**Type:** Code quality

`loadDomainMappings()` returns a `Map<string, string>` by reading and parsing `domains.conf`. But `normalizeDomain()` in `parser.ts` reads the same file directly from disk via its `domainsFile` parameter. This means:
- Two different code paths parse the same file format
- The Map-based approach is unused by the parser (the primary consumer)
- Changes to the file format would need updates in two places

**Recommendation:** Refactor `normalizeDomain` to accept a `Map<string, string>` (from `loadDomainMappings`) instead of a file path. This consolidates the parsing logic and enables caching. Actionable — see TODO L-DP-17.

---

## Test Coverage Assessment

| Module | Test File | Coverage Notes |
|---|---|---|
| `parser.ts` | `parser.test.ts` | **Good.** 6 fixture types, edge cases for malformed input, wildcard deps, file paths. Missing: BOM handling, duplicate IDs. |
| `analytics.ts` | `analytics.test.ts` | **Good.** Covers metrics collection, persistence, cost parsing, auto-commit. Missing: corrupt file handling on read. |
| `commands/analytics.ts` | `analytics.test.ts` | **Good.** Covers summary computation, formatting, trend arrows, empty data. |
| `webhooks.ts` | `webhooks.test.ts` | **Good.** URL resolution, payload formatting, fire-and-forget, integration with orchestrateLoop. Missing: timeout behavior. |
| `templates.ts` | `templates.test.ts` | **Good.** Parsing, loading, matching, word boundaries, real template integration. |
| `cross-repo.ts` | `cross-repo.test.ts` | **Adequate.** Covers parsing, sibling discovery, index CRUD. Missing: `resolveRepo` error paths, `die()` behavior. |
| `config.ts` | `config.test.ts` | **Good.** Covers defaults, key-value parsing, comments, quotes, domain mappings. |

---

## Findings Summary

| ID | Module | Severity | Type | Actionable? |
|---|---|---|---|---|
| 1.1 | parser | Low | Observability | Yes (M-DP-1) |
| 1.2 | parser | Medium | Data integrity | Yes (M-DP-2) |
| 1.3 | parser | Low | Code quality | Yes (L-DP-3) |
| 1.4 | parser | Low | Edge case | Yes (L-DP-4) |
| 1.5 | parser | Low | Edge case | Yes (L-DP-5) |
| 2.1 | analytics | Low | Data accuracy | Yes (L-DP-6) |
| 2.2 | analytics | Low | Side effect | Yes (L-DP-7) |
| 2.3 | analytics | Low | Robustness | Yes (L-DP-8) |
| 4.1 | webhooks | Medium | Resource leak | Yes (M-DP-9) |
| 4.2 | webhooks | Low | Resilience | Yes (L-DP-10) |
| 4.3 | webhooks | Low | Fail-fast | Yes (L-DP-11) |
| 5.1 | templates | Low | Performance | Yes (L-DP-12) |
| 5.2 | templates | Low | UX | Yes (L-DP-13) |
| 6.1 | cross-repo | Medium | Error handling | Yes (M-DP-14) |
| 6.2 | cross-repo | Low | Data integrity | Yes (L-DP-15) |
| 7.2 | config | Low | Fail-fast | Yes (L-DP-16) |
| 7.3 | config | Low | Code quality | Yes (L-DP-17) |

**Actionable findings: 17** (3 medium, 14 low)
**Observations only: 7** (documented above but no code change needed)
