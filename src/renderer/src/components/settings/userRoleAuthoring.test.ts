import assert from 'node:assert/strict'

import {
  authoringFieldErrors,
  authoringStatusReducer,
  createRoleAuthoringDraft,
  editRoleAuthoringDraft,
  emptyCapabilityDraft,
  idleAuthoringStatus,
  isAuthoringBusy,
  mapIssuesToFieldErrors,
  parseAliasesText,
  toUserRoleSaveInput,
  validateRoleAuthoringDraft,
  type RoleAuthoringDraft,
  type RoleAuthoringStatus,
} from './userRoleAuthoring'

function validDraft(overrides: Partial<RoleAuthoringDraft> = {}): RoleAuthoringDraft {
  return {
    id: 'auditor',
    label: 'Auditor',
    summary: '',
    aliasesText: '',
    capability: emptyCapabilityDraft(),
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
  assert.equal(draft.capability.enabled, false)
  // Seeded with the starter soul template, not a blank textarea.
  assert.ok(draft.body.includes('<what-to-do>'))
  assert.ok(draft.body.includes('<supporting-info>'))
}

function testEditDraftPrefillsAndLocksId(): void {
  const draft = editRoleAuthoringDraft(
    {
      id: 'code_auditor',
      label: 'Code auditor',
      summary: 'Audits diffs.',
      aliases: ['auditor', 'reviewer_x'],
      soul: [{ skill: 'code_auditor' }],
      capabilities: [{ kind: 'review', phase: 'testing', defaultFocus: 'regressions' }],
    },
    'Soul body here.',
  )
  assert.equal(draft.id, 'code_auditor')
  assert.equal(draft.label, 'Code auditor')
  assert.equal(draft.summary, 'Audits diffs.')
  assert.equal(draft.aliasesText, 'auditor, reviewer_x')
  assert.equal(draft.capability.enabled, true)
  assert.equal(draft.capability.phase, 'testing')
  assert.equal(draft.capability.defaultFocus, 'regressions')
  assert.equal(draft.body, 'Soul body here.')
}

// --- aliases parsing -----------------------------------------------------

function testParseAliases(): void {
  assert.deepEqual(parseAliasesText('a, b   c,,d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseAliasesText('   '), [])
}

// --- save input assembly -------------------------------------------------

function testSaveInputOmitsEmptyOptionals(): void {
  const input = toUserRoleSaveInput(validDraft())
  assert.deepEqual(input, { id: 'auditor', label: 'Auditor', body: 'You audit the change.' })
  assert.equal('summary' in input, false)
  assert.equal('aliases' in input, false)
  assert.equal('capability' in input, false)
}

// --- capability disclosure ----------------------------------------------

function testCapabilityDisclosureOffEmitsNoCapability(): void {
  const result = validateRoleAuthoringDraft(
    validDraft({ capability: { enabled: false, phase: 'product', defaultFocus: 'x' } }),
    { mode: createMode, existingIdsAndAliases: noExisting },
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal('capability' in result.input, false)
}

function testCapabilityDisclosureOnEmitsCapability(): void {
  const result = validateRoleAuthoringDraft(
    validDraft({ capability: { enabled: true, phase: 'review', defaultFocus: '  edge cases  ' } }),
    { mode: createMode, existingIdsAndAliases: noExisting },
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.input.capability, { phase: 'review', defaultFocus: 'edge cases' })
  }
}

function testCapabilityFocusOptionalWhenEnabled(): void {
  const input = toUserRoleSaveInput(
    validDraft({ capability: { enabled: true, phase: 'testing', defaultFocus: '   ' } }),
  )
  assert.deepEqual(input.capability, { phase: 'testing' })
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

function testBadAliasMapsToAliasesField(): void {
  const result = validateRoleAuthoringDraft(validDraft({ aliasesText: 'Bad Alias!' }), {
    mode: createMode,
    existingIdsAndAliases: noExisting,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.errors.aliases)
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
    existingIdsAndAliases: ['code_reviewer', 'reviewer'],
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
    { path: 'aliases[0]', message: 'bad alias' },
    { path: 'capabilities[0].phase', message: 'bad phase' },
    { path: 'mystery', message: 'unhomed' },
  ])
  assert.equal(errors.id, 'first id')
  assert.equal(errors.aliases, 'bad alias')
  assert.equal(errors.capability, 'bad phase')
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
testParseAliases()
testSaveInputOmitsEmptyOptionals()
testCapabilityDisclosureOffEmitsNoCapability()
testCapabilityDisclosureOnEmitsCapability()
testCapabilityFocusOptionalWhenEnabled()
testValidDraftPasses()
testInvalidIdMapsToIdField()
testEmptyLabelMapsToLabelField()
testBadAliasMapsToAliasesField()
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
