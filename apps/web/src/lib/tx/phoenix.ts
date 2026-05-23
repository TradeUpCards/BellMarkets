import {
  PROGRAM_ID as PHOENIX_PROGRAM_ID,
  Side,
  type MarketState,
  type OrderPacket,
  createSwapInstruction,
  getImmediateOrCancelOrderPacket,
  getLogAuthority,
} from "@ellipsis-labs/phoenix-sdk";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

const PHOENIX_LOG_AUTHORITY: PublicKey = getLogAuthority();

export interface PhoenixSwapParams {
  market: MarketState;
  trader: PublicKey;
  /**
   * Side.Bid = trader buys base (Yes) with quote (USDC).
   * Side.Ask = trader sells base (Yes) for quote (USDC).
   */
  side: Side;
  /** Base lots to fill (required for Side.Ask). */
  numBaseLots: number;
  /** Quote lots to spend/receive (required for Side.Bid). */
  numQuoteLots: number;
  /** Optional limit; default omits limit (pure market order). */
  priceInTicks?: number;
  /** Slippage hint passed through to Phoenix. */
  minBaseLotsToFill?: number;
  minQuoteLotsToFill?: number;
}

/**
 * Build a single Phoenix immediate-or-cancel (Swap) instruction. IOC orders
 * are seatless — no maker-setup required, no resting state. Perfect for the
 * four single-click trade actions on the Trade panel.
 *
 * Caller passes in a loaded `MarketState` (from `useOrderBook` or a one-off
 * load via `MarketState.load`); the helper extracts vault keys + builds
 * accounts + builds the packet + emits the TransactionInstruction.
 */
export function buildPhoenixSwapIx(
  params: PhoenixSwapParams,
): TransactionInstruction {
  const {
    market,
    trader,
    side,
    numBaseLots,
    numQuoteLots,
    priceInTicks,
    minBaseLotsToFill,
    minQuoteLotsToFill,
  } = params;

  const baseMint = market.data.header.baseParams.mintKey;
  const quoteMint = market.data.header.quoteParams.mintKey;

  const baseAccount = getAssociatedTokenAddressSync(baseMint, trader, true);
  const quoteAccount = getAssociatedTokenAddressSync(quoteMint, trader, true);

  const orderPacket: OrderPacket = getImmediateOrCancelOrderPacket({
    side,
    numBaseLots,
    numQuoteLots,
    priceInTicks,
    minBaseLotsToFill,
    minQuoteLotsToFill,
    useOnlyDepositedFunds: false,
  });

  return createSwapInstruction(
    {
      phoenixProgram: PHOENIX_PROGRAM_ID,
      logAuthority: PHOENIX_LOG_AUTHORITY,
      market: market.address,
      trader,
      baseAccount,
      quoteAccount,
      baseVault: market.getBaseVaultKey(),
      quoteVault: market.getQuoteVaultKey(),
      tokenProgram: TOKEN_PROGRAM_ID,
    },
    { orderPacket },
  );
}

export { Side as PhoenixSide } from "@ellipsis-labs/phoenix-sdk";
