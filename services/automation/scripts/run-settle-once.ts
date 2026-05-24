// One-shot operator script: invoke the settlement-nudger job exactly once
// against whatever's in .env. Same code path as the Trigger.dev `schedules.task`
// — just runs it locally without the cron + Trigger.dev runtime around it.
//
// Usage:
//   pnpm --filter @bell-markets/automation settle:once
//   pnpm --filter @bell-markets/automation settle:once -- --at=2026-05-23T20:00:00Z
//   pnpm --filter @bell-markets/automation settle:once -- --at=1748030400
//
// The optional `--at=<iso|unix>` arg overrides the off-chain `runAt` that
// the open-markets SCAN filters against. Useful to validate the scan path
// pre-expiry (e.g. "show me the markets that WOULD be picked up at 4pm ET
// today"). NOTE: this DOES NOT change on-chain semantics — `settle_market`
// itself enforces `expiry <= clock.unix_timestamp` against the real chain
// clock, so any tx sent before actual expiry will revert NotExpired (6003)
// and surface as `non-retriable-error` in the per-market outcome.
//
// Coordinate with Drew before running if you suspect she may be running a
// settle simulation against the same markets (avoid double-settle races).

import { runSettlementNudger } from "../src/jobs/settlement.js";
import { loadConfig } from "../src/config.js";

function parseAtArg(): Date {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--at=")) {
      const raw = arg.slice("--at=".length);
      // Try unix seconds first (integer), then ISO 8601.
      if (/^\d+$/.test(raw)) {
        const seconds = Number(raw);
        return new Date(seconds * 1000);
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid --at value "${raw}". Use ISO 8601 or unix seconds.`);
      }
      return d;
    }
  }
  return new Date();
}

async function main() {
  const config = loadConfig();
  const runAt = parseAtArg();
  console.error(
    JSON.stringify({
      event: "operator.run-settle-once.start",
      programId: config.bellMarketsProgramId,
      idlPath: config.bellMarketsIdlPath,
      runAt: runAt.toISOString(),
      runAtUnix: Math.floor(runAt.getTime() / 1000),
      isWallClockOverride: runAt.getTime() !== Date.now() && Math.abs(runAt.getTime() - Date.now()) > 60_000,
    }),
  );

  try {
    const outcome = await runSettlementNudger({
      runAt,
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
