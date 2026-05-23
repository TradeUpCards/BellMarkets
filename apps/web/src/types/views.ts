/**
 * Frontend view models per `specs/architecture.md` §4.
 *
 * These are the contracts the Trade panel + Markets grid + Portfolio compose
 * against. They project raw on-chain reads (`StrikeMarket`, `Position`,
 * `OrderBook`) into a UI-friendly shape — drop nullable fields when the
 * underlying data isn't loaded yet, normalize Outcome to the real Anchor
 * shape (Yes / No / Invalid / Unsettled, not the Day-1 spec's YesWins / NoWins).
 *
 * Pure types + projection helpers. No React. Design-agnostic.
 */

import type { PublicKey } from "@solana/web3.js";

import type { OutcomeTag, StrikeMarket } from "@/lib/solana/types";
import type { OrderBook } from "@/hooks/use-order-book";
import type { Position } from "@/hooks/use-position";

// ─── Market view ──────────────────────────────────────────────────────────

export interface StrikeMarketView {
  /** PDA of the StrikeMarket account. */
  marketId: PublicKey;
  /**
   * Ticker derived from `underlying_pyth_feed` via the off-chain pubkey
   * registry (`coordination/devnet-pubkeys.md`). Optional because the
   * mapping is a frontend concern and may not be resolved at render time.
   */
  ticker?: string;
  /** Strike price in USDC, human-readable (i.e., `strike_price_micros / 1e6`). */
  strike: number;
  /** Settlement window (expiry_unix → Date for UI display). */
  settlementWindow: Date;
  outcome: OutcomeTag;
  isSettled: boolean;
  /** Yes price from Phoenix order book midpoint, when both sides exist. */
  yesBidPrice?: number;
  yesAskPrice?: number;
  yesMidPrice?: number;
  /** No prices implied from Yes via the 1 - p relationship. */
  noBidPrice?: number;
  noAskPrice?: number;
  /** Implied probability = yesMidPrice. */
  impliedYesProbability?: number;
}

/**
 * Project a decoded `StrikeMarket` + optional `OrderBook` into a `StrikeMarketView`.
 *
 * Caller composes hooks: `useMarketAccount(marketPda)` → StrikeMarket, then
 * `useOrderBook(market.phoenixMarket)` → OrderBook, then `toStrikeMarketView`.
 */
export function toStrikeMarketView(args: {
  marketId: PublicKey;
  market: StrikeMarket;
  book?: OrderBook | null;
  /** Optional ticker resolver (pyth feed pubkey → ticker symbol). */
  ticker?: string;
}): StrikeMarketView {
  const { marketId, market, book, ticker } = args;

  const strike = Number(market.strikePrice.toString()) / 1_000_000;
  const settlementWindow = new Date(
    Number(market.expiryUnix.toString()) * 1000,
  );

  const tag = outcomeTagOf(market.outcome);

  const yesBid = book?.bids[0]?.price;
  const yesAsk = book?.asks[0]?.price;
  const yesMid =
    yesBid !== undefined && yesAsk !== undefined
      ? (yesBid + yesAsk) / 2
      : undefined;
  const noBid = yesAsk !== undefined ? 1 - yesAsk : undefined;
  const noAsk = yesBid !== undefined ? 1 - yesBid : undefined;

  return {
    marketId,
    ticker,
    strike,
    settlementWindow,
    outcome: tag,
    isSettled: tag !== "unsettled",
    yesBidPrice: yesBid,
    yesAskPrice: yesAsk,
    yesMidPrice: yesMid,
    noBidPrice: noBid,
    noAskPrice: noAsk,
    impliedYesProbability: yesMid,
  };
}

// Local import to avoid circular type — outcomeTag is in types.ts.
function outcomeTagOf(o: StrikeMarket["outcome"]): OutcomeTag {
  if ("yes" in o) return "yes";
  if ("no" in o) return "no";
  if ("invalid" in o) return "invalid";
  return "unsettled";
}

// ─── User position view ───────────────────────────────────────────────────

/**
 * Re-export of the live Position type from `usePosition`. Kept here so
 * downstream consumers can import a single "views" namespace rather than
 * threading hook-internal types.
 */
export type UserPosition = Position;

// ─── Trade intents (Trade-panel input shape) ──────────────────────────────

/**
 * What the user is trying to do. Each intent translates to ONE atomic
 * Solana transaction (POV-3) built by the corresponding `lib/tx/build-*.ts`.
 *
 * `usdcLots` / `tokenLots` are in PHOENIX LOT UNITS, not human-readable
 * dollars — the Trade panel converts between the two using the Phoenix
 * MarketState's lot math (`baseLotsPerBaseUnit`, etc.).
 */
export type TradeIntent =
  | {
      kind: "BuyYes";
      marketId: PublicKey;
      usdcLots: number;
      orderType: OrderType;
    }
  | {
      kind: "BuyNo";
      marketId: PublicKey;
      /** Pair count to mint (also = base lots sold on Phoenix). */
      pairs: bigint;
      orderType: OrderType;
    }
  | {
      kind: "SellYes";
      marketId: PublicKey;
      yesLots: number;
      orderType: OrderType;
    }
  | {
      kind: "SellNo";
      marketId: PublicKey;
      /** No tokens to sell (also = Yes to buy + pairs to redeem). */
      amount: bigint;
      /** Max USDC the trader will spend on the Phoenix buy leg. */
      maxQuoteLotsToSpend: number;
      orderType: OrderType;
    }
  | {
      kind: "Redeem";
      marketId: PublicKey;
      amount: bigint;
    };

export type OrderType = "market" | { limit: number };

// ─── Helpers shared across views ──────────────────────────────────────────

/** Format a usdc-micros bigint as a 6-decimal string (e.g., 1_500_000n → "1.500000"). */
export function formatUsdc(micros: bigint, decimals: number = 2): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole.toString()}${decimals > 0 ? "." + fracStr : ""}`;
}
