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

// Base58 prefix of the Anchor discriminator for `settle_market`.
// Derivation: sha256("global:settle_market")[..8] → bytes → base58.
// We don't compute this at runtime to keep the parser dependency-free; if
// Aria renames the instruction, recompute via:
//   `bs58.encode(crypto.createHash("sha256").update("global:settle_market").digest().slice(0,8))`
// and update this constant.
//
// IMPORTANT: at the time of writing, Aria's IDL exposes `settle_market` at
// this discriminator. Verify with `programs/bell-markets/idl/bell_markets.json`
// instructions[].discriminator. If the array there is not the base58 below,
// recompute.
export const SETTLE_MARKET_DISCRIMINATOR_BASE58 = "5xqRdYTPDDh";
