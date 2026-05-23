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

// ─── DR-005 / DR-006: TickerConfig view ───────────────────────────────────

/**
 * Projection of the on-chain `TickerConfig` PDA per DR-005 / DR-006. Used by
 * the Markets-grid filter row, the strike picker, and the "wider strikes
 * available" earnings indicator (DR-011).
 *
 * Field names mirror the post-P5 IDL `TickerConfig` schema. Use the
 * `TickerConfigVM` alias below in UI code per Tate's naming convention.
 */
export interface TickerConfigView {
  /** Pyth feed pubkey — primary identity. */
  pythFeed: PublicKey;
  /** Current "cap_center" (post-close anchor; updated on AH/PM wild swings). */
  capCenter: bigint;
  /** Strikes the program currently allows for user creation, in i64 units. */
  allowedStrikes: bigint[];
  /** Live count of populated entries in the fixed-16-slot allowed_strikes. */
  strikeCount: number;
  /** Max % deviation from `capCenter` for `user_create_strike_market`. */
  maxDeviationBps: number;
  /** Strike grid tick per DR-005 table — minimum strike granularity (i64 units). */
  strikeTickSize: bigint;
  /** AH/PM wild-swing trigger (per DR-006). */
  thresholdBps: number;
  /** Last unix-seconds the config was touched. */
  lastUpdatedUnix: bigint;
}

/** Tate-naming alias — UI code should reference VM-suffixed types. */
export type TickerConfigVM = TickerConfigView;

// ─── DR-008: UserConfig view ──────────────────────────────────────────────

/**
 * Per-user fee-state projection (DR-008). Drives "tier 2, 1.5% fee" badges,
 * "$X USDC volume / 30d" progress bars, and the projected total cost on
 * mint inputs.
 */
export interface UserConfigView {
  user: PublicKey;
  mintVolume30dMicros: bigint;
  mintVolumeLifetimeMicros: bigint;
  currentTier: 1 | 2 | 3;
  /** Default tier fee bps BEFORE creator rebate. */
  projectedFeeBps: number;
  /** Last linear-decay timestamp from on-chain — UI computes decay-remaining itself. */
  lastDecayUnix: bigint;
}

/** Tate-naming alias. */
export type UserConfigVM = UserConfigView;

// ─── DR-010: Rewards pool view ────────────────────────────────────────────

/**
 * Read-side view of one weekly/monthly rewards pool. The distribution amount
 * fields show "if the period closed now, here's what each top-10 winner gets"
 * — useful for the leaderboard CTA and the streak-badge tooltip.
 */
export interface RewardsPoolView {
  period: "weekly" | "monthly";
  totalBalanceUsdcMicros: bigint;
  /**
   * Projected payouts for positions 1-10, in USDC micros. Index 0 = #1.
   * Computed from the live pool balance × `distribution_bps[position]`.
   */
  distributionAmountsTop10: bigint[];
}

// ─── DR-008: Open Phoenix order view ──────────────────────────────────────

/**
 * UI projection of one trader's resting order on a Phoenix market. Mirrors
 * the `OpenOrder` shape from `useOpenOrders` with a friendlier name for the
 * portfolio "open orders" table.
 */
export interface OpenOrderView {
  /** Phoenix order primary id — sufficient for cancel-by-id. */
  orderId: {
    side: "Bid" | "Ask";
    priceInTicks: bigint;
    orderSequenceNumber: bigint;
  };
  side: "Bid" | "Ask";
  priceUi: number;
  /** Resting size in base lots. */
  sizeBaseLots: bigint;
  marketId: PublicKey;
  /** Unix seconds when the order was placed (best-effort; from `lastValidSlot`). */
  placeUnix: number | null;
}

/** Tate-naming alias. */
export type OpenOrderVM = OpenOrderView;

// ─── DR-010: Leaderboard entry view ───────────────────────────────────────

/**
 * Projection of one ranked user in the weekly/monthly leaderboard. The
 * indexer's `LeaderboardResponse.entries` deserialize to this shape; the
 * frontend renders the streak badge + prize and (for the connected user)
 * highlights their own row.
 */
export interface LeaderboardEntryView {
  rank: number;
  userPubkey: string;
  /** Longest consecutive winning settle in the period. */
  streakCount: number;
  /** Total markets traded in the period (tiebreaker per DR-010). */
  totalMarkets: number;
  prizeAmountMicros: bigint;
}

/** Tate-naming alias. */
export type LeaderboardEntryVM = LeaderboardEntryView;
