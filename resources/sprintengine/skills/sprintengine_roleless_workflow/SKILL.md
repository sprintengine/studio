<what-to-do>

# Sprint Orchestration Without Roles

This sprint runs no roles. One agent holds the coordination job: it produces the run's plan and task graph, adjudicates the plan gate, and triages work that stops. Every other task is dispatched to its own agent, which owns that task from claim to done. Unless the run handed you the coordination job, your task is the whole of your job — the work outside it belongs to the tasks that carry it, and to the agents dispatched to those.

## The loop your task runs

1. **Build** — implement the task you hold against its acceptance criteria. Commit scope is what you actually change (self-reported at publish), not a pre-declared path list; declared modules, when present, are an advisory collision hint.
2. **Publish and self-review** — per the Sprint Engine workflow rules: publish, follow the inline review directive against your own diff, then advance with `pass` or `pass_with_fixes`.

There is nobody to hand the remainder to. Whatever the task needs to be finished — the test, the check against the real path, the fix your own review turns up — is yours, inside it.

## One project per task

**Every task names exactly one project — its `repo` field, defaulting to `primary`.** Planning: give each task the project it changes (`repo` on `sprintengine.plan.add_task`); work spanning two projects is two tasks linked with `dependsOn`, never one task reaching across trees. Building: work only in that project's worktree — your terminal already starts there — where publish commits your changes under that project's own commit lock, so a task in another project never waits on yours. Reviewing: your diff may be one project's half of the change. Its companion lands in a separate pull request, so read the companion task's diff before calling your own half broken or incomplete.

## Finish what you started before taking more

**Carry each task through to `done` before claiming new ready work.** You own a task from claim to done — its review phase is yours, in the same session. A task sitting in `review` is not waiting for another agent; it is waiting for you.

## Keep the team the size the user set

**Do not add team members or roles — keep the team exactly as the user set it.** Never grow the team to hand off work you would rather not do yourself: the shape of this sprint is the user's choice, not a starting point. If the work genuinely cannot proceed at the current team size, record a blocker or move the task to `needs_input` for the user — never expand the team to route around it.

</what-to-do>

<supporting-info>

## What you carry

You receive this orchestration skill and the universal Sprint Engine quality norms, but **no role personality** — there is no role here to have one. The norms (Backlog, Knowledge Graph, project-relative paths, production reality, fallback discipline, evidence quality, post-change self-review) still bind you in full — carrying no specialist identity removes a lens, not the quality bar.

## Self-review honesty

Because you review your own work, the review phase is only as good as your skepticism. Treat it as an adversarial pass: look for the bug, the missed edge case, the acceptance criterion that would pass on mocks or disconnected state. When you find a real issue, fix it and report it as a finding — `pass_with_fixes` with `findingJson`. A `pass` with no real check is the failure mode this loop must avoid.

</supporting-info>
