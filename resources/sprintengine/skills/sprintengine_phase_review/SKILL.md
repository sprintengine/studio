<what-to-do>

# Review Your Own Work

Your task's diff has entered its review phase. You wrote this code; now
**read it as if a stranger wrote it** — you are the last reviewer before it
ships. Nobody reviews it after you.

Work adversarially through the diff against the task's acceptance criteria:

- **Correctness.** Trace each changed path with real inputs — empty, duplicate,
  concurrent, and error cases. Behaviour "looking right" is not a check.
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
- **Structure.** Did this change leave the codebase simpler, or add a
  special-case branch, nullable mode, cast, pass-through wrapper, or bespoke
  duplicate of a canonical helper? Working code that makes the surrounding code
  harder to reason about is a finding.

Then run a **quick smoke check** that the change itself actually works — the one
command, screen, or call that exercises what you built. This is not exhaustive
validation: planned QA tasks own that. Do not test an intermediate state the
next task will replace.

**Fix everything you find, now.** You own this task through `done`; findings are
never routed to another agent. Patch the defect, commit it scoped to this task,
and report the fixes when you advance.

Escalate only when you cannot fix a finding without a decision that is not yours
to make: the plan contradicts itself, the scope is wrong, or the fix requires
inventing a product decision. Never escalate to have your work confirmed.

</what-to-do>

<supporting-info>

# Reporting the outcome

Close the phase with `sprintengine.task.advance` —
`{ taskId, phase, outcome, summary, findingJson? }`. The only tool that moves your task forward; owner-only.

| `outcome` | Use when |
|---|---|
| `pass` | You reviewed the diff and found nothing to fix. |
| `pass_with_fixes` | You found issues and fixed them in this session. |
| `escalate` | A plan contradiction, scope change, or product decision blocks you. Routes to `needs_input`; you keep ownership and resume once resolved. |

`summary` is a short rationale for agent readers (~280 chars): what you checked,
how many findings, the headline fix. `findingJson` carries the taxonomy; do not
restate the task card or the diff.

## Finding telemetry

`findingJson` is **categorical telemetry only**: an array of
`{kind, severity, area, title?}` (`title` = short label, not a sentence).
Nothing downstream reads finding prose. Report every real finding — one entry
each, including the ones you fixed.

- `kind`: `code_bug`, `security_issue`, `product_requirement_violation`,
  `test_gap`, `accessibility_issue`, `performance_issue`, `reliability_issue`,
  `documentation_gap`, `other`.
- `severity`: `critical`, `high`, `medium`, `low`.
- `area`: `frontend`, `backend`, `database`, `networking`, `auth`, `security`,
  `filesystem`, `cli`, `ipc`, `mobile`, `testing`, `performance`, `docs`,
  `product`, `other`.

The same call takes optional defect **counts**, feeding the run's per-agent
quality metrics: `claimsChecked` (claims you verified), `missedRequirements`,
`implementationMistakes`, `factualErrors`, `unsafeChanges`, `regressionCount`,
`testFailuresIntroduced`, `hallucinatedClaims`, `accessibilityIssues`,
`designIssues`. Counts are evidence, not estimates.

Telemetry is best-effort and never blocks the transition. Only report what you
actually evaluated — an honest `0` for a dimension you checked is a real
signal; leave unknowns unset. Invalid optional fields are dropped with a
warning, never fabricated.

Phase evidence goes where evidence always goes — `file`, `command`, `result` on
`sprintengine.task.log`; commit fixes with
`sprintengine.vcs.commit --task-id <id> --path <file>`.

## The phase walk

The walk is strictly forward. A phase is visited at most once: fixes you make
during review are smoke-checked in place, never re-reviewed by re-entering the
phase. When every phase passes, the task is `done`.

</supporting-info>
