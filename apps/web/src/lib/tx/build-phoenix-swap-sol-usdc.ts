import {
  Side,
  type MarketState,
} from "@ellipsis-labs/phoenix-sdk";
import {
  type Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { buildPhoenixSwapIx } from "./phoenix";

/** Phoenix v1 devnet SOL/USDC FIFO market (DK1gsSV quote mint = Phoenix's test USDC). */
export const PHOENIX_SOL_USDC_DEVNET = new PublicKey(
  "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N",
);

export type SwapDirection = "SolToUsdc" | "UsdcToSol";

export interface BuildPhoenixSwapSolUsdcParams {
  connection: Connection;
  trader: PublicKey;
  /** Loader for the Phoenix SOL/USDC MarketState (injected so callers control caching). */
  loadMarket: (
    connection: Connection,
    marketKey: PublicKey,
  ) => Promise<MarketState>;
  /** Direction the user wants to swap. */
  direction: SwapDirection;
  /**
   * Trade size. Units interpretation:
   *   - SolToUsdc → base lots of SOL to sell (use MarketState lot math to convert).
   *   - UsdcToSol → quote lots of USDC to spend.
   */
  numLots: number;
  /** Optional slippage cap. */
  minOutLots?: number;
  /** Optional override for the SOL/USDC market pubkey (useful for tests). */
  marketAddress?: PublicKey;
}

export interface BuildPhoenixSwapSolUsdcResult {
  tx: Transaction;
  ix: TransactionInstruction;
  marketAddress: PublicKey;
}

/**
 * Build a single Phoenix IOC swap against the devnet SOL/USDC market — the
 * fallback path for `buildSmartSolToUsdcSwap` when Jupiter has no route.
 *
 *   - SolToUsdc: place IOC sell on the SOL/USDC bids (Side.Ask: trader sells base = SOL).
 *   - UsdcToSol: place IOC buy on the SOL/USDC asks (Side.Bid: trader buys base = SOL).
 *
 * Note (DR-005 mint-mismatch flag, see Cleo Day-3 handoff): devnet Phoenix's
 * SOL/USDC market uses `DK1gsSV…` as its quote mint — that's PHOENIX'S test
 * USDC, NOT Circle's real devnet USDC (`4zMMC9srt…`). Result is that the
 * "USDC" the trader receives is the Phoenix-flavored variant, which is NOT
 * the same mint BellMarkets' `MarketConfig.usdc_mint` is bound to. So this
 * builder is useful only as a liquidity-route fallback for SOL → Phoenix-USDC,
 * with a downstream conversion step (CPMM swap to Circle's USDC, or
 * Jupiter-mediated route, or accepting that the demo just uses Phoenix's
 * test USDC end-to-end). Document this limitation in the demo notes.
 */
export async function buildPhoenixSwapSolUsdcTx(
  params: BuildPhoenixSwapSolUsdcParams,
): Promise<BuildPhoenixSwapSolUsdcResult> {
  const {
    connection,
    trader,
    loadMarket,
    direction,
    numLots,
    minOutLots,
    marketAddress = PHOENIX_SOL_USDC_DEVNET,
  } = params;

  const market = await loadMarket(connection, marketAddress);

  const side: Side =
    direction === "SolToUsdc" ? Side.Ask : Side.Bid;
  const numBaseLots = direction === "SolToUsdc" ? numLots : 0;
  const numQuoteLots = direction === "UsdcToSol" ? numLots : 0;
  const minBaseLotsToFill =
    direction === "UsdcToSol" ? minOutLots : undefined;
  const minQuoteLotsToFill =
    direction === "SolToUsdc" ? minOutLots : undefined;

  const ix = buildPhoenixSwapIx({
    market,
    trader,
    side,
    numBaseLots,
    numQuoteLots,
    minBaseLotsToFill,
    minQuoteLotsToFill,
  });

  const tx = new Transaction().add(ix);
  return { tx, ix, marketAddress };
}
