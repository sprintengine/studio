// Pure helpers for the Sprint Engine saved-team picker. Kept out of
// NewWorkspacePanel so the divergence/prune rules can be unit-tested directly.
import type {
  AgentCli,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  SprintEngineRosterTeam,
} from '../../../types/workspace'

// Mirrors the wizard's CLI fallback (SprintEngineRosterTable / setRoleCount),
// so divergence comparison resolves an absent default the same way the rows do.
const DEFAULT_CLI: AgentCli = 'claude-code'

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

// True when the current wizard roster still matches the saved team it was loaded
// from — counts plus each active role's effective CLI. Per-role model overrides
// are launch-time workspace metadata, not part of a saved team, so they never
// count as divergence. Drives the picker's "edited" affordance and gates Update.
export function sprintEngineRosterMatchesTeam(
  team: SprintEngineRosterTeam,
  counts: SprintEngineRoleCounts,
  cliDefaults: SprintEngineRoleCliDefaults,
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
