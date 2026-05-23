// One-shot operator script: invoke the settlement-nudger job exactly once
// against whatever's in .env. Same code path as the Trigger.dev `schedules.task`
// — just runs it locally without the cron + Trigger.dev runtime around it.
//
// Usage:
//   pnpm --filter @bell-markets/automation settle:once
//
// Day-4 (2026-05-22) intent: prove the on-chain enumeration + retry harness
// against the live program. With no Unsettled+expired markets present, this
// is a no-op that exits ok with perMarket: [] — the right outcome.
//
// Coordinate with Drew before running if you suspect she may be running a
// settle simulation against the same markets (avoid double-settle races).

import { runSettlementNudger } from "../src/jobs/settlement.js";
import { loadConfig } from "../src/config.js";

async function main() {
  const config = loadConfig();
  console.error(
    JSON.stringify({
      event: "operator.run-settle-once.start",
      programId: config.bellMarketsProgramId,
      idlPath: config.bellMarketsIdlPath,
    }),
  );

  try {
    const outcome = await runSettlementNudger({
      runAt: new Date(),
      ctxRunId: `operator-${Date.now()}`,
      config,
    });
    console.log(JSON.stringify(outcome, null, 2));
    const anyErr = outcome.perMarket.some(
      (m) => m.status === "non-retriable-error" || m.status === "exhausted",
    );
    process.exit(anyErr ? 2 : 0);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "operator.run-settle-once.fatal",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    process.exit(1);
  }
}

main();
