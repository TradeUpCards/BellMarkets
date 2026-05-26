# Demo-Readiness Plan — Create → Trade → Settle → Redeem

**Goal:** every demo step is real on-chain. Strike markets, order book, and trading are non-negotiable. Leaderboards / contests / AI briefings / cosmetic widgets can stay as fixtures.

**Time budget:** submission Mon 2026-05-25 7pm ET (= today, end of day). Plan assumes ~12 working hours.

---

## What's actually real right now

| Surface | Status | Notes |
|---|---|---|
| Anchor program | ✅ Real | deploy_index=8, 27 ixs, `599h7Vzn…`. Verified E2E trade tonight. |
| Order book matcher | ✅ Real | 1 trade proved on devnet (tx `5rTS2SBoo…`). Vault invariant intact. |
| `useAllMarkets` / `useOrderBook` / `usePosition` / `useMarketConfig` | ✅ Real | Hooks return live chain state. |
| Tx builders (buy/sell YES, buy/sell NO atomic, mint_pair, redeem_pair) | ✅ Real | All wired to wallet adapter. |
| Wallet adapter (Phantom/Backpack/Solflare) | ✅ Real | |
| Helius RPC proxy (`/api/solana-rpc`) | ✅ Real | Key server-side. |
| AI briefings (Bell Pro) | ✅ Real | Neon DB + Anthropic Sonnet, live on /api/briefings/AAPL. |
| User upsert + OAuth flow | ✅ Real | Cleo's `c7f530e` shipped. |

## What's mock right now

| Surface | File | Mock |
|---|---|---|
| Probability matrix on landing | `apps/web/app/landing-view.tsx` `MATRIX_ROWS` (L99-191) | 7 static rows, hardcoded strikes + probs |
| CNBC marquee | `landing-view.tsx` `TICKERS` (L68-76) | 7 static spot/chg pairs |
| Session block (markets count, vol, trades, wallets) | `landing-view.tsx` L488-512 | All hardcoded |
| Trade page strike rail | `trade-view.tsx` `STRIKES` (L55) | `[620, 640, 660, 680, 700, 720, 740]` — wrong for $610 |
| Trade page strike probabilities | `trade-view.tsx` `STRIKE_PROBS` (L56-64) | Hardcoded percentages |
| Trade page bid/ask fallbacks | `trade-view.tsx` L68-71, L207-212 | When book is empty, falls back to constants |
| Trade page USDC balance | `trade-view.tsx` `USDC_AVAIL_FALLBACK = 123.45` (L72, L215) | `// TODO: useTokenBalance(usdcAta)` |
| Leaderboard / Recent Fills / Contests | `landing-view.tsx` | OUT OF SCOPE per user — can stay mock |

## What's missing for a real demo

| Item | Why |
|---|---|
| ≥1 market per MAG7 ticker on-chain at deploy_index=8 layout | Otherwise the matrix has nothing live to render |
| Each market with seeded liquidity | Otherwise the order book is empty everywhere |
| Real MAG7 Pyth devnet feeds OR a documented "demo uses SOL/USD" disclosure | Settlement reads from the bound feed; currently using SOL/USD fallback |
| A second wallet (not admin) funded with bUSDC for the trade demo | Self-trade works but isn't a credible demo |
| Settlement smoke test on a fast-expiry market | Proves the settle path beyond the matcher |
| Redemption smoke test post-settlement | Closes the loop |

---

## Demo flow (what we must be able to show)

```
1. Cory connects Phantom (devnet) — wallet visible in top-right
2. Cory clicks META ATM cell in matrix → /trade/META/610
3. Trade page shows: real bid/ask from book, real strike list, real bUSDC balance
4. Cory places a market BUY YES at the current ask — tx signs in Phantom
5. Order book updates live (websocket subscription) — ask consumed
6. Position monitor shows the new YES contracts
7. (Settle demo) — fast-expiry market settles via Pyth → outcome set on-chain
8. Cory redeems winning YES → bUSDC lands back in wallet
```

The full 49-market grid would be nice but a **7-market grid (one ATM per ticker) is acceptable**. The reviewer will look at one ticker in depth, not enumerate all 49.

---

## Workstream assignments

### Aria — Onchain (~1-2 hours)

**Owns:** Anchor program correctness + Pyth feed strategy + verifying program-side prerequisites.

**Tasks:**

1. **Pyth feed audit (30 min):** for each MAG7 ticker, check whether a Pyth devnet equity feed exists and is publishing. Use Pyth's `pyth.network/developers/price-feed-ids` page or check known devnet feed accounts. Report which tickers have live devnet feeds and which need fallback.
   - **Output:** `docs/pyth-feed-status.md` with per-ticker table.
2. **Fast-expiry settlement test market (30 min):** create one market with `expiry_unix` set to ~5-10 minutes from now. Crank `settle_market` against it. Verify:
   - `MarketSettled` event emits
   - `outcome` field updates from `Unsettled` to `Yes`/`No`/`Invalid`
   - `settle_price`, `settle_confidence`, `settled_at_unix` populate
   - Solscan tx link captured
3. **Redemption smoke test (15 min):** post-settlement, redeem 100 winning-side YES (or NO) from admin → verify 100 bUSDC lands in admin's ATA.
4. **Confirm `place_order` `remaining_accounts` contract is documented** in the trade-view tx builders (Cleo will need to pass maker payout ATAs from the book snapshot — verify her builders already do this).

**Blocking other leads on:** Pyth feed status report (Bram needs to know before creating the 49-market grid; Cleo's UI needs to know if it should display SOL/USD as the underlying for some markets).

---

### Bram — Automation (~2-3 hours)

**Owns:** Market creation grid + liquidity seeding + test wallets + cron status confirmation.

**Tasks:**

1. **Extend `seed-demo-liquidity.ts` to multi-strike (30 min):** instead of just ATM, seed each ticker with 3 strikes (ATM, +3%, -3%) or 5 strikes (ATM, ±3%, ±6%). 6-order ladder per strike. This gives the matrix something to render per row.
   - **Edit:** `services/automation/scripts/seed-demo-liquidity.ts` — change the strike loop.
2. **Run seed for all 7 MAG7 tickers (45 min):**
   - `pnpm seed-demo-liquidity --tickers META,NVDA,AAPL,MSFT,GOOG,AMZN,TSLA --expiry-days 5`
   - Capture all PDAs + tx sigs in `.project/bell-markets/coordination/demo-strikes.md`
3. **Confirm Trigger.dev cron status (15 min):** is the deployed dashboard active? If yes, leave it. If no, run `pnpm --filter @bell-markets/automation deploy` to push the schedule. Either is fine — just document which.
4. **Generate + fund test wallets (45 min):** run `generate-test-wallets`, `fund-test-wallets` (with both SOL and bUSDC), `export-wallets-for-phantom`. Hand 3 funded wallet JSONs to Cory for the demo.
5. **Optional if time:** seed a tx-history indexer so the Recent Fills tape on the landing page can be real. Skip if it'd take >1 hour.

**Depends on:** Aria's Pyth feed status (to know whether to use real feeds or SOL/USD fallback).
**Unblocks:** Cleo (needs the seeded markets to exist before she can verify the matrix renders correctly).

---

### Cleo — Frontend (~3-4 hours)

**Owns:** Replace mocks with live data on the two surfaces that must be real.

**Tasks:**

1. **Landing matrix → live (~90 min):** in `apps/web/app/landing-view.tsx`, replace `MATRIX_ROWS` with data derived from `useAllMarkets()`:
   - Group live markets by `underlying_pyth_feed` (resolves to ticker via known feed-pubkey map or `useTickerConfig`)
   - For each ticker, compute the strike ladder from the live markets, padding empty cells with `—`
   - For each cell, compute YES probability from the live order book midpoint via a new `useOrderBookMid(marketPda)` hook (or inline `useOrderBook` calls)
   - Keep visual treatment (heatmap classes) — just feed real numbers
   - **Acceptance:** matrix shows the 7 seeded ATM strikes Bram created with their real probability midpoints. Cells with no market show `—`.
2. **Trade page strikes array → live (~45 min):** in `trade-view.tsx`, derive `STRIKES` from `useAllMarkets()` filtered by ticker. Remove `STRIKE_PROBS` — show midpoint from book instead (already partially done via `liveYesAsk/Bid`).
3. **Wire bUSDC balance (~30 min):** replace `USDC_AVAIL_FALLBACK = 123.45` with `useTokenBalance(adminBusdcAta)` (already exists per `hooks/use-token-balance.ts`). The TODO comment shows where.
4. **CNBC marquee → live (~30 min, OPTIONAL):** replace `TICKERS` with Pyth Hermes REST fetch (`https://hermes.pyth.network/api/latest_price_feeds?ids=…`) for spot prices. Drop if time-pressed — marquee is the lowest priority.
5. **Smoke test in browser (~30 min):** with Bram's seeded markets live and your changes deployed, navigate /trade/META/610 → wallet connect → place a small order → confirm book updates.

**Depends on:** Bram's seeded markets (for the matrix to have anything to render).
**Unblocks:** Drew (E2E smoke test).

---

### Drew (Quality) — single E2E pass (~1 hour)

**Owns:** the final "click through everything in the browser" before submission.

**Tasks:**

1. **Full demo flow walkthrough in a real browser** (one of Bram's funded test wallets in Phantom):
   - Land on bell-markets.vercel.app → see real probability matrix
   - Click META ATM cell → /trade/META/610
   - Connect Phantom → see real bUSDC balance
   - Place a market buy at the ask → wallet signs → tx confirmed → book updates
   - Check position monitor shows the new contracts
   - Wait for Aria's fast-expiry market to settle (or use that one) → redeem winning side
2. **Capture screenshots / record GIF** at each step for the brief's "on-chain receipts" page.
3. **File any regressions** as commits to a `crt/drew-demo-fixes` branch with one-line PRs Cleo/Bram can merge fast.

**Depends on:** Aria + Bram + Cleo all done.
**Unblocks:** Submission.

---

## Dependency graph

```
       Aria (Pyth audit + settle/redeem smoke)
              │
              ↓
       Bram (multi-strike seed + 7-ticker grid + test wallets)
              │
              ↓
       Cleo (matrix → live, strikes → live, balance → live)
              │
              ↓
       Drew (E2E browser walkthrough + screenshots)
              │
              ↓
       Cory (record demo + submit)
```

Aria and Bram can start in parallel — Aria's Pyth status answers a question Bram needs but Bram can begin the multi-strike extension immediately while waiting.

---

## Acceptance bar (what "demo-ready" means)

✅ Landing matrix shows ≥7 ATM strikes with real probabilities from the live book midpoint
✅ Clicking any matrix cell loads the trade page with the right strike pre-selected
✅ Trade page shows real bid/ask from the on-chain order book
✅ Connecting a test wallet shows the correct real bUSDC balance
✅ Placing a market order signs in Phantom, confirms on devnet, and the book updates live
✅ Position monitor shows the contracts the user just bought
✅ At least one market has been settled on-chain with the resulting outcome visible
✅ Redemption of a winning position returns bUSDC to the wallet
✅ Every step above has a Solscan tx link captured for the brief's receipts page

---

## Out of scope for demo (stay mock — that's fine)

- Leaderboard rows
- Contest cards
- Recent Fills tape (unless Bram's bonus indexer lands)
- "active wallets" / "trades 24h" / "volume 24h" stats
- Earnings calendar / phase-3 PM checks
- Helio billing flow
- Discord / web-push notifications

These are correctly tagged `data-mock="true"` already. Don't waste cycles on them.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Pyth MAG7 devnet feeds missing or stale | Aria audits first; fall back to SOL/USD for tickers without feeds, document in brief |
| Market creation hits "already-exists" for ATM strikes | Use `--expiry-days 5` to force fresh PDAs |
| UI doesn't render new markets (decoder mismatch) | Verified tonight: the deploy_index=8 IDL decodes correctly. If issues, Cleo + Aria pair on the StrikeMarket layout. |
| Wallet connection flakes | Helius RPC proxy is in place; Phantom devnet support is solid. Drew tests with 2 wallets. |
| Settlement window doesn't open in time | Aria uses a 5-10 min expiry for the test market. Demo can be pre-recorded if needed. |

---

## Dispatch — ready to fire

When Cory approves this plan, the agent prompts are below. Cory can paste each into the corresponding lead's WSL terminal, or trigger me to dispatch them via the multi-agent flow.

### Aria prompt (paste into BellMarkets-aria WSL terminal)

> Read `docs/demo-readiness-plan.md` §"Aria — Onchain" for your full task list. Three deliverables:
> 1. `docs/pyth-feed-status.md` — per-MAG7-ticker devnet Pyth feed audit
> 2. Settlement smoke test on a fast-expiry market (5-10 min)
> 3. Redemption smoke test post-settlement
> Capture Solscan tx links for tasks 2 + 3. Report when complete.

### Bram prompt

> Read `docs/demo-readiness-plan.md` §"Bram — Automation" for your full task list.
> 1. Extend `seed-demo-liquidity.ts` to seed 3 strikes per ticker (ATM, +3%, -3%)
> 2. Run for all 7 MAG7 tickers with `--expiry-days 5` — capture PDAs to `.project/bell-markets/coordination/demo-strikes.md`
> 3. Generate + fund 3 test wallets, export Phantom-importable JSONs for Cory
> 4. Confirm Trigger.dev cron status (deployed or local-only); document either way
> Wait on Aria's `pyth-feed-status.md` before deciding whether to use real Pyth pubkeys or the SOL/USD fallback.

### Cleo prompt

> Read `docs/demo-readiness-plan.md` §"Cleo — Frontend". Priorities:
> 1. `apps/web/app/landing-view.tsx` — replace `MATRIX_ROWS` (L99-191) with live data from `useAllMarkets()` grouped by underlying_pyth_feed
> 2. `apps/web/app/trade/[ticker]/[strike]/trade-view.tsx` — replace `STRIKES`/`STRIKE_PROBS` (L55-64) with live derivation; wire `USDC_AVAIL_FALLBACK` (L72, L215) to `useTokenBalance`
> 3. Smoke-test /trade/META/610 in a real browser with a test wallet
> Wait on Bram's seeded markets before testing the matrix. You can start the code changes against the existing 1 seeded market in parallel.

### Drew prompt (or assign to Cleo as bonus pass)

> Read `docs/demo-readiness-plan.md` §"Drew — Quality". Single deliverable: full browser walkthrough of the demo flow against bell-markets.vercel.app once Aria + Bram + Cleo are done. Capture screenshots + Solscan tx links for the brief's receipts page.

---

## Cory's path

1. Sleep
2. Wake up, review this plan
3. Approve / edit
4. Dispatch the 3-4 leads in parallel
5. Re-converge in ~4-5 hours for Drew's E2E pass
6. Record demo + submit by 7pm ET

If anything blocks for >1 hour, fall back to "minimum viable demo" — 1 ticker (META), 1 strike (610), the trade we already proved tonight, plus a fast-expiry settle/redeem from Aria.
