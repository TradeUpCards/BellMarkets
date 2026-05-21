# BellMarkets — Architecture

> System shape. Components, deployment, data flow, verification approach.
> When this file disagrees with code, fix one or the other — don't leave the gap.
>
> Companion to `BRAINLIFT.md` (the 1-page constitution). This file holds
> the heavyweight architectural detail (repo layout, type signatures,
> data model, deployment, dependencies) that doesn't fit in the brainlift.

---

## 1. Overview

BellMarkets is a **non-custodial Solana dApp + off-chain orchestration service + browser frontend** that lets users trade Yes/No binary outcome tokens against USDC for the question *"Will [STOCK] close above [PRICE] today?"* on the MAG7 universe. Settlement is driven by an on-chain Pyth price read at 4:05 PM ET. The on-chain CLOB is Phoenix (per DR-001). Daily lifecycle (morning create-markets job at ~8am ET, settlement nudger at ~4:05pm ET) is orchestrated by an off-chain TypeScript service, but `settle_market` is permissionless so the system functions even if the orchestration service is offline (per DR-002).

### System diagram

```mermaid
graph TB
    User[Demo user / Phantom wallet] --> Web[Frontend - Next.js app]
    Operator[Demo operator] --> Auto[Automation service - Node/TS]

    Web -->|onAccountChange| RPC[Helius RPC]
    Web -->|signed txs| RPC
    Web -.->|read price feeds| Pyth[Pyth Network]

    Auto -->|sign admin txs| RPC
    Auto -->|read previous-close HTTP| PythAPI[Pyth HTTP API]

    RPC --> Solana[Solana devnet]
    Solana --> Program[BellMarkets Anchor program]
    Solana --> Phoenix[Phoenix CLOB markets]
    Solana --> PythAccts[Pyth price accounts on-chain]

    Program -->|reads + validates| PythAccts
    Program -->|mints / settles / redeems| Vault[(USDC vault PDAs)]
    Program -->|creates + binds| Phoenix
```

Three runtime surfaces: frontend (Cleo), automation service (Bram), on-chain program (Aria). Drew owns the integration glue (test paths through all three) and the demo orchestration.

---

## 2. Components

### 2.1 Onchain — BellMarkets Anchor program

**Responsibility:** authoritative state + the load-bearing invariants. Holds USDC vaults, mints Yes/No SPL tokens, enforces the $1 invariant, validates Pyth for settlement, immutably writes outcomes, pays out on redeem. **Does NOT** match trades (Phoenix does that — DR-001), schedule the lifecycle (off-chain — DR-002), or enforce position-exclusivity (frontend — Hard YES #8).

**Tech:** Rust + Anchor framework. SPL Token program for Yes/No mints + USDC vault. Pyth Solana Receiver SDK for on-chain price reads. Phoenix SDK for market creation + binding.

**Instructions exposed:**
- `initialize_config` — admin sets up global config (supported tickers, Pyth feed map, admin authority, override delay)
- `create_strike_market` — admin creates one strike (per-stock, per-day). Initializes Yes/No mints, vault PDA, Phoenix market, ties to a Pyth feed.
- `add_strike` — admin adds an extra strike for a stock intraday
- `mint_pair` — anyone deposits $1 USDC → receives 1 Yes + 1 No
- `settle_market` — **permissionless** (per DR-002 / Hard NO #5). Validates `block_time ≥ settlement_window`, Pyth staleness, Pyth confidence. Writes outcome immutably.
- `admin_settle` — admin-only fallback. On-chain time-delay gate (≥1hr after settlement window — Hard YES #7).
- `redeem` — anyone burns winning tokens → receives $1 USDC from vault. Burns losing tokens → receives $0.
- `pause` / `unpause` — admin emergency stop on minting + new trades.

**Talks to:** Solana runtime (token program, system program), Pyth price accounts (on-chain account read), Phoenix CLOB program (CPI for market creation).

**Owned by:** Aria. See `constitution/file-ownership.md`.

### 2.2 Off-chain — Automation Service (Bram)

**Responsibility:** orchestrate the daily lifecycle without becoming an authority. Two scheduled jobs:

- **Morning job (~8am ET):** for each MAG7 stock, read previous close from Pyth HTTP API, compute strikes (±3%/6%/9% from previous close, rounded to $10, deduplicate), call `create_strike_market` per unique strike. Logs results, alerts on failure, retries with backoff.
- **Settlement nudger (~4:05pm ET):** for each open contract, call `settle_market` (best-effort convenience caller — not authority). If Pyth confidence is too wide, retries every 30s for up to 15min. If still failing, alerts the admin for manual `admin_settle` override.

**Crucially:** the settlement nudger has no special signing authority over `settle_market` (per DR-002). It's a convenience caller. If it dies, any user can call `settle_market` themselves; the system still works.

**Tech:** Node.js + TypeScript. Solana web3.js + Anchor client via Helius RPC. **Trigger.dev (free tier)** as the cron platform — handles the morning + settlement-nudger schedules natively. No long-running process required; jobs run on Trigger.dev's infra. Stateless (no persistent DB per `constitution/hard-rules.md` §3.3). pnpm workspaces.

**Talks to:** Pyth HTTP API (off-chain price reads), Helius RPC (transaction signing + submission), the BellMarkets program (via Anchor client).

**Owned by:** Bram. See `constitution/file-ownership.md`.

### 2.3 Frontend — Next.js trading app (Cleo)

**Responsibility:** present the market, accept trade intent, sign transactions via the connected wallet, render real-time book + portfolio state, enforce position-exclusivity at the UX layer.

**Pages:**
- `/` — Landing: product explanation, live prices, connect-wallet CTA
- `/markets` — grid of 7 MAG7 stocks with live prices and active contract counts
- `/trade/[ticker]/[strike]` — strike-specific view: order book (Yes + No perspectives of the one Phoenix book), Buy Yes / Buy No / Sell Yes / Sell No panel with position-aware constraints, settlement countdown
- `/portfolio` — active positions, settled outcomes, P&L, redeem buttons
- `/history` — trade execution log

**Tech:**
- Next.js 15 (App Router)
- **React 18** + TypeScript (strict mode) — React 18 for peer-dep compat with `@solana/wallet-adapter-react`; none of React 19's new features (Server Actions, `use()`, form actions) are load-bearing for this app
- `@solana/wallet-adapter-react` for wallet integration (Phantom, Backpack, Solflare). Per Hard YES #10: no in-app keystore, no env-var private keys.
- `connection.onAccountChange` (Helius WebSocket) for real-time book + portfolio updates. **No polling** (Hard YES #9 / `hard-rules.md` §4.8).
- TanStack Query for RPC caching, dedup, and the WebSocket → cache bridge (`queryClient.setQueryData` from inside the subscription handler)
- Zustand for ephemeral UI state (open modals, selected strike, panel filters)
- Tailwind CSS + shadcn/ui components (Radix-based, copy-paste)

**Buy No / Sell No atomicity (POV-3):** Each user click → ONE wallet-signed transaction that bundles all required instructions. Buy No = `[mint_pair, place_sell_yes_on_phoenix]` in one tx. Sell No = `[buy_yes_on_phoenix, redeem_pair_for_usdc]` (or similar). The user never sees a "mint pair" button, never sees intermediate Yes balances. Per `hard-rules.md` §4.7.

**Talks to:** Helius RPC (read + WebSocket), user's wallet (signing), the BellMarkets program (via Anchor client), Phoenix SDK (place orders directly).

**Owned by:** Cleo. See `constitution/file-ownership.md`.

### 2.4 Quality + Demo — Integration & eval harness (Drew)

**Responsibility:** prove the system works end-to-end. Property-based tests for the $1 USDC invariant. Integration tests that exercise the full lifecycle on devnet. The "one-command demo" script. The cron-failure-path demo step (Hard YES #5).

**Tech:** Anchor test framework, `proptest` (Rust) for property-based invariants. Vitest + `fast-check` (TypeScript) for service + integration property tests. Mocked Pyth feeds for deterministic CI (Hard NO #12).

**Owned by:** Drew. See `constitution/file-ownership.md`.

---

## 3. Data model — on-chain accounts (the only persistent state)

There is no off-chain database (per `hard-rules.md` §3.3). On-chain state is the source of truth.

### Core account schemas

```rust
// programs/bell-markets/src/state/

#[account]
pub struct MarketConfig {
    pub admin: Pubkey,              // admin authority
    pub paused: bool,               // pause/unpause toggle
    pub supported_tickers: Vec<Ticker>,
    pub pyth_feed_map: Vec<(Ticker, Pubkey)>,  // ticker → Pyth price account
    pub staleness_threshold_sec: u64,   // default 300 (5 min)
    pub confidence_threshold_bps: u64,  // default 50 (0.5%)
    pub admin_override_delay_sec: u64,  // default 3600 (1 hour)
}

#[account]
pub struct StrikeMarket {
    pub ticker: Ticker,             // "AAPL", "MSFT", ...
    pub strike: u64,                // USDC, 6-decimal units (e.g., $680 = 680_000_000)
    pub settlement_window: i64,     // unix timestamp; settleable when block_time >= this
    pub yes_mint: Pubkey,           // SPL Yes-token mint
    pub no_mint: Pubkey,            // SPL No-token mint
    pub vault: Pubkey,              // program-owned USDC vault PDA
    pub phoenix_market: Pubkey,     // Phoenix CLOB market for Yes/USDC
    pub pyth_feed: Pubkey,          // Pyth price account for this ticker
    pub outcome: Option<Outcome>,   // None until settled; Some(...) is immutable
    pub pairs_outstanding: u64,     // count of un-redeemed mint pairs
    pub created_at: i64,
    pub settled_at: Option<i64>,
}

pub enum Outcome {
    YesWins,    // close >= strike  →  Yes pays $1, No pays $0
    NoWins,     // close <  strike  →  Yes pays $0, No pays $1
}

pub type Ticker = [u8; 8];   // null-padded ticker string, max 8 chars
```

### Invariants — enforced on-chain, verified by Drew's property tests

| Invariant | Where enforced | Drew's test coverage |
|---|---|---|
| `vault.amount == 1_000_000 * pairs_outstanding` (vault has $1 per open pair) | `mint_pair`, `redeem` | Property test sweeps (mint count × redeem count × settle outcome) |
| `yes_payout + no_payout == 1_000_000` for all outcomes (the $1 invariant) | `settle_market`, `admin_settle` | Property test sweeps (close_price × strike × outcome) |
| Outcome is `Some(...)` and never changes once written | `settle_market`, `admin_settle` | Negative test: attempt second settle, assert it fails |
| Tokens can only be created via `mint_pair` and destroyed via `redeem` | SPL Token program authority (program-owned mints) | Negative test: unauthorized mint/burn, assert it fails |

### PDAs (seeds)

```
StrikeMarket   : ["strike_market", ticker, strike_le_bytes, day_le_bytes]
Vault          : ["vault", strike_market.key()]
YesMint        : ["yes_mint", strike_market.key()]
NoMint         : ["no_mint", strike_market.key()]
```

**Schema changes after first devnet deploy require a fresh deploy** — see `BRAINLIFT.md` §4 "flag for review."

---

## 4. Off-chain types (TypeScript)

### Frontend view models

```ts
// apps/web/lib/types.ts

export type StrikeMarketView = {
  marketId: PublicKey;
  ticker: string;
  strike: number;              // USDC, human-readable
  yesBidPrice?: number;        // from Phoenix order book
  yesAskPrice?: number;
  noBidPrice?: number;         // = 1 - yesAskPrice (implied)
  noAskPrice?: number;         // = 1 - yesBidPrice (implied)
  impliedYesProbability?: number;  // midpoint of yes bid/ask
  settlementWindow: Date;
  outcome?: "YesWins" | "NoWins";
  isSettled: boolean;
};

export type UserPosition = {
  marketId: PublicKey;
  yesBalance: number;
  noBalance: number;
  // Constraint: only one of {yesBalance, noBalance} is non-zero from trading
  // (a transient both-nonzero state during mint-pair is OK; persistent both is a frontend bug)
};

export type TradeIntent =
  | { kind: "BuyYes"; marketId: PublicKey; usdcAmount: number; orderType: "market" | { limit: number } }
  | { kind: "BuyNo"; marketId: PublicKey; usdcAmount: number; orderType: "market" | { limit: number } }
  | { kind: "SellYes"; marketId: PublicKey; yesAmount: number; orderType: "market" | { limit: number } }
  | { kind: "SellNo"; marketId: PublicKey; noAmount: number; orderType: "market" | { limit: number } };

// Each TradeIntent translates to ONE atomic Solana transaction (POV-3).
```

### Automation service types

```ts
// services/automation/src/types.ts

export type StrikeSet = {
  ticker: string;
  previousClose: number;        // USDC equivalent
  strikes: number[];            // unique strikes after dedup, rounded to nearest $10
};

export async function computeStrikesForDay(date: Date): Promise<StrikeSet[]>;
export async function createMarketsForDay(strikeSets: StrikeSet[]): Promise<PublicKey[]>;
export async function settleMarketsForDay(markets: PublicKey[]): Promise<SettlementReport>;
// settleMarketsForDay is best-effort. If automation dies, anyone can crank settle themselves (DR-002).
```

---

## 5. Repo layout (target)

```
.
├── README.md
├── LICENSE                       # Apache 2.0
├── BRAINLIFT.md                  # 1-page constitution
├── CLAUDE_SESSION_HANDOFF.md     # Tate session continuity
├── constitution/                 # hard-rules.md, decisions.md, file-ownership.md, README.md
├── specs/                        # architecture.md (this file), bell-markets-spec.md, coordination.md, deferred.md, README.md
├── programs/                     # (Aria) Anchor program
│   └── bell-markets/
│       └── src/
│           ├── lib.rs            # program entry + instruction dispatch
│           ├── instructions/     # create_strike_market, mint_pair, settle_market, admin_settle, redeem, pause, add_strike
│           ├── state/            # MarketConfig, StrikeMarket, Vault account schemas
│           ├── oracle/           # Pyth read + validate (staleness, confidence)
│           └── errors.rs
├── services/
│   ├── automation/               # (Bram) morning + settlement-nudger
│   └── oracle-adapter/           # (Bram) Pyth HTTP API client
├── apps/web/                     # (Cleo) Next.js frontend
│   ├── app/                      # App Router: /, /markets, /trade/[ticker]/[strike], /portfolio, /history
│   ├── components/               # OrderBook, TradePanel, Portfolio, RedeemButton, etc.
│   └── lib/                      # solana/ (wallet, anchor client, phoenix client), pyth/ (client-side feed read)
├── packages/ui/                  # shared shadcn components
├── tests/
│   ├── contracts/                # (Aria) Anchor unit tests + property tests for on-chain invariants
│   ├── automation/               # (Bram) service unit tests
│   ├── frontend/                 # (Cleo) component unit tests
│   ├── integration/              # (Drew) full lifecycle on devnet
│   └── eval/                     # (Drew) $1-invariant proof set, oracle-failure scenarios, meta-tests
├── docs/
│   ├── SETUP.md
│   └── demo/                     # (Drew) demo script, recording assets, cron-failure path doc
├── scripts/
│   ├── setup-worktrees.sh        # Mode 2 lead worktree generator
│   ├── setup-onedrive-mirror.sh  # .project/ + .claude/ → OneDrive junctions
│   ├── lead-launchers.*          # start_<lead> / finish_<lead> helpers
│   ├── devnet-deploy.sh          # (Aria + Drew shared) Anchor deploy to devnet
│   └── one-command-demo.sh       # (Drew) PRD's reproducible lifecycle path
└── .gitignore                    # excludes /.project/, /.claude/, *.pdf, *.docx
```

---

## 6. Deployment

### Environments

| Env | Purpose | Cluster | Where the frontend runs | Automation runs |
|---|---|---|---|---|
| Local dev | Per-lead work | Solana localnet OR devnet | `pnpm --filter web dev` on `localhost:3000` | `pnpm --filter automation dev` locally |
| Devnet demo | **Submission target** | Solana devnet | Vercel preview deploy | Trigger.dev (free tier) |
| Mainnet-beta (stretch) | Post-demo only | Solana mainnet-beta | Vercel production | Trigger.dev (paid tier if cron volume grows) |

### Build + deploy pipeline

1. **Code → PR**: pnpm workspaces build (`pnpm install`, `pnpm build`)
2. **CI gate** (per `hard-rules.md` §5.3): `anchor test` + `pnpm test` + `pnpm typecheck` + `pnpm lint` — all must pass
3. **Merge to `main`**: dual-push to GitLab (cohort visibility) and GitHub (portfolio backup)
4. **Devnet deploy** (manual, Aria + Drew): `bash scripts/devnet-deploy.sh` — uploads program, runs morning job, opens markets for the day
5. **Demo run**: `bash scripts/one-command-demo.sh` — exercises create → mint → trade → settle → redeem end-to-end. Includes the cron-failure path step (Hard YES #5).

### Secrets

- **Devnet:** `.env.example` defines the shape. Each lead populates `.env` locally from their own keypair (devnet, freely airdroppable). No secrets in commits per `hard-rules.md` §1.2.
- **Mainnet-beta (stretch):** funded wallet keypair would live in a secrets manager (Railway / Fly.io secrets, or hardware wallet for admin keys). Out of scope for the core submission.

---

## 7. Verification approach

### Unit tests

- **Anchor program** (Aria, in `tests/contracts/`): instruction-level tests — `mint_pair` happy path, `mint_pair` negative cases (paused, insufficient USDC), `settle_market` happy path, `settle_market` rejects (stale Pyth, low confidence, before window, after window with valid Pyth), `redeem` (winner + loser), `admin_settle` time-delay enforcement.
- **Automation service** (Bram, in `tests/automation/`): strike calc unit tests, morning-job retry behavior, settlement-nudger retry behavior.
- **Frontend** (Cleo, in `tests/frontend/`): component rendering, position-exclusivity button states, atomic-tx assembly for Buy No / Sell No.

### Integration tests (Drew, `tests/integration/`)

- **Full lifecycle on devnet:** create → mint → trade → settle → redeem, with assertions at every step.
- **All 4 trade paths:** Buy Yes, Buy No, Sell Yes, Sell No each tested end-to-end (atomicity verified per POV-3).
- **Multi-user scenario:** market maker mints + quotes, second user takes, both redeem.
- **Cron-failure path** (Hard YES #5): kill automation mid-settle, trigger `settle_market` from a test user wallet, assert success.

### Eval suite (Drew, `tests/eval/`)

- **Property-based $1 invariant proof set** (Hard YES #1): `proptest` sweeps over (close_price × strike × outcome × pairs_outstanding) and asserts `vault_balance == $1 × open_pairs` AND `yes_payout + no_payout == $1.00`.
- **Oracle-failure scenarios**: stale Pyth, wide confidence, missing feed — all must be rejected by `settle_market`.
- **Meta-tests**: deliberately broken fixtures that should fail their rubric. Proves the test catches the bug it claims to.

### CI gate

`anchor test` + `pnpm test` + `pnpm typecheck` + `pnpm lint`. All must pass to merge. Cross-references `hard-rules.md` §5.3 and BRAINLIFT.md Hard YES #4.

### Manual smoke check

Before the final demo, Tate runs the full demo dry-run including the cron-failure path. If anything is shaky, the submission gets pushed back; we don't demo a flaky lifecycle.

---

## 8. External dependencies

| Service | Used for | Failure mode if down | Mitigation |
|---|---|---|---|
| **Solana devnet** | Compute + state | Total outage → demo not runnable | Devnet is the submission target; mainnet-beta is the documented stretch alternative |
| **Phoenix CLOB** | On-chain order book | Phoenix program outage → no trading possible | **No fallback CLOB** by design (`hard-rules.md` §4.1). Acceptable for a devnet demo — flagged in `specs/deferred.md` as a known operational risk for the mainnet stretch. |
| **Pyth Network** | Stock prices (HTTP for morning strikes, on-chain accounts for settlement) | Pyth outage at settlement → markets can't settle until Pyth recovers | Admin override path (`admin_settle`, time-delayed per Hard YES #7). **No fallback oracle** (`hard-rules.md` §4.3). |
| **Helius RPC** | Solana RPC + WebSocket for frontend + automation | Helius outage → frontend can't fetch state; automation can't submit txs | Fallback: any public Solana RPC endpoint (configurable via `NEXT_PUBLIC_RPC_URL` env var). Documented in `docs/SETUP.md` (when created). |
| **Trigger.dev** | Cron platform — runs the morning create-markets job (~8am ET) and the settlement nudger (~4:05pm ET) | Trigger.dev outage → automation doesn't fire; markets either don't get created (morning) or don't settle automatically (afternoon) | For the afternoon path: permissionless settle (DR-002) means any user can crank `settle_market` themselves — automation is convenience, not authority. For the morning path: operator (Tate) runs the create-markets script manually as recovery. Trigger.dev's free-tier SLA is best-effort; this is acceptable for a devnet demo. |
| **GitHub + GitLab** | Code hosting + dual-push | One down → push to the other still works; both down → local work only | Dual-push by design (`scripts/setup-worktrees.sh` and `git remote -v`). |

---

## 9. Things this architecture deliberately does NOT do

- **No custom on-chain matching engine** — Phoenix is the CLOB. See `specs/deferred.md` "build own CLOB" and DR-001.
- **No fallback oracle** — Pyth or admin override. See `specs/deferred.md` "fallback oracle" and DR-003.
- **No persistent off-chain database** — Solana RPC is the source of truth. See `specs/deferred.md` "off-chain caching DB" and `hard-rules.md` §3.3.
- **No multi-tenant teacher/admin dashboard** — non-custodial means every user IS a wallet. There's no admin role beyond pause / unpause / admin_settle. See `specs/deferred.md`.
- **No KYC, no fiat off-ramp, no custody** — PRD hard rule. See `hard-rules.md` §3.1.
- **No mobile app, no i18n, no offline mode** — out of scope per BRAINLIFT.md §1.
- **No non-MAG7 stocks, no perpetuals, no margin** — v1 scope. See `hard-rules.md` §3.2.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
>
> **Update protocol:** edit via MR. Update the mermaid diagram whenever
> a component boundary moves. Stale diagrams are worse than no diagram.
> Sync BRAINLIFT.md §3 in the same PR if the change affects the 1-pager.
