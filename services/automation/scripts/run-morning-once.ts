// One-shot operator script: invoke the morning-create-markets job exactly once
// against whatever's in .env. Same code path as the Trigger.dev `schedules.task`
// — just runs it locally without the cron + Trigger.dev runtime around it.
//
// Usage:
//   pnpm --filter @bell-markets/automation morning:once
//
// Day-4 (2026-05-22) intent: pilot the live wiring against Aria's deployed
// devnet program. Picks tomorrow's 4pm ET as the strike expiry so the program's
// `expiry_unix > now` check doesn't reject same-day runs invoked after 4pm ET
// local time.

import { runMorningCreateMarkets } from "../src/jobs/morning.js";
import { loadConfig } from "../src/config.js";

async function main() {
  const config = loadConfig();
  console.error(
    JSON.stringify({
      event: "operator.run-morning-once.start",
      programId: config.bellMarketsProgramId,
      idlPath: config.bellMarketsIdlPath,
      tickersWithPhoenix: Object.keys(config.phoenixMarkets),
      tickersWithPyth: Object.keys(config.pythPriceAccounts),
    }),
  );

  // runAt is set to tomorrow at noon UTC so `computeExpiryUnixFor4pmETSameDay`
  // returns tomorrow's 16:00 ET — comfortably in the future no matter when
  // the operator invokes this.
  const tomorrowNoonUtc = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrowNoonUtc.setUTCHours(12, 0, 0, 0);

  try {
    const outcome = await runMorningCreateMarkets({
      runAt: tomorrowNoonUtc,
      ctxRunId: `operator-${Date.now()}`,
      config,
    });
    console.log(JSON.stringify(outcome, null, 2));
    process.exit(outcome.perTicker.some((t) => t.status === "errored") ? 2 : 0);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "operator.run-morning-once.fatal",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    process.exit(1);
  }
}

main();
