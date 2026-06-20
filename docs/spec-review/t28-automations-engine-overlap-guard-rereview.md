# T28 Spec Re-Review - Automations Engine Overlap Guard

Verdict: approved

Sources reviewed:
- T28 rework response C5, prior spec finding C3, code review C2, and nuclear review C4.
- `knowledge/multicode/automations.md`.
- `src/main/automations/engine.ts`, `src/main/automations/engine.test.ts`, `src/main/automations/store.ts`, `src/main/automations/store.test.ts`.

Verification run during re-review:
- `npm run test:main` - passed.
- `npm run typecheck` - passed.

Re-review result:
- Prior KG finding resolved. `knowledge/multicode/automations.md` now documents that Automations timer ticks are serialized and that a tick fired while a timer evaluation is already in flight returns an empty result instead of overlapping store scans or racing `state.json` writes.
- Existing code-level requirements remain covered: `recordRun` has no discarded run-dir pre-scan, the timer overlap guard uses `timerEvaluation`, the slow-run regression covers skipped overlapping ticks plus preserved per-definition `in_flight`, and the 50-run bound remains covered by store tests.

Residual risk:
- None beyond the accepted implementation choice to skip overlapping timer ticks rather than queue a coalesced follow-up evaluation.
