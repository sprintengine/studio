import assert from 'node:assert/strict'

import {
  KNOWN_CAPABILITY_PERMISSIONS,
  describeCapabilityPermission,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
  validateCapabilityPermissions,
} from './permissions'
import { test } from 'vitest'

test('permissions', async () => {
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
      assert.doesNotMatch(describeCapabilityPermission(tier), /Unrecognized/, `${tier} has a real consent description`)
    }
    const result = validateCapabilityPermissions(tiers)
    assert.equal(result.ok, true, 'tiered scopes validate')
    if (result.ok) assert.deepEqual(result.permissions, tiers)
  }

  function testBacklogScopesAreKnownAndDisclosureOnly(): void {
    const scopes = ['backlog.read', 'backlog.write', 'backlog.link.open']
    for (const scope of scopes) {
      assert.equal(isKnownCapabilityPermission(scope), true, `${scope} is a known scope`)
      assert.equal(isBroadCapabilityPermission(scope), false, `${scope} is not flagged broad`)
      assert.doesNotMatch(
        describeCapabilityPermission(scope),
        /Unrecognized/,
        `${scope} has a real consent description`,
      )
    }
    assert.match(describeCapabilityPermission('backlog.read'), /Read Backlog/)
    assert.match(describeCapabilityPermission('backlog.write'), /Change Backlog/)
    assert.match(describeCapabilityPermission('backlog.link.open'), /Open links/)
    const result = validateCapabilityPermissions(scopes)
    assert.equal(result.ok, true, 'backlog scopes validate')
    if (result.ok) assert.deepEqual(result.permissions, scopes)
  }

  function testLegacyBroadScopeRetainedAndFlagged(): void {
    assert.equal(isKnownCapabilityPermission('ipc:invoke'), true, 'ipc:invoke keeps validating')
    assert.equal(isBroadCapabilityPermission('ipc:invoke'), true, 'ipc:invoke is flagged broad')
    const description = describeCapabilityPermission('ipc:invoke')
    assert.match(description, /broad/i, 'description marks the scope as broad')
    // No longer marked "legacy": the scope also gates the renderer→module-main
    // bridge, so the consent copy discloses both meanings.
    assert.match(description, /its own background code/i, 'description discloses the bridge meaning')
    const legacyManifest = validateCapabilityPermissions(['ipc:invoke', 'network'])
    assert.equal(legacyManifest.ok, true, 'existing manifests using ipc:invoke keep validating')
  }

  function testDescriptionsNeverImplyEnforcement(): void {
    for (const permission of KNOWN_CAPABILITY_PERMISSIONS) {
      assert.doesNotMatch(
        describeCapabilityPermission(permission),
        /sandbox|enforce|prevent|restrict|block/i,
        `${permission} consent string stays disclosure-only`,
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
  testBacklogScopesAreKnownAndDisclosureOnly()
  testLegacyBroadScopeRetainedAndFlagged()
  testDescriptionsNeverImplyEnforcement()
  console.log('permissions tests passed')
})
