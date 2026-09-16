import type {
  SprintEngineRole,
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineTask,
} from '../types/workspace'
import {
  getSprintEngineRoleLabel,
  orderSprintEngineRosterRoles,
  type SprintEngineAgentRosterItem,
} from './sprintengine'

// This module used to carry the wizard's planner policy — the floor that pinned
// the architect at 1, the "you must staff a planner" rejection, and the
// predicate the "Planner" badges read. All of it is gone (MC-2055): a sprint
// coordinates through a seat rather than a staffed role, so a roster may staff
// any set of roles or none, and no role is badged as the one that plans.

// Roles the host bundle can resolve with no specialist pack installed. Post
// un-ship this is empty: every specialist role — architect included — now
// travels in the installable pack. Kept as the last-resort fallback for callers
// that hold no `SprintEngineRoleRegistry` at all, so a role that cannot resolve is never
// advertised. The registry is the runtime authority when present.
export const BUNDLED_SPRINT_ENGINE_ADDABLE_ROLES: readonly SprintEngineRole[] = []

// Bundled summary copy for the live Sprint Engine board's add-member panel.
// The new-workspace wizard's copy is shorter (see
// `BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES` below) because that surface
// is about staffing intent rather than describing the live actor.
export const BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES: Record<SprintEngineRole, string> = {
  architect: 'Plans the run and signs off on finished work.',
  product: 'Shapes scope, positioning, audience fit, and priority tradeoffs.',
  developer: 'Builds implementation and integration work.',
  frontend: 'Owns interaction design, visual quality, and UI implementation.',
  ui_ux_reviewer: 'Reviews frontend UX, UI consistency, brand alignment, responsive behavior, and visual polish.',
  performance: 'Reviews latency, CPU, memory, runtime cost, and measurement gaps.',
  production_readiness_reviewer: 'Reviews release readiness across deployment, data, config, observability, rollback, and user setup.',
  cross_platform: 'Reviews OS, browser, device, filesystem, shell, packaging, and runtime compatibility.',
  tester: 'Validates behavior, regressions, and acceptance criteria.',
  security: 'Reviews trust boundaries, command safety, data handling, and hardening.',
}

// Bundled summary copy for the new-workspace roster wizard. Kept separate
// from the live-board copy so each surface can speak in the right tense
// without forcing the other to change.
export const BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES: Record<SprintEngineRole, string> = {
  architect: 'Plans the work, owns dependencies, signs off at the end.',
  product: 'Clarifies scope, tradeoffs, and acceptance criteria.',
  frontend: 'Implements UI, interaction states, and polish.',
  ui_ux_reviewer: 'Reviews screens, panels, brand alignment, responsiveness, and visual artifacts.',
  developer: 'Builds core logic, integrations, and refactors.',
  performance: 'Reviews latency, runtime cost, and measurement gaps.',
  production_readiness_reviewer: 'Checks whether the product is safe to release to production.',
  cross_platform: 'Checks compatibility across platforms, browsers, devices, and packaging targets.',
  tester: 'Runs acceptance checks and publishes evidence.',
  security: 'Reviews trust boundaries, secrets, and abuse cases.',
}

const WIZARD_CUSTOM_REGISTRY_ROLE_SUMMARY = 'Custom registry role.'

// Resolve the wizard summary for a role. Bundled roles use the wizard copy;
// custom registry roles fall back to their registry `description` if present,
// then to a generic label so unknown ids still render. Centralizing this here so
// the new-workspace roster table consumes the same shared module as the live board.
export function getSprintEngineWizardRoleSummary(
  roleId: SprintEngineRoleId,
  registry?: SprintEngineRoleRegistry | null,
): string {
  if (isBundledWizardRole(roleId)) return BUNDLED_SPRINT_ENGINE_WIZARD_ROLE_SUMMARIES[roleId]
  const fromRegistry = registry?.roles?.[roleId]?.description
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
  // Registry metadata `description` is the next fallback; final fallback is a
  // generic "Custom registry role." label so unknown roles still render.
  roleSummaries?: Partial<Record<SprintEngineRoleId, string>> | null
  fallbackSummary?: string
}

const CUSTOM_REGISTRY_ROLE_SUMMARY = 'Custom registry role.'

// Roleless members and roleless tasks are not counted: this tallies the
// per-ROLE staffing an add-member picker offers, and absent is not a role.
function countByRole<T extends { role?: SprintEngineRoleId }>(items: Iterable<T>): Map<SprintEngineRoleId, number> {
  const counts = new Map<SprintEngineRoleId, number>()
  for (const item of items) {
    if (!item.role) continue
    counts.set(item.role, (counts.get(item.role) ?? 0) + 1)
  }
  return counts
}

const BUNDLED_SPRINT_ENGINE_ADDABLE_ROLE_SET: ReadonlySet<SprintEngineRoleId> = new Set(
  BUNDLED_SPRINT_ENGINE_ADDABLE_ROLES,
)

// A roster role is offered only when it resolves: from the loaded registry when
// one is present — an empty registry resolves nothing — or from the bundled
// fallback set when the caller holds no registry at all. This gates the
// historical bundled seed that `orderSprintEngineRosterRoles` still emits for
// canonical ordering: post un-ship a seeded specialist the registry can no
// longer resolve must not surface in a picker until its pack is installed.
function resolvesAsAddableRole(
  role: SprintEngineRoleId,
  registry: SprintEngineRoleRegistry | null | undefined,
): boolean {
  const roles = registry?.roles
  if (roles) return Object.prototype.hasOwnProperty.call(roles, role)
  return BUNDLED_SPRINT_ENGINE_ADDABLE_ROLE_SET.has(role)
}

// Registry-authoritative list of roles that can be added to the Sprint Engine
// roster. The registry is the source of available specialist roles; the bundled
// seed inside `orderSprintEngineRosterRoles` only fixes canonical ordering and
// is gated to registry-resolvable roles here, so a fresh install with no pack
// offers NO roles: the picker greys out rather than becoming a roleless run
// (owner ruling 2026-09-08). An installed pack offers its specialist roles in
// curated order. The user grows the roster; agents still never do.
export function listSprintEngineAddableRoles(
  registry?: SprintEngineRoleRegistry | null,
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null,
): SprintEngineRoleId[] {
  const ordered = orderSprintEngineRosterRoles(registry ?? null, disabledRoleIds ?? null)
  return ordered.filter((role) => resolvesAsAddableRole(role, registry))
}

// New-workspace wizard roster choices. Identical to the addable-role list;
// kept as a named seam so the roster table's intent stays legible and future
// wizard-only ordering has one place.
export function listSprintEngineWizardRoles(
  registry?: SprintEngineRoleRegistry | null,
  disabledRoleIds?: ReadonlySet<SprintEngineRoleId> | null,
): SprintEngineRoleId[] {
  return listSprintEngineAddableRoles(registry, disabledRoleIds)
}

export function buildSprintEngineAddMemberOptions(
  input: SprintEngineAddMemberOptionsInput,
): SprintEngineAddMemberOption[] {
  const roleIds = listSprintEngineAddableRoles(input.registry ?? null, input.disabledRoleIds ?? null)
  const rosterCounts = countByRole(input.roster)
  const openTaskCounts = new Map<SprintEngineRoleId, number>()
  for (const task of input.tasks) {
    if (task.status === 'done' || !task.role) continue
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
  const fromRegistry = registry?.roles?.[role]?.description
  if (typeof fromRegistry === 'string' && fromRegistry.trim()) return fromRegistry.trim()
  return fallback
}

function isBundledBoardRole(role: SprintEngineRoleId): role is SprintEngineRole {
  return Object.prototype.hasOwnProperty.call(BUNDLED_SPRINT_ENGINE_BOARD_ROLE_SUMMARIES, role)
}
