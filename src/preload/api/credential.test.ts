import assert from 'node:assert/strict'

import { createCredentialApi } from './credential'
import type { CredentialSecretStatusResult } from '../../shared/electron-api'
import { test } from 'vitest'

test('credential', async () => {
  // Locks the preload channel mapping so a typo can't silently break the wiring to
  // the main-process `credential:secrets:*` handlers (src/main/ipc/credential-ipc.ts).
  async function main(): Promise<void> {
    const calls: { channel: string; input: unknown }[] = []
    const status: CredentialSecretStatusResult = {
      ok: true,
      status: {
        providerId: 'zai',
        configured: true,
        source: 'settings',
        persistence: 'encrypted',
        encryptionAvailable: true,
        label: 'Z.AI API key',
      },
    }

    const api = createCredentialApi({
      async invoke(channel: string, input: unknown): Promise<never> {
        calls.push({ channel, input })
        return status as never
      },
    })

    await api.credentialSecretStatus({ id: 'zai' })
    await api.credentialSecretSet({ id: 'zai', value: 'sk-z' })
    await api.credentialSecretClear({ id: 'zai' })

    assert.deepEqual(calls, [
      { channel: 'credential:secrets:status', input: { id: 'zai' } },
      { channel: 'credential:secrets:set', input: { id: 'zai', value: 'sk-z' } },
      { channel: 'credential:secrets:clear', input: { id: 'zai' } },
    ])

    console.log('credential-preload tests passed')
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
