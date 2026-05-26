# BellMarkets — Behavior Spec

> What the system does, end-to-end. The contract between intent and
> implementation. The file partner reviews compare against. The file
> graders read first.

This project is a **DeFi dApp** (Solana smart contract + automation service + browser frontend). The behavior spec below is shaped for that — not for ed-tech, generic backend APIs, agent systems, or data pipelines. The ed-tech / API / agent / data sections from the SDD template have been deleted; replaced with sections that fit the trading-app shape.

---

## 1. What the system does (1-paragraph)

A user connects a Solana wallet (Phantom, Backpack, Solflare). They see a list of 7 MAG7 stocks, each with multiple strike prices for today's session. For any strike, they can place one of four trade actions — Buy Yes (bullish), Buy No (bearish), Sell Yes (exit bullish), Sell No (exit bearish) — each of which signs ONE wallet transaction. At 4:00 PM ET, all open markets settle: an on-chain Pyth read writes the closing price into the contract, the binary outcome is computed (close ≥ strike → Yes wins; close < strike → No wins), and the outcome is permanent. After settlement, users click "Redeem" on their winning tokens to receive $1 USDC each. Losing tokens redeem to $0. The system is non-custodial — users sign every transaction, the program holds only the USDC vault collateral for active markets.

---

## 2. Users + roles

### Primary user: **Demo trader** (Solana devnet wallet holder)
- **Wants:** to bet directionally on intraday MAG7 closes, with known max gain ($1) and known max loss (their entry cost), no margin / no Greeks / no surprises.
- **Needs (must-have):** wallet connection in <5s, real-time prices and book depth, position-aware constraints (UI prevents holding both Yes and No from trading), atomic Buy No / Sell No flows (one signature, not three), redeem flow with immediate USDC payout.
- **Won't tolerate:** stale prices > 5 seconds, broken refresh that loses their position view, settlement that doesn't pay the correct side, redeem failures after settle.

### Secondary user: **Gauntlet evaluator / partner reviewer**
- **Wants:** reproducible lifecycle demo, defensible architecture explanation, clear trade-offs.
- **Needs:** one-command setup (`bash scripts/one-command-demo.sh` runs `create → mint → trade → settle → redeem`), a README with the project's spiky POVs and DRs cited, ability to verify the $1 invariant by running the property tests.

### Operator: **Demo team (Tate at the helm)**
- **Needs:** automation service that runs locally during demo day for the happy-path lifecycle, and a documented cron-failure recovery path (Hard YES #5) to demonstrate the permissionless-settle design (DR-002) is real, not theoretical.

---

## 3. Core user journeys

> The four trade-path journeys are the load-bearing UX of the product (POV-3). Each MUST translate to one wallet-signed transaction from the user's perspective.

### 3.1 Buy Yes (bullish, take liquidity)

**Trigger:** user clicks "Buy Yes" on a strike's trade panel.

**Steps:**
1. User connects wallet (if not already) and sees their bUSDC balance.
2. User browses active contracts, selects a strike (e.g., "META > $610").
3. UI displays current YES/NO prices (NO derived from YES via complementary identity), implied probability, and book depth from the on-chain OrderBook PDA.
4. User chooses market or limit, enters bUSDC amount, clicks "Buy YES."
5. Frontend assembles ONE transaction: `place_order(SIDE_BID, price, size, is_market)` against the on-chain in-program CLOB. The tx includes maker payout ATAs in `remaining_accounts` (one per planned fill, per `place_order.rs` contract).
6. Wallet prompts user to sign.
7. On-chain: matcher runs three-phase (plan fills → settle CPI per fill, PDA-signed → apply book updates). bUSDC moves from user/escrow to maker; YES tokens move from yes_escrow → user.
8. Frontend's `onAccountChange` subscription fires on the OrderBook PDA; UI updates: YES balance ↑, bUSDC balance ↓, position view refreshes.

**Success criteria:** YES tokens appear in user's wallet within 1–2 seconds. No intermediate "minting pair" step is shown. Vault invariant intact (trading is escrow-only, never touches usdc_vault).

**Failure modes:**
- Wallet declines → UI shows a non-blocking toast; nothing changes on-chain.
- Order doesn't fill (limit too aggressive, book empty) → user sees the open order with cancel option.
- User already holds No tokens for this strike → UI shows "Close your No position first" before allowing the buy (position-exclusivity per Hard YES #8).

### 3.2 Buy No (bearish, first-class operation)

**Trigger:** user clicks "Buy No" on a strike's trade panel.

**Steps:**
1. User selects strike, sees YES/NO prices (NO = $1 − YES at midpoint), picks market (DR-019: NO is market-only in v1), enters bUSDC amount, clicks "Buy NO."
2. Frontend assembles ONE transaction: `[mint_pair(amount), place_order(SIDE_ASK, ignored_price, amount, is_market=true)]` — bundled atomically. The place_order leg is IOC (fill-or-cancel).
3. Wallet prompts ONCE for signature.
4. On-chain: `mint_pair` debits bUSDC + mints equal YES + NO; `place_order` immediately sells the just-minted YES against the best bid. User ends up with the NO token only. Effective cost = `$1 − yes_sale_price`.
5. UI updates: NO balance ↑, bUSDC balance ↓ by net cost, position view refreshes.

**Success criteria:** ONE signature, ONE transaction, ZERO visible "mint pair" UI step (POV-3). The transient intermediate state (holding both YES and NO mid-transaction) is never displayed.

**Failure modes:**
- YES sale doesn't fill (no bid at acceptable price) → entire bundled tx fails atomically; user is back to original state. UI shows "Couldn't find a buyer — book is thin."
- User already holds YES tokens for this strike → UI shows "Close your YES position first" (Hard YES #8).

### 3.3 Sell Yes (exit bullish)

**Trigger:** user clicks "Sell Yes" from their portfolio.

**Steps:**
1. User opens `/portfolio`, sees their YES position for a strike, clicks "Sell YES."
2. UI shows current YES bid prices from the on-chain OrderBook, lets user pick market or limit.
3. Frontend assembles ONE transaction: `place_order(SIDE_ASK, price, size, is_market)`. YES tokens debited from user → yes_escrow; matcher runs three-phase to cross against resting bids; bUSDC paid from usdc_escrow → user via PDA signer.
4. Wallet signs.
5. On-chain: matcher executes; YES → taker (or rests if limit); bUSDC → user.
6. UI updates: YES balance ↓, bUSDC balance ↑, P&L row shows realized.

**Success criteria:** bUSDC arrives in wallet within 1–2s. Realized P&L = `sale_price − entry_price` per token. Vault invariant intact (escrow-only, never vault).

### 3.4 Sell No (exit bearish, first-class operation)

**Trigger:** user clicks "Sell No" from their portfolio.

**Steps:**
1. User clicks "Sell NO" on a NO position.
2. Frontend assembles ONE transaction: `[place_order(SIDE_BID, ignored_price, size, is_market=true), redeem_pair(size)]` — bundled atomically. The place_order leg is IOC.
3. Wallet signs ONCE.
4. On-chain: YES bought via matcher (escrow flows); held NO is immediately paired with the just-bought YES and redeemed for $1 bUSDC per pair. Net effect: user receives `$1 − yes_buy_price` more bUSDC.
5. UI updates: NO balance ↓, bUSDC balance ↑, P&L row shows realized.

**Success criteria:** ONE signature. The buy-YES mechanic is invisible to the user (POV-3).

### 3.5 Settlement (operator + user)

**Trigger:** clock reaches 4:00 PM ET. The PRD mandates settlement within 10 min of close.

**Steps (happy path):**
1. Bram's automation service polls Pyth for closing prices.
2. At ~4:05 PM ET (after the 5-min Pyth staleness threshold has elapsed for the most recent price), automation calls `settle_market` for each open market.
3. On-chain: `settle_market` re-validates Pyth (staleness + confidence), computes binary outcome, writes it immutably.
4. Frontend's `onAccountChange` fires on each market account; UI updates to show "SETTLED — YES WINS" / "NO WINS" + $ payout per token.
5. Redeem button activates on all of the user's settled positions.

**Steps (Pyth fails persistently):**
1. Automation retries every 30s for 15 min (per PRD).
2. If still failing, operator (Tate) is alerted; runs `admin_settle` with a manual price after the ≥1hr on-chain time delay (Hard YES #7).
3. Demo includes this path as part of the cron-failure narrative.

**Steps (automation service fails — Hard YES #5 demo path):**
1. Automation never calls settle (because it's offline / crashed / killed).
2. ANY user — even one without a position — calls `settle_market` themselves via the frontend's `/portfolio` page "Trigger settle" button (visible only when `block_time >= settlement_window`).
3. On-chain: `settle_market` validates Pyth, writes outcome — same as the happy path. Permissionless settle (DR-002) means no signing authority is required.
4. **Demo step:** Tate intentionally kills automation 30 seconds before 4pm ET, then asks an audience member to crank settle from their browser.

**Success criteria:** Every open market is settled within 10 minutes of 4:00 PM ET (PRD-mandated). The $1 invariant holds in 100% of settlements (Hard YES #1).

**Failure modes:**
- Pyth wide confidence at exactly 4:05 → automation retries; if persistent, admin override kicks in after 1hr.
- Race condition: automation and a user both call settle at the same instant → one tx wins, the other fails cleanly with "already settled" error. Loser pays gas; outcome is unaffected (benign per `decisions.md` DR-002).

### 3.6 Redeem

**Trigger:** user clicks "Redeem" on a settled winning token.

**Steps:**
1. User opens `/portfolio` after a market has settled.
2. UI shows "WINNER — $1.00" badge on the winning side of each settled market.
3. User clicks "Redeem all" or per-market "Redeem."
4. Frontend assembles ONE transaction: `redeem` instruction (burns tokens, transfers USDC from vault).
5. Wallet signs.
6. On-chain: tokens burn, USDC transfers, P&L finalizes.

**Success criteria:** USDC arrives in wallet within 1–2s. Losing tokens can also be "redeemed" but pay $0 (cleared from portfolio view).

**Failure modes:**
- Market not yet settled → button is disabled, tooltip explains.
- Already-redeemed token → button hidden (token balance is zero).

---

## 4. Daily lifecycle (operational state machine)

```
Post-close (prev trading day, 4:05 PM ET)
              Automation's grid-phase1-anchor cron settles expiring markets
              AND creates next day's strike grid (7 tickers × 7 strikes = 49 markets)
              Each new market goes through init_order_book + grow_order_book
              (or user-funded via user_create_strike_market — DR-005)
4:00 PM ET    US market close
~4:05 PM ET   Automation polls Pyth, calls settle_market for each open market
              [if automation down → any user can call settle_market from /portfolio]
~4:05 PM ET+  Redemption enabled; winners claim bUSDC
              [unredeemed tokens remain redeemable indefinitely]
After-hours   grid-phase2-ah-check polls every 30 min for wild-swing strike expansion
Pre-market    grid-phase3-pm-check polls every 30 min for wild-swing strike expansion
```

### Per-market state machine

```
Created → Mintable → Tradable → SettlementPending → Settled → (Redeemed)
                                                  ↓ (Pyth fails)
                                                  Admin override (after 1hr delay)
```

| State | Triggered by | Transitions |
|---|---|---|
| **Created** | `create_strike_market` (admin) | → Mintable on completion |
| **Mintable** | After creation | Users can `mint_pair`; YES/NO tokens trade on the in-program CLOB |
| **Tradable** | After `grow_order_book` sets `strike_market.order_book` (trading gate) | → SettlementPending at `settlement_window` |
| **SettlementPending** | `block_time >= settlement_window` | `settle_market` callable by anyone (DR-002) |
| **Settled** | `settle_market` writes outcome | Immutable; redeem enabled |
| **Admin override** | `admin_settle` after `settlement_window + 1h` (Hard YES #7) | Same end state as Settled |
| **Redeemed** | Per-user via `redeem` | Per-token; outstanding pairs counter decrements |

---

## 5. Edge cases + known constraints

- **Strike collision after rounding:** for low-priced stocks (e.g., a hypothetical $230 stock at ±3% rounded to $10), multiple strike levels can dedupe to the same value. Resolution: dedup at strike-calc time; result is fewer than the nominal 7 strikes for that stock (e.g., 5 strikes for AAPL example in PRD). UI shows actual unique strikes.
- **OrderBook is empty for a strike:** Buy YES market order has no asks to take → tx fails cleanly; UI tells user "no liquidity at this strike, try a limit." Buy NO (which requires a YES sale via IOC) similarly fails.
- **User refreshes mid-flow:** position view reads on-chain state via `useAllMarkets` + `useOrderBook` + `usePosition`; refresh shows authoritative current state. Neon DB serves product surface only; if it disagrees with chain, chain wins.
- **Browser tab close mid-tx:** wallet's signed tx may still land; on next session, position view will reflect the actual on-chain state.
- **Concurrent buy-NO by two users:** both bundle `mint_pair + place_order(SELL_YES, IOC)`. Both succeed (independent pairs minted); race only matters if the OrderBook's bid side is too thin to absorb both IOC sales — then one or both `place_order` calls return zero-fill IOC, atomically reverting the bundled tx and refunding the user's bUSDC.
- **Pyth feed missing for a ticker (config error):** `create_strike_market` rejects the call with a clear error; admin fixes config before retrying.
- **Settlement at exactly `block_time == settlement_window`:** allowed (PRD says "at-or-after").
- **At-strike close (close == strike):** Yes wins (PRD's at-or-above rule).

---

## 6. Non-goals (explicit)

- Mobile app — desktop browser only (see `specs/deferred.md` "mobile app")
- i18n / multi-language UI — English only
- Multi-tenant admin or operator dashboards beyond pause/unpause (see deferred)
- Off-chain DB as source of truth for funds (DB serves product surface only; chain is canonical for funds — see `hard-rules.md` §3.3 amended)
- KYC, off-ramp, fiat on-ramp (see `hard-rules.md` §3.1)
- Non-MAG7 stocks, margin, perpetuals, leveraged tokens, cross-strike netting (see `hard-rules.md` §3.2)
- Mainnet deployment for the core submission (stretch goal — v1.1 rent-recovery is hard precondition)
- Phoenix CLOB integration (DR-020 superseded DR-001; deferred to v2 secondary-venue candidate)
- Fallback oracle if Pyth is down (DR-003 trade-off — admin override on 1hr time delay is recovery)
- Limit-side NO trades (DR-019 — NO market-only in v1; resting Limit NO would strand fees on cancel)
- Post-settle rent recovery for OrderBook + escrows (v1.1; ~95% of per-market rent recoverable — see `specs/deferred.md`)
- Self-funding settle bounty (future feature — see deferred)

Cross-reference `specs/deferred.md` for the full rationale on each.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+) — customized for DeFi dApp shape (ed-tech / API / agent / data sections removed)
> **Created:** 2026-05-21
>
> **Update protocol:** edit via MR. Major behavior changes get tagged
> `spec-change`. Surface the change in the MR description with the
> user-visible delta.
