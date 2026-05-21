# IDL drop zone

`bell_markets.json` is intentionally empty (`{}`) on Day 1.

**Aria** copies `target/idl/bell_markets.json` here after her first successful
`anchor build`. The frontend Anchor client (`src/lib/solana/anchor.ts`) returns
`null` from `useBellMarketsProgram()` until the file contains a real IDL with
`instructions`, `accounts`, etc.

Do **not** hand-edit this file — it's a generated artifact.
