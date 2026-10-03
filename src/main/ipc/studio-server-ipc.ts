import type { IpcMain } from 'electron'

import { SERVER_METHODS, type ServerInfo } from '../../server/desktop/server-methods'
import { parseServerMode, type ServerMode } from '../../shared/server-mode'
import {
  STUDIO_SERVER_CHANNELS,
  type StudioServerInfo,
  type StudioServerPhase,
  type StudioServerStatus,
} from '../../shared/studio-server-status'
import type { ServerModeChoice } from '../server-mode'
import type { ServerSupervisor, SupervisorState } from '../server-supervisor/supervisor'

// The Studio server, as the windows ask about it: shell-owned, so every
// channel answers whether or not the server is running, and in process too
// (where the only thing to change is the mode the next launch runs in).

export type StudioServerIpcDeps = {
  choice: ServerModeChoice
  /** Null in process. */
  supervisor: Pick<ServerSupervisor, 'state' | 'health' | 'onState' | 'retry' | 'restart' | 'call'> | null
  /** Why this session runs in process after the last launch's server could not start (decision O9). */
  fellBack: string | null
  readSavedMode: () => ServerMode
  writeSavedMode: (mode: ServerMode) => void
  openLog: () => Promise<boolean>
  /** Quit and start again; `compatibility` makes the next launch run the server in process. */
  relaunch: (options: { compatibility: boolean }) => void
  /** Every window, told the status changed. */
  publish: (status: StudioServerStatus) => void
}

export function studioServerPhase(state: SupervisorState): StudioServerPhase {
  switch (state.kind) {
    case 'idle':
    case 'starting':
      return 'starting'
    case 'ready':
      return 'running'
    case 'backoff':
      return 'reconnecting'
    case 'failed':
    case 'stopped':
      return 'stopped'
    case 'stopping':
      return 'stopping'
  }
}

export function registerStudioServerIpc(ipcMain: IpcMain, deps: StudioServerIpcDeps): void {
  const status = (): StudioServerStatus => {
    const supervisor = deps.supervisor
    const state = supervisor?.state
    return {
      mode: deps.choice.mode,
      savedMode: deps.readSavedMode(),
      fromEnvironment: deps.choice.source === 'environment',
      phase: state ? studioServerPhase(state) : 'in-process',
      reason: state?.kind === 'failed' ? state.reason : null,
      pid: supervisor?.health.pid ?? null,
      restarts: supervisor?.health.restarts ?? 0,
      startedAt: supervisor?.health.startedAt ?? null,
      fellBack: deps.fellBack,
    }
  }
  deps.supervisor?.onState(() => deps.publish(status()))

  ipcMain.handle(STUDIO_SERVER_CHANNELS.status, () => status())
  ipcMain.handle(STUDIO_SERVER_CHANNELS.info, async (): Promise<StudioServerInfo | null> => {
    const supervisor = deps.supervisor
    if (!supervisor || supervisor.state.kind !== 'ready') return null
    const info = await supervisor.call<ServerInfo>(SERVER_METHODS.info, undefined, { timeoutMs: 5_000 })
    return {
      pid: info.pid,
      uptimeMs: info.uptimeMs,
      version: info.version,
      gatewaySocket: info.gatewaySocket,
      cipher: info.cipher,
      rssMb: info.rssMb,
      loopLagMs: supervisor.health.loopLagMs,
    }
  })
  ipcMain.handle(STUDIO_SERVER_CHANNELS.retry, () => deps.supervisor?.retry())
  ipcMain.handle(STUDIO_SERVER_CHANNELS.restart, () =>
    deps.supervisor?.restart('Restart server, asked for in Settings'),
  )
  ipcMain.handle(STUDIO_SERVER_CHANNELS.openLog, () => deps.openLog())
  ipcMain.handle(STUDIO_SERVER_CHANNELS.setMode, (_event, raw: unknown) => {
    const mode = parseServerMode(raw)
    if (!mode) throw new Error('A server mode is "in-process" or "out-of-process".')
    deps.writeSavedMode(mode)
    const next = status()
    deps.publish(next)
    return next
  })
  ipcMain.handle(STUDIO_SERVER_CHANNELS.relaunch, (_event, raw: unknown) => {
    const compatibility = (raw as { compatibility?: unknown } | null)?.compatibility === true
    deps.relaunch({ compatibility })
  })
}
