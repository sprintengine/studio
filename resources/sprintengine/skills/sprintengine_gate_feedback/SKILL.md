# Sprint Engine Gate Feedback

State each finding exactly **once**. `requiredAction` is the single inline source
of truth for findings and is what later rework and review prompts inline — put
one single-line action per finding there ("path — defect — required fix"). Do not
restate that finding in `summary` or `findingJson`. Full review depth belongs in
the review artifact file submitted via `artifactPath`, not in the verdict fields.

`summary` is a short verdict rationale written for agent readers — keep it under
~280 characters. Give the verdict shape (what passed, how many findings, the
headline issue) and point to the required actions and artifact; do not restate
the task card, the evidence, or the individual findings.

If the review context lists a known finding from another gate, do not
re-describe it: verify it within your scope and confirm it by comment id in
`requiredAction` (`confirms C7 — <scope note>`). Write up only findings that are
new; a confirmed finding is fixed once for every gate that filed it.

## Telemetry fields

Telemetry is best-effort and never blocks the verdict — but report it
accurately, and only for things you actually evaluated. Leave a field unset
rather than guessing; the server drops an invalid optional field with a warning
instead of recording a fabricated value.

`findingJson` is **categorical telemetry only**: each entry is `{kind, severity,
area, title?}` where `title` is a short label, not a sentence. Do not write
`detail` or `recommendation` — the actionable text already lives in
`requiredAction`, and nothing reads finding prose downstream.

Use feedback count fields only for evidence you actually evaluated:

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
`security`, `performance`, and `coordination`. Keep `reviewedDifficultyReason` to
one short line and do not restate a finding in it.

These budgets cap how findings and evidence are *written*, never how much you
check — report every real finding, tersely.
