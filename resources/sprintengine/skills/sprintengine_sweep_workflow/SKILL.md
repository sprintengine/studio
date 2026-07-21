<what-to-do>

# Fix-Forward Sweep

Your task is a **sweep**: audit the work this sprint produced and close every blocking finding. Fix small, safely owned findings directly. When a defect belongs to one completed dependency and should return to its implementer, open a closed rework thread with `sprintengine.task.request_changes`; that target must return to you for explicit re-approval before this sweep can finish.

Review the combined branch diff (or, for QA, exercise the finished behaviour), then:

- **Patch what you find, directly.** Including code outside "your" lane. You own the fix.
- Commit your fixes scoped to this task (`sprintengine.vcs.commit --task-id <id> --path <file>`), then publish. Your fixes are fresh implementation work, so they walk your own review phase like any other change. A sweep that found nothing publishes its findings summary and lands in `done` without entering review.
- **Record one assessment per audited task** with `sprintengine.task.log` on YOUR task id, passing `reviewTargetTaskId` naming the task you audited (its implementer is attributed automatically), plus categorical `findingJson` entries (`{kind, severity, area, title?}`) for every real finding — the ones you fixed too — and the defect counts you actually evaluated (`claimsChecked`, `missedRequirements`, `implementationMistakes`, `regressionCount`, `testFailuresIntroduced`, `unsafeChanges`, …). A clean audit still gets an assessment (`claimsChecked` + honest zeros): "checked, found nothing" and "never checked" must not look the same in the run metrics.

**Never take the whole sprint hostage over one finding.** Three rungs, in order:

1. **Fixable here** — fix it. This is the default for small sweep-local corrections. `pass_with_fixes`.
2. **One existing target owns the defect** — call `sprintengine.task.request_changes` with your sweep task as `sourceTaskId`. Stay on your sweep lease while the target is reworked; approve with `sprintengine.task.approve_rework`, or reject again. Your sweep cannot complete while the thread is open.
3. **A task/consumer is missing or the plan is wrong** — `sprintengine.task.advance` with `outcome: escalate` and `needsInputKind: architect`. Do not waste rework cycles on a finding without one valid target.
4. **A product or ship decision** — `escalate` with `needsInputKind: user` and a plain-human
   question. An accepted-and-deferred finding is recorded on this task, never silently dropped.

</what-to-do>

<supporting-info>

## Why you go last

Sweeps edit the tree, so the architect chains them (`dependsOn`) rather than running them in parallel: a later sweep reviews the tree an earlier one already fixed, and a project's worktree never hosts two sweeps editing at once. If your task depends on another sweep, that sweep's fixes are already in the diff you are reading — review the current tree, not the original work.

## The cost of escalating

Rung 1 is free. Rung 2 costs one deliberate architect decision and arrives as fresh planned tasks with clean briefs, visible and individually costed on the board. That is the point: rework beyond fix-forward should be a decision someone makes, not something that happens.

## Review artifacts

When your task produces a review artifact, lead with the verdict, then one compact bullet per finding (severity, path, defect, required fix, verification); keep it under ~120 lines.

## Scope

Your sweep's focus is declared in your role's registry manifest (`sweep.focus`). Stay inside it. A finding outside your focus that you can fix cheaply and safely: fix it and record it. A finding outside your focus that is large: name it in your summary so the architect can plan it — do not silently expand your task into a second sweep.

</supporting-info>
