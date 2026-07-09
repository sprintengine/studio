import assert from 'node:assert/strict'

import {
  buildAuthoredRoleManifest,
  parseRoleManifest,
  roleIdCollision,
  serializeRoleManifest,
  starterSoulTemplate,
  validateRoleManifest,
} from './role-manifest'

function testValidMinimal(): void {
  const result = validateRoleManifest({
    id: 'security',
    label: 'Security',
    directives: { implement: [{ skill: 'security' }, { skill: 'project_relative_paths' }] },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.id, 'security')
    assert.equal(result.manifest.summary, undefined)
    assert.equal(result.manifest.sweep, undefined)
    assert.deepEqual(result.manifest.directives, {
      implement: [{ skill: 'security' }, { skill: 'project_relative_paths' }],
    })
  }
}

function testValidFull(): void {
  const result = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    summary: 'Audits the change.',
    aliases: ['audit', 'sec-audit'],
    directives: { implement: [{ skill: 'auditor' }], review: [{ skill: 'auditor_review' }] },
    sweep: { focus: 'implementation and security', when: 'the run touches auth or user input' },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.manifest.aliases, ['audit', 'sec-audit'])
    assert.deepEqual(result.manifest.directives.review, [{ skill: 'auditor_review' }])
    assert.deepEqual(result.manifest.sweep, {
      focus: 'implementation and security',
      when: 'the run touches auth or user input',
    })
  }
}

function testNullSweepIsAWorkerRole(): void {
  const result = validateRoleManifest({
    id: 'builder',
    label: 'Builder',
    directives: { implement: [{ skill: 'builder' }] },
    sweep: null,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.manifest.sweep, undefined)
}

function testRejectsNonObject(): void {
  assert.equal(validateRoleManifest(null).ok, false)
  assert.equal(validateRoleManifest('role').ok, false)
  assert.equal(validateRoleManifest([]).ok, false)
}

function testRejectsBadId(): void {
  const result = validateRoleManifest({ id: 'Bad-Id', label: 'X', directives: { implement: [{ skill: 'x' }] } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'id'))
}

function testRejectsEmptyLabel(): void {
  const result = validateRoleManifest({ id: 'role', label: '   ', directives: { implement: [{ skill: 'x' }] } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'label'))
}

function testRejectsEmptyOrMissingImplement(): void {
  const empty = validateRoleManifest({ id: 'role', label: 'Role', directives: { implement: [] } })
  assert.equal(empty.ok, false)
  const missingDirectives = validateRoleManifest({ id: 'role', label: 'Role' })
  assert.equal(missingDirectives.ok, false)
  // A review-only pack is rejected: review-only roles are abolished at the schema level.
  const reviewOnly = validateRoleManifest({ id: 'role', label: 'Role', directives: { review: [{ skill: 'x' }] } })
  assert.equal(reviewOnly.ok, false)
  if (!reviewOnly.ok) assert.ok(reviewOnly.issues.some((issue) => issue.path === 'directives.implement'))
}

function testRejectsBadDirectiveEntry(): void {
  const result = validateRoleManifest({ id: 'role', label: 'Role', directives: { implement: [{ skill: 'Bad Skill' }] } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'directives.implement[0].skill'))
}

function testRejectsUnknownDirectiveKey(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    directives: { implement: [{ skill: 'x' }], testing: [{ skill: 'y' }] },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'directives.testing'))
}

function testRejectsBadAlias(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    aliases: ['OK', '..'],
    directives: { implement: [{ skill: 'x' }] },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path.startsWith('aliases[')))
}

function testRejectsBadSweep(): void {
  const missingWhen = validateRoleManifest({
    id: 'role',
    label: 'Role',
    directives: { implement: [{ skill: 'x' }] },
    sweep: { focus: 'things' },
  })
  assert.equal(missingWhen.ok, false)
  if (!missingWhen.ok) assert.ok(missingWhen.issues.some((issue) => issue.path === 'sweep.when'))

  const extraField = validateRoleManifest({
    id: 'role',
    label: 'Role',
    directives: { implement: [{ skill: 'x' }] },
    sweep: { focus: 'a', when: 'b', phase: 'review' },
  })
  assert.equal(extraField.ok, false)
  if (!extraField.ok) assert.ok(extraField.issues.some((issue) => issue.path === 'sweep.phase'))
}

// Decision 8: no v1 shim. A stale pack fails loudly with its v2 replacement named.
function testRejectsRemovedV1Keys(): void {
  const soul = validateRoleManifest({ id: 'role', label: 'Role', soul: [{ skill: 'x' }] })
  assert.equal(soul.ok, false)
  if (!soul.ok) {
    const issue = soul.issues.find((candidate) => candidate.path === 'soul')
    assert.ok(issue, 'soul must be rejected by name')
    assert.ok(issue.message.includes('directives'), 'the rejection must name the v2 replacement')
  }

  const capabilities = validateRoleManifest({
    id: 'role',
    label: 'Role',
    directives: { implement: [{ skill: 'x' }] },
    capabilities: [{ kind: 'review' }],
  })
  assert.equal(capabilities.ok, false)
  if (!capabilities.ok) {
    const issue = capabilities.issues.find((candidate) => candidate.path === 'capabilities')
    assert.ok(issue, 'capabilities must be rejected by name')
    assert.ok(issue.message.includes('sweep'), 'the rejection must name the v2 replacement')
  }
}

function testParseInvalidJson(): void {
  const result = parseRoleManifest('{ not json')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.issues[0].path, '')
}

function testParseValid(): void {
  const result = parseRoleManifest('{"id":"role","label":"Role","directives":{"implement":[{"skill":"x"}]}}')
  assert.equal(result.ok, true)
}

function testSerializeRoundTrip(): void {
  const built = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    summary: 'Audits the change.',
    aliases: ['audit'],
    directives: { implement: [{ skill: 'auditor' }] },
    sweep: { focus: 'security review', when: 'always' },
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  const serialized = serializeRoleManifest(built.manifest)
  assert.equal(serialized.endsWith('\n'), true)
  assert.equal(serialized, `${JSON.stringify(built.manifest, null, 2)}\n`)
  const reparsed = parseRoleManifest(serialized)
  assert.equal(reparsed.ok, true)
  if (reparsed.ok) assert.deepEqual(reparsed.manifest, built.manifest)
}

function testBuildAuthoredDirectivesAndOmission(): void {
  const minimal = buildAuthoredRoleManifest({ id: 'auditor', label: 'Auditor' })
  assert.deepEqual(minimal.directives, { implement: [{ skill: 'auditor' }] })
  assert.equal('summary' in minimal, false)
  assert.equal('aliases' in minimal, false)
  assert.equal('sweep' in minimal, false)
  // Blank/whitespace optionals are omitted rather than emitted empty.
  const blanks = buildAuthoredRoleManifest({ id: 'auditor', label: 'Auditor', summary: '  ', aliases: ['', '  '] })
  assert.equal('summary' in blanks, false)
  assert.equal('aliases' in blanks, false)
  // The minimal authored manifest validates through the single validator.
  assert.equal(validateRoleManifest(minimal).ok, true)
}

function testBuildAuthoredFull(): void {
  const full = buildAuthoredRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    summary: 'Audits the change.',
    aliases: ['audit'],
    sweep: { focus: 'security review', when: 'always' },
  })
  assert.deepEqual(full, {
    id: 'auditor',
    label: 'Auditor',
    directives: { implement: [{ skill: 'auditor' }] },
    summary: 'Audits the change.',
    aliases: ['audit'],
    sweep: { focus: 'security review', when: 'always' },
  })
}

// An author who enables the sweep toggle but leaves a field blank must see a
// validation error, not silently lose the sweep.
function testBuildAuthoredBlankSweepSurfacesAsValidationError(): void {
  const blank = buildAuthoredRoleManifest({ id: 'auditor', label: 'Auditor', sweep: { focus: '  ', when: '' } })
  assert.deepEqual(blank.sweep, { focus: '', when: '' })
  const result = validateRoleManifest(blank)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.path === 'sweep.focus'))
    assert.ok(result.issues.some((issue) => issue.path === 'sweep.when'))
  }
}

function testRoleIdCollision(): void {
  const existing = ['developer', 'architect', 'sec-audit']
  assert.equal(roleIdCollision('developer', existing), true)
  assert.equal(roleIdCollision('sec-audit', existing), true)
  assert.equal(roleIdCollision('auditor', existing), false)
  assert.equal(roleIdCollision('developer', new Set(existing)), true)
  assert.equal(roleIdCollision('developer', []), false)
}

function testStarterSoulTemplate(): void {
  const template = starterSoulTemplate('Security Auditor')
  assert.ok(template.length > 0)
  assert.ok(template.includes('<what-to-do>'))
  assert.ok(template.includes('</what-to-do>'))
  assert.ok(template.includes('<supporting-info>'))
  assert.ok(template.includes('</supporting-info>'))
  assert.ok(template.includes('Security Auditor'))
}

testValidMinimal()
testValidFull()
testNullSweepIsAWorkerRole()
testRejectsNonObject()
testRejectsBadId()
testRejectsEmptyLabel()
testRejectsEmptyOrMissingImplement()
testRejectsBadDirectiveEntry()
testRejectsUnknownDirectiveKey()
testRejectsBadAlias()
testRejectsBadSweep()
testRejectsRemovedV1Keys()
testParseInvalidJson()
testParseValid()
testSerializeRoundTrip()
testBuildAuthoredDirectivesAndOmission()
testBuildAuthoredFull()
testBuildAuthoredBlankSweepSurfacesAsValidationError()
testRoleIdCollision()
testStarterSoulTemplate()
console.log('role-manifest tests passed')
