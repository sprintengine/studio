---
name: sprintengine-kanban
description: Coordinate sprintengine task claiming, status updates, evidence publishing, artifact review gates, and plan reviews for projects that use named `sprintengine/<team>/state.yaml` and `sprintengine/<team>/plan.md` files. Use when acting as a sprintengine architect or worker in this repo's sprintengine-mode workflow.
---

Use the bundled coordination command instead of hand-editing `sprintengine/state.yaml` or named `sprintengine/<team>/state.yaml` files.

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
- For Verify Progress / recovery audits, run `sprintengine recover` and follow the returned prompt. This is audit-only and must not replan, add, delete, or replace tasks.
- Before using a command group or action for the first time, run its `--help` and follow the exact flags shown by the tool.
- Current command groups are `handover`, `init`, `recover`, `join`, `task`, `plan`, `artifact`, and `summary`.
- Worker commands live under `sprintengine task`: use `task next`, `task claim`, `task status`, `task log`, `task note`, and `task list`.
- `sprintengine task log` uses repeatable `--file`, `--command`, and `--result` flags.
- `sprintengine task status --status done` and `sprintengine artifact ready` accept optional `0`-`100` agent feedback flags such as `--confidence-pct`, `--task-clarity-pct`, and `--hallucination-risk-pct`, short text fields such as `--top-friction`, repeatable `--issue-json` prompt/process improvement signals, and repeatable `--finding-json` role-specific review findings. Omit them when unavailable; existing completion commands remain valid.
- Agent identity is the stable sprintengine slot id such as `frontend`, `product`, `developer-1`, or `developer-2`, not the Claude session id. If Claude restarts, reuse the same `--id` to continue that slot's active work.
- If calling the Python script directly instead of the `sprintengine` function, put global `--state <path>` before the subcommand.
- All file paths written into task cards, evidence, artifacts, reviews, plans, or handoffs must be relative to the project root. Never use absolute or machine-specific paths in `--path`, `--file`, artifact paths, markdown artifacts, or task notes.

Worker workflow:

1. Read `sprintengine/plan.md` for the human-authored plan and task context.
2. Run `sprintengine --help` and `sprintengine task next --help` before the first claim in a fresh terminal. On Windows PowerShell, run `.\scripts\sprintengine.cmd --help` and `.\scripts\sprintengine.cmd task next --help`.
3. Run `sprintengine task next --role <your-role> --id <your-agent-id>` to atomically claim the next ready task for your role. On Windows PowerShell, run `.\scripts\sprintengine.cmd task next --role <your-role> --id <your-agent-id>`.
4. If this Claude process was restarted, reuse the same `--id`; `task next` returns that slot's existing active task before claiming new work.
5. If no task is ready, stop and do not manually edit shared state.
6. Update only your own task card with:
   - `sprintengine task status`
   - `sprintengine task note`
   - `sprintengine task log`
7. Before marking work `done`, publish:
   - summary
   - touched files
   - commands run
   - results
   - optional completion feedback percentages on the final status or artifact-ready command when you can assess them
8. After marking one task `done`, stop. A fresh agent must be spawned for additional work.

Architect workflow:

1. New sprintengine runs start with product intake. Do not plan until the product intake artifact is approved, unless you are resuming a legacy architect-first sprintengine.
2. Treat `sprintengine/plan.md` as the final artifact you create, not as a source of truth that already exists.
3. Study the approved product artifact, repository, and current implementation deeply before planning.
4. Ask the user clarifying questions until they confirm the intended outcome, constraints, and acceptance criteria.
5. Use plan reviews when specialist input would improve the plan.
6. Write `sprintengine/plan.md` as a compact technical execution plan for AI agents: short bullets, low-level design, implementation approach, acceptance checks, risks/open questions, and only the context workers need beyond their task cards.
7. Do not include week-based timelines, dates, sprint plans, milestone schedules, duration estimates, or roadmap prose. Represent execution order with task dependencies, not time.
8. Add task cards one at a time with `Sprint Engine plan add-task`; start with tasks that have no dependencies, then add dependent work using `--depends-on`.
9. Include an architect-owned final review scheduling task after implementation, validation, and code review. This task decides which product, security, and performance final reviews are actually needed, records skip rationale for unneeded reviews, adds only the selected specialist review tasks, and then adds a later architect final review task.
10. Do not create product final acceptance, security review, or performance review tasks during initial planning unless the approved requirements or user explicitly require that specialist review before implementation starts.
11. During architect final review, never reopen completed tasks. If product, security, performance, code review, validation, or architect findings require follow-up work, create new tasks and also create a later architect final review task that depends on those follow-ups.
12. During user review, revise the board with `Sprint Engine plan update-task`, `Sprint Engine plan delete-task`, `Sprint Engine plan add-dependency`, and `Sprint Engine plan remove-dependency`.
13. Tell the user the plan is ready for review in the app. The user can inspect it, request specialist plan reviews, or manually spawn specialists from the UI.
14. Do not manually edit `sprintengine/state.yaml`.

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
sprintengine task log --task-id T3 --id frontend-1 --summary "Updated board UI" --file src/renderer/src/components/panels/SprintEngineBoardPanel.tsx --file src/renderer/src/utils/sprintengine.ts --command "npm run typecheck" --result "Passed"
Sprint Engine plan add-task --title "Persist Sprint Engine state" --role developer --path src/renderer/src/store --acceptance "State tracks task ownership and evidence"
Sprint Engine plan add-task --title "Review implementation" --role code_reviewer --depends-on T3 --path src/renderer/src/store --acceptance "Review artifact documents findings or approval"
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
- Plan reviewers write only their own markdown file in `plan-reviews/`; they do not update `state.yaml`, claim tasks, or change the task graph.
- Architects address plan reviews with `Sprint Engine plan address-reviews --actor architect`, then revise `plan.md` directly and task cards through `Sprint Engine plan` commands.
- The app does not call the Python tool. The Python tool is for agents; the user manually spawns specialists from the UI.
- Renderer, preload, and main-process UI IPC must not expose direct sprintengine Python mutations such as `sprintengine artifact approve`, `sprintengine artifact request-changes`, `sprintengine artifact ready`, `sprintengine task status`, or `Sprint Engine plan` updates. UI review actions should focus or message the relevant agent terminal; that agent then uses the Sprint Engine tool.
- If `python3` or `PyYAML` is unavailable, report the blocker instead of silently hand-editing shared state.

If you need the exact state layout, read `references/state-schema.md`.
