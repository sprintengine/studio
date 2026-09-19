import assert from 'node:assert/strict'

import type { DesignSystemLibraryEntry } from '../../../../shared/design-system/library'
import { compareBundleVersions, findLibraryUpdate, resolveBundleOrigin } from './designSystemSettingsModel'
import { test } from 'vitest'

test('designSystemSettingsModel', async () => {
  const tests: Array<{ name: string; body: () => void }> = []

  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  function entry(overrides: Partial<DesignSystemLibraryEntry>): DesignSystemLibraryEntry {
    return {
      id: 'abc12345',
      path: '/tmp/bundle',
      name: 'example',
      version: '1.0.0',
      summary: 'A bundle',
      releasedAt: null,
      sourceState: 'ok',
      addedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  run('origin reads the attach provenance stamps', () => {
    assert.equal(resolveBundleOrigin(undefined), 'authored')
    assert.equal(resolveBundleOrigin({}), 'authored')
    assert.equal(resolveBundleOrigin({ attachedAt: '2026-01-01T00:00:00.000Z' }), 'folder')
    assert.equal(
      resolveBundleOrigin({
        sourceLibraryId: 'example',
        sourceLibraryVersion: '1.0.0',
        attachedAt: '2026-01-01T00:00:00.000Z',
      }),
      'library',
    )
    // A scaffolded bundle may carry authoredBy without any attach stamp.
    assert.equal(resolveBundleOrigin({ authoredBy: 'someone' }), 'authored')
  })

  run('version order is numeric per segment, prerelease below its release', () => {
    assert.ok(compareBundleVersions('0.10.0', '0.9.0') > 0)
    assert.ok(compareBundleVersions('1.0.0', '0.99.99') > 0)
    assert.equal(compareBundleVersions('1.2.3', '1.2.3'), 0)
    assert.ok(compareBundleVersions('1.0.0-beta.1', '1.0.0') < 0)
    assert.ok(compareBundleVersions('1.0.0', '1.0.0-beta.1') > 0)
  })

  run('update offers the highest readable same-name entry above the attached version', () => {
    const attached = { name: 'example', version: '1.1.0' }
    const best = findLibraryUpdate(attached, [
      entry({ id: 'older', version: '1.0.0' }),
      entry({ id: 'same', version: '1.1.0' }),
      entry({ id: 'next', version: '1.2.0' }),
      entry({ id: 'best', version: '2.0.0' }),
      entry({ id: 'other-system', name: 'other', version: '9.9.9' }),
      entry({ id: 'broken', version: '3.0.0', sourceState: 'missing' }),
      entry({ id: 'unversioned', version: null }),
    ])
    assert.equal(best?.id, 'best')
  })

  run('update is null when nothing newer is registered', () => {
    const attached = { name: 'example', version: '2.0.0' }
    assert.equal(findLibraryUpdate(attached, []), null)
    assert.equal(findLibraryUpdate(attached, [entry({ version: '2.0.0' }), entry({ version: '1.9.0' })]), null)
  })

  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('designSystemSettingsModel.test.ts: ok')
})
