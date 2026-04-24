---
name: swarm-kanban
description: Coordinate swarm task claiming, status updates, evidence publishing, mailbox messages, and architect-to-specialist consultations for projects that use named `swarm/<team>/state.yaml` and `swarm/<team>/plan.md` files. Use when acting as a swarm architect or worker in this repo's swarm-mode workflow.
---

Use the bundled coordination command instead of hand-editing `swarm/state.yaml` or named `swarm/<team>/state.yaml` files.

Primary command:

- `swarm`

Fallback script:

- `python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py`

API discovery:

- When a swarm terminal starts, run `swarm --help`.
- For Verify Progress / recovery audits, run `swarm recover` and follow the returned prompt. This is audit-only and must not replan, add, delete, or replace tasks.
- Before using a command for the first time, run `swarm <command> --help` and follow the exact flags shown by the tool.
- Do not invent plural aliases or alternate names. In particular, `append-evidence` uses repeatable `--file`, `--command`, and `--result` flags; it does not accept `--touched-files`, `--commands-ran`, or `--results`.
- Mailbox commands use `--from-agent`, `--to-agent`, `--subject`, and `--body`; they do not accept `--recipient`, `--message`, or `--team`.
- Agent identity is the stable swarm slot id such as `frontend`, `product`, `developer-1`, or `developer-2`, not the Claude session id. If Claude restarts, reuse the same `--agent-id` to continue that slot's active work.
- If calling the Python script directly instead of the `swarm` function, put global `--state <path>` before the subcommand.

Worker workflow:

1. Read `swarm/plan.md` for the human-authored plan and task context.
2. Run `swarm --help` and `swarm claim-next-task --help` before the first claim in a fresh terminal.
3. Run `swarm claim-next-task --role <your-role> --agent-id <your-agent-id>` to atomically claim the next ready task for your role.
4. If this Claude process was restarted, reuse the same `--agent-id`; `claim-next-task` returns that slot's existing active task before claiming new work.
5. Poll your mailbox about every 30 seconds with `swarm get-mailbox --agent-id <your-agent-id> --consume`.
6. If no task is ready, stop and do not manually edit shared state.
7. Update only your own task card with:
   - `swarm set-task-status`
   - `swarm add-note`
   - `swarm append-evidence`
8. Before marking work `done`, publish:
   - summary
   - touched files
   - commands run
   - results
9. After marking one task `done`, stop. A fresh agent must be spawned for additional work.

Architect workflow:

1. Treat `swarm/plan.md` as the final artifact you create, not as a source of truth that already exists.
2. Study the repository and current implementation deeply before planning.
3. Ask the user clarifying questions until they confirm the intended outcome, constraints, and acceptance criteria.
4. Use consultation artifacts when specialist input would improve the plan.
5. Write `swarm/plan.md` as a compact technical execution plan for AI agents: short bullets, low-level design, implementation approach, acceptance checks, risks/open questions, and only the context workers need beyond their task cards.
6. Do not include week-based timelines, dates, sprint plans, milestone schedules, duration estimates, or roadmap prose. Represent execution order with task dependencies, not time.
7. Add task cards one at a time with `swarm plan add-task`; start with tasks that have no dependencies, then add dependent work using `--depends-on`.
8. During user review, revise the board with `swarm plan update-task`, `swarm plan delete-task`, `swarm plan add-dependency`, and `swarm plan remove-dependency`.
9. Tell the user the plan is ready for review in the app. The user can inspect it, request specialist plan reviews, or manually spawn specialists from the UI.
10. Do not manually edit `swarm/state.yaml`.

Use consultations when planning needs specialist input:

- Architect creates a request with `create-consultation`
- Specialist responds with `complete-consultation`
- Architect folds the response back into `swarm/plan.md`

Use plan reviews when the architect has drafted a complete plan and wants the specialist roster to critique it before execution:

- Specialist starts review mode with `swarm plan start-review --role <role> --id <agent-id>`
- The tool returns a prompt and the exact review file path under `plan-reviews/<agent-id>.md`
- Specialist writes structured markdown feedback in that file and does not claim tasks or implement
- Architect starts feedback mode with `swarm plan address-reviews --actor architect`
- The tool reads every review file and returns a prompt for revising `plan.md` and the task graph

Common commands:

```bash
swarm list-ready-tasks --role frontend
swarm claim-next-task --role frontend --agent-id frontend-1
swarm claim-task --task-id T3 --agent-id frontend-1
swarm set-task-status --task-id T3 --status in_progress --actor frontend-1
swarm append-evidence --task-id T3 --actor frontend-1 --summary "Updated board UI" --file src/renderer/src/components/panels/SwarmBoardPanel.tsx --file src/renderer/src/utils/swarm.ts --command "npm run typecheck" --result "Passed"
swarm plan add-task --title "Persist swarm state" --role developer --path src/renderer/src/store --acceptance "State tracks task ownership and evidence"
swarm plan add-task --title "Render task board" --role frontend --depends-on T1 --path src/renderer/src/components/panels --acceptance "Board displays todo, ready, in progress, needs input, and done"
swarm plan update-task --task-id T1 --title "Persist shared swarm state" --acceptance "State tracks task ownership and evidence" --path src/renderer/src/store
swarm plan add-dependency --task-id T2 --depends-on T1
swarm plan remove-dependency --task-id T2 --depends-on T1
swarm plan delete-task --task-id T3 --unlink-dependents
swarm plan start-review --role frontend --id frontend
swarm plan review-status
swarm plan address-reviews --actor architect
swarm plan list
swarm run-summary
swarm get-mailbox --agent-id frontend-1 --consume
swarm send-message --from-agent architect --to-agent frontend-1 --subject "Plan reviewed" --body "The user can spawn you from the UI when ready."
swarm send-message --from-agent frontend-1 --to-agent architect --subject "Re: UX question" --body "Recommended approach..." --reply-to REQ-20260419T130000Z-12345
swarm send-and-receive --from-agent architect --to-agent product --subject "Product validation request" --body "Validate this MVP scope." --timeout-seconds 1800 --consume
swarm broadcast-message --from-agent architect --subject "Plan available" --body "The user can spawn specialists manually from the UI."
swarm create-consultation --request-id UX-001 --from-role architect --to-role frontend --title "Need UX input for launch flow" --task-id T4 --question "Where should manual worker spawning live?"
swarm complete-consultation --request-id UX-001 --actor frontend --summary "Recommend top-level spawn controls." --recommendation "Use persistent specialist spawn buttons above the board."
```

Rules:

- Only claim tasks that are ready for your role.
- Prefer `claim-next-task` for normal worker execution because it claims under the swarm state lock.
- Only update your own task card.
- Append evidence before moving work to `done`.
- Complete one task per agent, then stop.
- Use `swarm run-summary` after all tasks are done to summarize touched files, commands, validation results, and manual verification notes.
- Do not rewrite the overall plan unless you are explicitly acting as the architect.
- Use `send-and-receive` when the architect must pause for a specialist reply before continuing. Responders should include `--reply-to <request-message-id>` when answering.
- Plan reviewers write only their own markdown file in `plan-reviews/`; they do not update `state.yaml`, claim tasks, or change the task graph.
- Architects address plan reviews with `swarm plan address-reviews --actor architect`, then revise `plan.md` directly and task cards through `swarm plan` commands.
- The app does not call the Python tool. The Python tool is for agents; the user manually spawns specialists from the UI.
- If `python3` or `PyYAML` is unavailable, report the blocker instead of silently hand-editing shared state.

If you need the exact state layout, read `references/state-schema.md`.
