import assert from 'node:assert/strict'

import { parseRoleManifest, validateRoleManifest } from './role-manifest'

function testValidMinimal(): void {
  const result = validateRoleManifest({
    id: 'code_reviewer',
    label: 'Code reviewer',
    soul: [{ skill: 'code_reviewer' }, { skill: 'collaboration_norms' }],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.id, 'code_reviewer')
    assert.equal(result.manifest.summary, undefined)
    assert.deepEqual(result.manifest.soul, [{ skill: 'code_reviewer' }, { skill: 'collaboration_norms' }])
  }
}

function testValidFull(): void {
  const result = validateRoleManifest({
    id: 'auditor',
    label: 'Auditor',
    summary: 'Audits the change.',
    aliases: ['audit', 'sec-audit'],
    soul: [{ skill: 'auditor' }],
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.manifest.aliases, ['audit', 'sec-audit'])
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

function testParseInvalidJson(): void {
  const result = parseRoleManifest('{ not json')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.issues[0].path, '')
}

function testParseValid(): void {
  const result = parseRoleManifest('{"id":"role","label":"Role","soul":[{"skill":"x"}]}')
  assert.equal(result.ok, true)
}

testValidMinimal()
testValidFull()
testRejectsNonObject()
testRejectsBadId()
testRejectsEmptyLabel()
testRejectsEmptySoul()
testRejectsBadSoulEntry()
testRejectsBadAlias()
testParseInvalidJson()
testParseValid()
console.log('role-manifest tests passed')
