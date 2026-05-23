# Cron-Failure Path — DR-002 / Hard YES #5 Demo Evidence

**Owner:** Drew. **Status:** Day-4 draft (Fri 2026-05-22). **Source of truth for the demo narration.**

---

## TL;DR (interview defense, 30 seconds)

> "Our automation isn't a privileged signer. The Anchor program enforces every settlement rule on chain — time gate, Pyth staleness, Pyth confidence, immutable outcome. `settle_market` is callable by any wallet that can pay the transaction fee. So if our cron dies at 4:05 PM ET, the protocol doesn't break — any user with a winning position has a $1 incentive to crank settle themselves. Our automation is the happy-path nudger, not the load-bearing piece."

This page documents how we prove that claim under demo conditions.

---

## What still works when our cron dies (per DR-005/006/009/010 architecture)

A reviewer's natural follow-up: "OK, settle still works — but doesn't the rest of the system break?" The Day-5 architectural revisions tighten this story. Every system component is independent of Bram's cron:

| Component | Depends on Bram's cron? | What happens if cron dies | Implementation state |
|---|---|---|---|
| `settle_market` (DR-002) | No — permissionless | Any user keypair cranks it; on-chain rules unchanged | **SHIPPED** — `settle_market.rs` |
| Strike creation (DR-005) | Indirect — depends on `TickerConfig` having been written at least once for that ticker | New strikes spawn when users pay rent IF `TickerConfig` exists for ticker; brand-new tickers blocked until cron has fired at least once | **PLANNED** — `user_create_strike_market` queued; current `create_strike_market` is admin-only |
| Strike-grid evolution (DR-006) | Yes, but reactive — next 30-min interval | Cron dying mid-cycle means stale `TickerConfig` until next fire; **existing strikes** still tradeable; new strikes blocked until next update | **PLANNED** for the 30-min reactive cadence |
| Trading calendar (DR-007) | Only for cron entry-point gating | Calendar logic is off-chain helper; if cron is dead nothing fires regardless | **PLANNED** for off-chain helper module |
| Fee model (DR-008) | No — fee logic queued for on-chain `mint_pair` | When shipped, fee math + split will be atomic with mint inside the Anchor program; current `mint_pair` has **zero fee logic** (no rounding, no fee, no scaling per source comment) | **NOT SHIPPED** — `mint_pair.rs` currently has no fee transfer; this row describes intended architecture once DR-008 lands |
| Phoenix v1 CLOB (DR-009) | No — independent Solana program | Order book accepts orders regardless of our service health | **SHIPPED** (external program) |
| Pyth oracle (DR-003) | No — independent Pyth Network publishers | Price feed updates continue; `settle_market` reads freshly. **Failure mode: if Pyth itself is down or stale, `settle_market` reverts with PythStale/PythNotTrading; recovery requires `admin_settle` AFTER `admin_override_eligible_at` (expiry + 1hr default per DR-003 + admin_settle.rs). So a Pyth outage during settle window creates a 1+ hour window before any settle is possible, even with admin action.** | **SHIPPED** (oracle parser); admin_settle time-delay path SHIPPED |
| Win-streak indexer (DR-010) | **Partially** — Helius pushes to Bram's webhook endpoint, which is part of our service surface | If Bram's indexer service is down, Helius retries with exponential backoff for ~72h then drops events. Settle events persist on-chain forever, so a separate re-index pass can rebuild streak state from chain. **Streak state is eventually-consistent, not cron-gated; bounded by Helius retry window.** | **NOT SHIPPED** — Helius webhook + Neon indexer queued for Bram |
| Merkle distribution (DR-010) | Admin-signed; cron is convenience | Admin can sign distributions from anywhere with the keypair. Note: requires committed Merkle root, which depends on the indexer being live at period-end. | **NOT SHIPPED** — `commit_leaderboard_root` + `distribute_*` ixs queued |
| Earnings pre-expansion (DR-011) | Yes, but additive to DR-006 | If pre-expansion misses, DR-006 reactive widening catches it within 30 min | **NOT SHIPPED** — earnings-calendar.ts queued |
| `config.paused` (admin pause) | No — but admin can halt the system | If `config.paused == true`, both `settle_market` and `mint_pair` revert with `Paused`. Permissionless settle is blocked regardless of cron health. Admin must explicitly unpause. | **SHIPPED** — `pause.rs` |

**Honest scope of the cron-death claim:** the **settlement and redemption path is fully on-chain** (Pyth oracle + Anchor program); a settle initiated by ANY wallet after expiry completes the lifecycle independent of our service. The **leaderboard indexing path** (Helius webhook + Bram's service + Neon Postgres) is an off-chain service we operate; its failure is scoped to win-streak tracking and does NOT affect settlement or redemption. The **Pyth failure path** has a 1-hour time-delay recovery via admin override, and the **paused state** can block everything if admin chooses — neither is "the cron died" but both are real failure modes worth knowing about.

### Sequence diagram — happy path (cron alive, normal day)

Note: the diagram annotates which steps are SHIPPED vs PLANNED. Some steps reflect the post-DR-008/010 target state; today's `mint_pair` has no fee logic and the Helius+Neon indexer is queued.

```mermaid
sequenceDiagram
    participant U as User wallet
    participant W as Web frontend (Cleo)
    participant P as Anchor program
    participant Py as Pyth Hermes
    participant C as Bram cron
    participant He as Helius webhook
    participant N as Neon indexer

    U->>W: Open Trade page
    W->>P: getMarketConfig + getStrikeMarket (RPC read)
    U->>W: Mint pair $100
    W->>P: mint_pair(100)
    Note over P: SHIPPED today: mint USDC→YES+NO 1:1<br/>PLANNED (DR-008): +2% fee, 50/25/25 split
    P-->>U: +100 YES + 100 NO tokens

    Note over C: 4:05 PM ET tick<br/>(SHIPPED: settle nudger;<br/> PLANNED: TickerConfig anchor)
    C->>P: settle_market (any signer; cron uses platform admin by convention only)
    P->>Py: read price via vendored parser
    P-->>P: write outcome immutable (SHIPPED)
    Note over He,N: PLANNED (DR-010): Helius webhook to Bram's<br/>indexer service; Neon Postgres streak state

    U->>W: Redeem $100 YES
    W->>P: redeem(100)
    P-->>U: +100 USDC
```

### Sequence diagram — cron-failure path

```mermaid
sequenceDiagram
    participant U as User wallet
    participant W as Web frontend (Cleo)
    participant P as Anchor program
    participant Py as Pyth Hermes
    participant C as Bram cron

    Note over C: 4:05 PM ET tick<br/>SERVICE DIED

    U->>W: Notices market is past-expiry but unsettled
    W->>P: getStrikeMarket — outcome = Unsettled
    U->>W: "Settle market" button (user-cranked path)
    W->>P: settle_market(settler=USER)
    P->>P: check NotAdmin? NO — settler is fee payer only
    P->>P: check NotExpired? PASS — block_time > expiry
    P->>P: check !config.paused? PASS
    P->>Py: read price via vendored parser
    Py-->>P: fresh price + confidence
    P->>P: check PythStale? PASS
    P->>P: check PythConfidenceTooWide? PASS
    P-->>P: write outcome immutable (SHIPPED: settle_market.rs)

    U->>W: Redeem $100 YES
    W->>P: redeem(100)
    P-->>U: +100 USDC

    Note over C: 5:00 PM ET — Service restarts
    C->>P: settle_market (admin re-tries)
    P-->>C: AlreadySettled (6002) — idempotent reject
    C->>C: log + move on
```

**Leaderboard indexing (DR-010) intentionally NOT in this diagram** — that's a separate dependency (Helius webhook + Bram's indexer service + Neon Postgres) with its own failure profile (Helius retry window ~72h, after which events drop unless a re-index pass is run against historical chain state). It is **not gated on the settlement cron**, but it IS gated on the indexer service being reachable to receive the webhook. Settle events persist on-chain forever, so streak state is rebuildable from chain history by any indexer — it's eventually-consistent, not load-bearing for the settlement / redemption demo.

Key visual: the cron-death path has the same SETTLEMENT AND REDEMPTION outcome as happy path. The program + Pyth path is fully intact. The user redeems on the same timeline. The leaderboard path (not shown) is a separate concern.

---

## Why this matters

The build commits to **DR-002 — permissionless `settle_market`; automation is convenience, not authority** (`constitution/decisions.md` DR-002). The architectural argument is that this is cheaper to operate (no monitored 24/7 hot wallet for liveness), scales better with market count, and is genuinely robust to operator failure.

Without a live demonstration of the cron-failure path, that argument is theoretical. Hard YES #5 (`BRAINLIFT.md` §4) makes the demo coverage non-negotiable.

A reviewer asking "what happens when your cron crashes?" gets one of two answers:

| Answer | Score |
|---|---|
| "Theoretically, anyone can call `settle_market` and the program would accept it" | Mid |
| "Let me show you. Here's the cron dying mid-cycle. Here's a non-admin wallet calling `settle_market`. Here's the on-chain outcome being written. Here's the user redeeming their winning side." | High |

This page is the script for the second answer.

---

## What's already proven (CI, not demo)

Before the demo even starts, the following invariants are already established by the test suite — these aren't part of the live demo prose but are the foundation that makes it credible:

1. **IDL-level proof — `settle_market` has no admin signer.** The deployed program's IDL (`programs/bell-markets/idl/bell_markets.json`) shows `settle_market` accepts exactly one signer named `settler` whose docs are literally `"Fee payer. NOT validated against admin — settle is permissionless."` Verified by `tests/integration/live-deploy-verify.test.ts` against the actual deployed bytes at `599h7Vzn...` on devnet.

2. **Chain-level proof — handler reaches the time-gate without checking admin.** A non-admin Drew keypair (`CJBLhJwTFndhGPvGU4fdoXtWmZHKNmkSn6bEa5MBsYVe`, 0.5 SOL devnet) builds + simulates `settle_market` against a real seeded StrikeMarket. The simulation returns `Custom: 6003` (`NotExpired` — a handler-body error code) NOT `Custom: 6001` (`NotAdmin`). The only way to reach `NotExpired` is to pass any signer constraint that exists; the only way to get `NotAdmin` would be to fail an admin constraint that doesn't exist. Verified by `tests/integration/live-program-call.test.ts`.

3. **Simulation-level coverage — every settle path uses a non-admin caller.** `scripts/simulate-trading-day.mjs` Phase 3 settles via Carol (a non-admin user), proving the full lifecycle works without administrative signing. Verified on every CI run across 3 outcome modes (yes/no/invalid).

These three are the "permanent record" that survives even if the live demo encounters a devnet hiccup. The demo below makes the same point in human terms.

---

## The live demo path

**Setup state (pre-demo):**
- Devnet program live at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV`.
- MarketConfig PDA `6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ` with platform admin `7b17F2woUy9hgHcRjuLckBVAtNnKAJBRD769URvLprp5`.
- At least one StrikeMarket exists past expiry but unsettled (Bram's morning job seeds these; if his harness exhausts retries, see "Coordinating with Bram" below).
- The presenter has Bram's automation service running in one terminal window. The on-chain markets are visible to the audience.

**Demo arc (≈ 3 minutes):**

### Step 1 — Show automation is running and would normally settle (~30s)

```
$ pnpm --filter @bell-markets/automation logs:tail
# Output shows the settlement job's countdown to 4:05 PM ET market close.
```

Narration: "Bram's service has a settlement job scheduled at 4:05 PM ET. In normal operation it would call `settle_market` for every market that's past expiry. Let me show you what happens when it can't."

### Step 2 — Kill the cron mid-cycle (~15s)

```
$ pkill -9 -f services/automation
# Or: stop the trigger.dev dev server with Ctrl-C inside that window.
```

Narration: "Service is dead. No retry. No fallback path inside the service itself."

(Bram's retry harness has its own internal exhaustion — coordinate with him on what state markets are in when the harness gives up. The point of the demo is what happens AFTER the harness gives up, not the harness itself.)

### Step 3 — Show markets stuck unsettled on chain (~15s)

```
$ pnpm --filter @bell-markets/tests verify-idl
# (or solana account <strike_market_pda> --url devnet)
# Shows StrikeMarket with outcome = Unsettled despite block_time > expiry.
```

Narration: "Markets are past expiry, oracle is fresh, but no one has called `settle_market`. Without permissionless settle this is a stuck state — users can't redeem."

### Step 4 — Random user wallet cranks settle (~45s)

```
$ pnpm --filter @bell-markets/tests crank-settle <STRIKE_MARKET_PDA>
# Uses a fresh keypair (NOT the platform admin), pays ~5000 lamports tx fee,
# calls program.methods.settleMarket().accounts({settler: fresh, ...}).rpc()
```

This is the load-bearing moment. The CLI script does literally these three things:
1. Generate a fresh `Keypair.generate()` keypair locally.
2. Devnet-airdrop or use Drew's funded keypair `CJBLhJwT...` for tx fee.
3. Call `program.methods.settleMarket().accounts({settler: keypair.publicKey, config, strikeMarket, underlyingPythFeed, clock: SYSVAR_CLOCK_PUBKEY}).signers([keypair]).rpc()`.

Expected output: a real tx signature, a re-fetch of the StrikeMarket showing `outcome: { yes: {} }` or `{ no: {} }`, `settle_price` populated, `settled_at_unix` populated.

Narration: "That's a wallet that nobody on this team owns. Fresh keypair. No admin authority. No special anything. Just paid the transaction fee and the program accepted the call because the on-chain checks passed — block_time past expiry, Pyth feed fresh, confidence tight. The outcome is now written immutably."

### Step 5 — User redeems against the settled market (~30s)

```
$ pnpm --filter @bell-markets/tests redeem-winning <STRIKE_MARKET_PDA>
# Burns user's winning-side tokens, vault transfers $1 USDC per token.
```

Narration: "And the user can redeem. The cron dying didn't stop anyone from getting paid."

### Step 6 — Restart the cron, show it idempotent (~30s)

```
$ pnpm --filter @bell-markets/automation dev
# Service starts back up, runs its retry loop, tries to settle markets.
# Finds them already settled → logs "AlreadySettled (6002)" → exits cleanly.
```

Narration: "And when we bring the service back up, it tries to settle the same markets, gets `AlreadySettled` (error code 6002), and moves on. It's idempotent. No double-settle. No corruption. Outcome immutability is enforced on chain — the program rejects the second call."

---

## What to NOT say (avoid these traps)

- **Don't claim "anyone with any wallet can settle"** — they need enough SOL for the tx fee (~5000 lamports = $0.0001). The barrier is gas, not authority.
- **Don't claim "this means we don't need automation"** — automation is still the happy path. Users would have to monitor expiry times themselves otherwise. The point is the protocol doesn't COLLAPSE without automation, not that automation is useless.
- **Don't show admin_settle in this demo** — it's a different recovery path (oracle failure, time-delayed). Keep it focused on permissionless `settle_market`.
- **Don't oversell the user incentive** — there's no on-chain bounty for cranking settle today. The incentive is "I want my winning $1 to be redeemable" — pull, not push. Future feature.

---

## Coordinating with Bram (retry harness behavior)

Bram's settlement job has a retry harness — what state does it leave markets in when the harness exhausts? Three scenarios to confirm with him before the live demo:

1. **All retries exhaust silently.** Job logs "retries exhausted" and exits. Markets unchanged. Demo proceeds as written.
2. **Last retry succeeds.** Job settles the market before the demo step 4. Need to either pause Bram's service before the demo OR use a different market that hasn't been touched.
3. **Some retries succeed, others don't.** Mixed state. Pick a known-unsettled market for the demo.

Drew + Bram coordinate one hour before each rehearsal to pin which market the demo uses.

Open question for Bram: does the settlement job set any persistent "I tried to settle this" marker that would visible during the demo? If yes, we can show that marker → "automation tried and failed, here's its log." If no, the demo just relies on "outcome is Unsettled on chain" as the cron-failed signal.

---

## Fallback plan (if devnet hiccups during live demo)

If the public devnet RPC rate-limits, errors, or has reorgs during the live run, fall back to:

1. **Mock simulation playback.** Run `node scripts/simulate-trading-day.mjs` — Phase 3 settles via Carol (non-admin) in the same way. ~10ms wall clock, deterministic, no network dependency. Narrate the same arc against the mock output.
2. **Pre-recorded screen capture.** `docs/demo/recording-assets/cron-failure-path.mp4` (Drew records during rehearsal, archive for live-demo fallback).

The point is the architectural argument doesn't depend on devnet's mood. Three layers of evidence: live test (devnet), simulation (offline), IDL inspection (committed bytes). Reviewers see all three.

---

## Cross-references

- `constitution/decisions.md` DR-002 — the decision being defended (permissionless settle)
- `constitution/decisions.md` DR-005 — user-funded strike creation (proves protocol is non-custodial top to bottom; cron has no privileged role in strike spawning)
- `constitution/decisions.md` DR-006 — reactive 30-min wild-swing detection (the cron *does* something useful, but missing one cycle doesn't break anyone's existing position)
- `constitution/decisions.md` DR-008 — fee model planned for `mint_pair` on chain (cron will never touch money flow); **status: NOT yet implemented — `mint_pair.rs` currently has no fee logic. This DR is queued architecture, not shipped state.**
- `constitution/decisions.md` DR-009 — Phoenix v1 CLOB integration (independent program, our cron health is irrelevant to order matching)
- `constitution/decisions.md` DR-010 — Helius webhook + Neon Postgres indexer + Merkle-committed leaderboard. **Status: not yet implemented; `commit_leaderboard_root` + `distribute_*` ixs queued for Aria, indexer queued for Bram.** When shipped: leaderboard updates from on-chain events Helius pushes to Bram's endpoint (which IS part of our service surface); distributions are admin-signed via cryptographically verifiable Merkle proofs. Failure mode: if Bram's indexer endpoint is down >72h, Helius retries exhaust and events drop — but settle events are permanent on chain, so a re-index pass against historical state can always rebuild streak state.
- `BRAINLIFT.md` §4 Hard YES #5 — the requirement being satisfied
- `tests/integration/live-deploy-verify.test.ts` — IDL structural proof (signer count + docs string check)
- `tests/integration/live-program-call.test.ts` — chain-level handler-reached proof (NotExpired evidence)
- `tests/eval/edge-cases.test.ts` — DR-002 sweep across 4 distinct settlers (mock-level)
- `scripts/simulate-trading-day.mjs` Phase 3 — every CI run exercises the non-admin settle path
- `services/automation/src/jobs/settlement.ts` — what the cron actually does (Bram's territory)
- `.project/bell-markets/coordination/cron-failure.md` — Bram's complementary doc on retry-harness terminal states + log shapes Drew's demo can rely on

## Strongest reviewer-defense line

> "Kill our cron right now and the settlement and redemption path continues."

The architecture supports this for the **settle → redeem** lifecycle. The doc above is the evidence; the tests are the proof. Scope: this defense applies to the on-chain settlement and redemption path. The **leaderboard indexing path** (Helius webhook + Bram's service + Neon Postgres) is an off-chain service we operate — a Helius outage or extended Bram-service downtime is a distinct failure mode, scoped to win-streak tracking, not settlement. The **Pyth oracle** is independent of our service but has its own failure mode (1-hour `admin_settle` time-delay if Pyth goes stale). And the **`config.paused`** admin pause can block everything regardless of cron state, by design.

If a reviewer asks "what if EVERYTHING goes down?" the honest answer is: settlement and redemption survive any combination of Bram's cron failure + our indexer service failure + Phoenix activity stop, because the on-chain program is the source of truth. They do NOT survive Pyth oracle outage (1hr admin-override window) or admin pause (intentional kill-switch).
