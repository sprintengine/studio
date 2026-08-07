// Team-directory name resolution for a chained sprint (sprint-engine-start): the
// self-trigger loop guard and the collision numbering share one ordered rule, so
// the guard cannot silently regress into "the rename accidentally protects us".
// Pure and dependency-free so it is unit-testable without the renderer store.

export type ChainedSprintTeamContext = { teamSlug: string; statePath: string }

export type ChainedSprintTeamNameResult =
  | { ok: true; teamName: string; context: ChainedSprintTeamContext }
  | { ok: false; code: 'sprint_self_trigger' | 'sprint_team_name_exhausted'; message: string }

export const CHAINED_SPRINT_TEAM_NAME_MAX_ATTEMPTS = 100

// Refuse a self-trigger loop BEFORE numbering, then number until the state path is
// free. Ordering matters: the watched team dir exists on disk, so the numbering
// loop always steps over it — a refuse check placed AFTER numbering never matches
// the watched slug and the implicit rename becomes the only real protection. This
// rejects a colliding base name outright instead of quietly renaming it to
// "<name> 2".
export async function resolveChainedSprintTeamName(input: {
  baseTeamName: string
  refuseTeamSlug?: string
  buildContext: (teamName: string) => ChainedSprintTeamContext
  stateExists: (statePath: string) => Promise<boolean>
  maxAttempts?: number
}): Promise<ChainedSprintTeamNameResult> {
  const { baseTeamName, buildContext, stateExists } = input
  const refuse = input.refuseTeamSlug?.trim()
  const maxAttempts = input.maxAttempts ?? CHAINED_SPRINT_TEAM_NAME_MAX_ATTEMPTS

  let teamName = baseTeamName
  let context = buildContext(teamName)
  if (refuse && context.teamSlug === refuse) {
    return {
      ok: false,
      code: 'sprint_self_trigger',
      message: `Chained sprint "${teamName}" would reuse the watched team directory "${context.teamSlug}"; give the chained sprint a different name.`,
    }
  }

  for (let suffix = 2; await stateExists(context.statePath); suffix += 1) {
    if (suffix > maxAttempts) {
      return {
        ok: false,
        code: 'sprint_team_name_exhausted',
        message: `Could not find a free team directory name for "${baseTeamName}" after ${maxAttempts} attempts.`,
      }
    }
    teamName = `${baseTeamName} ${suffix}`
    context = buildContext(teamName)
  }
  return { ok: true, teamName, context }
}
