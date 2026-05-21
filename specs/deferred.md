# BellMarkets — Deferred

> What we explicitly chose NOT to build (or NOT to build *yet*) — with
> rationale and revisit threshold. The opposite of a wish list: every
> entry here was considered and deliberately declined.

## Why this file matters

Two reasons:

1. **Defensible deferrals are different from gaps.** A grader / partner /
   future-maintainer who reads "we didn't ship X" will assume neglect
   unless the doc says "we chose not to ship X because Y." This file is
   that doc.
2. **Revisit thresholds prevent indefinite deferral.** A deferral
   without a re-evaluation trigger becomes an indefinite punt. Each
   entry here names *when* to look at it again.

---

## Format

Each entry uses this shape:

```
### [Short title — what's deferred]

**Status:** Deferred to [v2 / v3 / post-pilot / next cycle / specific date]
**Decided in:** [DR-NNN in constitution/decisions.md, if any]
**Decided on:** YYYY-MM-DD

**What we considered:** [1–2 sentences — what the feature/path looked like]

**Why deferred:**
- [Reason 1 — be specific. "Not enough time" isn't enough; "estimated 12h
  vs 30h budget remaining for MVP" is.]
- [Reason 2]

**Trade-off accepted:** [What this deferral costs us. There's always a
cost — name it.]

**Revisit threshold:** [SPECIFIC trigger. Examples:
- "After 2026-05-22 demo"
- "When partner X confirms pilot timing"
- "If user count exceeds 50"
- "Before any production deploy"
NOT: "Eventually" / "When we have time" / "TBD"]

**Re-evaluation owner:** [Who notices when the threshold trips — name,
role, or process]
```

---

## Deferred entries

### [FILL IN: example — "Multi-tenant teacher dashboard"]

**Status:** Deferred to v2
**Decided in:** [FILL IN: DR-NNN, if any]
**Decided on:** {{INIT_DATE}}

**What we considered:** [FILL IN: a teacher-facing dashboard showing
multiple students' progress across the fraction-equivalence module]

**Why deferred:**
- [FILL IN: e.g., "MVP scope = learner experience only; teacher view
  needs auth + multi-row state which 30h doesn't buy"]
- [FILL IN]

**Trade-off accepted:** [FILL IN: e.g., "Demo can't show teacher use
case; have to verbalize it in the AI Interview instead of demoing"]

**Revisit threshold:** [FILL IN: e.g., "When/if Synthesis-style pilot
with a real teacher is scheduled"]

**Re-evaluation owner:** [FILL IN: e.g., Cory]

---

### [FILL IN: next deferral]

**Status:**
**Decided in:**
**Decided on:**

**What we considered:**

**Why deferred:**
-

**Trade-off accepted:**

**Revisit threshold:**

**Re-evaluation owner:**

---

> Aim for clarity over completeness. 3–8 well-documented deferrals beat
> 20 thin ones. If something genuinely doesn't need deferral context
> (e.g., "we're not building a mobile app for this 3-day demo"), it can
> live in `specs/bell-markets-spec.md` §9 (Non-goals) as a one-liner
> instead.

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
>
> **Update protocol:** edit via MR whenever a deferral is made. Each
> deferral entry should reference the DR-NNN in constitution/decisions.md
> that locked the decision. When a revisit threshold trips, EITHER ship
> the deferred feature OR add a new entry explaining the re-deferral
> (don't silently keep the old entry alive past its trigger).
