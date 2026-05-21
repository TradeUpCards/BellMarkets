# BellMarkets

A non-custodial Solana dApp for trading binary outcome contracts on daily MAG7 stock prices, with $1 USDC payouts settled on-chain via a price oracle at 4PM ET.

> Gauntlet project codename: **Meridian**. See `.project/bell-markets/docs/prd/` for the full PRD.

---

## What it does

Each contract asks a simple question:
> "Will [STOCK] close above [PRICE] today?"

Two tokens per contract — **Yes** and **No** — trade against USDC on an on-chain order book. At 4:00 PM ET, an on-chain oracle reads the closing price; winners redeem $1 USDC per token.

- **Invariant:** Yes payout + No payout = $1.00 USDC. Always. Per contract.
- **Universe:** MAG7 (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA).
- **Lifecycle:** Same-day expiry (0DTE). Markets created ~8am ET, traded intraday, settled ~4:05pm ET, redeemable indefinitely.
- **Custody:** None. Non-KYC. On-chain order book. Oracle-driven settlement.

---

## Architecture (3 workstreams + 1 quality)

| Lead | Workstream | Owned paths |
|---|---|---|
| **Aria** | Onchain (Solana / Anchor) — mint-pair, settle, redeem, oracle integration, order book | `programs/**`, `tests/contracts/**`, `migrations/**`, `Anchor.toml`, `Cargo.*` |
| **Bram** | Automation Service (Node/TS) — morning create-markets, ~4:05pm settle, retry+backoff | `services/automation/**`, `services/oracle-adapter/**`, `tests/automation/**` |
| **Cleo** | Frontend (Next.js/React/TS) — Landing/Markets/Trade/Portfolio/History, wallet, order book UI | `apps/web/**`, `packages/ui/**`, `tests/frontend/**` |
| **Drew** | Quality + Integration + Demo — full-lifecycle tests, property-based invariant evals, demo script, cron-failure path | `tests/integration/**`, `tests/eval/**`, `docs/demo/**`, `scripts/one-command-demo.sh` |

Coordinated by **Tate** (Director, `/tate`). Slash commands: `/aria`, `/bram`, `/cleo`, `/drew`. See `.project/bell-markets/in-flight.md` for the live workstream map and file-ownership rules.

---

## Quick start

> **Always use `pnpm`. Never `npm` or `yarn`.**

```bash
# Install deps (monorepo via pnpm workspaces)
pnpm install

# Anchor build (smart contract)
anchor build

# Run contract tests
anchor test

# Start the frontend (Next.js, runs on http://localhost:3000)
pnpm --filter web dev

# Run the automation service in dev mode
pnpm --filter automation dev
```

Setup details (env vars, Solana CLI config, oracle keys) live in `docs/SETUP.md` once the build starts.

---

## Deployment

- **Required:** Solana devnet — reproducible scripts to deploy contracts, create markets, run the full lifecycle. Demonstrates: create → mint → trade → settle → redeem end-to-end on testnet.
- **Stretch:** Solana mainnet-beta with production oracle feeds. **Never use real funds for the core submission.**

---

## Deadlines

- **MVP target:** Fri 2026-05-22 9:00 PM ET (informal — not a hard gate)
- **Final:** Mon 2026-05-25 7:00 PM ET

---

## Hard rules

- No secrets, no private keys, no wallet mnemonics in any committed file.
- Never use mainnet or real funds for the core submission.
- The $1.00 USDC invariant is **always** enforced on-chain — including at settlement.
- `.project/` and `.claude/` are local-only (OneDrive-mirrored) — never committed.

See `constitution/hard-rules.md` for the full list.

---

## Repository layout

```
.
├── README.md                     # (this file)
├── LICENSE                       # Apache 2.0
├── BRAINLIFT.md                  # 4-section project constitution (run /brainlift to fill)
├── CLAUDE_SESSION_HANDOFF.md     # Tate session continuity
├── constitution/                 # Hard rules, decisions, file ownership
├── specs/                        # Architecture, project spec, coordination, deferred work
├── programs/                     # (Aria) Anchor program
├── services/                     # (Bram) Automation + oracle adapter
├── apps/web/                     # (Cleo) Next.js frontend
├── packages/ui/                  # (Cleo) Shared React components
├── tests/                        # Per-workstream + cross-cutting integration
├── docs/                         # Code-level docs (SETUP, demo, architecture diagrams)
└── scripts/                      # Setup + deploy + worktree helpers
```

Project docs (PRD PDF, lesson sketches, demo plans) live under `.project/bell-markets/docs/` — local-only.
