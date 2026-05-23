// One-shot operator script: close a weekly or monthly leaderboard period
// against whatever's currently in user_streaks.
//
// Usage:
//   pnpm --filter @bell-markets/automation distribute:once weekly
//   pnpm --filter @bell-markets/automation distribute:once monthly
//
// What it does:
//   1. Compute the period for "now" (this ISO week, or this calendar month)
//   2. Read top-10 from user_streaks
//   3. Build Merkle tree + upload leaderboard to Arweave (stub if no wallet)
//   4. Try to commit_leaderboard_root + distribute_*_rewards on chain
//      (returns "Awaiting Aria" until those ixs deploy; persistence layer
//      still writes the snapshot + per-position rolled-over rows)
//   5. Print summary JSON
//
// Demo path: even with NO winners (empty user_streaks), exit 0 and surface
// the rolled-over amount + the merkle-less snapshot.
//
// Requires DATABASE_URL in .env (Neon connection string).

import { runDistributeForPeriod } from "../src/indexer/distribute.js";
import { periodForDate } from "../src/indexer/periods.js";
import type { PeriodKind } from "../src/db/types.js";

async function main() {
  const kindArg = process.argv[2];
  if (kindArg !== "weekly" && kindArg !== "monthly") {
    console.error(
      JSON.stringify({
        event: "operator.run-distribute-once.fatal",
        error: `usage: distribute:once <weekly|monthly> (got "${kindArg}")`,
      }),
    );
    process.exit(2);
  }
  const kind: PeriodKind = kindArg;
  const now = new Date();
  const period = periodForDate(now, kind);

  console.error(
    JSON.stringify({
      event: "operator.run-distribute-once.start",
      kind,
      periodId: period.id,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
    }),
  );

  try {
    const outcome = await runDistributeForPeriod({
      period,
      // Stub pool: assume $0.00 for now (no real pool funded yet). Demo
      // path proves the persistence + Merkle/Arweave path runs end-to-end.
      readPoolBalance: async () => "0.00",
    });
    console.log(JSON.stringify(outcome, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "operator.run-distribute-once.fatal",
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    process.exit(1);
  }
}

main();
