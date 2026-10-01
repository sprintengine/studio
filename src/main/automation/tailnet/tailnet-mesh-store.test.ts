import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createSafeStorageStandIn as cipher } from '../../../../tests/stubs/safe-storage'
import { createTailnetMeshStore, LEGACY_TAILNET_MESH_FILENAME, TAILNET_MESH_FILENAME } from './tailnet-mesh-store'

const stored = {
  id: 'tnc_1',
  machineName: 'mac-mini',
  endpoint: '100.64.0.2:8443',
  deviceId: 'dev_1',
  deviceName: 'dev-macbook-air',
  deviceToken: 'mctn_plaintext-secret',
  scopes: ['workspace:read'],
  pairedAt: '2026-09-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-store-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readFile(dir: string): { raw: string; parsed: { version: number; connections: Record<string, unknown>[] } } {
  const raw = readFileSync(join(dir, TAILNET_MESH_FILENAME), 'utf8')
  return { raw, parsed: JSON.parse(raw) }
}

const input = {
  machineName: 'build-box',
  endpoint: '100.64.0.9:8443',
  deviceId: 'dev_9',
  deviceName: 'mac-mini',
  deviceToken: 'mctn_fresh-secret',
  scopes: ['workspace:read' as const],
  pairedVia: 'link' as const,
}

test('pairings stored under the legacy file name are moved to the current one and kept', () => {
  withDir((dir) => {
    writeFileSync(join(dir, LEGACY_TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }), {
      mode: 0o600,
    })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    assert.deepEqual(
      store.list().map((connection) => connection.id),
      ['tnc_1'],
      'the pairing survives the rename',
    )
    assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret')
    assert.equal(existsSync(join(dir, LEGACY_TAILNET_MESH_FILENAME)), false, 'no second copy of the tokens')
    const current = join(dir, TAILNET_MESH_FILENAME)
    assert.equal(readFile(dir).parsed.connections[0].id, 'tnc_1')
    if (process.platform !== 'win32') assert.equal(statSync(current).mode & 0o777, 0o600)
  })
})

test('a current file wins over a leftover legacy one', () => {
  withDir((dir) => {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 2, connections: [] }))
    writeFileSync(join(dir, LEGACY_TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }))
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    assert.deepEqual(store.list(), [])
  })
})

test('a token is sealed on disk and opened again by the next launch', () => {
  withDir((dir) => {
    const first = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    const added = first.add(input)

    const { raw, parsed } = readFile(dir)
    assert.equal(parsed.version, 2)
    assert.doesNotMatch(raw, /mctn_fresh-secret/u, 'the token is never written as plaintext')
    assert.equal('deviceToken' in parsed.connections[0], false)
    assert.equal(typeof parsed.connections[0].sealedToken, 'string')
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, TAILNET_MESH_FILENAME)).mode & 0o777, 0o600)
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      'the atomic write leaves no temporary behind',
    )

    const second = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    assert.equal(second.find(added.id)?.deviceToken, 'mctn_fresh-secret')
    assert.deepEqual(second.list(), first.list())
  })
})

test('the public view never carries a token or its ciphertext', () => {
  withDir((dir) => {
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    store.add(input)
    for (const connection of store.list()) {
      assert.equal('deviceToken' in connection, false)
      assert.equal('sealedToken' in connection, false)
    }
  })
})

test('a rewrite reuses the sealed token instead of asking the keychain again', () => {
  withDir((dir) => {
    const keychain = cipher()
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: keychain })
    const added = store.add(input)
    const sealed = readFile(dir).parsed.connections[0].sealedToken
    store.markConnected(added.id)
    store.updateScopes(added.id, ['workspace:read', 'conversation:read'])
    assert.equal(keychain.encryptions, 1)
    assert.equal(readFile(dir).parsed.connections[0].sealedToken, sealed)
  })
})

test('a plaintext file is rewritten sealed on its first read', () => {
  withDir((dir) => {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }), {
      mode: 0o600,
    })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret', 'the pairing still works')

    const { raw, parsed } = readFile(dir)
    assert.equal(parsed.version, 2)
    assert.doesNotMatch(raw, /mctn_plaintext-secret/u, 'no plaintext is left behind after the first read')
    assert.equal(parsed.connections[0].id, 'tnc_1')
    assert.equal(parsed.connections[0].machineName, 'mac-mini')

    const next = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher() })
    assert.equal(next.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret', 'and the next launch opens it')
  })
})

test('without encryption a new pairing lives in memory only', () => {
  withDir((dir) => {
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher({ value: false }) })
    const added = store.add(input)
    assert.equal(store.find(added.id)?.deviceToken, 'mctn_fresh-secret', 'usable for this session')

    const { raw, parsed } = readFile(dir)
    assert.doesNotMatch(raw, /mctn_fresh-secret/u)
    assert.deepEqual(parsed.connections, [], 'nothing about it reaches the disk')

    const next = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher({ value: false }) })
    assert.deepEqual(next.list(), [], 'and it does not survive a restart')
  })
})

test('outside Electron the store falls back to memory only rather than plaintext', () => {
  withDir((dir) => {
    // No `safeStorage` option: the lazy load finds no Electron in a test run.
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir })
    store.add(input)
    assert.doesNotMatch(readFile(dir).raw, /mctn_fresh-secret/u)
  })
})

test('without encryption a plaintext file loses its tokens from disk but keeps them for the session', () => {
  withDir((dir) => {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }))
    const logged: string[] = []
    const store = createTailnetMeshStore({
      resolveUserDataDir: () => dir,
      safeStorage: cipher({ value: false }),
      log: (line) => logged.push(line),
    })
    assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret')
    assert.doesNotMatch(readFile(dir).raw, /mctn_plaintext-secret/u)
    assert.ok(
      logged.some((line) => /pair those machines again/u.test(line)),
      'the log says why the pairing will not survive',
    )
  })
})

test('a sealed record this launch cannot open is kept for a later one', () => {
  withDir((dir) => {
    const available = { value: true }
    const first = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher(available) })
    const kept = first.add(input)

    // The keychain is unavailable for one launch, which still makes a change.
    available.value = false
    const locked = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher(available) })
    assert.deepEqual(locked.list(), [], 'what cannot be opened is not offered')
    locked.add({ ...input, deviceId: 'dev_10', deviceToken: 'mctn_session-only' })
    assert.doesNotMatch(readFile(dir).raw, /mctn_session-only/u)

    available.value = true
    const later = createTailnetMeshStore({ resolveUserDataDir: () => dir, safeStorage: cipher(available) })
    assert.equal(later.find(kept.id)?.deviceToken, 'mctn_fresh-secret', 'the sealed pairing survived that launch')
    assert.equal(later.list().length, 1)
  })
})
