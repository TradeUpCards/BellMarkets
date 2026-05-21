# BellMarkets — File Ownership

> Who owns what, and how shared-file edits get coordinated. Single source
> of truth for cross-lead conflict avoidance.

## Why this file exists

When multiple named leads (Aria / Bram / Cleo / etc.) work in parallel
on the same project, they will collide if file ownership isn't named in
advance. This file is the **rule** that the gauntlet-team-lead persona
(`/tate`) enforces — refuse to dispatch a teammate onto another
teammate's owned territory without explicit coordination.

This file complements `.project/<slug>/in-flight.md` (which tracks
*active* work-in-progress collisions) by documenting the *baseline*
ownership map that doesn't change session-to-session.

---

## Lead workstream model

[FILL IN: 1-paragraph overview of how the work is split. Examples:
- "Aria owns implementation (agents + persistence + CLI). Bram owns
  quality (evals + content + meta-tests). Cleo owns delivery
  (README + setup docs + dashboard + demo)."
- "Two leads: Aria (backend + API) and Bram (frontend + UX). No third
  workstream this project."
]

---

## File ownership map

### Aria — [FILL IN: workstream name]

**Owned (Aria edits without coordination):**
- [FILL IN: `path/to/dir/**`]
- [FILL IN: `path/to/file.ts`]
- [FILL IN]

**Shared (Aria can edit but must announce in `.project/<slug>/coordination/` first):**
- [FILL IN: `README.md` (shared with Cleo)]
- [FILL IN]

**Off-limits (Aria does not edit):**
- [FILL IN: `tests/eval/**` (owned by Bram)]
- [FILL IN]

---

### Bram — [FILL IN: workstream name]

**Owned:**
- [FILL IN]

**Shared:**
- [FILL IN]

**Off-limits:**
- [FILL IN]

---

### Cleo — [FILL IN: workstream name]

**Owned:**
- [FILL IN]

**Shared:**
- [FILL IN]

**Off-limits:**
- [FILL IN]

---

## Shared-file coordination protocol

For files in any lead's "Shared" list:

1. **Announce intent.** Before editing, write a 1-line note in
   `.project/<slug>/coordination/<file-slug>.md`: "Aria taking
   `README.md` 2026-05-20 14:00 to add CI badge. ETA 30 min."
2. **Check for conflicts.** Read existing notes in that file. If another
   lead is already working on it, wait or negotiate scope.
3. **Edit + commit + clear.** Make your edits, push, then delete or
   strike-through your coordination note.
4. **No silent edits to shared files.** If you forgot to announce, the
   reviewer can ask you to revert + re-do with proper coordination.

For files in any lead's "Off-limits" list:

1. **Stop.** Don't edit.
2. **Negotiate.** Open a thread in `.project/<slug>/coordination/cross-lead-<topic>.md`.
3. **Decide together.** Either the owner takes the change, or ownership
   is renegotiated (update this file via MR).

---

## How `/tate` enforces this

When a teammate dispatch is requested, `/tate` checks:
- Does the dispatch's prompted edits cross any lead's "Off-limits" boundary?
  → Refuse. Explain which boundary. Suggest negotiation.
- Are there any unresolved `.project/<slug>/coordination/` notes touching
  the same files?
  → Defer until those resolve.
- Is the dispatch implicit-multi-lead (e.g., touching two leads' owned dirs)?
  → Require explicit acknowledgement of both leads before dispatching.

---

## Updating this file

Changes here are weighty — they reshape who can move on what. Update via:

1. Open a thread in `.project/<slug>/coordination/file-ownership-change.md`
   describing the proposed change.
2. Get acknowledgement from every affected lead.
3. Land via MR. Tag it `ownership-change` so reviewers know to read carefully.

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
