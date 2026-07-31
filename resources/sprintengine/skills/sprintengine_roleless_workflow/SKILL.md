<what-to-do>

# Sprint Orchestration Without Roles

This sprint runs no roles. It is a pool: every agent shares one task graph and takes work by claiming it; nothing is assigned. With no architect and no specialists, the pool does the whole job itself — plan, implement, review, test, publish. Run alone and you do all of it; run several and the same loop runs in parallel over the shared graph.

## The full loop

Drive every piece of work through the same loop, in order, before it is done:

1. **Plan** — when the run needs a plan, create the tasks yourself, then self-approve the plan artifact. Planning is a claimed task like any other, so a pool still produces one plan. Plan validation as its own task where testing is meaningful (one whole-flow task at the end, or one per milestone), never per-task busywork.
2. **Build** — claim a ready task and implement it against its acceptance criteria and owned paths.
3. **Publish and self-review** — per the Sprint Engine workflow rules: publish, follow the inline review directive against your own diff, then advance with `pass` or `pass_with_fixes`.

## One project per task

**Every task names exactly one project — its `repo` field, defaulting to `primary`.** Planning: give each task the project it changes (`repo` on `sprintengine.plan.add_task`); work spanning two projects is two tasks linked with `dependsOn`, never one task reaching across trees. Building: work only in that project's worktree — your terminal already starts there — where publish commits your changes under that project's own commit lock, so a task in another project never waits on yours. Reviewing: your diff may be one project's half of the change. Its companion lands in a separate pull request, so read the companion task's diff before calling your own half broken or incomplete.

## Finish what you started before taking more

**Carry each task through to `done` before claiming new ready work.** You own a task from claim to done — its review phase is yours, in the same session. A task sitting in `review` is not waiting for another agent; it is waiting for you.

## Keep the team the size the user set

**Do not add team members or specialists — keep the team exactly as the user set it.** Never grow the team: do not try to add a developer, tester, reviewer, or any other role to handle work you would rather hand off. The pool does the whole job itself. If the work genuinely cannot proceed at the current team size, record a blocker or move the task to `needs_input` for the user — never expand the team to route around it.

</what-to-do>

<supporting-info>

## What you carry

You receive this orchestration skill and the universal Sprint Engine quality norms, but **no role personality** — there is no role here to have one. The norms (Backlog, Knowledge Graph, project-relative paths, production reality, fallback discipline, evidence quality, post-change self-review) still bind you in full — carrying no specialist identity removes a lens, not the quality bar.

## Self-review honesty

Because you review your own work, the review phase is only as good as your skepticism. Treat it as an adversarial pass: look for the bug, the missed edge case, the acceptance criterion that would pass on mocks or disconnected state. When you find a real issue, fix it and report it as a finding — `pass_with_fixes` with `findingJson`. A `pass` with no real check is the failure mode this loop must avoid.

</supporting-info>
