import assert from 'node:assert/strict'

import {
  CHAINED_SPRINT_TEAM_NAME_MAX_ATTEMPTS,
  resolveChainedSprintTeamName,
} from './chainedSprintTeamName'

// Slugging close enough to the renderer's for ordering assertions: lowercase,
// spaces → hyphens. The state path embeds the slug so an "exists on disk" probe
// keys off it.
function buildContext(name: string): { teamSlug: string; statePath: string } {
  const teamSlug = name.trim().toLowerCase().replace(/\s+/g, '-')
  return { teamSlug, statePath: `/root/.multi-code/sprintengine/${teamSlug}/run.yaml` }
}

function existsProbe(existingSlugs: string[]): {
  stateExists: (statePath: string) => Promise<boolean>
  calls: string[]
} {
  const set = new Set(existingSlugs)
  const calls: string[] = []
  return {
    calls,
    stateExists: async (statePath) => {
      calls.push(statePath)
      const slug = statePath.split('/').slice(-2)[0]
      return set.has(slug)
    },
  }
}

async function assertSelfTriggerRefusedBeforeNumbering(): Promise<void> {
  // The watched team dir exists on disk, so a check AFTER numbering would step
  // over it and never fire. The guard must run against the base slug first.
  const probe = existsProbe(['team-a'])
  const builtNames: string[] = []
  const result = await resolveChainedSprintTeamName({
    baseTeamName: 'Team A',
    refuseTeamSlug: 'team-a',
    buildContext: (name) => {
      builtNames.push(name)
      return buildContext(name)
    },
    stateExists: probe.stateExists,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'sprint_self_trigger')
  assert.match(result.message, /watched team directory "team-a"/u)
  assert.deepEqual(builtNames, ['Team A'], 'only the base name is built — numbering never runs')
  assert.deepEqual(probe.calls, [], 'the disk is never probed once the base slug is refused')
}

async function assertTrimmedRefuseSlugStillMatches(): Promise<void> {
  const probe = existsProbe([])
  const result = await resolveChainedSprintTeamName({
    baseTeamName: 'Team A',
    refuseTeamSlug: '  team-a  ',
    buildContext,
    stateExists: probe.stateExists,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'sprint_self_trigger')
}

async function assertNumberingStepsOverWatchedDirWithoutRecreatingIt(): Promise<void> {
  // Base "Team A" does not collide with the watched "Team A 2", so it is NOT a
  // self-trigger; numbering must step over BOTH the base and the watched dir and
  // never resolve to the watched slug (which would recreate it and re-fire).
  const probe = existsProbe(['team-a', 'team-a-2'])
  const result = await resolveChainedSprintTeamName({
    baseTeamName: 'Team A',
    refuseTeamSlug: 'team-a-2',
    buildContext,
    stateExists: probe.stateExists,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.teamName, 'Team A 3')
  assert.equal(result.context.teamSlug, 'team-a-3')
  assert.notEqual(result.context.teamSlug, 'team-a-2', 'never recreates the watched team dir')
}

async function assertFreeBaseNameReturnsUnchanged(): Promise<void> {
  const probe = existsProbe([])
  const result = await resolveChainedSprintTeamName({
    baseTeamName: 'Fresh Sprint',
    buildContext,
    stateExists: probe.stateExists,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.teamName, 'Fresh Sprint')
  assert.equal(result.context.teamSlug, 'fresh-sprint')
}

async function assertExhaustionIsBounded(): Promise<void> {
  // Every candidate slug exists: the loop must stop and refuse, not spin forever.
  const probe = { stateExists: async () => true }
  const result = await resolveChainedSprintTeamName({
    baseTeamName: 'Busy',
    buildContext,
    stateExists: probe.stateExists,
    maxAttempts: 3,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'sprint_team_name_exhausted')
  assert.match(result.message, /"Busy" after 3 attempts/u)
}

function assertMaxAttemptsDefaultExported(): void {
  assert.equal(CHAINED_SPRINT_TEAM_NAME_MAX_ATTEMPTS, 100)
}

async function main(): Promise<void> {
  await assertSelfTriggerRefusedBeforeNumbering()
  await assertTrimmedRefuseSlugStillMatches()
  await assertNumberingStepsOverWatchedDirWithoutRecreatingIt()
  await assertFreeBaseNameReturnsUnchanged()
  await assertExhaustionIsBounded()
  assertMaxAttemptsDefaultExported()
  console.log('chained sprint team-name guard-ordering tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
