// Verify the seeded META market by decoding StrikeMarket + OrderBook via the
// Anchor IDL — the same coder the UI uses. If both decode without throwing,
// the UI will be able to render the market.

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";
import { loadConfig } from "../src/config.js";

const STRIKE_MARKET = "4HVNcp5BBPCEKqgSCA2GgP4ybKnpqTRZaRxVGnrnxg2s";
const ORDER_BOOK = "3qa9yfZmWKVScrSSdSjb78TYnGUUqiWuLn516qfKJsu4";
const USDC_VAULT = "3vG7nBNmrD4kMrLAUZQyswn1gHmzaJWVEzcidbNDfcig";
const USDC_ESCROW = "2ry2yEJexKWKutUzjckTjdSVhf7sW9U2MRBHyjiFyAC5";
const YES_ESCROW = "Cngn1x6ydKkcqFDsswH937rf48RTtSRzhaiowDd2cq2g";

const PRICE_SCALE = 1_000_000n;

function bidCostCeil(price: bigint, size: bigint): bigint {
  return (price * size + PRICE_SCALE - 1n) / PRICE_SCALE;
}

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
  const spl = await import("@solana/spl-token");
  const connection = (program.provider as unknown as {
    connection: import("@solana/web3.js").Connection;
  }).connection;

  // 1. StrikeMarket decode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smCoder = (program.account as any).strikeMarket;
  let smOk = false;
  try {
    const sm = await smCoder.fetch(new web3.PublicKey(STRIKE_MARKET));
    smOk = true;
    console.log("✅ StrikeMarket decoded.");
    console.log(`   strikePrice = ${sm.strikePrice}`);
    console.log(`   expiryUnix  = ${sm.expiryUnix} (${new Date(Number(sm.expiryUnix) * 1000).toISOString()})`);
    console.log(`   outcome     = ${JSON.stringify(sm.outcome)}`);
    console.log(`   pairsOutstanding = ${sm.pairsOutstanding}`);
    console.log(`   orderBook   = ${sm.orderBook?.toBase58?.() ?? sm.orderBook ?? "<UNSET — pre-DR-020 layout>"}`);
  } catch (e) {
    console.log(`❌ StrikeMarket decode FAILED: ${(e as Error).message}`);
    console.log("   → UI will silently skip this account.");
  }

  // 2. OrderBook decode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obCoder = (program.account as any).orderBook;
  let bids: Array<{ price: bigint; size: bigint }> = [];
  let asks: Array<{ price: bigint; size: bigint }> = [];
  try {
    const ob = await obCoder.fetch(new web3.PublicKey(ORDER_BOOK));
    const bidsLen = Number(ob.bidsLen ?? ob.bids_len ?? 0);
    const asksLen = Number(ob.asksLen ?? ob.asks_len ?? 0);
    console.log(`✅ OrderBook decoded. bidsLen=${bidsLen} asksLen=${asksLen} nextSeq=${ob.nextSeq}`);
    for (let i = 0; i < bidsLen; i++) {
      const o = ob.bids[i];
      const price = BigInt(o.price.toString());
      const size = BigInt(o.size.toString());
      bids.push({ price, size });
      const dollars = Number(price) / 1_000_000;
      const yes = Number(size) / 1_000_000;
      console.log(`   bid #${i}: $${dollars.toFixed(2)} × ${yes} YES  (owner ${o.owner.toBase58().slice(0, 8)}…)`);
    }
    for (let i = 0; i < asksLen; i++) {
      const o = ob.asks[i];
      const price = BigInt(o.price.toString());
      const size = BigInt(o.size.toString());
      asks.push({ price, size });
      const dollars = Number(price) / 1_000_000;
      const yes = Number(size) / 1_000_000;
      console.log(`   ask #${i}: $${dollars.toFixed(2)} × ${yes} YES  (owner ${o.owner.toBase58().slice(0, 8)}…)`);
    }
  } catch (e) {
    console.log(`❌ OrderBook decode FAILED: ${(e as Error).message}`);
  }

  // 3. Escrow balances vs invariants
  const usdcEscrowInfo = await spl.getAccount(connection, new web3.PublicKey(USDC_ESCROW));
  const yesEscrowInfo = await spl.getAccount(connection, new web3.PublicKey(YES_ESCROW));
  const usdcVaultInfo = await spl.getAccount(connection, new web3.PublicKey(USDC_VAULT));

  let expectedUsdcEscrow = 0n;
  for (const b of bids) expectedUsdcEscrow += bidCostCeil(b.price, b.size);
  let expectedYesEscrow = 0n;
  for (const a of asks) expectedYesEscrow += a.size;
  const expectedVault = 200_000_000n;

  const usdcOk = usdcEscrowInfo.amount === expectedUsdcEscrow;
  const yesOk = yesEscrowInfo.amount === expectedYesEscrow;
  const vaultOk = usdcVaultInfo.amount === expectedVault;

  console.log(
    `\n${usdcOk ? "✅" : "❌"} usdc_escrow: ${usdcEscrowInfo.amount} (expected ${expectedUsdcEscrow})`,
  );
  console.log(
    `${yesOk ? "✅" : "❌"} yes_escrow:  ${yesEscrowInfo.amount} (expected ${expectedYesEscrow})`,
  );
  console.log(
    `${vaultOk ? "✅" : "❌"} usdc_vault:  ${usdcVaultInfo.amount} (expected ${expectedVault})`,
  );

  const allOk = smOk && bids.length === 3 && asks.length === 3 && usdcOk && yesOk && vaultOk;
  console.log(`\n${allOk ? "✅ ALL INVARIANTS HOLD — market is real, decodable, and UI-renderable" : "❌ MISMATCH — see above"}`);
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
