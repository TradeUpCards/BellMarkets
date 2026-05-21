// Morning job (~8:00 AM ET): for each MAG7 stock, read previous close
// from Pyth HTTP, compute strikes (strike-calc), and (once Aria's
// program is deployed) call `create_strike_market` per unique strike.
//
// Day-1 status: stub — no on-chain calls yet. Program is not deployed
// until Aria's Sat 5/23 first push. Until then the job logs the
// computed strikes and exits successfully. The kickoff explicitly asks
// for the stub shape so the Trigger.dev project shape is in place when
// Aria's program lands.
//
// Cron: `0 13 * * 1-5` = 8:00 AM ET on US weekdays during EDT (UTC-4).
// DST: this expression is correct for EDT (mid-Mar – early-Nov). When
// the US shifts back to EST in early November, 8am ET = 13:00 UTC
// becomes 8am ET = 14:00 UTC — the cron must be updated to
// `0 14 * * 1-5` for the EST half of the year. Tracked as a known
// issue in the bram-handoff; out of scope for Day 1.
//
// DR-002 reminder: this job has NO special signing authority over
// create_strike_market beyond what any "operator" wallet would have.
// The settlement nudger (settlement.ts) has even less — settle_market
// is permissionless and any user can call it. Hard rule from
// constitution/hard-rules.md §4.2.

import { schedules } from "@trigger.dev/sdk/v3";

import { MAG7 } from "../types.js";
import { computeStrikesForStock } from "../strike-calc.js";
import { loadConfig, requireConfig, PYTH_FEED_IDS } from "../config.js";

export const morningCreateMarketsJob = schedules.task({
  id: "morning-create-markets",
  cron: "0 13 * * 1-5",
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const config = loadConfig();
    const logBase = { jobId: "morning-create-markets", runAt: payload.timestamp.toISOString(), ctxRunId: ctx.run.id };

    // For Day 1 we log placeholder lines per ticker so the Trigger.dev
    // run shows the job exercised the strike-calc path end-to-end.
    // Pyth HTTP isn't called yet — the previous-close read is hard-coded
    // to a deterministic synthetic value per ticker. This keeps the
    // stub free of any live external dependency (constitution/hard-rules.md §2.2).
    const results: Array<{ ticker: string; previousClose: number; strikes: number[] }> = [];

    for (const ticker of MAG7) {
      // Deterministic synthetic prev close per ticker until Pyth wiring lands.
      // Roughly anchored to spring-2026 levels so logs look realistic in dev.
      const syntheticPrevClose = SYNTHETIC_PREV_CLOSE_USD[ticker];
      const strikes = computeStrikesForStock(syntheticPrevClose);
      results.push({ ticker, previousClose: syntheticPrevClose, strikes });
      console.info(JSON.stringify({ ...logBase, ticker, syntheticPrevClose, strikes }));
    }

    if (!config.programId) {
      console.info(
        JSON.stringify({
          ...logBase,
          stub: true,
          reason: "PROGRAM_ID not yet configured — Aria's program is not deployed. Would call create_strike_market for each strike above.",
          plannedCalls: results.reduce((sum, r) => sum + r.strikes.length, 0),
        }),
      );
      return { ok: true, stub: true, results } as const;
    }

    // When PROGRAM_ID is configured (Day 2+), this branch becomes a real
    // create_strike_market loop. Fail-fast on missing config first so the
    // half-wired-deploy state is loud rather than silent — and so the
    // run shows a single descriptive error instead of a deep stack from
    // PythClient/HeliusClient construction.
    requireConfig(config, ["heliusRpcUrl", "pythHttpBaseUrl", "programId", "adminKeypairPath"]);
    throw new Error(
      "morning-create-markets: config is complete but on-chain wiring is not implemented yet. Unset PROGRAM_ID until Aria's program is deployed and the Anchor client is wired.",
    );
  },
});

// Synthetic previous-close values used by the Day-1 stub. Replaced by
// real Pyth HTTP reads in Day 2. Anchored to recent (May 2026) ranges
// to make dev logs look plausible. Not used in production.
const SYNTHETIC_PREV_CLOSE_USD: Record<(typeof MAG7)[number], number> = {
  AAPL: 230,
  MSFT: 437.5,
  GOOGL: 175,
  AMZN: 188,
  NVDA: 970,
  META: 680,
  TSLA: 245,
};
