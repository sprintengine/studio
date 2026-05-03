---
name: swarm-kanban
description: Coordinate swarm task claiming, status updates, evidence publishing, artifact review gates, and plan reviews for projects that use named `swarm/<team>/state.yaml` and `swarm/<team>/plan.md` files. Use when acting as a swarm architect or worker in this repo's swarm-mode workflow.
---

Use the bundled coordination command instead of hand-editing `swarm/state.yaml` or named `swarm/<team>/state.yaml` files.

Primary command:

- `swarm`

Fallback script:

- POSIX: `.venv/bin/python .agents/skills/swarm-kanban/scripts/swarm_tool.py` when the repo venv exists, otherwise `python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py`
- Windows PowerShell: `& ".\.venv\Scripts\python.exe" ".\scripts\swarm_tool.py"` when the repo venv exists

API discovery:

- When a swarm terminal starts, run `swarm --help`.
- On Windows, if `swarm` fails because `python`, `python3`, or `py` is unavailable or resolves to a Windows Store alias, immediately retry with the repo venv command: `& ".\.venv\Scripts\python.exe" ".\scripts\swarm_tool.py" --help`.
- For Verify Progress / recovery audits, run `swarm recover` and follow the returned prompt. This is audit-only and must not replan, add, delete, or replace tasks.
- Before using a command group or action for the first time, run its `--help` and follow the exact flags shown by the tool.
- Current command groups are `handover`, `init`, `recover`, `join`, `task`, `plan`, `artifact`, and `summary`.
- Worker commands live under `swarm task`: use `task next`, `task claim`, `task status`, `task log`, `task note`, and `task list`.
- `swarm task log` uses repeatable `--file`, `--command`, and `--result` flags.
- `swarm task status --status done` and `swarm artifact ready` accept optional `0`-`100` agent feedback flags such as `--confidence-pct`, `--task-clarity-pct`, and `--hallucination-risk-pct`, short text fields such as `--top-friction`, repeatable `--issue-json` prompt/process improvement signals, and repeatable `--finding-json` role-specific review findings. Omit them when unavailable; existing completion commands remain valid.
- Agent identity is the stable swarm slot id such as `frontend`, `product`, `developer-1`, or `developer-2`, not the Claude session id. If Claude restarts, reuse the same `--id` to continue that slot's active work.
- If calling the Python script directly instead of the `swarm` function, put global `--state <path>` before the subcommand.
- All file paths written into task cards, evidence, artifacts, reviews, plans, or handoffs must be relative to the project root. Never use absolute or machine-specific paths in `--path`, `--file`, artifact paths, markdown artifacts, or task notes.

Worker workflow:

1. Read `swarm/plan.md` for the human-authored plan and task context.
2. Run `swarm --help` and `swarm task next --help` before the first claim in a fresh terminal. On Windows, use `& ".\.venv\Scripts\python.exe" ".\scripts\swarm_tool.py" task next --help` if the `swarm` command cannot find a real Python interpreter.
3. Run `swarm task next --role <your-role> --id <your-agent-id>` to atomically claim the next ready task for your role.
4. If this Claude process was restarted, reuse the same `--id`; `task next` returns that slot's existing active task before claiming new work.
5. If no task is ready, stop and do not manually edit shared state.
6. Update only your own task card with:
   - `swarm task status`
   - `swarm task note`
   - `swarm task log`
7. Before marking work `done`, publish:
   - summary
   - touched files
   - commands run
   - results
   - optional completion feedback percentages on the final status or artifact-ready command when you can assess them
8. After marking one task `done`, stop. A fresh agent must be spawned for additional work.

Architect workflow:

1. New swarm runs start with product intake. Do not plan until the product intake artifact is approved, unless you are resuming a legacy architect-first swarm.
2. Treat `swarm/plan.md` as the final artifact you create, not as a source of truth that already exists.
3. Study the approved product artifact, repository, and current implementation deeply before planning.
4. Ask the user clarifying questions until they confirm the intended outcome, constraints, and acceptance criteria.
5. Use plan reviews when specialist input would improve the plan.
6. Write `swarm/plan.md` as a compact technical execution plan for AI agents: short bullets, low-level design, implementation approach, acceptance checks, risks/open questions, and only the context workers need beyond their task cards.
7. Do not include week-based timelines, dates, sprint plans, milestone schedules, duration estimates, or roadmap prose. Represent execution order with task dependencies, not time.
8. Add task cards one at a time with `swarm plan add-task`; start with tasks that have no dependencies, then add dependent work using `--depends-on`.
9. Include normal final review tasks for performance review after code review, product final acceptance, and architect final review unless the user explicitly opts out.
10. During architect final review, never reopen completed tasks. If product findings or architect findings require follow-up work, create new tasks and also create a later architect final review task that depends on those follow-ups.
11. During user review, revise the board with `swarm plan update-task`, `swarm plan delete-task`, `swarm plan add-dependency`, and `swarm plan remove-dependency`.
12. Tell the user the plan is ready for review in the app. The user can inspect it, request specialist plan reviews, or manually spawn specialists from the UI.
13. Do not manually edit `swarm/state.yaml`.

Use plan reviews when the architect has drafted a complete plan and wants the specialist roster to critique it before execution:

- Specialist starts review mode with `swarm plan start-review --role <role> --id <agent-id>`
- The tool returns a prompt and the exact review file path under `plan-reviews/<agent-id>.md`
- Specialist writes structured markdown feedback in that file and does not claim tasks or implement
- Architect starts feedback mode with `swarm plan address-reviews --actor architect`
- The tool reads every review file and returns a prompt for revising `plan.md` and the task graph

Common commands:

```bash
swarm task list --role frontend
swarm task next --role frontend --id frontend-1
swarm task claim --task-id T3 --id frontend-1
swarm task status --task-id T3 --status in_progress --id frontend-1
swarm task log --task-id T3 --id frontend-1 --summary "Updated board UI" --file src/renderer/src/components/panels/SwarmBoardPanel.tsx --file src/renderer/src/utils/swarm.ts --command "npm run typecheck" --result "Passed"
swarm plan add-task --title "Persist swarm state" --role developer --path src/renderer/src/store --acceptance "State tracks task ownership and evidence"
swarm plan add-task --title "Review implementation" --role code_reviewer --depends-on T3 --path src/renderer/src/store --acceptance "Review artifact documents findings or approval"
swarm plan add-task --title "Review performance" --role performance --depends-on T4 --path src/renderer/src/store --acceptance "Performance review artifact documents measured evidence, findings, or approval"
swarm plan add-task --title "Render task board" --role frontend --depends-on T1 --path src/renderer/src/components/panels --acceptance "Board displays todo, ready, in progress, needs input, and done"
swarm plan update-task --task-id T1 --title "Persist shared swarm state" --acceptance "State tracks task ownership and evidence" --path src/renderer/src/store
swarm plan add-dependency --task-id T2 --depends-on T1
swarm plan remove-dependency --task-id T2 --depends-on T1
swarm plan delete-task --task-id T3 --unlink-dependents
swarm plan start-review --role frontend --id frontend
swarm plan review-status
swarm plan address-reviews --actor architect
swarm plan list
swarm summary
```

Rules:

- Only claim tasks that are ready for your role.
- Prefer `swarm task next` for normal worker execution because it claims under the swarm state lock.
- Only update your own task card.
- Append evidence before moving work to `done`.
- Complete one task per agent, then stop.
- Use `swarm summary` after all tasks are done to summarize touched files, commands, validation results, and manual verification notes.
- Do not rewrite the overall plan unless you are explicitly acting as the architect.
- Architect-created follow-up work from final review must be followed by another architect final review task. Completed tasks stay done; create new tasks for fixes or verification.
- Plan reviewers write only their own markdown file in `plan-reviews/`; they do not update `state.yaml`, claim tasks, or change the task graph.
- Architects address plan reviews with `swarm plan address-reviews --actor architect`, then revise `plan.md` directly and task cards through `swarm plan` commands.
- The app does not call the Python tool. The Python tool is for agents; the user manually spawns specialists from the UI.
- Renderer, preload, and main-process UI IPC must not expose direct swarm Python mutations such as `swarm artifact approve`, `swarm artifact request-changes`, `swarm artifact ready`, `swarm task status`, or `swarm plan` updates. UI review actions should focus or message the relevant agent terminal; that agent then uses the swarm tool.
- If `python3` or `PyYAML` is unavailable, report the blocker instead of silently hand-editing shared state.

If you need the exact state layout, read `references/state-schema.md`.
