#!/usr/bin/env node
/**
 * deploy-5-lifecycle.mjs — Live broadcast lifecycle test against Aria's
 * deploy-5 program at 599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV.
 *
 * Per Tate's 2026-05-23 dispatch P1. Drew can sign for permissionless ix
 * (settle_market, mint_pair from user, redeem, close_settled_market,
 *  user_create_strike_market) — admin-only steps (update_fee_config,
 * admin_settle) are SIMULATED and the txs are documented for Aria.
 *
 * Outputs JSON to stdout; the report doc is built by piping this script's
 * output into tests/integration/deploy-5-lifecycle-report.md generation.
 *
 * Usage:
 *   node tests/integration/deploy-5-lifecycle.mjs
 *
 * Idempotency: each step is wrapped in try/catch. If a step fails because
 * state already exists (e.g., market already settled), the script logs the
 * failure + moves on. Re-running is safe but skips already-done work.
 *
 * Requires: keys/devnet-drew-admin.json (Drew's funded keypair); installed
 * @coral-xyz/anchor + @solana/web3.js from tests/node_modules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Use require() rooted in the tests/ dir so @coral-xyz/anchor + @solana/web3.js
// resolve from tests/node_modules (where the workspace devDeps live).
const requireFromTests = createRequire(path.resolve(REPO_ROOT, "tests", "package.json"));
const anchor = requireFromTests("@coral-xyz/anchor");
const web3 = requireFromTests("@solana/web3.js");

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } = web3;

const PROGRAM_ID = new PublicKey("599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV");
const MARKET_CONFIG_PDA = new PublicKey("6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ");
const PLATFORM_ADMIN = new PublicKey("7b17F2woUy9hgHcRjuLckBVAtNnKAJBRD769URvLprp5");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const DREW_KEYPAIR_PATH = path.resolve(REPO_ROOT, "keys", "devnet-drew-admin.json");
const IDL_PATH = path.resolve(REPO_ROOT, "programs", "bell-markets", "idl", "bell_markets.json");

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");

const secret = JSON.parse(fs.readFileSync(DREW_KEYPAIR_PATH, "utf8"));
const drew = Keypair.fromSecretKey(Uint8Array.from(secret));
const wallet = new anchor.Wallet(drew);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const program = new anchor.Program(idl, provider);

// ─── Report helpers ───────────────────────────────────────────────────────

const events = [];
function record(step, status, details = {}) {
  const entry = { step, status, ts: new Date().toISOString(), ...details };
  events.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}

async function main() {
  record("start", "info", { drew: drew.publicKey.toBase58(), drewBalance: (await connection.getBalance(drew.publicKey)) / 1e9, program: PROGRAM_ID.toBase58() });

  // ─── Step 0: find a settle-eligible StrikeMarket ────────────────────────
  const allStrikes = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: "KJaQDqXuFRY" } }],   // StrikeMarket discriminator
  });
  // Decode each for outcome + expiry; pick the first unsettled + expired one.
  const now = BigInt(Math.floor(Date.now() / 1000));
  let target = null;
  for (const acc of allStrikes) {
    const d = acc.account.data;
    const expiryUnix = d.readBigInt64LE(80);
    const outcomeByte = d[248];   // after 8 disc + 32 config + 32 pyth + 8 strike + 8 expiry + 32 yes_mint + 32 no_mint + 32 vault + 32 phoenix + 8 settle_price + 8 settle_conf + 8 settle_slot + 8 settled_at
    if (outcomeByte === 0 && expiryUnix < now) {
      target = { pubkey: acc.pubkey, data: d, expiryUnix };
      break;
    }
  }
  if (!target) {
    record("step-0", "fail", { reason: "no settle-eligible market found (all settled or pre-expiry)" });
    return;
  }
  const m = target.data;
  const strikeMarket = target.pubkey;
  const pythFeed = new PublicKey(m.subarray(40, 72));
  const strikePrice = m.readBigInt64LE(72);
  record("step-0", "ok", {
    selected: strikeMarket.toBase58(),
    pythFeed: pythFeed.toBase58(),
    strikeUsd: Number(strikePrice) / 1e6,
    expiryUnix: target.expiryUnix.toString(),
    secondsPastExpiry: (now - target.expiryUnix).toString(),
  });

  // ─── Step 1 (LIVE): settle_market via non-admin Drew — DR-002 chain proof ─
  // This is the HY-5 / DR-002 proof in its strongest form: a real broadcast
  // by a non-admin keypair that writes the outcome on chain.
  try {
    const ix = await program.methods
      .settleMarket()
      .accounts({
        settler: drew.publicKey,
        config: MARKET_CONFIG_PDA,
        strikeMarket,
        underlyingPythFeed: pythFeed,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = drew.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(drew);

    // First simulate to ensure the tx is well-formed.
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      record("step-1-settle-simulate", "fail", { err: sim.value.err, logs: sim.value.logs?.slice(-5) });
      // If the only failure is Pyth confidence/staleness, that's a chain-level handler revert
      // — still positive evidence DR-002 is permissionless. Document + continue.
      record("step-1-settle-broadcast", "skipped", { reason: "simulation failed; not broadcasting (would waste SOL)" });
    } else {
      record("step-1-settle-simulate", "ok", { logs: sim.value.logs?.slice(-5) });
      // Broadcast.
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      record("step-1-settle-broadcast", "ok", { txSig: sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet` });

      // Re-fetch market to verify outcome was written.
      const after = await connection.getAccountInfo(strikeMarket);
      const newOutcomeByte = after.data[248];
      const settlePrice = after.data.readBigInt64LE(216);
      const settledAtUnix = after.data.readBigInt64LE(240);
      record("step-1-settle-verify", "ok", {
        outcomeBefore: 0, outcomeAfter: newOutcomeByte,
        outcomeName: ["Unsettled", "Yes", "No", "Invalid"][newOutcomeByte],
        settlePriceUsd: Number(settlePrice) / 1e6,
        settledAtUnix: settledAtUnix.toString(),
      });
    }
  } catch (e) {
    record("step-1-settle", "fail", { err: e.message?.slice(0, 500) });
  }

  // ─── Step 2 (SIMULATE-ONLY): update_fee_config from Drew (non-admin) ───
  // Expected: NotAdmin (6001). Confirms the admin gate is enforced on chain.
  try {
    const [feeConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("fee_config")], PROGRAM_ID);
    const ix = await program.methods
      .updateFeeConfig({
        mintFeeBps: 200,
        platformRetainBps: 5000,
        weeklyPoolBps: 2500,
        monthlyPoolBps: 2500,
        creatorRebateBps: 10000,
        forceRedeemGraceSecs: new anchor.BN(30 * 24 * 60 * 60),
        weeklyDistributionBps: [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400],
        monthlyDistributionBps: [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400],
      })
      .accounts({
        admin: drew.publicKey,
        config: MARKET_CONFIG_PDA,
        feeConfig: feeConfigPda,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = drew.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(drew);
    const sim = await connection.simulateTransaction(tx);
    const errStr = JSON.stringify(sim.value.err);
    const code = errStr?.match(/Custom":\s*(\d+)/)?.[1];
    record("step-2-update-fee-from-drew", code === "6001" ? "ok" : "unexpected", {
      expectedReject: "NotAdmin (6001)",
      actualErr: code ? `Custom: ${code}` : errStr,
      interpretation: code === "6001" ? "admin gate enforced on chain — confirmed" : "got non-NotAdmin error; investigate",
    });
  } catch (e) {
    // Anchor methods builder may not have updateFeeConfig in the right format; capture + move on.
    record("step-2-update-fee-from-drew", "error-in-build", { err: e.message?.slice(0, 300) });
  }

  // ─── Step 3 (DOCUMENT): user_create_strike_market with no TickerConfig ─
  // Currently no TickerConfig PDA exists on devnet. user_create_strike_market
  // should revert with TickerConfigNotInitialized (or whichever Aria named it).
  try {
    const [tickerCfgPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticker_config"), pythFeed.toBuffer()], PROGRAM_ID,
    );
    const tcInfo = await connection.getAccountInfo(tickerCfgPda);
    record("step-3-ticker-config-check", "info", {
      tickerConfigPda: tickerCfgPda.toBase58(),
      exists: tcInfo !== null,
      note: tcInfo === null
        ? "Drew CAN'T run user_create_strike_market against SOL/USD until Bram's morning cron writes the TickerConfig (per DR-005+DR-006)"
        : "TickerConfig exists; user_create_strike_market is unblocked",
    });
  } catch (e) {
    record("step-3-ticker-config-check", "error", { err: e.message?.slice(0, 300) });
  }

  // ─── Step 4 (DOCUMENT BLOCKED): admin-only steps need Aria ─────────────
  record("step-4-admin-blocked", "info", {
    blockedSteps: [
      "update_fee_config (mint_fee_bps 0→200) — Aria admin keypair only",
      "admin_settle (alternative settle path) — Aria admin keypair only",
      "force_redeem — Aria admin keypair only; requires 30-day grace anyway",
    ],
    workaround: "settle_market (step 1 above) provides DR-002 permissionless evidence; close_settled_market can be tested if step-1 succeeded + market drains to 0",
  });

  record("summary", "info", {
    drewBalanceAfter: (await connection.getBalance(drew.publicKey)) / 1e9,
    totalEvents: events.length,
    successCount: events.filter((e) => e.status === "ok").length,
    failCount: events.filter((e) => e.status === "fail").length,
  });
}

main().catch((e) => {
  record("fatal", "fail", { err: e.message, stack: e.stack?.split("\n").slice(0, 5).join("\n") });
  process.exit(1);
});
