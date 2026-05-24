# Sprint Engine Workflow

Coordinate through Sprint Engine MCP tools rather than editing run-store files directly. Claim or resume only tasks and gates assigned to your current role, read the task card and acceptance criteria, keep edits within owned paths unless a small companion change is required, and log every touched file and verification command as evidence.

When the work is ready, publish implementation evidence via `sprintengine.task.publish` so required quality gates can review it. If the task is blocked, move it to `needs_input` via `sprintengine.task.status` with the correct actor, reason, question, and suggested resolution instead of marking it done.

When a returned directive includes `nextMcpToolName`, invoke that MCP tool once
with `nextMcpArguments`. After completing or publishing work in Multicode,
publish the required evidence/verdict and let the runtime own later dispatch
and continuation. Standalone/headless CLI users can still use `join --watch` for
polling/backoff outside the managed Multicode runtime.

Benchmark feedback counts and difficulty fields are optional evidence fields on
publish/verdict payloads. Use them only when grounded in work you actually
evaluated. `claimsChecked` counts concrete claims checked; defect count fields
count observed issues such as hallucinated claims, factual errors, missed
requirements, implementation mistakes, regressions, introduced test failures,
and unsafe changes. Architects may use `difficultyPct` on
`sprintengine.plan.add_task`; implementers may use `actualDifficultyPct` on
`sprintengine.task.publish`; reviewers and testers may use
`reviewedDifficultyPct` with `reviewedDifficultyDimension` on
`sprintengine.gate.verdict`. Do not guess missing counts or difficulty values.
