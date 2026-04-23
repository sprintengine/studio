# Swarm State Schema

The shared swarm coordination files are:

- `swarm/plan.md`
  - architect-authored low-level design and task plan
- `swarm/<team-slug>/state.yaml`
  - machine-readable kanban board and run state
- `swarm/<team-slug>/plan-reviews/<agent-id>.md`
  - specialist-authored markdown review of the current architect plan
- `swarm/<team-slug>/mailboxes/<agent-id>/*.json`
  - durable agent-to-agent messages

The Python tool is the preferred write path for `swarm/state.yaml`.

Use `swarm run-summary` to print a read-only completion summary from task evidence.
Use `swarm get-mailbox --agent-id <agent-id> --consume` to read and consume mailbox messages.
Use `swarm send-message` or `swarm broadcast-message` to route instructions or updates to agent mailboxes.
Use `swarm claim-next-task --role <role> --agent-id <agent-id>` for normal worker task claiming.
Use `swarm plan add-task` to build the task board one task at a time while planning.
Use `swarm plan update-task`, `swarm plan delete-task`, `swarm plan add-dependency`, and `swarm plan remove-dependency` to revise the board during user review.
Use `swarm plan start-review --role <role> --id <agent-id>` when a specialist should critique the architect plan before execution.
Use `swarm plan review-status` to summarize expected, missing, stale, and unexpected plan review files.
Use `swarm plan address-reviews --actor architect` when the architect is ready to revise the plan from specialist feedback.
The app does not call the Python tool; the user reviews `plan.md` and manually spawns specialists from the UI.

## Task Card Fields

- `id`
- `title`
- `description`
- `role`
- `status`
  - `todo`
  - `in_progress`
  - `needs_input`
  - `done`
- `ownerAgentId`
- `dependsOn`
- `ownedPaths`
- `acceptanceCriteria`
- `implementationNotes`
- `evidence`
  - `summary`
  - `touchedFiles`
  - `commandsRan`
  - `results`
- `notes`
- `startedAt`
- `completedAt`

## Coordination Rules

- Board `Ready` is derived, not stored as a separate task status.
- A task is ready when:
  - `status` is `todo`
  - all dependencies are `done`
  - `ownerAgentId` is empty
- Only one task should be claimed by a worker at a time; `claim-next-task` returns the existing active task instead of claiming another one.
- Consultations are stored as artifacts and events.
- Agents should poll their mailbox about every 30 seconds while active.
- Consumed mailbox messages are moved into the agent mailbox `read/` folder.
- The architect builds and revises the task graph during planning with `swarm plan` commands.
- Product strategist tasks and consultations should capture market, competitor, audience, positioning, workflow, and adoption-risk guidance.
- Workers should not rewrite the plan or change other workers' task cards.

## Consultation Flow

1. Architect creates a structured consultation request.
2. Specialist completes the consultation response.
3. Architect updates `swarm/plan.md`.

## Plan Review Flow

1. Architect finishes a draft `plan.md` and task graph.
2. Specialist runs `swarm plan start-review --role <role> --id <agent-id>`.
3. Specialist writes or replaces `plan-reviews/<agent-id>.md` using the returned prompt.
4. Architect runs `swarm plan address-reviews --actor architect`.
5. Architect updates `plan.md` directly and updates task cards only through `swarm plan` commands.

Review files include the current plan fingerprint. If `plan.md` changes after a review, `swarm plan review-status` marks that review stale.
