# BellMarkets — Brain Lift

> Single source of truth for AI coding assistants working on this project.
> Read this before writing code. If you'd contradict something here, stop and ask.
>
> **Status:** Draft. Fill in `[FILL IN: ...]` markers before the first
> `/aria` / `/bram` / `/cleo` dispatch. Re-edit any section as the project's
> understanding of itself changes.

---

## 1. Context

### What this is

[FILL IN: 1–2 sentences. Concrete enough that an AI assistant can refuse
off-scope work. Bad: "an app for users." Good: "a web app where front-desk
staff upload scanned lab PDFs and a 2-stage extraction pipeline writes
verified facts into OpenEMR's clinical tables with audit trails."]

### Why it exists

[FILL IN: Stakes, audience, deadline. Why does this project need to exist
this week / this quarter? "Gauntlet Week N cohort exercise — judges
evaluate X" / "hiring partner deliverable — partner is evaluating Y" /
"production replacement for legacy system Z — switchover date W".]

### Who uses it

[FILL IN]
- **Primary user:** [role + context]
- **Secondary user:** [role + context]

If unknown, write `[UNKNOWN — confirm in presearch-interview]`.

### Stage of build

[FILL IN: e.g., "Day 0 — repo bootstrapped, no app code yet" /
"Mid-MVP — auth + 2 endpoints shipped, dashboard in progress" /
"Hardening — feature freeze, fixing eval regressions"]

### Deadlines

- **MVP:** Fri 2026-05-22 9:00 PM ET (informal target; not a hard gate)
- **Final:** Mon 2026-05-25 7:00 PM ET
- **Other:** [FILL IN: AI Interview / partner demo / cohort review window]

### Out of scope (for this build, by deliberate choice)

[FILL IN: bullet list. Be specific. "No mobile app" beats "no extras".
Common: "no user accounts", "no i18n", "no multi-tenant", "no offline mode".]

- ...

---

## 2. Spiky Points of View

> Strong opinions baked into the architecture. Disagreeing with one means
> redesigning the project, not patching it. Every POV has a documented
> trade-off — own it.

### POV 1 — [FILL IN: short title]

[FILL IN: 2–4 sentences. Stake the position. Name the trade-off it
accepts. Reference budget / constraint / data that justifies it.]

**Trade-off:** [What this position costs. "We pay X in exchange for Y."]

### POV 2 — [FILL IN]

[...]

**Trade-off:** [...]

### POV 3 — [FILL IN]

[...]

**Trade-off:** [...]

> Add more POVs as the project demands. 3–6 is a healthy range. Fewer and
> the AI assistant has too much freedom; more and you're over-engineering.

---

## 3. The Knowledge Tree

### Tech Stack

[FILL IN each line; mark `[INFERRED — CONFIRM]` if not yet decided]

- **Frontend:**
- **Backend:**
- **Language:**
- **State management:**
- **Database:**
- **Testing:**
- **Linting:**
- **Deployment:**
- **CI gate:** (what specifically blocks merge? Vitest pass? Eval threshold? Type-check?)

### Repo layout (target)

```
[FILL IN: tree diagram of the planned file structure. Even if speculative,
having a target shape prevents AI assistants from spraying files everywhere.]
```

### Domain primitives (build these FIRST, before any UI / API)

```
[FILL IN: the 3–6 typed primitives that everything else composes from.
Function signatures + types are enough — no implementations. Example:

type PatientId = number;
type Fraction = { num: number; den: number };
function isEquivalent(a: Fraction, b: Fraction): boolean;
]
```

### Critical files (when they exist)

[FILL IN: name the load-bearing files and what's load-bearing about them.
"A bug in this file silently passes wrong answers as correct." If a file
isn't critical, don't list it.]

- **`path/to/file.ts`** — [what makes it load-bearing]

### External references

[FILL IN: links, papers, reference implementations, partner docs, PRD
locations. Only what the AI assistant needs to make decisions — not a
literature dump.]

### Decisions log

Maintain `DECISIONS.md` at repo root. Every spiky POV gets an entry with
its trade-off. Every deferral gets an entry with a revisit threshold.

### Where local-only coordination memory lives

- `.project/in-flight.md` — workstream rules + file ownership map
- `.project/kickoff/` — lead boot prompts
- `.project/handoffs/` — per-lead handoff files
- `.project/sessions/` — per-session recaps
- `.project/stories/` — interview-ready story repo
- `CLAUDE_SESSION_HANDOFF.md` (repo root) — primer for fresh Tate sessions

`.project/` is gitignored. Never committed. Mirrored to OneDrive for survivor copies.

---

## 4. Guardrails

### Hard NOs for AI coding assistants

[FILL IN: specific prohibitions. "Do not use Redux" beats "keep state
simple". 5–10 items is a healthy range. The list earns its keep by
preventing AI assistants from making the same mistake twice.]

1. [FILL IN]
2. ...

### Hard YESes

[FILL IN: non-negotiable requirements. Same shape as the NOs.]

1. [FILL IN]
2. ...

### Things to *flag for human review* (not auto-block)

[FILL IN: actions the AI should pause and confirm before taking, but
isn't outright banned from. "Any new dependency — post to chat with 1-line
why before npm install." Different from a Hard NO — these are reviewable,
not refused.]

- ...

---

> **Created:** {{INIT_DATE}}
> **Template:** brainlift v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Owner:** {{OWNER_NAME}}
> **Update cadence:** Every Brain Lift item that changes during a session
> gets a same-session edit. End-of-week, sweep for `[INFERRED — CONFIRM]`
> tags that have been resolved.
