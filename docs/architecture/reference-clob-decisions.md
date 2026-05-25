# In-Program CLOB — Adoption Notes vs Keith's Reference Design

> **Status:** v1 architecture lock per `constitution/decisions.md` DR-020.
> **Reference:** [`reference-clob-design.md`](./reference-clob-design.md) (Keith's full architecture doc) + [`reference-clob-spec.md`](./reference-clob-spec.md) (his F-03 feature spec for the matching engine).

This doc explains which of Keith's design decisions we **adopt verbatim**, which we **adapt** to our existing program shape, and which we **defer** for our v1 submission window.

---

## Why we built on Keith's reference rather than designing from scratch

Keith's design is independently developed, adversarially-reviewed (1 high + 4 medium findings caught + fixed), and already implemented end-to-end (chunks 1–6 complete, MR open). We pivoted to in-program CLOB late Sun 2026-05-24 with ~22hr to submission. Reinventing the matching engine from a blank page would have meant re-discovering the same bugs Keith's review surfaced (book-lock DoS via corrupted `remaining_accounts`, frozen-account griefing, PDA-seed defenses, zero-price limit griefing, unchecked subtraction). Adopting his pattern lets us inherit a proven security posture.

Per DR-020: "The reference design's adversarial review already covers the matching engine's failure modes, letting us inherit a proven security posture rather than re-discover bugs."

---

## Adopted verbatim

| Decision | Source | Notes |
|---|---|---|
| **Bounded array `OrderBook` PDA** (N = 128 bids + 128 asks) | ADR-002b | Keeps matching trustless + fully on-chain without slab complexity. |
| **Two-instruction creation:** `init_order_book` → `grow_order_book` | F-03 §"Order-book creation is two instructions" | Solana's `MAX_PERMITTED_DATA_INCREASE` = 10,240 B/ix; the 14.9 KB OrderBook PDA cannot allocate in one shot. This is the kind of subtle constraint we'd have hit cold without his discovery. |
| **Taker crosses on placement** | F-03 chunk 3 | `place_order` immediately matches a crossing order against the resting opposite side; `match_orders` is a permissionless crank for the rare case the book is left crossed. Required by PRD's atomic Buy-NO flow. |
| **Market remainder = fill-or-cancel** (not fill-or-kill) | F-03 chunk 3 | Fill what the book allows, drop the rest, refund unused escrow. |
| **Three-phase matching: plan → settle → apply** | F-03 §"Three-phase matching (borrow-safe)" | Read-only planning pass collects `PlannedFill`s; settlement pass does CPIs with maker-account verification; apply pass mutates the book. Avoids holding a book borrow across CPIs. |
| **Telescoping escrow** (`ceil(price × s_before) − ceil(price × s_after)`) | F-03 §"Matching: exact escrow via telescoping" | No dust, no escrow field needed on `Order`, drains to exactly 0 on full fill. Critical for invariant #1 (vault USDC untouched by trading). |
| **Separate per-market escrow accounts** (`usdc_escrow`, `yes_escrow`) | F-03 §"Escrow accounts (invariant #1 safety)" | NEVER use the collateralization vault for trade escrow. Mechanically enforces `vault_USDC == $1 × pairs_minted`. |
| **`remaining_accounts` trust model** | F-03 §"`remaining_accounts` trust model (security-critical)" | Maker payout accounts passed via `ctx.remaining_accounts`, aligned in fill order. Each maker account verified against on-chain `Order.owner` + correct mint + SPL Token program ownership. The main manual-review hotspot. |
| **Adversarial fixes pre-baked** (H-1, M-1 through M-4) | F-03 §"Adversarial review — findings & resolutions" | Apply all five fixes in our initial implementation rather than discovering them post-deploy: SPL Token program-owned verification, frozen-account check, PDA seed constraint on `yes_mint`, `checked_sub` on size decrements, zero-price limit rejection. |
| **Book full = reject** (`BookFull` error) | ADR-002b | Documented demo limitation. |
| **`match_orders` as defensive/liveness no-op** | F-03 §"`match_orders` is a defensive/liveness no-op" | Required for PRD trustlessness guarantee — anyone can trigger settlement of a crossed pair — but normally a no-op since `place_order` crosses on placement. |

---

## Adapted to our existing program shape

| Keith's name | Ours | Adaptation note |
|---|---|---|
| `Market` PDA | `StrikeMarket` PDA | Our PDA exists at `deploy_index=6` with seeds `[b"strike", pyth_feed, expiry, strike]`. Add an `order_book: Pubkey` field as the trading gate. |
| `pairs_minted` (monotonic) + `winning_redeemed` (cumulative) | Our `pairs_outstanding` (current count) | Different shape — ours tracks current count, his tracks lifetime. Our invariant: `vault_USDC == $1 × pairs_outstanding`. His: `vault == $1 × pairs_minted − winning_redeemed`. Both correct, just different state representation. Keep ours. |
| Order-book + escrow owned by `mint_authority` PDA | Order-book + escrow owned by our `StrikeMarket` PDA (no separate mint_authority PDA in our design) | Our `StrikeMarket` PDA already signs for mints + vault transfers (per DR-017 vault security model). Reuse it as escrow authority — no new PDA needed. |
| `usdc_escrow` + `yes_escrow` seeds | Same naming, but seeds adapt to our PDA pattern: `[b"usdc_escrow", strike_market.key()]` + `[b"yes_escrow", strike_market.key()]` | Trivial naming convention adaptation. |
| Generic `usdc_mint` from his `Config` | Our `MarketConfig.usdc_mint` (set at `initialize_config` time) | Same logical pattern. We add an admin-only `update_usdc_mint(new_mint: Pubkey)` ix as part of deploy_index=7 so we can flip from Circle USDC → our "bUSDC" demo mint without redeploying from scratch. |

---

## Deferred (post-v1)

| Item | Why deferred | When revisited |
|---|---|---|
| **Slab-style order book** (production path per ADR-002b) | Bounded array is sufficient for demo + early production. Slab is the production-scale path Keith also defers. | When `BookFull` becomes an actual UX complaint, not before. |
| **Maker rebates** | Per our DR-018 lock: `phoenix_maker_fee_bps = 0` (now `match_maker_fee_bps = 0`). Taker-only matches Drift/dYdX industry standard. | v2+ if liquidity-provision incentives become necessary. |
| **`OrdersCranked` event** (Keith's L-3) | Indexer attribution for cranker settlements. Minor analytics improvement. | When our analytics surface needs to distinguish cranker-driven from taker-driven fills. |
| **Phoenix integration removal** | Phoenix code (verify_phoenix_market, phoenix_market field on StrikeMarket) stays dormant per DR-020. Additive change is safer than destructive in submission window. | v2 cleanup pass OR if Phoenix becomes the v2 secondary-venue per Polymarket pattern. |

---

## Adopted with attribution notes for interview defense

Two things worth calling out by name when discussing this in interview:

1. **The two-instruction `init_order_book` + `grow_order_book` pattern.** Keith's spec discovered this *only after* hitting `InvalidRealloc` on a one-shot init attempt. Without his note, we'd have spent multi-hour debug cycles. Cite his F-03 §"Order-book creation is two instructions" as the source.

2. **The `remaining_accounts` SPL Token program-owned verification (H-1).** Without this check, a malicious maker could corrupt their own payout account to permanently freeze fills through their order — a book-lock DoS. Keith's adversarial review caught this; we bake the `verify_maker_account` helper into our initial implementation.

---

## What this means for `constitution/decisions.md`

- **DR-001** (Phoenix integration) — superseded
- **DR-009** (Model D Phoenix fee_recipient) — deferred to v2
- **DR-018** (fee model) — amended: "Phoenix taker fee" → "in-program taker fee"; same rate, same accrual logic
- **DR-019** (NO market-only) — still applies; language updates to reference our `place_order` instead of Phoenix `swap`
- **DR-020** (this pivot) — locks the in-program CLOB choice + cites this doc as the reference

---

## Credit

Keith Mazanec, "Meridian" project (parallel cohort build). Reference docs preserved verbatim in this repo at `reference-clob-design.md` (his `ARCHITECTURE.md`) and `reference-clob-spec.md` (his `docs/features/03-order-book-matching.md`). His MR !3 implementation at `labs.gauntletai.com/keithmazanec/meridian/-/merge_requests/3`.
