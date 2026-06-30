import assert from 'node:assert/strict'

import { ProviderSecretStore } from './secret-store'
import type { ProviderSecretStoreOptions } from './secret-store'
import type { LoadedConversationProvider } from '../shared/plugin-manifest'

type MemoryFiles = {
  files: Map<string, Buffer>
  adapter: ProviderSecretStoreOptions['files']
}

const provider: LoadedConversationProvider = {
  manifest: {
    kind: 'provider',
    id: 'openai-compatible',
    displayName: 'OpenAI Compatible',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'gpt-5' }],
    auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
  },
  source: 'bundled',
  manifestPath: '/fixtures/openai-compatible/plugin.json',
  pluginRoot: '/fixtures/openai-compatible',
  adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
}

async function main(): Promise<void> {
  await testEncryptedWriteStatusAndClear()
  await testSessionFallbackWhenEncryptionUnavailable()
  await testEnvironmentStatusUsesDescriptorEnv()
  await testResolveSecretReturnsMainOnlyValue()
  await testStorageFailureIsRedacted()
  await testExpectedFailuresAreExplicit()

  console.log('provider-secret-store tests passed')
}

async function testEncryptedWriteStatusAndClear(): Promise<void> {
  const files = createMemoryFiles()
  const store = createStore({ files, encryptionAvailable: true })

  const written = await store.setSecret('openai-compatible', 'sk-test-secret')
  assert.equal(written.ok, true)
  if (!written.ok) return
  assert.deepEqual(written.status, {
    providerId: 'openai-compatible',
    configured: true,
    source: 'settings',
    persistence: 'encrypted',
    encryptionAvailable: true,
    label: 'API key',
  })
  assert.doesNotMatch(JSON.stringify(written), /sk-test-secret/)

  const status = await store.getStatus('openai-compatible')
  assert.equal(status.ok, true)
  if (!status.ok) return
  assert.equal(status.status.source, 'settings')

  const cleared = await store.clearSecret('openai-compatible')
  assert.equal(cleared.ok, true)
  if (!cleared.ok) return
  assert.equal(cleared.status.configured, false)
  assert.equal(cleared.status.source, 'none')
}

async function testSessionFallbackWhenEncryptionUnavailable(): Promise<void> {
  const files = createMemoryFiles()
  const store = createStore({ files, encryptionAvailable: false })

  const written = await store.setSecret('openai-compatible', 'sk-session-secret')
  assert.equal(written.ok, true)
  if (!written.ok) return
  assert.equal(written.status.source, 'session')
  assert.equal(written.status.persistence, 'session')
  assert.equal(written.status.encryptionAvailable, false)
  assert.equal(files.files.size, 0)
  assert.doesNotMatch(JSON.stringify(written), /sk-session-secret/)
}

async function testEnvironmentStatusUsesDescriptorEnv(): Promise<void> {
  const store = createStore({
    files: createMemoryFiles(),
    encryptionAvailable: true,
    env: { OPENAI_API_KEY: 'sk-env-secret' },
  })

  const status = await store.getStatus('openai-compatible')
  assert.equal(status.ok, true)
  if (!status.ok) return
  assert.equal(status.status.configured, true)
  assert.equal(status.status.source, 'environment')
  assert.equal(status.status.persistence, 'environment')
  assert.doesNotMatch(JSON.stringify(status), /sk-env-secret/)
}

async function testResolveSecretReturnsMainOnlyValue(): Promise<void> {
  const files = createMemoryFiles()
  const store = createStore({ files, encryptionAvailable: true })
  assert.deepEqual(await store.resolveSecret('openai-compatible'), {
    ok: false,
    message: 'Conversation provider secret is not configured.',
  })

  await store.setSecret('openai-compatible', 'sk-main-secret')
  assert.deepEqual(await store.resolveSecret('openai-compatible'), {
    ok: true,
    providerId: 'openai-compatible',
    value: 'sk-main-secret',
    source: 'settings',
  })
}

async function testStorageFailureIsRedacted(): Promise<void> {
  const files = createMemoryFiles()
  const store = createStore({ files, encryptionAvailable: true })
  if (!files.adapter) throw new Error('missing files adapter')
  files.adapter.writeFile = async () => {
    throw new Error('disk full while writing sk-failing-secret')
  }

  const result = await store.setSecret('openai-compatible', 'sk-failing-secret')
  assert.deepEqual(result, { ok: false, message: 'Could not store provider secret.' })
  assert.doesNotMatch(JSON.stringify(result), /sk-failing-secret/)
  const status = await store.getStatus('openai-compatible')
  assert.equal(status.ok, true)
  if (!status.ok) return
  assert.equal(status.status.configured, false)
}

async function testExpectedFailuresAreExplicit(): Promise<void> {
  const providerWithoutAuth: LoadedConversationProvider = {
    ...provider,
    manifest: { ...provider.manifest, auth: undefined },
  }
  const store = createStore({
    files: createMemoryFiles(),
    encryptionAvailable: true,
    providerById: (id) => (id === 'openai-compatible' ? providerWithoutAuth : undefined),
  })

  assert.deepEqual(await store.getStatus('bad id'), { ok: false, message: 'Provider id is invalid.' })
  assert.deepEqual(await store.getStatus('missing-provider'), {
    ok: false,
    message: 'Conversation provider is not installed.',
  })
  assert.deepEqual(await store.setSecret('openai-compatible', '  '), {
    ok: false,
    message: 'Conversation provider does not declare a secret.',
  })
}

function createStore(input: {
  files: MemoryFiles
  encryptionAvailable: boolean
  env?: NodeJS.ProcessEnv
  providerById?: (id: string) => LoadedConversationProvider | undefined
}): ProviderSecretStore {
  return new ProviderSecretStore({
    resolveAuthOwner: input.providerById ?? ((id) => (id === 'openai-compatible' ? provider : undefined)),
    resolveUserDataDir: () => '/user-data',
    safeStorage: {
      isEncryptionAvailable: () => input.encryptionAvailable,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => value.toString('utf-8').replace(/^encrypted:/, ''),
    },
    files: input.files.adapter,
    env: input.env ?? {},
  })
}

function createMemoryFiles(): MemoryFiles {
  const files = new Map<string, Buffer>()
  return {
    files,
	    adapter: {
	      mkdir: async () => undefined,
	      readFile: async (path) => {
	        const value = files.get(String(path))
	        if (!value) throw new Error('missing')
	        return value
      },
      unlink: async (path) => {
        files.delete(String(path))
      },
	      writeFile: async (path, data) => {
	        files.set(String(path), Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
	      },
	    } as unknown as ProviderSecretStoreOptions['files'],
	  }
	}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
