# Feature: Order Book & Matching

**ID:** F-03 · **Roadmap piece:** F-03 · **Status:** In review — [MR !3](https://labs.gauntletai.com/keithmazanec/meridian/-/merge_requests/3)

## Description

This delivers the on-chain Central Limit Order Book (CLOB) for trading Yes tokens
against USDC: `place_order` (limit and market), `cancel_order`, and `match_orders`
(execute crossing bids/asks by price-time priority and settle the token + USDC
transfers atomically). It implements the bounded on-chain book described in
ARCHITECTURE.md §4.3 and ADR-002b.

It exists because the order book is the trading venue — the place where price
discovery and matching happen — and it is the most technically ambitious part of the
program (the brief explicitly rewards building it). One book per strike serves all
four user actions by perspective (ARCHITECTURE.md §6).

## How it fits the roadmap

Wave 1, parallel with F-02 and F-05. It is off the single longest critical path but
is required for F-09 integration (the trade leg and all four trade paths). Treat it
as the second-highest-risk component after the oracle.

## Dependencies (must exist before this starts)

- **F-01 Program scaffold & accounts** — needs `OrderBook`, `Order`, the price/size
  fixed-point scale, and the market PDA conventions.

## Unblocks (what waits on this)

- **F-09 Integration & E2E** — the trading leg; all four trade paths (Buy/Sell
  Yes/No) execute against this book.

## Acceptance criteria

- `place_order` posts a resting limit order or executes a market order against the
  opposite side; orders carry owner, price (USDC-per-Yes in `[0, 1.00]` at the fixed
  scale), size, and a monotonic sequence number for time priority.
- `match_orders` crosses bids and asks strictly by price-time priority and settles
  the corresponding Yes-token and USDC transfers atomically; partial fills are
  handled correctly (remaining size stays resting; filled size is removed).
- `cancel_order` removes only the caller's own resting order and returns any escrowed
  funds/tokens.
- The book respects its bounded capacity `N` gracefully (a clear, deterministic
  outcome when full — e.g. reject or evict per a documented rule), never corrupting
  state or exceeding account space.
- Matching is trustless: the cranker (taker or automation) cannot alter prices or
  sizes; it only triggers execution (ARCHITECTURE.md §5 note).
- Trading is rejected when the program is paused or the market is settled.
- No on-chain prohibition is added on a user holding both Yes and No (that guardrail
  is client-side only — ROADMAP.md cross-cutting concern #6).

## Testing requirements

- Unit tests: limit post + rest; market order full fill; partial fills across
  multiple price levels; price-time priority ordering (including ties broken by
  sequence); cancel returns escrow; book-full behavior; matching cannot be made to
  alter price/size; no trading when paused/settled.
- Edge cases named in the architecture: rounding at the fixed scale, partial fills,
  ordering. Property/fuzz-style coverage of matching is encouraged.
- Run on a local validator via the Anchor test harness.

## Manual setup required

None.

## Approved implementation plan (checklist)

Decisions locked (confirmed against `ARCHITECTURE.md` and the brief `project_*.pdf`):

1. **Taker crosses on placement.** `place_order` immediately matches a crossing/market
   order against the resting opposite side and settles atomically; `match_orders` is a
   permissionless crank that sweeps any still-crossed resting pairs. *Mandated* by the
   brief's Buy-No story ("immediately sells Yes at best bid — one wallet approval").
2. **Market remainder = fill-or-cancel** (fill what the book allows, drop the rest, refund
   unused escrow). Not fill-or-kill.
3. **Book full = reject** with `BookFull` (ADR-002b documented demo limitation).

Cross-cutting:
- Order escrow uses **separate** per-market escrow token accounts, never the
  collateralization vault (invariant #1, ARCH §7.1 / brief p10).
- Matching only **transfers** existing tokens (never mints/burns).
- **No** on-chain both-sides prohibition (ROADMAP concern #6 / ADR-006).
- **Contract change (propagated):** new escrow PDA seeds added to `constants.rs` (source of
  truth) and noted in `ROADMAP.md` concern #3 for F-06 to derive.

Chunks:

- [x] **Chunk 1 — Escrow seeds + `init_order_book` (+ `grow_order_book`).** Added
  `USDC_ESCROW_SEED`, `YES_ESCROW_SEED` to `constants.rs`; created the order-book + escrow
  accounts and wired `Market.order_book`; registered in lib/instructions;
  `OrderBookInitialized` event. **Two-instruction creation** (see notes — Solana realloc
  cap). Tests pass: init+grow wires market & escrows; second init rejected; second grow
  rejected; init against unknown market rejected.
- [x] **Chunk 2 — `place_order` resting (limit, no cross).** Validation + escrow (bid USDC
  `ceil`; ask Yes exact) + sorted insert with `next_seq`; `OrderPlaced`. Shared `matching`
  module added (`bid_cost_ceil`, `fill_cost_floor`, `insert_sorted`, `cross_incoming` stub).
  Tests pass: bid/ask rest + escrow exact; price-time priority incl. seq tiebreak;
  zero-size, price-out-of-range, paused, settled all rejected; `BookFull` at capacity.
- [x] **Chunk 3 — `place_order` crossing + market + partial fills.** `matching::cross_incoming`
  does taker-crosses-on-placement: plan fills (read-only, price-time from index 0) → settle
  CPIs (verifying each `remaining_accounts` maker account) → apply size decrements/removals.
  `OrderMatched` per fill. Tests pass: taker buy full-fill; taker sell full-fill; partial
  fill across two price levels; crossing limit fills then rests remainder; market remainder
  cancelled (not rested); non-crossing limit doesn't fill.
- [x] **Chunk 4 — `cancel_order`.** Owner-only (`NotOrderOwner`); finds order by
  `(side, seq)` (`OrderNotFound`); refunds exact remaining escrow (`ceil(price*remaining)`
  USDC for a bid, `remaining` Yes for an ask) PDA-signed from the escrow accounts; removes
  the slot. `OrderCancelled`. Allowed even when paused/settled (users must always reclaim
  escrow). Tests: cancel bid/ask returns escrow; **partially-filled bid refunds exactly the
  remaining** (validates telescoping escrow); non-owner rejected; missing order rejected.
- [x] **Chunk 5 — `match_orders` crank + trustlessness.** Permissionless sweep of crossed
  resting pairs, `max_fills`-bounded, settled from escrow (no party signs); trades at the
  bid's price so the bid escrow drains exactly. Tests: third party cranks a crossed pair
  correctly; **no-op on an uncrossed book** (normal state under taker-crosses-on-placement);
  **cranker cannot misdirect funds** (wrong-owner account rejected); **settlement uses
  on-chain price/size, not caller input**; rejected when paused/settled. Crossed-book test
  shim documented (the public API never leaves the book crossed).
- [x] **Chunk 6 — Escrow/invariant sweep + four-path smoke.** New `test_order_book_invariants.rs`:
  (a) the collateralization vault is invariant through a place/cross/cancel flurry — trading
  is escrow-only and never touches it; (b) escrow reconciles exactly to the resting book
  (`usdc_escrow == Σ ceil(price*size)` over bids, `yes_escrow == Σ size` over asks, incl.
  odd-price rounding); (c) all four trade paths execute at book level (Buy Yes, Sell Yes,
  Buy No = mint+sell-Yes with effective $0.30 cost, Sell No = buy-Yes), vault still invariant.
- [x] **Adversarial review** — 1 high + 4 medium fixed (see below); lows recorded for the user.
- [x] **Rebase + MR** — rebased onto local main, pushed to `feat/F-03-order-book`, MR !3 opened.

## Implementation notes (filled in by the building agent)

> Decisions and rationale recorded here as the build proceeds.

### Order-book creation is two instructions (`init_order_book` + `grow_order_book`)

**Divergence from F-01's handoff note.** F-01 (`docs/features/01-…`, "Frozen contract
handoff") stated the `OrderBook` (14,905 B) would be created in one `init` because
"`init` pre-allocates the full byte budget." That assumption is **wrong on Solana**:
account data can grow by at most `MAX_PERMITTED_DATA_INCREASE` = **10,240 bytes per
instruction**, and a PDA can only be created by an `init`/`realloc` CPI (it has no key to
sign a top-level `createAccount`). So a 14.9 KB PDA cannot be allocated in a single
instruction. Verified live: a one-shot `init` fails with `InvalidRealloc` /
"Failed to reallocate account data".

**Resolution (keeps both frozen contracts).** Split creation into two permissionless
instructions:
- `init_order_book` — `init`s the PDA at `ORDER_BOOK_INIT_ALLOC` (8 + 10,000 ≤ cap) plus
  the two escrow token accounts; sets the book fields; **leaves `Market.order_book`
  unset**.
- `grow_order_book` — `realloc`s the PDA to the full `8 + INIT_SPACE` (+~4.7 KB, under the
  cap), tops up rent, and **then** writes `Market.order_book`.

The frozen `ORDERBOOK_N = 128` and the frozen seed `[order_book, market]` are both
preserved — only the *creation mechanism* changed. `Market.order_book` is the trading
gate: every trading instruction will require `market.order_book == order_book.key()`, so
trading is impossible until `grow_order_book` has run. Clients (test harness, later F-06
SDK) must call init then grow. Considered and rejected: `#[account(zero)]` + top-level
`createAccount` (impossible for a PDA — breaks the frozen seed); shrinking `ORDERBOOK_N`
(breaks the frozen size contract).

### Book ordering & escrow rounding

`bids` are kept sorted price-descending then seq-ascending; `asks` price-ascending then
seq-ascending — so the best order on each side is index 0 and price-time priority is a
front-to-back scan (`matching::insert_sorted`). `Order.active` is the slot-occupancy flag
(F-01 contract); orders are removed by `Vec::remove` rather than left as tombstones, which
keeps the index-0-is-best invariant simple. Escrow rounding: a bid escrows
`ceil(price*size/PRICE_SCALE)` USDC (round up, so escrow always covers the worst case); a
fill costs `floor(maker_price*fill_size/PRICE_SCALE)` (round down). The ceil−floor
remainder is refunded to the bidder when the order leaves the book (fill-complete or
cancel), so no dust is stranded. Required-account note: `place_order` needs the caller's
Yes ATA *and* USDC ATA to exist (a pure resting bid still names `user_yes` because a
crossing bid receives Yes); the SDK/frontend must create these ATAs first.

### Matching: exact escrow via telescoping (no dust, no Order field)

The frozen `Order` struct has no escrow field, so escrow must be reconstructable from
`price` + `size` at every point. The trade USDC for a fill that shrinks a resting order
from `s_before` to `s_after` is defined as **`ceil(price*s_before) − ceil(price*s_after)`**
(`matching::fill_usdc`). Over any sequence of partial fills this telescopes to exactly
`ceil(price*original_size)` — which is exactly what a bid escrows (`bid_cost_ceil`). So a
bid's escrow drains to **zero** when fully filled and the remaining escrow always equals
`ceil(price*remaining_size)` — no dust, no stranded funds, and `cancel_order` (Chunk 4)
can refund exactly `ceil(price*remaining)` without tracking anything. Both taker
directions use the same `fill_usdc`, so a buy and a sell at the same maker price move
identical USDC. Trade price is always the **maker's** resting price (price-time priority).

### `remaining_accounts` trust model (security-critical)

A taker fill pays an arbitrary set of makers, so maker payout accounts can't be named in
the fixed `Accounts` struct — they're passed via `ctx.remaining_accounts`, aligned in
fill order (best price/time first). For each matched maker the handler deserializes the
supplied token account and **requires** `account.owner == on-chain order.owner` and
`account.mint == the correct mint` (USDC when an ask-maker is paid; Yes when a bid-maker
receives tokens) before transferring. Prices and sizes are read **only** from the
on-chain `Order`s, never from the caller — so a cranker/taker can trigger matching but
cannot alter terms or misdirect funds. This is the main manual-review hotspot.

### Three-phase matching (borrow-safe)

`cross_incoming` runs (1) a read-only planning pass over the sorted book collecting
`PlannedFill`s, (2) a settlement pass doing the CPIs with maker-account verification, then
(3) an apply pass mutating the book (decrement partial makers; remove emptied ones
back-to-front so indices stay valid). Splitting phases avoids holding a book borrow across
CPIs and keeps the matching logic auditable. `match_orders` uses the same three-phase
shape.

### Adversarial review — findings & resolutions

An independent review attacked the matching engine, escrow accounting, and trust
boundaries. Triage (HIGH/MEDIUM fixed; LOW recorded for the user):

**Fixed:**
- **H-1 — `remaining_accounts` not verified SPL-owned (book-lock DoS).** A maker could
  corrupt their payout account so every fill through their order reverts, permanently
  blocking that price level. Fixed: new `matching::verify_maker_account` checks the
  account is owned by the SPL Token program (so raw-byte `try_deserialize` can't be
  spoofed), is writable, is **not frozen** (M-1), and has the right token-owner + mint —
  used by both `cross_incoming` and `match_orders`. Regression test:
  `crank_rejects_non_spl_maker_account`.
- **M-1 — frozen maker payout account → matching DoS.** Folded into `verify_maker_account`
  (rejects `state != Initialized` with a clear error).
- **M-2 — `match_orders.yes_mint` lacked the PDA seed constraint** (defense-in-depth gap
  vs. `place_order`). Fixed: added `seeds = [YES_MINT_SEED, market]`.
- **M-3 — unchecked `size -= amt` in `apply_crank_fills`** (silent wraparound on a future
  planning regression → escrow desync). Fixed: `checked_sub` → `MathOverflow`.
- **M-4 — zero-price limit order** escrowed nothing and could acquire Yes for free / squat
  a slot. Fixed: limit price must be in `[1, PRICE_SCALE]`. Regression test:
  `place_order_rejects_zero_price_limit`.

**LOW (recorded — not auto-applied; for the user to decide):**
- **L-1** — `remaining_accounts` writability now checked inside `verify_maker_account`
  (folded in), so this is effectively addressed.
- **L-2** — `cancel_order` intentionally has no market-state gate (users must always
  reclaim escrow); add an inline comment on the `market` field to make intent explicit.
- **L-3** — `OrderMatched` from the crank labels the cranker as `taker` and only one
  side as `maker`; consider a dedicated `OrdersCranked` event (or a `cranker` field) so
  indexers attribute crank settlements correctly.
- **L-4** — the `!maker.active` guard in `cross_incoming` planning is dead code (orders
  are removed, never tombstoned); remove or comment.
- **L-5** — fixed in passing: the `grow_order_book` realloc-safety comment wrongly claimed
  the runtime zeroes realloc'd bytes; corrected to the borsh-length-prefix reasoning.

### `match_orders` is a defensive/liveness no-op in normal operation

Because `place_order` crosses on placement, a correctly-operated book is never left
crossed, so `match_orders` normally finds nothing and is a no-op (proven by a test). It
exists for the architecture's trustlessness/liveness guarantee (ARCH §5): anyone can
trigger settlement of a crossed pair, and the cranker can only trigger — prices/sizes come
only from on-chain orders, and each maker payout account is verified against the order's
`owner` + mint. **Crank trade price = the bid's price** (deliberate simplification): when
the book is crossed (`bid.price ≥ ask.price`), this drains the bid's escrow exactly with
no price-improvement surplus to refund and no third account per fill; the seller receives
≥ their ask. Tested via a `seed_crossed_book` shim because the public API can't leave the
book crossed; the trustlessness tests (wrong-owner account rejected; on-chain price used
regardless of cranker) run against that shim.

### Escrow accounts (invariant #1 safety)

Two per-market escrow token accounts, both owned by the existing `mint_authority` PDA
(reused — no new key): `usdc_escrow` (`[usdc_escrow, market]`) holds bidders' USDC;
`yes_escrow` (`[yes_escrow, market]`) holds askers' Yes tokens. They are **separate from
the collateralization vault** so trading never perturbs invariant #1
(`vault == PAYOFF_UNIT * pairs_minted - winning_redeemed`). New seeds are in
`constants.rs` (source of truth) and noted in `ROADMAP.md` concern #3 for F-06.
