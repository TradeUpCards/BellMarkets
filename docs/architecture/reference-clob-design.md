# Meridian — System Architecture

> Binary stock-outcome markets on Solana. A non-custodial dApp where users trade
> Yes/No tokens on whether a MAG7 stock will close at or above a strike price today.
> Each contract pays $1.00 USDC to the winning side. `Yes + No = $1.00`, always.

This document records **what we are building, how it fits together, and — most
importantly — *why* each major decision was made**, including the alternatives we
rejected and the trade-offs we accepted. Companion document: [`RESEARCH.md`](./RESEARCH.md)
explains the underlying technologies for a crypto novice.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Glossary (quick reference)](#2-glossary-quick-reference)
3. [Component Architecture](#3-component-architecture)
4. [On-Chain Account & Data Model](#4-on-chain-account--data-model)
5. [Smart Contract Instructions](#5-smart-contract-instructions)
6. [The Order Book — One Book, Two Perspectives](#6-the-order-book--one-book-two-perspectives)
7. [Invariants (enforced on-chain)](#7-invariants-enforced-on-chain)
8. [Sequence Flows](#8-sequence-flows)
9. [Daily Lifecycle](#9-daily-lifecycle)
10. [Decision Records (ADRs)](#10-decision-records-adrs)
11. [Risks & Limitations](#11-risks--limitations)
12. [Testing Strategy](#12-testing-strategy)
13. [Deployment](#13-deployment)
14. [Open Questions](#14-open-questions)

---

## 1. System Overview

Meridian is a same-day (0DTE) binary options market. The product question is always:

> **"Will [STOCK] close at or above [STRIKE] today?"**

A user who thinks *yes* holds **Yes tokens**; a user who thinks *no* holds **No
tokens**. At 4:00 PM ET the market settles against an on-chain price oracle:

- Closing price **≥ strike** → each **Yes** token redeems for **$1.00 USDC**, **No** = $0.
- Closing price **< strike** → each **No** token redeems for **$1.00 USDC**, **Yes** = $0.

The system has four moving parts:

| Part | Tech | Role |
|---|---|---|
| **On-chain program** | Rust + Anchor (Solana) | Mints, vault, order book, settlement, redemption — the source of truth |
| **Automation service** | TypeScript / Node.js | Triggers market creation (AM) and settlement (PM) on a schedule |
| **Frontend** | TypeScript + React (Next.js) | Wallet connection, trading UI, portfolio, the "four buttons, one book" UX |
| **Price oracle** | Pyth (+ admin-override fallback) | Brings real stock prices on-chain for settlement |

**Design north star:** *non-custodial by construction*. No human or service ever
holds user funds. USDC collateral lives in a Program Derived Address (PDA) vault
that can only release funds according to on-chain rules. Correctness is enforced
by code and math, not by trust in an operator.

---

## 2. Glossary (quick reference)

| Term | Meaning |
|---|---|
| **0DTE** | Zero days to expiration — the contract is created and settles the same day |
| **USDC** | A stablecoin (digital dollar). 1 USDC ≈ $1. The settlement currency |
| **SPL token** | Solana's token standard (the equivalent of ERC-20 on Ethereum) |
| **Mint (account)** | The on-chain definition of a token (supply, decimals, authority) |
| **PDA** | Program Derived Address — an address only the program can sign for; no private key. Makes custody trustless |
| **CLOB** | Central Limit Order Book — bids/asks matched by price-time priority |
| **Maker / Taker** | Maker posts a resting order; taker crosses the spread to fill it |
| **Oracle** | A service that publishes off-chain data (stock prices) on-chain |
| **Confidence band** | Pyth publishes price ± a confidence interval; a wide band = low certainty |
| **Strike** | The price level that decides the Yes/No outcome |
| **Vault** | PDA-owned token account holding the USDC collateral for a market |
| **Crank / settle** | The transaction that reads the oracle and writes the final outcome |

---

## 3. Component Architecture

```
                          ┌──────────────────────────────────────────┐
                          │              FRONTEND (Next.js)            │
                          │  Landing · Markets · Trade · Portfolio ·   │
                          │  History.  Wallet adapter. Four-button UX. │
                          └───────────────┬───────────────┬───────────┘
                                          │ read prices    │ sign & send txns
                                          │ (off-chain API)│ (wallet)
                                          ▼                ▼
   ┌───────────────────────┐    ┌──────────────────────────────────────────────┐
   │  AUTOMATION SERVICE    │    │              SOLANA PROGRAM (Anchor)           │
   │  (Node.js, scheduled)  │    │                                                │
   │                        │    │  Config ── Markets ── { Yes mint, No mint,     │
   │  AM job: create strikes │───▶│            Vault PDA, OrderBook }              │
   │  PM job: settle markets │───▶│                                                │
   │  retry + alert         │    │  Instructions: init · create_market · add_strike│
   │                        │    │  mint_pair · place_order · cancel · match ·    │
   └──────────┬─────────────┘    │  settle · admin_settle · redeem · pause        │
              │ reads             └──────────────────┬─────────────────────────────┘
              │ prev close                           │ reads price at settlement
              ▼                                       ▼
   ┌───────────────────────┐            ┌───────────────────────────────┐
   │  PRICE SOURCE (AM)     │            │  PRICE ORACLE ON-CHAIN (PM)    │
   │  off-chain price API   │            │  Pyth price update account     │
   │  or oracle read        │            │  (or admin-supplied fallback)  │
   └───────────────────────┘            └───────────────────────────────┘
```

**Trust boundaries:**

- The **program** is the only thing that can move funds. Everything else merely
  *requests* actions; the program validates and either executes or rejects.
- The **automation service** holds a keypair that can call *permissioned* admin
  instructions (create/settle). It **cannot** violate invariants or drain the
  vault — the PDA design forbids it. It is a liveness convenience, not a trust root.
- The **frontend** holds nothing. The user's wallet signs every state-changing
  action.

---

## 4. On-Chain Account & Data Model

Solana programs are stateless; all state lives in **accounts** the program owns.
(If you're new to this, see RESEARCH.md "Solana accounts model".)

### 4.1 `Config` (singleton, one per deployment)

| Field | Type | Notes |
|---|---|---|
| `admin` | `Pubkey` | Authority for create/settle/pause/override |
| `usdc_mint` | `Pubkey` | The USDC mint used for collateral |
| `supported_tickers` | `[Ticker; 7]` | AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA + oracle feed id per ticker |
| `paused` | `bool` | Emergency switch for minting/trading |
| `fee_account` | `Option<Pubkey>` | If fees are ever charged, they go *here*, never the vault (keeps invariant exact) |

### 4.2 `Market` (one per stock-strike-day)

| Field | Type | Notes |
|---|---|---|
| `ticker` | `Ticker` | e.g. META |
| `strike` | `u64` | Strike price, fixed-point (e.g. cents) |
| `trading_day` | `i64` | The session date this market settles for |
| `yes_mint` | `Pubkey` | SPL mint for Yes tokens |
| `no_mint` | `Pubkey` | SPL mint for No tokens |
| `vault` | `Pubkey` | PDA-owned USDC token account |
| `vault_bump` / `mint_authority_bump` | `u8` | PDA bumps |
| `pairs_minted` | `u64` | Count of Yes/No pairs ever minted, monotonic (drives the vault invariant) |
| `winning_redeemed` | `u64` | USDC base units paid out via `redeem` (added in F-02; gives the invariant on-chain form: `vault == PAYOFF_UNIT × pairs_minted − winning_redeemed`) |
| `order_book` | `Pubkey` | The `OrderBook` account for this market (wired by F-03) |
| `state` | `enum` | `Open` → `Settled` |
| `outcome` | `enum` | `Unsettled` / `YesWins` / `NoWins` |
| `settlement_price` | `Option<u64>` | The closing price written at settlement (immutable) |
| `settled_at` | `Option<i64>` | Timestamp of settlement |

> **Why mints + vault are PDAs:** the program is the mint authority and the vault
> owner. No private key exists for them, so funds and token issuance are controlled
> *only* by program logic. This is the mechanical basis of "non-custodial."

### 4.3 `OrderBook` (one per market) — bounded on-chain book

| Field | Type | Notes |
|---|---|---|
| `market` | `Pubkey` | Back-reference |
| `bids` | `[Order; N]` | Buy-Yes orders, kept sorted by price-time priority |
| `asks` | `[Order; N]` | Sell-Yes orders, kept sorted by price-time priority |
| `next_seq` | `u64` | Monotonic sequence number for time priority |

`Order`: `{ owner: Pubkey, price: u64 (in USDC per Yes, 0–1.00), size: u64, seq: u64, side: enum }`

> **Why a bounded array (not a Serum-style slab):** keeps matching trustless and
> fully on-chain while avoiding the slab/heap data-structure complexity that makes
> production CLOBs hard. The cap `N` is a documented demo limitation (see ADR-002b).

### 4.4 Token accounts (per user, standard SPL)

Each user holds Associated Token Accounts (ATAs) for: USDC, each Yes mint, each
No mint they interact with. Created on demand.

---

## 5. Smart Contract Instructions

| Instruction | Caller | Purpose |
|---|---|---|
| `initialize_config` | deployer | One-time global setup: admin, USDC mint, tickers, oracle feed ids |
| `create_strike_market` | admin/automation | Create one stock-strike-day: Yes/No mints, vault PDA, order book. **Not batched** (one call per strike) |
| `add_strike` | admin | Add an extra strike intraday |
| `mint_pair` | any user | Deposit $1.00 USDC → receive 1 Yes + 1 No. Increments `pairs_minted` |
| `place_order` | any user | Post a limit/market order for Yes vs USDC |
| `cancel_order` | order owner | Remove a resting order |
| `match_orders` | any user / automation | Execute crossing bids/asks (price-time priority), settle token+USDC transfers |
| `settle_market` | admin/automation | After 4:00 PM ET: read oracle, validate staleness+confidence, write immutable outcome |
| `admin_settle` | admin only | Fallback when oracle fails. Enforces a time delay (e.g. ≥1h after close) before callable |
| `redeem` | any token holder | Burn winning tokens → receive $1.00 each from vault. Losing tokens → $0 |
| `pause` / `unpause` | admin | Emergency stop on minting/trading |

> **Matching as its own instruction (`match_orders`):** keeps `place_order` cheap
> and bounds compute per transaction. Either a counterparty taker or the automation
> service can crank matching. Matching is still **on-chain and trustless** — the
> cranker only triggers it; it cannot change prices or sizes.

---

## 6. The Order Book — One Book, Two Perspectives

The single most important UX/architecture concept. Each strike has **exactly one
order book**: **Yes token traded against USDC.** Because `Yes + No = $1.00`,
selling a Yes is economically identical to buying a No. So one book serves all
four user actions:

| User action | What actually happens on the book |
|---|---|
| **Buy Yes** | Buy Yes from the ask side |
| **Sell Yes** | Sell Yes on the ask side (post) / hit a bid |
| **Buy No** | Mint a pair ($1 USDC), **sell the Yes** on the bid side, keep the No. Effective No cost = $1.00 − Yes sale price |
| **Sell No** | **Buy a Yes** from the ask side → now hold Yes+No = redeemable $1.00, closing the No exposure |

**Key insight:** *Buy Yes & Sell No* are the same side (buying Yes). *Buy No & Sell
Yes* are the same side (selling Yes). One book, four actions, two perspectives.

The price of Yes (0.00–1.00) is the **market-implied probability** the stock closes
at/above the strike. If Yes trades at $0.65, No is implicitly $0.35.

---

## 7. Invariants (enforced on-chain)

These are the correctness guarantees. Tests must prove them for **all** prices.

1. **Collateralization:** `vault_USDC_balance == $1.00 × pairs_minted`. Exact.
   Any fee goes to a separate `fee_account`, never the vault.
2. **Payout completeness:** `Yes_payout + No_payout == $1.00` at settlement, always.
3. **Token provenance:** tokens are created *only* by `mint_pair` and destroyed
   *only* by `redeem`. (Program holds mint+freeze authority via PDA.)
4. **Settlement immutability:** once `outcome`/`settlement_price` are written, they
   cannot change.
5. **Settlement timing:** `settle_market` rejects before 4:00 PM ET; `admin_settle`
   rejects before its enforced delay.
6. **Oracle quality:** `settle_market` rejects stale prices and prices whose
   confidence band exceeds the configured threshold.

---

## 8. Sequence Flows

### 8.1 Mint pair

```
User wallet            Program                         SPL Token / Vault
   │  mint_pair(market) ──▶│                                  │
   │                       │ transfer $1.00 USDC user→vault ─▶│
   │                       │ mint 1 Yes → user ATA ──────────▶│
   │                       │ mint 1 No  → user ATA ──────────▶│
   │                       │ pairs_minted += 1                │
   │ ◀── 1 Yes + 1 No ─────│                                  │
```

### 8.2 Buy No (the abstracted mechanic)

```
Frontend translates "Buy No" into one atomic transaction:
  1. mint_pair                → user gets Yes + No, vault gets $1.00
  2. place_order(sell Yes)    → Yes posted/sold on the bid side
  → user is left holding No; effective cost = $1.00 − Yes sale proceeds
(one wallet approval)
```

### 8.3 Settlement & redemption

```
Automation (4:05 PM ET)     Program                    Oracle / Vault
   │ settle_market(market) ──▶│                              │
   │                          │ read price ────────────────▶│
   │                          │ check staleness+confidence   │
   │                          │ outcome = price ≥ strike ?   │
   │                          │   YesWins : NoWins           │
   │                          │ write outcome (immutable)    │
   │ ◀──── settled ───────────│                              │
                                  ... later ...
User wallet                  Program                    Vault
   │ redeem(winning tokens) ─▶│ burn tokens                  │
   │                          │ transfer $1.00 × tokens ────▶│ → user
   │ ◀──── USDC ──────────────│                              │
```

---

## 9. Daily Lifecycle

| Time (ET) | Actor | Action |
|---|---|---|
| 8:00 AM | Automation | Read previous close per stock; compute strikes (±3/6/9%, round to $10, dedupe) |
| 8:30 AM | Automation | `create_strike_market` per strike (Yes/No mints, vault, order book) |
| 9:00 AM | Frontend | Markets visible; minting enabled |
| 9:30 AM | Market | US open; live trading |
| 4:00 PM | Market | US close |
| ~4:05 PM | Automation | `settle_market` per open contract (read oracle, write outcome). Retry on wide confidence every 30s up to 15 min; else alert admin for `admin_settle` |
| 4:05 PM+ | Users | Redemption enabled; winners claim USDC |
| Ongoing | Users | Unredeemed winning tokens remain redeemable indefinitely |

**Strike algorithm (example, META prev close $680):** strikes at −9/−6/−3/+3/+6/+9%
rounded to nearest $10 → $620, $640, $660, $700, $720, $740, plus optionally the
rounded close ($680). Deduplicate (low-priced stocks like AAPL collapse to fewer
unique strikes).

---

## 10. Decision Records (ADRs)

Each record: **Context → Options → Decision → Why → Trade-offs/Risks.** These are
written to be *defended*.

### ADR-001 — Blockchain: Solana + Anchor (deploy to devnet)

- **Context:** Meridian's core is a real-time on-chain order book, which demands
  low-latency, irreversible transactions ("finality") and cheap fees.
- **Options:** (A) Solana + Rust/Anchor; (B) EVM L2 (Arbitrum/Base) + Solidity;
  (C) HyperLiquid.
- **Decision:** **Solana + Anchor.**
- **Why:** Sub-second finality (~400ms slots) and sub-cent fees make a live order
  book feel responsive; Solana has mature CLOB infrastructure (Phoenix, OpenBook)
  and native price oracles (Pyth) with confidence intervals; the brief explicitly
  prefers Solana and *requires* devnet deployment, so it is also the lowest-risk
  path to passing. Anchor removes Rust/Solana boilerplate (account validation, IDL
  generation), reducing surface area for security bugs.
- **Trade-offs / risks:** Rust + Solana's accounts model has a steeper learning
  curve than Solidity for newcomers; the ecosystem moves fast. Mitigated by Anchor
  and by RESEARCH.md.
- **Rejected because:** EVM L2s impose latency/gas penalties on order books (most
  EVM DEXs use AMMs, not CLOBs, for this reason); HyperLiquid has a fast native
  order book but is purpose-built for its own perps and does not host custom
  binary-outcome instruments today.

### ADR-002 — Order book: build a minimal on-chain CLOB (vs. integrate)

- **Context:** Each strike needs one order book (Yes vs USDC). We can build one or
  integrate an existing on-chain CLOB.
- **Options:** (A) Build minimal CLOB in our program; (B) Integrate Phoenix;
  (C) Integrate OpenBook.
- **Decision:** **Build a minimal on-chain CLOB inside our program.**
- **Why:** The brief explicitly rewards this ("more ambitious, demonstrates deeper
  understanding") and success criteria emphasize defensible trade-offs. Crucially,
  Phoenix is built for **long-lived spot pairs**, but Meridian needs **many
  short-lived markets created and retired every day** (one Yes/USDC book per strike
  per day) — a poor fit for Phoenix's market-creation model, with uncertain
  per-market setup cost/permissions on devnet. Meridian's instruments are also
  *simpler* than general spot trading (price is bounded $0.00–$1.00, one book per
  strike, modest depth), so a purpose-built book is genuinely tractable. Owning the
  book in the same program keeps trade and settlement state cohesive and wires the
  mint/redeem invariants directly into trading with no cross-program glue.
- **Trade-offs / risks:** Matching logic is perf-sensitive and edge-case heavy
  (partial fills, ordering, rounding). Mitigated by scoping to "minimal" (ADR-002b)
  and by a fallback path.
- **Rejected because:** Integration trades a hard-to-verify external devnet
  dependency for less demonstrated understanding; if the dependency isn't on devnet,
  the whole approach dead-ends.

### ADR-002b — Order book storage: bounded on-chain matching

- **Context:** How resting orders are stored determines complexity and Solana
  compute/account-size pressure.
- **Options:** (A) Per-order accounts + off-chain matcher; (B) Serum/Phoenix-style
  on-chain slab; (C) Bounded on-chain array, matched in-instruction.
- **Decision:** **(C) Bounded on-chain array with on-chain matching.**
- **Why:** Keeps matching trustless and fully on-chain (supports the "transparent
  and auditable" pitch and the invariant story) while avoiding the slab/heap
  data-structure complexity of (B) and the trusted-matcher weakness of (A).
- **Trade-offs / risks:** A cap `N` on resting orders per side per market. This is
  a documented demo limitation; production path is the slab model (B).

### ADR-003 — Collateral: SPL mints per strike + PDA-owned vault

- **Context:** Need non-custodial collateral and a token pair per market.
- **Decision:** Two SPL mints (Yes, No) per market; USDC held in a **PDA vault**;
  the program is mint + freeze authority via PDA.
- **Why:** SPL is Solana's native, audited token standard. PDA ownership means no
  private key controls funds or issuance — only program logic does. The
  mint-pair-only / redeem-only lifecycle enforces the collateralization invariant
  *mechanically* rather than by trust.
- **Trade-offs / risks:** Two mints + vault + order book per strike = several
  accounts per market (rent cost, account-creation transactions). Acceptable;
  bounded by the small number of stocks × strikes per day.

### ADR-004 — Oracle: Pyth, with an admin-override fallback for devnet

- **Context:** Settlement must read a real stock closing price on-chain, with
  staleness and confidence checks. Stock feeds may not exist on devnet and only
  update during market hours.
- **Options:** (A) Pyth; (B) Switchboard; both with/without a fallback.
- **Decision:** **Pyth** as the production oracle, behind an **oracle interface**,
  with a **time-delayed admin-override** settlement path for devnet/emergencies.
- **Why:** Pyth publishes native confidence intervals — exactly the brief's
  confidence-check requirement — is the dominant Solana price oracle, and is the
  main on-chain source of real-time **US equities** prices (it powers Polymarket's
  equity markets — strong production validation). Critically, Pyth on Solana is a
  **pull oracle**: our client fetches a signed price from Pyth's **Hermes** service
  and posts it on-chain via the **Pyth Solana Receiver** (program ID
  `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, **identical on devnet and
  mainnet**), then `settle_market` consumes the resulting price-update account via
  `get_price_no_older_than(max_age, feed_id)`. Because *we* post the update, we can
  likely get equity prices onto **devnet** during market hours even without
  sponsored push feeds — which de-risks the devnet requirement. The oracle
  interface + `admin_settle` override remains as the guaranteed fallback.
- **Trade-offs / risks:** Equity feeds **only update during US market hours** and
  feed IDs **differ per cluster** (must use the devnet feed ID, looked up live).
  Settlement at 4:00 PM ET sits right at the regular-session/post-market boundary,
  so the automation service must encode the market calendar and choose a tight
  staleness window. The override is a centralization point; mitigated by the
  enforced time delay, admin-only access, and being fallback-only.
- **Rejected because:** Switchboard is a fine alternative but Pyth's confidence
  model maps more directly onto the requirement; choosing one keeps scope tight.

### ADR-005 — Automation: plain Node.js scheduled service (vs. keeper network)

- **Context:** Market creation (AM) and settlement (PM) must fire on a wall clock;
  blockchains cannot self-trigger.
- **Options:** (A) Plain Node.js cron-style service; (B) on-chain keeper network
  (Clockwork-style).
- **Decision:** **(A) Plain Node.js service** in the same repo.
- **Why:** Fewer dependencies (brief: "avoid unnecessary third-party
  abstractions"), full control over retry/backoff/alert logic, matches the brief's
  stated stack. The service is trust-minimized: it can only call permissioned
  instructions and cannot violate on-chain invariants — correctness lives on-chain,
  only *timing* lives off-chain.
- **Trade-offs / risks:** Single off-chain process is a liveness dependency; if it
  dies, markets don't auto-create/settle. Mitigated by retries, alerting, and the
  admin override. **Resilience design:** `settle_market` is **idempotent** (safe to
  retry — a second call on a settled market is a no-op) and, where possible,
  **permissionless** (anyone can post the Pyth update and trigger settlement after
  4:00 PM ET), so the system can settle even if our service is down. The service
  also owns a keypair that pays fees and posts oracle updates — it must be secured
  (env/KMS) and monitored.

### ADR-006 — Position constraints: enforce in the frontend

- **Context:** A user shouldn't *persistently* hold both Yes and No for one strike
  (holding both = redeemable $1.00; pointless to trade).
- **Decision:** Enforce client-side (check balances, guide user to close the
  opposite position first). Do **not** enforce on-chain.
- **Why:** Holding both is a legitimate *transient* state of the mint mechanic
  (Buy No mints a pair). Forbidding it on-chain would break minting. The rule is a
  UX guardrail, not a fund-safety invariant — so the on-chain layer enforces only
  what affects fund safety.
- **Trade-offs / risks:** A determined user could acquire both via raw transactions
  outside the UI; harmless (just $1.00 of redeemable collateral).

---

## 11. Risks & Limitations

*(No regulatory or compliance claims are made here; this is a technical risk note.)*

- **⚠️ Equity oracle feeds & market hours (highest risk):** *Verified findings
  (see RESEARCH.md §2.5):* Pyth equity feeds **only update during US market hours**
  (regular session 9:30 AM–4:00 PM ET; frozen/stale nights, weekends, NYSE
  holidays), and **feed IDs differ per cluster** (must use the *devnet* feed ID).
  Settlement at 4:00 PM ET sits at the regular/post-market boundary, so the
  automation service must encode the market calendar (incl. half-days) and pick a
  precise "close" price with a tight staleness window. *De-risking factor:* because
  Pyth on Solana is a **pull oracle**, our client posts the Hermes price update
  on-chain itself via the Receiver (same program ID on devnet & mainnet), so we can
  likely obtain equity prices on devnet during market hours even without sponsored
  push feeds. *Still requires a live check:* confirm each MAG7 feed returns a fresh
  devnet price during market hours before building settlement (see Open Questions).
  The `admin_settle` override is the guaranteed fallback regardless.
- **Order book scope:** the bounded-array book caps resting orders per side and is
  not optimized for high throughput. Demo-grade, not production-grade.
- **Automation liveness:** a single off-chain scheduler is a single point of
  failure for *timing* (not for funds).
- **Oracle centralization in fallback:** `admin_settle` is a trusted path; bounded
  by time delay + admin-only + use-only-on-failure.
- **No KYC / custody / margin** — by design, per the brief.
- **Devnet only for core submission;** never mainnet or real funds for the core
  deliverable.

---

## 12. Testing Strategy

**Smart-contract unit tests:** mint, settle, redeem; settlement at/above/below
strike; invariant tests (`Yes + No = $1.00`) across all prices; vault balance
invariant after every mint/redeem; oracle validation (stale price, wide confidence,
valid price); admin override with time-delay enforcement.

**Integration tests:** full lifecycle (create → mint → trade → settle → redeem);
all four trade paths (Buy/Sell Yes/No); multi-user (one mints+quotes, another
takes, both redeem).

**Frontend tests:** wallet connect; order placement & signing; real-time price
display; order book rendering (both perspectives of one book); position-constraint
enforcement; portfolio/P&L accuracy; settlement display & redeem flow.

---

## 13. Deployment

- **Target:** Solana **devnet** (required). Bonus: mainnet-beta.
- **Reproducibility:** one-command setup (`make dev` or equivalent) and scripts to
  deploy the program, create markets, and run the full lifecycle end-to-end on
  devnet.
- **Secrets:** via environment variables; ship a `.env.example`. Never commit keys.
- **Demo:** create → mint → trade → settle → redeem, reproducible on devnet.

---

## 14. Open Questions

1. **[CRITICAL — needs a live check] Do each of the 7 MAG7 feeds return a fresh
   price on Solana *devnet* during market hours?** RESEARCH.md confirmed the pull
   model + per-cluster feed IDs + market-hours behavior, but the exact live devnet
   coverage per ticker must be verified with a tiny script (Hermes → Receiver →
   `get_price_no_older_than`) during a US session before settlement code is
   committed. Fallbacks if flaky: (a) prove settlement logic on devnet with crypto
   feeds (BTC/SOL, 24/7) as stand-ins; (b) mock the oracle behind the interface for
   dev; (c) validate equities on mainnet-beta with tiny amounts.
2. **Strike fixed-point representation** — align the program's `strike` /
   `settlement_price` units with Pyth's `price × 10^exponent` scaling (apply the
   exponent; avoid float). Decide how to treat a confidence band that straddles the
   strike, and consider choosing strikes off round numbers.
3. **Order book cap `N`** — pick a concrete value once compute-unit budget per
   `match_orders` is measured.
4. **Settlement permissionlessness** — confirm `settle_market` can be made callable
   by anyone after 4:00 PM ET (resilience), with the automation service as the
   default trigger.

---

*Decisions summary table*

| # | Decision | Choice | One-line why |
|---|---|---|---|
| 001 | Chain | Solana + Anchor, devnet | Sub-second finality + mature CLOB/oracle infra for a real-time book |
| 002 | Order book | Build minimal on-chain CLOB | Brief rewards it; existing CLOBs are mainnet-risky; cohesive state |
| 002b | Book storage | Bounded on-chain matching | Trustless + auditable without slab-structure complexity |
| 003 | Tokens/vault | SPL mints + PDA vault | Non-custodial by construction; enforces $1.00 invariant mechanically |
| 004 | Oracle | Pyth + admin-override fallback | Confidence bands fit the brief; fallback guarantees devnet demo |
| 005 | Automation | Plain Node.js cron service | Chains can't self-trigger; minimal deps; trust-minimized |
| 006 | Position rules | Frontend-enforced | UX guardrail, not a fund-safety invariant |
