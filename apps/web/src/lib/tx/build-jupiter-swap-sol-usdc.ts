import {
  PublicKey,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";

/**
 * Circle's devnet USDC mint.
 *
 * NOTE (DR-020, 2026-05-24): this file is DORMANT. BellMarkets no longer
 * binds to Circle USDC — `MarketConfig.usdc_mint` now points at a
 * self-controlled bUSDC mint (Bram's `mint-demo-usdc` CLI). Callers that
 * need a USDC mint pubkey MUST read `useMarketConfig().usdcMint` instead of
 * importing this constant. Kept here only as a record of the pre-pivot
 * deploy-6 baseline; will be removed when the Jupiter onramp ships against
 * the new mint (v2 candidate).
 */
export const USDC_DEVNET_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

/** Wrapped SOL mint. */
export const WRAPPED_SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface BuildJupiterSwapSolUsdcParams {
  /** Wallet that will sign + pay. */
  userPublicKey: PublicKey;
  /** Lamports of SOL to swap → USDC. */
  amountLamports: bigint;
  /** Slippage tolerance in bps. Default 50 (0.5%). */
  slippageBps?: number;
  /** Injectable fetch — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override quote/swap URLs (tests). */
  quoteUrl?: string;
  swapUrl?: string;
}

export interface BuildJupiterSwapSolUsdcResult {
  /** Versioned tx returned by Jupiter — ready for the wallet to sign + send. */
  tx: VersionedTransaction;
  quote: JupiterQuoteResponse;
  /** Convenience projection of `outAmount` from `quote`. */
  expectedUsdcMicros: bigint;
  /** Effective slippage bps actually requested. */
  slippageBps: number;
}

/**
 * Build a SOL → Circle-USDC swap via Jupiter v6.
 *
 * Two-step flow:
 *   1. GET `/quote` for `WRAPPED_SOL_MINT → USDC_DEVNET_MINT` with `amountLamports`.
 *   2. POST `/swap` with the quote + user pubkey; Jupiter returns a serialized
 *      versioned transaction that already wraps SOL, swaps, and unwraps any
 *      remainder, signed only as far as Jupiter's intermediate accounts. The
 *      caller signs as `userPublicKey` and broadcasts via `sendTransaction`.
 *
 * Devnet caveat: Jupiter v6 may return no viable route on devnet (the
 * aggregated DEX universe is sparse there). Callers should treat a thrown
 * `JupiterNoRouteError` as a signal to fall back to the Phoenix path —
 * `buildSmartSolToUsdcSwap` does exactly this.
 */
export async function buildJupiterSwapSolUsdcTx(
  params: BuildJupiterSwapSolUsdcParams,
): Promise<BuildJupiterSwapSolUsdcResult> {
  const {
    userPublicKey,
    amountLamports,
    slippageBps = 50,
    fetchImpl = fetch,
    quoteUrl = JUPITER_QUOTE_URL,
    swapUrl = JUPITER_SWAP_URL,
  } = params;

  const quoteParams = new URLSearchParams({
    inputMint: WRAPPED_SOL_MINT.toBase58(),
    outputMint: USDC_DEVNET_MINT.toBase58(),
    amount: amountLamports.toString(),
    slippageBps: slippageBps.toString(),
    swapMode: "ExactIn",
  });

  const quoteResp = await fetchImpl(`${quoteUrl}?${quoteParams.toString()}`);
  if (!quoteResp.ok) {
    throw new JupiterApiError(
      `Jupiter quote failed: ${quoteResp.status} ${quoteResp.statusText}`,
      quoteResp.status,
    );
  }
  const quote = (await quoteResp.json()) as JupiterQuoteResponse | { error?: string };
  if ("error" in quote && quote.error) {
    throw new JupiterNoRouteError(`Jupiter: ${quote.error}`);
  }
  if (!("outAmount" in quote) || !quote.outAmount) {
    throw new JupiterNoRouteError("Jupiter quote returned no route.");
  }

  const swapResp = await fetchImpl(swapUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapResp.ok) {
    throw new JupiterApiError(
      `Jupiter swap failed: ${swapResp.status} ${swapResp.statusText}`,
      swapResp.status,
    );
  }
  const swap = (await swapResp.json()) as JupiterSwapResponse;

  const txBytes = Buffer.from(swap.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBytes);

  return {
    tx,
    quote: quote as JupiterQuoteResponse,
    expectedUsdcMicros: BigInt(quote.outAmount),
    slippageBps,
  };
}

export class JupiterApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "JupiterApiError";
  }
}

export class JupiterNoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterNoRouteError";
  }
}

/** Type-narrowing convenience for callers that want to branch on no-route. */
export function isJupiterNoRoute(err: unknown): err is JupiterNoRouteError {
  return err instanceof JupiterNoRouteError;
}

/**
 * Heuristic for the smart-router fallback decision: any 4xx / no-route or
 * "no route" payload should fall through to Phoenix. Network errors should
 * surface so the caller can decide whether to retry.
 */
export function shouldFallBackToPhoenix(err: unknown): boolean {
  if (err instanceof JupiterNoRouteError) return true;
  if (err instanceof JupiterApiError) {
    return err.status >= 400 && err.status < 500;
  }
  return false;
}

// Keep a reference to the connection signature for callers that want to
// share imports. Connection-less callers can ignore.
export type { Connection };
