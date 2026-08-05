# Sprint Engine Workflow

Coordinate through Sprint Engine MCP tools; never edit run-store files directly. If the managed MCP server is unreachable, stop and report the failure. Claim or resume only tasks assigned to your role, read the task card and acceptance criteria, and log every touched file and verification command as evidence.

## You Own Your Task From Claim To Done

No other agent reviews your work. Implement, then publish with `sprintengine.task.publish`. The engine detects whether you produced a diff:

- **A diff** — the task enters its review phase and the publish response carries your review directive (`nextDirective`). Follow it: read your own diff adversarially, fix everything you find, commit fixes scoped to the task, then close the phase with `sprintengine.task.advance`.
- **No diff** — the task lands in `done`; analysis-only tasks and clean reviews end here.

In worktree-mode runs `task.publish` also commits your task-scoped changes in your task's project worktree, under that project's own commit lock.

## Commit Scope

Paths are relative to your task's one project (`repo`). Commit scope is what you CHANGED: self-report changed files at publish (`--changed-path`); those are committed. Never edit `ownedPaths` (an advisory collision hint only). Leftover dirty paths that are not yours are a sibling's: leave them. Log a far-outside edit as `scopeExpansionJson` via `sprintengine.task.log`; go `needs_input` before scope changes or sibling overlap.

## Escalate Only What You Must Not Invent

You are trusted to finish the task. Derive answers yourself from the task card, the plan, the Knowledge Graph, and the code. **Never escalate to have your work confirmed, reviewed, or approved.**

Escalate (`sprintengine.task.advance` with `outcome: escalate`, or `sprintengine.task.status` with `needs_input`) only when the plan contradicts itself, acceptance is impossible as written, the scope is wrong, or finishing means inventing a product decision that is not yours to make.

Compile errors, failing tests, review findings, and validation gaps are yours to fix. Classify real blockers with `--needs-input-kind`: `architect` for stale plans, impossible acceptance, wrong paths, or scope mismatches; `user` for product decisions, approvals, hardware, credentials, or another outside check.

## Dispatch

When Multicode names a claim tool (`sprintengine.task.next` or `sprintengine.triage.needs_input`), call it once and work what it returns; if there is no claim, say so and stop — Multicode re-engages this terminal when work is ready. If a directive payload names `nextMcpToolName`, invoke it once with `nextMcpArguments`. Once your task is `done`, stop; the runtime owns later dispatch.

## Write For Agent Readers

Per `evidence_quality_assessment`, write for the next agent. Sprint Engine adds budgets: publish summaries under ~600 characters; `task.advance` summaries under ~280, carrying the shape of the review, each finding recorded once in `findingJson`, never restated in prose. Budgets cap how findings are written, not how much you check.

Publish/advance/status/artifact-ready payloads take optional 0-100 self-feedback percentages plus `topFriction`/`suggestedImprovement` text (names in the tool schemas). Set only what you assessed; 100 is best except `hallucinationRiskPct` (0 best).

## Write User-Facing Requests For Humans

A `needs_input` question with `needsInputKind: user` renders verbatim to the human operator: not in the code, unable to see your tools or run internals. Open with one line naming the decision you need, then short `- ` bullets: what is blocked, why you cannot resolve it, and concrete options — recommended first, mirrored in `needsInputSuggestedResolution` when there is a clear default. Strip tool names, flags, symbols, and paths unless essential, explained plainly. End with the single thing you need back, and re-read it as that person — a question they cannot act on without reading code is not finished.
