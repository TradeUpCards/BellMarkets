// Verify the on-chain MarketConfig.usdc_mint field. Quick diagnostic for
// the "insufficient funds" trade-view bug — if config still points at the
// old Circle USDC mint, the frontend will look up the wrong ATA and see 0.

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";
import { loadConfig } from "../src/config.js";

const EXPECTED_BUSDC = "5vq2oahKFnnjStK1Ctqwdxdt44rtKuKHmPga9iZKtBZp";
const RECIPIENT_WALLET = "BYPeNkAVEHvfSBzWTnxgFx4DVzMEpNoowKpmmRr67YiW";
const EXPECTED_ATA = "63BXnEtJRojKtrkdx1SHtSUgv7RLw6rXeiGJdP4QCSrk";

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
  const programIdPk = new web3.PublicKey(cfg.bellMarketsProgramId);
  const [configPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programIdPk,
  );
  const connection = (program.provider as unknown as {
    connection: import("@solana/web3.js").Connection;
  }).connection;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mc = await (program.account as any).marketConfig.fetch(configPda);
  const usdcMint = mc.usdcMint.toBase58();
  const ok = usdcMint === EXPECTED_BUSDC;
  console.log(`${ok ? "✅" : "❌"} MarketConfig.usdc_mint = ${usdcMint}`);
  console.log(`   expected bUSDC          = ${EXPECTED_BUSDC}`);
  console.log(`   admin                   = ${mc.admin.toBase58()}`);
  console.log(`   treasury                = ${mc.treasury.toBase58()}`);
  console.log(`   paused                  = ${mc.paused}`);

  // Now also confirm the recipient wallet's bUSDC ATA exists + has balance.
  const recipientPk = new web3.PublicKey(RECIPIENT_WALLET);
  const busdcMintPk = new web3.PublicKey(EXPECTED_BUSDC);
  const derivedAta = spl.getAssociatedTokenAddressSync(busdcMintPk, recipientPk, true);
  console.log(
    `\n${derivedAta.toBase58() === EXPECTED_ATA ? "✅" : "❌"} Derived ATA for (bUSDC, ${RECIPIENT_WALLET.slice(0, 8)}…) = ${derivedAta.toBase58()}`,
  );
  console.log(`   expected ATA            = ${EXPECTED_ATA}`);

  try {
    const ataInfo = await spl.getAccount(connection, derivedAta);
    const balance = Number(ataInfo.amount) / 1_000_000;
    console.log(`✅ ATA exists on-chain · balance = ${balance} bUSDC (${ataInfo.amount} atomic)`);
    console.log(`   ATA mint                = ${ataInfo.mint.toBase58()}`);
    console.log(`   ATA owner               = ${ataInfo.owner.toBase58()}`);
  } catch (e) {
    console.log(`❌ ATA fetch failed: ${(e as Error).message}`);
  }

  console.log("\n=== DIAGNOSIS ===");
  if (!ok) {
    console.log(
      "❌ MarketConfig.usdc_mint is NOT bUSDC. The frontend's useMarketConfig",
    );
    console.log("   returns the wrong mint → useTokenBalance looks up the wrong ATA →");
    console.log("   balance always reads as 0 → 'insufficient funds'.");
    console.log("   FIX: re-run update_usdc_mint admin ix to set it to bUSDC.");
  } else {
    console.log("✅ MarketConfig.usdc_mint is bUSDC. ATA derivation is correct.");
    console.log("   The 'insufficient funds' bug is likely a frontend hook lifecycle");
    console.log("   issue — useMarketConfig data not propagating to useTokenBalance");
    console.log("   on time, or a stale TanStack Query cache. Frontend fix.");
  }
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error ? err.stack : "");
  process.exit(1);
});
