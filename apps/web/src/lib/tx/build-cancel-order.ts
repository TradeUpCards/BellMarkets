import { BN } from "@coral-xyz/anchor";
import {
  PROGRAM_ID as PHOENIX_PROGRAM_ID,
  Side,
  createCancelMultipleOrdersByIdInstruction,
  getLogAuthority,
  type MarketState,
} from "@ellipsis-labs/phoenix-sdk";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

const PHOENIX_LOG_AUTHORITY: PublicKey = getLogAuthority();

export interface CancelOrderRef {
  side: Side;
  /** Phoenix internal price in ticks (read from L3 order or trader-state). */
  priceInTicks: number | bigint;
  /** Phoenix per-side monotonically increasing order seq number. */
  orderSequenceNumber: number | bigint;
}

export interface BuildCancelOrderParams {
  /** Phoenix market loaded via `MarketState.load`. */
  market: MarketState;
  /** Wallet of the order's owner — must match `trader` on the resting order. */
  trader: PublicKey;
  /** One or more order refs to cancel atomically. */
  orders: CancelOrderRef[];
}

export interface BuildCancelOrderResult {
  tx: Transaction;
  ix: TransactionInstruction;
}

/**
 * Build (don't send) a single Phoenix `CancelMultipleOrdersById` instruction
 * that cancels every order in `orders` in a single tx.
 *
 * Phoenix matches by (side, priceInTicks, orderSequenceNumber) — the trader
 * who placed the order must sign. Callers typically read order refs from
 * `useOpenOrders` (PhoenixSdk `MarketState.getTraderState(...)`) which returns
 * the live resting orders for a trader on a market.
 *
 * For UX symmetry with the four trade actions, the cancel surfaces as a
 * single-tx flow (one signature, atomic).
 */
export function buildCancelOrderTx(
  params: BuildCancelOrderParams,
): BuildCancelOrderResult {
  const { market, trader, orders } = params;
  if (orders.length === 0) {
    throw new Error("buildCancelOrderTx: orders array is empty.");
  }

  const baseMint = market.data.header.baseParams.mintKey;
  const quoteMint = market.data.header.quoteParams.mintKey;

  const ix = createCancelMultipleOrdersByIdInstruction(
    {
      phoenixProgram: PHOENIX_PROGRAM_ID,
      logAuthority: PHOENIX_LOG_AUTHORITY,
      market: market.address,
      trader,
      baseAccount: getAssociatedTokenAddressSync(baseMint, trader, true),
      quoteAccount: getAssociatedTokenAddressSync(quoteMint, trader, true),
      baseVault: market.getBaseVaultKey(),
      quoteVault: market.getQuoteVaultKey(),
      tokenProgram: TOKEN_PROGRAM_ID,
    },
    {
      params: {
        orders: orders.map((o) => ({
          side: o.side,
          priceInTicks: new BN(o.priceInTicks.toString()),
          orderSequenceNumber: new BN(o.orderSequenceNumber.toString()),
        })),
      },
    },
  );

  const tx = new Transaction().add(ix);
  return { tx, ix };
}

export { Side as PhoenixSide } from "@ellipsis-labs/phoenix-sdk";
