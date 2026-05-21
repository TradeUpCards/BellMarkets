# Claude Session Handoff — BellMarkets

**Date:** _(filled by /session-handoff at first run)_
**Session phase:** Day 0 — initial setup; first substantive session not yet run
**Next hard gate:** Mon 2026-05-25 7:00 PM ET (Final). Informal MVP target: Fri 2026-05-22 9:00 PM ET.
**Current branch / SHA:** main @ _(filled by /session-handoff after first commit)_

---

## TATE — START HERE

This is a freshly-initialized project from `claude-code-project-template`. Run `/tate` to get your morning report. Then your first action will likely be:

- Verify git state (initial commit done, remote(s) set up)
- Read `.project/bell-markets/docs/prd/project_1771969779565.pdf` (the Meridian PRD — full project brief)
- Read `BRAINLIFT.md` (skeletal — needs `/brainlift` to fill) and `constitution/` + `specs/` (skeletal — need `/sdd-init` to fill)
- Read `.project/bell-markets/in-flight.md` for the workstream coordination map
- Recommend the Day 0 sequence: fill BRAINLIFT.md → fill SDD scaffolding → dispatch first lead (likely Aria for the Anchor program skeleton)

After your first substantive session, run `/session-handoff` to refresh THIS file with real state.

---

## Current Objective

BellMarkets is a non-custodial Solana dApp for trading binary outcome contracts on daily MAG7 stock prices, with $1 USDC payouts settled on-chain via a price oracle at 4PM ET (Gauntlet "Meridian" project).

Day 0 priority: convert the PRD into a defensible architecture (BRAINLIFT + SDD), then start the Anchor program skeleton + monorepo scaffolding.

_(Update this section after each session to reflect what we're trying to ship right now.)_

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
