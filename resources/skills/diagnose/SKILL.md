---
name: diagnose
description: Debug bugs, failing tests, broken workflows, flaky behavior, and performance regressions through a reproducible feedback loop. Use when the user says diagnose, debug, broken, failing, throwing, flaky, slow, regressed, or reports behavior that needs root-cause analysis before a fix.
---

# Diagnose

Use a disciplined diagnosis loop. Do not patch from the first plausible explanation unless the failure is trivial and already reproduced.

## 1. Build A Feedback Loop

Create the fastest reliable signal that shows the reported failure.

Prefer, in order:

1. A failing test at the public interface or integration path.
2. A CLI command, HTTP request, or fixture-driven script with expected output.
3. A browser automation check for UI behavior, console errors, or network failures.
4. A replay of captured logs, payloads, traces, or event data.
5. A small temporary harness that exercises the real failing path.
6. A repeated stress loop for flaky or timing-sensitive failures.

If you cannot build a loop, stop and report what you tried. Ask for the missing artifact, environment, log, reproduction step, or permission for temporary instrumentation.

## 2. Reproduce

Confirm the loop matches the user's failure, not a nearby failure.

- Capture the exact symptom: error text, wrong output, timing, visual state, or event sequence.
- Run enough times to establish determinism or a useful flake rate.
- Avoid changing production code before reproduction unless the missing observability is the blocker.

## 3. Hypothesize

List 3-5 ranked hypotheses before testing.

Each hypothesis must be falsifiable:

```text
If <cause> is true, then <probe or change> should show <observable result>.
```

Test one variable at a time. Use debugger or targeted probes before broad logging.

## 4. Instrument Narrowly

- Put probes at boundaries that distinguish hypotheses.
- Tag temporary logs with a unique prefix such as `[DEBUG-1234]`.
- For performance issues, establish a baseline metric before changing code.
- Do not scatter untagged logs or leave instrumentation behind.

## 5. Fix And Lock Down

When the cause is known:

1. Convert the minimized reproduction into a regression test when a correct test surface exists.
2. Apply the smallest fix that addresses the real cause.
3. Re-run the regression test and original feedback loop.
4. Remove temporary probes, harnesses, and debug logs.

If no correct regression-test surface exists, say so directly. That is an architecture/testability finding, not a reason to write a misleading test.

## Done Means

- Original failure no longer reproduces.
- Relevant regression coverage exists, or the absence of a valid test surface is documented.
- Temporary instrumentation is removed.
- The root cause and verification command are reported.
