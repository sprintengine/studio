# Sprint Engine Workflow

Coordinate through Sprint Engine MCP tools; never edit run-store files directly. Claim or resume only tasks assigned to your role, read the task card and acceptance criteria, keep edits within owned paths unless a small companion change is required, and log every touched file and verification command as evidence.

## You Own Your Task From Claim To Done

No other agent reviews your work. Implement, then publish with `sprintengine.task.publish`. The engine detects whether you produced a diff:

- **A diff** — the task enters its review phase and the publish response carries your review directive inline (`nextDirective`). Follow it: read your own diff adversarially, fix everything you find, commit the fixes scoped to this task, then close the phase with `sprintengine.task.advance`.
- **No diff** — the task lands directly in `done`. An analysis-only task or a clean sweep ends here.

In worktree-mode runs `task.publish` also commits your task-scoped changes under the Sprint Engine git commit lock before routing the task onward.

## Derive Answers Yourself. Escalate Only What You Must Not Invent

You are trusted to finish the task. Derive answers from the task card, the plan, the Knowledge Graph, and the code. **Never escalate to have your work confirmed, reviewed, or approved.**

Escalate — `sprintengine.task.advance` with `outcome: escalate`, or `sprintengine.task.status` with `needs_input` — only when the plan contradicts itself, the acceptance criteria are impossible as written, the scope is wrong, or finishing would mean inventing a product decision that is not yours to make.

Ordinary compile errors, failing tests, review findings, and validation gaps are yours to fix. Classify a real blocker with `--needs-input-kind`: `architect` for stale plans, impossible acceptance criteria, wrong paths, or scope mismatches; `user` for product decisions, approvals, real hardware, credentials, or another outside check.

## Dispatch

When Multicode names a claim tool (`sprintengine.task.next` or `sprintengine.triage.needs_input`), call it once and work what it returns; if it returns no claim, say so and stop — Multicode re-engages this terminal when work is ready. If a directive payload names `nextMcpToolName`, invoke that tool once with `nextMcpArguments`. Once your task is `done`, let the runtime own later dispatch.

Role-specific runtime skills may add planning, publishing, artifact, benchmark, or difficulty guidance. Follow those only when they match the work you are doing.

## Write For Agent Readers

Per `evidence_quality_assessment`, write for the next agent. Sprint Engine budgets on top of that: publish summaries under ~600 characters; `task.advance` summaries under ~280, carrying the shape of the review, with each finding recorded once in `findingJson` and never restated in prose. Budgets cap how findings are written, never how much you check.

## Write User-Facing Requests For Humans

When you move a task to `needs_input` with `needsInputKind: user`, the `needsInputQuestion` is shown verbatim to the human operator. They are not in the code and cannot see your tools, symbols, or run internals, so drop the agent-reader voice and write for them:

- Open with one line naming the decision or action you need from them.
- Then short `- ` bullets: what is blocked, why you cannot resolve it yourself, and the concrete options or steps they can take. Put your recommended option first.
- Strip internal jargon (tool names, flags, code symbols, file paths, acceptance shorthand) unless essential, then explain it plainly.
- Keep it scannable with bullets and line breaks, never one dense paragraph, and end with the single thing you need back. Put your recommended default in `needsInputSuggestedResolution` when there is a clear one.

A question the operator cannot act on without reading the code is not finished — re-read it as that person before sending.
