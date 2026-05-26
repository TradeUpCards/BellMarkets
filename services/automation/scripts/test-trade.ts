// E2E trade test: place a crossing BID at $0.55 × 50 YES against the seeded
// META market. If the matcher crosses on placement (per Keith's design), the
// $0.55 ask should be consumed and balances should reconcile.
//
// Self-trade caveat: the admin owns both the resting ask and the incoming bid.
// If the program rejects self-trades we'll see the explicit error and fall
// back to a second-wallet path.

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";
import { loadConfig } from "../src/config.js";

const STRIKE_MARKET = "4HVNcp5BBPCEKqgSCA2GgP4ybKnpqTRZaRxVGnrnxg2s";
const ORDER_BOOK = "3qa9yfZmWKVScrSSdSjb78TYnGUUqiWuLn516qfKJsu4";
const YES_MINT = "7VGnUGC44dU69oWzTWuLSt7tsFSE2JZ8csRBf26BfX6h";
const USDC_VAULT = "3vG7nBNmrD4kMrLAUZQyswn1gHmzaJWVEzcidbNDfcig";
const USDC_ESCROW = "2ry2yEJexKWKutUzjckTjdSVhf7sW9U2MRBHyjiFyAC5";
const YES_ESCROW = "Cngn1x6ydKkcqFDsswH937rf48RTtSRzhaiowDd2cq2g";
const ADMIN_USDC_ATA = "HAYmFJZhuEiVrQ4Brjwku5gpgaYPz7bjdgZzfV9bM647";
const ADMIN_YES_ATA = "Ek9PxJNwcBeep9Bvdb9kuz22GTaUDWUqTa1NC97S79nH";

const SIDE_BID = 0;
const SIDE_ASK = 1;

const TRADE_PRICE = 550_000n; // $0.55
const TRADE_SIZE = 50_000_000n; // 50 YES

async function snapshot(connection: any, spl: any, web3: any, program: any) {
  const ob = await (program.account as any).orderBook.fetch(new web3.PublicKey(ORDER_BOOK));
  const bidsLen = Number(ob.bidsLen ?? ob.bids_len ?? 0);
  const asksLen = Number(ob.asksLen ?? ob.asks_len ?? 0);
  const usdcEscrow = (await spl.getAccount(connection, new web3.PublicKey(USDC_ESCROW))).amount;
  const yesEscrow = (await spl.getAccount(connection, new web3.PublicKey(YES_ESCROW))).amount;
  const vault = (await spl.getAccount(connection, new web3.PublicKey(USDC_VAULT))).amount;
  const adminUsdc = (await spl.getAccount(connection, new web3.PublicKey(ADMIN_USDC_ATA))).amount;
  const adminYes = (await spl.getAccount(connection, new web3.PublicKey(ADMIN_YES_ATA))).amount;
  return { bidsLen, asksLen, usdcEscrow, yesEscrow, vault, adminUsdc, adminYes };
}

function fmt(label: string, pre: bigint, post: bigint) {
  const delta = post - pre;
  const sign = delta > 0n ? "+" : delta < 0n ? "" : " ";
  return `${label}: ${pre} → ${post}  (Δ ${sign}${delta})`;
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
  const anchor = await import("@coral-xyz/anchor");
  const spl = await import("@solana/spl-token");
  const connection = (program.provider as unknown as { connection: any }).connection;
  const provider = program.provider as unknown as { wallet: { publicKey: any } };
  const adminPk = provider.wallet.publicKey;

  const programIdPk = new web3.PublicKey(cfg.bellMarketsProgramId);
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);
  const busdcMintPk = new web3.PublicKey(process.env.BUSDC_MINT!);

  console.log("=== PRE-TRADE SNAPSHOT ===");
  const pre = await snapshot(connection, spl, web3, program);
  console.log(`bidsLen=${pre.bidsLen} asksLen=${pre.asksLen}`);
  console.log(`usdc_escrow=${pre.usdcEscrow}  yes_escrow=${pre.yesEscrow}`);
  console.log(`vault=${pre.vault}  admin_usdc=${pre.adminUsdc}  admin_yes=${pre.adminYes}`);

  console.log(`\n=== PLACING MARKET BUY: $0.55 × 50 YES (should cross the resting $0.55 ask) ===`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const methods = program.methods as any;
    // remaining_accounts contract (place_order.rs:218): one maker payout
    // token account per planned fill. We're a BID crossing 1 ask owned by
    // admin → maker payout = admin's bUSDC ATA (where the proceeds land).
    const sig = await methods
      .placeOrder(
        SIDE_BID,
        new anchor.BN(TRADE_PRICE.toString()),
        new anchor.BN(TRADE_SIZE.toString()),
        false, // limit order — escrows only the at-limit cost (27.5 bUSDC for $0.55 × 50)
      )
      .accounts({
        user: adminPk,
        config: configPda,
        strikeMarket: new web3.PublicKey(STRIKE_MARKET),
        orderBook: new web3.PublicKey(ORDER_BOOK),
        yesMint: new web3.PublicKey(YES_MINT),
        usdcMint: busdcMintPk,
        userYes: new web3.PublicKey(ADMIN_YES_ATA),
        userUsdc: new web3.PublicKey(ADMIN_USDC_ATA),
        usdcEscrow: new web3.PublicKey(USDC_ESCROW),
        yesEscrow: new web3.PublicKey(YES_ESCROW),
        tokenProgram: spl.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        {
          pubkey: new web3.PublicKey(ADMIN_USDC_ATA),
          isWritable: true,
          isSigner: false,
        },
      ])
      .rpc();
    console.log(`✅ place_order tx: ${sig}`);
    console.log(`   solscan: https://solscan.io/tx/${sig}?cluster=devnet`);

    // Wait for confirmation propagation
    await connection.confirmTransaction(sig, "confirmed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`❌ place_order FAILED: ${msg}`);
    if (msg.includes("SelfTrade") || msg.includes("self") || msg.includes("Self")) {
      console.log("   → Self-trade prevention triggered. Need a second wallet for E2E test.");
    }
    return;
  }

  console.log("\n=== POST-TRADE SNAPSHOT ===");
  const post = await snapshot(connection, spl, web3, program);
  console.log(fmt("bidsLen     ", BigInt(pre.bidsLen), BigInt(post.bidsLen)));
  console.log(fmt("asksLen     ", BigInt(pre.asksLen), BigInt(post.asksLen)));
  console.log(fmt("usdc_escrow ", pre.usdcEscrow, post.usdcEscrow));
  console.log(fmt("yes_escrow  ", pre.yesEscrow, post.yesEscrow));
  console.log(fmt("vault       ", pre.vault, post.vault));
  console.log(fmt("admin_usdc  ", pre.adminUsdc, post.adminUsdc));
  console.log(fmt("admin_yes   ", pre.adminYes, post.adminYes));

  // Expected for a full self-trade match:
  //   - asksLen: 3 → 2 (one ask consumed)
  //   - yes_escrow: -50 YES (released to buyer = admin)
  //   - admin_yes: +50 (received from match) ... but admin lost 0 (already escrowed)
  //     → net +50 in ATA
  //   - admin_usdc: -27.5 (paid by bid) +27.5 (received by ask) = 0 if self-trade
  //     OR -27.5 only if maker payment went elsewhere
  //   - vault: unchanged (trading is escrow-only)
  const asksDelta = post.asksLen - pre.asksLen;
  const yesEscrowDelta = post.yesEscrow - pre.yesEscrow;
  const adminYesDelta = post.adminYes - pre.adminYes;
  const vaultDelta = post.vault - pre.vault;

  console.log("\n=== ASSESSMENT ===");
  if (asksDelta === -1 && yesEscrowDelta === -50_000_000n && adminYesDelta === 50_000_000n && vaultDelta === 0n) {
    console.log("✅ TRADE MATCHED CORRECTLY:");
    console.log("   ask consumed, yes_escrow telescoped, admin received 50 YES, vault invariant intact.");
  } else if (asksDelta === 0 && post.bidsLen > pre.bidsLen) {
    console.log("⚠️  BID RESTED instead of crossing — place_order does NOT auto-match.");
    console.log("   Try calling match_orders() next.");
  } else {
    console.log("⚠️  Unexpected diff — partial fill, self-trade-prevention, or other behavior:");
    console.log(`   asksDelta=${asksDelta}, yesEscrowDelta=${yesEscrowDelta}, adminYesDelta=${adminYesDelta}, vaultDelta=${vaultDelta}`);
  }
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
