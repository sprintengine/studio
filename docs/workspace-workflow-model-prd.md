# Workspace Workflow Model PRD

Date: 2026-05-09

## Decision

Multicode should keep distinct workspace modes where the execution model is
meaningfully different.

Workspace direction:

- **Switchboard**: long-lived issue board and agent-pool execution workspace.
- **Sprint Engine**: scoped dependency-graph execution workspace.
- **Campaign**: adaptive goal/milestone workspace.
- **Watchtower**: intake, inspection, and triage panel inside Switchboard.

Swarm should be renamed to Watchtower. Symphony should be renamed to
Switchboard.

Do not collapse Sprint Engine and Switchboard into one engine. They solve
different execution problems.

## Product Thesis

Multicode's value is not multiple boards. Its value is moving work safely from
discovery to planning to agent execution with visibility, evidence, and user
control.

Multicode should remain local-first and terminal-native. Users bring their own
agent CLIs, provider authentication, subscriptions, shell configuration, package
managers, and repo environment. Multicode orchestrates managed terminal sessions;
it does not take custody of provider API keys, become a model gateway, or use
Codex App Server.

The user-facing model:

> Watchtower finds. Switchboard routes and executes queue work. Campaign pursues.
> Sprint Engine executes dependency-graph runs.

## Surface Responsibilities

### Watchtower

Watchtower is the intake and inspection surface.

For MVP, Watchtower should be a panel inside a Switchboard workspace, not a
separate workspace type.

It owns:

- agent-generated codebase findings
- security, bug, quality, architecture, and performance review outputs
- imported work from GitHub, Jira, CI, or other external sources
- inbox and triage state
- task drafts before they become accepted project work

It does not own:

- the durable project board
- execution state
- Sprint Engine task claiming

Core actions:

- run a Watchtower inspection
- view findings in an inbox
- edit a task draft
- merge related findings
- discard a finding
- accept a finding into Switchboard
- optionally send selected accepted work to Campaign or Sprint Engine context

### Switchboard

Switchboard is a long-lived issue board and agent-pool execution workspace. It
organizes accepted work, tracks readiness, and lets a pool of agents pick up
eligible tasks.

Multicode's Switchboard model was developed independently. OpenAI Symphony later
validated the broader issue-control-plane category, but Switchboard is not a
copy of Symphony and should not claim exact Symphony spec compatibility unless
that compatibility is intentionally implemented and tested.

Its Kanban board is the primary UI over issue states, not the whole product
concept.

It owns:

- accepted project tasks
- issue state, backlog, and priority
- board workflow state and tracker sync
- human and agent ownership metadata
- links to findings, runs, artifacts, and external issue IDs
- eligibility metadata for agent dispatch
- observability for active or recently completed agent work
- per-task worktree state
- agent-pool availability and assignment state

Recommended columns:

- Backlog
- Ready
- In Progress
- Testing
- Review
- Done

`Ready` means "eligible for the Switchboard agent pool to pick up." It does not
mean the task belongs in a Sprint Engine dependency graph.

Issue-control-plane target:

- read from an issue tracker or local issue store
- treat issue state as the control plane for agent work
- support bounded concurrency
- maintain authoritative orchestration state for dispatch, retries, and
  reconciliation
- preserve per-issue execution context where practical
- load repo-owned workflow policy from a versioned workflow document
- expose operator-visible status and logs
- create an isolated worktree per claimed task by default
- move implemented work into testing/review before Done

Overlap with OpenAI Symphony is about the category: issue-driven orchestration,
bounded execution, observable agent work, and reconciliation. Multicode should
implement those control-plane concepts through its own local terminal runtime.

Multicode-specific difference:

- Switchboard has its own queue execution model. It should not route normal
  Ready tasks through Sprint Engine.
- Sprint Engine may be offered as an explicit escalation path when selected work
  needs dependency-graph planning, coordinated roles, artifacts, or review gates.
- Multicode does not use Codex App Server. Managed local terminals are the
  execution substrate.

### Campaign

Campaign is the adaptive outcome mode.

It owns:

- high-level goal
- milestone strategy
- reassessment history
- sequence of Sprint Engine runs
- decisions, blockers, and next proposed milestone

Campaign should not have a Kanban board. Its visual model should be a goal,
milestone, and run timeline.

Campaign may interact with Switchboard, but must not depend on it.

Optional integrations:

- publish milestones or follow-up tasks to Switchboard
- pull selected Switchboard tasks into a campaign
- log Campaign progress back to Switchboard

Required integration:

- launch Sprint Engine runs for approved milestones

### Sprint Engine

Sprint Engine is the dependency-aware execution runtime.

It owns:

- run-specific task graph
- dependencies
- safe parallelization
- agent roster
- role assignment
- task claiming
- Ready gate inside the run
- artifacts
- evidence
- review state
- run completion history

Sprint Engine should keep a run view because it is not just a Kanban board. It
is a projection of the execution graph.

Sprint Engine executes through managed local terminal sessions. It runs the
user's installed agent CLIs inside the user's existing environment and captures
logs, evidence, artifacts, status, and failure signals from those sessions.

Sprint Engine's current core shape should be preserved:

- dependency graph is central
- a run is scoped and planned
- agents claim graph nodes
- graph dependencies control safe concurrency
- one shared run worktree may remain the default

Do not adapt Sprint Engine so far that it becomes Switchboard's queue runner.

Non-goal:

- Do not integrate Codex App Server.
- Do not require provider API keys.
- Do not become a hosted model gateway.

## Core Workflow

### Watchtower To Switchboard

1. User opens Watchtower.
2. User runs an inspection or imports external work.
3. Watchtower produces findings and task drafts.
4. User triages the inbox.
5. Accepted items become Switchboard issues/tasks.
6. Rejected or merged findings remain in Watchtower history.

### Switchboard Agent-Pool Execution

1. User accepts or creates tasks on the Switchboard board.
2. User moves tasks into Ready.
3. The Switchboard agent pool claims eligible Ready tasks.
4. Each claimed task gets its own worktree by default.
5. The agent implements the task in that task worktree.
6. Implementation moves the task to Testing or Review, not directly to Done.
7. Tester/reviewer agents or a human verify the work.
8. Approved work is merged or marked Done with evidence attached.

### Switchboard To Sprint Engine Escalation

1. User selects related Switchboard tasks that need dependency planning.
2. User clicks **Run with Sprint Engine**.
3. Sprint Engine imports the selected tasks as inputs to a scoped run.
4. Sprint Engine builds its own dependency graph and executes separately.
5. Sprint Engine can publish evidence, artifacts, and follow-ups back to
   linked Switchboard tasks.

### Campaign To Sprint Engine

1. User opens Campaign.
2. User enters a high-level goal.
3. Campaign proposes the next milestone.
4. User approves the milestone.
5. Campaign launches a Sprint Engine run.
6. Sprint Engine executes the run.
7. Campaign reviews evidence and repo state.
8. Campaign proposes the next milestone or asks for user input.

## MVP Requirements

### Implementation Impact

Switchboard changes the work from "build a Kanban board" to "build a long-lived
issue workspace with its own queue runner and agent pool."

Practical changes:

- Switchboard issues need stable IDs, source tracker metadata, state, priority,
  labels, blocker references, and execution eligibility.
- Switchboard needs orchestration metadata: active run ID, last dispatch attempt,
  retry count, failure reason, current agent/session status, and reconciliation
  status.
- Switchboard needs a local issue store first, even before GitHub/Jira/Linear sync.
- Switchboard needs a repo-owned workflow policy file, such as `WORKFLOW.md`, to
  define what eligible agent work means for that repo.
- Switchboard needs a dispatch layer that can decide which Ready issues are
  eligible to run.
- For MVP, that dispatch layer should assign Ready tasks to the Switchboard
  agent pool, not create Sprint Engine runs by default.
- Switchboard needs per-task worktree creation, tracking, merge, and cleanup.
- Switchboard needs task lifecycle gates: Ready, In Progress, Testing, Review,
  Done.
- Sprint Engine needs a terminal-session contract for spawning, observing,
  cancelling, and summarizing local agent CLI sessions.
- Switchboard can reuse the same terminal-session contract for queue agents.
- Sprint Engine only needs an import path from selected Switchboard issues for
  explicit escalation into a dependency-graph run.
- Watchtower accepted findings should create Switchboard issues, not generic board
  cards.
- Campaign can either launch Sprint Engine directly or create/link Switchboard
  issues for visibility, but it must not require Switchboard.

What does not change:

- Sprint Engine remains the dependency-aware execution engine.
- Switchboard Ready does mean the Switchboard agent pool may pick up the task,
  subject to concurrency and policy limits.
- Watchtower remains the triage inbox for generated and imported work.
- Campaign remains an adaptive outcome loop, not a Kanban board.
- Managed local terminals remain the execution substrate.
- Codex App Server remains out of scope by product principle, not merely
  deferred.

MVP shortcut:

- Do not build a full always-on Switchboard daemon first.
- Build a local Switchboard issue store, Kanban UI, workflow policy file, and
  manual or opt-in agent-pool runner.
- Add daemon-style polling, automatic retries, and external tracker sync after
  the core Ready-to-agent-pool path works.
- Use managed local terminal sessions for all agent execution.

### Must Build

- Keep Switchboard as a separate workspace type.
- Keep Sprint Engine as a separate workspace type.
- Add a Watchtower panel with an inbox inside Switchboard.
- Rename Swarm to Watchtower in user-facing surfaces.
- Add finding and task-draft states: New, Accepted, Merged, Rejected,
  Published.
- Allow accepted Watchtower items to become Switchboard tasks.
- Keep Switchboard as Multicode's issue control plane for accepted work.
- Show a Switchboard Kanban board as the primary UI over issue states.
- Add repo-owned workflow policy support for dispatch behavior.
- Track Switchboard orchestration metadata for dispatch eligibility,
  reconciliation, retries, and active execution status.
- Add a Switchboard agent-pool runner for Ready tasks.
- Create a separate worktree per claimed Switchboard task by default.
- Move implemented Switchboard tasks through Testing and/or Review before Done.
- Preserve Sprint Engine's run-specific dependency graph and execution board.
- Allow explicit **Run with Sprint Engine** escalation from selected
  Switchboard tasks.
- Execute both Switchboard queue tasks and Sprint Engine run tasks through
  managed local terminal sessions.
- Add a Campaign panel with goal, milestone, current run, and reassessment
  sections.
- Let Campaign launch Sprint Engine runs without requiring Switchboard.

### Should Build

- Watchtower inspection presets: Security, Bugs, Quality, Architecture,
  Performance.
- Background Watchtower agent sessions that can be inspected but do not dominate
  the UI.
- Source metadata on every task: Manual, Watchtower, GitHub, Jira, Campaign,
  Sprint Engine follow-up.
- Human vs agent ownership metadata.
- GitHub-sourced task claim coordination through visible issue comments and
  canonical branches so separate local clones do not silently work the same
  external issue.
- Basic duplicate detection for Watchtower findings.
- A task detail view showing linked finding, linked run, evidence, and artifacts.
- Notes comparing Switchboard to OpenAI Symphony without claiming direct
  compatibility.
- Optional local issue-store adapter before GitHub/Jira/Linear integrations.
- Provider-agnostic terminal session adapters for Codex CLI, Claude Code, and
  other local agent CLIs.
- Switchboard worktree cleanup and conflict-resolution UX.
- Tester/reviewer agent roles for Switchboard Testing and Review columns.

### Defer

- Separate Watchtower Kanban board.
- Separate Campaign Kanban board.
- Full bidirectional GitHub/Jira sync.
- Private/internal-only comment sync controls for GitHub-sourced Switchboard
  work.
- Complex multi-board routing.
- Removing Sprint Engine's internal run board.
- Rewriting Sprint Engine as a generic board column system.
- Full always-on Switchboard daemon behavior for every workspace.
- Forcing Switchboard execution through Sprint Engine by default.
- Adapting Sprint Engine until it becomes a queue runner.
- Provider API-key custody or model-gateway behavior.
- Codex App Server integration.

## Data Model Direction

Use shared linking fields where practical, but keep workflow-specific state
authorities separate.

Recommended concepts:

- **Finding**: raw Watchtower observation or imported candidate.
- **Task draft**: editable proposed task derived from a finding.
- **Switchboard issue**: accepted project task, shown in Switchboard and eligible for
  orchestration.
- **Switchboard execution task**: queue task claimed by an agent pool worker in a
  task-specific worktree.
- **Run task**: Sprint Engine dependency-graph execution node, linked to one or
  more Switchboard issues, Watchtower findings, or Campaign milestones.
- **Milestone**: Campaign step toward a goal, linked to one or more Sprint
  Engine runs.

Sprint Engine run state remains authoritative for dependency-aware execution.
Switchboard owns long-lived issue and queue execution state. The two systems may
link to each other, but neither should directly mutate the other's internal
state.

The execution substrate is managed local terminal sessions. Switchboard queue
execution and Sprint Engine graph execution both use that substrate, but they
remain separate execution models.

## Branding And Styling

### Naming

- Swarm becomes **Watchtower**.
- Symphony is replaced by **Switchboard**.
- Sprint Engine remains **Sprint Engine**.

### Color Direction

Keep Multicode as one dark, dense engineering command center. Module accents
should identify location, not replace semantic state colors.

Recommended accents:

- **Watchtower**: copper/orange, inherited from the prior Swarm direction.
  Suggested accent `#d97757`, hover text `#ffb088`, deep fill `#241513`.
- **Switchboard**: violet. Suggested accent `#7c5cf2`, deep fill `#1a1530`.
- **Campaign**: steel/royal blue. Suggested accent `#355da8`, deep fill
  `#111b30`.
- **Sprint Engine**: no single module accent. Use semantic execution colors:
  emerald ready/done, amber needs input, warm amber running, red blocked/error.

Primary buttons and focus rings should continue using the Multicode app accent
`#5c7cff`.

### Visual Treatment

Current block-style retro images are useful for internal flavor but should be
revised for production positioning.

Recommendation:

- Keep the dark command-center identity.
- Move from decorative block illustrations toward product-real imagery:
  real panels, task graphs, run timelines, evidence cards, and triage inboxes.
- Use screenshots or screenshot-like composites as the main product imagery.
- Reserve stylized block imagery for splash states, empty states, or light brand
  texture.
- Show actual product concepts in hero/marketing assets: Watchtower inbox,
  Switchboard board and queue agents, Campaign timeline, Sprint Engine graph.

The production visual language should feel precise, technical, and inspectable,
not playful or toy-like.

## Production Target

Production should feel like one workspace with multiple coordinated command
surfaces, not four unrelated apps.

The user should be able to answer:

- Where do new findings and imported issues go? Watchtower.
- Where does accepted work enter a long-lived agent queue? Switchboard.
- Where do I pursue a big goal? Campaign.
- Where do agents execute independent queue work? Switchboard.
- Where do agents execute dependency-graph work? Sprint Engine.

## Open Decisions

- Should Watchtower be available as a left-panel mode, bottom drawer, or full
  center panel?
- Should Campaign milestones be persisted as first-class records or derived
  from a campaign plan document plus linked runs?
- How should Switchboard task worktrees be named, merged, and cleaned up?
- How much Sprint Engine status should mirror onto Switchboard cards after
  escalation?
- Should GitHub/Jira import enter Watchtower first by default, or should trusted
  imports be allowed to bypass triage?
