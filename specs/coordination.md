# BellMarkets — Coordination

> Workstream model + lead handoff discipline + cross-lead negotiation
> patterns. The operational complement to `constitution/file-ownership.md`.

`file-ownership.md` says *who* owns what; this file says *how* the work moves across leads.

---

## 1. Workstream model

**Four parallel workstreams + persistent Director**, running in **Mode 2 (per-lead worktrees)**.

| Lead | Workstream | Worktree path | Branch |
|---|---|---|---|
| **Tate** | Director — coordinates everyone | `BellMarkets/` (main checkout) | `main` |
| **Aria** | Onchain (Solana / Anchor) | `../BellMarkets-aria` | `crt/aria-<phase>` |
| **Bram** | Automation Service (Node / TS) | `../BellMarkets-bram` | `crt/bram-<phase>` |
| **Cleo** | Frontend (Next.js / React / TS) | `../BellMarkets-cleo` | `crt/cleo-<phase>` |
| **Drew** | Quality + Integration + Demo | `../BellMarkets-drew` | `crt/drew-<phase>` |

Each lead has their own `.claude/agents/<name>.md` persona file and `.claude/skills/<name>/SKILL.md` slash command. Invoking `/aria` (or `/bram`, `/cleo`, `/drew`) in any session loads that lead's identity + kickoff prompt.

**Daily sync via `/daily-sync`** at the start of each work session — pulls fresh handoffs from each lead, then Tate synthesizes the cross-lead status report.

---

## 2. Lead identities + boot prompts

| Lead | Identity / focus | Boot via | Kickoff prompt at |
|---|---|---|---|
| **Tate** | Director — coordinates everyone, owns the global handoff, watches deadlines | `/tate` | `.project/bell-markets/kickoff/tate.md` |
| **Aria** | Onchain: Anchor program, oracle integration, Phoenix CLOB binding | `/aria` | `.project/bell-markets/kickoff/aria.md` |
| **Bram** | Automation Service: morning create-markets, settlement nudger, oracle reads | `/bram` | `.project/bell-markets/kickoff/bram.md` |
| **Cleo** | Frontend: Next.js trade UI, wallet, real-time book + portfolio | `/cleo` | `.project/bell-markets/kickoff/cleo.md` |
| **Drew** | Quality + Integration + Demo: cross-cutting tests, $1 invariant proof set, demo script | `/drew` | `.project/bell-markets/kickoff/drew.md` |

Generic teammate types (`quality-lead`, `delivery-lead`, `implementation-lead`, `codebase-mapper`, `observability-security-teammate`) remain in `.claude/agents/` for one-off ad-hoc dispatches that don't fit any named lead's ongoing workstream. The generic `quality-lead` is intentionally `model: sonnet` for bias diversification when auditing Opus-written code (`constitution/hard-rules.md` §4.9).

---

## 3. Handoff discipline

### Per-session (every lead, every time)

Before `/clear` or session exit, each lead refreshes their handoff:

- **Tate** refreshes the global `CLAUDE_SESSION_HANDOFF.md` at repo root
- **Aria / Bram / Cleo / Drew** refresh their lead-specific handoff at `.project/bell-markets/handoffs/<name>-handoff.md`

The skill `.claude/skills/session-handoff/SKILL.md` walks the steps. Hard rule: no secrets, no raw oracle / RPC / wallet log dumps (>20 lines), no live oracle prices written into handoffs (per `hard-rules.md` §2.1).

### Daily sync (when multiple leads are active)

Run `/daily-sync` at start of day. The skill:
1. Prompts each active lead to self-attest current state by refreshing their own handoff first (no synthesis from stale handoffs).
2. Then Tate reads all the fresh handoffs and synthesizes the coordinated status report — what's shipped, what's in progress, what's blocked, what's next.

The default flow is lead-attested because synthesis from stale data gives stale conclusions.

### Mid-session (when a lead needs another lead's state)

Read the other lead's handoff directly via the junctioned `.project/bell-markets/handoffs/` — never DM them mid-session. Handoffs are the message bus.

If urgent: RAISE to Tate. Tate decides whether to interrupt the other lead's session or queue the question.

---

## 4. Cross-lead negotiation patterns

### Shared-file edits

Use `.project/bell-markets/coordination/<file-slug>.md` per the `file-ownership.md` protocol — announce, check, edit, clear. Examples of shared files:

- `README.md` (Tate primary + Drew demo section)
- `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` (Bram + Cleo + Drew — monorepo root)
- `scripts/devnet-deploy.sh` (Aria + Drew)
- `scripts/one-command-demo.sh` (Drew primary; Cleo coordinates if adding a frontend-launch step)

### Decision changes (modifying `constitution/decisions.md`)

A lead has discovered a reason to revisit a locked DR (e.g., Drew's property test reveals POV-2 is unenforceable as written).

1. **Lead RAISES to Tate** — does not silently edit `constitution/`.
2. Tate opens a thread in `.project/bell-markets/coordination/decisions-DR-NNN-revisit.md` describing the issue.
3. Each affected lead acknowledges (read the thread, comment if needed).
4. If consensus: new DR added (don't delete the old; mark old `Status: Superseded by DR-XYZ`). Tate makes the edit in the main checkout, MR-labeled `decisions:`.
5. Synced changes flow to BRAINLIFT.md §2 (POV section) in the same PR.

### Architecture changes (modifying `specs/architecture.md`)

Same protocol as decision changes, but route through a draft MR with architecture diff visible. If the change moves a component boundary, update the mermaid diagram in the same PR. Stale diagrams are worse than no diagram (per `specs/architecture.md` update protocol).

### Hard-rule additions (modifying `constitution/hard-rules.md`)

Hard rules can only be ADDED, never silently weakened. If a rule is genuinely wrong:

1. RAISE to Tate.
2. Tate writes a new DR explaining why the rule is being changed.
3. Mark the old rule `**Status: DEPRECATED (date)** — superseded by §X.Y`.
4. Don't delete the old rule — citations break.

### Scope disputes

Tate adjudicates. The model: leads can disagree; Tate picks. Disagreements get logged in `.project/bell-markets/coordination/scope-<topic>.md` so the decision is traceable.

### Load-bearing instruction reviews (Drew gatekeeping)

Any PR touching `programs/bell-markets/src/instructions/settle_market.rs`, `mint_pair.rs`, or `redeem.rs` — OR `apps/web/lib/solana/buy-no.ts` (+ `sell-no.ts`) — requires **Drew's sign-off** before merge:

- For program instructions: Drew runs the property-based invariant suite against the PR branch and reports PASS / BLOCK / NEEDS-FOLLOW-UP.
- For Buy No / Sell No frontend: Drew verifies atomicity (one signed tx) and that no intermediate Yes balance is exposed to the user (POV-3 / `hard-rules.md` §4.7).

If Drew is offline (e.g., end-of-day work), the PR waits. Drew's review is not optional for these paths.

---

## 5. Worktree pattern (Mode 2 — per-lead worktrees)

Each lead works in their own sibling worktree, with `.project/` and `.claude/` junctioned back to the main checkout. This gives:

- **Independent branch + working tree per lead** — they don't step on each other's checked-out files
- **Shared coordination state** — `.project/bell-markets/in-flight.md`, kickoffs, handoffs, sessions all live in the main checkout and are visible via junctions
- **Shared agent definitions + slash commands** — `.claude/agents/` and `.claude/skills/` similarly shared

### Layout

```
C:/Dev/GauntletAI/
├── BellMarkets/                  # main checkout — Tate works here on `main`
│   ├── .project/                 # → OneDrive (real location)
│   ├── .claude/                  # → OneDrive (real location)
│   └── <code>
├── BellMarkets-aria/             # worktree — Aria works here on crt/aria-<phase>
│   ├── .project/                 # → junction to ../BellMarkets/.project
│   ├── .claude/                  # → junction to ../BellMarkets/.claude
│   └── <code>
├── BellMarkets-bram/             # same pattern
├── BellMarkets-cleo/             # same pattern
└── BellMarkets-drew/             # same pattern
```

### Setup

```bash
# From the main checkout. Idempotent — skips existing worktrees.
bash scripts/setup-worktrees.sh
```

The script reads `LEADS=(aria bram cleo drew)` and creates each sibling worktree on its own branch with junctions in place.

### Teardown (when a phase ends)

```bash
# Critical order — ALWAYS remove junctions BEFORE git worktree remove.
# Otherwise rm -rf on the worktree follows the junction and nukes
# the main checkout's .project/ + .claude/.

cd ../BellMarkets-aria
cmd //c "rmdir .project"     # Windows: rmdir on a junction unlinks, doesn't recurse
cmd //c "rmdir .claude"
cd ../BellMarkets
git worktree remove ../BellMarkets-aria
```

Or use `scripts/lead-launchers.sh` (`start_<lead>`, `finish_<lead>` helpers) — safety preconditions are baked in.

### Lead-launcher helpers

`scripts/lead-launchers.sh` provides `start_aria`, `start_bram`, `start_cleo`, `start_drew` (sync the worktree's branch with main, run a check that junctions are intact) and `finish_<name>` (verify handoff is fresh before exit, then optionally tear down the worktree).

---

## 6. What this file is NOT

- **Not the workstream owner.** That's `constitution/file-ownership.md`.
- **Not the to-do list.** That's `.project/bell-markets/in-flight.md` plus each lead's handoff.
- **Not the meeting notes.** Those are `.project/bell-markets/sessions/`.
- **Not the constitution.** Coordination protocols live here; non-negotiable rules live in `constitution/hard-rules.md`.

This file documents the **protocols** — the rules of engagement. Daily state goes in the locations above.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
