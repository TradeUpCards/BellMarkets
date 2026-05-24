// Generate a per-wallet PNL digest for the demo.
//
// Usage:
//   pnpm --filter @bell-markets/automation pnl-digest:gen <wallet_pubkey>
//
// Workflow:
//   1. Query user_market_holds × settle_events within a period (default = last 7 days)
//   2. Compute deterministic stats (won/lost/net/win-count/loss-count)
//   3. Build Sonnet prompt with the stats + top-N positions
//   4. callAnthropic → persist via insertPnlDigest
//
// Cleo's GET /api/pnl-digest/:wallet reads the most recent row.
//
// Stub-friendly: same contract as gen-briefings.ts. ANTHROPIC_API_KEY
// unset → deterministic stub body, model='stub', cost=0.

import {
  buildPnlDigestPrompt,
  callAnthropic,
  insertPnlDigest,
  listUserPositionsInPeriod,
  type PnlDigestPosition,
  type PnlDigestStats,
} from "../src/ai/index.js";
import { createHash } from "node:crypto";

function parsePeriodFromArgs(): { start: Date; end: Date; days: number } {
  // Look for --days=N; default 7
  let days = 7;
  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith("--days=")) days = Math.max(1, Math.min(30, Number(arg.slice(7)) || 7));
  }
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end, days };
}

function dollarsFromHeld(heldStr: string): number {
  // user_market_holds.yes_held / no_held stored as NUMERIC (UI-ready amount,
  // not base units). yes_held = N pairs × $1/pair after redeem semantics.
  const n = Number(heldStr);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const wallet = process.argv[2];
  if (!wallet) {
    console.error(
      JSON.stringify({
        event: "gen-pnl-digest.fatal",
        error: "usage: gen-pnl-digest <wallet_pubkey> [--days=7]",
      }),
    );
    process.exit(2);
  }

  const { start, end, days } = parsePeriodFromArgs();
  console.error(
    JSON.stringify({
      event: "gen-pnl-digest.start",
      wallet,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      days,
      mode: process.env.ANTHROPIC_API_KEY ? "live" : "stub",
    }),
  );

  const rawPositions = await listUserPositionsInPeriod(wallet, start, end);

  // Compute stats — wins, losses, invalid, abstained
  let wonAmountUsdc = 0;
  let lostAmountUsdc = 0;
  let winCount = 0;
  let lossCount = 0;
  let invalidCount = 0;
  let abstainedCount = 0;
  const positions: PnlDigestPosition[] = [];

  for (const p of rawPositions) {
    const yes = dollarsFromHeld(p.yesHeld);
    const no = dollarsFromHeld(p.noHeld);
    const winningSide =
      p.outcome === "yes" ? yes : p.outcome === "no" ? no : 0;
    const losingSide =
      p.outcome === "yes" ? no : p.outcome === "no" ? yes : 0;

    switch (p.result) {
      case "won":
        wonAmountUsdc += winningSide;
        winCount++;
        break;
      case "lost":
        lostAmountUsdc += losingSide;
        lossCount++;
        break;
      case "invalid":
        invalidCount++;
        break;
      case "abstained":
        abstainedCount++;
        break;
    }

    positions.push({
      ticker: p.ticker ?? "unknown",
      strikeUsd: 0, // unknown without StrikeMarket join (v1.5: enrich via Anchor read)
      outcome: p.outcome as PnlDigestPosition["outcome"],
      result: p.result,
      amountUsdc: p.result === "won" ? winningSide : -losingSide,
      settledAt: p.settledAt,
    });
  }

  const stats: PnlDigestStats = {
    wonAmountUsdc,
    lostAmountUsdc,
    netPnlUsdc: wonAmountUsdc - lostAmountUsdc,
    winCount,
    lossCount,
    invalidCount,
    abstainedCount,
    totalMarkets: rawPositions.length,
  };

  if (rawPositions.length === 0) {
    console.error(
      JSON.stringify({
        event: "gen-pnl-digest.empty",
        wallet,
        reason: "No settled positions in this period — nothing to digest.",
        note: "Seed sample data via .project/.../sample-pnl-seed.sql or wait for live trade history.",
      }),
    );
    process.exit(0);
  }

  const prompt = buildPnlDigestPrompt({
    walletPubkey: wallet,
    periodStart: start,
    periodEnd: end,
    stats,
    positions,
  });
  const result = await callAnthropic(prompt);
  if (!result.ok) {
    console.error(
      JSON.stringify({ event: "gen-pnl-digest.errored", error: result.error }),
    );
    process.exit(2);
  }

  const promptHash = createHash("sha256").update(JSON.stringify(prompt)).digest("hex");
  const digestId = await insertPnlDigest({
    walletPubkey: wallet,
    periodStart: start,
    periodEnd: end,
    model: result.stub ? "stub" : prompt.model,
    body: result.outputText,
    stats: stats as unknown as Record<string, unknown>,
    promptHash,
    requestId: result.requestId,
    costCents: result.costCents,
  });

  console.log(
    JSON.stringify(
      {
        event: "gen-pnl-digest.summary",
        digestId,
        wallet,
        period: { start: start.toISOString(), end: end.toISOString() },
        model: result.stub ? "stub" : prompt.model,
        stats,
        costCents: result.costCents,
        bodyPreview: result.outputText.slice(0, 200),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "gen-pnl-digest.fatal",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
