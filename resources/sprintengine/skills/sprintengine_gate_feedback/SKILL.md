# Sprint Engine Gate Feedback

Verdict shape: `summary` is a short verdict rationale written for agent
readers (keep it under ~2000 characters) — do not restate the task card or
evidence. Put one single-line required action per finding in `requiredAction`
("path — defect — required fix"). Full
review depth belongs in the review artifact file submitted via `artifactPath`;
later rework and review prompts inline your summary and actions, not the file.
For structured findings, add `findingJson` entries (`{kind, severity, area,
title, detail, file?, recommendation?}`). These budgets cap how findings are
written, never how much you check — report every real finding, tersely.

If the review context lists a known finding from another gate, do not
re-describe it: verify it within your scope and confirm it by comment id in
`requiredAction` (`confirms C7 — <scope note>`). Write up only findings that
are new; a confirmed finding is fixed once for every gate that filed it.

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
