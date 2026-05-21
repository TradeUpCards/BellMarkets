# BellMarkets — Build Timeline

> Living planning artifact. Each lead refreshes their row in the table below when state changes. Tate refreshes the Gantt diagram on weekly cadence or after a major scope/order change.
>
> See `ARCHITECTURE.md` "Next Implementation Step" for the dispatch entry-point and `specs/coordination.md` for the workstream model.

## Hard dates

| Date | Time (ET) | Event |
|---|---|---|
| Thu 2026-05-21 | 9:00 PM | All 4 leads dispatched (parallel) — Day-1 start |
| Fri 2026-05-22 | 9:00 PM | Informal MVP target — scaffolding complete, all leads' Day-1 deliverables in |
| Sat 2026-05-23 | 6:00 PM | **CRITICAL GATE** — Aria's first devnet deploy unblocks live integration |
| Sat 2026-05-23 | 9:00 PM | Cleo's frontend connects to live devnet program |
| Sun 2026-05-24 | 6:00 PM | Cron-failure demo script ready (Hard YES #5 evidence) |
| Sun 2026-05-24 | 11:00 PM | Demo video recorded |
| Mon 2026-05-25 | 3:00 PM | Final submission window opens (4hr slack before hard deadline) |
| Mon 2026-05-25 | **7:00 PM** | **HARD FINAL** — Gauntlet cohort deliverable |

## Gantt

```mermaid
gantt
    title BellMarkets — Build Timeline (Thu 5/21 evening → Mon 5/25 final 7pm ET)
    dateFormat YYYY-MM-DD-HH
    axisFormat %a %H:%M

    section Tate (Director)
    Day-0 setup (DONE)                    :done, t0, 2026-05-21-09, 8h
    Dispatch all 4 leads tonight          :crit, t1, 2026-05-21-21, 1h
    /daily-sync each morning              :t2, 2026-05-22-08, 4d
    Demo dry-runs + cron-failure rehearsal:t3, 2026-05-24-18, 18h
    Final submission                      :crit, t4, 2026-05-25-15, 4h

    section Aria (Onchain)
    Anchor.toml + Cargo.toml + lib.rs     :a0, 2026-05-21-21, 3h
    state.rs (MarketConfig, StrikeMarket) :a1, 2026-05-22-08, 4h
    8 instruction skeletons + errors.rs   :a2, 2026-05-22-12, 6h
    Vendored Pyth parser (oracle.rs)      :a3, 2026-05-22-18, 3h
    Phoenix adapter stub (adapters/)      :a4, 2026-05-22-21, 3h
    Instruction bodies: mint_pair, settle :a5, 2026-05-23-08, 6h
    Instruction bodies: redeem, admin     :a6, 2026-05-23-14, 4h
    First devnet deploy + Drew sim run    :crit, a7, 2026-05-23-18, 4h
    Bug fixes from Drew's findings        :a8, 2026-05-24-08, 8h
    Final devnet redeploy + verify        :a9, 2026-05-24-16, 4h

    section Bram (Automation)
    services/automation/ + pnpm setup     :b0, 2026-05-21-21, 2h
    trigger.config.ts + job stubs         :b1, 2026-05-22-08, 3h
    Strike calc (deterministic, mocked)   :b2, 2026-05-22-11, 4h
    Pyth HTTP + Helius RPC client wrappers:b3, 2026-05-22-15, 4h
    Unit tests on strike logic            :b4, 2026-05-22-19, 3h
    Wire morning job to real program      :b5, 2026-05-23-14, 4h
    Wire settlement nudger + retry        :b6, 2026-05-23-18, 4h
    Trigger.dev deploy + dashboard verify :b7, 2026-05-24-12, 4h
    Mainnet-readiness doc (stretch defer) :b8, 2026-05-24-16, 2h

    section Cleo (Frontend)
    Next.js 14.2.18 + React 18 setup      :c0, 2026-05-21-21, 2h
    Wallet adapter + Phantom connect      :c1, 2026-05-22-08, 3h
    Tailwind + shadcn baseline + layout   :c2, 2026-05-22-11, 3h
    Route shells (5 pages, no data)       :c3, 2026-05-22-14, 3h
    TanStack Query + Anchor client setup  :c4, 2026-05-22-17, 3h
    /markets + /trade pages (read-only)   :c5, 2026-05-23-08, 5h
    Trade panel UI (4 buttons, disabled)  :c6, 2026-05-23-13, 4h
    Atomic Buy/Sell No tx bundling        :c7, 2026-05-23-17, 4h
    Connect to deployed program (live)    :crit, c8, 2026-05-23-21, 2h
    Position-exclusivity + portfolio P&L  :c9, 2026-05-24-08, 4h
    Settlement countdown + redeem flow    :c10, 2026-05-24-12, 4h
    docs/USER-GUIDE.md (composite-tx FAQ) :c11, 2026-05-24-16, 2h
    Polish + Vercel deploy                :c12, 2026-05-24-18, 4h

    section Drew (Quality+Demo)
    tests/integration + tests/eval setup  :d0, 2026-05-21-21, 2h
    Mocked Aria interface for simulation  :d1, 2026-05-22-08, 4h
    simulate-trading-day.mjs skeleton     :d2, 2026-05-22-12, 6h
    Parameterized mocha edge cases stubs  :d3, 2026-05-22-18, 4h
    Live sim against deployed program     :crit, d4, 2026-05-23-18, 4h
    Surface bugs to Aria; iterate         :d5, 2026-05-24-08, 4h
    one-command-demo.sh                   :d6, 2026-05-24-12, 4h
    Cron-failure demo step + script       :d7, 2026-05-24-16, 3h
    Record demo video                     :d8, 2026-05-24-19, 4h
    Defense narrative + Q&A prep          :d9, 2026-05-25-08, 4h
```

## Per-lead Day 1 deliverables (target: Fri 5/22 9pm ET)

| Lead | Deliverable |
|---|---|
| **Aria** | `programs/bell-markets/` compiles via `anchor build` (no "Stack offset exceeded" warnings per `hard-rules.md` §4.11). All 8 instructions declared as stubs. `MarketConfig` + `StrikeMarket` + `Outcome` defined in `state.rs`. Vendored Pyth parser unit-tested against a fixture. Phoenix adapter stub compiles with `UncheckedAccount` skeleton + magic-number check. |
| **Bram** | `services/automation/` workspace package compiles. `trigger.config.ts` valid; two job stubs (morning, settlement) declared with correct cron expressions. `strike-calc.ts` deterministic logic with passing unit tests (covers ±3/6/9% rounding + dedup for low-priced stocks). Pyth HTTP + Helius RPC client wrappers with mockable interfaces. |
| **Cleo** | `apps/web/` runs via `pnpm --filter web dev`. Wallet-adapter Connect button works with Phantom on devnet. Tailwind + shadcn installed. TanStack Query + Anchor client 0.30.1 wired. 5 route shells exist (landing, markets, trade/[ticker]/[strike], portfolio, history) — all placeholders, no data binding yet. |
| **Drew** | `tests/integration/` + `tests/eval/` directories scaffolded. `scripts/simulate-trading-day.mjs` skeleton runs to completion (all 6 phases logged; no actual chain calls yet — uses a mock Aria interface). `scripts/one-command-demo.sh` skeleton with TODO comments. `tests/eval/invariants.md` lists the 5 invariants Drew will verify. |

## Risks visible in the Gantt

1. **Aria's first devnet deploy at Sat 5/23 6pm ET is the single biggest gate.**
   - If it slips 6+ hours: Cleo can't wire trade buttons; Drew can't run live sim; Bram can't test settlement nudger end-to-end.
   - Mitigation: Aria dispatched first tonight (longest runway); Drew co-locks to inform interface design.

2. **Cleo's atomic Buy No / Sell No tx bundling on Sat 5pm ET is novel work.**
   - No precedent in w3Swap. Risk: stuck on Phoenix SDK + Anchor client integration boundary.
   - Mitigation: Drew's simulation exercises these paths first — early bug signal before Cleo wires the UI.

3. **Drew's cron-failure demo step on Sun 4pm ET requires Bram's deploy working.**
   - If Trigger.dev integration is flaky, the load-bearing demo evidence (Hard YES #5) is at risk.
   - Mitigation: Drew validates a "manual kill" recovery path early; doesn't require Trigger.dev to be live to demo killing it (just needs an automation process to point at and stop).

## Cut-list if running short

Per BRAINLIFT.md POV-2 + Hard YES #5, the **cron-failure path is load-bearing** for the defense narrative. Cuts in priority order:

1. **First to cut:** Bram's Trigger.dev deploy + observability dashboard (b7) — degrade to "operator runs job manually." The cron-failure demo path becomes "we never had a cron in the first place" with a documented "would be Trigger.dev for mainnet."
2. **Second:** Cleo's settlement countdown UI (c10 partial) and history page (skip entirely).
3. **Third:** Drew's defense narrative document (d9) — the doc itself; demo + cron-failure path remain mandatory.
4. **Never cut:** Aria's instruction bodies (mint_pair, settle, redeem, admin_settle), Cleo's 4 trade actions + atomic bundling, Drew's compressed-time simulation + cron-failure demo step, the one-command demo.

## How this file evolves

- Update the Gantt + per-lead deliverables table when scope changes meaningfully (not on every commit).
- Each lead can edit their own row of the per-lead deliverables table; the Gantt itself is Tate-owned.
- After each `/daily-sync`, Tate updates the "Hard dates" table if any gate has slipped.
- Risks section is append-only — surfaced risks stay even when retired (mark `[retired YYYY-MM-DD: mitigated by X]`).
