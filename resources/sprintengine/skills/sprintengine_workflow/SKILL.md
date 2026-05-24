# Sprint Engine Workflow

Coordinate through Sprint Engine commands rather than editing run-store files directly. Claim or resume only tasks and gates assigned to your current role, read the task card and acceptance criteria, keep edits within owned paths unless a small companion change is required, and log every touched file and verification command as evidence.

When the work is ready, publish implementation evidence so required quality gates can review it. If the task is blocked, move it to `needs_input` with the correct actor, reason, question, and suggested resolution instead of marking it done.

When Auto Mode is enabled, run `sprintengine join --role <role> --id <agent-id> --watch` after completing or publishing work so the CLI can reconcile dispatches, resume rework, claim eligible developer work, or stop according to the run configuration.

Benchmark feedback counts and difficulty fields are optional evidence fields.
Use them only when grounded in work you actually evaluated. `claims_checked`
counts concrete claims checked; defect count fields count observed issues such
as hallucinated claims, factual errors, missed requirements, implementation
mistakes, regressions, introduced test failures, and unsafe changes. Architects
may use `--difficulty-pct`; implementers may use `--actual-difficulty-pct`;
reviewers and testers may use `--reviewed-difficulty-pct` with a reviewed
difficulty dimension. Do not guess missing counts or difficulty values.
