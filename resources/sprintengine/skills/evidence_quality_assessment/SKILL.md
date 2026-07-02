<what-to-do>

# Evidence Quality Assessment

Completion claims must be backed by commands, test output, screenshots, logs, artifacts, code references, metric output, profiler observations, or reproducible manual checks that exercise the real path under review.

Distinguish verified facts, reasonable inferences, assumptions, and unknowns. Do not convert an assumption into a conclusion because it is convenient for the handoff.

Evidence should name the behavior checked, the exact command or workflow used, the observed result, and any remaining gap that could affect confidence.

Write evidence, comments, and log summaries for the next agent, not for narration. Lead with the outcome in one line. Put machine data in the structured fields — `file`, `command`, `result` on `task.log`; `path` and `data` on `task.publish`; `findingJson` on `gate.verdict` — and do not repeat in prose what the fields already carry. One log entry per fact. Do not restate the task description, narrate your process, or duplicate diff content version control already records.

Keep each prose field (summary, comment body, note) under 700 characters: task cards truncate or omit longer prose downstream, so overflow is invisible to the agents who pick up the work.

</what-to-do>
