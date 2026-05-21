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
    title BellMarkets Build Timeline
    dateFormat YYYY-MM-DD
    axisFormat %a %m-%d

    section Tate
    Day 0 setup done             :done, t0, 2026-05-21, 1d
    Dispatch 4 leads             :crit, t1, 2026-05-21, 1d
    Daily syncs                  :t2, 2026-05-22, 3d
    Demo dry runs                :t3, 2026-05-24, 1d
    Final submission             :crit, t4, 2026-05-25, 1d

    section Aria
    Program scaffold day 1       :a1, 2026-05-22, 1d
    Instruction bodies day 2     :a2, 2026-05-23, 1d
    First devnet deploy          :crit, a3, 2026-05-23, 1d
    Bug fixes from Drew          :a4, 2026-05-24, 1d
    Final redeploy               :a5, 2026-05-25, 1d

    section Bram
    Service scaffold day 1       :b1, 2026-05-22, 1d
    Strike calc + clients        :b2, 2026-05-22, 1d
    Wire jobs to program         :b3, 2026-05-23, 1d
    Trigger dev deploy           :b4, 2026-05-24, 1d

    section Cleo
    Frontend scaffold day 1      :c1, 2026-05-22, 1d
    Trade panel + atomic tx      :c2, 2026-05-23, 1d
    Connect to live program      :crit, c3, 2026-05-23, 1d
    Portfolio + redeem flow      :c4, 2026-05-24, 1d
    Polish + Vercel deploy       :c5, 2026-05-24, 1d

    section Drew
    Test infra day 1             :d1, 2026-05-22, 1d
    Simulation skeleton          :d2, 2026-05-22, 1d
    Live sim on devnet           :crit, d3, 2026-05-23, 1d
    Cron failure demo            :d4, 2026-05-24, 1d
    Record demo video            :d5, 2026-05-24, 1d
    Defense narrative            :d6, 2026-05-25, 1d
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
