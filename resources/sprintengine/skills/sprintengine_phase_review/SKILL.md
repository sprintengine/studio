<what-to-do>

# Review Your Own Work

Your task produced a diff and has entered its review phase. You wrote this code;
now **read it as if a stranger wrote it** and you are the last reviewer before it
ships. Nobody reviews it after you.

Work adversarially through the diff against the task's acceptance criteria:

- **Correctness.** Trace each changed path with real inputs, including the empty,
  duplicate, concurrent, and error cases. Behaviour "looking right" is not a check.
- **Contract drift is blocking.** If you changed a documented contract — a schema,
  a tool payload, a status enum, a file layout, a convention — update the
  Knowledge Graph note and the docs that describe it **in the same publish**. A
  contract change with a stale note is an incomplete change, not a follow-up.
- **Tests move with behaviour.** New or changed behaviour needs a test that would
  fail without the change. A test edited to match the new output without asserting
  the new behaviour is a regression in coverage.
- **No fallback masking.** A `try`/`catch`, `?? default`, or silent `continue`
  that turns a real failure into a plausible-looking success is a defect. Prefer
  explicit failure over surprising fallback.
- **Requirements coverage.** Re-read every acceptance criterion and name the code
  that satisfies it. An unmet or partially met criterion is a finding, not a nuance.
- **Structure.** Did this change leave the codebase simpler and easier to scan, or
  did it add a special-case branch, a nullable mode, a cast, a pass-through
  wrapper, or a bespoke duplicate of a canonical helper? Working code that makes
  the surrounding code harder to reason about is a finding.

Then run a **quick smoke check** that the change itself actually works — the one
command, screen, or call that exercises what you built. This is not exhaustive
validation: planned QA tasks own that. Do not spend this session testing an
intermediate state the next task will replace.

**Fix everything you find, now.** You own this task through `done`; findings are
never routed to another agent. Patch the defect, commit it scoped to this task,
and report what you fixed when you advance the phase.

Escalate only when you cannot fix a finding without a decision that is not yours
to make: the plan contradicts itself, the scope is wrong, or the fix requires
inventing a product decision. Never escalate to have your work confirmed.

</what-to-do>

<supporting-info>

# Reporting the outcome

Close the phase with `sprintengine.task.advance` —
`{ taskId, phase, outcome, summary, findingJson? }`. It is the only tool that
moves your task forward, and only you (the owner) may call it.

| `outcome` | Use when |
|---|---|
| `pass` | You reviewed the diff and found nothing to fix. |
| `pass_with_fixes` | You found issues and fixed them in this session. |
| `escalate` | A plan contradiction, scope change, or product decision blocks you. Routes the task to `needs_input`; you keep ownership and resume when it is resolved. |

`summary` is a short rationale written for agent readers — keep it under ~280
characters. Give the shape of the review (what you checked, how many findings,
the headline fix) and let `findingJson` carry the taxonomy. Do not restate the
task card or the diff.

## Finding telemetry

`findingJson` is **categorical telemetry only**: an array of
`{kind, severity, area, title?}`, where `title` is a short label, not a sentence.
It feeds run analytics; nothing downstream reads finding prose. Report every real
finding, tersely — one entry per finding, including the ones you fixed.

- `kind`: `code_bug`, `security_issue`, `product_requirement_violation`,
  `test_gap`, `accessibility_issue`, `performance_issue`, `reliability_issue`,
  `documentation_gap`, `other`.
- `severity`: `critical`, `high`, `medium`, `low`.
- `area`: `frontend`, `backend`, `database`, `networking`, `auth`, `security`,
  `filesystem`, `cli`, `ipc`, `mobile`, `testing`, `performance`, `docs`,
  `product`, `other`.

Telemetry is best-effort and never blocks the transition, but only report what you
actually evaluated. Leave a field unset rather than guessing; the server drops an
invalid optional field with a warning instead of recording a fabricated value.

Evidence you gather during the phase goes where evidence always goes: `file`,
`command`, and `result` on `sprintengine.task.log`. Fixes are committed with
`sprintengine.vcs.commit --task-id <id> --path <file>` and fold into this task.

## The phase walk

The walk is strictly forward. A phase is visited at most once: fixes you make
during review are smoke-checked in place, never re-reviewed by re-entering the
phase. When every phase passes, the task is `done` and you are finished.

</supporting-info>
