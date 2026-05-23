# BellMarkets — System Overview (Diagrams)

Everything in this file renders inline in GitHub, Cursor's markdown preview,
Notion, and most static-site generators. No tooling. No dev server.

This is the "single picture per question" companion to the deeper LikeC4
model at `docs/architecture/` (which is for interactive exploration).

---

## 1. System Flowchart — Where Each Piece Lives

A top-down view of the whole system in one diagram.

```mermaid
flowchart TB
    %% Actors
    Trader([Trader<br/>browser user])
    Admin([Platform Admin<br/>operator])
    Cranker([Any wallet<br/>DR-002 cranker])

    %% External boundary
    subgraph External["External Systems"]
        Pyth[Pyth Network<br/>oracle]
        Phoenix[Phoenix v1 CLOB<br/>order book]
        Solana[Solana Devnet<br/>L1 blockchain]
        Circle[Circle USDC<br/>stablecoin]
        Trigger[Trigger.dev<br/>cron platform]
        Helius[Helius<br/>RPC + WebSocket]
        WA[Wallet Adapter<br/>Phantom/Solflare]
    end

    %% BellMarkets system
    subgraph BellMarkets["BellMarkets (our system)"]
        direction TB
        Frontend[Frontend<br/>Next.js + React<br/>Cleo]
        Automation[Automation Service<br/>Trigger.dev jobs<br/>Bram]
        Program[Anchor Program<br/>10 instructions<br/>Aria]
        Quality[Quality + Sim<br/>mocha + eval<br/>Drew]

        subgraph OnchainData["On-Chain Data Stores"]
            Config[(MarketConfig PDA)]
            Markets[(StrikeMarket PDAs<br/>~35/day)]
            Mints[(YES / NO mints)]
            Vault[(USDC Vault)]
        end

        Frontend --> Program
        Automation --> Program
        Program --> Config
        Program --> Markets
        Program --> Mints
        Program --> Vault
        Quality -.observes.-> Program
        Quality -.observes.-> Automation
    end

    %% Actor relationships
    Trader --> WA
    Trader --> Frontend
    Admin --> Automation
    Admin --> Program
    Cranker --> Program

    %% External relationships
    Frontend --> Helius
    Frontend --> Phoenix
    Automation --> Trigger
    Automation --> Helius
    Automation --> Pyth
    Program --> Pyth
    Program --> Phoenix
    Program --> Circle
    Program --> Solana
    WA --> Frontend

    %% Styling
    classDef aria fill:#1e1b4b,stroke:#8b5cf6,color:#fff
    classDef bram fill:#451a03,stroke:#fb923c,color:#fff
    classDef cleo fill:#164e63,stroke:#06b6d4,color:#fff
    classDef drew fill:#14532d,stroke:#22c55e,color:#fff
    classDef ext fill:#1f2937,stroke:#6b7280,color:#fff
    classDef data fill:#0c0a0a,stroke:#fbbf24,color:#fff
    classDef actor fill:#1f1b18,stroke:#fff,color:#fff

    class Program,Config,Markets,Mints,Vault aria
    class Automation bram
    class Frontend cleo
    class Quality drew
    class Pyth,Phoenix,Solana,Circle,Trigger,Helius,WA ext
    class Config,Markets,Mints,Vault data
    class Trader,Admin,Cranker actor
```

**Key takeaways:**
- The system has 4 internal workstreams (color-coded by lead).
- The Anchor Program is the only thing on-chain; everything else is off-chain.
- DR-002 lets *anyone* (Cranker) call the program — automation is convenience, not authority.
- The trader's private key never crosses into BellMarkets — Wallet Adapter is the trust boundary.

---

## 2. C4 Context — Standard C4 Notation

Same picture as above, but in the formal C4 Context shape that
architecture reviewers expect.

```mermaid
C4Context
    title BellMarkets — System Context

    Person(trader, "Trader", "Retail user. Connects Phantom/Solflare wallet. Trades binary outcomes for $1 USDC payouts.")
    Person(admin, "Platform Admin", "Operator. Signs initialize_config, create_strike_market, pause, admin_settle.")
    Person(cranker, "Any wallet (Cranker)", "DR-002: anyone can crank settle. Critical for cron-failure path (HY-5).")

    System(bm, "BellMarkets", "Non-custodial Solana dApp.<br/>Binary outcome contracts on MAG7 stocks.<br/>$1 USDC max payout. Same-day expiry.")

    System_Ext(solana, "Solana Devnet", "L1 blockchain. Program deployed at 599h7V…kS7uV")
    System_Ext(pyth, "Pyth Network", "Pull-based oracle. Used both on-chain (settle) and off-chain (spot display).")
    System_Ext(phoenix, "Phoenix v1", "On-chain limit-order book by Ellipsis Labs.")
    System_Ext(circle, "Circle USDC", "Devnet USDC mint. Pinned in MarketConfig.")
    System_Ext(trigger, "Trigger.dev", "Hosted cron platform. Free tier. Runs morning + settle jobs.")
    System_Ext(helius, "Helius", "Solana RPC + WebSocket. Subscription-driven account updates.")

    Rel(trader, bm, "Trades via browser")
    Rel(admin, bm, "Operates cron + admin ix")
    Rel(cranker, bm, "Permissionless settle / mint / redeem")
    Rel(bm, solana, "Deploys + transacts on")
    Rel(bm, pyth, "Reads close price for settle")
    Rel(bm, phoenix, "Routes orders via CPI")
    Rel(bm, circle, "Holds USDC in vault")
    Rel(bm, trigger, "Schedules cron jobs")
    Rel(bm, helius, "RPC + subscription transport")

    UpdateRelStyle(trader, bm, $offsetX="-30")
    UpdateRelStyle(cranker, bm, $offsetX="20")
```

---

## 3. C4 Container — Inside BellMarkets

Zoom into the system. Shows the 4 workstream containers + their owned data.

```mermaid
C4Container
    title BellMarkets — Containers (Internal Structure)

    Person(trader, "Trader")
    Person(admin, "Admin")

    System_Boundary(bm, "BellMarkets") {
        Container(frontend, "Frontend", "Next.js 14 + React 18 + TypeScript", "Trading UI. 5 routes. 6 hooks. 7 atomic tx builders. Cleo.")
        Container(automation, "Automation", "Node 22 + Trigger.dev v4", "Morning + settle cron jobs. PRD 30s × 15min retry. Bram.")
        Container(program, "Anchor Program", "Rust 1.95 + Anchor 0.31.1", "10 instructions. Deployed devnet 599h7V…kS7uV. Aria.")
        ContainerDb(config, "MarketConfig PDA", "Solana account", "Singleton. Admin, USDC mint, oracle policy.")
        ContainerDb(markets, "StrikeMarket PDAs", "Solana accounts", "~35 per trading day. Outcome + settle_price.")
        ContainerDb(mints, "YES/NO Mints + Vault", "SPL Token accounts", "Per-market token pairs. USDC vault.")
        Container(quality, "Quality + Sim", "mocha + ts-mocha + Vitest", "Compressed-time simulation. Drew.")
    }

    System_Ext(pyth, "Pyth")
    System_Ext(phoenix, "Phoenix CLOB")
    System_Ext(helius, "Helius RPC")
    System_Ext(trigger, "Trigger.dev")

    Rel(trader, frontend, "Trades", "HTTPS + wallet")
    Rel(admin, automation, "Operates", "Trigger.dev dashboard")
    Rel(frontend, program, "Signed tx", "via Helius RPC")
    Rel(frontend, phoenix, "Order book reads", "Phoenix SDK")
    Rel(frontend, helius, "Subscribes to accounts", "WebSocket")
    Rel(automation, program, "Signs create + settle", "Anchor client")
    Rel(automation, trigger, "Scheduled by", "cron")
    Rel(program, pyth, "Reads price", "vendored parser")
    Rel(program, phoenix, "Routes orders", "CPI")
    Rel(program, config, "Reads policy", "")
    Rel(program, markets, "Mutates outcome", "")
    Rel(program, mints, "Mints + burns", "")
    Rel(quality, program, "Tests against", "live + mock")
```

---

## 4. Sequence — Trader Buys "No" (POV-3 Atomic)

The signature UX commitment. One signature. Two on-chain instructions
bundled atomically. If either fails, both revert.

```mermaid
sequenceDiagram
    autonumber
    actor T as Trader
    participant W as Wallet (Phantom)
    participant F as Frontend
    participant P as Anchor Program
    participant V as USDC Vault
    participant M as YES/NO Mints
    participant X as Phoenix CLOB

    T->>F: Click "Buy No @ 48¢"
    F->>F: buildBuyNo(amount=1)<br/>composes 2-ix atomic tx:<br/>1. mintPair(1)<br/>2. phoenix.sellYes(1)
    F->>W: Request signature<br/>(simulate + present)
    W->>T: Show "approve tx with 2 ix"
    T->>W: Sign once
    W-->>F: Signed tx
    F->>P: Submit transaction

    rect rgb(40, 70, 40)
        Note over P,X: ATOMIC EXECUTION (both succeed or both revert)
        P->>V: ix0: transfer $1 USDC from trader → vault
        P->>M: ix0: mint 1 YES + 1 NO → trader ATA
        P->>X: ix1: place sell order on YES asks
        X->>M: burn YES from trader (Phoenix maker takes)
        X->>T: pay 48¢ USDC (filled at ask)
    end

    Note over T: Net result:<br/>Paid $1.00 to mint pair<br/>Received $0.48 selling YES<br/>Net cost: $0.52 for 1 NO contract<br/>Wins $1 if META < $680
```

**Why one signature matters:** competitors force users through 2 separate
transactions (mint, then sell). That's slower, more error-prone, and
breaks the "I am buying No" mental model. POV-3 says: the user thinks
"Buy No" — the system should execute "Buy No," not expose the primitives.

---

## 5. Sequence — Daily Settlement (Happy Path)

What happens at 4:05 PM ET every weekday.

```mermaid
sequenceDiagram
    autonumber
    participant T as Trigger.dev
    participant J as settlementJob
    participant R as retryHelper<br/>(30s × 15min)
    participant A as Anchor Client
    participant P as Anchor Program
    participant Py as Pyth Price Account
    participant SM as StrikeMarket PDAs

    Note over T,P: 4:00 PM ET — Pyth pushes META close to chain ($679.20)

    T->>J: 4:05 PM cron fires<br/>(5 21 * * 1-5)
    J->>A: program.account.strikeMarket.all()
    A->>SM: getProgramAccounts (1 RPC call)
    SM-->>A: 35 markets (all unsettled)
    A-->>J: List of expired markets

    loop For each of 35 markets (parallel)
        J->>R: retryUntilDeadline(settle, 30s, 15min)
        R->>P: settle_market()
        P->>Py: read price account
        Py-->>P: aggregate=$679.20, confidence=20bps, slot=fresh
        P->>P: 20bps < 50bps (config.confidence) ✓
        P->>P: slot age < 300s (config.staleness) ✓
        P->>SM: write outcome=No (679.20 < 680), settle_price=679200000

        Note over P: Strike $680: META closed BELOW → NO wins
    end

    J-->>T: Job complete. 35/35 settled.
```

**Retry harness detail:** if Pyth confidence is wide at 4:05 (common — high
volatility around close), the retry harness re-attempts every 30s for 15
minutes. Each market retries independently — one slow market doesn't
block the other 34.

---

## 6. Sequence — When the Cron Fails (DR-002 / HY-5)

The architectural commitment that makes BellMarkets actually
non-custodial. If Bram's automation dies, the protocol still works.

```mermaid
sequenceDiagram
    autonumber
    participant T as Trigger.dev
    participant J as settlementJob
    participant H as Helius RPC
    participant C as Any wallet<br/>(Cranker)
    participant P as Anchor Program
    participant Py as Pyth Oracle
    participant SM as StrikeMarket

    rect rgb(80, 40, 40)
        Note over T,H: SCENARIO: Trigger.dev outage at 4:05 PM
        T--xJ: ❌ cron does not fire
    end

    Note over T,H: ...20 minutes pass. Markets still unsettled.

    rect rgb(40, 60, 80)
        Note over C,P: HY-5 / DR-002 path: any wallet rescues the protocol
        C->>H: I notice market is unsettled past expiry
        C->>P: settle_market() with MY OWN keypair (not admin)
        P->>P: check expiry_unix < now ✓
        P->>P: check outcome.is_none ✓
        P->>P: check signer == ? ← NO CHECK. Permissionless.
        P->>Py: read price account
        Py-->>P: $679.20 (same as cron would have read)
        P->>SM: write outcome=No, settle_price=679200000
        P-->>C: settled successfully
    end

    Note over C,SM: Cranker burns 5,000 lamports of gas.<br/>Cron failure = $0 protocol impact.<br/>Demo evidence for HY-5.
```

**Why this is defensible:** every binary-options platform claims to be
"decentralized." Most require their backend to settle. Kill the backend,
kill the protocol. We refused that — settle is unconditionally
permissionless. The cron is convenience for the 99% case where everything
works; the protocol survives the 1%.

---

## 7. Sequence — Full Trader Lifecycle (Mint → Trade → Settle → Redeem)

Zoomed out: what a single trader's journey looks like over a day.

```mermaid
sequenceDiagram
    autonumber
    actor T as Trader (Alice)
    participant F as Frontend
    participant P as Anchor Program
    participant V as USDC Vault
    participant M as YES/NO Mints
    participant X as Phoenix CLOB

    Note over T,X: 10:30 AM ET — Alice opens her position

    T->>F: Connect Phantom
    T->>F: Navigate to META $680 market
    T->>F: Click "Mint 10 Pairs ($10 USDC)"
    F->>P: mint_pair(10)
    P->>V: transfer $10 USDC in
    P->>M: mint 10 YES + 10 NO to Alice
    Note over T: Alice holds 10 YES + 10 NO<br/>Vault: $10 (1 pair = $1)

    Note over T,X: 11:00 AM — Alice bullish, sells her NO tokens

    T->>F: Click "Sell 10 NO @ 49¢"
    F->>X: phoenix.placeOrder(SellNo, 10, 0.49)
    X->>M: burn 10 NO from Alice
    X-->>T: $4.90 USDC paid

    Note over T: Alice holds 10 YES, $4.90 cash<br/>Net cost basis: $5.10 for 10 YES contracts<br/>(implied buy-Yes price: 51¢)

    Note over T,X: 4:05 PM — Cron settles. META closed at $681.50 (above strike).

    P->>P: settle_market() reads Pyth: $681.50
    P->>P: outcome = Yes (681.50 > 680)

    Note over T,X: 4:10 PM — Alice redeems winnings

    T->>F: Click "Redeem 10 YES"
    F->>P: redeem(10)
    P->>M: burn 10 YES from Alice
    P->>V: transfer $10 USDC to Alice
    Note over T: Alice received $10<br/>Total: $10 + $4.90 = $14.90 USDC<br/>P&L: +$4.90 on $5.10 cost = +96%
```

---

## 8. Data Flow — Pyth Price → On-Chain Settle

How a stock price moves from Pyth into our settle outcome.

```mermaid
flowchart LR
    Market[Stock Market<br/>NYSE / NASDAQ] -->|trades| Pubs[Pyth Publishers<br/>20+ market makers]
    Pubs -->|signed price reports| PythAgg[Pyth Aggregator<br/>off-chain]
    PythAgg -->|push price + confidence| PythAcct[Pyth Price Account<br/>on-chain PDA]
    PythAcct -->|read| Parser[Vendored Pyth Parser<br/>30 lines, no SDK]
    Parser -->|aggregate + slot + conf| Settle[settle_market]
    Settle -->|"outcome = price ≥ strike"| Market2[StrikeMarket PDA<br/>outcome + settle_price]

    style Market fill:#1f2937,color:#fff,stroke:#9ca3af
    style PythAcct fill:#5b21b6,color:#fff,stroke:#8b5cf6
    style Parser fill:#5b21b6,color:#fff,stroke:#8b5cf6
    style Settle fill:#1e1b4b,color:#fff,stroke:#8b5cf6
    style Market2 fill:#451a03,color:#fff,stroke:#fbbf24

    classDef policy fill:#0c0a0a,stroke:#fbbf24,color:#fff
    P1[/staleness < 300s/]:::policy
    P2[/confidence < 50bps/]:::policy

    Parser --> P1
    Parser --> P2
    P1 -->|else: PythStale| Settle
    P2 -->|else: PythConfidenceTooWide| Settle
```

The two policy gates (staleness + confidence) come from MarketConfig.
If either fails, settle reverts → retry harness loops. If they keep
failing for 1 hour past expiry, admin can override with `admin_settle`.

---

## How to use these diagrams for interview defense

| Question they ask | Diagram to open |
|---|---|
| "Walk me through your architecture" | §1 System Flowchart |
| "What about industry standard notation?" | §2 + §3 C4 Context + Container |
| "Tell me about the trading UX" | §4 Buy No sequence |
| "What happens at settlement?" | §5 Daily settle sequence |
| "What if your cron service goes down?" | §6 Permissionless settle sequence |
| "Walk me through a full user journey" | §7 Mint → trade → settle → redeem |
| "How does the oracle integration work?" | §8 Pyth data flow |

Each section is ~2-3 minutes of narration. Full set ~15 minutes if asked
to walk through everything.

---

## Editing

These are pure Markdown + Mermaid code blocks. Edit in any editor.
Preview in:
- Cursor / VS Code (built-in markdown preview)
- GitHub (renders Mermaid in `.md` files natively)
- `npx markserv .` for a local server
- Any markdown tool

If a diagram outgrows readability, split it into two. If the same
relationship appears in multiple diagrams, that's fine — Mermaid
diagrams are *views*, not a single source of truth (that's the LikeC4
model at `docs/architecture/`).
