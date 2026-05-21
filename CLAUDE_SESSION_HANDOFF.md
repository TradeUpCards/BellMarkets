# Claude Session Handoff — BellMarkets

**Date:** 2026-05-21 (Thu evening, EOD)
**Session phase:** **Day 0 complete; Day 1 ready to dispatch all 4 leads in parallel.**
**Next hard gate:** Mon 2026-05-25 7:00 PM ET (Final). Informal MVP target: Fri 2026-05-22 9:00 PM ET.
**Current branch / SHA:** main @ `709a00b` (presearch ARCHITECTURE.md + LESSONS.md recalibrations). 6 commits total on Day 0; all pushed to GitLab + GitHub.

---

## TATE — START HERE

**Day 0 is complete.** BRAINLIFT.md filled (147 lines), constitution/ + specs/ populated, ARCHITECTURE.md written via /presearch-interview, Drew promoted from generic quality-lead to a named 4th lead, all INFERRED tags resolved, LESSONS.md recalibrations applied (Anchor 0.31.1 / Solana 3.1.14 / React 18 / Next 14.2.18 / vendored Pyth parser / Phoenix UncheckedAccount pattern / compressed-time simulation as primary verification). All 4 leads have populated first-task kickoffs at `.project/bell-markets/kickoff/{aria,bram,cleo,drew}.md`.

**On next session start, your first action sequence:**

1. Run `git fetch origin main` (sync from possible lead pushes overnight)
2. Read `.project/bell-markets/in-flight.md` for active workstream status
3. Read each lead's handoff at `.project/bell-markets/handoffs/{aria,bram,cleo,drew}-handoff.md` — they should exist after their first sessions
4. Surface the 4-line morning report (days to gate, build state, lead status, recommendation for today)
5. Run `/daily-sync` to refresh + synthesize all 4 lead states into a single coordinated status

The build timeline is in `docs/TIMELINE.md` (Gantt + per-lead Day-1 deliverables + risks). Critical gate: **Sat 5/23 6pm ET — Aria's first devnet deploy** unblocks live integration for the other 3 leads.

---

## Current Objective

Ship the Gauntlet "Meridian" submission: non-custodial Solana dApp for binary outcome contracts on daily MAG7 stock prices, $1 USDC invariant payouts, on-chain Pyth settlement at 4:05 PM ET, Phoenix CLOB. Final deadline: Mon 2026-05-25 7:00 PM ET.

**Day-by-day plan:**
- **Day 0 (Thu 5/21, DONE):** Brainlift + SDD + presearch + Drew roster + LESSONS.md recalibrations. 6 commits pushed.
- **Day 1 (Fri 5/22):** All 4 leads scaffold their workstream packages in parallel — see `docs/TIMELINE.md` for per-lead deliverables. Target by 9pm ET: 4 worktree branches with passing scaffold-level work.
- **Day 2 (Sat 5/23):** Aria deploys first devnet program (CRITICAL gate at 6pm ET); Cleo wires trade buttons to live program; Bram wires jobs to deployed program; Drew runs compressed-time simulation against real chain.
- **Day 3 (Sun 5/24):** Bug-fix iteration; cron-failure demo path scripted; demo video recorded; defense narrative written.
- **Day 4 (Mon 5/25):** Demo dry-runs; final commits + grader-handoff verification before 7pm ET hard final.

---

## Decisions Made

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| 1 | Package manager | pnpm (always — never npm/yarn) | User preference; pnpm workspaces fit the multi-package monorepo (apps/web, services/automation) |
| 2 | Lead setup | Option C named leads (Aria/Bram/Cleo/Drew) | 4 distinct workstreams: onchain, automation, frontend, and cross-cutting quality+integration+demo. Drew was promoted from generic quality-lead to a named 4th lead on Day 0 |
| 3 | Worktree mode | Mode 2 (per-lead worktrees, sibling `BellMarkets-<lead>`) | Sustained multi-day parallel work between contract + service + frontend |
| 4 | Doc weight | Both Brain Lift + SDD from day one | User explicitly chose both — not the migration path; want the constitution scaffolding live before any code |
| 5 | License | Apache 2.0 | Explicit patent grant is helpful for crypto/DeFi |

_(Append decisions as they accumulate. Promote significant ones to `constitution/decisions.md`.)_

---

## Files Touched (this session)

This Day-0 setup session via `/use-template`:
- Created `LICENSE` (Apache 2.0), `.gitignore` (Node + excludes `/.project/`, `/.claude/`)
- Filled placeholders in `BRAINLIFT.md`, `constitution/**`, `specs/**`, `.claude/agents/{aria,bram,cleo}.md`, `.claude/skills/{aria,bram,cleo,tate}/SKILL.md`, `.project/bell-markets/**`
- Renamed `.project/PROJECT/` → `.project/bell-markets/`, `specs/PROJECT-spec.md` → `specs/bell-markets-spec.md`
- Generated `scripts/setup-worktrees.sh` (Mode 2 helper)
- Made first commit

---

## Tests / Evals Status

N/A on Day 0. No code yet.

---

## Risks + Blockers

### P0 (blocks shipping)
_(none on Day 0)_

### P1 (significant)
- PRD has tight scope across 3 disciplines (Solana / TS service / Next.js). Risk: any one slice slipping kills the lifecycle demo. Mitigation: 4-lead split with quality-lead owning the create→mint→trade→settle→redeem integration.

### P2 (track but not blocking)
- Node-only `.gitignore` ships without Rust/Anchor patterns — append `target/`, `.anchor/`, `test-ledger/` once Anchor scaffolding starts.

---

## Recommended Next PM Prompt

For Day 0:
```
Read CLAUDE_SESSION_HANDOFF.md, the PRD at .project/bell-markets/docs/prd/project_1771969779565.pdf, and the skeletal BRAINLIFT.md + constitution/ + specs/.
Restate the BellMarkets mission, the 3-workstream split, and the highest-leverage first move.
Recommend: do we run /brainlift first, /sdd-init first, or skip both and start scaffolding the monorepo?
Wait for my confirmation before any work.
```

---

## Recommended Next Agent-Team Formation

For Day 0 / first session: Solo Tate. No leads dispatched yet — first job is to fill the constitution scaffolding, then dispatch Aria for Anchor skeleton.

---

## Hard Rules (do not violate)

- No secrets / API keys / OAuth tokens / HMAC secrets in any committed file. Use `.env` (in `.gitignore`).
- No private keys / mnemonics / wallet seed phrases in any committed file. **Never use mainnet or real funds for the core submission** (per PRD).
- No log dumps (>20 lines of raw output) in handoffs or session recaps.
- No `git push --force` to `main` without explicit user request.
- **Always use pnpm** — never `npm` or `yarn`. Lockfile is `pnpm-lock.yaml`. If a tool's docs say `npm install`, translate to `pnpm install`.
- `/.project/` and `/.claude/` are local-only / OneDrive-mirrored — never commit them to git.
- Block session exit if `CLAUDE_SESSION_HANDOFF.md` hasn't been refreshed since the last meaningful state change.

_(Add project-specific hard rules here as they emerge — and promote them into `constitution/hard-rules.md`.)_

---

## Session Handoff Discipline

Before `/clear` or session exit, run `/session-handoff` to refresh this file. The skill at `.claude/skills/session-handoff/SKILL.md` walks the steps.

If you're a named lead (Aria/Bram/Cleo), write to your lead-specific handoff at `.project/bell-markets/handoffs/<name>-handoff.md` instead of this global file. Tate owns this global file.
