// DR-020 / Day-7 — seed demo liquidity on multiple tickers × multiple strikes.
//
// Per ticker, seeds **3 strikes** by default (ATM, ATM+3%, ATM-3%) — bracketing
// the live Pyth spot so the demo shows both in-the-money and out-of-the-money
// markets per ticker. Per strike, does the full 10-step pipeline:
//
//   1. create_strike_market (admin)            — fresh PDA
//   2. init_order_book (admin)                 — phase 1: 10KB OrderBook PDA + escrows
//   3. grow_order_book (admin)                 — phase 2: realloc to LEN + open trading gate
//   4. mint_pair(200 bUSDC) (admin)            — 200 YES + 200 NO into admin's ATAs
//   5. place_order × 6 — non-crossing 3-rung ladder:
//        bids: $0.40, $0.45, $0.50 × 50 YES each
//        asks: $0.55, $0.60, $0.65 × 50 YES each
//      ($0.05 inside spread; non-crossing so the book stays populated for the
//      demo.)
//
// Each step is its own tx. Failure of one strike doesn't roll back others.
// Idempotency: every step checks on-chain state first and skips if already
// done — safe to re-run after partial failures.
//
// Output: all (ticker, strike, strikeMarketPda, orderBookPda, escrows) tuples
// in the final stdout JSON for piping into coordination/demo-strikes.md.
//
// Usage:
//   pnpm --filter @bell-markets/automation seed-demo-liquidity
//   pnpm --filter @bell-markets/automation seed-demo-liquidity --tickers META,NVDA,AAPL,MSFT,GOOGL,AMZN,TSLA
//   pnpm --filter @bell-markets/automation seed-demo-liquidity --expiry-days 5
//   pnpm --filter @bell-markets/automation seed-demo-liquidity --skip-place-orders
//   pnpm --filter @bell-markets/automation seed-demo-liquidity --strike-offsets 0,3,-3,6,-6
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
const PRICE_SCALE = 1_000_000n;
const SIDE_BID = 0;
const SIDE_ASK = 1;
const ORDER_BOOK_SEED = Buffer.from("order_book");
const USDC_ESCROW_SEED = Buffer.from("usdc_escrow");
const YES_ESCROW_SEED = Buffer.from("yes_escrow");
const TOKEN_PROGRAM_ID_BASE58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Default fallbacks if env per-ticker pubkeys aren't set. Re-uses known-good
// devnet placeholders.
const FALLBACK_PYTH_DEVNET = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"; // SOL/USD
const FALLBACK_PHOENIX_DEVNET = "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N"; // SOL/USDC magic-verified
const FALLBACK_FEE_COLLECTOR = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs"; // MarketConfig.treasury

const ORDER_LADDER_BIDS = [
  { priceMicroUsdc: 400_000n, sizeAtomic: 50_000_000n },
  { priceMicroUsdc: 450_000n, sizeAtomic: 50_000_000n },
  { priceMicroUsdc: 500_000n, sizeAtomic: 50_000_000n },
];
const ORDER_LADDER_ASKS = [
  { priceMicroUsdc: 550_000n, sizeAtomic: 50_000_000n },
  { priceMicroUsdc: 600_000n, sizeAtomic: 50_000_000n },
  { priceMicroUsdc: 650_000n, sizeAtomic: 50_000_000n },
];

const MINT_PAIR_AMOUNT_BUSDC = 200n;

/** Default strike offsets as integer percentage points (0 = ATM, +3 = ATM*1.03, -3 = ATM*0.97). */
const DEFAULT_STRIKE_OFFSETS_PCT = [0, 3, -3];

type CliArgs = {
  tickers: Ticker[];
  skipPlaceOrders: boolean;
  expiryUnix: number;
  strikeOffsetsPct: number[];
};

function parseArgs(): CliArgs {
  let tickers: Ticker[] = ["META"];
  let skipPlaceOrders = false;
  let expiryDays = 5; // default per Day-7 dispatch (was 36h)
  let strikeOffsetsPct = DEFAULT_STRIKE_OFFSETS_PCT;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--tickers" && i + 1 < process.argv.length) {
      const list = process.argv[i + 1]!.split(",").map((t) => t.trim().toUpperCase() as Ticker);
      tickers = list;
      i++;
    } else if (arg === "--skip-place-orders") {
      skipPlaceOrders = true;
    } else if (arg === "--expiry-days" && i + 1 < process.argv.length) {
      const n = Number(process.argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0 || n > 7) {
        throw new Error(`--expiry-days must be 1..7 (program enforces MAX_EXPIRY_HORIZON_SECS=7d); got "${process.argv[i + 1]}"`);
      }
      expiryDays = n;
      i++;
    } else if (arg === "--strike-offsets" && i + 1 < process.argv.length) {
      strikeOffsetsPct = process.argv[i + 1]!.split(",").map((s) => Number(s.trim()));
      if (strikeOffsetsPct.some((n) => !Number.isFinite(n))) {
        throw new Error(`--strike-offsets must be a comma-separated list of integers (got "${process.argv[i + 1]}")`);
      }
      i++;
    }
  }

  // Expiry: T + expiryDays, rounded to 4pm ET. EDT = 20:00 UTC.
  const now = new Date();
  const target = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
  const expiryUnix = Math.floor(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
      20,
      0,
      0,
    ) / 1000,
  );
  return { tickers, skipPlaceOrders, expiryUnix, strikeOffsetsPct };
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} is unset`);
  return v;
}

/** Compute the integer-dollar strike for an ATM ± pct% offset, rounded to nearest $1. */
function strikeForOffset(spotUsd: number, offsetPct: number): number {
  return Math.round(spotUsd * (1 + offsetPct / 100));
}

// ────────────────────────────────────────────────────────────────────────────
// Per-strike orchestration — factored out so the outer loop can iterate
// (ticker, offsetPct) pairs cleanly.
// ────────────────────────────────────────────────────────────────────────────

type StrikeSeedDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: any;
  connection: import("@solana/web3.js").Connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  web3: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anchor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spl: any;
  programIdPk: import("@solana/web3.js").PublicKey;
  busdcMintPk: import("@solana/web3.js").PublicKey;
  tokenProgramPk: import("@solana/web3.js").PublicKey;
  treasuryPk: import("@solana/web3.js").PublicKey;
  configPda: import("@solana/web3.js").PublicKey;
  feeConfigPda: import("@solana/web3.js").PublicKey;
  weeklyPoolPda: import("@solana/web3.js").PublicKey;
  monthlyPoolPda: import("@solana/web3.js").PublicKey;
  userConfigPda: import("@solana/web3.js").PublicKey;
  adminPk: import("@solana/web3.js").PublicKey;
  adminKeypair: import("@solana/web3.js").Keypair;
  expiryUnix: number;
  skipPlaceOrders: boolean;
};

type StrikeContext = {
  ticker: Ticker;
  offsetPct: number;
  strikeUsd: number;
  expo: number;
  underlyingPythFeed: string;
  phoenixMarket: string;
};

async function seedOneStrike(
  ctx: StrikeContext,
  deps: StrikeSeedDeps,
): Promise<Record<string, unknown>> {
  const {
    program: _program,
    methods,
    connection,
    web3,
    anchor,
    spl,
    programIdPk,
    busdcMintPk,
    tokenProgramPk,
    treasuryPk,
    configPda,
    feeConfigPda,
    weeklyPoolPda,
    monthlyPoolPda,
    userConfigPda,
    adminPk,
    adminKeypair,
    expiryUnix,
    skipPlaceOrders,
  } = deps;
  void _program; // reserved for future use

  const strikeLog: Record<string, unknown> = {
    ticker: ctx.ticker,
    offsetPct: ctx.offsetPct,
    strikeUsd: ctx.strikeUsd,
  };

  const strikePriceI64 = scaleStrikeToI64(ctx.strikeUsd, ctx.expo);
  strikeLog.strikePriceI64 = strikePriceI64.toString();

  const underlyingPythFeedPk = new web3.PublicKey(ctx.underlyingPythFeed);
  const phoenixMarketPk = new web3.PublicKey(ctx.phoenixMarket);

  // PDAs
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
  strikeLog.strikeMarket = strikeMarketPda.toBase58();
  strikeLog.yesMint = yesMintPda.toBase58();
  strikeLog.noMint = noMintPda.toBase58();
  strikeLog.usdcVault = usdcVaultPda.toBase58();
  strikeLog.orderBook = orderBookPda.toBase58();
  strikeLog.usdcEscrow = usdcEscrowPda.toBase58();
  strikeLog.yesEscrow = yesEscrowPda.toBase58();

  // 4. create_strike_market (idempotent)
  const existingStrike = await connection.getAccountInfo(strikeMarketPda);
  if (existingStrike) {
    strikeLog.createStrikeMarket = "already-exists";
  } else {
    const sig: string = await methods
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
    strikeLog.createStrikeMarket = sig;
  }

  // 5. init_order_book (idempotent)
  const existingOrderBook = await connection.getAccountInfo(orderBookPda);
  if (existingOrderBook && !existingOrderBook.data.every((b: number) => b === 0)) {
    strikeLog.initOrderBook = "already-exists";
  } else {
    const sig: string = await methods
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
    strikeLog.initOrderBook = sig;
  }

  // 6. grow_order_book (idempotent in handler)
  const growSig: string = await methods
    .growOrderBook()
    .accounts({
      user: adminPk,
      config: configPda,
      strikeMarket: strikeMarketPda,
      orderBook: orderBookPda,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
  strikeLog.growOrderBook = growSig;

  if (skipPlaceOrders) {
    strikeLog.placeOrders = "skipped";
    return strikeLog;
  }

  // 7. Ensure admin ATAs
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
  strikeLog.adminBusdcAta = adminBusdcAta.address.toBase58();
  strikeLog.adminYesAta = adminYesAta.address.toBase58();
  strikeLog.adminNoAta = adminNoAta.address.toBase58();
  strikeLog.feeCollectorUsdc = treasuryAta.address.toBase58();

  // 8. Top up admin bUSDC if short
  const need = 300_000_000n;
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
    strikeLog.bUsdcTopUp = topUp.toString();
  }

  // 9. mint_pair
  try {
    const mintAmountAtomic = MINT_PAIR_AMOUNT_BUSDC * 1_000_000n;
    const mintSig: string = await methods
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
    strikeLog.mintPair = mintSig;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    strikeLog.mintPair = `errored: ${reason.substring(0, 200)}`;
    strikeLog.mintPairFallback = "bids-only";
  }

  // 10. Place orders
  const placedOrders: Array<{ side: string; price: string; size: string; txSig: string }> = [];
  const orderErrors: string[] = [];

  const placeOrderTx = async (side: number, priceMicroUsdc: bigint, sizeAtomic: bigint) => {
    const sig: string = await methods
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
  if (strikeLog.mintPair && !String(strikeLog.mintPair).startsWith("errored")) {
    for (const rung of ORDER_LADDER_ASKS) {
      try {
        const sig = await placeOrderTx(SIDE_ASK, rung.priceMicroUsdc, rung.sizeAtomic);
        placedOrders.push({ side: "ask", price: rung.priceMicroUsdc.toString(), size: rung.sizeAtomic.toString(), txSig: sig });
      } catch (err) {
        orderErrors.push(`ask ${rung.priceMicroUsdc}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  strikeLog.placedOrders = placedOrders;
  if (orderErrors.length) strikeLog.orderErrors = orderErrors;

  return strikeLog;
}

// ────────────────────────────────────────────────────────────────────────────
// Outer driver — ticker × strike-offset loop
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const { tickers, skipPlaceOrders, expiryUnix, strikeOffsetsPct } = parseArgs();
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
      strikeOffsetsPct,
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
    connection: import("@solana/web3.js").Connection;
  };
  const adminPk = provider.wallet.publicKey;
  const adminKeypair = (provider.wallet as unknown as { payer?: import("@solana/web3.js").Keypair }).payer;
  if (!adminKeypair) throw new Error("provider wallet missing payer keypair for SPL ops");
  const connection = provider.connection;

  // Shared PDAs
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);
  const [feeConfigPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("fee_config")], programIdPk);
  const [weeklyPoolPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("weekly_pool")], programIdPk);
  const [monthlyPoolPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("monthly_pool")], programIdPk);
  const [userConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user"), configPda.toBuffer(), adminPk.toBuffer()],
    programIdPk,
  );

  const treasuryPk = new web3.PublicKey(FALLBACK_FEE_COLLECTOR);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;

  const deps: StrikeSeedDeps = {
    program,
    methods,
    connection,
    web3,
    anchor,
    spl,
    programIdPk,
    busdcMintPk,
    tokenProgramPk,
    treasuryPk,
    configPda,
    feeConfigPda,
    weeklyPoolPda,
    monthlyPoolPda,
    userConfigPda,
    adminPk,
    adminKeypair,
    expiryUnix,
    skipPlaceOrders,
  };

  const allStrikes: Array<Record<string, unknown>> = [];

  for (const ticker of tickers) {
    let spotUsd: number;
    let expo: number;
    let underlyingPythFeed: string;
    let phoenixMarket: string;
    try {
      const feedId = PYTH_HERMES_FEED_IDS[ticker];
      if (!feedId) throw new Error(`no Pyth Hermes feed id for ${ticker}`);
      const prev = await pyth.getPreviousClose({ ticker, feedId });
      spotUsd = prev.price;
      expo = prev.expo;
      underlyingPythFeed = process.env[`PYTH_PRICE_ACCOUNT_${ticker}`] || FALLBACK_PYTH_DEVNET;
      phoenixMarket = process.env[`PHOENIX_MARKET_${ticker}`] || FALLBACK_PHOENIX_DEVNET;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "operator.seed-demo-liquidity.ticker-pyth-error",
          ticker,
          error: reason,
        }),
      );
      allStrikes.push({ ticker, error: `pyth: ${reason}` });
      continue;
    }

    console.error(
      JSON.stringify({
        event: "operator.seed-demo-liquidity.ticker-start",
        ticker,
        spotUsd,
        expo,
        underlyingPythFeed,
        phoenixMarket,
        strikeOffsetsPct,
      }),
    );

    // Compute + dedup integer-dollar strikes across the chosen offsets.
    const seenStrikes = new Set<number>();
    for (const offsetPct of strikeOffsetsPct) {
      const strikeUsd = strikeForOffset(spotUsd, offsetPct);
      if (seenStrikes.has(strikeUsd)) {
        console.error(
          JSON.stringify({
            event: "operator.seed-demo-liquidity.strike-deduped",
            ticker,
            offsetPct,
            strikeUsd,
            reason: "rounds to same integer dollar as a prior offset; skipping duplicate",
          }),
        );
        continue;
      }
      seenStrikes.add(strikeUsd);

      try {
        const strikeOut = await seedOneStrike(
          { ticker, offsetPct, strikeUsd, expo, underlyingPythFeed, phoenixMarket },
          deps,
        );
        // Annotate with spot for downstream context
        strikeOut.spotUsd = spotUsd;
        allStrikes.push(strikeOut);
        console.error(
          JSON.stringify({
            event: "operator.seed-demo-liquidity.strike-done",
            ticker,
            offsetPct,
            strikeUsd,
            strikeMarket: strikeOut.strikeMarket,
            orderBook: strikeOut.orderBook,
          }),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failed = { ticker, offsetPct, strikeUsd, spotUsd, error: reason };
        allStrikes.push(failed);
        console.error(
          JSON.stringify({
            event: "operator.seed-demo-liquidity.strike-fatal",
            ...failed,
          }),
        );
      }
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      expiryUnix,
      expiryIso: new Date(expiryUnix * 1000).toISOString(),
      strikeOffsetsPct,
      ladder: {
        bids: ORDER_LADDER_BIDS.map((r) => ({ price: r.priceMicroUsdc.toString(), size: r.sizeAtomic.toString() })),
        asks: ORDER_LADDER_ASKS.map((r) => ({ price: r.priceMicroUsdc.toString(), size: r.sizeAtomic.toString() })),
      },
      strikes: allStrikes,
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
