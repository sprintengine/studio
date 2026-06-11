import assert from 'node:assert/strict'

import {
  KNOWN_CAPABILITY_PERMISSIONS,
  describeCapabilityPermission,
  isBroadCapabilityPermission,
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

function testTieredIpcScopesAreKnownAndDescribed(): void {
  const tiers = ['ipc:workspace-read', 'ipc:workspace-write', 'ipc:agents', 'ipc:settings']
  for (const tier of tiers) {
    assert.equal(isKnownCapabilityPermission(tier), true, `${tier} is a known scope`)
    assert.equal(isBroadCapabilityPermission(tier), false, `${tier} is not flagged broad`)
    assert.doesNotMatch(
      describeCapabilityPermission(tier),
      /Unrecognized/,
      `${tier} has a real consent description`
    )
  }
  const result = validateCapabilityPermissions(tiers)
  assert.equal(result.ok, true, 'tiered scopes validate')
  if (result.ok) assert.deepEqual(result.permissions, tiers)
}

function testLegacyBroadScopeRetainedAndFlagged(): void {
  assert.equal(isKnownCapabilityPermission('ipc:invoke'), true, 'ipc:invoke keeps validating')
  assert.equal(isBroadCapabilityPermission('ipc:invoke'), true, 'ipc:invoke is flagged broad')
  const description = describeCapabilityPermission('ipc:invoke')
  assert.match(description, /broad/i, 'description marks the scope as broad')
  assert.match(description, /legacy/i, 'description marks the scope as legacy')
  const legacyManifest = validateCapabilityPermissions(['ipc:invoke', 'network'])
  assert.equal(legacyManifest.ok, true, 'existing manifests using ipc:invoke keep validating')
}

function testDescriptionsNeverImplyEnforcement(): void {
  for (const permission of KNOWN_CAPABILITY_PERMISSIONS) {
    assert.doesNotMatch(
      describeCapabilityPermission(permission),
      /sandbox|enforce|prevent|restrict|block/i,
      `${permission} consent string stays disclosure-only`
    )
  }
}

testValidAndDedup()
testUndefinedIsEmpty()
testUnknownAllowedButFlagged()
testRejectsNonArray()
testRejectsNonStringEntry()
testKnownDescriptions()
testTieredIpcScopesAreKnownAndDescribed()
testLegacyBroadScopeRetainedAndFlagged()
testDescriptionsNeverImplyEnforcement()
console.log('permissions tests passed')
