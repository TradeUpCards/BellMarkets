// Indexer query layer. All SQL parameterized; no string interpolation of
// user-supplied values.
//
// Functions are factored so tests can inject a fake SQL client. The default
// uses the Neon serverless client.

import { getSqlClient, IndexerDbError } from "./client.js";
import type { SqlClient } from "./client.js";
import type {
  DistributionInput,
  LeaderboardEntry,
  LeaderboardSnapshot,
  PeriodKind,
  SettleEvent,
  SettleEventInput,
  SnapshotInput,
  UserMarketHold,
  UserMarketHoldInput,
  UserStreak,
} from "./types.js";

export type QueryDeps = { sql?: SqlClient };

function clientOf(deps?: QueryDeps): SqlClient {
  return deps?.sql ?? getSqlClient();
}

// ---------------------------------------------------------------------------
// settle_events
// ---------------------------------------------------------------------------

/**
 * Insert a settle event. Idempotent — `tx_sig` is UNIQUE so a Helius webhook
 * retry inserts at most once. Returns the existing row's id on conflict.
 */
export async function insertSettleEvent(
  input: SettleEventInput,
  deps?: QueryDeps,
): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO settle_events (market_pubkey, ticker, expiry_unix, outcome, settle_price, settle_slot, tx_sig)
    VALUES (${input.marketPubkey}, ${input.ticker ?? null}, ${input.expiryUnix}, ${input.outcome}, ${input.settlePrice ?? null}, ${input.settleSlot ?? null}, ${input.txSig})
    ON CONFLICT (tx_sig) DO UPDATE SET tx_sig = settle_events.tx_sig
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) {
    throw new IndexerDbError("insertSettleEvent: insert returned no rows");
  }
  return row.id;
}

export async function getSettleEventByTxSig(
  txSig: string,
  deps?: QueryDeps,
): Promise<SettleEvent | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, market_pubkey, ticker, expiry_unix, outcome, settle_price, settle_slot, tx_sig, observed_at
    FROM settle_events
    WHERE tx_sig = ${txSig}
  `) as Array<RawSettleEvent>;
  return rows[0] ? rowToSettleEvent(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// user_market_holds
// ---------------------------------------------------------------------------

export async function insertUserMarketHold(
  input: UserMarketHoldInput,
  deps?: QueryDeps,
): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO user_market_holds (settle_event_id, user_pubkey, market_pubkey, yes_held, no_held, outcome, result)
    VALUES (${input.settleEventId}, ${input.userPubkey}, ${input.marketPubkey}, ${input.yesHeld}, ${input.noHeld}, ${input.outcome}, ${input.result})
    ON CONFLICT (settle_event_id, user_pubkey) DO UPDATE SET result = excluded.result
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) {
    throw new IndexerDbError("insertUserMarketHold: insert returned no rows");
  }
  return row.id;
}

export async function getHoldsForSettleEvent(
  settleEventId: number,
  deps?: QueryDeps,
): Promise<UserMarketHold[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, settle_event_id, user_pubkey, market_pubkey, yes_held, no_held, outcome, result, observed_at
    FROM user_market_holds
    WHERE settle_event_id = ${settleEventId}
  `) as Array<RawUserMarketHold>;
  return rows.map(rowToUserMarketHold);
}

// ---------------------------------------------------------------------------
// user_streaks
// ---------------------------------------------------------------------------

/**
 * Atomically apply a settle result to a user's streak.
 *   "won"        → increments current_streak, updates longest_streak,
 *                  bumps total_markets_won + total_markets_traded.
 *   "lost"       → resets current_streak to 0, bumps total_markets_traded.
 *   "invalid"    → bumps total_markets_traded; current_streak unchanged
 *                  (PRD: Invalid outcomes refund both sides — neither
 *                  "win" nor "loss" semantically).
 *   "abstained"  → no-op. Caller should typically not insert abstain rows
 *                  but the function handles them as a defensive measure.
 *
 * Uses INSERT … ON CONFLICT UPDATE so users with no prior row are created.
 */
export async function applyResultToUserStreak(
  userPubkey: string,
  result: "won" | "lost" | "invalid" | "abstained",
  observedAt: Date,
  deps?: QueryDeps,
): Promise<UserStreak> {
  const sql = clientOf(deps);
  if (result === "abstained") {
    // Lookup-or-create with no field changes.
    const rows = (await sql`
      INSERT INTO user_streaks (user_pubkey, last_settle_at, updated_at)
      VALUES (${userPubkey}, ${observedAt.toISOString()}, NOW())
      ON CONFLICT (user_pubkey) DO UPDATE SET updated_at = NOW()
      RETURNING user_pubkey, current_streak, longest_streak, total_markets_won, total_markets_traded, last_result, last_settle_at, updated_at
    `) as Array<RawUserStreak>;
    const row = rows[0];
    if (!row) {
      throw new IndexerDbError("applyResultToUserStreak(abstained): returned no rows");
    }
    return rowToUserStreak(row);
  }

  if (result === "won") {
    const rows = (await sql`
      INSERT INTO user_streaks (
        user_pubkey, current_streak, longest_streak, total_markets_won,
        total_markets_traded, last_result, last_settle_at, updated_at
      )
      VALUES (${userPubkey}, 1, 1, 1, 1, ${"won"}, ${observedAt.toISOString()}, NOW())
      ON CONFLICT (user_pubkey) DO UPDATE SET
        current_streak = user_streaks.current_streak + 1,
        longest_streak = GREATEST(user_streaks.longest_streak, user_streaks.current_streak + 1),
        total_markets_won = user_streaks.total_markets_won + 1,
        total_markets_traded = user_streaks.total_markets_traded + 1,
        last_result = ${"won"},
        last_settle_at = ${observedAt.toISOString()},
        updated_at = NOW()
      RETURNING user_pubkey, current_streak, longest_streak, total_markets_won, total_markets_traded, last_result, last_settle_at, updated_at
    `) as Array<RawUserStreak>;
    const row = rows[0];
    if (!row) throw new IndexerDbError("applyResultToUserStreak(won): no rows");
    return rowToUserStreak(row);
  }

  if (result === "lost") {
    const rows = (await sql`
      INSERT INTO user_streaks (
        user_pubkey, current_streak, longest_streak, total_markets_won,
        total_markets_traded, last_result, last_settle_at, updated_at
      )
      VALUES (${userPubkey}, 0, 0, 0, 1, ${"lost"}, ${observedAt.toISOString()}, NOW())
      ON CONFLICT (user_pubkey) DO UPDATE SET
        current_streak = 0,
        total_markets_traded = user_streaks.total_markets_traded + 1,
        last_result = ${"lost"},
        last_settle_at = ${observedAt.toISOString()},
        updated_at = NOW()
      RETURNING user_pubkey, current_streak, longest_streak, total_markets_won, total_markets_traded, last_result, last_settle_at, updated_at
    `) as Array<RawUserStreak>;
    const row = rows[0];
    if (!row) throw new IndexerDbError("applyResultToUserStreak(lost): no rows");
    return rowToUserStreak(row);
  }

  // invalid: bump total_markets_traded, leave streak unchanged
  const rows = (await sql`
    INSERT INTO user_streaks (
      user_pubkey, current_streak, longest_streak, total_markets_won,
      total_markets_traded, last_result, last_settle_at, updated_at
    )
    VALUES (${userPubkey}, 0, 0, 0, 1, ${"invalid"}, ${observedAt.toISOString()}, NOW())
    ON CONFLICT (user_pubkey) DO UPDATE SET
      total_markets_traded = user_streaks.total_markets_traded + 1,
      last_result = ${"invalid"},
      last_settle_at = ${observedAt.toISOString()},
      updated_at = NOW()
    RETURNING user_pubkey, current_streak, longest_streak, total_markets_won, total_markets_traded, last_result, last_settle_at, updated_at
  `) as Array<RawUserStreak>;
  const row = rows[0];
  if (!row) throw new IndexerDbError("applyResultToUserStreak(invalid): no rows");
  return rowToUserStreak(row);
}

export async function getUserStreak(
  userPubkey: string,
  deps?: QueryDeps,
): Promise<UserStreak | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT user_pubkey, current_streak, longest_streak, total_markets_won, total_markets_traded, last_result, last_settle_at, updated_at
    FROM user_streaks
    WHERE user_pubkey = ${userPubkey}
  `) as Array<RawUserStreak>;
  return rows[0] ? rowToUserStreak(rows[0]) : undefined;
}

/**
 * Top-N leaderboard: highest current_streak first, then highest
 * total_markets_traded (tiebreaker 1). The "random" tiebreaker (DR-010
 * tiebreaker 2) is applied in TS at the merkle step.
 */
export async function topNLeaderboard(
  limit: number,
  deps?: QueryDeps,
): Promise<LeaderboardEntry[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT user_pubkey, current_streak, longest_streak, total_markets_traded, total_markets_won
    FROM user_streaks
    WHERE current_streak > 0
    ORDER BY current_streak DESC, total_markets_traded DESC
    LIMIT ${limit}
  `) as Array<{
    user_pubkey: string;
    current_streak: number;
    longest_streak: number;
    total_markets_traded: number;
    total_markets_won: number;
  }>;
  return rows.map((r) => ({
    userPubkey: r.user_pubkey,
    currentStreak: r.current_streak,
    longestStreak: r.longest_streak,
    totalMarketsTraded: r.total_markets_traded,
    totalMarketsWon: r.total_markets_won,
  }));
}

// ---------------------------------------------------------------------------
// leaderboard_snapshots + distributions
// ---------------------------------------------------------------------------

export async function insertSnapshot(
  input: SnapshotInput,
  deps?: QueryDeps,
): Promise<LeaderboardSnapshot> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO leaderboard_snapshots (
      period_kind, period_id, period_start, period_end,
      merkle_root, arweave_tx_id, committed_tx_sig,
      participants_count, full_leaderboard_json
    )
    VALUES (
      ${input.periodKind}, ${input.periodId}, ${input.periodStart.toISOString()}, ${input.periodEnd.toISOString()},
      ${input.merkleRoot ?? null}, ${input.arweaveTxId ?? null}, ${input.committedTxSig ?? null},
      ${input.participantsCount}, ${JSON.stringify(input.fullLeaderboardJson)}::jsonb
    )
    ON CONFLICT (period_kind, period_id) DO UPDATE SET
      merkle_root = COALESCE(excluded.merkle_root, leaderboard_snapshots.merkle_root),
      arweave_tx_id = COALESCE(excluded.arweave_tx_id, leaderboard_snapshots.arweave_tx_id),
      committed_tx_sig = COALESCE(excluded.committed_tx_sig, leaderboard_snapshots.committed_tx_sig)
    RETURNING id, period_kind, period_id, period_start, period_end, merkle_root, arweave_tx_id, committed_tx_sig, participants_count, full_leaderboard_json, created_at
  `) as Array<RawLeaderboardSnapshot>;
  const row = rows[0];
  if (!row) throw new IndexerDbError("insertSnapshot: no rows");
  return rowToSnapshot(row);
}

export async function insertDistribution(
  input: DistributionInput,
  deps?: QueryDeps,
): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO distributions (snapshot_id, position, user_pubkey, amount_usdc, tx_sig, merkle_proof)
    VALUES (
      ${input.snapshotId}, ${input.position}, ${input.userPubkey ?? null}, ${input.amountUsdc},
      ${input.txSig ?? null}, ${input.merkleProof ? JSON.stringify(input.merkleProof) : null}::jsonb
    )
    ON CONFLICT (snapshot_id, position) DO UPDATE SET
      tx_sig = COALESCE(excluded.tx_sig, distributions.tx_sig)
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new IndexerDbError("insertDistribution: no rows");
  return row.id;
}

// ---------------------------------------------------------------------------
// Row-mapping helpers
// ---------------------------------------------------------------------------

type RawSettleEvent = {
  id: number;
  market_pubkey: string;
  ticker: string | null;
  expiry_unix: number | string;
  outcome: string;
  settle_price: string | null;
  settle_slot: number | string | null;
  tx_sig: string;
  observed_at: string;
};

function rowToSettleEvent(r: RawSettleEvent): SettleEvent {
  return {
    id: r.id,
    marketPubkey: r.market_pubkey,
    ticker: r.ticker ?? undefined,
    expiryUnix: Number(r.expiry_unix),
    outcome: r.outcome as SettleEvent["outcome"],
    settlePrice: r.settle_price ?? undefined,
    settleSlot: r.settle_slot !== null && r.settle_slot !== undefined ? Number(r.settle_slot) : undefined,
    txSig: r.tx_sig,
    observedAt: new Date(r.observed_at),
  };
}

type RawUserMarketHold = {
  id: number;
  settle_event_id: number;
  user_pubkey: string;
  market_pubkey: string;
  yes_held: string;
  no_held: string;
  outcome: string;
  result: string;
  observed_at: string;
};

function rowToUserMarketHold(r: RawUserMarketHold): UserMarketHold {
  return {
    id: r.id,
    settleEventId: r.settle_event_id,
    userPubkey: r.user_pubkey,
    marketPubkey: r.market_pubkey,
    yesHeld: r.yes_held,
    noHeld: r.no_held,
    outcome: r.outcome as UserMarketHold["outcome"],
    result: r.result as UserMarketHold["result"],
    observedAt: new Date(r.observed_at),
  };
}

type RawUserStreak = {
  user_pubkey: string;
  current_streak: number;
  longest_streak: number;
  total_markets_won: number;
  total_markets_traded: number;
  last_result: string | null;
  last_settle_at: string | null;
  updated_at: string;
};

function rowToUserStreak(r: RawUserStreak): UserStreak {
  return {
    userPubkey: r.user_pubkey,
    currentStreak: r.current_streak,
    longestStreak: r.longest_streak,
    totalMarketsWon: r.total_markets_won,
    totalMarketsTraded: r.total_markets_traded,
    lastResult: (r.last_result ?? undefined) as UserStreak["lastResult"],
    lastSettleAt: r.last_settle_at ? new Date(r.last_settle_at) : undefined,
    updatedAt: new Date(r.updated_at),
  };
}

type RawLeaderboardSnapshot = {
  id: number;
  period_kind: string;
  period_id: number;
  period_start: string;
  period_end: string;
  merkle_root: string | null;
  arweave_tx_id: string | null;
  committed_tx_sig: string | null;
  participants_count: number;
  full_leaderboard_json: LeaderboardEntry[];
  created_at: string;
};

function rowToSnapshot(r: RawLeaderboardSnapshot): LeaderboardSnapshot {
  return {
    id: r.id,
    periodKind: r.period_kind as PeriodKind,
    periodId: r.period_id,
    periodStart: new Date(r.period_start),
    periodEnd: new Date(r.period_end),
    merkleRoot: r.merkle_root ?? undefined,
    arweaveTxId: r.arweave_tx_id ?? undefined,
    committedTxSig: r.committed_tx_sig ?? undefined,
    participantsCount: r.participants_count,
    fullLeaderboardJson: r.full_leaderboard_json,
    createdAt: new Date(r.created_at),
  };
}
