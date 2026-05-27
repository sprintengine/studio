import type {
  SprintEngineRole,
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineTask,
  SprintEngineTaskStatus,
} from '../types/workspace'
import {
  getSprintEngineRoleLabel,
  orderSprintEngineRosterRoles,
  type SprintEngineAgentRosterItem,
} from './sprintengine'

// Compatibility fallback: the bundled all-roles list. Use this only when no
// `SprintEngineRoleRegistry` is available — the registry is the runtime
// authority for available roles, and bundled constants are last-resort
// fallbacks per `knowledge/multicode/sprint-engine.md`.
export const BUNDLED_SPRINT_ENGINE_ADDABLE_ROLES: readonly SprintEngineRole[] = [
  'architect',
  'product',
  'frontend',
  'developer',
  'code_reviewer',
  'spec_reviewer',
  'performance',
  'tester',
  'security',
]

// Bundled summary copy for the live Sprint Engine board's add-member panel.
// The new-workspace wizard's copy is shorter (see
// `BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES` below) because that surface
// is about staffing intent rather than describing the live actor.
export const BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES: Record<SprintEngineRole, string> = {
  architect: 'Plans the run and gates readiness.',
  product: 'Shapes scope, positioning, audience fit, and priority tradeoffs.',
  developer: 'Builds implementation and integration work.',
  frontend: 'Owns interaction design, visual quality, and UI implementation.',
  code_reviewer: 'Reviews implementation quality, regressions, and evidence.',
  spec_reviewer: 'Checks implementation against requirements, acceptance criteria, and tests.',
  performance: 'Reviews latency, CPU, memory, runtime cost, and measurement gaps.',
  tester: 'Validates behavior, regressions, and acceptance criteria.',
  security: 'Reviews trust boundaries, command safety, data handling, and hardening.',
}

// Bundled summary copy for the new-workspace roster wizard. Kept separate
// from the live-board copy so each surface can speak in the right tense
// without forcing the other to change.
export const BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES: Record<SprintEngineRole, string> = {
  architect: 'Plans the work, owns dependencies, gates reviews.',
  product: 'Clarifies scope, tradeoffs, and acceptance criteria.',
  frontend: 'Implements UI, interaction states, and polish.',
  developer: 'Builds core logic, integrations, and refactors.',
  code_reviewer: 'Reviews implementation quality before validation.',
  spec_reviewer: 'Checks implementation against requirements and acceptance criteria.',
  performance: 'Reviews latency, runtime cost, and measurement gaps.',
  tester: 'Runs acceptance checks and publishes evidence.',
  security: 'Reviews trust boundaries, secrets, and abuse cases.',
}

const WIZARD_CUSTOM_REGISTRY_ROLE_SUMMARY = 'Custom registry role.'

// Resolve the wizard summary for a role. Bundled roles use the wizard copy;
// custom registry roles fall back to their registry `summary` if present, then
// to a generic label so unknown ids still render. Centralizing this here so
// the new-workspace roster table consumes the same shared module as the live
// board.
export function getSprintEngineWizardRoleSummary(
  roleId: SprintEngineRoleId,
  registry?: SprintEngineRoleRegistry | null,
): string {
  if (isBundledWizardRole(roleId)) return BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES[roleId]
  const fromRegistry = registry?.roles?.[roleId]?.summary
  if (typeof fromRegistry === 'string' && fromRegistry.trim()) return fromRegistry.trim()
  return WIZARD_CUSTOM_REGISTRY_ROLE_SUMMARY
}

function isBundledWizardRole(role: SprintEngineRoleId): role is SprintEngineRole {
  return Object.prototype.hasOwnProperty.call(BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES, role)
}

export type SprintEngineAddMemberOption = {
  role: SprintEngineRoleId
  label: string
  summary: string
  activeForRole: number
  openTasksForRole: number
}

type RosterLike = Pick<SprintEngineAgentRosterItem, 'role'>
type TaskLike = Pick<SprintEngineTask, 'role' | 'status'>

export type SprintEngineAddMemberOptionsInput = {
  registry?: SprintEngineRoleRegistry | null
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null
  roster: Iterable<RosterLike>
  tasks: Iterable<TaskLike>
  // Per-role summary copy. Bundled board summary is used when not provided.
  // Registry metadata `summary` is the next fallback; final fallback is a
  // generic "Custom registry role." label so unknown roles still render.
  roleSummaries?: Partial<Record<SprintEngineRoleId, string>> | null
  fallbackSummary?: string
}

const CUSTOM_REGISTRY_ROLE_SUMMARY = 'Custom registry role.'

function countByRole<T extends { role: SprintEngineRoleId }>(items: Iterable<T>): Map<SprintEngineRoleId, number> {
  const counts = new Map<SprintEngineRoleId, number>()
  for (const item of items) {
    counts.set(item.role, (counts.get(item.role) ?? 0) + 1)
  }
  return counts
}

// Registry-aware list of roles that can be added to the Sprint Engine
// roster. Falls back to the bundled order when no registry is provided so
// callers without registry access still render a stable list.
export function listSprintEngineAddableRoles(
  registry?: SprintEngineRoleRegistry | null,
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null,
): SprintEngineRoleId[] {
  return orderSprintEngineRosterRoles(registry ?? null, disabledRoleIds ?? null)
}

export function buildSprintEngineAddMemberOptions(
  input: SprintEngineAddMemberOptionsInput,
): SprintEngineAddMemberOption[] {
  const roleIds = listSprintEngineAddableRoles(input.registry ?? null, input.disabledRoleIds ?? null)
  const rosterCounts = countByRole(input.roster)
  const openTaskCounts = new Map<SprintEngineRoleId, number>()
  for (const task of input.tasks) {
    if (task.status === 'done') continue
    openTaskCounts.set(task.role, (openTaskCounts.get(task.role) ?? 0) + 1)
  }
  const summaryOverrides = input.roleSummaries ?? null
  const fallbackSummary = input.fallbackSummary ?? CUSTOM_REGISTRY_ROLE_SUMMARY
  return roleIds.map((role) => {
    const label = getSprintEngineRoleLabel(role, input.registry ?? null)
    const summary = resolveRoleSummary(role, input.registry ?? null, summaryOverrides, fallbackSummary)
    return {
      role,
      label,
      summary,
      activeForRole: rosterCounts.get(role) ?? 0,
      openTasksForRole: openTaskCounts.get(role) ?? 0,
    }
  })
}

// First role with open work but no agent on the roster yet. Used by the
// board's "Add member" dialog to preselect a sensible default.
export function findFirstUncoveredSprintEngineRole(
  input: SprintEngineAddMemberOptionsInput,
): SprintEngineRoleId | null {
  const options = buildSprintEngineAddMemberOptions(input)
  const uncovered = options.find((option) => option.openTasksForRole > 0 && option.activeForRole === 0)
  return uncovered?.role ?? null
}

// Roster headcount keyed by role id. Includes every role visible in the
// current add-member options (so zero-count roles appear).
export function buildSprintEngineRosterCountByRole(
  input: SprintEngineAddMemberOptionsInput,
): Record<SprintEngineRoleId, number> {
  const options = buildSprintEngineAddMemberOptions(input)
  const counts: Record<SprintEngineRoleId, number> = {}
  for (const option of options) {
    counts[option.role] = option.activeForRole
  }
  return counts
}

function resolveRoleSummary(
  role: SprintEngineRoleId,
  registry: SprintEngineRoleRegistry | null | undefined,
  overrides: Partial<Record<SprintEngineRoleId, string>> | null,
  fallback: string,
): string {
  const override = overrides?.[role]?.trim()
  if (override) return override
  if (isBundledBoardRole(role)) return BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES[role]
  const fromRegistry = registry?.roles?.[role]?.summary
  if (typeof fromRegistry === 'string' && fromRegistry.trim()) return fromRegistry.trim()
  return fallback
}

function isBundledBoardRole(role: SprintEngineRoleId): role is SprintEngineRole {
  return Object.prototype.hasOwnProperty.call(BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES, role)
}

// Exported for the board's "Ready" status / uncovered-role calculation when
// it needs to consult a single task status value.
export function isSprintEngineTaskOpenForRole(task: TaskLike, role: SprintEngineRoleId): boolean {
  return task.role === role && task.status !== 'done'
}

// Re-exported for callers that just need the type and would otherwise pull
// it in from the larger `sprintengine.ts` module.
export type { SprintEngineTaskStatus }
