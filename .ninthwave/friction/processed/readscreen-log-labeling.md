# readScreen output mislabeled as "Permanently stuck" for successful items

**Observed:** 2026-03-25, grind cycle 1 batch 3

## What happened

The readScreen diagnostic captures terminal output in executeClean. But executeClean runs for ALL terminal items (done, stuck, merged), not just stuck ones. So successfully merged items like M-ORC-1 and H-ONB-1 got logs saying "[M-ORC-1] Permanently stuck. Screen output: ..." even though they completed successfully.

## Fix

Only capture/log screen output with the "stuck" label when the item is actually in stuck state. For merged/done items being cleaned, either skip screen reading or use a neutral label like "Worker finished. Screen output:".
