// TypeScript shapes that mirror db/migrations/0001_dr010_initial.sql.
// Keep in lockstep with the SQL — when adding columns, update both.

export type Outcome = "yes" | "no" | "invalid" | "unsettled";

export type SettleEvent = {
  id: number;
  marketPubkey: string;
  ticker: string | undefined;
  expiryUnix: number;
  outcome: Outcome;
  settlePrice: string | undefined; // NUMERIC → string via pg
  settleSlot: number | undefined;
  txSig: string;
  observedAt: Date;
};

export type SettleEventInput = Omit<SettleEvent, "id" | "observedAt">;

export type HoldResult = "won" | "lost" | "abstained" | "invalid";

export type UserMarketHold = {
  id: number;
  settleEventId: number;
  userPubkey: string;
  marketPubkey: string;
  yesHeld: string;
  noHeld: string;
  outcome: Outcome;
  result: HoldResult;
  observedAt: Date;
};

export type UserMarketHoldInput = Omit<UserMarketHold, "id" | "observedAt">;

export type UserStreak = {
  userPubkey: string;
  currentStreak: number;
  longestStreak: number;
  totalMarketsWon: number;
  totalMarketsTraded: number;
  lastResult: HoldResult | undefined;
  lastSettleAt: Date | undefined;
  updatedAt: Date;
};

export type PeriodKind = "weekly" | "monthly";

export type LeaderboardEntry = {
  userPubkey: string;
  currentStreak: number;
  longestStreak: number;
  totalMarketsTraded: number;
  totalMarketsWon: number;
};

export type LeaderboardSnapshot = {
  id: number;
  periodKind: PeriodKind;
  periodId: number;
  periodStart: Date;
  periodEnd: Date;
  merkleRoot: string | undefined;
  arweaveTxId: string | undefined;
  committedTxSig: string | undefined;
  participantsCount: number;
  fullLeaderboardJson: LeaderboardEntry[];
  createdAt: Date;
};

export type SnapshotInput = Omit<LeaderboardSnapshot, "id" | "createdAt">;

export type Distribution = {
  id: number;
  snapshotId: number;
  position: number;
  userPubkey: string | undefined;
  amountUsdc: string;
  txSig: string | undefined;
  merkleProof: string[] | undefined;
  distributedAt: Date;
};

export type DistributionInput = Omit<Distribution, "id" | "distributedAt">;
