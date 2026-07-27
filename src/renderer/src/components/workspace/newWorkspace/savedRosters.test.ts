import assert from 'node:assert/strict'

import type {
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoster,
} from '../../../types/workspace'
import { sprintEnginePlannerRole } from '../../../../../shared/sprintengine/state'
import {
  PLAIN_AGENT_ROLE_COUNTS,
  activeSprintEngineRoleIds,
  pruneSprintEngineRoleCliDefaults,
  pruneSprintEngineRoleModelOverrides,
  resolveInitialSprintEngineRoster,
  sprintEngineLaunchRoleCounts,
  sprintEngineRosterMatches,
  sprintEngineRosterNameTaken,
} from './savedRosters'

function team(overrides: Partial<SprintEngineRoster>): SprintEngineRoster {
  return {
    id: 't1',
    name: 'Lightweight',
    roleCounts: { architect: 1, developer: 2 },
    roleCliDefaults: { architect: 'claude-code', developer: 'codex' },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

// --- activeSprintEngineRoleIds -------------------------------------------
assert.deepEqual(
  activeSprintEngineRoleIds({ architect: 1, developer: 2, tester: 0 }).sort(),
  ['architect', 'developer'],
  'only roles with count > 0 are active',
)

// --- pruneSprintEngineRoleCliDefaults ------------------------------------
// The wizard holds a default for every known role; only active roles persist.
assert.deepEqual(
  pruneSprintEngineRoleCliDefaults(
    { architect: 1, developer: 2, tester: 0 },
    { architect: 'claude-code', developer: 'codex', tester: 'codex', security: 'claude-code' },
  ),
  { architect: 'claude-code', developer: 'codex' },
  'CLI defaults for count-0 and absent roles are dropped',
)

// --- sprintEngineRosterMatches ---------------------------------------
const base = team({})
assert.equal(
  sprintEngineRosterMatches(base, { architect: 1, developer: 2 }, { architect: 'claude-code', developer: 'codex' }),
  true,
  'identical roster matches',
)
// Pool model: a persisted count is read as an enabled flag, so bumping developer
// 2 -> 3 (still enabled) is NOT divergence — only enable/disable + runtime are.
assert.equal(
  sprintEngineRosterMatches(base, { architect: 1, developer: 3 }, { architect: 'claude-code', developer: 'codex' }),
  true,
  'a changed count on a still-enabled role is not divergence (tolerant count read)',
)
// Disabling a role the team staffed (count -> 0) IS divergence.
assert.equal(
  sprintEngineRosterMatches(base, { architect: 1, developer: 0 }, { architect: 'claude-code' }),
  false,
  'disabling a staffed role diverges',
)
assert.equal(
  sprintEngineRosterMatches(base, { architect: 1, developer: 2 }, { architect: 'claude-code', developer: 'claude-code' }),
  false,
  'a changed CLI on an active role diverges',
)
// A count-0 role with a leftover CLI default must not register as divergence —
// only active roles are compared, with claude-code as the shared fallback.
assert.equal(
  sprintEngineRosterMatches(
    team({ roleCliDefaults: { architect: 'claude-code', developer: 'codex' } }),
    { architect: 1, developer: 2, tester: 0 },
    { architect: 'claude-code', developer: 'codex', tester: 'codex' },
  ),
  true,
  'a leftover CLI default on a count-0 role is not divergence',
)
assert.equal(
  sprintEngineRosterMatches(
    team({ roleCounts: { architect: 1, developer: 2 }, roleCliDefaults: { architect: 'claude-code' } }),
    { architect: 1, developer: 2 },
    { architect: 'claude-code', developer: 'claude-code' },
  ),
  true,
  'an absent saved CLI default resolves to the claude-code fallback',
)
// Adding a role the team did not have diverges (union covers the new active role).
assert.equal(
  sprintEngineRosterMatches(base, { architect: 1, developer: 2, security: 1 }, { architect: 'claude-code', developer: 'codex', security: 'claude-code' }),
  false,
  'adding a new active role diverges',
)

// --- sprintEngineRosterMatches: model overrides ----------------------
const modelTeam = team({ roleModelOverrides: { developer: 'opus' } })
const modelCounts: SprintEngineRoleCounts = { architect: 1, developer: 2 }
const modelClis = { architect: 'claude-code', developer: 'codex' }
assert.equal(
  sprintEngineRosterMatches(modelTeam, modelCounts, modelClis, { developer: 'opus' }),
  true,
  'a saved role model that still matches is not divergence',
)
assert.equal(
  sprintEngineRosterMatches(modelTeam, modelCounts, modelClis, { developer: 'sonnet' }),
  false,
  'a changed role model diverges',
)
assert.equal(
  sprintEngineRosterMatches(modelTeam, modelCounts, modelClis, {}),
  false,
  'clearing a saved role model diverges',
)
assert.equal(
  sprintEngineRosterMatches(modelTeam, modelCounts, modelClis, { developer: 'opus', architect: null }),
  true,
  'an explicit CLI-default (null) on a role the team left unset is not divergence',
)
assert.equal(
  sprintEngineRosterMatches(base, modelCounts, modelClis, { developer: null }),
  true,
  'null / absent / "" model all resolve to the same CLI default (no divergence vs a team without models)',
)
assert.equal(
  sprintEngineRosterMatches(base, modelCounts, modelClis),
  true,
  'omitting the model argument (pre-model callers) still matches a modelless team',
)
// A model override on a count-0 role must not register as divergence.
assert.equal(
  sprintEngineRosterMatches(
    team({ roleCounts: { architect: 1, developer: 2 }, roleModelOverrides: { developer: 'opus' } }),
    { architect: 1, developer: 2, tester: 0 },
    { architect: 'claude-code', developer: 'codex' },
    { developer: 'opus', tester: 'haiku' },
  ),
  true,
  'a leftover model override on a count-0 role is not divergence',
)

// --- pruneSprintEngineRoleModelOverrides ---------------------------------
assert.deepEqual(
  pruneSprintEngineRoleModelOverrides(
    { architect: 1, developer: 2, tester: 0 },
    { architect: 'opus', developer: null, tester: 'haiku', security: 'sonnet' },
  ),
  { architect: 'opus' },
  'only explicit models on active roles persist; null/count-0/absent are dropped',
)
assert.deepEqual(
  pruneSprintEngineRoleModelOverrides({ architect: 1 }, undefined),
  {},
  'a missing override map prunes to empty',
)

// --- sprintEngineRosterNameTaken -------------------------------------------
const teams = [team({ id: 'a', name: 'Lightweight' }), team({ id: 'b', name: 'Full stack' })]
assert.equal(sprintEngineRosterNameTaken(teams, 'lightweight'), true, 'collision is case-insensitive')
assert.equal(sprintEngineRosterNameTaken(teams, '  Full Stack '), true, 'collision trims and folds case')
assert.equal(sprintEngineRosterNameTaken(teams, 'Security run'), false, 'a fresh name is free')
assert.equal(sprintEngineRosterNameTaken(teams, 'Lightweight', 'a'), false, 'a team keeping its own name is not a collision')
assert.equal(sprintEngineRosterNameTaken(teams, 'Lightweight', 'b'), true, 'another team taking the name is a collision')
assert.equal(sprintEngineRosterNameTaken(teams, '   '), false, 'a blank name is never taken')

// --- resolveInitialSprintEngineRoster ------------------------------------
// The wizard's default-selection contract: open pre-selected on a runnable team.
const DEFAULT_COUNTS: SprintEngineRoleCounts = { architect: 1, developer: 1, security: 1 }
const DEFAULT_CLIS = {
  architect: 'claude-code',
  developer: 'claude-code',
  security: 'claude-code',
} as Required<SprintEngineRoleCliDefaults>

// Fresh install (no saved teams, no saved roster) → built-in default, Custom.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(resolved.roleCounts, DEFAULT_COUNTS, 'fresh install seeds the default counts')
  assert.deepEqual(resolved.roleCliDefaults, DEFAULT_CLIS, 'fresh install seeds the default CLI map')
  assert.equal(resolved.selectedRosterId, null, 'fresh install has no selected team')
  assert.notEqual(resolved.roleCounts, DEFAULT_COUNTS, 'counts are cloned, not the same reference')
}

// lastSelectedRosterId resolves to that team, which becomes the selection.
{
  const picked = team({ id: 'b', name: 'Reviewers', roleCounts: { architect: 1, developer: 2, security: 1 }, roleCliDefaults: { developer: 'codex' } })
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'a' }), picked],
    lastSelectedRosterId: 'b',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.selectedRosterId, 'b', 'lastSelectedRosterId selects the matching saved team')
  assert.deepEqual(resolved.roleCounts, { architect: 1, developer: 2, security: 1 }, 'counts come from the selected team')
  // CLI defaults layer the team subset over the full default map.
  assert.deepEqual(
    resolved.roleCliDefaults,
    { architect: 'claude-code', developer: 'codex', security: 'claude-code' },
    'team CLI subset layers over the default map',
  )
}

// The selected team's saved model overrides ride into the opened roster.
{
  const picked = team({
    id: 'b',
    name: 'Reviewers',
    roleCounts: { architect: 1, developer: 2 },
    roleModelOverrides: { developer: 'opus' },
  })
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'a' }), picked],
    lastSelectedRosterId: 'b',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(resolved.roleModelOverrides, { developer: 'opus' }, 'selected team model overrides seed the roster')
  assert.notEqual(resolved.roleModelOverrides, picked.roleModelOverrides, 'model overrides are cloned, not the same reference')
}

// A modelless team (or fresh install) resolves to an empty override map.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(resolved.roleModelOverrides, {}, 'fresh install has no model overrides')
}

// lastSelectedRosterId with no match falls back to the legacy single saved roster.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'a' })],
    lastSelectedRosterId: 'missing',
    savedRoster: { roleCounts: { architect: 1, developer: 1 }, roleCliDefaults: { architect: 'codex' } },
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.selectedRosterId, null, 'an unmatched lastSelectedRosterId is Custom, not a team')
  assert.deepEqual(resolved.roleCounts, { architect: 1, developer: 1 }, 'falls back to the legacy saved roster counts')
  assert.deepEqual(
    resolved.roleCliDefaults,
    { architect: 'codex', developer: 'claude-code', security: 'claude-code' },
    'legacy roster CLI subset layers over the default map',
  )
}

// --- MC-1875: formation is a stored property of the roster -----------------

// A roster saved in pool formation reopens in pool formation — the whole point.
// Note its roleCounts still staff specialists (the wizard keeps them behind the
// collapsed disclosure), which is exactly the case the old guess got WRONG:
// re-deriving from roleCounts would say 'roles'.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'p', mode: 'pool', roleCounts: { architect: 1, developer: 1 } })],
    lastSelectedRosterId: 'p',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.mode, 'pool', 'a saved pool formation is restored, not re-derived from roleCounts')
  assert.deepEqual(
    resolved.roleCounts,
    { architect: 1, developer: 1 },
    'the specialist roster is still carried, so switching back to roles restores it',
  )
}

// An explicitly-saved roles formation survives even when nothing but `general`
// is staffed — the mirror case, where the guess would have said 'pool'.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'r', mode: 'roles', roleCounts: { general: 1 } })],
    lastSelectedRosterId: 'r',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.mode, 'roles', 'an explicit roles formation is not overridden by the guess')
}

// A roster saved BEFORE this change has no `mode`, and must resolve exactly as
// it did before: the staffs-specialists guess.
{
  const legacySpecialist = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'l', roleCounts: { architect: 1, developer: 1 } })],
    lastSelectedRosterId: 'l',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(legacySpecialist.mode, 'roles', 'a legacy roster staffing specialists still opens on roles')

  const legacyPlain = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'l', roleCounts: { general: 1 } })],
    lastSelectedRosterId: 'l',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(legacyPlain.mode, 'pool', 'a legacy general-only roster still opens on the pool')
}

// A fresh install (no saved source at all) opens on the pool even though the
// built-in default counts staff specialists — the MC-1585 behavior the resolver
// must not silently flip.
{
  const fresh = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(fresh.mode, 'pool', 'a fresh install still opens on the plain agent pool')
  assert.deepEqual(fresh.roleCounts, DEFAULT_COUNTS, 'while still holding the default specialist roster behind it')
}

// Switching formation marks the roster dirty, so "Update" can persist the new
// mode. Without this, changing formation and pressing Update would silently
// re-save the OLD formation.
{
  const pool = team({ id: 'p', mode: 'pool', roleCounts: { architect: 1, developer: 2 } })
  assert.equal(
    sprintEngineRosterMatches(pool, pool.roleCounts, pool.roleCliDefaults, undefined, 'pool'),
    true,
    'merely opening a pool roster is not an edit',
  )
  assert.equal(
    sprintEngineRosterMatches(pool, pool.roleCounts, pool.roleCliDefaults, undefined, 'roles'),
    false,
    'switching formation marks the roster edited',
  )
  // A legacy roster resolves its implicit mode the same way the loader does, so
  // opening one is never spuriously "edited".
  const legacy = team({ id: 'l', roleCounts: { architect: 1, developer: 2 } })
  assert.equal(
    sprintEngineRosterMatches(legacy, legacy.roleCounts, legacy.roleCliDefaults, undefined, 'roles'),
    true,
    'opening a legacy specialist roster is not an edit',
  )
  // Callers that do not track formation compare exactly as before.
  assert.equal(
    sprintEngineRosterMatches(pool, pool.roleCounts, pool.roleCliDefaults),
    true,
    'omitting the mode argument keeps the pre-MC-1875 comparison',
  )
}

// OWNER RULING 2026-07-26: no roster-level agent count. A pool run's ceiling is
// the RUN's max-concurrency setting, never a number stored on the roster.
{
  const pool = team({ id: 'p', mode: 'pool' })
  const keys = Object.keys(pool)
  for (const forbidden of ['agentCount', 'poolSize', 'maxAgents', 'agents']) {
    assert.ok(!keys.includes(forbidden), `a roster must not carry "${forbidden}" — the run owns concurrency`)
  }
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [pool],
    lastSelectedRosterId: 'p',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(
    Object.keys(resolved).sort(),
    ['mode', 'roleCliDefaults', 'roleCounts', 'roleModelOverrides', 'selectedRosterId'],
    'the resolver returns formation and staffing only — no agent count',
  )
}

// SEAM (MC-1875): formation -> what actually launches. Horizon could not start
// a pool run at all before this: its only launch door passed roleCounts and
// nothing else, so "no roles" was unexpressible.
{
  const specialistCounts: SprintEngineRoleCounts = { architect: 1, developer: 1 }

  assert.deepEqual(
    sprintEngineLaunchRoleCounts('roles', specialistCounts),
    specialistCounts,
    'a roles roster launches with exactly its own counts — byte-identical to today',
  )
  assert.deepEqual(
    sprintEngineLaunchRoleCounts('pool', specialistCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'a pool roster launches the plain-agent seed, not the specialists it parks behind the disclosure',
  )

  // The acceptance criterion in full: a pool launch seats NO architect, and the
  // agent it spawns first is a plain general.
  const poolLaunch = sprintEngineLaunchRoleCounts('pool', specialistCounts)
  assert.equal(poolLaunch.architect ?? 0, 0, 'a no-roles run has no architect seat')
  assert.equal(
    sprintEnginePlannerRole(poolLaunch),
    'general',
    'the initial spawn for a no-roles run is a plain general agent',
  )
  assert.equal(
    sprintEnginePlannerRole(sprintEngineLaunchRoleCounts('roles', specialistCounts)),
    'architect',
    'a roles run still spawns its architect first',
  )

  // WHY the line above is load-bearing, pinned against the item's own (wrong)
  // claim that sprintEnginePlannerRole "picks general over architect when
  // general is staffed". It does NOT — architect wins whenever it is staffed.
  // The pool result is correct only because the seed contains no architect. If
  // that ever changes, a "no roles" run silently gets an architect planner.
  assert.equal(
    sprintEnginePlannerRole({ architect: 1, general: 1 }),
    'architect',
    'architect outranks general when both are staffed — so the pool seed must never carry one',
  )
}

console.log('saved team helper tests passed')
