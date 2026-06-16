import assert from 'node:assert/strict'

import type { SprintEngineRosterTeam } from '../../../types/workspace'
import {
  activeSprintEngineRoleIds,
  pruneSprintEngineRoleCliDefaults,
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

// --- sprintEngineTeamNameTaken -------------------------------------------
const teams = [team({ id: 'a', name: 'Lightweight' }), team({ id: 'b', name: 'Full stack' })]
assert.equal(sprintEngineTeamNameTaken(teams, 'lightweight'), true, 'collision is case-insensitive')
assert.equal(sprintEngineTeamNameTaken(teams, '  Full Stack '), true, 'collision trims and folds case')
assert.equal(sprintEngineTeamNameTaken(teams, 'Security run'), false, 'a fresh name is free')
assert.equal(sprintEngineTeamNameTaken(teams, 'Lightweight', 'a'), false, 'a team keeping its own name is not a collision')
assert.equal(sprintEngineTeamNameTaken(teams, 'Lightweight', 'b'), true, 'another team taking the name is a collision')
assert.equal(sprintEngineTeamNameTaken(teams, '   '), false, 'a blank name is never taken')

console.log('saved team helper tests passed')
