# Review 1: Type System, Data Model & Configuration

## Summary

The ninthwave type system is pragmatically designed and, overall, serves the codebase well. Types are co-located by concern (`core/types.ts` for shared domain types, `core/orchestrator.ts` for state machine types, `core/daemon.ts` for serialization types), and there are zero uses of `any` across all reviewed files. The handful of `as` casts are limited to validated boundaries (priority parsing, JSON deserialization), which is reasonable.

The most significant structural issue is the divergence between `OrchestratorItem` (30+ optional fields, `core/orchestrator.ts:47-121`) and `DaemonStateItem` (`core/daemon.ts:19-63`). These two types represent the same entity at different layers (runtime vs. persistence), and the hand-written `serializeOrchestratorState()` mapping (`core/daemon.ts:489-528`) must be manually kept in sync. A field added to one and forgotten in the other would cause silent state loss on crash recovery. Today this is held together by discipline, not by the compiler.

Secondary concerns include: a `ProjectConfig` interface that uses an index signature (`[key: string]: string`) defeating type safety, a `WorkerCostData` interface that is defined but never imported outside its definition file, a `CODE_EXTENSIONS_FOR_LINE` constant that is exported but never used, and a hardcoded `MODEL_PRICING` table that will go stale as model versions change. The parser layer is clean and well-separated, though `work-item-files.ts` and `work-item-utils.ts` have an artificial split that adds cognitive overhead without clear benefit.

## Findings

### 1. OrchestratorItem / DaemonStateItem divergence risk -- SEVERITY: high
**Tag:** SIMPLIFY

`OrchestratorItem` (`core/orchestrator.ts:47-121`) has ~30 optional fields representing runtime orchestration state. `DaemonStateItem` (`core/daemon.ts:19-63`) is its serialized counterpart, with ~22 optional fields. The mapping between them lives in `serializeOrchestratorState()` (`core/daemon.ts:489-528`), a hand-written function that conditionally copies each field.

**Fields present in `OrchestratorItem` but absent from `DaemonStateItem`:**
- `partition` (line 55)
- `workspaceRef` (line 53)
- `lastCommitTime` (line 62)
- `eventTime` (line 66)
- `detectedTime` (line 68)
- `detectionLatencyMs` (line 70)
- `lastScreenOutput` (line 72)
- `baseBranch` (line 74)
- `resolvedRepoRoot` (line 76)
- `reviewVerdictPath` (line 80)
- `reviewCompleted` (present in both, but DaemonStateItem has it)
- `notAliveCount` (line 96)
- `lastAliveAt` (line 98)
- `needsCiFix` (line 112)

Some of these omissions are intentional (transient runtime state like `notAliveCount`), but others (`partition`, `workspaceRef`, `baseBranch`, `resolvedRepoRoot`) mean that a daemon crash/restart loses the ability to manage in-flight items properly. Workers launched before the crash won't be recoverable because their workspace references and partitions are gone.

**Recommendation:** Either (a) generate `DaemonStateItem` from `OrchestratorItem` using a `Pick`/`Omit` utility type with an explicit exclusion list for transient fields, or (b) add a compile-time check (e.g., a `satisfies` assertion or mapped type) that ensures every non-transient field in `OrchestratorItem` appears in `DaemonStateItem`. Estimated effort: ~50 LOC.

### 2. ProjectConfig uses index signature, defeating type safety -- SEVERITY: medium
**Tag:** SIMPLIFY

`ProjectConfig` (`core/types.ts:41-44`):
```typescript
export interface ProjectConfig {
  locExtensions: string;
  [key: string]: string;
}
```

The `[key: string]: string` index signature allows arbitrary key-value pairs. This means any `config["typo_key"]` access returns `string` instead of `undefined`, hiding bugs. In `core/config.ts:55-57`, `config["LOC_EXTENSIONS"]` is accessed via string indexing rather than a typed field.

**Recommendation:** Replace the index signature with explicit known fields:
```typescript
export interface ProjectConfig {
  locExtensions: string;
  reviewExternal?: string;
  githubToken?: string;
  scheduleEnabled?: string;
}
```
This aligns with the `KNOWN_CONFIG_KEYS` set (`core/config.ts:9-14`) that already enumerates valid keys. Estimated effort: ~30 LOC across `config.ts` and `types.ts`.

### 3. WorkerCostData is defined but never imported -- SEVERITY: low
**Tag:** STRIP

`WorkerCostData` (`core/types.ts:103-110`) defines cost and token data for a worker session. However, `grep` across the entire `core/` directory shows it is only referenced in `core/types.ts` itself -- never imported by any other file. The actual cost tracking uses `WorkerProgress` (`core/daemon.ts:340-351`) and `HeartbeatCostFields` (`core/daemon.ts:407-411`) instead.

**Recommendation:** Remove `WorkerCostData` from `core/types.ts`. It is dead code. Estimated effort: ~10 LOC.

### 4. CODE_EXTENSIONS_FOR_LINE is exported but never used -- SEVERITY: low
**Tag:** STRIP

`CODE_EXTENSIONS_FOR_LINE` (`core/types.ts:176-177`) is exported but never imported anywhere in the codebase. It appears to be a remnant from an earlier version of `extractFilePaths()`, which now uses `CODE_EXTENSIONS` directly.

**Recommendation:** Delete the constant. Estimated effort: ~3 LOC.

### 5. MODEL_PRICING is hardcoded and will go stale -- SEVERITY: medium
**Tag:** QUESTIONABLE

`MODEL_PRICING` (`core/types.ts:124-132`) hardcodes per-million-token prices for 7 models. This table:
- Will silently produce incorrect cost estimates when API pricing changes
- Must be manually updated for each new model release
- Is only used by `estimateCost()` (`core/types.ts:138-156`) which is only imported by `test/analytics.test.ts`

The `estimateCost` function has a prefix-matching fallback (`core/types.ts:148-149`) to handle versioned model names, which is pragmatic, but the staleness issue remains.

**Recommendation:** Two options: (a) externalize the pricing table to a config file or fetch it at startup, or (b) strip `MODEL_PRICING` and `estimateCost` entirely if cost tracking is purely informational and doesn't gate any behavior. The analytics dashboard can display raw token counts without dollar estimates. This is a product decision.

### 6. Unsafe `as Priority` cast in parseWorkItemFile -- SEVERITY: medium
**Tag:** SIMPLIFY

In `core/work-item-files.ts:85`:
```typescript
priority = p as Priority;
```

The variable `p` is derived from a regex match and lowercased, but the cast happens *before* the validation check at line 117-118:
```typescript
const validPriorities: Set<string> = new Set(Object.keys(PRIORITY_NUM));
if (!validPriorities.has(priority)) return null;
```

While the validation does catch invalid values (returning `null`), the cast at line 85 means `priority` has type `Priority` between lines 85 and 118, even though it may hold an invalid value. The second cast at line 142 is redundant since `priority` is already typed as `Priority` by that point.

**Recommendation:** Type `priority` as `string` initially and use a type guard function:
```typescript
function isPriority(s: string): s is Priority {
  return s in PRIORITY_NUM;
}
```
Then cast only after validation. Estimated effort: ~15 LOC.

### 7. Duplicate PRIORITY_RANK tables -- SEVERITY: low
**Tag:** SIMPLIFY

`PRIORITY_NUM` in `core/types.ts:22-27` and `PRIORITY_RANK` in `core/orchestrator.ts:13-18` are identical maps from `Priority` to `number` (critical=0, high=1, medium=2, low=3). Both are used in different contexts (sorting work items vs. merge queue ordering), but they have the same values and semantics.

**Recommendation:** Remove `PRIORITY_RANK` from `core/orchestrator.ts` and import `PRIORITY_NUM` from `core/types.ts` instead. The cast at `orchestrator.ts:2518-2519` (`as Priority`) would be unnecessary if the items are already typed. Estimated effort: ~10 LOC.

### 8. PRStatus interface is defined but never imported -- SEVERITY: low
**Tag:** STRIP

`PRStatus` (`core/types.ts:52-58`) defines a PR status shape, but no file in the codebase imports it. The orchestrator uses its own `ItemSnapshot` interface for PR state, and the `gh.ts` module returns ad-hoc objects. This is dead code.

**Recommendation:** Remove `PRStatus` from `core/types.ts`. Estimated effort: ~7 LOC.

### 9. JSON.parse with `as` casts lacks runtime validation -- SEVERITY: medium
**Tag:** SIMPLIFY

Multiple `JSON.parse(...) as T` patterns in `core/daemon.ts`:
- Line 266: `JSON.parse(content) as DaemonState`
- Line 312: `JSON.parse(content) as DaemonState`
- Line 372: `JSON.parse(content) as ReviewVerdict`
- Line 400: `JSON.parse(content) as WorkerProgress`
- Line 468: `JSON.parse(content) as ExternalReviewItem[]`

None of these validate the parsed JSON against the expected shape. If a file is corrupted, partially written, or from an older schema version, the cast succeeds but the object may be missing required fields, leading to runtime errors far from the deserialization site.

**Recommendation:** Add a lightweight validation function for at least `DaemonState` (the crash-recovery path), checking that `items` is an array and each item has `id` and `state` fields. Full schema validation (e.g., Zod) is overkill for this codebase, but a 10-line guard function would catch the most dangerous corruption scenarios. Estimated effort: ~30 LOC.

### 10. Config key=value parser doesn't validate value types -- SEVERITY: low
**Tag:** KEEP

`loadConfig()` (`core/config.ts:21-60`) parses key=value lines and stores everything as strings. There's no type coercion or range validation -- e.g., a user could set `schedule_enabled=maybe` and it would be silently accepted. The `KNOWN_CONFIG_KEYS` warning (`core/config.ts:44-52`) catches unknown keys but not malformed values.

However, since only 4 config keys exist and the config is rarely modified, this is low-risk. The warning for unknown keys is a pragmatic guard.

**Recommendation:** Keep as-is for now. If config grows beyond ~8 keys, add type-specific parsers. Current risk is low.

### 11. ID_PATTERN edge case: single-char domain codes -- SEVERITY: low
**Tag:** KEEP

`ID_PATTERN` (`core/types.ts:82`) is `/[A-Z]-[A-Za-z0-9]+-[0-9]+[a-z]*/`. The middle segment `[A-Za-z0-9]+` requires at least one character, which is correct. However, the pattern does not anchor (`^`/`$`), so it can match substrings of longer strings. This is intentional -- the pattern is used for extraction (finding IDs within text), not validation.

The `WILDCARD_DEP_PATTERN` (`core/types.ts:94`) at `/[A-Z](?:[A-Za-z0-9]*-)*\*/g` handles patterns like `MUX-*` and `H-MUX-*`. The expansion logic in `expandWildcardDeps()` (`core/work-item-utils.ts:167-202`) correctly distinguishes priority-prefixed patterns (single letter + domain) from domain-only patterns, using different matching strategies for each.

One edge case: an ID like `A-B-1` (single-char domain) would work correctly with the current pattern. An empty domain (`A--1`) would not match because `[A-Za-z0-9]+` requires at least one char, which is correct behavior.

**Recommendation:** No changes needed. The regex patterns are correct for their intended use.

### 12. OrchestratorItem has 30+ optional fields -- SEVERITY: medium
**Tag:** QUESTIONABLE

`OrchestratorItem` (`core/orchestrator.ts:47-121`) has accumulated ~30 optional fields representing various aspects of the orchestration lifecycle. This flat structure means every access to a field like `reviewWorkspaceRef` or `mergeCommitSha` requires optional chaining, and there's no compile-time guarantee that fields are set when expected for a given state.

For example, `prNumber` is optional but required in `ci-pending`/`ci-passed`/`merging` states. `mergeCommitSha` is set only during `merged` → `verifying` but accessed in `verify-failed` and `repairing-main`. The type system doesn't enforce these invariants.

State-discriminated unions (a different sub-interface per state) would make the type system enforce field presence. However, this would add significant structural complexity to the codebase (30+ state transitions would need explicit type narrowing), and the current approach works correctly in practice because `processTransitions` is well-tested.

**Recommendation:** This is a tradeoff between compile-time safety and implementation simplicity. The current flat-optional approach is pragmatic for a codebase of this size. If bugs arise from accessing fields in wrong states, consider adding runtime assertions at state boundaries rather than restructuring the type. Tag as QUESTIONABLE -- revisit if it becomes a bug source.

### 13. extractBody skips Bootstrap metadata -- SEVERITY: low
**Tag:** SIMPLIFY

`extractBody()` (`core/work-item-utils.ts:204-253`) strips metadata lines using `METADATA_PREFIXES` (`line 205-212`), but the prefix list does not include `**Bootstrap:**`. This means `Bootstrap: true` lines would leak into the extracted body text when round-tripping through `writeWorkItemFile` → `extractBody`.

Looking at `parseWorkItemFile` (`core/work-item-files.ts:108-110`), Bootstrap *is* parsed from raw text, so adding it to the metadata prefixes would be correct.

**Recommendation:** Add `"**Bootstrap:**"` to `METADATA_PREFIXES` in `core/work-item-utils.ts:204-212`. Estimated effort: ~1 LOC.

### 14. serializeOrchestratorState uses conditional spread for optional fields -- SEVERITY: low
**Tag:** KEEP

`serializeOrchestratorState()` (`core/daemon.ts:489-528`) uses the pattern `...(item.field ? { field: item.field } : {})` for each optional field. This is verbose (~20 instances) but intentional -- it produces clean JSON without `undefined` values, which aids readability of the state file.

The pattern is consistent and mechanical. While a utility function like `pickDefined(item, ["field1", "field2"])` would reduce verbosity, the current explicit approach makes it easy to see exactly which fields are serialized.

**Recommendation:** Keep as-is. The verbosity is acceptable given the correctness benefit.

## Theme A: Feature Necessity

### Assessment

| Feature | Tag | Rationale |
|---|---|---|
| `WorkItem` core fields | **KEEP** | Essential domain model, used everywhere |
| `OrchestratorItem` | **KEEP** | Core state machine, heavily tested |
| `OrchestratorConfig` | **KEEP** | All fields are wired to behavior |
| `DaemonStateItem` | **KEEP** | Required for crash recovery |
| `DaemonState` | **KEEP** | Required for PID management and status display |
| `PollSnapshot` / `ItemSnapshot` | **KEEP** | Clean abstraction for external state polling |
| `Action` / `ActionType` | **KEEP** | Pure state machine output, well-designed |
| `OrchestratorDeps` | **KEEP** | Clean dependency injection for testability |
| `WorkerCostData` | **STRIP** | Defined but never imported (Finding 3) |
| `CODE_EXTENSIONS_FOR_LINE` | **STRIP** | Exported but never used (Finding 4) |
| `PRStatus` | **STRIP** | Defined but never imported (Finding 8) |
| `MODEL_PRICING` + `estimateCost` | **QUESTIONABLE** | Only used in analytics tests; pricing will go stale (Finding 5) |
| `WorkspacePackage` / `WorkspaceConfig` | **KEEP** | Used by `core/commands/init.ts` for monorepo detection |
| `WatchResult` / `Transition` | **KEEP** | Used by `core/commands/pr-monitor.ts` |
| `ScheduledTask` | **KEEP** | Used by schedule subsystem (`core/schedule-files.ts`, `core/schedule-runner.ts`) |
| `PRIORITY_RANK` (orchestrator.ts) | **SIMPLIFY** | Duplicate of `PRIORITY_NUM` (Finding 7) |
| `RunResult` | **KEEP** | Used by `core/shell.ts` and many other modules |
| Layout preferences (daemon.ts) | **KEEP** | Serves TUI panel mode persistence |
| External review types (daemon.ts) | **KEEP** | Serves external PR review feature |
| Log rotation (daemon.ts) | **KEEP** | Prevents unbounded disk usage |
| Runtime state migration (daemon.ts) | **KEEP** | One-time migration for new state directory |

**Unused config options:** All `OrchestratorConfig` fields are wired to behavior in the state machine. The `KNOWN_CONFIG_KEYS` set in `config.ts` has 4 entries, all of which are used: `LOC_EXTENSIONS` (version bump), `review_external` (external PR review), `github_token` (auth), `schedule_enabled` (scheduled tasks).

### Summary

3 items should be stripped (dead code), 2 simplified, and 1 needs a product decision. The vast majority of types and features serve real user outcomes in the core pipeline.

## Theme B: Complexity Reduction

### Can the type hierarchy be flattened?

The type hierarchy is already fairly flat. `core/types.ts` defines shared domain types; `core/orchestrator.ts` defines state machine types; `core/daemon.ts` defines serialization types. The main layering question is whether `OrchestratorItem` should be flattened into state-discriminated unions (Finding 12). **Verdict: No -- the runtime cost of restructuring outweighs the compile-time safety benefit at this codebase size.**

### Should work-item-files.ts and work-item-utils.ts be merged?

`core/parser.ts` (49 lines) delegates to `core/work-item-files.ts` (346 lines) and re-exports from `core/work-item-utils.ts` (291 lines). The split was introduced to break a bidirectional dependency (noted in `work-item-utils.ts:3`). However:

- `work-item-files.ts` imports from `work-item-utils.ts` (line 19)
- `parser.ts` re-exports from `work-item-utils.ts` (lines 10-17)
- External consumers import from `parser.ts` or directly from the individual files

The three-file arrangement adds cognitive overhead for developers wondering "where does parsing logic go?" The bidirectional dependency concern is valid, but it could be resolved by having a single `work-items.ts` file that contains all three files' content (~686 LOC total), with `parser.ts` reduced to a thin adapter for the `parseWorkItems` function that adds the origin/main filtering.

**Verdict: SIMPLIFY.** Merge `work-item-utils.ts` into `work-item-files.ts` (or a renamed `work-items.ts`). Keep `parser.ts` as the thin adapter with origin/main filtering. This reduces the three-file arrangement to two files. **Estimated savings: ~40 LOC of imports/re-exports, plus cognitive overhead reduction.**

### Is there unnecessary indirection in the parser layer?

`parser.ts` (49 lines) is a thin wrapper around `listWorkItems()` that adds origin/main filtering. This is a reasonable separation of concerns -- the filtering is a different responsibility (execution safety) from the parsing (file reading). **Verdict: KEEP the indirection, but merge the files it wraps (above).**

### LOC Estimates for Simplification

| Action | LOC Change |
|---|---|
| Strip `WorkerCostData`, `CODE_EXTENSIONS_FOR_LINE`, `PRStatus` | -25 LOC |
| Merge `PRIORITY_RANK` into `PRIORITY_NUM` usage | -8 LOC |
| Add `**Bootstrap:**` to `METADATA_PREFIXES` | +1 LOC |
| Merge `work-item-utils.ts` into `work-item-files.ts` | -40 LOC (imports/re-exports) |
| Replace `ProjectConfig` index signature with typed fields | +10 LOC (net, removes flexibility) |
| Add `DaemonState` validation guard | +30 LOC |
| **Net change** | **~-32 LOC** |

## Recommendations

**Priority 1 (High -- correctness risk):**
1. **Add compile-time or runtime sync check between `OrchestratorItem` and `DaemonStateItem`** (Finding 1). A field forgotten in `serializeOrchestratorState()` causes silent state loss on crash recovery. This is the highest-risk finding.
2. **Add lightweight validation for `DaemonState` deserialization** (Finding 9). Corrupted state files could crash the daemon on restart.

**Priority 2 (Medium -- code quality):**
3. **Replace `ProjectConfig` index signature with typed fields** (Finding 2). Aligns the type with the already-existing `KNOWN_CONFIG_KEYS` set.
4. **Use type guard for Priority validation** instead of `as` cast (Finding 6). Small change, better safety.
5. **Add `**Bootstrap:**` to `METADATA_PREFIXES`** (Finding 13). Prevents metadata leaking into body text.

**Priority 3 (Low -- cleanup):**
6. **Strip dead exports:** `WorkerCostData`, `CODE_EXTENSIONS_FOR_LINE`, `PRStatus` (Findings 3, 4, 8). ~25 LOC of dead code.
7. **Deduplicate `PRIORITY_RANK`/`PRIORITY_NUM`** (Finding 7). ~8 LOC.
8. **Merge `work-item-utils.ts` into `work-item-files.ts`** (Theme B). Reduces cognitive overhead.

**Product decision needed:**
9. **`MODEL_PRICING` / `estimateCost`** (Finding 5). Decide: externalize, strip, or accept staleness.
10. **`OrchestratorItem` flat-optional structure** (Finding 12). Monitor for bugs; restructure only if it becomes a source of defects.
