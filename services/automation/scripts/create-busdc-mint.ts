// One-shot operator script: create the bUSDC demo mint on devnet.
//
// DR-020 pivot: BellMarkets is moving to a self-controlled "bUSDC" SPL mint
// for the demo so we can mint test USDC freely to demo wallets without
// depending on Circle's devnet faucet. The platform admin keypair is both
// mint authority and freeze authority — we'll flip MarketConfig.usdc_mint
// to point here once Aria's deploy_index=7 lands `update_usdc_mint`.
//
// Usage:
//   pnpm --filter @bell-markets/automation busdc:create
//
// Idempotency: the script ALWAYS creates a NEW mint (createMint generates a
// random keypair). Running twice produces two distinct mints. The output
// JSON is the authoritative record — paste the mint pubkey into
// `.project/bell-markets/coordination/devnet-pubkeys.md` once verified.
//
// Hard rule: signs with `keys/devnet-platform-admin.json` only. No other
// authority is acceptable here per the security registry (Aria's pubkey
// 7b17F2wo… is the canonical platform admin).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEVNET_RPC = process.env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.PLATFORM_ADMIN_KEYPAIR_PATH || "keys/devnet-platform-admin.json";
const DECIMALS = 6; // matches Circle USDC for invariant symmetry

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

function rpcHost(): string {
  try { return new URL(DEVNET_RPC).host; } catch { return "<invalid>"; }
}

async function main() {
  console.error(JSON.stringify({ event: "operator.busdc-create.start", rpcHost: rpcHost() }));

  const platformAdmin = await loadPlatformAdminKeypair();
  console.error(
    JSON.stringify({
      event: "operator.busdc-create.keypair-loaded",
      platformAdmin: platformAdmin.publicKey.toBase58(),
    }),
  );

  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const connection = new web3.Connection(DEVNET_RPC, "confirmed");

  // Balance check — createMint with 6 decimals is ~0.0015 SOL rent. Refuse
  // to start if the admin doesn't have at least 0.01 SOL headroom.
  const balance = await connection.getBalance(platformAdmin.publicKey);
  console.error(
    JSON.stringify({
      event: "operator.busdc-create.balance",
      sol: balance / 1e9,
    }),
  );
  if (balance < 0.01 * 1e9) {
    throw new Error(
      `Platform admin balance ${balance / 1e9} SOL is below 0.01 SOL floor — airdrop first.`,
    );
  }

  // createMint generates a new mint keypair internally + sends one
  // CreateAccount+InitializeMint tx. Platform admin is both the payer of
  // rent + the future mint authority + freeze authority.
  const mintPubkey = await spl.createMint(
    connection,
    platformAdmin, // payer
    platformAdmin.publicKey, // mintAuthority
    platformAdmin.publicKey, // freezeAuthority — same as mint authority for demo simplicity
    DECIMALS,
    undefined, // keypair — let SDK generate
    { commitment: "confirmed" },
  );

  console.error(
    JSON.stringify({
      event: "operator.busdc-create.success",
      mintPubkey: mintPubkey.toBase58(),
      decimals: DECIMALS,
      mintAuthority: platformAdmin.publicKey.toBase58(),
      freezeAuthority: platformAdmin.publicKey.toBase58(),
    }),
  );

  // Final stdout line is the JSON the operator captures into devnet-pubkeys.md.
  console.log(
    JSON.stringify({
      ok: true,
      mintPubkey: mintPubkey.toBase58(),
      decimals: DECIMALS,
      mintAuthority: platformAdmin.publicKey.toBase58(),
      freezeAuthority: platformAdmin.publicKey.toBase58(),
      cluster: "devnet",
      rpcHost: rpcHost(),
      createdAt: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.busdc-create.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
