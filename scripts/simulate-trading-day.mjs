#!/usr/bin/env node
/**
 * simulate-trading-day.mjs — Drew's primary verification artifact.
 *
 * 60 seconds of wall clock = 1 BellMarkets trading day. Three wallets,
 * multi-user contention, full lifecycle (create → mint → trade → settle
 * → redeem), with a Phase 5 cross-check of the 5 invariants from logged
 * events.
 *
 * Day-3 status (Fri 2026-05-22): IDL-reconciled against the deployed-program
 * IDL at `programs/bell-markets/idl/bell_markets.json`. Uses the 9-instruction
 * surface (incl. redeem_invalid for Invalid-outcome paths).
 *   - Outcome is the 4-variant Anchor enum: { unsettled | yes | no | invalid }
 *   - mint_pair takes `amount` (u64 micro-USDC), not "pairs"
 *   - redeem burns ONLY the winning side (single `winning_mint` Account)
 *   - admin_settle takes a forced Outcome (not a manual price)
 *   - settle_market has no args; pyth feed is an Account, validated by
 *     vendored 30-line parser (Hard NO #6 / DR-003)
 *
 * Why this script stays mock-backed even after Day-3 live unblock:
 *   The compressed-time simulation's job (Hard YES #1) is to catch multi-user
 *   contention + invariant bugs in CI on every PR, deterministically and
 *   without network. Live RPC + devnet airdrops are non-deterministic +
 *   rate-limited. The live program is exercised in
 *   `tests/integration/live-program-call.test.ts` (gated by `LIVE_DEVNET=1`).
 *
 * Hard rules enforced (BRAINLIFT.md §4):
 *   - Mocked Pyth feeds only (Hard NO #12)
 *   - Permissionless settle modeled (DR-002 / Hard NO #5): Phase 3 settles
 *     via Carol (non-admin) to bake DR-002 evidence into the primary artifact
 *   - $1 USDC invariant verified Phase 5 (Hard YES #1)
 *
 * Usage:
 *   node scripts/simulate-trading-day.mjs
 *   node scripts/simulate-trading-day.mjs --outcome=yes_wins
 *   node scripts/simulate-trading-day.mjs --outcome=no_wins
 *   node scripts/simulate-trading-day.mjs --outcome=invalid    (admin override path)
 */

import { performance } from "node:perf_hooks";

const ONE_USDC = 1_000_000n;
const STRIKE_PRICE = 680_000_000n;
const DEFAULT_STALENESS_SECS = 300n;
const DEFAULT_CONFIDENCE_BPS = 50;
const DEFAULT_ADMIN_OVERRIDE_DELAY_SECS = 3600n;

const argv = process.argv.slice(2);
const outcomeFlag = argv.find((a) => a.startsWith("--outcome="))?.split("=")[1] ?? "yes_wins";
const closeAbove = outcomeFlag === "yes_wins";
const isInvalid = outcomeFlag === "invalid";
const PYTH_CLOSE_PRICE = closeAbove ? STRIKE_PRICE + 5n * ONE_USDC : STRIKE_PRICE - 5n * ONE_USDC;

const OUTCOME_UNSETTLED = { unsettled: {} };
const OUTCOME_YES       = { yes: {} };
const OUTCOME_NO        = { no: {} };
const OUTCOME_INVALID   = { invalid: {} };
const outcomeKind = (o) =>
  "unsettled" in o ? "unsettled" : "yes" in o ? "yes" : "no" in o ? "no" : "invalid";

function createMockAria(opts = {}) {
  const state = {
    config: null,
    markets: new Map(),
    positions: new Map(),
    vaults: new Map(),
    blockTime: 0n,
    slot: 0n,
    txLog: [],
  };
  const posKey = (m, w) => `${m}:${w}`;
  const log = (kind, details) => state.txLog.push({ kind, details, blockTime: state.blockTime });
  const tx = () => ({
    signature: `mock-${state.txLog.length.toString().padStart(6, "0")}`,
    slot: state.slot,
    blockTime: state.blockTime,
  });
  const requireUnsettled = (m, ix) => {
    if (outcomeKind(m.outcome) !== "unsettled") throw new Error(`${ix}: AlreadySettled`);
  };

  const program = {
    async initializeConfig(args) {
      state.config = {
        admin: args.admin, usdcMint: args.usdcMint, treasury: args.treasury,
        priceStalenessSecs: args.priceStalenessSecs,
        priceConfidenceBps: args.priceConfidenceBps,
        adminOverrideDelaySecs: args.adminOverrideDelaySecs,
        paused: false, bump: 255,
      };
      log("initializeConfig", { admin: args.admin });
      return tx();
    },
    async createStrikeMarket(args) {
      if (state.config.admin !== args.admin) throw new Error("createStrikeMarket: NotAdmin");
      if (args.expiryUnix <= state.blockTime) throw new Error("createStrikeMarket: ExpiryInPast");
      const marketId = `mock-strike-${args.underlyingPythFeed}-${args.expiryUnix}-${args.strikePrice}`;
      state.markets.set(marketId, {
        config: "mock-config-pda",
        underlyingPythFeed: args.underlyingPythFeed,
        strikePrice: args.strikePrice,
        expiryUnix: args.expiryUnix,
        yesMint: `${marketId}-yes`, noMint: `${marketId}-no`, usdcVault: `${marketId}-vault`,
        phoenixMarket: args.phoenixMarket,
        settlePrice: 0n, settleConfidence: 0n, settleSlot: 0n, settledAtUnix: 0n,
        outcome: OUTCOME_UNSETTLED,
        adminOverrideEligibleAt: args.expiryUnix + state.config.adminOverrideDelaySecs,
        bump: 254, yesMintBump: 253, noMintBump: 252, vaultBump: 251,
      });
      state.vaults.set(marketId, 0n);
      log("createStrikeMarket", { admin: args.admin, marketId, strikePrice: args.strikePrice, expiryUnix: args.expiryUnix });
      return { ...tx(), marketId };
    },
    async mintPair(args) {
      if (args.amount === 0n) throw new Error("mintPair: ZeroAmount");
      const m = state.markets.get(args.marketId);
      requireUnsettled(m, "mintPair");
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) + args.amount);
      const key = posKey(args.marketId, args.user);
      const cur = state.positions.get(key) ?? { marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n };
      cur.yesBalance += args.amount;
      cur.noBalance  += args.amount;
      state.positions.set(key, cur);
      log("mintPair", { user: args.user, marketId: args.marketId, amount: args.amount });
      return tx();
    },
    async _phoenixTrade(args) {
      const sk = posKey(args.marketId, args.seller);
      const bk = posKey(args.marketId, args.buyer);
      const s = state.positions.get(sk) ?? { marketId: args.marketId, wallet: args.seller, yesBalance: 0n, noBalance: 0n };
      const b = state.positions.get(bk) ?? { marketId: args.marketId, wallet: args.buyer,  yesBalance: 0n, noBalance: 0n };
      if (args.side === "yes") {
        if (s.yesBalance < args.amount) throw new Error("phoenixTrade: short YES");
        s.yesBalance -= args.amount; b.yesBalance += args.amount;
      } else {
        if (s.noBalance < args.amount) throw new Error("phoenixTrade: short NO");
        s.noBalance -= args.amount; b.noBalance += args.amount;
      }
      state.positions.set(sk, s);
      state.positions.set(bk, b);
      log("phoenixTrade", { seller: args.seller, buyer: args.buyer, side: args.side, amount: args.amount });
      return tx();
    },
    async settleMarket(args) {
      const m = state.markets.get(args.marketId);
      requireUnsettled(m, "settleMarket");
      if (state.blockTime < m.expiryUnix) throw new Error(`settleMarket: NotExpired`);
      const closePrice = opts.pythClosePrice ?? (m.strikePrice + 5n * ONE_USDC);
      m.outcome = closePrice >= m.strikePrice ? OUTCOME_YES : OUTCOME_NO;
      m.settlePrice = closePrice;
      m.settleSlot = state.slot;
      m.settledAtUnix = state.blockTime;
      log("settleMarket", { settler: args.settler, marketId: args.marketId, settlePrice: closePrice, outcome: outcomeKind(m.outcome) });
      return tx();
    },
    async adminSettle(args) {
      if (state.config.admin !== args.admin) throw new Error("adminSettle: NotAdmin");
      const m = state.markets.get(args.marketId);
      requireUnsettled(m, "adminSettle");
      if (state.blockTime < m.adminOverrideEligibleAt) throw new Error("adminSettle: AdminOverrideTooEarly");
      m.outcome = args.forcedOutcome;
      m.settledAtUnix = state.blockTime;
      log("adminSettle", { admin: args.admin, marketId: args.marketId, outcome: outcomeKind(args.forcedOutcome) });
      return tx();
    },
    async redeem(args) {
      if (args.amount === 0n) throw new Error("redeem: ZeroAmount");
      const m = state.markets.get(args.marketId);
      const oc = outcomeKind(m.outcome);
      if (oc === "unsettled") throw new Error("redeem: NotSettled");
      if (oc === "invalid")   throw new Error("redeem: InvalidOutcomeForRedeem (use redeem_invalid)");
      const key = posKey(args.marketId, args.user);
      const pos = state.positions.get(key) ?? { marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n };
      const winningBalance = oc === "yes" ? pos.yesBalance : pos.noBalance;
      if (args.amount > winningBalance) throw new Error(`redeem: insufficient winning balance (have=${winningBalance})`);
      if (oc === "yes") pos.yesBalance -= args.amount;
      else              pos.noBalance  -= args.amount;
      state.positions.set(key, pos);
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - args.amount);
      log("redeem", { user: args.user, marketId: args.marketId, amount: args.amount, winningSide: oc });
      return tx();
    },
    async redeemInvalid(args) {
      if (args.amount === 0n) throw new Error("redeemInvalid: ZeroAmount");
      const m = state.markets.get(args.marketId);
      if (outcomeKind(m.outcome) !== "invalid") throw new Error("redeemInvalid: InvalidOutcomeForRedeem");
      const key = posKey(args.marketId, args.user);
      const pos = state.positions.get(key) ?? { marketId: args.marketId, wallet: args.user, yesBalance: 0n, noBalance: 0n };
      if (args.amount > pos.yesBalance) throw new Error(`redeemInvalid: insufficient YES`);
      if (args.amount > pos.noBalance) throw new Error(`redeemInvalid: insufficient NO`);
      pos.yesBalance -= args.amount;
      pos.noBalance  -= args.amount;
      state.positions.set(key, pos);
      state.vaults.set(args.marketId, (state.vaults.get(args.marketId) ?? 0n) - args.amount);
      log("redeemInvalid", { user: args.user, marketId: args.marketId, amount: args.amount });
      return tx();
    },
    async fetchStrikeMarket(marketId) { return state.markets.get(marketId); },
    async fetchUserPosition(marketId, wallet) {
      const live = state.positions.get(posKey(marketId, wallet));
      if (!live) return { marketId, wallet, yesBalance: 0n, noBalance: 0n };
      return { marketId: live.marketId, wallet: live.wallet, yesBalance: live.yesBalance, noBalance: live.noBalance };
    },
    async fetchVaultBalance(marketId) { return state.vaults.get(marketId) ?? 0n; },
  };
  return { program, state };
}

const advanceBlockTime = (state, seconds) => {
  state.blockTime += BigInt(seconds);
  state.slot += (BigInt(seconds) * 5n) / 2n;
};

const phase = (n, label) => console.log(`\n── Phase ${n}: ${label} ─────────────────────────────`);
const step  = (msg) => console.log(`  · ${msg}`);
const ok    = (msg) => console.log(`  ✓ ${msg}`);
const fail  = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

async function main() {
  const t0 = performance.now();
  const { program, state } = createMockAria({ pythClosePrice: PYTH_CLOSE_PRICE });
  const ADMIN     = "platform-admin-pubkey";
  const ALICE     = "alice-pubkey";
  const BOB       = "bob-pubkey";
  const CAROL     = "carol-pubkey";
  const PYTH      = "pyth-aapl-feed-mock";
  const PHOENIX   = "phoenix-aapl-fifo-market-mock";
  const USDC_MINT = "usdc-mint-devnet-mock";
  const TREASURY  = "treasury-token-account-mock";

  state.blockTime = 1_716_300_000n;
  state.slot      = 250_000_000n;

  phase(0, "Generate 3 wallets, fund each, initialize global config");
  step("would airdrop 0.05 SOL each to Alice / Bob / Carol from devnet faucet");
  step("would mint 100 USDC each (devnet test USDC) to Alice / Bob / Carol");
  await program.initializeConfig({
    admin: ADMIN, usdcMint: USDC_MINT, treasury: TREASURY,
    priceStalenessSecs: DEFAULT_STALENESS_SECS,
    priceConfidenceBps: DEFAULT_CONFIDENCE_BPS,
    adminOverrideDelaySecs: DEFAULT_ADMIN_OVERRIDE_DELAY_SECS,
  });
  ok(`MarketConfig initialized; admin=${ADMIN}`);
  advanceBlockTime(state, 10);

  phase(1, "Admin creates AAPL $680 market (expiry 35s out)");
  const expiryUnix = state.blockTime + 35n;
  const created = await program.createStrikeMarket({
    admin: ADMIN, underlyingPythFeed: PYTH,
    strikePrice: STRIKE_PRICE, expiryUnix, phoenixMarket: PHOENIX,
  });
  const MARKET = created.marketId;
  ok(`market created: ${MARKET} (strike=$${Number(STRIKE_PRICE) / 1e6}, expiry=${expiryUnix})`);
  step(`would verify phoenix_market 8-byte magic prefix (DR-001 / hard-rules.md §4.12)`);
  advanceBlockTime(state, 5);

  phase(2, "Multi-user trading: Alice MM, Bob bullish, Carol bearish");
  await program.mintPair({ user: ALICE, marketId: MARKET, amount: 10n * ONE_USDC });
  ok(`Alice minted $10 of pairs`);
  step(`would Phoenix-post: bid 0.55 USDC for YES ×5 + ask 0.55 USDC for YES ×5`);
  await program.mintPair({ user: BOB, marketId: MARKET, amount: 2n * ONE_USDC });
  await program._phoenixTrade({ marketId: MARKET, seller: BOB, buyer: ALICE, side: "no", amount: 2n * ONE_USDC });
  ok(`Bob buy_yes composite → Bob holds 2 YES`);
  await program.mintPair({ user: CAROL, marketId: MARKET, amount: 2n * ONE_USDC });
  await program._phoenixTrade({ marketId: MARKET, seller: CAROL, buyer: ALICE, side: "yes", amount: 2n * ONE_USDC });
  ok(`Carol buy_no composite → Carol holds 2 NO`);
  advanceBlockTime(state, 30);

  phase(3, isInvalid
    ? "Admin invokes admin_settle with Invalid (oracle-down recovery path)"
    : "Settle market — DR-002: Carol cranks from her (non-admin) wallet");

  let winSide;
  if (isInvalid) {
    // Time-travel past expiry + override delay so admin_settle is eligible.
    advanceBlockTime(state, Number(DEFAULT_ADMIN_OVERRIDE_DELAY_SECS));
    await program.adminSettle({ admin: ADMIN, marketId: MARKET, forcedOutcome: OUTCOME_INVALID });
    ok(`settled by ${ADMIN} (admin override): outcome=invalid`);
    winSide = "invalid";
  } else {
    step(`would read Pyth account ${PYTH}; mocked close = $${Number(PYTH_CLOSE_PRICE) / 1e6}`);
    await program.settleMarket({ settler: CAROL, marketId: MARKET });
    const settled = await program.fetchStrikeMarket(MARKET);
    winSide = outcomeKind(settled.outcome);
    ok(`settled by ${CAROL} (non-admin): outcome=${winSide}, immutable`);
    // I3: second settle must reject.
    try {
      await program.settleMarket({ settler: ALICE, marketId: MARKET });
      fail(`second settle SUCCEEDED — I3 broken`);
    } catch (e) {
      ok(`I3 second settle rejected as expected: ${e.message}`);
    }
  }
  advanceBlockTime(state, 10);

  phase(4, isInvalid ? "Invalid path: all users redeem_invalid for pair refund"
                     : "Winners redeem; losers' redeem attempts revert");
  if (isInvalid) {
    for (const wallet of [ALICE, BOB, CAROL]) {
      const pos = await program.fetchUserPosition(MARKET, wallet);
      const eqMin = pos.yesBalance < pos.noBalance ? pos.yesBalance : pos.noBalance;
      if (eqMin === 0n) {
        step(`${wallet} holds 0 paired (yes=${pos.yesBalance}, no=${pos.noBalance}); skip`);
        continue;
      }
      await program.redeemInvalid({ user: wallet, marketId: MARKET, amount: eqMin });
      ok(`${wallet}: redeem_invalid $${Number(eqMin) / 1e6} (refunded full pair deposit)`);
    }
  } else {
    for (const wallet of [ALICE, BOB, CAROL]) {
      const pos = await program.fetchUserPosition(MARKET, wallet);
      const winningBalance = winSide === "yes" ? pos.yesBalance : pos.noBalance;
      if (winningBalance === 0n) {
        step(`${wallet} holds 0 ${winSide.toUpperCase()} (loser); skipping redeem`);
        continue;
      }
      await program.redeem({ user: wallet, marketId: MARKET, amount: winningBalance });
      ok(`${wallet}: redeemed $${Number(winningBalance) / 1e6} of ${winSide.toUpperCase()}`);
    }
    const loserSide = winSide === "yes" ? "no" : "yes";
    const aLoser = winSide === "yes" ? CAROL : BOB;
    try {
      await program.redeem({ user: aLoser, marketId: MARKET, amount: ONE_USDC });
      fail(`${aLoser} loser redeem SUCCEEDED — token-supply discipline broken`);
    } catch (e) {
      ok(`${aLoser} (loser of ${loserSide.toUpperCase()}) redeem rejected: ${e.message}`);
    }
  }
  advanceBlockTime(state, 5);

  phase(5, "Invariant cross-check");
  await checkInvariants({ program, state, market: MARKET, winSide, isInvalid });
  advanceBlockTime(state, 5);

  const elapsedMs = performance.now() - t0;
  console.log(`\n── Done: ${elapsedMs.toFixed(0)}ms wall clock; ${state.txLog.length} mock txs; simulated ${state.blockTime - 1_716_300_000n}s of trading-day time ──`);
  if (process.exitCode === 1) console.error("FAIL — one or more invariant checks failed.");
  else ok("All Phase 5 invariant checks passed against mocked state.");
}

async function checkInvariants({ program, state, market, winSide, isInvalid }) {
  const m = await program.fetchStrikeMarket(market);
  const vaultBalance = await program.fetchVaultBalance(market);
  const mints       = state.txLog.filter((t) => t.kind === "mintPair");
  const redeems     = state.txLog.filter((t) => t.kind === "redeem");
  const redeemInvs  = state.txLog.filter((t) => t.kind === "redeemInvalid");
  const totalMinted = mints.reduce((s, t) => s + t.details.amount, 0n);
  const totalRedeemed = redeems.reduce((s, t) => s + t.details.amount, 0n);
  const totalInv      = redeemInvs.reduce((s, t) => s + t.details.amount, 0n);

  // I1: vault_balance == Σ mintPair - Σ redeem - Σ redeemInvalid.
  const expectedVault = totalMinted - totalRedeemed - totalInv;
  if (vaultBalance === expectedVault) {
    ok(`I1 vault_balance == Σ mints - Σ redeems  (vault=${vaultBalance}, expected=${expectedVault})`);
  } else {
    fail(`I1 VIOLATED: vault=${vaultBalance}, expected=${expectedVault}`);
  }

  // I2: $1 USDC conservation. Every micro-USDC that entered the vault via
  //     mint_pair must either still be in the vault OR have been paid out
  //     via redeem or redeem_invalid. Equivalently:
  //       totalRedeemed + totalInv === totalMinted - vaultBalance
  //     A bug paying 2× per token would violate this immediately.
  //     (Earlier draft of this check was an unconditional ok() — caught by
  //     audit on 2026-05-22, replaced with this boolean assertion.)
  if (totalRedeemed + totalInv === totalMinted - vaultBalance) {
    ok(`I2 $1 USDC conservation: minted=${totalMinted}, redeemed=${totalRedeemed}, redeem_invalid=${totalInv}, vault=${vaultBalance}`);
  } else {
    fail(`I2 VIOLATED: minted=${totalMinted}, redeemed=${totalRedeemed}, redeem_invalid=${totalInv}, vault=${vaultBalance} (expected redeemed+invalid=${totalMinted - vaultBalance})`);
  }

  // I3: outcome immutable once written.
  const oc = outcomeKind(m.outcome);
  if (oc !== "unsettled" && m.settledAtUnix > 0n) {
    ok(`I3 outcome immutable: ${oc} @ settledAtUnix=${m.settledAtUnix}`);
  } else {
    fail(`I3 VIOLATED: outcome=${oc}, settledAtUnix=${m.settledAtUnix}`);
  }

  // I4: tokens only created via mint_pair / destroyed via redeem(_invalid).
  // Per-side token conservation, derived directly from the contract semantics:
  //   mint_pair(amount)        creates `amount` YES AND `amount` NO
  //   redeem(amount)           burns `amount` of the winning side only
  //   redeem_invalid(amount)   burns `amount` of YES AND `amount` of NO
  //
  // So per side:  Σ minted (per side) = Σ in_wallets + Σ burned_on_that_side
  //
  // This is the actual contract invariant; it holds regardless of trading
  // symmetry (Phoenix transfers shuffle ownership but don't create/destroy
  // tokens). Earlier draft of this check (`remYes === remNo`) only happened
  // to hold due to sim-specific trading symmetry — caught by audit
  // (Sonnet, 2026-05-22) and replaced with this structural per-side check.
  let remYes = 0n, remNo = 0n;
  for (const pos of state.positions.values()) {
    remYes += pos.yesBalance;
    remNo  += pos.noBalance;
  }
  if (isInvalid) {
    // Invalid path: only redeem_invalid burns; both sides drained by totalInv.
    const yesOk = totalMinted === remYes + totalInv;
    const noOk  = totalMinted === remNo + totalInv;
    if (yesOk && noOk) {
      ok(`I4 (invalid): per-side conservation: minted=${totalMinted} = remYes(${remYes}) + redeemInv(${totalInv}) AND = remNo(${remNo}) + redeemInv(${totalInv})`);
    } else {
      fail(`I4 (invalid) VIOLATED: minted=${totalMinted}, remYes=${remYes}+redeemInv=${totalInv}={yes side ${yesOk}}, remNo=${remNo}+redeemInv=${totalInv}={no side ${noOk}}`);
    }

    // I4-RECOVERY (informational, NOT a contract invariant): if traders hold
    // asymmetric positions post-Invalid, redeem_invalid leaves some stake
    // stranded (recoverable only via Phoenix rebalance). This is a known
    // UX gap documented in Drew's handoff Risks #1, not a contract bug.
    let totalRecoverablePairs = 0n;
    for (const pos of state.positions.values()) {
      totalRecoverablePairs += pos.yesBalance < pos.noBalance ? pos.yesBalance : pos.noBalance;
    }
    const stranded = totalMinted - totalInv - totalRecoverablePairs;
    if (stranded === 0n) {
      ok(`I4-RECOVERY (informational): all minted stake is either redeemed or in a balanced pair (no stranded value)`);
    } else {
      console.warn(`  ⚠ I4-RECOVERY (informational): ${stranded} micro-USDC of stake is stranded as asymmetric YES/NO positions; recovery requires Phoenix rebalance before redeem_invalid (Drew handoff Risks #1, not a contract bug)`);
      ok(`I4-RECOVERY informational warning emitted (does not fail the contract invariant)`);
    }
  } else {
    let remWin = 0n;
    for (const pos of state.positions.values()) {
      remWin += winSide === "yes" ? pos.yesBalance : pos.noBalance;
    }
    // Winning-side conservation: Σ minted = Σ winning_in_wallets + Σ redeemed
    const winningOk = totalMinted === remWin + totalRedeemed;
    // Losing-side conservation: Σ minted = Σ losing_in_wallets + 0 burns
    // (losing tokens have no redeem path and are NOT destroyed on yes/no outcome).
    const remLose = winSide === "yes" ? remNo : remYes;
    const losingOk = totalMinted === remLose;
    if (winningOk && losingOk) {
      ok(`I4 per-side conservation: minted=${totalMinted} = rem${winSide}(${remWin})+redeemed(${totalRedeemed}) AND minted = rem${winSide === "yes" ? "no" : "yes"}(${remLose})+0`);
    } else {
      fail(`I4 VIOLATED: winningSide ${winningOk}, losingSide ${losingOk}; minted=${totalMinted}, remWin=${remWin}+redeemed=${totalRedeemed}, remLose=${remLose}`);
    }
  }

  // I5: position-exclusivity (Hard YES #8 — frontend guardrail; benign on chain).
  let both = 0;
  for (const [k, p] of state.positions.entries()) {
    if (p.yesBalance > 0n && p.noBalance > 0n) {
      console.warn(`  ⚠ I5 informational: ${k} yes=${p.yesBalance} no=${p.noBalance}`);
      both++;
    }
  }
  ok(`I5 position-exclusivity: ${both} wallet(s) hold both sides (benign per Hard YES #8)`);
}

BigInt.prototype.toJSON = function () { return this.toString(); };
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
