import assert from 'node:assert/strict'

import {
  KNOWN_CAPABILITY_PERMISSIONS,
  capabilityAccess,
  describeCapabilityPermission,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
  partitionCapabilityAccess,
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
    const tiers = ['ipc:workspace-read', 'ipc:workspace-write', 'ipc:settings']
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

  function testModuleBridgeScopeIsNarrowAndDescribed(): void {
    assert.equal(isKnownCapabilityPermission('module:bridge'), true, 'module:bridge is a known scope')
    assert.equal(isBroadCapabilityPermission('module:bridge'), false, 'module:bridge is not flagged broad')
    const description = describeCapabilityPermission('module:bridge')
    assert.equal(description, 'Let its window code talk to its own background code')
    assert.doesNotMatch(description, /internal APIs|broad/i, 'the bridge scope does not read as the broad one')
    const result = validateCapabilityPermissions(['module:bridge', 'storage'])
    assert.equal(result.ok, true, 'module:bridge validates')
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

  function testExtensionPlatformScopesAreKnownAndDescribed(): void {
    const scopes = [
      'conversation:read',
      'conversation:operate',
      'conversation:bypass',
      'secrets',
      'github',
      'mcp:tools',
    ]
    for (const scope of scopes) {
      assert.equal(isKnownCapabilityPermission(scope), true, `${scope} is a known scope`)
      assert.equal(isBroadCapabilityPermission(scope), false, `${scope} is not flagged broad`)
      assert.doesNotMatch(
        describeCapabilityPermission(scope),
        /Unrecognized/,
        `${scope} has a real consent description`,
      )
    }
    assert.match(
      describeCapabilityPermission('github'),
      /never shown/,
      'the GitHub copy says the token stays with the app',
    )
    assert.match(
      describeCapabilityPermission('secrets'),
      /never shown/,
      'the secrets copy says the key stays with the app',
    )
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
  testModuleBridgeScopeIsNarrowAndDescribed()
  testDescriptionsNeverImplyEnforcement()
  testExtensionPlatformScopesAreKnownAndDescribed()
  console.log('permissions tests passed')
})

test('usage:read and conversation:read-all are known, described, and read-all is flagged broad', () => {
  for (const scope of ['usage:read', 'conversation:read-all']) {
    assert.equal(isKnownCapabilityPermission(scope), true, `${scope} is a known scope`)
    assert.equal(validateCapabilityPermissions([scope]).ok, true)
  }
  assert.equal(
    describeCapabilityPermission('usage:read'),
    'See token usage and cost of every agent session on this machine',
  )
  assert.match(
    describeCapabilityPermission('conversation:read-all'),
    /^Read every chat on this machine, including what you and the agents wrote/,
  )
  // Reading every chat is broad the way `ipc:invoke` is; usage counts are not.
  assert.equal(isBroadCapabilityPermission('conversation:read-all'), true)
  assert.equal(isBroadCapabilityPermission('usage:read'), false)
  assert.equal(isBroadCapabilityPermission('conversation:read'), false)
})

// The at-a-glance table Settings → Extensions draws its warning glyphs from.
// One row per known scope, so a scope added to the vocabulary without a short
// title fails here rather than reaching a row as "Unrecognized".
const NEEDS_CARE = [
  'filesystem:read-home',
  'filesystem:write-workspace',
  'process:spawn',
  'network',
  'ipc:invoke',
  'ipc:settings',
  'conversation:operate',
  'conversation:bypass',
  'conversation:read-all',
  'github',
  'secrets',
  'usage:read',
]

test('every known scope has a short title, and exactly the sensitive ones need care', () => {
  for (const permission of KNOWN_CAPABILITY_PERMISSIONS) {
    const access = capabilityAccess(permission)
    assert.doesNotMatch(access.title, /Unrecognized/, `${permission} has a title of its own`)
    assert.ok(access.title.split(' ').length <= 6, `${permission}: "${access.title}" stays short`)
    assert.equal(access.care, NEEDS_CARE.includes(permission), `${permission} care flag`)
    if (access.care) {
      assert.ok(access.why, `${permission} says why it needs care`)
      assert.ok(access.why!.split(/\s+/).length <= 6, `${permission}: "${access.why}" is six words or fewer`)
    } else {
      assert.equal(access.why, undefined, `${permission} is standard and carries no why`)
    }
    assert.doesNotMatch(
      `${access.title} ${access.why ?? ''}`,
      /sandbox|enforce|prevent|restrict|block/i,
      `${permission} short copy stays disclosure-only`,
    )
    assert.doesNotMatch(access.title, /…$/, 'no trailing ellipsis')
  }
})

test('the owner-approved titles read as written', () => {
  assert.equal(capabilityAccess('filesystem:read-home').title, 'Reads your home folder')
  assert.equal(capabilityAccess('filesystem:write-workspace').title, 'Edits files in your projects')
  assert.equal(capabilityAccess('ipc:invoke').title, 'Broad access to Studio')
  assert.equal(capabilityAccess('conversation:operate').title, 'Runs chats with your agents')
  assert.equal(capabilityAccess('conversation:bypass').title, 'Lets agents act without asking')
  assert.equal(capabilityAccess('github').title, 'Uses your GitHub sign-in')
})

test('an unrecognized scope always needs care and names itself', () => {
  const access = capabilityAccess('totally-made-up')
  assert.equal(access.care, true)
  assert.match(access.title, /totally-made-up/)
  assert.ok(access.why)
})

test('partitioning keeps declared order within each group', () => {
  assert.deepEqual(partitionCapabilityAccess(['storage', 'github', 'mystery:scope', 'backlog.read', 'network']), {
    care: ['github', 'mystery:scope', 'network'],
    standard: ['storage', 'backlog.read'],
  })
  assert.deepEqual(partitionCapabilityAccess([]), { care: [], standard: [] })
})
