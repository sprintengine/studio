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
    id: 'code_reviewer',
    label: 'Code reviewer',
    soul: [{ skill: 'code_reviewer' }, { skill: 'project_relative_paths' }],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.id, 'code_reviewer')
    assert.equal(result.manifest.summary, undefined)
    assert.deepEqual(result.manifest.soul, [{ skill: 'code_reviewer' }, { skill: 'project_relative_paths' }])
  }
}

function testValidFull(): void {
  const result = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    summary: 'Audits the change.',
    aliases: ['audit', 'sec-audit'],
    capabilities: [
      {
        kind: 'review',
        phase: 'review',
        reviews: ['implementation', 'security'],
        defaultFocus: 'Implementation and security review.',
      },
    ],
    soul: [{ skill: 'auditor' }],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.manifest.aliases, ['audit', 'sec-audit'])
    assert.deepEqual(result.manifest.capabilities, [
      {
        kind: 'review',
        phase: 'review',
        reviews: ['implementation', 'security'],
        defaultFocus: 'Implementation and security review.',
      },
    ])
  }
}

function testRejectsNonObject(): void {
  assert.equal(validateRoleManifest(null).ok, false)
  assert.equal(validateRoleManifest('role').ok, false)
  assert.equal(validateRoleManifest([]).ok, false)
}

function testRejectsBadId(): void {
  const result = validateRoleManifest({ id: 'Bad-Id', label: 'X', soul: [{ skill: 'x' }] })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'id'))
}

function testRejectsEmptyLabel(): void {
  const result = validateRoleManifest({ id: 'role', label: '   ', soul: [{ skill: 'x' }] })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'label'))
}

function testRejectsEmptySoul(): void {
  const empty = validateRoleManifest({ id: 'role', label: 'Role', soul: [] })
  assert.equal(empty.ok, false)
  const missing = validateRoleManifest({ id: 'role', label: 'Role' })
  assert.equal(missing.ok, false)
}

function testRejectsBadSoulEntry(): void {
  const result = validateRoleManifest({ id: 'role', label: 'Role', soul: [{ skill: 'Bad Skill' }] })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'soul[0].skill'))
}

function testRejectsBadAlias(): void {
  const result = validateRoleManifest({ id: 'role', label: 'Role', aliases: ['OK', '..'], soul: [{ skill: 'x' }] })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path.startsWith('aliases[')))
}

function testRejectsBadCapability(): void {
  const result = validateRoleManifest({
    id: 'role',
    label: 'Role',
    capabilities: [{ kind: 'review', required: true }],
    soul: [{ skill: 'x' }],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === 'capabilities[0].required'))
}

function testParseInvalidJson(): void {
  const result = parseRoleManifest('{ not json')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.issues[0].path, '')
}

function testParseValid(): void {
  const result = parseRoleManifest('{"id":"role","label":"Role","soul":[{"skill":"x"}]}')
  assert.equal(result.ok, true)
}

function testSerializeRoundTrip(): void {
  const built = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    summary: 'Audits the change.',
    aliases: ['audit'],
    capabilities: [{ kind: 'review', phase: 'review', defaultFocus: 'Security review.' }],
    soul: [{ skill: 'auditor' }],
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

function testBuildAuthoredSoulAndOmission(): void {
  const minimal = buildAuthoredRoleManifest({ id: 'auditor', label: 'Auditor' })
  assert.deepEqual(minimal.soul, [{ skill: 'auditor' }])
  assert.equal('summary' in minimal, false)
  assert.equal('aliases' in minimal, false)
  assert.equal('capabilities' in minimal, false)
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
    capability: { phase: 'review', defaultFocus: 'Security review.' },
  })
  assert.deepEqual(full, {
    id: 'auditor',
    label: 'Auditor',
    soul: [{ skill: 'auditor' }],
    summary: 'Audits the change.',
    aliases: ['audit'],
    capabilities: [{ kind: 'review', phase: 'review', defaultFocus: 'Security review.' }],
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
testRejectsNonObject()
testRejectsBadId()
testRejectsEmptyLabel()
testRejectsEmptySoul()
testRejectsBadSoulEntry()
testRejectsBadAlias()
testRejectsBadCapability()
testParseInvalidJson()
testParseValid()
testSerializeRoundTrip()
testBuildAuthoredSoulAndOmission()
testBuildAuthoredFull()
testRoleIdCollision()
testStarterSoulTemplate()
console.log('role-manifest tests passed')
