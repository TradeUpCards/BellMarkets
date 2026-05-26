# BellMarkets — Brain Lift

> Single source of truth for AI coding assistants. Read this before writing code. If you'd contradict something here, stop and ask.
>
> **Status:** v2 — refreshed 2026-05-25 post-DR-020 + post-deploy_index=8 (submission day). Day-0 (2026-05-21) version is preserved in git history. Detailed architecture lives in `specs/architecture.md`. Locked design decisions live in `constitution/decisions.md` (DR-001…DR-020). Where this doc and the DR file disagree, the DR file wins — it's the audit trail.

---

## 1. Context

### What this is
BellMarkets is the team's implementation of the Gauntlet "Meridian" PRD: a non-custodial Solana dApp where users trade YES/NO binary outcome tokens against bUSDC for *"Will [STOCK] close above [PRICE] today?"* on the MAG7. Settlement is an on-chain Pyth read shortly after 4:00 PM ET. The order book is **in-program** (per DR-020 — pivoted from Phoenix integration). Daily lifecycle is orchestrated by an off-chain TypeScript service on Trigger.dev. PRD source: `.project/bell-markets/docs/prd/project_1771969779565.pdf`.

### Why it exists
Gauntlet cohort project — partner-evaluated build demonstrating the full lifecycle (`create → mint → trade → settle → redeem`) end-to-end on Solana devnet, with defensible architecture and named trade-offs. Hard final: **Mon 2026-05-25 7:00 PM ET**. Effective build window: ~4 days.

### Who uses it
- **Demo users:** retail-style traders on Solana devnet during the demo window; Phantom/Backpack/Solflare wallet, no KYC.
- **Evaluators:** Gauntlet reviewers running the lifecycle from the repo + reviewing on-chain via Solscan.
- **Team:** validating on-chain invariants and the cron-failure recovery path during dev.

### Stage of build (2026-05-25, submission day)
- **Anchor program:** deployed to devnet at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` (deploy_index=8). 27 instructions, 7 account types, 57 error variants.
- **bUSDC self-controlled demo mint:** `5vq2oahKFnnjStK1Ctqwdxdt44rtKuKHmPga9iZKtBZp`.
- **In-program CLOB:** live. Matcher verified end-to-end on-chain (META $610, 6 resting orders, 1 crossing trade — all invariants held).
- **Frontend:** deployed on Vercel; trade page hooks (`useAllMarkets`, `useOrderBook`, `usePosition`) wired to live chain state.
- **Automation:** Trigger.dev jobs defined for create-markets (~8am ET) + post-close phases (4:05pm ET settle + grid-evolution).
- **Documentation:** brief V2 + pre-mainnet-readiness + decisions log + this brainlift updated.

### Deadlines
- **Final submission:** Mon 2026-05-25 7:00 PM ET (hard cohort deliverable). ← TODAY
- **Stretch:** mainnet-beta after submission, gated on v1.1 rent-recovery instructions (`force_cancel_order` + `close_order_book`, per `specs/deferred.md`).

### Out of scope (deliberate)
- No mainnet, no real funds (PRD hard rule)
- No KYC, no custody, no off-ramp
- No mobile / no i18n / no multi-tenant
- **Off-chain database is product surface, not protocol authority.** Solana is canonical for funds (DR-003 amended); a Neon Postgres serves users, OAuth, AI briefings, notification prefs, leaderboard reads. The DB can be wiped — funds remain reconcilable from chain.
- No fallback CLOB if the in-program matcher has a bug — admin pause is the safety valve
- No fallback oracle if Pyth fails (DR-003) — admin override (`admin_settle`) on a 1-hour time delay is the recovery
- No non-MAG7 stocks, no margin / perps / cross-strike netting
- No automated rent recovery for OrderBook + escrows post-settle in v1 — deferred to v1.1 as pre-mainnet precondition (`specs/deferred.md` + `pre-mainnet-readiness.md` §"v2 gap #8")

---

## 2. Spiky Points of View

> Disagreeing with one means redesigning the project, not patching it. Each POV has a Decision Record in `constitution/decisions.md`.

### POV 1 — Build the matching engine in-program; concentrate trading + settlement + collateral in one audit surface
We run a price-time-priority CLOB inside the Anchor program. `place_order` is the entry point; the matcher crosses on placement (three-phase plan/settle/apply) and rests the remainder if any. `cancel_order` is owner-only and refunds exact remaining escrow. `match_orders` is a permissionless crank for crossed-but-unmatched books. The OrderBook PDA is a bounded zero-copy struct (128 orders per side). Adopted a parallel-cohort reference design with adversarial review pre-applied (Keith Mazanec's Chunk-1–6 + invariant-test pattern).

**Trade-off:** We pay one novel audit surface (the matcher) — gated for mainnet on a formal third-party audit — in exchange for: no dependency on Phoenix devnet bootstrap (which proved impractical inside the demo window because Phoenix's market-init requires our YES mint to exist before our program creates it), a smaller audit surface concentrated in one program, escrow telescoping without dust, and a stronger "we built it" interview narrative. See DR-020 (supersedes DR-001).

### POV 2 — On-chain owns the rules; off-chain owns the schedule. `settle_market` is permissionless.
The Anchor program enforces all settlement rules: time gate, Pyth staleness + confidence, immutable outcome write. `settle_market` is **callable by anyone** — Bram's automation service is a convenience caller (first to crank wins), not an authority. Admin override (`admin_settle`) is on-chain time-delayed (≥1hr) and used only when Pyth fails.

**Trade-off:** ~half a day of extra on-chain timing-logic work + benign race-condition wasted fees, in exchange for cheaper mainnet ops (~5–10×), better scaling (load distributes to user demand), stronger demo defense ("our cron can die and the system still works"), and engineering symmetry with the in-program matcher's permissionless-crank philosophy. See DR-002.

### POV 3 — Buy NO is a first-class atomic operation; UI never exposes mint-and-sell
Four buttons: Buy YES, Buy NO, Sell YES, Sell NO. Each = one wallet-signed transaction. Buy NO bundles `mint_pair + place_order(SELL_YES, IOC)` atomically (user keeps the NO, effective cost = `$1 − YES_sale_price`); Sell NO is the inverse (`place_order(BUY_YES, IOC) + redeem_pair`). Users never see a "mint pair" button, never see a YES token they don't want.

**Trade-off:** More frontend complexity (bundled atomic transactions, position-aware button states, four-button mental model) in exchange for UX that matches user intent rather than protocol internals. We reject the faster-to-build path that exposes the mint-then-sell steps. **Amended post-DR-020:** Limit-side NO trades are disabled (DR-019) — only market orders for NO — because a resting Limit NO would strand fees on cancel. Limit YES + four atomic flows remain.

---

## 3. The Knowledge Tree

> Detailed architecture (repo layout tree, Rust + TS type signatures, full domain model) lives in `specs/architecture.md`. This section is the index, not the architecture.

### Tech Stack (post-DR-020 + post-Day-7)
- **Solana CLI:** **3.1.14** (Anza/agave; bundles platform-tools v1.52 with Cargo 1.85 / edition2024)
- **Anchor CLI:** **0.31.1** (compatible with Solana 3.x sBPF v3 VM)
- **Rust (host):** 1.95 stable
- **Onchain language:** Rust + Anchor on **Solana devnet** (stretch: mainnet-beta gated on v1.1)
- **CLOB:** **In-program** (DR-020). Bounded zero-copy `OrderBook` PDA, 128 orders/side, three-phase matching (plan/settle/apply). Reference: `docs/architecture/reference-clob-{design,decisions,spec}.md`. Phoenix integration code stays dormant in the program (additive — not removed); Phoenix-as-secondary-venue is a v2 candidate per DR-009.
- **Oracle:** Pyth Network (DR-003) — implemented via vendored 30-line price-account parser at `programs/bell-markets/src/oracle.rs`. **Do NOT use `pyth-sdk-solana`** — Borsh-version cascade documented in `LESSONS.md` Lesson 1.
- **RPC:** Helius via server-side proxy at `apps/web/app/api/solana-rpc/route.ts` (key stays out of NEXT_PUBLIC_ — see DR-014 + brief)
- **Frontend:** **Next.js 14.2.18** (App Router) + **React 18** + TypeScript strict — version pinned per `LESSONS.md`
- **Anchor JS client:** `@coral-xyz/anchor` **0.30.1** (deliberate mismatch with CLI 0.31.1 per DR-004)
- **Wallet:** `@solana/wallet-adapter-react` (Phantom / Backpack / Solflare)
- **Realtime:** `connection.onAccountChange` subscriptions — no polling (Hard YES #9)
- **State / data:** TanStack Query for RPC caching + dedup + WebSocket cache bridge; Zustand for ephemeral UI state
- **Styling:** Tailwind CSS + shadcn/ui (copy-paste Radix-based components)
- **Database (product surface):** **Neon Postgres** (DR-003 amended). Tables: `users`, `oauth_accounts`, `notification_prefs`, `push_subscriptions`, `briefings`, `leaderboard_*`, `distributions`. NOT canonical for funds — chain is.
- **Automation service:** Node.js + TypeScript on **Trigger.dev** at separate `services/automation/` workspace package — cron handles morning create + post-close grid evolution + settlement-nudger
- **AI:** Anthropic Claude Sonnet for Bell Pro daily briefings (live on /api/briefings/<TICKER>)
- **Package manager:** **pnpm** always (never npm, never yarn) — confirmed user preference
- **Monorepo:** pnpm workspaces (apps/web, services/automation, packages/ui, programs/bell-markets, tests)
- **Testing (Anchor + integration + eval):** mocha + chai + ts-mocha via `anchor test`; Rust property tests via `cargo test --lib`
- **Testing (automation service):** **Vitest** (ESM-first; clean with Trigger.dev v4)
- **Testing (frontend):** Jest (Next.js default)
- **Primary invariant verification:** in-program invariant tests (`programs/bell-markets/src/instructions/*.rs` `#[cfg(test)]` blocks — 100/100 Rust property tests) + Drew's `tests/contracts/test_order_book_invariants.ts` (vault invariant, escrow reconciliation, four-path smoke) + `tests/integration/live-program-call.test.ts` (chain-simulate).
- **Linting:** ESLint + Prettier (TS); clippy + rustfmt (Rust)
- **Deployment:** Solana devnet (program), Vercel (frontend at bell-markets.vercel.app), Trigger.dev (automation), Neon (database)

### Critical files
- **`programs/bell-markets/src/instructions/place_order.rs`** — DR-020 load-bearing; three-phase matching; vault invariant must hold across cross.
- **`programs/bell-markets/src/instructions/cancel_order.rs`** — escrow refund correctness; allowed even when paused/settled.
- **`programs/bell-markets/src/instructions/settle_market.rs`** — $1 invariant load-bearing; permissionless; Pyth-validated.
- **`programs/bell-markets/src/instructions/mint_pair.rs`** — vault-balance invariant load-bearing.
- **`programs/bell-markets/src/instructions/redeem.rs`** — payout invariant load-bearing.
- **`programs/bell-markets/src/matching.rs`** — sorted-insert + remove-shift; bid_cost_ceil helper.
- **`programs/bell-markets/src/state.rs`** — `OrderBook::LEN = 16,448 B`; `ORDERBOOK_N = 128`.
- **`programs/bell-markets/src/oracle.rs`** — Pyth parser; staleness + confidence thresholds.
- **`services/automation/src/jobs/morning.ts`** — daily liveness (no morning markets = no demo).
- **`apps/web/src/lib/tx/build-buy-no.ts`** (+ `build-sell-no.ts`) — POV-3 atomicity; review must verify bundling.
- **`apps/web/app/api/solana-rpc/route.ts`** — Helius proxy keeping key server-side.

### Where local-only coordination memory lives
- `.project/bell-markets/in-flight.md` — workstream + file-ownership map
- `.project/bell-markets/kickoff/`, `handoffs/`, `sessions/`, `candidates/`, `stories/`, `docs/prd/`
- `CLAUDE_SESSION_HANDOFF.md` (repo root) — Tate session continuity

`.project/` and `.claude/` are gitignored; junctioned to OneDrive for survivor copies + cross-machine sync.

---

## 4. Guardrails

### Hard NOs

1. **Never use mainnet or real funds** for the core submission (PRD).
2. **Never commit secrets / private keys / mnemonics / API keys / RPC keys** to git. `.env` only; `.env.example` shows the shape. `keys/` directory is gitignored.
3. **Never use `npm install` or `yarn add`** — pnpm always. Delete any `package-lock.json` / `yarn.lock` that sneaks in.
4. **The matcher is in-program now (DR-020).** Reject PRs that try to swap it for Phoenix or another CLOB without a new DR superseding DR-020. (Originally Hard NO #4 said "never write a matcher" — superseded same day as DR-020.)
5. **Never give `settle_market` a special-signer requirement** (DR-002). The instruction must be safe under arbitrary callers.
6. **Never add a fallback oracle** (DR-003). Pyth or admin override only.
7. **Never leak the mint-and-sell mechanic to the trade UI** (POV-3). Buy NO / Sell NO are atomic single-tx operations from the user's perspective.
8. **Never violate the $1 USDC invariant** — `yes_payout + no_payout = $1.00` exactly. Fees route through `fee_collector`, never out of `usdc_vault`.
9. **Never commit files under `.project/` or `.claude/`** — OneDrive-mirrored, gitignored by construction.
10. **Never `git push --force` to `main`** without explicit user request.
11. **Never dump raw oracle / RPC / wallet logs** (>20 lines) into handoffs, session recaps, or commit messages.
12. **Never use live stock prices in unit / integration tests** — synthetic / mocked Pyth feeds only. CI must not depend on market hours.
13. **The Helius API key NEVER appears in `NEXT_PUBLIC_*`.** Server-side proxy only (`/api/solana-rpc`). A leaked key is a leaked credential, full stop.

### Hard YESes

1. **The $1 USDC invariant is verified on-chain.** `mint_pair` debits exact `amount` bUSDC and mints exact `amount` YES + `amount` NO; `redeem_pair` is the inverse; `redeem` post-settle pays $1 to the winning side; the vault holds exactly `pairs_outstanding × $1`. Drew's `tests/contracts/test_order_book_invariants.ts` plus Aria's Rust property tests cover this.
2. **The full lifecycle is demoable end-to-end on devnet.** Create → mint → trade (place_order match) → settle → redeem. Verified tonight (2026-05-25) for the trade leg; settle + redeem in Aria's smoke-test path.
3. **pnpm always** — every script / CI / README / `package.json` references pnpm. User confirmed permanent preference.
4. **Every PR runs:** `anchor test` + `pnpm test` + `pnpm typecheck` + `pnpm lint`. CI fails the merge if any fail.
5. **The demo includes the cron-failure path** — settle from a non-cron wallet. Load-bearing evidence for DR-002.
6. **`settle_market` validates Pyth staleness AND confidence**; both thresholds configurable; outcome immutable once written.
7. **`admin_settle` has an on-chain time-delay gate** (≥1hr after settlement window). Enforced in the program.
8. **Position-exclusivity is a frontend guardrail** — UI prevents Buy YES while holding NO (and vice versa). Benign if bypassed (user redeems pair for $1).
9. **Order book + portfolio views update via WebSocket** (`onAccountChange`) — no polling. Reconnect-on-disconnect handled.
10. **Frontend uses `@solana/wallet-adapter-react` for all signing** — no in-app keystore, no env-var private keys for "test flows."
11. **Every Spiky POV has a Decision Record** in `constitution/decisions.md` with the trade-off line spelled out.
12. **All matcher CPI transfers are PDA-signed** with `strike_market` as authority — never the user. Maker payout ATAs are validated for ownership + mint before the CPI fires (per `place_order.rs` `verify_maker_account`).

### Things to flag for human review (not auto-block)
- Adding any new dependency beyond the locked stack — name a one-line "why" first.
- Touching the `vault` PDA seeds, `OrderBook` schema, or `StrikeMarket` account schema after deploy_index=8.
- Any change to `place_order`, `cancel_order`, `match_orders`, `settle_market`, `mint_pair`, or `redeem` — pause for property-test coverage review.
- Any cross-workstream PR (e.g., `programs/` + `apps/web/`) — both owning leads must sign off.
- Any deviation from a Spiky POV — write a new DR before implementing.

---

> **Created:** 2026-05-21 (v1) → refreshed 2026-05-25 (v2, post-DR-020 + post-deploy_index=8)
> **Template:** brainlift v1 (from `claude-code-project-template` v0.3.0+)
> **Owner:** Cory Vandenberg (Tate)
> **Update cadence:** Same-session edit for items that change during work. End-of-week sweep.
