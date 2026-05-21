// Settlement nudger (~4:05 PM ET): for each open contract, call
// `settle_market` (permissionless — DR-002). Best-effort. If Pyth
// confidence is too wide, retries every 30s for up to 15min. If still
// failing after the window, alerts the admin for manual `admin_settle`
// (which has its own ≥1hr on-chain delay gate — Hard YES #7).
//
// Day-1 status: stub — no on-chain calls yet. The job logs that it
// *would* settle the day's open markets and exits successfully.
//
// Cron: `5 21 * * 1-5` = 4:05 PM ET on US weekdays during EDT (UTC-4).
// DST: the EST half of the year needs `5 22 * * 1-5` instead. Same
// known-issue tracking as morning.ts. Out of scope for Day 1.
//
// DR-002 hard rule: settle_market is permissionless. This nudger is a
// convenience caller, not an authority. Removing the nudger entirely
// must not break the system — any user can call settle_market with
// the same instruction shape.

import { schedules } from "@trigger.dev/sdk/v3";

import { loadConfig, requireConfig } from "../config.js";

export const settlementNudgerJob = schedules.task({
  id: "settlement-nudger",
  cron: "5 21 * * 1-5",
  maxDuration: 900, // 15min — matches the PRD-mandated retry window
  run: async (payload, { ctx }) => {
    const config = loadConfig();
    const logBase = { jobId: "settlement-nudger", runAt: payload.timestamp.toISOString(), ctxRunId: ctx.run.id };

    if (!config.programId) {
      console.info(
        JSON.stringify({
          ...logBase,
          stub: true,
          reason: "PROGRAM_ID not yet configured — Aria's program is not deployed. Would iterate open StrikeMarket accounts and call settle_market on each.",
        }),
      );
      return { ok: true, stub: true } as const;
    }

    requireConfig(config, ["heliusRpcUrl", "programId", "adminKeypairPath"]);
    throw new Error(
      "settlement-nudger: config is complete but on-chain wiring is not implemented yet. Unset PROGRAM_ID until Aria's program is deployed.",
    );
  },
});
