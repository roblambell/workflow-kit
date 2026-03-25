# Supervisor LLM call failing repeatedly

**Observed:** 2026-03-25, grind cycle 1 batch 3

## What happened

Throughout the orchestration run, every supervisor tick logged `"status":"llm_call_failed"`. The supervisor is supposed to use an LLM for anomaly detection and friction logging, but the API call is failing silently (no error details in the log).

## Impact

The supervisor degrades to a no-op when LLM calls fail. Anomaly detection and automatic friction logging don't work. The supervisor still runs but produces no useful output.

## What needs to happen

1. Log the actual error from the LLM call (timeout? auth? rate limit?)
2. Add a backoff or disable the supervisor after N consecutive failures
3. Consider whether the supervisor needs its own API key or can share the session's
