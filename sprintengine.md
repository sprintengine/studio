# SprintEngine Mode Summary

Sprint Engine mode becomes a distinct way to create and run a workspace.

On the `Create Workspace` screen, there should be a separate `SprintEngine Mode` tab. Instead of asking for a normal layout/template first, it asks the user for one high-level goal in a single message box. This goal is handed to an `Architect` agent.

The user can also configure the sprintengine before launch:

- choose how many agents to use: `1`, `2`, `3`, `4`, `5`, or `10`
- choose optional skills for each role using checkboxes
- roles include:
  - `Architect`
  - `Developer`
  - `Frontend / UX Engineer`
  - `Tester`

## Agent Roles

The `Architect` is the lead agent.

- uses the highest-intelligence model
- reads the codebase
- creates the implementation plan
- breaks work into tasks
- defines task dependencies
- delegates tasks to workers

The `Frontend / UX Engineer`

- specializes in interface design and frontend implementation
- uses frontend/design-oriented skills
- focuses on UX, layout, styling, and frontend build work

The `Developer`

- handles general engineering / implementation tasks
- picks up tasks from the architect's plan

The `Tester`

- validates completed work
- checks acceptance criteria
- supports review/testing stages

## Task Execution Model

The architect produces a structured task plan.
Each task has:

- title
- description
- assignee
- dependency list
- status

Workers pull tasks from this plan.
Rules:

- they only start work when dependencies are satisfied
- when multiple tasks are available, they work on the one that comes first
- they wait for blocked dependencies instead of skipping ahead arbitrarily
- they continue progressing tasks until complete

So this is not freeform parallel chaos; it is ordered, dependency-aware execution.

## SprintEngine Workspace UI

When the user enters Sprint Engine mode, the workspace UI changes completely.

The user should not see:

- file explorer
- code editor

Instead, they should see:

- a central `Kanban / task board` pane
- live task creation and task progress
- columns such as:
  - `Backlog`
  - `Ready`
  - `In Progress`
  - `Review`
  - `Testing`
  - `Done`

Task cards update live as the architect creates them and as workers execute them.

When the user clicks a task card:

- open a popup/modal
- show full task details and description

On the right side:

- show tiled CLI panes for each active agent
- each pane reflects that agent's live work/session output

## Core UX Intent

Sprint Engine mode is meant to feel like:

- one human engineer directing an AI team
- a live sprint board plus active specialists
- planning, execution, review, and testing happening visibly in one workspace

## Recommended Implementation Direction

From the earlier discussion, the best architecture is:

- one persistent `Architect` orchestrator
- worker agents activated as needed
- not every agent permanently running unless required

So the UI can show configured roles, but only active agents need live CLI sessions at a given moment. That keeps cost and noise under control while preserving the "AI team" experience.
