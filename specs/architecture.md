# BellMarkets — Architecture

> System shape. Components, deployment, data flow, verification approach.
> When this file disagrees with code, fix one or the other — don't leave
> the gap.

---

## 1. Overview

[FILL IN: 2–4 sentences. What kind of system is this? Web app /
backend API / agent / data pipeline / multi-service / etc. What's the
one-line "what it does" version.]

### System diagram

```mermaid
[FILL IN: a diagram. Pick one shape:

- C4-style component diagram:
  graph TB
    User[User] --> Web[Web UI]
    Web --> API[Backend API]
    API --> DB[(Postgres)]
    API --> Cache[(Redis)]

- Agent/data-flow diagram:
  graph LR
    Input[User input] --> Router[Supervisor]
    Router --> Worker1[Worker A]
    Router --> Worker2[Worker B]
    Worker1 --> Verifier
    Worker2 --> Verifier
    Verifier --> Response

- Pipeline diagram:
  graph LR
    Source[Raw data] --> Parse[Parser]
    Parse --> Transform[Transform]
    Transform --> Sink[(Storage)]

Pick the one that matches your system. Delete the placeholder examples.
]
```

---

## 2. Components

### 2.1 [FILL IN: component name, e.g., "Frontend (React + Vite)"]

**Responsibility:** [FILL IN: what this component does + does not do]

**Tech:** [FILL IN: stack details]

**Talks to:** [FILL IN: which other components, via what protocol]

**Owned by:** [FILL IN: which lead — references `constitution/file-ownership.md`]

---

### 2.2 [FILL IN: next component]

**Responsibility:**

**Tech:**

**Talks to:**

**Owned by:**

---

### 2.3 [FILL IN: next component]

[Same shape]

---

## 3. Data model (if persistent)

[FILL IN: only if the project has persistent storage. Otherwise delete
this whole section. For systems with state:]

### Entities

[FILL IN: ER diagram or table list]

```mermaid
erDiagram
    [Entity1] ||--o{ [Entity2] : "relationship"
    [Entity2] {
        [type] [field]
        [type] [field]
    }
```

### Migrations

[FILL IN: how migrations are managed — tool, location, naming, review flow]

---

## 4. Deployment

### Environments

[FILL IN: dev / staging / prod, or simpler if this is a demo-only project]

### Build + deploy pipeline

[FILL IN: how code goes from MR → running. Tools, gates, who triggers,
rollback story.]

### Where it runs

[FILL IN: hosting — droplet / serverless / static site / cohort cluster /
partner-controlled infra]

### Secrets

[FILL IN: where they live, how they get into the runtime, who controls
rotation. Reference `constitution/hard-rules.md` §5 for the discipline
that's enforced.]

---

## 5. Verification approach

[FILL IN: how do we know the system is working correctly?]

- **Unit tests:** [scope, coverage target, file location]
- **Integration tests:** [scope, what they cover that unit tests don't]
- **Eval suite (if AI/agent project):** [number of cases, rubrics,
  PR-blocking gate criteria]
- **CI gate:** [what blocks merge specifically]
- **Manual smoke check:** [if any]

---

## 6. External dependencies

[FILL IN: services / APIs / data sources outside our control]

| Service | Used for | Failure mode if down | Mitigation |
|---|---|---|---|
| [e.g., OpenAI] | [LLM completions] | [agent unable to respond] | [fallback to Anthropic; honor request_id retries] |
| [e.g., Postgres on RDS] | [primary store] | [data layer down → full app outage] | [PITR backups; read replica] |

---

## 7. Things this architecture deliberately does NOT do

[FILL IN: bullet list. Reference `specs/deferred.md` for the full
rationale on each.]

- [e.g., No multi-region / multi-tenant — see deferred.md §2]
- [e.g., No real-time streaming layer — see deferred.md §4]

---

> **Template:** SDD v1 (from `claude-code-project-template` {{TEMPLATE_VERSION}})
> **Created:** {{INIT_DATE}}
>
> **Update protocol:** edit via MR. Update the mermaid diagram whenever
> a component boundary moves. Stale diagrams are worse than no diagram.
