---
name: swarm-kanban
description: Coordinate swarm task claiming, status updates, evidence publishing, mailbox messages, and architect-to-specialist consultations for projects that use named `swarm/<team>/state.yaml` and `swarm/<team>/plan.md` files. Use when acting as a swarm architect or worker in this repo's swarm-mode workflow.
---

Use the bundled coordination command instead of hand-editing `swarm/state.yaml` or named `swarm/<team>/state.yaml` files.

Primary command:

- `swarm`

Fallback script:

- `python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py`

Worker workflow:

1. Read `swarm/plan.md` for the human-authored plan and task context.
2. Run `swarm claim-next-task --role <your-role> --agent-id <your-agent-id>` to atomically claim the next ready task for your role.
3. Poll your mailbox about every 30 seconds with `swarm get-mailbox --agent-id <your-agent-id> --consume`.
4. If no task is ready, stay idle and do not manually edit shared state.
5. Update only your own task card with:
   - `swarm set-task-status`
   - `swarm add-note`
   - `swarm append-evidence`
6. Before marking work `done`, publish:
   - summary
   - touched files
   - commands run
   - results
7. After marking a task `done`, run `claim-next-task` again to pick up the next ready task for your role.

Architect workflow:

1. Treat `swarm/plan.md` as the final artifact you create, not as a source of truth that already exists.
2. Study the repository and current implementation deeply before planning.
3. Ask the user clarifying questions until they confirm the intended outcome, constraints, and acceptance criteria.
4. Use consultation artifacts when specialist input would improve the plan.
5. Write `swarm/plan.md` with the low-level design, implementation approach, risks, acceptance criteria, and specialist task breakdown.
6. Create `swarm/tasks.json` using `swarm/tasks.template.json` and `swarm/tasks.schema.json`.
7. Validate the task graph with `swarm validate-tasks --file swarm/tasks.json`.
8. Replace the kanban task graph with `swarm replace-tasks --actor architect --file swarm/tasks.json`.
9. Mark the final plan ready with `swarm mark-plan-ready --actor architect`.
10. Tell the user the plan is ready for review only after `mark-plan-ready` succeeds.
11. Do not manually edit `swarm/state.yaml`.

Use consultations when planning needs specialist input:

- Architect creates a request with `create-consultation`
- Specialist responds with `complete-consultation`
- Architect folds the response back into `swarm/plan.md`

Common commands:

```bash
swarm list-ready-tasks --role frontend
swarm claim-next-task --role frontend --agent-id frontend-1
swarm claim-task --task-id T3 --agent-id frontend-1
swarm set-task-status --task-id T3 --status in_progress --actor frontend-1
swarm append-evidence --task-id T3 --actor frontend-1 --summary "Updated board UI" --file src/renderer/src/components/panels/SwarmBoardPanel.tsx --command "npm run typecheck" --result "Passed"
swarm run-summary
swarm get-mailbox --agent-id frontend-1 --consume
swarm send-message --from-agent architect --to-agent frontend-1 --subject "Plan approved" --body "Claim your next ready task."
swarm broadcast-message --from-agent architect --subject "Plan ready" --body "Review your mailbox and claim ready work."
swarm validate-tasks --file swarm/tasks.json
swarm replace-tasks --actor architect --file swarm/tasks.json
swarm mark-plan-ready --actor architect
swarm create-consultation --request-id UX-001 --from-role architect --to-role frontend --title "Need UX input for approval flow" --task-id T4 --question "Where should plan approval live?"
swarm complete-consultation --request-id UX-001 --actor frontend --summary "Recommend a top-level approval banner." --recommendation "Use a persistent approval strip above the board."
```

Rules:

- Only claim tasks that are ready for your role.
- Prefer `claim-next-task` for normal worker execution because it claims under the swarm state lock.
- Only update your own task card.
- Append evidence before moving work to `done`.
- Use `swarm run-summary` after all tasks are done to summarize touched files, commands, validation results, and manual verification notes.
- Do not rewrite the overall plan unless you are explicitly acting as the architect.
- Only use `validate-tasks`, `replace-tasks`, and `mark-plan-ready` as the architect during planning, before the user approves the plan.
- If `python3` or `PyYAML` is unavailable, report the blocker instead of silently hand-editing shared state.

If you need the exact state layout, read `references/state-schema.md`.
