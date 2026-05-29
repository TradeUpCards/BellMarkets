# BellMarkets

A non-custodial Solana dApp for trading binary outcome contracts on daily MAG7 stock prices. **One question per market** (e.g. *"Will NVDA close above $145 today?"*), **$1 USDC payouts** settled on-chain at 4:00 PM ET via the Pyth oracle.

> Gauntlet project codename: **Meridian**. Cohort 5 submission. See `.project/bell-markets/docs/prd/` for the original PRD.

🎥 **Demo video:** [youtu.be/keODMa5CSGI](https://youtu.be/keODMa5CSGI)
🌐 **Live demo:** [bell-markets.vercel.app](https://bell-markets.vercel.app)
📜 **Program:** [`599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV`](https://solscan.io/account/599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV?cluster=devnet) on Solana devnet (`deploy_index=9`)
💵 **bUSDC:** Self-controlled demo mint [`5vq2oahKFnnjStK1Ctqwdxdt44rtKuKHmPga9iZKtBZp`](https://solscan.io/account/5vq2oahKFnnjStK1Ctqwdxdt44rtKuKHmPga9iZKtBZp?cluster=devnet)
🧾 **Full lifecycle verified on-chain (2026-05-25):**
   - **Trade:** [Solscan tx `5rTS2SBo…1VCe`](https://solscan.io/tx/5rTS2SBoo1phuTaL4DhCQoBLNj4nJxSZBfbVvHC7Vzogw7sMh6h9hegTobNbBpKhKpbhFyZErygdUxCZceJr1VCe?cluster=devnet) — limit BID $0.55 × 50 YES crossed the resting $0.55 ask. Vault intact, escrow telescoped, asksLen 3→2, taker received 50 YES.
   - **Settle:** [Solscan tx `5BFRyVW1…fXepU`](https://solscan.io/tx/5BFRyVW1tZnxErs69VaCRHpzrEMTaJqGWmkMJcQYUi5asXjNh6DA2kKzu3PWKjyvMfqAeH5keMmVrSMFxwyfXepU?cluster=devnet) — `admin_settle(Yes)` after compressed-time setup. Outcome immutably written.
   - **Redeem:** [Solscan tx `XhAgMQTp…16tX3`](https://solscan.io/tx/XhAgMQTpGr6wyHAKFbyTf3uMKfwBeyZw86pZXRFbkxonDbo6QaeyFuVFy6nRhtvT36DTFLUeKVH2f5sp5X16tX3?cluster=devnet) — 100,000,000 atomic YES burned → 100,000,000 atomic bUSDC paid out. **$1 invariant preserved end-to-end.**

---

## For reviewers

Three HTML one-pagers at the repo root — open in any browser, printable, each self-contained:

- **[`WORKFLOW.html`](./WORKFLOW.html)** — repo bootstrap → submission timeline. Five days, eight deploys, twenty Decision Records, the DR-020 pivot story, and the directed multi-agent Claude Code workflow that built it.
- **[`SYSTEM-DESIGN.html`](./SYSTEM-DESIGN.html)** — architecture, decisions, trade-offs, risks, lessons learned, six technical challenges with how each was solved.
- **[`BRAINLIFT.html`](./BRAINLIFT.html)** — single-page constitution (Spiky POVs + Hard NOs + Hard YESes).

Plus [`docs/cost-analysis.md`](./docs/cost-analysis.md) — on-chain-verified per-market rent + scaling math (v1.1 rent-recovery is documented as a hard pre-mainnet precondition in `specs/deferred.md`).

---

## What it does

Each contract asks a simple question:
> *"Will [STOCK] close above [PRICE] today?"*

Two SPL tokens per contract — **YES** and **NO** — trade against bUSDC on an **in-program order book**. At 4:00 PM ET, the Anchor program reads Pyth's MAG7 equity feeds; winners redeem $1 bUSDC per winning token.

- **Invariant:** YES payout + NO payout = $1.00 bUSDC. Always. Per contract. Enforced on-chain.
- **Universe:** MAG7 (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA).
- **Lifecycle:** Same-day expiry (0DTE). Markets created ~8am ET, traded intraday on a CLOB, settled ~4:05pm ET, redeemable indefinitely.
- **Custody:** None. Wallet signs every state-changing action. No KYC.
- **Settlement:** Pyth Network on-chain oracle. Permissionless — anyone can crank `settle_market` after expiry if the cron dies.

---

## Architecture

```
┌─ apps/web (Next.js 14) ─────────────────────────────────────────┐
│  Landing · Markets · Trade · Portfolio · History · /admin       │
│  Wallet adapters (Phantom / Backpack / Solflare)                │
│  TanStack Query · subscription-driven (connection.onAccountChange) │
└───────────┬──────────────────────────────────────┬──────────────┘
            │                                      │
            ▼ writes (signed by user)              ▼ reads (public)
┌─ programs/bell-markets (Anchor 0.31.1) ─────────────────────────┐
│  28 instructions / 7 account types / 57 error variants          │
│                                                                  │
│  Trade primitives:  mint_pair · redeem · redeem_pair             │
│  In-program CLOB:   init_order_book · grow_order_book · place_order │
│                     cancel_order · match_orders                   │
│  Settlement:        settle_market (permissionless) · admin_settle │
│  Admin ops:         pause · update_fee_config · update_usdc_mint  │
│                     reinit_rewards_pools · force_redeem           │
│                                                                  │
│  Per-strike PDAs: yes_mint · no_mint · usdc_vault                │
│                   order_book (zero-copy, 128 orders/side)        │
│                   usdc_escrow · yes_escrow (CLOB collateral)     │
└───────────┬──────────────────────────────────────┬──────────────┘
            │                                      │
            ▼ reads at settle                      ▼ events
┌─ Pyth Network ─────────┐         ┌─ services/automation (Node/TS) ┐
│  MAG7 equity feeds     │         │  ~8am create-markets job        │
│  Confidence + staleness│         │  ~4:05pm settle nudger          │
│  Vendored parser       │         │  Helius webhook indexer         │
└────────────────────────┘         │  Sonnet 4.6 briefings (Anthropic)│
                                   │  PNL digests + leaderboards     │
                                   └─────────────────────────────────┘
```

### Workstreams

| Lead | Domain | Owned paths |
|---|---|---|
| **Aria** | Onchain (Solana / Anchor) — program, CLOB, mint/burn/settle/redeem | `programs/**`, `tests/contracts/**`, `migrations/**`, `Anchor.toml`, `Cargo.*` |
| **Bram** | Automation Service (Node/TS) — morning markets, settle nudger, indexer, briefings | `services/automation/**`, `tests/automation/**` |
| **Cleo** | Frontend (Next.js/React/TS) — Landing/Markets/Trade/Portfolio/History + /admin | `apps/web/**`, `packages/ui/**` |
| **Drew** | Quality + Integration + Demo — invariant tests, full-lifecycle smoke, demo script | `tests/integration/**`, `tests/eval/**`, `docs/demo/**` |

Coordinated by **Tate** (Director, `/tate`). Slash commands: `/aria`, `/bram`, `/cleo`, `/drew`.

---

## Major architectural decisions

Full decision log at `constitution/decisions.md`. The four that matter most for understanding the product:

| DR | Status | Decision | Why it matters |
|---|---|---|---|
| **DR-001** | **Superseded by DR-020** | Originally: integrate Phoenix v1 CLOB instead of building one | Phoenix devnet bootstrap proved impractical (chicken-and-egg between our YES mints and Phoenix `InitializeMarket`); pivoted to in-program CLOB ~22 hr before submission |
| **DR-002** | Active | `settle_market` is permissionless | If our automation dies, any wallet can crank settlement from the Pyth feed. Demo proves this from a third-party wallet. |
| **DR-017** | Active | Vault security: PDA self-authority, admin-as-cranker-not-redirector | No human keypair can drain a vault; admin can pause/crank but can't redirect funds. Mechanically enforced. |
| **DR-020** | Active (v1 lock) | Built minimal in-program CLOB per the PRD's "more ambitious" path | The PRD: *"Build a minimal order book as part of your smart contract — more ambitious, demonstrates deeper understanding."* Adopted Keith Mazanec's adversarially-reviewed reference design. |

---

## In-program CLOB highlights (DR-020)

We built the matcher ourselves rather than integrate Phoenix v1. Six new instructions, 702 lines of matching logic (`programs/bell-markets/src/matching.rs`), Keith Mazanec's parallel reference design adopted with his adversarial review baked in at initial implementation.

**Key invariants (enforced on-chain):**
- `vault_USDC == $1 × pairs_outstanding` — trading uses separate escrow accounts (`usdc_escrow`, `yes_escrow`), never the collateralization vault
- Telescoping escrow math — no dust, exact refund on cancel
- Three-phase matching (plan → settle → apply) — borrow-safe across CPIs
- 128 orders per side per market (bounded array; production path is the slab structure)
- H-1 fix: every maker payout account verified SPL-owned + correct owner + correct mint + not-frozen

**Reference design preserved in repo:**
- `docs/architecture/reference-clob-design.md` — Keith's full ARCHITECTURE.md
- `docs/architecture/reference-clob-spec.md` — Keith's F-03 feature spec
- `docs/architecture/reference-clob-decisions.md` — our adoption notes (what we adopt vs adapt vs defer)

---

## Quick start

> **Always use `pnpm`. Never `npm` or `yarn`.**

```bash
# Install deps (monorepo via pnpm workspaces)
pnpm install

# Anchor build (smart contract)
anchor build

# Frontend dev server (Next.js, port 3000)
pnpm --filter web dev

# Automation service in dev mode
pnpm --filter @bell-markets/automation dev
```

### Demo testing

Open `docs/demo/test-runbook.html` (or `http://localhost:3000/test-runbook.html` once dev server is running) for a step-by-step testing checklist covering all 4 trade paths, IOC defense verification, and the DR-019 UI disable matrix.

### Admin / operations

CLI scripts in `services/automation/scripts/`:

| Script | Purpose |
|---|---|
| `pnpm gen-test-wallets [N]` | Generate N test wallets to `keys/test-wallets.json` |
| `pnpm fund-test-wallets` | Fund all test wallets with bUSDC + SOL for tx fees |
| `pnpm export-phantom [N]` | Export first N wallet private keys for Phantom import |
| `pnpm mint-demo-usdc <wallet> <amt>` | Mint bUSDC to any wallet |
| `pnpm seed-demo-liquidity` | Bootstrap order books for the 3 demo strikes |
| `pnpm reinit-rewards-pools` | Migrate reward pools to current `config.usdc_mint` |

Web-based admin operations at `/admin` (wallet-gated by `MarketConfig.admin`):
- Pause / unpause toggle (emergency kill switch)
- Read-only MarketConfig + FeeConfig display
- Markets table with admin_settle button per row
- Update fee config form

---

## Deployment

- **Devnet:** deploy_index=9 LIVE at `599h7Vzn…` (9 cumulative deploys, 6.683 SOL spent — see `migrations/audit_log.jsonl`)
- **Vercel:** LIVE at [bell-markets.vercel.app](https://bell-markets.vercel.app) — Helius RPC kept server-side via `/api/solana-rpc` proxy (Hard NO #13). See `docs/deployment/vercel.md` for setup.
- **Pyth devnet posture:** Pyth v2 push feeds on devnet are ~660 days stale (audit finding in [`docs/pyth-feed-status.md`](./docs/pyth-feed-status.md)). On devnet, `settle_market` reverts `PythStale (6009)` for all tested feeds; operational settle path is `admin_settle` only. Hermes HTTP equity feeds DO publish MAG7 prices and are used by the off-chain briefings pipeline (network-agnostic). v1.5 fix: Pyth Pull migration.
- **Mainnet:** roadmapped — see `docs/architecture/pre-mainnet-readiness.md` for the audit + readiness gate. v1.1 rent-recovery (`force_cancel_order` + `close_order_book`) is a hard precondition; full design in `specs/deferred.md`.

---

## Hard rules

- No secrets, no private keys, no wallet mnemonics in any committed file
- Never use mainnet or real funds for v1 submission
- The $1.00 bUSDC invariant is **always** enforced on-chain
- `.project/` and `.claude/` are local-only — never committed
- `keys/` is gitignored — never commit test wallet keypairs or platform admin

Full list: `constitution/hard-rules.md`.

---

## Repository layout

```
.
├── README.md
├── LICENSE                          # Apache 2.0
├── BRAINLIFT.md                     # 4-section project constitution
├── CLAUDE_SESSION_HANDOFF.md        # Tate session continuity
├── vercel.json                      # Vercel monorepo build config
├── constitution/                    # Hard rules + 20 Decision Records
├── specs/                           # Architecture, project spec, coordination
├── programs/bell-markets/           # Anchor program (28 ix, 7 accts, 57 errors)
├── services/automation/             # Cron service, indexer, AI briefings
├── apps/web/                        # Next.js frontend + /admin console
├── packages/ui/                     # Shared React components
├── tests/contracts/                 # Anchor program tests (135/135 pass)
├── tests/automation/                # Vitest (361/361 pass)
├── tests/integration/               # Live devnet smoke tests
├── tests/eval/                      # Invariant property tests
├── docs/architecture/               # System diagrams + audit posture
├── docs/demo/                       # Demo script + testing runbook
├── docs/deployment/                 # Vercel + mainnet readiness
├── keys/                            # Gitignored — never committed
└── scripts/                         # One-command-demo + setup helpers
```

Project coordination state (handoffs, kickoffs, in-flight) lives under `.project/bell-markets/` — gitignored, OneDrive-mirrored.

---

## License

Apache 2.0. See `LICENSE`.

## Author

**Cory Vandenberg** — AI Engineer Fellow, GauntletAI Cohort 5 (Meridian).

Built solo using a directed multi-agent Claude Code workflow — four named lead workstreams (Aria · Bram · Cleo · Drew) running in parallel WSL terminal sessions under a single director (Tate). I designed the architecture, locked the 20+ Decision Records that drove the build, and reviewed/merged every commit; the agents executed under my dispatch. See [`WORKFLOW.html`](./WORKFLOW.html) for the full story.

[github.com/TradeUpCards](https://github.com/TradeUpCards) · coryvandenberg@gmail.com
