import { PublicKey } from "@solana/web3.js";

import type { Order, OrderBookAccount } from "./types";

export type { Order, OrderBookAccount } from "./types";

/**
 * Constants mirrored from `programs/bell-markets/src/state.rs` (DR-020).
 * Source of truth: `programs/bell-markets/src/state.rs` — sync these by hand
 * when Aria changes any of them (rare, locks via deploy + audit log).
 */
export const ORDERBOOK_N = 128;
export const PRICE_SCALE = 1_000_000n; // USDC base units per $1 (6 decimals)
export const SIDE_BID = 0;
export const SIDE_ASK = 1;

/** Max planned fills per place_order ix call (matches MAX_FILLS_PER_PLACE_ORDER). */
export const MAX_FILLS_PER_PLACE_ORDER = 16;

/** Max crossed pairs per match_orders ix call. */
export const MAX_CROSSED_PAIRS_PER_MATCH_ORDERS = 8;

// ── Byte-layout offsets (mirrors the IDL `OrderBook` table comment) ────────
const DISC_LEN = 8;
const ORDER_LEN = 64; // 32 owner + 8 price + 8 size + 8 seq + 1 side + 7 pad
const MARKET_OFF = DISC_LEN; // 8
const NEXT_SEQ_OFF = MARKET_OFF + 32; // 40
const BIDS_OFF = NEXT_SEQ_OFF + 8; // 48
const ASKS_OFF = BIDS_OFF + ORDER_LEN * ORDERBOOK_N; // 8240
const BIDS_LEN_OFF = ASKS_OFF + ORDER_LEN * ORDERBOOK_N; // 16432
const ASKS_LEN_OFF = BIDS_LEN_OFF + 2; // 16434
const BUMP_OFF = ASKS_LEN_OFF + 2; // 16436

export const ORDER_BOOK_LEN = 16_448;
export const ORDER_BOOK_INIT_ALLOC = 10_008; // 10_000 payload + 8 disc

function readU64Le(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}
function readU16Le(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

function decodeOrder(buf: Buffer, off: number): Order {
  const owner = new PublicKey(buf.subarray(off, off + 32));
  const price = readU64Le(buf, off + 32);
  const size = readU64Le(buf, off + 40);
  const seq = readU64Le(buf, off + 48);
  const sideByte = buf[off + 56] ?? 0;
  const side: 0 | 1 = sideByte === SIDE_ASK ? SIDE_ASK : SIDE_BID;
  return { owner, price, size, seq, side };
}

/**
 * Decode a bytemuck `OrderBook` account into a typed view. Caller is
 * responsible for verifying `data.length >= ORDER_BOOK_INIT_ALLOC` —
 * pre-grow allocations decode market+next_seq but not the full ladders.
 *
 * Returns `null` when the buffer is too small to contain a meaningful book
 * (typical: account was init'd but not grown — the trading gate on
 * `strike_market.order_book` should already have rejected the call).
 */
export function decodeOrderBook(data: Buffer): OrderBookAccount | null {
  if (data.length < ORDER_BOOK_LEN) {
    // Pre-grow allocation. Trading is gated off at the program level.
    return null;
  }
  const market = new PublicKey(data.subarray(MARKET_OFF, MARKET_OFF + 32));
  const nextSeq = readU64Le(data, NEXT_SEQ_OFF);
  const bidsLen = readU16Le(data, BIDS_LEN_OFF);
  const asksLen = readU16Le(data, ASKS_LEN_OFF);
  const bump = data[BUMP_OFF] ?? 0;

  const bids: Order[] = [];
  for (let i = 0; i < bidsLen && i < ORDERBOOK_N; i++) {
    bids.push(decodeOrder(data, BIDS_OFF + i * ORDER_LEN));
  }
  const asks: Order[] = [];
  for (let i = 0; i < asksLen && i < ORDERBOOK_N; i++) {
    asks.push(decodeOrder(data, ASKS_OFF + i * ORDER_LEN));
  }

  return { market, nextSeq, bids, asks, bump };
}

// ── Off-chain plan_fills (mirrors matching::plan_fills in Rust) ────────────

/**
 * One planned fill against a maker. Used to construct `remaining_accounts`
 * for `place_order`. The payout-token side of the maker (USDC for ask makers
 * filled by an incoming bid; YES for bid makers filled by an incoming ask)
 * is derived by the caller via `getAssociatedTokenAddressSync`.
 */
export interface PlannedFill {
  /** Index into `book.bids` or `book.asks` (the resting side). */
  makerIndex: number;
  /** The maker's `Order.owner` pubkey (used to derive their payout ATA). */
  makerOwner: PublicKey;
  /** The maker's resting price — drives the per-fill USDC math. */
  makerPrice: bigint;
  /** YES tokens filled in this slot (≤ maker.size). */
  fillSize: bigint;
}

export interface PlanFillsResult {
  fills: PlannedFill[];
  /** Total YES tokens filled across all planned fills. */
  totalFilled: bigint;
  /** YES tokens remaining unfilled (= size - totalFilled). */
  remaining: bigint;
}

/**
 * Off-chain mirror of `matching::plan_fills`. Walks the opposite side of the
 * incoming order (best-first) and accumulates fills until either:
 *   - `size` exhausted, OR
 *   - `MAX_FILLS_PER_PLACE_ORDER` reached, OR
 *   - next maker doesn't cross the incoming price (limit only).
 *
 * For market orders, `price` is ignored and walks until size is met or the
 * book runs out.
 */
export function planFills(
  book: OrderBookAccount,
  side: 0 | 1,
  price: bigint,
  size: bigint,
  isMarket: boolean,
  maxFills: number = MAX_FILLS_PER_PLACE_ORDER,
): PlanFillsResult {
  const makers = side === SIDE_BID ? book.asks : book.bids;
  const fills: PlannedFill[] = [];
  let remaining = size;
  let totalFilled = 0n;

  for (let i = 0; i < makers.length && fills.length < maxFills && remaining > 0n; i++) {
    const maker = makers[i];
    if (!maker) break;
    // Cross check for limit orders. Bids cross asks priced <= bidPrice;
    // asks cross bids priced >= askPrice.
    if (!isMarket) {
      const crosses = side === SIDE_BID
        ? maker.price <= price
        : maker.price >= price;
      if (!crosses) break;
    }
    const fillSize = maker.size < remaining ? maker.size : remaining;
    fills.push({
      makerIndex: i,
      makerOwner: maker.owner,
      makerPrice: maker.price,
      fillSize,
    });
    totalFilled += fillSize;
    remaining -= fillSize;
  }

  return { fills, totalFilled, remaining };
}
