/**
 * Specialist prompt composition — shared because BOTH processes compose it now.
 *
 * It used to live under `src/renderer/src/specialists/`, which meant a specialist
 * launch could only be assembled inside a React hook: the main-process
 * `AgentLaunchService` (MC-2159) had no way to wrap a directive in the
 * role-assignment preamble, so `agent.launch` from the gateway or an automation had
 * to round-trip through a window. Nothing here touches the DOM or `window` — it
 * is string composition over ids — so it moved rather than being duplicated.
 * `src/renderer/src/specialists/specialistActions.ts` re-exports it verbatim, so
 * every renderer import site is unchanged.
 */
import type { SpecialistActionId } from '../../renderer/src/types/workspace'
import {
  AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD,
  buildRoleAssignmentText,
  defaultWorkspaceRoleSkillRel,
  missingRoleMessage,
} from './role-brief'

export type SpecialistIcon =
  | 'architecture'
  | 'code'
  | 'design'
  | 'design_review'
  | 'review'
  | 'spaghetti'
  | 'nuclear'
  | 'shield'
  | 'test'
  | 'infra'
  | 'product'
  | 'performance'
  | 'production_readiness'
  | 'cross_platform'
  | 'writing'

export type SpecialistAction = {
  id: SpecialistActionId
  label: string
  shortLabel: string
  description: string
  icon: SpecialistIcon
  // A specialist's id is its registry role id, so `role === id` always. The
  // field is kept (rather than folded into `id`) so call sites reading a role
  // for the skill pointer stay explicit about intent.
  role: string
  shortcut?: string
}

// Reserved engine-defaults key for the General agent. General is not special-
// cased: its CLI + model persist through the same `specialistCliDefaults` /
// `specialistModelDefaults` maps as every specialist, keyed by this sentinel.
// The double-underscore guarantees it never collides with a real specialist id,
// and it is never added to the specialist roster or `specialistOrder`.
export const GENERAL_AGENT_ENGINE_KEY = '__general__' as SpecialistActionId

// Curated display order for the specialist roster, keyed by registry role id.
// Specialists no longer ship as a hardcoded catalog — the roster is sourced from
// the role registry (see specialistPacks.ts), which groups roles by source layer
// and sorts alphabetically. This list restores a deliberate default ordering for
// the known first-party roles; any role not listed here (a workspace/user/plugin
// specialist) is appended after them. It is display-only: it never adds or drops
// a specialist, only sequences the ones the registry actually surfaces.
export const SPECIALIST_DISPLAY_ORDER: readonly string[] = [
  'architect',
  'product',
  'developer',
  'devops',
  'performance',
  'production_readiness_reviewer',
  'cross_platform',
  'frontend',
  'ui_ux_reviewer',
  'blog_writer',
  'tester',
  'security',
]

// Synthesize a specialist action for a registry role id. The id is the registry
// role id, so its brief is the skill at `.claude/skills/<kebab>/SKILL.md`;
// label/icon fall back to the id and a neutral glyph. Callers that have
// registry metadata (the pickers, via specialistPacks.ts) prefer that richer
// action; this is the pure-id fallback for a selected id no longer present in
// the registry.
export function synthesizeSpecialistAction(id: string): SpecialistAction {
  return {
    id,
    label: id,
    shortLabel: id,
    description: '',
    icon: 'code',
    role: id,
  }
}

// Resolve a specialist id to an action shape. Every id is a registry role id, so
// its brief is the matching workspace skill; this synthesizes the shape from the
// id alone. Rich display metadata (manifest label/icon) comes from the
// registry-sourced pack list, not from here. Empty input yields a neutral empty
// placeholder rather than throwing, so a missing selection degrades safely.
export function getSpecialistAction(id: SpecialistActionId | null | undefined): SpecialistAction {
  return synthesizeSpecialistAction(id ?? '')
}

/**
 * Sequence a specialist roster for display. IDs in `order` (a user-defined
 * order) are honored first in their saved sequence, then the curated
 * `SPECIALIST_DISPLAY_ORDER` for known first-party roles, then any remaining
 * specialists in `actions` order (e.g. a workspace/user/plugin role not in
 * either list). Every action in `actions` appears exactly once; unknown ids in
 * the order lists are ignored. Never adds or drops an entry.
 */
export function orderSpecialistActions(
  order: readonly SpecialistActionId[],
  actions: readonly SpecialistAction[],
): SpecialistAction[] {
  const byId = new Map(actions.map((action) => [action.id, action]))
  const seen = new Set<SpecialistActionId>()
  const ordered: SpecialistAction[] = []
  for (const id of [...order, ...SPECIALIST_DISPLAY_ORDER]) {
    const action = byId.get(id)
    if (action && !seen.has(id)) {
      ordered.push(action)
      seen.add(id)
    }
  }
  for (const action of actions) {
    if (!seen.has(action.id)) ordered.push(action)
  }
  return ordered
}

export function buildMissingSpecialistSoul(action: SpecialistAction, message?: string): string {
  return [
    'Role unavailable.',
    '',
    message ?? missingRoleMessage(action.role),
  ].join('\n')
}

export function buildSpecialistSoulStartupPrompt(action: SpecialistAction, skillRel?: string): string {
  const roleId = action.role || action.id
  return buildRoleAssignmentText(roleId, skillRel ?? defaultWorkspaceRoleSkillRel(roleId))
}

// Autonomous-run variant of the role startup prompt. Unlike the interactive
// build above — which names the role skill then waits for a human to hand over a
// task — an automation agent has no human in the loop, so it must take the role
// and then immediately carry out the directive. The directive is the
// main-process-composed automation prompt (autonomy policy + run-status
// signal instructions), kept verbatim below so its reporting contract stands.
export function buildSpecialistDirectiveStartupPrompt(action: SpecialistAction, directive: string): string {
  return [
    buildSpecialistSoulStartupPrompt(action),
    '',
    AUTONOMOUS_SPECIALIST_DIRECTIVE_LEAD,
    '',
    '---',
    '',
    directive.trim(),
  ].join('\n')
}
