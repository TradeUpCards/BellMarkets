// DR-020 P4 — seed demo liquidity on 1-3 tickers post deploy_index=7.
//
// Per chosen strike (one per ticker, ATM via live Pyth Hermes):
//   1. create_strike_market (admin)            — fresh PDA
//   2. init_order_book (admin)                 — phase 1: 10KB OrderBook PDA + escrows
//   3. grow_order_book (admin)                 — phase 2: realloc to LEN + open trading gate
//   4. mint_pair(200 bUSDC) (admin)            — 200 YES + 200 NO into admin's ATAs
//   5. place_order × 6 — non-crossing 3-rung ladder:
//        bids: $0.40, $0.45, $0.50 × 50 YES each
//        asks: $0.55, $0.60, $0.65 × 50 YES each
//      ($0.05 inside spread; non-crossing so the book stays populated for the
//      demo — interpretation of the dispatcher's "ladder" intent; the literal
//      "same 3 prices each side" would cross-fill itself and leave the book
//      sparse.)
//
// Each step is its own tx. Failure of one ticker doesn't roll back others.
// All output captured as JSON for downstream documenting into
// .project/bell-markets/coordination/demo-strikes.md.
//
// Usage:
//   pnpm --filter @bell-markets/automation seed-demo-liquidity
//   pnpm --filter @bell-markets/automation seed-demo-liquidity --tickers META,NVDA,AAPL
//   pnpm --filter @bell-markets/automation seed-demo-liquidity --skip-place-orders
//
// Env:
//   BUSDC_MINT, BELL_MARKETS_PROGRAM_ID, HELIUS_DEVNET_RPC_URL,
//   PYTH_HTTP_BASE_URL, PLATFORM_ADMIN_KEYPAIR_PATH, BELL_MARKETS_IDL_PATH,
//   PYTH_PRICE_ACCOUNT_<TICKER>, PHOENIX_MARKET_<TICKER> (with fallbacks).

import { BellMarketsAnchorClient } from "../src/clients/anchor.js";
import { PythClient } from "../src/clients/pyth.js";
import { PYTH_HERMES_FEED_IDS } from "../src/config.js";
import { scaleStrikeToI64 } from "../src/jobs/morning.js";
import type { Ticker } from "../src/types.js";

// ── Hardcoded constants from programs/bell-markets/src/state.rs ─────────────
const PRICE_SCALE = 1_000_000n; // u64 PRICE_SCALE (per spec: $1.00 = 1_000_000)
const SIDE_BID = 0;
const SIDE_ASK = 1;
const ORDER_BOOK_SEED = Buffer.from("order_book");
const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");
const TOKEN_PROGRAM_ID_BASE58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Default fallbacks if env per-ticker pubkeys aren't set. Re-uses
// known-good devnet placeholders (Day-4 META strikes used these).
const FALLBACK_PYTH_DEVNET = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"; // SOL/USD
const FALLBACK_PHOENIX_DEVNET = "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N"; // SOL/USDC magic-verified
const FALLBACK_FEE_COLLECTOR = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs"; // MarketConfig.treasury

const ORDER_LADDER_BIDS = [
  { priceMicroUsdc: 400_000n, sizeAtomic: 50_000_000n }, // $0.40 × 50 YES
  { priceMicroUsdc: 450_000n, sizeAtomic: 50_000_000n }, // $0.45 × 50 YES
  { priceMicroUsdc: 500_000n, sizeAtomic: 50_000_000n }, // $0.50 × 50 YES
];
const ORDER_LADDER_ASKS = [
  { priceMicroUsdc: 550_000n, sizeAtomic: 50_000_000n }, // $0.55 × 50 YES
  { priceMicroUsdc: 600_000n, sizeAtomic: 50_000_000n }, // $0.60 × 50 YES
  { priceMicroUsdc: 650_000n, sizeAtomic: 50_000_000n }, // $0.65 × 50 YES
];

const MINT_PAIR_AMOUNT_BUSDC = 200n; // human-readable bUSDC → 200_000_000 atomic

type CliArgs = {
  tickers: Ticker[];
  skipPlaceOrders: boolean;
  expiryUnix: number;
};

function parseArgs(): CliArgs {
  let tickers: Ticker[] = ["META"];
  let skipPlaceOrders = false;
  let expiryDaysOffset = 2; // T+36h default → "day after tomorrow at 4pm ET"
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--tickers" && i + 1 < process.argv.length) {
      const list = process.argv[i + 1]!.split(",").map((t) => t.trim().toUpperCase() as Ticker);
      tickers = list;
      i++;
    } else if (arg === "--skip-place-orders") {
      skipPlaceOrders = true;
    } else if (arg === "--expiry-days" && i + 1 < process.argv.length) {
      expiryDaysOffset = parseInt(process.argv[i + 1]!, 10);
      i++;
    }
  }
  // Expiry: T+(expiryDaysOffset * 24h - 12h), rounded to 4pm ET of that day.
  // Bounded by MAX_EXPIRY_HORIZON_SECS (7 days). Plenty of demo runway.
  const now = new Date();
  const twoDaysOut = new Date(now.getTime() + (expiryDaysOffset * 24 - 12) * 60 * 60 * 1000);
  const expiryUnix = Math.floor(
    Date.UTC(
      twoDaysOut.getUTCFullYear(),
      twoDaysOut.getUTCMonth(),
      twoDaysOut.getUTCDate(),
      20, // 4pm ET = 20:00 UTC during EDT
      0,
      0,
    ) / 1000,
  );
  return { tickers, skipPlaceOrders, expiryUnix };
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} is unset`);
  return v;
}

async function main() {
  const { tickers, skipPlaceOrders, expiryUnix } = parseArgs();
  const busdcMint = reqEnv("BUSDC_MINT");
  const programId = reqEnv("BELL_MARKETS_PROGRAM_ID");
  const rpcUrl = reqEnv("HELIUS_DEVNET_RPC_URL");
  const pythHttp = reqEnv("PYTH_HTTP_BASE_URL");
  const keypairPath = reqEnv("PLATFORM_ADMIN_KEYPAIR_PATH");
  const idlPath = process.env.BELL_MARKETS_IDL_PATH || "src/idl/bell_markets.json";

  console.error(
    JSON.stringify({
      event: "operator.seed-demo-liquidity.start",
      tickers,
      skipPlaceOrders,
      expiryUnix,
      expiryIso: new Date(expiryUnix * 1000).toISOString(),
    }),
  );

  const anchorClient = new BellMarketsAnchorClient({
    rpcUrl,
    programId,
    keypairPath,
    idlPath,
  });
  const program = await anchorClient.getProgram();
  const pyth = new PythClient({ baseUrl: pythHttp });
  const web3 = await import("@solana/web3.js");
  const anchor = await import("@coral-xyz/anchor");
  const spl = await import("@solana/spl-token");

  const programIdPk = new web3.PublicKey(programId);
  const busdcMintPk = new web3.PublicKey(busdcMint);
  const tokenProgramPk = new web3.PublicKey(TOKEN_PROGRAM_ID_BASE58);

  const provider = program.provider as unknown as {
    wallet: { publicKey: import("@solana/web3.js").PublicKey; payer?: import("@solana/web3.js").Keypair };
  };
  const adminPk = provider.wallet.publicKey;
  const adminKeypair = (provider.wallet as unknown as { payer?: import("@solana/web3.js").Keypair }).payer;
  if (!adminKeypair) throw new Error("provider wallet missing payer keypair for SPL ops");

  // Common PDAs
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);
  const [feeConfigPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("fee_config")], programIdPk);
  const [weeklyPoolPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("weekly_pool")], programIdPk);
  const [monthlyPoolPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("monthly_pool")], programIdPk);
  const [userConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user"), configPda.toBuffer(), adminPk.toBuffer()],
    programIdPk,
  );

  // fee_collector_usdc = bUSDC ATA owned by config.treasury (FAc2Jccu...)
  const treasuryPk = new web3.PublicKey(FALLBACK_FEE_COLLECTOR);
  const feeCollectorUsdcPk = await spl.getAssociatedTokenAddress(busdcMintPk, treasuryPk);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  const connection = (program.provider as unknown as { connection: import("@solana/web3.js").Connection })
    .connection;

  const perTicker: Array<Record<string, unknown>> = [];

  for (const ticker of tickers) {
    const tickerLog: Record<string, unknown> = { ticker };
    try {
      // 1. Read live Pyth spot
      const feedId = PYTH_HERMES_FEED_IDS[ticker];
      if (!feedId) throw new Error(`no Pyth Hermes feed id for ${ticker}`);
      const prev = await pyth.getPreviousClose({ ticker, feedId });
      const atmStrikeUsd = Math.round(prev.price); // round to nearest $1 — coarse but fine for demo
      tickerLog.spotUsd = prev.price;
      tickerLog.atmStrikeUsd = atmStrikeUsd;
      tickerLog.expo = prev.expo;
      const strikePriceI64 = scaleStrikeToI64(atmStrikeUsd, prev.expo);
      tickerLog.strikePriceI64 = strikePriceI64.toString();

      // 2. Resolve Pyth on-chain feed + Phoenix venue (env override or fallback)
      const pythAccountStr = process.env[`PYTH_PRICE_ACCOUNT_${ticker}`] || FALLBACK_PYTH_DEVNET;
      const phoenixStr = process.env[`PHOENIX_MARKET_${ticker}`] || FALLBACK_PHOENIX_DEVNET;
      const underlyingPythFeedPk = new web3.PublicKey(pythAccountStr);
      const phoenixMarketPk = new web3.PublicKey(phoenixStr);
      tickerLog.underlyingPythFeed = underlyingPythFeedPk.toBase58();
      tickerLog.phoenixMarket = phoenixMarketPk.toBase58();

      // 3. Derive strike + child PDAs
      const expiryLe = Buffer.alloc(8);
      expiryLe.writeBigInt64LE(BigInt(expiryUnix));
      const strikeLe = Buffer.alloc(8);
      strikeLe.writeBigInt64LE(strikePriceI64);
      const [strikeMarketPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("strike"), underlyingPythFeedPk.toBuffer(), expiryLe, strikeLe],
        programIdPk,
      );
      const [yesMintPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("yes"), strikeMarketPda.toBuffer()],
        programIdPk,
      );
      const [noMintPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("no"), strikeMarketPda.toBuffer()],
        programIdPk,
      );
      const [usdcVaultPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), strikeMarketPda.toBuffer()],
        programIdPk,
      );
      const [orderBookPda] = web3.PublicKey.findProgramAddressSync(
        [ORDER_BOOK_SEED, strikeMarketPda.toBuffer()],
        programIdPk,
      );
      const [usdcEscrowPda] = web3.PublicKey.findProgramAddressSync(
        [USDC_ESCROW_SEED, strikeMarketPda.toBuffer()],
        programIdPk,
      );
      const [yesEscrowPda] = web3.PublicKey.findProgramAddressSync(
        [YES_ESCROW_SEED, strikeMarketPda.toBuffer()],
        programIdPk,
      );
      tickerLog.strikeMarket = strikeMarketPda.toBase58();
      tickerLog.yesMint = yesMintPda.toBase58();
      tickerLog.noMint = noMintPda.toBase58();
      tickerLog.usdcVault = usdcVaultPda.toBase58();
      tickerLog.orderBook = orderBookPda.toBase58();
      tickerLog.usdcEscrow = usdcEscrowPda.toBase58();
      tickerLog.yesEscrow = yesEscrowPda.toBase58();

      // 4. create_strike_market (idempotent: if already exists, skip)
      const existingStrike = await connection.getAccountInfo(strikeMarketPda);
      if (existingStrike) {
        tickerLog.createStrikeMarket = "already-exists";
      } else {
        const sig = await methods
          .createStrikeMarket(new anchor.BN(strikePriceI64.toString()), new anchor.BN(expiryUnix))
          .accounts({
            admin: adminPk,
            config: configPda,
            strikeMarket: strikeMarketPda,
            underlyingPythFeed: underlyingPythFeedPk,
            yesMint: yesMintPda,
            noMint: noMintPda,
            usdcVault: usdcVaultPda,
            usdcMint: busdcMintPk,
            phoenixMarket: phoenixMarketPk,
            systemProgram: web3.SystemProgram.programId,
            tokenProgram: tokenProgramPk,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        tickerLog.createStrikeMarket = sig;
      }

      // 5. init_order_book (idempotent: if OrderBook already exists, skip)
      const existingOrderBook = await connection.getAccountInfo(orderBookPda);
      if (existingOrderBook && !existingOrderBook.data.every((b) => b === 0)) {
        tickerLog.initOrderBook = "already-exists";
      } else {
        const sig = await methods
          .initOrderBook()
          .accounts({
            user: adminPk,
            config: configPda,
            strikeMarket: strikeMarketPda,
            orderBook: orderBookPda,
            usdcMint: busdcMintPk,
            yesMint: yesMintPda,
            usdcEscrow: usdcEscrowPda,
            yesEscrow: yesEscrowPda,
            systemProgram: web3.SystemProgram.programId,
            tokenProgram: tokenProgramPk,
            rent: web3.SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        tickerLog.initOrderBook = sig;
      }

      // 6. grow_order_book — idempotent in handler (no-op if already grown).
      const growSig = await methods
        .growOrderBook()
        .accounts({
          user: adminPk,
          config: configPda,
          strikeMarket: strikeMarketPda,
          orderBook: orderBookPda,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc();
      tickerLog.growOrderBook = growSig;

      if (skipPlaceOrders) {
        tickerLog.placeOrders = "skipped";
        perTicker.push(tickerLog);
        console.error(JSON.stringify({ event: "operator.seed-demo-liquidity.ticker", ...tickerLog }));
        continue;
      }

      // 7. Ensure admin's bUSDC + user_yes + user_no ATAs (idempotent)
      const adminBusdcAta = await spl.getOrCreateAssociatedTokenAccount(
        connection,
        adminKeypair,
        busdcMintPk,
        adminPk,
      );
      const adminYesAta = await spl.getOrCreateAssociatedTokenAccount(
        connection,
        adminKeypair,
        yesMintPda,
        adminPk,
      );
      const adminNoAta = await spl.getOrCreateAssociatedTokenAccount(
        connection,
        adminKeypair,
        noMintPda,
        adminPk,
      );
      const treasuryAta = await spl.getOrCreateAssociatedTokenAccount(
        connection,
        adminKeypair,
        busdcMintPk,
        treasuryPk,
      );
      tickerLog.adminBusdcAta = adminBusdcAta.address.toBase58();
      tickerLog.adminYesAta = adminYesAta.address.toBase58();
      tickerLog.adminNoAta = adminNoAta.address.toBase58();
      tickerLog.feeCollectorUsdc = treasuryAta.address.toBase58();

      // 8. Top up admin bUSDC for mint_pair (+slack for bid escrow). 200 mint
      //    + 67.5 bid escrow + buffer ≈ 300 bUSDC. Mint 300.
      const need = 300_000_000n; // 300 bUSDC at 6 decimals
      if (BigInt(adminBusdcAta.amount.toString()) < need) {
        const topUp = need - BigInt(adminBusdcAta.amount.toString());
        await spl.mintTo(
          connection,
          adminKeypair,
          busdcMintPk,
          adminBusdcAta.address,
          adminKeypair,
          topUp,
          [],
          { commitment: "confirmed" },
        );
        tickerLog.bUsdcTopUp = topUp.toString();
      }

      // 9. mint_pair — may FAIL if existing weekly/monthly pools still bound to
      //    Circle USDC (the pools were bootstrapped on Day-5 with Circle USDC;
      //    flipping config.usdc_mint doesn't migrate them). Capture + log.
      try {
        const mintAmountAtomic = MINT_PAIR_AMOUNT_BUSDC * 1_000_000n;
        const mintSig = await methods
          .mintPair(new anchor.BN(mintAmountAtomic.toString()))
          .accounts({
            user: adminPk,
            config: configPda,
            feeConfig: feeConfigPda,
            userConfig: userConfigPda,
            strikeMarket: strikeMarketPda,
            userUsdc: adminBusdcAta.address,
            usdcVault: usdcVaultPda,
            yesMint: yesMintPda,
            noMint: noMintPda,
            userYes: adminYesAta.address,
            userNo: adminNoAta.address,
            feeCollectorUsdc: treasuryAta.address,
            weeklyPool: weeklyPoolPda,
            monthlyPool: monthlyPoolPda,
            usdcMint: busdcMintPk,
            clock: web3.SYSVAR_CLOCK_PUBKEY,
            systemProgram: web3.SystemProgram.programId,
            tokenProgram: tokenProgramPk,
          })
          .rpc();
        tickerLog.mintPair = mintSig;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        tickerLog.mintPair = `errored: ${reason.substring(0, 200)}`;
        // Bid placement requires only USDC (already in admin's ATA). Asks
        // require YES tokens — without mint_pair they'd fail. Place bids only.
        tickerLog.mintPairFallback = "bids-only";
      }

      // 10. Place orders: bids always, asks only if mint_pair succeeded
      const placedOrders: Array<{ side: string; price: string; size: string; txSig: string }> = [];
      const orderErrors: string[] = [];

      const placeOrderTx = async (side: number, priceMicroUsdc: bigint, sizeAtomic: bigint) => {
        const sig = await methods
          .placeOrder(side, new anchor.BN(priceMicroUsdc.toString()), new anchor.BN(sizeAtomic.toString()), false)
          .accounts({
            user: adminPk,
            config: configPda,
            strikeMarket: strikeMarketPda,
            orderBook: orderBookPda,
            yesMint: yesMintPda,
            usdcMint: busdcMintPk,
            userYes: adminYesAta.address,
            userUsdc: adminBusdcAta.address,
            usdcEscrow: usdcEscrowPda,
            yesEscrow: yesEscrowPda,
            tokenProgram: tokenProgramPk,
          })
          .rpc();
        return sig;
      };

      for (const rung of ORDER_LADDER_BIDS) {
        try {
          const sig = await placeOrderTx(SIDE_BID, rung.priceMicroUsdc, rung.sizeAtomic);
          placedOrders.push({ side: "bid", price: rung.priceMicroUsdc.toString(), size: rung.sizeAtomic.toString(), txSig: sig });
        } catch (err) {
          orderErrors.push(`bid ${rung.priceMicroUsdc}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (tickerLog.mintPair && !String(tickerLog.mintPair).startsWith("errored")) {
        for (const rung of ORDER_LADDER_ASKS) {
          try {
            const sig = await placeOrderTx(SIDE_ASK, rung.priceMicroUsdc, rung.sizeAtomic);
            placedOrders.push({ side: "ask", price: rung.priceMicroUsdc.toString(), size: rung.sizeAtomic.toString(), txSig: sig });
          } catch (err) {
            orderErrors.push(`ask ${rung.priceMicroUsdc}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      tickerLog.placedOrders = placedOrders;
      if (orderErrors.length) tickerLog.orderErrors = orderErrors;

      perTicker.push(tickerLog);
      console.error(JSON.stringify({ event: "operator.seed-demo-liquidity.ticker", ...tickerLog }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      tickerLog.error = reason;
      perTicker.push(tickerLog);
      console.error(JSON.stringify({ event: "operator.seed-demo-liquidity.ticker-fatal", ...tickerLog }));
    }
  }

  // Final summary (last stdout line — captured by operator into demo-strikes.md)
  console.log(
    JSON.stringify({
      ok: true,
      expiryUnix,
      expiryIso: new Date(expiryUnix * 1000).toISOString(),
      ladder: {
        bids: ORDER_LADDER_BIDS.map((r) => ({ price: r.priceMicroUsdc.toString(), size: r.sizeAtomic.toString() })),
        asks: ORDER_LADDER_ASKS.map((r) => ({ price: r.priceMicroUsdc.toString(), size: r.sizeAtomic.toString() })),
      },
      perTicker,
      _priceScale: PRICE_SCALE.toString(),
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.seed-demo-liquidity.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
