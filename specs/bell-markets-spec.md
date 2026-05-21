# BellMarkets — Behavior Spec

> What the system does, end-to-end. The contract between intent and
> implementation. The file partner reviews compare against. The file
> graders read first.

This file is project-type-specific. The sections below cover the most
common shapes; **delete the sections that don't apply, keep + fill the
ones that do.** If your project shape isn't represented, add new
sections that fit.

---

## 1. What the system does (1-paragraph)

[FILL IN: 3–6 sentences. The system in plain language — what it does
for the user, end-to-end. No internals, no architecture, no design
choices. Just "user does X, system does Y, result is Z."]

---

## 2. Users + roles

[FILL IN: who interacts with this system, and what they need from it]

### Primary user: [FILL IN: role]
- **Wants:** [FILL IN]
- **Needs (must-have):** [FILL IN]
- **Won't tolerate:** [FILL IN: e.g., latency > Xs, data loss, broken refresh]

### Secondary user: [FILL IN: role, if any]
- **Wants:**
- **Needs:**

### Operator: [FILL IN: who runs/maintains the system, if separate from users]
- **Needs:**

---

## 3. Core user journeys

### 3.1 [FILL IN: journey name, e.g., "First-time user signs up + onboards"]

**Trigger:** [FILL IN: what starts this]

**Steps:**
1. [FILL IN: user action]
2. [FILL IN: system response]
3. [FILL IN: ...]
4. [FILL IN: end state]

**Success criteria:** [FILL IN: how we know it worked]
**Failure modes:** [FILL IN: known ways this breaks; what we do then]

---

### 3.2 [FILL IN: next journey]

[Same shape]

---

### 3.3 [FILL IN: next journey]

[Same shape]

---

## 4. SECTION FOR ED-TECH / TUTOR PROJECTS

> Delete this whole section if not an ed-tech project.

### Learner journey

**Difficulty model:** [FILL IN: fixed levels / adaptive / hybrid]

**Feedback latency budget:** [FILL IN: ms]

**Session length:** [FILL IN: target time-on-task]

**Scaffold mode (if any):** [FILL IN: when triggered, what changes]

### Lesson structure

[FILL IN: how content is organized — single lesson / curriculum tree /
modular / etc.]

### Assessment

[FILL IN: how correctness is determined. **Critical** if any LLM is in
the path — the constitution must rule on whether LLMs can grade.]

---

## 5. SECTION FOR BACKEND API PROJECTS

> Delete this section if not an API project.

### Endpoints

| Method | Path | Purpose | Auth | Rate limit |
|---|---|---|---|---|
| [GET] | [/path] | [what it does] | [scheme] | [n/min] |
| [POST] | [/path] | [...] | [...] | [...] |

### Request/response schemas

[FILL IN: pointer to OpenAPI/JSON Schema, or inline shapes for the
critical endpoints]

### Error model

[FILL IN: how errors surface — HTTP status conventions, error envelope
shape, retryable vs terminal classification]

### Idempotency

[FILL IN: which endpoints are idempotent; how clients indicate
idempotency keys; how the server handles duplicates]

---

## 6. SECTION FOR AI / AGENT PROJECTS

> Delete this section if not an agent project.

### Agent loop

[FILL IN: state machine. Single-agent / supervisor + workers /
multi-agent with explicit coordination protocol / ...]

### Tools available to the agent

| Tool | Inputs | Outputs | Failure mode |
|---|---|---|---|
| [FILL IN] | [...] | [...] | [...] |

### Verifier

[FILL IN: what's checked, how, what triggers refusal. **Hard-rule
boundary** — the constitution should name what the verifier MUST catch.]

### Tool-use budget

[FILL IN: max calls per turn, max latency budget, cost ceiling per request]

### Hallucination / grounding discipline

[FILL IN: every claim must cite X / no LLM grades correctness / etc.]

---

## 7. SECTION FOR DATA-PIPELINE PROJECTS

> Delete this section if not a data project.

### Source data

[FILL IN: where it comes from, shape, freshness expectation]

### Transformations

[FILL IN: high-level — what gets normalized, joined, enriched]

### Sink

[FILL IN: where output lands, who reads it, freshness SLA]

### Schema evolution

[FILL IN: how schema changes are versioned + rolled out]

---

## 8. Edge cases + known constraints

[FILL IN: weird states the system has to handle. Empty inputs.
Concurrent edits. Refresh mid-flow. Browser tab close. Partial
network. etc.]

- **[Edge case 1]:** [how it's handled]
- **[Edge case 2]:** [...]

---

## 9. Non-goals (explicit)

[FILL IN: things this spec is NOT covering. Cross-reference to
`specs/deferred.md` for the full list of deferred features.]

- [Non-goal 1] — see `deferred.md`
- [Non-goal 2] — see `deferred.md`

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
>
> **Update protocol:** edit via MR. Major behavior changes get tagged
> `spec-change` so reviewers know to read carefully. Surface the change
> in the MR description with the user-visible delta.
