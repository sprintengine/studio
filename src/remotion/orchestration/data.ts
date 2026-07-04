// Pre-baked sprint fixture for the orchestration film. Production-shaped data,
// never placeholder text — plausible task titles, real Sprint Engine roles, and
// a real dependency DAG. Nothing here fetches or randomises; every frame renders
// from these constants so the render is deterministic.

import type { ModelId, RoleId } from './tokens'

export const epic = {
  key: 'MTR',
  title: 'Usage metering & billing',
  brief:
    'Meter product usage per workspace, aggregate it hourly, and bill it — with a dashboard, invoice export, and rate-limit guardrails.',
}

export type LaneId = 'todo' | 'ready' | 'in_progress' | 'review' | 'testing' | 'done'

export const lanes: { id: LaneId; label: string }[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'testing', label: 'Testing' },
  { id: 'done', label: 'Done' },
]

export type SprintTask = {
  id: string
  title: string
  role: RoleId
  model: ModelId
  dependsOn: string[]
  // 'frontend' | 'backend' track drives which review gates the task clears.
  track: 'frontend' | 'backend'
}

// A real dependency DAG: two independent roots, parallel middle branches that
// converge on a release-gate leaf. buildTopoLevels() below assigns each task to
// a topological level — the same layered layout the live task-graph view uses.
export const tasks: SprintTask[] = [
  { id: 'MTR-01', title: 'Usage event schema', role: 'developer', model: 'codex-5.5', dependsOn: [], track: 'backend' },
  { id: 'MTR-02', title: 'Metering data model', role: 'developer', model: 'glm-5.2', dependsOn: [], track: 'backend' },
  { id: 'MTR-03', title: 'Hourly aggregation pipeline', role: 'developer', model: 'codex-5.5', dependsOn: ['MTR-01', 'MTR-02'], track: 'backend' },
  { id: 'MTR-04', title: 'Billing API endpoints', role: 'developer', model: 'codex-5.5', dependsOn: ['MTR-02'], track: 'backend' },
  { id: 'MTR-05', title: 'Usage dashboard UI', role: 'frontend', model: 'opus-4.8', dependsOn: ['MTR-03'], track: 'frontend' },
  { id: 'MTR-06', title: 'Invoice PDF export', role: 'developer', model: 'glm-5.2', dependsOn: ['MTR-04'], track: 'backend' },
  { id: 'MTR-07', title: 'Rate-limit guardrails', role: 'security', model: 'codex-5.5', dependsOn: ['MTR-04'], track: 'backend' },
  { id: 'MTR-08', title: 'Plan upgrade flow UI', role: 'frontend', model: 'opus-4.8', dependsOn: ['MTR-05', 'MTR-06'], track: 'frontend' },
  { id: 'MTR-09', title: 'Acceptance & release checks', role: 'tester', model: 'opus-4.8', dependsOn: ['MTR-07', 'MTR-08'], track: 'frontend' },
]

// Kahn's-algorithm topological levelling — mirrors buildTaskGraphLayout in
// src/renderer/src/components/panels/sprintEngineTaskGraph.ts. Level 0 = no
// dependencies (runnable immediately); each dependent sits one level past its
// deepest dependency. Tasks sharing a level are independent → run in parallel.
export function buildTopoLevels(items: SprintTask[]): Map<string, number> {
  const byId = new Map(items.map((task) => [task.id, task]))
  const level = new Map<string, number>()
  const resolve = (id: string, seen: Set<string>): number => {
    if (level.has(id)) return level.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const task = byId.get(id)
    const deps = task?.dependsOn.filter((depId) => byId.has(depId)) ?? []
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((depId) => resolve(depId, seen))) + 1
    level.set(id, value)
    return value
  }
  items.forEach((task) => resolve(task.id, new Set()))
  return level
}

// The team. The most-capable model (Fable 5) takes architecture and the
// high-judgment reviews (UX, spec, release); Codex builds and reviews the
// backend and runs security; Opus builds the frontend and runs acceptance; a
// second backend dev runs on GLM. Each role runs on the vendor the user staffs
// — the whole point of the film.
export type RosterMember = {
  role: RoleId
  model: ModelId
  state: 'planning' | 'running' | 'gate' | 'queued'
}

export const roster: RosterMember[] = [
  { role: 'architect', model: 'fable-5', state: 'planning' },
  { role: 'product', model: 'fable-5', state: 'planning' },
  { role: 'frontend', model: 'opus-4.8', state: 'running' },
  { role: 'developer', model: 'codex-5.5', state: 'running' },
  { role: 'developer', model: 'glm-5.2', state: 'running' },
  { role: 'security', model: 'codex-5.5', state: 'gate' },
  { role: 'code_reviewer', model: 'codex-5.5', state: 'gate' },
  { role: 'nuclear_reviewer', model: 'codex-5.5', state: 'gate' },
  { role: 'spec_reviewer', model: 'fable-5', state: 'queued' },
  { role: 'ui_ux_reviewer', model: 'fable-5', state: 'queued' },
  { role: 'production_readiness_reviewer', model: 'fable-5', state: 'queued' },
  { role: 'tester', model: 'opus-4.8', state: 'queued' },
]

// The review chain a change clears before it ships, grouped exactly as the
// brief frames it: backend gates, frontend gates, then shared gates. Security
// is the one gate the user often staffs to a different vendor (Codex / Mythos).
export type ReviewGate = {
  role: RoleId
  model: ModelId
  group: 'backend' | 'frontend' | 'shared'
}

export const reviewGates: ReviewGate[] = [
  { role: 'code_reviewer', model: 'codex-5.5', group: 'backend' },
  { role: 'nuclear_reviewer', model: 'codex-5.5', group: 'backend' },
  { role: 'ui_ux_reviewer', model: 'fable-5', group: 'frontend' },
  { role: 'spec_reviewer', model: 'fable-5', group: 'frontend' },
  { role: 'tester', model: 'opus-4.8', group: 'shared' },
  { role: 'production_readiness_reviewer', model: 'fable-5', group: 'shared' },
  { role: 'security', model: 'codex-5.5', group: 'shared' },
]

// Lane transitions for the execute/kanban scene, scheduled as frame offsets
// from that scene's entrance. Ordered so dependency roots clear first and
// dependents follow — a legible topological cascade, several tasks in flight.
export const laneTransitions: { taskId: string; lane: LaneId; at: number }[] = [
  { taskId: 'MTR-01', lane: 'ready', at: 8 },
  { taskId: 'MTR-02', lane: 'ready', at: 14 },
  { taskId: 'MTR-01', lane: 'in_progress', at: 26 },
  { taskId: 'MTR-02', lane: 'in_progress', at: 32 },
  { taskId: 'MTR-04', lane: 'ready', at: 44 },
  { taskId: 'MTR-01', lane: 'review', at: 54 },
  { taskId: 'MTR-04', lane: 'in_progress', at: 60 },
  { taskId: 'MTR-02', lane: 'review', at: 66 },
  { taskId: 'MTR-03', lane: 'ready', at: 74 },
  { taskId: 'MTR-01', lane: 'done', at: 82 },
  { taskId: 'MTR-03', lane: 'in_progress', at: 90 },
  { taskId: 'MTR-02', lane: 'done', at: 96 },
  { taskId: 'MTR-04', lane: 'review', at: 104 },
  { taskId: 'MTR-07', lane: 'ready', at: 110 },
  { taskId: 'MTR-06', lane: 'ready', at: 116 },
  { taskId: 'MTR-03', lane: 'review', at: 124 },
  { taskId: 'MTR-04', lane: 'done', at: 130 },
  { taskId: 'MTR-07', lane: 'in_progress', at: 136 },
  { taskId: 'MTR-06', lane: 'in_progress', at: 142 },
  { taskId: 'MTR-05', lane: 'ready', at: 148 },
  { taskId: 'MTR-03', lane: 'testing', at: 154 },
  { taskId: 'MTR-05', lane: 'in_progress', at: 162 },
  { taskId: 'MTR-03', lane: 'done', at: 168 },
  { taskId: 'MTR-06', lane: 'review', at: 174 },
  { taskId: 'MTR-07', lane: 'review', at: 180 },
  { taskId: 'MTR-05', lane: 'review', at: 188 },
  { taskId: 'MTR-08', lane: 'ready', at: 196 },
  { taskId: 'MTR-06', lane: 'done', at: 202 },
  { taskId: 'MTR-08', lane: 'in_progress', at: 208 },
]

// Resolve a task's lane at a given offset within the execute scene.
export function laneAtOffset(taskId: string, offset: number): LaneId {
  let lane: LaneId = 'todo'
  for (const transition of laneTransitions) {
    if (transition.taskId === taskId && offset >= transition.at) lane = transition.lane
  }
  return lane
}

export function lastMoveOffset(taskId: string, offset: number): number | null {
  let movedAt: number | null = null
  for (const transition of laneTransitions) {
    if (transition.taskId === taskId && offset >= transition.at) movedAt = transition.at
  }
  return movedAt
}
