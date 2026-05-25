// Admin script: fund all test wallets with bUSDC + SOL for tx fees.
//
// Usage:
//   pnpm --filter @bell-markets/automation fund-test-wallets
//   pnpm --filter @bell-markets/automation fund-test-wallets --busdc 1000 --sol 0.05
//   pnpm --filter @bell-markets/automation fund-test-wallets --skip-sol
//   pnpm --filter @bell-markets/automation fund-test-wallets --range 0:10  (fund first 10)
//
// Behavior:
//   1. Reads keys/test-wallets.json (must run gen-test-wallets first)
//   2. For each wallet (or range):
//      a. Transfers SOL from platform admin → wallet (for tx fees) — skippable
//      b. Mints bUSDC to wallet's bUSDC ATA via mintTo (admin = mint authority)
//   3. Idempotent: skips bUSDC if existing balance >= target; skips SOL if balance >= target
//   4. Continues on per-wallet errors; final summary counts successes + failures
//
// Hard rule: signs with `keys/devnet-platform-admin.json` only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEVNET_RPC = process.env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.PLATFORM_ADMIN_KEYPAIR_PATH || "keys/devnet-platform-admin.json";
const WALLETS_PATH = "keys/test-wallets.json";
const DEFAULT_BUSDC = 1000; // whole bUSDC
const DEFAULT_SOL = 0.05; // SOL for tx fees (covers ~10,000 txs at 5000 lamports each)
const DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;

interface Wallet {
  index: number;
  pubkey: string;
  secretKeyBase58: string;
  secretKeyBytes: number[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const busdcArg = args.indexOf("--busdc");
  const solArg = args.indexOf("--sol");
  const rangeArg = args.indexOf("--range");
  const skipSol = args.includes("--skip-sol");

  const busdcAmount = busdcArg >= 0 ? Number(args[busdcArg + 1]) : DEFAULT_BUSDC;
  const solAmount = solArg >= 0 ? Number(args[solArg + 1]) : DEFAULT_SOL;
  let range: { start: number; end: number } | null = null;
  if (rangeArg >= 0) {
    const [s, e] = args[rangeArg + 1].split(":").map(Number);
    range = { start: s, end: e };
  }

  if (!Number.isFinite(busdcAmount) || busdcAmount < 0) {
    throw new Error(`--busdc must be a non-negative number, got "${args[busdcArg + 1]}"`);
  }
  if (!Number.isFinite(solAmount) || solAmount < 0) {
    throw new Error(`--sol must be a non-negative number, got "${args[solArg + 1]}"`);
  }

  return { busdcAmount, solAmount, range, skipSol };
}

async function loadPlatformAdminKeypair() {
  const absolute = resolve(KEYPAIR_PATH);
  const raw = readFileSync(absolute, "utf-8");
  const bytes = JSON.parse(raw) as number[];
  const web3 = await import("@solana/web3.js");
  return web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function loadWallets(): Wallet[] {
  const raw = readFileSync(resolve(WALLETS_PATH), "utf-8");
  return JSON.parse(raw);
}

async function main() {
  const { busdcAmount, solAmount, range, skipSol } = parseArgs();
  const busdcMint = process.env.BUSDC_MINT;
  if (!busdcMint) {
    throw new Error("BUSDC_MINT env var unset — set BUSDC_MINT=<pubkey> in env");
  }

  console.error(
    JSON.stringify({
      event: "operator.fund-test-wallets.start",
      busdcAmount,
      solAmount: skipSol ? null : solAmount,
      range,
      busdcMint,
      rpc: DEVNET_RPC,
    }),
  );

  const allWallets = loadWallets();
  const wallets = range
    ? allWallets.slice(range.start, range.end)
    : allWallets;

  console.error(
    JSON.stringify({
      event: "operator.fund-test-wallets.loaded",
      total: allWallets.length,
      toFund: wallets.length,
    }),
  );

  const platformAdmin = await loadPlatformAdminKeypair();
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const connection = new web3.Connection(DEVNET_RPC, "confirmed");

  const mintPk = new web3.PublicKey(busdcMint);
  const targetAtomicBusdc = BigInt(Math.floor(busdcAmount * 10 ** DECIMALS));
  const targetLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  const errors: Array<{ index: number; pubkey: string; error: string }> = [];

  for (const wallet of wallets) {
    const walletPk = new web3.PublicKey(wallet.pubkey);

    try {
      // === SOL transfer (if not skipped) ===
      if (!skipSol && solAmount > 0) {
        const currentBalance = await connection.getBalance(walletPk, "confirmed");
        if (currentBalance < targetLamports) {
          const toSend = targetLamports - currentBalance;
          const tx = new web3.Transaction().add(
            web3.SystemProgram.transfer({
              fromPubkey: platformAdmin.publicKey,
              toPubkey: walletPk,
              lamports: toSend,
            }),
          );
          await web3.sendAndConfirmTransaction(connection, tx, [platformAdmin], {
            commitment: "confirmed",
          });
          console.error(
            JSON.stringify({
              event: "operator.fund-test-wallets.sol-funded",
              index: wallet.index,
              pubkey: wallet.pubkey,
              lamportsSent: toSend,
            }),
          );
        } else {
          console.error(
            JSON.stringify({
              event: "operator.fund-test-wallets.sol-skip",
              index: wallet.index,
              pubkey: wallet.pubkey,
              currentLamports: currentBalance,
            }),
          );
        }
      }

      // === bUSDC mint (if requested) ===
      if (busdcAmount > 0) {
        // Idempotent ATA create
        const ata = await spl.getOrCreateAssociatedTokenAccount(
          connection,
          platformAdmin,
          mintPk,
          walletPk,
          false,
        );

        if (ata.amount >= targetAtomicBusdc) {
          console.error(
            JSON.stringify({
              event: "operator.fund-test-wallets.busdc-skip",
              index: wallet.index,
              pubkey: wallet.pubkey,
              currentAtomic: ata.amount.toString(),
            }),
          );
          skipCount++;
        } else {
          const toMint = targetAtomicBusdc - ata.amount;
          const txSig = await spl.mintTo(
            connection,
            platformAdmin,
            mintPk,
            ata.address,
            platformAdmin,
            toMint,
            [],
            { commitment: "confirmed" },
          );
          console.error(
            JSON.stringify({
              event: "operator.fund-test-wallets.busdc-funded",
              index: wallet.index,
              pubkey: wallet.pubkey,
              mintedAtomic: toMint.toString(),
              txSig,
            }),
          );
          successCount++;
        }
      } else {
        successCount++;
      }
    } catch (err) {
      errorCount++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ index: wallet.index, pubkey: wallet.pubkey, error: msg });
      console.error(
        JSON.stringify({
          event: "operator.fund-test-wallets.error",
          index: wallet.index,
          pubkey: wallet.pubkey,
          error: msg,
        }),
      );
    }
  }

  console.error(
    JSON.stringify({
      event: "operator.fund-test-wallets.summary",
      total: wallets.length,
      funded: successCount,
      skipped: skipCount,
      errors: errorCount,
    }),
  );

  console.log(
    JSON.stringify({
      ok: errorCount === 0,
      total: wallets.length,
      funded: successCount,
      skipped: skipCount,
      errors: errorCount,
      errorDetails: errors,
      busdcAmount,
      solAmount: skipSol ? null : solAmount,
      cluster: "devnet",
    }),
  );

  if (errorCount > 0) process.exit(2);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.fund-test-wallets.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
