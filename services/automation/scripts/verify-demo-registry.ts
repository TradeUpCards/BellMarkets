// Verify the 21 StrikeMarket PDAs in apps/web/src/lib/demo-strikes.ts.
// Mirrors what useAllMarkets does after fix 7f9e5e2 — if the new hook
// fails on the live site, this script tells us why (PDA empty? wrong
// schema? decode fail?).

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";
import { loadConfig } from "../src/config.js";

const DEMO_PDAS: Array<{ ticker: string; strike: number; pda: string }> = [
  { ticker: "META", strike: 592, pda: "4hLBQ4tRcqvdJ7DwSMh7D6qo8fWcAfx7bp2c5ne7XGh4" },
  { ticker: "META", strike: 610, pda: "4QL6a8c4G25hHYkEm2cp6RAz18fmKYqUey1bxkugttSN" },
  { ticker: "META", strike: 629, pda: "2Jh6jVsjzWG2QrQjjWFK2H1213N8jbfHeW4ZZAf4NKvh" },
  { ticker: "NVDA", strike: 209, pda: "EJib2HZ1Sar3czncfok5dgP24QnVZhiiUKHU6qTuqRpX" },
  { ticker: "NVDA", strike: 215, pda: "4ac1qFRXHbFRNcnABRHVknCaSVjrF2Qp4rnkS6zhezVA" },
  { ticker: "NVDA", strike: 222, pda: "EaWQzkZ6XUsb3ehCr54cNTsRodKLikRCmebC4qxj9kfp" },
  { ticker: "AAPL", strike: 300, pda: "HW9DRUj9bM3NnATY1khEwidBTDpssq4uZwzD5DAeJ4Vt" },
  { ticker: "AAPL", strike: 309, pda: "3Wi3jEB2dsdbCHGZrE34SGuKcoGkY7bpe6N4EXFTHVwr" },
  { ticker: "AAPL", strike: 318, pda: "FeBW6NYWujNecdL6YrNbiaNtQ4dGsWrscn9e69jY7akm" },
  { ticker: "MSFT", strike: 406, pda: "He3PrshcBBbsjBf8vT6tMEa6BPRfr8KgafAvm8zmza6P" },
  { ticker: "MSFT", strike: 419, pda: "LnpzzTp2vvD4RRYCQJkJoFxJ1TLqMXiJSEnm6PEpdLu" },
  { ticker: "MSFT", strike: 431, pda: "2uZ7hjd9mwcepQk73RrK5G1Mr8b9ZiVugXAuBs2Y5nDc" },
  { ticker: "GOOGL", strike: 368, pda: "2EpRjC6iak27epcwjQuXV6Gsn9Mxd3oqE7sh234J8FEu" },
  { ticker: "GOOGL", strike: 379, pda: "2vessd9iDJ3fStY3s7P7sZt7FYcFcYmtdnERLLT7Dpsq" },
  { ticker: "GOOGL", strike: 391, pda: "6XjT324AyDYoW77xCEKSmruFZDWy1oL1iH3VqGm8GZtG" },
  { ticker: "AMZN", strike: 259, pda: "HPo5En5kN5PoJ7jQz2xPYkuFJDnbwcham6uanC2HpDcW" },
  { ticker: "AMZN", strike: 267, pda: "J1qxamiR4Hw32qwpAmMXcgdSQdUM8WJ3E2dL8nC7fwkR" },
  { ticker: "AMZN", strike: 275, pda: "24EoQ6ALTcsNsLGaX8LpuDAYdQ7ZvhaheNhpmuXv7KvZ" },
  { ticker: "TSLA", strike: 413, pda: "2LWfuMbnwxeak5ECB9EaH2BwaVuNdngzisu1xt1jkvpn" },
  { ticker: "TSLA", strike: 426, pda: "6jMurJM43btuiMSJ1eRrWwN7yvudcJRVhFVc7CfzUGg2" },
  { ticker: "TSLA", strike: 439, pda: "4CLgZXMewaZhRktQjDWtukbhhP3CidMyw8iG3mM5P6vb" },
];

async function main() {
  const cfg = loadConfig();
  if (!cfg.heliusRpcUrl) throw new Error("HELIUS_DEVNET_RPC_URL unset");
  if (!cfg.bellMarketsProgramId) throw new Error("BELL_MARKETS_PROGRAM_ID unset");
  if (!cfg.platformAdminKeypairPath) throw new Error("PLATFORM_ADMIN_KEYPAIR_PATH unset");

  const client = new BellMarketsAnchorClient({
    rpcUrl: cfg.heliusRpcUrl,
    programId: cfg.bellMarketsProgramId,
    keypairPath: cfg.platformAdminKeypairPath,
    idlPath: cfg.bellMarketsIdlPath || "src/idl/bell_markets.json",
  });
  const program = await client.getProgram();
  const web3 = await import("@solana/web3.js");
  const connection = (program.provider as unknown as {
    connection: import("@solana/web3.js").Connection;
  }).connection;

  const pdaList = DEMO_PDAS.map((m) => new web3.PublicKey(m.pda));
  console.log(`Fetching ${pdaList.length} accounts via getMultipleAccountsInfo (same call as useAllMarkets after fix 7f9e5e2)…\n`);

  const infos = await connection.getMultipleAccountsInfo(pdaList, "confirmed");
  let exists = 0;
  let decoded = 0;
  let missing: string[] = [];
  let failed: string[] = [];

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    const entry = DEMO_PDAS[i]!;
    const label = `${entry.ticker}/${entry.strike}`.padEnd(12);
    if (!info) {
      console.log(`❌ ${label} ${entry.pda} — ACCOUNT NOT FOUND on devnet`);
      missing.push(`${entry.ticker}/${entry.strike}`);
      continue;
    }
    exists++;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sm = (program.coder.accounts as any).decode("StrikeMarket", info.data);
      decoded++;
      console.log(
        `✅ ${label} ${entry.pda.slice(0, 8)}…  size=${info.data.length}B  strikePrice=${sm.strikePrice}  outcome=${JSON.stringify(sm.outcome)}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`⚠️  ${label} ${entry.pda.slice(0, 8)}…  size=${info.data.length}B  DECODE FAILED: ${msg.slice(0, 80)}`);
      failed.push(`${entry.ticker}/${entry.strike}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Total in registry:     ${pdaList.length}`);
  console.log(`Account exists:        ${exists}`);
  console.log(`Decoded successfully:  ${decoded}`);
  if (missing.length > 0) {
    console.log(`\n❌ NOT FOUND (${missing.length}): ${missing.join(", ")}`);
    console.log("   These PDAs are in the registry but the on-chain account doesn't exist.");
    console.log("   Likely: Bram's seed didn't complete for these markets, OR the registry has stale PDAs.");
  }
  if (failed.length > 0) {
    console.log(`\n⚠️  DECODE FAILED (${failed.length}): ${failed.join(", ")}`);
    console.log("   These exist but don't match the current IDL schema (deploy_index=9).");
    console.log("   Likely: deploy_index<7 legacy StrikeMarket — frontend's defensive filter drops these.");
  }
  if (decoded === pdaList.length) {
    console.log("\n✅ All 21 markets decodable. If matrix still empty on live site:");
    console.log("   - Vercel hasn't rebuilt yet (commit 7f9e5e2 — typically 2 min)");
    console.log("   - Or hard-refresh + clear cache still serving old JS bundle");
  }
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
