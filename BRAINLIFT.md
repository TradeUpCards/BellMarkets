# BellMarkets — Brain Lift

> Single source of truth for AI coding assistants. Read this before writing code. If you'd contradict something here, stop and ask.
>
> **Status:** v1 — locked Day 0 (2026-05-21). Detailed architecture (repo layout, type signatures, domain model) lives in `specs/architecture.md`. Locked design decisions live in `constitution/decisions.md` (DR-001 Phoenix, DR-002 Permissionless settle, DR-003 Pyth).

---

## 1. Context

### What this is
BellMarkets is the team's implementation of the Gauntlet "Meridian" PRD: a non-custodial Solana dApp where users trade Yes/No binary outcome tokens against USDC for *"Will [STOCK] close above [PRICE] today?"* on the MAG7. Settlement is an on-chain Pyth read at 4:05 PM ET; the order book is Phoenix; the daily lifecycle is orchestrated by an off-chain TypeScript service. PRD source: `.project/bell-markets/docs/prd/project_1771969779565.pdf`.

### Why it exists
Gauntlet cohort project — partner-evaluated build demonstrating the full lifecycle (`create → mint → trade → settle → redeem`) end-to-end on Solana devnet, with defensible architecture and named trade-offs. Hard final: **Mon 2026-05-25 7:00 PM ET**. Effective build window: ~3 days from Day 0.

### Who uses it
- **Demo users:** retail-style traders on Solana devnet during the demo window; Phantom/Backpack wallet, no KYC.
- **Evaluators:** Gauntlet reviewers running the lifecycle from the repo via one-command setup.
- **Team:** validating on-chain invariants and the cron-failure recovery path during dev.

### Stage of build
Day 0 — repo bootstrapped, constitution being written, no application code yet. Next: `/sdd-init`, then dispatch Aria.

### Deadlines
- **MVP target:** Fri 2026-05-22 9:00 PM ET (informal team target — not a hard gate)
- **Final:** Mon 2026-05-25 7:00 PM ET (hard cohort deliverable)
- **Stretch:** mainnet-beta with funded automation wallet + production Pyth feeds — post-demo only.

### Out of scope (deliberate)
- No mainnet, no real funds (PRD hard rule)
- No KYC, no custody, no off-ramp
- No mobile / no i18n / no multi-tenant
- No persistent off-chain database — Solana RPC is the source of truth; automation service is stateless cron
- No fallback CLOB if Phoenix has an outage (DR-001) and no fallback oracle if Pyth fails (DR-003) — admin override is the recovery
- No non-MAG7 stocks, no margin / perps / cross-strike netting, no on-chain matching engine of our own

---

## 2. Spiky Points of View

> Disagreeing with one means redesigning the project, not patching it. Each POV has a Decision Record in `constitution/decisions.md`.

### POV 1 — Integrate Phoenix; do not reinvent the matching engine
We use Phoenix as the on-chain CLOB for every strike market. Aria's Anchor program creates a Phoenix market per strike during the morning job and binds Yes-token settlement to it. Matching, price-time priority, partial-fill accounting, self-trade prevention are Phoenix's problem.

**Trade-off:** We pay a weaker "we built our own matching engine" interview narrative and accept a hard dependency on Phoenix (no fallback CLOB), in exchange for ~1.5 days of build budget, audited matching logic, and a permissionless-crank philosophy aligned with POV-2. See DR-001.

### POV 2 — On-chain owns the rules; off-chain owns the schedule. `settle_market` is permissionless.
The Anchor program enforces all settlement rules: time gate, Pyth staleness + confidence, immutable outcome write. `settle_market` is **callable by anyone** — Bram's automation service is a convenience caller (first to crank wins), not an authority. Admin override (`admin_settle`) is on-chain time-delayed (≥1hr) and used only when Pyth fails.

**Trade-off:** ~half a day of extra on-chain timing-logic work + benign race-condition wasted fees, in exchange for cheaper mainnet ops (~5–10×), better scaling (load distributes to user demand), stronger demo defense ("our cron can die and the system still works"), and alignment with Phoenix's permissionless-crank philosophy. See DR-002.

### POV 3 — Buy No / Sell No are first-class atomic operations; UI never exposes mint-and-sell
Four buttons: Buy Yes, Buy No, Sell Yes, Sell No. Each = one wallet-signed transaction. Buy No bundles `mint_pair + sell_yes` on Phoenix atomically (user keeps the No, effective cost = `$1 - yes_sale_price`); Sell No is the inverse. Users never see a "mint pair" button, never see a Yes token they don't want.

**Trade-off:** More frontend complexity (bundled atomic transactions, position-aware button states, four-button mental model) in exchange for UX that matches user intent rather than protocol internals. We reject the faster-to-build path that exposes the steps.

---

## 3. The Knowledge Tree

> Detailed architecture (repo layout tree, Rust + TS type signatures, full domain model) lives in `specs/architecture.md` (populated by `/sdd-init`). This section is the index, not the architecture.

### Tech Stack
- **Solana CLI:** **3.1.14** (Anza/agave; bundles platform-tools v1.52 with Cargo 1.85 / edition2024)
- **Anchor CLI:** **0.31.1** (compatible with Solana 3.x sBPF v3 VM)
- **Rust (host):** 1.95 stable
- **Onchain language:** Rust + Anchor on **Solana devnet** (stretch: mainnet-beta)
- **CLOB:** Phoenix (DR-001) — no custom matcher. Integrate via `UncheckedAccount<'info>` + manual byte layout (only pattern that works for > 1 KB Solana accounts; same approach Phoenix/Serum/OpenBook use internally per `LESSONS.md` Lesson 3).
- **Oracle:** Pyth Network (DR-003) — implemented via vendored 30-line price-account parser at `programs/bell-markets/src/oracle.rs`. **Do NOT use `pyth-sdk-solana`** — Borsh-version cascade documented in `LESSONS.md` Lesson 1.
- **RPC:** Helius (devnet + WebSocket subscriptions)
- **Frontend:** **Next.js 14.2.18** (App Router) + **React 18** + TypeScript strict — version pinned to the combination `LESSONS.md` validated as "stable with `@solana/wallet-adapter`"
- **Anchor JS client:** `@coral-xyz/anchor` **0.30.1**
- **Wallet:** `@solana/wallet-adapter-react` (Phantom / Backpack / Solflare)
- **Realtime:** `connection.onAccountChange` subscriptions — no polling (Hard YES #9)
- **State / data:** TanStack Query for RPC caching + dedup + WebSocket cache bridge; Zustand for ephemeral UI state
- **Styling:** Tailwind CSS + shadcn/ui (copy-paste Radix-based components)
- **Automation service:** Node.js + TypeScript on **Trigger.dev** (free tier) at separate `services/automation/` workspace package — cron platform handles the 8am ET morning job + ~4:05pm ET settlement nudger
- **Package manager:** **pnpm** always (never npm, never yarn)
- **Monorepo:** pnpm workspaces
- **Testing (Anchor + integration + eval):** mocha + chai + ts-mocha via `anchor test` (Anchor default; Drew's `tests/integration/` + `tests/eval/` also use this)
- **Testing (automation service):** **Vitest** (ESM-first; clean with Trigger.dev v4 + `"type": "module"`; Jest+TS+ESM interop is friction Bram explicitly chose to avoid)
- **Testing (frontend):** Jest (Next.js default)
- **Primary invariant verification:** **compressed-time lifecycle simulation** at `scripts/simulate-trading-day.mjs` (60s = 1 trading day, ≥3 wallets, multi-user) — Drew-owned. Catches multi-user contention bugs that per-function tests miss (per `LESSONS.md` Lesson 10). Supplemented by parameterized mocha tests for specific edge cases.
- **Linting:** ESLint + Prettier (TS); clippy + rustfmt (Rust)
- **Deployment:** Solana devnet (contracts), Vercel (frontend), Trigger.dev (automation service)
- **CI gate:** `anchor test` + `pnpm test` + `pnpm typecheck` + `pnpm lint` + compressed-time simulation run. All must pass to merge.

### Critical files (when they exist)
- **`programs/bell-markets/src/instructions/settle_market.rs`** — $1 invariant load-bearing; permissionless; Pyth-validated. Highest property-test coverage.
- **`programs/bell-markets/src/instructions/mint_pair.rs`** — vault-balance invariant load-bearing.
- **`programs/bell-markets/src/instructions/redeem.rs`** — payout invariant load-bearing.
- **`programs/bell-markets/src/oracle/pyth.rs`** — staleness + confidence thresholds; wrong thresholds = settlements on bad data.
- **`services/automation/src/jobs/morning.ts`** — daily liveness; no morning markets = no demo.
- **`apps/web/lib/solana/buy-no.ts`** (+ `sell-no.ts`) — POV-3 atomicity; review must verify the bundle.

### Where local-only coordination memory lives
- `.project/bell-markets/in-flight.md` — workstream + file-ownership map
- `.project/bell-markets/kickoff/`, `handoffs/`, `sessions/`, `candidates/`, `stories/`, `docs/prd/`
- `CLAUDE_SESSION_HANDOFF.md` (repo root) — Tate session continuity

`.project/` and `.claude/` are gitignored; junctioned to OneDrive for survivor copies + cross-machine sync.

---

## 4. Guardrails

### Hard NOs

1. **Never use mainnet or real funds** for the core submission (PRD).
2. **Never commit secrets / private keys / mnemonics / API keys / RPC keys** to git. `.env` only; `.env.example` shows the shape.
3. **Never use `npm install` or `yarn add`** — pnpm always. Delete any `package-lock.json` / `yarn.lock` that sneaks in.
4. **Never write an on-chain matching engine** (DR-001). Reject PRs that add price-time-priority code inside the Anchor program.
5. **Never give `settle_market` a special-signer requirement** (DR-002). The instruction must be safe under arbitrary callers.
6. **Never add a fallback oracle** (DR-003). Pyth or admin override only.
7. **Never leak the mint-and-sell mechanic to the trade UI** (POV-3). Buy No / Sell No are atomic single-tx operations from the user's perspective.
8. **Never violate the $1 USDC invariant** — `yes_payout + no_payout = $1.00` exactly. Fees, if added later, go to a separate account.
9. **Never commit files under `.project/` or `.claude/`** — OneDrive-mirrored, gitignored by construction.
10. **Never `git push --force` to `main`** without explicit user request.
11. **Never dump raw oracle / RPC / wallet logs** (>20 lines) into handoffs, session recaps, or commit messages.
12. **Never use live stock prices in unit / integration tests** — synthetic / mocked Pyth feeds only. CI must not depend on market hours.

### Hard YESes

1. **The $1 USDC invariant is verified by the compressed-time lifecycle simulation** (`scripts/simulate-trading-day.mjs`) on every CI build. The simulation covers create → mint → ≥3 trade paths → settle → redeem with ≥3 distinct test wallets and asserts `vault_balance == $1 × open_pairs` AND `yes_payout + no_payout == $1.00` from logged events. Supplemented by parameterized mocha edge cases (at-strike, double-redeem, stale Pyth, settle-before-window).
2. **The full lifecycle is demoable end-to-end on devnet with one command** (`scripts/one-command-demo.sh`).
3. **pnpm always** — every script / CI / README / `package.json` references pnpm.
4. **Every PR runs:** `anchor test` + `pnpm test` + `pnpm typecheck` + `pnpm lint`. CI fails the merge if any fail.
5. **The demo includes the cron-failure path** — kill automation mid-settle, trigger settle from a test user wallet. Load-bearing evidence for DR-002.
6. **`settle_market` validates Pyth staleness AND confidence**; both thresholds configurable; outcome immutable once written.
7. **`admin_settle` has an on-chain time-delay gate** (≥1hr after settlement window). Enforced in the program.
8. **Position-exclusivity is a frontend guardrail** — UI prevents Buy Yes while holding No (and vice versa). Benign if bypassed (user redeems pair for $1).
9. **Order book + portfolio views update via WebSocket** (`onAccountChange`) — no polling. Reconnect-on-disconnect handled.
10. **Frontend uses `@solana/wallet-adapter-react` for all signing** — no in-app keystore, no env-var private keys for "test flows."
11. **Every Spiky POV has a Decision Record** in `constitution/decisions.md` with the trade-off line spelled out.

### Things to flag for human review (not auto-block)
- Adding any new dependency beyond the locked stack (Anchor, Pyth SDK, Phoenix SDK, Next.js, wallet adapter, TanStack Query) — name a one-line "why" first.
- Touching the `vault` PDA seeds or `StrikeMarket` account schema after the first devnet deploy.
- Any change to `settle_market`, `mint_pair`, or `redeem` — pause for property-test coverage review.
- Any cross-workstream PR (e.g., `programs/` + `apps/web/`) — both owning leads must sign off.
- Any deviation from a Spiky POV — write a new DR before implementing.

### Sweep items
(All `[INFERRED — CONFIRM]` tags resolved on Day 0 — see Tech Stack section above. Cleo's stack locked at Next 14.2.18 App Router + React 18 + TS strict + TanStack Query + Zustand + Tailwind + shadcn. Bram's automation locked at Trigger.dev free tier in separate `services/automation/`. Toolchain triple pinned to Solana 3.1.14 / Anchor 0.31.1 / Rust 1.95 per `LESSONS.md` evidence. Verification approach reset to compressed-time simulation + parameterized mocha — fast-check and proptest dropped from plan.)

---

> **Created:** 2026-05-21
> **Template:** brainlift v1 (from `claude-code-project-template` v0.3.0+)
> **Owner:** Cory Vandenberg (Tate)
> **Update cadence:** Same-session edit for Brain Lift items that change during work. End-of-week, sweep for resolved `[INFERRED — CONFIRM]` tags.
