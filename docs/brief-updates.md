# Brief Updates — Diffs from PDF V1.0 (May 2026)

> Track of what changed between `Bell.Markets.pdf` V1.0 and the actual shipped
> v1 demo state. Use this to update the PDF before sending to PEAK6.

The brief is well-structured — **most of it is timeless** (vision, mission,
mechanics F-01/02/04/05/06, one-book-per-strike, competitive positioning,
user personas, roadmap, closing). The **drift is concentrated in 4 spots**,
all stemming from the DR-020 pivot from Phoenix → in-program CLOB.

---

## Critical edits

### EDIT 1 — Page 6, F·03 mechanic

**Current:**
> **Phoenix order book**
> We integrate Phoenix's audited CLOB rather than build our own matcher.
> Real spreads, real depth, no custom matching risk — and the same crank
> model we use for settle.

**Replace with:**
> **In-program CLOB**
> A minimal on-chain matching engine inside our Anchor program — 27
> instructions total, 6 of them new for the order book (init/grow/place/
> cancel/match + admin update). Adopted Keith Mazanec's parallel-cohort
> reference design with his adversarial review baked in at initial
> implementation: SPL-Token-program ownership checks on `remaining_accounts`,
> frozen-account rejection, zero-price limit guard, telescoping escrow,
> three-phase plan→settle→apply matching. Trading and settlement share
> one audit surface.

### EDIT 2 — Page 12, System Architecture diagram

**Current:** On-chain program section shows:
> `PHOENIX CLOB · DR-001` — Audited matcher · permissionless crank

**Replace with:**
> `BELL CLOB · DR-020` — In-program matching · 128 orders/side · escrow PDAs

### EDIT 3 — Page 12, DR-001 decision card

**Current:**
> **DECISION · DR-001**
> Integrate Phoenix; don't build a matcher.
> Saves ~1.5 days. Audited matching. Same crank model. Tradeoff: hard
> dependency on Phoenix uptime.

**Replace with:**
> **DECISION · DR-020**
> Built minimal in-program CLOB.
> Phoenix devnet bootstrap proved impractical inside the build window
> (chicken-and-egg between our YES mints and Phoenix `InitializeMarket`).
> Pivoted ~22 hr from submission to the PRD's explicitly "more ambitious"
> path. Keith Mazanec's adversarially-reviewed reference design adopted.
> The matcher and settlement share one audit surface. Phoenix code stays
> dormant in source as a v2 candidate.

### EDIT 4 — Page 15, "Phoenix dependency" risk card

**Current:**
> **SEVERITY · MEDIUM**
> **Phoenix dependency · single matcher**
> We chose Phoenix over a custom matcher to save ~1.5 days of build budget.
> A Phoenix outage during trading hours stops new orders.
> Mitigation · Orders pause; settlement still runs on existing positions.
> Cross-CLOB abstraction is roadmap'd; OpenBook is the documented fallback
> target.

**Replace with:**
> **SEVERITY · MEDIUM**
> **In-program matcher · audit surface**
> We built our own minimal CLOB inside the Anchor program (DR-020).
> Matching engines are high-risk audit category. Our defense: adopted
> Keith Mazanec's adversarially-reviewed reference design verbatim
> (H-1 SPL-owned check, M-1 frozen-account rejection, M-2 PDA seed
> constraints, M-3 checked arithmetic, M-4 zero-price limit guard),
> 19/19 invariant tests passing on devnet, formal third-party audit
> queued as the gate to mainnet GA.
> Mitigation · Phoenix integration path documented as v2 candidate per
> DR-001 (superseded). If the in-program matcher hits a scaling limit
> at `ORDERBOOK_N=128`, the slab-based production path is in Keith's
> reference design (`docs/architecture/reference-clob-spec.md` ADR-002b).

### EDIT 5 — Page 15, "Hostile reviewer prompt" card

**Current:**
> **SEVERITY · LOW**
> **Hostile reviewer prompt: 'why not custom matcher?'**
> An interviewer may push on the build/buy trade. The defense is in the
> decision record — three-day window, audited matcher, identical crank
> model.
> Mitigation · DR-001 documented. Honest answer in the room: 'I had three
> days and one matcher's worth of build budget.'

**Replace with:**
> **SEVERITY · LOW**
> **Hostile reviewer prompt: 'why a custom matcher?'**
> The PRD prescribes *"Build a minimal order book as part of your smart
> contract (more ambitious, demonstrates deeper understanding)."* Phoenix
> integration was the initial plan (DR-001), but devnet bootstrapping
> proved impractical ~22 hr from submission; we pivoted to the in-program
> path per DR-020.
> Mitigation · The matcher is ~250 lines Rust + 702 lines of matching
> helpers, lifted from Keith Mazanec's parallel-cohort reference design
> with his adversarial review pre-applied. Defense in DR-020. Honest
> answer in the room: 'PRD said more ambitious is better; Phoenix didn't
> bootstrap; this is what shipped.'

---

## Optional polish edits (nice-to-have, not load-bearing)

### Page 3 — "$0.36" callout

Currently uses `AAPL > $215` at `$0.36`. Live demo strike is **AAPL > $309**
(reflecting current AAPL spot ~$309 as of submission week). Either:
- Update example to current spot: e.g. *"NVDA > $215 today buys YES at
  $0.49"* (matches our live demo strikes)
- OR keep as illustrative and add footnote: *"strike example from PRD V0;
  live demo strikes scale with current spot prices"*

### Page 5 — "Will NVDA close above $145.00 today?"

Same issue. NVDA spot is ~$215 as of submission week. Either:
- Update to live state (`NVDA > $215 @ YES $0.49 / NO $0.51`)
- OR add footnote

### Page 7 — Strike algorithm example

`META prev close $680.00` → strikes at $620-$740. Current META spot is
~$610 — strikes at $560-$680 would be the actual live equivalent. Either
update example numbers or keep PRD-V0 example and note "illustrative."

### Page 8 — Landing terminal screenshot

The mockup in the screenshot is the gamified arcade-retro variant.
Live landing matches the v8 mockup (not the arcade-retro). If you want
the screenshot to reflect the actual live UI, regenerate from
`localhost:3000/` (v8 Bloomberg-density design).

### Page 12 — Architecture diagram

Update the labels:
- Helius → confirmed real (we'll have devnet RPC from Helius for the
  Vercel deploy)
- Trigger.dev → confirmed real
- Pyth → confirmed real, vendored parser per Aria's adapter

Add to ON-CHAIN PROGRAM section:
- `bUSDC self-controlled demo mint` — note that mainnet would use Circle USDC

### Page 13 — Go-to-market section

The "Unfair lever — Bell AI agent · Phase 2" still applies. We have AI
briefings shipped (Pyth Hermes → Sonnet 4.6 → Neon → `/api/briefings/<ticker>`)
which is essentially Bell Phase 1. Worth mentioning as already-shipped
infrastructure on this page.

### Page 14 — Roadmap

"Devnet submission · (You are here.)" — confirm the SHIPPED tag is
accurate.

---

## What's STILL TRUE and doesn't need editing

- Page 4 — Vision, Mission, North Star, First Win
- Page 5 — Product overview (just the example strike numbers)
- Page 6 — F-01, F-02, F-04, F-05, F-06 (everything except F-03 above)
- Page 7 — One book / two perspectives / four actions — STILL THE ENTIRE
  PRODUCT EXPLANATION; this didn't change with DR-020
- Page 10 — Competitive positioning vs Kalshi/Polymarket/DraftKings
- Page 11 — User personas (Devin/Mara/Jules)
- Page 13 — Go-to-market motions
- Page 14 — Roadmap quarters
- Page 15 — Other risks (US regulatory, Pyth feed integrity, liquidity
  bootstrap, composite-tx user education)
- Page 16 — Closing

---

## New facts worth adding (post-PDF V1.0)

1. **deploy_index=8 on devnet** — 27 ix surface, 6.671 SOL cumulative spend
   across 8 deploys. Could add to Page 16 alongside the existing repo/license
   facts.

2. **bUSDC self-controlled demo mint** — `5vq2oahKFnnjStK1Ctqwdxdt44rtKuKHmPga9iZKtBZp`
   on devnet. Lets us fund demo wallets instantly (no faucet friction).
   Mainnet uses Circle USDC via `update_usdc_mint` admin ix (configurable).
   Could add to Page 5 as a small "demo USDC" note.

3. **/admin operational console** — wallet-gated by `MarketConfig.admin`.
   Pause toggle, MarketConfig display, manual admin_settle, update fee
   config. Worth mentioning on Page 12 as part of the operational surface.

4. **8 audit cycles + 17 substantive findings caught + fixed** — Drew's
   running quality lineage. Could add to Page 6 as a credibility number
   alongside the existing F·06 compressed-time eval mention.

5. **Vercel live URL** — once deployed. Add to Page 16.
