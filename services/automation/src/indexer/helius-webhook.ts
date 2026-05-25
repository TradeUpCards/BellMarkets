// DR-010 — Helius webhook payload parser.
//
// Helius webhooks deliver enhanced-transaction payloads to a configured HTTPS
// endpoint. This module exposes a pure parser that takes the raw Helius
// payload + extracts the fields needed to call `handleSettleEvent`.
//
// Deployment shape (NOT in this file; out-of-scope for MVP):
//   - A Vercel / Trigger.dev HTTP endpoint receives Helius POST
//   - Endpoint calls `parseHeliusSettleWebhook(payload)` → may return many
//     events per POST (Helius batches)
//   - For each event: call `handleSettleEvent(event, { fetchTokenHolders, ... })`
//
// Helius doc reference: enhanced-transactions / "Anchor Program Detection".
// We match settle_market instructions by the on-chain instruction
// discriminator (Anchor's `sha256("global:settle_market")[..8]`).

import type { Outcome } from "../db/types.js";
import type { HandleSettleEventInput } from "./settle-event-handler.js";

/**
 * Subset of Helius's enhanced-transaction payload shape we depend on.
 * Pulled from the public docs; we tolerate extra fields.
 */
export type HeliusEnhancedTx = {
  signature: string;
  slot?: number;
  description?: string;
  type?: string;
  source?: string;
  instructions?: Array<{
    programId?: string;
    accounts?: string[];
    data?: string; // base58
    innerInstructions?: Array<{ programId?: string; accounts?: string[]; data?: string }>;
  }>;
  events?: {
    anchor?: Array<{
      programId?: string;
      name?: string; // e.g. "MarketSettled"
      data?: Record<string, unknown>;
    }>;
  };
  /** Some Helius variants put account-data writes here for SPL token / Solana state mutation. */
  accountData?: Array<{
    account: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: Array<{
      mint: string;
      tokenAccount: string;
      userAccount?: string;
      rawTokenAmount?: { tokenAmount?: string; decimals?: number };
    }>;
  }>;
};

export type ParsedSettleEvent = HandleSettleEventInput;

/**
 * Walk a Helius enhanced-tx payload looking for our program's
 * `settle_market` event. Returns one ParsedSettleEvent per match (Helius
 * batches multiple settles in a single webhook POST when they share slot).
 *
 * `programId`: caller-supplied (BELL_MARKETS_PROGRAM_ID). Required so we
 * filter out webhooks that include other programs' settle events.
 *
 * Strategy (in order of preference):
 *   1. If `events.anchor[]` has an entry whose `name === "MarketSettled"`
 *      AND `programId` matches our program → parse fields from `data`.
 *      This is the canonical path when Aria emits an Anchor event.
 *   2. Fallback (no anchor event): walk `instructions[]` looking for an
 *      instruction whose `programId` matches us AND whose discriminator
 *      bytes match `sha256("global:settle_market")[..8]`. Recover the
 *      market pubkey from the `accounts[]` ordering per Aria's settle_market
 *      Accounts struct.
 *
 * If neither path resolves → return empty array (Helius delivered a tx that
 * touched our program but wasn't a settle_market; could be mint_pair etc.).
 */
export function parseHeliusSettleWebhook(
  payload: ReadonlyArray<HeliusEnhancedTx> | HeliusEnhancedTx,
  programId: string,
): ParsedSettleEvent[] {
  const txs = Array.isArray(payload) ? payload : [payload];
  const out: ParsedSettleEvent[] = [];
  for (const tx of txs) {
    const events = tx.events?.anchor ?? [];
    let matched = false;
    for (const ev of events) {
      if (ev.programId !== programId) continue;
      if (ev.name !== "MarketSettled" && ev.name !== "marketSettled") continue;
      const parsed = parseAnchorEvent(tx, ev.data ?? {});
      if (parsed) {
        out.push(parsed);
        matched = true;
      }
    }
    if (matched) continue;
    // Fallback: discriminator-match against instructions[].
    const discrim = SETTLE_MARKET_DISCRIMINATOR_BASE58;
    for (const ix of tx.instructions ?? []) {
      if (ix.programId !== programId) continue;
      if (!ix.data) continue;
      // Helius "data" is base58. The first 8 bytes encode the Anchor instruction
      // discriminator. We do a prefix-match.
      if (ix.data.startsWith(discrim)) {
        const parsed = parseInstructionAccounts(tx, ix.accounts ?? []);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

/**
 * Anchor event "MarketSettled" — expected fields:
 *   { market: pubkey, outcome: { yes/no/invalid }, settlePrice: i64,
 *     settleSlot: u64, expiryUnix: i64, ticker?: string }
 *
 * We tolerate either camelCase or snake_case keys (Anchor's IDL emits
 * camelCase; Helius sometimes preserves snake_case).
 */
function parseAnchorEvent(
  tx: HeliusEnhancedTx,
  data: Record<string, unknown>,
): ParsedSettleEvent | undefined {
  const market = pickString(data, ["market", "strikeMarket", "strike_market"]);
  if (!market) return undefined;
  const yesMint = pickString(data, ["yesMint", "yes_mint"]);
  const noMint = pickString(data, ["noMint", "no_mint"]);
  if (!yesMint || !noMint) return undefined;
  const expiryRaw = pickNumberLike(data, ["expiryUnix", "expiry_unix"]);
  const settleSlot = pickNumberLike(data, ["settleSlot", "settle_slot", "slot"]);
  const settlePrice = pickStringOrNumber(data, ["settlePrice", "settle_price"]);
  const ticker = pickString(data, ["ticker"]);
  const outcome = parseOutcome(pickEnum(data, ["outcome"]));
  if (!outcome) return undefined;
  if (expiryRaw === undefined) return undefined;

  return {
    marketPubkey: market,
    yesMint,
    noMint,
    ticker,
    expiryUnix: expiryRaw,
    outcome,
    settlePrice: settlePrice !== undefined ? String(settlePrice) : undefined,
    settleSlot: settleSlot !== undefined ? settleSlot : tx.slot,
    txSig: tx.signature,
  };
}

/**
 * Fallback: parse from settle_market's Accounts struct ordering per Aria's
 * Anchor handler.  Account order (from
 * programs/bell-markets/src/instructions/settle_market.rs):
 *   [0] settler (signer)
 *   [1] config
 *   [2] strike_market
 *   [3] underlying_pyth_feed
 *   [4] clock
 *
 * This path doesn't have YES/NO mints in the ix accounts (settle_market
 * doesn't touch token state). We mark them as the strike_market PDA and
 * upstream caller is expected to enrich via `program.account.strikeMarket.fetch`
 * before invoking handleSettleEvent. For this MVP path, we return a
 * placeholder that requires the caller to override yesMint/noMint —
 * which means this fallback is INSUFFICIENT alone. Caller must use the
 * full anchor-event path OR enrich the mint pubkeys via `derivePdas`.
 */
function parseInstructionAccounts(
  tx: HeliusEnhancedTx,
  accounts: ReadonlyArray<string>,
): ParsedSettleEvent | undefined {
  const market = accounts[2];
  if (!market) return undefined;
  return {
    marketPubkey: market,
    yesMint: "", // unresolvable from discriminator-only fallback
    noMint: "",
    ticker: undefined,
    expiryUnix: 0,
    outcome: "unsettled",
    settlePrice: undefined,
    settleSlot: tx.slot,
    txSig: tx.signature,
  };
}

function parseOutcome(value: unknown): Outcome | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "yes" || lower === "yeswins" || lower === "yes_wins") return "yes";
    if (lower === "no" || lower === "nowins" || lower === "no_wins") return "no";
    if (lower === "invalid") return "invalid";
    if (lower === "unsettled") return "unsettled";
  }
  if (typeof value === "object" && value !== null) {
    // Borsh enum encoding: { yes: {} } / { no: {} } / etc.
    if (Object.prototype.hasOwnProperty.call(value, "yes")) return "yes";
    if (Object.prototype.hasOwnProperty.call(value, "yesWins")) return "yes";
    if (Object.prototype.hasOwnProperty.call(value, "no")) return "no";
    if (Object.prototype.hasOwnProperty.call(value, "noWins")) return "no";
    if (Object.prototype.hasOwnProperty.call(value, "invalid")) return "invalid";
    if (Object.prototype.hasOwnProperty.call(value, "unsettled")) return "unsettled";
  }
  return undefined;
}

function pickString(obj: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickEnum(obj: Record<string, unknown>, keys: ReadonlyArray<string>): unknown {
  for (const k of keys) {
    if (k in obj) return obj[k];
  }
  return undefined;
}

function pickNumberLike(obj: Record<string, unknown>, keys: ReadonlyArray<string>): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
    if (typeof v === "object" && v !== null && typeof (v as { toString?: () => string }).toString === "function") {
      const s = (v as { toString: () => string }).toString();
      if (/^-?\d+$/.test(s)) return Number(s);
    }
  }
  return undefined;
}

function pickStringOrNumber(
  obj: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" || typeof v === "number") return v;
  }
  return undefined;
}

// ── Anchor instruction discriminators ──────────────────────────────────────
//
// Computed at module load via `sha256("global:<snake_name>")[..8]` then
// base58-encoded. Helius enhanced-tx `instructions[].data` is base58; we
// prefix-match.
//
// IMPORTANT: when Aria renames or adds an instruction, just add the snake-
// case name to BELL_MARKETS_IX_NAMES below — the discriminator regenerates
// automatically on next module load. No copy-paste base58 to maintain.

import { createHash } from "node:crypto";

/** All Bell Markets ix names. Keep in lockstep with
 *  programs/bell-markets/src/lib.rs `#[program] mod` declarations.
 *
 *  Through deploy_index=6: 20 ixs (initialize_config through close_settled_market).
 *  Adds in deploy_index=7 per DR-020 (in-program CLOB pivot):
 *    - init_order_book, grow_order_book — two-instruction creation (Solana realloc cap)
 *    - place_order, cancel_order — user trade entry points
 *    - match_orders — permissionless crank for crossed-but-unmatched pairs
 *    - update_usdc_mint — admin ix to flip from Circle USDC → bUSDC demo mint
 *
 *  Discriminators are auto-computed via sha256("global:<name>")[..8] at module
 *  load; no manual base58 wrangling needed when ixs are added or renamed.
 */
export const BELL_MARKETS_IX_NAMES = [
  // deploy_index ≤ 6
  "initialize_config",
  "create_strike_market",
  "add_strike",
  "pause",
  "admin_settle",
  "settle_market",
  "mint_pair",
  "redeem",
  "redeem_invalid",
  "redeem_pair",
  "user_create_strike_market",
  "update_ticker_config",
  "initialize_fee_config",
  "update_fee_config",
  "initialize_rewards_pools",
  "commit_leaderboard_root",
  "distribute_weekly_rewards",
  "distribute_monthly_rewards",
  "force_redeem",
  "close_settled_market",
  // DR-020 / deploy_index=7 — in-program CLOB
  "init_order_book",
  "grow_order_book",
  "place_order",
  "cancel_order",
  "match_orders",
  "update_usdc_mint",
  // DR-020 / deploy_index=8 — Path B unblock for mint_pair under bUSDC
  "reinit_rewards_pools",
] as const;

export type BellMarketsIxName = (typeof BELL_MARKETS_IX_NAMES)[number];

// Internal base58 alphabet — duplicated from merkle.ts to keep this module
// independent. Both must stay in sync.
const _BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bytesToBase58(bytes: Buffer): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += _BASE58_ALPHABET[digits[i]!];
  }
  return out;
}

/**
 * Compute the Anchor discriminator for an ix name + return it base58-encoded.
 * Helius's `instructions[].data` field is base58; we prefix-match against
 * this value.
 *
 *   sha256("global:settle_market")[..8] → bytes → base58
 */
export function ixDiscriminatorBase58(ixSnakeName: string): string {
  const full = createHash("sha256").update(`global:${ixSnakeName}`).digest();
  return bytesToBase58(full.slice(0, 8));
}

/** All known Bell Markets ix discriminators, keyed by ix name. Lazy-init
 *  at first access; safe under top-level await elsewhere. */
export const BELL_MARKETS_IX_DISCRIMINATORS: Record<BellMarketsIxName, string> = Object.fromEntries(
  BELL_MARKETS_IX_NAMES.map((name) => [name, ixDiscriminatorBase58(name)]),
) as Record<BellMarketsIxName, string>;

/** Reverse lookup: base58 prefix → ix name. */
const _DISCRIMINATOR_TO_NAME = (() => {
  const map = new Map<string, BellMarketsIxName>();
  for (const name of BELL_MARKETS_IX_NAMES) {
    map.set(BELL_MARKETS_IX_DISCRIMINATORS[name], name);
  }
  return map;
})();

/** Legacy export — kept for backward compat with prior settle-only callers. */
export const SETTLE_MARKET_DISCRIMINATOR_BASE58 = BELL_MARKETS_IX_DISCRIMINATORS.settle_market;

// ---------------------------------------------------------------------------
// DR-020 — in-program CLOB event parsers (deploy_index=7)
// ---------------------------------------------------------------------------
//
// Scaffolding parsers for the four order-book events Aria's deploy_index=7
// will emit. Per the reference design (docs/architecture/reference-clob-spec.md
// + reference-clob-decisions.md), the event shapes are:
//
//   OrderBookInitialized { market, order_book, usdc_escrow, yes_escrow }
//   OrderPlaced          { market, order_book, owner, side, price, size, seq }
//   OrderMatched         { market, order_book, taker, maker, side, price, size, taker_seq, maker_seq }
//   OrderCancelled       { market, order_book, owner, side, seq, refunded_amount }
//
// These shapes are inferred from Keith's reference-clob-spec.md chunk
// completion notes + ADR-002b. They MAY adjust slightly when Aria's IDL
// lands; the parsers below are tolerant to both camelCase and snake_case
// keys + accept BN-style numeric encodings. Live event verification waits
// for deploy_index=7.
//
// Observability-only — no new DB tables yet (per dispatch). Lazy-add when
// Drew/Cleo surface a need.

export type ParsedOrderBookInitialized = {
  txSig: string;
  slot: number | undefined;
  marketPubkey: string;
  orderBookPubkey: string;
  usdcEscrowPubkey: string | undefined;
  yesEscrowPubkey: string | undefined;
};

export type OrderSide = "bid" | "ask";

export type ParsedOrderPlaced = {
  txSig: string;
  slot: number | undefined;
  marketPubkey: string;
  orderBookPubkey: string;
  ownerPubkey: string;
  side: OrderSide;
  /** Price in USDC-per-Yes at the program's fixed scale (PRICE_SCALE per reference spec). */
  price: string;
  /** Size in Yes-token base units. */
  size: string;
  /** Monotonic sequence number for time priority. */
  seq: string;
};

export type ParsedOrderMatched = {
  txSig: string;
  slot: number | undefined;
  marketPubkey: string;
  orderBookPubkey: string;
  takerPubkey: string;
  makerPubkey: string;
  /** Side of the resting maker order ("bid" → taker sold Yes; "ask" → taker bought Yes). */
  side: OrderSide;
  /** Fill price (per reference spec: trades at the bid's price so bid escrow drains exactly). */
  price: string;
  /** Fill size in Yes-token base units. */
  size: string;
  takerSeq: string | undefined;
  makerSeq: string;
};

export type ParsedOrderCancelled = {
  txSig: string;
  slot: number | undefined;
  marketPubkey: string;
  orderBookPubkey: string;
  ownerPubkey: string;
  side: OrderSide;
  seq: string;
  /** Refunded escrow (USDC for a bid, Yes tokens for an ask) in atomic units. */
  refundedAmount: string | undefined;
};

export type ParsedClobEvents = {
  orderBookInitialized: ParsedOrderBookInitialized[];
  orderPlaced: ParsedOrderPlaced[];
  orderMatched: ParsedOrderMatched[];
  orderCancelled: ParsedOrderCancelled[];
};

/**
 * Walk Helius payload looking for any of the four CLOB events. Returns a
 * grouped result keyed by event kind so the indexer can dispatch each kind
 * to its own handler.
 *
 * If `events.anchor[]` is empty (Helius didn't decode events for this
 * program), the result is all-empty arrays — callers can still fall back
 * to `recognizeBellMarketsIxs` for ix-level visibility.
 */
export function parseClobEvents(
  payload: ReadonlyArray<HeliusEnhancedTx> | HeliusEnhancedTx,
  programId: string,
): ParsedClobEvents {
  const txs = Array.isArray(payload) ? payload : [payload];
  const out: ParsedClobEvents = {
    orderBookInitialized: [],
    orderPlaced: [],
    orderMatched: [],
    orderCancelled: [],
  };
  for (const tx of txs) {
    for (const ev of tx.events?.anchor ?? []) {
      if (ev.programId !== programId) continue;
      const name = (ev.name ?? "").toLowerCase();
      const data = ev.data ?? {};
      if (name === "orderbookinitialized" || name === "order_book_initialized") {
        const parsed = parseOrderBookInitialized(tx, data);
        if (parsed) out.orderBookInitialized.push(parsed);
      } else if (name === "orderplaced" || name === "order_placed") {
        const parsed = parseOrderPlaced(tx, data);
        if (parsed) out.orderPlaced.push(parsed);
      } else if (name === "ordermatched" || name === "order_matched") {
        const parsed = parseOrderMatched(tx, data);
        if (parsed) out.orderMatched.push(parsed);
      } else if (name === "ordercancelled" || name === "order_cancelled") {
        const parsed = parseOrderCancelled(tx, data);
        if (parsed) out.orderCancelled.push(parsed);
      }
    }
  }
  return out;
}

function parseOrderBookInitialized(
  tx: HeliusEnhancedTx,
  data: Record<string, unknown>,
): ParsedOrderBookInitialized | undefined {
  const market = pickString(data, ["market", "strikeMarket", "strike_market"]);
  const orderBook = pickString(data, ["orderBook", "order_book"]);
  if (!market || !orderBook) return undefined;
  return {
    txSig: tx.signature,
    slot: tx.slot,
    marketPubkey: market,
    orderBookPubkey: orderBook,
    usdcEscrowPubkey: pickString(data, ["usdcEscrow", "usdc_escrow"]),
    yesEscrowPubkey: pickString(data, ["yesEscrow", "yes_escrow"]),
  };
}

function parseOrderPlaced(
  tx: HeliusEnhancedTx,
  data: Record<string, unknown>,
): ParsedOrderPlaced | undefined {
  const market = pickString(data, ["market", "strikeMarket", "strike_market"]);
  const orderBook = pickString(data, ["orderBook", "order_book"]);
  const owner = pickString(data, ["owner", "ownerPubkey"]);
  const side = parseSide(pickEnum(data, ["side"]));
  const price = pickStringy(data, ["price"]);
  const size = pickStringy(data, ["size", "quantity"]);
  const seq = pickStringy(data, ["seq", "sequence", "sequenceNumber", "sequence_number"]);
  if (!market || !orderBook || !owner || !side || price === undefined || size === undefined || seq === undefined) {
    return undefined;
  }
  return {
    txSig: tx.signature,
    slot: tx.slot,
    marketPubkey: market,
    orderBookPubkey: orderBook,
    ownerPubkey: owner,
    side,
    price,
    size,
    seq,
  };
}

function parseOrderMatched(
  tx: HeliusEnhancedTx,
  data: Record<string, unknown>,
): ParsedOrderMatched | undefined {
  const market = pickString(data, ["market", "strikeMarket", "strike_market"]);
  const orderBook = pickString(data, ["orderBook", "order_book"]);
  const taker = pickString(data, ["taker", "takerPubkey"]);
  const maker = pickString(data, ["maker", "makerPubkey"]);
  const side = parseSide(pickEnum(data, ["side", "makerSide", "maker_side"]));
  const price = pickStringy(data, ["price", "fillPrice", "fill_price"]);
  const size = pickStringy(data, ["size", "fillSize", "fill_size"]);
  const takerSeq = pickStringy(data, ["takerSeq", "taker_seq"]);
  const makerSeq = pickStringy(data, ["makerSeq", "maker_seq"]);
  if (
    !market || !orderBook || !taker || !maker || !side ||
    price === undefined || size === undefined || makerSeq === undefined
  ) {
    return undefined;
  }
  return {
    txSig: tx.signature,
    slot: tx.slot,
    marketPubkey: market,
    orderBookPubkey: orderBook,
    takerPubkey: taker,
    makerPubkey: maker,
    side,
    price,
    size,
    takerSeq,
    makerSeq,
  };
}

function parseOrderCancelled(
  tx: HeliusEnhancedTx,
  data: Record<string, unknown>,
): ParsedOrderCancelled | undefined {
  const market = pickString(data, ["market", "strikeMarket", "strike_market"]);
  const orderBook = pickString(data, ["orderBook", "order_book"]);
  const owner = pickString(data, ["owner", "ownerPubkey"]);
  const side = parseSide(pickEnum(data, ["side"]));
  const seq = pickStringy(data, ["seq", "sequence", "sequenceNumber", "sequence_number"]);
  if (!market || !orderBook || !owner || !side || seq === undefined) return undefined;
  return {
    txSig: tx.signature,
    slot: tx.slot,
    marketPubkey: market,
    orderBookPubkey: orderBook,
    ownerPubkey: owner,
    side,
    seq,
    refundedAmount: pickStringy(data, ["refundedAmount", "refunded_amount", "refund"]),
  };
}

function parseSide(value: unknown): OrderSide | undefined {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "bid" || lower === "buy") return "bid";
    if (lower === "ask" || lower === "sell" || lower === "offer") return "ask";
  }
  if (typeof value === "object" && value !== null) {
    // Anchor enum borsh shape: { bid: {} } / { ask: {} }
    if (Object.prototype.hasOwnProperty.call(value, "bid")) return "bid";
    if (Object.prototype.hasOwnProperty.call(value, "buy")) return "bid";
    if (Object.prototype.hasOwnProperty.call(value, "ask")) return "ask";
    if (Object.prototype.hasOwnProperty.call(value, "sell")) return "ask";
  }
  return undefined;
}

/**
 * Pick a numeric-ish field and stringify so the caller can store the exact
 * on-chain bytes (BN, u64, etc.) without losing precision to JS Number.
 */
function pickStringy(obj: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object" && v !== null && typeof (v as { toString?: () => string }).toString === "function") {
      const s = (v as { toString: () => string }).toString();
      if (s && s !== "[object Object]") return s;
    }
  }
  return undefined;
}

/**
 * Walk a Helius payload and return the names of all Bell Markets ixs
 * observed. Used for indexer observability (logging which ixs fired in
 * any given batch) without parsing per-ix arguments.
 *
 * `programId` filter ensures we only count instructions targeting our
 * program — webhooks can include cross-program activity.
 */
export function recognizeBellMarketsIxs(
  payload: ReadonlyArray<HeliusEnhancedTx> | HeliusEnhancedTx,
  programId: string,
): Array<{ txSig: string; ixName: BellMarketsIxName; slot?: number }> {
  const txs = Array.isArray(payload) ? payload : [payload];
  const out: Array<{ txSig: string; ixName: BellMarketsIxName; slot?: number }> = [];
  for (const tx of txs) {
    for (const ix of tx.instructions ?? []) {
      if (ix.programId !== programId) continue;
      if (!ix.data) continue;
      // Match by base58 prefix — Anchor's discriminator is the first 8
      // bytes of the ix data buffer.
      for (const [discriminator, ixName] of _DISCRIMINATOR_TO_NAME.entries()) {
        if (ix.data.startsWith(discriminator)) {
          out.push({
            txSig: tx.signature,
            ixName: ixName as BellMarketsIxName,
            slot: tx.slot,
          });
          break;
        }
      }
    }
  }
  return out;
}
