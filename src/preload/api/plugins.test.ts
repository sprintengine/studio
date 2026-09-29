import assert from 'node:assert/strict'

import { createPluginsApi } from './plugins'
import type { PluginRegistryListResult } from '../../shared/electron-api'
import { test } from 'vitest'

test('plugins', async () => {
  async function main(): Promise<void> {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const listResponse: PluginRegistryListResult = {
      ok: true,
      plugins: [
        {
          id: 'codex',
          displayName: 'Codex',
          source: 'bundled',
          version: 1,
          binary: 'codex',
          resumeSession: true,
          sessionIdFromCaller: false,
          agentStateCapable: true,
        },
        {
          id: 'opencode',
          displayName: 'OpenCode',
          source: 'user',
          version: 1,
          binary: 'opencode',
          resumeSession: false,
          sessionIdFromCaller: false,
          agentStateCapable: true,
        },
      ],
    }

    const api = createPluginsApi({
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        return listResponse
      },
    } as unknown as Parameters<typeof createPluginsApi>[0])

    const list = await api.pluginsList()
    assert.deepEqual(list, listResponse)

    // Agent CLIs ship with the app: there is no folder install to reach.
    assert.equal('installPluginFolder' in api, false)
    assert.deepEqual(
      calls.map((call) => call.channel),
      ['plugins:list'],
    )

    console.log('plugins-preload tests passed')
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
