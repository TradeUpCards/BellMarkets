// tests/contracts/smoke_compressed_time_settle.ts
//
// COMPRESSED-TIME SETTLE + REDEEM SMOKE — devnet evidence script for
// deploy_index=9 (Cory dispatch 2026-05-25).
//
// Path:
//   0. update_admin_override_delay_secs(0)          — relax admin_settle gate
//   1. create_strike_market × 2 (Strike A, Strike B) — short-expiry, possible
//                                                       because deploy_index=9
//                                                       admin path no longer
//                                                       enforces market-close-time
//   2. init_order_book × 2 + grow_order_book × 2     — open trading gates
//   3. mint_pair × 2 (200 bUSDC into each)            — admin holds 200 YES + 200 NO
//   4. wait until Strike A expires (+ 30s buffer)
//   5. settle_market on Strike A                      — REAL Pyth SOL/USD read
//   6. wait until Strike B expires (+ 5s buffer)
//   7. admin_settle(Yes) on Strike B                  — admin price override
//   8. redeem 100 contracts from Strike A's winning  — burn 100 winning, mint 100 bUSDC
//      side (YES if SOL >= $1 at expiry, which it
//      always is — strike = $1, SOL ~$200)
//   9. Print all tx sigs + Solscan URLs as JSON
//
// Strike binding: both strikes use the SAME Pyth feed (SOL/USD live devnet at
// `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix`). Strike B is "labeled" as a
// META smoke (no real META Pyth devnet feed exists — see docs/pyth-feed-status.md)
// — admin_settle ignores the feed binding so the label is purely cosmetic.
// Strike A and B differ by expiry only (different PDAs).
//
// Run:
//   pnpm --filter @bell-markets/automation exec tsx \
//     /mnt/c/Dev/GauntletAI/BellMarkets-aria/tests/contracts/smoke_compressed_time_settle.ts
//
// Requires the same env as @bell-markets/automation scripts (.env):
//   BELL_MARKETS_PROGRAM_ID, HELIUS_DEVNET_RPC_URL, PLATFORM_ADMIN_KEYPAIR_PATH,
//   BELL_MARKETS_IDL_PATH, BUSDC_MINT
//
// Hard-rules respected: no secrets in source, devnet only, idempotent only
// where cheap.

import { BellMarketsAnchorClient } from "../../services/automation/src/clients/anchor.js";

const SOL_USD_PYTH = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"; // verified live + publishing
const PHOENIX_PLACEHOLDER = "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N"; // SOL/USDC magic-verified
const TREASURY_PUBKEY = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs"; // MarketConfig.treasury
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// strike = i64 at Pyth expo -8. $1.00 = 100_000_000. SOL ~$200 always >= $1
// → both strikes guaranteed to settle Yes via settle_market; we admin_settle
// Strike B as Yes too so admin always holds the winning side (200 YES each).
const STRIKE_I64 = 100_000_000;

// 8-min + 9-min expiries from "now". Strike A drains the permissionless path
// (settle_market with real Pyth read), Strike B drains the admin path
// (admin_settle override).
const STRIKE_A_EXPIRY_DELTA_SECS = 480; // 8 min
const STRIKE_B_EXPIRY_DELTA_SECS = 540; // 9 min

// mint_pair amount (200 bUSDC = 200_000_000 atomic at 6 decimals).
const MINT_AMOUNT_BUSDC_ATOMIC = 200_000_000n;

// Redeem 100 of the winning side (100 bUSDC out at $1 par).
const REDEEM_AMOUNT_ATOMIC = 100_000_000n;

const SOLSCAN_DEVNET = "https://solscan.io/tx/";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} is unset`);
  return v;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const programId = reqEnv("BELL_MARKETS_PROGRAM_ID");
  const rpcUrl = reqEnv("HELIUS_DEVNET_RPC_URL");
  const keypairPath = reqEnv("PLATFORM_ADMIN_KEYPAIR_PATH");
  const idlPath = process.env.BELL_MARKETS_IDL_PATH || "src/idl/bell_markets.json";
  const busdcMint = reqEnv("BUSDC_MINT");

  console.error(JSON.stringify({ event: "smoke.start", programId, deployIndex: 9 }));

  const anchorClient = new BellMarketsAnchorClient({
    rpcUrl,
    programId,
    keypairPath,
    idlPath,
  });
  const program = await anchorClient.getProgram();
  const web3 = await import("@solana/web3.js");
  const anchor = await import("@coral-xyz/anchor");
  const spl = await import("@solana/spl-token");

  const programIdPk = new web3.PublicKey(programId);
  const busdcMintPk = new web3.PublicKey(busdcMint);
  const pythFeedPk = new web3.PublicKey(SOL_USD_PYTH);
  const phoenixPk = new web3.PublicKey(PHOENIX_PLACEHOLDER);
  const tokenProgramPk = new web3.PublicKey(TOKEN_PROGRAM_ID);
  const treasuryPk = new web3.PublicKey(TREASURY_PUBKEY);

  const provider = program.provider as unknown as {
    wallet: { publicKey: import("@solana/web3.js").PublicKey; payer?: import("@solana/web3.js").Keypair };
    connection: import("@solana/web3.js").Connection;
  };
  const adminPk = provider.wallet.publicKey;
  const adminKeypair = (provider.wallet as unknown as { payer?: import("@solana/web3.js").Keypair }).payer;
  if (!adminKeypair) throw new Error("provider wallet missing payer keypair for SPL ops");
  const connection = provider.connection;

  // Common PDAs
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);
  const [feeConfigPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("fee_config")], programIdPk);
  const [weeklyPoolPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("weekly_pool")], programIdPk);
  const [monthlyPoolPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("monthly_pool")], programIdPk);
  const [userConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user"), configPda.toBuffer(), adminPk.toBuffer()],
    programIdPk,
  );
  const feeCollectorUsdcPk = await spl.getAssociatedTokenAddress(busdcMintPk, treasuryPk);

  // ── 0. update_admin_override_delay_secs(0) ─────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;

  console.error(JSON.stringify({ event: "smoke.step", step: "update-override-delay-to-zero" }));
  const updateOverrideSig: string = await methods
    .updateAdminOverrideDelaySecs(new anchor.BN(0))
    .accounts({
      admin: adminPk,
      config: configPda,
    })
    .rpc();
  console.error(JSON.stringify({ event: "smoke.tx", step: "update-override-delay", sig: updateOverrideSig }));

  // ── 1. create_strike_market × 2 ───────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  const strikeAExpiryUnix = now + STRIKE_A_EXPIRY_DELTA_SECS;
  const strikeBExpiryUnix = now + STRIKE_B_EXPIRY_DELTA_SECS;

  const deriveStrikePdas = (expiryUnix: number) => {
    const expiryLe = Buffer.alloc(8);
    expiryLe.writeBigInt64LE(BigInt(expiryUnix));
    const strikeLe = Buffer.alloc(8);
    strikeLe.writeBigInt64LE(BigInt(STRIKE_I64));
    const [strikePda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("strike"), pythFeedPk.toBuffer(), expiryLe, strikeLe],
      programIdPk,
    );
    const [yesMint] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("yes"), strikePda.toBuffer()],
      programIdPk,
    );
    const [noMint] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("no"), strikePda.toBuffer()],
      programIdPk,
    );
    const [usdcVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), strikePda.toBuffer()],
      programIdPk,
    );
    const [orderBook] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("order_book"), strikePda.toBuffer()],
      programIdPk,
    );
    const [usdcEscrow] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_escrow"), strikePda.toBuffer()],
      programIdPk,
    );
    const [yesEscrow] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("yes_escrow"), strikePda.toBuffer()],
      programIdPk,
    );
    return { strikePda, yesMint, noMint, usdcVault, orderBook, usdcEscrow, yesEscrow };
  };

  const A = deriveStrikePdas(strikeAExpiryUnix);
  const B = deriveStrikePdas(strikeBExpiryUnix);

  console.error(JSON.stringify({
    event: "smoke.step", step: "create-strikes",
    strikeA: A.strikePda.toBase58(), strikeAExpiry: strikeAExpiryUnix,
    strikeB: B.strikePda.toBase58(), strikeBExpiry: strikeBExpiryUnix,
  }));

  const createSig = async (s: ReturnType<typeof deriveStrikePdas>, expiry: number) =>
    methods
      .createStrikeMarket(new anchor.BN(STRIKE_I64), new anchor.BN(expiry))
      .accounts({
        admin: adminPk,
        config: configPda,
        strikeMarket: s.strikePda,
        underlyingPythFeed: pythFeedPk,
        yesMint: s.yesMint,
        noMint: s.noMint,
        usdcVault: s.usdcVault,
        usdcMint: busdcMintPk,
        phoenixMarket: phoenixPk,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: tokenProgramPk,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

  const createASig = await createSig(A, strikeAExpiryUnix);
  console.error(JSON.stringify({ event: "smoke.tx", step: "create-A", sig: createASig }));
  const createBSig = await createSig(B, strikeBExpiryUnix);
  console.error(JSON.stringify({ event: "smoke.tx", step: "create-B", sig: createBSig }));

  // ── 2. init/grow order book × 2 ──────────────────────────────────────────
  const initOrderBook = async (s: ReturnType<typeof deriveStrikePdas>) =>
    methods
      .initOrderBook()
      .accounts({
        user: adminPk,
        config: configPda,
        strikeMarket: s.strikePda,
        orderBook: s.orderBook,
        usdcMint: busdcMintPk,
        yesMint: s.yesMint,
        usdcEscrow: s.usdcEscrow,
        yesEscrow: s.yesEscrow,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: tokenProgramPk,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

  const growOrderBook = async (s: ReturnType<typeof deriveStrikePdas>) =>
    methods
      .growOrderBook()
      .accounts({
        user: adminPk,
        config: configPda,
        strikeMarket: s.strikePda,
        orderBook: s.orderBook,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

  const initASig = await initOrderBook(A);
  const initBSig = await initOrderBook(B);
  const growASig = await growOrderBook(A);
  const growBSig = await growOrderBook(B);
  console.error(JSON.stringify({ event: "smoke.tx", step: "init/grow-A", initSig: initASig, growSig: growASig }));
  console.error(JSON.stringify({ event: "smoke.tx", step: "init/grow-B", initSig: initBSig, growSig: growBSig }));

  // ── 3. mint_pair × 2 (200 bUSDC each → 200 YES + 200 NO per strike) ────
  const adminBusdcAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, busdcMintPk, adminPk);
  const adminAYesAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, A.yesMint, adminPk);
  const adminANoAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, A.noMint, adminPk);
  const adminBYesAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, B.yesMint, adminPk);
  const adminBNoAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, B.noMint, adminPk);
  const treasuryAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, busdcMintPk, treasuryPk);

  // Top up admin bUSDC to cover 2 × 200 mint_pair + slack.
  const need = 500_000_000n; // 500 bUSDC
  const currentBalance = BigInt((await spl.getAccount(connection, adminBusdcAta.address)).amount.toString());
  if (currentBalance < need) {
    const topUp = need - currentBalance;
    await spl.mintTo(connection, adminKeypair, busdcMintPk, adminBusdcAta.address, adminKeypair, topUp, [], {
      commitment: "confirmed",
    });
    console.error(JSON.stringify({ event: "smoke.tx", step: "topup-busdc", topUpAtomic: topUp.toString() }));
  }

  const mintPair = async (s: ReturnType<typeof deriveStrikePdas>, userYesAta: import("@solana/web3.js").PublicKey, userNoAta: import("@solana/web3.js").PublicKey) =>
    methods
      .mintPair(new anchor.BN(MINT_AMOUNT_BUSDC_ATOMIC.toString()))
      .accounts({
        user: adminPk,
        config: configPda,
        feeConfig: feeConfigPda,
        userConfig: userConfigPda,
        strikeMarket: s.strikePda,
        userUsdc: adminBusdcAta.address,
        usdcVault: s.usdcVault,
        yesMint: s.yesMint,
        noMint: s.noMint,
        userYes: userYesAta,
        userNo: userNoAta,
        feeCollectorUsdc: treasuryAta.address,
        weeklyPool: weeklyPoolPda,
        monthlyPool: monthlyPoolPda,
        usdcMint: busdcMintPk,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: tokenProgramPk,
      })
      .rpc();

  const mintASig = await mintPair(A, adminAYesAta.address, adminANoAta.address);
  const mintBSig = await mintPair(B, adminBYesAta.address, adminBNoAta.address);
  console.error(JSON.stringify({ event: "smoke.tx", step: "mint-A", sig: mintASig }));
  console.error(JSON.stringify({ event: "smoke.tx", step: "mint-B", sig: mintBSig }));

  // ── 4. Wait until Strike A expires + 30s buffer ────────────────────────
  const waitForExpiry = async (expiryUnix: number, label: string, bufferSecs: number) => {
    const ts = Math.floor(Date.now() / 1000);
    const waitSecs = Math.max(0, expiryUnix + bufferSecs - ts);
    console.error(JSON.stringify({ event: "smoke.wait", label, secs: waitSecs, expiry: expiryUnix, bufferSecs }));
    if (waitSecs > 0) await sleep(waitSecs * 1000);
  };

  await waitForExpiry(strikeAExpiryUnix, "strike-A-expiry", 30);

  // ── 5. settle_market on Strike A (REAL Pyth read) ──────────────────────
  console.error(JSON.stringify({ event: "smoke.step", step: "settle-market-A" }));
  const settleASig: string = await methods
    .settleMarket()
    .accounts({
      settler: adminPk,
      config: configPda,
      strikeMarket: A.strikePda,
      underlyingPythFeed: pythFeedPk,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();
  console.error(JSON.stringify({ event: "smoke.tx", step: "settle-A", sig: settleASig }));

  // Verify Strike A's on-chain state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountNs = program.account as any;
  const strikeAState = (await accountNs.strikeMarket.fetch(A.strikePda)) as {
    outcome: Record<string, unknown>;
    settlePrice: import("@coral-xyz/anchor").BN;
    settleConfidence: import("@coral-xyz/anchor").BN;
    settledAtUnix: import("@coral-xyz/anchor").BN;
    settleSlot: import("@coral-xyz/anchor").BN;
  };
  const aOutcomeKey = Object.keys(strikeAState.outcome)[0]; // anchor enum key
  console.error(JSON.stringify({
    event: "smoke.verify", step: "A-settled",
    outcome: aOutcomeKey,
    settlePrice: strikeAState.settlePrice.toString(),
    settleConfidence: strikeAState.settleConfidence.toString(),
    settledAtUnix: strikeAState.settledAtUnix.toString(),
    settleSlot: strikeAState.settleSlot.toString(),
  }));
  if (aOutcomeKey === "unsettled") throw new Error("Strike A outcome did not flip from Unsettled");
  if (strikeAState.settlePrice.toString() === "0") throw new Error("Strike A settle_price == 0 (settle_market path should set non-zero)");

  // ── 6. Wait until Strike B expires ──────────────────────────────────────
  await waitForExpiry(strikeBExpiryUnix, "strike-B-expiry", 5);

  // ── 7. admin_settle(Yes) on Strike B ───────────────────────────────────
  console.error(JSON.stringify({ event: "smoke.step", step: "admin-settle-B-as-yes" }));
  const adminSettleSig: string = await methods
    .adminSettle({ yes: {} })  // Anchor enum syntax for Outcome::Yes
    .accounts({
      admin: adminPk,
      config: configPda,
      strikeMarket: B.strikePda,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();
  console.error(JSON.stringify({ event: "smoke.tx", step: "admin-settle-B", sig: adminSettleSig }));

  const strikeBState = (await accountNs.strikeMarket.fetch(B.strikePda)) as {
    outcome: Record<string, unknown>;
    settlePrice: import("@coral-xyz/anchor").BN;
    settledAtUnix: import("@coral-xyz/anchor").BN;
  };
  const bOutcomeKey = Object.keys(strikeBState.outcome)[0];
  console.error(JSON.stringify({
    event: "smoke.verify", step: "B-admin-settled",
    outcome: bOutcomeKey,
    settlePrice: strikeBState.settlePrice.toString(),
    settledAtUnix: strikeBState.settledAtUnix.toString(),
    discriminator: strikeBState.settlePrice.toString() === "0" ? "admin-pathed" : "UNEXPECTED-NON-ZERO",
  }));
  if (bOutcomeKey !== "yes") throw new Error(`Strike B outcome should be 'yes', got '${bOutcomeKey}'`);

  // ── 8. Redeem 100 contracts from Strike A's winning side ───────────────
  // strike = $1, SOL ~$200 → outcome = Yes → burn 100 YES
  // (admin holds 200 YES from mint_pair → burn 100, get 100 bUSDC)
  // Refresh balances to confirm 100 bUSDC delta.
  const aYesBefore = BigInt((await spl.getAccount(connection, adminAYesAta.address)).amount.toString());
  const aBusdcBefore = BigInt((await spl.getAccount(connection, adminBusdcAta.address)).amount.toString());

  console.error(JSON.stringify({ event: "smoke.step", step: "redeem-A", outcome: aOutcomeKey }));
  const redeemSig: string = await methods
    .redeem(new anchor.BN(REDEEM_AMOUNT_ATOMIC.toString()))
    .accounts({
      user: adminPk,
      config: configPda,
      strikeMarket: A.strikePda,
      yesMint: A.yesMint,
      noMint: A.noMint,
      userYes: adminAYesAta.address,
      userNo: adminANoAta.address,
      usdcVault: A.usdcVault,
      userUsdc: adminBusdcAta.address,
      usdcMint: busdcMintPk,
      tokenProgram: tokenProgramPk,
    })
    .rpc();
  console.error(JSON.stringify({ event: "smoke.tx", step: "redeem-A", sig: redeemSig }));

  const aYesAfter = BigInt((await spl.getAccount(connection, adminAYesAta.address)).amount.toString());
  const aBusdcAfter = BigInt((await spl.getAccount(connection, adminBusdcAta.address)).amount.toString());

  const yesDelta = aYesBefore - aYesAfter;
  const busdcDelta = aBusdcAfter - aBusdcBefore;
  console.error(JSON.stringify({
    event: "smoke.verify", step: "redeem-balances",
    yesBurned: yesDelta.toString(),
    busdcIn: busdcDelta.toString(),
    yesBefore: aYesBefore.toString(), yesAfter: aYesAfter.toString(),
    busdcBefore: aBusdcBefore.toString(), busdcAfter: aBusdcAfter.toString(),
  }));
  if (yesDelta !== REDEEM_AMOUNT_ATOMIC) throw new Error(`YES burn delta ${yesDelta} != expected ${REDEEM_AMOUNT_ATOMIC}`);
  if (busdcDelta !== REDEEM_AMOUNT_ATOMIC) throw new Error(`bUSDC in delta ${busdcDelta} != expected ${REDEEM_AMOUNT_ATOMIC}`);

  // Final summary (stdout — captured by operator for the report)
  console.log(JSON.stringify({
    ok: true,
    deployIndex: 9,
    programId,
    txs: {
      updateOverrideDelay: { sig: updateOverrideSig, solscan: SOLSCAN_DEVNET + updateOverrideSig + "?cluster=devnet" },
      createStrikeA: { sig: createASig, solscan: SOLSCAN_DEVNET + createASig + "?cluster=devnet" },
      createStrikeB: { sig: createBSig, solscan: SOLSCAN_DEVNET + createBSig + "?cluster=devnet" },
      initOrderBookA: { sig: initASig, solscan: SOLSCAN_DEVNET + initASig + "?cluster=devnet" },
      growOrderBookA: { sig: growASig, solscan: SOLSCAN_DEVNET + growASig + "?cluster=devnet" },
      initOrderBookB: { sig: initBSig, solscan: SOLSCAN_DEVNET + initBSig + "?cluster=devnet" },
      growOrderBookB: { sig: growBSig, solscan: SOLSCAN_DEVNET + growBSig + "?cluster=devnet" },
      mintPairA: { sig: mintASig, solscan: SOLSCAN_DEVNET + mintASig + "?cluster=devnet" },
      mintPairB: { sig: mintBSig, solscan: SOLSCAN_DEVNET + mintBSig + "?cluster=devnet" },
      settleMarketA: { sig: settleASig, solscan: SOLSCAN_DEVNET + settleASig + "?cluster=devnet" },
      adminSettleB: { sig: adminSettleSig, solscan: SOLSCAN_DEVNET + adminSettleSig + "?cluster=devnet" },
      redeemA: { sig: redeemSig, solscan: SOLSCAN_DEVNET + redeemSig + "?cluster=devnet" },
    },
    strikes: {
      A: {
        pda: A.strikePda.toBase58(),
        expiry: strikeAExpiryUnix,
        outcome: aOutcomeKey,
        settlePrice: strikeAState.settlePrice.toString(),
        settleConfidence: strikeAState.settleConfidence.toString(),
        settledAtUnix: strikeAState.settledAtUnix.toString(),
        settleSlot: strikeAState.settleSlot.toString(),
        settlePath: "settle_market (permissionless, real Pyth SOL/USD)",
      },
      B: {
        pda: B.strikePda.toBase58(),
        expiry: strikeBExpiryUnix,
        outcome: bOutcomeKey,
        settlePrice: strikeBState.settlePrice.toString(),
        settledAtUnix: strikeBState.settledAtUnix.toString(),
        settlePath: "admin_settle (forced Yes, settle_price=0 marks admin-pathed)",
      },
    },
    redeem: {
      strike: "A",
      amountAtomic: REDEEM_AMOUNT_ATOMIC.toString(),
      yesBurned: yesDelta.toString(),
      busdcIn: busdcDelta.toString(),
    },
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "smoke.fatal",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }));
  process.exit(1);
});
