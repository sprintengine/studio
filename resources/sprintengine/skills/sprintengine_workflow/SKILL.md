# Sprint Engine Workflow

Coordinate through Sprint Engine MCP tools rather than editing run-store files directly. Claim or resume only tasks and gates assigned to your current role, read the task card and acceptance criteria, keep edits within owned paths unless a small companion change is required, and log every touched file and verification command as evidence.

When the work is ready, publish implementation evidence via `sprintengine.task.publish` so required quality gates can review it. In worktree-mode runs, `task.publish` also commits the task-scoped changes under the Sprint Engine git commit lock before routing the task onward; outside worktree mode, publish does not stage or commit git changes. If the task is blocked, move it to `needs_input` via `sprintengine.task.status` with the correct actor, reason, question, and suggested resolution instead of marking it done.

Use project-root-relative paths in Sprint Engine MCP payload fields that carry paths, including `path` on `sprintengine.plan.add_task`, `file` on `sprintengine.task.log`, `path` on `sprintengine.artifact.add`, and corresponding plan/artifact update fields. If a tool result returns an absolute path, convert it to a project-relative path before logging or writing it into an artifact.

If `MULTICODE_KNOWLEDGE_ROOT` is set and your change affects a behavior, contract, file layout, or convention documented in the Knowledge Graph, update the relevant note in the same publish. Log the KG note path with `sprintengine.task.log` `file` evidence alongside the source files you touched.

When Multicode names a claim tool (`sprintengine.task.next`,
`sprintengine.gate.next`, or `sprintengine.triage.needs_input`), call it once
and work what it returns; if it returns no claim, say so and stop — Multicode
re-engages this terminal when work is ready. If a directive payload names
`nextMcpToolName`, invoke that MCP tool once with `nextMcpArguments`. After
publishing evidence or a verdict, let the runtime own later dispatch and
continuation. Standalone/headless CLI users can still use `join --watch` for
polling/backoff outside the managed Multicode runtime.

Role-specific Sprint Engine runtime skills may add planning, publishing, gate,
artifact, benchmark, or difficulty guidance. Follow those only when they match
the work you are actually doing.

## Write For Agent Readers

Sprint Engine artifacts are consumed mostly by other agents, and every summary,
comment, and review is re-read in later prompts, so write terse bullet-first
content: facts and decisions, not narrative. Never restate the task card, plan,
or requirements the reader already has; reference file paths instead of quoting
file content. Budgets: evidence `result` entries are one line each; `task.log`
summaries, notes, and comments stay within a few lines; publish summaries stay
under ~600 characters; gate verdict summaries stay under ~2000 characters.
Budgets cap how findings and evidence are written, never how much you check —
report every real finding, tersely. The one exception is a `user`-kind
`needs_input` question, which is read by a person — see Write User-Facing
Requests For Humans below.

## Write User-Facing Requests For Humans

When you move a task to `needs_input` with `needsInputKind: user`, the
`needsInputQuestion` is shown verbatim to the human operator. They are not in the
code and cannot see your tools, symbols, or run internals, so drop the
agent-reader voice and write the request for them:

- Open with one line naming the decision or action you need from them.
- Then short `- ` bullets: what is blocked, why you cannot resolve it yourself,
  and the concrete options or steps they can take. Put your recommended option
  first.
- Strip internal jargon — tool names, command flags, code symbols, file-path
  references, and acceptance-criteria shorthand — unless it is essential, and
  then explain it in plain words.
- Keep it scannable with bullets and line breaks, never one dense paragraph, and
  end with the single thing you need back. Put your recommended default in
  `needsInputSuggestedResolution` when there is a clear one.

A question the operator cannot act on without reading the code is not finished.
Re-read your `needsInputQuestion` as that person before you send it: does it say
exactly what you want them to do?
