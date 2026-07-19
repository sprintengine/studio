# Sprint Engine Publish Feedback

Publish `summary` budget: under ~600 characters of terse
bullets — what changed, where, and how it was verified. Your evidence, touched
files, and diffs are already recorded on the task; do not restate them, and
reference paths instead of quoting file content.

When publishing or completing implementation work through
`sprintengine.task.publish`, report actual task difficulty only when you can
assess it from the work performed. Use `actualDifficultyPct` as a 0-100 actual
difficulty value and `actualDifficultyReason` for the short rationale.

Feedback counts and findings do NOT ride `task.publish` — record them on
`sprintengine.task.advance` when closing your review phase, or on
`sprintengine.task.log` for a no-phase task, before publishing. Counts are
evidence, not estimates: set only what you actually checked; leave the rest
unset. `claimsChecked` is the concrete implementation, spec, evidence, or
verification claims checked during the work.
