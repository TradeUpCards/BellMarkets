// Admin script: flip MarketConfig.usdc_mint to the bUSDC demo mint.
//
// DR-020 P3: post deploy_index=7 (Aria 2026-05-25 01:20 UTC), the admin-only
// `update_usdc_mint(new_mint: Pubkey)` ix is live. This script:
//   1. Loads the existing MarketConfig via Anchor read
//   2. Compares config.usdc_mint vs the bUSDC target — no-op if already set
//   3. Otherwise signs `update_usdc_mint` with platform admin
//   4. Re-reads MarketConfig and confirms the flip
//
// Usage:
//   pnpm --filter @bell-markets/automation update-usdc-mint
//   pnpm --filter @bell-markets/automation update-usdc-mint --new-mint <pubkey>  // override target
//
// Env required: BELL_MARKETS_PROGRAM_ID, HELIUS_DEVNET_RPC_URL,
//   PLATFORM_ADMIN_KEYPAIR_PATH, BELL_MARKETS_IDL_PATH. BUSDC_MINT default
//   unless --new-mint given (the latter is for emergency reversion or future
//   demo-mint rotations).
//
// Side-effect notice (per DR-020): the 7 deploy_index=6 META strikes whose
// vaults hold Circle USDC become trade-inert after this flip — their
// usdc_vault.mint no longer matches MarketConfig.usdc_mint. Acceptable per
// DR-020 pivot scope.

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";

const DEFAULT_BUSDC_MINT = "5vq2oahKFnnjStK1Ctqwdxdt44rtKuKHmPga9iZKtBZp";

function parseArgs(): { newMintOverride: string | undefined } {
  let newMintOverride: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--new-mint" && i + 1 < process.argv.length) {
      newMintOverride = process.argv[i + 1];
      i++;
    }
  }
  return { newMintOverride };
}

async function main() {
  const { newMintOverride } = parseArgs();
  const newMintBase58 = newMintOverride || process.env.BUSDC_MINT || DEFAULT_BUSDC_MINT;

  const programId = process.env.BELL_MARKETS_PROGRAM_ID;
  const rpcUrl = process.env.HELIUS_DEVNET_RPC_URL;
  const keypairPath = process.env.PLATFORM_ADMIN_KEYPAIR_PATH;
  const idlPath = process.env.BELL_MARKETS_IDL_PATH || "src/idl/bell_markets.json";
  if (!programId || !rpcUrl || !keypairPath) {
    throw new Error(
      "missing env: BELL_MARKETS_PROGRAM_ID, HELIUS_DEVNET_RPC_URL, PLATFORM_ADMIN_KEYPAIR_PATH are required",
    );
  }

  console.error(
    JSON.stringify({
      event: "operator.update-usdc-mint.start",
      programId,
      newMint: newMintBase58,
      rpc: rpcUrl,
    }),
  );

  const anchorClient = new BellMarketsAnchorClient({
    rpcUrl,
    programId,
    keypairPath,
    idlPath,
  });
  const program = await anchorClient.getProgram();
  const web3 = await import("@solana/web3.js");
  const anchor = await import("@coral-xyz/anchor");

  const programIdPk = new web3.PublicKey(programId);
  const [configPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programIdPk,
  );
  const newMintPk = new web3.PublicKey(newMintBase58);

  // Read current config to (a) verify the program ID resolves a real account
  // and (b) skip the on-chain call if usdc_mint is already the target.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = program.account as any;
  const currentConfig = (await account.marketConfig.fetch(configPda)) as {
    admin: import("@solana/web3.js").PublicKey;
    usdcMint: import("@solana/web3.js").PublicKey;
  };

  console.error(
    JSON.stringify({
      event: "operator.update-usdc-mint.current",
      configPda: configPda.toBase58(),
      admin: currentConfig.admin.toBase58(),
      currentUsdcMint: currentConfig.usdcMint.toBase58(),
    }),
  );

  if (currentConfig.usdcMint.equals(newMintPk)) {
    console.error(
      JSON.stringify({
        event: "operator.update-usdc-mint.no-op",
        reason: "config.usdc_mint already equals target",
      }),
    );
    console.log(
      JSON.stringify({
        ok: true,
        noOp: true,
        usdcMint: currentConfig.usdcMint.toBase58(),
        configPda: configPda.toBase58(),
      }),
    );
    return;
  }

  // ── Send tx ────────────────────────────────────────────────────────────
  const provider = program.provider as unknown as {
    wallet: { publicKey: import("@solana/web3.js").PublicKey };
  };
  const adminPk = provider.wallet.publicKey;
  if (!adminPk.equals(currentConfig.admin)) {
    throw new Error(
      `signer mismatch: loaded keypair ${adminPk.toBase58()} is not the config admin ${currentConfig.admin.toBase58()}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  const txSig: string = await methods
    .updateUsdcMint(newMintPk)
    .accounts({
      admin: adminPk,
      config: configPda,
    })
    .rpc();

  console.error(
    JSON.stringify({
      event: "operator.update-usdc-mint.sent",
      txSig,
    }),
  );

  // ── Verify ─────────────────────────────────────────────────────────────
  const after = (await account.marketConfig.fetch(configPda)) as {
    usdcMint: import("@solana/web3.js").PublicKey;
  };
  if (!after.usdcMint.equals(newMintPk)) {
    throw new Error(
      `post-tx verification failed: usdc_mint is ${after.usdcMint.toBase58()} (expected ${newMintBase58})`,
    );
  }

  console.error(
    JSON.stringify({
      event: "operator.update-usdc-mint.verified",
      newUsdcMint: after.usdcMint.toBase58(),
    }),
  );

  console.log(
    JSON.stringify({
      ok: true,
      noOp: false,
      txSig,
      configPda: configPda.toBase58(),
      previousUsdcMint: currentConfig.usdcMint.toBase58(),
      newUsdcMint: after.usdcMint.toBase58(),
      cluster: "devnet",
      _anchorBn: typeof anchor.BN, // silence unused-import lint
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.update-usdc-mint.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
