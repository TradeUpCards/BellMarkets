// DR-010 — period-close distribute crons.
//
// Two Trigger.dev tasks:
//
//   - Weekly:   Friday 5:00 PM ET ("0 17 * * 5", America/New_York, gated by isTradingDay)
//   - Monthly:  Last trading Friday of month at 5:00 PM ET ("0 17 * * 5",
//                gated by isLastTradingFridayOfMonth)
//
// Both fire on the same cron expression — the monthly gate is a subset of
// the weekly gate. On months whose last trading Friday is also the cron
// firing day, BOTH crons fire (correct — they close distinct period kinds).
//
// Each fire:
//   1. Compute period (this ISO week, or this calendar month)
//   2. runDistributeForPeriod(period)
//   3. Persist snapshot + on-chain distribute attempts (stubs until Aria
//      deploys distribute_*_rewards)
//
// `readPoolBalance` reads the on-chain pool token account. Stub returns
// "0.00" so the cron exercises the persistence + Merkle paths without a
// real on-chain pool funded.

import { schedules } from "@trigger.dev/sdk/v3";

import { isTradingDay } from "../calendar.js";
import { isLastTradingFridayOfMonth, periodForDate } from "../indexer/periods.js";
import { runDistributeForPeriod } from "../indexer/distribute.js";
import type { PeriodKind } from "../db/types.js";

export const weeklyDistributeJob = schedules.task({
  id: "distribute-weekly-rewards",
  cron: {
    pattern: "0 17 * * 5",
    timezone: "America/New_York",
  },
  maxDuration: 600,
  run: async (payload, { ctx }) => {
    const runAt = payload.timestamp;
    if (!isTradingDay(runAt)) {
      return {
        ok: true,
        skipped: true,
        reason: "not a trading day",
        runAt: runAt.toISOString(),
      };
    }
    return runDistributeForKind(runAt, "weekly", ctx.run.id);
  },
});

export const monthlyDistributeJob = schedules.task({
  id: "distribute-monthly-rewards",
  cron: {
    pattern: "0 17 * * 5",
    timezone: "America/New_York",
  },
  maxDuration: 600,
  run: async (payload, { ctx }) => {
    const runAt = payload.timestamp;
    if (!isLastTradingFridayOfMonth(runAt)) {
      return {
        ok: true,
        skipped: true,
        reason: "not last trading Friday of month",
        runAt: runAt.toISOString(),
      };
    }
    return runDistributeForKind(runAt, "monthly", ctx.run.id);
  },
});

async function runDistributeForKind(runAt: Date, kind: PeriodKind, ctxRunId: string) {
  const period = periodForDate(runAt, kind);
  void ctxRunId; // available for richer log enrichment
  return runDistributeForPeriod({
    period,
    readPoolBalance: stubReadPoolBalance,
  });
}

/**
 * Default pool-balance reader. Returns "0.00" — the on-chain pool PDA isn't
 * funded until DR-010 mint-time fee-split lands in Aria's `mint_pair`. When
 * Aria deploys, swap this for a real `connection.getTokenAccountBalance(poolPda)`
 * lookup.
 */
async function stubReadPoolBalance(_kind: PeriodKind): Promise<string> {
  return "0.00";
}
