import assert from 'node:assert/strict'

import type {
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRosterTeam,
} from '../../../types/workspace'
import {
  activeSprintEngineRoleIds,
  pruneSprintEngineRoleCliDefaults,
  pruneSprintEngineRoleModelOverrides,
  resolveInitialSprintEngineRoster,
  sprintEngineRosterMatchesTeam,
  sprintEngineTeamNameTaken,
} from './savedTeams'

function team(overrides: Partial<SprintEngineRosterTeam>): SprintEngineRosterTeam {
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

// --- sprintEngineRosterMatchesTeam ---------------------------------------
const base = team({})
assert.equal(
  sprintEngineRosterMatchesTeam(base, { architect: 1, developer: 2 }, { architect: 'claude-code', developer: 'codex' }),
  true,
  'identical roster matches',
)
assert.equal(
  sprintEngineRosterMatchesTeam(base, { architect: 1, developer: 3 }, { architect: 'claude-code', developer: 'codex' }),
  false,
  'a changed count diverges',
)
assert.equal(
  sprintEngineRosterMatchesTeam(base, { architect: 1, developer: 2 }, { architect: 'claude-code', developer: 'claude-code' }),
  false,
  'a changed CLI on an active role diverges',
)
// A count-0 role with a leftover CLI default must not register as divergence —
// only active roles are compared, with claude-code as the shared fallback.
assert.equal(
  sprintEngineRosterMatchesTeam(
    team({ roleCliDefaults: { architect: 'claude-code', developer: 'codex' } }),
    { architect: 1, developer: 2, tester: 0 },
    { architect: 'claude-code', developer: 'codex', tester: 'codex' },
  ),
  true,
  'a leftover CLI default on a count-0 role is not divergence',
)
assert.equal(
  sprintEngineRosterMatchesTeam(
    team({ roleCounts: { architect: 1, developer: 2 }, roleCliDefaults: { architect: 'claude-code' } }),
    { architect: 1, developer: 2 },
    { architect: 'claude-code', developer: 'claude-code' },
  ),
  true,
  'an absent saved CLI default resolves to the claude-code fallback',
)
// Adding a role the team did not have diverges (union covers the new active role).
assert.equal(
  sprintEngineRosterMatchesTeam(base, { architect: 1, developer: 2, security: 1 }, { architect: 'claude-code', developer: 'codex', security: 'claude-code' }),
  false,
  'adding a new active role diverges',
)

// --- sprintEngineRosterMatchesTeam: model overrides ----------------------
const modelTeam = team({ roleModelOverrides: { developer: 'opus' } })
const modelCounts: SprintEngineRoleCounts = { architect: 1, developer: 2 }
const modelClis = { architect: 'claude-code', developer: 'codex' }
assert.equal(
  sprintEngineRosterMatchesTeam(modelTeam, modelCounts, modelClis, { developer: 'opus' }),
  true,
  'a saved role model that still matches is not divergence',
)
assert.equal(
  sprintEngineRosterMatchesTeam(modelTeam, modelCounts, modelClis, { developer: 'sonnet' }),
  false,
  'a changed role model diverges',
)
assert.equal(
  sprintEngineRosterMatchesTeam(modelTeam, modelCounts, modelClis, {}),
  false,
  'clearing a saved role model diverges',
)
assert.equal(
  sprintEngineRosterMatchesTeam(modelTeam, modelCounts, modelClis, { developer: 'opus', architect: null }),
  true,
  'an explicit CLI-default (null) on a role the team left unset is not divergence',
)
assert.equal(
  sprintEngineRosterMatchesTeam(base, modelCounts, modelClis, { developer: null }),
  true,
  'null / absent / "" model all resolve to the same CLI default (no divergence vs a team without models)',
)
assert.equal(
  sprintEngineRosterMatchesTeam(base, modelCounts, modelClis),
  true,
  'omitting the model argument (pre-model callers) still matches a modelless team',
)
// A model override on a count-0 role must not register as divergence.
assert.equal(
  sprintEngineRosterMatchesTeam(
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

// --- sprintEngineTeamNameTaken -------------------------------------------
const teams = [team({ id: 'a', name: 'Lightweight' }), team({ id: 'b', name: 'Full stack' })]
assert.equal(sprintEngineTeamNameTaken(teams, 'lightweight'), true, 'collision is case-insensitive')
assert.equal(sprintEngineTeamNameTaken(teams, '  Full Stack '), true, 'collision trims and folds case')
assert.equal(sprintEngineTeamNameTaken(teams, 'Security run'), false, 'a fresh name is free')
assert.equal(sprintEngineTeamNameTaken(teams, 'Lightweight', 'a'), false, 'a team keeping its own name is not a collision')
assert.equal(sprintEngineTeamNameTaken(teams, 'Lightweight', 'b'), true, 'another team taking the name is a collision')
assert.equal(sprintEngineTeamNameTaken(teams, '   '), false, 'a blank name is never taken')

// --- resolveInitialSprintEngineRoster ------------------------------------
// The wizard's default-selection contract: open pre-selected on a runnable team.
const DEFAULT_COUNTS: SprintEngineRoleCounts = { architect: 1, developer: 1, code_reviewer: 1 }
const DEFAULT_CLIS = {
  architect: 'claude-code',
  developer: 'claude-code',
  code_reviewer: 'claude-code',
} as Required<SprintEngineRoleCliDefaults>

// Fresh install (no saved teams, no saved roster) → built-in default, Custom.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedTeams: [],
    lastSelectedTeamId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(resolved.roleCounts, DEFAULT_COUNTS, 'fresh install seeds the default counts')
  assert.deepEqual(resolved.roleCliDefaults, DEFAULT_CLIS, 'fresh install seeds the default CLI map')
  assert.equal(resolved.selectedTeamId, null, 'fresh install has no selected team')
  assert.notEqual(resolved.roleCounts, DEFAULT_COUNTS, 'counts are cloned, not the same reference')
}

// lastSelectedTeamId resolves to that team, which becomes the selection.
{
  const picked = team({ id: 'b', name: 'Reviewers', roleCounts: { architect: 1, developer: 2, code_reviewer: 1 }, roleCliDefaults: { developer: 'codex' } })
  const resolved = resolveInitialSprintEngineRoster({
    savedTeams: [team({ id: 'a' }), picked],
    lastSelectedTeamId: 'b',
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.selectedTeamId, 'b', 'lastSelectedTeamId selects the matching saved team')
  assert.deepEqual(resolved.roleCounts, { architect: 1, developer: 2, code_reviewer: 1 }, 'counts come from the selected team')
  // CLI defaults layer the team subset over the full default map.
  assert.deepEqual(
    resolved.roleCliDefaults,
    { architect: 'claude-code', developer: 'codex', code_reviewer: 'claude-code' },
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
    savedTeams: [team({ id: 'a' }), picked],
    lastSelectedTeamId: 'b',
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
    savedTeams: [],
    lastSelectedTeamId: null,
    savedRoster: null,
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.deepEqual(resolved.roleModelOverrides, {}, 'fresh install has no model overrides')
}

// lastSelectedTeamId with no match falls back to the legacy single saved roster.
{
  const resolved = resolveInitialSprintEngineRoster({
    savedTeams: [team({ id: 'a' })],
    lastSelectedTeamId: 'missing',
    savedRoster: { roleCounts: { architect: 1, developer: 1 }, roleCliDefaults: { architect: 'codex' } },
    defaultRoleCounts: DEFAULT_COUNTS,
    defaultRoleCliDefaults: DEFAULT_CLIS,
  })
  assert.equal(resolved.selectedTeamId, null, 'an unmatched lastSelectedTeamId is Custom, not a team')
  assert.deepEqual(resolved.roleCounts, { architect: 1, developer: 1 }, 'falls back to the legacy saved roster counts')
  assert.deepEqual(
    resolved.roleCliDefaults,
    { architect: 'codex', developer: 'claude-code', code_reviewer: 'claude-code' },
    'legacy roster CLI subset layers over the default map',
  )
}

console.log('saved team helper tests passed')
