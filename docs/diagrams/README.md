# BellMarkets — Diagrams

Static Mermaid diagrams that render inline in GitHub, Cursor, Notion,
and any markdown previewer. No tooling, no dev server — open the file
and read.

## Files

| File | Content |
|---|---|
| `system-overview.md` | 8 diagrams covering: system flowchart, C4 Context, C4 Container, sequence diagrams for Buy No / settle / permissionless-settle / full trader lifecycle, Pyth data flow |

## When to use which doc

The project has three architecture artifacts, by depth:

| Doc | Format | When to reach for it |
|---|---|---|
| **`docs/diagrams/system-overview.md`** (this dir) | Static Mermaid in markdown | **Default.** Skim 10-15 seconds per diagram. Paste into PRs / Notion / email. Walk for interview defense. |
| `ARCHITECTURE.md` (repo root) | Decision Record table + narrative | "Why did we choose this approach?" — the *rationale* layer |
| `docs/architecture/*.c4` | Interactive LikeC4 explorer | "Let me drill from container to component to specific instruction." For ongoing engineering work, not interview slides |

If a reviewer asks for *one* thing, hand them `system-overview.md`. The
LikeC4 model is a power-user tool; most viewers don't need it.

## Editing

Open `system-overview.md` in Cursor. Mermaid diagrams are fenced code
blocks (` ```mermaid `). The Cursor markdown preview renders them live.
Same for GitHub when you push.

If a diagram needs to evolve:
- A diagram becomes load-bearing for a flow we keep explaining → promote it to its own file
- Two diagrams say the same thing differently → consolidate
- Architecture changes → update both this file AND the LikeC4 model (`docs/architecture/`)
