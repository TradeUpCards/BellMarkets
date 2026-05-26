# Bell.Markets V2 Brief — Polish Feedback

**Source documents reviewed:** `Bell.Markets_v2.pdf` (12pp) + `Bell Markets V2 Unbiased Review_v2.pdf` (19pp)
**Reviewer's grade:** A− leave-behind, B+ in-room — fair.
**Core structural critique (reviewer):** *"Currently reads slightly too definitive for a devnet prototype."* — load-bearing fix. Everything else is polish.

---

## 1. Overall take

V2 is genuinely strong. The mechanics pages (5–7) are the spine — keep them and let everything else be in service to them. The biggest single risk to credibility is **one factually wrong claim** about the database; fix that first. The second-biggest is **tone drift toward overclaim** (covered well by the reviewer). Beyond that, the brief should lean harder into what makes Cory differentiated for an AI Engineer Fellow role: the multi-agent Claude Code workflow that built this.

---

## 2. What the reviewer nailed (agree, no need to re-justify)

- ✅ "At the bell" → "after the bell" for settlement timing
- ✅ Page 2 audience-facing rewrite (no "the read I want" fourth-wall break)
- ✅ Page 3 soften "most-watched, most-priced financial event on Earth"
- ✅ Page 4 tighter mainnet-path wording
- ✅ Page 5 remove "asserted on-chain or in CI" subtitle
- ✅ Page 5 F-02 less specific Pyth wording (no confidence/staleness numbers)
- ✅ Page 5 F-06 cut specific test counts
- ✅ Page 6 add "ignoring fees/spread" caveat to the YES/NO identity
- ✅ Page 7 "Maker is now short YES" → "Maker has sold the YES leg, holds NO exposure"
- ✅ Page 7 Carol P&L sentence rephrase
- ✅ Page 8 35 vs 49 markets/day inconsistency — must fix
- ✅ Page 9 typos: "book,four" and "BOTH side"
- ✅ Page 10 architecture defensibility — especially the "no off-chain DB" overclaim
- ✅ Page 11 rename "Hostile reviewer prompt"
- ✅ Page 11 soften "PRD said more ambitious is better" framing
- ✅ Replace "dedup'd" terminology with "ATM and ±3%, ±6%, ±9%"

---

## 3. What the reviewer missed or got partially wrong

### 3.1 The Neon Postgres claim — factually false, not just risky wording

Page 10 currently says: *"DECISION · DR-003 — No off-chain DB. Solana RPC is the source of truth. TanStack Query caches in memory."*

**This is wrong.** The repo has Neon Postgres in production:
- Bram's AI briefings table
- User upsert table (`apps/web/app/api/users/upsert/route.ts`, commit `c7f530e`)
- `notification_prefs`, `oauth_accounts`, `push_subscriptions`
- Leaderboard data, distributions table
- `services/automation/db/migrations/` with 6 SQL migration files visible on GitHub

A finance-savvy reviewer who clicks the repo link will see this in 30 seconds. The brief MUST be updated.

**Replacement copy for DR-003:**

> **DECISION · DR-003 — Chain is canonical for funds; database serves product surface.**
>
> Solana is the source of truth for balances, collateral, settlement, and redemption rights. A Neon Postgres serves user accounts, OAuth links, AI briefings, leaderboard reads, and notification state. The database can drift, get rebuilt, or be wiped — funds remain reconcilable from chain.

### 3.2 The Pyth-MAG7-on-devnet question (Cory must know the answer cold)

The reviewer flagged "Are those actual live Pyth equity feeds on devnet?" but didn't dig in. **This is the single deepest "show me" question a finance-savvy reviewer will ask.** Pyth MAG7 feeds on Solana devnet have historically been spotty per ticker.

If devnet settlement currently uses crypto feeds (BTC/SOL) as stand-ins or falls back to admin-override for unavailable tickers, **say that on Page 11** rather than letting it be a gotcha.

**Suggested honest framing for Page 11:**

> **Pyth equity feeds on devnet · live coverage**
> Pyth maintains MAG7 equity feeds, but devnet coverage during market hours is inconsistent per ticker. The settlement code path is wired against `get_price_no_older_than` with confidence and staleness gates. For tickers where the devnet feed is unavailable at close, demo settlement falls back to admin-override with a time-delayed gate. Production path: same code path, mainnet feeds, no admin fallback.

### 3.3 The "what I personally built" line — reframe more honestly

The reviewer suggests: *"I designed and implemented the market mechanics, Anchor program, order-book flow, settlement path, front-end trade surface, and CI invariant tests during the sprint."*

That's only fully true if Cory wrote every line. The build used a multi-agent Claude Code workflow with named lead agents (Aria/Bram/Cleo/Drew). **That's MORE impressive for an AI Engineer Fellow role**, not less — but the brief currently hides it.

**Replacement copy for Page 12:**

> "On Bell.Markets: I designed the architecture, locked the 20+ Decision Records that drove the build, and orchestrated a multi-agent Claude Code workflow across four named workstreams — onchain (Anchor program + matcher), automation (cron, oracle, AI briefings), frontend (trade surface + order-book UX), and quality (invariant tests + integration smoke). I reviewed and merged every commit; the agents executed under my dispatch."

This leverages the GauntletAI Fellowship instead of obscuring it. For PEAK6 specifically — *"directed AI agents to build a non-trivial financial primitive in 3 days"* is a stronger differentiator than *"wrote 952 lines of Rust by hand."*

### 3.4 Keith's reference design is a STRENGTH, currently buried as risk mitigation

Page 11's "Mitigation" mentions "parallel-cohort reference design with adversarial review pre-applied" but treats it as defense against a custom-matcher attack. **Adopting a peer's vetted design with their adversarial review baked in is a sign of engineering maturity, not desperation.** Senior engineers recognize when not to NIH.

**Add a one-line callout in the Mitigation block:**

> "Adopting a vetted peer-reference design instead of inventing a matcher from scratch is the senior-engineer move: shorter audit surface, faster review, fewer novel bugs."

### 3.5 Specific-number trim — partial agreement with reviewer

- ❌ Cut "~6.67 SOL spent" — pure noise, distracts
- ✅ Keep "27 instructions" — answers "did you actually build a meaningful program"
- ✅ Keep "deploy_index=8" — implies disciplined deploy hygiene
- ❌ Cut "~250 lines Rust + 702 lines matching helpers" — invites "show me the lines"

### 3.6 Tagline conflict (catch from reviewer, ruling here)

Logo slogan "Settle it at the bell" vs page-1 hero "settled at the bell" — **keep the logo, fix the hero**. They serve different roles: slogan is brand, hero is technical claim.

### 3.7 Things neither party flagged

- **"Complete-set close" terminology** on page 5 isn't explained anywhere — call it `redeem_pair` or "complete set redemption" with one sentence of explanation
- **"Bell.Markets" vs "BellMarkets"** — pick one and use it everywhere
- **Page 12 AI Engineer Fellow framing** — currently understated; should be louder
- **`/admin` console** appears in the architecture diagram but isn't explained — add a one-line footnote or skip it from the diagram

---

## 4. Pages with screenshots (8 + 9) — restructure

### 4.1 Diagnosis

**Page 8 (terminal / heatmap):** too small, too dark, caption describes the UI instead of describing what the *trader* is seeing, 35-vs-49 inconsistency lives here, no visual anchor to the mechanics from pages 5–7.

**Page 9 (trade surface):** same legibility problem, the "book,four" + "BOTH side" typos, doesn't materialize the "one book, four actions" claim with a visual, no proof this is a *live* deployment (could be a Figma mock).

### 4.2 Recommended restructure — collapse to ONE visual page + ONE receipts page

#### New Page 8 — "The live product"

ONE hero screenshot (the terminal/heatmap), enlarged to ~⅔ of the page, with **4 numbered callouts drawn onto the image** pointing at specific UI elements that map to mechanics from earlier pages:

1. **Pyth status pill** — "Live oracle, ATM-band gate (DR-002)"
2. **Probability cell** — "YES bid 0.62 / NO bid 0.38 → identity holds at midpoint"
3. **Strike grid** — "7 strikes per ticker: ATM, ±3%, ±6%, ±9% (49 markets/day across MAG7)"
4. **Settlement countdown** — "Permissionless crank opens at 4:05 ET (DR-002)"

Caption below the screenshot:

> Every element above is rendered from on-chain reads: order book PDA, market PDA, Pyth price account. No off-chain quote service, no shadow book. The probability cell is the matcher's midpoint; the settlement countdown is computed from the market's `expiry_ts`; the Pyth pill turns red the moment confidence breaches its gate. Live at **bell-markets.vercel.app** (Phantom/Backpack/Solflare).

Inset thumbnail (bottom-right corner): the trade surface — order book ladder + buy/sell ticket — with one-line caption:

> *"One-click intent on any of the four legs (Buy YES, Sell YES, Buy NO via atomic mint+sell). Order book ladder + trade ticket + position state in one frame."*

#### New Page 9 — "On-chain receipts"

The page the brief is currently missing and the one that will close any finance-savvy interviewer.

Three small screenshots in a vertical column (or 2×2 grid), each with a Solscan/SolanaFM link below:

1. **A real `settle_market` transaction on devnet** — Solscan view showing program ID, Pyth account read, resulting `MarketSettled` event with close price
2. **An order placed and matched** — `place_order` followed by `apply_settlement` in the same block, showing escrow movement
3. **A `redeem_pair` post-settlement** — showing 100 winning YES → 100 bUSDC, 100 losing NO → 0

Caption:

> Every screenshot above is a real devnet transaction. Click any signature to view it on a third-party explorer. The program executed it; we did not stub, mock, or simulate it. This is the bar I'd hold a v1 to: every claim in this brief has a receipt.

**This is the page that makes the brief defensible.** Right now, a reviewer reads "27 instructions, 19/19 invariant tests" and has to take Cory's word for it. With three Solscan links, they verify in 10 seconds. For PEAK6 — a derivatives shop — *on-chain receipts beat any prose claim*.

### 4.3 Fallback: if pages can't be reshuffled, keep 8 + 9 separate

**Page 8** — enlarge the heatmap, add the 4 callouts above, fix 35 → 49, caption shifts from "look at the heatmap" to "every cell rendered from on-chain reads — no off-chain quote service."

**Page 9** — enlarge the trade surface, add 4 different callouts:

1. **Four-button row** — "One book, four actions (DR-019: Limit NO disabled; atomic Buy NO = mint_pair + IOC sell-YES)"
2. **Order book ladder** — "Real PDA-stored book: 128 orders/side, three-phase matching (plan/settle/apply)"
3. **Trade ticket** — "Collateral debited atomically with order placement; never net-credit"
4. **Position state** — "YES/NO balances from token accounts; never from local state"

Caption:

> "One order book per strike. Buy YES, Sell YES, Buy NO, and Sell NO all route through the same PDA-stored book. Buy NO and Sell NO are atomic compositions of `mint_pair` + IOC sell-YES (and the inverse) — single transaction, never half-filled across two states."

Move the receipts to page 11 inset (worse, but salvageable).

### 4.4 Micro-fixes to the screenshots themselves

- **Light mode or invert** the terminal — current shots are too dark to read at print scale
- **Crop browser chrome** (URL bar, tabs) — wasted pixels
- **Annotate IN the image, not the caption** — numbered circles directly on the screenshot beat "in the top-right you can see…"
- **Show real data, not zeros** — place demo orders before reshooting so probability cells, order book, and position state have actual numbers

---

## 5. Drop-in replacement copy (highest-priority edits)

### Page 1 hero

**Was:** *"Binary markets on MAG7 closes, settled on-chain at the bell."*

**Replace with:** *"Binary markets on MAG7 closes. On-chain settlement at the daily print."*

### Page 2 quote box

**Was:** *"'Builder with finance instincts' is the read I want. Architecture, mechanics, and tradeoffs over startup pitch."*

**Replace with:** *"This brief is a market-structure leave-behind, not a startup pitch. The strongest pages are 6 (mechanics) and 7 (worked trade). Read those if you read nothing else."*

### Page 3 (soften the "most-watched on Earth" claim)

**Was:** *"Single-name daily closes are the most-watched, most-priced financial event on Earth."*

**Replace with:** *"Single-name daily closes are among the most-priced and most-discussed events in retail and institutional finance. MAG7 in particular concentrates attention across earnings cycles."*

### Page 5 subtitle

**Was:** *"Each item below is asserted on-chain or in CI. Each is also one of the reasons this is shippable in three days instead of three months."*

**Replace with:** *"Each item below is enforced by code, by the program, or by a deliberate failure-path choice. Together they're the reasons this is a working primitive, not a UI demo."*

### Page 5 F-04 (separate permissionless crank from admin)

**Was:** *"Permissionless settle — If our cron dies, any wallet can crank settle_market once the window opens. The system survives our orchestration. The demo proves it from a wallet that isn't ours."*

**Replace with:** *"Permissionless settlement — Once the settlement window opens and oracle conditions pass, any wallet can crank `settle_market`. Admin settlement exists as a time-delayed fallback for cases where the oracle is unrecoverable. Normal settlement does not depend on our cron."*

### Page 6 caveat (add below the YES/NO identity line)

> *"Identity holds at midpoint; executable NO prices route through the YES bid/ask, so realized prices include the spread."*

### Page 11 rename + soften (the "hostile reviewer" section)

**Was:** *"Hostile reviewer prompt: 'why a custom matcher?'"*

**Replace with:** *"Why an in-program matcher in v1"*

**Replace the mitigation prose with:**

> *"The PRD allowed either Phoenix integration or a minimal in-program matcher. Phoenix was the initial direction; devnet bootstrapping proved impractical inside the build window because Phoenix's market-init requires our YES mint to exist before our program creates it. The in-program path eliminated that dependency and concentrated trading + settlement + collateral accounting in one audit surface. I adopted a parallel-cohort reference design with adversarial review pre-applied (SPL-owned check, frozen-account rejection, PDA seed constraints, checked arithmetic, zero-price guard); 19/19 invariant tests pass on devnet. Formal third-party audit is the gate to mainnet GA. Phoenix integration is documented as a v2 candidate."*

### Page 11 (add Pyth-on-devnet honesty)

See §3.2 above for replacement copy.

### Page 12 (multi-agent workflow framing)

See §3.3 above for replacement copy.

### Page 10 DR-003 (Neon DB)

See §3.1 above for replacement copy.

---

## 6. Prioritized edit order

Do in this order. Each step assumes the prior step landed.

| # | Edit | Why first/last |
|---|------|---|
| 1 | **Fix DR-003 "No off-chain DB"** | Factually wrong. #1 credibility risk. |
| 2 | **Fix 35 vs 49 markets inconsistency** | Most obvious internal contradiction. |
| 3 | **Page 1 hero: "after the bell" / "daily print"** | Easy fix; quotable accuracy. |
| 4 | **Page 11 "hostile reviewer" rename + soften** | Defensiveness signal in current copy. |
| 5 | **Page 12 multi-agent workflow framing** | Leverages the GauntletAI angle. |
| 6 | **Page 5 subtitle + F-04 separation** | Biggest overclaim concentration. |
| 7 | **Page 6 add ignoring-fees caveat** | Finance-rigor signal. |
| 8 | **Pages 8-9 restructure → 1 visual + 1 receipts** | Biggest structural upgrade. Receipts page is the trust closer. |
| 9 | **Page 2 audience-facing rewrite** | Tone, not facts — last because it's lower-risk. |
| 10 | **Add Pyth-on-devnet honesty on page 11** | Avoids a known gotcha; only matters if devnet feeds are actually unreliable for some tickers. |

Everything else (typos, "Maker is short YES" wording, page 3 softening, "dedup'd" wording) is polish — do in one pass after the above.

---

## 7. Bottom line

The reviewer's overall direction is right: **shift from "look at this platform I built" to "here is the primitive, here's what's real, here's what would need to change before production."**

My addition: **lean into the multi-agent AI orchestration angle.** Cory is applying as an AI Engineer Fellow. The brief currently undersells what's most distinctive about how this got built. Page 12 should make that explicit. The PEAK6 panel will respect *"built a non-trivial financial primitive with a directed multi-agent workflow in 3 days"* more than they'll respect *"wrote 952 lines of Rust by hand."*

The single highest-leverage upgrade is the **new on-chain receipts page** (§4.2). Every other edit is text polish; that one is a structural credibility win that costs an afternoon of screenshotting and gains hours of interview trust.

---

## 8. Optional follow-up artifacts

If useful, the next concrete deliverables would be:

- **Interview-day cheat sheet (1 page):** pre-canned answers to the likely hostile questions (Pyth integrity, custom matcher, regulatory, custody, $1 invariant, mainnet path)
- **Receipts page checklist:** the exact devnet transactions to capture, the order to fire them in, and the Solscan URL format
- **Figma/Canva paste-ready callout text** for the screenshot callouts

Ping me on any of those.
