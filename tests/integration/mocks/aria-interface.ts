// Aria interface mock — Drew, Day-3 reconciled (Fri 2026-05-22).
//
// Source-of-truth for these shapes: the deployed program's IDL at
// `programs/bell-markets/idl/bell_markets.json` (Anchor 0.31 spec v0.1.0,
// program `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` on devnet, 9
// instructions as of Day-3 redeploy).
//
// Cross-checked against Aria's handler source at
// `programs/bell-markets/src/{state,instructions/*}.rs`. Field names are the
// camelCase form `@coral-xyz/anchor` 0.30.1 returns when decoding accounts.
//
// What's different from Day-1 mock (drift catalog):
//   - On-chain MarketConfig has `usdcMint, treasury, bump, _reserved` — Day-1
//     mock had `supportedTickers, pythFeedMap` (NEITHER exists on chain).
//   - On-chain StrikeMarket has NO `ticker`, NO `pairsOutstanding`, NO
//     `createdAt`. Vault USDC balance IS the source of truth for outstanding
//     pairs. `settledAtUnix: i64` uses 0 = unsettled (not nullable).
//   - Outcome is 4-variant (Unsettled / Yes / No / Invalid), wire form
//     `{ unsettled: {} } | { yes: {} } | { no: {} } | { invalid: {} }`.
//   - `mint_pair(amount: u64)` takes micro-USDC, not "pairs."
//   - `redeem(amount: u64)` burns ONLY the winning side (single `winning_mint`).
//   - `redeem_invalid(amount: u64)` — Day-3 new 9th instruction — burns equal
//     amounts of YES + NO and refunds `amount` USDC. For Invalid outcomes only.
//   - `admin_settle(forcedOutcome: Outcome)` — admin chooses outcome directly;
//     settle_price=0 stays as admin-pathed discriminator.
//   - `settle_market()` — no args; pyth feed is an Account.

// ─── Domain primitives ────────────────────────────────────────────────────

/** Solana base58 pubkey. String at the mock boundary; PublicKey once we use web3.js. */
export type Pubkey = string;

/** USDC, 6-decimal native units (e.g., $1.00 = 1_000_000n). YES/NO mints share decimals. */
export type UsdcMicros = bigint;

/** Outcome — borsh enum, 1-byte discriminant. Wire form from Anchor JS client:
 *  `{ unsettled: {} } | { yes: {} } | { no: {} } | { invalid: {} }`. */
export type Outcome =
  | { unsettled: Record<string, never> }
  | { yes: Record<string, never> }
  | { no: Record<string, never> }
  | { invalid: Record<string, never> };

export const OUTCOME_UNSETTLED: Outcome = { unsettled: {} };
export const OUTCOME_YES: Outcome       = { yes: {} };
export const OUTCOME_NO: Outcome        = { no: {} };
export const OUTCOME_INVALID: Outcome   = { invalid: {} };

export function outcomeKind(o: Outcome): "unsettled" | "yes" | "no" | "invalid" {
  if ("unsettled" in o) return "unsettled";
  if ("yes" in o)       return "yes";
  if ("no" in o)        return "no";
  return "invalid";
}

// ─── On-chain account shapes (mirror programs/bell-markets/idl/bell_markets.json) ─────────

/** PDA seeds: `["config"]`. Singleton per program. */
export interface MarketConfig {
  admin: Pubkey;
  usdcMint: Pubkey;
  treasury: Pubkey;
  priceStalenessSecs: bigint;          // i64
  priceConfidenceBps: number;          // u16
  adminOverrideDelaySecs: bigint;      // i64
  paused: boolean;
  bump: number;                        // u8
  _reserved: Uint8Array;               // [u8; 64]
}

/** PDA seeds: `["strike", underlyingPythFeed, expiryUnix.le_bytes(), strikePrice.le_bytes()]`. */
export interface StrikeMarket {
  config: Pubkey;
  underlyingPythFeed: Pubkey;
  strikePrice: bigint;                 // i64; micro-USDC
  expiryUnix: bigint;                  // i64; unix seconds
  yesMint: Pubkey;                     // PDA seeds: ["yes", strikeMarket]
  noMint: Pubkey;                      // PDA seeds: ["no", strikeMarket]
  usdcVault: Pubkey;                   // PDA seeds: ["vault", strikeMarket]
  phoenixMarket: Pubkey;
  settlePrice: bigint;                 // i64; 0 for admin-pathed settles
  settleConfidence: bigint;            // u64
  settleSlot: bigint;                  // u64
  settledAtUnix: bigint;               // i64; 0 if unsettled
  outcome: Outcome;
  adminOverrideEligibleAt: bigint;     // i64; expiry + adminOverrideDelaySecs
  /** DR-005 / DR-008: pubkey that paid rent to create the strike PDA. Immutable post-create.
   *  Drives DR-008 creator-rebate logic in mint_pair. Set by `user_create_strike_market`
   *  (signer is creator) OR `create_strike_market` (admin signer; admin is creator). */
  creator: Pubkey;
  bump: number;                        // u8
  yesMintBump: number;
  noMintBump: number;
  vaultBump: number;
  _reserved: Uint8Array;               // [u8; 64]
}

/** DR-005: per-ticker (per-Pyth-feed) config. PDA seeds: ["ticker_config", pythFeed]. */
export interface TickerConfig {
  pythFeed: Pubkey;
  maxUserStrikeDeviationBps: number;  // u16; e.g., 1500 for AAPL = 15%
  strikeTickSize: bigint;             // u64 micro-USDC; e.g., $1 = 1_000_000 for AAPL
  capCenter: bigint;                  // i64 micro-USDC; reference spot for deviation check
  thresholdBps: number;               // u16; wild-swing threshold (per DR-006)
  lastUpdatedSlot: bigint;            // u64
  bump: number;
}

/** DR-008: per-user volume tracker. PDA seeds: ["user_config", user]. */
export interface UserConfig {
  user: Pubkey;
  mintVolume30d: bigint;              // u64 micro-USDC; rolling 30-day mint volume for tier
  bump: number;
}

/** DR-008 / DR-010: separate global singleton (not appended to MarketConfig — sidesteps
 *  destructive realloc on devnet). PDA seeds: ["fee_config"]. */
export interface FeeConfig {
  config: Pubkey;                     // back-pointer to MarketConfig PDA
  mintFeeBps: number;                 // u16; 0 = mechanism disabled
  platformRetainBps: number;          // u16; default 5000 (50%)
  weeklyPoolBps: number;              // u16; default 2500 (25%)
  monthlyPoolBps: number;             // u16; default 2500 (25%)
  creatorRebateBps: number;           // u16; default 10000 (100% rebate = creator pays 0%)
  forceRedeemGraceSecs: bigint;       // i64; default 30 days
  weeklyDistributionBps: number[];    // [u16; 10]; default [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400]
  monthlyDistributionBps: number[];   // [u16; 10]; same default
  bump: number;
}

/** DR-010: stores Merkle roots for past leaderboard periods. PDA seeds: ["leaderboard_commitments"]. */
export interface LeaderboardCommitment {
  periodId: bigint;                   // u64
  periodType: number;                 // u8; 0 = weekly, 1 = monthly
  merkleRoot: Uint8Array;             // [u8; 32]
  arweaveTxId: Uint8Array;            // [u8; 48]
  committedAtSlot: bigint;
}

/** Off-chain view models (mirror specs/architecture.md §4). Not stored on chain. */
export interface StrikeMarketView {
  marketId: Pubkey;
  ticker: string;                       // derived from underlyingPythFeed → ticker map (off-chain)
  strikeUsd: number;                    // human-readable from strikePrice / 1e6
  expiry: Date;
  yesBidPrice?: number;
  yesAskPrice?: number;
  noBidPrice?: number;
  noAskPrice?: number;
  impliedYesProbability?: number;
  outcome: Outcome;
  isSettled: boolean;
}

/** User position is computed from token-account balances. No on-chain `Position` account. */
export interface UserPositionView {
  marketId: Pubkey;
  wallet: Pubkey;
  yesBalance: bigint;                   // micro-YES
  noBalance: bigint;                    // micro-NO
}

// ─── Instruction surface (9 instructions per IDL) ──────────────────────────

export interface AriaProgram {
  // Admin-only
  initializeConfig(args: InitializeConfigArgs): Promise<TxResult>;
  createStrikeMarket(args: CreateStrikeMarketArgs): Promise<TxResult & { marketId: Pubkey }>;
  addStrike(args: AddStrikeArgs): Promise<TxResult>;
  pause(args: PauseArgs): Promise<TxResult>;
  adminSettle(args: AdminSettleArgs): Promise<TxResult>;   // time-delay gated; takes forcedOutcome

  // Permissionless (DR-002) / user-callable
  mintPair(args: MintPairArgs): Promise<TxResult>;
  settleMarket(args: SettleMarketArgs): Promise<TxResult>;
  redeem(args: RedeemArgs): Promise<TxResult>;             // single winning side only (post-settle Yes/No)
  redeemInvalid(args: RedeemInvalidArgs): Promise<TxResult>; // Day-3: refund both sides for Invalid markets (post-settle)
  redeemPair(args: RedeemPairArgs): Promise<TxResult>;     // Day-4: inverse of mint_pair (pre-settle only)

  // Day-5 new (DR-005 / DR-006 / DR-008 / DR-010)
  userCreateStrikeMarket(args: UserCreateStrikeMarketArgs): Promise<TxResult & { marketId: Pubkey }>;  // DR-005 permissionless
  updateTickerConfig(args: UpdateTickerConfigArgs): Promise<TxResult>;                                  // DR-006 admin
  forceRedeem(args: ForceRedeemArgs): Promise<TxResult>;                                                // DR-005 admin escape valve
  closeSettledMarket(args: CloseSettledMarketArgs): Promise<TxResult>;                                  // DR-005 permissionless rent recovery
  initializeFeeConfig(args: InitializeFeeConfigArgs): Promise<TxResult>;                                // DR-008 admin setup
  updateFeeConfig(args: UpdateFeeConfigArgs): Promise<TxResult>;                                        // DR-008 admin
  initializeRewardsPools(args: InitializeRewardsPoolsArgs): Promise<TxResult>;                          // DR-010 admin setup
  commitLeaderboardRoot(args: CommitLeaderboardRootArgs): Promise<TxResult>;                            // DR-010 admin
  distributeWeeklyRewards(args: DistributeRewardsArgs): Promise<TxResult>;                              // DR-010 admin
  distributeMonthlyRewards(args: DistributeRewardsArgs): Promise<TxResult>;                             // DR-010 admin

  // Read helpers
  fetchMarketConfig(): Promise<MarketConfig>;
  fetchStrikeMarket(marketId: Pubkey): Promise<StrikeMarket>;
  fetchUserPosition(marketId: Pubkey, wallet: Pubkey): Promise<UserPositionView>;
  fetchVaultBalance(marketId: Pubkey): Promise<UsdcMicros>;
  fetchFeeConfig(): Promise<FeeConfig | null>;
  fetchUserConfig(user: Pubkey): Promise<UserConfig>;
  fetchTickerConfig(pythFeed: Pubkey): Promise<TickerConfig | null>;
  fetchPoolBalances(): Promise<{ feeCollector: UsdcMicros; weekly: UsdcMicros; monthly: UsdcMicros }>;
}

export interface TxResult {
  signature: string;
  slot: bigint;
  blockTime: bigint;
}

export interface InitializeConfigArgs {
  admin: Pubkey;                        // signer
  usdcMint: Pubkey;
  treasury: Pubkey;
  priceStalenessSecs: bigint;
  priceConfidenceBps: number;
  adminOverrideDelaySecs: bigint;
}

export interface CreateStrikeMarketArgs {
  admin: Pubkey;                        // signer; must equal config.admin
  underlyingPythFeed: Pubkey;
  strikePrice: bigint;                  // i64; > 0
  expiryUnix: bigint;                   // i64; > now
  phoenixMarket: Pubkey;                // must pass 8-byte magic check
}

export type AddStrikeArgs = { admin: Pubkey };
export interface PauseArgs { admin: Pubkey; paused: boolean }

export interface MintPairArgs {
  user: Pubkey;
  marketId: Pubkey;
  amount: UsdcMicros;                   // u64 micro-USDC; mints `amount` YES + NO
}

export interface SettleMarketArgs {
  settler: Pubkey;                      // permissionless
  marketId: Pubkey;
}

export interface AdminSettleArgs {
  admin: Pubkey;
  marketId: Pubkey;
  forcedOutcome: Outcome;               // must NOT be Unsettled
}

export interface RedeemArgs {
  user: Pubkey;
  marketId: Pubkey;
  amount: UsdcMicros;                   // burn `amount` of winning mint, receive `amount` USDC
}

export interface RedeemInvalidArgs {
  user: Pubkey;
  marketId: Pubkey;
  amount: UsdcMicros;                   // burn `amount` YES + `amount` NO, receive `amount` USDC
}

/** Day-4: pre-settlement pair burn (inverse of mint_pair). Gated to Outcome::Unsettled.
 *  Identical wire shape to redeem_invalid but opposite outcome gate. */
export interface RedeemPairArgs {
  user: Pubkey;
  marketId: Pubkey;
  amount: UsdcMicros;                   // burn `amount` YES + `amount` NO, receive `amount` USDC
}

// ─── Day-5 Args (DR-005/006/008/010) ──────────────────────────────────────

export interface UserCreateStrikeMarketArgs {
  user: Pubkey;                         // signer; pays SOL rent for the new PDA
  underlyingPythFeed: Pubkey;
  strikePrice: bigint;                  // i64; must align to TickerConfig.strikeTickSize
  expiryUnix: bigint;                   // i64; must be future
  phoenixMarket: Pubkey;
  // Pyth gate at create time per DR-005 spec — mock supports pythBehavior via createMockAria opts.
}

export interface UpdateTickerConfigArgs {
  admin: Pubkey;
  pythFeed: Pubkey;
  capCenter?: bigint;
  maxUserStrikeDeviationBps?: number;
  strikeTickSize?: bigint;
  thresholdBps?: number;
}

export interface ForceRedeemArgs {
  admin: Pubkey;                        // signer; only after settled_at + grace_secs
  marketId: Pubkey;
  user: Pubkey;                         // recipient (long-tail holder being force-redeemed)
  amount: UsdcMicros;
}

export interface CloseSettledMarketArgs {
  closer: Pubkey;                       // permissionless; any signer
  marketId: Pubkey;
}

export interface InitializeFeeConfigArgs {
  admin: Pubkey;                        // signer
  mintFeeBps?: number;                  // default 0 (mechanism disabled until admin enables)
  platformRetainBps?: number;           // default 5000
  weeklyPoolBps?: number;               // default 2500
  monthlyPoolBps?: number;              // default 2500
  creatorRebateBps?: number;            // default 10000
  forceRedeemGraceSecs?: bigint;        // default 30 days
  weeklyDistributionBps?: number[];     // default per DR-010 table
  monthlyDistributionBps?: number[];
}

export interface UpdateFeeConfigArgs {
  admin: Pubkey;
  mintFeeBps?: number;
  platformRetainBps?: number;
  weeklyPoolBps?: number;
  monthlyPoolBps?: number;
  creatorRebateBps?: number;
  forceRedeemGraceSecs?: bigint;
  weeklyDistributionBps?: number[];
  monthlyDistributionBps?: number[];
}

export type InitializeRewardsPoolsArgs = { admin: Pubkey };

export interface CommitLeaderboardRootArgs {
  admin: Pubkey;
  periodId: bigint;
  periodType: 0 | 1;                    // 0 = weekly, 1 = monthly
  merkleRoot: Uint8Array;               // [u8; 32]
  arweaveTxId: Uint8Array;              // [u8; 48]
}

export interface DistributeRewardsArgs {
  admin: Pubkey;
  periodId: bigint;
  recipient: Pubkey;
  position: number;                     // u8; 0..9
  amount: UsdcMicros;
  merkleProof: Uint8Array[];            // each entry is [u8; 32]; verified against committed root
}

// ─── Mock implementation (offline; for simulation + offline tests) ─────────

export interface MockState {
  config: MarketConfig | null;
  markets: Map<Pubkey, StrikeMarket>;
  positions: Map<string /* `${marketId}:${wallet}` */, UserPositionView>;
  vaults: Map<Pubkey, UsdcMicros>;
  blockTime: bigint;
  slot: bigint;
  txLog: Array<{ kind: string; details: unknown; blockTime: bigint }>;
  // Day-5 state
  feeConfig: FeeConfig | null;
  userConfigs: Map<Pubkey, UserConfig>;
  tickerConfigs: Map<Pubkey, TickerConfig>;
  weeklyPool: UsdcMicros;
  monthlyPool: UsdcMicros;
  feeCollector: UsdcMicros;
  leaderboardCommitments: Map<string /* `${periodType}:${periodId}` */, LeaderboardCommitment>;
  distributionsClaimed: Set<string /* `${periodType}:${periodId}:${recipient}:${position}` */>;
  /** Markets closed via close_settled_market — tracked so the mock can reject re-close. */
  closedMarkets: Set<Pubkey>;
}

export const DEFAULT_FEE_CONFIG: Omit<FeeConfig, "config" | "bump"> = {
  mintFeeBps: 0,                        // Disabled by default; admin enables via update.
  platformRetainBps: 5000,
  weeklyPoolBps: 2500,
  monthlyPoolBps: 2500,
  creatorRebateBps: 10000,              // 100% rebate = creator pays 0% fee
  forceRedeemGraceSecs: 30n * 24n * 60n * 60n,    // 30 days
  weeklyDistributionBps: [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400],
  monthlyDistributionBps: [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400],
};

export interface MockOptions {
  pythBehavior?: "tight" | "wide" | "stale" | "notTrading";
  pythClosePrice?: bigint;
  pythPublishSlotOffset?: bigint;
}

export const ONE_USDC: UsdcMicros = 1_000_000n;

/**
 * Helper shared between distributeWeeklyRewards + distributeMonthlyRewards.
 * Verifies admin + commitment exists + Merkle proof recomputes to committed root +
 * idempotency (no double-claim per period/recipient/position).
 *
 * Mock Merkle verification: leaf = sha256(recipient || position || amount); proof is
 * a Vec<[u8;32]> walked into root via sha256(leftConcatRight). Real on-chain handler
 * uses the same primitive (sha256, sorted-pair concat). This is structurally close
 * enough to catch tampering bugs without pulling in the real Merkle crate.
 */
function distributeRewardsImpl(
  args: DistributeRewardsArgs,
  periodType: 0 | 1,
  state: MockState,
  log: (kind: string, details: unknown) => void,
  tx: () => TxResult,
): TxResult {
  if (!state.config) throw new Error("distributeRewards: config not initialized");
  if (state.config.admin !== args.admin) throw new Error("distributeRewards: NotAdmin");
  if (!state.feeConfig) throw new Error("distributeRewards: FeeConfigNotInitialized");
  if (args.amount === 0n) throw new Error("distributeRewards: ZeroAmount");
  // Position is 1-indexed per Rust `is_valid_position` (>= 1, <= 10). Sonnet
  // audit 2026-05-23 caught the missing lower bound; mock previously accepted
  // position=0 which the on-chain handler would revert with InvalidDistributionPosition.
  if (args.position < 1 || args.position > 10) {
    throw new Error("distributeRewards: InvalidDistributionPosition (1..10)");
  }

  const key = `${periodType}:${args.periodId}`;
  const commitment = state.leaderboardCommitments.get(key);
  if (!commitment) {
    throw new Error(`distributeRewards: NoCommitmentForPeriod (period ${periodType}:${args.periodId} not committed)`);
  }

  // Idempotency: per period × recipient × position, only one claim allowed.
  const claimKey = `${periodType}:${args.periodId}:${args.recipient}:${args.position}`;
  if (state.distributionsClaimed.has(claimKey)) {
    throw new Error(`distributeRewards: AlreadyClaimed`);
  }

  // Merkle proof verification (mock).
  // Leaf format mirrors Aria's `merkle.rs::compute_leaf` field set (recipient,
  // position, period_id, period_type, amount). String encoding instead of
  // Aria's binary [u8;50] — see mockMerkleLeaf docstring for the why.
  const computed = mockMerkleVerify(
    args.recipient, args.position, args.periodId, periodType, args.amount,
    args.merkleProof, commitment.merkleRoot,
  );
  if (!computed) {
    throw new Error("distributeRewards: InvalidProof");
  }

  // Distribute from the appropriate pool.
  const poolBalance = periodType === 0 ? state.weeklyPool : state.monthlyPool;
  if (poolBalance < args.amount) {
    throw new Error(`distributeRewards: PoolUnderfunded (have=${poolBalance}, want=${args.amount})`);
  }
  if (periodType === 0) state.weeklyPool -= args.amount;
  else state.monthlyPool -= args.amount;

  state.distributionsClaimed.add(claimKey);
  log(periodType === 0 ? "distributeWeeklyRewards" : "distributeMonthlyRewards", {
    admin: args.admin, periodId: args.periodId, recipient: args.recipient, position: args.position, amount: args.amount,
  });
  return tx();
}

/**
 * Mock Merkle leaf computation. Matches Aria's `merkle.rs::compute_leaf`
 * structurally (includes ALL 5 fields: recipient, position, period_id,
 * period_type, amount) but uses a string encoding instead of binary.
 *
 * Why string vs Aria's binary [u8;50]: mock recipient is a JS string label
 * (e.g., "alice-pubkey") not a real base58 Pubkey, so binary `recipient.as_ref()`
 * has no equivalent. The mock is SELF-CONSISTENT (both leaf-builder + verifier
 * use this same format) — tests catch any field-tampering bug. Cannot verify
 * real on-chain proofs from Bram's indexer; that's a deferred concern when we
 * want to integration-test against the indexer's output specifically.
 *
 * Critical fix (Sonnet audit 2026-05-23): earlier version omitted period_id +
 * period_type from the leaf, causing tests to pass for the wrong reason
 * (same leaf accepted across periods).
 */
export function mockMerkleLeaf(
  recipient: Pubkey,
  position: number,
  periodId: bigint,
  periodType: 0 | 1,
  amount: UsdcMicros,
): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const leafStr = `${recipient}:${position}:${periodId.toString()}:${periodType}:${amount.toString()}`;
  return new Uint8Array(createHash("sha256").update(leafStr).digest());
}

/** Walks a proof from leaf to root using sorted-pair sha256 (matches OpenZeppelin
 *  + Aria's `verify_merkle_proof`). Sibling at each level is concat'd with the
 *  lexicographically-smaller half first. */
export function mockMerkleVerifyProof(
  leaf: Uint8Array,
  proof: Uint8Array[],
  expectedRoot: Uint8Array,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());

  let cur = leaf;
  for (const sib of proof) {
    const [a, b] = compareBytes(cur, sib) < 0 ? [cur, sib] : [sib, cur];
    const concat = new Uint8Array(a.length + b.length);
    concat.set(a, 0);
    concat.set(b, a.length);
    cur = sha256(concat);
  }
  return compareBytes(cur, expectedRoot) === 0;
}

/** Convenience for the distribute path — leaf-computes + walks proof. */
function mockMerkleVerify(
  recipient: Pubkey,
  position: number,
  periodId: bigint,
  periodType: 0 | 1,
  amount: UsdcMicros,
  proof: Uint8Array[],
  expectedRoot: Uint8Array,
): boolean {
  const leaf = mockMerkleLeaf(recipient, position, periodId, periodType, amount);
  return mockMerkleVerifyProof(leaf, proof, expectedRoot);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function createMockAria(opts: MockOptions = {}): { program: AriaProgram; state: MockState } {
  const state: MockState = {
    config: null,
    markets: new Map(),
    positions: new Map(),
    vaults: new Map(),
    blockTime: 0n,
    slot: 0n,
    txLog: [],
    feeConfig: null,
    userConfigs: new Map(),
    tickerConfigs: new Map(),
    weeklyPool: 0n,
    monthlyPool: 0n,
    feeCollector: 0n,
    leaderboardCommitments: new Map(),
    distributionsClaimed: new Set(),
    closedMarkets: new Set(),
  };

  const posKey = (m: Pubkey, w: Pubkey): string => `${m}:${w}`;
  const log = (kind: string, details: unknown): void => {
    state.txLog.push({ kind, details, blockTime: state.blockTime });
  };
  const tx = (): TxResult => ({
    signature: `mock-${state.txLog.length.toString().padStart(6, "0")}`,
    slot: state.slot,
    blockTime: state.blockTime,
  });

  function requireUnsettled(m: StrikeMarket, ix: string): void {
    if (outcomeKind(m.outcome) !== "unsettled") {
      throw new Error(`${ix}: AlreadySettled (outcome=${outcomeKind(m.outcome)})`);
    }
  }

  const program: AriaProgram = {
    async initializeConfig(args) {
      if (state.config) throw new Error("initializeConfig: already initialized");
      if (args.priceStalenessSecs <= 0n || args.priceStalenessSecs > 24n * 60n * 60n) {
        throw new Error("initializeConfig: InvalidConfigParam (staleness)");
      }
      if (args.priceConfidenceBps <= 0 || args.priceConfidenceBps > 1_000) {
        throw new Error("initializeConfig: InvalidConfigParam (confidence)");
      }
      if (args.adminOverrideDelaySecs <= 0n || args.adminOverrideDelaySecs > 7n * 24n * 60n * 60n) {
        throw new Error("initializeConfig: InvalidConfigParam (override delay)");
      }
      state.config = {
        admin: args.admin,
        usdcMint: args.usdcMint,
        treasury: args.treasury,
        priceStalenessSecs: args.priceStalenessSecs,
        priceConfidenceBps: args.priceConfidenceBps,
        adminOverrideDelaySecs: args.adminOverrideDelaySecs,
        paused: false,
        bump: 255,
        _reserved: new Uint8Array(64),
      };
      log("initializeConfig", { admin: args.admin });
      return tx();
    },

    async createStrikeMarket(args) {
      if (!state.config) throw new Error("createStrikeMarket: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("createStrikeMarket: NotAdmin");
      if (state.config.paused) throw new Error("createStrikeMarket: Paused");
      if (args.strikePrice <= 0n) throw new Error("createStrikeMarket: InvalidStrikePrice");
      if (args.expiryUnix <= state.blockTime) throw new Error("createStrikeMarket: ExpiryInPast");

      const marketId: Pubkey = `mock-strike-${args.underlyingPythFeed}-${args.expiryUnix}-${args.strikePrice}`;
      const market: StrikeMarket = {
        config: "mock-config-pda",
        underlyingPythFeed: args.underlyingPythFeed,
        strikePrice: args.strikePrice,
        expiryUnix: args.expiryUnix,
        yesMint: `${marketId}-yes-mint`,
        noMint:  `${marketId}-no-mint`,
        usdcVault: `${marketId}-vault`,
        phoenixMarket: args.phoenixMarket,
        settlePrice: 0n,
        settleConfidence: 0n,
        settleSlot: 0n,
        settledAtUnix: 0n,
        outcome: OUTCOME_UNSETTLED,
        adminOverrideEligibleAt: args.expiryUnix + state.config.adminOverrideDelaySecs,
        creator: args.admin,             // DR-005/008: admin is creator when admin-created
        bump: 254, yesMintBump: 253, noMintBump: 252, vaultBump: 251,
        _reserved: new Uint8Array(64),
      };
      state.markets.set(marketId, market);
      state.vaults.set(marketId, 0n);
      log("createStrikeMarket", { admin: args.admin, marketId, strikePrice: args.strikePrice, expiryUnix: args.expiryUnix });
      return { ...tx(), marketId };
    },

    async userCreateStrikeMarket(args) {
      // DR-005: permissionless; user is creator + pays SOL rent.
      if (!state.config) throw new Error("userCreateStrikeMarket: config not initialized");
      if (state.config.paused) throw new Error("userCreateStrikeMarket: Paused");
      if (args.strikePrice <= 0n) throw new Error("userCreateStrikeMarket: InvalidStrikePrice");
      if (args.expiryUnix <= state.blockTime) throw new Error("userCreateStrikeMarket: ExpiryInPast");

      const tc = state.tickerConfigs.get(args.underlyingPythFeed);
      if (!tc) throw new Error(`userCreateStrikeMarket: TickerConfigNotFound (brand-new ticker — cron must write TickerConfig first per DR-005 + DR-006)`);

      // Strike must align to tickerConfig.strikeTickSize grid.
      if (args.strikePrice % tc.strikeTickSize !== 0n) {
        throw new Error(`userCreateStrikeMarket: StrikeMisalignedTick (strike ${args.strikePrice} not aligned to tick ${tc.strikeTickSize})`);
      }

      // Strike must be within tc.maxUserStrikeDeviationBps of tc.capCenter.
      const dev = args.strikePrice > tc.capCenter ? args.strikePrice - tc.capCenter : tc.capCenter - args.strikePrice;
      const maxDev = (tc.capCenter * BigInt(tc.maxUserStrikeDeviationBps)) / 10_000n;
      if (dev > maxDev) {
        throw new Error(`userCreateStrikeMarket: StrikeBeyondDeviationCap (dev=${dev}, max=${maxDev})`);
      }

      // Pyth gate at create time (DR-005 §"Decision" bullet 4)
      if (opts.pythBehavior === "stale") throw new Error("userCreateStrikeMarket: PythStale");
      if (opts.pythBehavior === "wide") throw new Error("userCreateStrikeMarket: PythConfidenceTooWide");

      const marketId: Pubkey = `mock-strike-${args.underlyingPythFeed}-${args.expiryUnix}-${args.strikePrice}`;
      const market: StrikeMarket = {
        config: "mock-config-pda",
        underlyingPythFeed: args.underlyingPythFeed,
        strikePrice: args.strikePrice,
        expiryUnix: args.expiryUnix,
        yesMint: `${marketId}-yes-mint`,
        noMint:  `${marketId}-no-mint`,
        usdcVault: `${marketId}-vault`,
        phoenixMarket: args.phoenixMarket,
        settlePrice: 0n,
        settleConfidence: 0n,
        settleSlot: 0n,
        settledAtUnix: 0n,
        outcome: OUTCOME_UNSETTLED,
        adminOverrideEligibleAt: args.expiryUnix + state.config.adminOverrideDelaySecs,
        creator: args.user,              // DR-005: user is creator, drives DR-008 rebate logic
        bump: 254, yesMintBump: 253, noMintBump: 252, vaultBump: 251,
        _reserved: new Uint8Array(64),
      };
      state.markets.set(marketId, market);
      state.vaults.set(marketId, 0n);
      log("userCreateStrikeMarket", { user: args.user, marketId, strikePrice: args.strikePrice, expiryUnix: args.expiryUnix });
      return { ...tx(), marketId };
    },

    async addStrike(_args) {
      log("addStrike", { note: "no-op convenience per Aria handoff" });
      return tx();
    },

    async pause(args) {
      if (!state.config) throw new Error("pause: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("pause: NotAdmin");
      state.config.paused = args.paused;
      log("pause", { admin: args.admin, paused: args.paused });
      return tx();
    },

    async mintPair(args) {
      if (!state.config) throw new Error("mintPair: config not initialized");
      if (state.config.paused) throw new Error("mintPair: Paused");
      if (args.amount === 0n) throw new Error("mintPair: ZeroAmount");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`mintPair: market ${args.marketId} not found`);
      requireUnsettled(m, "mintPair");

      // DR-008 fee math. When FeeConfig.mintFeeBps == 0 (default), no fee — preserves
      // Day-1..4 behavior for tests that don't initialize FeeConfig.
      //
      // Tier scaling (Sonnet audit 2026-05-23 fix): Rust handler scales the raw
      // tier bps by `mint_fee_bps / 200` so that promo modes (mint_fee_bps != 200)
      // proportionally adjust the tier discount too. e.g., mint_fee_bps=100 →
      // tier1 effective is 100 bps (not 200). Earlier mock used raw tier_bps which
      // matched only the canonical 200-bps config.
      let fee = 0n;
      let creatorRebateFires = false;
      if (state.feeConfig && state.feeConfig.mintFeeBps > 0) {
        const fc = state.feeConfig;
        const userCfg = state.userConfigs.get(args.user) ?? {
          user: args.user, mintVolume30d: 0n, bump: 254,
        };
        let tierBps: number;
        if (userCfg.mintVolume30d < 1_000n * ONE_USDC)        tierBps = 200;
        else if (userCfg.mintVolume30d < 10_000n * ONE_USDC)  tierBps = 150;
        else                                                  tierBps = 100;

        // Scale tier by mint_fee_bps (matches Rust effective_bps formula).
        const scaledTierBps = Math.floor((tierBps * fc.mintFeeBps) / 200);

        // Creator rebate (DR-008): if signer == strikeMarket.creator AND market is Unsettled.
        const isCreator = m.creator === args.user;
        creatorRebateFires = isCreator && outcomeKind(m.outcome) === "unsettled";
        let effectiveBps = scaledTierBps;
        if (creatorRebateFires) {
          effectiveBps = Math.floor((scaledTierBps * (10000 - fc.creatorRebateBps)) / 10000);
        }
        fee = (args.amount * BigInt(effectiveBps)) / 10_000n;

        // 3-way split (DR-010)
        const platformShare = (fee * BigInt(fc.platformRetainBps)) / 10_000n;
        const weeklyShare = (fee * BigInt(fc.weeklyPoolBps)) / 10_000n;
        const monthlyShare = fee - platformShare - weeklyShare;        // remainder to avoid dust loss
        state.feeCollector += platformShare;
        state.weeklyPool += weeklyShare;
        state.monthlyPool += monthlyShare;

        // Gaming defense (DR-008): if creator rebate fired AT ALL, do NOT update mint_volume_30d.
        if (!creatorRebateFires) {
          userCfg.mintVolume30d += args.amount;
          state.userConfigs.set(args.user, userCfg);
        }
      }

      // Vault gets the principal (preserves $1 invariant); fee already siphoned above.
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) + args.amount);
      const key = posKey(args.marketId, args.user);
      const cur = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n,
      };
      cur.yesBalance += args.amount;
      cur.noBalance  += args.amount;
      state.positions.set(key, cur);
      log("mintPair", { user: args.user, marketId: args.marketId, amount: args.amount, fee, creatorRebateFires });
      return tx();
    },

    async settleMarket(args) {
      if (!state.config) throw new Error("settleMarket: config not initialized");
      if (state.config.paused) throw new Error("settleMarket: Paused");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`settleMarket: market ${args.marketId} not found`);
      requireUnsettled(m, "settleMarket");
      if (state.blockTime < m.expiryUnix) {
        throw new Error(`settleMarket: NotExpired (blockTime=${state.blockTime}, expiry=${m.expiryUnix})`);
      }
      if (opts.pythBehavior === "notTrading") throw new Error("settleMarket: PythNotTrading");
      if (opts.pythBehavior === "stale") throw new Error("settleMarket: PythStale");
      if (opts.pythBehavior === "wide")  throw new Error("settleMarket: PythConfidenceTooWide");

      const closePrice = opts.pythClosePrice ?? (m.strikePrice + 5n * ONE_USDC);
      m.outcome = closePrice >= m.strikePrice ? OUTCOME_YES : OUTCOME_NO;
      m.settlePrice = closePrice;
      m.settleConfidence = 100n;
      m.settleSlot = state.slot;
      m.settledAtUnix = state.blockTime;
      log("settleMarket", { settler: args.settler, marketId: args.marketId, settlePrice: closePrice, outcome: outcomeKind(m.outcome) });
      return tx();
    },

    async adminSettle(args) {
      if (!state.config) throw new Error("adminSettle: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("adminSettle: NotAdmin");
      if (state.config.paused) throw new Error("adminSettle: Paused");
      if (outcomeKind(args.forcedOutcome) === "unsettled") {
        throw new Error("adminSettle: ForcedOutcomeUnsettled");
      }
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`adminSettle: market ${args.marketId} not found`);
      requireUnsettled(m, "adminSettle");
      if (state.blockTime < m.adminOverrideEligibleAt) {
        throw new Error(`adminSettle: AdminOverrideTooEarly (eligible at ${m.adminOverrideEligibleAt}, now ${state.blockTime})`);
      }
      m.outcome = args.forcedOutcome;
      m.settledAtUnix = state.blockTime;
      log("adminSettle", { admin: args.admin, marketId: args.marketId, outcome: outcomeKind(args.forcedOutcome) });
      return tx();
    },

    async redeem(args) {
      if (!state.config) throw new Error("redeem: config not initialized");
      if (state.config.paused) throw new Error("redeem: Paused");
      if (args.amount === 0n) throw new Error("redeem: ZeroAmount");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`redeem: market ${args.marketId} not found`);

      const oc = outcomeKind(m.outcome);
      if (oc === "unsettled") throw new Error("redeem: NotSettled");
      if (oc === "invalid")   throw new Error("redeem: InvalidOutcomeForRedeem (use redeem_invalid)");

      const key = posKey(args.marketId, args.user);
      const pos = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n,
      };
      const winningBalance = oc === "yes" ? pos.yesBalance : pos.noBalance;
      if (args.amount > winningBalance) {
        throw new Error(`redeem: insufficient winning balance (have=${winningBalance}, want=${args.amount})`);
      }

      if (oc === "yes") pos.yesBalance -= args.amount;
      else              pos.noBalance  -= args.amount;
      state.positions.set(key, pos);
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - args.amount);

      log("redeem", { user: args.user, marketId: args.marketId, amount: args.amount, winningSide: oc });
      return tx();
    },

    async redeemPair(args) {
      // Day-4 instruction. Mirror-image of redeem_invalid but gated to
      // Outcome::Unsettled (pre-settlement only). Powers the atomic Sell No
      // flow in Cleo's POV-3: [phoenix.swap(yes->no), redeem_pair(amount)].
      if (!state.config) throw new Error("redeemPair: config not initialized");
      if (state.config.paused) throw new Error("redeemPair: Paused");
      if (args.amount === 0n) throw new Error("redeemPair: ZeroAmount");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`redeemPair: market ${args.marketId} not found`);
      // Outcome::Unsettled required — Aria uses AlreadySettled error code (not a
      // dedicated NotPreSettle) to signal post-settle calls. Matches Rust handler.
      if (outcomeKind(m.outcome) !== "unsettled") {
        throw new Error(`redeemPair: AlreadySettled (use redeem or redeem_invalid post-settle)`);
      }

      const key = posKey(args.marketId, args.user);
      const pos = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n,
      };
      if (args.amount > pos.yesBalance) {
        throw new Error(`redeemPair: insufficient YES (have=${pos.yesBalance}, want=${args.amount})`);
      }
      if (args.amount > pos.noBalance) {
        throw new Error(`redeemPair: insufficient NO (have=${pos.noBalance}, want=${args.amount})`);
      }

      pos.yesBalance -= args.amount;
      pos.noBalance  -= args.amount;
      state.positions.set(key, pos);
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - args.amount);

      log("redeemPair", { user: args.user, marketId: args.marketId, amount: args.amount });
      return tx();
    },

    async redeemInvalid(args) {
      if (!state.config) throw new Error("redeemInvalid: config not initialized");
      if (state.config.paused) throw new Error("redeemInvalid: Paused");
      if (args.amount === 0n) throw new Error("redeemInvalid: ZeroAmount");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`redeemInvalid: market ${args.marketId} not found`);
      if (outcomeKind(m.outcome) !== "invalid") {
        throw new Error(`redeemInvalid: InvalidOutcomeForRedeem (outcome=${outcomeKind(m.outcome)}; use redeem for Yes/No)`);
      }

      const key = posKey(args.marketId, args.user);
      const pos = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n,
      };
      if (args.amount > pos.yesBalance) {
        throw new Error(`redeemInvalid: insufficient YES (have=${pos.yesBalance}, want=${args.amount})`);
      }
      if (args.amount > pos.noBalance) {
        throw new Error(`redeemInvalid: insufficient NO (have=${pos.noBalance}, want=${args.amount})`);
      }

      pos.yesBalance -= args.amount;
      pos.noBalance  -= args.amount;
      state.positions.set(key, pos);
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - args.amount);

      log("redeemInvalid", { user: args.user, marketId: args.marketId, amount: args.amount });
      return tx();
    },

    // ─── Day-5 new (DR-005 / DR-006 / DR-008 / DR-010) ───────────────────

    async updateTickerConfig(args) {
      if (!state.config) throw new Error("updateTickerConfig: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("updateTickerConfig: NotAdmin");
      const existing = state.tickerConfigs.get(args.pythFeed);
      const tc: TickerConfig = existing ?? {
        pythFeed: args.pythFeed,
        maxUserStrikeDeviationBps: 1500,
        strikeTickSize: 1_000_000n,
        capCenter: 0n,
        thresholdBps: 400,
        lastUpdatedSlot: 0n,
        bump: 254,
      };
      if (args.capCenter !== undefined) tc.capCenter = args.capCenter;
      if (args.maxUserStrikeDeviationBps !== undefined) tc.maxUserStrikeDeviationBps = args.maxUserStrikeDeviationBps;
      if (args.strikeTickSize !== undefined) tc.strikeTickSize = args.strikeTickSize;
      if (args.thresholdBps !== undefined) tc.thresholdBps = args.thresholdBps;
      tc.lastUpdatedSlot = state.slot;
      state.tickerConfigs.set(args.pythFeed, tc);
      log("updateTickerConfig", { admin: args.admin, pythFeed: args.pythFeed });
      return tx();
    },

    async forceRedeem(args) {
      // DR-005 admin escape valve. Only after settled_at + grace_secs.
      if (!state.config) throw new Error("forceRedeem: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("forceRedeem: NotAdmin");
      if (state.config.paused) throw new Error("forceRedeem: Paused");
      if (args.amount === 0n) throw new Error("forceRedeem: ZeroAmount");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`forceRedeem: market ${args.marketId} not found`);
      if (outcomeKind(m.outcome) === "unsettled") throw new Error("forceRedeem: NotSettled");

      const grace = state.feeConfig?.forceRedeemGraceSecs ?? DEFAULT_FEE_CONFIG.forceRedeemGraceSecs;
      const eligibleAt = m.settledAtUnix + grace;
      // Sonnet audit 2026-05-23: Rust uses `require!(now > settled_at + grace)`
      // (strict-greater). Earlier mock used `<` which allowed `blockTime == eligibleAt`
      // through. Off-by-one at the boundary. Fixed to `<=` so eligibleAt itself
      // is the LAST rejected timestamp; valid range is blockTime > eligibleAt.
      if (state.blockTime <= eligibleAt) {
        throw new Error(`forceRedeem: ForceRedeemTooEarly (eligible at ${eligibleAt + 1n}, now ${state.blockTime})`);
      }

      const key = posKey(args.marketId, args.user);
      const pos = state.positions.get(key) ?? { marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n };
      // Admin can force-redeem regardless of which side won — pays out from vault.
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - args.amount);
      // Clear position (simulates burn-and-pay regardless of side).
      const oc = outcomeKind(m.outcome);
      if (oc === "yes") pos.yesBalance = pos.yesBalance > args.amount ? pos.yesBalance - args.amount : 0n;
      else if (oc === "no") pos.noBalance = pos.noBalance > args.amount ? pos.noBalance - args.amount : 0n;
      state.positions.set(key, pos);
      log("forceRedeem", { admin: args.admin, marketId: args.marketId, user: args.user, amount: args.amount });
      return tx();
    },

    async closeSettledMarket(args) {
      // DR-005 permissionless rent recovery. Closes mints + vault.
      if (!state.config) throw new Error("closeSettledMarket: config not initialized");
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`closeSettledMarket: market ${args.marketId} not found`);
      if (outcomeKind(m.outcome) === "unsettled") {
        throw new Error("closeSettledMarket: NotSettled (would orphan pair holders)");
      }
      if (state.closedMarkets.has(args.marketId)) {
        throw new Error("closeSettledMarket: AlreadyClosed");
      }

      // Pairs-outstanding check via vault balance (vault.amount == pairs_outstanding × $1).
      const vault = state.vaults.get(args.marketId) ?? 0n;
      if (vault > 0n) {
        throw new Error(`closeSettledMarket: PairsStillOutstanding (vault=${vault})`);
      }
      // Recovered rent flows to treasury per DR-005 §"Closed-rent recovery."
      const recoveredRent = 3n * 200_000n;  // mock: ~$0.60 total for yes_mint + no_mint + vault rent
      state.feeCollector += recoveredRent;
      state.closedMarkets.add(args.marketId);
      log("closeSettledMarket", { closer: args.closer, marketId: args.marketId, recoveredRent });
      return tx();
    },

    async initializeFeeConfig(args) {
      if (!state.config) throw new Error("initializeFeeConfig: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("initializeFeeConfig: NotAdmin");
      if (state.feeConfig) throw new Error("initializeFeeConfig: AlreadyInitialized");
      state.feeConfig = {
        config: "mock-config-pda",
        mintFeeBps: args.mintFeeBps ?? DEFAULT_FEE_CONFIG.mintFeeBps,
        platformRetainBps: args.platformRetainBps ?? DEFAULT_FEE_CONFIG.platformRetainBps,
        weeklyPoolBps: args.weeklyPoolBps ?? DEFAULT_FEE_CONFIG.weeklyPoolBps,
        monthlyPoolBps: args.monthlyPoolBps ?? DEFAULT_FEE_CONFIG.monthlyPoolBps,
        creatorRebateBps: args.creatorRebateBps ?? DEFAULT_FEE_CONFIG.creatorRebateBps,
        forceRedeemGraceSecs: args.forceRedeemGraceSecs ?? DEFAULT_FEE_CONFIG.forceRedeemGraceSecs,
        weeklyDistributionBps: args.weeklyDistributionBps ?? [...DEFAULT_FEE_CONFIG.weeklyDistributionBps],
        monthlyDistributionBps: args.monthlyDistributionBps ?? [...DEFAULT_FEE_CONFIG.monthlyDistributionBps],
        bump: 254,
      };
      // Sum-validation (DR-010): platform + weekly + monthly must == 10_000.
      const sum = state.feeConfig.platformRetainBps + state.feeConfig.weeklyPoolBps + state.feeConfig.monthlyPoolBps;
      if (sum !== 10_000) {
        state.feeConfig = null;
        throw new Error(`initializeFeeConfig: FeeBpsSumMismatch (sum=${sum}, expected 10_000)`);
      }
      log("initializeFeeConfig", { admin: args.admin });
      return tx();
    },

    async updateFeeConfig(args) {
      if (!state.config) throw new Error("updateFeeConfig: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("updateFeeConfig: NotAdmin");
      if (!state.feeConfig) throw new Error("updateFeeConfig: FeeConfigNotInitialized");
      const fc = state.feeConfig;
      if (args.mintFeeBps !== undefined) fc.mintFeeBps = args.mintFeeBps;
      if (args.platformRetainBps !== undefined) fc.platformRetainBps = args.platformRetainBps;
      if (args.weeklyPoolBps !== undefined) fc.weeklyPoolBps = args.weeklyPoolBps;
      if (args.monthlyPoolBps !== undefined) fc.monthlyPoolBps = args.monthlyPoolBps;
      if (args.creatorRebateBps !== undefined) fc.creatorRebateBps = args.creatorRebateBps;
      if (args.forceRedeemGraceSecs !== undefined) fc.forceRedeemGraceSecs = args.forceRedeemGraceSecs;
      if (args.weeklyDistributionBps !== undefined) fc.weeklyDistributionBps = [...args.weeklyDistributionBps];
      if (args.monthlyDistributionBps !== undefined) fc.monthlyDistributionBps = [...args.monthlyDistributionBps];
      // Sum-validation
      const sum = fc.platformRetainBps + fc.weeklyPoolBps + fc.monthlyPoolBps;
      if (sum !== 10_000) throw new Error(`updateFeeConfig: FeeBpsSumMismatch (sum=${sum})`);
      log("updateFeeConfig", { admin: args.admin });
      return tx();
    },

    async initializeRewardsPools(args) {
      if (!state.config) throw new Error("initializeRewardsPools: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("initializeRewardsPools: NotAdmin");
      // Mock: just confirm pool counters are at 0 (they already are by init).
      log("initializeRewardsPools", { admin: args.admin });
      return tx();
    },

    async commitLeaderboardRoot(args) {
      if (!state.config) throw new Error("commitLeaderboardRoot: config not initialized");
      if (state.config.admin !== args.admin) throw new Error("commitLeaderboardRoot: NotAdmin");
      if (args.merkleRoot.length !== 32) throw new Error("commitLeaderboardRoot: InvalidRootLength");
      if (args.arweaveTxId.length !== 48) throw new Error("commitLeaderboardRoot: InvalidArweaveIdLength");
      if (args.periodType !== 0 && args.periodType !== 1) throw new Error("commitLeaderboardRoot: InvalidPeriodType");
      const key = `${args.periodType}:${args.periodId}`;
      if (state.leaderboardCommitments.has(key)) throw new Error("commitLeaderboardRoot: PeriodAlreadyCommitted");
      state.leaderboardCommitments.set(key, {
        periodId: args.periodId,
        periodType: args.periodType,
        merkleRoot: args.merkleRoot,
        arweaveTxId: args.arweaveTxId,
        committedAtSlot: state.slot,
      });
      log("commitLeaderboardRoot", { admin: args.admin, periodId: args.periodId, periodType: args.periodType });
      return tx();
    },

    async distributeWeeklyRewards(args) {
      return distributeRewardsImpl(args, /* periodType */ 0, state, log, tx);
    },

    async distributeMonthlyRewards(args) {
      return distributeRewardsImpl(args, /* periodType */ 1, state, log, tx);
    },

    async fetchFeeConfig() {
      return state.feeConfig;
    },
    async fetchUserConfig(user) {
      return state.userConfigs.get(user) ?? { user, mintVolume30d: 0n, bump: 254 };
    },
    async fetchTickerConfig(pythFeed) {
      return state.tickerConfigs.get(pythFeed) ?? null;
    },
    async fetchPoolBalances() {
      return { feeCollector: state.feeCollector, weekly: state.weeklyPool, monthly: state.monthlyPool };
    },

    async fetchMarketConfig() {
      if (!state.config) throw new Error("fetchMarketConfig: not initialized");
      return state.config;
    },

    async fetchStrikeMarket(marketId) {
      const m = state.markets.get(marketId);
      if (!m) throw new Error(`fetchStrikeMarket: ${marketId} not found`);
      return m;
    },

    async fetchUserPosition(marketId, wallet) {
      const live = state.positions.get(posKey(marketId, wallet));
      if (!live) return { marketId, wallet, yesBalance: 0n, noBalance: 0n };
      return { marketId: live.marketId, wallet: live.wallet, yesBalance: live.yesBalance, noBalance: live.noBalance };
    },

    async fetchVaultBalance(marketId) {
      return state.vaults.get(marketId) ?? 0n;
    },
  };

  return { program, state };
}

/** Advance the mock's Clock.unix_timestamp + Clock.slot (~2.5 slots/sec at 400ms each). */
export function advanceBlockTime(state: MockState, seconds: number | bigint): void {
  const s = typeof seconds === "bigint" ? seconds : BigInt(seconds);
  state.blockTime += s;
  state.slot += (s * 5n) / 2n;
}
