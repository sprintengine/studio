import assert from 'node:assert/strict'

import {
  authoringFieldErrors,
  authoringStatusReducer,
  createRoleAuthoringDraft,
  editRoleAuthoringDraft,
  idleAuthoringStatus,
  isAuthoringBusy,
  mapIssuesToFieldErrors,
  toUserRoleSaveInput,
  validateRoleAuthoringDraft,
  type RoleAuthoringDraft,
  type RoleAuthoringStatus,
} from './userRoleAuthoring'

function validDraft(overrides: Partial<RoleAuthoringDraft> = {}): RoleAuthoringDraft {
  return {
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits diffs for regressions. Staff it before a release.',
    aliases: [],
    body: 'You audit the change.',
    ...overrides,
  }
}

const createMode = { kind: 'create' as const }
const noExisting: string[] = []

// --- draft seeding -------------------------------------------------------

function testCreateDraftSeedsStarterBody(): void {
  const draft = createRoleAuthoringDraft()
  assert.equal(draft.id, '')
  // Seeded with the starter template, not a blank textarea.
  assert.ok(draft.body.includes('<what-to-do>'))
  assert.ok(draft.body.includes('<supporting-info>'))
}

function testEditDraftPrefillsAndLocksId(): void {
  const draft = editRoleAuthoringDraft(
    {
      id: 'code_auditor',
      label: 'Code auditor',
      description: 'Audits diffs. Staff it before a release.',
      aliases: ['auditor', 'reviewer_x'],
      directives: { implement: [{ skill: 'code_auditor' }] },
    },
    'Instructions here.',
  )
  assert.equal(draft.id, 'code_auditor')
  assert.equal(draft.label, 'Code auditor')
  assert.equal(draft.description, 'Audits diffs. Staff it before a release.')
  // Aliases are no longer an authoring field, but editing a role that has them
  // must not silently drop them on save.
  assert.deepEqual(draft.aliases, ['auditor', 'reviewer_x'])
  assert.equal(draft.body, 'Instructions here.')
}

// --- save input assembly -------------------------------------------------

function testSaveInputOmitsEmptyOptionals(): void {
  const input = toUserRoleSaveInput(validDraft())
  assert.deepEqual(input, {
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits diffs for regressions. Staff it before a release.',
    body: 'You audit the change.',
  })
  assert.equal('aliases' in input, false)
}

function testSaveInputCarriesPreservedAliases(): void {
  const input = toUserRoleSaveInput(validDraft({ aliases: ['auditor', '  '] }))
  assert.deepEqual(input.aliases, ['auditor'])
}

// --- validation ----------------------------------------------------------

function testValidDraftPasses(): void {
  const result = validateRoleAuthoringDraft(validDraft(), {
    mode: createMode,
    existingIdsAndAliases: noExisting,
  })
  assert.equal(result.ok, true)
}

function testInvalidIdMapsToIdField(): void {
  const result = validateRoleAuthoringDraft(validDraft({ id: 'Bad-Id' }), {
    mode: createMode,
    existingIdsAndAliases: noExisting,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.id)
}

function testEmptyLabelMapsToLabelField(): void {
  const result = validateRoleAuthoringDraft(validDraft({ label: '   ' }), {
    mode: createMode,
    existingIdsAndAliases: noExisting,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.label)
}

function testEmptyDescriptionMapsToDescriptionField(): void {
  const result = validateRoleAuthoringDraft(validDraft({ description: '   ' }), {
    mode: createMode,
    existingIdsAndAliases: noExisting,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.description)
}

// --- empty body ----------------------------------------------------------

function testEmptyBodyIsBlocking(): void {
  const result = validateRoleAuthoringDraft(validDraft({ body: '   \n  ' }), {
    mode: createMode,
    existingIdsAndAliases: noExisting,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.body)
}

// --- id collision --------------------------------------------------------

function testIdCollisionBlocksInCreateMode(): void {
  const result = validateRoleAuthoringDraft(validDraft({ id: 'frontend' }), {
    mode: createMode,
    existingIdsAndAliases: ['frontend', 'developer'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.id)
}

function testIdCollisionAgainstAliasBlocks(): void {
  const result = validateRoleAuthoringDraft(validDraft({ id: 'reviewer' }), {
    mode: createMode,
    existingIdsAndAliases: ['security', 'reviewer'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.id)
}

function testEditModeSkipsCollision(): void {
  // Edit re-saves an existing id; its own id is in the registry, but the locked
  // id must not be flagged as a collision against itself.
  const result = validateRoleAuthoringDraft(validDraft({ id: 'auditor' }), {
    mode: { kind: 'edit', id: 'auditor' },
    existingIdsAndAliases: ['auditor', 'frontend'],
  })
  assert.equal(result.ok, true)
}

// --- issue mapping -------------------------------------------------------

function testMapIssuesKeepsFirstPerField(): void {
  const errors = mapIssuesToFieldErrors([
    { path: 'id', message: 'first id' },
    { path: 'id', message: 'second id' },
    { path: 'description', message: 'needs a description' },
    { path: 'mystery', message: 'unhomed' },
  ])
  assert.equal(errors.id, 'first id')
  assert.equal(errors.description, 'needs a description')
  // Aliases are not authored here, so an alias issue has no field home.
  assert.equal(errors.form, 'unhomed')
}

// --- state machine -------------------------------------------------------

function testHappyPathLifecycle(): void {
  let state: RoleAuthoringStatus = idleAuthoringStatus
  state = authoringStatusReducer(state, { type: 'submit' })
  assert.equal(state.status, 'validating')
  assert.equal(isAuthoringBusy(state), true)
  state = authoringStatusReducer(state, { type: 'valid' })
  assert.equal(state.status, 'saving')
  assert.equal(isAuthoringBusy(state), true)
  state = authoringStatusReducer(state, { type: 'saved', id: 'auditor' })
  assert.equal(state.status, 'saved')
  if (state.status === 'saved') assert.equal(state.id, 'auditor')
  assert.equal(isAuthoringBusy(state), false)
}

function testValidationFailureLifecycle(): void {
  let state: RoleAuthoringStatus = idleAuthoringStatus
  state = authoringStatusReducer(state, { type: 'submit' })
  state = authoringStatusReducer(state, { type: 'invalid', errors: { id: 'bad' } })
  assert.equal(state.status, 'error')
  assert.deepEqual(authoringFieldErrors(state), { id: 'bad' })
}

function testSaveFailureLifecycle(): void {
  let state: RoleAuthoringStatus = idleAuthoringStatus
  state = authoringStatusReducer(state, { type: 'submit' })
  state = authoringStatusReducer(state, { type: 'valid' })
  state = authoringStatusReducer(state, { type: 'failed', errors: { body: 'empty' } })
  assert.equal(state.status, 'error')
  assert.deepEqual(authoringFieldErrors(state), { body: 'empty' })
}

function testReentrantSubmitIgnoredWhileSaving(): void {
  let state: RoleAuthoringStatus = { status: 'saving' }
  state = authoringStatusReducer(state, { type: 'submit' })
  assert.equal(state.status, 'saving')
}

function testResetReturnsIdle(): void {
  const state = authoringStatusReducer({ status: 'error', errors: { id: 'x' } }, { type: 'reset' })
  assert.equal(state.status, 'idle')
  assert.deepEqual(authoringFieldErrors(state), {})
}

function testStaleEventsIgnored(): void {
  // A 'saved' that arrives when not saving (e.g. after reset) is a no-op.
  const state = authoringStatusReducer(idleAuthoringStatus, { type: 'saved', id: 'x' })
  assert.equal(state.status, 'idle')
}

testCreateDraftSeedsStarterBody()
testEditDraftPrefillsAndLocksId()
testSaveInputOmitsEmptyOptionals()
testSaveInputCarriesPreservedAliases()
testValidDraftPasses()
testInvalidIdMapsToIdField()
testEmptyLabelMapsToLabelField()
testEmptyDescriptionMapsToDescriptionField()
testEmptyBodyIsBlocking()
testIdCollisionBlocksInCreateMode()
testIdCollisionAgainstAliasBlocks()
testEditModeSkipsCollision()
testMapIssuesKeepsFirstPerField()
testHappyPathLifecycle()
testValidationFailureLifecycle()
testSaveFailureLifecycle()
testReentrantSubmitIgnoredWhileSaving()
testResetReturnsIdle()
testStaleEventsIgnored()

console.log('userRoleAuthoring.test.ts passed')
