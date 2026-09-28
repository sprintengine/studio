import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshStore, LEGACY_TAILNET_MESH_FILENAME, TAILNET_MESH_FILENAME } from './tailnet-mesh-store'

const stored = {
  id: 'tnc_1',
  machineName: 'Studio',
  endpoint: '100.64.0.2:8443',
  deviceId: 'dev_1',
  deviceName: 'laptop',
  deviceToken: 'secret',
  scopes: ['workspace:read'],
  pairedAt: '2026-09-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

test('pairings stored under the legacy file name are moved to the current one and kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-store-'))
  try {
    writeFileSync(join(dir, LEGACY_TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }), {
      mode: 0o600,
    })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir })
    assert.deepEqual(
      store.list().map((connection) => connection.id),
      ['tnc_1'],
      'the pairing survives the rename',
    )
    assert.equal(store.find('tnc_1')?.deviceToken, 'secret')
    assert.equal(existsSync(join(dir, LEGACY_TAILNET_MESH_FILENAME)), false, 'no second copy of the tokens')
    const current = join(dir, TAILNET_MESH_FILENAME)
    assert.equal(JSON.parse(readFileSync(current, 'utf8')).connections[0].id, 'tnc_1')
    if (process.platform !== 'win32') assert.equal(statSync(current).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a current file wins over a leftover legacy one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-store-'))
  try {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [] }))
    writeFileSync(join(dir, LEGACY_TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }))
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir })
    assert.deepEqual(store.list(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
