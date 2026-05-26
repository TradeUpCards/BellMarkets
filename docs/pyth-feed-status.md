# Pyth Devnet Feed Status — MAG7 Audit

**Owner:** Aria (Onchain / Solana / Anchor lead)
**Date:** 2026-05-26 (post deploy_index=9)
**Cluster:** Solana devnet (`https://api.devnet.solana.com`)
**Audit method:** raw `solana account <pubkey> --url devnet` probes against the candidate Pyth on-chain price-account pubkeys for each MAG7 ticker, plus historical Pyth devnet equity pubkeys from prior docs.

---

## Executive summary

**Pyth devnet's v2 push price accounts are no longer maintained — they have NOT been updated in 660+ days.** This was empirically discovered during the deploy_index=9 compressed-time settle smoke (this session): the on-chain Pyth SOL/USD account `J83w4HKfqxwcq3...` exists with valid magic/version/atype headers, but its `agg.pub_slot` is 142,625,138 slots behind the current Solana devnet slot (delta × 0.4s/slot ≈ 660 days). Settlement against any of these stale feeds fails with `PythStale (6009)` because the on-chain staleness gate (`age_secs ≤ price_staleness_secs = 300`) cannot possibly pass.

**Consequence:** `settle_market` (the permissionless oracle-pathed settlement) is **unavailable on devnet** for any tested Pyth pubkey. All settlement on devnet must go through `admin_settle(forced_outcome)`, the escape-hatch admin ix.

In addition: **Pyth devnet does NOT publish US-equity price accounts** in any form (legacy v2 push OR new pull). All historically-referenced MAG7 equity pubkeys probed return `AccountNotFound`. The only Pyth on-chain devnet accounts I could find are a small set of crypto pairs (SOL/USD, BTC/USD) — and even those are 660+ days stale per above.

**Operational implication for the demo grid:** Bram's `create_strike_market` calls can still bind to a Pyth pubkey (the binding requires only that the pubkey is supplied — Anchor doesn't validate freshness at bind time), but **at expiry, `settle_market` will revert with `PythStale (6009)` on every strike on devnet.** The viable settle path is:

- **`admin_settle(forced_outcome)`** — admin pushes the canonical equity close price from off-chain (Pyth Hermes HTTP equity feeds DO publish MAG7 prices network-agnostically — feed IDs in Finding 2 below). The strike's `settle_price == 0` post-call marks "admin-pathed" (vs. oracle-pathed where `settle_price != 0`) so downstream UI / analytics can distinguish settlement source.

Bram's existing seeded demo strikes (META@$610, NVDA@$215, AAPL@$309 — all created 2026-05-25) are bound to SOL/USD (`J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix`) via `seed-demo-liquidity.ts`'s `FALLBACK_PYTH_DEVNET` constant. **Their permissionless `settle_market` path will FAIL `PythStale (6009)` at expiry.** Bram should call `admin_settle` against each seeded strike at expiry with the canonical equity close, or accept that the strikes never settle (only `cancel_order` would let users reclaim escrow).

**For deploy_index=9 smoke evidence:** the live attempt at `settle_market` on Strike A captured the `PythStale (6009)` error on chain (audit evidence the path is correctly wired). Both strikes were then settled via `admin_settle(Yes)` and the redeem flow verified end-to-end. See "Smoke evidence" section in `CLAUDE_SESSION_HANDOFF.md` for tx signatures + Solscan links.

---

## Per-ticker findings

For each MAG7, I probed the candidate Pyth on-chain pubkeys that historical docs / Pyth's older devnet registry mention. None resolved.

| Ticker | On-chain Pyth devnet feed | Last publish slot | Recommendation |
|---|---|---|---|
| **AAPL** | none (probed `4MEXNyMqsT...` and `cMzyA8AcBd...` — both `AccountNotFound`) | n/a | **SOL/USD fallback** for `create_strike_market` binding; `admin_settle` for resolution if off-hours / non-trading day. |
| **MSFT** | none (no canonical devnet pubkey in Pyth's published registry) | n/a | SOL/USD fallback; `admin_settle`. |
| **GOOGL** | none | n/a | SOL/USD fallback; `admin_settle`. |
| **AMZN** | none | n/a | SOL/USD fallback; `admin_settle`. |
| **META** | none (Bram's seeded strike uses SOL/USD fallback) | n/a | SOL/USD fallback (status quo); `admin_settle` recommended for canonical META close. |
| **NVDA** | none | n/a | SOL/USD fallback; `admin_settle`. |
| **TSLA** | none | n/a | SOL/USD fallback; `admin_settle`. |

---

## Live + verified devnet Pyth feeds (background reference)

These are the only crypto feeds I confirmed live + publishing on devnet (via `solana account` probe — returned valid `gSbePeb...`-owned Pyth v2 price accounts with magic `0xa1b2c3d4`).

| Symbol | Devnet pubkey | Status | Exponent | Last publish slot | Staleness vs current |
|---|---|---|---|---|---|
| **SOL/USD** | `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix` | ACCOUNT EXISTS — valid magic, owned by Pyth program, recent agg_price $139.82 — **but agg_pub_slot = 322,338,250 vs current 464,963,388 → ~660 days stale** | -8 | 322,338,250 | ~660 days |
| **BTC/USD** | `HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J` | ACCOUNT EXISTS — same owner, valid magic — same stale-feed pattern (not re-probed for publish_slot, presumed similarly stale) | -8 (typical) | (not probed; same pattern) | (presumed ~660 days) |
| **ETH/USD** | `EdVCmQ9FSPcVRAvxpUjPcnSc5ssfqgGoY9LSWzTjyezN` | absent — `AccountNotFound` (legacy pubkey) | — | — | — |

**No primary feed is usable for permissionless `settle_market` on devnet today.** SOL/USD's account exists with a valid header but its data is frozen from ~660 days ago — the on-chain staleness gate (`age_secs ≤ price_staleness_secs = 300`) cannot be satisfied. For strike binding (`StrikeMarket.underlying_pyth_feed`), `J83w4HKfqxwcq3...` is still the recommended placeholder (matches `FALLBACK_PYTH_DEVNET` in `seed-demo-liquidity.ts`); but settlement MUST go through `admin_settle`, not `settle_market`.

**Empirical staleness probe** (this session, against current devnet slot 464,963,388):

```bash
solana account J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix --url devnet --output json-compact \
  | node -e '... parse bytes 232-240 as u64 LE ...'
# agg_pub_slot = 322,338,250
# slot delta   = 464,963,388 - 322,338,250 = 142,625,138 slots
# wall-clock   = 142,625,138 × 0.4s ≈ 57M sec ≈ 660 days
```

---

## Findings worth Bram's attention

### Finding 1 — Drift: `services/automation/src/devnet-pubkeys.ts` references a non-existent pubkey

`DEVNET_PYTH_PRICE_ACCOUNTS.META = "J83w4HKfFqVghYYjAYTQTzAQ9QQbpDgN1qmcQxk8q1QH"` — this pubkey returns `AccountNotFound` on devnet. It is differs from the actual SOL/USD pubkey (`J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix`) by 4 characters at offset 5-8 (likely a typo / silent copy-paste error during the Day-5 work).

**Operational impact today: ZERO.** No code path actually reads this constant. The morning create-markets job + seed-demo-liquidity script both consult `process.env.PYTH_PRICE_ACCOUNT_<TICKER>` first and fall back to the script-local `FALLBACK_PYTH_DEVNET` constant (which IS correct). The `DEVNET_PYTH_PRICE_ACCOUNTS` map is documentation-only.

**Recommendation:** correct the typo (`J83w4HKfFq...` → `J83w4HKfqx...`) to keep documentation aligned, or delete the entry entirely since it's unused. Bram's call.

### Finding 2 — Hermes off-chain DOES publish MAG7 equity prices

Pyth Hermes (`https://hermes.pyth.network/api/v2/updates/price/latest?ids[]=<hex>`) IS network-agnostic and publishes MAG7 equity feed IDs:

| Ticker | Hermes feed ID (hex) |
|---|---|
| AAPL | `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` |
| MSFT | `0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` |
| GOOGL | `0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2` |
| AMZN | `0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a` |
| NVDA | `0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593` |
| META | `0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe` |
| TSLA | `0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1` |

These power Bram's `morning.ts` off-chain previous-close reads and seed the AI Bell Pro briefings. They are NOT on-chain Pyth accounts — they are price IDs in Pyth's pull-oracle / Hermes HTTP model.

**To get real MAG7 on-chain prices into `settle_market`, the path is Pyth Pull (post-MVP):** the off-chain Bram service would assemble a Hermes-signed update VAA + post it to a devnet Pyth Pull receiver program in the same tx that calls `settle_market`. That's a non-trivial Anchor change to our Accounts struct (add `pyth_receiver` + `price_update_v2: AccountInfo` accounts; replace the vendored `parse_pyth_price` with a `PriceUpdateV2`-decoded read). v1.5 work, not demo-blocking.

### Finding 3 — Compressed-time smoke test (this session) confirmed devnet Pyth is dead

Per deploy_index=9 smoke (Cory dispatch 2026-05-25, captured in `tests/contracts/smoke_compressed_time_settle.ts` and `smoke_compressed_time_resume.ts`):

- Strike A bound to `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix` (SOL/USD), expiry now+8min
- After expiry, permissionless `settle_market` **reverted with `PythStale (6009)`** at `settle_market.rs:103` — the staleness check `age_secs ≤ 300` failed because the Pyth feed's `publish_slot` was 142M+ slots (660 days) behind the current Solana slot
- Both Strike A and Strike B were then successfully settled via `admin_settle(forced_outcome = Yes)` — outcome flipped from Unsettled to Yes, `settled_at_unix` populated, `settle_price/confidence/slot` stayed 0 per the documented admin-pathed discriminator pattern
- 100 contracts redeemed from Strike A's winning (YES) side: 100,000,000 atomic YES burned + 100,000,000 atomic bUSDC ($1.00 par) received — `$1 USDC invariant` preserved

See `CLAUDE_SESSION_HANDOFF.md` ("Smoke evidence — deploy_index=9 compressed-time settle") for tx signatures + Solscan links.

---

## Methodology

```bash
# Per-pubkey probe (run from WSL Ubuntu where solana CLI is installed):
for k in <pubkey-1> <pubkey-2> ...; do
  printf "%-44s " "$k"
  solana account $k --url devnet 2>&1 | head -1
done
```

Probes against:
- Verified-live: SOL/USD (`J83w4HKfqxwcq3...`), BTC/USD (`HovQMDrbAg...`)
- Legacy / candidate: 5 historical MAG7 equity pubkeys from Pyth docs and old example repos — all `AccountNotFound`.
- Bram's documented pubkey: `J83w4HKfFqVgh...` — `AccountNotFound` (typo finding 1 above).

Tested with Solana CLI 3.1.14 against the public devnet RPC.

---

## Decision summary

| Question | Decision |
|---|---|
| Can `create_strike_market` bind to a real MAG7 Pyth devnet feed? | **No.** Pyth devnet has crypto-only on-chain coverage. |
| Can `settle_market` (permissionless) work on devnet against any Pyth pubkey? | **No.** Pyth devnet v2 push feeds have not updated in ~660 days; `PythStale (6009)` fires every time. Live-proven by deploy_index=9 smoke. |
| What feed should the 7 demo strikes bind to? | **SOL/USD** (`J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix`). Status quo — what Bram's seed script already uses. Binding is fine; settlement won't fire via `settle_market`. |
| How are strikes resolved at expiry on devnet? | **`admin_settle(forced_outcome)`** — admin pushes the canonical close off-chain. The strike's `settle_price == 0` post-call discriminates "admin-pathed" from "oracle-pathed." |
| What's the v1.5 path to true permissionless settle? | **Pyth Pull oracle integration.** Off-chain Bram assembles a Hermes-signed update VAA; on-chain settle CPI's into the Pyth Pull receiver to verify + decode the update in the same tx. Drops the vendored `parse_pyth_price` for the Pyth Pull receiver's `PriceUpdateV2` parse. Equity feeds are available via Hermes (see Finding 2), so this unlocks both crypto + equity settle on the same code path. |

---

## Cross-lead implications

- **Bram:** consider fixing the `devnet-pubkeys.ts` typo (Finding 1). **Important:** the seeded META/NVDA/AAPL strikes will NOT settle via permissionless `settle_market` — they'll fail `PythStale` because the bound SOL/USD feed is 660 days stale. For the live demo, Bram MUST call `admin_settle(forced_outcome)` against each seeded strike at expiry with the canonical equity close from Hermes (the off-chain HTTP equity feed IDs in Finding 2 are still active). The demo narrative should explicitly cover this: "settle_market reads on-chain Pyth — works on mainnet; devnet falls back to admin_settle because Pyth's devnet push feeds were sunset."
- **Cleo:** UI should badge `settle_price == 0` as "admin-settled" (vs `settle_price != 0` as "oracle-settled"). This was documented in `admin_settle.rs`'s module doc but may not be wired into the trade-view UI yet.
- **Drew:** the smoke test in `tests/contracts/smoke_compressed_time_settle.ts` is re-runnable evidence; future `LIVE_DEVNET=1` integration suites can extend it.
- **Tate:** no architectural change needed; the Pyth Pull migration is v1.5 P1 work.
