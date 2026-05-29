import assert from 'node:assert/strict'

import {
  describeCapabilityPermission,
  isKnownCapabilityPermission,
  validateCapabilityPermissions,
} from './permissions'

function testValidAndDedup(): void {
  const result = validateCapabilityPermissions(['network', 'network', 'process:spawn'])
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.permissions, ['network', 'process:spawn'])
}

function testUndefinedIsEmpty(): void {
  const result = validateCapabilityPermissions(undefined)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.permissions, [])
}

function testUnknownAllowedButFlagged(): void {
  const result = validateCapabilityPermissions(['totally-made-up'])
  assert.equal(result.ok, true, 'unknown scopes validate (forward-compatible)')
  assert.equal(isKnownCapabilityPermission('totally-made-up'), false)
  assert.match(describeCapabilityPermission('totally-made-up'), /Unrecognized/)
}

function testRejectsNonArray(): void {
  assert.equal(validateCapabilityPermissions('network').ok, false)
}

function testRejectsNonStringEntry(): void {
  const result = validateCapabilityPermissions(['network', 42])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.issues[0].path, 'permissions[1]')
}

function testKnownDescriptions(): void {
  assert.equal(isKnownCapabilityPermission('filesystem:read-workspace'), true)
  assert.match(describeCapabilityPermission('filesystem:read-workspace'), /Read files/)
}

testValidAndDedup()
testUndefinedIsEmpty()
testUnknownAllowedButFlagged()
testRejectsNonArray()
testRejectsNonStringEntry()
testKnownDescriptions()
console.log('permissions tests passed')
