// DR-010 — settle_market event handler.
//
// Pipeline triggered by a Helius webhook (or any caller with the equivalent
// data shape):
//   1. Insert settle_events row (idempotent on tx_sig)
//   2. For each token holder of the YES/NO mints at settle time, insert a
//      user_market_holds row (idempotent on (settle_event_id, user_pubkey))
//   3. For each user: apply the win/loss/invalid/abstain result to
//      user_streaks via applyResultToUserStreak
//
// The data source for "who held what at settle time" is a Helius getTokenAccountsByMint
// query (provided by deps.fetchTokenHolders). For local tests, we inject the
// fake list directly.
//
// Invariant: the YES/NO mints have authority = StrikeMarket PDA. After
// settle, holders still own their tokens until they redeem; the snapshot at
// settle-slot is what determines win/loss.

import {
  insertSettleEvent,
  insertUserMarketHold,
  applyResultToUserStreak,
} from "../db/queries.js";
import type { Outcome, SettleEventInput, HoldResult } from "../db/types.js";
import type { QueryDeps } from "../db/queries.js";

export type TokenHolder = {
  ownerPubkey: string;
  /** Decimal-string amount of YES held at settle. "0" if none. */
  yesHeld: string;
  /** Decimal-string amount of NO held at settle. "0" if none. */
  noHeld: string;
};

export type FetchTokenHoldersFn = (params: {
  marketPubkey: string;
  yesMint: string;
  noMint: string;
  atSlot?: number;
}) => Promise<TokenHolder[]>;

export type HandleSettleEventInput = {
  marketPubkey: string;
  yesMint: string;
  noMint: string;
  ticker: string | undefined;
  expiryUnix: number;
  outcome: Outcome;
  settlePrice: string | undefined;
  settleSlot: number | undefined;
  txSig: string;
  observedAt?: Date;
};

export type HandleSettleEventDeps = QueryDeps & {
  fetchTokenHolders: FetchTokenHoldersFn;
};

export type HandleSettleEventResult = {
  settleEventId: number;
  holdersProcessed: number;
  winners: number;
  losers: number;
  invalidPositions: number;
  abstainers: number;
};

/**
 * Determine the per-user result given their YES/NO holdings and the
 * settled outcome.
 *
 * DR-010 semantics:
 *   - Outcome "yes":  user wins iff yes > 0 (regardless of no)
 *   - Outcome "no":   user wins iff no > 0
 *   - Outcome "invalid": position is "invalid" (no win/loss credit, but
 *     does count for total_markets_traded)
 *   - Outcome "unsettled": should never reach here (caller's bug); we
 *     treat as abstain.
 *
 * "yes_held > 0 AND no_held > 0" (a paired position) on a winning side
 * still counts as a win — they held the winning side and minted it
 * (pair-minting is the canonical way to acquire both); we don't penalize
 * users for holding the losing side too.
 *
 * "yes_held = 0 AND no_held = 0" means the holder is a zero-balance ATA
 * (never traded or already redeemed). Skip with `abstained`.
 */
export function determineResult(
  outcome: Outcome,
  yesHeld: string,
  noHeld: string,
): HoldResult {
  const y = Number(yesHeld);
  const n = Number(noHeld);
  // Defensive: NaN means unparseable balance → treat as zero held = abstain.
  const ySafe = Number.isFinite(y) ? y : 0;
  const nSafe = Number.isFinite(n) ? n : 0;
  if (ySafe <= 0 && nSafe <= 0) return "abstained";
  if (outcome === "invalid") return "invalid";
  if (outcome === "yes") return ySafe > 0 ? "won" : "lost";
  if (outcome === "no") return nSafe > 0 ? "won" : "lost";
  // "unsettled" — defensive
  return "abstained";
}

export async function handleSettleEvent(
  input: HandleSettleEventInput,
  deps: HandleSettleEventDeps,
): Promise<HandleSettleEventResult> {
  const observedAt = input.observedAt ?? new Date();

  // 1. Insert settle_events
  const settleEventInput: SettleEventInput = {
    marketPubkey: input.marketPubkey,
    ticker: input.ticker,
    expiryUnix: input.expiryUnix,
    outcome: input.outcome,
    settlePrice: input.settlePrice,
    settleSlot: input.settleSlot,
    txSig: input.txSig,
  };
  const settleEventId = await insertSettleEvent(settleEventInput, deps);

  // 2 + 3. Fetch token holders, insert holds + apply streak updates
  const holders = await deps.fetchTokenHolders({
    marketPubkey: input.marketPubkey,
    yesMint: input.yesMint,
    noMint: input.noMint,
    atSlot: input.settleSlot,
  });

  let winners = 0;
  let losers = 0;
  let invalidPositions = 0;
  let abstainers = 0;

  for (const holder of holders) {
    const result = determineResult(input.outcome, holder.yesHeld, holder.noHeld);
    await insertUserMarketHold(
      {
        settleEventId,
        userPubkey: holder.ownerPubkey,
        marketPubkey: input.marketPubkey,
        yesHeld: holder.yesHeld,
        noHeld: holder.noHeld,
        outcome: input.outcome,
        result,
      },
      deps,
    );

    // Update streak only for non-abstain results.
    if (result !== "abstained") {
      await applyResultToUserStreak(holder.ownerPubkey, result, observedAt, deps);
    }

    switch (result) {
      case "won":
        winners++;
        break;
      case "lost":
        losers++;
        break;
      case "invalid":
        invalidPositions++;
        break;
      case "abstained":
        abstainers++;
        break;
    }
  }

  return {
    settleEventId,
    holdersProcessed: holders.length,
    winners,
    losers,
    invalidPositions,
    abstainers,
  };
}
