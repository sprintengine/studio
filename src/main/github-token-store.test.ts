import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

import { GitHubTokenStore } from './github-token-store'
import { createSecretCipherStandIn } from '../../tests/stubs/secret-cipher'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'github-token-store-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

test('a token is sealed into the data directory and read back by the next store', async () => {
  vi.stubEnv('GITHUB_TOKEN', '')
  vi.stubEnv('GH_TOKEN', '')
  const dir = await tempDir()
  const cipher = createSecretCipherStandIn()
  const store = new GitHubTokenStore({ resolveUserDataDir: () => dir, cipher })
  assert.deepEqual(await store.writeToken(' ghp_example '), {
    configured: true,
    source: 'settings',
    encryptionAvailable: true,
  })
  const onDisk = await readFile(join(dir, 'github-token.bin'))
  assert.equal(onDisk.includes(Buffer.from('ghp_example')), false)
  assert.equal(cipher.open(onDisk), 'ghp_example')

  const next = new GitHubTokenStore({ resolveUserDataDir: () => dir, cipher })
  assert.equal(await next.resolveToken(), 'ghp_example')
  assert.equal((await next.clearToken()).configured, false)
  assert.equal(existsSync(join(dir, 'github-token.bin')), false)
})

test('without a cipher the token lasts for the session and never reaches the disk', async () => {
  vi.stubEnv('GITHUB_TOKEN', '')
  vi.stubEnv('GH_TOKEN', '')
  const dir = await tempDir()
  const store = new GitHubTokenStore({
    resolveUserDataDir: () => dir,
    cipher: createSecretCipherStandIn({ value: false }),
  })
  const status = await store.writeToken('ghp_example')
  assert.deepEqual(status, { configured: true, source: 'settings', encryptionAvailable: false })
  assert.equal(await store.resolveToken(), 'ghp_example')
  assert.equal(existsSync(join(dir, 'github-token.bin')), false)

  // A token another cipher sealed (the desktop's keychain, seen from a server
  // sharing its directory) outlives a clear here.
  await new GitHubTokenStore({ resolveUserDataDir: () => dir, cipher: createSecretCipherStandIn() }).writeToken(
    'ghp_desktop',
  )
  await store.clearToken()
  assert.equal(existsSync(join(dir, 'github-token.bin')), true)
})
