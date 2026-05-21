// Aria interface mock — Drew, Day-1 scaffold (Thu 2026-05-21).
//
// Source-of-truth for these shapes: `specs/architecture.md` §3 (Rust account
// schemas) and §4 (TS view models). Mirror — do not invent. When Aria deploys
// Sat 2026-05-23, replace the mock implementations with `@coral-xyz/anchor`
// 0.30.1 client calls; the types stay (or get regenerated from the emitted IDL).
//
// Day-1 purpose: lets `scripts/simulate-trading-day.mjs` and `tests/eval/*`
// run end-to-end before Aria's program exists. Logs "would do X" instead of
// hitting the chain, returns predictable shapes for invariant cross-checks.

// ─── Domain primitives ────────────────────────────────────────────────────

/** A Solana base58 pubkey. String at the boundary; `PublicKey` once @solana/web3.js lands. */
export type Pubkey = string;

/** Ticker is `[u8; 8]` on-chain (null-padded). Human-readable here. */
export type Ticker = "AAPL" | "MSFT" | "GOOGL" | "AMZN" | "NVDA" | "META" | "TSLA";

/** USDC, 6-decimal native units (e.g., $1.00 = 1_000_000). */
export type UsdcMicros = bigint;

/** Settlement outcome — see `programs/bell-markets/src/state/Outcome` (specs/architecture.md §3). */
export type Outcome = "YesWins" | "NoWins";

// ─── On-chain account shapes (mirror specs/architecture.md §3) ─────────────

export interface MarketConfig {
  admin: Pubkey;
  paused: boolean;
  supportedTickers: Ticker[];
  pythFeedMap: Array<{ ticker: Ticker; feed: Pubkey }>;
  stalenessThresholdSec: bigint;       // default 300
  confidenceThresholdBps: bigint;      // default 50  (0.5%)
  adminOverrideDelaySec: bigint;       // default 3600 (1hr — Hard YES #7)
}

export interface StrikeMarket {
  marketId: Pubkey;                    // PDA: ["strike_market", ticker, strike_le, day_le]
  ticker: Ticker;
  strike: UsdcMicros;                  // e.g., $680 = 680_000_000n
  settlementWindow: bigint;            // unix sec; settleable when block_time >= this
  yesMint: Pubkey;
  noMint: Pubkey;
  vault: Pubkey;                       // program-owned USDC vault PDA
  phoenixMarket: Pubkey;               // Phoenix CLOB market for Yes/USDC
  pythFeed: Pubkey;
  outcome: Outcome | null;             // None until settled; immutable once written
  pairsOutstanding: bigint;            // count of un-redeemed mint pairs
  createdAt: bigint;
  settledAt: bigint | null;
}

// ─── Off-chain view models (mirror specs/architecture.md §4) ───────────────

export interface StrikeMarketView {
  marketId: Pubkey;
  ticker: Ticker;
  strike: number;                       // human-readable USDC
  yesBidPrice?: number;
  yesAskPrice?: number;
  noBidPrice?: number;                  // = 1 - yesAskPrice (implied)
  noAskPrice?: number;                  // = 1 - yesBidPrice (implied)
  impliedYesProbability?: number;       // midpoint of yes bid/ask
  settlementWindow: Date;
  outcome?: Outcome;
  isSettled: boolean;
}

export interface UserPosition {
  marketId: Pubkey;
  wallet: Pubkey;
  yesBalance: bigint;
  noBalance: bigint;
  // Position-exclusivity (Hard YES #8): only one side non-zero from trading.
  // Transient both-nonzero state during mint_pair is OK; persistent both is
  // a frontend bug, benign (user redeems pair for $1).
}

export type TradeIntent =
  | { kind: "BuyYes";  marketId: Pubkey; usdcAmount: UsdcMicros; orderType: OrderType }
  | { kind: "BuyNo";   marketId: Pubkey; usdcAmount: UsdcMicros; orderType: OrderType }
  | { kind: "SellYes"; marketId: Pubkey; yesAmount: bigint;      orderType: OrderType }
  | { kind: "SellNo";  marketId: Pubkey; noAmount: bigint;       orderType: OrderType };

export type OrderType = "market" | { limit: number };

// ─── Instruction surface (mirror specs/architecture.md §2.1) ───────────────
//
// Each method = one Anchor instruction Aria's program will expose. Day-1
// implementations return predictable shapes; Sat 5/23 swap for Anchor client.

export interface AriaProgram {
  // Admin-only instructions
  initializeConfig(args: InitializeConfigArgs): Promise<TxResult>;
  createStrikeMarket(args: CreateStrikeMarketArgs): Promise<TxResult & { marketId: Pubkey }>;
  addStrike(args: AddStrikeArgs): Promise<TxResult>;
  pause(): Promise<TxResult>;
  unpause(): Promise<TxResult>;
  adminSettle(args: AdminSettleArgs): Promise<TxResult>;       // time-delay gated (≥1hr — Hard YES #7)

  // Permissionless instructions (DR-002 — callable by anyone)
  mintPair(args: MintPairArgs): Promise<TxResult>;
  settleMarket(args: SettleMarketArgs): Promise<TxResult>;     // permissionless per DR-002
  redeem(args: RedeemArgs): Promise<TxResult>;

  // Read helpers — wrap RPC account fetches; Anchor client supplies the real ones.
  fetchMarketConfig(): Promise<MarketConfig>;
  fetchStrikeMarket(marketId: Pubkey): Promise<StrikeMarket>;
  fetchUserPosition(marketId: Pubkey, wallet: Pubkey): Promise<UserPosition>;
  fetchVaultBalance(marketId: Pubkey): Promise<UsdcMicros>;
}

export interface TxResult {
  signature: string;
  slot: bigint;
  blockTime: bigint;
}

export interface InitializeConfigArgs {
  admin: Pubkey;
  supportedTickers: Ticker[];
  pythFeedMap: Array<{ ticker: Ticker; feed: Pubkey }>;
  stalenessThresholdSec?: bigint;
  confidenceThresholdBps?: bigint;
  adminOverrideDelaySec?: bigint;
}

export interface CreateStrikeMarketArgs {
  caller: Pubkey;                 // must be admin
  ticker: Ticker;
  strike: UsdcMicros;
  settlementWindow: bigint;
  pythFeed: Pubkey;
}

export interface AddStrikeArgs {
  caller: Pubkey;                 // must be admin
  ticker: Ticker;
  strike: UsdcMicros;
  settlementWindow: bigint;
}

export interface MintPairArgs {
  caller: Pubkey;                 // any wallet
  marketId: Pubkey;
  pairs: bigint;                  // count; deposits $1 USDC per pair
}

export interface SettleMarketArgs {
  caller: Pubkey;                 // any wallet (DR-002 / Hard NO #5)
  marketId: Pubkey;
  pythPriceAccount: Pubkey;
}

export interface AdminSettleArgs {
  caller: Pubkey;                 // must be admin
  marketId: Pubkey;
  manualPrice: UsdcMicros;
  // Program-side check: block_time >= settlement_window + admin_override_delay (≥1hr).
}

export interface RedeemArgs {
  caller: Pubkey;                 // any wallet (anyone who holds tokens)
  marketId: Pubkey;
  yesAmountToBurn: bigint;
  noAmountToBurn: bigint;
}

// ─── Mock implementation (Day-1 only — swap with @coral-xyz/anchor 5/23) ───

export interface MockState {
  config: MarketConfig | null;
  markets: Map<Pubkey, StrikeMarket>;
  positions: Map<string /* `${marketId}:${wallet}` */, UserPosition>;
  vaults: Map<Pubkey, UsdcMicros>;
  blockTime: bigint;              // simulation clock; advance via `advanceBlockTime`
  txLog: Array<{ kind: string; details: unknown; blockTime: bigint }>;
}

export interface MockOptions {
  /** Pyth confidence: "tight" = passes both checks; "wide" = fails confidence; "stale" = fails staleness. */
  pythBehavior?: "tight" | "wide" | "stale";
  /** Inject deterministic "stock close price" the mock returns when settle_market reads Pyth. */
  manualClosePrice?: UsdcMicros;
}

export const ONE_USDC: UsdcMicros = 1_000_000n;

export function createMockAria(opts: MockOptions = {}): { program: AriaProgram; state: MockState } {
  const state: MockState = {
    config: null,
    markets: new Map(),
    positions: new Map(),
    vaults: new Map(),
    blockTime: 0n,
    txLog: [],
  };

  function posKey(marketId: Pubkey, wallet: Pubkey): string {
    return `${marketId}:${wallet}`;
  }

  function log(kind: string, details: unknown): void {
    state.txLog.push({ kind, details, blockTime: state.blockTime });
  }

  function tx(): TxResult {
    return {
      signature: `mock-${state.txLog.length.toString().padStart(6, "0")}`,
      slot: state.blockTime,
      blockTime: state.blockTime,
    };
  }

  const program: AriaProgram = {
    async initializeConfig(args) {
      state.config = {
        admin: args.admin,
        paused: false,
        supportedTickers: args.supportedTickers,
        pythFeedMap: args.pythFeedMap,
        stalenessThresholdSec: args.stalenessThresholdSec ?? 300n,
        confidenceThresholdBps: args.confidenceThresholdBps ?? 50n,
        adminOverrideDelaySec: args.adminOverrideDelaySec ?? 3600n,
      };
      log("initializeConfig", args);
      return tx();
    },

    async createStrikeMarket(args) {
      const marketId = `mock-market-${state.markets.size + 1}`;
      const market: StrikeMarket = {
        marketId,
        ticker: args.ticker,
        strike: args.strike,
        settlementWindow: args.settlementWindow,
        yesMint: `${marketId}-yes-mint`,
        noMint: `${marketId}-no-mint`,
        vault: `${marketId}-vault`,
        phoenixMarket: `${marketId}-phoenix`,
        pythFeed: args.pythFeed,
        outcome: null,
        pairsOutstanding: 0n,
        createdAt: state.blockTime,
        settledAt: null,
      };
      state.markets.set(marketId, market);
      state.vaults.set(marketId, 0n);
      log("createStrikeMarket", { caller: args.caller, marketId, ticker: args.ticker, strike: args.strike });
      return { ...tx(), marketId };
    },

    async addStrike(args) {
      log("addStrike", args);
      return tx();
    },

    async pause() {
      if (state.config) state.config.paused = true;
      log("pause", {});
      return tx();
    },

    async unpause() {
      if (state.config) state.config.paused = false;
      log("unpause", {});
      return tx();
    },

    async mintPair(args) {
      const market = state.markets.get(args.marketId);
      if (!market) throw new Error(`mintPair: market ${args.marketId} not found`);
      market.pairsOutstanding += args.pairs;
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) + args.pairs * ONE_USDC);

      const key = posKey(args.marketId, args.caller);
      const cur = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.caller, yesBalance: 0n, noBalance: 0n,
      };
      cur.yesBalance += args.pairs;
      cur.noBalance  += args.pairs;
      state.positions.set(key, cur);

      log("mintPair", { caller: args.caller, marketId: args.marketId, pairs: args.pairs });
      return tx();
    },

    async settleMarket(args) {
      const market = state.markets.get(args.marketId);
      if (!market) throw new Error(`settleMarket: market ${args.marketId} not found`);
      if (market.outcome !== null) throw new Error(`settleMarket: outcome already written (immutable)`);
      if (state.blockTime < market.settlementWindow) {
        throw new Error(`settleMarket: before settlement window (blockTime=${state.blockTime}, window=${market.settlementWindow})`);
      }

      // Day-1 Pyth check is mocked. Sat 5/23: replace with vendored Pyth parser readout from on-chain account.
      if (opts.pythBehavior === "stale") throw new Error(`settleMarket: Pyth price stale`);
      if (opts.pythBehavior === "wide")  throw new Error(`settleMarket: Pyth confidence too wide`);

      const closePrice = opts.manualClosePrice ?? market.strike + ONE_USDC; // default: YesWins (close > strike)
      market.outcome = closePrice >= market.strike ? "YesWins" : "NoWins";
      market.settledAt = state.blockTime;
      log("settleMarket", { caller: args.caller, marketId: args.marketId, closePrice, outcome: market.outcome });
      return tx();
    },

    async adminSettle(args) {
      const market = state.markets.get(args.marketId);
      if (!market) throw new Error(`adminSettle: market ${args.marketId} not found`);
      if (market.outcome !== null) throw new Error(`adminSettle: outcome already written (immutable)`);
      const delay = state.config?.adminOverrideDelaySec ?? 3600n;
      if (state.blockTime < market.settlementWindow + delay) {
        throw new Error(`adminSettle: time-delay gate (≥${delay}s after window) not yet open`);
      }
      market.outcome = args.manualPrice >= market.strike ? "YesWins" : "NoWins";
      market.settledAt = state.blockTime;
      log("adminSettle", { caller: args.caller, marketId: args.marketId, manualPrice: args.manualPrice, outcome: market.outcome });
      return tx();
    },

    async redeem(args) {
      const market = state.markets.get(args.marketId);
      if (!market) throw new Error(`redeem: market ${args.marketId} not found`);
      if (market.outcome === null) throw new Error(`redeem: not settled yet`);

      const key = posKey(args.marketId, args.caller);
      const pos = state.positions.get(key) ?? {
        marketId: args.marketId, wallet: args.caller, yesBalance: 0n, noBalance: 0n,
      };
      if (args.yesAmountToBurn > pos.yesBalance) throw new Error(`redeem: insufficient Yes balance`);
      if (args.noAmountToBurn  > pos.noBalance)  throw new Error(`redeem: insufficient No balance`);

      const winningSide = market.outcome === "YesWins" ? "yes" : "no";
      const winningBurn = winningSide === "yes" ? args.yesAmountToBurn : args.noAmountToBurn;
      const payout = winningBurn * ONE_USDC;

      pos.yesBalance -= args.yesAmountToBurn;
      pos.noBalance  -= args.noAmountToBurn;
      state.positions.set(key, pos);

      // Vault drains by the winning-side burn count × $1; losing burns return $0 (tokens destroyed, no payout).
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - payout);
      market.pairsOutstanding -= winningBurn;

      log("redeem", { caller: args.caller, marketId: args.marketId, yesBurn: args.yesAmountToBurn, noBurn: args.noAmountToBurn, payout });
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
      // Return a snapshot copy (real Anchor RPC returns a deserialized value, not a live ref).
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

/** Simulation helper: advance the mock's block_time. Real `@coral-xyz/anchor` uses RPC slot time. */
export function advanceBlockTime(state: MockState, seconds: bigint): void {
  state.blockTime += seconds;
}
