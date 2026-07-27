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
    description: 'Reviews auth, secrets, and input handling. Staff it when the run touches a trust boundary.',
    directives: { implement: [{ skill: 'security' }, { skill: 'project_relative_paths' }] },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.id, 'security')
    assert.equal(
      result.manifest.description,
      'Reviews auth, secrets, and input handling. Staff it when the run touches a trust boundary.',
    )
    assert.deepEqual(result.manifest.directives, {
      implement: [{ skill: 'security' }, { skill: 'project_relative_paths' }],
    })
  }
}

function testValidFull(): void {
  const result = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits the change. Staff it before a release.',
    aliases: ['audit', 'sec-audit'],
    directives: { implement: [{ skill: 'auditor' }], review: [{ skill: 'auditor_review' }] },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.manifest.aliases, ['audit', 'sec-audit'])
    assert.deepEqual(result.manifest.directives.review, [{ skill: 'auditor_review' }])
  }
}

// MC-1886 removed the sweep concept. Unlike the v1 keys below, `sweep` is NOT
// rejected by name — an installed pack predating the removal must keep loading
// (the engine's role_registry.py ignores it the same way), and the parsed
// manifest simply carries no trace of it.
function testLegacySweepKeyIsIgnored(): void {
  const result = validateRoleManifest({
    id: 'builder',
    label: 'Builder',
    description: 'Builds things. Staff it when something must be built.',
    directives: { implement: [{ skill: 'builder' }] },
    sweep: { focus: 'security review', when: 'always' },
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal('sweep' in result.manifest, false)
}

function testRejectsNonObject(): void {
  assert.equal(validateRoleManifest(null).ok, false)
  assert.equal(validateRoleManifest('role').ok, false)
  assert.equal(validateRoleManifest([]).ok, false)
}

function testRejectsBadId(): void {
  const result = validateRoleManifest({ id: 'Bad-Id', label: 'X', description: 'X. Staff it for X.', directives: { implement: [{ skill: 'x' }] } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'id'))
}

function testRejectsEmptyLabel(): void {
  const result = validateRoleManifest({ id: 'role', label: '   ', description: 'X. Staff it for X.', directives: { implement: [{ skill: 'x' }] } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'label'))
}

function testRejectsEmptyOrMissingImplement(): void {
  const empty = validateRoleManifest({ id: 'role', label: 'Role', description: 'Role. Staff it for role work.', directives: { implement: [] } })
  assert.equal(empty.ok, false)
  const missingDirectives = validateRoleManifest({ id: 'role', label: 'Role', description: 'Role. Staff it for role work.' })
  assert.equal(missingDirectives.ok, false)
  // A review-only pack is rejected: review-only roles are abolished at the schema level.
  const reviewOnly = validateRoleManifest({ id: 'role', label: 'Role', description: 'Role. Staff it for role work.', directives: { review: [{ skill: 'x' }] } })
  assert.equal(reviewOnly.ok, false)
  if (!reviewOnly.ok) assert.ok(reviewOnly.issues.some((issue) => issue.path === 'directives.implement'))
}

function testRejectsBadDirectiveEntry(): void {
  const result = validateRoleManifest({ id: 'role', label: 'Role', description: 'Role. Staff it for role work.', directives: { implement: [{ skill: 'Bad Skill' }] } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'directives.implement[0].skill'))
}

function testRejectsUnknownDirectiveKey(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    description: 'Role. Staff it for role work.',
    directives: { implement: [{ skill: 'x' }], testing: [{ skill: 'y' }] },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'directives.testing'))
}

function testRejectsBadAlias(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    description: 'Role. Staff it for role work.',
    aliases: ['OK', '..'],
    directives: { implement: [{ skill: 'x' }] },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path.startsWith('aliases[')))
}

// Decision 8: no v1 shim. A stale pack fails loudly with its v2 replacement named.
function testRejectsRemovedV1Keys(): void {
  const soul = validateRoleManifest({ id: 'role', label: 'Role', description: 'Role. Staff it for role work.', soul: [{ skill: 'x' }] })
  assert.equal(soul.ok, false)
  if (!soul.ok) {
    const issue = soul.issues.find((candidate) => candidate.path === 'soul')
    assert.ok(issue, 'soul must be rejected by name')
    assert.ok(issue.message.includes('directives'), 'the rejection must name the v2 replacement')
  }

  const capabilities = validateRoleManifest({
    id: 'role',
    label: 'Role',
    description: 'Role. Staff it for role work.',
    directives: { implement: [{ skill: 'x' }] },
    capabilities: [{ kind: 'review' }],
  })
  assert.equal(capabilities.ok, false)
  if (!capabilities.ok) {
    const issue = capabilities.issues.find((candidate) => candidate.path === 'capabilities')
    assert.ok(issue, 'capabilities must be rejected by name')
    assert.ok(issue.message.includes('directives'), 'the rejection must name the v2 replacement')
  }
}

// MC-1831 renamed `summary` to `description`. Unlike the v1 keys above, a pack
// predating the rename must keep loading — its roles are how runs are staffed —
// so the old key is dropped, not rejected (the engine warns about it), and a
// manifest with no description at all is still valid.
function testLegacySummaryKeyIsDroppedNotRejected(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    summary: 'Does role things.',
    directives: { implement: [{ skill: 'x' }] },
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal('summary' in result.manifest, false)
    assert.equal(result.manifest.description, undefined)
  }
}

// Present but empty is an authoring mistake, not a legacy manifest.
function testRejectsEmptyDescription(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    description: '   ',
    directives: { implement: [{ skill: 'x' }] },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'description'))
}

function testParseInvalidJson(): void {
  const result = parseRoleManifest('{ not json')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.issues[0].path, '')
}

function testParseValid(): void {
  const result = parseRoleManifest(
    '{"id":"role","label":"Role","description":"Role. Staff it for role work.","directives":{"implement":[{"skill":"x"}]}}',
  )
  assert.equal(result.ok, true)
}

function testSerializeRoundTrip(): void {
  const built = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits the change. Staff it before a release.',
    aliases: ['audit'],
    directives: { implement: [{ skill: 'auditor' }] },
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
  const minimal = buildAuthoredRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits the change. Staff it before a release.',
  })
  assert.equal(minimal.description, 'Audits the change. Staff it before a release.')
  assert.deepEqual(minimal.directives, { implement: [{ skill: 'auditor' }] })
  assert.equal('aliases' in minimal, false)
  // Blank/whitespace optionals are omitted rather than emitted empty.
  const blanks = buildAuthoredRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits the change. Staff it before a release.',
    aliases: ['', '  '],
  })
  assert.equal('aliases' in blanks, false)
  // The minimal authored manifest validates through the single validator.
  assert.equal(validateRoleManifest(minimal).ok, true)
}

function testBuildAuthoredFull(): void {
  const full = buildAuthoredRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    description: '  Audits the change. Staff it before a release.  ',
    aliases: ['audit'],
  })
  assert.deepEqual(full, {
    id: 'auditor',
    label: 'Auditor',
    description: 'Audits the change. Staff it before a release.',
    directives: { implement: [{ skill: 'auditor' }] },
    aliases: ['audit'],
  })
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
testLegacySweepKeyIsIgnored()
testRejectsNonObject()
testRejectsBadId()
testRejectsEmptyLabel()
testRejectsEmptyOrMissingImplement()
testRejectsBadDirectiveEntry()
testRejectsUnknownDirectiveKey()
testRejectsBadAlias()
testRejectsRemovedV1Keys()
testLegacySummaryKeyIsDroppedNotRejected()
testRejectsEmptyDescription()
testParseInvalidJson()
testParseValid()
testSerializeRoundTrip()
testBuildAuthoredDirectivesAndOmission()
testBuildAuthoredFull()
testRoleIdCollision()
testStarterSoulTemplate()
console.log('role-manifest tests passed')
