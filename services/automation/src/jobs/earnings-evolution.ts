// DR-011 earnings-calendar cron wrapper.
//
// Single cron at 4:30 PM ET on every trading day. Fires AFTER Phase 1 /
// Phase 1b have anchored TickerConfig at 4:05 PM ET (Phase 1) / 1:05 PM ET
// (Phase 1b); this layers the earnings adjustment on top.

import { schedules } from "@trigger.dev/sdk/v3";

import { isTradingDay } from "../calendar.js";
import { runEarningsCronOnce } from "../earnings-evolution.js";

export const earningsEvolutionJob = schedules.task({
  id: "earnings-evolution",
  cron: {
    pattern: "30 16 * * 1-5",
    timezone: "America/New_York",
  },
  maxDuration: 300,
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
    return runEarningsCronOnce({ runAt, ctxRunId: ctx.run.id });
  },
});
