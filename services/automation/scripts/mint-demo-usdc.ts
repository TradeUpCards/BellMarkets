// Admin script: mint bUSDC to any devnet wallet.
//
// Usage:
//   pnpm --filter @bell-markets/automation mint-demo-usdc <wallet-pubkey> <amount>
//   e.g. pnpm --filter @bell-markets/automation mint-demo-usdc <wallet> 100
//
// <amount> is in whole bUSDC units (script multiplies by 10^DECIMALS). Mint
// 100 → recipient gets 100 bUSDC = 100_000_000 atomic units.
//
// Behavior:
//   1. Resolve bUSDC mint pubkey from env BUSDC_MINT or from
//      .project/.../devnet-pubkeys.md (operator pastes after busdc:create)
//   2. Create the recipient ATA if missing (idempotent via getOrCreateATA)
//   3. mintTo signed by platform admin (must equal mint authority)
//   4. Print final balance JSON to stdout for downstream tooling
//
// Hard rule: signs with `keys/devnet-platform-admin.json` only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEVNET_RPC = process.env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.PLATFORM_ADMIN_KEYPAIR_PATH || "keys/devnet-platform-admin.json";
const DECIMALS = 6; // bUSDC decimals (matches Circle USDC)

async function loadPlatformAdminKeypair() {
  const absolute = resolve(KEYPAIR_PATH);
  const raw = readFileSync(absolute, "utf-8");
  const bytes = JSON.parse(raw) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Keypair at ${absolute} must be a JSON array of 64 numbers`);
  }
  const web3 = await import("@solana/web3.js");
  return web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function parseArgs(): { recipient: string; amount: number } {
  const recipient = process.argv[2];
  const amountStr = process.argv[3];
  if (!recipient || !amountStr) {
    throw new Error(
      "usage: mint-demo-usdc <wallet-pubkey> <amount-in-whole-bUSDC>\n" +
        "example: pnpm --filter @bell-markets/automation mint-demo-usdc DemoWaLL... 100",
    );
  }
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`amount must be a positive number, got "${amountStr}"`);
  }
  return { recipient, amount };
}

async function main() {
  const { recipient, amount } = parseArgs();
  const busdcMint = process.env.BUSDC_MINT;
  if (!busdcMint) {
    throw new Error(
      "BUSDC_MINT env var unset — paste the bUSDC mint pubkey from busdc:create output into .env or set BUSDC_MINT=<pubkey> inline.",
    );
  }

  // Redact secrets in operator logs: log host only (api-key query strip).
  const rpcHost = (() => {
    try { return new URL(DEVNET_RPC).host; } catch { return "<invalid>"; }
  })();
  console.error(
    JSON.stringify({
      event: "operator.mint-demo-usdc.start",
      recipient,
      amount,
      busdcMint,
      rpcHost,
    }),
  );

  const platformAdmin = await loadPlatformAdminKeypair();
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const connection = new web3.Connection(DEVNET_RPC, "confirmed");

  const mintPk = new web3.PublicKey(busdcMint);
  const recipientPk = new web3.PublicKey(recipient);

  // Idempotent ATA creation — returns existing if already there. Platform
  // admin is the rent payer when the ATA needs to be created.
  const recipientAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    platformAdmin, // payer
    mintPk,
    recipientPk,
    false, // allowOwnerOffCurve — false; recipient must be a real wallet
  );
  console.error(
    JSON.stringify({
      event: "operator.mint-demo-usdc.ata-ready",
      ata: recipientAta.address.toBase58(),
      balanceBefore: Number(recipientAta.amount),
    }),
  );

  const atomicAmount = BigInt(Math.floor(amount * 10 ** DECIMALS));
  const txSig = await spl.mintTo(
    connection,
    platformAdmin, // payer
    mintPk,
    recipientAta.address,
    platformAdmin, // mintAuthority (must match the mint's authority)
    atomicAmount,
    [],
    { commitment: "confirmed" },
  );

  // Refresh ATA to capture post-mint balance.
  const postAccount = await spl.getAccount(connection, recipientAta.address);

  console.error(
    JSON.stringify({
      event: "operator.mint-demo-usdc.success",
      txSig,
      ata: recipientAta.address.toBase58(),
      mintedAtomic: atomicAmount.toString(),
      balanceAfterAtomic: postAccount.amount.toString(),
    }),
  );

  console.log(
    JSON.stringify({
      ok: true,
      txSig,
      recipient,
      ata: recipientAta.address.toBase58(),
      busdcMint,
      mintedAmount: amount,
      balanceAfter: Number(postAccount.amount) / 10 ** DECIMALS,
      cluster: "devnet",
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.mint-demo-usdc.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
