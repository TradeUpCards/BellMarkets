#!/usr/bin/env node
/**
 * simulate-trading-day.mjs — Drew's primary verification artifact.
 *
 * 60 seconds = 1 BellMarkets trading day. Three wallets, multi-user
 * contention, full lifecycle (create → mint → trade → settle → redeem),
 * with a Phase 5 cross-check of the 5 invariants from logged events.
 *
 * Day-1 status (Thu 2026-05-21): all phases call an INLINE MOCK of Aria's
 * program. The mock mirrors the typed interface in
 * `tests/integration/mocks/aria-interface.ts` (mirrored from
 * `specs/architecture.md` §3 + §4). Each phase logs "Phase X: would do Y"
 * with expected on-chain effects. Invariant checks run against the
 * mocked state.
 *
 * When Aria deploys to devnet (Sat 2026-05-23), swap the inline mock
 * for `@coral-xyz/anchor` 0.30.1 client calls. The phase orchestration
 * + invariant checks stay; only the calls change.
 *
 * Runs on every CI build (Hard YES #1). Catches multi-user contention
 * bugs that per-function tests miss (LESSONS.md Lesson 10).
 *
 * Hard rules enforced:
 *   - Mocked Pyth feeds only (Hard NO #12). No live oracle reads.
 *   - Permissionless settle modeled (DR-002). Phase 3 settles via a
 *     non-admin caller to prove DR-002 in the simulation.
 *   - $1 USDC invariant verified Phase 5 (Hard YES #1).
 *
 * Usage:
 *   node scripts/simulate-trading-day.mjs
 *   node scripts/simulate-trading-day.mjs --outcome=yes_wins
 *   node scripts/simulate-trading-day.mjs --outcome=no_wins
 */

import { performance } from "node:perf_hooks";

// ─── Constants ────────────────────────────────────────────────────────────

const ONE_USDC = 1_000_000n;             // 6 decimals
const STRIKE   = 680_000_000n;           // $680 — AAPL example strike
const TICKER   = "AAPL";

// ─── CLI flags ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const outcomeFlag = argv.find((a) => a.startsWith("--outcome="))?.split("=")[1] ?? "yes_wins";
const closeAbove = outcomeFlag === "yes_wins";
const CLOSE_PRICE = closeAbove ? STRIKE + 5n * ONE_USDC : STRIKE - 5n * ONE_USDC;

// ─── Inline mock of Aria's program (mirror of tests/integration/mocks/aria-interface.ts) ───

function createMockAria() {
  const state = {
    config: null,
    markets: new Map(),
    positions: new Map(),         // key: `${marketId}:${wallet}`
    vaults: new Map(),
    blockTime: 0n,
    txLog: [],
  };

  const posKey = (m, w) => `${m}:${w}`;
  const tx = () => ({
    signature: `mock-${state.txLog.length.toString().padStart(6, "0")}`,
    slot: state.blockTime,
    blockTime: state.blockTime,
  });
  const log = (kind, details) => state.txLog.push({ kind, details, blockTime: state.blockTime });

  const program = {
    async initializeConfig(args) {
      state.config = {
        admin: args.admin,
        paused: false,
        supportedTickers: args.supportedTickers,
        pythFeedMap: args.pythFeedMap,
        stalenessThresholdSec:  args.stalenessThresholdSec  ?? 300n,
        confidenceThresholdBps: args.confidenceThresholdBps ?? 50n,
        adminOverrideDelaySec:  args.adminOverrideDelaySec  ?? 3600n,
      };
      log("initializeConfig", { admin: args.admin });
      return tx();
    },

    async createStrikeMarket(args) {
      const marketId = `mock-market-${state.markets.size + 1}`;
      state.markets.set(marketId, {
        marketId,
        ticker: args.ticker,
        strike: args.strike,
        settlementWindow: args.settlementWindow,
        yesMint: `${marketId}-yes-mint`,
        noMint:  `${marketId}-no-mint`,
        vault:   `${marketId}-vault`,
        phoenixMarket: `${marketId}-phoenix`,
        pythFeed: args.pythFeed,
        outcome: null,
        pairsOutstanding: 0n,
        createdAt: state.blockTime,
        settledAt: null,
      });
      state.vaults.set(marketId, 0n);
      log("createStrikeMarket", { caller: args.caller, marketId, ticker: args.ticker, strike: args.strike, settlementWindow: args.settlementWindow });
      return { ...tx(), marketId };
    },

    async mintPair(args) {
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`mintPair: market ${args.marketId} not found`);
      m.pairsOutstanding += args.pairs;
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) + args.pairs * ONE_USDC);
      const key = posKey(args.marketId, args.caller);
      const cur = state.positions.get(key) ?? { marketId: args.marketId, wallet: args.caller, yesBalance: 0n, noBalance: 0n };
      cur.yesBalance += args.pairs;
      cur.noBalance  += args.pairs;
      state.positions.set(key, cur);
      log("mintPair", { caller: args.caller, marketId: args.marketId, pairs: args.pairs });
      return tx();
    },

    /** Simulated Phoenix sell: transfer Yes from `caller` to `taker`, USDC the other way. */
    async _phoenixTrade(args) {
      const sellerKey = posKey(args.marketId, args.seller);
      const buyerKey  = posKey(args.marketId, args.buyer);
      const seller = state.positions.get(sellerKey) ?? { marketId: args.marketId, wallet: args.seller, yesBalance: 0n, noBalance: 0n };
      const buyer  = state.positions.get(buyerKey)  ?? { marketId: args.marketId, wallet: args.buyer,  yesBalance: 0n, noBalance: 0n };

      if (args.side === "yes") {
        if (seller.yesBalance < args.amount) throw new Error(`phoenixTrade: seller short of Yes`);
        seller.yesBalance -= args.amount;
        buyer.yesBalance  += args.amount;
      } else {
        if (seller.noBalance < args.amount) throw new Error(`phoenixTrade: seller short of No`);
        seller.noBalance -= args.amount;
        buyer.noBalance  += args.amount;
      }
      state.positions.set(sellerKey, seller);
      state.positions.set(buyerKey,  buyer);
      log("phoenixTrade", { seller: args.seller, buyer: args.buyer, side: args.side, amount: args.amount, pricePerToken: args.pricePerToken });
      return tx();
    },

    async settleMarket(args) {
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`settleMarket: market ${args.marketId} not found`);
      if (m.outcome !== null) throw new Error(`settleMarket: outcome already written (immutable)`);
      if (state.blockTime < m.settlementWindow) {
        throw new Error(`settleMarket: before window (blockTime=${state.blockTime}, window=${m.settlementWindow})`);
      }
      m.outcome   = args.closePrice >= m.strike ? "YesWins" : "NoWins";
      m.settledAt = state.blockTime;
      log("settleMarket", { caller: args.caller, marketId: args.marketId, closePrice: args.closePrice, outcome: m.outcome });
      return tx();
    },

    async redeem(args) {
      const m = state.markets.get(args.marketId);
      if (!m) throw new Error(`redeem: market ${args.marketId} not found`);
      if (m.outcome === null) throw new Error(`redeem: not settled`);
      const key = posKey(args.marketId, args.caller);
      const pos = state.positions.get(key) ?? { marketId: args.marketId, wallet: args.caller, yesBalance: 0n, noBalance: 0n };
      if (args.yesAmountToBurn > pos.yesBalance) throw new Error(`redeem: insufficient Yes (${pos.yesBalance})`);
      if (args.noAmountToBurn  > pos.noBalance)  throw new Error(`redeem: insufficient No  (${pos.noBalance})`);
      const winSide = m.outcome === "YesWins" ? "yes" : "no";
      const winBurn = winSide === "yes" ? args.yesAmountToBurn : args.noAmountToBurn;
      const payout  = winBurn * ONE_USDC;
      pos.yesBalance -= args.yesAmountToBurn;
      pos.noBalance  -= args.noAmountToBurn;
      state.positions.set(key, pos);
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - payout);
      m.pairsOutstanding -= winBurn;
      log("redeem", { caller: args.caller, marketId: args.marketId, yesBurn: args.yesAmountToBurn, noBurn: args.noAmountToBurn, payout });
      return tx();
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

function advanceBlockTime(state, seconds) { state.blockTime += BigInt(seconds); }

// ─── Phase orchestration ──────────────────────────────────────────────────

const phase = (n, label) => console.log(`\n── Phase ${n}: ${label} ─────────────────────────────`);
const step  = (msg) => console.log(`  · ${msg}`);
const ok    = (msg) => console.log(`  ✓ ${msg}`);
const fail  = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

async function main() {
  const t0 = performance.now();
  const { program, state } = createMockAria();
  const ADMIN  = "admin-pubkey";
  const ALICE  = "alice-pubkey"; // market maker
  const BOB    = "bob-pubkey";   // bullish taker
  const CAROL  = "carol-pubkey"; // bearish taker
  const PYTH   = "pyth-aapl-feed-mock";

  // Initial block time: noon ET on demo day.
  state.blockTime = 1_716_300_000n;

  // ── Phase 0 (10s wall clock simulated): wallets + funding ─────────────
  phase(0, "Generate 3 wallets, fund each with 0.05 SOL + 100 USDC");
  step("would airdrop 0.05 SOL each to Alice / Bob / Carol from admin");
  step("would mint 100 USDC each to Alice / Bob / Carol (devnet test USDC)");
  await program.initializeConfig({
    admin: ADMIN,
    supportedTickers: [TICKER],
    pythFeedMap: [{ ticker: TICKER, feed: PYTH }],
  });
  ok(`config initialized; admin=${ADMIN}, ${state.config.supportedTickers.length} ticker(s)`);
  advanceBlockTime(state, 10);

  // ── Phase 1 (5s): create market with close_ts in the past ─────────────
  phase(1, "Create AAPL $680 market with settlement_window in the past");
  // Settlement window is set BEFORE current block time so settle_market is immediately callable.
  // (Real demo path: window = today 4:05pm ET; we backdate here to skip the wait.)
  const settlementWindow = state.blockTime - 60n; // 60s ago = already in window
  const created = await program.createStrikeMarket({
    caller: ADMIN, ticker: TICKER, strike: STRIKE, settlementWindow, pythFeed: PYTH,
  });
  const MARKET = created.marketId;
  ok(`market created: ${MARKET} (strike=$${Number(STRIKE) / 1e6}, window=${settlementWindow})`);
  step(`would CPI Phoenix create_market for Yes/USDC pair (DR-001)`);
  advanceBlockTime(state, 5);

  // ── Phase 2 (30s): multi-user trading ─────────────────────────────────
  phase(2, "Multi-user trading: Alice MM, Bob bullish, Carol bearish");

  // Alice mints 10 pairs, posts ask of 0.55 Yes + ask of 0.45 No (i.e., implied 55% Yes).
  await program.mintPair({ caller: ALICE, marketId: MARKET, pairs: 10n });
  ok(`Alice minted 10 pairs (vault += $10; Alice holds 10 Yes + 10 No)`);
  step(`would Phoenix-post bid 0.55 USDC for Yes ×5 + ask 0.55 USDC for Yes ×5 (MM both sides)`);

  // Bob buys Yes (composite: mint_pair + sell_no on Phoenix in one atomic tx per POV-3).
  // Simulating the net effect: Bob ends with +2 Yes, 0 No (the No was sold to Alice during the bundle).
  await program.mintPair({ caller: BOB, marketId: MARKET, pairs: 2n });
  await program._phoenixTrade({ marketId: MARKET, seller: BOB, buyer: ALICE, side: "no", amount: 2n, pricePerToken: 450_000n });
  ok(`Bob buy_yes composite: mint_pair(2) + sell_no(2) @ $0.45 → Bob holds +2 Yes`);

  // Carol buys No (composite: mint_pair + sell_yes on Phoenix in one atomic tx).
  await program.mintPair({ caller: CAROL, marketId: MARKET, pairs: 2n });
  await program._phoenixTrade({ marketId: MARKET, seller: CAROL, buyer: ALICE, side: "yes", amount: 2n, pricePerToken: 550_000n });
  ok(`Carol buy_no composite: mint_pair(2) + sell_yes(2) @ $0.55 → Carol holds +2 No`);

  advanceBlockTime(state, 30);

  // ── Phase 3 (10s): settle ─────────────────────────────────────────────
  phase(3, "Settle market — permissionless (DR-002): Carol cranks settle from her wallet");
  step(`would read Pyth price account ${PYTH}; mocked close = $${Number(CLOSE_PRICE) / 1e6}`);
  // Note: per DR-002, settle_market is permissionless. We deliberately call it from CAROL (not admin).
  // This is the cron-failure path in microcosm: automation doesn't have special authority.
  await program.settleMarket({ caller: CAROL, marketId: MARKET, closePrice: CLOSE_PRICE });
  const settled = await program.fetchStrikeMarket(MARKET);
  ok(`settled by ${CAROL} (non-admin): outcome=${settled.outcome}, immutable`);

  // Verify outcome is immutable: second settle attempt must fail.
  try {
    await program.settleMarket({ caller: ALICE, marketId: MARKET, closePrice: CLOSE_PRICE });
    fail(`second settle_market call SUCCEEDED — outcome immutability broken`);
  } catch (e) {
    ok(`second settle_market call rejected as expected: ${e.message}`);
  }
  advanceBlockTime(state, 10);

  // ── Phase 4 (5s): redeem ──────────────────────────────────────────────
  phase(4, "Winners redeem; losers can't");
  const winningSide = settled.outcome === "YesWins" ? "yes" : "no";

  // Each user redeems all of their winning + losing tokens; only winning side pays.
  for (const wallet of [ALICE, BOB, CAROL]) {
    const pos = await program.fetchUserPosition(MARKET, wallet);
    if (pos.yesBalance === 0n && pos.noBalance === 0n) {
      step(`${wallet} holds no tokens; skipping redeem`);
      continue;
    }
    await program.redeem({
      caller: wallet, marketId: MARKET,
      yesAmountToBurn: pos.yesBalance,
      noAmountToBurn:  pos.noBalance,
    });
    const winBurn = winningSide === "yes" ? pos.yesBalance : pos.noBalance;
    ok(`${wallet}: burned ${pos.yesBalance} Yes + ${pos.noBalance} No → received $${Number(winBurn)} (winning side: ${winningSide})`);
  }

  // Loser-redeem-only attempt: someone with zero winning tokens tries to redeem extra → reverts.
  try {
    await program.redeem({ caller: BOB, marketId: MARKET, yesAmountToBurn: 999n, noAmountToBurn: 0n });
    fail(`Bob over-redeem SUCCEEDED — token-supply discipline broken`);
  } catch (e) {
    ok(`Bob over-redeem rejected as expected: ${e.message}`);
  }
  advanceBlockTime(state, 5);

  // ── Phase 5 (5s): cross-check all 5 invariants ────────────────────────
  phase(5, "Invariant cross-check");
  await checkInvariants({ program, state, market: MARKET });
  advanceBlockTime(state, 5);

  const elapsedMs = performance.now() - t0;
  console.log(`\n── Done: ${elapsedMs.toFixed(0)}ms wall clock; ${state.txLog.length} mock txs; simulated ${state.blockTime - 1_716_300_000n}s of trading-day time ──`);
  if (process.exitCode === 1) {
    console.error("FAIL — one or more invariant checks failed.");
  } else {
    ok("All Phase 5 invariant checks passed against mocked state.");
  }
}

// ─── Invariant cross-check (mirrors tests/eval/invariants.md) ─────────────

async function checkInvariants({ program, state, market }) {
  const m = await program.fetchStrikeMarket(market);
  const vaultBalance = await program.fetchVaultBalance(market);

  // I1: vault_balance == $1 × pairs_outstanding (always, after every mint/redeem).
  const expectedVault = m.pairsOutstanding * ONE_USDC;
  if (vaultBalance === expectedVault) {
    ok(`I1 vault_balance == $1 × pairs_outstanding (${vaultBalance} == ${expectedVault})`);
  } else {
    fail(`I1 VIOLATED: vault_balance=${vaultBalance}, expected=${expectedVault} (pairs_outstanding=${m.pairsOutstanding})`);
  }

  // I2: yes_payout + no_payout == $1.00 per pair (from settle outcome).
  //     We verify via the logged redeem events: sum(payout) == sum(winning_side_burns) × $1.
  const redeems = state.txLog.filter((t) => t.kind === "redeem");
  let sumPayouts = 0n;
  let sumWinBurns = 0n;
  const winSide = m.outcome === "YesWins" ? "yes" : "no";
  for (const r of redeems) {
    sumPayouts += r.details.payout;
    sumWinBurns += winSide === "yes" ? r.details.yesBurn : r.details.noBurn;
  }
  if (sumPayouts === sumWinBurns * ONE_USDC) {
    ok(`I2 yes_payout + no_payout == $1.00 per pair (sum payouts=${sumPayouts}, win burns=${sumWinBurns} × $1)`);
  } else {
    fail(`I2 VIOLATED: sum payouts=${sumPayouts}, expected ${sumWinBurns} × $1`);
  }

  // I3: outcome is immutable once written. Verified in Phase 3 (second settle rejected).
  if (m.outcome !== null && m.settledAt !== null) {
    ok(`I3 outcome immutable: ${m.outcome} @ blockTime=${m.settledAt}; second-settle attempt was rejected (see Phase 3)`);
  } else {
    fail(`I3 VIOLATED: market.outcome=${m.outcome}, settledAt=${m.settledAt}`);
  }

  // I4: tokens only created via mint_pair / destroyed via redeem.
  // Cross-check: sum(mintPair.pairs) - sum(redeem.winning_side_burns) == pairs_outstanding.
  // (Loser tokens are also burned on redeem but don't count against outstanding pairs; the
  // pair is "spent" the moment its winning side redeems. Vault drain matches winning burns.)
  const mints = state.txLog.filter((t) => t.kind === "mintPair");
  const totalMinted = mints.reduce((s, t) => s + t.details.pairs, 0n);
  const expectedOutstanding = totalMinted - sumWinBurns;
  if (m.pairsOutstanding === expectedOutstanding) {
    ok(`I4 tokens only via mint_pair / redeem: minted ${totalMinted}, winning-redeemed ${sumWinBurns}, outstanding ${m.pairsOutstanding}`);
  } else {
    fail(`I4 VIOLATED: outstanding=${m.pairsOutstanding}, expected=${expectedOutstanding} (minted=${totalMinted}, redeemed=${sumWinBurns})`);
  }

  // I5: position-exclusivity (Hard YES #8 — frontend guardrail, benign on-chain).
  // We check that NO active position ends Phase 4 with both sides non-zero. Transient
  // both-nonzero during mint_pair is allowed; persistent both is a UX bug.
  let violations = 0;
  for (const [key, pos] of state.positions.entries()) {
    if (pos.yesBalance > 0n && pos.noBalance > 0n) {
      console.warn(`  ⚠ I5 holds both sides: ${key} yes=${pos.yesBalance} no=${pos.noBalance} (benign; user can redeem the pair for $1)`);
      violations++;
    }
  }
  if (violations === 0) {
    ok(`I5 position-exclusivity holds for all ${state.positions.size} positions (no wallet ends with both Yes and No)`);
  } else {
    // Not a fail — Hard YES #8 says this is benign. Just informational.
    ok(`I5 position-exclusivity informational: ${violations} wallet(s) hold both sides post-trade (benign per Hard YES #8)`);
  }
}

// ─── BigInt JSON serializer (for debug dumps) ─────────────────────────────

BigInt.prototype.toJSON = function () { return this.toString(); };

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
