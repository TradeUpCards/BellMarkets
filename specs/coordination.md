# BellMarkets — Coordination

> Workstream model + lead handoff discipline + cross-lead negotiation
> patterns. The operational complement to `constitution/file-ownership.md`.

`file-ownership.md` says *who* owns what; this file says *how* the work
moves across leads.

---

## 1. Workstream model

[FILL IN: 1-paragraph summary of how the work is decomposed. Examples:

- "Three parallel workstreams: Aria (implementation), Bram (quality +
  evals), Cleo (delivery + docs). Each lead has their own worktree
  branched from main; daily sync (`/daily-sync`) at start of day to
  pull each other's merged work."
- "Two linear phases: Phase 1 (Aria — backend scaffolding) blocks
  Phase 2 (Bram — frontend). Sequential, single worktree, no
  parallelism."
- "One lead (solo Tate). No coordination needed."

Pick the actual shape. Don't model parallelism you don't have.]

---

## 2. Lead identities + boot prompts

[FILL IN: each lead's identity + how to invoke. If using the named-lead
pattern from this template (Option C in /use-template), there's already
a `/aria`, `/bram`, `/cleo`, `/tate` slash command per lead.]

| Lead | Identity / focus | Boot via | Kickoff prompt at |
|---|---|---|---|
| Tate | Team lead — coordinates everyone | `/tate` | `.project/<slug>/kickoff/tate.md` |
| Aria | [FILL IN] | `/aria` | `.project/<slug>/kickoff/aria.md` |
| Bram | [FILL IN] | `/bram` | `.project/<slug>/kickoff/bram.md` |
| Cleo | [FILL IN] | `/cleo` | `.project/<slug>/kickoff/cleo.md` |

---

## 3. Handoff discipline

### Per-session (every lead, every time)

Before `/clear` or session exit, each lead refreshes their handoff:

- **Tate** refreshes the global `CLAUDE_SESSION_HANDOFF.md` at repo root
- **Aria/Bram/Cleo** refresh their lead-specific handoff at
  `.project/<slug>/handoffs/<name>-handoff.md`

The skill `.claude/skills/session-handoff/SKILL.md` walks the steps.

### Daily sync (when multiple leads are active)

Run `/daily-sync` at start of day. The skill prompts each lead to
self-attest their current state by refreshing their own handoff first
(no synthesis from stale handoffs), then Tate synthesizes the coordinated
status report.

### Mid-session (when a lead needs another lead's state)

Read the other lead's handoff directly — never DM them mid-session.
Handoffs are the message bus.

---

## 4. Cross-lead negotiation patterns

### Shared-file edits

Use `.project/<slug>/coordination/<file-slug>.md` per `file-ownership.md`
protocol — announce, check, edit, clear.

### Decision changes (something in `constitution/decisions.md` needs updating)

1. Open thread in `.project/<slug>/coordination/decisions-DR-NNN-revisit.md`
2. Each affected lead acknowledges
3. Land via MR with `decisions:` label
4. Reference the new DR in any code change that depends on it

### Scope disputes

Tate adjudicates. The model: leads can disagree; Tate picks. Disagreement
gets logged in `.project/<slug>/coordination/scope-<topic>.md` so the
decision is traceable.

### Architecture changes (something in `specs/architecture.md`)

Same protocol as decision changes but route through a draft MR with
architecture diff visible before merging.

---

## 5. Worktree pattern (if using Mode 2 or Mode 3)

[FILL IN: only if using per-lead worktrees. Otherwise delete this section.]

- Worktrees live at `$PROJECT_PARENT/$PROJECT_NAME-<lead>` on branch `<prefix>/<lead>-<phase>`
- `.project/` and `.claude/` are junctioned from each worktree → main checkout
- Use `scripts/lead-launchers.sh` (`start_<lead>`, `finish_<lead>`) — the
  safety preconditions are baked in
- Reference: `WORKTREE_PATTERNS.md` for the full pattern

---

## 6. What this file is NOT

- **Not the workstream owner.** That's `constitution/file-ownership.md`.
- **Not the to-do list.** That's `.project/<slug>/in-flight.md` plus each
  lead's handoff.
- **Not the meeting notes.** Those are `.project/<slug>/sessions/`.

This file documents the **protocols** — the rules of engagement. Daily
state goes in the locations above.

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
