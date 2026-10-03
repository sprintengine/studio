import type { IpcMain } from 'electron'

import { SSH_ENV_CHANNELS } from '../../shared/ssh-environments'
import type { SshEnvironments } from '../environments/ssh/ssh-environments'

// The renderer's way to the desktop's SSH machines (phase 8). Every payload
// is checked here: ids and destinations come from a window, which is trusted
// with nothing more than asking.

function idOf(payload: unknown): string | null {
  const id = (payload as { id?: unknown } | null)?.id
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(id) ? id : null
}

const unknown = { ok: false as const, message: 'That SSH machine is not one of yours.' }

export function registerSshEnvironmentsIpc(ipcMain: IpcMain, machines: SshEnvironments): () => void {
  const handle = (channel: string, run: (payload: unknown) => unknown) =>
    ipcMain.handle(channel, (_event, payload) => run(payload))
  handle(SSH_ENV_CHANNELS.list, () => machines.list())
  handle(SSH_ENV_CHANNELS.suggestions, () => machines.suggestions())
  handle(SSH_ENV_CHANNELS.resolve, (payload) => {
    const destination = (payload as { destination?: unknown } | null)?.destination
    return typeof destination === 'string' ? machines.resolve(destination) : { ok: false, message: 'Type a host.' }
  })
  handle(SSH_ENV_CHANNELS.add, (payload) => {
    const record = (payload ?? {}) as { destination?: unknown; label?: unknown }
    if (typeof record.destination !== 'string') return { ok: false, message: 'Type a host.' }
    return machines.add({
      destination: record.destination,
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
    })
  })
  handle(SSH_ENV_CHANNELS.update, (payload) => {
    const id = idOf(payload)
    const patch = (payload as { patch?: unknown } | null)?.patch
    if (!id || typeof patch !== 'object' || patch === null) return unknown
    const record = patch as Record<string, unknown>
    const clean: Parameters<SshEnvironments['update']>[1] = {}
    if (typeof record.label === 'string') clean.label = record.label
    if (typeof record.keepRunning === 'boolean') clean.keepRunning = record.keepRunning
    if (typeof record.remoteDownload === 'boolean') clean.remoteDownload = record.remoteDownload
    if (record.paneTraffic === 'all' || record.paneTraffic === 'loopback' || record.paneTraffic === 'off')
      clean.paneTraffic = record.paneTraffic
    if (record.installDir === null || typeof record.installDir === 'string')
      clean.installDir =
        typeof record.installDir === 'string' && record.installDir.trim() ? record.installDir.trim() : null
    return machines.update(id, clean)
  })
  const byId = (channel: string, run: (id: string, payload: Record<string, unknown>) => unknown) =>
    handle(channel, (payload) => {
      const id = idOf(payload)
      return id ? run(id, (payload ?? {}) as Record<string, unknown>) : unknown
    })
  byId(SSH_ENV_CHANNELS.connect, (id) => machines.connect(id))
  byId(SSH_ENV_CHANNELS.disconnect, (id) => machines.disconnect(id))
  byId(SSH_ENV_CHANNELS.stopServer, (id) => machines.stopServer(id))
  byId(SSH_ENV_CHANNELS.upgradeServer, (id) => machines.upgradeServer(id))
  byId(SSH_ENV_CHANNELS.diagnostics, (id) => machines.diagnostics(id))
  byId(SSH_ENV_CHANNELS.forget, (id, payload) =>
    machines.forget(id, {
      stopServer: payload.stopServer === true,
      clearBrowsingData: payload.clearBrowsingData === true,
    }),
  )
  const onAnswer = (_event: unknown, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    const answer = (payload as { answer?: unknown } | null)?.answer
    if (typeof id === 'string') machines.answer(id, typeof answer === 'string' ? answer : null)
  }
  ipcMain.on(SSH_ENV_CHANNELS.answer, onAnswer)
  return () => {
    for (const channel of [
      SSH_ENV_CHANNELS.list,
      SSH_ENV_CHANNELS.suggestions,
      SSH_ENV_CHANNELS.resolve,
      SSH_ENV_CHANNELS.add,
      SSH_ENV_CHANNELS.update,
      SSH_ENV_CHANNELS.connect,
      SSH_ENV_CHANNELS.disconnect,
      SSH_ENV_CHANNELS.stopServer,
      SSH_ENV_CHANNELS.upgradeServer,
      SSH_ENV_CHANNELS.diagnostics,
      SSH_ENV_CHANNELS.forget,
    ])
      ipcMain.removeHandler(channel)
    ipcMain.removeListener(SSH_ENV_CHANNELS.answer, onAnswer)
  }
}
