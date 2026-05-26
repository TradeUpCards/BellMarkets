// Print actual lamports balance of the seeded META OrderBook PDA + the
// other per-market accounts. Compares against the rent-exempt formula
// to confirm the docs/demo-readiness-plan.md numbers match reality.

import { loadConfig } from "../src/config.js";

const ACCOUNTS = [
  { label: "StrikeMarket    ", pubkey: "4HVNcp5BBPCEKqgSCA2GgP4ybKnpqTRZaRxVGnrnxg2s" },
  { label: "OrderBook       ", pubkey: "3qa9yfZmWKVScrSSdSjb78TYnGUUqiWuLn516qfKJsu4" },
  { label: "usdc_vault      ", pubkey: "3vG7nBNmrD4kMrLAUZQyswn1gHmzaJWVEzcidbNDfcig" },
  { label: "usdc_escrow     ", pubkey: "2ry2yEJexKWKutUzjckTjdSVhf7sW9U2MRBHyjiFyAC5" },
  { label: "yes_escrow      ", pubkey: "Cngn1x6ydKkcqFDsswH937rf48RTtSRzhaiowDd2cq2g" },
  { label: "yes_mint        ", pubkey: "7VGnUGC44dU69oWzTWuLSt7tsFSE2JZ8csRBf26BfX6h" },
  { label: "no_mint         ", pubkey: "B85JHBat1h1ymtyBCQv1LYWqAi7fYqnD8pAjGC3TMmd2" },
];

async function main() {
  const cfg = loadConfig();
  if (!cfg.heliusRpcUrl) throw new Error("HELIUS_DEVNET_RPC_URL unset");

  const web3 = await import("@solana/web3.js");
  const connection = new web3.Connection(cfg.heliusRpcUrl, "confirmed");

  let total = 0n;
  for (const { label, pubkey } of ACCOUNTS) {
    const info = await connection.getAccountInfo(new web3.PublicKey(pubkey));
    if (!info) {
      console.log(`${label}: <not found>`);
      continue;
    }
    const lamports = BigInt(info.lamports);
    total += lamports;
    const sol = Number(lamports) / 1_000_000_000;
    console.log(
      `${label}: ${info.data.length.toString().padStart(6)} B   ${lamports.toString().padStart(11)} lamports   ${sol.toFixed(6)} SOL`,
    );
  }
  console.log(
    `\n  TOTAL per-market rent: ${total} lamports = ${(Number(total) / 1_000_000_000).toFixed(6)} SOL`,
  );
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
