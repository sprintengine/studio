# Sprint Engine Gate Feedback

When submitting a Sprint Engine gate verdict with `sprintengine.gate.verdict`,
use feedback count fields only for evidence you actually evaluated:

- `claimsChecked`: concrete implementation, specification, evidence, or verification claims checked.
- `hallucinatedClaims`: checked claims unsupported by repo, task, evidence, or observed behavior.
- `factualErrors`: checked claims contradicted by source, docs, tests, state, or runtime evidence.
- `missedRequirements`: required acceptance, task, or plan items absent or only partially implemented.
- `implementationMistakes`: code, state, schema, routing, integration, or workflow defects in the delivered work.
- `regressionCount`: previously working behavior or contract broken by the change.
- `testFailuresIntroduced`: new failing tests or reproducible validation failures caused by the change.
- `unsafeChanges`: security, data-loss, destructive-operation, privacy, or permission risks introduced by the change.

Use `reviewedDifficultyPct`, `reviewedDifficultyDimension`, and
`reviewedDifficultyReason` only when you assessed reviewed difficulty. Valid
dimensions are `implementation`, `review`, `verification`, `product_spec`,
`security`, `performance`, and `coordination`. Do not guess counts or difficulty
values you did not evaluate.
