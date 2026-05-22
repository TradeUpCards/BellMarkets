// Generic deadline-bounded retry helper with injectable clock + sleep.
//
// Why this exists: PRD mandates settle_market retry on Pyth-confidence-wide
// failures every 30s for up to 15min. Trigger.dev's job-level retry policy
// (configured in trigger.config.ts) restarts the WHOLE job on failure, which
// is the wrong granularity — we need to retry one market while continuing on
// to the next. So this helper lives inside the job body.
//
// Design notes:
//   - `now()` + `sleep()` are injectable so vitest can fast-forward time
//     without `vi.useFakeTimers()` global magic.
//   - `shouldRetry` is a callback the caller supplies. The helper doesn't
//     know anything about Anchor errors or HTTP status codes — that's the
//     job's job (e.g., settlement.ts checks for PythConfidenceTooWide).
//   - On `non-retriable` we stop immediately. On `exhausted` we report
//     attempts + the last error so the caller can decide whether to
//     escalate (e.g., alert for admin_settle).

export type RetryDeps = {
  /** Milliseconds since epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Wait `ms` milliseconds. Defaults to `setTimeout`-backed promise. */
  sleep?: (ms: number) => Promise<void>;
};

export type RetryOptions<E = unknown> = RetryDeps & {
  /** Interval between attempts, in ms. */
  intervalMs: number;
  /** Total deadline window, in ms. */
  deadlineMs: number;
  /** Return `true` to retry on this error, `false` to abort immediately. */
  shouldRetry: (error: E, attempt: number) => boolean;
};

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number; elapsedMs: number }
  | {
      ok: false;
      error: unknown;
      reason: "exhausted" | "non-retriable";
      attempts: number;
      elapsedMs: number;
    };

/**
 * Run `fn` repeatedly until it resolves, exhausts the deadline, or hits a
 * non-retriable error. Each retry waits `intervalMs` between attempts.
 *
 * The helper is greedy about the deadline: if the next sleep would push past
 * `deadlineMs`, it exits immediately rather than sleeping then giving up.
 */
export async function retryUntilDeadline<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const start = now();
  const deadline = start + opts.deadlineMs;
  let attempts = 0;
  let lastError: unknown;

  while (now() < deadline) {
    attempts++;
    try {
      const value = await fn();
      return { ok: true, value, attempts, elapsedMs: now() - start };
    } catch (err) {
      lastError = err;
      if (!opts.shouldRetry(err, attempts)) {
        return { ok: false, error: err, reason: "non-retriable", attempts, elapsedMs: now() - start };
      }
      // If the next sleep would push past the deadline, don't bother sleeping —
      // return `exhausted` now with a smaller elapsedMs.
      if (now() + opts.intervalMs >= deadline) break;
      await sleep(opts.intervalMs);
    }
  }
  return { ok: false, error: lastError, reason: "exhausted", attempts, elapsedMs: now() - start };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
