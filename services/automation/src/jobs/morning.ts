// Morning job (~8:00 AM ET): for each MAG7 stock, read previous close
// from Pyth Hermes, compute strikes (strike-calc), and call
// `create_strike_market` per unique strike against Aria's deployed
// devnet program.
//
// Day-2 status (2026-05-21): wired against Aria's deployed program
// `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV`. Per-strike calls go
// through `BellMarketsAnchorClient.getProgram().methods.createStrikeMarket()`.
// The IDL itself is still the placeholder `{}` until Aria copies
// `target/idl/bell_markets.json` into `services/automation/src/idl/` —
// the client fail-fasts with a descriptive AnchorClientError until then,
// so a partial deploy can never silently no-op.
//
// Cron: `0 13 * * 1-5` = 8:00 AM ET on US weekdays during EDT (UTC-4).
// DST: the EST half of the year (early Nov on) needs `0 14 * * 1-5`.
// Tracked as a Day-1 known issue.
//
// DR-002 reminder: this job has NO special signing authority. The
// platform-admin keypair we sign with is required by Aria's
// `constraint = config.admin == admin.key()`; any wallet whose pubkey
// matches MarketConfig.admin can sign the same call. We are a
// convenience caller, not an authority.

import { schedules } from "@trigger.dev/sdk/v3";

import { MAG7, type Ticker } from "../types.js";
import { computeStrikesForStock } from "../strike-calc.js";
import {
  loadConfig,
  PYTH_HERMES_FEED_IDS,
  computeExpiryUnixFor4pmETSameDay,
  type AutomationConfig,
} from "../config.js";
import { PythClient, type PreviousCloseResponse } from "../clients/pyth.js";
import { BellMarketsAnchorClient } from "../clients/anchor.js";

export const morningCreateMarketsJob = schedules.task({
  id: "morning-create-markets",
  cron: "0 13 * * 1-5",
  maxDuration: 300,
  run: async (payload, { ctx }) =>
    runMorningCreateMarkets({
      runAt: payload.timestamp,
      ctxRunId: ctx.run.id,
    }),
});

// ── Vitest-friendly orchestration ───────────────────────────────────────────
// The Trigger.dev `schedules.task` wrapper above is a thin shell over this
// pure(-ish) function. Tests inject the factories so we never load web3.js,
// hit live Pyth, or send a real transaction.

export type MorningJobDeps = {
  runAt: Date;
  ctxRunId?: string;
  config?: AutomationConfig;
  pythClientFactory?: (cfg: AutomationConfig) => PythClient;
  anchorClientFactory?: (cfg: AutomationConfig) => BellMarketsAnchorClient;
  /** Override the per-strike tx-send. Default uses Anchor `program.methods.createStrikeMarket(...).rpc()`. */
  sendCreateStrikeMarketTx?: SendCreateStrikeMarketTxFn;
  /** Sink for the structured log. Defaults to `console.info(JSON.stringify(...))`. */
  log?: (entry: Record<string, unknown>) => void;
};

export type SendCreateStrikeMarketInput = {
  ticker: Ticker;
  strikePriceI64: bigint;
  strikeUsd: number;
  expiryUnix: number;
  pythPriceAccount: string;
  phoenixMarket: string;
  anchorClient: BellMarketsAnchorClient;
  config: AutomationConfig;
};

export type SendCreateStrikeMarketResult =
  | { ok: true; txSig: string }
  | { ok: false; error: string };

export type SendCreateStrikeMarketTxFn = (input: SendCreateStrikeMarketInput) => Promise<SendCreateStrikeMarketResult>;

export type TickerOutcome = {
  ticker: Ticker;
  status: "submitted" | "skipped" | "errored";
  reason?: string;
  previousClose?: number;
  expo?: number;
  strikes?: number[];
  txSigs?: string[];
  errors?: string[];
};

export type MorningJobOutcome = {
  ok: true;
  runAt: string;
  perTicker: TickerOutcome[];
  stub?: boolean;
};

export async function runMorningCreateMarkets(deps: MorningJobDeps): Promise<MorningJobOutcome> {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const runAtIso = deps.runAt.toISOString();
  const logBase = { jobId: "morning-create-markets", runAt: runAtIso, ctxRunId: deps.ctxRunId };
  const expiryUnix = computeExpiryUnixFor4pmETSameDay(deps.runAt);

  // ── Stub branch — preserves Day-1 dev ergonomics ────────────────────────
  if (!config.bellMarketsProgramId) {
    log({ ...logBase, stub: true, reason: "BELL_MARKETS_PROGRAM_ID unset — log-only stub" });
    return {
      ok: true,
      runAt: runAtIso,
      stub: true,
      perTicker: MAG7.map((ticker) => ({ ticker, status: "skipped", reason: "BELL_MARKETS_PROGRAM_ID unset" })),
    };
  }

  // ── Live branch ─────────────────────────────────────────────────────────
  // Build clients lazily, surface configuration errors with a single
  // descriptive log line — never a deep web3.js stack.
  let pythClient: PythClient;
  let anchorClient: BellMarketsAnchorClient;
  try {
    pythClient = deps.pythClientFactory?.(config) ?? defaultPythClientFactory(config);
    anchorClient = deps.anchorClientFactory?.(config) ?? defaultAnchorClientFactory(config);
  } catch (err) {
    log({ ...logBase, level: "error", stage: "client-init", error: serializeError(err) });
    throw err;
  }

  // Preflight: construct the Program once so a missing IDL fails before any
  // per-ticker Pyth call.
  try {
    await anchorClient.getProgram();
  } catch (err) {
    log({ ...logBase, level: "error", stage: "anchor-program-init", error: serializeError(err) });
    throw err;
  }

  const sendTx: SendCreateStrikeMarketTxFn = deps.sendCreateStrikeMarketTx ?? defaultSendCreateStrikeMarketTx;
  const perTicker: TickerOutcome[] = [];

  for (const ticker of MAG7) {
    const phoenixMarket = config.phoenixMarkets[ticker];
    const pythPriceAccount = config.pythPriceAccounts[ticker];
    const hermesFeedId = PYTH_HERMES_FEED_IDS[ticker];

    if (!phoenixMarket) {
      perTicker.push({ ticker, status: "skipped", reason: "no Phoenix market configured" });
      log({ ...logBase, ticker, status: "skipped", reason: `PHOENIX_MARKET_${ticker} unset` });
      continue;
    }
    if (!pythPriceAccount) {
      perTicker.push({ ticker, status: "skipped", reason: "no Pyth on-chain price account configured" });
      log({ ...logBase, ticker, status: "skipped", reason: `PYTH_PRICE_ACCOUNT_${ticker} unset` });
      continue;
    }
    if (!hermesFeedId) {
      // Should be unreachable — table is dense for all MAG7 — but the
      // `noUncheckedIndexedAccess` strict-mode narrowing forces the check.
      perTicker.push({ ticker, status: "errored", errors: ["missing Hermes feed id"] });
      continue;
    }

    let prevClose: PreviousCloseResponse;
    try {
      prevClose = await pythClient.getPreviousClose({ ticker, feedId: hermesFeedId });
    } catch (err) {
      const error = serializeError(err);
      perTicker.push({ ticker, status: "errored", errors: [error] });
      log({ ...logBase, ticker, status: "errored", stage: "pyth-prev-close", error });
      continue;
    }

    const strikes = computeStrikesForStock(prevClose.price);
    const txSigs: string[] = [];
    const errors: string[] = [];

    for (const strikeUsd of strikes) {
      const strikePriceI64 = scaleStrikeToI64(strikeUsd, prevClose.expo);
      const result = await sendTx({
        ticker,
        strikePriceI64,
        strikeUsd,
        expiryUnix,
        pythPriceAccount,
        phoenixMarket,
        anchorClient,
        config,
      });
      if (result.ok) {
        txSigs.push(result.txSig);
        log({ ...logBase, ticker, strikeUsd, txSig: result.txSig });
      } else {
        errors.push(`${strikeUsd}: ${result.error}`);
        log({ ...logBase, level: "warn", ticker, strikeUsd, error: result.error });
      }
    }

    perTicker.push({
      ticker,
      status: errors.length === 0 ? "submitted" : "errored",
      previousClose: prevClose.price,
      expo: prevClose.expo,
      strikes,
      txSigs,
      ...(errors.length > 0 ? { errors } : {}),
    });
  }

  return { ok: true, runAt: runAtIso, perTicker };
}

/**
 * Scale a human-readable USD strike into the i64 representation Aria's
 * settle handler compares against. The on-chain settle path reads Pyth's
 * `i64 price` + `i32 expo` (typically -8 for US equities) and compares
 * `price >= strike_market.strike_price`. The strike must therefore use
 * the same expo scale.
 *
 *   $230, expo=-8 → 23_000_000_000
 *   $680, expo=-8 → 68_000_000_000
 */
export function scaleStrikeToI64(strikeUsd: number, expo: number): bigint {
  if (!Number.isFinite(strikeUsd) || strikeUsd <= 0) {
    throw new Error(`scaleStrikeToI64: invalid strikeUsd=${strikeUsd}`);
  }
  if (!Number.isInteger(expo)) {
    throw new Error(`scaleStrikeToI64: expo must be integer (got ${expo})`);
  }
  const factor = Math.pow(10, -expo);
  const scaled = Math.round(strikeUsd * factor);
  if (!Number.isFinite(scaled)) {
    throw new Error(`scaleStrikeToI64: non-finite for strike=${strikeUsd}, expo=${expo}`);
  }
  return BigInt(scaled);
}

function defaultPythClientFactory(config: AutomationConfig): PythClient {
  if (!config.pythHttpBaseUrl) {
    throw new Error("PYTH_HTTP_BASE_URL is required when BELL_MARKETS_PROGRAM_ID is set");
  }
  return new PythClient({ baseUrl: config.pythHttpBaseUrl });
}

function defaultAnchorClientFactory(config: AutomationConfig): BellMarketsAnchorClient {
  if (!config.heliusRpcUrl) throw new Error("HELIUS_DEVNET_RPC_URL is required when BELL_MARKETS_PROGRAM_ID is set");
  if (!config.platformAdminKeypairPath) {
    throw new Error("PLATFORM_ADMIN_KEYPAIR_PATH is required when BELL_MARKETS_PROGRAM_ID is set");
  }
  if (!config.bellMarketsIdlPath) throw new Error("BELL_MARKETS_IDL_PATH is required");
  if (!config.bellMarketsProgramId) throw new Error("BELL_MARKETS_PROGRAM_ID is required");
  return new BellMarketsAnchorClient({
    rpcUrl: config.heliusRpcUrl,
    programId: config.bellMarketsProgramId,
    keypairPath: config.platformAdminKeypairPath,
    idlPath: config.bellMarketsIdlPath,
  });
}

/**
 * Real-runtime send path. Deferred imports keep this code path off
 * `@solana/web3.js` and `@coral-xyz/anchor` until the live job actually
 * runs — which lets unit tests construct the morning job graph without
 * triggering the workspace rpc-websockets/uuid CJS-ESM cascade.
 */
async function defaultSendCreateStrikeMarketTx(input: SendCreateStrikeMarketInput): Promise<SendCreateStrikeMarketResult> {
  try {
    if (!input.config.usdcDevnetMint) {
      return { ok: false, error: "USDC_DEVNET_MINT unset" };
    }
    const program = await input.anchorClient.getProgram();
    const anchor = await import("@coral-xyz/anchor");
    const web3 = await import("@solana/web3.js");

    const programIdPk = new web3.PublicKey(input.anchorClient.opts.programId);
    const underlyingPythFeedPk = new web3.PublicKey(input.pythPriceAccount);
    const usdcMintPk = new web3.PublicKey(input.config.usdcDevnetMint);
    const phoenixMarketPk = new web3.PublicKey(input.phoenixMarket);

    // PDAs per programs/bell-markets/src/instructions/create_strike_market.rs seeds:
    //   strike: [b"strike", underlying_pyth_feed, expiry_unix.to_le_bytes(), strike_price.to_le_bytes()]
    //   yes:    [b"yes", strike_market]
    //   no:     [b"no", strike_market]
    //   vault:  [b"vault", strike_market]
    //   config: [b"config"]
    const expiryLe = i64LeBytes(BigInt(input.expiryUnix));
    const strikeLe = i64LeBytes(input.strikePriceI64);

    const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);
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

    // Anchor's runtime `.methods` / `.accounts` are strongly typed via the
    // IDL generic, but the IDL we load is `Idl` (any), so the chain is
    // type-loose at the call site. The Accounts shape is verified against
    // Aria's Rust at programs/bell-markets/src/instructions/create_strike_market.rs.
    const provider = program.provider as unknown as {
      wallet: { publicKey: import("@solana/web3.js").PublicKey };
    };
    const adminPk = provider.wallet.publicKey;
    const TOKEN_PROGRAM_ID = new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const methods = program.methods as any;
    const txSig: string = await methods
      .createStrikeMarket(new anchor.BN(input.strikePriceI64.toString()), new anchor.BN(input.expiryUnix))
      .accounts({
        admin: adminPk,
        config: configPda,
        strikeMarket: strikeMarketPda,
        underlyingPythFeed: underlyingPythFeedPk,
        yesMint: yesMintPda,
        noMint: noMintPda,
        usdcVault: usdcVaultPda,
        usdcMint: usdcMintPk,
        phoenixMarket: phoenixMarketPk,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return { ok: true, txSig };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

/** Convert a signed bigint into an 8-byte little-endian buffer (i64). */
function i64LeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return buf;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
