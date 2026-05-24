# CLOB Strategy — Trade-off Analysis

> Companion to `constitution/decisions.md` DR-001 and DR-009. This doc provides
> the deeper analysis that informed those locked decisions, plus the
> escalation triggers for future revisits. Permanent project record.

## Decision summary

**Locked for MVP and beyond, until scale triggers a revisit:**
- Integrate Phoenix v1 CLOB; do not build our own matching engine (DR-001)
- Investigate Phoenix v1 `fee_receiver` config (Model D) to capture trade fees passively (DR-008)
- Fork or build only if Model D fails AND we hit $1M+ daily volume (DR-009)

## The five options on the table

| # | Option | Cost | Revenue capture | Status |
|---|---|---|---|---|
| 1 | Phoenix v1 — no venue fee | $0 build | Mint-only via our ix (DR-008) | Current MVP path |
| 2 | Phoenix v1 + Model D (venue fee) | $0 build + ~30-45 min discovery | Mint + Phoenix-trade fees | Pending Bram investigation |
| 3 | Wait for Phoenix v2 | $0 build + indefinite timeline | Same as #2 if v2 ships with fee_receiver | Bet on Phoenix roadmap |
| 4 | Fork Phoenix v1 | ~1-2 weeks + $10-30K audit | Mint + Phoenix-trade fees (we own the code) | Only at scale + #2 fails |
| 5 | Build custom CLOB from scratch | ~2-4 months + $50-200K audit | Full control of fee model | Not under any realistic conditions |

## Cost-benefit analysis under each option

### Option 1 — Phoenix v1 (current)

**Implementation cost:** $0 — Phoenix v1 is already integrated (verified by Aria's Day-3 work, Phoenix v1 magic prefix at `[0x77, 0xDF, 0x71, 0x73, 0xB7, 0x20, 0x58, 0x71]`).

**Annual revenue at scale (49 markets/day, ~$5M total mint volume/year):**
- Mint-only fee at 2%: ~$100K/year
- Phoenix-trade fees: $0 (gap exists)
- **Total: ~$100K/year**

**Risk profile:**
- Phoenix v1 deprecation/upgrade — unlikely; widely used, well-audited
- Liquidity dependency on Phoenix's ecosystem (mostly OK; they have it)
- Integrator network (Jupiter etc.) routes through Phoenix → we benefit by default

### Option 2 — Phoenix v1 + Model D (venue fees)

**Implementation cost:** ~30-45 min Bram discovery + ~1-2 hr Aria wiring if feasible.

**Annual revenue at scale (assuming Phoenix volume ~3× mint volume = ~$15M):**
- Mint-only fee at 2%: ~$100K/year
- Phoenix venue fee at 5 bps: ~$75K/year additional
- **Total: ~$175K/year**

**Risk profile:**
- Same as #1 (depends on Phoenix v1)
- Plus: dependent on Phoenix's `fee_receiver` field existing AND being configurable per market AND being settable by market creator (the program calling `create_strike_market` Phoenix CPI)
- If any of those fail, we fall back to #1

**Discovery questions for Bram:**
1. Does Phoenix v1's market struct expose a `fee_receiver: Pubkey` field?
2. Is it set at market initialization (via Phoenix CPI) or via a later "set_fee_receiver" ix?
3. Can the program (not just the market creator pubkey) hold the fee_receiver?
4. What fee modes does Phoenix support (taker-only, taker + maker rebate, etc.)?
5. Are there per-market or per-program limits on the fee bps?

### Option 3 — Phoenix v2 (when it ships)

**Implementation cost:** TBD — depends on Phoenix v2's API surface. Could be near-zero migration if Phoenix v2 designs for our use case.

**Annual revenue:** Same as #2 if v2 includes `fee_receiver` natively.

**Risk profile:**
- Phoenix v2 launch timing is unknown (Ellipsis Labs has hinted but not committed)
- Migration cost could be substantial if v2 changes interfaces meaningfully
- We'd need to track v1 + v2 markets for a transition period

**Quarterly check from Bram: monitor Phoenix v2 announcements; raise to Tate if Ellipsis publishes a roadmap.**

### Option 4 — Fork Phoenix v1

**Implementation cost:**
- ~1-2 weeks engineering (1 senior developer or 2 mid-level pairing)
  - Copy Phoenix v1 codebase (MIT licensed)
  - Add `fee_receiver` field to market struct (~50 lines of code)
  - Add `set_fee_receiver` instruction (~80 lines)
  - Modify match logic to skim fee on each fill (~30 lines)
  - Update all tests (Phoenix's existing suite + new fee tests)
- ~$10-30K partial re-audit (focused on our additions only; Phoenix's base audit covers most)
- Ongoing maintenance: ~$30-50K/year engineering + monitoring
- **One-time: $40-80K. Ongoing: $30-50K/year.**

**Annual revenue at scale (same as #2):** ~$175K/year

**Risk profile:**
- We now own a matching engine. Bug risk is non-trivial (matching engines are top-tier audit category).
- Lose Phoenix v1's integrator network — Jupiter routes through Phoenix, not us. Our forked CLOB ("BellPhoenix" or whatever) needs to lobby for inclusion in aggregator routes, which takes time + effort.
- Liquidity bootstrapping — our forked markets start at zero open interest. Phoenix v1 markets have existing traders + bots.
- Track upstream Phoenix v1 changes; merge security patches; defend against divergence over time.

**When this becomes ROI-positive:**
- Cost recovery threshold (build + audit): ~$50K. At $175K/year incremental revenue from venue fees, recovered in ~3-4 months.
- BUT: only if we're at the volume that justifies the venue-fee revenue. At $1M+ daily Phoenix volume (~$370M/year), 5 bps = $185K/year. That's the volume threshold where this works.
- We're NOT at that volume at MVP launch. Wait for it.

### Option 5 — Build custom CLOB from scratch

**Implementation cost:**
- ~2-4 months focused engineering (Ellipsis Labs spent ~1.5 years on Phoenix v1, but smaller scope is possible)
- $50-200K formal audit (matching engines are highest-risk audit category)
- Zero liquidity day-1; massive bootstrap effort
- **One-time: $100-300K. Ongoing: ~$50-100K/year.**

**Why this is never seriously considered:**
- Cost is 5-10× the fork option
- Phoenix's integrator network value can't be replaced quickly
- Time-to-market killer
- We're not differentiating on matching-engine design — we're differentiating on binary-options primitives + lifecycle automation

**The only path where this is rational:**
- We've already forked Phoenix (Option 4) and outgrown it
- We need features Phoenix's design doesn't accommodate (extreme MEV resistance, batched auctions, etc.)
- We're a CLOB-as-a-product company, not a binary-options dApp

For BellMarkets specifically, this is not a serious option. We're a binary-options dApp.

## Revenue math at different volume scales

Annual revenue capture under each option, assuming 49 markets/day:

| Daily Phoenix volume | Daily mint volume | Option 1 fee | Option 2 fee | Option 3 fee | Option 4 fee | Comments |
|---|---|---|---|---|---|---|
| $0 (no trading) | $0 | $0 | $0 | $0 | $0 | Pre-launch |
| $50K (early MVP) | $20K | $400/day | $425/day | $425/day | $425/day | Build cost not recoverable |
| $500K | $200K | $4,000/day | $4,250/day | $4,250/day | $4,250/day | Marginal — fork not worth it |
| $1M | $400K | $8,000/day | $8,500/day | $8,500/day | $8,500/day | Fork starts to look interesting |
| $5M | $2M | $40K/day | $42.5K/day | $42.5K/day | $42.5K/day | Fork clearly ROI-positive |
| $10M+ | $4M+ | $80K+/day | $85K+/day | $85K+/day | $85K+/day | Fork is strategic priority |

Annual:
- At $5M daily volume: Option 2 captures ~$15.5M/year; Option 4 captures the same but with ~$50K/year additional maintenance cost
- At $10M+ daily volume: Option 4 starts to be worth the additional cost for strategic sovereignty reasons

## Migration triggers (from MVP forward)

**MVP → first 6 months post-launch:**
- Stay on Option 1 + investigate Option 2 (Model D)
- If Option 2 works → upgrade to Option 2 immediately
- If Option 2 fails → stay on Option 1; revisit in 6 months

**Months 6-12:**
- Quarterly review: is Phoenix v2 announced? If yes, plan migration to Option 3.
- Review daily Phoenix volume. If approaching $1M+, start preliminary Option 4 analysis (read Phoenix v1 source carefully; estimate fork timeline).

**Month 12+:**
- If daily Phoenix volume > $5M AND Option 2 (or 3) didn't materialize: start fork project
- If daily Phoenix volume > $10M: fork is strategic priority

## Phoenix v2 monitoring (Bram)

**What to watch:**
- Ellipsis Labs GitHub: https://github.com/Ellipsis-Labs
- Their Discord / Twitter for v2 announcements
- Phoenix audit reports for hints at v2 architecture
- Solana ecosystem chatter (Jupiter integrators usually know first)

**Quarterly check:** Bram raises to Tate if Phoenix v2 is publicly announced or has a beta cluster running.

**Migration cost to v2:**
- Re-do magic prefix check (v2 will have different `MarketHeader.discriminant`)
- Update Phoenix CPI calls in `create_strike_market`
- Re-test our market binding
- ~1-2 hr Aria + ~30 min Drew

If v2 includes native `fee_receiver`, we migrate immediately. If v2 doesn't, we stay on v1 (or fork it).

## Why we lock this strategically

This decision tree affects revenue, security, and team focus. Locking it gives:
- **Team focus:** engineers don't waste time on "should we build a CLOB?" discussions
- **Predictable cost trajectory:** we know the dollar value of each scale milestone
- **Defensible interview narrative:** "we evaluated Phoenix vs fork vs build; here's why MVP is Phoenix; here's the trigger for revisit"
- **Future-flexibility:** the doc captures the upgrade paths so future Tate sessions don't re-litigate

## Updates / changes to this doc

Track scale-triggered or Phoenix-roadmap changes here:

| Date | Change | Trigger | Authority |
|---|---|---|---|
| 2026-05-22 | Initial commit | DR-001 + DR-009 lock | Cory (Tate-routed) |
| 2026-05-23 | Model D investigation closed PARTIAL — `fee_recipient` confirmed but bind-to-existing-market path can't capture (see § "DR-009 Model D — Aria on-chain verification" below) | Tate routed Bram (off-chain research) + Aria (on-chain verification + clob/CPI design walk) | Bram (investigation) + Aria (verification + on-chain perspective) |

When daily Phoenix volume crosses a milestone ($1M, $5M, $10M) or Phoenix v2 is announced, append a row + describe what action was taken.

## DR-009 Model D — Aria on-chain verification (2026-05-23)

Bram's investigation in `.project/bell-markets/coordination/model-d-investigation.md` answered the 5 § "Discovery questions for Bram" against Phoenix v1 source. This section is the **independent on-chain-engineer verification** plus the program-design implications a code-side perspective adds.

### Primary-source verification

All five of Bram's findings independently re-verified against the canonical Phoenix v1 master branch (`Ellipsis-Labs/phoenix-v1` repo, fetched via `gh api repos/Ellipsis-Labs/phoenix-v1/contents/src/program/...`, raw bytes decoded and re-read):

| Claim | Source file:line | Verified |
|---|---|---|
| `MarketHeader.fee_recipient: Pubkey` exists | `src/program/accounts.rs` `MarketHeader` struct, field 10 (after `authority`) | ✅ |
| `MarketHeader.authority: Pubkey` is the "market_authority" | Same file, field 9 | ✅ |
| `InitializeMarket = 100` (ix variant); `market_creator` is signer | `src/program/instruction.rs:191,198` (`#[account(3, writable, signer, name = "market_creator", desc = "The market_creator account must sign for the creation of new vaults")]`) | ✅ |
| `ChangeFeeRecipient = 109` (ix variant); requires `market_authority` signer | `src/program/instruction.rs:273,275` (`#[account(3, signer, name = "market_authority", desc = "The market_authority account must sign to change the free recipient")]`) | ✅ |
| `CollectFees = 108`; sweeper-callable (any signer); fee_recipient is writable destination | `src/program/instruction.rs:264-268` (`signer, name = "sweeper"` + `writable, name = "fee_recipient"`) | ✅ |
| Discriminant value `8167313896524341111` (= little-endian `[0x77, 0xDF, 0x71, 0x73, 0xB7, 0x20, 0x58, 0x71]`) | `src/program/accounts.rs` `test_valid_discriminants` test asserts this exact value | ✅ — matches Aria's Day-3 verified magic-prefix in `programs/bell-markets/src/adapters/phoenix.rs` |

**Verdict:** Bram's PARTIAL-feasibility finding stands without correction. The mechanism exists; the current bind-to-existing-market path can't reach it.

### What's mechanically true at the on-chain layer

The Phoenix `fee_recipient` is bound at two distinct points, gated by two distinct signers:

1. **At `InitializeMarket` (variant 100):** `fee_recipient` is set as a parameter inside `InitializeParams`. The signer required is `market_creator`. Whoever creates the market becomes the initial `MarketHeader.authority` automatically.

2. **At `ChangeFeeRecipient` (variant 109):** existing `fee_recipient` is mutated. The signer required is `market_authority` — i.e., whoever held authority at the time of the call. Authority can transfer via `NameSuccessor` (variant 102) + `ClaimAuthority` (variant 101).

For BellMarkets to capture Phoenix taker fees, ONE of two must hold:

- **(A)** We are `market_creator` at init time → we own `authority` → we set `fee_recipient` to our PDA.
- **(B)** We hold `authority` (after a NameSuccessor + ClaimAuthority chain from the original creator) → we call `ChangeFeeRecipient` to point at our PDA.

Today's `programs/bell-markets/src/instructions/create_strike_market.rs` does NEITHER. It calls `verify_phoenix_market` (8-byte magic prefix check) on a supplied Phoenix market account and binds its pubkey into `StrikeMarket.phoenix_market`. No `InitializeMarket` CPI, no `ChangeFeeRecipient` CPI. The Day-4 META markets bind to `CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N` (SOL/USDC) whose `authority` and `fee_recipient` are whoever Phoenix or Ellipsis set at devnet seed time — emphatically not us.

### On-chain-engineer perspective on what Model D activation would require

Beyond Bram's cross-lead checklist, the program-side considerations:

1. **CPI to `InitializeMarket` is a substantial CPI** — Phoenix allocates bids/asks/seats arrays per the `MarketSizeParams { bids_size, asks_size, num_seats }` triple. A typical 500/500/100 sizing is ~80KB+ of account allocation. At 200K CU default per ix, Phoenix's init eats a significant chunk; combined with our state writes + Pyth read + Phoenix magic verify, we'd be CU-tight in a single `create_strike_market` ix. **Likely split required:** an `init_phoenix_market_for_strike` sibling ix that runs the Phoenix init separately, before our `create_strike_market` binds to it. This keeps our existing ix's CU envelope intact.

2. **Authority pubkey must be a program PDA**, not an admin keypair. Concrete recommendation: `[b"phoenix_auth", strike_market.key()]` per-strike, with the on-chain init wiring `market_creator = phoenix_auth_pda` (signed via PDA seeds). Per-strike authority isolates risk — a future `ChangeFeeRecipient` for one strike can't accidentally affect another. Bumps cached on `StrikeMarket.phoenix_auth_bump` (new field; would claim 1 byte from `_reserved`).

3. **`fee_recipient` is a token-account Pubkey, not a wallet Pubkey.** Phoenix sweeps to `fee_recipient` directly via SPL Token `Transfer` during `CollectFees`. So we'd pass the USDC ATA of our `MarketConfig.treasury`, not the wallet. Our existing fee-collector wallet `FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs` already has a USDC ATA (used by P2's `mint_pair` fee_collector_usdc check). Phoenix `fee_recipient = associated_token_address(treasury, usdc_mint)` works without new accounts.

4. **Cleo's Day-2 mint-mismatch flag dissolves naturally.** Phoenix's existing devnet markets use Phoenix-internal quote mints (`DK1gsSV...`) that ≠ Circle USDC. If we own the market, we pass `quote_mint = MarketConfig.usdc_mint` (Circle's `4zMMC9srt...`) at InitializeMarket time. The mismatch goes away by construction — atomic Buy No / Sell Yes flows that previously needed a Jupiter swap leg become 1-CPI clean.

5. **Per-strike vs per-ticker market.** Phoenix's "one market per (base, quote)" model means: one Phoenix market per strike (~50 strike-markets/day × 7 tickers = 350 Phoenix markets at full MAG7 scale), OR one Phoenix market per ticker × YES + NO sides. Decision affects rent burn (350 × ~0.6-1.4 SOL/market = ~$30K-65K at $200/SOL) vs liquidity fragmentation (350 markets each with their own order books vs 14 deeper markets). I lean per-ticker × per-side (14 total) — better liquidity, lower rent, simpler routing. Tate's call when this is dispatched.

6. **`taker_fee_bps` is `u64` (no upstream cap)** — Bram noted no upstream limit. Aria's defensive recommendation: hardcode an on-chain ceiling in our `init_phoenix_market_for_strike` ix (e.g., `require!(taker_fee_bps <= 50, ...)`) so a future admin keypair compromise can't reset taker fees to 99.99%. Phoenix-protocol-level there's no guard; we add one at our wrapper.

### Cost / activation triggers — unchanged from DR-009

Bram's revenue math holds. Per the existing escalation tree:

- Below $500K daily Phoenix volume: revenue is ~$30-91K/yr — not worth the ~6-8 hr cross-lead refactor + new audit surface (matching-engine CPI tightening is non-trivial to review).
- $500K-$1M daily volume: revenue ~$91-183K/yr — borderline; depends on the audit budget.
- $1M+ daily volume: revenue justifies the migration.
- Phoenix v2 with native per-third-party fee_recipient (Bram quarterly watch): would invalidate this trade-off entirely — we'd capture fees on bound markets without owning them.

### Defer decision — explicit hand-off

For MVP and the next ~6 months: stay on DR-008 mint-only fee. **No on-chain change to `create_strike_market`** until either daily Phoenix volume crosses $500K-$1M OR Phoenix v2 ships with the missing primitive. Both Aria's and Bram's investigations close the open question; future-Aria can re-open by dispatching the 6-8 hr migration checklist in Bram's investigation doc + the program-side considerations above.

This conclusion is documented here (canonical), in Bram's investigation doc (off-chain perspective), and in the audit log entry for the next deploy that bears on Phoenix integration (none planned without a Model D dispatch).

## References

- `constitution/decisions.md` DR-001 — Phoenix CLOB integration
- `constitution/decisions.md` DR-008 — Fee model with Phoenix venue-fee investigation
- `constitution/decisions.md` DR-009 — CLOB strategy escalation tree
- `.project/bell-markets/coordination/cory_questions_1_answers.md` — initial cost analysis context
- `programs/bell-markets/src/adapters/phoenix.rs` — Phoenix integration code
- Phoenix v1 source: https://github.com/Ellipsis-Labs/phoenix-v1
