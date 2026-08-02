import assert from 'node:assert/strict'

import type {
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoster,
} from '../../../types/workspace'
import { sprintEngineCoordinatorSeatForRoleCounts } from '../../../../../shared/sprintengine/state'
import {
  NO_ROLES_ROSTER,
  NO_ROLES_ROSTER_ID,
  NO_ROLES_ROSTER_NAME,
  PLAIN_AGENT_ROLE_COUNTS,
  activeSprintEngineRoleIds,
  findSavedSprintEngineRoster,
  isNoRolesRosterRef,
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

// Fresh install (no saved rosters, no saved roster) → the built-in "No roles".
// MC-1876 changed this from an unnamed "Custom" selection: the zero-config
// default is now a nameable, deterministic thing the picker can show.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  // The specialist default is still SEEDED (so picking a roster later opens on
  // something runnable) — it is just no longer what LAUNCHES.
  assert.deepEqual(resolved.roleCounts, DEFAULT_COUNTS, 'fresh install seeds the default counts')
  assert.deepEqual(resolved.roleCliDefaults, DEFAULT_CLIS, 'fresh install seeds the default CLI map')
  assert.equal(resolved.selectedRosterId, NO_ROLES_ROSTER_ID, 'fresh install selects the built-in No roles')
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(resolved.selectedRosterId, resolved.roleCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'and a fresh-install launch stages the plain-agent seed',
  )
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

// --- MC-2064: a roster is a set of roles — there is no formation -----------

// The `mode` axis is deleted outright (owner ruling: no users, no saved pools,
// no migration). A roster carries staffing and runtimes only, and the resolver
// returns nothing beyond selection + staffing.
{
  const saved = team({ id: 'p' })
  const keys = Object.keys(saved)
  for (const forbidden of ['mode', 'agentCount', 'poolSize', 'maxAgents', 'agents']) {
    assert.ok(!keys.includes(forbidden), `a roster must not carry "${forbidden}"`)
  }
  assert.ok(!('mode' in NO_ROLES_ROSTER), 'the built-in carries no formation either — it IS the level above rosters')
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [saved],
    lastSelectedRosterId: 'p',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(
    Object.keys(resolved).sort(),
    ['roleCliDefaults', 'roleCounts', 'roleModelOverrides', 'selectedRosterId'],
    'the resolver returns selection and staffing only — no formation, no agent count',
  )
}

// A fresh install (no saved source at all) opens on the built-in "No roles"
// even though the seeded default counts staff specialists — the MC-1585
// behavior the resolver must not silently flip.
{
  const fresh = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(fresh.selectedRosterId, NO_ROLES_ROSTER_ID, 'a fresh install still opens on No roles')
  assert.deepEqual(fresh.roleCounts, DEFAULT_COUNTS, 'while still holding the default specialist roster seeded behind it')
}

// A persisted roster selection whose id no longer resolves (deleted roster,
// hand-edited settings) falls back to the built-in "No roles" — never to a
// phantom roster. The legacy single-roster mirror is the one documented
// exception, pinned separately above.
{
  const stale = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: 'ghost-roster-id',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(stale.selectedRosterId, NO_ROLES_ROSTER_ID, 'a stale selection falls back to No roles')
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(stale.selectedRosterId, stale.roleCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'and launches the plain-agent seed, not the seeded specialist rows',
  )
}

// SEAM: the no-roles/roster selection -> what actually launches. Keyed off the
// roster REFERENCE via isNoRolesRosterRef, never a stored formation.
{
  const specialistCounts: SprintEngineRoleCounts = { architect: 1, developer: 1 }

  assert.deepEqual(
    sprintEngineLaunchRoleCounts('some-saved-roster', specialistCounts),
    specialistCounts,
    'a roster selection launches with exactly its own counts',
  )
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(null, specialistCounts),
    specialistCounts,
    'and so does a hand-tuned (Custom) selection',
  )
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(NO_ROLES_ROSTER_ID, specialistCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'the built-in launches the plain-agent seed, not the specialists the wizard keeps seeded',
  )
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(NO_ROLES_ROSTER_NAME, specialistCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'by name as well as by id — horizon frontmatter references it by name',
  )

  // The acceptance criterion in full: a no-roles launch seats NO architect, and
  // the agent it spawns first carries no role.
  const noRolesLaunch = sprintEngineLaunchRoleCounts(NO_ROLES_ROSTER_ID, specialistCounts)
  assert.equal(noRolesLaunch.architect ?? 0, 0, 'a no-roles run has no architect seat')
  assert.deepEqual(
    sprintEngineCoordinatorSeatForRoleCounts(noRolesLaunch),
    { agentId: 'coordinator' },
    'the initial spawn for a no-roles run is the roleless coordinator seat',
  )
  assert.deepEqual(
    sprintEngineCoordinatorSeatForRoleCounts(sprintEngineLaunchRoleCounts('some-saved-roster', specialistCounts)),
    { role: 'architect', agentId: 'architect' },
    'a roster run still spawns its architect first',
  )

  // WHY the line above is load-bearing: the seat is architect whenever an
  // architect is CONFIGURED, so the no-roles result is correct only because the
  // seed staffs nothing. If that ever changes, a "no roles" run silently gets
  // an architect coordinator.
  assert.deepEqual(
    sprintEngineCoordinatorSeatForRoleCounts({ architect: 1, developer: 1 }),
    { role: 'architect', agentId: 'architect' },
    'a staffed architect always takes the seat — so the no-roles seed must never carry one',
  )
}

// --- MC-1876: "No roles" is the zero-configuration default -----------------

// The built-in resolves by id AND by name, so `roster: No roles` in a horizon's
// frontmatter works as well as the internal id.
{
  assert.equal(isNoRolesRosterRef(NO_ROLES_ROSTER_ID), true, 'the built-in resolves by id')
  assert.equal(isNoRolesRosterRef(NO_ROLES_ROSTER_NAME), true, 'and by name')
  assert.equal(isNoRolesRosterRef('  no ROLES  '), true, 'name matching ignores case and surrounding space')
  assert.equal(isNoRolesRosterRef('No roles pair'), false, 'a different name is not the built-in')
  assert.equal(isNoRolesRosterRef(null), false, 'absent is not the built-in')
  assert.equal(isNoRolesRosterRef(''), false, 'empty is not the built-in')
}

// It carries the plain-agent seed and no staffing to summarise — it is the
// ABSENCE of a roster.
{
  assert.deepEqual(NO_ROLES_ROSTER.roleCounts, PLAIN_AGENT_ROLE_COUNTS)
  assert.equal(NO_ROLES_ROSTER.id, NO_ROLES_ROSTER_ID)
  assert.equal(NO_ROLES_ROSTER.name, NO_ROLES_ROSTER_NAME)
}

// An explicit reference to the built-in beats a saved roster AND a last-used
// selection — naming it means "no roster", so nothing may override it.
{
  const saved = team({ id: 'a', name: 'opus', roleCounts: { architect: 1, developer: 1 } })
  const byName = resolveInitialSprintEngineRoster({
    savedRosters: [saved],
    lastSelectedRosterId: 'a',
    savedRoster: { roleCounts: { architect: 1 }, roleCliDefaults: {} },
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
    explicitRosterRef: NO_ROLES_ROSTER_NAME,
  })
  assert.equal(byName.selectedRosterId, NO_ROLES_ROSTER_ID, 'naming the built-in wins over last-used')
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(byName.selectedRosterId, byName.roleCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'and staffs no roles',
  )
}

// Selecting the built-in STICKS across a reload: `lastSelectedRosterId` holding
// the built-in id must not fall through to the legacy savedRoster mirror, which
// would silently re-staff "No roles" with the last specialist roster touched.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedRosters: [team({ id: 'a', name: 'opus' })],
    lastSelectedRosterId: NO_ROLES_ROSTER_ID,
    savedRoster: { roleCounts: { architect: 1, developer: 1 }, roleCliDefaults: { architect: 'codex' } },
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.selectedRosterId, NO_ROLES_ROSTER_ID, 'a stored No-roles selection survives reload')
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(resolved.selectedRosterId, resolved.roleCounts),
    PLAIN_AGENT_ROLE_COUNTS,
    'and is not re-staffed from the legacy roster mirror',
  )
}

// An explicit SAVED roster still wins over the default — the flip only changes
// what ABSENT means.
{
  const saved = team({ id: 'a', name: 'opus', roleCounts: { architect: 1, developer: 1 } })
  const byId = resolveInitialSprintEngineRoster({
    savedRosters: [saved],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
    explicitRosterRef: 'a',
  })
  assert.equal(byId.selectedRosterId, 'a', 'an explicit saved roster id resolves')
  assert.deepEqual(
    sprintEngineLaunchRoleCounts(byId.selectedRosterId, byId.roleCounts),
    { architect: 1, developer: 1 },
    'and launches its own staffing',
  )
  const byName = resolveInitialSprintEngineRoster({
    savedRosters: [saved],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
    explicitRosterRef: 'OPUS',
  })
  assert.equal(byName.selectedRosterId, 'a', 'and so does its name, case-insensitively')
}

// Name lookup: the built-in is deliberately NOT in the saved list, so callers
// must check isNoRolesRosterRef first. This is what keeps "a named roster that
// does not exist fails loudly" from accidentally swallowing the built-in.
{
  const rosters = [team({ id: 'a', name: 'opus' })]
  assert.equal(findSavedSprintEngineRoster(rosters, 'opus')?.id, 'a')
  assert.equal(findSavedSprintEngineRoster(rosters, 'a')?.id, 'a')
  assert.equal(findSavedSprintEngineRoster(rosters, NO_ROLES_ROSTER_NAME), null, 'the built-in is not a saved roster')
  assert.equal(findSavedSprintEngineRoster(rosters, 'ghost'), null, 'an unknown name finds nothing, so callers can fail loudly')
  assert.equal(findSavedSprintEngineRoster(rosters, null), null)
}

// The reserved name cannot be taken by a user roster, so nothing can shadow the
// default in a picker or in horizon frontmatter (where NAME is the reference).
{
  assert.equal(sprintEngineRosterNameTaken([], NO_ROLES_ROSTER_NAME), true, 'the built-in name is reserved')
  assert.equal(sprintEngineRosterNameTaken([], 'no roles'), true, 'case-insensitively')
  assert.equal(sprintEngineRosterNameTaken([], '  No Roles '), true, 'and ignoring surrounding space')
  assert.equal(sprintEngineRosterNameTaken([], 'No roles v2'), false, 'a merely similar name is fine')
  // Reserved even when renaming an existing roster onto it.
  assert.equal(
    sprintEngineRosterNameTaken([team({ id: 'a' })], NO_ROLES_ROSTER_NAME, 'a'),
    true,
    'excludeId does not unlock the reserved name',
  )
}

// Deleting every saved roster leaves the built-in present and selectable.
{
  const afterDeletingAll = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(afterDeletingAll.selectedRosterId, NO_ROLES_ROSTER_ID, 'No roles survives deleting every roster')
  assert.equal(
    sprintEngineLaunchRoleCounts(afterDeletingAll.selectedRosterId, afterDeletingAll.roleCounts).architect ?? 0,
    0,
    'and still launches with no architect',
  )
}

// SEAM (MC-1876, found in review): BOTH sprint.create paths resolve a roster
// through resolveRequestedRoster and BOTH must honor the selection it returns.
// The goal-sourced path originally passed `roster.roleCounts` straight
// through and hardcoded `initialSpawnRoles: ['architect']`, so a No-roles run
// created that way silently staffed the specialist defaults and seated an
// architect — the selection resolved, then ignored, on one of two callers.
//
// This pins the shared decision both paths now make. The regression it guards
// is "one caller honors the contract and the other does not", which is invisible
// to any test that only exercises the Horizon path.
{
  const defaultResolved = resolveInitialSprintEngineRoster({
    savedRosters: [],
    lastSelectedRosterId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  // What the resolver hands a caller still carries the specialist defaults...
  assert.ok((defaultResolved.roleCounts.architect ?? 0) > 0, 'the resolved roster still carries the specialist rows')
  // ...so a caller that forgets to apply the selection staffs an architect.
  // Applying it is what makes "No roles" true.
  const launched = sprintEngineLaunchRoleCounts(defaultResolved.selectedRosterId, defaultResolved.roleCounts)
  assert.deepEqual(launched, PLAIN_AGENT_ROLE_COUNTS, 'both paths must launch the plain-agent seed')
  assert.equal(launched.architect ?? 0, 0, 'and therefore seat no architect')
  assert.deepEqual(
    sprintEngineCoordinatorSeatForRoleCounts(launched),
    { agentId: 'coordinator' },
    'so the first agent spawned carries no role, not the hardcoded architect',
  )
}

console.log('saved team helper tests passed')
