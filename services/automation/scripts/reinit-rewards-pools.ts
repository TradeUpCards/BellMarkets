// Admin script: migrate weekly_pool + monthly_pool to the current
// MarketConfig.usdc_mint (DR-020 Path B — post deploy_index=8).
//
// Why:
//   update_usdc_mint (deploy_index=7) flipped config.usdc_mint
//   Circle USDC -> bUSDC, but left the existing weekly_pool +
//   monthly_pool TokenAccounts bound to Circle USDC. mint_pair's
//   `token::mint = usdc_mint` constraint now fails with ConstraintTokenMint.
//   reinit_rewards_pools (deploy_index=8) closes the old pool TAs and
//   re-creates them at the same PDA addresses, bound to the current
//   config.usdc_mint.
//
// Idempotency:
//   1. Read weekly_pool + monthly_pool current mints
//   2. If BOTH already match config.usdc_mint, no-op (logs + exits 0)
//   3. Else call reinit_rewards_pools; verify post-call
//
// Usage:
//   pnpm --filter @bell-markets/automation reinit-rewards-pools

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";

async function main() {
  const programId = process.env.BELL_MARKETS_PROGRAM_ID;
  const rpcUrl = process.env.HELIUS_DEVNET_RPC_URL;
  const keypairPath = process.env.PLATFORM_ADMIN_KEYPAIR_PATH;
  const idlPath = process.env.BELL_MARKETS_IDL_PATH || "src/idl/bell_markets.json";
  if (!programId || !rpcUrl || !keypairPath) {
    throw new Error(
      "missing env: BELL_MARKETS_PROGRAM_ID, HELIUS_DEVNET_RPC_URL, PLATFORM_ADMIN_KEYPAIR_PATH",
    );
  }

  console.error(JSON.stringify({ event: "operator.reinit-pools.start", programId, rpc: rpcUrl }));

  const anchorClient = new BellMarketsAnchorClient({
    rpcUrl,
    programId,
    keypairPath,
    idlPath,
  });
  const program = await anchorClient.getProgram();
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");

  const programIdPk = new web3.PublicKey(programId);
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);
  const [weeklyPoolPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("weekly_pool")],
    programIdPk,
  );
  const [monthlyPoolPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("monthly_pool")],
    programIdPk,
  );

  const provider = program.provider as unknown as {
    wallet: { publicKey: import("@solana/web3.js").PublicKey };
    connection: import("@solana/web3.js").Connection;
  };
  const adminPk = provider.wallet.publicKey;
  const connection = provider.connection;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = program.account as any;
  const currentConfig = (await account.marketConfig.fetch(configPda)) as {
    admin: import("@solana/web3.js").PublicKey;
    usdcMint: import("@solana/web3.js").PublicKey;
  };

  if (!adminPk.equals(currentConfig.admin)) {
    throw new Error(
      `signer mismatch: loaded keypair ${adminPk.toBase58()} is not config admin ${currentConfig.admin.toBase58()}`,
    );
  }

  const weeklyBefore = await spl.getAccount(connection, weeklyPoolPda);
  const monthlyBefore = await spl.getAccount(connection, monthlyPoolPda);

  console.error(
    JSON.stringify({
      event: "operator.reinit-pools.current",
      configUsdcMint: currentConfig.usdcMint.toBase58(),
      weeklyPool: weeklyPoolPda.toBase58(),
      weeklyMint: weeklyBefore.mint.toBase58(),
      weeklyAmount: weeklyBefore.amount.toString(),
      monthlyPool: monthlyPoolPda.toBase58(),
      monthlyMint: monthlyBefore.mint.toBase58(),
      monthlyAmount: monthlyBefore.amount.toString(),
    }),
  );

  // Idempotency: if both pools already match config.usdc_mint, no-op.
  if (
    weeklyBefore.mint.equals(currentConfig.usdcMint) &&
    monthlyBefore.mint.equals(currentConfig.usdcMint)
  ) {
    console.error(
      JSON.stringify({
        event: "operator.reinit-pools.no-op",
        reason: "both pools already bound to config.usdc_mint",
      }),
    );
    console.log(
      JSON.stringify({
        ok: true,
        noOp: true,
        configUsdcMint: currentConfig.usdcMint.toBase58(),
        weeklyMint: weeklyBefore.mint.toBase58(),
        monthlyMint: monthlyBefore.mint.toBase58(),
      }),
    );
    return;
  }

  // Pre-flight: pool.amount == 0 required by handler (PoolNotEmpty defense).
  if (weeklyBefore.amount !== 0n) {
    throw new Error(`weekly_pool.amount = ${weeklyBefore.amount} (must be 0; drain before reinit)`);
  }
  if (monthlyBefore.amount !== 0n) {
    throw new Error(`monthly_pool.amount = ${monthlyBefore.amount} (must be 0; drain before reinit)`);
  }

  // ── Send tx ───────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  const txSig: string = await methods
    .reinitRewardsPools()
    .accounts({
      admin: adminPk,
      config: configPda,
      usdcMint: currentConfig.usdcMint,
      weeklyPool: weeklyPoolPda,
      monthlyPool: monthlyPoolPda,
      tokenProgram: new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      systemProgram: web3.SystemProgram.programId,
      rent: web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.error(JSON.stringify({ event: "operator.reinit-pools.sent", txSig }));

  // ── Verify ────────────────────────────────────────────────────────────
  const weeklyAfter = await spl.getAccount(connection, weeklyPoolPda);
  const monthlyAfter = await spl.getAccount(connection, monthlyPoolPda);
  if (!weeklyAfter.mint.equals(currentConfig.usdcMint)) {
    throw new Error(
      `post-tx verification failed: weekly_pool.mint = ${weeklyAfter.mint.toBase58()} (expected ${currentConfig.usdcMint.toBase58()})`,
    );
  }
  if (!monthlyAfter.mint.equals(currentConfig.usdcMint)) {
    throw new Error(
      `post-tx verification failed: monthly_pool.mint = ${monthlyAfter.mint.toBase58()} (expected ${currentConfig.usdcMint.toBase58()})`,
    );
  }

  console.error(
    JSON.stringify({
      event: "operator.reinit-pools.verified",
      weeklyMint: weeklyAfter.mint.toBase58(),
      monthlyMint: monthlyAfter.mint.toBase58(),
    }),
  );

  console.log(
    JSON.stringify({
      ok: true,
      noOp: false,
      txSig,
      configUsdcMint: currentConfig.usdcMint.toBase58(),
      previousWeeklyMint: weeklyBefore.mint.toBase58(),
      previousMonthlyMint: monthlyBefore.mint.toBase58(),
      weeklyMint: weeklyAfter.mint.toBase58(),
      monthlyMint: monthlyAfter.mint.toBase58(),
      weeklyPoolPda: weeklyPoolPda.toBase58(),
      monthlyPoolPda: monthlyPoolPda.toBase58(),
      cluster: "devnet",
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.reinit-pools.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
