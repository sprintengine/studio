---
name: debug
description: Debug bugs, failing tests, broken workflows, flaky behavior, and performance regressions through a file-backed state machine that survives context compaction. Use when the user says debug, diagnose, broken, failing, throwing, flaky, slow, regressed, or reports behavior that needs root-cause analysis before a fix.
---

# Debug

Drive every investigation through an explicit, file-backed state machine. The
state file is your source of truth: it survives context compaction, so a
truncated session can reconstruct exactly where it was and what is still
outstanding. Do not patch from the first plausible explanation unless the
failure is trivial and already reproduced.

## State File Contract

Keep one state file per investigation at:

```
.multi-code/debug/<MULTICODE_AGENT_ID>.json
```

`<MULTICODE_AGENT_ID>` is the value of the `MULTICODE_AGENT_ID` environment
variable already exported into this terminal (one file per agent terminal). If
the variable is unset, fall back to `.multi-code/debug/session.json`.

**Every turn, before doing anything else, read this file.** It tells you the
current `state`, the confirmed reproduction, your ranked hypotheses, and which
probes are still in the tree. **Update it on every state transition** and
whenever a hypothesis status or probe changes — never let it drift from reality.
Create it (with `state: "reproducing"`) on the first turn if it does not exist.

### Schema

```json
{
  "schemaVersion": 1,
  "agentId": "<MULTICODE_AGENT_ID>",
  "state": "reproducing",
  "bug": {
    "symptom": "exact error text, wrong output, timing, or visual state",
    "reproCommand": "the fastest reliable command/loop that shows the failure",
    "reproConfirmed": false
  },
  "hypotheses": [
    {
      "id": "H1",
      "rank": 1,
      "statement": "If <cause> is true, then <probe> shows <observable result>",
      "status": "open",
      "evidence": "what the probe actually showed, once tested"
    }
  ],
  "probes": [
    {
      "tag": "DEBUG-1234",
      "hypothesisId": "H1",
      "file": "src/path/to/file.ts",
      "line": 42,
      "removed": false
    }
  ],
  "fix": {
    "applied": false,
    "summary": "the smallest change that addresses the real cause",
    "regressionTest": "path or name of the locking test, or why none exists"
  },
  "updatedAt": "ISO-8601 timestamp"
}
```

Field rules:

- `state` is one of the states below.
- `hypotheses[].status` is `open`, `confirmed`, or `ruled_out`.
- `probes[].tag` follows the `DEBUG-<n>` convention and matches the literal tag
  text you put in the code (e.g. a `[DEBUG-1234]` log prefix).
- `probes[].removed` is `false` while the instrumentation is still in the tree
  and `true` only once you have deleted it.
- `updatedAt` is refreshed on every write.

## States

```
reproducing -> hypothesizing -> instrumenting -> ruling_out -> fixing -> cleanup -> done
                                      ^                |
                                      |                v
                                      +----------------+
                              (loop until a hypothesis is confirmed)
```

### reproducing

Build the fastest reliable signal that shows the reported failure, preferring in
order: a failing test at the public interface; a CLI/HTTP/fixture script with
expected output; a browser automation check for UI/console/network behavior; a
replay of captured logs/payloads/traces; a small temporary harness exercising
the real failing path; a repeated stress loop for flaky or timing-sensitive
failures.

Capture the exact symptom and run enough times to establish determinism or a
useful flake rate. Record `bug.symptom` and `bug.reproCommand`; set
`bug.reproConfirmed: true` only once the loop reproduces the user's failure (not
a nearby one). Avoid changing production code before reproduction unless the
missing observability is itself the blocker. If you cannot build a loop, stop
and report what you tried and the missing artifact, environment, log, repro
step, or permission you need. Then transition to `hypothesizing`.

### hypothesizing

List 3-5 ranked, falsifiable hypotheses before testing, each in the form
`If <cause> is true, then <probe or change> should show <observable result>`.
Write them to `hypotheses[]` with `status: "open"`. Test one variable at a time;
prefer a debugger or targeted probes over broad logging. Transition to
`instrumenting`.

### instrumenting

Add narrow probes at the boundaries that distinguish hypotheses. Tag every
temporary log/probe with a unique `DEBUG-<n>` prefix and record each as a
`probes[]` entry with `removed: false`, its `file`, `line`, and the
`hypothesisId` it tests. For performance issues, capture a baseline metric
before changing code. Do not scatter untagged logs. Transition to `ruling_out`.

### ruling_out

Run the repro and read the probe output. Update each tested hypothesis to
`confirmed` or `ruled_out` and record what the probe showed in `evidence`. If no
hypothesis is confirmed yet, loop back to `instrumenting` (add or move probes) —
or back to `hypothesizing` if all current hypotheses are ruled out. Once a
hypothesis is `confirmed`, transition to `fixing`.

### fixing

Apply the smallest fix that addresses the confirmed root cause. When a correct
test surface exists, convert the minimized reproduction into a regression test;
if none exists, say so directly and record that in `fix.regressionTest` — that
is an architecture/testability finding, not a reason to write a misleading test.
Re-run the regression test and the original repro loop. Set `fix.applied: true`
with a `fix.summary`. Transition to `cleanup`.

### cleanup

Remove every temporary probe, harness, and debug log. For each `probes[]` entry,
delete the instrumentation from the code and set `removed: true`. Sweep the tree
for any residual `DEBUG-` tag to confirm nothing was missed. Transition to
`done` only when every probe is `removed: true`.

### done

Terminal state. **Never declare `done` while any `probes[]` entry has
`removed: false`** — leftover instrumentation is the failure this state machine
exists to prevent. When done:

- The original failure no longer reproduces (re-run `bug.reproCommand`).
- Relevant regression coverage exists, or the absence of a valid test surface is
  documented in `fix.regressionTest`.
- Every probe is removed and no `DEBUG-` tag remains in the tree.
- Report the **root cause** and the exact **verification command** to the user.

Archive or clear the state file once you reach `done`; it is ephemeral
per-investigation scratch, not a durable record.
