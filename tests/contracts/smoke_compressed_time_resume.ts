// tests/contracts/smoke_compressed_time_resume.ts
//
// RESUME script for the deploy_index=9 compressed-time smoke. Picks up after
// `smoke_compressed_time_settle.ts` failed at settle_market with PythStale
// (6009) — Pyth devnet v2 push feeds are 660+ days stale, so the
// permissionless settle_market path is unavailable on devnet.
//
// Strikes A + B already exist + are minted-into + expired + Unsettled.
// This script:
//   1. attempt settle_market on Strike A    — EXPECTED to fail PythStale
//      (captured as audit evidence — the real path is wired but Pyth devnet
//      is dead, so we admin_settle instead)
//   2. admin_settle(Yes) on Strike A         — works (forced outcome)
//   3. admin_settle(Yes) on Strike B         — works
//   4. redeem 100 contracts from Strike A    — burns 100 YES → 100 bUSDC
//   5. Print all tx sigs + Solscan URLs as JSON
//
// Strike PDAs hardcoded from the failed run's log:

import { BellMarketsAnchorClient } from "../../services/automation/src/clients/anchor.js";

const SOL_USD_PYTH = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// From the failed-run log:
const STRIKE_A_PDA = "33HjuPy39BXtKwK6skkxy3m3bE9VpEyKa2ddD22aVWDw";
const STRIKE_A_EXPIRY = 1779768677;
const STRIKE_B_PDA = "HpWXtaELNTsaSShvwoHobpyZjNSCEbNHxhALoGaMwmKL";
const STRIKE_B_EXPIRY = 1779768737;
const STRIKE_I64 = 100_000_000;
const REDEEM_AMOUNT_ATOMIC = 100_000_000n;

const SOLSCAN_DEVNET = "https://solscan.io/tx/";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} is unset`);
  return v;
}

async function main() {
  const programId = reqEnv("BELL_MARKETS_PROGRAM_ID");
  const rpcUrl = reqEnv("HELIUS_DEVNET_RPC_URL");
  const keypairPath = reqEnv("PLATFORM_ADMIN_KEYPAIR_PATH");
  const idlPath = process.env.BELL_MARKETS_IDL_PATH || "src/idl/bell_markets.json";
  const busdcMint = reqEnv("BUSDC_MINT");

  console.error(JSON.stringify({ event: "resume.start", programId, deployIndex: 9 }));

  const anchorClient = new BellMarketsAnchorClient({ rpcUrl, programId, keypairPath, idlPath });
  const program = await anchorClient.getProgram();
  const web3 = await import("@solana/web3.js");
  const anchor = await import("@coral-xyz/anchor");
  const spl = await import("@solana/spl-token");

  const programIdPk = new web3.PublicKey(programId);
  const busdcMintPk = new web3.PublicKey(busdcMint);
  const pythFeedPk = new web3.PublicKey(SOL_USD_PYTH);
  const tokenProgramPk = new web3.PublicKey(TOKEN_PROGRAM_ID);

  const provider = program.provider as unknown as {
    wallet: { publicKey: import("@solana/web3.js").PublicKey; payer?: import("@solana/web3.js").Keypair };
    connection: import("@solana/web3.js").Connection;
  };
  const adminPk = provider.wallet.publicKey;
  const adminKeypair = (provider.wallet as unknown as { payer?: import("@solana/web3.js").Keypair }).payer;
  if (!adminKeypair) throw new Error("provider wallet missing payer keypair for SPL ops");
  const connection = provider.connection;

  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);

  // Re-derive child PDAs from known strike PDAs
  const childPdas = (strikePdaB58: string) => {
    const strikePda = new web3.PublicKey(strikePdaB58);
    const [yesMint] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("yes"), strikePda.toBuffer()], programIdPk,
    );
    const [noMint] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("no"), strikePda.toBuffer()], programIdPk,
    );
    const [usdcVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), strikePda.toBuffer()], programIdPk,
    );
    return { strikePda, yesMint, noMint, usdcVault };
  };
  const A = childPdas(STRIKE_A_PDA);
  const B = childPdas(STRIKE_B_PDA);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountNs = program.account as any;

  // ── 1. Attempt settle_market on Strike A — EXPECTED PythStale failure ──
  let settleMarketAttempt: { success: false; error: string } | { success: true; sig: string };
  try {
    const sig = await methods
      .settleMarket()
      .accounts({
        settler: adminPk,
        config: configPda,
        strikeMarket: A.strikePda,
        underlyingPythFeed: pythFeedPk,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
    settleMarketAttempt = { success: true, sig };
    console.error(JSON.stringify({ event: "resume.tx", step: "settle-market-A", sig }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    settleMarketAttempt = { success: false, error: msg.substring(0, 200) };
    console.error(JSON.stringify({ event: "resume.expected-failure", step: "settle-market-A", reason: "Pyth devnet feed 660+ days stale (audit finding)", error: msg.substring(0, 150) }));
  }

  // ── 2. admin_settle(Yes) on Strike A ────────────────────────────────────
  let adminSettleASig: string;
  try {
    adminSettleASig = await methods
      .adminSettle({ yes: {} })
      .accounts({
        admin: adminPk,
        config: configPda,
        strikeMarket: A.strikePda,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
    console.error(JSON.stringify({ event: "resume.tx", step: "admin-settle-A", sig: adminSettleASig }));
  } catch (err) {
    // If A is already admin-settled from a prior partial run, this throws AlreadySettled — fine
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AlreadySettled")) {
      adminSettleASig = "already-settled-skipped";
      console.error(JSON.stringify({ event: "resume.skip", step: "admin-settle-A", reason: "AlreadySettled" }));
    } else throw err;
  }

  const strikeAState = (await accountNs.strikeMarket.fetch(A.strikePda)) as {
    outcome: Record<string, unknown>;
    settlePrice: import("@coral-xyz/anchor").BN;
    settleConfidence: import("@coral-xyz/anchor").BN;
    settleSlot: import("@coral-xyz/anchor").BN;
    settledAtUnix: import("@coral-xyz/anchor").BN;
  };
  const aOutcomeKey = Object.keys(strikeAState.outcome)[0];

  // ── 3. admin_settle(Yes) on Strike B ────────────────────────────────────
  let adminSettleBSig: string;
  try {
    adminSettleBSig = await methods
      .adminSettle({ yes: {} })
      .accounts({
        admin: adminPk,
        config: configPda,
        strikeMarket: B.strikePda,
        clock: web3.SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
    console.error(JSON.stringify({ event: "resume.tx", step: "admin-settle-B", sig: adminSettleBSig }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("AlreadySettled")) {
      adminSettleBSig = "already-settled-skipped";
      console.error(JSON.stringify({ event: "resume.skip", step: "admin-settle-B", reason: "AlreadySettled" }));
    } else throw err;
  }

  const strikeBState = (await accountNs.strikeMarket.fetch(B.strikePda)) as {
    outcome: Record<string, unknown>;
    settlePrice: import("@coral-xyz/anchor").BN;
    settledAtUnix: import("@coral-xyz/anchor").BN;
  };
  const bOutcomeKey = Object.keys(strikeBState.outcome)[0];

  // ── 4. redeem 100 contracts from Strike A (winning side = YES) ─────────
  // Admin holds 200 YES from prior mint_pair. After admin_settle(Yes), redeem
  // burns 100 YES + transfers 100 bUSDC vault → admin's bUSDC ATA.
  const adminBusdcAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, busdcMintPk, adminPk);
  const adminAYesAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, A.yesMint, adminPk);
  const adminANoAta = await spl.getOrCreateAssociatedTokenAccount(connection, adminKeypair, A.noMint, adminPk);

  const aYesBefore = BigInt((await spl.getAccount(connection, adminAYesAta.address)).amount.toString());
  const aBusdcBefore = BigInt((await spl.getAccount(connection, adminBusdcAta.address)).amount.toString());

  let redeemSig: string;
  try {
    redeemSig = await methods
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
    console.error(JSON.stringify({ event: "resume.tx", step: "redeem-A", sig: redeemSig }));
  } catch (err) {
    console.error(JSON.stringify({ event: "resume.fatal-redeem", error: err instanceof Error ? err.message : String(err) }));
    throw err;
  }

  const aYesAfter = BigInt((await spl.getAccount(connection, adminAYesAta.address)).amount.toString());
  const aBusdcAfter = BigInt((await spl.getAccount(connection, adminBusdcAta.address)).amount.toString());
  const yesDelta = aYesBefore - aYesAfter;
  const busdcDelta = aBusdcAfter - aBusdcBefore;
  if (yesDelta !== REDEEM_AMOUNT_ATOMIC) throw new Error(`YES burn delta ${yesDelta} != ${REDEEM_AMOUNT_ATOMIC}`);
  if (busdcDelta !== REDEEM_AMOUNT_ATOMIC) throw new Error(`bUSDC in delta ${busdcDelta} != ${REDEEM_AMOUNT_ATOMIC}`);

  // ── Final summary ─────────────────────────────────────────────────────
  console.log(JSON.stringify({
    ok: true,
    deployIndex: 9,
    programId,
    settleMarketAttempt: {
      result: settleMarketAttempt.success ? "succeeded-unexpectedly" : "failed-as-expected",
      reason: settleMarketAttempt.success ? undefined : "PythStale (6009) — Pyth devnet v2 push feeds 660+ days stale; see docs/pyth-feed-status.md",
      error: settleMarketAttempt.success ? undefined : (settleMarketAttempt as { error: string }).error,
    },
    txs: {
      adminSettleA: { sig: adminSettleASig, solscan: adminSettleASig === "already-settled-skipped" ? undefined : SOLSCAN_DEVNET + adminSettleASig + "?cluster=devnet" },
      adminSettleB: { sig: adminSettleBSig, solscan: adminSettleBSig === "already-settled-skipped" ? undefined : SOLSCAN_DEVNET + adminSettleBSig + "?cluster=devnet" },
      redeemA: { sig: redeemSig, solscan: SOLSCAN_DEVNET + redeemSig + "?cluster=devnet" },
    },
    strikes: {
      A: {
        pda: STRIKE_A_PDA,
        expiry: STRIKE_A_EXPIRY,
        outcome: aOutcomeKey,
        settlePrice: strikeAState.settlePrice.toString(),
        settleConfidence: strikeAState.settleConfidence.toString(),
        settleSlot: strikeAState.settleSlot.toString(),
        settledAtUnix: strikeAState.settledAtUnix.toString(),
        settlePath: "admin_settle(Yes) — settle_price=0 marks admin-pathed (Pyth devnet unavailable)",
      },
      B: {
        pda: STRIKE_B_PDA,
        expiry: STRIKE_B_EXPIRY,
        outcome: bOutcomeKey,
        settlePrice: strikeBState.settlePrice.toString(),
        settledAtUnix: strikeBState.settledAtUnix.toString(),
        settlePath: "admin_settle(Yes)",
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
    event: "resume.fatal",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }));
  process.exit(1);
});
