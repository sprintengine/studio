# Legacy run store (real copy)

A copy of a real Sprint Engine run store — `mobile-relay-traffic-efficiency2`,
run to completion on 2026-07-19 under the retired architectures — captured for
`tests/sprintengine_tool/test_legacy_run_key_tolerance.py`. It exists so
backward tolerance is proven against a store the product actually wrote, not a
hand-built fixture that only contains what the test author remembered.

Copied verbatim: `run.yaml` (`schemaVersion: 4`, the version the engine still
supports), `tasks/`, `artifacts/`, `metrics/`, `runner/`, `events.jsonl`,
`dispatch.jsonl`, `automation.json`, `plan.md`.

Four deliberate deviations from the source store:

- **`worktree/` and `projection.json` are omitted.** The worktree is a git
  checkout with no bearing on store loading, and `projection.json` is a derived
  cache full of absolute machine paths — the engine rebuilds it.
- **One absolute path in `automation.json` was replaced with `<team-dir>`.** It
  was the capture machine's own store path in a delivered-notification key.
- **Knowledge-graph note paths were re-prefixed.** The run's prose cited notes
  under a `knowledge/` root that this repo no longer carries; the prefix was
  rewritten to `docs/` so the fixture holds no dangling reference. Nothing the
  store loader reads was touched.
- **`rosterSource` and `allowedRuntimes` were added to `run.yaml`.** Every real
  store on the capture machine carries `requiredSweeps` (this one's four entries
  are real), but none carries the other two: they were written only by
  `--roster-source` / `--allowed-runtimes-json` at init, which the app never
  passed for these runs. They are written here in the exact shape the retired
  `apply_roster_source` / `apply_allowed_runtimes` produced — a
  `'user' | 'architect'` scalar and a list of `{cli, model}` objects with
  `model: null` meaning "that CLI's own default".

Nothing else was edited. Do not regenerate this fixture from the current
engine: a store the current engine writes cannot carry the retired keys, which
is exactly what the test needs to exercise.

Older real stores exist at `schemaVersion` 2 and 3. Those are not a tolerance
case — the engine refuses them by design with a "delete and re-run" message, so
they would prove nothing about a key being inert.
