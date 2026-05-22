import { describe, it, expect } from "vitest";
import { retryUntilDeadline } from "../../services/automation/src/lib/retry.js";

// Fake clock: hands the test exact control over time progression so we can
// validate retry counts + elapsed-ms accounting without sleeping in real time.
function makeFakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("retryUntilDeadline — happy paths", () => {
  it("returns ok on first success without sleeping", async () => {
    const clock = makeFakeClock();
    const result = await retryUntilDeadline(async () => "value-1", {
      intervalMs: 30_000,
      deadlineMs: 15 * 60 * 1000,
      shouldRetry: () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("value-1");
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(0);
  });

  it("retries on retriable error and succeeds on attempt 3", async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const result = await retryUntilDeadline(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok-on-3";
      },
      {
        intervalMs: 30_000,
        deadlineMs: 15 * 60 * 1000,
        shouldRetry: () => true,
        now: clock.now,
        sleep: clock.sleep,
      },
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("ok-on-3");
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(60_000); // two 30s sleeps
  });
});

describe("retryUntilDeadline — non-retriable", () => {
  it("aborts on first non-retriable error", async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const result = await retryUntilDeadline(
      async () => {
        calls++;
        throw new Error("hard-stop");
      },
      {
        intervalMs: 30_000,
        deadlineMs: 15 * 60 * 1000,
        shouldRetry: () => false,
        now: clock.now,
        sleep: clock.sleep,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("non-retriable");
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
    expect((result.error as Error).message).toBe("hard-stop");
  });

  it("passes attempt number to shouldRetry", async () => {
    const clock = makeFakeClock();
    const seenAttempts: number[] = [];
    const result = await retryUntilDeadline(
      async () => {
        throw new Error("retriable for a bit");
      },
      {
        intervalMs: 30_000,
        deadlineMs: 5 * 60 * 1000,
        shouldRetry: (_err, attempt) => {
          seenAttempts.push(attempt);
          return attempt < 3;
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    );
    if (result.ok) throw new Error("expected failure");
    expect(seenAttempts).toEqual([1, 2, 3]);
    expect(result.reason).toBe("non-retriable");
    expect(result.attempts).toBe(3);
  });
});

describe("retryUntilDeadline — deadline exhaustion", () => {
  it("exhausts after 15min × 30s intervals — PRD-mandated cadence", async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const result = await retryUntilDeadline(
      async () => {
        calls++;
        throw new Error("PythConfidenceTooWide");
      },
      {
        intervalMs: 30_000,
        deadlineMs: 15 * 60 * 1000,
        shouldRetry: () => true,
        now: clock.now,
        sleep: clock.sleep,
      },
    );
    if (result.ok) throw new Error("expected exhausted");
    expect(result.reason).toBe("exhausted");
    // 15min / 30s = 30 windows; the loop exits on the iteration whose
    // post-failure check would push past the deadline. With now=t and
    // intervalMs=30_000: attempt N occurs at t = (N-1)*30_000. The break
    // triggers when t + 30_000 >= 900_000 → t >= 870_000 → N-1 = 29 → N = 30.
    expect(result.attempts).toBe(30);
    expect(calls).toBe(30);
    // elapsedMs is the time of the last failed attempt — 29 sleeps × 30s.
    expect(result.elapsedMs).toBe(29 * 30_000);
  });

  it("aborts immediately if deadlineMs is 0", async () => {
    const clock = makeFakeClock();
    const result = await retryUntilDeadline(async () => "shouldnt-reach", {
      intervalMs: 30_000,
      deadlineMs: 0,
      shouldRetry: () => true,
      now: clock.now,
      sleep: clock.sleep,
    });
    if (result.ok) throw new Error("expected exhausted");
    expect(result.reason).toBe("exhausted");
    expect(result.attempts).toBe(0);
  });

  it("uses defaults when now/sleep not injected — real timers", async () => {
    // Just smoke that the defaults work; use small interval so the test is fast.
    const start = Date.now();
    const result = await retryUntilDeadline(async () => "fast", {
      intervalMs: 1,
      deadlineMs: 100,
      shouldRetry: () => true,
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toBe("fast");
    expect(Date.now() - start).toBeLessThan(50);
  });
});
