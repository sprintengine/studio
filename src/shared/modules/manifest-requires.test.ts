import assert from 'node:assert/strict'
import { test } from 'vitest'

import { validateThirdPartyModuleManifest } from './third-party-manifest'

// `requires.hostCapabilities`: what a module's main half cannot run without
// (phase 6 spec, 12.4). Additive and optional: a manifest without it is as
// valid as before, and the host API version does not move.

const VALID = { id: 'acme-panel', displayName: 'Acme panel', version: 1, engines: { hostApi: 1 } }

test('a module may say its main half needs electron-main, and the host keeps it', () => {
  const result = validateThirdPartyModuleManifest({ ...VALID, requires: { hostCapabilities: ['electron-main'] } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.manifest.requires, { hostCapabilities: ['electron-main'] })
})

test('a manifest without it is unchanged, and an empty list says nothing', () => {
  const plain = validateThirdPartyModuleManifest(VALID)
  assert.equal(plain.ok && plain.manifest.requires, undefined)
  const empty = validateThirdPartyModuleManifest({ ...VALID, requires: { hostCapabilities: [] } })
  assert.equal(empty.ok && empty.manifest.requires, undefined)
})

test('a malformed requires is refused with its path', () => {
  for (const requires of ['electron-main', { hostCapabilities: 'electron-main' }, { platforms: ['darwin'] }]) {
    const result = validateThirdPartyModuleManifest({ ...VALID, requires })
    assert.equal(result.ok, false, JSON.stringify(requires))
    assert.match(JSON.stringify(!result.ok && result.issues), /requires/)
  }
})
