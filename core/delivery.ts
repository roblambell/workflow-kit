// Shared delivery verification and retry logic for terminal multiplexer adapters.
// Extracted from send-message.ts so multiplexer paths share identical
// verification and retry semantics.

export type Sleeper = (ms: number) => void;

/** Options for retry with exponential backoff. */
export interface RetryOptions {
  sleep: Sleeper;
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Check whether a message was delivered by inspecting screen content.
 *
 * Returns true if the message appears to have been submitted (not stuck in the
 * input field). If the last non-blank screen line contains a significant prefix
 * of the message, the message is likely still sitting in an input field —
 * meaning Return fired before the paste completed.
 */
export function checkDelivery(
  screenContent: string,
  message: string,
): boolean {
  const lines = screenContent
    .split("\n")
    .filter((l) => l.trim() !== "");

  if (lines.length === 0) return true;

  // If the last visible line contains a significant prefix of our message,
  // it's likely still sitting in the input field (not yet submitted).
  const lastLine = lines[lines.length - 1]!;
  const probe = message.length > 60 ? message.slice(0, 60) : message;

  return !lastLine.includes(probe);
}

/**
 * Retry an operation with exponential backoff.
 *
 * Calls `attemptFn` up to `maxRetries + 1` times. On each retry after the
 * first attempt, sleeps for `baseDelayMs * 2^(attempt-1)` milliseconds.
 * Returns true as soon as `attemptFn` succeeds.
 */
export function sendWithRetry(
  attemptFn: () => boolean,
  opts: RetryOptions,
): boolean {
  const { sleep, maxRetries = 3, baseDelayMs = 100 } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
    if (attemptFn()) {
      return true;
    }
  }

  return false;
}
