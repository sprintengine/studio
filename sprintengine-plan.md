# Implementation Plan

Build real Sprint Engine mode in 6 phases. Goal: turn the current sprintengine UI mock into a state-driven, architect-led orchestration system.

## Phase 1: Solidify SprintEngine State

Objective: make Sprint Engine workspaces first-class persisted entities.

Files:

- [workspace.ts](./src/renderer/src/types/workspace.ts)
- [workspaceStore.ts](./src/renderer/src/store/workspaceStore.ts)
- [sprintengine.ts](./src/renderer/src/utils/sprintengine.ts)

Tasks:

- Expand `SwarmState` to include:
  - `phase: 'planning' | 'executing' | 'paused' | 'completed' | 'error'`
  - `tasks`
  - `events`
  - `artifacts`
  - `activeAssignments`
- Expand `SwarmTask` to include:
  - `role`
  - `acceptanceCriteria`
  - `files`
  - `priority`
  - `notes`
- Add `SwarmArtifact` and `SwarmEvent` types.
- Ensure Sprint Engine state survives persist/import/export.
- Ensure Sprint Engine agents are seeded from agent count and roles.

Acceptance:

- Creating a Sprint Engine workspace persists goal, skills, roster, tasks, and phase.
- Reopening/importing a Sprint Engine workspace restores the board exactly.

## Phase 2: Replace Mock Board Data With Real Store Data

Objective: make the board purely store-driven.

Files:

- [SprintEngineBoardPanel.tsx](./src/renderer/src/components/panels/SprintEngineBoardPanel.tsx)
- [workspaceStore.ts](./src/renderer/src/store/workspaceStore.ts)

Tasks:

- Remove any remaining locally generated mock tasks from the panel.
- Render all columns from `workspace.swarmState.tasks`.
- Add store actions for:
  - `setSwarmPhase`
  - `setSwarmTasks`
  - `updateSwarmTask`
  - `appendSwarmEvent`
  - `appendSwarmArtifact`
  - `setSwarmAssignment`
- Add task detail modal support from store data only.

Acceptance:

- Board is fully driven by workspace state.
- Changing task state in store immediately updates the UI.

## Phase 3: Architect Planning Service

Objective: when Sprint Engine workspace starts, architect generates the real plan.

Files to add:

- `src/renderer/src/services/swarmPlanner.ts`
- `src/renderer/src/services/swarmRunner.ts`

Files to update:

- [TemplateSelector.tsx](./src/renderer/src/components/workspace/TemplateSelector.tsx)
- [WorkspaceManager.tsx](./src/renderer/src/components/workspace/WorkspaceManager.tsx)
- [workspaceStore.ts](./src/renderer/src/store/workspaceStore.ts)

Tasks:

- On first load of a Sprint Engine workspace, set phase to `planning`.
- Launch architect planning flow automatically.
- Architect input should include:
  - user goal
  - folder path
  - selected skills
  - agent count
- Architect must return structured output, not freeform only.

Required planner output schema:

```ts
type PlannerOutput = {
  repoSummary: string
  tasks: Array<{
    id: string
    title: string
    description: string
    role: 'architect' | 'developer' | 'frontend' | 'tester'
    dependsOn: string[]
    acceptanceCriteria: string[]
    files: string[]
    priority: number
  }>
}
```

Acceptance:

- A new Sprint Engine workspace automatically generates tasks from architect output.
- Seed mock tasks are no longer used.

## Phase 4: Scheduler / Assignment Engine

Objective: assign ready tasks to idle workers based on dependencies.

Files to add:

- `src/renderer/src/services/swarmScheduler.ts`

Files to update:

- `swarmRunner.ts`
- [workspaceStore.ts](./src/renderer/src/store/workspaceStore.ts)

Tasks:

- Implement dependency resolution:
  - task becomes `ready` only when all `dependsOn` are `done`
- Implement worker assignment:
  - pick idle agent
  - choose first eligible ready task by priority/order
  - assign task
  - mark `in_progress`
- Architect remains persistent.
- Workers do not self-assign.

Scheduler rules:

- blocked tasks stay blocked
- only ready tasks can start
- if multiple are ready, take the earliest/highest-priority one
- tester tasks only start when prerequisites are complete

Acceptance:

- Tasks move from `backlog` to `ready` automatically.
- Idle workers receive eligible tasks without manual intervention.

## Phase 5: Worker Context Handoff

Objective: pass compact structured task packets to workers.

Files:

- `swarmRunner.ts`
- `swarmPlanner.ts`
- [TerminalView.tsx](./src/renderer/src/components/panels/TerminalView.tsx) only if needed for display behavior

Tasks:

- Create `WorkerTaskPacket` shape:

```ts
type WorkerTaskPacket = {
  taskId: string
  role: string
  goal: string
  repoSummary: string
  taskSummary: string
  acceptanceCriteria: string[]
  relevantFiles: string[]
  priorArtifacts: string[]
  constraints: string[]
}
```

- Architect prepares or the app derives this packet.
- Send this packet to the worker runtime.
- Capture worker completion summary and attach as artifact/event.
- Do not resend full repo context unless needed.

Acceptance:

- Worker receives scoped task context.
- Board stores the worker's output summary and touched files.

## Phase 6: Review / Testing Loop

Objective: finish the lifecycle so tasks can truly complete.

Files:

- `swarmRunner.ts`
- `swarmScheduler.ts`
- [SprintEngineBoardPanel.tsx](./src/renderer/src/components/panels/SprintEngineBoardPanel.tsx)

Tasks:

- After worker completion, move task to `review` or `testing`.
- Tester validates acceptance criteria.
- On pass:
  - mark task `done`
- On fail:
  - move task back to `in_progress` or `blocked`
  - attach tester notes artifact
- Add event log to board/task modal.

Acceptance:

- Tasks complete through a visible review/testing lifecycle.
- Failed work returns to execution with notes.

## Suggested Service Boundaries

- `swarmPlanner.ts`
  - talks to architect
  - parses structured planning output
- `swarmScheduler.ts`
  - decides what task is eligible next
  - assigns work to idle agents
- `swarmRunner.ts`
  - orchestrates lifecycle
  - updates store
  - reacts to worker/tester completion

## Important Constraints

- Store is the source of truth, not terminal output.
- Board state must always reflect actual orchestration state.
- Architect should emit structured data.
- Workers should receive scoped packets, not full raw repo context by default.
- Do not make every configured agent permanently active if not needed.

## First Milestone

Ship this first:

1. full `SwarmState` model
2. architect auto-planning
3. board populated from real planner tasks
4. no worker execution yet

That gives a real Sprint Engine planning experience before automation gets more complex.
