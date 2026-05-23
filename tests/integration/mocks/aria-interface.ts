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
  bump: number;                        // u8
  yesMintBump: number;
  noMintBump: number;
  vaultBump: number;
  _reserved: Uint8Array;               // [u8; 64]
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

  // Read helpers
  fetchMarketConfig(): Promise<MarketConfig>;
  fetchStrikeMarket(marketId: Pubkey): Promise<StrikeMarket>;
  fetchUserPosition(marketId: Pubkey, wallet: Pubkey): Promise<UserPositionView>;
  fetchVaultBalance(marketId: Pubkey): Promise<UsdcMicros>;
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

// ─── Mock implementation (offline; for simulation + offline tests) ─────────

export interface MockState {
  config: MarketConfig | null;
  markets: Map<Pubkey, StrikeMarket>;
  positions: Map<string /* `${marketId}:${wallet}` */, UserPositionView>;
  vaults: Map<Pubkey, UsdcMicros>;
  blockTime: bigint;
  slot: bigint;
  txLog: Array<{ kind: string; details: unknown; blockTime: bigint }>;
}

export interface MockOptions {
  pythBehavior?: "tight" | "wide" | "stale" | "notTrading";
  pythClosePrice?: bigint;
  pythPublishSlotOffset?: bigint;
}

export const ONE_USDC: UsdcMicros = 1_000_000n;

export function createMockAria(opts: MockOptions = {}): { program: AriaProgram; state: MockState } {
  const state: MockState = {
    config: null,
    markets: new Map(),
    positions: new Map(),
    vaults: new Map(),
    blockTime: 0n,
    slot: 0n,
    txLog: [],
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
        bump: 254, yesMintBump: 253, noMintBump: 252, vaultBump: 251,
        _reserved: new Uint8Array(64),
      };
      state.markets.set(marketId, market);
      state.vaults.set(marketId, 0n);
      log("createStrikeMarket", { admin: args.admin, marketId, strikePrice: args.strikePrice, expiryUnix: args.expiryUnix });
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

      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) + args.amount);
      const key = posKey(args.marketId, args.user);
      const cur = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n,
      };
      cur.yesBalance += args.amount;
      cur.noBalance  += args.amount;
      state.positions.set(key, cur);
      log("mintPair", { user: args.user, marketId: args.marketId, amount: args.amount });
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
