import { LAMPORTS_PER_SOL, type VersionedTransaction, Transaction, type PublicKey } from "@solana/web3.js";
import type { MarketState } from "@ellipsis-labs/phoenix-sdk";
import type { Connection } from "@solana/web3.js";

import {
  buildJupiterSwapSolUsdcTx,
  shouldFallBackToPhoenix,
  type JupiterQuoteResponse,
} from "./build-jupiter-swap-sol-usdc";
import {
  PHOENIX_SOL_USDC_DEVNET,
  buildPhoenixSwapSolUsdcTx,
} from "./build-phoenix-swap-sol-usdc";

export type SmartSwapRoute = "jupiter" | "phoenix";

export interface SmartSolToUsdcParams {
  connection: Connection;
  trader: PublicKey;
  /** Lamports of SOL the user wants to swap to USDC. */
  amountLamports: bigint;
  /** Loader for Phoenix MarketState (only called on Phoenix fallback). */
  loadMarket: (
    connection: Connection,
    marketKey: PublicKey,
  ) => Promise<MarketState>;
  /** Slippage tolerance in bps for Jupiter quote (Phoenix path is best-effort IOC). */
  slippageBps?: number;
  /** Injectable fetch for Jupiter (tests). */
  fetchImpl?: typeof fetch;
}

export type SmartSolToUsdcResult =
  | {
      route: "jupiter";
      tx: VersionedTransaction;
      expectedUsdcMicros: bigint;
      slippageBps: number;
      quote: JupiterQuoteResponse;
    }
  | {
      route: "phoenix";
      tx: Transaction;
      /** Approximate — Phoenix doesn't quote ahead-of-time the way Jupiter does. */
      expectedUsdcMicros: null;
      slippageBps: number;
      reason: string;
    };

/**
 * The user-facing wrapper. Tries Jupiter first; if no route exists on devnet,
 * falls back to a direct Phoenix IOC against the SOL/USDC market.
 *
 * Decision tree:
 *   1. Jupiter `/quote` for WSOL → Circle-USDC.
 *   2. If quote succeeds → build Jupiter swap tx; return `route: "jupiter"`.
 *   3. If quote returns no-route / 4xx → fall back to Phoenix; return
 *      `route: "phoenix"` with reason string for UI logging.
 *   4. Network / 5xx errors are NOT auto-fallback — they surface to caller
 *      so a transient outage doesn't silently downgrade the route.
 *
 * The two return shapes differ (Versioned vs legacy Transaction), so callers
 * pattern-match on `route` before signing/sending. The `useSendTransaction`
 * hook already handles both shapes via the wallet adapter's `sendTransaction`
 * overloads.
 *
 * Caller-side UX hint: surface `route` + `expectedUsdcMicros` so the user
 * can see "Routed via Jupiter — ~$24.07 USDC expected" vs "Phoenix fallback
 * — Phoenix-USDC venue".
 */
export async function buildSmartSolToUsdcSwap(
  params: SmartSolToUsdcParams,
): Promise<SmartSolToUsdcResult> {
  const {
    connection,
    trader,
    amountLamports,
    loadMarket,
    slippageBps = 50,
    fetchImpl,
  } = params;

  try {
    const j = await buildJupiterSwapSolUsdcTx({
      userPublicKey: trader,
      amountLamports,
      slippageBps,
      fetchImpl,
    });
    return {
      route: "jupiter",
      tx: j.tx,
      expectedUsdcMicros: j.expectedUsdcMicros,
      slippageBps: j.slippageBps,
      quote: j.quote,
    };
  } catch (err) {
    if (!shouldFallBackToPhoenix(err)) throw err;

    const reason = err instanceof Error ? err.message : String(err);
    const numBaseLots = lamportsToPhoenixSolBaseLots(amountLamports);

    const phoenix = await buildPhoenixSwapSolUsdcTx({
      connection,
      trader,
      loadMarket,
      direction: "SolToUsdc",
      numLots: numBaseLots,
      marketAddress: PHOENIX_SOL_USDC_DEVNET,
    });
    return {
      route: "phoenix",
      tx: phoenix.tx,
      expectedUsdcMicros: null,
      slippageBps,
      reason,
    };
  }
}

/**
 * Phoenix SOL/USDC market uses 1e9 lamports per 1 SOL base unit and a market-
 * specific `base_lots_per_base_unit` we don't know without loading. Caller
 * passes `amountLamports`; for the Phoenix fallback path we project to
 * approximate base lots using the market's published lot math. This is a
 * placeholder — the real conversion needs the loaded `MarketState` so we
 * have `header.baseLotsPerBaseUnit`. For now, treat 1 lamport ≈ 1 base lot
 * (Phoenix devnet SOL/USDC has baseLotsPerBaseUnit = 1e9 → 1 lamport ≈ 1 lot)
 * which is approximately correct for the devnet market the demo points at.
 *
 * The proper version: pass an already-loaded `MarketState` into the wrapper
 * and convert via `Math.floor(lamports / Number(market.data.header.baseLotSize))`.
 * Day-5 task is structural; refine when wiring the live UI.
 */
/**
 * Sanity ceiling on the SOL → Phoenix-base-lots conversion. Without knowing
 * the live `baseLotsPerBaseUnit` on Phoenix's devnet SOL/USDC market we cap
 * the projected lot count at the equivalent of ~50 SOL (5e10 lamports). If
 * a caller requests more, refuse — better to error than to ship a giant
 * Phoenix order built from a wrong scaler. (See audit P2-C 2026-05-23.)
 */
const MAX_SAFE_PHOENIX_SOL_LOTS = 50_000_000_000;

function lamportsToPhoenixSolBaseLots(lamports: bigint): number {
  const asNum = Number(lamports);
  if (!Number.isFinite(asNum)) {
    throw new Error(
      "buildSmartSolToUsdcSwap: amountLamports too large for safe Number conversion.",
    );
  }
  if (asNum > MAX_SAFE_PHOENIX_SOL_LOTS) {
    throw new Error(
      `buildSmartSolToUsdcSwap: requested Phoenix swap of ${asNum} lamports exceeds safe lot cap (${MAX_SAFE_PHOENIX_SOL_LOTS}). Pass a loaded MarketState to use baseLotsPerBaseUnit for the real conversion.`,
    );
  }
  return asNum;
}

export { LAMPORTS_PER_SOL };
