import assert from 'node:assert/strict'

import { createModulesApi } from './modules'
import type { ModuleEnablementWriteResult } from '../../shared/electron-api'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
} from '../../shared/modules/manifest'
import {
  EMPTY_MODULE_SURFACES,
  MODULE_REGISTRY_SNAPSHOT_CHANNEL,
  type ModuleRegistrySnapshot,
  type ModuleRegistrySnapshotWriteResult,
} from '../../shared/modules/registry-snapshot'
import { test } from 'vitest'

test('modules', async () => {
  async function main(): Promise<void> {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const listResponse: ThirdPartyModuleListResult = {
      modules: [
        {
          manifest: {
            id: 'trusted-main',
            displayName: 'Trusted main',
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            entry: { main: 'main.cjs' },
          },
          trust: 'trusted',
          launch: {
            status: 'trusted_executable',
            hasMainEntry: true,
            expectedToLoad: true,
          },
        },
      ],
      rejected: [],
    }
    const installResponse: ThirdPartyModuleInstallResult = { ok: true, id: 'trusted-main', trust: 'unsigned' }
    const trustResponse: ThirdPartyModuleTrustResult = { ok: true }
    const enablementResponse: ModuleEnablementWriteResult = { ok: true }
    const registrySnapshot: ModuleRegistrySnapshot = {
      capturedAt: 1_700_000_000_000,
      channel: 'development',
      modules: [
        {
          id: 'trusted-main',
          manifest: listResponse.modules[0].manifest,
          source: 'third-party',
          enabled: true,
          absence: null,
          surfaces: { ...EMPTY_MODULE_SURFACES },
        },
      ],
    }
    const registryResponse: ModuleRegistrySnapshotWriteResult = { ok: true }
    const listeners = new Map<string, () => void>()

    const api = createModulesApi({
      on(channel: string, listener: () => void) {
        listeners.set(channel, listener)
      },
      removeListener(channel: string, listener: () => void) {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        if (channel === 'modules:third-party:list') return listResponse
        if (channel === 'modules:third-party:install-folder') return installResponse
        if (channel === 'modules:third-party:set-trust') return trustResponse
        if (channel === 'modules:set-enablement') return enablementResponse
        if (channel === MODULE_REGISTRY_SNAPSHOT_CHANNEL) return registryResponse
        throw new Error(`unexpected channel ${channel}`)
      },
    } as Parameters<typeof createModulesApi>[0])

    assert.deepEqual(await api.listThirdPartyModules(), listResponse)
    assert.deepEqual(await api.installThirdPartyModuleFolder('/tmp/module'), installResponse)
    assert.deepEqual(await api.setThirdPartyModuleTrust('trusted-main', true), trustResponse)
    assert.deepEqual(await api.setModuleEnablement({ 'trusted-main': true }), enablementResponse)
    assert.deepEqual(await api.setModuleRegistrySnapshot(registrySnapshot), registryResponse)
    let changed = 0
    const stop = api.onThirdPartyModulesChanged(() => {
      changed++
    })
    listeners.get('modules:third-party:changed')!()
    assert.equal(changed, 1, 'module change events reach renderer subscribers')
    stop()
    assert.equal(listeners.has('modules:third-party:changed'), false, 'unsubscribe removes the same listener')
    assert.deepEqual(calls, [
      { channel: 'modules:third-party:list', args: [] },
      { channel: 'modules:third-party:install-folder', args: ['/tmp/module'] },
      { channel: 'modules:third-party:set-trust', args: [{ id: 'trusted-main', trusted: true }] },
      { channel: 'modules:set-enablement', args: [{ 'trusted-main': true }] },
      { channel: MODULE_REGISTRY_SNAPSHOT_CHANNEL, args: [registrySnapshot] },
    ])

    console.log('modules-preload tests passed')
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
