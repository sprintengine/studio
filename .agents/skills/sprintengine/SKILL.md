---
name: sprintengine
description: Coordinate sprintengine task claiming, status updates, evidence publishing, artifact review gates, projections, migration, and plan reviews for projects that use named `.multi-code/sprintengine/<team>/` run stores and `plan.md` files. Use when acting as a sprintengine architect or worker in this repo's sprintengine-mode workflow.
---

Use the bundled coordination command instead of hand-editing Sprint Engine store files. This includes `.multi-code/sprintengine/state.yaml`, named `.multi-code/sprintengine/<team>/state.yaml` files, `run.yaml`, `projection.json`, task JSON files, artifact JSON files, `events.jsonl`, `metrics/agent-feedback.jsonl`, runner status files, and lock files.

Primary command:

- POSIX shells: `sprintengine`
- Windows PowerShell: `.\scripts\sprintengine.cmd`

Fallback script:

- POSIX: `.venv/bin/python scripts/sprintengine_tool.py` when the repo venv exists, otherwise `python3 scripts/sprintengine_tool.py`
- Windows PowerShell: `& ".\.venv\Scripts\python.exe" ".\scripts\sprintengine_tool.py"` when the repo venv exists, otherwise `py -3 ".\scripts\sprintengine_tool.py"` or `python ".\scripts\sprintengine_tool.py"`

API discovery:

- When a sprintengine terminal starts, run `sprintengine --help` on POSIX shells or `.\scripts\sprintengine.cmd --help` on Windows PowerShell.
- Command examples may use `sprintengine ...` as shorthand. On Windows PowerShell, translate that shorthand to `.\scripts\sprintengine.cmd ...` or the direct Python fallback above. Do not execute `scripts/sprintengine` directly from Windows PowerShell; it is a Bash wrapper.
- On Windows, if `.\scripts\sprintengine.cmd` cannot run, immediately retry with the repo venv command: `& ".\.venv\Scripts\python.exe" ".\scripts\sprintengine_tool.py" --help`.
- For Verify Progress / recovery audits, run `sprintengine recover` and follow the returned prompt. Recovery is an integrity pass: it must keep implementation work stopped, but it may tighten acceptance criteria, add missing real-integration/verification tasks, or fix dependencies when the existing plan would let fake product behavior count as done.
- Before using a command group or action for the first time, run its `--help` and follow the exact flags shown by the tool.
- Current command groups are `handover`, `init`, `recover`, `migrate`, `projection`, `join`, `triage`, `task`, `plan`, `artifact`, `summary`, and `merge`.
- Worker commands live under `sprintengine task`: use `task next`, `task claim`, `task status`, `task log`, `task note`, and `task list`.
- `sprintengine task log` uses repeatable `--file`, `--command`, and `--result` flags. When a task requires a small directly related edit outside `ownedPaths`, also add repeatable `--scope-expansion-json '{"path":"<project-relative-path>","reason":"<why this companion edit is required>","risk":"<low|medium|high or short risk>"}'`.
- When moving a task to `needs_input`, classify who must resolve it with `--needs-input-kind` (`architect`, `user`, or `owner`) plus `--needs-input-question`; add `--needs-input-reason` (`task_scope`, `artifact_review`, `tooling`, `verification`, `product_decision`, or `blocked_other`) when available. Use `architect` for stale plans, impossible acceptance criteria, wrong paths, architectural scope mismatches, or artifact reviews so the UI can route the blocker to the architect. Legacy kind values (`artifact`, `tooling`, `verification`, `other`) are still accepted for compatibility but should not be used for new blockers.
- Architects can triage architect-actionable blockers with `sprintengine triage needs-input --id architect`; this returns a bounded prompt for task-card or task-graph repair, not application-source implementation.
- `sprintengine task status --status done` and `sprintengine artifact ready` accept optional `0`-`100` agent feedback flags such as `--confidence-pct`, `--task-clarity-pct`, and `--hallucination-risk-pct`, short text fields such as `--top-friction`, repeatable `--issue-json` prompt/process improvement signals, and repeatable `--finding-json` role-specific review findings. Omit them when unavailable; existing completion commands remain valid.
- Agent identity is the stable sprintengine slot id such as `frontend`, `product`, `developer-1`, or `developer-2`, not the Claude session id. If Claude restarts, reuse the same `--id` to continue that slot's active work.
- If calling the Python script directly instead of the `sprintengine` function, put global `--state <path>` before the subcommand.
- All file paths written into task cards, evidence, artifacts, reviews, plans, or handoffs must be relative to the project root. Never use absolute or machine-specific paths in `--path`, `--file`, artifact paths, markdown artifacts, or task notes.
- For app, mobile, or read-only tooling, use `sprintengine projection` or the generated `projection.json` read contract. Do not parse `tasks/`, `artifacts/`, `events.jsonl`, metrics files, lock files, or legacy `state.yaml` directly for migrated runs.
- Do not move files between task or artifact status folders by hand. Folder location, embedded status mirrors, ready queue materialization, activity, events, metrics, and projection updates must be produced by Sprint Engine commands.

Worker workflow:

1. Read the active team's approved `architect_plan` artifact path from `.multi-code/sprintengine/<team>/state.yaml`, normally `.multi-code/sprintengine/<team>/plan.md`, for the human-authored plan and task context. Do not search for or use any other `plan.md`.
2. Run `sprintengine --help` and `sprintengine task next --help` before the first claim in a fresh terminal. On Windows PowerShell, run `.\scripts\sprintengine.cmd --help` and `.\scripts\sprintengine.cmd task next --help`.
3. Run `sprintengine task next --role <your-role> --id <your-agent-id>` to atomically claim the next ready task for your role. On Windows PowerShell, run `.\scripts\sprintengine.cmd task next --role <your-role> --id <your-agent-id>`.
4. If this Claude process was restarted, reuse the same `--id`; `task next` returns that slot's existing active task before claiming new work.
5. If no task is ready, stop and do not manually edit shared state.
6. Treat `ownedPaths` as the primary edit surface and collision boundary, not a ban on obvious companion edits. Prefer owned paths, but small directly required companion edits for correctness, integration, type safety, tests, or cleaner structure are allowed when logged as scope expansions. Move to `needs_input` with kind `architect` before broad expansion, product scope changes, major ownership boundary changes, or likely overlap with another active task.
7. Update only your own task card with:
   - `sprintengine task status`
   - `sprintengine task note`
   - `sprintengine task log`
   - `sprintengine artifact add` / `sprintengine artifact ready` when your task explicitly produces an artifact
8. Before marking work `done`, publish:
   - summary
   - touched files
   - scope expansions for touched files outside owned paths, if any
   - commands run
   - results
   - optional completion feedback percentages on the final status or artifact-ready command when you can assess them
9. After marking one task `done`, stop. A fresh agent must be spawned for additional work.

Architect workflow:

1. New sprintengine runs start with product intake. Do not plan until the product intake artifact is approved, unless you are resuming a legacy architect-first sprintengine.
2. Treat `.multi-code/sprintengine/<team>/plan.md` for the active team as the final artifact you create, not as a source of truth that already exists. Do not read, copy, or overwrite another team's `plan.md`.
3. Study the approved product artifact, repository, and current implementation deeply before planning.
4. Ask the user clarifying questions until they confirm the intended outcome, constraints, and acceptance criteria.
5. Use plan reviews when specialist input would improve the plan.
6. Write `.multi-code/sprintengine/<team>/plan.md` as a compact technical execution plan for AI agents: short bullets, low-level design, implementation approach, acceptance checks, risks/open questions, and only the context workers need beyond their task cards.
7. Do not include week-based timelines, dates, sprint plans, milestone schedules, duration estimates, or roadmap prose. Represent execution order with task dependencies, not time.
8. Add task cards one at a time with `Sprint Engine plan add-task`; start with tasks that have no dependencies, then add dependent work using `--depends-on`.
9. Include an architect-owned final review scheduling task after implementation, validation, and code review. This task decides which product, security, and performance final reviews are actually needed, records skip rationale for unneeded reviews, adds only the selected specialist review tasks, and then adds a later architect final review task.
10. Do not create product final acceptance, security review, or performance review tasks during initial planning unless the approved requirements or user explicitly require that specialist review before implementation starts.
11. During architect final review, never reopen completed tasks. If product, security, performance, code review, validation, or architect findings require follow-up work, create new tasks and also create a later architect final review task that depends on those follow-ups.
12. During user review, revise the board with `Sprint Engine plan update-task`, `Sprint Engine plan delete-task`, `Sprint Engine plan add-dependency`, and `Sprint Engine plan remove-dependency`.
13. Tell the user the plan is ready for review in the app. The user can inspect it, request specialist plan reviews, or manually spawn specialists from the UI.
14. Do not manually edit `.multi-code/sprintengine/state.yaml`, `run.yaml`, task files, artifact files, events, metrics, projections, runner files, or locks.

Use plan reviews when the architect has drafted a complete plan and wants the specialist roster to critique it before execution:

- Specialist starts review mode with `Sprint Engine plan start-review --role <role> --id <agent-id>`
- The tool returns a prompt and the exact review file path under `plan-reviews/<agent-id>.md`
- Specialist writes structured markdown feedback in that file and does not claim tasks or implement
- Architect starts feedback mode with `Sprint Engine plan address-reviews --actor architect`
- The tool reads every review file and returns a prompt for revising `plan.md` and the task graph

Common commands:

```bash
sprintengine task list --role frontend
sprintengine task next --role frontend --id frontend-1
sprintengine task claim --task-id T3 --id frontend-1
sprintengine task status --task-id T3 --status in_progress --id frontend-1
sprintengine task log --task-id T3 --id frontend-1 --summary "Updated board UI" --file src/renderer/src/components/panels/SprintEngineBoardPanel.tsx --file src/renderer/src/utils/sprintengine.ts --scope-expansion-json '{"path":"src/renderer/src/utils/sprintengine.ts","reason":"shared selector extracted to avoid duplicated panel/palette logic","risk":"low; covered by typecheck"}' --command "npm run typecheck" --result "Passed"
Sprint Engine plan add-task --title "Persist Sprint Engine state" --role developer --path src/renderer/src/store --acceptance "State tracks task ownership and evidence"
Sprint Engine plan add-task --title "Review implementation quality" --role code_reviewer --depends-on T3 --path src/renderer/src/store --path .multi-code/sprintengine/<team>/reviews/code-review-1.md --description "Review-only the completed implementation for correctness, modularity, maintainability, and verification gaps. Produce direct review evidence or a code_review artifact with concrete findings and recommended follow-up work; do not edit application or test code." --acceptance "Reviewer logs review evidence and verification commands inspected or run" --acceptance "Findings include severity, impact, recommended fix, owner role, and verification steps" --acceptance "If no findings remain, reviewer records explicit approval and residual risk"
Sprint Engine plan add-task --title "Spec review implementation" --role spec_reviewer --depends-on T3 --path .multi-code/sprintengine/<team>/reviews/spec-review-1.md --description "Review-only the completed implementation against the approved requirements, acceptance criteria, architect plan, implementation evidence, and tests. Produce a spec review artifact with requirement coverage, behavioral gaps, missing tests, verdict, and recommended follow-up tasks." --acceptance "Spec review records every material requirement as met, missing, partial, blocked, not applicable, or intentionally deferred" --acceptance "Findings include severity, requirement source, impact, recommended fix, and verification steps"
Sprint Engine plan add-task --title "Review performance" --role performance --depends-on T4 --path src/renderer/src/store --acceptance "Performance review artifact documents measured evidence, findings, or approval"
Sprint Engine plan add-task --title "Render task board" --role frontend --depends-on T1 --path src/renderer/src/components/panels --acceptance "Board displays todo, ready, in progress, needs input, and done"
Sprint Engine plan update-task --task-id T1 --title "Persist shared Sprint Engine state" --acceptance "State tracks task ownership and evidence" --path src/renderer/src/store
Sprint Engine plan add-dependency --task-id T2 --depends-on T1
Sprint Engine plan remove-dependency --task-id T2 --depends-on T1
Sprint Engine plan delete-task --task-id T3 --unlink-dependents
Sprint Engine plan start-review --role frontend --id frontend
Sprint Engine plan review-status
Sprint Engine plan address-reviews --actor architect
Sprint Engine plan list
sprintengine projection
sprintengine summary
```

Rules:

- Only claim tasks that are ready for your role.
- Prefer `sprintengine task next` for normal worker execution because it claims under the Sprint Engine state lock.
- Only update your own task card.
- Append evidence before moving work to `done`.
- Complete one task per agent, then stop.
- Use `sprintengine summary` after all tasks are done to summarize touched files, commands, validation results, and manual verification notes.
- Do not rewrite the overall plan unless you are explicitly acting as the architect.
- Architect-created follow-up work from final review must be followed by another architect final review task. Completed tasks stay done; create new tasks for fixes or verification.
- Plan reviewers write only their own markdown file in `plan-reviews/`; they do not update `state.yaml`, `run.yaml`, task files, artifact files, events, metrics, locks, claim tasks, or change the task graph.
- Architects address plan reviews with `Sprint Engine plan address-reviews --actor architect`, then revise `plan.md` directly and task cards through `Sprint Engine plan` commands.
- App and mobile read paths should consume normalized Sprint Engine projections. They must not parse folder-store internals or mutate Sprint Engine files directly.
- The Python tool is for agent and local coordination commands. UI review actions should focus or message the relevant agent terminal; that agent then uses the Sprint Engine tool.
- Renderer, preload, and main-process UI IPC must not expose direct sprintengine Python mutations such as `sprintengine artifact approve`, `sprintengine artifact request-changes`, `sprintengine artifact ready`, `sprintengine task status`, or `Sprint Engine plan` updates. UI review actions should focus or message the relevant agent terminal; that agent then uses the Sprint Engine tool.
- If `python3` or `PyYAML` is unavailable, report the blocker instead of silently hand-editing shared state.

If you need the exact state layout, read `references/state-schema.md`.
