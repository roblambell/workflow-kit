# Remote branch deletion fails when GitHub auto-delete is enabled

**Date:** 2026-03-25
**Severity:** low
**Component:** orchestrator cleanup / `action: clean`

## Observation

After each merge, the orchestrator tries to delete the remote branch (`git push origin --delete ninthwave/X`), but GitHub's "auto-delete head branches" setting already removed them. This produces a noisy warning on every item:

```
Warning: Failed to delete remote branch ninthwave/M-OBS-1: git push failed (exit 1): error: unable to delete 'ninthwave/M-OBS-1': remote ref does not exist
```

Happened for all 3 items (M-OBS-1, L-DOC-2, L-VIS-7).

## Suggested fix options (need CEO/eng review on correct default)

1. **Config option:** `remote_branch_cleanup: auto | always | never` — let the user specify.
2. **Auto-detect:** Before deleting, check if the remote branch exists (`git ls-remote --heads origin ninthwave/X`). Skip if already gone.
3. **Default to not deleting:** If the branch is already gone after merge, GitHub auto-delete is likely on. Default to skipping remote deletion and only attempt it if explicitly configured.
4. **Suppress the warning:** Treat "remote ref does not exist" as a non-error (branch already cleaned up = success).

## Impact

Low — purely cosmetic noise, but it makes the logs look like something went wrong when everything is fine.
