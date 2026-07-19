import assert from 'node:assert/strict'

import { TrackerConnectionStore, type TrackerConnectionStoreOptions } from './connection-store'

// Verifies the connection store's acceptance-critical behavior (MC-1633):
// connection CRUD, per-connection secret resolution keyed by connection id, the
// redaction boundary (no secret in the persisted JSON or the listed payload),
// env-fallback, and capability gating.

type MemoryFs = {
  files: Map<string, Buffer>
  adapter: NonNullable<TrackerConnectionStoreOptions['files']>
}

const CONNECTIONS_PATH = '/user-data/tracker-connections.json'

async function main(): Promise<void> {
  await testCrudAndPerConnectionSecrets()
  await testSecretNeverInPersistedJson()
  await testEnvFallbackResolvesCredential()
  await testStatusRedactionAndProbe()
  await testCapabilityGating()
  await testDraftConnectionIsTransient()
  await testValidationRejectsBadShapes()

  console.log('tracker-connection-store tests passed')
}

async function testCrudAndPerConnectionSecrets(): Promise<void> {
  const store = createStore({ encryptionAvailable: true })

  assert.deepEqual(await store.list(), [])

  const first = await store.add({
    provider: 'github',
    baseUrl: null,
    authMode: 'github_pat',
    label: 'github.com',
    secret: 'ghp_first',
  })
  const second = await store.add({
    provider: 'github',
    baseUrl: 'https://ghe.example.com/api/v3',
    authMode: 'github_pat',
    label: 'Enterprise',
    secret: 'ghp_second',
  })

  assert.notEqual(first.id, second.id)
  const listed = await store.list()
  assert.equal(listed.length, 2)

  // Two connections of the SAME provider resolve DISTINCT secrets, keyed by id.
  assert.deepEqual(await store.resolveSecret(first.id), {
    ok: true,
    providerId: first.id,
    value: 'ghp_first',
    source: 'settings',
  })
  assert.deepEqual(await store.resolveSecret(second.id), {
    ok: true,
    providerId: second.id,
    value: 'ghp_second',
    source: 'settings',
  })

  await store.remove(first.id)
  const afterRemoval = await store.list()
  assert.equal(afterRemoval.length, 1)
  assert.equal(afterRemoval[0].id, second.id)
  // Removing a connection clears its credential.
  assert.equal((await store.resolveSecret(first.id)).ok, false)
}

async function testSecretNeverInPersistedJson(): Promise<void> {
  const fs = createMemoryFs()
  const store = createStore({ encryptionAvailable: true, fs })

  await store.add({
    provider: 'jira',
    baseUrl: 'https://jira.example.com',
    authMode: 'jira_pat',
    label: 'Data Center',
    secret: 'super-secret-token',
  })

  const persisted = fs.files.get(CONNECTIONS_PATH)
  assert.ok(persisted, 'connections file should be written')
  const text = persisted.toString('utf8')
  assert.doesNotMatch(text, /super-secret-token/, 'secret must never land in the connections JSON')
  assert.match(text, /"version": 1/)

  // Nor in the redacted list payload.
  const listed = await store.list()
  assert.doesNotMatch(JSON.stringify(listed), /super-secret-token/)
}

async function testEnvFallbackResolvesCredential(): Promise<void> {
  const store = createStore({
    encryptionAvailable: true,
    env: { MY_TRACKER_TOKEN: 'env-provided-secret' },
  })

  const connection = await store.add({
    provider: 'linear',
    baseUrl: null,
    authMode: 'linear_key',
    label: 'Linear',
    envVar: 'MY_TRACKER_TOKEN',
    // No secret supplied — the env var is the fallback source.
  })

  assert.deepEqual(await store.resolveSecret(connection.id), {
    ok: true,
    providerId: connection.id,
    value: 'env-provided-secret',
    source: 'environment',
  })
}

async function testStatusRedactionAndProbe(): Promise<void> {
  const store = createStore({ encryptionAvailable: true })

  const configured = await store.add({
    provider: 'github',
    baseUrl: null,
    authMode: 'github_pat',
    label: 'With token',
    secret: 'ghp_token',
  })
  const bare = await store.add({
    provider: 'github',
    baseUrl: null,
    authMode: 'github_pat',
    label: 'No token',
  })

  const before = await store.list()
  const configuredRow = before.find((c) => c.id === configured.id)
  const bareRow = before.find((c) => c.id === bare.id)
  assert.equal(configuredRow?.status, 'unknown')
  assert.equal(configuredRow?.statusReason, 'Not tested yet.')
  assert.equal(bareRow?.status, 'expired')
  assert.equal(bareRow?.statusReason, 'No credential configured.')

  store.recordProbe(configured.id, { ok: true, summary: 'Reached GitHub.' })
  store.recordProbe(bare.id, { ok: false, reason: 'Bad credentials.' })
  const after = await store.list()
  assert.equal(after.find((c) => c.id === configured.id)?.status, 'connected')
  const failed = after.find((c) => c.id === bare.id)
  assert.equal(failed?.status, 'unknown')
  assert.equal(failed?.statusReason, 'Bad credentials.')
}

async function testCapabilityGating(): Promise<void> {
  const store = createStore({
    encryptionAvailable: true,
    resolveCapabilities: (provider) =>
      provider === 'github' ? { canComment: true, canTransition: false, selfHostable: true } : undefined,
  })

  const github = await store.add({ provider: 'github', baseUrl: null, authMode: 'github_pat', label: 'GH' })
  const linear = await store.add({ provider: 'linear', baseUrl: null, authMode: 'linear_key', label: 'Lin' })

  const listed = await store.list()
  const githubRow = listed.find((c) => c.id === github.id)
  const linearRow = listed.find((c) => c.id === linear.id)
  assert.deepEqual(githubRow?.capabilities, { canComment: true, canTransition: false, selfHostable: true })
  assert.equal(linearRow?.capabilities, undefined, 'no client registered ⇒ no capabilities surfaced')
}

async function testDraftConnectionIsTransient(): Promise<void> {
  const fs = createMemoryFs()
  const store = createStore({ encryptionAvailable: true, fs })

  const seenSecret = await store.withDraftConnection(
    { provider: 'github', baseUrl: null, authMode: 'github_pat', label: 'Draft', secret: 'draft-secret' },
    async (connectionId) => (await store.resolveSecret(connectionId)).ok && connectionId
  )
  assert.ok(seenSecret, 'draft secret resolvable inside the draft scope')

  // Nothing persisted, and the draft id no longer resolves after the scope.
  assert.equal(fs.files.get(CONNECTIONS_PATH), undefined)
  assert.equal((await store.list()).length, 0)
  assert.equal((await store.resolveSecret(String(seenSecret))).ok, false)
}

async function testValidationRejectsBadShapes(): Promise<void> {
  const store = createStore({ encryptionAvailable: true })

  await assert.rejects(
    store.add({ provider: 'jira', baseUrl: null, authMode: 'jira_pat', label: 'No URL' }),
    /server address is required/
  )
  await assert.rejects(
    store.add({ provider: 'github', baseUrl: null, authMode: 'jira_basic', label: 'Mismatch' }),
    /sign-in method does not match/
  )
  await assert.rejects(
    store.add({ provider: 'linear', baseUrl: 'https://nope', authMode: 'linear_key', label: 'Linear' }),
    /no server address/
  )
}

let idCounter = 0
function createStore(input: {
  encryptionAvailable: boolean
  env?: NodeJS.ProcessEnv
  fs?: MemoryFs
  resolveCapabilities?: TrackerConnectionStoreOptions['resolveCapabilities']
}): TrackerConnectionStore {
  const fs = input.fs ?? createMemoryFs()
  return new TrackerConnectionStore({
    resolveUserDataDir: () => '/user-data',
    files: fs.adapter,
    env: input.env ?? {},
    generateConnectionId: () => `trk-c${++idCounter}`,
    resolveCapabilities: input.resolveCapabilities,
    safeStorage: {
      isEncryptionAvailable: () => input.encryptionAvailable,
      encryptString: (value) => Buffer.from(`enc:${value}`),
      decryptString: (value) => value.toString('utf-8').replace(/^enc:/, ''),
    },
  })
}

function createMemoryFs(): MemoryFs {
  const files = new Map<string, Buffer>()
  const adapter = {
    mkdir: async () => undefined,
    readFile: async (path: unknown, encoding?: unknown) => {
      const value = files.get(String(path))
      if (!value) throw new Error('missing')
      return encoding ? value.toString('utf8') : value
    },
    writeFile: async (path: unknown, data: unknown) => {
      files.set(String(path), Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
    },
    unlink: async (path: unknown) => {
      files.delete(String(path))
    },
  } as unknown as NonNullable<TrackerConnectionStoreOptions['files']>
  return { files, adapter }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
