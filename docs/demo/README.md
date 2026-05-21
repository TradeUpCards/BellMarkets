# docs/demo — demo script, recording assets, cron-failure path documentation

**Owner:** Drew. **Status:** Day-1 scaffold (Thu 2026-05-21).

## What lives here

The narrative + operational documentation for the live demo Tate runs against
the deployed devnet stack. The actual reproducible lifecycle path is the
executable `scripts/one-command-demo.sh`; this directory holds the prose
that surrounds it.

- (planned) `demo-script.md` — Tate's narration outline for the demo run.
  Lands Sun 2026-05-24.
- (planned) `cron-failure-script.md` — the load-bearing DR-002 evidence
  path. The demo step where Bram's automation is killed mid-settle and a
  test user wallet triggers `settle_market`. Without this, DR-002 is
  theoretical. Hard YES #5. Lands Sun 2026-05-24.
- (planned) `test-coverage-proof.md` — meta-tests: deliberately break a
  fixture in a sandbox, watch the test fire, document. Proves the tests
  catch the bug they claim to.
- (planned) `recording-assets/` — screen-recording stills + GIFs (post-demo).

## Why the cron-failure path is load-bearing

DR-002 commits the project to permissionless `settle_market` — automation
is convenience, not authority. If we cannot demonstrate that the cron can
die and a user can crank settle themselves, the architectural commitment
is theoretical and the design's strongest interview narrative ("our cron
can fail and the system still works") collapses.

Hard YES #5: the demo MUST include this path. Drew owns the script;
Tate runs it during the final dry-run before submission.
