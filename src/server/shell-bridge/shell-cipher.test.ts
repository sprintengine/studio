import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createTailnetMeshStore, TAILNET_MESH_FILENAME } from '../../main/automation/tailnet/tailnet-mesh-store'
import { GitHubTokenStore } from '../../main/github-token-store'
import { createShellSecretCipher, meshSealedTokens } from './shell-cipher'
import type { ShellBridge } from './shell-bridge'

// The server's cipher out of process: the shell's keychain, asked over the
// control channel. Every store writes the keychain's own bytes, and the mesh
// store, which opens as it is built, is served from what was opened ahead.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-shell-cipher-'))
  dirs.push(dir)
  return dir
}

// The keychain's transform: reversible, not the identity, prefixed as safeStorage's is.
const keychainSeal = (plain: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(plain, 'utf8').reverse()])
const keychainOpen = (sealed: Uint8Array) => {
  const bytes = Buffer.from(sealed)
  if (!bytes.subarray(0, 3).equals(Buffer.from('v10'))) throw new Error('not the keychain')
  return Buffer.from(bytes.subarray(3)).reverse()
}

function fakeBridge(options: { available?: boolean } = {}) {
  const calls: string[] = []
  const bridge = {
    cipher: {
      available: async () => options.available ?? true,
      seal: async (plain: Uint8Array) => {
        calls.push('seal')
        return new Uint8Array(keychainSeal(Buffer.from(plain).toString('utf8')))
      },
      open: async (sealed: Uint8Array) => {
        calls.push('open')
        return new Uint8Array(keychainOpen(sealed))
      },
    },
  } as unknown as ShellBridge
  return { bridge, calls }
}

test('a sealed value is the keychain’s own bytes, and opens back once per secret', async () => {
  const { bridge, calls } = fakeBridge()
  const cipher = createShellSecretCipher(bridge, { available: true })
  const sealed = await cipher.sealAsync('ghp_example')
  assert.deepEqual(sealed, keychainSeal('ghp_example'))
  assert.equal(await cipher.openAsync(sealed), 'ghp_example')
  // Known from the seal: the keychain is not asked again.
  assert.deepEqual(calls, ['seal'])
  assert.throws(() => cipher.seal('x'), /asynchronously/)
})

test('a synchronous open answers only what was primed', async () => {
  const { bridge } = fakeBridge()
  const cipher = createShellSecretCipher(bridge, { available: true })
  const sealed = keychainSeal('token-1')
  assert.throws(() => cipher.open(sealed), /not opened ahead/)
  await cipher.prime([sealed, Buffer.from('damaged')])
  assert.equal(cipher.open(sealed), 'token-1')
})

test('a keychain that cannot seal primes nothing and says so', async () => {
  const { bridge, calls } = fakeBridge({ available: false })
  const cipher = createShellSecretCipher(bridge, { available: true })
  await cipher.prime([keychainSeal('token')])
  assert.equal(cipher.available(), false)
  assert.deepEqual(calls, [])
})

test('the GitHub token is written as the keychain seals it and read back through the shell', async () => {
  const dir = dataDir()
  const { bridge } = fakeBridge()
  const cipher = createShellSecretCipher(bridge, { available: true })
  const writer = new GitHubTokenStore({ resolveUserDataDir: () => dir, cipher })
  await writer.writeToken('ghp_example')
  assert.deepEqual(readFileSync(join(dir, 'github-token.bin')), keychainSeal('ghp_example'))
  const reader = new GitHubTokenStore({
    resolveUserDataDir: () => dir,
    cipher: createShellSecretCipher(fakeBridge().bridge, { available: true }),
  })
  assert.equal(await reader.readToken(), 'ghp_example')
})

test('the mesh store opens what was primed, and seals a new pairing once the keychain answers', async () => {
  const dir = dataDir()
  writeFileSync(
    join(dir, TAILNET_MESH_FILENAME),
    JSON.stringify({
      version: 2,
      connections: [
        {
          id: 'tnc_existing',
          machineName: 'mac-mini',
          endpoint: '100.64.0.2:8471',
          deviceId: 'dev_1',
          deviceName: 'dev-macbook-air',
          scopes: [],
          pairedAt: '2026-10-01T00:00:00.000Z',
          lastConnectedAt: null,
          pairedVia: 'link',
          sealedToken: keychainSeal('existing-token').toString('base64'),
        },
      ],
    }),
  )
  const { bridge } = fakeBridge()
  const cipher = createShellSecretCipher(bridge, { available: true })
  await cipher.prime(meshSealedTokens(dir))
  const logged: string[] = []
  const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher, log: (line) => logged.push(line) })
  assert.equal(store.find('tnc_existing')?.deviceToken, 'existing-token')

  const added = store.add({
    machineName: 'build-box',
    endpoint: '100.64.0.3:8471',
    deviceId: 'dev_2',
    deviceName: 'dev-macbook-air',
    deviceToken: 'new-token',
    scopes: [],
    pairedVia: 'link',
  })
  assert.deepEqual(logged, [], 'a pending seal is not reported as a keychain that cannot encrypt')
  const onDisk = () =>
    JSON.parse(readFileSync(join(dir, TAILNET_MESH_FILENAME), 'utf8')).connections as Array<{
      id: string
      sealedToken: string
    }>
  for (let tries = 0; tries < 100 && !onDisk().some((entry) => entry.id === added.id); tries++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const written = onDisk().find((entry) => entry.id === added.id)
  assert.deepEqual(Buffer.from(written!.sealedToken, 'base64'), keychainSeal('new-token'))
  // The existing record was written back as it was.
  assert.equal(
    onDisk().find((entry) => entry.id === 'tnc_existing')?.sealedToken,
    keychainSeal('existing-token').toString('base64'),
  )
})
