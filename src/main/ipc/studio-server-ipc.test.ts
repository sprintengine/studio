import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import { test } from 'vitest'

import type { ServerMode } from '../../shared/server-mode'
import type { StudioServerStatus } from '../../shared/studio-server-status'
import type { SupervisorState } from '../server-supervisor/supervisor'
import { registerStudioServerIpc, studioServerPhase } from './studio-server-ipc'

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) } as unknown as IpcMain,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
  }
}

test('each supervisor state is one phase in words', () => {
  const phases: Array<[SupervisorState, string]> = [
    [{ kind: 'idle' }, 'starting'],
    [{ kind: 'starting', attempt: 1 }, 'starting'],
    [{ kind: 'ready', ready: {} as never }, 'running'],
    [{ kind: 'backoff', attempt: 2, delayMs: 1_000, exit: { code: 70, signal: null } }, 'reconnecting'],
    [{ kind: 'failed', reason: 'x', exit: null, neverReady: false }, 'stopped'],
    [{ kind: 'stopping' }, 'stopping'],
    [{ kind: 'stopped' }, 'stopped'],
  ]
  for (const [state, phase] of phases) assert.equal(studioServerPhase(state), phase, state.kind)
})

test('in process, the status is the mode, and the toggle writes the next launch’s', async () => {
  const ipc = fakeIpc()
  let saved: ServerMode = 'in-process'
  const published: StudioServerStatus[] = []
  registerStudioServerIpc(ipc.ipcMain, {
    choice: { mode: 'in-process', source: 'default' },
    supervisor: null,
    fellBack: null,
    readSavedMode: () => saved,
    writeSavedMode: (mode) => {
      saved = mode
    },
    openLog: async () => true,
    relaunch: () => undefined,
    publish: (status) => published.push(status),
  })
  const status = (await ipc.invoke('studio-server:status')) as StudioServerStatus
  assert.equal(status.phase, 'in-process')
  assert.equal(await ipc.invoke('studio-server:info'), null)
  const next = (await ipc.invoke('studio-server:set-mode', 'out-of-process')) as StudioServerStatus
  assert.equal(next.savedMode, 'out-of-process')
  assert.equal(next.mode, 'in-process', 'this session keeps its mode')
  assert.equal(published.length, 1)
  await assert.rejects(Promise.resolve().then(() => ipc.invoke('studio-server:set-mode', 'sideways')))
})

test('a relaunch in compatibility mode is asked for by name', async () => {
  const ipc = fakeIpc()
  const relaunched: unknown[] = []
  registerStudioServerIpc(ipc.ipcMain, {
    choice: { mode: 'out-of-process', source: 'settings' },
    supervisor: null,
    fellBack: null,
    readSavedMode: () => 'out-of-process',
    writeSavedMode: () => undefined,
    openLog: async () => true,
    relaunch: (options) => relaunched.push(options),
    publish: () => undefined,
  })
  await ipc.invoke('studio-server:relaunch', { compatibility: true })
  await ipc.invoke('studio-server:relaunch', {})
  assert.deepEqual(relaunched, [{ compatibility: true }, { compatibility: false }])
})
