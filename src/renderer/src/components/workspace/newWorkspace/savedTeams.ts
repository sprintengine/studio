// Pure helpers for the Sprint Engine saved-team picker. Kept out of
// NewWorkspacePanel so the divergence/prune rules can be unit-tested directly.
import type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  SprintEngineRosterTeam,
  SprintEngineSavedRoster,
} from '../../../types/workspace'

// Mirrors the wizard's CLI fallback (SprintEngineRosterTable / setRoleCount),
// so divergence comparison resolves an absent default the same way the rows do.
const DEFAULT_CLI: AgentCli = 'claude-code'

// Default first-run team for a from-scratch Sprint Engine: a runnable
// plan -> build -> review loop, not just planners. A novice who lands on the
// roster step can press Continue and get a team that actually implements and
// reviews work. Saved teams override this; it only seeds when none exists.
// Shared with the automation server's sprint.create so an externally created
// run gets the same roster a wizard Continue would.
export const DEFAULT_SPRINT_ENGINE_ROLE_COUNTS: SprintEngineRoleCounts = {
  architect: 1,
  product: 1,
  frontend: 0,
  ui_ux_reviewer: 0,
  developer: 1,
  code_reviewer: 1,
  spec_reviewer: 0,
  performance: 0,
  production_readiness_reviewer: 0,
  cross_platform: 0,
  tester: 0,
  security: 0,
}

// Every known role (the counts map's keys plus the count-less nuclear
// reviewer) mapped to the stock CLI — the wizard's Required<> seed map.
export const DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS: Required<SprintEngineRoleCliDefaults> = Object.fromEntries(
  [...Object.keys(DEFAULT_SPRINT_ENGINE_ROLE_COUNTS), 'nuclear_reviewer'].map((role) => [role, DEFAULT_CLI])
) as Required<SprintEngineRoleCliDefaults>

export type ResolvedInitialSprintEngineRoster = {
  selectedTeamId: string | null
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
//   1. The most recently selected saved team (lastSelectedTeamId → savedTeams).
//   2. The legacy single saved roster.
//   3. The built-in default roster (a runnable implement-and-review team) when no
//      saved roster exists — a fresh install still opens pre-selected.
// CLI defaults always layer over the full default map, so every known role keeps
// a valid CLI even when a saved team stored only a subset.
export function resolveInitialSprintEngineRoster(input: {
  savedTeams: SprintEngineRosterTeam[]
  lastSelectedTeamId: string | null | undefined
  savedRoster: SprintEngineSavedRoster | null
  defaultRoleCounts: SprintEngineRoleCounts
  defaultRoleCliDefaults: Required<SprintEngineRoleCliDefaults>
}): ResolvedInitialSprintEngineRoster {
  const selectedTeam =
    input.savedTeams.find((team) => team.id === input.lastSelectedTeamId) ?? null
  const sourceRoster: SprintEngineSavedRoster | null = selectedTeam
    ? {
        roleCounts: selectedTeam.roleCounts,
        roleCliDefaults: selectedTeam.roleCliDefaults,
        roleModelOverrides: selectedTeam.roleModelOverrides,
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
  return { selectedTeamId: selectedTeam?.id ?? null, roleCounts, roleCliDefaults, roleModelOverrides }
}

export function activeSprintEngineRoleIds(counts: SprintEngineRoleCounts): SprintEngineRoleId[] {
  return (Object.keys(counts) as SprintEngineRoleId[]).filter((role) => (counts[role] ?? 0) > 0)
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
// from — counts plus each active role's effective CLI and effective model. A
// model change (like a CLI change) marks the team edited so Update can re-save
// it. null/absent/"" all resolve to the same "CLI default", so an explicit
// default pick does not falsely read as diverged.
export function sprintEngineRosterMatchesTeam(
  team: SprintEngineRosterTeam,
  counts: SprintEngineRoleCounts,
  cliDefaults: SprintEngineRoleCliDefaults,
  modelOverrides?: SprintEngineRoleModelOverrides,
): boolean {
  const roles = new Set<SprintEngineRoleId>([
    ...activeSprintEngineRoleIds(team.roleCounts),
    ...activeSprintEngineRoleIds(counts),
  ])
  for (const role of roles) {
    if ((team.roleCounts[role] ?? 0) !== (counts[role] ?? 0)) return false
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
export function sprintEngineTeamNameTaken(
  teams: SprintEngineRosterTeam[],
  name: string,
  excludeId?: string | null,
): boolean {
  const trimmed = name.trim().toLowerCase()
  if (!trimmed) return false
  return teams.some((team) => team.id !== excludeId && team.name.trim().toLowerCase() === trimmed)
}
