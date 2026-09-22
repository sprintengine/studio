import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcMain } from 'electron'
import { test } from 'vitest'

import {
  LAUNCH_SETTINGS_CHANNELS,
  parseAgentLaunchSettingsRecord,
  type AgentLaunchSettingsRecord,
  type AgentLaunchSettingsSnapshot,
  type AgentLaunchSettingsWriteAck,
} from '../../shared/launch-settings'
import { createAgentLaunchSettingsStore } from '../launch-settings-store'
import { registerLaunchSettingsIpc } from './launch-settings-ipc'

function fakeWindow(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) },
  }
}

async function withIpc(
  body: (ipc: {
    invoke: (channel: string, payload?: unknown) => unknown
    windows: ReturnType<typeof fakeWindow>[]
    userDataDir: string
    store: ReturnType<typeof createAgentLaunchSettingsStore>
    dispose: () => void
  }) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-launch-settings-ipc-'))
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const ipcMain = {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
      void handlers.set(channel, handler),
  } as unknown as IpcMain
  const store = createAgentLaunchSettingsStore({ resolveUserDataDir: () => userDataDir })
  const windows = [fakeWindow(), fakeWindow(), fakeWindow(true)]
  const dispose = registerLaunchSettingsIpc(ipcMain, { launchSettings: store, getWindows: () => windows })
  try {
    await body({
      invoke: (channel, payload) => {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`no handler for ${channel}`)
        return handler({}, payload)
      },
      windows,
      userDataDir,
      store,
      dispose,
    })
  } finally {
    // Every queued atomic write settles before the directory goes.
    await store.settled()
    await rm(userDataDir, { recursive: true, force: true })
  }
}

test('the window side registers exactly the get, update and migrate invokes', async () => {
  await withIpc(async ({ invoke }) => {
    const snapshot = (await invoke(LAUNCH_SETTINGS_CHANNELS.get)) as AgentLaunchSettingsSnapshot
    assert.equal(snapshot.record, null)
    assert.equal(snapshot.settings.lastSelectedCli, null)
    assert.throws(() => invoke('launch-settings:sync', {}), /no handler/, 'the full-record push is gone')
    assert.throws(() => invoke('launch-settings:hydrate', {}), /no handler/, 'the hydrate seed is gone')
  })
})

test('an update is answered with main record and broadcast to every live window', async () => {
  await withIpc(async ({ invoke, windows }) => {
    const ack = (await invoke(LAUNCH_SETTINGS_CHANNELS.update, {
      lastSelectedCli: 'codex',
    })) as AgentLaunchSettingsWriteAck
    assert.equal(ack.ok, true)
    assert.equal(ack.changed, true)
    assert.equal(ack.record.settings.lastSelectedCli, 'codex')
    assert.equal(ack.record.lastWrite.actor, 'ui')

    const [a, b, gone] = windows
    const expected = [{ channel: LAUNCH_SETTINGS_CHANNELS.changed, payload: ack.record }]
    assert.deepEqual(a?.sent, expected)
    assert.deepEqual(b?.sent, expected)
    assert.deepEqual(gone?.sent, [], 'a destroyed window is skipped')

    const repeat = (await invoke(LAUNCH_SETTINGS_CHANNELS.update, {
      lastSelectedCli: 'codex',
    })) as AgentLaunchSettingsWriteAck
    assert.equal(repeat.changed, false)
    assert.equal(a?.sent.length, 1, 'an update that changes nothing is not broadcast')
  })
})

test('a change main makes itself reaches the windows on the same channel', async () => {
  await withIpc(async ({ store, windows }) => {
    const result = store.update({ lastAgentSpawnPermissionPreset: 'manual' }, 'system')
    const sent = windows[0]?.sent.at(-1)
    assert.equal(sent?.channel, LAUNCH_SETTINGS_CHANNELS.changed)
    assert.equal((sent?.payload as AgentLaunchSettingsRecord).revision, result.record.revision)
  })
})

test('migrate is accepted while main has no record and refused after', async () => {
  await withIpc(async ({ invoke, windows }) => {
    const offer = { lastSelectedCli: 'gemini', cliRuntimes: {}, mcp: { syncEnabled: false, servers: {} } }
    const accepted = (await invoke(LAUNCH_SETTINGS_CHANNELS.migrate, offer)) as AgentLaunchSettingsWriteAck
    assert.equal(accepted.changed, true)
    assert.equal(accepted.record.settings.lastSelectedCli, 'gemini')
    assert.equal(windows[0]?.sent.length, 1, 'an accepted migration is broadcast like any write')

    const refused = (await invoke(LAUNCH_SETTINGS_CHANNELS.migrate, {
      ...offer,
      lastSelectedCli: 'codex',
    })) as AgentLaunchSettingsWriteAck
    assert.equal(refused.changed, false)
    assert.equal(refused.record.settings.lastSelectedCli, 'gemini')
    assert.equal(windows[0]?.sent.length, 1)
  })
})

// The window deletes its localStorage copy of the launch settings as soon as a
// migration is answered, so the answer must not come before main's copy is on
// disk: quitting in between would otherwise lose both.
test('an accepted migration is answered only once it is on disk', async () => {
  await withIpc(async ({ invoke, userDataDir }) => {
    const offer = { lastSelectedCli: 'gemini', cliRuntimes: {}, mcp: { syncEnabled: false, servers: {} } }
    const accepted = (await invoke(LAUNCH_SETTINGS_CHANNELS.migrate, offer)) as AgentLaunchSettingsWriteAck
    assert.equal(accepted.changed, true)
    const onDisk = parseAgentLaunchSettingsRecord(
      JSON.parse(await readFile(join(userDataDir, 'agent-launch-settings.json'), 'utf8')),
    )
    assert.equal(onDisk?.revision, accepted.record.revision)
    assert.equal(onDisk?.settings.lastSelectedCli, 'gemini')
    assert.equal(accepted.persisted, true)
    const updated = (await invoke(LAUNCH_SETTINGS_CHANNELS.update, {
      lastSelectedCli: 'codex',
    })) as AgentLaunchSettingsWriteAck
    assert.equal(updated.persisted, true)
    const snapshot = (await invoke(LAUNCH_SETTINGS_CHANNELS.get)) as AgentLaunchSettingsSnapshot
    assert.equal(snapshot.persisted, true)
  })
})

test('the returned disposer stops the broadcast', async () => {
  await withIpc(async ({ invoke, windows, dispose }) => {
    dispose()
    invoke(LAUNCH_SETTINGS_CHANNELS.update, { lastSelectedCli: 'codex' })
    assert.deepEqual(windows[0]?.sent, [])
  })
})
