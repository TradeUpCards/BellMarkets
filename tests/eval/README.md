# tests/eval — invariant proof set + oracle-failure scenarios

**Owner:** Drew. **Status:** Day-1 scaffold (Thu 2026-05-21).

## What lives here

The verification surface for the load-bearing invariants. Primary verification
is `scripts/simulate-trading-day.mjs` (the compressed-time lifecycle simulation —
Hard YES #1). This directory supplements it with parameterized edge-case
mocha tests for the cases the simulation doesn't naturally exercise.

- `invariants.md` — documents the 5 invariants this workstream verifies,
  how each is checked by the simulation, how a parameterized mocha test could
  supplement, and the failure mode if violated.
- `edge-cases.test.ts` — parameterized mocha cases (Day-1 stubs are
  `it.skip(...)`; implemented as Aria's instructions become testable).

## What is *not* here

- **No `proptest` (Rust) or `fast-check` (TypeScript)** — both were
  considered and dropped on Day 0. Per LESSONS.md Lesson 10, the
  compressed-time simulation catches multi-user contention bugs that
  property-based per-function tests miss; and a 3-day window doesn't have
  budget for a property-testing framework's learning curve. The mocha
  edge cases are the chosen supplement.

## How to run

**Day 1 (today):** stubs only — `it.skip(...)`. No CI gate yet.

**From Sat 2026-05-23 onward (once devDeps + Aria's IDL land):**

```bash
pnpm --filter @bell-markets/tests test:eval
```
