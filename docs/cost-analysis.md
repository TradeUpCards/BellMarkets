# BellMarkets — Cost Analysis

> **Scope:** SOL costs to operate BellMarkets — what the protocol spends to function, where the rent goes, what's recoverable, what's stranded.
>
> **Status:** As of submission (2026-05-25), deploy_index=8. All devnet numbers verified on-chain. Mainnet projections use the same lamports-per-byte formula (rent is identical across clusters; the cluster only changes the $ value of SOL).
>
> **Why this matters:** The cost-per-market burn rate is the load-bearing economic argument for the v1.1 rent-recovery instructions (`force_cancel_order` + `close_order_book`). Without them, ~187 SOL/month leaks at production scale.

---

## 1. Cumulative deploy costs

Source: `migrations/audit_log.jsonl` (8 entries through 2026-05-25).

| # | Date | Type | .so KB | Cost SOL | Cumulative SOL | Notes |
|---|---|---|---|---|---|---|
| 1 | 2026-05-21 | initial | 348.7 | 2.486 | 2.486 | First deploy. ProgramData rent dominates. |
| 2 | 2026-05-21 | upgrade | 390.5 | 0.300 | 2.786 | Handler bodies filled. |
| 3 | 2026-05-22 | upgrade | 414.3 | 0.170 | 2.956 | DR-005 user-funded creation surface. |
| 4 | 2026-05-22 | upgrade | 436.1 | 0.159 | 3.115 | DR-007 lifecycle hooks. |
| 5 | 2026-05-23 | upgrade | 741.2 | 2.179 | 5.294 | DR-008 + DR-010 + DR-011 expansion (+312 KB; required 2 SOL pre-deploy top-up). |
| 6 | 2026-05-24 | upgrade | 741.8 | 0.008 | 5.306 | DR-015 leaderboard multi-metric (no schema change). |
| 7 | 2026-05-25 | upgrade | 915.5 | 1.243 | 6.549 | **DR-020 in-program CLOB pivot.** +178 KB. Adds 6 ixs + OrderBook account. |
| 8 | 2026-05-25 | upgrade | 931.9 | 0.122 | **6.671** | Path B (`reinit_rewards_pools` for bUSDC migration) + Sonnet-audit defense-in-depth fixes. |

**Total program deploy cost to submission:** 6.671 SOL.
**Upgrade-authority remaining:** ~8.329 SOL of 15 SOL provisioned (10 SOL initial + 5 SOL pre-deploy-7 top-up).

### Mainnet projection — deploy
- **Initial mainnet deploy at submission binary size (~932 KB):** ~6.64 SOL (one-time ProgramData rent + tx fees). At $160/SOL ≈ **$1,062**.
- **Upgrade cadence (5 upgrades/year, +5% binary growth each):** ~1 SOL/year ≈ **$160/year**.

---

## 2. Per-market rent (verified on-chain, 2026-05-25)

Per-market PDA + token-account rent (all numbers from `services/automation/scripts/check-rent.ts` against the seeded META $610 market — fetched from Solana RPC, not formula-only).

| Account | Size | Rent (SOL) | Closable today? | Closable v1.1? |
|---|---|---|---|---|
| StrikeMarket | 333 B | 0.003209 | ❌ tombstone by design | ❌ keep as tombstone |
| **OrderBook** | **16,448 B** | **0.115369** | **❌ no close path** | ✅ `close_order_book` |
| usdc_vault | 165 B | 0.002039 | ✅ `close_settled_market` | ✅ (existing) |
| usdc_escrow | 165 B | 0.002039 | ❌ | ✅ `close_order_book` |
| yes_escrow | 165 B | 0.002039 | ❌ | ✅ `close_order_book` |
| yes_mint | 82 B | 0.001462 | ❌ no `close_authority` | ❌ (v1.2: add `mint::close_authority`) |
| no_mint | 82 B | 0.001462 | ❌ same | ❌ same |
| **Total per market** | | **0.127619** | **0.002039 (1.6%)** | **0.121486 (95.2%)** |

The OrderBook is **90.4% of per-market rent** — it's the single line that matters for any cost-reduction work. The mints together are 2.3% — small enough to defer to v1.2 (the close requires adding `mint::close_authority` to the Anchor init schema, a program upgrade for ~$1.50/market on mainnet).

### How the OrderBook ends up at 16,448 B

```
8 (Anchor discriminator)
+ 32  (market: Pubkey)
+ 8   (next_seq: u64)
+ 64 × 128 (bids: [Order; 128])     ← 8,192 B
+ 64 × 128 (asks: [Order; 128])     ← 8,192 B
+ 2   (bids_len: u16)
+ 2   (asks_len: u16)
+ 1   (bump: u8)
+ 11  (_reserved padding)
= 16,448 B
```

`ORDERBOOK_N = 128` is the resting-order cap per side per market. Hard cap. Adequate for demo + early mainnet; not a deep-liquidity venue. v2 expansion (256 or slab-style) is a schema change requiring migration planning.

### Rent recovery math under v1.1

```
Phase A — immediately post-settle (cancel sweep + close_order_book):
  recovered = 0.115369 (OrderBook) + 0.002039 + 0.002039 (both escrows)
            = 0.119447 SOL

Phase B — after all redemptions complete (existing close_settled_market):
  recovered = 0.002039 SOL (usdc_vault)

Permanently stranded (tombstone + mints without close_authority):
  stranded = 0.003209 (StrikeMarket tombstone) + 0.001462 + 0.001462 (mints)
           = 0.006133 SOL

Net recoverable per market under v1.1: 0.121486 SOL = 95.2%
Stranded:                              0.006133 SOL =  4.8%
```

---

## 3. Operating cost at scale

Demo scope: 7 MAG7 tickers × 7 strikes = 49 markets/day. Each market created at the prior day's 4:05 PM ET close (`grid-phase1-anchor` cron). Each is single-day-expiry (0DTE).

### Daily / monthly rent burden

| Scope | Markets created | SOL/scope (no recovery) | SOL/scope (v1.1 recovery) |
|---|---|---|---|
| Daily | 49 | 6.253 | 0.301 (4.8% stranded) |
| Weekly (5 trading days) | 245 | 31.27 | 1.50 |
| **Monthly (~21 trading days)** | **1,029** | **131.3** | **6.31** |
| Annual (~252 trading days) | 12,348 | 1,576 | 75.7 |

### Mainnet $ projection (at $160/SOL)

| Scope | Cost today (v1) | Cost under v1.1 | Recovery |
|---|---|---|---|
| Daily | $1,000 stranded | $48 stranded | $952/day saved |
| Monthly | $21,000 stranded | $1,010 stranded | $19,990/month saved |
| Annual | $252,000 stranded | $12,100 stranded | $239,900/year saved |

These are gross operator costs (rent that's locked, not paid as tx fees). Under DR-005 (user-funded strike creation via `user_create_strike_market`), the **first user to want to trade a strike** pays the ~$0.90 PDA-init friction — so for sparsely-traded strikes the operator pays $0. But for the dense ATM strikes that get auto-created at end-of-day, the operator wears it.

**Conclusion: v1.1 is non-negotiable before mainnet.** $240K/year stranded rent on a project with no revenue is not viable. The two new instructions (~60-90 min Aria work + new deploy_index) are documented in `specs/deferred.md` and `docs/architecture/pre-mainnet-readiness.md` §"v2 gap #8".

---

## 4. Per-trade tx fees (operator-borne vs user-borne)

Every Solana transaction pays the validator a base fee of 5,000 lamports per signature (0.000005 SOL ≈ $0.0008 at $160/SOL). Compute-unit (CU) fees on top of that depend on the instruction.

| Action | Signer | Approx CU | Approx total fee | Who pays |
|---|---|---|---|---|
| `mint_pair` | user | ~25K CU | 5,000 lamports + CU | User |
| `place_order` (limit, rests) | user | ~35K CU | 5,000 lamports + CU | User |
| `place_order` (market, crosses 1-3) | user | ~50-100K CU | 5,000-7,500 lamports + CU | User |
| `cancel_order` | user | ~20K CU | 5,000 lamports + CU | User |
| `settle_market` | **any signer** (DR-002) | ~30K CU | 5,000 lamports + CU | Cron (happy path) OR any user (failure path) |
| `redeem` | user | ~20K CU | 5,000 lamports + CU | User |
| `create_strike_market` (admin path) | admin | ~50K CU | 5,000 lamports + CU + ~0.005 SOL PDA rent | Admin / operator |
| `user_create_strike_market` (DR-005) | user | ~50K CU | 5,000 lamports + CU + ~0.005 SOL PDA rent | User (Meteora-style cost-shift) |
| `init_order_book` + `grow_order_book` | any signer | ~80K CU total | 0.115 SOL PDA rent | Whoever cranks first (currently operator) |

### Cron tx-fee burden

The automation cron (Trigger.dev) cranks `settle_market` + the post-close phases. Assuming ~50 settle txs/day + 100 grid-evolution txs/day = ~150 txs/day × 5,000 lamports/tx = 750,000 lamports/day = 0.00075 SOL/day = 0.275 SOL/year. At $160/SOL: **~$44/year in operator tx fees** (rounding error compared to rent).

---

## 5. AI + DB + Vercel costs (off-chain)

| Service | Tier | Usage | Cost |
|---|---|---|---|
| Anthropic Sonnet (briefings) | API | 7 briefings/day × ~3K tokens output × $15/MTok | ~$0.32/day = ~$10/month |
| Neon Postgres | Free tier | <500 MB storage, <50 GB compute-hours/mo | $0 (well within free tier for demo) |
| Vercel | Free tier (Hobby) | <100 GB bandwidth/mo | $0 (sufficient for demo + light traffic) |
| Trigger.dev | Free tier | <50 runs/day | $0 (sufficient for demo) |
| Helius RPC | Free tier (devnet) | <100K req/day | $0 |
| Helius RPC (mainnet projection) | Standard tier | ~500K req/day at moderate traffic | ~$49/month |

**Off-chain $ costs at demo scale:** ~$10/month (Anthropic only).
**Off-chain $ costs at projected mainnet scale (10K MAU):** ~$60-100/month (Helius + Anthropic + paid Vercel tier if needed).

---

## 6. Cost-per-user economics (mainnet)

For a mainnet-launched protocol, the unit economics that matter:

- **First-trade friction (DR-005 path):** ~0.005 SOL = ~$0.80 to spawn a fresh strike's PDAs. Absorbed by the first trader of that strike. Self-balancing — strikes nobody wants never exist.
- **Per-trade fee paid by user:** 5,000 lamports = ~$0.0008 in tx fees. Negligible.
- **Operator's per-market rent (without v1.1):** $20.42 per market locked. **Unviable.**
- **Operator's per-market rent (under v1.1):** $0.98 per market permanently stranded. Viable.

Break-even per market = $0.98 in fees collected. At DR-008's locked fee model (25 bps mint fee + 10 bps in-program taker), this is reached at **~$390 in mint volume per market** — easily achievable for any market with meaningful trading activity.

---

## 7. What's stranded vs recovered — visual summary

```
┌────────────────────────────────────────────────────────────────┐
│                Per-market rent: 0.127619 SOL                   │
├────────────────────────────────────────────────────────────────┤
│  Today (deploy_index=8 / submission):                          │
│  ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  Recoverable: 0.002 SOL (1.6%)                                 │
│                                                                 │
│  v1.1 (post-submission, pre-mainnet):                          │
│  ███████████████████████████████████████████████████████████░░ │
│  Recoverable: 0.121 SOL (95.2%) — adds force_cancel_order      │
│                                  + close_order_book            │
│                                                                 │
│  v1.2 (post-mainnet polish):                                   │
│  ██████████████████████████████████████████████████████████████│
│  Recoverable: 0.124 SOL (97.4%) — adds close_market_mints      │
│  (requires program upgrade: mint::close_authority on init)     │
└────────────────────────────────────────────────────────────────┘
```

---

## 8. Sources

- **On-chain rent verification:** `services/automation/scripts/check-rent.ts` — re-runnable spot-check against any seeded market.
- **Deploy cost ledger:** `migrations/audit_log.jsonl` — one entry per deploy.
- **Recovery design:** `docs/architecture/pre-mainnet-readiness.md` §"v2 gap #8" (full technical design with tombstone-safety analysis).
- **Deferral entries:** `specs/deferred.md` §"OrderBook + escrow rent recovery" (v1.1 P1) + §"Mint rent recovery" (v1.2).
- **Brief callout (interview defense):** `docs/brief-v2-polish.md` §3 (v2 gap #8 reframe).

---

> **Owner:** Drew (quality + pre-mainnet readiness) + Tate (gating). **Last verified:** 2026-05-25 against deploy_index=8 + seeded META $610 market.
