// Pure helpers for the Sprint Engine saved-team picker. Kept out of
// NewWorkspacePanel so the divergence/prune rules can be unit-tested directly.
import type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRoster,
  SprintEngineRosterMode,
  SprintEngineSavedRoster,
} from '../../../types/workspace'
import {
  NO_ROLES_ROSTER_ID,
  NO_ROLES_ROSTER_NAME,
  isNoRolesRosterRef,
} from '../../../../../shared/sprintengine/run-types'
import { SPRINT_ENGINE_GENERAL_ROLE_ID } from '../../../utils/sprintengineRoleOptions'

// Re-exported so the wizard, the Horizon picker (MC-1880) and the launch path
// all import the built-in from one place. Defined in shared — see the comment
// on the constant for why.
export { NO_ROLES_ROSTER_ID, NO_ROLES_ROSTER_NAME, isNoRolesRosterRef }

// Mirrors the wizard's CLI fallback (SprintEngineRosterTable / setRoleCount),
// so divergence comparison resolves an absent default the same way the rows do.
const DEFAULT_CLI: AgentCli = 'claude-code'

// What the wizard's roster step OPENS on when the user has no saved team: a
// runnable plan -> build pair, so Continue yields a team that can actually do
// work. Saved teams override it; it only seeds when none exists.
//
// Every role here MUST be one the wizard renders as an editable roster row, so
// the user can see it and switch it off. A role seeded here that the wizard
// draws no row for is invisible config the user cannot uncheck, and it rides
// into `configuredRoles` on every run.
export const DEFAULT_SPRINT_ENGINE_ROLE_COUNTS: SprintEngineRoleCounts = {
  architect: 1,
  product: 0,
  frontend: 0,
  ui_ux_reviewer: 0,
  developer: 1,
  performance: 0,
  production_readiness_reviewer: 0,
  cross_platform: 0,
  tester: 0,
  security: 0,
  // `general` is NOT staffed by default (count 0): a fresh run opens on plain
  // agents whose count is `maxConcurrentAgents`, not a roster headcount, so
  // seeding `{ general: 2 }` here would only write config the roster layer
  // discards. It joins the key set purely so the Required<> CLI seed map below
  // derives a stock CLI for it — otherwise the plain-agents picker (and the
  // specialist table's General row) would have no CLI default. See MC-1585.
  general: 0,
}

// What a NO-ROLES ('pool') run stages: one plain `general` planner seat. After
// that, agents are minted PER TASK up to the run's max-concurrency setting —
// this is a seed, never a headcount, and there is deliberately no roster-level
// agent count anywhere (owner ruling 2026-07-26).
//
// Lives here rather than in NewWorkspacePanel so the wizard and the
// plan-sourced launch path (useAutomationRequests) share one constant instead
// of each spelling `{ general: 1 }` (MC-1875).
export const PLAIN_AGENT_ROLE_COUNTS: SprintEngineRoleCounts = { general: 1 }

// The built-in "No roles" (non-)roster as a `SprintEngineRoster`, so every
// consumer that renders or resolves a roster can treat it uniformly. It is
// NEVER written into `savedRosters` — see NO_ROLES_ROSTER_ID for why.
export const NO_ROLES_ROSTER: SprintEngineRoster = {
  id: NO_ROLES_ROSTER_ID,
  name: NO_ROLES_ROSTER_NAME,
  mode: 'pool',
  roleCounts: PLAIN_AGENT_ROLE_COUNTS,
  roleCliDefaults: {},
  createdAt: 0,
  updatedAt: 0,
}

// Every known role mapped to the stock CLI — the wizard's Required<> seed map.
export const DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS: Required<SprintEngineRoleCliDefaults> = Object.fromEntries(
  Object.keys(DEFAULT_SPRINT_ENGINE_ROLE_COUNTS).map((role) => [role, DEFAULT_CLI])
) as Required<SprintEngineRoleCliDefaults>

export type ResolvedInitialSprintEngineRoster = {
  selectedRosterId: string | null
  // The formation to open in / launch with. This is the CONTRACT item 3 (No
  // roles) and item 5 (Horizon picker) consume — a synthetic roster resolves
  // through here exactly like a saved one.
  mode: SprintEngineRosterMode
  roleCounts: SprintEngineRoleCounts
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>
  roleModelOverrides: SprintEngineRoleModelOverrides
}

// The effective launch model a saved override resolves to: a trimmed explicit
// model id, or undefined for "CLI default" (null, empty, or absent). Both sides
// of a divergence comparison and the persisted prune funnel through this so
// null/absent/"" are treated as the same (no model flag).
function effectiveSavedRoleModel(
  overrides: SprintEngineRoleModelOverrides | undefined,
  role: SprintEngineRoleId,
): string | undefined {
  const value = overrides?.[role]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

// Resolve the roster the new-workspace wizard opens with, so the roster step is
// a single Continue on a runnable team. Precedence:
//   1. An explicit roster reference (id or name), INCLUDING the built-in
//      "No roles" — this is how a horizon's `roster:` frontmatter resolves.
//   2. The most recently selected saved roster (lastSelectedRosterId), which
//      may itself be the built-in.
//   3. The legacy single saved roster.
//   4. NO ROLES — the zero-configuration default (MC-1876). This replaced a
//      fallthrough to `DEFAULT_SPRINT_ENGINE_ROLE_COUNTS`, i.e. to a SPECIALIST
//      roster, which was the opposite of a default.
//
// `roleCounts` still carries `defaultRoleCounts` in that last case: the wizard
// keeps the specialist table behind the collapsed disclosure so switching to
// "Pick roles yourself" opens on something runnable. Formation, not staffing,
// is what the default flip changes — `mode` is what decides the launch.
//
// CLI defaults always layer over the full default map, so every known role keeps
// a valid CLI even when a saved roster stored only a subset.
export function resolveInitialSprintEngineRoster(input: {
  savedRosters: SprintEngineRoster[]
  lastSelectedRosterId: string | null | undefined
  savedRoster: SprintEngineSavedRoster | null
  defaultRoleCounts: SprintEngineRoleCounts
  defaultRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
  /** Explicit roster id or name (a horizon's `roster:`, an automation config). */
  explicitRosterRef?: string | null
}): ResolvedInitialSprintEngineRoster {
  // The built-in short-circuits everything: naming it means "no roster", so no
  // saved roster and no last-used selection may override it.
  if (isNoRolesRosterRef(input.explicitRosterRef) || isNoRolesRosterRef(input.lastSelectedRosterId)) {
    return {
      selectedRosterId: NO_ROLES_ROSTER_ID,
      mode: 'pool',
      roleCounts: { ...input.defaultRoleCounts },
      roleCliDefaults: { ...input.defaultRoleCliDefaults },
      roleModelOverrides: {},
    }
  }
  const selectedRoster =
    (input.explicitRosterRef
      ? findSavedSprintEngineRoster(input.savedRosters, input.explicitRosterRef)
      : null)
    ?? input.savedRosters.find((roster) => roster.id === input.lastSelectedRosterId)
    ?? null
  const sourceRoster: SprintEngineSavedRoster | null = selectedRoster
    ? {
        roleCounts: selectedRoster.roleCounts,
        roleCliDefaults: selectedRoster.roleCliDefaults,
        roleModelOverrides: selectedRoster.roleModelOverrides,
      }
    : input.savedRoster
  const roleCounts = sourceRoster?.roleCounts
    ? { ...sourceRoster.roleCounts }
    : { ...input.defaultRoleCounts }
  const roleCliDefaults: Required<SprintEngineRoleCliDefaults> = {
    ...input.defaultRoleCliDefaults,
    ...(sourceRoster?.roleCliDefaults ?? {}),
  }
  const roleModelOverrides: SprintEngineRoleModelOverrides = {
    ...(sourceRoster?.roleModelOverrides ?? {}),
  }
  return {
    // With nothing saved at all, the (non-)selection IS the built-in, so the
    // picker shows "No roles" rather than a nameless "Custom" entry.
    selectedRosterId: selectedRoster?.id ?? (sourceRoster ? null : NO_ROLES_ROSTER_ID),
    mode: resolveSprintEngineRosterMode(selectedRoster, Boolean(sourceRoster), roleCounts),
    roleCounts,
    roleCliDefaults,
    roleModelOverrides,
  }
}

// Find a saved roster by id OR by (case-insensitive) name. Horizon frontmatter
// and automation configs name a roster by NAME; the wizard selects by id.
// Returns null for the built-in — callers must check `isNoRolesRosterRef`
// first, because the built-in is not in this list by design.
export function findSavedSprintEngineRoster(
  rosters: ReadonlyArray<SprintEngineRoster>,
  ref: string | null | undefined,
): SprintEngineRoster | null {
  const trimmed = ref?.trim()
  if (!trimmed) return null
  const byId = rosters.find((roster) => roster.id === trimmed)
  if (byId) return byId
  const lowered = trimmed.toLowerCase()
  return rosters.find((roster) => roster.name.trim().toLowerCase() === lowered) ?? null
}

// A roster's formation: what it was SAVED as when it says so, otherwise the
// pre-MC-1875 guess, so legacy rosters open exactly as they did before.
//
// The guess is deliberately the old `initialUseSpecialistRoles` expression,
// including its "only a SAVED source counts" clause: a fresh install with no
// saved roster at all opens on 'pool' even though `defaultRoleCounts` staffs
// specialists behind the collapsed disclosure (MC-1585). Changing that here
// would silently flip every fresh install's formation.
export function resolveSprintEngineRosterMode(
  roster: SprintEngineRoster | null,
  hasSavedSource: boolean,
  roleCounts: SprintEngineRoleCounts,
): SprintEngineRosterMode {
  if (roster?.mode) return roster.mode
  return hasSavedSource && sprintEngineRosterStaffsSpecialists(roleCounts) ? 'roles' : 'pool'
}

// What a resolved roster actually staffs at launch (MC-1875). The one place
// formation turns into role counts, shared by the wizard's create path and the
// plan-sourced (Horizon / automation) launch path so the two cannot diverge.
//
// A 'pool' roster launches the plain-agent seed, NOT the specialist counts it
// may still be carrying behind the wizard's collapsed disclosure. That the seed
// contains NO `architect` is load-bearing: `sprintEnginePlannerRole` prefers
// architect over general whenever architect is staffed, so a pool run that
// leaked an architect count would silently seat an architect as its planner —
// the exact thing "no roles" means to exclude. Pinned in savedRosters.test.ts.
export function sprintEngineLaunchRoleCounts(
  mode: SprintEngineRosterMode,
  roleCounts: SprintEngineRoleCounts,
): SprintEngineRoleCounts {
  return mode === 'pool' ? PLAIN_AGENT_ROLE_COUNTS : roleCounts
}

export function activeSprintEngineRoleIds(counts: SprintEngineRoleCounts): SprintEngineRoleId[] {
  return (Object.keys(counts) as SprintEngineRoleId[]).filter((role) => (counts[role] ?? 0) > 0)
}

// True when a roster staffs any role other than the plain `general` agent — an
// architect, a developer, a reviewer, any specialist. The wizard opens its
// "Use specialist roles" disclosure pre-expanded for a saved team that staffs
// specialists (so it round-trips visibly), and keeps it collapsed for a plain
// general-only team or a fresh install. A general-only roster is NOT specialist.
export function sprintEngineRosterStaffsSpecialists(counts: SprintEngineRoleCounts): boolean {
  return activeSprintEngineRoleIds(counts).some((role) => role !== SPRINT_ENGINE_GENERAL_ROLE_ID)
}

// Keep only CLI defaults for roles actually in the roster (count > 0). The
// wizard holds a Required<...> map with an entry for every known role, so saving
// it verbatim stored a default for roles the team does not include — noise that
// also made two otherwise-identical teams compare as different saves.
export function pruneSprintEngineRoleCliDefaults(
  counts: SprintEngineRoleCounts,
  cliDefaults: SprintEngineRoleCliDefaults,
): SprintEngineRoleCliDefaults {
  const pruned: SprintEngineRoleCliDefaults = {}
  for (const role of activeSprintEngineRoleIds(counts)) {
    const cli = cliDefaults[role]
    if (cli) pruned[role] = cli
  }
  return pruned
}

// Keep only explicit model ids for roles actually in the roster (count > 0),
// mirroring pruneSprintEngineRoleCliDefaults. A "CLI default" pick (null/"" )
// is dropped because it is indistinguishable from absent at launch, which also
// keeps two otherwise-identical teams from comparing as different saves.
export function pruneSprintEngineRoleModelOverrides(
  counts: SprintEngineRoleCounts,
  overrides: SprintEngineRoleModelOverrides | undefined,
): SprintEngineRoleModelOverrides {
  const pruned: SprintEngineRoleModelOverrides = {}
  for (const role of activeSprintEngineRoleIds(counts)) {
    const model = effectiveSavedRoleModel(overrides, role)
    if (model) pruned[role] = model
  }
  return pruned
}

// True when the current wizard roster still matches the saved team it was loaded
// from — the same enabled ROLE SET plus each role's effective CLI and effective
// model. Under the pool model a persisted `roleCounts` is read as an enabled-set
// (0 vs >0), never a seat headcount, so bumping a stored count from 2 to 3 does
// not read as divergence — only enabling/disabling a role, or changing its CLI or
// model, does. A model change (like a CLI change) marks the team edited so Update
// can re-save it. null/absent/"" all resolve to the same "CLI default", so an
// explicit default pick does not falsely read as diverged.
export function sprintEngineRosterMatches(
  team: SprintEngineRoster,
  counts: SprintEngineRoleCounts,
  cliDefaults: SprintEngineRoleCliDefaults,
  modelOverrides?: SprintEngineRoleModelOverrides,
  // MC-1875: formation is part of what a roster IS, so switching it must mark
  // the roster edited and let "Update" re-save the new mode. Omitted by callers
  // that do not track formation, which then compare exactly as before.
  mode?: SprintEngineRosterMode,
): boolean {
  if (mode !== undefined) {
    // An absent stored mode is the legacy 'roles'-or-'pool' guess, resolved the
    // same way the loader resolved it — otherwise merely OPENING a legacy
    // roster would read as edited.
    const storedMode = resolveSprintEngineRosterMode(team, true, team.roleCounts)
    if (storedMode !== mode) return false
  }
  const roles = new Set<SprintEngineRoleId>([
    ...activeSprintEngineRoleIds(team.roleCounts),
    ...activeSprintEngineRoleIds(counts),
  ])
  for (const role of roles) {
    // Enabled-set comparison: both sides staff the role (>0) or neither does.
    // The union above already excludes count-0 roles, so a role reaching this
    // loop from only one side is a genuine enable/disable divergence.
    if (((team.roleCounts[role] ?? 0) > 0) !== ((counts[role] ?? 0) > 0)) return false
    const teamCli = team.roleCliDefaults[role] ?? DEFAULT_CLI
    const currentCli = cliDefaults[role] ?? DEFAULT_CLI
    if (teamCli !== currentCli) return false
    if (
      effectiveSavedRoleModel(team.roleModelOverrides, role)
      !== effectiveSavedRoleModel(modelOverrides, role)
    ) {
      return false
    }
  }
  return true
}

// Case-insensitive name-collision check for the save/rename affordances. When
// `excludeId` is set (rename) the team keeping its own name is not a collision.
export function sprintEngineRosterNameTaken(
  teams: SprintEngineRoster[],
  name: string,
  excludeId?: string | null,
): boolean {
  const trimmed = name.trim().toLowerCase()
  if (!trimmed) return false
  // The built-in's name is RESERVED (MC-1876): a user roster called "No roles"
  // would shadow the default in every picker and in horizon frontmatter, where
  // the name is how a roster is referenced.
  if (isNoRolesRosterRef(trimmed)) return true
  return teams.some((team) => team.id !== excludeId && team.name.trim().toLowerCase() === trimmed)
}
