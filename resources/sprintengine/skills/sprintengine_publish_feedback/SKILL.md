# Sprint Engine Publish Feedback

Publish `summary` budget: under ~600 characters (2000 enforced) of terse
bullets — what changed, where, and how it was verified. Reviewers receive your
full evidence, touched files, and diffs in the gate prompt; do not restate
them, and reference paths instead of quoting file content.

When publishing or completing implementation work through
`sprintengine.task.publish`, report actual task difficulty only when you can
assess it from the work performed. Use `actualDifficultyPct` as a 0-100 actual
difficulty value and `actualDifficultyReason` for the short rationale.

Feedback counts are evidence fields, not estimates. Set counts only for claims,
requirements, failures, or risks you actually checked; leave fields unset when
you did not evaluate them. `claimsChecked` is the concrete implementation,
specification, evidence, or verification claims checked during the work.
