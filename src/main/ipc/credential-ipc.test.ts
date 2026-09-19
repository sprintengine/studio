import assert from 'node:assert/strict'

import type {
  CredentialSecretClearResult,
  CredentialSecretSetResult,
  CredentialSecretStatusResult,
} from '../../shared/electron-api'
import { type CredentialIpcStore, registerCredentialIpc } from './credential-ipc'
import { test } from 'vitest'

test('credential-ipc', async () => {
  type Handler = (event: unknown, input: unknown) => Promise<unknown>

  function createIpcMain(): { handle: (channel: string, handler: Handler) => void; handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>()
    return {
      handle: (channel, handler) => handlers.set(channel, handler),
      handlers,
    }
  }

  const okStatus = (id: string, configured: boolean): CredentialSecretStatusResult => ({
    ok: true,
    status: {
      providerId: id,
      configured,
      source: configured ? 'settings' : 'none',
      persistence: 'encrypted',
      encryptionAvailable: true,
      label: 'Z.AI API key',
    },
  })

  function createStore(): { store: CredentialIpcStore; calls: string[] } {
    const calls: string[] = []
    const store: CredentialIpcStore = {
      async getStatus(id): Promise<CredentialSecretStatusResult> {
        calls.push(`status:${id}`)
        return okStatus(id, false)
      },
      async setSecret(id, value): Promise<CredentialSecretSetResult> {
        calls.push(`set:${id}:${value}`)
        return okStatus(id, true)
      },
      async clearSecret(id): Promise<CredentialSecretClearResult> {
        calls.push(`clear:${id}`)
        return okStatus(id, false)
      },
    }
    return { store, calls }
  }

  async function main(): Promise<void> {
    await testRoutesToStore()
    await testRejectsBadInput()
    console.log('credential-ipc tests passed')
  }

  async function testRoutesToStore(): Promise<void> {
    const ipcMain = createIpcMain()
    const { store, calls } = createStore()
    registerCredentialIpc(ipcMain as never, store)

    const status = await ipcMain.handlers.get('credential:secrets:status')?.(null, { id: 'zai' })
    assert.deepEqual(status, okStatus('zai', false))

    const set = await ipcMain.handlers.get('credential:secrets:set')?.(null, { id: 'zai', value: 'sk-z' })
    assert.deepEqual(set, okStatus('zai', true))

    const clear = await ipcMain.handlers.get('credential:secrets:clear')?.(null, { id: 'zai' })
    assert.deepEqual(clear, okStatus('zai', false))

    assert.deepEqual(calls, ['status:zai', 'set:zai:sk-z', 'clear:zai'])
  }

  async function testRejectsBadInput(): Promise<void> {
    const ipcMain = createIpcMain()
    const { store, calls } = createStore()
    registerCredentialIpc(ipcMain as never, store)

    assert.deepEqual(await ipcMain.handlers.get('credential:secrets:status')?.(null, { id: '   ' }), {
      ok: false,
      message: 'Credential id is required.',
    })
    assert.deepEqual(await ipcMain.handlers.get('credential:secrets:set')?.(null, { id: 'zai' }), {
      ok: false,
      message: 'Credential value is required.',
    })
    // No store call should have happened for invalid input.
    assert.deepEqual(calls, [])
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
